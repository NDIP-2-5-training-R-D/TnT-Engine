#!/usr/bin/env bash
# ── OpenBao Raft Snapshot Restore ───────────────────────────────────
#
# Restores OpenBao from a Raft snapshot file.
# WARNING: This replaces ALL current data. Use with extreme caution.
#
# Usage:
#   bash scripts/vault-restore.sh /path/to/vault_raft_20260401.snap
#
# Environment:
#   VAULT_ADDR   — OpenBao API address (default: http://localhost:8200)
#   VAULT_TOKEN  — Auth token with sys/storage/raft/snapshot write access

set -euo pipefail

VAULT_ADDR="${VAULT_ADDR:-http://localhost:8200}"

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <snapshot-file>"
    echo "  Example: $0 /tmp/tnt-vault-backups/vault_raft_20260401_120000.snap"
    exit 1
fi

SNAPSHOT_FILE="$1"

if [[ ! -f "${SNAPSHOT_FILE}" ]]; then
    echo "ERROR: Snapshot file not found: ${SNAPSHOT_FILE}"
    exit 2
fi

if [[ -z "${VAULT_TOKEN:-}" ]]; then
    echo "ERROR: VAULT_TOKEN environment variable is required."
    exit 1
fi

SNAP_SIZE=$(du -sh "${SNAPSHOT_FILE}" | cut -f1)
echo "[$(date -Iseconds)] Restoring OpenBao from snapshot..."
echo "  VAULT_ADDR:    ${VAULT_ADDR}"
echo "  SNAPSHOT_FILE: ${SNAPSHOT_FILE} (${SNAP_SIZE})"
echo ""
echo "  WARNING: This will REPLACE all current Vault data!"
echo "  Press Ctrl+C within 5 seconds to cancel..."
sleep 5

# Restore the snapshot (force=true to overwrite)
HTTP_CODE=$(curl -sw '%{http_code}' \
    --header "X-Vault-Token: ${VAULT_TOKEN}" \
    --request POST \
    --data-binary @"${SNAPSHOT_FILE}" \
    --output /dev/null \
    "${VAULT_ADDR}/v1/sys/storage/raft/snapshot-force")

if [[ "${HTTP_CODE}" != "204" && "${HTTP_CODE}" != "200" ]]; then
    echo "ERROR: Restore failed with HTTP ${HTTP_CODE}"
    exit 3
fi

echo "  Snapshot restored successfully."
echo ""
echo "  IMPORTANT: The cluster may need to be unsealed after restore."
echo "  Check seal status: curl -s ${VAULT_ADDR}/v1/sys/seal-status | jq ."
echo ""

# Verify health
sleep 3
HEALTH=$(curl -sf "${VAULT_ADDR}/v1/sys/health" 2>/dev/null || echo '{"sealed":true}')
echo "  Health status: ${HEALTH}"

echo "[$(date -Iseconds)] Restore complete."
