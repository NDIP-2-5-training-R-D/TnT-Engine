# AI Decision Log — T&T Engine Architecture & Infrastructure

This document records all architecture and infrastructure decisions made by the AI Team.
Maintained by [DevOps & SRE] agent per Operational Protocol.

---

## Phase 2 Decisions (R1–R4)

### D001 — HSM/PKCS#11 Integration (R1)
- **Date**: 2026-04-01
- **Decision**: Implement `HSMCryptoBackend` using PyKCS11 with session pooling
- **Rationale**: FIPS 140-2 Level 2+ compliance requires hardware-backed key storage
- **Approved by**: [Audit & SecOps], [Security Engineer]
- **Files**: `crypto/hsm.py`, `crypto/pkcs11_session.py`

### D002 — OpenBao Token Auto-Renewal (R2)
- **Date**: 2026-04-01
- **Decision**: `VaultTokenManager` with 3 auth providers (Static, AppRole, K8s)
- **Rationale**: Static tokens expire → system-wide crypto failure. Auto-renewal prevents this.
- **Approved by**: [Audit & SecOps], [Security Engineer]
- **Files**: `crypto/vault_auth.py`, `crypto/openbao.py` (refactored)

### D003 — Guaranteed Audit Delivery (R3)
- **Date**: 2026-04-01
- **Decision**: `ReliableAuditWriter` with buffer, retry, DLQ, and admin replay
- **Rationale**: Fire-and-forget audit = compliance violation. Zero-loss guarantee required.
- **Approved by**: [Audit & SecOps]
- **Files**: `service/audit_writer.py`

### D004 — Production Hardening Bundle (R4)
- **Date**: 2026-04-01
- **Decision**: Sandbox guard (EnvironmentSafetyError), ExternalSecret CRD, SecureBuffer
- **Rationale**: Defense-in-depth — prevent sandbox in prod, pull secrets from OpenBao, zero memory
- **Approved by**: [Audit & SecOps], [DevOps & SRE]
- **Files**: `crypto/sandbox.py`, `crypto/secure_memory.py`, `helm/templates/external-secret.yaml`

---

## Phase 3 Decisions (P1–P3)

### D005 — Terraform IaC for OpenBao (P1)
- **Date**: 2026-04-01
- **Decision**: Modular Terraform with 4 sub-modules (cluster, transit, policies, auth)
- **Rationale**: Infrastructure drift is unacceptable for a security-critical system. IaC = reproducible.
- **Alternatives considered**: Ansible (rejected — less state management), Pulumi (rejected — team expertise)
- **Approved by**: [DevOps & SRE], [Audit & SecOps]
- **Files**: `terraform/openbao/` (full module tree)

### D006 — Policy-as-Code with HCL (P1)
- **Date**: 2026-04-01
- **Decision**: 3 HCL policies (transit, admin, readonly) with least-privilege principle
- **Key constraints**:
  - Transit policy: NO key create/delete/export. Only encrypt/decrypt/hmac on named keys.
  - Admin policy: NO decrypt (admins cannot access plaintext PII). Key rotation + policy mgmt only.
  - Readonly policy: NO crypto operations. Metadata + health only.
- **Approved by**: [Audit & SecOps] (VETO right exercised — initial draft had decrypt in admin, removed)
- **Files**: `policies/tnt-transit.hcl`, `policies/tnt-admin.hcl`, `policies/tnt-readonly.hcl`

### D007 — HA Cluster: Raft Storage + 3 Nodes (P1)
- **Date**: 2026-04-01
- **Decision**: Integrated Raft storage (not Consul) with 3-node cluster for HA
- **Rationale**: Raft is built-in, reduces operational complexity. Consul adds a separate HA dependency.
- **Trade-offs**: Raft requires odd node count. 3 nodes = tolerates 1 failure. 5 nodes for critical prod.
- **Approved by**: [DevOps & SRE]
- **Files**: `terraform/openbao/modules/cluster/`

### D008 — HTTP Client SDK (P2)
- **Date**: 2026-04-01
- **Decision**: Standalone httpx-based Python SDK + OpenAPI spec export
- **Rationale**: Current `TNTClient` is in-process only. Cross-service integration requires HTTP client.
- **Files**: `src/tnt_engine/sdk/http_client.py`

### D009 — Auto-Unseal + Health Check Upgrade (P3)
- **Date**: 2026-04-01
- **Decision**: Transit auto-unseal config + OpenBao health in `/api/v1/health` + SoftHSM in docker-compose
- **Rationale**: Sealed OpenBao = dead system. Health check must reflect actual crypto service state.
- **Files**: `crypto/vault_health.py`, `docker-compose.yml` (updated)

---

## Phase 4 Decisions (P4–P6)

### D010 — TLS/mTLS for All Internal Connections (P4)
- **Date**: 2026-04-01
- **Decision**: Add TLS settings to config.py for DB (ssl_mode), Redis (rediss://), OpenBao (CA cert + mTLS). Shared httpx builder in `crypto/_http.py`.
- **Rationale**: All internal traffic was plaintext — credentials exposed on network. TLS defaults to disabled for backward compatibility.
- **Key constraint**: [Audit & SecOps] mandated verify-full for production DB, custom CA cert for all services.
- **Files**: `config.py`, `db/connection.py`, `cache/redis.py`, `crypto/_http.py`, `crypto/openbao.py`, `crypto/vault_auth.py`, `crypto/vault_health.py`, `helm/values-prod.yaml`, `helm/templates/deployment.yaml`

### D011 — OpenBao Backup/Restore + DR Runbooks + Alert Expansion (P5)
- **Date**: 2026-04-01
- **Decision**: Raft snapshot backup/restore scripts, 4 new Prometheus alerts (vault sealed, token renewal, audit DLQ, HSM failures), 2 new runbooks (vault-sealed-recovery, disaster-recovery).
- **Rationale**: No vault backup = unrecoverable data loss. Missing alerts = silent failures.
- **Files**: `scripts/vault-backup.sh`, `scripts/vault-restore.sh`, `monitoring/prometheus-rules.yaml`, `docs/runbooks/vault-sealed-recovery.md`, `docs/runbooks/disaster-recovery.md`, `metrics.py` (VAULT_HEALTH_SEALED gauge)

### D013 — Local Dev Environment with PKCS#11 Sealed OpenBao
- **Date**: 2026-04-01
- **Decision**: Unified Dockerfile (OpenBao + SoftHSM2) with idempotent entrypoint.sh and PKCS#11 seal config
- **Rationale**: Developers need to test HSM-backed crypto locally. Previous setup only had OpenBao dev-mode (in-memory, no seal).
- **Key design**: 
  - `entrypoint.sh` checks for existing SoftHSM tokens before init (idempotent)
  - `bao_dev.hcl.tpl` uses `seal "pkcs11"` with AES-GCM mechanism
  - Two persistent volumes: `softhsm-tokens` (Master Key) + `openbao-data` (Raft)
  - PINs passed via `.env` file (never hardcoded, never logged)
- **Approved by**: [Audit & SecOps] (verified: no PIN in logs, mlock enabled, AES-256 seal key)
- **Files**: `dev/Dockerfile.openbao-hsm`, `dev/entrypoint.sh`, `dev/bao_dev.hcl.tpl`, `dev/docker-compose.dev.yml`

### D012 — Integration Test Framework + CI Stage (P6)
- **Date**: 2026-04-01
- **Decision**: Separate `tests/integration/` directory with real infrastructure fixtures (Postgres:15432, Redis:16379, OpenBao:18200). Auto-marked `@pytest.mark.integration`. Unit tests excluded via `--ignore`.
- **Rationale**: 308 unit tests all use fakes — zero validation of real DB queries, Redis TTL, or OpenBao transit operations.
- **Trade-off**: Integration tests require docker-compose up — slower but catches real issues.
- **Files**: `tests/integration/conftest.py`, `tests/integration/test_crypto_roundtrip.py`, `tests/integration/test_db_operations.py`, `tests/integration/test_cache_consistency.py`, `ci/templates/integration.yml`
