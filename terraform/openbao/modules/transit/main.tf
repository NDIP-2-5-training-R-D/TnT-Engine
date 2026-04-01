# ── Transit Secrets Engine ───────────────────────────────────────────
# Provisions the transit engine and creates encryption + HMAC keys.

resource "vault_mount" "transit" {
  path        = "transit"
  type        = "transit"
  description = "T&T Engine transit encryption backend"

  default_lease_ttl_seconds = 0
  max_lease_ttl_seconds     = 0
}

# AES-256-GCM encryption key for tokenization
resource "vault_transit_secret_backend_key" "encryption" {
  backend = vault_mount.transit.path
  name    = var.transit_key_name
  type    = var.transit_key_type

  deletion_allowed          = var.transit_allow_deletion
  exportable                = false  # Keys NEVER leave OpenBao
  allow_plaintext_backup    = false
  min_decryption_version    = var.transit_min_decryption_version
  min_encryption_version    = 0      # Always use latest version for encrypt
  auto_rotate_period        = 0      # Rotate manually via admin API or CI
  convergent_encryption     = false  # We use HMAC for convergent lookup
}

# HMAC key for convergent tokenization lookups
resource "vault_transit_secret_backend_key" "hmac" {
  backend = vault_mount.transit.path
  name    = var.transit_hmac_key_name
  type    = var.transit_key_type

  deletion_allowed          = var.transit_allow_deletion
  exportable                = false
  allow_plaintext_backup    = false
  min_decryption_version    = 1
  convergent_encryption     = false
}
