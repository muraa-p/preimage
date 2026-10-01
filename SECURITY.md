# Security Policy

## Scope

preimage writes to your filesystem and to your SQLite databases. It is a tool
that lives in an agent's hot path, so treat a bug in it as a data-loss bug.

What preimage does **not** do, by design:

- It has **zero runtime dependencies**. Nothing is fetched or executed at
  install time beyond the tarball itself. A supply-chain compromise of an
  upstream package cannot reach you through preimage.
- It makes **no network requests**. There is no telemetry, no update check, no
  crash reporting. The journal is a local SQLite file.
- It does **not** run any shell command, and it never executes the hooks it
  installs. `preimage hook install` copies two small bash scripts into
  `.claude/settings.json` or your OpenCode config.
- It **never writes outside the project root** during restore. Every restored
  path is resolved and checked against the root before a single byte is
  written.

## Reporting a vulnerability

Email **security@muraa-p.dev** or use GitHub's private vulnerability reporting
on the Security tab of the repository. Please include:

- what an attacker-controlled input looks like
- the exact command or MCP tool call that triggers it
- the resulting file or row change

Please do not open a public issue for an unfixed vulnerability.

You can expect an acknowledgement within 72 hours and a fix or a mitigation
plan within 14 days.

## What counts as a vulnerability

Especially interested:

- `preimage_restore` writing a file outside the project root (path traversal)
- a restore that corrupts a file it was asked to restore (non-atomic write)
- `preimage restore --purge` deleting something it was not asked to delete
- a captured database being restored into the wrong file
- a checkpoint silently recording less than it claims to record

## What does not count

- preimage is not a backup. The journal lives beside your project and is lost
  with it. This is documented.
- preimage does not merge. A restore is a snapshot, so it can revert changes
  made to files it captured, including ones you wanted to keep.
- Race conditions against another process writing the same files at the same
  moment. preimage is single-writer.
- The 10 MB per-file cap. Oversized files are recorded but not stored, and a
  restore skips them rather than blanking them.

## Hardening notes

If preimage handles sensitive data:

- The journal stores file contents as SQLite BLOBs in `.preimage/journal.db`.
  That file is as sensitive as the project it protects. It is gitignored by
  default; keep it that way.
- Journal files inherit your umask. On a shared machine, set permissions
  explicitly.
- SQLite sidecar files (`-wal`, `-shm`) sit next to your databases. They are
  treated as part of the database, never purged independently.