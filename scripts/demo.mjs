#!/usr/bin/env node
// Produces the terminal transcript used in the README.
//
//   node scripts/demo.mjs
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
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const supportsColour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const c = (code, text) => (supportsColour ? `${code}${text}${RESET}` : text);

function step(label) {
	process.stdout.write(`\n${c(BOLD, `$ ${label}`)}\n`);
}

function run(args) {
	return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

function show(output) {
	for (const line of output.trimEnd().split("\n")) {
		process.stdout.write(`${c(DIM, "│")} ${line}\n`);
	}
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preimage-demo-"));
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "preimage-demo-db-"));

try {
	process.stdout.write(c(BOLD, "\nStory 1: the agent rewrote your config and deleted a file\n"));

	fs.writeFileSync(path.join(dir, "config.json"), '{"port":3000,"db":"prod"}');
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "src", "server.js"), "const PORT = 3000;\n");

	step(`preimage checkpoint "before agent refactor" --root <project>`);
	show(run(["checkpoint", "before agent refactor", "--root", dir]));

	step("# the agent has its way with your files");
	fs.writeFileSync(path.join(dir, "config.json"), '{"port":9999,"db":"prod"}');
	fs.writeFileSync(path.join(dir, "EMERGENCY.js"), "// created at 2am\n");
	fs.rmSync(path.join(dir, "src", "server.js"));
	process.stdout.write(
		`${c(DIM, "│")} ${c(YELLOW, "config.json rewritten, src/server.js deleted, EMERGENCY.js added")}\n`,
	);

	step(`preimage diff 1 --root <project>`);
	show(run(["diff", "1", "--root", dir]));

	step(`preimage restore 1 --root <project> --purge --yes`);
	show(run(["restore", "1", "--root", dir, "--purge", "--yes"]));

	step("state afterwards");
	show(
		`config.json: ${fs.readFileSync(path.join(dir, "config.json"), "utf8")}\n` +
			`src/server.js: restored\n` +
			`EMERGENCY.js: ${fs.existsSync(path.join(dir, "EMERGENCY.js")) ? "still here" : c(GREEN, "gone")}`,
	);

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
	process.stdout.write("\n");
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(dbDir, { recursive: true, force: true });
}