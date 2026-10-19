#!/usr/bin/env bash
set -euo pipefail

root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly root
# shellcheck source=lib/common.sh
source "$root/scripts/lib/common.sh"

[[ $# == 0 ]] || fail 64 'Usage: scripts/dev.sh (migration is separate: scripts/migrate.sh)'
((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1))) ||
  fail 69 'Bash 5.1 or newer is required'
require_backend "$root"
require_executable "$root/backend/.venv/bin/uvicorn"
require_file "$root/frontend/package.json"
require_file "$root/frontend/package-lock.json"
require_executable "$root/frontend/node_modules/.bin/vite"
for command in npm node setsid ss mktemp rm sleep; do
  require_command "$command"
done
npm --version >/dev/null 2>&1 || fail 69 'npm cannot run'
node --version >/dev/null 2>&1 || fail 69 'node cannot run'
node -e 'const p = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); process.exit(typeof p.scripts?.dev === "string" && p.scripts.dev.trim() ? 0 : 1)' \
  "$root/frontend/package.json" >/dev/null 2>&1 || fail 66 'frontend/package.json must define a dev script'
require_tmpdir
for port in 8000 5173; do
  listeners=$(ss -H -ltn "sport = :$port") || fail 69 'Cannot inspect TCP listeners with ss'
  [[ -z "$listeners" ]] || fail 75 "TCP port $port is occupied; no existing process was touched"
done

# No job control: each setsid child becomes the leader of its own process group.
set +m
umask 077
run_tmp=$(mktemp -d "${TMPDIR:-/tmp}/lexicona-dev.XXXXXXXX") || fail 73 'Cannot create private TMPDIR'
readonly run_tmp
export TMPDIR="$run_tmp"
children=()

cleanup() {
  local status=$? pid attempt active last_pid=${!:-}
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  # Also cover a signal between spawning a child and recording its PID.
  if [[ -n "$last_pid" && " ${children[*]} " != *" $last_pid "* ]]; then
    children+=("$last_pid")
  fi
  for pid in "${children[@]}"; do
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM -- "$pid" 2>/dev/null
  done
  for ((attempt = 0; attempt < 30; attempt++)); do
    active=0
    for pid in "${children[@]}"; do
      if kill -0 -- "-$pid" 2>/dev/null || kill -0 -- "$pid" 2>/dev/null; then
        active=1
      fi
    done
    [[ "$active" == 1 ]] || break
    sleep 0.1
  done
  for pid in "${children[@]}"; do
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL -- "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
  done
  rm -rf -- "$run_tmp"
  exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

(
  cd -- "$root/backend"
  exec setsid "$root/backend/.venv/bin/uvicorn" lexicona.app:create_app \
    --factory --host 127.0.0.1 --port 8000 --workers 1
) &
children+=("$!")
(
  cd -- "$root/frontend"
  exec setsid npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
) &
children+=("$!")
printf 'lexicona: processes launched on 127.0.0.1 (API :8000, UI :5173); readiness is not yet verified\n'

# Poll direct children, then wait for the exact exit status. Unlike wait -n,
# this also catches a process that has already exited before monitoring starts.
while :; do
  for pid in "${children[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      status=0
      wait "$pid" || status=$?
      printf 'lexicona: child %s exited with status %s; stopping the other child\n' "$pid" "$status" >&2
      [[ "$status" != 0 ]] || status=70
      exit "$status"
    fi
  done
  sleep 0.1
done
