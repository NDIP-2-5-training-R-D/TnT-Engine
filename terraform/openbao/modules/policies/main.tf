# ── Policy-as-Code ──────────────────────────────────────────────────
# Loads HCL policy files from the policies/ directory and provisions
# them in OpenBao. Policies are environment-aware.

resource "vault_policy" "transit" {
  name   = "tnt-transit"
  policy = templatefile("${path.module}/../../../../policies/tnt-transit.hcl", {})
}

resource "vault_policy" "admin" {
  name   = "tnt-admin"
  policy = templatefile("${path.module}/../../../../policies/tnt-admin.hcl", {})
}

resource "vault_policy" "readonly" {
  name   = "tnt-readonly"
  policy = templatefile("${path.module}/../../../../policies/tnt-readonly.hcl", {})
}

# ── Audit Device ────────────────────────────────────────────────────
# Enable file-based audit logging for compliance

resource "vault_audit" "file" {
  count = var.environment != "development" ? 1 : 0

  type = "file"

  options = {
    file_path = "/var/log/openbao/audit.log"
    log_raw   = false  # Never log raw request/response bodies
  }
}
