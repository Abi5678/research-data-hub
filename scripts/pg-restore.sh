#!/usr/bin/env bash
# pg-restore.sh - Restore an RDH Postgres backup via docker compose.
#
# Usage:
#   ./scripts/pg-restore.sh backups/rdh_20260809_120000.sql.gz
#
# WARNING: This drops and recreates the target database. All existing data is lost.
# Requires: docker compose postgres service running.
# Reads POSTGRES_USER / POSTGRES_DB from environment or .env (defaults: rdh/rdh).

set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -lt 1 ]; then
  echo "Usage: $0 <backup_file.sql.gz>"
  exit 1
fi

BACKUP="$1"
if [ ! -f "$BACKUP" ]; then
  echo "File not found: $BACKUP"
  exit 1
fi

PGUSER="${POSTGRES_USER:-rdh}"
PGDB="${POSTGRES_DB:-rdh}"

echo "Restoring $BACKUP into $PGDB (all existing data will be replaced) ..."
read -r -p "Continue? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

docker compose exec -T postgres psql -U "$PGUSER" -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$PGDB' AND pid<>pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS \"$PGDB\";" \
  -c "CREATE DATABASE \"$PGDB\" OWNER \"$PGUSER\";"

gunzip -c "$BACKUP" | docker compose exec -T postgres psql -U "$PGUSER" -d "$PGDB" --quiet

echo "Restore complete."
