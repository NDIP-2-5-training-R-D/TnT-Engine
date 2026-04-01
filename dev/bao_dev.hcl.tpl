# ════════════════════════════════════════════════════════════════════
# T&T Engine — OpenBao Development Server Configuration
#
# Uses PKCS#11 seal backed by SoftHSM2 for local development.
# This mirrors production HSM-backed seal behavior without requiring
# real hardware.
#
# Key differences from production:
#   - Single node (no Raft HA)
#   - TLS disabled (local dev only)
#   - SoftHSM2 instead of hardware HSM
#
# Environment variable substitution performed by entrypoint.sh:
#   ${RESOLVED_SLOT_ID}  — SoftHSM slot ID (resolved at runtime)
#   ${SOFTHSM_PIN}       — HSM user PIN
#   ${SEAL_KEY_LABEL}    — PKCS#11 seal key label
# ════════════════════════════════════════════════════════════════════

# ── Listener ────────────────────────────────────────────────────────

listener "tcp" {
  address       = "0.0.0.0:8200"
  tls_disable   = true        # Dev only — production uses TLS
}

# ── Storage ─────────────────────────────────────────────────────────

storage "raft" {
  path    = "/opt/openbao/data"
  node_id = "dev-node-1"
}

# ── PKCS#11 Seal (SoftHSM2) ────────────────────────────────────────
# OpenBao's master key is encrypted by an AES-256 key stored in the
# HSM. On startup, OpenBao uses PKCS#11 to access this key and
# auto-unseal without manual unseal key shares.

seal "pkcs11" {
  lib            = "/usr/lib/softhsm/libsofthsm2.so"
  slot           = "${RESOLVED_SLOT_ID}"
  pin            = "${SOFTHSM_PIN}"
  key_label      = "${SEAL_KEY_LABEL}"
  mechanism      = "0x1087"        # CKM_AES_GCM (FIPS-approved)
  hmac_key_label = ""              # Not needed for AES-GCM
  generate_key   = "false"         # Key created by entrypoint.sh
}

# ── API & Cluster ───────────────────────────────────────────────────

api_addr     = "http://127.0.0.1:8200"
cluster_addr = "http://127.0.0.1:8201"

ui = true

# ── Telemetry ───────────────────────────────────────────────────────

telemetry {
  prometheus_retention_time = "30s"
  disable_hostname         = true
}

# ── Security ────────────────────────────────────────────────────────

# Prevent sensitive data from being swapped to disk
disable_mlock = false

log_level = "info"

max_request_duration = "90s"
