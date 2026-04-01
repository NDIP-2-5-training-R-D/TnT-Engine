#!/usr/bin/env bash
# Database migration script using the expand-migrate-contract pattern.
#
# Usage:
#   ./scripts/db-migrate.sh <environment>
#
# The script applies schema.sql idempotently (IF NOT EXISTS everywhere).
# For breaking changes, use the expand → migrate → contract pattern:
#   1. EXPAND:   Add new columns/tables (backward-compatible)
#   2. MIGRATE:  Deploy new app version that writes to both old+new
#   3. CONTRACT: Remove old columns after all pods are on new version
#
# This script only runs the EXPAND phase. CONTRACT is a separate step.

set -euo pipefail

ENV="${1:-dev}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_FILE="${SCRIPT_DIR}/../sql/schema.sql"

case "$ENV" in
  dev)
    DB_HOST="${TNT_DB_HOST:-localhost}"
    DB_PORT="${TNT_DB_PORT:-5432}"
    DB_NAME="${TNT_DB_NAME:-tnt_engine}"
    DB_USER="${TNT_DB_USER:-tnt}"
    ;;
  staging|prod)
    # In staging/prod, these come from environment variables (injected by CI/CD)
    DB_HOST="${TNT_DB_HOST:?TNT_DB_HOST is required}"
    DB_PORT="${TNT_DB_PORT:?TNT_DB_PORT is required}"
    DB_NAME="${TNT_DB_NAME:?TNT_DB_NAME is required}"
    DB_USER="${TNT_DB_USER:?TNT_DB_USER is required}"
    ;;
  *)
    echo "Usage: $0 <dev|staging|prod>"
    exit 1
    ;;
esac

echo "=== T&T Engine DB Migration ==="
echo "Environment: ${ENV}"
echo "Host:        ${DB_HOST}:${DB_PORT}"
echo "Database:    ${DB_NAME}"
echo ""

# Apply schema (idempotent — all CREATE statements use IF NOT EXISTS)
PGPASSWORD="${TNT_DB_PASSWORD:-tnt_secret}" psql \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  -f "$SCHEMA_FILE" \
  --set ON_ERROR_STOP=on

echo ""
echo "=== Migration complete ==="
