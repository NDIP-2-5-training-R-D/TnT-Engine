# ── OpenBao Cluster ──────────────────────────────────────────────────

variable "openbao_addr" {
  description = "OpenBao API address"
  type        = string
  default     = "http://127.0.0.1:8200"
}

variable "openbao_token" {
  description = "OpenBao root/admin token for initial provisioning (use env TF_VAR_openbao_token)"
  type        = string
  sensitive   = true
}

variable "environment" {
  description = "Deployment environment: development, staging, production"
  type        = string
  default     = "development"

  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "Environment must be development, staging, or production."
  }
}

variable "cluster_name" {
  description = "OpenBao cluster name"
  type        = string
  default     = "tnt-openbao"
}

variable "cluster_node_count" {
  description = "Number of OpenBao nodes for HA (must be odd: 3 or 5)"
  type        = number
  default     = 3

  validation {
    condition     = contains([1, 3, 5], var.cluster_node_count)
    error_message = "Node count must be 1, 3, or 5."
  }
}

# ── Transit Engine ──────────────────────────────────────────────────

variable "transit_key_name" {
  description = "Name of the transit encryption key"
  type        = string
  default     = "tnt-key"
}

variable "transit_hmac_key_name" {
  description = "Name of the transit HMAC key"
  type        = string
  default     = "tnt-hmac"
}

variable "transit_key_type" {
  description = "Encryption algorithm for transit key"
  type        = string
  default     = "aes256-gcm96"
}

variable "transit_min_decryption_version" {
  description = "Minimum key version allowed for decryption"
  type        = number
  default     = 1
}

variable "transit_allow_deletion" {
  description = "Whether transit keys can be deleted (false in production)"
  type        = bool
  default     = false
}

# ── AppRole Auth ────────────────────────────────────────────────────

variable "approle_token_ttl" {
  description = "TTL for AppRole tokens"
  type        = string
  default     = "1h"
}

variable "approle_token_max_ttl" {
  description = "Max TTL for AppRole tokens"
  type        = string
  default     = "4h"
}

variable "approle_bound_cidr_list" {
  description = "CIDR blocks allowed for AppRole login"
  type        = list(string)
  default     = ["10.0.0.0/8", "172.16.0.0/12"]
}

# ── Kubernetes Auth ─────────────────────────────────────────────────

variable "k8s_auth_enabled" {
  description = "Enable Kubernetes auth method"
  type        = bool
  default     = false
}

variable "k8s_host" {
  description = "Kubernetes API server URL"
  type        = string
  default     = "https://kubernetes.default.svc"
}

variable "k8s_ca_cert" {
  description = "Kubernetes CA certificate (PEM)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "k8s_service_account" {
  description = "Kubernetes service account name for T&T Engine"
  type        = string
  default     = "tnt-engine"
}

variable "k8s_namespace" {
  description = "Kubernetes namespace for T&T Engine"
  type        = string
  default     = "tnt-engine"
}

# ── Auto-Unseal (for P3) ───────────────────────────────────────────

variable "auto_unseal_enabled" {
  description = "Enable auto-unseal via transit (requires a separate OpenBao/Vault)"
  type        = bool
  default     = false
}

variable "auto_unseal_addr" {
  description = "Address of the unsealing Vault/OpenBao instance"
  type        = string
  default     = ""
}

variable "auto_unseal_token" {
  description = "Token for the unsealing instance"
  type        = string
  default     = ""
  sensitive   = true
}

variable "auto_unseal_key_name" {
  description = "Transit key name on the unsealing instance"
  type        = string
  default     = "tnt-autounseal"
}
