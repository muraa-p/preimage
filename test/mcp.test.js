import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { createServer, runStdio } from "../src/mcp.js";
import { Journal } from "../src/journal.js";

function tmpRoot(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preimage-mcp-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function write(root, rel, content) {
	const abs = path.join(root, ...rel.split("/"));
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
}

/** Collect replies from the MCP server for a list of requests. */
function harness(root) {
	const sent = [];
	const out = { write: (s) => sent.push(JSON.parse(s)) };
	const handle = createServer({ root, stdout: out });
	let nextId = 1;
	return {
		sent,
		async request(method, params) {
			const id = nextId++;
			await handle(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
			return sent.find((m) => m.id === id) ?? null;
		},
		async notify(method, params) {
			await handle(JSON.stringify({ jsonrpc: "2.0", method, params }));
		},
	};
}

/** Pull the JSON payload out of a tool result's text content. */
function payload(reply) {
	assert.ok(reply, "expected a reply");
	assert.ok(reply.result, `expected result, got: ${JSON.stringify(reply)}`);
	const text = reply.result.content[0].text;
	return JSON.parse(text);
}

test("initialize reports server info and tool capability", async (t) => {
	const root = tmpRoot(t);
	const mcp = harness(root);
	const reply = await mcp.request("initialize", {});
	assert.equal(reply.result.serverInfo.name, "preimage");
	assert.ok(reply.result.capabilities.tools);
});

test("tools/list exposes the four tools", async (t) => {
	const root = tmpRoot(t);
	const mcp = harness(root);
	const { result } = await mcp.request("tools/list", {});
	const names = result.tools.map((tool) => tool.name).sort();
	assert.deepEqual(names, [
		"preimage_checkpoint",
		"preimage_diff",
		"preimage_list",
		"preimage_restore",
	]);
});

test("every tool declares an input schema and description", async (t) => {
	const root = tmpRoot(t);
	const mcp = harness(root);
	const { result } = await mcp.request("tools/list", {});
	for (const tool of result.tools) {
		assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
		assert.equal(tool.inputSchema.type, "object");
	}
});

test("checkpoint then diff reports file changes", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "before");

	const mcp = harness(root);
	const cp = payload(
		await mcp.request("tools/call", {
			name: "preimage_checkpoint",
			arguments: { label: "before edit" },
		}),
	);
	assert.equal(cp.ok, true);
	assert.equal(cp.files, 1);

	write(root, "a.txt", "after");
	write(root, "b.txt", "new");

	const diff = payload(
		await mcp.request("tools/call", {
			name: "preimage_diff",
			arguments: { checkpointId: cp.checkpointId },
		}),
	);
	assert.equal(diff.changed, 2);
	assert.deepEqual(diff.files.modified, ["a.txt"]);
	assert.deepEqual(diff.files.added, ["b.txt"]);
	assert.equal(diff.label, "before edit");
});

test("diff defaults to the most recent checkpoint", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "one");

	const mcp = harness(root);
	await mcp.request("tools/call", { name: "preimage_checkpoint", arguments: { label: "first" } });
	write(root, "a.txt", "two");
	await mcp.request("tools/call", { name: "preimage_checkpoint", arguments: { label: "second" } });
	write(root, "a.txt", "three");

	const diff = payload(await mcp.request("tools/call", { name: "preimage_diff", arguments: {} }));
	assert.equal(diff.label, "second");
	assert.deepEqual(diff.files.modified, ["a.txt"]);
});

test("list returns checkpoints with human-readable sizes", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "hello");

	const mcp = harness(root);
	await mcp.request("tools/call", { name: "preimage_checkpoint", arguments: { label: "x" } });

	const list = payload(await mcp.request("tools/call", { name: "preimage_list", arguments: {} }));
	assert.equal(list.checkpoints.length, 1);
	assert.equal(list.checkpoints[0].label, "x");
	assert.match(list.checkpoints[0].bytesHuman, /B$/);
	assert.ok(!Number.isNaN(Date.parse(list.checkpoints[0].takenAt)));
});

test("list tells the agent whether a checkpoint is safe to restore from", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "hello");

	const mcp = harness(root);
	const cp = payload(await mcp.request("tools/call", { name: "preimage_checkpoint", arguments: {} }));

	// A row that never finished being written, as a crash mid-checkpoint leaves.
	const { Journal } = await import(new URL("../src/journal.js", import.meta.url).href);
	const j = Journal.open(root);
	j.createCheckpoint({ root, label: "crashed mid-write" });
	j.close();

	const list = payload(await mcp.request("tools/call", { name: "preimage_list", arguments: {} }));
	const byId = Object.fromEntries(list.checkpoints.map((c) => [c.id, c]));
	assert.equal(byId[cp.checkpointId].restorable, true);
	// Without this the agent cannot tell "saved nothing" from "unusable", and
	// will happily restore from the latter and get `ok: true` for it.
	assert.equal(byId[cp.checkpointId + 1].restorable, false);
});

test("restore refuses an unfinished checkpoint instead of reporting a fake success", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "original");

	const mcp = harness(root);
	await mcp.request("tools/call", { name: "preimage_checkpoint", arguments: {} });

	const { Journal } = await import(new URL("../src/journal.js", import.meta.url).href);
	const j = Journal.open(root);
	const ghost = j.createCheckpoint({ root, label: "crashed mid-write" });
	j.close();
	write(root, "a.txt", "agent wrecked this");

	const reply = await mcp.request("tools/call", {
		name: "preimage_restore",
		arguments: { checkpointId: ghost, confirm: true },
	});
	assert.equal(reply.result.isError, true);
	assert.match(reply.result.content[0].text, /incomplete/);
	// The file the agent wrecked is untouched, and it is told why.
	assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "agent wrecked this");
});

test("diff refuses an unfinished checkpoint rather than reporting every file as added", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "original");

	const mcp = harness(root);
	await mcp.request("tools/call", { name: "preimage_checkpoint", arguments: {} });

	const { Journal } = await import(new URL("../src/journal.js", import.meta.url).href);
	const j = Journal.open(root);
	const ghost = j.createCheckpoint({ root, label: "crashed mid-write" });
	j.close();

	const reply = await mcp.request("tools/call", {
		name: "preimage_diff",
		arguments: { checkpointId: ghost },
	});
	assert.equal(reply.result.isError, true);
	assert.match(reply.result.content[0].text, /incomplete/);
});

test("diff defaults to the most recent finished checkpoint", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "one");

	const mcp = harness(root);
	const first = payload(
		await mcp.request("tools/call", { name: "preimage_checkpoint", arguments: { label: "first" } }),
	);
	const { Journal } = await import(new URL("../src/journal.js", import.meta.url).href);
	const j = Journal.open(root);
	j.createCheckpoint({ root, label: "later but unfinished" });
	j.close();
	write(root, "a.txt", "two");

	const diff = payload(await mcp.request("tools/call", { name: "preimage_diff", arguments: {} }));
	assert.equal(diff.checkpointId, first.checkpointId);
	assert.deepEqual(diff.files.modified, ["a.txt"]);
});

test("a checkpoint whose database capture fails still keeps its file snapshot", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "kept");

	const mcp = harness(root);
	const cp = payload(
		await mcp.request("tools/call", {
			name: "preimage_checkpoint",
			arguments: { databases: ["does-not-exist.db"] },
		}),
	);
	assert.equal(cp.ok, true);
	assert.equal(cp.files, 1, "the file snapshot survives an unreachable database");
	assert.equal(cp.databases[0].error !== undefined, true, "and the database failure is reported");
	const list = payload(await mcp.request("tools/call", { name: "preimage_list", arguments: {} }));
	assert.equal(list.checkpoints[0].restorable, true);
});

test("restore requires explicit confirmation", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "original");

	const mcp = harness(root);
	const cp = payload(await mcp.request("tools/call", { name: "preimage_checkpoint", arguments: {} }));
	write(root, "a.txt", "broken");

	// No confirm: must refuse and change nothing. Refusals come back as an
	// error result with a plain-text message, not a JSON payload.
	const refused = await mcp.request("tools/call", {
		name: "preimage_restore",
		arguments: { checkpointId: cp.checkpointId },
	});
	assert.equal(refused.result.isError, true);
	assert.match(refused.result.content[0].text, /confirm must be true/);
	assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "broken");

	// confirm: false is also refused.
	const refused2 = await mcp.request("tools/call", {
		name: "preimage_restore",
		arguments: { checkpointId: cp.checkpointId, confirm: false },
	});
	assert.equal(refused2.result.isError, true);
	assert.match(refused2.result.content[0].text, /confirm must be true/);
	assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "broken");
});

test("restore with confirm rewrites files", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "original");

	const mcp = harness(root);
	const cp = payload(await mcp.request("tools/call", { name: "preimage_checkpoint", arguments: {} }));
	write(root, "a.txt", "broken");

	const result = payload(
		await mcp.request("tools/call", {
			name: "preimage_restore",
			arguments: { checkpointId: cp.checkpointId, confirm: true },
		}),
	);
	assert.equal(result.ok, true);
	assert.deepEqual(result.files.written, ["a.txt"]);
	assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "original");
});

test("restore purge removes files created after the checkpoint", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "original");

	const mcp = harness(root);
	const cp = payload(await mcp.request("tools/call", { name: "preimage_checkpoint", arguments: {} }));
	write(root, "junk.txt", "junk");

	await mcp.request("tools/call", {
		name: "preimage_restore",
		arguments: { checkpointId: cp.checkpointId, confirm: true, purge: true },
	});
	assert.equal(fs.existsSync(path.join(root, "junk.txt")), false);
});

test("restore dryRun reports without writing", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "original");

	const mcp = harness(root);
	const cp = payload(await mcp.request("tools/call", { name: "preimage_checkpoint", arguments: {} }));
	write(root, "a.txt", "broken");

	const result = payload(
		await mcp.request("tools/call", {
			name: "preimage_restore",
			arguments: { checkpointId: cp.checkpointId, confirm: true, dryRun: true },
		}),
	);
	assert.equal(result.dryRun, true);
	assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "broken");
});

test("checkpoint with databases captures rows", async (t) => {
	const root = tmpRoot(t);
	const db = new DatabaseSync(path.join(root, "app.db"));
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)");
	db.prepare("INSERT INTO users VALUES (?, ?)").run(1, "a@x.com");
	db.prepare("INSERT INTO users VALUES (?, ?)").run(2, "b@x.com");
	db.close();

	const mcp = harness(root);
	const cp = payload(
		await mcp.request("tools/call", {
			name: "preimage_checkpoint",
			arguments: { label: "with db", databases: ["app.db"] },
		}),
	);
	assert.equal(cp.rows, 2);
	assert.equal(cp.databases[0].error, undefined);
});

test("restore repairs database rows", async (t) => {
	const root = tmpRoot(t);
	const db = new DatabaseSync(path.join(root, "app.db"));
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)");
	db.prepare("INSERT INTO users VALUES (?, ?)").run(1, "a@x.com");
	db.close();

	const mcp = harness(root);
	const cp = payload(
		await mcp.request("tools/call", {
			name: "preimage_checkpoint",
			arguments: { databases: ["app.db"] },
		}),
	);

	const w = new DatabaseSync(path.join(root, "app.db"));
	w.prepare("UPDATE users SET email = ? WHERE id = 1").run("hacked@evil.com");
	w.close();

	await mcp.request("tools/call", {
		name: "preimage_restore",
		arguments: { checkpointId: cp.checkpointId, confirm: true },
	});

	const r = new DatabaseSync(path.join(root, "app.db"), { readOnly: true });
	assert.equal(r.prepare("SELECT email FROM users WHERE id = 1").get().email, "a@x.com");
	r.close();
});

test("checkpoint surfaces a per-database error instead of failing", async (t) => {
	const root = tmpRoot(t);
	const mcp = harness(root);
	const cp = payload(
		await mcp.request("tools/call", {
			name: "preimage_checkpoint",
			arguments: { databases: ["missing.db"] },
		}),
	);
	assert.equal(cp.ok, true);
	assert.equal(cp.rows, 0);
	assert.match(cp.databases[0].error, /database not found/);
});

test("diff with a journal but no checkpoints reports the problem", async (t) => {
	const root = tmpRoot(t);
	// Create the journal without taking a checkpoint.
	Journal.open(root).close();

	const mcp = harness(root);
	const reply = await mcp.request("tools/call", {
		name: "preimage_diff",
		arguments: {},
	});
	assert.equal(reply.result.isError, true);
	assert.match(reply.result.content[0].text, /no checkpoints exist/);
});

test("diff before any journal points the agent at taking a checkpoint", async (t) => {
	const root = tmpRoot(t);
	const mcp = harness(root);
	const reply = await mcp.request("tools/call", {
		name: "preimage_diff",
		arguments: {},
	});
	assert.equal(reply.result.isError, true);
	assert.match(reply.result.content[0].text, /Take a checkpoint first/);
});

test("tools/call on an unknown tool returns an error result", async (t) => {
	const root = tmpRoot(t);
	const mcp = harness(root);
	const reply = await mcp.request("tools/call", { name: "nope", arguments: {} });
	assert.match(reply.result.content[0].text, /unknown tool/);
});

test("unknown JSON-RPC method returns a protocol error", async (t) => {
	const root = tmpRoot(t);
	const mcp = harness(root);
	const reply = await mcp.request("resources/list", {});
	assert.equal(reply.error.code, -32601);
});

test("ping is answered", async (t) => {
	const root = tmpRoot(t);
	const mcp = harness(root);
	const reply = await mcp.request("ping", {});
	assert.deepEqual(reply.result, {});
});

test("a final request without a trailing newline is still answered", async (t) => {
	const root = tmpRoot(t);
	const sent = [];
	const handle = createServer({ root, stdout: { write: (s) => sent.push(JSON.parse(s)) } });
	await handle('{"jsonrpc":"2.0","id":7,"method":"tools/list"}');
	assert.equal(sent.length, 1);
	assert.equal(sent[0].id, 7);
});

test("runStdio flushes a trailing request when stdin closes", async (t) => {
	const root = tmpRoot(t);
	write(root, "a.txt", "hello");

	const sent = [];
	// A Readable whose payload has no trailing newline.
	const input = Readable.from([
		'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
		'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"preimage_checkpoint","arguments":{}}}',
	]);
	await runStdio({ root, input, stdout: { write: (s) => sent.push(JSON.parse(s)) } });

	assert.equal(sent.length, 2);
	const cp = JSON.parse(sent[1].result.content[0].text);
	assert.equal(cp.ok, true);
	assert.equal(cp.files, 1);
});

test("malformed JSON line is ignored without crashing", async (t) => {
	const root = tmpRoot(t);
	const sent = [];
	const handle = createServer({ root, stdout: { write: (s) => sent.push(JSON.parse(s)) } });
	await handle("{not json");
	assert.equal(sent.length, 0);
});