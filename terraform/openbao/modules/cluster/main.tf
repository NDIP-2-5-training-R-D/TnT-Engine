# ── OpenBao HA Cluster Configuration ─────────────────────────────────
# Generates server configuration files for an N-node Raft HA cluster.
# These configs are used by Docker/K8s to bootstrap OpenBao nodes.
#
# In production, deploy via Helm chart (hashicorp/vault-helm with
# OpenBao image override) or this Terraform module for Docker-based infra.

# Generate server configuration for each node
resource "local_file" "openbao_config" {
  count = var.node_count

  filename = "${var.config_output_dir}/node-${count.index}/config.hcl"

  content = templatefile("${path.module}/templates/server.hcl.tpl", {
    node_id         = "node-${count.index}"
    api_addr        = "http://${var.cluster_name}-${count.index}:8200"
    cluster_addr    = "http://${var.cluster_name}-${count.index}:8201"
    cluster_name    = var.cluster_name
    node_count      = var.node_count
    cluster_nodes   = [for i in range(var.node_count) : {
      id   = "node-${i}"
      addr = "${var.cluster_name}-${i}:8201"
    }]
    enable_ui       = var.enable_ui
    log_level       = var.log_level
    tls_enabled     = var.tls_enabled
    tls_cert_file   = var.tls_cert_file
    tls_key_file    = var.tls_key_file

    # Auto-unseal
    auto_unseal_enabled  = var.auto_unseal_enabled
    auto_unseal_addr     = var.auto_unseal_addr
    auto_unseal_token    = var.auto_unseal_token
    auto_unseal_key_name = var.auto_unseal_key_name
  })

  file_permission = "0640"
}

# Generate docker-compose for HA cluster
resource "local_file" "docker_compose_ha" {
  filename = "${var.config_output_dir}/docker-compose-ha.yml"

  content = templatefile("${path.module}/templates/docker-compose-ha.yml.tpl", {
    cluster_name = var.cluster_name
    node_count   = var.node_count
    openbao_image = var.openbao_image
  })

  file_permission = "0644"
}
