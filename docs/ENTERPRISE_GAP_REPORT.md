# Enterprise Gap Report — T&T Engine Control Plane
**Version**: 1.0  
**Date**: 2026-04-02  
**Prepared by**: [Enterprise PO] + [Compliance & SecOps] + [Infra/DR Architect]  
**Status**: AWAITING CLIENT REVIEW

---

## Executive Summary

The T&T Engine backend has strong data-layer foundations (tenant-scoped DB, reliable audit writer, crypto abstraction). However, the Control Plane (Next.js dashboard) operates as a **single-admin, unauthenticated console** with no approval workflows, no SIEM integration, and minimal disaster recovery automation. It is **suitable for lab/dev environments only** in its current state.

**Enterprise readiness: 2 of 4 pillars are CRITICAL gaps.**

---

## Pillar A: Access Governance (Maker-Checker)

### Current State: CRITICAL GAP

| Capability | Status | Evidence |
|---|---|---|
| User authentication | MISSING | No middleware.ts, no NextAuth, no JWT, no cookies. Layout shows hardcoded "Admin" badge. |
| RBAC enforcement | DEFINED BUT UNUSED | `Role = "admin" \| "operator" \| "viewer"` in types.ts. Backend has `AccessControl` class with 3 roles + permission matrix. **Neither is wired into any route.** |
| Maker-Checker workflow | NOT IMPLEMENTED | All mutation endpoints (seal, rotate, init, policy save, secret_id generate) execute immediately on `X-Confirm-Action` header match. No pending state, no second approver. |
| Audit of admin actions | PARTIAL | Console.log only: `[AUDIT] Unseal attempt | reason="..."`. Not persisted, not queryable. |
| Multi-admin support | NOT IMPLEMENTED | Single implicit user. No sessions, no user identity. |

### What Must Be Built

1. **Authentication layer**: NextAuth.js (or custom JWT) with user sessions
2. **Role-based route guards**: Middleware checking role before mutations
3. **Approval queue**: Database table for pending actions + approve/reject flow
4. **Action audit trail**: Persist who requested, who approved, timestamp, reason

### Risk if Not Addressed

> Any operator with network access can seal the vault, rotate keys, or generate secret IDs without oversight. This violates SOC2 CC6.1 (Logical Access Controls) and PCI-DSS 8.6 (Multi-factor for admin access).

---

## Pillar B: Multi-Tenancy / Namespace Isolation

### Current State: PARTIAL (Data-layer only)

| Capability | Status | Evidence |
|---|---|---|
| Tenant-scoped data | IMPLEMENTED | All DB queries: `WHERE tenant_id = $1`. Cache keys: `{tenant_id}:{hash}`. Audit entries include `tenant_id`. |
| Tenant-scoped quotas | IMPLEMENTED | `QuotaManager` tracks per-tenant monthly limits. |
| Tenant feature flags | IMPLEMENTED | `FeatureFlags` supports per-tenant overrides. |
| OpenBao namespace headers | NOT IMPLEMENTED | `vault-client.ts` never sends `X-Vault-Namespace`. All keys/policies in default namespace. |
| UI namespace switcher | NOT IMPLEMENTED | No dropdown, no context, no routing. |
| Per-namespace keys/policies | NOT IMPLEMENTED | Key listing shows all keys regardless of tenant. |

### What Must Be Built

1. **Namespace context**: Add `namespace` param to `vault-client.ts` → `X-Vault-Namespace` header
2. **UI Switcher**: Sidebar dropdown for namespace selection, persisted in session
3. **Scoped views**: Keys, policies, AppRoles filtered by selected namespace

### Risk if Not Addressed

> HR department keys visible to Finance department operators. Violates principle of least privilege (NIST SP 800-53 AC-6).

---

## Pillar C: Disaster Recovery

### Current State: MINIMAL

| Capability | Status | Evidence |
|---|---|---|
| Manual Raft backup | IMPLEMENTED | `POST /api/keys/backup` downloads snapshot. Rate limited 1/5min. |
| Backup scripts | IMPLEMENTED | `scripts/vault-backup.sh` (Raft), `scripts/db-backup.sh` (pg_dump). |
| DR runbooks | IMPLEMENTED | `docs/runbooks/disaster-recovery.md` with RPO/RTO targets. |
| Scheduled backups | NOT IMPLEMENTED | Scripts exist but no cron/scheduler in the application. |
| Backup history/listing | NOT IMPLEMENTED | No metadata store, no versioning, no UI list. |
| Restore UI | NOT IMPLEMENTED | CLI-only restore (`vault-restore.sh`). |
| Backup verification | NOT IMPLEMENTED | No checksum validation, no test-restore capability. |
| Backup encryption | NOT IMPLEMENTED | Snapshots stored unencrypted. |
| Off-site replication | NOT CONFIGURED | Scripts have S3/GCS comments but disabled. |

### What Must Be Built

1. **Scheduled backup worker**: Cron-based (node-cron or API trigger) with configurable interval
2. **Backup metadata store**: Track timestamp, size, checksum, storage location
3. **Backup history UI**: List past backups with status, size, age
4. **Restore UI**: Upload snapshot or select from history → confirm → execute → verify
5. **Backup verification**: Periodic test-restore to validate backup integrity

### Risk if Not Addressed

> RPO/RTO targets (4h/1h for Vault) are aspirational — no automated mechanism enforces them. A DR event requires manual SSH + script execution.

---

## Pillar D: External Audit / SIEM Integration

### Current State: CRITICAL GAP

| Capability | Status | Evidence |
|---|---|---|
| Audit log capture | IMPLEMENTED | `ReliableAuditWriter` with buffer, retry, DLQ. 7 action types tracked. |
| Audit persistence | IMPLEMENTED | PostgreSQL `audit_log` table, immutable, indexed. |
| Audit query API | PARTIAL | `query_audit()` method exists in repository but NOT exposed via admin API. |
| CEF export | NOT IMPLEMENTED | No CEF formatter, no CEF headers. |
| Splunk HEC | NOT IMPLEMENTED | No HTTP Event Collector integration. |
| Elasticsearch bulk | NOT IMPLEMENTED | No ES client, no index templates. |
| Syslog RFC 5424 | NOT IMPLEMENTED | No syslog formatter or forwarder. |
| Real-time streaming | NOT IMPLEMENTED | Audit writes to DB only. No Kafka/NATS/SQS publish. |
| Signed audit logs | NOT IMPLEMENTED | No HMAC chain, no tamper evidence. |
| Retention policy | NOT IMPLEMENTED | No automatic pruning or archival. |

### What Must Be Built

1. **SIEM export API**: `GET /api/audit/export?format=cef&since=...` with CEF and JSON-SIEM formats
2. **Real-time webhook**: Configurable webhook endpoint for audit events (Splunk HEC, Elastic, custom)
3. **Audit query endpoint**: Expose `query_audit()` via admin API with filters (tenant, action, date range)
4. **Retention policy**: Configurable auto-archive/delete after N days

### Risk if Not Addressed

> Compliance auditors (SOC2, PCI-DSS, HIPAA) require centralized log management with tamper-evident audit trails. Local DB-only storage is insufficient for regulatory audits.

---

## Consolidated Scorecard

| Pillar | Score | Enterprise Target | Gap |
|---|---|---|---|
| **A. Access Governance** | 1/10 | Maker-Checker + RBAC + MFA | Auth, RBAC, approval queue |
| **B. Multi-Tenancy** | 5/10 | Full namespace isolation | Vault namespace headers, UI switcher |
| **C. Disaster Recovery** | 3/10 | Automated + verified backups | Scheduler, history, restore UI |
| **D. Audit/SIEM** | 2/10 | CEF + real-time export | Export formats, webhook, query API |

---

## Recommended Implementation Priority

| Priority | Pillar | Module | Justification |
|---|---|---|---|
| **P0** | A | Authentication + RBAC middleware | Cannot deploy without knowing WHO is performing actions |
| **P0** | D | SIEM Export API (CEF + JSON) | Compliance audit requirement — auditors need centralized logs |
| **P1** | A | Maker-Checker approval queue | Dual-control for destructive operations (SOC2 CC6.1) |
| **P1** | C | Scheduled backups + backup history UI | Automated DR enforcement (RPO compliance) |
| **P2** | B | Namespace context switcher | Multi-team isolation |
| **P2** | C | Restore UI + backup verification | Full DR lifecycle |
| **P3** | D | Real-time webhook + retention | Advanced SIEM integration |

---

## Sign-off

| Agent | Verdict |
|---|---|
| [Enterprise PO] | Report accepted. Recommend starting with Pillar A (Auth) and D (SIEM). |
| [Compliance & SecOps] | VETO on production deployment without P0 items addressed. |
| [Infra/DR Architect] | DR automation (P1) must follow immediately after auth. |
| [Fullstack Engineer] | Ready to implement. Recommend NextAuth.js + SQLite for approval queue. |
