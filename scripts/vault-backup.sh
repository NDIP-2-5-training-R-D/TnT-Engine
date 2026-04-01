#!/usr/bin/env bash
# ── OpenBao Raft Snapshot Backup ────────────────────────────────────
#
# Creates a point-in-time snapshot of the OpenBao Raft storage.
# Intended to run via cron (every 4 hours) or manually before upgrades.
#
# RPO: 4 hours (if run on schedule)
# RTO: 1 hour (restore from snapshot + unseal + verify)
#
# Usage:
#   bash scripts/vault-backup.sh
#   VAULT_ADDR=http://openbao:8200 VAULT_TOKEN=<token> bash scripts/vault-backup.sh
#
# Environment:
#   VAULT_ADDR      — OpenBao API address (default: http://localhost:8200)
#   VAULT_TOKEN     — Auth token with sys/storage/raft/snapshot read access
#   BACKUP_DIR      — Backup destination (default: /tmp/tnt-vault-backups)
#   RETENTION_DAYS  — Cleanup backups older than N days (default: 7)

set -euo pipefail

VAULT_ADDR="${VAULT_ADDR:-http://localhost:8200}"
BACKUP_DIR="${BACKUP_DIR:-/tmp/tnt-vault-backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
SNAPSHOT_FILE="${BACKUP_DIR}/vault_raft_${TIMESTAMP}.snap"

echo "[$(date -Iseconds)] Starting OpenBao raft backup..."
echo "  VAULT_ADDR: ${VAULT_ADDR}"
echo "  BACKUP_DIR: ${BACKUP_DIR}"

# Validate token is set
if [[ -z "${VAULT_TOKEN:-}" ]]; then
    echo "ERROR: VAULT_TOKEN environment variable is required."
    exit 1
fi

# Create backup directory
mkdir -p "${BACKUP_DIR}"

# Check vault health
HEALTH=$(curl -sf "${VAULT_ADDR}/v1/sys/health" || echo '{"sealed":true}')
SEALED=$(echo "${HEALTH}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sealed', True))" 2>/dev/null || echo "true")

if [[ "${SEALED}" == "True" || "${SEALED}" == "true" ]]; then
    echo "ERROR: Vault is sealed. Cannot create snapshot."
    exit 2
fi

# Create raft snapshot
echo "  Creating raft snapshot: ${SNAPSHOT_FILE}"
curl -sf \
    --header "X-Vault-Token: ${VAULT_TOKEN}" \
    --output "${SNAPSHOT_FILE}" \
    "${VAULT_ADDR}/v1/sys/storage/raft/snapshot"

if [[ ! -s "${SNAPSHOT_FILE}" ]]; then
    echo "ERROR: Snapshot file is empty or was not created."
    rm -f "${SNAPSHOT_FILE}"
    exit 3
fi

SNAP_SIZE=$(du -sh "${SNAPSHOT_FILE}" | cut -f1)
echo "  Snapshot created: ${SNAP_SIZE}"

# Optional: upload to object storage
# aws s3 cp "${SNAPSHOT_FILE}" "s3://tnt-backups/vault/${TIMESTAMP}.snap"
# gsutil cp "${SNAPSHOT_FILE}" "gs://tnt-backups/vault/${TIMESTAMP}.snap"

# Cleanup old snapshots
CLEANED=$(find "${BACKUP_DIR}" -name "vault_raft_*.snap" -mtime +"${RETENTION_DAYS}" -delete -print | wc -l)
if [[ "${CLEANED}" -gt 0 ]]; then
    echo "  Cleaned up ${CLEANED} snapshots older than ${RETENTION_DAYS} days"
fi

echo "[$(date -Iseconds)] Backup complete: ${SNAPSHOT_FILE}"
