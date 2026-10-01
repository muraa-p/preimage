import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Journal } from "../src/journal.js";
import { captureTables, diffTables, restoreTables, listTables, rowKey, serialiseRow, deserialiseRow, primaryKeyColumns } from "../src/dbadapter.js";

function tmpRoot(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preimage-db-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function makeDb(root, name = "app.db") {
	const abs = path.join(root, name);
	const db = new DatabaseSync(abs);
	db.exec(`
    CREATE TABLE users (
      id    INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      name  TEXT,
      score REAL
    );
    CREATE TABLE notes (
      id   INTEGER PRIMARY KEY,
      body TEXT
    );
  `);
	db.prepare("INSERT INTO users (id, email, name, score) VALUES (?, ?, ?, ?)").run(1, "a@example.com", "Ada", 10.5);
	db.prepare("INSERT INTO users (id, email, name, score) VALUES (?, ?, ?, ?)").run(2, "b@example.com", "Bob", 20.25);
	db.prepare("INSERT INTO notes (id, body) VALUES (?, ?)").run(1, "first note");
	db.close();
	return abs;
}

test("listTables finds user tables and skips sqlite internals", (t) => {
	const root = tmpRoot(t);
	const abs = makeDb(root);
	assert.deepEqual(listTables(abs), ["notes", "users"]);
});

test("primaryKeyColumns returns declared pk columns in order", (t) => {
	const root = tmpRoot(t);
	const abs = makeDb(root);
	const db = new DatabaseSync(abs, { readOnly: true });
	const cols = primaryKeyColumns(db, "users");
	assert.equal(cols.length, 1);
	assert.equal(cols[0], "id");
	db.close();
});

test("primaryKeyColumns falls back to rowid when no pk declared", (t) => {
	const root = tmpRoot(t);
	const abs = path.join(root, "nopk.db");
	const db = new DatabaseSync(abs);
	db.exec("CREATE TABLE t (a TEXT, b TEXT)");
	db.close();

	const db2 = new DatabaseSync(abs, { readOnly: true });
	assert.deepEqual(primaryKeyColumns(db2, "t"), ["rowid"]);
	db2.close();
});

test("capture and restore recovers a dropped table's rows", (t) => {
	const root = tmpRoot(t);
	const abs = makeDb(root);
	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	const result = captureTables(j, id, { root, dbPath: "app.db", tables: ["users"] });
	j.finaliseCheckpoint(id, { fileCount: 0, totalBytes: 0, dbCount: result.rowCount });
	assert.equal(result.rowCount, 2);

	// The agent deletes everything.
	const db = new DatabaseSync(abs);
	db.exec("DELETE FROM users");
	const gone = db.prepare("SELECT COUNT(*) AS n FROM users").get();
	assert.equal(Number(gone.n), 0);
	db.close();

	restoreTables(j, id, root, {});

	const db2 = new DatabaseSync(abs, { readOnly: true });
	const rows = db2.prepare("SELECT * FROM users ORDER BY id").all();
	assert.equal(rows.length, 2);
	assert.equal(rows[0].email, "a@example.com");
	assert.equal(rows[1].name, "Bob");
	db2.close();
	j.close();
});

test("restore repairs mutated column values", (t) => {
	const root = tmpRoot(t);
	const abs = makeDb(root);
	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	captureTables(j, id, { root, dbPath: "app.db", tables: ["users"] });
	j.finaliseCheckpoint(id, { dbCount: 2 });

	const db = new DatabaseSync(abs);
	db.prepare("UPDATE users SET email = ?, name = ? WHERE id = 1").run("hacked@evil.com", "HACKED");
	db.close();

	restoreTables(j, id, root, {});

	const db2 = new DatabaseSync(abs, { readOnly: true });
	const row = db2.prepare("SELECT * FROM users WHERE id = 1").get();
	assert.equal(row.email, "a@example.com");
	assert.equal(row.name, "Ada");
	db2.close();
	j.close();
});

test("restore re-inserts a row the agent deleted", (t) => {
	const root = tmpRoot(t);
	const abs = makeDb(root);
	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	captureTables(j, id, { root, dbPath: "app.db", tables: ["users"] });
	j.finaliseCheckpoint(id, { dbCount: 2 });

	const db = new DatabaseSync(abs);
	db.exec("DELETE FROM users WHERE id = 2");
	db.close();

	restoreTables(j, id, root, {});

	const db2 = new DatabaseSync(abs, { readOnly: true });
	const row = db2.prepare("SELECT * FROM users WHERE id = 2").get();
	assert.equal(row.name, "Bob");
	db2.close();
	j.close();
});

test("removeExtra deletes rows added after the checkpoint", (t) => {
	const root = tmpRoot(t);
	const abs = makeDb(root);
	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	captureTables(j, id, { root, dbPath: "app.db", tables: ["users"] });
	j.finaliseCheckpoint(id, { dbCount: 2 });

	const db = new DatabaseSync(abs);
	db.prepare("INSERT INTO users (id, email, name, score) VALUES (?, ?, ?, ?)").run(3, "new@example.com", "New", 1);
	db.close();

	restoreTables(j, id, root, { removeExtra: true });

	const db2 = new DatabaseSync(abs, { readOnly: true });
	assert.equal(Number(db2.prepare("SELECT COUNT(*) AS n FROM users").get().n), 2);
	db2.close();
	j.close();
});

test("without removeExtra, extra rows survive", (t) => {
	const root = tmpRoot(t);
	const abs = makeDb(root);
	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	captureTables(j, id, { root, dbPath: "app.db", tables: ["users"] });
	j.finaliseCheckpoint(id, { dbCount: 2 });

	const db = new DatabaseSync(abs);
	db.prepare("INSERT INTO users (id, email, name, score) VALUES (?, ?, ?, ?)").run(3, "new@example.com", "New", 1);
	db.close();

	restoreTables(j, id, root, {});

	const db2 = new DatabaseSync(abs, { readOnly: true });
	assert.equal(Number(db2.prepare("SELECT COUNT(*) AS n FROM users").get().n), 3);
	db2.close();
	j.close();
});

test("diffTables reports missing, updated and extra rows", (t) => {
	const root = tmpRoot(t);
	const abs = makeDb(root);
	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	captureTables(j, id, { root, dbPath: "app.db", tables: ["users"] });
	j.finaliseCheckpoint(id, { dbCount: 2 });

	const db = new DatabaseSync(abs);
	db.prepare("UPDATE users SET name = ? WHERE id = 1").run("Changed");
	db.exec("DELETE FROM users WHERE id = 2");
	db.prepare("INSERT INTO users (id, email, name, score) VALUES (?, ?, ?, ?)").run(3, "c@x.com", "Cy", 5);
	db.close();

	const diff = diffTables(j, id, root);
	assert.equal(diff.updated.length, 1);
	assert.equal(diff.updated[0].pk, "[1]");
	// id 2 was deleted after the checkpoint, so restore must add it back.
	assert.equal(diff.missing.length, 1);
	assert.equal(diff.missing[0].pk, "[2]");
	// id 3 was added after the checkpoint, so it is extra.
	assert.equal(diff.extra.length, 1);
	assert.equal(diff.extra[0].pk, "[3]");
	j.close();
});

test("capture with no table list captures every table", (t) => {
	const root = tmpRoot(t);
	makeDb(root);
	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	const result = captureTables(j, id, { root, dbPath: "app.db", tables: [] });
	assert.equal(result.tables.length, 2);
	assert.equal(result.rowCount, 3); // 2 users + 1 note
	j.close();
});

test("capture reports a clear error for a missing database", (t) => {
	const root = tmpRoot(t);
	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	assert.throws(
		() => captureTables(j, id, { root, dbPath: "nope.db", tables: [] }),
		/database not found/,
	);
	j.close();
});

test("row serialisation round-trips nulls, numbers and blobs", () => {
	const original = {
		id: 7n,
		name: "seven",
		ratio: 0.5,
		nothing: null,
		payload: Buffer.from([1, 2, 3, 255]),
	};
	const back = deserialiseRow(serialiseRow(original));
	assert.equal(typeof back.id, "bigint");
	assert.equal(back.id, 7n);
	assert.equal(back.name, "seven");
	assert.equal(back.ratio, 0.5);
	assert.equal(back.nothing, null);
	assert.ok(Buffer.isBuffer(back.payload));
	assert.deepEqual([...back.payload], [1, 2, 3, 255]);
});

test("rowKey is stable and distinguishes null from string null", () => {
	assert.equal(rowKey({ id: 1 }, ["id"]), "[1]");
	assert.equal(rowKey({ id: null }, ["id"]), "[null]");
	assert.notEqual(rowKey({ id: null }, ["id"]), rowKey({ id: "null" }, ["id"]));
});

test("restore is idempotent for rows", (t) => {
	const root = tmpRoot(t);
	const abs = makeDb(root);
	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	captureTables(j, id, { root, dbPath: "app.db", tables: ["users"] });
	j.finaliseCheckpoint(id, { dbCount: 2 });

	const first = restoreTables(j, id, root, {});
	assert.ok(first.restored > 0);

	const db = new DatabaseSync(abs);
	db.prepare("UPDATE users SET name = ? WHERE id = 1").run("Changed");
	db.close();

	const second = restoreTables(j, id, root, {});
	assert.ok(second.errors.length === 0);
	const db2 = new DatabaseSync(abs, { readOnly: true });
	assert.equal(db2.prepare("SELECT name FROM users WHERE id = 1").get().name, "Ada");
	db2.close();
	j.close();
});

test("restore leaves tables the checkpoint never captured alone", (t) => {
	const root = tmpRoot(t);
	const abs = makeDb(root);
	const j = Journal.open(root);
	const id = j.createCheckpoint({ root });
	// Only 'users' is captured. 'notes' is out of scope entirely.
	captureTables(j, id, { root, dbPath: "app.db", tables: ["users"] });
	j.finaliseCheckpoint(id, { dbCount: 2 });

	const db = new DatabaseSync(abs);
	db.exec("DELETE FROM notes");
	db.close();

	restoreTables(j, id, root, { removeExtra: true });

	// The note row was deleted and must stay deleted: preimage never saw it, so
	// restoring must not resurrect it.
	const db2 = new DatabaseSync(abs, { readOnly: true });
	assert.equal(Number(db2.prepare("SELECT COUNT(*) AS n FROM notes").get().n), 0);
	db2.close();
	j.close();
});