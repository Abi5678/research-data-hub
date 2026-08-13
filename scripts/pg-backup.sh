#!/usr/bin/env bash
# Fix garbled dash in comment for clarity
# pg-backup.sh - Dump the RDH Postgres database via docker compose.
#
# Usage:
#   ./scripts/pg-backup.sh                   # writes to backups/rdh_<timestamp>.sql.gz
#   ./scripts/pg-backup.sh my_backup.sql.gz  # writes to backups/my_backup.sql.gz
#
# Requires: docker compose postgres service running.
# Reads POSTGRES_USER / POSTGRES_DB from environment or .env (defaults: rdh/rdh).

set -euo pipefail
cd "$(dirname "$0")/.."

PGUSER="${POSTGRES_USER:-rdh}"
PGDB="${POSTGRES_DB:-rdh}"
BACKUP_DIR="backups"
mkdir -p "$BACKUP_DIR"

FILENAME="${1:-rdh_$(date +%Y%m%d_%H%M%S).sql.gz}"
DEST="$BACKUP_DIR/$FILENAME"

echo "Backing up $PGDB to $DEST ..."
docker compose exec -T postgres pg_dump -U "$PGUSER" -d "$PGDB" --no-owner --no-acl \
  | gzip > "$DEST"

echo "Done. $(du -h "$DEST" | cut -f1) compressed."
