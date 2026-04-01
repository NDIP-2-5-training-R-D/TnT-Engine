# T&T Engine Admin Policy — Key rotation and management
#
# Grants:
#   - key rotation on transit keys
#   - key metadata read
#   - policy management
#   - audit log access
#
# Denies:
#   - decrypt (admins should not access plaintext PII)
#   - key export (never)
#   - key deletion (unless explicitly enabled)
#
# Bound to: platform operators, SREs

# Key rotation (create new version)
path "transit/keys/tnt-key/rotate" {
  capabilities = ["update"]
}

path "transit/keys/tnt-hmac/rotate" {
  capabilities = ["update"]
}

# Key metadata (read config, versions)
path "transit/keys/tnt-key" {
  capabilities = ["read"]
}

path "transit/keys/tnt-hmac" {
  capabilities = ["read"]
}

# Key configuration (min_decryption_version, etc.)
path "transit/keys/tnt-key/config" {
  capabilities = ["update"]
}

path "transit/keys/tnt-hmac/config" {
  capabilities = ["update"]
}

# Encrypt only (for re-encryption workflows) — NOT decrypt
path "transit/encrypt/tnt-key" {
  capabilities = ["update"]
}

# HMAC (for integrity checks)
path "transit/hmac/tnt-hmac" {
  capabilities = ["update"]
}

# Policy management
path "sys/policies/acl/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}

# Auth method management
path "auth/*" {
  capabilities = ["create", "read", "update", "delete", "list", "sudo"]
}

# Audit device management
path "sys/audit/*" {
  capabilities = ["create", "read", "update", "delete", "list", "sudo"]
}

# System health and seal status
path "sys/health" {
  capabilities = ["read", "sudo"]
}

path "sys/seal-status" {
  capabilities = ["read"]
}

# Token management
path "auth/token/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
