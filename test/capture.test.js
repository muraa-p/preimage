import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Journal } from "../src/journal.js";
import { scanTree, persistTree, diffTree, loadTree } from "../src/capture.js";
import { restoreFiles } from "../src/restore.js";

function tmpRoot(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preimage-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function write(root, rel, content) {
	const abs = path.join(root, ...rel.split("/"));
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
}

// Creating symlinks on Windows needs Developer Mode or elevation. Probe once so
// symlink tests skip instead of failing for environmental reasons.
const symlinksAvailable = (() => {
	const probe = path.join(os.tmpdir(), `preimage-symlink-probe-${process.pid}`);
	try {
		fs.symlinkSync(probe, `${probe}-link`);
		fs.unlinkSync(`${probe}-link`);
		return true;
	} catch {
		return false;
	}
})();

test("journal creates checkpoints and survives reopening", (t) => {
	const root = tmpRoot(t);
	const j = Journal.open(root);
	const id = j.createCheckpoint({ root, label: "first" });
	j.finaliseCheckpoint(id, { fileCount: 2, totalBytes: 10, dbCount: 0 });
	j.close();

	const again = Journal.open(root);
	const cp = again.getCheckpoint(id);
	assert.equal(cp.label, "first");
	assert.equal(cp.file_count, 2);
	assert.equal(cp.status, "open");
	again.close();
});

test("blobs are deduplicated by content hash", (t) => {
	const root = tmpRoot(t);
	const j = Journal.open(root);
	const bytes = Buffer.from("identical content");
	const sha1 = j.putBlob("aaa", bytes);
	const sha2 = j.putBlob("aaa", bytes);
	assert.equal(sha1, sha2);
	assert.equal(j.getBlob("aaa").toString(), "identical content");
	assert.equal(j.stats().blobs, 1);
	j.close();
});

test("scanTree skips ignored directories", (t) => {
	const root = tmpRoot(t);
	write(root, "keep.txt", "keep");
	write(root, "node_modules/pkg/index.js", "nope");
	write(root, ".git/config", "nope");

	const tree = scanTree(root);
	assert.deepEqual([...tree.keys()].sort(), ["keep.txt"]);
});

test("scanTree records nested files with posix relative paths", (t) => {
	const root = tmpRoot(t);
	write(root, "src/deep/nested/file.ts", "content");

	const tree = scanTree(root);
	assert.deepEqual([...tree.keys()], ["src/deep/nested/file.ts"]);
});

test("files larger than maxFileBytes are recorded but not stored", (t) => {
	const root = tmpRoot(t);
	write(root, "big.bin", Buffer.alloc(2048, 7));

	const tree = scanTree(root, { maxFileBytes: 1024 });
	const entry = tree.get("big.bin");
	assert.equal(entry.size, 2048);
	assert.match(entry.bytes.toString("utf8"), /^preimage:skipped:/);
});

test("checkpoint then restore returns modified file to original bytes", (t) => {
	const root = tmpRoot(t);
	write(root, "config.json", '{"port":3000}');

	const j = Journal.open(root);
	const id = j.createCheckpoint({ root, label: "before" });
	persistTree(j, id, scanTree(root));
	j.finaliseCheckpoint(id, { fileCount: 1, totalBytes: 15, dbCount: 0 });

	// The agent breaks it.
	write(root, "config.json", '{"port":9999}');
	assert.equal(fs.readFileSync(path.join(root, "config.json"), "utf8"), '{"port":9999}');

	const result = restoreFiles(j, id, root, {});
	assert.equal(result.errors.length, 0);
	assert.equal(result.written.length, 1);
	assert.equal(fs.readFileSync(path.join(root, "config.json"), "utf8"), '{"port":3000}');
	j.close();
});

test("restore puts back a deleted file", (t) => {
	const root = tmpRoot(t);
	write(root, "important.txt", "do not lose me");

	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	persistTree(j, id, scanTree(root));
	j.finaliseCheckpoint(id, { fileCount: 1, totalBytes: 14, dbCount: 0 });

	fs.unlinkSync(path.join(root, "important.txt"));

	const result = restoreFiles(j, id, root, {});
	assert.equal(fs.existsSync(path.join(root, "important.txt")), true);
	assert.equal(fs.readFileSync(path.join(root, "important.txt"), "utf8"), "do not lose me");
	assert.equal(result.errors.length, 0);
	j.close();
});

test("restore recreates a file the agent deleted a directory for", (t) => {
	const root = tmpRoot(t);
	write(root, "src/app.ts", "export const a = 1;");

	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	persistTree(j, id, scanTree(root));
	j.finaliseCheckpoint(id, { fileCount: 1, totalBytes: 19, dbCount: 0 });

	fs.rmSync(path.join(root, "src"), { recursive: true, force: true });

	restoreFiles(j, id, root, {});
	assert.equal(fs.readFileSync(path.join(root, "src", "app.ts"), "utf8"), "export const a = 1;");
	j.close();
});

test("purge removes files created after the checkpoint", (t) => {
	const root = tmpRoot(t);
	write(root, "original.txt", "original");

	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	persistTree(j, id, scanTree(root));
	j.finaliseCheckpoint(id, { fileCount: 1, totalBytes: 8, dbCount: 0 });

	write(root, "agent-created.txt", "junk");
	write(root, "original.txt", "modified");

	restoreFiles(j, id, root, { purge: true });

	assert.equal(fs.existsSync(path.join(root, "agent-created.txt")), false);
	assert.equal(fs.readFileSync(path.join(root, "original.txt"), "utf8"), "original");
	j.close();
});

test("without purge, files created after the checkpoint are left alone", (t) => {
	const root = tmpRoot(t);
	write(root, "original.txt", "original");

	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	persistTree(j, id, scanTree(root));
	j.finaliseCheckpoint(id, { fileCount: 1, totalBytes: 8, dbCount: 0 });

	write(root, "agent-created.txt", "keep me");

	restoreFiles(j, id, root, {});
	assert.equal(fs.existsSync(path.join(root, "agent-created.txt")), true);
	j.close();
});

test("restore is idempotent", (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "one");
	write(root, "b.txt", "two");

	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	persistTree(j, id, scanTree(root));
	j.finaliseCheckpoint(id, { fileCount: 2, totalBytes: 6, dbCount: 0 });

	write(root, "a.txt", "changed");
	write(root, "b.txt", "changed");

	const first = restoreFiles(j, id, root, {});
	const second = restoreFiles(j, id, root, {});

	assert.equal(first.written.length, 2);
	assert.equal(second.written.length, 0);
	assert.equal(second.unchanged, 2);
	j.close();
});

test("dryRun reports without writing", (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "one");

	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	persistTree(j, id, scanTree(root));
	j.finaliseCheckpoint(id, { fileCount: 1, totalBytes: 3, dbCount: 0 });

	write(root, "a.txt", "changed");

	const result = restoreFiles(j, id, root, { dryRun: true });
	assert.equal(result.written.length, 1);
	assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "changed");
	j.close();
});

test("diffTree classifies added, modified, removed and unchanged", (t) => {
	const root = tmpRoot(t);
	write(root, "stay.txt", "same");
	write(root, "change.txt", "before");
	write(root, "gone.txt", "will go");

	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	persistTree(j, id, scanTree(root));
	j.finaliseCheckpoint(id, { fileCount: 3, totalBytes: 20, dbCount: 0 });

	write(root, "stay.txt", "same");
	write(root, "change.txt", "after");
	write(root, "new.txt", "brand new");
	fs.unlinkSync(path.join(root, "gone.txt"));

	const diff = diffTree(j, id, root);
	assert.deepEqual(diff.added.map((f) => f.path), ["new.txt"]);
	assert.deepEqual(diff.modified.map((f) => f.path), ["change.txt"]);
	assert.deepEqual(diff.removed, ["gone.txt"]);
	assert.deepEqual(diff.unchanged.sort(), ["stay.txt"]);
	assert.equal(diff.unreadable.length, 0);
	j.close();
});

test("symlinks are restored as symlinks", { skip: !symlinksAvailable }, (t) => {
	const root = tmpRoot(t);
	write(root, "real.txt", "content");
	fs.symlinkSync(path.join(root, "real.txt"), path.join(root, "link.txt"));

	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	persistTree(j, id, scanTree(root));
	j.finaliseCheckpoint(id, { fileCount: 2, totalBytes: 15, dbCount: 0 });

	fs.unlinkSync(path.join(root, "link.txt"));
	restoreFiles(j, id, root, {});

	const st = fs.lstatSync(path.join(root, "link.txt"));
	assert.equal(st.isSymbolicLink(), true);
	assert.equal(fs.readFileSync(path.join(root, "link.txt"), "utf8"), "content");
	j.close();
});

test("restore refuses to write outside the project root", (t) => {
	const root = tmpRoot(t);
	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	// Simulate a tampered checkpoint record.
	j.addFile({
		checkpointId: id,
		path: "../escaped.txt",
		kind: "file",
		mode: 0o644,
		size: 5,
		sha: j.putBlob("evil", Buffer.from("evil")),
	});
	j.finaliseCheckpoint(id, { fileCount: 1, totalBytes: 5, dbCount: 0 });

	const result = restoreFiles(j, id, root, {});
	assert.equal(result.errors.length, 1);
	assert.match(result.errors[0], /outside project root/);
	assert.equal(fs.existsSync(path.resolve(root, "../escaped.txt")), false);
	j.close();
});

test("too-large files are skipped rather than blanked", (t) => {
	const root = tmpRoot(t);
	write(root, "big.bin", Buffer.alloc(4096, 9));

	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	persistTree(j, id, scanTree(root, { maxFileBytes: 1024 }));
	j.finaliseCheckpoint(id, { fileCount: 1, totalBytes: 4096, dbCount: 0 });

	write(root, "big.bin", Buffer.alloc(4096, 1));

	const result = restoreFiles(j, id, root, {});
	assert.equal(result.skipped.length, 1);
	// Content must not be destroyed.
	assert.equal(fs.readFileSync(path.join(root, "big.bin"))[0], 1);
	j.close();
});

test("gc removes blobs no longer referenced", (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "content to store");
	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	persistTree(j, id, scanTree(root));
	j.finaliseCheckpoint(id, { fileCount: 1, totalBytes: 16, dbCount: 0 });
	assert.ok(j.stats().bytes > 0);

	j.deleteCheckpoint(id);
	const freed = j.gc();
	assert.ok(freed > 0);
	assert.equal(j.stats().blobs, 0);
	j.close();
});

test("loadTree hydrates bytes for every entry", (t) => {
	const root = tmpRoot(t);
	write(root, "x.txt", "xyz");

	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	persistTree(j, id, scanTree(root));
	j.finaliseCheckpoint(id, { fileCount: 1, totalBytes: 3, dbCount: 0 });

	const entries = loadTree(j, id);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].bytes.toString(), "xyz");
	assert.equal(entries[0].kind, "file");
	j.close();
});