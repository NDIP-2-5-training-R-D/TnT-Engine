# T&T Engine Transit Policy — Service-level access
#
# Grants:
#   - encrypt/decrypt on the transit encryption key
#   - hmac on the HMAC key
#   - token self-renewal
#
# Denies:
#   - key creation/deletion/rotation (admin only)
#   - key export (never)
#   - access to other secrets engines
#
# Bound to: tnt-engine AppRole + K8s service account

# Encrypt and decrypt with the transit key
path "transit/encrypt/tnt-key" {
  capabilities = ["update"]
}

path "transit/decrypt/tnt-key" {
  capabilities = ["update"]
}

# HMAC operations
path "transit/hmac/tnt-hmac" {
  capabilities = ["update"]
}

# Read key metadata (for key version tracking during re-encryption)
path "transit/keys/tnt-key" {
  capabilities = ["read"]
}

path "transit/keys/tnt-hmac" {
  capabilities = ["read"]
}

# Token self-management (renewal, lookup)
path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
