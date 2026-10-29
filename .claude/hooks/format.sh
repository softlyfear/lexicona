#!/usr/bin/env bash
# PostToolUse hook: format the file Claude just edited. Never blocks the edit.
file=$(jq -r '.tool_input.file_path // empty')
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
[[ -n "$file" && -f "$file" ]] || exit 0

case "$file" in
  "$root"/backend/*.py)
    cd "$root/backend" && uv run -q ruff format -q "$file" && uv run -q ruff check -q --fix "$file"
    ;;
  "$root"/frontend/*.ts | "$root"/frontend/*.tsx | "$root"/frontend/*.css | "$root"/frontend/*.json)
    cd "$root/frontend" && npx --no-install prettier --write --log-level warn "$file"
    ;;
esac
exit 0
