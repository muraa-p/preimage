// File snapshot and diff.
//
// A checkpoint stores the content of every file under the root so a later
// restore can put the tree back byte-for-byte. Symlinks are recorded by target
// string rather than followed, which keeps a restore honest about links.
//
// Journal records for a symlink hold the link target as their "content" blob,
// so restore can distinguish "a link that points at X" from "a regular file
// whose bytes happen to equal X".

import fs from "node:fs";
import path from "node:path";
import { isIgnored, sha256 } from "./util.js";

/** Default cap: files larger than this are recorded but not stored. */
export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

const SKIP_PREFIX = "preimage:skipped:";
const SKIP_MARKER = (reason) => `${SKIP_PREFIX}${reason}`;

function isSkipMarker(bytes) {
	return bytes.byteLength > SKIP_PREFIX.length && bytes.toString("utf8", 0, SKIP_PREFIX.length) === SKIP_PREFIX;
}

/** Exported so restore can recognise entries recorded without content. */
export { isSkipMarker };

/** Build the journal descriptor for one path, reading content when storable. */
function describe(abs, maxFileBytes) {
	const st = fs.lstatSync(abs);

	if (st.isSymbolicLink()) {
		const target = fs.readlinkSync(abs);
		return { kind: "symlink", mode: st.mode, size: target.length, bytes: Buffer.from(target, "utf8") };
	}
	if (!st.isFile()) return null;
	if (st.size > maxFileBytes) {
		return {
			kind: "file",
			mode: st.mode,
			size: st.size,
			bytes: Buffer.from(SKIP_MARKER("too-large"), "utf8"),
		};
	}
	const bytes = fs.readFileSync(abs);
	return { kind: "file", mode: st.mode, size: st.size, bytes, sha: sha256(bytes) };
}

/**
 * Recursively scan `root`, returning Map<relPosixPath, descriptor>.
 * Descriptors carry `bytes` so the caller can persist without re-reading.
 */
export function scanTree(root, { maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
	const out = new Map();
	const stack = [""];
	while (stack.length > 0) {
		const relDir = stack.pop();
		const absDir = relDir === "" ? root : path.join(root, ...relDir.split("/"));
		let entries;
		try {
			entries = fs.readdirSync(absDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (isIgnored(entry.name)) continue;
			const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
			const abs = path.join(absDir, entry.name);
			if (entry.isDirectory()) {
				stack.push(rel);
				continue;
			}
			let desc;
			try {
				desc = describe(abs, maxFileBytes);
			} catch {
				continue; // vanished mid-scan
			}
			if (desc) out.set(rel, desc);
		}
	}
	return out;
}

/** Persist a scanned tree into the journal under a checkpoint. */
export function persistTree(journal, checkpointId, tree) {
	let fileCount = 0;
	let totalBytes = 0;
	for (const [rel, desc] of tree) {
		const sha = journal.putBlob(sha256(desc.bytes), desc.bytes);
		journal.addFile({
			checkpointId,
			path: rel,
			kind: desc.kind,
			mode: desc.mode,
			size: desc.size,
			sha,
		});
		fileCount++;
		totalBytes += desc.size;
	}
	return { fileCount, totalBytes };
}

/** Read the stored descriptor for one checkpoint entry, hydrated with bytes. */
function hydrate(journal, row) {
	const bytes = journal.getBlob(row.sha);
	return { path: row.path, kind: row.kind, mode: row.mode, size: row.size, sha: row.sha, bytes };
}

/**
 * Compare the current state of `root` against a stored checkpoint.
 * Returns { added, modified, removed, unchanged, unreadable }.
 */
export function diffTree(journal, checkpointId, root, opts = {}) {
	const stored = new Map();
	for (const row of journal.listFiles(checkpointId)) stored.set(row.path, row);

	const current = scanTree(root, opts);
	const added = [];
	const modified = [];
	const removed = [];
	const unchanged = [];
	const unreadable = [];

	for (const [rel, desc] of current) {
		const prev = stored.get(rel);
		const isSymlink = desc.kind === "symlink";

		if (!prev) {
			added.push({ path: rel, size: desc.size, kind: desc.kind });
			continue;
		}

		// A file that was skipped at checkpoint time and is skipped now tells us
		// nothing, so treat it as unchanged rather than reporting noise.
		const prevSkipped = isSkipMarker(journal.getBlob(prev.sha) ?? Buffer.alloc(0));
		const nowSkipped = !isSymlink && isSkipMarker(desc.bytes);
		if (prevSkipped || nowSkipped) {
			unchanged.push(rel);
			continue;
		}

		const prevBytes = journal.getBlob(prev.sha);
		if (!prevBytes) {
			unreadable.push(rel);
			continue;
		}

		if (sha256(prevBytes) !== sha256(desc.bytes)) {
			modified.push({ path: rel, size: desc.size, kind: desc.kind });
		} else {
			unchanged.push(rel);
		}
	}

	for (const rel of stored.keys()) {
		if (!current.has(rel)) removed.push(rel);
	}

	return { added, modified, removed, unchanged, unreadable };
}

/** Hydrate every stored entry for a checkpoint. Used by restore. */
export function loadTree(journal, checkpointId) {
	return journal.listFiles(checkpointId).map((row) => hydrate(journal, row));
}