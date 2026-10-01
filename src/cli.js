// preimage CLI
//
// Commands are intentionally few and composable. The two that matter most to an
// agent integration are `checkpoint` and `restore`, both of which emit JSON on
// request so a hook can parse them without scraping human text.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Journal } from "./journal.js";
import { scanTree, persistTree, diffTree, DEFAULT_MAX_FILE_BYTES } from "./capture.js";
import { restoreFiles } from "./restore.js";
import { captureTables, diffTables, restoreTables, listTables } from "./dbadapter.js";
import { humanBytes, journalDir, ensureDir, shortId } from "./util.js";

const USAGE = `preimage - the undo layer for AI agents

USAGE
  preimage <command> [options]

COMMANDS
  init                          Create the journal for the current directory
  checkpoint [label]            Snapshot files (and optionally tables) now
  list                          List recent checkpoints
  show [id]                     Summarise one checkpoint (default: latest)
  diff [id]                     Show what changed since a checkpoint (default: latest)
  restore <id>                  Put files and tables back to a checkpoint
  tables <db>                   List tables in a SQLite database
  hook install <target>         Print an agent hook config (claude-code|opencode)
  gc                            Drop unreferenced blobs

COMMON OPTIONS
  --root <dir>                  Project root (default: cwd)
  --json                        Machine-readable output
  --db <path>                   Include a SQLite database (repeatable)
  --table <name>                Limit to specific tables (repeatable)
  --max-bytes <n>               Skip files larger than this (default ${DEFAULT_MAX_FILE_BYTES})
  --dry-run                     Show what restore would do, change nothing
  --purge                       Also delete files created after the checkpoint
  --remove-extra                Also delete rows added after the checkpoint
  --yes                         Skip the confirmation prompt

EXAMPLES
  preimage checkpoint "before refactor"
  preimage diff                # latest checkpoint
  preimage diff 0003
  preimage restore 0003 --purge
  preimage checkpoint --db ./app.db --table users --table orders
`;

function parseArgs(argv) {
	const out = { _: [], flags: {} };
	const setFlag = (name, value) => {
		if (Object.hasOwn(out.flags, name)) {
			const prev = out.flags[name];
			out.flags[name] = Array.isArray(prev) ? [...prev, value] : [prev, value];
		} else {
			out.flags[name] = value;
		}
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			out._.push(...argv.slice(i + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (eq !== -1) {
				setFlag(arg.slice(2, eq), arg.slice(eq + 1));
			} else {
				const next = argv[i + 1];
				if (next !== undefined && !next.startsWith("--")) {
					setFlag(arg.slice(2), next);
					i++;
				} else {
					setFlag(arg.slice(2), true);
				}
			}
		} else {
			out._.push(arg);
		}
	}
	return out;
}

function toArray(v) {
	if (v === undefined) return [];
	return Array.isArray(v) ? v : [v];
}

function formatWhen(ms) {
	const delta = Date.now() - ms;
	const mins = Math.round(delta / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

function emit(args, humanFn, jsonFn) {
	if (args.flags.json) {
		process.stdout.write(`${JSON.stringify(jsonFn(), null, 2)}\n`);
	} else {
		humanFn();
	}
}

function resolveRoot(flags) {
	return path.resolve(flags.root ?? process.cwd());
}

function requireJournal(root) {
	const dir = journalDir(root);
	if (!fs.existsSync(dir)) {
		throw new Error(
			`no journal for ${root}\nRun \`preimage init\` first, or pass --root <dir>.`,
		);
	}
	return Journal.open(root);
}

function confirm(question) {
	if (!process.stdin.isTTY) return false;
	process.stdout.write(`${question} [y/N] `);
	const buf = Buffer.alloc(64);
	try {
		const bytes = fs.readSync(0, buf, 0, 64, null);
		return /^(y|yes)$/i.test(buf.toString("utf8", 0, bytes).trim());
	} catch {
		return false;
	}
}

async function cmdInit(args) {
	const root = resolveRoot(args.flags);
	const dir = journalDir(root);
	ensureDir(dir);
	const journal = Journal.open(root);
	const stats = journal.stats();
	journal.close();
	emit(
		args,
		() => {
			process.stdout.write(`journal ready at ${path.join(dir, "journal.db")}\n`);
			process.stdout.write(`${stats.checkpoints} checkpoints, ${stats.blobs} blobs\n`);
		},
		() => ({ ok: true, root, journal: path.join(dir, "journal.db"), ...stats }),
	);
}

async function cmdCheckpoint(args) {
	const root = resolveRoot(args.flags);
	const label = args._[1] ?? null;
	ensureDir(journalDir(root));
	const journal = Journal.open(root);

	const maxBytes = Number(args.flags["max-bytes"] ?? DEFAULT_MAX_FILE_BYTES);
	const id = journal.createCheckpoint({ root, label, source: args.flags.source ?? "cli" });

	const tree = scanTree(root, { maxFileBytes: Number.isFinite(maxBytes) ? maxBytes : DEFAULT_MAX_FILE_BYTES });
	const { fileCount, totalBytes } = persistTree(journal, id, tree);

	const dbs = toArray(args.flags.db);
	const tables = toArray(args.flags.table);
	let rowCount = 0;
	const captured = [];
	for (const dbPath of dbs) {
		const result = captureTables(journal, id, { root, dbPath, tables });
		rowCount += result.rowCount;
		captured.push(result);
	}

	journal.finaliseCheckpoint(id, { fileCount, totalBytes, dbCount: rowCount });
	journal.close();

	emit(
		args,
		() => {
			process.stdout.write(`checkpoint ${shortId(id)} created\n`);
			process.stdout.write(`  ${fileCount} files, ${humanBytes(totalBytes)}\n`);
			if (captured.length > 0) {
				process.stdout.write(`  ${rowCount} rows across ${captured.length} database(s)\n`);
			}
			// Silently capturing fewer tables than asked for would be a lie.
			for (const db of captured) {
				for (const name of db.skipped) {
					process.stdout.write(`  skipped missing table ${db.dbPath}:${name}\n`);
				}
			}
		},
		() => ({ ok: true, id, label, fileCount, totalBytes, rowCount, databases: captured }),
	);
}

async function cmdList(args) {
	const root = resolveRoot(args.flags);
	const journal = requireJournal(root);
	const rows = journal.listCheckpoints({ limit: Number(args.flags.limit ?? 20) });
	journal.close();
	emit(
		args,
		() => {
			if (rows.length === 0) {
				process.stdout.write("no checkpoints yet\n");
				return;
			}
			for (const r of rows) {
				const tag = r.label ? ` ${r.label}` : "";
				process.stdout.write(
					`${shortId(r.id)}  ${formatWhen(r.created_at).padStart(8)}  ` +
						`${String(r.file_count).padStart(5)} files  ${humanBytes(r.total_bytes).padStart(9)}  ` +
						`${r.status}${tag}\n`,
				);
			}
		},
		() => ({ ok: true, checkpoints: rows }),
	);
}

function parseId(value) {
	if (value === undefined) throw new Error("checkpoint id required");
	const n = Number(String(value).replace(/^0+/, ""));
	if (!Number.isFinite(n)) throw new Error(`invalid checkpoint id: ${value}`);
	return n;
}

/**
 * The id for `diff` and `show`. Omitting it means "the most recent
 * checkpoint", which is what someone means almost every time they type
 * `preimage diff`. Explicit ids still win.
 */
function parseOptionalId(args, journal, command) {
	const raw = args._[1];
	if (raw === undefined) {
		const latest = journal.latestCheckpoint();
		if (!latest) {
			throw new Error(
				`no checkpoints yet. Run \`preimage checkpoint\` before \`preimage ${command}\`.`,
			);
		}
		return latest.id;
	}
	return parseId(raw);
}

async function cmdShow(args) {
	const root = resolveRoot(args.flags);
	const journal = requireJournal(root);
	const id = parseOptionalId(args, journal, "show");
	const cp = journal.getCheckpoint(id);
	if (!cp) throw new Error(`no checkpoint ${args._[1]}`);
	const dbTables = journal.listDbTables(id);
	journal.close();
	emit(
		args,
		() => {
			process.stdout.write(`checkpoint ${shortId(cp.id)}\n`);
			process.stdout.write(`  taken   ${new Date(cp.created_at).toISOString()}\n`);
			process.stdout.write(`  label   ${cp.label ?? "(none)"}\n`);
			process.stdout.write(`  source  ${cp.source}\n`);
			process.stdout.write(`  status  ${cp.status}\n`);
			process.stdout.write(`  files   ${cp.file_count} (${humanBytes(cp.total_bytes)})\n`);
			if (dbTables.length > 0) {
				process.stdout.write(`  tables  ${dbTables.map((t) => `${t.db_path}:${t.table}`).join(", ")}\n`);
			}
		},
		() => ({ ok: true, checkpoint: cp, tables: dbTables }),
	);
}

async function cmdDiff(args) {
	const root = resolveRoot(args.flags);
	const journal = requireJournal(root);
	const id = parseOptionalId(args, journal, "diff");
	if (!journal.getCheckpoint(id)) throw new Error(`no checkpoint ${args._[1]}`);
	const files = diffTree(journal, id, root);
	const dbs = toArray(args.flags.db);
	let tables = { missing: [], updated: [], extra: [], droppedTables: [], identical: 0, errors: [] };
	if (dbs.length > 0 || journal.listDbTables(id).length > 0) {
		tables = diffTables(journal, id, root);
	}

	// A database captured with --db is reported by the rows section. Listing it
	// in the file section too would count the same change twice and read as if
	// the file would be rewritten byte-for-byte on restore, which it is not.
	const tableOwned = new Set(journal.listDbTables(id).map((t) => t.db_path));
	journal.close();
	const pathOf = (item) => (typeof item === "string" ? item : item.path);
	const isPlainFile = (item) => !tableOwned.has(pathOf(item));
	const plain = {
		added: files.added.filter(isPlainFile),
		modified: files.modified.filter(isPlainFile),
		removed: files.removed.filter(isPlainFile),
	};

	const changed = files.added.length + files.modified.length + files.removed.length;
	emit(
		args,
		() => {
			process.stdout.write(`diff against checkpoint ${shortId(id)}\n`);
			process.stdout.write(`  ${plain.added.length} added\n`);
			process.stdout.write(`  ${plain.modified.length} modified\n`);
			process.stdout.write(`  ${plain.removed.length} deleted\n`);
			process.stdout.write(`  ${files.unchanged.length} unchanged\n`);
			if (files.unreadable.length > 0) {
				process.stdout.write(`  ${files.unreadable.length} unreadable from journal\n`);
			}
			const rowTotal =
				tables.missing.length + tables.updated.length + tables.extra.length + tables.droppedTables.length;
			if (rowTotal > 0) {
				process.stdout.write(
					`  rows: ${tables.missing.length} missing, ${tables.updated.length} changed, ${tables.extra.length} extra\n`,
				);
			}
			// A dropped table is the loudest signal there is, so it leads.
			for (const t of tables.droppedTables) {
				process.stdout.write(`  table dropped: ${t.dbPath}:${t.table}\n`);
			}
			for (const list of [plain.modified, plain.removed, plain.added]) {
				for (const item of list.slice(0, 20)) {
					process.stdout.write(`    ${pathOf(item)}\n`);
				}
			}
		},
		() => ({
			ok: true,
			id,
			changed,
			files: {
				added: plain.added.map((f) => f.path),
				modified: plain.modified.map((f) => f.path),
				deleted: plain.removed,
				unchanged: files.unchanged,
				unreadable: files.unreadable,
			},
			// Reported separately so a caller can still see that a database file
			// changed on disk even though restore handles it table by table.
			tableOwnedDatabases: [...tableOwned],
			tables,
		}),
	);
}

async function cmdRestore(args) {
	const root = resolveRoot(args.flags);
	const journal = requireJournal(root);
	const id = parseId(args._[1]);
	const cp = journal.getCheckpoint(id);
	if (!cp) throw new Error(`no checkpoint ${args._[1]}`);

	const dryRun = Boolean(args.flags["dry-run"]);
	const purge = Boolean(args.flags.purge);
	const removeExtra = Boolean(args.flags["remove-extra"]);

	if (!dryRun && !args.flags.yes) {
		const risky = purge || removeExtra;
		const question = risky
			? `Restore ${shortId(id)} and delete new files/rows? This cannot be undone.`
			: `Restore ${shortId(id)}?`;
		if (!confirm(question)) {
			process.stdout.write("aborted\n");
			journal.close();
			return;
		}
	}

	const fileResult = restoreFiles(journal, id, root, { purge, dryRun });
	const tableResult = restoreTables(journal, id, root, { removeExtra });

	if (!dryRun) {
		journal.setCheckpointStatus(id, "restored");
	}
	journal.close();

	emit(
		args,
		() => {
			process.stdout.write(
				`${dryRun ? "would restore" : "restored"} checkpoint ${shortId(id)}${cp.label ? ` (${cp.label})` : ""}\n`,
			);
			process.stdout.write(`  ${fileResult.written.length} files written\n`);
			process.stdout.write(`  ${fileResult.unchanged} already identical\n`);
			if (fileResult.purged.length > 0) process.stdout.write(`  ${fileResult.purged.length} new files removed\n`);
			if (fileResult.purgedDirs.length > 0) {
				process.stdout.write(`  ${fileResult.purgedDirs.length} empty directories removed\n`);
			}
			if (fileResult.skipped.length > 0) {
				process.stdout.write(`  ${fileResult.skipped.length} skipped (too large to store)\n`);
			}
			if (tableResult.created > 0) {
				process.stdout.write(`  ${tableResult.created} tables recreated\n`);
			}
			if (tableResult.restored > 0) process.stdout.write(`  ${tableResult.restored} rows written\n`);
			if (tableResult.deleted > 0) process.stdout.write(`  ${tableResult.deleted} rows removed\n`);
			for (const e of fileResult.errors.concat(tableResult.errors)) {
				process.stdout.write(`  error: ${e}\n`);
			}
		},
		() => ({ ok: true, id, files: fileResult, tables: tableResult }),
	);
}

async function cmdTables(args) {
	const root = resolveRoot(args.flags);
	const dbPath = args._[1];
	if (!dbPath) throw new Error("usage: preimage tables <db>");
	const abs = path.resolve(root, dbPath);
	const tables = listTables(abs);
	emit(args, () => {
		for (const t of tables) process.stdout.write(`${t}\n`);
	}, () => ({ ok: true, dbPath, tables }));
}

/**
 * Resolve the bundled hook script for a target agent.
 * Returns null when this build does not ship one.
 */
function bundledHook(target) {
	if (target !== "claude-code" && target !== "opencode") return null;
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.join(here, "..", "integrations", target, "preimage-checkpoint.sh");
}

async function cmdHook(args) {
	const verb = args._[1];
	if (verb !== undefined && verb !== "install") {
		throw new Error(`unknown hook subcommand: ${verb} (expected "hook install")`);
	}
	const target = args._[2] ?? "claude-code";
	const script = bundledHook(target);
	if (!script) {
		throw new Error(`unknown hook target: ${target} (expected claude-code or opencode)`);
	}
	if (!fs.existsSync(script)) {
		throw new Error(`hook script missing from this install: ${script}`);
	}
	const quoted = JSON.stringify(script);

	const payload = {
		"claude-code": {
			file: "~/.claude/settings.json",
			fragment: {
				hooks: {
					PreToolUse: [
						{
							matcher: "Edit|Write|MultiEdit|NotebookEdit",
							hooks: [{ type: "command", command: quoted }],
						},
					],
				},
			},
			note: "Merge the hooks object into your existing settings.json rather than replacing it. The hook debounces, so it snapshots at most once every 120s (PREIMAGE_SESSION_WINDOW).",
		},
		opencode: {
			file: "your plugin or shell wrapper",
			fragment: { command: [quoted, "$PWD"].join(" ") },
			note: "Call the script before any mutating step in your plugin. It snapshots at most once every 120s (PREIMAGE_SESSION_WINDOW) and never fails the build.",
		},
	}[target];

	emit(
		args,
		() => {
			process.stdout.write(`Add this to ${payload.file}:\n\n`);
			process.stdout.write(`${JSON.stringify(payload.fragment, null, 2)}\n\n`);
			process.stdout.write(`${payload.note}\n`);
		},
		() => ({ ok: true, target, script, ...payload }),
	);
}

async function cmdGc(args) {
	const root = resolveRoot(args.flags);
	const journal = requireJournal(root);
	const freed = journal.gc();
	const stats = journal.stats();
	journal.close();
	emit(
		args,
		() => process.stdout.write(`freed ${humanBytes(freed)}, ${stats.blobs} blobs remain\n`),
		() => ({ ok: true, freed, ...stats }),
	);
}

const COMMANDS = {
	init: cmdInit,
	checkpoint: cmdCheckpoint,
	list: cmdList,
	ls: cmdList,
	show: cmdShow,
	diff: cmdDiff,
	restore: cmdRestore,
	tables: cmdTables,
	hook: cmdHook,
	gc: cmdGc,
};

export async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	const cmd = args._[0];
	if (!cmd || args.flags.help || cmd === "help") {
		process.stdout.write(USAGE);
		return 0;
	}
	const fn = COMMANDS[cmd];
	if (!fn) {
		process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
		return 2;
	}
	try {
		await fn(args);
		return 0;
	} catch (err) {
		process.stderr.write(`error: ${err.message}\n`);
		if (args.flags.json) {
			process.stdout.write(`${JSON.stringify({ ok: false, error: err.message }, null, 2)}\n`);
		}
		return 1;
	}
}