variable "transit_key_name" {
  type = string
}

variable "transit_hmac_key_name" {
  type = string
}

variable "transit_key_type" {
  type    = string
  default = "aes256-gcm96"
}

variable "transit_min_decryption_version" {
  type    = number
  default = 1
}

variable "transit_allow_deletion" {
  type    = bool
  default = false
}
