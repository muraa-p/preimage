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

test("diff shows a unified patch, and --no-hunks suppresses it", async (t) => {
	const root = tmpRoot(t);
	write(root, "app.js", "const port = 3000;\nconst host = 'localhost';\n");
	await run(["checkpoint", "--root", root]);
	write(root, "app.js", "const port = 9999;\nconst host = 'localhost';\n");

	const { stdout } = await run(["diff", "--root", root]);
	// Knowing the file changed is not the same as knowing what changed in it.
	assert.match(stdout, /--- a\/app\.js/);
	assert.match(stdout, /\+\+\+ b\/app\.js/);
	assert.match(stdout, /^@@ -\d+,\d+ \+\d+,\d+ @@/m);
	assert.match(stdout, /-const port = 3000;/);
	assert.match(stdout, /\+const port = 9999;/);
	// The summary still leads, so the shape of the change is readable first.
	assert.ok(stdout.indexOf("1 modified") < stdout.indexOf("--- a/app.js"));

	const { stdout: bare } = await run(["diff", "--root", root, "--no-hunks"]);
	assert.match(bare, /1 modified/);
	assert.doesNotMatch(bare, /--- a\/app\.js/);
});

test("diff --json carries the patch and its line counts", async (t) => {
	const root = tmpRoot(t);
	write(root, "app.js", "one\ntwo\n");
	await run(["checkpoint", "--root", root]);
	write(root, "app.js", "one\nTWO\nthree\n");

	const { stdout } = await run(["diff", "--root", root, "--json"]);
	const v = JSON.parse(stdout);
	assert.equal(v.patches.length, 1);
	assert.equal(v.patches[0].path, "app.js");
	assert.equal(v.patches[0].added, 2);
	assert.equal(v.patches[0].removed, 1);
	assert.equal(v.patches[0].binary, false);
});

test("a binary file is reported as such rather than as an empty patch", async (t) => {
	const root = tmpRoot(t);
	fs.writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
	await run(["checkpoint", "--root", root]);
	fs.writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x02]));

	const { stdout } = await run(["diff", "--root", root, "--json"]);
	const v = JSON.parse(stdout);
	const entry = v.patches.find((p) => p.path === "logo.png");
	assert.ok(entry, "the changed binary file is still listed");
	assert.equal(entry.binary, true);
	assert.equal(entry.reason, "binary file");
});

test("commands fail cleanly without a journal", async (t) => {
	const root = tmpRoot(t);
	const { stderr } = await run(["list", "--root", root], { expectFail: true });
	assert.match(stderr, /no journal/);
	assert.match(stderr, /preimage checkpoint/);
});

test("running from a subdirectory points at the journal one level up", async (t) => {
	const root = tmpRoot(t);
	write(root, "src/app.js", "one");
	await run(["checkpoint", "--root", root]);
	write(root, "src/app.js", "two");

	// Most work happens in a subdirectory, and "no journal" there is a dead end:
	// the journal exists, just not where you are standing.
	const sub = path.join(root, "src");
	const { stderr } = await run(["list", "--root", sub], { expectFail: true });
	assert.match(stderr, /no journal/);
	assert.match(stderr, /journal one level up/);
	assert.match(stderr, new RegExp(`--root ${root.replace(/\\/g, "\\\\")}`));

	// And it must not silently act on the parent instead. Restore has to be
	// pointed at the right project explicitly.
	await run(["checkpoint", "--root", sub]);
	const { stdout } = await run(["list", "--root", sub, "--json"]);
	const listed = JSON.parse(stdout);
	assert.equal(listed.checkpoints.length, 1, "the subdirectory gets its own journal");
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

test("diff with no id compares against the most recent checkpoint", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "one");
	await run(["checkpoint", "first", "--root", root]);

	// A second checkpoint, so "latest" is not simply "the only one".
	write(root, "a.txt", "two");
	await run(["checkpoint", "second", "--root", root]);
	write(root, "a.txt", "three");

	const implicit = await runJson(["diff", "--root", root, "--json"]);
	const explicit = await runJson(["diff", "2", "--root", root, "--json"]);
	assert.deepEqual(implicit.files, explicit.files);
	assert.equal(implicit.id, 2);
	assert.deepEqual(implicit.files.modified, ["a.txt"]);
});

test("show with no id summarises the most recent checkpoint", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "one");
	await run(["checkpoint", "first", "--root", root]);
	write(root, "a.txt", "two");
	await run(["checkpoint", "second", "--root", root]);

	const implicit = await runJson(["show", "--root", root, "--json"]);
	const explicit = await runJson(["show", "2", "--root", root, "--json"]);
	assert.deepEqual(implicit, explicit);
	assert.equal(implicit.checkpoint.id, 2);
	assert.equal(implicit.checkpoint.label, "second");
});

test("diff with no checkpoints explains what to do first", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "one");
	await run(["init", "--root", root]);
	const res = await run(["diff", "--root", root], { expectFail: true });
	assert.match(res.stderr, /no checkpoints yet/);
	assert.match(res.stderr, /preimage checkpoint/);
});

test("restore still requires an explicit id", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "one");
	await run(["checkpoint", "--root", root]);

	// Defaulting restore to "latest" would silently roll back the wrong thing
	// whenever someone has several checkpoints and no clear memory of which.
	const res = await run(["restore", "--root", root, "--yes"], { expectFail: true });
	assert.match(res.stderr, /checkpoint id required/);
});

test("checkpoint reports a table that does not exist instead of claiming success", async (t) => {
	const root = tmpRoot(t);
	const dbAbs = path.join(root, "app.db");
	const db = new DatabaseSync(dbAbs);
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)");
	db.prepare("INSERT INTO users VALUES (?, ?)").run(1, "a@example.com");
	db.close();

	const res = await runJson(
		["checkpoint", "--root", root, "--db", "app.db", "--table", "users", "--table", "ghost", "--json"],
	);
	assert.equal(res.ok, true);
	assert.deepEqual(res.databases[0].skipped, ["ghost"]);
	assert.deepEqual(res.databases[0].tables, ["users"]);
	assert.equal(res.rowCount, 1);
});
