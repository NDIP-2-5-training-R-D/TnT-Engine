# OpenBao server configuration (used for non-dev / production-like deployments)
# In docker-compose.yml we use -dev mode; this file is a reference for hardened setups.

ui = false

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true   # Enable TLS in production
}

storage "file" {
  path = "/openbao/data"
}

api_addr     = "http://0.0.0.0:8200"
cluster_addr = "http://0.0.0.0:8201"
