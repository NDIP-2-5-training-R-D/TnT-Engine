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
    -H "X-Vault-Token: ${VAULT_TOKEN}" 2>/dev/null || echo "[init-openbao] tnt-hmac already exists."

echo "[init-openbao] Creating tnt-aes-gcm (AES-256-GCM96, for AES256_GCM96 transformation)..."
curl -sf -X POST "${VAULT_ADDR}/v1/transit/keys/tnt-aes-gcm" \
    -H "X-Vault-Token: ${VAULT_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"type":"aes256-gcm96"}' 2>/dev/null || echo "[init-openbao] tnt-aes-gcm already exists."

echo "[init-openbao] Creating tnt-fpe (AES-256-GCM96, for FF3_1 / Format-Preserving Encryption)..."
curl -sf -X POST "${VAULT_ADDR}/v1/transit/keys/tnt-fpe" \
    -H "X-Vault-Token: ${VAULT_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"type":"aes256-gcm96"}' 2>/dev/null || echo "[init-openbao] tnt-fpe already exists."

echo "[init-openbao] Done. Transit keys ready."
echo ""
echo "[init-openbao] Keys provisioned:"
echo "  tnt-key      — Convergent tokenization (TOKENIZE)"
echo "  tnt-hmac     — HMAC-SHA-256 / HMAC-SHA-512 (HMAC, HMAC_SHA512)"
echo "  tnt-aes-gcm  — AES-256-GCM96 authenticated encryption (AES256_GCM96)"
echo "  tnt-fpe      — Format-Preserving Encryption key material (FF3_1)"
