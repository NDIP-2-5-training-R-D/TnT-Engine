#!/bin/sh
# scripts/init-openbao.sh
# Automatically initializes OpenBao after every container start:
#   1. Enable Transit secrets engine (idempotent)
#   2. Create encryption key 'ndip-key'   (idempotent)
#
# Runs as a one-shot init container; exits 0 on success.

set -e

BAO_ADDR="${BAO_ADDR:-http://openbao:8200}"
VAULT_TOKEN="${BAO_TOKEN:-root}"

export VAULT_TOKEN

echo "==> OpenBao init starting (addr=$BAO_ADDR)"

# ---------- helper: call bao CLI ----------
bao_cmd() {
    bao "$@" -address="$BAO_ADDR"
}

# ---------- 1. Enable Transit engine ----------
echo "--> Enabling Transit secrets engine..."
if bao_cmd secrets enable transit 2>/dev/null; then
    echo "    Transit enabled."
else
    echo "    Transit already enabled (skipping)."
fi

# ---------- 2. Create ndip-key ----------
echo "--> Creating Transit key 'ndip-key' (aes256-gcm96)..."
if bao_cmd write transit/keys/ndip-key type=aes256-gcm96 2>/dev/null; then
    echo "    Key 'ndip-key' created."
else
    echo "    Key 'ndip-key' already exists (skipping)."
fi

echo "==> OpenBao initialization complete."
