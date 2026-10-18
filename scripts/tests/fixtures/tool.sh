#!/usr/bin/env bash
# Intentionally synthetic executables for launcher contract tests.
set -euo pipefail

case "${0##*/}" in
  uv)
    [[ "$*" == '--version' ]] || exit 95
    exit 0
    ;;
  python)
    [[ "$*" == '-c import sys; raise SystemExit(sys.prefix == sys.base_prefix)' ]] || exit 95
    exit "${FIXTURE_VENV_STATUS:-0}"
    ;;
  ss)
    [[ "${FIXTURE_SS_FAILURE:-0}" == 0 ]] || exit 1
    if [[ -n "${FIXTURE_COLLISION:-}" && "$*" == *":${FIXTURE_COLLISION}"* ]]; then
      printf 'LISTEN 0 128 127.0.0.1:%s 0.0.0.0:*\n' "$FIXTURE_COLLISION"
    fi
    exit 0
    ;;
  alembic)
    [[ "$*" == 'upgrade head' ]] || exit 95
    printf '%s\n' "$PWD" >"$FIXTURE_STATE/migration.cwd"
    exit "${FIXTURE_MIGRATE_EXIT:-0}"
    ;;
  npm)
    if [[ "$*" == '--version' ]]; then
      exit 0
    fi
    [[ "$*" == 'run dev -- --host 127.0.0.1 --port 5173 --strictPort' ]] || exit 95
    role=frontend
    status="${FIXTURE_FRONTEND_EXIT:-hold}"
    ;;
  uvicorn)
    [[ "$*" == 'lexicona.app:create_app --factory --host 127.0.0.1 --port 8000' ]] || exit 95
    role=backend
    status="${FIXTURE_BACKEND_EXIT:-hold}"
    ;;
  descendant)
    role=descendant
    status=hold
    ;;
  *) exit 95 ;;
esac

printf '%s\n' "$$" >"$FIXTURE_STATE/$role.pid"
printf '%s\n' "$PWD" >"$FIXTURE_STATE/$role.cwd"
printf '%s\n' "${TMPDIR:-missing}" >"$FIXTURE_STATE/$role.tmp"
if [[ "$status" != hold ]]; then
  sleep 0.2
  exit "$status"
fi
if [[ "${FIXTURE_STUBBORN:-0}" == 1 ]]; then
  trap '' TERM INT
else
  trap 'exit 0' TERM INT
fi
if [[ "$role" == frontend ]]; then
  "$FIXTURE_STATE/descendant" &
fi
while :; do
  sleep 0.1 &
  wait "$!" || true
done
