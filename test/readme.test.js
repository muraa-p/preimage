import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const README = fs.readFileSync(new URL("README.md", ROOT), "utf8");
const BIN = path.join(ROOT_PATH, "bin", "preimage.js");

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
	const testDir = path.join(ROOT_PATH, "test");
	const declared = fs
		.readdirSync(testDir)
		.filter((f) => f.endsWith(".test.js"))
		.flatMap((f) => fs.readFileSync(path.join(testDir, f), "utf8").split("\n"))
		.filter((l) => /^\s*test\(/.test(l)).length;

	assert.equal(claimed, declared, `badge says ${claimed}, suite declares ${declared}`);
});

test("the README's opening transcript is what the demo actually prints", () => {
	// The demo script is the single source of truth: the GIF records it and the
	// README quotes it, so checking the README against it catches drift in
	// either direction. Replaying a private copy of the fixture here instead
	// would be a third thing to keep in sync.
	const raw = execFileSync(process.execPath, [path.join(ROOT_PATH, "scripts", "demo.mjs"), "--story=1"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 32 * 1024 * 1024,
	});

	// Strip the demo's presentation: the gutter, the prompt, and the placeholder
	// path, all of which the README formats differently.
	const lines = raw
		.split("\n")
		.map((l) => l.replace(/^[│\s]*/, "").trim())
		.filter((l) => l && !l.startsWith("$ preimage") && !l.startsWith("$ #") && !l.startsWith("Story"));

	assert.ok(lines.length > 15, `demo produced ${lines.length} meaningful lines`);

	// The test-count line comes from node's own test runner, whose reporter and
	// discovery differ between versions, so it is checked loosely. Everything
	// preimage itself prints is checked exactly.
	const isRunnerSummary = (l) => /passing|failing|no tests found/.test(l);

	for (const line of lines) {
		if (isRunnerSummary(line)) continue;
		// The scripted narration ("config.js rewritten, ...") is written for the
		// demo, so it is expected to appear verbatim too.
		assert.ok(
			README.includes(line),
			`README does not contain a line the demo prints:\n  ${line}`,
		);
	}
});

test("the opening transcript shows a real unified diff", () => {
	const opening = transcriptBlocks()[0] ?? "";
	assert.match(opening, /^--- a\/config\.js$/m, "shows the old file");
	assert.match(opening, /^\+\+\+ b\/config\.js$/m, "shows the new file");
	assert.match(opening, /^@@ -\d+,\d+ \+\d+,\d+ @@/m, "shows a hunk header");
	assert.match(opening, /^-[\t ]port: 3000,$/m, "shows a removed line");
	assert.match(opening, /^\+[\t ]port: Number\(process\.env\.PORT\) \|\| 8080,$/m);
	assert.match(opening, /✔ \d+ passing, 0 failing/, "closes on the tests passing");
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
