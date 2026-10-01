#!/usr/bin/env bash
# OpenCode / Codex CLI / any tool with a shell hook: snapshot before a write.
#
# Same debounce logic as the Claude Code hook, but without depending on the
# hook payload format. Wire it to whatever your harness calls before a mutating
# command.
#
#   preimage hook install-opencode
#
# Manual wiring for an OpenCode plugin or a git pre-commit-style wrapper:
#
#   preimage-hook-checkpoint /path/to/project
#   your-dangerous-command
#   preimage restore "$(cat .preimage/.last-result.json | jq -r .id)" --purge

set -uo pipefail

ROOT="${1:-${PREIMAGE_ROOT:-$PWD}}"
WINDOW="${PREIMAGE_SESSION_WINDOW:-120}"
STAMP="$ROOT/.preimage/.last-checkpoint"

mkdir -p "$ROOT/.preimage"

NOW=$(date +%s)
if [ -f "$STAMP" ]; then
	LAST=$(cat "$STAMP" 2>/dev/null || echo 0)
	if [ "$((NOW - LAST))" -lt "$WINDOW" ]; then
		exit 0
	fi
fi

if preimage checkpoint "auto: agent edit" --root "$ROOT" --json >"$ROOT/.preimage/.last-result.json" 2>/dev/null; then
	echo "$NOW" >"$STAMP"
	exit 0
fi

exit 0