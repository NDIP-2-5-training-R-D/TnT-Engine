# ── AppRole Auth Method ──────────────────────────────────────────────
# Service-to-service authentication for the T&T Engine.

resource "vault_auth_backend" "approle" {
  type = "approle"
  path = "approle"

  tune {
    default_lease_ttl = var.approle_token_ttl
    max_lease_ttl     = var.approle_token_max_ttl
  }
}

resource "vault_approle_auth_backend_role" "tnt_engine" {
  backend   = vault_auth_backend.approle.path
  role_name = "tnt-engine"

  token_policies      = [var.transit_policy_name]
  token_ttl           = parseint(replace(var.approle_token_ttl, "h", ""), 10) * 3600
  token_max_ttl       = parseint(replace(var.approle_token_max_ttl, "h", ""), 10) * 3600
  token_type          = "service"
  bind_secret_id      = true
  secret_id_bound_cidrs = var.approle_bound_cidr_list

  # Secret ID usage limits
  secret_id_num_uses = var.environment == "production" ? 0 : 0  # 0 = unlimited
  token_num_uses     = 0  # unlimited
}

# Retrieve the role ID (non-sensitive — can be baked into config)
data "vault_approle_auth_backend_role_id" "tnt_engine" {
  backend   = vault_auth_backend.approle.path
  role_name = vault_approle_auth_backend_role.tnt_engine.role_name
}

# Generate a secret ID (sensitive — inject into K8s secret or CI variable)
resource "vault_approle_auth_backend_role_secret_id" "tnt_engine" {
  backend   = vault_auth_backend.approle.path
  role_name = vault_approle_auth_backend_role.tnt_engine.role_name

  metadata = jsonencode({
    environment = var.environment
    created_by  = "terraform"
  })
}

# ── Kubernetes Auth Method (optional) ───────────────────────────────

resource "vault_auth_backend" "kubernetes" {
  count = var.k8s_auth_enabled ? 1 : 0

  type = "kubernetes"
  path = "kubernetes"
}

resource "vault_kubernetes_auth_backend_config" "config" {
  count = var.k8s_auth_enabled ? 1 : 0

  backend            = vault_auth_backend.kubernetes[0].path
  kubernetes_host    = var.k8s_host
  kubernetes_ca_cert = var.k8s_ca_cert
}

resource "vault_kubernetes_auth_backend_role" "tnt_engine" {
  count = var.k8s_auth_enabled ? 1 : 0

  backend                          = vault_auth_backend.kubernetes[0].path
  role_name                        = "tnt-engine"
  bound_service_account_names      = [var.k8s_service_account]
  bound_service_account_namespaces = [var.k8s_namespace]
  token_policies                   = [var.transit_policy_name]
  token_ttl                        = 3600  # 1 hour
  token_max_ttl                    = 14400 # 4 hours
  token_type                       = "service"
}
