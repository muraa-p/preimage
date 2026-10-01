// SQLite row capture and restore.
//
// git cannot see database state. An agent that runs a migration or an UPDATE
// against your local SQLite file leaves no trace you can check out. This
// adapter snapshots whole tables as JSON keyed by primary key, which is enough
// to put a table back exactly as it was.
//
// Scope is explicit: you name the tables. There is deliberately no "snapshot
// everything" mode, because silently rewriting an entire database on restore
// is exactly the kind of surprise this tool exists to prevent.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Group keys join a database path and a table name. They were previously
// joined with a literal NUL byte inline, which was correct but invisible in
// diffs and made this file read as binary to some tools.
function groupKey(dbPath, table) {
	return JSON.stringify([dbPath, table]);
}

function splitGroupKey(key) {
	return JSON.parse(key);
}

function quoteIdent(name) {
	return `"${String(name).replace(/"/g, '""')}"`;
}

function norm(v) {
	if (v === undefined || v === null) return null;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (v instanceof Uint8Array) return v;
	if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
	return String(v);
}

/** Names of all real (non-internal, non-virtual) tables. */
export function listTables(dbPath) {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return db
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
				 ORDER BY name`,
			)
			.all()
			.map((r) => r.name);
	} finally {
		db.close();
	}
}

/**
 * Primary key columns for a table. Falls back to `rowid` when the table has no
 * declared primary key, which is the only stable row identity SQLite offers.
 */
export function primaryKeyColumns(db, table) {
	const info = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
	const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
	if (pk.length > 0) return pk.map((c) => c.name);
	const hasRowid = db
		.prepare(`SELECT rowid FROM ${quoteIdent(table)} LIMIT 1`)
		.all().length >= 0;
	return hasRowid ? ["rowid"] : [];
}

/** Column names for a table, in declaration order. */
export function columnsOf(db, table) {
	return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map((c) => c.name);
}

/** The CREATE statement for a table, or null if it is missing or a view. */
export function tableDdl(db, table) {
	const row = db
		.prepare(
			`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
		)
		.get(table);
	return row?.sql ?? null;
}

export function tableExists(db, table) {
	return (
		db
			.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
			.get(table) !== undefined
	);
}

/**
 * Read every row of a table as plain JSON-safe objects.
 *
 * Rows come back exactly as node:sqlite gives them: INTEGER PRIMARY KEY
 * columns arrive as BigInt, BLOBs as Uint8Array. serialiseRow tags both so a
 * later restore can put the same types back.
 */
export function readRows(db, table) {
	return db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all();
}

/**
 * Strip BigInt into JSON, tagging which columns were BigInt so restore can
 * coerce them back. node:sqlite returns INTEGER PRIMARY KEY as BigInt.
 */
export function serialiseRow(row) {
	const out = {};
	const bigints = {};
	for (const [k, v] of Object.entries(row)) {
		if (typeof v === "bigint") {
			bigints[k] = true;
			out[k] = v.toString();
		} else if (v instanceof Uint8Array) {
			bigints[k] = false;
			out[k] = Buffer.from(v).toString("base64");
			out[`__b64_${k}`] = true;
		} else {
			out[k] = v;
		}
	}
	out.__meta = { bigints, b64: Object.keys(out).filter((k) => k.startsWith("__b64_")) };
	return out;
}

export function deserialiseRow(obj) {
	const { __meta = { bigints: {}, b64: [] }, ...rest } = obj;
	const out = {};
	for (const [k, v] of Object.entries(rest)) {
		// Internal bookkeeping, never a real column.
		if (k.startsWith("__")) continue;
		if (__meta.b64.includes(`__b64_${k}`)) out[k] = Buffer.from(v, "base64");
		else if (__meta.bigints[k] && v !== null) out[k] = BigInt(v);
		else out[k] = v;
	}
	return out;
}

/**
 * Key order independent JSON, so two objects holding the same data compare
 * equal regardless of how they were built.
 */
function stableStringify(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * Is the row currently in the database the same as the row in the journal?
 *
 * Both sides go through serialiseRow, so a row read from disk and a row read
 * out of the journal are always compared in the same shape. Comparing the raw
 * objects instead reports every unchanged row as changed, because one side
 * still carries serialisation metadata the other has stripped.
 */
export function sameRow(liveRow, storedRowJson) {
	const live = stableStringify(serialiseRow(liveRow));
	const stored = stableStringify(serialiseRow(deserialiseRow(JSON.parse(storedRowJson))));
	return live === stored;
}

/** Stable identity for a row: JSON of its primary key values. */
export function rowKey(row, pkCols) {
	return JSON.stringify(pkCols.map((c) => row[c] ?? null));
}

/**
 * Snapshot the given tables into the journal under `checkpointId`.
 * dbPath is stored as a path relative to the project root when possible so the
 * journal stays portable across machines.
 */
export function captureTables(journal, checkpointId, { root, dbPath, tables }) {
	const abs = path.resolve(root, dbPath);
	if (!fs.existsSync(abs)) {
		throw new Error(`database not found: ${abs}`);
	}
	const storePath = path.relative(root, abs).split(path.sep).join("/") || abs;

	let selected = tables;
	if (!selected || selected.length === 0) {
		selected = listTables(abs);
	}

	const db = new DatabaseSync(abs, { readOnly: true });
	let rowCount = 0;
	const skipped = [];
	try {
		for (const table of selected) {
			if (!tableExists(db, table)) {
				// Naming the missing table beats surfacing a raw SQLite error.
				skipped.push(table);
				continue;
			}
			const pkCols = primaryKeyColumns(db, table);
			const rows = readRows(db, table);
			// Storing the DDL is what lets restore bring back a dropped table.
			journal.addDbTable({
				checkpointId,
				dbPath: storePath,
				table,
				ddl: tableDdl(db, table),
			});
			for (const row of rows) {
				const serialised = serialiseRow(row);
				journal.addDbRow({
					checkpointId,
					dbPath: storePath,
					table,
					pk: rowKey(row, pkCols),
					rowJson: JSON.stringify(serialised),
				});
				rowCount++;
			}
		}
	} finally {
		db.close();
	}
	return { dbPath: storePath, tables: selected.filter((t) => !skipped.includes(t)), rowCount, skipped };
}

/** Dry-run comparison of stored rows against current table contents. */
export function diffTables(journal, checkpointId, root) {
	const storedByTable = new Map();
	for (const row of journal.listDbRows(checkpointId)) {
		const key = groupKey(row.db_path, row.table);
		if (!storedByTable.has(key)) storedByTable.set(key, []);
		storedByTable.get(key).push(row);
	}

	// Direction matters, and the names are relative to the checkpoint:
	//   missing - rows the checkpoint had that are gone now (restore must add them)
	//   extra   - rows present now that the checkpoint never had (restore may delete them)
	const result = { missing: [], updated: [], extra: [], droppedTables: [], identical: 0, errors: [] };

	for (const [key, rows] of storedByTable) {
		const [storePath, table] = splitGroupKey(key);
		const abs = path.resolve(root, storePath);
		if (!fs.existsSync(abs)) {
			result.errors.push(`database missing: ${storePath}`);
			continue;
		}
		let db;
		try {
			db = new DatabaseSync(abs, { readOnly: true });
		} catch (err) {
			result.errors.push(`cannot open ${storePath}: ${err.message}`);
			continue;
		}
		try {
			if (!tableExists(db, table)) {
				// Every stored row counts as missing, which is what restore needs
				// to know and what the user needs to see in the diff.
				for (const row of rows) {
					result.missing.push({ dbPath: storePath, table, pk: row.pk });
				}
				result.droppedTables.push({ dbPath: storePath, table });
				continue;
			}
			const pkCols = primaryKeyColumns(db, table);
			const current = new Map();
			for (const row of readRows(db, table)) {
				current.set(rowKey(row, pkCols), row);
			}
			for (const row of rows) {
				const have = current.get(row.pk);
				if (!have) {
					result.missing.push({ dbPath: storePath, table, pk: row.pk });
					continue;
				}
				if (sameRow(have, row.row_json)) result.identical++;
				else result.updated.push({ dbPath: storePath, table, pk: row.pk });
			}
			for (const pk of current.keys()) {
				if (!rows.some((r) => r.pk === pk)) {
					result.extra.push({ dbPath: storePath, table, pk });
				}
			}
		} finally {
			db.close();
		}
	}
	return result;
}

/**
 * Restore stored rows. Deletions of rows the agent added are opt-in via
 * `removeExtra`, because dropping data is the one irreversible thing this tool
 * does. Runs each table in a transaction.
 */
export function restoreTables(journal, checkpointId, root, { removeExtra = false, only = null } = {}) {
	// Each table's CREATE statement is stored alongside its rows. Without it a
	// table the agent dropped could only be reported, not recovered.
	const ddlByKey = new Map();
	for (const t of journal.listDbTables(checkpointId)) {
		ddlByKey.set(groupKey(t.db_path, t.table), t.ddl ?? null);
	}

	const grouped = new Map();
	for (const row of journal.listDbRows(checkpointId)) {
		const key = groupKey(row.db_path, row.table);
		if (!grouped.has(key)) grouped.set(key, []);
		grouped.get(key).push(row);
	}

	const summary = { restored: 0, deleted: 0, created: 0, tables: [], errors: [] };

	for (const [key, rows] of grouped) {
		const [storePath, table] = splitGroupKey(key);
		if (only && !only.includes(`${storePath}:${table}`)) continue;
		const abs = path.resolve(root, storePath);
		if (!fs.existsSync(abs)) {
			summary.errors.push(`database missing: ${storePath}`);
			continue;
		}
		let db;
		try {
			db = new DatabaseSync(abs);
		} catch (err) {
			summary.errors.push(`cannot open ${storePath}: ${err.message}`);
			continue;
		}
		try {
			if (!tableExists(db, table)) {
				const ddl = ddlByKey.get(key);
				if (!ddl) throw new Error("table no longer exists and no DDL was recorded");
				db.exec(ddl);
				summary.created++;
			}

			const pkCols = primaryKeyColumns(db, table);
			const cols = columnsOf(db, table);

			db.exec("BEGIN IMMEDIATE");
			try {
				for (const row of rows) {
					const want = deserialiseRow(JSON.parse(row.row_json));
					const insertCols = cols.filter((c) => Object.hasOwn(want, c));
					if (insertCols.length === 0) continue;
					const sql =
						`INSERT OR REPLACE INTO ${quoteIdent(table)} (${insertCols.map(quoteIdent).join(", ")})` +
						` VALUES (${insertCols.map(() => "?").join(", ")})`;
					db.prepare(sql).run(...insertCols.map((c) => norm(want[c])));
					summary.restored++;
				}

				if (removeExtra && pkCols.length > 0) {
					const current = db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all();
					const known = new Set(rows.map((r) => r.pk));
					for (const row of current) {
						if (known.has(rowKey(row, pkCols))) continue;
						const where = pkCols.map((c) => `${quoteIdent(c)} = ?`).join(" AND ");
						db.prepare(`DELETE FROM ${quoteIdent(table)} WHERE ${where}`).run(
							...pkCols.map((c) => norm(row[c])),
						);
						summary.deleted++;
					}
				}

				db.exec("COMMIT");
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
			summary.tables.push({ dbPath: storePath, table });
		} catch (err) {
			summary.errors.push(`${storePath}:${table}: ${err.message}`);
		} finally {
			db.close();
		}
	}
	return summary;
}