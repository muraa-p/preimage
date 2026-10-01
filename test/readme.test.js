import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = new URL("../", import.meta.url);
const README = fs.readFileSync(new URL("README.md", ROOT), "utf8");
const BIN = fileURLToPath(new URL("../bin/preimage.js", import.meta.url));

/** Every ``` fenced block that looks like a shell transcript. */
function transcriptBlocks() {
	const blocks = [];
	const re = /```\n(\$ [^\n]*[\s\S]*?)```/g;
	let m;
	while ((m = re.exec(README)) !== null) {
		if (m[1].includes("$ preimage") || m[1].startsWith("preimage ")) {
			blocks.push(m[1]);
		}
	}
	return blocks;
}

test("the tests badge matches the number of tests actually in the suite", () => {
	// The badge is the first thing anyone reads. It said 91 while the suite was
	// at 132, for several releases.
	const badge = README.match(/badge\/tests-(\d+)%20passing/);
	assert.ok(badge, "there is a tests badge");
	const claimed = Number(badge[1]);

	// Counted from the test files rather than hardcoded, so adding a test fails
	// this until the badge is updated -- which is the whole point.
	const testDir = fileURLToPath(new URL("test/", ROOT));
	const declared = fs
		.readdirSync(testDir)
		.filter((f) => f.endsWith(".test.js"))
		.flatMap((f) => fs.readFileSync(path.join(testDir, f), "utf8").split("\n"))
		.filter((l) => /^\s*test\(/.test(l)).length;

	assert.equal(claimed, declared, `badge says ${claimed}, suite declares ${declared}`);
});

test("the README's opening transcript is what the tool actually prints", (t) => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(path.join(process.cwd(), "..")), "preimage-readme-")));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const run = (args) =>
		execFileSync(process.execPath, [BIN, ...args, "--root", dir], { encoding: "utf8" });

	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "config.json"),
		'{\n  "port": 3000,\n  "features": ["search"]\n}\n',
	);
	fs.writeFileSync(
		path.join(dir, "src", "server.js"),
		`const { port } = require("./config.json");\n\nfunction createServer() {\n  return { port, routes: ["/health"] };\n}\n\nmodule.exports = { createServer };\n`,
	);

	const checkpoint = run(["checkpoint", "before agent refactor"]).trimEnd();
	fs.writeFileSync(path.join(dir, "EMERGENCY.js"), "// created at 2am, don't ask\n");
	fs.rmSync(path.join(dir, "src", "server.js"));
	fs.writeFileSync(
		path.join(dir, "config.json"),
		'{\n  "port": 9999,\n  "features": ["search", "beta"]\n}\n',
	);
	const diff = run(["diff", "1"]).trimEnd();
	const restore = run(["restore", "1", "--purge", "--yes"]).trimEnd();

	// Every output line the README claims must be produced by a real run. This
	// is the check that would have caught the transcript going stale when the
	// diff feature landed and the tool started printing hunks.
	for (const claimed of [checkpoint, diff, restore]) {
		for (const line of claimed.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			assert.ok(
				README.includes(trimmed),
				`README does not contain a line the tool actually prints:\n  ${trimmed}`,
			);
		}
	}

	// And the headline: the opening transcript must show a real unified diff,
	// because that is what `preimage diff` does now.
	const opening = transcriptBlocks()[0] ?? "";
	assert.match(opening, /^--- a\/config\.json$/m, "opening transcript shows a diff header");
	assert.match(opening, /^-  "port": 3000,$/m);
	assert.match(opening, /^\+  "port": 9999,$/m);
});

test("no README transcript claims output the tool no longer produces", () => {
	// Cheap but broad: nothing in a transcript may reference a flag or a
	// version that does not exist.
	for (const flag of README.match(/preimage [a-z]+ --[a-z-]+/g) ?? []) {
		const name = flag.split(" ")[1];
		const f = flag.match(/--([a-z-]+)/)[1];
		assert.ok(
			help().includes(`--${f}`),
			`README documents \`${name} --${f}\`, which the CLI does not accept`,
		);
	}
});

function help() {
	return execFileSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
}

function fileURLToPath(u) {
	return u.pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/\//g, path.sep);
}
