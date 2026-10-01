// Small helpers with no dependencies beyond Node's stdlib.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * ANSI colour, used only when writing to a terminal.
 *
 * A diff is the one output where colour carries information rather than
 * decoration: git colours it, so a monochrome `preimage diff` next to a
 * coloured `git diff` looks like the less capable of the two. Honoured the
 * conventions people rely on -- NO_COLOR disables it, and so does --no-color
 * and --color=never, while --color=always forces it on for piping into a file.
 */
/**
 * Whether colour is wanted, given the environment and the parsed flags.
 *
 * Order matters and follows the conventions people already expect from git and
 * ripgrep:
 *
 *   --color=never / --no-color   off, whatever else
 *   --color=always               on, even when piped
 *   NO_COLOR                     off, and it wins over the environment too
 *   FORCE_COLOR / COLOR=always   on
 *   otherwise                    on only if the output is a terminal
 */
export function colourEnabled(flags = {}, stream = process.stdout) {
	const forced = flags.color;
	if (forced === "never" || forced === false || flags["no-color"]) return false;
	if (forced === "always" || forced === true) return true;
	// COLOUR matches git, which reads both. NO_COLOR still wins, so a user with
	// it set is never overridden by an ambient variable.
	if (process.env.NO_COLOR !== undefined) return false;
	if (process.env.FORCE_COLOR !== undefined || process.env.COLOR === "always") return true;
	if (forced !== undefined) return false;
	return Boolean(stream.isTTY);
}

const CODES = {
	red: 31,
	green: 32,
	yellow: 33,
	blue: 34,
	magenta: 35,
	cyan: 36,
	bold: 1,
	dim: 2,
};

export function makeColour(enabled) {
	if (!enabled) return (_name, text) => text;
	return (name, text) => `[${CODES[name] ?? 0}m${text}[0m`;
}

/** Directory that holds the journal for a given project root. */
export function journalDir(root) {
	return path.join(root, ".preimage");
}

export function journalPath(root) {
	return path.join(journalDir(root), "journal.db");
}

/** Files and directories never worth capturing. */
export const DEFAULT_IGNORE = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	".preimage",
	".DS_Store",
	"__pycache__",
	".venv",
	"venv",
	".mypy_cache",
	".pytest_cache",
	".next",
	".turbo",
	".cache",
	"dist",
	"build",
	"coverage",
	"target",
	"vendor",
	".idea",
	".vscode",
]);

export function isIgnored(name) {
	return DEFAULT_IGNORE.has(name) || name.endsWith(".swp");
}

export function sha256(buf) {
	return createHash("sha256").update(buf).digest("hex");
}

/** Human-readable byte size. */
export function humanBytes(n) {
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = n;
	let i = -1;
	do {
		value /= 1024;
		i++;
	} while (value >= 1024 && i < units.length - 1);
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

export function shortId(n) {
	return String(n).padStart(4, "0");
}

/** Depth-first walk yielding absolute file paths, skipping ignored dirs. */
export function* walkFiles(root, { followSymlinks = false } = {}) {
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (isIgnored(entry.name)) continue;
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (followSymlinks) {
					let real;
					try {
						real = fs.statSync(abs);
					} catch {
						continue;
					}
					if (!real.isDirectory()) continue;
				}
				stack.push(abs);
			} else if (entry.isFile()) {
				yield abs;
			}
		}
	}
}

/** Count total bytes and files under a root, used for size guards. */
export function dirSize(root) {
	let bytes = 0;
	let files = 0;
	for (const abs of walkFiles(root)) {
		try {
			bytes += fs.statSync(abs).size;
			files++;
		} catch {
			// file vanished mid-walk; skip
		}
	}
	return { bytes, files };
}

export function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

/**
 * Atomic-ish write: write to a sibling temp file then rename over the target.
 * Rename is atomic on POSIX and on Windows when the target exists.
 */
export function writeFileAtomic(target, data) {
	ensureDir(path.dirname(target));
	const tmp = `${target}.preimage-tmp-${process.pid}-${Date.now()}`;
	try {
		fs.writeFileSync(tmp, data);
		fs.renameSync(tmp, target);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// temp already gone
		}
		throw err;
	}
}

/** Case-insensitive comparison on Windows, byte comparison elsewhere. */
export const pathSep = process.platform === "win32" ? "\\" : "/";

export function toPosix(p) {
	return p.split(pathSep).join("/");
}