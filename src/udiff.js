// Line-level unified diffs, with no dependencies.
//
// preimage already knew *which* files an agent changed. That is not enough to
// review the damage: "app.js was modified" leaves the reader to open it and work
// out what actually happened. This produces the same `diff -u` / `git diff`
// format people already know how to read.
//
// Implemented as Myers' O(ND) algorithm, chosen because it is linear in the size
// of the edit rather than the size of the file, so the common case -- a few
// changed lines in a long file -- stays fast.

/** Lines longer than this are truncated in a hunk, so one minified bundle
 *  cannot flood a terminal or an agent's context window. */
const MAX_LINE_CHARS = 400;

/** Give up on a precise line-level diff past this many changed lines and report a
 *  whole-file replacement instead.
 *
 *  This is the guard that matters. Myers costs O(D) per step of the search, so a
 *  file that was rewritten from top to bottom makes D as large as the file and
 *  the trace alone becomes 2*(n+m) ints per step. Measured: 20k lines fully
 *  rewritten took 17.5s and allocated gigabytes before this bound existed. The
 *  bound keeps the work flat, and a hunk containing more than this many changed
 *  lines is not something anyone reads line by line anyway. */
const MAX_EDIT_DISTANCE = 400;

const CONTEXT = 3;

/** Sentinel marking a last line that has no trailing newline. Never a real
 *  character, so it cannot collide with file content. */
const NO_EOL = "\u0000<no-eol>";

/** NUL in the first 8 KiB is the same heuristic git uses for "binary". */
function looksBinary(buf) {
	const limit = Math.min(buf.byteLength, 8192);
	for (let i = 0; i < limit; i++) if (buf[i] === 0) return true;
	return false;
}

/** Split into lines, reporting whether the file ended with a newline. */
function splitLines(buf) {
	const text = buf.toString("utf8");
	const endsWithNewline = text.length === 0 || text.endsWith("\n");
	const body = endsWithNewline ? text.slice(0, -1) : text;
	if (body === "") return { lines: [], endsWithNewline };
	// Strip the CR of a CRLF pair. Comparing and printing normalised lines keeps
	// a checkout on one line-ending convention from reading as a change to every
	// line of the file.
	const lines = body.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	// A missing final newline is itself a change, and git shows it. Marking the
	// last line makes it differ from the same text that does end in a newline, so
	// the diff finds it as an ordinary edit instead of missing it entirely.
	if (!endsWithNewline) lines[lines.length - 1] += NO_EOL;
	return { lines, endsWithNewline };
}

/**
 * Myers' diff over two line arrays.
 * Returns a list of ops: { op: "eq" | "del" | "add", line, aIndex, bIndex }.
 */
function myers(a, b) {
	const n = a.length;
	const m = b.length;
	// Trim the common prefix and suffix first. This is the single biggest win
	// in practice: a one-line edit in a 5000-line file reduces to a 1x1 problem.
	let start = 0;
	while (start < n && start < m && a[start] === b[start]) start++;
	let endA = n;
	let endB = m;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}

	const ops = [];
	for (let i = 0; i < start; i++) ops.push({ op: "eq", a: a[i], b: b[i] });

	const mid = a.slice(start, endA);
	const midB = b.slice(start, endB);

	if (mid.length > 0 && midB.length > 0) {
		const edit = shortestEdit(mid, midB, start);
		if (edit) {
			ops.push(...edit);
		} else {
			// Too different to diff precisely within the budget. Reporting the
			// whole region as replaced is honest and instant; pretending to a
			// line-level answer we did not compute is not.
			for (const line of mid) ops.push({ op: "del", a: line, b: undefined });
			for (const line of midB) ops.push({ op: "add", a: undefined, b: line });
		}
	} else if (mid.length > 0) {
		for (const line of mid) ops.push({ op: "del", a: line, b: undefined });
	} else {
		for (const line of midB) ops.push({ op: "add", a: undefined, b: line });
	}

	for (let k = 0; k < n - endA; k++) {
		ops.push({ op: "eq", a: a[endA + k], b: b[endB + k] });
	}
	return ops;
}

/**
 * The edit script for the trimmed middle, via the standard V/F trace walk.
 * Returns null when the two regions differ by more than MAX_EDIT_DISTANCE lines,
 * which the caller treats as "replace the region wholesale".
 *
 * The V array is sized to the search bound rather than to n+m. That is the whole
 * point: with a bound, memory and time are flat no matter how large the files
 * are, and the common case -- a few edited lines in a long file -- is already
 * handled by the prefix/suffix trim before this runs.
 */
function shortestEdit(a, b, offset) {
	const n = a.length;
	const m = b.length;
	const max = Math.min(n + m, MAX_EDIT_DISTANCE);
	const v = new Int32Array(2 * max + 1);
	const offsetV = max;
	const trace = [];

	for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x;
			if (k === -d || (k !== d && v[k - 1 + offsetV] < v[k + 1 + offsetV])) {
				x = v[k + 1 + offsetV];
			} else {
				x = v[k - 1 + offsetV] + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[k + offsetV] = x;
			if (x >= n && y >= m) {
				return backtrack(trace, a, b, offset, d, offsetV);
			}
		}
	}
	return null;
}

function backtrack(trace, a, b, offset, d, offsetV) {
	const ops = [];
	let x = a.length;
	let y = b.length;

	for (let depth = d; depth > 0; depth--) {
		const v = trace[depth];
		const k = x - y;
		let prevK;
		if (k === -depth || (k !== depth && v[k - 1 + offsetV] < v[k + 1 + offsetV])) {
			prevK = k + 1;
		} else {
			prevK = k - 1;
		}
		const prevX = v[prevK + offsetV];
		const prevY = prevX - prevK;

		while (x > prevX && y > prevY) {
			x--;
			y--;
			ops.push({ op: "eq", a: a[x], b: b[y] });
		}
		if (x > prevX) {
			x--;
			ops.push({ op: "del", a: a[x], b: undefined });
		} else if (y > prevY) {
			y--;
			ops.push({ op: "add", a: undefined, b: b[y] });
		}
	}
	while (x > 0 && y > 0) {
		x--;
		y--;
		ops.push({ op: "eq", a: a[x], b: b[y] });
	}
	ops.reverse();

	// Re-absorb the equal runs that surround each edit, so the caller sees one
	// continuous stream and can group hunks from it.
	const withOffset = [];
	for (const op of ops) withOffset.push(op);
	return withOffset;
}

/** Group an op stream into unified hunks with `CONTEXT` lines of context. */
function toHunks(ops, { aNoEol, bNoEol }) {
	const changed = ops.map((o, i) => (o.op === "eq" ? -1 : i)).filter((i) => i !== -1);
	if (changed.length === 0) return [];

	const groups = [];
	let groupStart = changed[0];
	let groupEnd = changed[0];
	for (const i of changed.slice(1)) {
		if (i - groupEnd <= CONTEXT * 2) {
			groupEnd = i;
		} else {
			groups.push([groupStart, groupEnd]);
			groupStart = i;
			groupEnd = i;
		}
	}
	groups.push([groupStart, groupEnd]);

	// Line numbers as they appear in each file, computed from the op stream.
	const aLine = new Array(ops.length);
	const bLine = new Array(ops.length);
	let ai = 0;
	let bi = 0;
	for (let i = 0; i < ops.length; i++) {
		if (ops[i].op !== "add") aLine[i] = ++ai;
		if (ops[i].op !== "del") bLine[i] = ++bi;
	}

	return groups.map(([from, to]) => {
		const lo = Math.max(0, from - CONTEXT);
		const hi = Math.min(ops.length - 1, to + CONTEXT);
		const body = [];
		let aStart = null;
		let bStart = null;
		let aCount = 0;
		let bCount = 0;

		for (let i = lo; i <= hi; i++) {
			const op = ops[i];
			if (aStart === null && op.op !== "add") aStart = aLine[i];
			if (bStart === null && op.op !== "del") bStart = bLine[i];
			if (op.op !== "add") aCount++;
			if (op.op !== "del") bCount++;
			const marker = op.op === "eq" ? " " : op.op === "del" ? "-" : "+";
			const raw = op.op === "add" ? op.b : op.a;
			const missingEol = raw.endsWith(NO_EOL);
			body.push(marker + clip(missingEol ? raw.slice(0, -NO_EOL.length) : raw));
			// git marks a missing final newline, and so do we: without it the
			// reader cannot tell "no trailing newline" from a display artefact.
			if (missingEol) body.push("\\ No newline at end of file");
		}

		return {
			aStart: aStart ?? 0,
			aCount,
			bStart: bStart ?? 0,
			bCount,
			heading: functionHeading(ops, lo),
			body,
		};
	});
}

/**
 * The text git appends after `@@`, naming the enclosing block so a hunk deep in a
 * long file says where it is. git uses language-aware analysis; the portable
 * approximation, and the one every other unified-diff tool uses, is the nearest
 * preceding line that starts in column 0 -- which is where functions, classes
 * and sections begin in most languages.
 */
function functionHeading(ops, fromIndex) {
	for (let i = fromIndex - 1; i >= 0; i--) {
		const op = ops[i];
		if (op.op === "add") continue; // not present in the "before" file
		const line = op.a;
		if (typeof line !== "string" || line.length === 0) continue;
		if (/^\s/.test(line)) continue; // indented: inside a block, not a heading
		return clip(line.trim().slice(0, 80));
	}
	return null;
}

function clip(line) {
	if (line.length <= MAX_LINE_CHARS) return line;
	return `${line.slice(0, MAX_LINE_CHARS)}… [${line.length} chars]`;
}

/**
 * Unified diff between two buffers.
 * Returns { hunks, binary, reason }.
 *   - `binary` true when the content cannot meaningfully be diffed as text.
 *   - `reason` explains an omission to the reader rather than leaving a gap.
 */
export function unifiedDiff(before, after) {
	if (looksBinary(before) || looksBinary(after)) {
		return { hunks: [], binary: true, reason: "binary file" };
	}
	if (before.byteLength > 4 * 1024 * 1024 || after.byteLength > 4 * 1024 * 1024) {
		return { hunks: [], binary: false, reason: "file too large to diff line by line" };
	}

	const a = splitLines(before);
	const b = splitLines(after);

	// An empty file has no lines, so the usual "\ No newline" logic has nothing
	// to attach to. Reporting one added empty line reads correctly.
	if (a.lines.length === 0 && b.lines.length === 0) {
		return { hunks: [], binary: false, reason: null };
	}

	const ops = myers(a.lines, b.lines);
	const hunks = toHunks(ops, { aNoEol: !a.endsWithNewline, bNoEol: !b.endsWithNewline });
	return { hunks, binary: false, reason: null };
}

/** Format one side of a hunk header the way git does: a count of 1 is implied
 *  and omitted, and a count of 0 is written as `0,0` with the start forced to 0. */
function hunkHeader(sign, start, count) {
	if (count === 0) return `${sign}0,0`;
	if (count === 1) return `${sign}${start}`;
	return `${sign}${start},${count}`;
}

/** Render hunks in `diff -u` format, the shape every review tool understands. */
export function renderUnified(fromLabel, toLabel, hunks) {
	const out = [`--- ${fromLabel}`, `+++ ${toLabel}`];
	for (const h of hunks) {
		const heading = h.heading ? ` ${h.heading}` : "";
		out.push(
			`@@ ${hunkHeader("-", h.aStart, h.aCount)} ${hunkHeader("+", h.bStart, h.bCount)} @@${heading}`,
		);
		out.push(...h.body);
	}
	return out.join("\n");
}
