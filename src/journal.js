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
  ddl          TEXT,
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

/**
 * Columns added after the first release. `CREATE TABLE IF NOT EXISTS` will not
 * touch a table that already exists, so a journal written by an older preimage
 * would otherwise fail on the first query that names a new column. Adding a
 * nullable column is cheap and idempotent; a destructive change would need a
 * real migration tool and a version marker.
 */
const ADDED_COLUMNS = [["db_tables", "ddl", "TEXT"]];

function migrate(db) {
	for (const [table, column, type] of ADDED_COLUMNS) {
		const existing = db
			.prepare(`PRAGMA table_info(${table})`)
			.all()
			.some((c) => c.name === column);
		if (!existing) {
			db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
		}
	}
}

/**
 * Checkpoint lifecycle. A checkpoint is created as `writing` and only becomes
 * `open` once every file and row has actually been persisted.
 *
 * The `writing` state is not decoration. If the process dies partway through a
 * checkpoint, the row would otherwise survive with no content behind it, and
 * every later `diff` would default to it while every `restore` would report
 * success having changed nothing. For a tool whose entire promise is "this is
 * reversible", a restore that silently does nothing is the worst failure
 * available, so an unfinished checkpoint is refused rather than honoured.
 *
 * `open` is also what preimage journals written before this state existed
 * carry, so they keep restoring exactly as they did.
 */
export const STATUS_WRITING = "writing";
export const STATUS_OPEN = "open";
export const STATUS_RESTORED = "restored";

/** True when a checkpoint is complete enough to restore from. */
export function isRestorable(cp) {
	return Boolean(cp) && cp.status !== STATUS_WRITING;
}

/** How long a writer waits for another's lock before giving up. */
const BUSY_TIMEOUT_MS = 10_000;

/**
 * Put the journal into WAL mode, if it is not already, tolerating contention.
 *
 * WAL lets readers run during a write, which matters when a restore is reading
 * the journal while a checkpoint writes to it. But switching a database into WAL
 * needs a brief exclusive lock, and that switch does NOT honour `busy_timeout`:
 * it fails with SQLITE_BUSY in about 0ms if any other connection holds a write
 * lock, however long the timeout says to wait. Verified directly: against a
 * locked database, the pragma fails in 0ms with the same 10s busy timeout set.
 *
 * Two things follow.
 *
 * The pragma is only issued when the database is not in WAL yet. Asserting it
 * unconditionally -- which is what putting it in the schema string did -- made
 * every single `preimage` command perform the switch, so any command overlapping
 * another one could die with "database is locked". Once the journal is in WAL it
 * stays there, and this becomes a cheap read.
 *
 * And a genuine first-time switch that does collide is not fatal. The loser of
 * the race simply opens the journal in whatever mode the winner chose, which is
 * WAL. Failing here would be the wrong trade: the journal still works, only
 * concurrent readers block a little longer.
 */
function ensureWal(db) {
	const { journal_mode: mode } = db.prepare("PRAGMA journal_mode").get();
	if (String(mode).toLowerCase() === "wal") return;
	try {
		db.exec("PRAGMA journal_mode = WAL");
	} catch (err) {
		// 5 is SQLITE_BUSY. Another connection is mid-write and holds the lock
		// this switch needs. Whoever is switching will get there.
		if (err?.errcode !== 5) throw err;
	}
}

export class Journal {
	constructor(dbPath) {
		ensureDir(journalDir(dbPath.replace(/[/\\]journal\.db$/, "")));
		this.path = dbPath;
		this.db = new DatabaseSync(dbPath);
		// WAL lets readers run during a write, but writers still serialise, and
		// SQLite's default busy timeout is 0 -- so a second process racing the
		// first gets SQLITE_BUSY immediately instead of waiting its turn.
		// Agents run work in parallel, and `preimage checkpoint` is exactly the
		// kind of thing several of them will reach for at once.
		this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		ensureWal(this.db);
		this.db.exec(SCHEMA);
		migrate(this.db);
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

	/**
	 * Run `fn` as a single write transaction, rolling back if it throws.
	 *
	 * `BEGIN IMMEDIATE` takes the write lock up front rather than on the first
	 * write, so concurrent writers queue on the busy timeout rather than
	 * failing half way through. Everything in a checkpoint -- the row, the
	 * file entries, the blobs, the table rows -- is written inside one of
	 * these, so a checkpoint either exists complete or not at all.
	 */
	transaction(fn) {
		this.db.exec("BEGIN IMMEDIATE");
		let out;
		try {
			out = fn();
		} catch (err) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// already rolled back, or the connection is unusable; the
				// original error is the one worth surfacing
			}
			throw err;
		}
		this.db.exec("COMMIT");
		return out;
	}

	// --- checkpoints -------------------------------------------------------

	createCheckpoint({ root, label = null, source = "cli" }) {
		const info = this.db
			.prepare(
				"INSERT INTO checkpoints (created_at, root, label, source, status) VALUES (?, ?, ?, ?, ?)",
			)
			.run(Date.now(), root, label, source, STATUS_WRITING);
		return Number(info.lastInsertRowid);
	}

	finaliseCheckpoint(id, { fileCount = 0, totalBytes = 0, dbCount = 0 }) {
		this.db
			.prepare(
				"UPDATE checkpoints SET file_count = ?, total_bytes = ?, db_count = ?, status = ? WHERE id = ?",
			)
			.run(fileCount, totalBytes, dbCount, STATUS_OPEN, id);
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

	/**
	 * The newest checkpoint that finished being written. An unfinished one is
	 * skipped rather than returned, so a bare `preimage diff` never defaults to
	 * a checkpoint with nothing behind it.
	 */
	latestCheckpoint() {
		return (
			this.db
				.prepare(
					"SELECT * FROM checkpoints WHERE status != ? ORDER BY id DESC LIMIT 1",
				)
				.get(STATUS_WRITING) ?? null
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

	addDbTable({ checkpointId, dbPath, table, ddl = null }) {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO db_tables (checkpoint_id, db_path, table_name, ddl) VALUES (?, ?, ?, ?)",
			)
			.run(norm(checkpointId), dbPath, table, norm(ddl));
	}

	listDbTables(checkpointId) {
		return this.db
			.prepare(
				'SELECT db_path, table_name AS "table", ddl FROM db_tables WHERE checkpoint_id = ? ORDER BY db_path, table_name',
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