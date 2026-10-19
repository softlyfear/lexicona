#!/usr/bin/env bash
# Explicit, foreground-only migration. No implicit migration on app startup.
set -euo pipefail

root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly root
# shellcheck source=lib/common.sh
source "$root/scripts/lib/common.sh"

[[ $# == 0 ]] || fail 64 'Usage: scripts/migrate.sh (upgrades the configured development database to head)'
require_backend "$root"
require_executable "$root/backend/.venv/bin/alembic"
require_tmpdir
cd -- "$root/backend"
exec "$root/backend/.venv/bin/alembic" upgrade head
