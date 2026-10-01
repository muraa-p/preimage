#!/usr/bin/env node
// Produces the terminal transcript used in the README.
//
//   node scripts/demo.mjs            # instant, for reading
//   node scripts/demo.mjs --paced    # with pauses, for recording (tape/demo.tape)
//
// It runs against a throwaway directory and exercises the two stories the
// README leads with: a botched file edit, and a destructive SQLite migration.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "preimage.js");

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const supportsColour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const c = (code, text) => (supportsColour ? `${code}${text}${RESET}` : text);

// Recording mode. vhs needs the output to arrive slowly enough to be read, and
// the CLI itself finishes in milliseconds, so --paced holds each step open.
// The text is identical either way, which keeps the README honest.
const paced = process.argv.includes("--paced");
const hold = (ms) => {
	if (!paced) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
// Tuned so the whole story lands around 20 seconds. Long enough to read each
// step, short enough that someone actually watches it -- and every second of
// hold is a second of near-identical frames in the GIF.
const STEP_MS = 900;
const READ_MS = 1700;

function step(label) {
	process.stdout.write(`\n${c(BOLD, `$ ${label}`)}\n`);
	hold(STEP_MS);
}

function note(text) {
	process.stdout.write(`${c(DIM, "│")} ${c(YELLOW, text)}\n`);
	hold(READ_MS);
}

function run(args) {
	return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

function show(output) {
	for (const line of output.trimEnd().split("\n")) {
		process.stdout.write(`${c(DIM, "│")} ${line}\n`);
	}
	hold(READ_MS);
}

// Which story to run. Both by default, which is what the README quotes. The
// tape files record them one at a time so each transcript fits on screen.
const storyArg = process.argv.find((a) => a.startsWith("--story="));
const only = storyArg ? storyArg.split("=")[1] : null;
const want = (n) => only === null || only === String(n);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preimage-demo-"));
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "preimage-demo-db-"));

// The file demo runs against a small real service rather than a one-line config
// blob. Two reasons: a multi-line code diff has context lines, so it is legible
// in a GIF at the size a README shows it, and the closing beat is the project's
// own test suite failing and then passing again, which is the thing a viewer
// actually cares about.
const CONFIG_BEFORE = `export const config = {
\tname: "hello-service",
\tport: 3000,
\tgreeting: "Hello",
};
`;

const CONFIG_AFTER = `export const config = {
\tname: "hello-service",
\tport: Number(process.env.PORT) || 8080,
\tgreeting: "Hi",
};
`;

const SERVER_BEFORE = `import http from "node:http";
import { config } from "./config.js";

const server = http.createServer((req, res) => {
\tif (req.url === "/health") {
\t\tres.writeHead(200, { "content-type": "application/json" });
\t\tres.end(JSON.stringify({ ok: true }));
\t\treturn;
\t}

\tres.writeHead(200, { "content-type": "text/plain" });
\tres.end(\`${"${config.greeting}"} from ${"${config.name}"}!\`);
});

server.listen(config.port, () => {
\tconsole.log(\`listening on ${"${config.port}"}\`);
});
`;

const TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../config.js";

test("serves a greeting", () => {
\tassert.match(\`${"${config.greeting}"} from ${"${config.name}"}!\`, /Hello/);
});

test("uses the default port", () => {
\tassert.equal(config.port, 3000);
});
`;

/**
 * Run the project's own tests and summarise, the way a person would.
 *
 * Reads the `pass`/`fail` totals from node's own summary rather than counting
 * the ✔ and ✖ lines: when a test fails, node prints it once during the run and
 * again under "failing tests:", so counting the glyphs reports every failure
 * twice. It said "5 failing" for a project with two tests.
 */
function testSummary(cwd) {
	// When this script is itself run from a test suite, node exports
	// NODE_TEST_CONTEXT=child-v8 to the child. The nested `node --test` then
	// changes behaviour and reports zero tests, so the demo claimed "no tests"
	// when check/readme.test.js exercised it. Clearing the variable makes the
	// nested run behave like a normal one.
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	delete env.NODE_TEST_WORKER_ID;
	let out;
	try {
		out = execFileSync(process.execPath, ["--test"], { cwd, encoding: "utf8", env });
	} catch (e) {
		out = `${e.stdout ?? ""}`;
	}
	const pass = Number(/^ℹ pass (\d+)$/m.exec(out)?.[1] ?? 0);
	const fail = Number(/^ℹ fail (\d+)$/m.exec(out)?.[1] ?? 0);
	if (fail === 0 && pass > 0) return c(GREEN, `✔ ${pass} passing, 0 failing`);
	if (fail === 0) return c(DIM, "no tests");
	return c(RED, `✖ ${fail} failing, ${pass} passing`);
}

try {
if (want(1)) {
	process.stdout.write(c(BOLD, "\nStory 1: the agent changes what it shouldn't have\n"));

	const proj = path.join(dir, "hello-service");
	fs.mkdirSync(path.join(proj, "test"), { recursive: true });
	fs.writeFileSync(path.join(proj, "config.js"), CONFIG_BEFORE);
	fs.writeFileSync(path.join(proj, "server.js"), SERVER_BEFORE);
	fs.writeFileSync(path.join(proj, "test", "config.test.js"), TEST);
	fs.writeFileSync(
		path.join(proj, "package.json"),
		'{\n  "name": "hello-service",\n  "type": "module"\n}\n',
	);

	step(`preimage checkpoint "before the agent gets creative" --root <project>`);
	show(run(["checkpoint", "before the agent gets creative", "--root", proj]));

	step("# the agent quietly changes the port and the greeting, and leaves a stray file");
	// Only config.js is touched. An earlier version also appended a stray
	// console.log to server.js, which made the diff show a second near-identical
	// hunk and told the story no better. One clean hunk reads better on a
	// README-sized image, and server.js still demonstrates the point: it is in
	// the checkpoint, and it is not in the diff, because it did not change.
	fs.writeFileSync(path.join(proj, "config.js"), CONFIG_AFTER);
	fs.writeFileSync(path.join(proj, "DEBUG.md"), "# scratch notes, will delete later\n");
	process.stdout.write(
		`${c(DIM, "│")} ${c(YELLOW, "config.js rewritten, DEBUG.md added")}\n`,
	);
	hold(READ_MS);

	step("# the project's own tests notice");
	process.stdout.write(`${c(DIM, "│")} ${testSummary(proj)}\n`);
	hold(READ_MS);

	// Colour the diff the way a terminal would, so the GIF shows what a user
	// actually sees. When the output is not a terminal -- the plain-text README
	// transcript -- NO_COLOR is forced instead, so the two forms can never
	// disagree by accident.
	const wantColour =
		process.stdout.isTTY ||
		process.env.FORCE_COLOR !== undefined ||
		process.env.COLOR === "always";
	const env = { ...process.env };
	if (wantColour) {
		env.COLOR = "always";
		delete env.NO_COLOR;
	} else {
		env.NO_COLOR = "1";
	}
	const showRun = (args) =>
		show(execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env }));

	step(`preimage diff 1 --root <project>`);
	showRun(["diff", "1", "--root", proj]);

	step(`preimage restore 1 --root <project> --purge --yes`);
	showRun(["restore", "1", "--root", proj, "--purge", "--yes"]);

	step("# tests again, after the rollback");
	process.stdout.write(`${c(DIM, "│")} ${testSummary(proj)}\n`);
	hold(READ_MS);

	step("and the stray file");
	process.stdout.write(
		`${c(DIM, "│")} DEBUG.md: ${fs.existsSync(path.join(proj, "DEBUG.md")) ? c(RED, "still here") : c(GREEN, "gone")}\n`,
	);
	hold(READ_MS);
}

if (want(2)) {
	process.stdout.write(c(BOLD, "\n\nStory 2: the agent ran a migration it should not have\n"));

	const dbPath = path.join(dbDir, "app.db");
	const seed = new DatabaseSync(dbPath);
	seed.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT)");
	seed.prepare("INSERT INTO users VALUES (?, ?, ?)").run(1, "ada@org.org", "admin");
	seed.prepare("INSERT INTO users VALUES (?, ?, ?)").run(2, "bob@org.org", "staff");
	seed.close();

	step(`preimage checkpoint "before migration" --root <project> --db app.db`);
	// This demo uses its own fresh directory, so its checkpoint ids start at 1.
	const dbCheckpoint = 1;
	show(run(["checkpoint", "before migration", "--root", dbDir, "--db", "app.db"]));

	step("# a migration drops a user, promotes another, and invents a third");
	const wreck = new DatabaseSync(dbPath);
	wreck.exec("DELETE FROM users WHERE id = 2");
	wreck.prepare("UPDATE users SET email = ?, role = ? WHERE id = 1").run("root@attacker.com", "superadmin");
	wreck.prepare("INSERT INTO users VALUES (?, ?, ?)").run(99, "ghost@x.com", "admin");
	wreck.close();
	process.stdout.write(`${c(DIM, "│")} ${c(YELLOW, "3 rows changed")}\n`);
	hold(READ_MS);

	step(`preimage diff ${dbCheckpoint} --root <project>`);
	show(run(["diff", String(dbCheckpoint), "--root", dbDir]));

	step(`preimage restore ${dbCheckpoint} --root <project> --remove-extra --yes`);
	show(run(["restore", String(dbCheckpoint), "--root", dbDir, "--remove-extra", "--yes"]));

	const verify = new DatabaseSync(dbPath, { readOnly: true });
	const rows = verify.prepare("SELECT * FROM users ORDER BY id").all();
	verify.close();

	step("rows afterwards");
	process.stdout.write(`${c(DIM, "│")} ${c(CYAN, JSON.stringify(rows))}\n`);
	process.stdout.write(
		`${c(DIM, "│")} ${c(GREEN, "ada is an admin again, bob is back, ghost is gone")}\n`,
	);
}

if (want(3)) {
	process.stdout.write(
		c(BOLD, "\n\nStory 3: the agent dropped a table outright\n"),
	);

	const dropDir = fs.mkdtempSync(path.join(os.tmpdir(), "preimage-demo-drop-"));
	const dbPath = path.join(dropDir, "app.db");
	const seed = new DatabaseSync(dbPath);
	seed.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)");
	seed.exec("CREATE TABLE invoices (id INTEGER PRIMARY KEY, total REAL)");
	seed.prepare("INSERT INTO users VALUES (?, ?)").run(1, "ada@org.org");
	seed.prepare("INSERT INTO invoices VALUES (?, ?)").run(1, 420.5);
	seed.close();

	// The CREATE statement is stored with the rows, which is the only reason
	// this is undoable at all.
	step(`preimage checkpoint "before the schema change" --root <project> --db app.db`);
	show(run(["checkpoint", "before the schema change", "--root", dropDir, "--db", "app.db"]));

	step("# the agent decides users is no longer needed");
	const wreck = new DatabaseSync(dbPath);
	wreck.exec("DROP TABLE users");
	wreck.close();
	process.stdout.write(`${c(DIM, "│")} ${c(YELLOW, "DROP TABLE users")}\n`);
	hold(READ_MS);

	step(`preimage diff 1 --root <project>`);
	show(run(["diff", "1", "--root", dropDir]));

	step(`preimage restore 1 --root <project> --yes`);
	show(run(["restore", "1", "--root", dropDir, "--yes"]));

	const verify = new DatabaseSync(dbPath, { readOnly: true });
	const tables = verify
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
		.all()
		.map((r) => r.name);
	const rows = verify.prepare("SELECT * FROM users").all();
	verify.close();

	step("schema and rows afterwards");
	process.stdout.write(`${c(DIM, "│")} tables: ${c(CYAN, JSON.stringify(tables))}\n`);
	process.stdout.write(`${c(DIM, "│")} users:  ${c(CYAN, JSON.stringify(rows))}\n`);
	process.stdout.write(
		`${c(DIM, "│")} ${c(GREEN, "the table came back, with its schema, with its row")}\n`,
	);

	fs.rmSync(dropDir, { recursive: true, force: true });
}
process.stdout.write("\n");
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(dbDir, { recursive: true, force: true });
}