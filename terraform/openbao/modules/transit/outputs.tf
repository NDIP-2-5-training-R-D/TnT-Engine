output "encryption_key_name" {
  value = vault_transit_secret_backend_key.encryption.name
}

output "hmac_key_name" {
  value = vault_transit_secret_backend_key.hmac.name
}

output "mount_path" {
  value = vault_mount.transit.path
}
