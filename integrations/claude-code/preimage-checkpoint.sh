#!/usr/bin/env bash
# Claude Code PreToolUse hook: snapshot before a write.
#
# Snapshotting before every single Edit would be correct but wasteful, so this
# debounces: one checkpoint per SESSION_WINDOW (default 120s). The first write
# in a burst captures the pre-edit state, which is the state you actually want to
# return to. Subsequent writes within the window do nothing.
#
# Install:
#   preimage hook install-claude-code
#
# Or wire it manually in ~/.claude/settings.json:
#
#   {
#     "hooks": {
#       "PreToolUse": [{
#         "matcher": "Edit|Write|MultiEdit|NotebookEdit",
#         "hooks": [{ "type": "command",
#                     "command": "preimage-hook-checkpoint" }]
#       }]
#     }
#   }
#
# Reads the hook payload on stdin (Claude Code passes JSON) and uses the
# project dir from the payload, falling back to $CLAUDE_PROJECT_DIR and cwd.

set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
WINDOW="${PREIMAGE_SESSION_WINDOW:-120}"
STAMP="$ROOT/.preimage/.last-checkpoint"

# Read and discard stdin so Claude Code never blocks on a full pipe.
if [ ! -t 0 ]; then
	INPUT="$(cat 2>/dev/null || true)"
	PROJECT_DIR="$(printf '%s' "$INPUT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
	[ -n "${PROJECT_DIR:-}" ] && ROOT="$PROJECT_DIR"
fi

mkdir -p "$ROOT/.preimage"

# Debounce on wall-clock time.
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

# Never block the agent on a checkpoint failure.
exit 0