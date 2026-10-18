#!/usr/bin/env bash
# Shared environment checks/normalization; sourcing leaves options unchanged.

fail() {
  local status="$1"
  shift
  printf 'lexicona: %s\n' "$*" >&2
  exit "$status"
}

require_file() {
  [[ -f "$1" && -r "$1" ]] || fail 66 "Missing readable file: $1"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail 69 "Missing required command: $1"
}

require_executable() {
  [[ -f "$1" && -x "$1" ]] || fail 66 "Missing executable: $1"
}

# Contract: require_backend PROJECT_ROOT; never read a caller's global root.
require_backend() {
  local backend_root="${1:?require_backend requires a project root}"
  require_file "$backend_root/backend/pyproject.toml"
  require_file "$backend_root/backend/uv.lock"
  require_file "$backend_root/backend/alembic.ini"
  require_file "$backend_root/backend/.venv/pyvenv.cfg"
  require_executable "$backend_root/backend/.venv/bin/python"
  require_command uv
  uv --version >/dev/null 2>&1 || fail 69 'uv cannot run'
  "$backend_root/backend/.venv/bin/python" -c 'import sys; raise SystemExit(sys.prefix == sys.base_prefix)' \
    >/dev/null 2>&1 || fail 66 'backend/.venv must be a working virtual environment'
}

require_tmpdir() {
  [[ -d "${TMPDIR:-/tmp}" && -w "${TMPDIR:-/tmp}" && -x "${TMPDIR:-/tmp}" ]] ||
    fail 73 'TMPDIR must name an existing writable, searchable directory'
  # Resolve in the caller's cwd before either launcher changes directory.
  TMPDIR=$(CDPATH='' cd -- "${TMPDIR:-/tmp}" && pwd -P) || fail 73 'Cannot resolve TMPDIR'
  export TMPDIR
}
