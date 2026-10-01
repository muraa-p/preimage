import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/preimage.js", import.meta.url));
const ROOT_URL = new URL("../", import.meta.url);
const { Journal, isRestorable, STATUS_WRITING } = await import(
	new URL("src/journal.js", ROOT_URL).href
);

function tmpRoot(t) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "preimage-atomic-")));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function write(root, rel, content) {
	const abs = path.join(root, ...rel.split("/"));
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
}

async function run(args, { expectFail = false } = {}) {
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
			maxBuffer: 10 * 1024 * 1024,
		});
		assert.ok(!expectFail, `expected failure but succeeded: ${args.join(" ")}`);
		return { stdout, stderr, code: 0 };
	} catch (err) {
		assert.ok(expectFail, `command failed: ${args.join(" ")}\n${err.stderr ?? err.message}`);
		return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
	}
}

/** Run the CLI with --json appended, so a failure surfaces as a parse error. */
async function runJson(args, opts) {
	const { stdout } = await run([...args, "--json"], opts);
	return JSON.parse(stdout);
}

/* --- the checkpoint lifecycle ------------------------------------------- */

test("a finalised checkpoint is marked open and is restorable", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "one");
	const created = await runJson(["checkpoint", "--root", root]);
	assert.equal(created.ok, true);

	const j = Journal.open(root);
	const cp = j.getCheckpoint(created.id);
	assert.equal(cp.status, "open");
	assert.equal(isRestorable(cp), true);
	j.close();
});

test("an unfinished checkpoint is refused by restore rather than silently doing nothing", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "original");

	// A real checkpoint first, so there is something valid to fall back to.
	const good = await runJson(["checkpoint", "good", "--root", root]);

	// What a crash between the INSERT and the finalising UPDATE leaves behind.
	const j = Journal.open(root);
	const ghost = j.createCheckpoint({ root, label: "crashed mid-write" });
	j.close();

	const { stderr, code } = await run(
		["restore", String(ghost), "--yes", "--root", root, "--json"],
		{ expectFail: true },
	);
	assert.equal(code, 1);
	assert.match(stderr, /incomplete/);
	assert.match(stderr, /nothing in it to restore/);

	// The critical part: a restore that reports success without changing
	// anything is worse than one that fails, because the caller moves on
	// believing the rollback worked.
	const listed = await runJson(["list", "--root", root]);
	const ghostRow = listed.checkpoints.find((c) => c.id === ghost);
	assert.equal(ghostRow.status, STATUS_WRITING);

	// `diff` must not silently fall back to an empty checkpoint and report
	// every real file as newly added.
	const diffed = await run(["diff", "--root", root], { expectFail: false });
	assert.match(diffed.stdout, new RegExp(`against checkpoint ${String(good.id).padStart(4, "0")}`));
});

test("diff and show refuse an unfinished checkpoint", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "x");
	await runJson(["checkpoint", "--root", root]);
	const j = Journal.open(root);
	const ghost = j.createCheckpoint({ root, label: "half done" });
	j.close();

	for (const command of ["diff", "show"]) {
		const { stderr } = await run([command, String(ghost), "--root", root], { expectFail: true });
		assert.match(stderr, /incomplete/, `${command} should explain the checkpoint is unusable`);
	}
});

test("list says plainly that an unfinished checkpoint has nothing to restore", async (t) => {
	const root = tmpRoot(t);
	const j = Journal.open(root);
	j.createCheckpoint({ root, label: "crashed" });
	j.close();
	const { stdout } = await run(["list", "--root", root]);
	assert.match(stdout, /incomplete, nothing to restore/);
});

test("the newest restorable checkpoint is chosen when the newest row is unfinished", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "x");
	const good = await runJson(["checkpoint", "good", "--root", root]);
	const j = Journal.open(root);
	j.createCheckpoint({ root, label: "later but unfinished" });
	assert.equal(j.latestCheckpoint().id, good.id, "latestCheckpoint must skip the unfinished row");
	j.close();
});

test("a failed checkpoint leaves no row behind", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "one");
	await runJson(["checkpoint", "before", "--root", root]);

	// A checkpoint whose table capture throws must not leave a row with no
	// content, because a bare `diff` would then default to it.
	const j = Journal.open(root);
	const before = j.listCheckpoints().length;
	j.close();

	const { code, stderr } = await run(
		["checkpoint", "doomed", "--root", root, "--db", "missing.db", "--table", "t"],
		{ expectFail: true },
	);
	assert.equal(code, 1);
	assert.ok(stderr.length > 0);

	const j2 = Journal.open(root);
	assert.equal(j2.listCheckpoints().length, before, "the failed checkpoint rolled back");
	j2.close();
});

test("a rollback inside transaction() leaves no partial rows", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "one");
	const j = Journal.open(root);
	assert.throws(() =>
		j.transaction(() => {
			j.createCheckpoint({ root, label: "will be rolled back" });
			throw new Error("deliberate");
		}),
	);
	assert.equal(j.listCheckpoints().length, 0);
	j.close();
});

/* --- concurrency --------------------------------------------------------- */

test("concurrent checkpoints all succeed instead of colliding on the journal", async (t) => {
	const root = tmpRoot(t);
	for (let i = 0; i < 30; i++) write(root, `f${i}.txt`, `content ${i} `);

	const results = await Promise.all(
		Array.from({ length: 6 }, (_, i) =>
			execFileAsync(process.execPath, [BIN, "checkpoint", `race-${i}`, "--root", root], {
				maxBuffer: 10 * 1024 * 1024,
			}).then(
				() => ({ ok: true }),
				(err) => ({ ok: false, msg: err.stderr ?? err.message }),
			),
		),
	);
	const failed = results.filter((r) => !r.ok);
	assert.deepEqual(
		failed.map((f) => f.msg),
		[],
		"every concurrent checkpoint should wait its turn rather than fail",
	);

	const listed = await runJson(["list", "--root", root]);
	assert.equal(listed.checkpoints.length, 6);
	assert.equal(new Set(listed.checkpoints.map((c) => c.id)).size, 6, "ids must be unique");
	for (const cp of listed.checkpoints) {
		assert.equal(cp.file_count, 30, `checkpoint ${cp.id} captured the wrong file count`);
		assert.equal(cp.status, "open");
	}
});

/* --- flag parsing -------------------------------------------------------- */

test("a repeated scalar flag takes the last value instead of crashing", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "one");
	const created = await runJson(["checkpoint", "--root", root, "--root", root]);
	assert.equal(created.ok, true);
	assert.equal(created.fileCount, 1);
});

test("a repeated --root in both forms does not reach path.resolve as an array", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "one");
	const created = await runJson(["checkpoint", `--root=${root}`, "--root", root]);
	assert.equal(created.ok, true);
});

test("repeated --db and --table flags still collect", async (t) => {
	const root = tmpRoot(t);
	for (const name of ["one.db", "two.db"]) {
		const db = new (await import("node:sqlite")).DatabaseSync(path.join(root, name));
		db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
		db.close();
	}
	const created = await runJson([
		"checkpoint",
		"--root",
		root,
		"--db",
		"one.db",
		"--table",
		"t",
		"--db",
		"two.db",
		"--table",
		"t",
	]);
	assert.equal(created.databases.length, 2);
});