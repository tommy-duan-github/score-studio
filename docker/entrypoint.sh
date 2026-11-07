#!/bin/sh
# Starts as root, makes /data and /exports writable for PUID:PGID, then runs Score Studio as that user.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
case "$PUID$PGID" in *[!0-9]*) echo "PUID/PGID must be numbers" >&2; exit 1 ;; esac

if [ -n "${SCORE_STUDIO_MCP_TOKEN:-}" ] && [ "${#SCORE_STUDIO_MCP_TOKEN}" -lt 16 ]; then
  echo "WARNING: SCORE_STUDIO_MCP_TOKEN is shorter than 16 characters; MCP stays disabled." >&2
fi

if [ "$(id -u)" = "0" ]; then
  for d in "${SCORE_STUDIO_DATA:-/data}" "${SCORE_STUDIO_EXPORT:-/exports}"; do
    mkdir -p "$d"
    # Only the top level and our own files: never recurse into someone else's share.
    [ "$(stat -c %u:%g "$d")" = "$PUID:$PGID" ] || chown "$PUID:$PGID" "$d" || true
  done
  [ -d "${SCORE_STUDIO_DATA:-/data}/projects" ] && chown -R "$PUID:$PGID" "${SCORE_STUDIO_DATA:-/data}/projects" 2>/dev/null || true
  [ -f "${SCORE_STUDIO_DATA:-/data}/config.json" ] && chown "$PUID:$PGID" "${SCORE_STUDIO_DATA:-/data}/config.json" 2>/dev/null || true
  mkdir -p /tmp/mpl /tmp/cache && chown "$PUID:$PGID" /tmp/mpl /tmp/cache
  # The PUID has no /etc/passwd entry; getpass.getuser() (used by torch) reads these first.
  export HOME=/tmp USER=scorestudio LOGNAME=scorestudio
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups \
    python -m uvicorn app.main:app --app-dir /app/backend --host 0.0.0.0 --port "${PORT:-19287}" \
    --timeout-graceful-shutdown 10 --no-server-header
fi

exec python -m uvicorn app.main:app --app-dir /app/backend --host 0.0.0.0 --port "${PORT:-19287}" \
  --timeout-graceful-shutdown 10 --no-server-header
