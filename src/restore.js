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
 * Databases this checkpoint captured at the table level. The table adapter owns
 * those files. If the file layer also rewrote them, restoring `--table users`
 * would silently revert every other table in the database, which is exactly the
 * surprise the explicit table scope exists to prevent.
 */
function tableOwnedDatabases(journal, checkpointId) {
	const owned = new Set();
	for (const t of journal.listDbTables(checkpointId)) {
		const base = normaliseRel(t.db_path);
		owned.add(base);
		// SQLite sidecar files describe the same database and must travel with it.
		owned.add(`${base}-wal`);
		owned.add(`${base}-shm`);
		owned.add(`${base}-journal`);
	}
	return owned;
}

function normaliseRel(p) {
	return String(p).split(path.sep).join("/").replace(/^\.\//, "");
}

/** Directories that purge emptied, deepest first, so parents can be pruned. */
function prunableDirs(purged) {
	const dirs = new Set();
	for (const rel of purged) {
		let dir = path.posix.dirname(rel.split(path.sep).join("/"));
		while (dir && dir !== "." && dir !== "/") {
			dirs.add(dir);
			dir = path.posix.dirname(dir);
		}
	}
	return [...dirs].sort((a, b) => b.length - a.length);
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
		purgedDirs: [],
		tableOwned: [],
		errors: [],
		dryRun,
	};

	const knownPaths = new Set(entries.map((e) => e.path));
	const tableOwned = tableOwnedDatabases(journal, checkpointId);

	for (const entry of entries) {
		// Handled by the table adapter; writing it here would defeat table scope.
		if (tableOwned.has(entry.path)) {
			result.tableOwned.push(entry.path);
			continue;
		}
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
			// A database captured at table level is never a stray file, even if the
			// agent created it after the checkpoint. Purging it would destroy the
			// rows restore is about to put back.
			if (tableOwned.has(rel)) continue;
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

		// Purging files leaves their directories behind, which reads as an
		// incomplete restore. Remove directories that are now empty.
		if (!dryRun) {
			for (const dir of prunableDirs(result.purged)) {
				let abs;
				try {
					abs = safeJoin(root, dir);
				} catch {
					continue;
				}
				try {
					fs.rmdirSync(abs);
					result.purgedDirs.push(dir);
				} catch {
					// Not empty, or already gone. Nothing to do.
				}
			}
		}
	}

	return result;
}