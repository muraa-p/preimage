// MCP server (stdio, JSON-RPC 2.0).
//
// This is the surface an agent actually calls. Tools are intentionally
// destructive-by-explicit: `preimage_restore` requires `confirm: true`, so an
// agent cannot roll the workspace back by accident while chasing a task.
//
// Implemented directly against the spec rather than via the SDK so preimage
// stays dependency-free. It is a tool that sits in the agent's hot path, and
// every dependency there is attack surface.

import fs from "node:fs";
import { Journal } from "./journal.js";
import { scanTree, persistTree, diffTree, DEFAULT_MAX_FILE_BYTES } from "./capture.js";
import { restoreFiles } from "./restore.js";
import { captureTables, diffTables, restoreTables, listTables } from "./dbadapter.js";
import { journalDir, ensureDir, humanBytes, shortId } from "./util.js";

const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
	{
		name: "preimage_checkpoint",
		description:
			"Snapshot the current state of the workspace before making risky changes. Returns a checkpoint id to pass to preimage_restore or preimage_diff. Use this BEFORE running migrations, bulk edits, refactors, or anything an agent might get wrong.",
		inputSchema: {
			type: "object",
			properties: {
				label: { type: "string", description: "Short human-readable reason, e.g. 'before schema migration'" },
				databases: {
					type: "array",
					items: { type: "string" },
					description: "SQLite files to capture tables from, relative to the project root",
				},
				tables: {
					type: "array",
					items: { type: "string" },
					description: "Specific tables to capture. Omit to capture every table in each database.",
				},
			},
		},
	},
	{
		name: "preimage_diff",
		description:
			"Show what changed since a checkpoint: files added, modified, deleted, and SQLite rows inserted, updated or removed. Read-only.",
		inputSchema: {
			type: "object",
			properties: {
				checkpointId: { type: "number", description: "Checkpoint id. Defaults to the most recent." },
			},
			required: [],
		},
	},
	{
		name: "preimage_restore",
		description:
			"Roll the workspace back to a checkpoint. Requires confirm:true. By default only restores previously-existing files; pass purge to also delete files created after the checkpoint, and removeExtra to also delete rows added after it.",
		inputSchema: {
			type: "object",
			properties: {
				checkpointId: { type: "number", description: "Checkpoint id. Defaults to the most recent." },
				confirm: {
					type: "boolean",
					description: "Must be true. Guards against accidental rollback.",
				},
				purge: { type: "boolean", description: "Delete files created after the checkpoint" },
				removeExtra: { type: "boolean", description: "Delete rows created after the checkpoint" },
				dryRun: { type: "boolean", description: "Report what would change without writing" },
			},
			required: ["confirm"],
		},
	},
	{
		name: "preimage_list",
		description: "List recent checkpoints with their file counts, sizes and labels.",
		inputSchema: { type: "object", properties: { limit: { type: "number" } } },
	},
];

function textResult(payload) {
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message) {
	return { isError: true, content: [{ type: "text", text: message }] };
}

function resolveCheckpoint(journal, arg) {
	if (arg === undefined || arg === null) {
		const latest = journal.latestCheckpoint();
		if (!latest) throw new Error("no checkpoints exist yet");
		return latest;
	}
	const cp = journal.getCheckpoint(arg);
	if (!cp) throw new Error(`no checkpoint with id ${arg}`);
	return cp;
}

function handleTool(name, args, root) {
	const dir = journalDir(root);
	if (!fs.existsSync(dir)) {
		if (name === "preimage_checkpoint") {
			ensureDir(dir);
		} else {
			throw new Error(`no journal for ${root}. Take a checkpoint first.`);
		}
	}
	const journal = Journal.open(root);
	try {
		switch (name) {
			case "preimage_checkpoint": {
				const id = journal.createCheckpoint({
					root,
					label: args?.label ?? null,
					source: args?.source ?? "mcp",
				});
				const tree = scanTree(root, { maxFileBytes: DEFAULT_MAX_FILE_BYTES });
				const { fileCount, totalBytes } = persistTree(journal, id, tree);

				let rowCount = 0;
				const captured = [];
				for (const dbPath of args?.databases ?? []) {
					try {
						const r = captureTables(journal, id, {
							root,
							dbPath,
							tables: args?.tables ?? [],
						});
						rowCount += r.rowCount;
						captured.push(r);
					} catch (err) {
						captured.push({ dbPath, error: err.message });
					}
				}
				journal.finaliseCheckpoint(id, { fileCount, totalBytes, dbCount: rowCount });
				return textResult({
					ok: true,
					checkpointId: id,
					label: args?.label ?? null,
					files: fileCount,
					bytes: totalBytes,
					bytesHuman: humanBytes(totalBytes),
					rows: rowCount,
					databases: captured,
				});
			}

			case "preimage_list": {
				const rows = journal.listCheckpoints({ limit: args?.limit ?? 20 });
				return textResult({
					ok: true,
					checkpoints: rows.map((r) => ({
						id: r.id,
						label: r.label,
						status: r.status,
						files: r.file_count,
						bytesHuman: humanBytes(r.total_bytes),
						rows: r.db_count,
						takenAt: new Date(r.created_at).toISOString(),
					})),
				});
			}

			case "preimage_diff": {
				const cp = resolveCheckpoint(journal, args?.checkpointId);
				const files = diffTree(journal, cp.id, root);
				const tables = journal.listDbTables(cp.id).length > 0 ? diffTables(journal, cp.id, root) : null;
				return textResult({
					ok: true,
					checkpointId: cp.id,
					label: cp.label,
					changed:
						files.added.length + files.modified.length + files.removed.length,
					files: {
						added: files.added.map((f) => f.path),
						modified: files.modified.map((f) => f.path),
						deleted: files.removed,
						unchanged: files.unchanged.length,
						unreadable: files.unreadable,
					},
					tables,
				});
			}

			case "preimage_restore": {
				if (args?.confirm !== true) {
					return errorResult(
						"refusing to restore: confirm must be true. Ask the user before rolling back.",
					);
				}
				const cp = resolveCheckpoint(journal, args?.checkpointId);
				const dryRun = args?.dryRun === true;
				const fileResult = restoreFiles(journal, cp.id, root, {
					purge: args?.purge === true,
					dryRun,
				});
				const tableResult = restoreTables(journal, cp.id, root, {
					removeExtra: args?.removeExtra === true,
				});
				if (!dryRun) journal.setCheckpointStatus(cp.id, "restored");
				return textResult({
					ok: fileResult.errors.length === 0 && tableResult.errors.length === 0,
					dryRun,
					checkpointId: cp.id,
					label: cp.label,
					files: {
						written: fileResult.written.map((w) => w.path),
						unchanged: fileResult.unchanged,
						purged: fileResult.purged,
						skipped: fileResult.skipped,
						errors: fileResult.errors,
					},
					tables: tableResult,
				});
			}

			default:
				return errorResult(`unknown tool: ${name}`);
		}
	} finally {
		journal.close();
	}
}

export function createServer({ root = process.cwd(), stdout = process.stdout } = {}) {
	const send = (msg) => stdout.write(`${JSON.stringify(msg)}\n`);

	return async function handle(line) {
		let req;
		try {
			req = JSON.parse(line);
		} catch {
			return;
		}
		const { id, method, params } = req;
		const reply = (result) => send({ jsonrpc: "2.0", id, result });
		const fail = (code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

		switch (method) {
			case "initialize":
				return reply({
					protocolVersion: PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "preimage", version: "0.1.0" },
				});
			case "notifications/initialized":
				return undefined;
			case "ping":
				return reply({});
			case "tools/list":
				return reply({ tools: TOOLS });
			case "tools/call": {
				const name = params?.name;
				if (!TOOLS.some((t) => t.name === name)) {
					return reply(errorResult(`unknown tool: ${name}`));
				}
				try {
					return reply(handleTool(name, params?.arguments ?? {}, root));
				} catch (err) {
					return reply(errorResult(err.message));
				}
			}
			default:
				return fail(-32601, `method not found: ${method}`);
		}
	};
}

/** Read newline-delimited JSON-RPC from stdin until closed. */
export async function runStdio({
	root = process.cwd(),
	input = process.stdin,
	stdout = process.stdout,
} = {}) {
	const handle = createServer({ root, stdout });
	let buffer = "";
	input.setEncoding("utf8");
	for await (const chunk of input) {
		buffer += chunk;
		let idx;
		while ((idx = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, idx).trim();
			buffer = buffer.slice(idx + 1);
			if (line.length > 0) await handle(line);
		}
	}
	// stdin closed. A client that did not terminate its final request with a
	// newline still expects an answer, so flush whatever is left.
	const tail = buffer.trim();
	if (tail.length > 0) await handle(tail);
}