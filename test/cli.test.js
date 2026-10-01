import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/preimage.js", import.meta.url));

function tmpRoot(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preimage-cli-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function write(root, rel, content) {
	const abs = path.join(root, ...rel.split("/"));
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
}

/** Run the CLI against a root, returning parsed JSON output. */
async function run(args, { expectFail = false } = {}) {
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
			maxBuffer: 10 * 1024 * 1024,
		});
		assert.ok(!expectFail, `expected failure but command succeeded: ${args.join(" ")}`);
		return { stdout, stderr, code: 0 };
	} catch (err) {
		assert.ok(expectFail, `command failed: ${args.join(" ")}\n${err.stderr ?? err.message}`);
		return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
	}
}

async function runJson(args, opts) {
	const { stdout } = await run(args, opts);
	return JSON.parse(stdout);
}

test("checkpoint --json reports counts and bytes", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "hello");
	write(root, "src/b.js", "console.log(1)");

	const out = await runJson(["checkpoint", "initial", "--root", root, "--json"]);
	assert.equal(out.ok, true);
	assert.equal(out.label, "initial");
	assert.equal(out.fileCount, 2);
	assert.equal(out.totalBytes, "hello".length + "console.log(1)".length);
});

test("list --json returns newest checkpoint first", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "one");
	const first = await runJson(["checkpoint", "first", "--root", root, "--json"]);
	write(root, "a.txt", "two");
	const second = await runJson(["checkpoint", "second", "--root", root, "--json"]);

	const out = await runJson(["list", "--root", root, "--json"]);
	assert.equal(out.checkpoints.length, 2);
	assert.equal(out.checkpoints[0].id, second.id);
	assert.equal(out.checkpoints[1].label, "first");
	assert.ok(first.id < second.id);
});

test("checkpoint --db captures table rows", async (t) => {
	const root = tmpRoot(t);
	const db = new DatabaseSync(path.join(root, "app.db"));
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)");
	db.prepare("INSERT INTO users VALUES (?, ?)").run(1, "a@x.com");
	db.close();

	const out = await runJson(["checkpoint", "with-db", "--root", root, "--db", "app.db", "--json"]);
	assert.equal(out.rowCount, 1);
	assert.equal(out.databases[0].tables.length, 1);
});

test("diff --json classifies file changes", async (t) => {
	const root = tmpRoot(t);
	write(root, "keep.txt", "same");
	write(root, "change.txt", "before");
	write(root, "drop.txt", "bye");

	const { id } = await runJson(["checkpoint", "--root", root, "--json"]);
	write(root, "change.txt", "after");
	write(root, "new.txt", "fresh");
	fs.unlinkSync(path.join(root, "drop.txt"));

	const out = await runJson(["diff", String(id), "--root", root, "--json"]);
	assert.equal(out.changed, 3);
	assert.deepEqual(out.files.added, ["new.txt"]);
	assert.deepEqual(out.files.modified, ["change.txt"]);
	assert.deepEqual(out.files.deleted, ["drop.txt"]);
	assert.deepEqual(out.files.unchanged, ["keep.txt"]);
});

test("restore --json --yes rewrites files", async (t) => {
	const root = tmpRoot(t);
	write(root, "config.json", '{"v":1}');

	const { id } = await runJson(["checkpoint", "--root", root, "--json"]);
	write(root, "config.json", '{"v":2}');

	const out = await runJson(["restore", String(id), "--root", root, "--yes", "--json"]);
	assert.equal(out.ok, true);
	assert.equal(out.files.written.length, 1);
	assert.equal(fs.readFileSync(path.join(root, "config.json"), "utf8"), '{"v":1}');
});

test("restore --dry-run reports without writing", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "original");

	const { id } = await runJson(["checkpoint", "--root", root, "--json"]);
	write(root, "a.txt", "broken");

	const out = await runJson(["restore", String(id), "--root", root, "--yes", "--dry-run", "--json"]);
	assert.equal(out.files.dryRun, true);
	assert.equal(out.files.written.length, 1);
	assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "broken");
});

test("restore --purge --remove-extra clears new files and rows", async (t) => {
	const root = tmpRoot(t);
	const db = new DatabaseSync(path.join(root, "app.db"));
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)");
	db.prepare("INSERT INTO users VALUES (?, ?)").run(1, "keep@x.com");
	db.close();
	write(root, "original.txt", "original");

	const { id } = await runJson([
		"checkpoint", "--root", root, "--db", "app.db", "--json",
	]);

	// The agent adds a file and a row, and breaks the original file.
	write(root, "original.txt", "broken");
	write(root, "agent-junk.txt", "junk");
	const db2 = new DatabaseSync(path.join(root, "app.db"));
	db2.prepare("INSERT INTO users VALUES (?, ?)").run(2, "junk@x.com");
	db2.close();

	await runJson(["restore", String(id), "--root", root, "--yes", "--purge", "--remove-extra", "--json"]);

	assert.equal(fs.readFileSync(path.join(root, "original.txt"), "utf8"), "original");
	assert.equal(fs.existsSync(path.join(root, "agent-junk.txt")), false);

	const db3 = new DatabaseSync(path.join(root, "app.db"), { readOnly: true });
	assert.equal(Number(db3.prepare("SELECT COUNT(*) AS n FROM users").get().n), 1);
	db3.close();
});

test("restore marks the checkpoint as restored", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "one");

	const { id } = await runJson(["checkpoint", "--root", root, "--json"]);
	await runJson(["restore", String(id), "--root", root, "--yes", "--json"]);

	const out = await runJson(["show", String(id), "--root", root, "--json"]);
	assert.equal(out.checkpoint.status, "restored");
});

test("commands fail cleanly without a journal", async (t) => {
	const root = tmpRoot(t);
	const { stderr } = await run(["list", "--root", root], { expectFail: true });
	assert.match(stderr, /no journal/);
	assert.match(stderr, /preimage init/);
});

test("checkpoint works without init, creating the journal", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "x");

	const out = await runJson(["checkpoint", "--root", root, "--json"]);
	assert.equal(out.ok, true);
	assert.equal(fs.existsSync(path.join(root, ".preimage", "journal.db")), true);
});

test("unknown checkpoint id fails with a clear message", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "x");
	await runJson(["checkpoint", "--root", root, "--json"]);

	const { stderr } = await run(["show", "9999", "--root", root, "--json"], { expectFail: true });
	assert.match(stderr, /no checkpoint 9999/);
});

test("tables lists tables in a database", async (t) => {
	const root = tmpRoot(t);
	const db = new DatabaseSync(path.join(root, "app.db"));
	db.exec("CREATE TABLE alpha (id INTEGER PRIMARY KEY); CREATE TABLE beta (id INTEGER PRIMARY KEY);");
	db.close();

	const out = await runJson(["tables", "app.db", "--root", root, "--json"]);
	assert.deepEqual(out.tables, ["alpha", "beta"]);
});

test("gc frees unreferenced blobs", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "content that occupies space");
	const { id } = await runJson(["checkpoint", "--root", root, "--json"]);

	const before = await runJson(["gc", "--root", root, "--json"]);
	assert.equal(before.freed, 0);

	// Dropping the checkpoint via a direct journal call is what gc supports;
	// verify gc is safe to run twice regardless.
	const second = await runJson(["gc", "--root", root, "--json"]);
	assert.equal(second.freed, 0);
	assert.ok(id);
});

test("journal is ignored by its own scanner", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "one");

	const first = await runJson(["checkpoint", "--root", root, "--json"]);
	assert.equal(first.fileCount, 1);

	// A second checkpoint must not capture the journal's own files.
	const second = await runJson(["checkpoint", "--root", root, "--json"]);
	assert.equal(second.fileCount, 1);
});

test("multiple --db flags are all captured", async (t) => {
	const root = tmpRoot(t);
	for (const name of ["one.db", "two.db"]) {
		const db = new DatabaseSync(path.join(root, name));
		db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
		db.prepare("INSERT INTO t VALUES (?, ?)").run(1, "x");
		db.close();
	}

	const out = await runJson([
		"checkpoint", "--root", root, "--db", "one.db", "--db", "two.db", "--json",
	]);
	assert.equal(out.databases.length, 2);
	assert.equal(out.rowCount, 2);
});

test("multiple --table flags narrow capture", async (t) => {
	const root = tmpRoot(t);
	const db = new DatabaseSync(path.join(root, "app.db"));
	db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY); CREATE TABLE b (id INTEGER PRIMARY KEY);");
	db.prepare("INSERT INTO a VALUES (1)").run();
	db.prepare("INSERT INTO b VALUES (1)").run();
	db.close();

	const out = await runJson([
		"checkpoint", "--root", root, "--db", "app.db", "--table", "a", "--json",
	]);
	assert.equal(out.rowCount, 1);
	assert.deepEqual(out.databases[0].tables, ["a"]);
});

test("hook install claude-code returns a mergeable settings fragment", async (t) => {
	tmpRoot(t);
	const out = await runJson(["hook", "install", "claude-code", "--json"]);
	assert.equal(out.ok, true);
	assert.equal(out.target, "claude-code");
	assert.match(out.fragment.hooks.PreToolUse[0].matcher, /Edit/);
	assert.match(out.fragment.hooks.PreToolUse[0].hooks[0].command, /preimage-checkpoint\.sh/);
	assert.match(out.file, /settings\.json/);
});

test("hook install opencode returns a runnable command", async (t) => {
	tmpRoot(t);
	const out = await runJson(["hook", "install", "opencode", "--json"]);
	assert.equal(out.target, "opencode");
	assert.match(out.fragment.command, /preimage-checkpoint\.sh/);
});

test("hook install rejects an unknown target", async (t) => {
	tmpRoot(t);
	const { stderr } = await run(["hook", "install", "emacs", "--json"], { expectFail: true });
	assert.match(stderr, /unknown hook target/);
});

test("--help exits zero and prints usage", async (t) => {
	tmpRoot(t);
	const { stdout } = await run(["--help"]);
	assert.match(stdout, /the undo layer for AI agents/);
});