#!/usr/bin/env bash
# Synthetic process fixtures only; these do not exercise the application.
set -euo pipefail

source_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly source_root
sandbox="$(mktemp -d "${TMPDIR:-/tmp}/lexicona-shell-tests.XXXXXXXX")"
readonly sandbox
trap 'rm -rf -- "$sandbox"' EXIT
mkdir -p "$sandbox/project/scripts" "$sandbox/tmp"
for script in dev.sh migrate.sh; do
  if [[ -f "$source_root/scripts/$script" ]]; then
    cp -- "$source_root/scripts/$script" "$sandbox/project/scripts/"
  fi
done
if [[ -d "$source_root/scripts/lib" ]]; then
  cp -R -- "$source_root/scripts/lib" "$sandbox/project/scripts/"
fi

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

expect_exit() {
  local expected="$1" actual=0
  shift
  "$@" >"$sandbox/output" 2>&1 || actual=$?
  [[ "$actual" == "$expected" ]] || {
    printf 'Expected exit %s, got %s\n' "$expected" "$actual" >&2
    cat -- "$sandbox/output" >&2
    fail "$*"
  }
  printf 'PASS: exit %s: %s\n' "$actual" "$*"
}

expect_exit 66 bash "$sandbox/project/scripts/dev.sh"
[[ $(<"$sandbox/output") == *'backend/pyproject.toml'* ]] || fail 'missing path diagnostic'

mkdir -p "$sandbox/project/backend/.venv/bin" "$sandbox/project/frontend/node_modules/.bin" \
  "$sandbox/bin" "$sandbox/state" "$sandbox/no-uv"
cp -- "$source_root/scripts/tests/fixtures/tool.sh" "$sandbox/tool"
chmod +x "$sandbox/tool"
for tool in uv npm ss; do
  ln -s -- "$sandbox/tool" "$sandbox/bin/$tool"
done
for tool in python alembic uvicorn; do
  ln -s -- "$sandbox/tool" "$sandbox/project/backend/.venv/bin/$tool"
done
ln -s -- "$sandbox/tool" "$sandbox/state/descendant"
for file in pyproject.toml uv.lock alembic.ini .venv/pyvenv.cfg; do
  touch -- "$sandbox/project/backend/$file"
done
printf '%s\n' '{"scripts":{"dev":"vite"}}' >"$sandbox/project/frontend/package.json"
touch -- "$sandbox/project/frontend/package-lock.json" "$sandbox/project/frontend/node_modules/.bin/vite"
chmod +x "$sandbox/project/frontend/node_modules/.bin/vite"
export FIXTURE_STATE="$sandbox/state" TMPDIR="$sandbox/tmp"
export PATH="$sandbox/bin:$PATH"
for tool in bash dirname node npm setsid ss mktemp rm sleep; do
  ln -s -- "$(command -v "$tool")" "$sandbox/no-uv/$tool"
done
# The library takes an explicit project root; no caller global is required.
expect_exit 0 bash -euo pipefail -c \
  "unset root; source \"\$1/scripts/lib/common.sh\"; require_backend \"\$1\"" \
  bash "$sandbox/project"
expect_exit 69 env PATH="$sandbox/no-uv" bash "$sandbox/project/scripts/dev.sh"
[[ $(<"$sandbox/output") == *'uv'* ]] || fail 'missing uv diagnostic'
[[ ! -e "$sandbox/state/backend.pid" ]] || fail 'preflight spawned backend'
expect_exit 66 env FIXTURE_VENV_STATUS=1 bash "$sandbox/project/scripts/dev.sh"
expect_exit 64 bash "$sandbox/project/scripts/dev.sh" unexpected
expect_exit 73 env TMPDIR="$sandbox/missing" bash "$sandbox/project/scripts/dev.sh"
expect_exit 75 env FIXTURE_COLLISION=8000 bash "$sandbox/project/scripts/dev.sh"
expect_exit 75 env FIXTURE_COLLISION=5173 bash "$sandbox/project/scripts/dev.sh"
expect_exit 69 env FIXTURE_SS_FAILURE=1 bash "$sandbox/project/scripts/dev.sh"
[[ ! -e "$sandbox/state/backend.pid" ]] || fail 'failed preflight spawned backend'

assert_stopped() {
  local file pid state
  for file in "$sandbox/state/"*.pid; do
    [[ -f "$file" ]] || continue
    pid=$(<"$file")
    state=$(ps -o stat= -p "$pid") || continue
    [[ "$state" == Z* ]] || fail "fixture process $pid survived ($state)"
  done
  local -a leftovers=("$sandbox/tmp/"*)
  [[ ! -e "${leftovers[0]}" ]] || fail 'launcher temporary directory leaked'
}

supervisor=''
unrelated_pid=''
cleanup_fixtures() {
  local status=$? file pid
  trap - EXIT
  trap '' HUP INT TERM
  if [[ -n "$supervisor" ]]; then
    kill -TERM "$supervisor" 2>/dev/null || true
    wait "$supervisor" 2>/dev/null || true
  fi
  for file in "$sandbox/state/"*.pid; do
    [[ -f "$file" ]] || continue
    pid=$(<"$file")
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  done
  if [[ -n "$unrelated_pid" ]]; then
    kill "$unrelated_pid" 2>/dev/null || true
    wait "$unrelated_pid" 2>/dev/null || true
  fi
  rm -rf -- "$sandbox"
  exit "$status"
}
trap cleanup_fixtures EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
sleep 120 &
unrelated_pid=$!
# Relative invocation must ignore CDPATH for discovery, not erase it for tools.
bootstrap_project="$sandbox/project with spaces"
shadow="$sandbox/shadow with spaces"
cp -R -- "$sandbox/project" "$bootstrap_project"
mkdir -p "$shadow/scripts/tests"
for cdpath in . "$shadow:."; do
  (
    cd -- "$bootstrap_project"
    export CDPATH="$cdpath"
    expect_exit 64 bash scripts/dev.sh unexpected
    expect_exit 64 bash scripts/migrate.sh unexpected
    expect_exit 37 timeout 10 env FIXTURE_BACKEND_EXIT=37 bash scripts/dev.sh
    for role in backend frontend; do
      [[ $(<"$sandbox/state/$role.cwd") == "$bootstrap_project/$role" ]] || fail "$role root redirected by CDPATH"
      [[ $(<"$sandbox/state/$role.cdpath") == "$cdpath" ]] || fail "$role inherited CDPATH changed"
    done
    assert_stopped
    expect_exit 41 env FIXTURE_MIGRATE_EXIT=41 bash scripts/migrate.sh
    [[ $(<"$sandbox/state/migration.cwd") == "$bootstrap_project/backend" ]] || fail 'migration root redirected by CDPATH'
    [[ $(<"$sandbox/state/migration.cdpath") == "$cdpath" ]] || fail 'migration inherited CDPATH changed'
    [[ "$CDPATH" == "$cdpath" ]] || fail 'caller CDPATH changed'
    kill -0 "$unrelated_pid" || fail 'unrelated process was killed'
    printf 'PASS: relative launchers from path with spaces; CDPATH=%s preserved, shadow ignored\n' "$cdpath"
  )
done
# Explicit worker argv must win without deleting the caller's environment.
expect_exit 37 timeout 10 env WEB_CONCURRENCY=4 UVICORN_WORKERS=3 \
  FIXTURE_BACKEND_EXIT=37 bash "$sandbox/project/scripts/dev.sh"
for role in backend frontend; do
  [[ $(<"$sandbox/state/$role.workers-env") == $'4\n3' ]] || fail "$role inherited worker environment"
done
assert_stopped
printf 'PASS: explicit single worker with inherited WEB_CONCURRENCY=4 and UVICORN_WORKERS=3\n'
expect_exit 37 timeout 10 env FIXTURE_BACKEND_EXIT=37 bash "$sandbox/project/scripts/dev.sh"
[[ $(<"$sandbox/state/backend.cwd") == "$sandbox/project/backend" ]] || fail 'backend cwd'
[[ $(<"$sandbox/state/frontend.cwd") == "$sandbox/project/frontend" ]] || fail 'frontend cwd'
[[ $(<"$sandbox/state/backend.tmp") == "$sandbox/tmp/lexicona-dev."* ]] || fail 'private TMPDIR'
assert_stopped
kill -0 "$unrelated_pid" || fail 'unrelated process was killed'

# Relative TMPDIR is relative to the caller, not either service's cwd.
relative_tmp='relative temp with spaces'
mkdir -p "$sandbox/$relative_tmp/lexicona-dev.not-owned"
printf '%s\n' keep >"$sandbox/$relative_tmp/lexicona-dev.not-owned/keep"
for attempt in 1 2; do
  rm -f -- "$sandbox/state/"*.tmp-resolved
  (
    cd -- "$sandbox"
    expect_exit 37 timeout 10 env TMPDIR="$relative_tmp" FIXTURE_BACKEND_EXIT=37 \
      bash "$sandbox/project/scripts/dev.sh"
  )
  for role in backend frontend; do
    child_tmp=$(<"$sandbox/state/$role.tmp")
    [[ $(<"$sandbox/state/$role.cwd") == "$sandbox/project/$role" ]] || fail "$role cwd with relative TMPDIR"
    [[ $(<"$sandbox/state/$role.tmp-resolved") == "$child_tmp" ]] || fail "$role cannot access TMPDIR from child cwd"
    [[ "$child_tmp" == "$sandbox/$relative_tmp/lexicona-dev."* ]] || fail "$role TMPDIR is not absolute/private"
    [[ ! -e "$child_tmp" ]] || fail "$role private TMPDIR leaked"
  done
  [[ $(<"$sandbox/state/backend.tmp") == "$(<"$sandbox/state/frontend.tmp")" ]] || fail 'children have different TMPDIRs'
  leftovers=("$sandbox/$relative_tmp/"*)
  [[ ${#leftovers[@]} == 1 && "${leftovers[0]}" == "$sandbox/$relative_tmp/lexicona-dev.not-owned" ]] || fail 'cleanup touched unowned directory or leaked private directory'
  [[ $(<"$sandbox/$relative_tmp/lexicona-dev.not-owned/keep") == keep ]] || fail 'cleanup touched unowned file'
  [[ "$TMPDIR" == "$sandbox/tmp" ]] || fail 'launcher changed caller TMPDIR'
  assert_stopped
  kill -0 "$unrelated_pid" || fail 'unrelated process was killed'
  printf 'PASS: relative TMPDIR with spaces accessible from both child cwds; own-only cleanup (run %s)\n' "$attempt"
done

expect_exit 23 timeout 10 env FIXTURE_FRONTEND_EXIT=23 bash "$sandbox/project/scripts/dev.sh"
assert_stopped
expect_exit 70 timeout 10 env FIXTURE_BACKEND_EXIT=0 bash "$sandbox/project/scripts/dev.sh"
assert_stopped

signal_case() {
  local signal="$1" expected="$2" stubborn="${3:-0}" attempt actual=0
  rm -f -- "$sandbox/state/"*.pid
  env --default-signal=INT --default-signal=TERM FIXTURE_STUBBORN="$stubborn" \
    setsid bash "$sandbox/project/scripts/dev.sh" >"$sandbox/output" 2>&1 &
  supervisor=$!
  for ((attempt = 0; attempt < 100; attempt++)); do
    [[ -s "$sandbox/state/descendant.pid" && -s "$sandbox/state/backend.pid" ]] && break
    sleep 0.03
  done
  [[ -s "$sandbox/state/descendant.pid" && -s "$sandbox/state/backend.pid" ]] || fail 'startup timed out'
  kill -"$signal" "$supervisor"
  for ((attempt = 0; attempt < 120; attempt++)); do
    kill -0 "$supervisor" 2>/dev/null || break
    sleep 0.05
  done
  kill -0 "$supervisor" 2>/dev/null && fail 'signal cleanup timed out'
  wait "$supervisor" || actual=$?
  supervisor=''
  [[ "$actual" == "$expected" ]] || fail "signal $signal: expected $expected, got $actual"
  assert_stopped
  kill -0 "$unrelated_pid" || fail 'unrelated process was killed'
  printf 'PASS: signal %s => %s (stubborn=%s), descendants stopped\n' "$signal" "$actual" "$stubborn"
}

signal_case TERM 143
signal_case INT 130
signal_case HUP 129
signal_case TERM 143 1

expect_exit 0 bash "$sandbox/project/scripts/migrate.sh"
[[ $(<"$sandbox/state/migration.cwd") == "$sandbox/project/backend" ]] || fail 'migration cwd'
expect_exit 41 env FIXTURE_MIGRATE_EXIT=41 bash "$sandbox/project/scripts/migrate.sh"
expect_exit 64 bash "$sandbox/project/scripts/migrate.sh" unexpected
mv -- "$sandbox/project/backend/.venv/bin/alembic" "$sandbox/alembic"
expect_exit 66 bash "$sandbox/project/scripts/migrate.sh"
printf 'PASS: synthetic launcher suite; no application runtime was exercised\n'
