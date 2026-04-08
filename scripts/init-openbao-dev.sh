#!/usr/bin/env bash
# Initialize OpenBao transit keys for local development.
# Called after docker compose up, before first T&T Engine request.
# Idempotent — safe to run multiple times.

set -euo pipefail

VAULT_ADDR="${VAULT_ADDR:-http://localhost:8200}"
VAULT_TOKEN="${VAULT_TOKEN:-dev-token}"

echo "[init-openbao] Waiting for OpenBao to be ready..."
for i in $(seq 1 30); do
    if curl -sf "${VAULT_ADDR}/v1/sys/health" > /dev/null 2>&1; then
        echo "[init-openbao] OpenBao is ready."
        break
    fi
    echo "[init-openbao] Waiting... ($i/30)"
    sleep 2
done

echo "[init-openbao] Enabling transit engine..."
curl -sf -X POST "${VAULT_ADDR}/v1/sys/mounts/transit" \
    -H "X-Vault-Token: ${VAULT_TOKEN}" \
    -d '{"type":"transit"}' 2>/dev/null || echo "[init-openbao] Transit already enabled."

echo "[init-openbao] Creating tnt-key..."
curl -sf -X POST "${VAULT_ADDR}/v1/transit/keys/tnt-key" \
    -H "X-Vault-Token: ${VAULT_TOKEN}" 2>/dev/null || echo "[init-openbao] tnt-key already exists."

echo "[init-openbao] Creating tnt-hmac..."
curl -sf -X POST "${VAULT_ADDR}/v1/transit/keys/tnt-hmac" \
    -H "X-Vault-Token: ${VAULT_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"type":"hmac"}' 2>/dev/null || echo "[init-openbao] tnt-hmac already exists."

echo "[init-openbao] Creating tnt-aes-gcm (AES-256-GCM96, for AES256_GCM96 transformation)..."
curl -sf -X POST "${VAULT_ADDR}/v1/transit/keys/tnt-aes-gcm" \
    -H "X-Vault-Token: ${VAULT_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"type":"aes256-gcm96"}' 2>/dev/null || echo "[init-openbao] tnt-aes-gcm already exists."

echo "[init-openbao] Creating tnt-fpe (AES-256-GCM96, DEK-wrapping key for FF3_1 envelope encryption)..."
curl -sf -X POST "${VAULT_ADDR}/v1/transit/keys/tnt-fpe" \
    -H "X-Vault-Token: ${VAULT_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"type":"aes256-gcm96"}' 2>/dev/null || echo "[init-openbao] tnt-fpe already exists."

# ── KV v2 secret engine ────────────────────────────────────────────
echo "[init-openbao] Enabling KV v2 secret engine at 'secret/'..."
curl -sf -X POST "${VAULT_ADDR}/v1/sys/mounts/secret" \
    -H "X-Vault-Token: ${VAULT_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"type":"kv","options":{"version":"2"}}' 2>/dev/null \
    || echo "[init-openbao] KV v2 at 'secret/' already enabled."

# ── FPE Data Encryption Key (envelope encryption) ─────────────────
# Check whether the FPE DEK has already been bootstrapped to avoid regenerating
# it on every invocation (idempotent).
echo "[init-openbao] Checking FPE DEK at 'secret/data/tnt/fpe-dek'..."
if curl -sf "${VAULT_ADDR}/v1/secret/data/tnt/fpe-dek" \
       -H "X-Vault-Token: ${VAULT_TOKEN}" > /dev/null 2>&1; then
    echo "[init-openbao] FPE DEK already exists — skipping generation."
else
    echo "[init-openbao] Generating FPE DEK (32 random bytes, wrapped with tnt-fpe)..."

    # Generate a random 32-byte DEK and base64-encode it (OpenBao Transit plaintext format)
    RAW_DEK_B64=$(python3 -c "import os, base64; print(base64.b64encode(os.urandom(32)).decode())")

    # Wrap (encrypt) the DEK using the tnt-fpe Transit key
    WRAPPED_DEK=$(curl -sf -X POST "${VAULT_ADDR}/v1/transit/encrypt/tnt-fpe" \
        -H "X-Vault-Token: ${VAULT_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{\"plaintext\": \"${RAW_DEK_B64}\"}" \
        | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['ciphertext'])")

    # Unset the raw DEK from shell memory as soon as it has been wrapped
    unset RAW_DEK_B64

    # Store the wrapped DEK in KV v2
    curl -sf -X POST "${VAULT_ADDR}/v1/secret/data/tnt/fpe-dek" \
        -H "X-Vault-Token: ${VAULT_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{\"data\": {\"wrapped_dek\": \"${WRAPPED_DEK}\"}}" > /dev/null
    echo "[init-openbao] FPE DEK stored at 'secret/data/tnt/fpe-dek'."
fi

echo "[init-openbao] Done. Transit keys and secrets ready."
echo ""
echo "[init-openbao] Keys provisioned:"
echo "  tnt-key      — Convergent tokenization (TOKENIZE)"
echo "  tnt-hmac     — HMAC-SHA-256 / HMAC-SHA-512 (HMAC, HMAC_SHA512)"
echo "  tnt-aes-gcm  — AES-256-GCM96 authenticated encryption (AES256_GCM96)"
echo "  tnt-fpe      — DEK-wrapping key for FF3-1 envelope encryption (FF3_1)"
echo ""
echo "[init-openbao] Secrets provisioned:"
echo "  secret/data/tnt/fpe-dek  — Wrapped FF3-1 DEK (32 bytes, encrypted by tnt-fpe)"
