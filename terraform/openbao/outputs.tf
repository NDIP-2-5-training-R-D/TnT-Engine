output "transit_key_name" {
  description = "Name of the provisioned transit encryption key"
  value       = module.transit.encryption_key_name
}

output "transit_hmac_key_name" {
  description = "Name of the provisioned transit HMAC key"
  value       = module.transit.hmac_key_name
}

output "approle_role_id" {
  description = "AppRole role ID for the T&T Engine service"
  value       = module.auth.approle_role_id
}

output "approle_secret_id" {
  description = "AppRole secret ID (sensitive — inject into K8s secret)"
  value       = module.auth.approle_secret_id
  sensitive   = true
}

output "transit_policy_name" {
  description = "Name of the transit access policy"
  value       = module.policies.transit_policy_name
}

output "admin_policy_name" {
  description = "Name of the admin policy"
  value       = module.policies.admin_policy_name
}

output "environment" {
  description = "Deployment environment"
  value       = var.environment
}
