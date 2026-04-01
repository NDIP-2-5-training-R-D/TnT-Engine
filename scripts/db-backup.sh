#!/usr/bin/env bash
# Database backup script.
#
# Usage:
#   ./scripts/db-backup.sh
#
# Creates a timestamped pg_dump and optionally uploads to object storage.
#
# Recovery targets:
#   RPO (Recovery Point Objective): 1 hour (run via cron every hour)
#   RTO (Recovery Time Objective): 30 minutes (restore from latest backup)

set -euo pipefail

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="${BACKUP_DIR:-/tmp/tnt-backups}"
BACKUP_FILE="${BACKUP_DIR}/tnt_engine_${TIMESTAMP}.sql.gz"

DB_HOST="${TNT_DB_HOST:-localhost}"
DB_PORT="${TNT_DB_PORT:-5432}"
DB_NAME="${TNT_DB_NAME:-tnt_engine}"
DB_USER="${TNT_DB_USER:-tnt}"

mkdir -p "$BACKUP_DIR"

echo "=== T&T Engine DB Backup ==="
echo "Timestamp: ${TIMESTAMP}"
echo "Output:    ${BACKUP_FILE}"

PGPASSWORD="${TNT_DB_PASSWORD:-tnt_secret}" pg_dump \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  | gzip > "$BACKUP_FILE"

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "Backup complete: ${BACKUP_FILE} (${SIZE})"

# Optional: upload to S3/GCS
# aws s3 cp "$BACKUP_FILE" "s3://tnt-backups/${BACKUP_FILE##*/}"
# gsutil cp "$BACKUP_FILE" "gs://tnt-backups/${BACKUP_FILE##*/}"

# Cleanup: keep last 168 backups (7 days at hourly)
find "$BACKUP_DIR" -name "tnt_engine_*.sql.gz" -mtime +7 -delete 2>/dev/null || true

echo "=== Backup complete ==="
