# ════════════════════════════════════════════════════════════════════
# T&T Engine — OpenBao Infrastructure-as-Code
#
# Provisions:
#   1. Transit engine + encryption/HMAC keys
#   2. Security policies (least-privilege)
#   3. AppRole auth method
#   4. Kubernetes auth method (optional)
#
# Usage:
#   cd terraform/openbao
#   export TF_VAR_openbao_token="<root-token>"
#   terraform init
#   terraform plan -var="environment=production"
#   terraform apply
# ════════════════════════════════════════════════════════════════════

provider "vault" {
  address = var.openbao_addr
  token   = var.openbao_token
}

# ── Transit Engine ──────────────────────────────────────────────────

module "transit" {
  source = "./modules/transit"

  transit_key_name               = var.transit_key_name
  transit_hmac_key_name          = var.transit_hmac_key_name
  transit_key_type               = var.transit_key_type
  transit_min_decryption_version = var.transit_min_decryption_version
  transit_allow_deletion         = var.environment == "development" ? true : var.transit_allow_deletion
}

# ── Policies ────────────────────────────────────────────────────────

module "policies" {
  source = "./modules/policies"

  transit_key_name      = var.transit_key_name
  transit_hmac_key_name = var.transit_hmac_key_name
  environment           = var.environment
}

# ── AppRole Auth ────────────────────────────────────────────────────

module "auth" {
  source = "./modules/auth"

  depends_on = [module.policies]

  environment             = var.environment
  approle_token_ttl       = var.approle_token_ttl
  approle_token_max_ttl   = var.approle_token_max_ttl
  approle_bound_cidr_list = var.approle_bound_cidr_list
  transit_policy_name     = module.policies.transit_policy_name

  # Kubernetes auth
  k8s_auth_enabled   = var.k8s_auth_enabled
  k8s_host           = var.k8s_host
  k8s_ca_cert        = var.k8s_ca_cert
  k8s_service_account = var.k8s_service_account
  k8s_namespace      = var.k8s_namespace
}
