# T&T Engine Read-Only Policy — Audit and monitoring
#
# Grants:
#   - read key metadata (versions, algorithm, rotation date)
#   - system health/seal status
#   - audit log access
#
# Denies:
#   - any encrypt/decrypt/hmac operations
#   - any write operations
#   - key export
#
# Bound to: auditors, monitoring systems, compliance tools

# Key metadata only (no crypto operations)
path "transit/keys/tnt-key" {
  capabilities = ["read"]
}

path "transit/keys/tnt-hmac" {
  capabilities = ["read"]
}

# List all transit keys
path "transit/keys" {
  capabilities = ["list"]
}

# System health
path "sys/health" {
  capabilities = ["read"]
}

path "sys/seal-status" {
  capabilities = ["read"]
}

# Audit log listing
path "sys/audit" {
  capabilities = ["read"]
}

# Policy listing (read-only)
path "sys/policies/acl" {
  capabilities = ["list"]
}

path "sys/policies/acl/*" {
  capabilities = ["read"]
}

# Token self-management
path "auth/token/lookup-self" {
  capabilities = ["read"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}
