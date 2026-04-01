variable "environment" {
  type = string
}

variable "transit_policy_name" {
  type = string
}

variable "approle_token_ttl" {
  type    = string
  default = "1h"
}

variable "approle_token_max_ttl" {
  type    = string
  default = "4h"
}

variable "approle_bound_cidr_list" {
  type    = list(string)
  default = []
}

variable "k8s_auth_enabled" {
  type    = bool
  default = false
}

variable "k8s_host" {
  type    = string
  default = ""
}

variable "k8s_ca_cert" {
  type      = string
  default   = ""
  sensitive = true
}

variable "k8s_service_account" {
  type    = string
  default = "tnt-engine"
}

variable "k8s_namespace" {
  type    = string
  default = "tnt-engine"
}
