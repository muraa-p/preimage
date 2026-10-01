// SQLite-backed journal. One database per project, living in <root>/.preimage/journal.db.
//
// Schema notes:
//  - blobs are content-addressed by sha256 so identical files across checkpoints
//    are stored once. Restoring a checkpoint only needs the blob lookup.
//  - files rows reference blobs by sha rather than inlining bytes.
//  - db_rows stores full row JSON per primary key so restore can upsert or delete.
//
// node:sqlite only accepts null | number | bigint | string | Uint8Array for bound
// values. Booleans and undefined are rejected, so we normalise on the way in.

import { DatabaseSync } from "node:sqlite";
import { ensureDir, journalDir, journalPath } from "./util.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoints (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,
  root        TEXT NOT NULL,
  label       TEXT,
  source      TEXT NOT NULL DEFAULT 'cli',
  status      TEXT NOT NULL DEFAULT 'open',
  file_count  INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  db_count    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS blobs (
  sha    TEXT PRIMARY KEY,
  bytes  BLOB NOT NULL,
  size   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'file',
  mode         INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  sha          TEXT NOT NULL,
  UNIQUE (checkpoint_id, path)
);
CREATE INDEX IF NOT EXISTS files_checkpoint ON files (checkpoint_id);

CREATE TABLE IF NOT EXISTS db_tables (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  db_path      TEXT NOT NULL,
  table_name   TEXT NOT NULL,
  UNIQUE (checkpoint_id, db_path, table_name)
);

CREATE TABLE IF NOT EXISTS db_rows (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  db_path      TEXT NOT NULL,
  table_name   TEXT NOT NULL,
  pk           TEXT NOT NULL,
  row_json     TEXT NOT NULL,
  UNIQUE (checkpoint_id, db_path, table_name, pk)
);
CREATE INDEX IF NOT EXISTS db_rows_checkpoint ON db_rows (checkpoint_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
`;

function norm(value) {
	if (value === undefined || value === null) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (value instanceof Uint8Array) return value;
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") {
		return value;
	}
	return String(value);
}

export class Journal {
	constructor(dbPath) {
		ensureDir(journalDir(dbPath.replace(/[/\\]journal\.db$/, "")));
		this.path = dbPath;
		this.db = new DatabaseSync(dbPath);
		this.db.exec(SCHEMA);
	}

	static open(root) {
		return new Journal(journalPath(root));
	}

	close() {
		try {
			this.db.close();
		} catch {
			// already closed
		}
	}

	// --- checkpoints -------------------------------------------------------

	createCheckpoint({ root, label = null, source = "cli" }) {
		const info = this.db
			.prepare(
				"INSERT INTO checkpoints (created_at, root, label, source) VALUES (?, ?, ?, ?)",
			)
			.run(Date.now(), root, label, source);
		return Number(info.lastInsertRowid);
	}

	finaliseCheckpoint(id, { fileCount = 0, totalBytes = 0, dbCount = 0 }) {
		this.db
			.prepare(
				"UPDATE checkpoints SET file_count = ?, total_bytes = ?, db_count = ? WHERE id = ?",
			)
			.run(fileCount, totalBytes, dbCount, id);
	}

	getCheckpoint(id) {
		return (
			this.db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(norm(id)) ?? null
		);
	}

	listCheckpoints({ limit = 50 } = {}) {
		return this.db
			.prepare(
				"SELECT * FROM checkpoints ORDER BY id DESC LIMIT ?",
			)
			.all(norm(limit));
	}

	latestCheckpoint() {
		return (
			this.db.prepare("SELECT * FROM checkpoints ORDER BY id DESC LIMIT 1").get() ?? null
		);
	}

	setCheckpointStatus(id, status) {
		this.db.prepare("UPDATE checkpoints SET status = ? WHERE id = ?").run(status, norm(id));
	}

	deleteCheckpoint(id) {
		this.db.prepare("DELETE FROM checkpoints WHERE id = ?").run(norm(id));
	}

	// --- blobs -------------------------------------------------------------

	/** Store bytes if this sha is not already present. Returns the sha. */
	putBlob(sha, bytes) {
		const exists = this.db.prepare("SELECT 1 FROM blobs WHERE sha = ?").get(norm(sha));
		if (exists) return sha;
		this.db
			.prepare("INSERT INTO blobs (sha, bytes, size) VALUES (?, ?, ?)")
			.run(norm(sha), bytes, bytes.byteLength);
		return sha;
	}

	getBlob(sha) {
		const row = this.db.prepare("SELECT bytes FROM blobs WHERE sha = ?").get(norm(sha));
		if (!row) return null;
		return Buffer.from(row.bytes);
	}

	// --- files -------------------------------------------------------------

	addFile({ checkpointId, path, kind = "file", mode, size, sha }) {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO files (checkpoint_id, path, kind, mode, size, sha) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(norm(checkpointId), path, kind, norm(mode), norm(size), norm(sha));
	}

	listFiles(checkpointId) {
		return this.db
			.prepare("SELECT path, kind, mode, size, sha FROM files WHERE checkpoint_id = ? ORDER BY path")
			.all(norm(checkpointId));
	}

	getFile(checkpointId, filePath) {
		return (
			this.db
				.prepare("SELECT path, kind, mode, size, sha FROM files WHERE checkpoint_id = ? AND path = ?")
				.get(norm(checkpointId), filePath) ?? null
		);
	}

	// --- database rows -----------------------------------------------------

	addDbTable({ checkpointId, dbPath, table }) {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO db_tables (checkpoint_id, db_path, table_name) VALUES (?, ?, ?)",
			)
			.run(norm(checkpointId), dbPath, table);
	}

	listDbTables(checkpointId) {
		return this.db
			.prepare(
				'SELECT db_path, table_name AS "table" FROM db_tables WHERE checkpoint_id = ? ORDER BY db_path, table_name',
			)
			.all(norm(checkpointId));
	}

	addDbRow({ checkpointId, dbPath, table, pk, rowJson }) {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO db_rows (checkpoint_id, db_path, table_name, pk, row_json) VALUES (?, ?, ?, ?, ?)",
			)
			.run(norm(checkpointId), dbPath, table, pk, rowJson);
	}

	listDbRows(checkpointId, { dbPath = null, table = null } = {}) {
		let sql = 'SELECT db_path, table_name AS "table", pk, row_json FROM db_rows WHERE checkpoint_id = ?';
		const params = [norm(checkpointId)];
		if (dbPath !== null) {
			sql += " AND db_path = ?";
			params.push(dbPath);
		}
		if (table !== null) {
			sql += " AND table_name = ?";
			params.push(table);
		}
		sql += " ORDER BY db_path, table_name, pk";
		return this.db.prepare(sql).all(...params);
	}

	// --- maintenance -------------------------------------------------------

	/** Remove blobs no longer referenced by any checkpoint. Returns bytes freed. */
	gc() {
		const before = this.db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM blobs").get();
		this.db
			.prepare(
				"DELETE FROM blobs WHERE sha NOT IN (SELECT DISTINCT sha FROM files)",
			)
			.run();
		const after = this.db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM blobs").get();
		return Number(before.n) - Number(after.n);
	}

	stats() {
		const checkpoints = this.db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get();
		const blobs = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM blobs").get();
		return {
			checkpoints: Number(checkpoints.n),
			blobs: Number(blobs.n),
			bytes: Number(blobs.bytes),
		};
	}
}

export function openJournal(root) {
	const j = Journal.open(root);
	return j;
}