import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const BIN = path.join(ROOT, "bin", "preimage.js");

const pkg = JSON.parse(read("package.json"));
const cli = read("src/cli.js");
const help = execFileSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });

// Flags belonging to git, npm or GitHub Actions, and to the demo script, rather
// than to preimage's own parser.
const FOREIGN_FLAGS = new Set([
	"--provenance", "--no-git-tag-version", "--follow-tags", "--access",
	"--package-manager-cache", "--id-token", "--contents", "--tag",
	"--if-present", "--story", "--paced",
]);

test("every relative file the docs link to exists", () => {
	for (const doc of ["README.md", "CONTRIBUTING.md", "SECURITY.md"]) {
		for (const m of read(doc).matchAll(/\]\((?!https?:)([^)#]+)(?:#[^)]*)?\)/g)) {
			const target = m[1].trim();
			if (/^(docs|tape|src|test|integrations|bin|scripts)\//.test(target)) {
				assert.ok(exists(target), `${doc} links to ${target}, which does not exist`);
			}
		}
	}
});

test("every command in --help is wired up", () => {
	// The help lists commands as "  list    List recent ..." in a COMMANDS block.
	const listed = [...help.split("COMMANDS")[1].matchAll(/^\s{2}([a-z]+)/gm)].map((m) => m[1]);
	assert.ok(listed.length >= 9, `--help lists ${listed.length} commands`);

	const wired = new Set([...cli.matchAll(/^\s+([a-z]+): cmd[A-Z]\w+,/gm)].map((m) => m[1]));
	for (const c of listed) {
		// `preimage` is caught from the USAGE line, not the command table.
		if (c === "preimage") continue;
		assert.ok(wired.has(c), `--help documents \`${c}\` but nothing dispatches it`);
	}
});

test("every wired command appears in --help", () => {
	const wired = [...cli.matchAll(/^\s+([a-z]+): cmd[A-Z]\w+,/gm)].map((m) => m[1]);
	const listed = new Set([...help.split("COMMANDS")[1].matchAll(/^\s{2}([a-z]+)/gm)].map((m) => m[1]));
	for (const c of wired) {
		// `ls` is documented inline on the list line rather than as its own entry.
		assert.ok(
			listed.has(c) || help.includes(`alias: ${c}`),
			`\`${c}\` works but --help never mentions it`,
		);
	}
});

test("the mcp subcommand is dispatched before the command table", () => {
	assert.match(read("bin/preimage.js"), /argv\[0\] === "mcp"/);
});

test("every flag the docs mention is in --help", () => {
	for (const doc of ["README.md", "CONTRIBUTING.md"]) {
		for (const m of read(doc).matchAll(/(?:^|\s)(--[a-z][a-z-]+)/gm)) {
			const flag = m[1];
			if (FOREIGN_FLAGS.has(flag)) continue;
			assert.ok(help.includes(flag), `${doc} documents ${flag}, which --help does not list`);
		}
	}
});

test("the syntax check covers every source file", () => {
	// A file missing from `npm run check` can be broken and CI will not notice.
	for (const f of fs.readdirSync(path.join(ROOT, "src"))) {
		if (!f.endsWith(".js")) continue;
		assert.ok(pkg.scripts.check.includes(`src/${f}`), `src/${f} is not syntax-checked`);
	}
	for (const f of pkg.files) {
		if (f.startsWith("!") || f.endsWith("/")) continue;
		assert.ok(exists(f), `package.json files lists ${f}, which does not exist`);
	}
});

test("each hook target the code accepts has a shipped script", () => {
	const targets = [...cli.matchAll(/target !== "([a-z-]+)"/g)].map((m) => m[1]);
	assert.ok(targets.length > 0, "found the hook target checks");
	for (const t of targets) {
		assert.ok(
			exists(`integrations/${t}/preimage-checkpoint.sh`),
			`${t} is an accepted hook target but its script is not shipped`,
		);
	}
});

test("every demo story runs without crashing", () => {
	for (const story of [1, 2, 3]) {
		const out = execFileSync(process.execPath, [path.join(ROOT, "scripts/demo.mjs"), `--story=${story}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 32 * 1024 * 1024,
		});
		assert.ok(out.length > 50, `story ${story} produced ${out.length} chars`);
		assert.doesNotMatch(out, /ReferenceError|TypeError/, `story ${story} threw`);
	}
});

test("every tape writes a file that exists and records a script that exists", () => {
	for (const tape of fs.readdirSync(path.join(ROOT, "tape"))) {
		const text = read(path.join("tape", tape));
		const out = /Output (\S+)/.exec(text)?.[1];
		assert.ok(out, `${tape} has no Output line`);
		assert.ok(exists(out), `${tape} writes ${out}, which does not exist`);
		const cmd = /Type "([^"]+)"/.exec(text)?.[1] ?? "";
		if (cmd.includes("demo.mjs")) {
			assert.ok(exists("scripts/demo.mjs"), `${tape} records a missing script`);
		}
	}
});

test("no version is hardcoded where package.json is available", () => {
	assert.doesNotMatch(read("src/mcp.js"), /version: "\d+\.\d+\.\d+"/);
	assert.doesNotMatch(read("src/cli.js"), /version: "\d+\.\d+\.\d+"/);
});

test("the repository is licensed and has a security policy", () => {
	assert.ok(exists("LICENSE"));
	assert.ok(exists("SECURITY.md"));
	assert.ok(exists("CONTRIBUTING.md"));
	assert.equal(pkg.license, "MIT");
});
