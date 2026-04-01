terraform {
  required_version = ">= 1.5.0"

  required_providers {
    vault = {
      # The hashicorp/vault provider is compatible with OpenBao
      source  = "hashicorp/vault"
      version = ">= 4.0.0"
    }
    docker = {
      source  = "kreuzwerker/docker"
      version = ">= 3.0.0"
    }
  }

  # Remote state — uncomment for production
  # backend "s3" {
  #   bucket = "tnt-engine-terraform-state"
  #   key    = "openbao/terraform.tfstate"
  #   region = "ap-southeast-1"
  # }
}
