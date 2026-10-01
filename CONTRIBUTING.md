# Contributing

Contributions are welcome. This project is small on purpose, so a small
focused change beats a large speculative one.

## Getting set up

preimage has zero runtime dependencies and requires Node 22.5 or newer for
`node:sqlite`.

```sh
git clone https://github.com/muraa-p/preimage
cd preimage
npm install
npm test
```

There is nothing to install to run the test suite. That is the point of having
no dependencies.

## Before you open a pull request

```sh
npm run check   # syntax check every source file
npm test        # 91 tests
```

Both must pass. CI additionally runs them on Linux, macOS and Windows across
Node 22 and 24.

## Ground rules for changes

**Stay dependency-free.** preimage ships zero runtime dependencies because it
runs inside an agent's hot path, where a supply-chain compromise is a
supply-chain compromise. A PR that adds a dependency needs to argue why the
built-in Node API is not enough.

**Destructive behaviour stays opt-in.** Deleting files (`--purge`), deleting rows
(`--remove-extra`) and rolling back via MCP (`confirm: true`) are all behind an
explicit flag. Do not make any of them default.

**Fail loudly, never silently.** If a capture skipped a table, say which one. If
a restore could not write a file, report it in `errors` rather than continuing.
The most valuable thing this tool does is tell the truth about the state of
someone's project.

**Every bug fix gets a test that fails without it.** The bug where
`restore --table users` silently reverted every other table in the database is
the reason the file layer now refuses to touch a database the table adapter
owns. That test is the reason it stays fixed.

## Style

- Tabs for indentation, double quotes, semicolons. Match the file you are in.
- Comments explain *why*. The code already says what.
- Keep public functions small enough that their failure modes are readable.

## Releasing

Releases publish to npm from GitHub Actions with **Trusted Publishing**, so
there is no long-lived token in the repository.

The workflow picks its credential at run time: if an `NPM_TOKEN` secret exists it
uses that, otherwise it publishes via Trusted Publishing. That is deliberate, so
the one-time npm setup below does not have to happen before anything can be
published. Once Trusted Publishing is configured, delete the `NPM_TOKEN` secret
and the workflow will keep working with no credential in the repo at all.

Setting up the npm side, once, by hand:

1. npm → `@muraa-p/preimage` → **Settings** → **Trusted Publisher** → **Add
   GitHub Actions**
2. Fill in:
   - **Organization / user**: `muraa-p`
   - **Repository**: `preimage`
   - **Workflow filename**: `release.yml`
3. Bump `version` in `package.json`, commit, then tag and push:

```sh
npm version patch --no-git-tag-version
git commit -am "Release v0.1.1"
git tag -a v0.1.1 -m "Release v0.1.1"
git push origin main --follow-tags
```

The workflow refuses to publish if the tag does not match `package.json`, or if
that version already exists on npm.

If a publish fails with `404 Not Found - PUT .../@muraa-p/preimage`, that is
Trusted Publishing not being configured on the npm side yet, not a missing
package. Either finish the setup above, or add an `NPM_TOKEN` secret with Read
and Write access plus **Bypass 2FA**, and re-run the failed job.

## Reporting bugs

Open an issue with:

- the exact command or MCP tool call
- what you expected and what happened
- Node version and operating system

If the bug involved data loss or an out-of-root write, follow
[SECURITY.md](SECURITY.md) instead.

## Good first contributions

- Postgres or MySQL support in `src/dbadapter.js`. The adapter is one file and
  SQLite is the only backend today.
- A `preimage watch` command that keeps a rolling window of checkpoints instead
  of relying on editor hooks.
- Better `diff` output for large trees (grouping, colour, a `--summary` mode).