# preimage

[![ci](https://github.com/muraa-p/preimage/actions/workflows/ci.yml/badge.svg)](https://github.com/muraa-p/preimage/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@muraa-p/preimage.svg)](https://www.npmjs.com/package/@muraa-p/preimage)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.5.0-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/npm/l/preimage.svg)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-91%20passing-brightgreen)](#development)

**The undo layer for AI agents.**

Your agent is one confident `rm -rf` away from deleting a table, rewriting a
config, or "helpfully" migrating a database. git can't save you: those changes
never entered a commit, and they often aren't files at all.

`preimage` writes a checkpoint before the work starts, then puts everything back
byte-for-byte — including database rows git has never heard of.

![preimage rolling back an agent's file edits](docs/demo-files.gif)

```
$ preimage checkpoint "before agent refactor"
checkpoint 0001 created
  2 files, 44 B

$ # the agent has its way with your files
$ preimage diff 1
diff against checkpoint 0001
  1 added
  1 modified
  1 deleted
  0 unchanged
    config.json
    src/server.js
    EMERGENCY.js

$ preimage restore 1 --purge
restored checkpoint 0001 (before agent refactor)
  2 files written
  0 already identical
  1 new files removed
```

Config is back. The deleted file is back. The 2am special is gone.

Now the part git can never do:

![preimage rolling back a destructive database migration](docs/demo-database.gif)

```
$ preimage checkpoint "before migration" --db app.db
checkpoint 0001 created
  1 files, 8.0 KB
  2 rows across 1 database(s)

$ # a migration drops a user, promotes another, invents a third
$ preimage diff 1
diff against checkpoint 0001
  0 added
  0 modified
  0 deleted
  0 unchanged
  rows: 1 missing, 1 changed, 1 extra

$ preimage restore 1 --remove-extra
restored checkpoint 0001 (before migration)
  0 files written
  0 already identical
  2 rows written
  1 rows removed

$ sqlite3 app.db "SELECT * FROM users"
[{"id":1,"email":"ada@org.org","role":"admin"},
 {"id":2,"email":"bob@org.org","role":"staff"}]
```

`ada` is an admin again. `bob` is back. The ghost row is gone. No commit, no
`git checkout`, no hand-written `UPDATE`.

And when the agent drops a whole table, the schema comes back with it:

```
$ preimage checkpoint "before the schema change" --db app.db
checkpoint 0001 created
  1 files, 12 KB
  2 rows across 1 database(s)

$ # the agent decides users is no longer needed
$ preimage diff 1
diff against checkpoint 0001
  0 added
  0 modified
  0 deleted
  0 unchanged
  rows: 1 missing, 0 changed, 0 extra
  table dropped: app.db:users

$ preimage restore 1 --yes
restored checkpoint 0001 (before the schema change)
  0 files written
  0 already identical
  1 tables recreated
  2 rows written

$ sqlite3 app.db ".tables"
invoices users
```

`DROP TABLE users` is undoable. preimage stored the `CREATE` statement next to
the rows, so recreating the table is part of the restore rather than a separate
recovery ritual.

Run the whole demo yourself:

```bash
git clone https://github.com/muraa-p/preimage && cd preimage
node scripts/demo.mjs
```

## Install

```bash
npm install -g @muraa-p/preimage
```

Zero dependencies. Node 22.5+ (it uses the built-in `node:sqlite`, so there is
no native build step and no supply chain to audit).

Then wire it to your agent — see [Agent integration](#agent-integration).

## Why this exists

The tooling around coding agents is very good at *watching* them. Session
logs, traces, prompt caches, token dashboards, eval harnesses — all of it
observes what the agent did. Almost nothing helps you *undo* it.

| | git | preimage |
|---|---|---|
| Untracked files | No | Yes |
| `.gitignore`d files | No | Yes |
| Database rows | No | Yes |
| Works outside a repo | No | Yes |
| Needs `git add` + commit discipline | Yes | No |
| Reverts agent-created junk | No | Yes, with `--purge` |

Preimage is not a backup tool and not a VCS. It is the write-ahead log for the
one window where a non-human is editing your machine.

## Usage

```bash
preimage init                          # create the journal
preimage checkpoint "before refactor"  # snapshot now
preimage list                          # see checkpoints
preimage diff                          # what changed since the latest
preimage diff 3                        # ...since a specific one
preimage restore 3                     # put it back
```

`diff` doesn't just name the files. It prints a real unified diff, byte for byte
what `git diff` would print, so you can read the damage instead of opening each
file to find it:

```
$ preimage diff
diff against checkpoint 0001
  1 added
  1 modified
  0 deleted
  2 unchanged
    app.js
    SCRATCH.js

--- a/app.js
+++ b/app.js
@@ -1,4 +1,8 @@
-export function greet(name) {
-  return `hello ${name}`;
+export function greet(name, greeting = 'hi') {
+  const msg = `${greeting} ${name}`;
+  console.log(msg);
+  return msg;
+}
+
+export function farewell(name) {
+  return 'bye';
 }
```

`--no-hunks` gives you just the file list. Binary files and files too large to
diff line-by-line are reported with the reason rather than skipped silently.

`diff` and `show` default to the most recent checkpoint. `restore` always wants
an explicit id, because guessing wrong there is expensive.

Every command takes `--json` for machine-readable output. `diff --json` puts the
patches in a `patches` array, each with `path`, `added`, `removed` and the
`diff -u` text.

### Options that matter

```
--root <dir>       Project root (default: cwd)
--db <path>        Capture a SQLite database too (repeatable)
--table <name>     Limit to specific tables (repeatable)
--max-bytes <n>    Skip files larger than this (default 10 MB)
--no-hunks         diff: file names only, no line-level patches
--dry-run          Report what restore would do, change nothing
--purge            Also delete files created after the checkpoint
--remove-extra     Also delete rows created after the checkpoint
--yes              Skip the confirmation prompt
```

## Agent integration

### MCP — this is the path, and it is agent-agnostic

`preimage mcp` speaks the Model Context Protocol over stdio, so it works with
**every** MCP client, not just Claude. That includes OpenAI Codex and ChatGPT,
Cursor, VS Code and Copilot, Windsurf, Gemini CLI, Zed, Cline, Roo Code, Kilo
Code, Amazon Q and Claude Desktop. If your agent speaks MCP, preimage plugs in.

Most clients take the same JSON:

```jsonc
{
  "mcpServers": {
    "preimage": { "command": "preimage", "args": ["mcp"] }
  }
}
```

Where each one wants it:

| Agent | How to add it |
| --- | --- |
| **Claude Code** | `claude mcp add preimage -- preimage mcp` |
| **OpenAI Codex** | `codex mcp add preimage -- preimage mcp`, or a `[mcp_servers.preimage]` table in `~/.codex/config.toml` |
| **Gemini CLI** | `gemini mcp add preimage preimage mcp`, or `mcpServers` in `~/.gemini/settings.json` |
| **Cursor** | `.cursor/mcp.json`, using the `mcpServers` key above |
| **VS Code / Copilot** | `.vscode/mcp.json` — the key is `servers`, not `mcpServers` |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |
| **Zed** | `.zed/settings.json`, under `context_servers` |
| **Claude Desktop** | `claude_desktop_config.json` |

Clients that launch the server in the wrong working directory will snapshot the
wrong tree, so pass the path explicitly if that happens:

```jsonc
"preimage": { "command": "preimage", "args": ["mcp", "--root", "/path/to/project"] }
```

Four tools:

- `preimage_checkpoint` — snapshot before risky work
- `preimage_diff` — what changed since a checkpoint, with a unified diff per file
- `preimage_restore` — roll back
- `preimage_list` — what's recoverable

`preimage_restore` **requires an explicit `confirm: true`**, and refuses
otherwise. An agent mid-task should not be able to undo your working state by
accident; it has to ask.

`preimage_diff` returns the patches, so the agent sees the lines it changed
rather than being told a file changed and having to go read it. The patch text is
capped at a budget; if a refactor exceeds it, the response says how many files
were left out rather than letting the agent conclude they were untouched. Pass
`includePatches: false` when you only want the file names.

### Hooks (automatic)

Snapshotting before every single edit is correct but wasteful, so the bundled
hooks debounce: one checkpoint per 120 seconds. The first write in a burst
captures the state you actually want to return to.

```bash
preimage hook install claude-code    # prints a settings.json fragment
preimage hook install opencode       # prints a plugin command
```

Merge the printed fragment into `~/.claude/settings.json`. The hook never fails
your session — if the checkpoint can't be taken, the edit proceeds anyway.

Set `PREIMAGE_SESSION_WINDOW=0` to snapshot on literally every write.

This is the one part that is **not** agent-agnostic: hooks are wired for Claude
Code and OpenCode only. Every other agent is covered by MCP above — the
difference is that a hook snapshots *without the model asking*, so on the other
agents you either rely on the model calling `preimage_checkpoint` or wrap your
own command chain.

## Safety design

This tool deletes things, so the defaults are conservative.

- **Nothing destructive without a flag.** `restore` only rewrites files it
  recorded. Deleting agent-created files requires `--purge`; deleting
  agent-created rows requires `--remove-extra`.
- **Confirmation before you lose data.** Interactive restores prompt first.
  Agent restores need `confirm: true`.
- **Big files are skipped, never blanked.** Files over `--max-bytes` are
  recorded as existing but their content is not stored. On restore preimage
  leaves them completely alone rather than overwriting them with nothing.
- **Writes are atomic.** Every restore goes through a temp file and a rename,
  so a crash mid-restore cannot leave a half-written file.
- **A checkpoint is all-or-nothing.** The row, the file entries and the database
  rows are written in one transaction. A checkpoint that dies partway through
  leaves nothing behind rather than an empty row that looks restorable. Anything
  unfinished is refused outright, because a restore that reports success without
  restoring anything is the one failure this tool cannot have.
- **Parallel agents do not collide.** Several `preimage checkpoint` processes can
  run at once; they queue on the journal rather than failing on a lock.
- **Path traversal is blocked.** A tampered journal record cannot write outside
  the project root.
- **Table scope is explicit.** preimage never snapshots an entire database
  silently. You name the tables, or you opt in per database. And a database you
  captured with `--db` is restored table by table, never as a file — that's the
  only way `--table users` can leave `audit_log` alone.
- **A dropped table comes back.** The `CREATE` statement is stored alongside the
  rows, so `DROP TABLE users` is undoable, schema included.

## How it works

A checkpoint is a content-addressed snapshot in a SQLite journal at
`<root>/.preimage/journal.db`.

```
checkpoints   id, created_at, label, source, status
files         checkpoint_id, path, kind, mode, size, sha
blobs         sha, bytes            -- deduplicated by content hash
db_tables     checkpoint_id, db_path, table_name, ddl
db_rows       checkpoint_id, db_path, table_name, pk, row_json
```

Blobs are keyed by sha256, so a file that appears in twenty checkpoints is
stored once. Restore looks up the blob and writes it back; identical files are
skipped, which makes restore idempotent and fast. `preimage gc` drops blobs no
longer referenced.

Database rows are stored as JSON keyed by primary key (falling back to `rowid`),
with BigInt and BLOB columns tagged so they round-trip exactly. Each table's
`CREATE` statement is stored too, which is what lets restore rebuild a table the
agent dropped. Restores run inside a transaction per table.

A database captured with `--db` is handed to the table adapter and removed from
the file layer's work list. Without that, restoring `--table users` would
rewrite the whole `.db` file and silently revert every table you never asked
about.

Add `.preimage/` to `.gitignore`.

## Limitations

Worth knowing before you rely on it:

- **SQLite only** for database capture. Postgres and MySQL adapters are the
  obvious next step; the `dbadapter.js` interface is small.
- **Not a backup.** The journal lives next to your project. It protects you
  from the agent's mistakes, not from your disk failing.
- **Restore is a snapshot, not a merge.** You get the state at the checkpoint,
  not a three-way diff. If you changed something by hand after the checkpoint
  and want to keep it, restoring loses it.
- **First 10 MB per file.** Larger files are tracked but not restorable.
- **Single-writer.** The journal is not designed for concurrent restores from
  several processes at once.

## Development

```bash
npm test          # 132 tests, node:test
npm run check     # syntax check every entrypoint
node scripts/demo.mjs             # all three stories, instant
node scripts/demo.mjs --story=1   # just one story
```

CI runs the suite on Linux, macOS and Windows across Node 22 and 24, and
additionally installs the packed tarball into a clean project to check that the
real binary works from a real install.

### Re-recording the demos

The GIFs in this README come from [`tape/`](./tape), recorded with
[vhs](https://github.com/charmbracelet/vhs). Needs `vhs`, `ffmpeg` and `ttyd` on
`PATH`.

```bash
vhs tape/files.tape        # -> docs/demo-files.gif
vhs tape/database.tape     # -> docs/demo-database.gif
```

Both record `scripts/demo.mjs` with `--paced`, so the text in the GIFs is
generated by the same code path quoted above. If you change the demo, re-record
and update the transcripts here in the same commit.

## Contributing

Issues and PRs welcome. Keep it dependency-free — that constraint is the whole
security argument for a tool that sits in the agent's hot path. Destructive
behaviour stays behind a flag, and every bug fix ships with the test that fails
without it.

See [CONTRIBUTING.md](CONTRIBUTING.md). Vulnerabilities go to
[SECURITY.md](SECURITY.md), not the issue tracker.

## License

MIT