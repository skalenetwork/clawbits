#!/usr/bin/env bash
# Online snapshot of the Reef desired-state DB (the source of truth for every
# agent's desired_state + restart_policy). Uses sqlite3's `.backup`, which is
# consistent against a live WAL DB, then prunes to the newest $REEF_BACKUP_KEEP.
#
# Run by reef-db-backup.timer (daily). Reads the same /etc/reef/reef.env as the API.
# For continuous, point-in-time backups, prefer litestream instead (see README).
set -euo pipefail

DB="${REEF_DB_PATH:-/var/lib/reef/reef.db}"
DEST="${REEF_BACKUP_DIR:-/var/backups/reef}"
KEEP="${REEF_BACKUP_KEEP:-14}"

if [[ ! -f "$DB" ]]; then
  echo "reef-db-backup: no DB at $DB — nothing to do" >&2
  exit 0
fi

mkdir -p "$DEST"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$DEST/reef-$stamp.db"

sqlite3 "$DB" ".backup '$out'"
echo "reef-db-backup: wrote $out"

# Keep the newest $KEEP snapshots; drop the rest.
ls -1t "$DEST"/reef-*.db 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
