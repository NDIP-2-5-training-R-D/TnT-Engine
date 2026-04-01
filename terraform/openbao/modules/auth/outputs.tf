output "approle_role_id" {
  description = "AppRole role ID for T&T Engine"
  value       = data.vault_approle_auth_backend_role_id.tnt_engine.role_id
}

output "approle_secret_id" {
  description = "AppRole secret ID (sensitive)"
  value       = vault_approle_auth_backend_role_secret_id.tnt_engine.secret_id
  sensitive   = true
}

output "approle_path" {
  value = vault_auth_backend.approle.path
}
