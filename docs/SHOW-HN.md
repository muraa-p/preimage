# Draft: Show HN post for preimage

Everything below is verified — real command output, real numbers. Post it yourself
(HN does not allow self-promotion via a proxy, and posting as the author is
what the rules expect).

**Title options** — pick one:

- `preimage: a write-ahead journal for AI agents, so a bad edit is a rollback instead of an apology`
- `Show HN: I built the undo layer for coding agents (zero deps, works via MCP)`
- `preimage – snapshot what your agent is about to change, diff it like git, roll it back`

**Flag:** show-hn

---

**Body:**

I got tired of `git diff` being my undo button for agent damage, so I built the
thing that should exist underneath it: a write-ahead journal for the window where
a non-human is editing your machine.

```bash
npm install -g @muraa-p/preimage
```

Zero dependencies, MIT, Node 22.5+.

## The problem

An agent changes four files at once and one of them is wrong. You need to know
what it touched before you decide what to keep. `git status` only helps if
everything was committed, and `git diff` shows you the damage but not the state to
return to.

So: snapshot before risky work, diff after, roll back if it's wrong.

## What it does

```bash
preimage checkpoint "before the schema migration"   # 5 files, 949 B
# ...the agent does its thing...
preimage diff
preimage restore 1 --purge
```

`checkpoint` is content-addressed, so unchanged files are stored once no matter
how many checkpoints you take. It also captures specific SQLite *tables*, not
database files, so `--table users` can never silently revert `audit_log`.

## The part I'm most pleased with

`preimage diff` prints a real unified diff — byte-for-byte what `git diff`
prints, including the section heading and the `\ No newline at end of file`
marker. Not an approximation; it's hand-rolled Myers, and there's a test that
compares it against actual `git diff` output across 23 fixtures.

```
$ preimage diff
diff against checkpoint 0001
  1 added
  2 modified
  0 deleted
  3 unchanged
    config.js
    server.js
    DEBUG.md

--- a/config.js
+++ b/config.js
@@ -1,5 +1,5 @@
 export const config = {
 	name: "hello-service",
-	port: 3000,
-	greeting: "Hello",
+	port: Number(process.env.PORT) || 8080,
+	greeting: "Hi",
 };
```

## It hooks into whatever agent you use

`preimage mcp` is an MCP server, so it works with anything that speaks MCP —
Claude Code, OpenAI Codex, Cursor, VS Code, Windsurf, Gemini CLI, Zed, and so
on. Four tools: `checkpoint`, `diff`, `restore`, `list`.

The agent gets the diff too, so it can see the lines it changed instead of being
told a file changed and having to go read it:

```json
{ "mcpServers": { "preimage": { "command": "preimage", "args": ["mcp"] } } }
```

`preimage_restore` requires an explicit `confirm: true` and refuses otherwise.
An agent mid-task shouldn't be able to undo your working state by accident; it
has to ask you first.

## Safety defaults, because this deletes things

- Deleting agent-created files needs `--purge`. Deleting agent-created rows needs
  `--remove-extra`. Neither is on by default.
- Files over 10 MB are recorded but not stored, and on restore are **left alone**
  rather than overwritten with nothing.
- A `DROP TABLE` is undoable — the `CREATE` statement is stored with the rows.
- A checkpoint that didn't finish being written is **refused**, not restored
  from. A restore that reports success while changing nothing is the one failure
  a tool like this cannot have.
- Table scope is explicit. A database captured with `--db` is restored table by
  table, never as a file.

## Why SQLite, and why hand-rolled

`node:sqlite` is built in from Node 22.5, so there's no native build step and no
dependency to audit in something that sits in the agent's hot path. The MCP
server is plain JSON-RPC over stdio rather than the SDK, for the same reason.

The tradeoff is that I own the concurrency. WAL plus `BEGIN IMMEDIATE` and a busy
timeout; checkpoints are a single transaction that rolls back rather than
leaving a half-written row. That last one was a real bug — a checkpoint that died
partway through left a row that *looked* restorable, and `restore` printed
"restored" with exit 0 having changed nothing. Caught by an adversarial test
pass, not by a user report. I'd rather it be found that way.

132 tests, CI on Linux/macOS/Windows across Node 22 and 24.

## Honest limitations

- **Files only, plus SQLite tables.** No Postgres, no MySQL. The adapter is
  `src/dbadapter.js` if you want to add one.
- **Not a backup tool and not a VCS.** It's the write-ahead log for one window.
  The journal is a SQLite file; back it up if the machine matters.
- **Hooks are Claude Code and OpenCode only.** Every other agent is covered by
  MCP. The difference is that a hook snapshots *without the model asking*.
- **The bundled hook scripts are bash**, so on Windows they need WSL or Git Bash.
  MCP has no such requirement.
- **Whole-file snapshots, not delta-encoded.** Fine for a session's worth of
  checkpoints; not for archiving a repository.

GitHub: https://github.com/muraa-p/preimage

Happy to answer questions about the design, especially the diff format matching
git byte-for-byte — that took more iteration than it should have and I have
opinions.

---

## Where to post it

- **news.ycombinator.com** with `show-hn` — primary target. Best odds of real
  discussion. Post weekday 08:00–10:00 US Eastern.
- **r/ClaudeAI** and **r/LocalLLaMA** — reword the lead for each. The Claude one
  cares about hooks, the LocalLLaMA one about agent tooling generally.
- **r/programming** — a version without the agent framing, leading with the
  git-identical diff. Their rule is no marketing; lead with the engineering.
- **Hacker News comment on any existing "AI broke my code" thread** — this is
  exactly the pain, and being useful there converts far better than a launch post.

## Before you post

- Confirm the README's demo GIFs still match current output — they were recorded
  before the diff feature landed, so the transcripts in the README may be stale.
- Have one real bug report or a user's "this saved me" ready if the first comment
  asks. Either is worth more than another feature at this point.
