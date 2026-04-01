output "transit_policy_name" {
  value = vault_policy.transit.name
}

output "admin_policy_name" {
  value = vault_policy.admin.name
}

output "readonly_policy_name" {
  value = vault_policy.readonly.name
}
