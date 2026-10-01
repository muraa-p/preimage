import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { unifiedDiff, renderUnified } from "../src/udiff.js";

const B = (s) => Buffer.from(s, "utf8");
const diff = (a, b) => {
	const { hunks } = unifiedDiff(B(a), B(b));
	return renderUnified("a", "b", hunks);
};
const patch = (a, b) => {
	const { hunks } = unifiedDiff(B(a), B(b));
	return hunks.flatMap((h) => h.body);
};

/* --- hunk shape ---------------------------------------------------------- */

test("a changed line becomes a deletion and an addition", () => {
	assert.equal(
		diff("one\ntwo\nthree\n", "one\nTWO\nthree\n"),
		"--- a\n+++ b\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three",
	);
});

test("an added and a removed line are reported as such", () => {
	assert.match(diff("a\nb\n", "a\nb\nc\n"), /^\+c$/m);
	assert.match(diff("a\nb\nc\n", "a\nc\n"), /^-b$/m);
});

test("creating a file uses git's zero-side hunk header", () => {
	// `-0,0` with the count of 1 omitted on the other side, exactly as git writes
	// it. Getting this wrong makes the output unparseable by patch(1).
	assert.equal(diff("", "hello\n"), "--- a\n+++ b\n@@ -0,0 +1 @@\n+hello");
});

test("a missing final newline is shown, not silently normalised", () => {
	const out = diff("a\nb", "a\nb\n");
	assert.match(out, /\\ No newline at end of file/);
	assert.match(out, /^-b$/m);
	assert.match(out, /^\+b$/m);
});

test("two edits far apart become two hunks, nearby edits become one", () => {
	const far = diff(
		"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n",
		"A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n",
	);
	assert.equal(far.match(/^@@/gm).length, 2);
	assert.match(far, /@@ -\d+,\d+ \+\d+,\d+ @@ f/, "and names the enclosing block");

	const near = diff("a\nb\nc\nd\ne\n", "A\nB\nc\nd\nE\n");
	assert.equal(near.match(/^@@/gm).length, 1);
});

/* --- correctness properties ---------------------------------------------- */

test("applying nothing gives back the original file", () => {
	// The strongest property available without a patch library: the context and
	// removals in a hunk must reconstruct the "before" file exactly.
	const before = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
	const after = "alpha\nBETA\ngamma\ndelta\nEPSILON\nzeta\n";
	const lines = patch(before, after);
	const reconstructed = lines
		.filter((l) => l.startsWith(" ") || l.startsWith("-"))
		.map((l) => l.slice(1))
		.join("\n");
	assert.equal(reconstructed + "\n", before);
});

test("the additions reconstruct the after file", () => {
	const before = "alpha\nbeta\ngamma\n";
	const after = "alpha\nBETA\ngamma\ndelta\n";
	const lines = patch(before, after);
	const reconstructed = lines
		.filter((l) => l.startsWith(" ") || l.startsWith("+"))
		.map((l) => l.slice(1))
		.join("\n");
	assert.equal(reconstructed + "\n", after);
});

test("identical files produce no hunks", () => {
	assert.equal(unifiedDiff(B("a\nb\n"), B("a\nb\n")).hunks.length, 0);
});

test("a change in line endings alone is not a change to every line", () => {
	// A CRLF checkout must not read as a rewrite of the whole file. The CR is
	// stripped for comparison, so the content is what gets compared.
	assert.equal(unifiedDiff(B("a\r\nb\r\n"), B("a\nb\n")).hunks.length, 0);
});

/* --- things it must decline to do ---------------------------------------- */

test("binary content is reported as binary rather than mangled into text", () => {
	const r = unifiedDiff(Buffer.from([0x00, 0x01, 0xff, 0x00]), B("text\n"));
	assert.equal(r.binary, true);
	assert.equal(r.reason, "binary file");
	assert.equal(r.hunks.length, 0);
});

test("a file that is too large to diff says so instead of stalling", () => {
	const huge = "x".repeat(5 * 1024 * 1024);
	const r = unifiedDiff(B(huge), B(`${huge}y`));
	assert.match(r.reason, /too large/);
});

test("a long line is clipped but the change is still shown", () => {
	const long = "x".repeat(5000);
	const lines = patch("a\n", `a\n${long}\n`);
	const added = lines.find((l) => l.startsWith("+"));
	assert.match(added, /chars\]$/, "the truncation is disclosed, not silent");
});

/* --- bounds -------------------------------------------------------------- */

test("a small edit in a large file stays fast", () => {
	const big = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join("\n") + "\n";
	const changed = big.replace("line 9999", "LINE 9999");
	const t0 = Date.now();
	const { hunks } = unifiedDiff(B(big), B(changed));
	assert.ok(Date.now() - t0 < 1000, "a one-line edit in 20k lines must not be slow");
	assert.equal(hunks.length, 1);
	const changed2 = hunks.flatMap((h) => h.body).filter((l) => /^[+-][^+-]/.test(l));
	assert.equal(changed2.length, 2, "only the two lines that actually changed");
});

test("a wholesale rewrite falls back to a replacement instead of hanging", () => {
	// This is the case that needs a bound: Myers costs O(D) per step, so a
	// full rewrite makes D as large as the file. Without a cap this took 17
	// seconds and allocated gigabytes.
	const a = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join("\n") + "\n";
	const b = Array.from({ length: 20_000 }, (_, i) => `other ${i}`).join("\n") + "\n";
	const t0 = Date.now();
	const { hunks } = unifiedDiff(B(a), B(b));
	assert.ok(Date.now() - t0 < 3000, "a full rewrite must be bounded");
	assert.ok(hunks.length > 0, "and must still say something");
});

/* --- against a reference implementation ---------------------------------- */

test("output matches git diff byte for byte", { skip: !hasGit() }, () => {
	const cases = [
		["one line changed", "one\ntwo\nthree\n", "one\nTWO\nthree\n"],
		["line added", "a\nb\n", "a\nb\nc\n"],
		["line removed", "a\nb\nc\n", "a\nc\n"],
		["blank line added", "a\nc\n", "a\n\nc\n"],
		["no trailing newline added", "a\nb", "a\nb\n"],
		["no trailing newline removed", "a\nb\n", "a\nb"],
		["file created", "", "hello\n"],
		["file emptied", "hello\n", ""],
		["two separate edits", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", "A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n"],
		["adjacent edits merge", "a\nb\nc\nd\ne\n", "A\nB\nc\nd\nE\n"],
		["insert at top", "b\nc\n", "a\nb\nc\n"],
		["insert at bottom", "a\nb\n", "a\nb\nc\n"],
		["whitespace only change", "a\nb\n", "a \nb\n"],
		["one line file changed", "a\n", "b\n"],
		["delete from top", "a\nb\nc\n", "b\nc\n"],
		["delete from bottom", "a\nb\nc\n", "a\nb\n"],
		["crlf on both sides", "a\r\nb\r\n", "a\r\nB\r\n"],
		["unicode", "héllo\nwörld\n", "héllo\nwörld!\n"],
		["tabs preserved", "\ta\n\tb\n", "\ta\n\tB\n"],
		["quotes and backslashes", 'a"b\nc\\d\n', 'a"b\nc\\D\n'],
		["dollar signs", "$var\n$other\n", "$var\n$OTHER\n"],
		[
			"long file single edit",
			Array.from({ length: 60 }, (_, i) => `l${i}`).join("\n") + "\n",
			Array.from({ length: 60 }, (_, i) => (i === 30 ? "CHANGED" : `l${i}`)).join("\n") + "\n",
		],
	];

	for (const [label, before, after] of cases) {
		assert.equal(oursHunksOnly(before, after), gitHunksOnly(before, after), label);
	}
});

function hasGit() {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function gitHunksOnly(before, after) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "preimage-ref-")));
	const a = path.join(dir, "a.txt");
	const b = path.join(dir, "b.txt");
	fs.writeFileSync(a, before);
	fs.writeFileSync(b, after);
	let out;
	try {
		out = execFileSync("git", ["diff", "--no-index", "--unified=3", a, b], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (e) {
		out = e.stdout ?? "";
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	return out
		.split("\n")
		.filter((l) => !/^(---|\+\+\+|diff |index )/.test(l))
		.join("\n")
		.replace(/\s+$/, "");
}

function oursHunksOnly(before, after) {
	const { hunks } = unifiedDiff(B(before), B(after));
	return hunks
		.flatMap((h) => [`@@ -${h.aStart}${h.aCount === 1 ? "" : `,${h.aCount}`} +${h.bStart}${h.bCount === 1 ? "" : `,${h.bCount}`} @@${h.heading ? ` ${h.heading}` : ""}`, ...h.body])
		.join("\n")
		.replace(/\s+$/, "");
}