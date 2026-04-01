#!/bin/sh
set -e

VAULT_ADDR="http://openbao:8200"
VAULT_TOKEN="root"

# Wait for OpenBao to be healthy
echo "Waiting for OpenBao at ${VAULT_ADDR}..."
tries=0
until curl -s --max-time 2 "${VAULT_ADDR}/v1/sys/health" > /dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 30 ]; then
    echo "ERROR: OpenBao did not become healthy after 30 tries. Aborting."
    exit 1
  fi
  echo "  Not ready yet (attempt ${tries}/30), retrying in 2s..."
  sleep 2
done
echo "OpenBao is healthy."

# ---------------------------------------------------------------------------
# Helper: idempotent mount — succeeds even if already enabled
# ---------------------------------------------------------------------------

enable_engine() {
  _path="$1"
  _type="$2"
  _label="$3"
  echo "Enabling ${_label} engine at ${_path}..."
  _status=$(curl -s -o /dev/null -w "%{http_code}" \
    --header "X-Vault-Token: ${VAULT_TOKEN}" \
    --request POST \
    --data "{\"type\":\"${_type}\"}" \
    "${VAULT_ADDR}/v1/sys/mounts/${_path}")
  if [ "$_status" = "204" ] || [ "$_status" = "200" ]; then
    echo "  ${_label} engine enabled."
    return 0
  elif [ "$_status" = "400" ]; then
    echo "  ${_label} engine already enabled (skipped)."
    return 0
  else
    echo "  WARNING: ${_label} engine returned HTTP ${_status}."
    return 1
  fi
}

enable_auth() {
  _path="$1"
  _type="$2"
  _label="$3"
  echo "Enabling ${_label} auth at ${_path}..."
  _status=$(curl -s -o /dev/null -w "%{http_code}" \
    --header "X-Vault-Token: ${VAULT_TOKEN}" \
    --request POST \
    --data "{\"type\":\"${_type}\"}" \
    "${VAULT_ADDR}/v1/sys/auth/${_path}")
  if [ "$_status" = "204" ] || [ "$_status" = "200" ]; then
    echo "  ${_label} auth enabled."
    return 0
  elif [ "$_status" = "400" ]; then
    echo "  ${_label} auth already enabled (skipped)."
    return 0
  else
    echo "  WARNING: ${_label} auth returned HTTP ${_status}."
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Transit secrets engine
# ---------------------------------------------------------------------------

enable_engine "transit" "transit" "Transit"

echo "Creating transit key 'tt-engine-key' (aes256-gcm96)..."
curl -sf \
  --header "X-Vault-Token: ${VAULT_TOKEN}" \
  --request POST \
  --data '{"type":"aes256-gcm96"}' \
  "${VAULT_ADDR}/v1/transit/keys/tt-engine-key" > /dev/null 2>&1 || echo "  Key already exists (skipped)."

# ---------------------------------------------------------------------------
# Transform secrets engine (format-preserving encryption)
# Not supported in all OpenBao builds — failures are non-fatal.
# ---------------------------------------------------------------------------

if enable_engine "transform" "transform" "Transform"; then
  echo "Creating transform role 'tt-engine'..."
  curl -sf \
    --header "X-Vault-Token: ${VAULT_TOKEN}" \
    --request POST \
    --data '{"transformations":["tt-fpe-ccn"]}' \
    "${VAULT_ADDR}/v1/transform/role/tt-engine" > /dev/null 2>&1 || echo "  Transform role already exists (skipped)."

  echo "Creating FPE transformation 'tt-fpe-ccn' (credit-card numbers)..."
  curl -sf \
    --header "X-Vault-Token: ${VAULT_TOKEN}" \
    --request POST \
    --data '{
      "type": "fpe",
      "template": "builtin/creditcardnumber",
      "tweak_source": "internal",
      "allowed_roles": ["tt-engine"]
    }' \
    "${VAULT_ADDR}/v1/transform/transformations/fpe/tt-fpe-ccn" > /dev/null 2>&1 || echo "  FPE CCN transformation already exists (skipped)."

  echo "Creating FPE transformation 'tt-fpe-ssn' (US social security numbers)..."
  curl -sf \
    --header "X-Vault-Token: ${VAULT_TOKEN}" \
    --request POST \
    --data '{
      "type": "fpe",
      "template": "builtin/socialsecuritynumber",
      "tweak_source": "internal",
      "allowed_roles": ["tt-engine"]
    }' \
    "${VAULT_ADDR}/v1/transform/transformations/fpe/tt-fpe-ssn" > /dev/null 2>&1 || echo "  FPE SSN transformation already exists (skipped)."

  # Update role to include the SSN transformation as well
  curl -sf \
    --header "X-Vault-Token: ${VAULT_TOKEN}" \
    --request POST \
    --data '{"transformations":["tt-fpe-ccn","tt-fpe-ssn"]}' \
    "${VAULT_ADDR}/v1/transform/role/tt-engine" > /dev/null 2>&1 || true
else
  echo "  Transform engine not available — skipping FPE setup."
fi

# ---------------------------------------------------------------------------
# AppRole auth
# ---------------------------------------------------------------------------

enable_auth "approle" "approle" "AppRole"

echo "Creating policy 'tt-engine-policy'..."
curl -sf \
  --header "X-Vault-Token: ${VAULT_TOKEN}" \
  --request PUT \
  --data '{
    "policy": "path \"transit/*\" { capabilities = [\"create\", \"read\", \"update\"] }\npath \"transform/*\" { capabilities = [\"create\", \"read\", \"update\"] }\npath \"auth/token/renew-self\" { capabilities = [\"update\"] }"
  }' \
  "${VAULT_ADDR}/v1/sys/policies/acl/tt-engine-policy" > /dev/null

echo "Creating AppRole 'tt-engine'..."
curl -sf \
  --header "X-Vault-Token: ${VAULT_TOKEN}" \
  --request POST \
  --data '{
    "token_policies": ["tt-engine-policy"],
    "token_ttl": "1h",
    "token_max_ttl": "24h"
  }' \
  "${VAULT_ADDR}/v1/auth/approle/role/tt-engine" > /dev/null

# ---------------------------------------------------------------------------
# Output credentials
# ---------------------------------------------------------------------------

echo ""
echo "=== Credentials ==="
ROLE_ID_RESPONSE=$(curl -sf \
  --header "X-Vault-Token: ${VAULT_TOKEN}" \
  "${VAULT_ADDR}/v1/auth/approle/role/tt-engine/role-id")

ROLE_ID=$(echo "$ROLE_ID_RESPONSE" | sed 's/.*"role_id":"\([^"]*\)".*/\1/')
echo "OPENBAO_ROLE_ID=${ROLE_ID}"

SECRET_ID_RESPONSE=$(curl -sf \
  --header "X-Vault-Token: ${VAULT_TOKEN}" \
  --request POST \
  "${VAULT_ADDR}/v1/auth/approle/role/tt-engine/secret-id")

SECRET_ID=$(echo "$SECRET_ID_RESPONSE" | sed 's/.*"secret_id":"\([^"]*\)".*/\1/')
echo "OPENBAO_SECRET_ID=${SECRET_ID}"

echo ""
echo "=== OpenBao init complete ==="
echo "Engines:  transit (HMAC/encrypt/decrypt), transform (FPE: CCN + SSN)"
echo "Copy OPENBAO_ROLE_ID and OPENBAO_SECRET_ID into your .env file."
