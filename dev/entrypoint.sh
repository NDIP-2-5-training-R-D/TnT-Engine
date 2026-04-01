#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
# T&T Engine — OpenBao + SoftHSM2 Entrypoint
#
# This script runs at container startup and performs:
#   1. Initialize SoftHSM2 token slot (IDEMPOTENT — skips if exists)
#   2. Create PKCS#11 seal key for OpenBao (IDEMPOTENT)
#   3. Start OpenBao server with PKCS#11 seal
#
# Environment variables (required):
#   SOFTHSM_PIN         — User PIN for the HSM slot
#   SOFTHSM_SO_PIN      — Security Officer PIN
#   SOFTHSM_TOKEN_LABEL — Token label (default: openbao-hsm)
#   SEAL_KEY_LABEL      — Label for the auto-unseal AES key (default: openbao-seal-key)
#
# Volumes:
#   /var/lib/softhsm/tokens — SoftHSM token store (MUST persist)
#   /opt/openbao/data       — OpenBao Raft storage (MUST persist)
#
# Security:
#   - PIN values are NEVER logged or echoed
#   - All sensitive operations use environment variables only
# ════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Configuration ───────────────────────────────────────────────────

SOFTHSM_PIN="${SOFTHSM_PIN:?ERROR: SOFTHSM_PIN is required}"
SOFTHSM_SO_PIN="${SOFTHSM_SO_PIN:?ERROR: SOFTHSM_SO_PIN is required}"
SOFTHSM_TOKEN_LABEL="${SOFTHSM_TOKEN_LABEL:-openbao-hsm}"
SEAL_KEY_LABEL="${SEAL_KEY_LABEL:-openbao-seal-key}"
SOFTHSM_LIB="/usr/lib/softhsm/libsofthsm2.so"
SOFTHSM_CONF="/etc/softhsm/softhsm2.conf"
TOKEN_DIR="/var/lib/softhsm/tokens"

export SOFTHSM2_CONF="${SOFTHSM_CONF}"

echo "[entrypoint] ══════════════════════════════════════════════════"
echo "[entrypoint] T&T Engine — OpenBao + SoftHSM2 Startup"
echo "[entrypoint] ══════════════════════════════════════════════════"

# ── Step 1: Ensure SoftHSM2 directories exist ──────────────────────

mkdir -p "${TOKEN_DIR}"

if [[ ! -f "${SOFTHSM_CONF}" ]]; then
    echo "[entrypoint] Creating SoftHSM2 config: ${SOFTHSM_CONF}"
    mkdir -p "$(dirname "${SOFTHSM_CONF}")"
    cat > "${SOFTHSM_CONF}" <<CONF
directories.tokendir = ${TOKEN_DIR}
objectstore.backend = file
log.level = INFO
CONF
fi

# ── Step 2: Initialize SoftHSM token (idempotent) ──────────────────

echo "[entrypoint] Checking SoftHSM2 token slots..."

# Check if our token label already exists
if softhsm2-util --show-slots 2>/dev/null | grep -q "Label:.*${SOFTHSM_TOKEN_LABEL}"; then
    echo "[entrypoint] SoftHSM token '${SOFTHSM_TOKEN_LABEL}' already exists. Skipping init."
else
    echo "[entrypoint] Initializing SoftHSM token '${SOFTHSM_TOKEN_LABEL}'..."

    # Find an available slot — SoftHSM always has at least one uninitialized slot
    AVAIL_SLOT=$(softhsm2-util --show-slots 2>/dev/null \
        | grep "^Slot " | head -1 | awk '{print $2}')

    if [[ -z "${AVAIL_SLOT}" ]]; then
        echo "[entrypoint] ERROR: No available SoftHSM slots."
        exit 1
    fi

    softhsm2-util --init-token \
        --slot "${AVAIL_SLOT}" \
        --label "${SOFTHSM_TOKEN_LABEL}" \
        --pin "${SOFTHSM_PIN}" \
        --so-pin "${SOFTHSM_SO_PIN}"

    echo "[entrypoint] SoftHSM token initialized on slot ${AVAIL_SLOT}."
fi

# ── Step 3: Create PKCS#11 seal key (idempotent) ───────────────────

echo "[entrypoint] Checking for PKCS#11 seal key '${SEAL_KEY_LABEL}'..."

# Check if the seal key already exists
if pkcs11-tool --module "${SOFTHSM_LIB}" \
    --login --pin "${SOFTHSM_PIN}" \
    --token-label "${SOFTHSM_TOKEN_LABEL}" \
    --list-objects --type secrkey 2>/dev/null \
    | grep -q "label:.*${SEAL_KEY_LABEL}"; then
    echo "[entrypoint] Seal key '${SEAL_KEY_LABEL}' already exists. Skipping creation."
else
    echo "[entrypoint] Creating AES-256 seal key '${SEAL_KEY_LABEL}'..."

    pkcs11-tool --module "${SOFTHSM_LIB}" \
        --login --pin "${SOFTHSM_PIN}" \
        --token-label "${SOFTHSM_TOKEN_LABEL}" \
        --keygen --key-type AES:32 \
        --label "${SEAL_KEY_LABEL}" \
        --id 10 \
        --extractable --allow-sw

    echo "[entrypoint] Seal key created."
fi

# ── Step 4: Create T&T Engine application keys (idempotent) ────────

echo "[entrypoint] Checking for T&T Engine application keys..."

# Encryption key
if pkcs11-tool --module "${SOFTHSM_LIB}" \
    --login --pin "${SOFTHSM_PIN}" \
    --token-label "${SOFTHSM_TOKEN_LABEL}" \
    --list-objects --type secrkey 2>/dev/null \
    | grep -q "label:.*tnt-encrypt-key"; then
    echo "[entrypoint] Application encrypt key exists."
else
    echo "[entrypoint] Creating AES-256 application encrypt key..."
    pkcs11-tool --module "${SOFTHSM_LIB}" \
        --login --pin "${SOFTHSM_PIN}" \
        --token-label "${SOFTHSM_TOKEN_LABEL}" \
        --keygen --key-type AES:32 \
        --label "tnt-encrypt-key" \
        --id 01 \
        --extractable --allow-sw
fi

# HMAC key
if pkcs11-tool --module "${SOFTHSM_LIB}" \
    --login --pin "${SOFTHSM_PIN}" \
    --token-label "${SOFTHSM_TOKEN_LABEL}" \
    --list-objects --type secrkey 2>/dev/null \
    | grep -q "label:.*tnt-hmac-key"; then
    echo "[entrypoint] Application HMAC key exists."
else
    echo "[entrypoint] Creating HMAC key..."
    pkcs11-tool --module "${SOFTHSM_LIB}" \
        --login --pin "${SOFTHSM_PIN}" \
        --token-label "${SOFTHSM_TOKEN_LABEL}" \
        --keygen --key-type GENERIC:32 \
        --label "tnt-hmac-key" \
        --id 02 \
        --extractable --allow-sw
fi

# ── Step 5: Show slot summary ──────────────────────────────────────

echo "[entrypoint] ── SoftHSM2 Slot Summary ──"
softhsm2-util --show-slots 2>/dev/null | head -20
echo ""

echo "[entrypoint] ── PKCS#11 Objects ──"
pkcs11-tool --module "${SOFTHSM_LIB}" \
    --login --pin "${SOFTHSM_PIN}" \
    --token-label "${SOFTHSM_TOKEN_LABEL}" \
    --list-objects --type secrkey 2>/dev/null || true
echo ""

# ── Step 6: Resolve PKCS#11 slot ID for OpenBao config ─────────────

SLOT_ID=$(softhsm2-util --show-slots 2>/dev/null \
    | grep -B1 "Label:.*${SOFTHSM_TOKEN_LABEL}" \
    | grep "^Slot " | awk '{print $2}')

if [[ -z "${SLOT_ID}" ]]; then
    echo "[entrypoint] ERROR: Cannot find slot ID for token '${SOFTHSM_TOKEN_LABEL}'"
    exit 1
fi

echo "[entrypoint] Resolved PKCS#11 slot ID: ${SLOT_ID}"

# Export for OpenBao config template substitution
export RESOLVED_SLOT_ID="${SLOT_ID}"

# ── Step 7: Generate OpenBao config from template ──────────────────

if [[ -f /etc/openbao/bao_dev.hcl.tpl ]]; then
    echo "[entrypoint] Generating OpenBao config from template..."
    envsubst < /etc/openbao/bao_dev.hcl.tpl > /etc/openbao/bao_dev.hcl
fi

# ── Step 8: Start OpenBao ──────────────────────────────────────────

echo "[entrypoint] ══════════════════════════════════════════════════"
echo "[entrypoint] Starting OpenBao server..."
echo "[entrypoint] Config: /etc/openbao/bao_dev.hcl"
echo "[entrypoint] Seal:   PKCS#11 (SoftHSM2)"
echo "[entrypoint] Data:   /opt/openbao/data"
echo "[entrypoint] ══════════════════════════════════════════════════"

exec bao server -config=/etc/openbao/bao_dev.hcl
