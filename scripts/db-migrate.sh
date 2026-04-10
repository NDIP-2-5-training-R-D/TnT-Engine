#!/usr/bin/env bash
# Database migration script using the expand-migrate-contract pattern.
#
# Usage:
#   ./scripts/db-migrate.sh <environment>
#
# The script applies migrations idempotently in order:
#   1. sql/schema.sql          — core T&T Engine schema
#   2. sql/migrations/*.sql    — numbered incremental migrations (001, 002, ...)
#
# In dev mode the migration runs inside the postgres Docker container so
# psql does NOT need to be installed on the host.
#
# For breaking changes, use the expand → migrate → contract pattern:
#   1. EXPAND:   Add new columns/tables (backward-compatible)
#   2. MIGRATE:  Deploy new app version that writes to both old+new
#   3. CONTRACT: Remove old columns after all pods are on new version

set -euo pipefail

ENV="${1:-dev}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/.."
SCHEMA_FILE="${REPO_ROOT}/sql/schema.sql"
MIGRATIONS_DIR="${REPO_ROOT}/sql/migrations"

case "$ENV" in
  dev)
    DB_NAME="${TNT_DB_NAME:-tnt_engine}"
    DB_USER="${TNT_DB_USER:-tnt}"
    DB_PASSWORD="${TNT_DB_PASSWORD:-tnt_secret}"
    DOCKER_SERVICE="postgres"
    ;;
  staging|prod)
    DB_HOST="${TNT_DB_HOST:?TNT_DB_HOST is required}"
    DB_PORT="${TNT_DB_PORT:?TNT_DB_PORT is required}"
    DB_NAME="${TNT_DB_NAME:?TNT_DB_NAME is required}"
    DB_USER="${TNT_DB_USER:?TNT_DB_USER is required}"
    DB_PASSWORD="${TNT_DB_PASSWORD:?TNT_DB_PASSWORD is required}"
    DOCKER_SERVICE=""
    ;;
  *)
    echo "Usage: $0 <dev|staging|prod>"
    exit 1
    ;;
esac

echo "=== T&T Engine DB Migration ==="
echo "Environment: ${ENV}"
echo "Database:    ${DB_NAME}"
echo ""

# ── Build psql executor ───────────────────────────────────────────────

if [[ "$ENV" == "dev" ]]; then
  # Dev: always run inside the Docker container (no local psql needed)
  CONTAINER=$(docker compose -f "${REPO_ROOT}/docker-compose.yml" ps -q "$DOCKER_SERVICE" 2>/dev/null | head -1)
  if [[ -z "$CONTAINER" ]]; then
    echo "ERROR: postgres container is not running." >&2
    echo "       Start the stack first: make dev" >&2
    exit 1
  fi

  run_sql_file() {
    local file="$1"
    echo "  Applying: $(basename "$file")"
    docker exec -i "$CONTAINER" \
      env PGPASSWORD="$DB_PASSWORD" \
      psql -U "$DB_USER" -d "$DB_NAME" --set ON_ERROR_STOP=on -q \
      < "$file"
  }
else
  # Staging/prod: use local psql
  if ! command -v psql &>/dev/null; then
    echo "ERROR: psql not found. Install postgresql-client on this machine." >&2
    exit 1
  fi

  run_sql_file() {
    local file="$1"
    echo "  Applying: $(basename "$file")"
    PGPASSWORD="$DB_PASSWORD" psql \
      -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
      -f "$file" --set ON_ERROR_STOP=on -q
  }
fi

# ── Apply schema.sql ──────────────────────────────────────────────────

echo "--- Core schema ---"
run_sql_file "$SCHEMA_FILE"

# ── Apply numbered migrations ─────────────────────────────────────────

if [[ -d "$MIGRATIONS_DIR" ]]; then
  mapfile -t MIGRATION_FILES < <(find "$MIGRATIONS_DIR" -name "*.sql" | sort)
  if [[ ${#MIGRATION_FILES[@]} -gt 0 ]]; then
    echo ""
    echo "--- Incremental migrations (${#MIGRATION_FILES[@]} files) ---"
    for f in "${MIGRATION_FILES[@]}"; do
      run_sql_file "$f"
    done
  fi
fi

echo ""
echo "=== Migration complete ==="
