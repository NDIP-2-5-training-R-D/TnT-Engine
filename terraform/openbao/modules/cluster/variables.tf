variable "cluster_name" {
  type    = string
  default = "tnt-openbao"
}

variable "node_count" {
  type    = number
  default = 3
}

variable "config_output_dir" {
  description = "Directory to write generated config files"
  type        = string
  default     = "./generated"
}

variable "openbao_image" {
  type    = string
  default = "quay.io/openbao/openbao:2.1"
}

variable "enable_ui" {
  type    = bool
  default = true
}

variable "log_level" {
  type    = string
  default = "info"
}

variable "tls_enabled" {
  type    = bool
  default = false
}

variable "tls_cert_file" {
  type    = string
  default = ""
}

variable "tls_key_file" {
  type    = string
  default = ""
}

variable "auto_unseal_enabled" {
  type    = bool
  default = false
}

variable "auto_unseal_addr" {
  type    = string
  default = ""
}

variable "auto_unseal_token" {
  type      = string
  default   = ""
  sensitive = true
}

variable "auto_unseal_key_name" {
  type    = string
  default = "tnt-autounseal"
}
