// Restore files from a checkpoint.
//
// Restoring is the destructive half of this tool, so it is deliberately
// conservative:
//   - files the agent created are only removed when `purge` is passed
//   - files too large to store are left untouched rather than blanked
//   - every write goes through a temp file + rename so a crash mid-restore
//     cannot leave a half-written file behind

import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeFileAtomic } from "./util.js";
import { loadTree, isSkipMarker, scanTree } from "./capture.js";

/** Resolve the absolute path for a stored relative path, refusing escapes. */
function safeJoin(root, rel) {
	const abs = path.resolve(root, ...rel.split("/"));
	const rootResolved = path.resolve(root);
	if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
		throw new Error(`refusing to write outside project root: ${rel}`);
	}
	return abs;
}

/**
 * Restore every file recorded in the checkpoint.
 * Returns counts and a per-path breakdown for reporting.
 */
export function restoreFiles(journal, checkpointId, root, { purge = false, dryRun = false } = {}) {
	const entries = loadTree(journal, checkpointId);
	const result = {
		written: [],
		unchanged: 0,
		skipped: [],
		purged: [],
		errors: [],
		dryRun,
	};

	const knownPaths = new Set(entries.map((e) => e.path));

	for (const entry of entries) {
		if (entry.bytes && isSkipMarker(entry.bytes)) {
			result.skipped.push({ path: entry.path, reason: "too-large to store" });
			continue;
		}
		let abs;
		try {
			abs = safeJoin(root, entry.path);
		} catch (err) {
			result.errors.push(err.message);
			continue;
		}

		let existing = null;
		try {
			existing = fs.lstatSync(abs);
		} catch {
			existing = null;
		}

		// Symlinks: the stored bytes are the link target.
		if (entry.kind === "symlink") {
			const target = entry.bytes.toString("utf8");
			if (existing && existing.isSymbolicLink() && fs.readlinkSync(abs) === target) {
				result.unchanged++;
				continue;
			}
			if (dryRun) {
				result.written.push({ path: entry.path, kind: "symlink", bytes: entry.bytes.length });
				continue;
			}
			try {
				ensureDir(path.dirname(abs));
				fs.rmSync(abs, { force: true, recursive: false });
				fs.symlinkSync(target, abs);
				result.written.push({ path: entry.path, kind: "symlink" });
			} catch (err) {
				result.errors.push(`${entry.path}: ${err.message}`);
			}
			continue;
		}

		// Regular file. Skip if content already matches.
		if (existing && existing.isFile()) {
			try {
				const current = fs.readFileSync(abs);
				if (current.equals(entry.bytes)) {
					result.unchanged++;
					continue;
				}
			} catch {
				// unreadable; fall through and overwrite
			}
		} else if (existing && existing.isDirectory()) {
			result.errors.push(`${entry.path}: is a directory now, refusing to overwrite`);
			continue;
		}

		if (dryRun) {
			result.written.push({ path: entry.path, kind: "file", bytes: entry.bytes.length });
			continue;
		}

		try {
			writeFileAtomic(abs, entry.bytes);
			// Restore the recorded permission bits (mask to the rwx bits).
			if (entry.mode && process.platform !== "win32") {
				fs.chmodSync(abs, entry.mode & 0o777);
			}
			result.written.push({ path: entry.path, kind: "file", bytes: entry.bytes.length });
		} catch (err) {
			result.errors.push(`${entry.path}: ${err.message}`);
		}
	}

	// Optionally remove files the agent added after the checkpoint.
	if (purge) {
		const now = scanTree(root);
		for (const rel of now.keys()) {
			if (knownPaths.has(rel)) continue;
			let abs;
			try {
				abs = safeJoin(root, rel);
			} catch {
				continue;
			}
			if (dryRun) {
				result.purged.push(rel);
				continue;
			}
			try {
				fs.rmSync(abs, { force: true });
				result.purged.push(rel);
			} catch (err) {
				result.errors.push(`${rel}: ${err.message}`);
			}
		}
	}

	return result;
}