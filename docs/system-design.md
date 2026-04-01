# T&T Engine — System Design Document

**Version**: 0.6.0
**Classification**: Internal — Architecture Review
**Last Updated**: 2026-04-01
**Author**: Platform Engineering Team

---

## 1. Executive Summary

The T&T Engine is an enterprise-grade PII tokenization platform that replaces sensitive data with deterministic, non-reversible-by-design tokens. It enables downstream systems to operate on tokenized data without exposure to plaintext PII, satisfying GDPR, PCI-DSS, and internal data governance requirements.

**Key capabilities:**

- **Convergent tokenization** — same plaintext always produces the same token within a tenant, enabling joins and deduplication on tokenized data
- **Multi-tenant isolation** — every operation is scoped by tenant_id at the database, cache, and cryptographic layers
- **Lifecycle management** — tokens can be revoked (compliance hold) or deleted (GDPR right to erasure)
- **Data governance** — classification-based policy enforcement prevents misuse of high-sensitivity fields
- **High throughput** — 3-layer cache (in-memory → Redis → PostgreSQL) with batch processing and async I/O
- **Runtime control** — feature flags, dynamic configuration, and admin API enable operational changes without redeployment

**Value proposition:** Consuming services integrate via a clean SDK and never handle plaintext PII, raw encryption keys, or database connections. All complexity is abstracted behind a single `tokenize(value, field, tenant_id)` call.

---

## 2. System Overview

### 2.1 Business Goals

- Centralize PII protection across all services in the organization
- Achieve compliance with GDPR, PCI-DSS, and internal data classification policies
- Enable analytics and data processing on tokenized datasets without PII exposure
- Provide a self-service platform that teams adopt without security team involvement per integration

### 2.2 Technical Goals

- Sub-100ms p99 latency for single tokenize/detokenize operations
- Support >= 5,000 requests/second per instance with horizontal scaling
- Zero plaintext PII in storage, logs, or transit between internal components
- Strong consistency for token creation (no duplicate tokens)
- Immediate enforcement of revoke/delete operations
- Zero-downtime deployments and schema migrations

---

## 3. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              CONSUMERS                                       │
│   Dev A (Business Apps)                    Dev B (Crypto Plugins)            │
│   ─ SDK: tokenize / detokenize            ─ Implements CryptoBackend        │
│   ─ PolicyEngine: process_record           ─ Plugs into CircuitBreaker      │
└──────────────────────────┬───────────────────────────────────────────────────┘
                           │
            ┌──────────────▼───────────────┐
            │     FastAPI (API Gateway)     │
            │  /api/v1  /api/v2  /admin    │
            │                              │
            │  Middleware Stack:            │
            │   Metrics → Guardrails →     │
            │   Backpressure → Routing     │
            └──────┬────────┬──────────────┘
                   │        │
        ┌──────────▼──┐  ┌──▼──────────────┐
        │ PolicyEngine│  │  TokenService    │
        │ (governance │  │  (core engine)   │
        │  + masking) │  │                  │
        └─────────────┘  └──┬──────────────┘
                            │
           ┌────────────────┼────────────────┐
           │                │                │
    ┌──────▼──────┐  ┌─────▼──────┐  ┌──────▼──────────┐
    │ LayeredCache │  │ Repository │  │ CryptoBackend   │
    │ L1→L2→DB    │  │ (tenant-   │  │ (HMAC+Encrypt)  │
    │             │  │  scoped)   │  │                  │
    └──────┬──────┘  └─────┬──────┘  └──────┬──────────┘
           │               │                │
    ┌──────▼──────┐  ┌─────▼──────┐  ┌──────▼──────────┐
    │ L1: Memory  │  │ PostgreSQL │  │ CircuitBreaker   │
    │ L2: Redis   │  │ (Primary)  │  │ → OpenBao Transit│
    │             │  │ (Replica)  │  │                  │
    └─────────────┘  └────────────┘  └─────────────────┘

    ┌─── Background Workers ──────────────────────────────┐
    │ CleanupWorker    — expire tokens + prune dedup      │
    │ ReencryptWorker  — key rotation re-encryption       │
    │ CacheRebuildWorker — warm caches after cold start   │
    │ ReconciliationWorker — data integrity validation    │
    └─────────────────────────────────────────────────────┘
```

### 3.1 Component Summary

| Component | Technology | Role |
|---|---|---|
| API Gateway | FastAPI + Starlette middleware | Request routing, metrics, guardrails, backpressure |
| TokenService | Python async | Core tokenization logic, idempotency, lifecycle |
| PolicyEngine | Python | Governance-aware field routing (TOKENIZE/MASK/HASH/PASSTHROUGH) |
| LayeredCache | In-memory LRU + Redis | 3-layer write-through cache for token lookups |
| Repository | asyncpg | Tenant-scoped data access with read replica routing |
| CryptoBackend | httpx → OpenBao | HMAC computation + transit encryption/decryption |
| CircuitBreaker | Custom state machine | Protects against cascading crypto service failures |
| EventBus | In-process async | Decoupled event emission with deduplication |
| Workers | asyncio tasks | Background maintenance (expire, re-encrypt, rebuild, reconcile) |

---

## 4. Core Tokenization Logic

### 4.1 Cryptographic Approach

The platform uses **HMAC via the OpenBao Transit engine** for convergent tokenization lookups, and **Transit encryption** for value storage.

**HMAC (Keyed Hash Message Authentication Code):**
- Computed by OpenBao's transit backend using a named HMAC key
- Input: base64(normalized_plaintext) → Output: deterministic hash string
- The HMAC serves as the lookup key in `token_lookup` — same plaintext always produces the same hash within the same key

**Transit Encryption:**
- The plaintext is encrypted via OpenBao's `/transit/encrypt` endpoint
- Output format: `vault:v{N}:{ciphertext}` where N is the key version
- The key version is stored alongside the ciphertext, enabling future key rotation

### 4.2 Why HMAC + Transit Encryption (Not AES Directly)

| Consideration | HMAC + Transit | Direct AES |
|---|---|---|
| Key management | Delegated to OpenBao (HSM-backed) | Application must manage keys |
| Key rotation | Transparent via key versioning | Requires application re-encryption logic |
| Convergent lookup | HMAC is deterministic — enables O(1) lookup | AES-GCM is non-deterministic (different ciphertext each time) |
| Separation of concerns | Application never sees raw keys | Application holds key material |
| Audit | OpenBao provides key access audit trail | No built-in audit |
| Trade-off | Extra network hop per crypto operation (~5ms) | Lower latency but higher risk |

### 4.3 Deterministic Behavior

For the same `(plaintext, tenant_id)` pair:
1. The plaintext is NFC-normalized and whitespace-stripped
2. The HMAC is computed → always the same hash for the same input
3. The hash is used as the primary key in `token_lookup(hash, tenant_id)`
4. The database UNIQUE constraint guarantees exactly one token per (hash, tenant_id)

**Result:** Multiple calls with the same input always return the same token. This is the convergent tokenization invariant.

### 4.4 Security Properties

- **Non-reversible from token alone** — the token (e.g., `tok_A3f8x...`) contains no information about the plaintext
- **Reversible only with DB + crypto key** — detokenization requires both the encrypted ciphertext (in DB) and the transit key (in OpenBao)
- **Tenant isolation** — HMAC is scoped by tenant via the lookup table's composite key, so the same plaintext for different tenants produces different tokens
- **Key rotation support** — each ciphertext stores its key version; re-encryption worker upgrades old versions transparently

---

## 5. Data Flow

### 5.1 Tokenization Flow

```
Client                   API              TokenService         Cache        DB          OpenBao
  │                       │                    │                 │           │             │
  │── POST /tokenize ────▶│                    │                 │           │             │
  │                       │── tokenize(req) ──▶│                 │           │             │
  │                       │                    │── dedup check ─▶│           │             │
  │                       │                    │◀─ miss ─────────│           │             │
  │                       │                    │── normalize ────│           │             │
  │                       │                    │── HMAC ─────────│───────────│────────────▶│
  │                       │                    │◀─ hash ─────────│───────────│◀────────────│
  │                       │                    │── get(hash) ───▶│           │             │
  │                       │                    │◀─ L1 miss ──────│           │             │
  │                       │                    │─────────────────│──get(h)─▶│             │
  │                       │                    │◀────────────────│◀─ miss ──│             │
  │                       │                    │─────────────────│──────────│── find() ──▶│
  │                       │                    │◀────────────────│──────────│◀─ null ─────│
  │                       │                    │── encrypt ──────│───────────│────────────▶│
  │                       │                    │◀─ ciphertext ───│───────────│◀────────────│
  │                       │                    │── upsert_token ─│───────────│─────────────│
  │                       │                    │◀─ winning_token ─│──────────│             │
  │                       │                    │── set(hash,tok)▶│           │             │
  │                       │                    │── set_dedup ────│───────────│             │
  │                       │◀─ TokenizeResponse │                 │           │             │
  │◀─ 200 {token} ────────│                    │                 │           │             │
```

### 5.2 Detokenization Flow

```
Client                   API              TokenService         DB          OpenBao
  │                       │                    │                 │             │
  │── POST /detokenize ──▶│                    │                 │             │
  │                       │── detokenize() ───▶│                 │             │
  │                       │                    │── validate fmt ─│             │
  │                       │                    │── get_record ───│────────────▶│
  │                       │                    │◀─ TokenRecord ──│◀────────────│
  │                       │                    │── check status ─│             │
  │                       │                    │   (ACTIVE ok,   │             │
  │                       │                    │    REVOKED/      │             │
  │                       │                    │    EXPIRED fail) │             │
  │                       │                    │── decrypt ───────│────────────▶│
  │                       │                    │◀─ plaintext ─────│◀────────────│
  │                       │◀─ plaintext ───────│                 │             │
  │◀─ 200 {value} ────────│                    │                 │             │
```

**Critical note:** Detokenize always reads from DB (not cache) to enforce revoke/expire status immediately.

---

## 6. System Layers

### 6.1 API Layer

Three versioned routers:

| Router | Prefix | Purpose |
|---|---|---|
| v1 | `/api/v1` | Core tokenize/detokenize/batch/lifecycle/policy endpoints |
| v2 | `/api/v2` | v1 + quota enforcement + event emission + usage headers |
| Admin | `/admin` | Runtime control: feature flags, config, quotas, cache rebuild |

Middleware stack (applied outermost-first):
1. **MetricsMiddleware** — Prometheus request count + latency + trace ID propagation
2. **GuardrailsMiddleware** — Reject bodies > 1MB, enforce 30s timeout
3. **BackpressureMiddleware** — Shed requests when in-flight > 200 concurrent (returns 503 + Retry-After)

### 6.2 Processing Layer

**TokenService** — stateless, async, handles all orchestration:
- Normalization (NFC Unicode + whitespace strip)
- 3-layer cache lookup
- Concurrency-safe upsert with race resolution
- Batch deduplication within a single request
- Lifecycle status enforcement

**PolicyEngine** — governance-aware field router:
- Parses `{field, action}` policies
- Enforces data classification rules (HIGH_SENSITIVE can only TOKENIZE)
- Batches TOKENIZE fields automatically for efficiency

### 6.3 Cache Layer

| Layer | Technology | Latency | Scope | Survives Restart |
|---|---|---|---|---|
| L1 | In-memory LRU (10K entries, 5min TTL) | < 1μs | Per-pod | No |
| L2 | Redis (1hr TTL, 50 connections) | 1-5ms | Shared across pods | Yes |
| L3 | PostgreSQL | 5-50ms | Source of truth | Yes |

**Cache key format:** `{tenant_id}:{hmac_hash}`

**Write-through:** Both L1 and L2 are updated on every new token creation.

**Never authoritative for lifecycle:** Detokenize always checks DB for REVOKED/EXPIRED status.

### 6.4 Storage Layer

**PostgreSQL 16** with:
- Connection pooling: asyncpg with 10–50 connections per pool
- Read replica routing: read queries use `read_pool`, writes use `pool`
- Statement timeout: 10 seconds
- Concurrency-safe upsert via PL/pgSQL function
- `SKIP LOCKED` for worker batch operations (multi-replica safe)

### 6.5 Crypto Layer

**Abstraction:** `CryptoBackend` interface (ABC) with `hmac()`, `encrypt()`, `decrypt()`, `close()`

**Production implementation:** `OpenBaoCryptoBackend` — HTTP client to OpenBao Transit API

**Development implementation:** `SandboxCryptoBackend` — local SHA-256 + base64 (no external service needed)

**Protection:** `CircuitBreakerBackend` wraps any backend with 3-state FSM (CLOSED → OPEN → HALF_OPEN)

---

## 7. Data Consistency & Idempotency

### 7.1 Consistency Model

| Operation | Consistency Level | Mechanism |
|---|---|---|
| Tokenize (write) | **Strong** | `upsert_token()` PL/pgSQL function serializes at (hash, tenant_id) |
| Detokenize (read) | **Strong** | Always reads DB for current status; never trusts cache for lifecycle |
| Cache | **Eventually consistent** | Write-through with TTL; DB is always authoritative |
| Revoke / Delete | **Immediately consistent in DB** | Cache entries may linger briefly (up to TTL) but detokenize checks DB first |
| Audit log | **Best-effort** | Async fire-and-forget; small window where operation succeeded but audit not yet written |
| Events | **At-least-once** | Unique `event_id` for consumer-side dedup |

### 7.2 Idempotency

**Mechanism:** Request hash deduplication

1. `SHA256(operation:tenant_id:value:field)` → deterministic request hash
2. Before processing: check `request_dedup` table for cached response
3. On cache hit: return stored response immediately (no crypto calls, no DB writes)
4. On cache miss: process normally, then store response in dedup table
5. Background worker prunes entries older than 1 hour

### 7.3 Concurrency Safety

When two requests for the same `(plaintext, tenant_id)` arrive simultaneously:

1. Both compute the same HMAC hash
2. Both miss cache and DB
3. Both generate different random tokens
4. Both call `upsert_token()` — the DB function uses `INSERT ON CONFLICT`:
   - First to insert wins (creates token_lookup + token_store rows)
   - Second gets the existing token from the SELECT fallback
5. Both return the **same** token (the winner's)
6. `CONFLICT_RESOLVED` counter increments for observability

---

## 8. Performance & Scalability

### 8.1 Caching Strategy

- **Cache-first reads:** L1 → L2 → DB reduces DB load by 80%+ in steady state
- **Write-through:** New tokens are immediately available in all cache layers
- **Cold start warmup:** CacheRebuildWorker scans `token_lookup` and pre-populates L1 + L2
- **Hot key protection:** L1 LRU keeps frequently accessed tokens in-process

### 8.2 Batch Processing

- **Within-batch deduplication:** Duplicate values in a single batch are detected by HMAC hash — only one encrypt + insert per unique value
- **Parallel HMAC:** All HMAC computations in a batch run concurrently via `asyncio.gather()`
- **Batch DB upsert:** All inserts happen in a single transaction
- **Batch cache backfill:** `set_multi()` for both L1 and L2

### 8.3 Horizontal Scaling

- **Stateless pods:** No in-process state except L1 cache (which is per-pod and disposable)
- **HPA:** Kubernetes autoscaler scales 3–20 pods based on CPU (70%) or custom metric (500 req/s/pod)
- **Read replicas:** Read queries route to replicas, reducing primary DB load
- **Connection pooling:** 50 connections per pool per pod; k8s limits total via HPA max

### 8.4 Performance Targets

| Metric | Target | Measured By |
|---|---|---|
| Tokenize p99 | < 200ms | `tnt_tokenize_seconds` histogram |
| Detokenize p99 | < 100ms | `tnt_detokenize_seconds` histogram |
| Cache hit rate | > 80% | `tnt_l1_cache_hits_total / (hits + misses)` |
| Error rate | < 1% | `tnt_http_requests_total{status=~"5.."}` |
| Throughput | >= 5,000 req/s per pod | `tnt_http_requests_total` rate |

---

## 9. Runtime Control

### 9.1 Feature Flags

| Flag | Default | Purpose |
|---|---|---|
| `enable_tokenization` | true | Master switch for tokenize operations |
| `enable_detokenization` | true | Master switch for detokenize operations |
| `enable_cache` | true | Toggle L1 + L2 cache |
| `enable_dedup` | true | Toggle idempotency layer |
| `enable_audit` | true | Toggle audit log writes |
| `sandbox_mode` | false | Use mock crypto (no OpenBao calls) |

Flags support **per-tenant overrides** — a flag can be disabled globally but enabled for a specific tenant (or vice versa).

**Update mechanism:** `POST /admin/flags` — no restart required.

### 9.2 Dynamic Configuration

Runtime-tunable parameters (no restart):

| Parameter | Default | Tunable Via |
|---|---|---|
| `cache_ttl_seconds` | 3600 | `POST /admin/config` |
| `crypto_max_retries` | 3 | `POST /admin/config` |
| `rate_limit_max_requests` | 5000 | `POST /admin/config` |
| `cleanup_batch_size` | 1000 | `POST /admin/config` |
| `soft_delete_purge_after_days` | 30 | `POST /admin/config` |

---

## 10. Security Design

### 10.1 Key Management

- **Key storage:** OpenBao Transit engine (HSM-backed in production)
- **Key access:** Short-lived Vault tokens with scoped policies
- **Key rotation:** Transparent — new encryptions use latest key version; old ciphertexts store their version number; ReencryptWorker re-encrypts old versions in background
- **Application key exposure:** NEVER — the application never sees raw encryption keys; all crypto operations go through the OpenBao API

### 10.2 No Plaintext Exposure

| Layer | Protection |
|---|---|
| Storage (DB) | Only ciphertext stored; plaintext encrypted before any INSERT |
| Cache (Redis) | Stores only `hmac_hash → token` mappings; never plaintext or ciphertext |
| Logs | PII masking processor strips SSN, CC, email patterns from all log output |
| API responses | Token values only; plaintext returned only from authenticated detokenize calls |
| Events | Contain token prefixes and field names only; never plaintext |

### 10.3 Access Control

| Role | Can Do | Cannot Do |
|---|---|---|
| TOKENIZER | Tokenize, Mask, Process | Detokenize, Revoke, Delete |
| DETOKENIZER | All of TOKENIZER + Detokenize | Revoke, Delete |
| ADMIN | All operations | — |

### 10.4 Data Governance

| Sensitivity Level | Fields | Allowed Actions |
|---|---|---|
| HIGH_SENSITIVE | SSN, credit card, passport, bank account | TOKENIZE only |
| MEDIUM | Email, phone, date of birth | TOKENIZE, MASK, HASH |
| LOW | Name, address, city | All including PASSTHROUGH |
| UNCLASSIFIED | Unknown fields | TOKENIZE, MASK, HASH (no PASSTHROUGH) |

Governance is enforced at the PolicyEngine layer — Dev A cannot bypass it.

### 10.5 Tenant Isolation

Every layer enforces tenant boundaries:
- **Database:** `token_lookup` primary key is `(hash, tenant_id)` — different tenants get different tokens for the same plaintext
- **Cache:** Key format `{tenant_id}:{hmac_hash}` — no cross-tenant cache pollution
- **Repository:** Every query includes `AND tenant_id = $N` — no path to access another tenant's data
- **Rate limiting:** Per-tenant sliding window
- **Quotas:** Per-tenant monthly operation limits

---

## 11. Failure Handling & Resilience

### 11.1 Dependency Failure Matrix

| Dependency | Failure Mode | System Behavior | User Impact |
|---|---|---|---|
| PostgreSQL | Down | Tokenize fails. Detokenize fails for cache misses. | 503 for writes; cached tokens still readable |
| PostgreSQL | Slow | Statement timeout at 10s. Backpressure sheds excess. | Some 503s; others succeed slowly |
| Redis | Down | L2 cache bypassed. L1 + DB still work. | Higher latency (+5ms); no data loss |
| OpenBao | Down | Circuit breaker opens after 5 failures. | Tokenize: 503 fast-fail. Detokenize: works (uses stored ciphertext) |
| OpenBao | Slow | 5s timeout + 3 retries with exponential backoff. | Tokenize latency up to 15s before failing |

### 11.2 Backpressure

- **Mechanism:** In-flight request counter in middleware
- **Threshold:** 200 concurrent requests (configurable)
- **Behavior:** Returns 503 + `Retry-After: 1` header
- **Exempt:** Health, readiness, and metrics endpoints always pass

### 11.3 Kill Switch

Feature flags act as kill switches:
- `enable_tokenization: false` → disables all tokenize operations instantly
- `enable_cache: false` → bypasses cache (useful during cache corruption debugging)
- `sandbox_mode: true` → switches to local mock crypto (no OpenBao calls)

All toggleable at runtime via `POST /admin/flags` — no restart needed.

### 11.4 Graceful Shutdown

1. K8s sends SIGTERM → readiness probe starts failing (no new traffic routed)
2. ShutdownCoordinator sets `draining=true`
3. 5-second drain window for in-flight requests to complete
4. Workers stopped (CleanupWorker, etc.)
5. Connections closed (Circuit breaker → Redis → DB)
6. Pod terminates cleanly

---

## 12. Data Lifecycle

### 12.1 Token States

```
  ACTIVE ──── (time-based) ────▶ EXPIRED
    │
    └──── (manual revoke) ─────▶ REVOKED
    │
    └──── (GDPR delete) ───────▶ [hard deleted — cascade removes lookup]
```

### 12.2 Retention Policy

| Data | Default Retention | Configurable |
|---|---|---|
| Active tokens | Indefinite (or TTL if set at creation) | Per-request `ttl_seconds` |
| Expired tokens | Indefinite (status change, data preserved) | Background cleanup |
| Revoked tokens | Indefinite (status change, data preserved) | Background cleanup |
| Dedup cache | 1 hour | `dedup_ttl_seconds` |
| Audit log | Indefinite (append-only) | External archival policy |

### 12.3 GDPR Right to Erasure

`DELETE /api/v1/token/delete` → hard deletes `token_store` row + cascades to `token_lookup`. The encrypted value and lookup hash are permanently removed. Audit entries (which contain no plaintext) are preserved for compliance trail.

---

## 13. Observability

### 13.1 Metrics (Prometheus)

| Category | Key Metrics |
|---|---|
| Request | `tnt_http_requests_total`, `tnt_http_request_duration_seconds` |
| Tokenize | `tnt_tokenize_seconds`, `tnt_detokenize_seconds`, `tnt_tokens_created_total` |
| Cache | `tnt_l1_cache_hits_total`, `tnt_l1_cache_misses_total` |
| Database | `tnt_db_operation_duration_seconds`, `tnt_db_errors_total` |
| Redis | `tnt_redis_operation_duration_seconds`, `tnt_redis_errors_total` |
| Crypto | `tnt_crypto_operation_duration_seconds`, `tnt_crypto_errors_total` |
| Resilience | `tnt_inflight_requests`, `tnt_requests_shed_total`, `tnt_guardrail_rejected_total` |
| Events | `tnt_events_published_total`, `tnt_events_deduplicated_total` |
| Business | `tnt_conflict_resolved_total`, `tnt_dedup_hits_total`, `tnt_lifecycle_ops_total` |

### 13.2 Logging

- **Format:** Structured JSON via structlog
- **PII protection:** Masking processor strips SSN, credit card, email patterns from all string fields
- **Trace correlation:** `trace_id` injected from contextvars into every log line
- **Centralized collection:** Loki + Promtail with JSON parsing pipeline

### 13.3 Tracing

- **Mechanism:** `trace_id` propagated via `X-Trace-ID` header and contextvars
- **Scope:** API → Service → Repository → Audit → Events
- **Correlation:** Same `trace_id` links request log, audit entry, and emitted events

### 13.4 Alerting

8 Prometheus alert rules enforcing SLOs:
- CRITICAL: error rate > 1%, circuit breaker open, < 50% pods available
- WARNING: p99 latency > 200ms, cache hit < 80%, DB/Redis slow

---

## 14. Event-Driven Design

### 14.1 Emitted Events

| Event | Emitted When | Data |
|---|---|---|
| `TOKEN_CREATED` | New token created (v2 API) | `token_prefix`, `field` |
| `BATCH_TOKEN_CREATED` | Batch tokenize (v2 API) | `count` |
| `TOKEN_REVOKED` | Token revoked (v2 API) | `token_prefix` |
| `TOKEN_DELETED` | Token hard-deleted (v2 API) | `token_prefix` |

### 14.2 Event Guarantees

- **Delivery:** At-least-once (unique `event_id` per event for consumer dedup)
- **Handler isolation:** Handler failures are logged but never fail the publisher
- **Dedup window:** 10K event_ids tracked in LRU; duplicates silently dropped

### 14.3 Extension Path

Current: in-process EventBus. Future: swap for Kafka/Redis Streams publisher. The `Event` dataclass and `EventHandler` type are stable interfaces — consumers don't change when the transport changes.

---

## 15. Replay & Recovery

### 15.1 Cache Recovery

- **Cold start:** CacheRebuildWorker scans `token_lookup JOIN token_store WHERE status='ACTIVE'` and populates L1 + L2 in batches
- **Redis flush:** Same worker, triggered manually via `POST /admin/cache/rebuild`
- **Lazy warmup:** Cache misses naturally backfill from DB on every request

### 15.2 Key Rotation Recovery

- **ReencryptWorker:** Fetches tokens with `key_version < target`, decrypts with old key, re-encrypts with current key, updates DB
- **Uses `SKIP LOCKED`** for safe multi-replica operation
- **Metrics:** `tnt_reencrypt_total`, `tnt_reencrypt_errors_total`

### 15.3 Data Integrity Validation

- **ReconciliationWorker:** Read-only scan that decrypts stored ciphertexts and verifies HMAC consistency
- **Detects:** Ciphertext corruption, missing lookup entries, HMAC mismatches
- **Output:** `ReconciliationReport` with `is_clean` flag and error details

---

## 16. Deployment Architecture

### 16.1 Kubernetes

- **Deployment:** 3 replicas with `RollingUpdate` (`maxSurge=1`, `maxUnavailable=0`)
- **HPA:** 3–20 pods, scales on CPU 70% or 500 req/s/pod
- **PDB:** `minAvailable=2` during voluntary disruptions
- **Security:** Non-root, read-only filesystem, drop all capabilities
- **Network Policy:** Ingress from nginx + monitoring only; egress to PG/Redis/OpenBao/DNS only

### 16.2 CI/CD (GitLab)

```
Feature branch:  validate (lint+test+types) → security (SAST+deps)  [stops]
main branch:     validate → security → build → scan → deploy_dev → verify → deploy_staging → verify
git tag (v*):    validate → security → build → scan → deploy_prod (MANUAL) → verify
```

- **Build:** Multi-stage Docker image → GitLab Container Registry
- **Deploy:** Helm `upgrade --install --atomic` (auto-rollback on failed rollout)
- **Rollback:** One-click `helm rollback` via manual pipeline job

### 16.3 Helm Chart

Per-environment values:
- **dev:** 2 replicas, no HPA, relaxed resources
- **staging:** 3 replicas, mirrors production sizing
- **prod:** 3–30 replicas, TLS, read replica, 500m–2 CPU, 512Mi–1Gi memory

---

## 17. Multi-Tenancy

### 17.1 Isolation

| Layer | Mechanism |
|---|---|
| Database | Composite PK `(hash, tenant_id)` — no cross-tenant collision |
| Cache | Key format `{tenant_id}:{hash}` |
| Rate limiting | Per-tenant sliding window (5,000 req/60s default) |
| Quotas | Per-tenant monthly operation limits |
| Feature flags | Per-tenant overrides |
| Audit | `tenant_id` column — all queries filtered |

### 17.2 Tenant Onboarding

No code changes required. Tenants are implicitly created on first request — the `tenant_id` is a string field provided by the caller. Quotas and rate limits default to unlimited; operators set explicit limits via the admin API.

---

## 18. Future Scalability

### 18.1 Multi-Region Readiness

| Capability | Current State | Extension Path |
|---|---|---|
| Read replicas | Supported (per-region replicas) | Configure `db_read_host` per region |
| Convergent hashing | Deterministic (works cross-region) | Same HMAC key in all regions |
| Event propagation | In-process bus | Swap for cross-region Kafka |
| Idempotent operations | Request dedup | Safe to retry across regions |
| Token_lookup replication | Single-region only | CockroachDB or Citus for distributed PK |
| Cache invalidation | TTL-based | Add region-aware pub/sub |

### 18.2 Streaming Pipeline

- **Current:** Batch API (`/tokenize/batch`) handles up to 1,000 items per call
- **Future:** Kafka consumer that reads from a PII stream, tokenizes in bulk, and writes to a tokenized stream
- **Interface stability:** The `TokenService.batch_tokenize()` method is the same whether called from API or stream consumer

---

## 19. Trade-offs & Design Decisions

| Decision | Alternative | Why This Choice |
|---|---|---|
| HMAC for lookup + Transit for storage | AES-GCM for both | HMAC enables deterministic lookups (convergent tokenization); AES-GCM is non-deterministic |
| OpenBao Transit vs. in-app encryption | Application-level AES | Separation of concerns: app never holds keys; key rotation is transparent; HSM backing possible |
| Async fire-and-forget audit | Synchronous audit writes | Audit failures should never block business operations |
| DB-based idempotency vs. Redis | Redis dedup | DB is more durable; Redis loss doesn't break idempotency; 1-hour TTL keeps table small |
| In-process event bus vs. Kafka | Kafka from day one | Kafka is premature for single-service; in-process bus has same interface; swap when cross-service needed |
| Per-pod L1 cache vs. shared-nothing | Distributed cache only | L1 eliminates network hop for hot keys; inconsistency is bounded by TTL and harmless (cache is never authoritative for lifecycle) |
| Backpressure via inflight count vs. token bucket | Token bucket | Inflight count directly correlates to resource consumption (memory, connections); token bucket controls rate but not concurrent resource usage |

---

## 20. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| OpenBao outage blocks tokenization | Medium | High | Circuit breaker fast-fails; detokenize works independently; sandbox mode as emergency fallback |
| Database corruption | Low | Critical | ReconciliationWorker detects inconsistencies; hourly backups (RPO: 1h); read replicas for availability |
| Cache poisoning (stale revoked token served) | Low | Medium | Detokenize NEVER trusts cache for lifecycle — always checks DB status |
| Token collision (two different plaintexts get same token) | Negligible | Critical | 32 bytes of `secrets.token_urlsafe` = 256 bits of entropy; probability < 2^-128 |
| Key compromise | Low | Critical | Keys in OpenBao (HSM-backed); key rotation + re-encryption worker; audit trail on key access |
| Tenant data leakage | Low | Critical | Every query, cache key, and audit entry includes `tenant_id`; composite PK prevents cross-tenant collision |
| Traffic spike causes cascading failure | Medium | High | Backpressure sheds at 200 concurrent; HPA scales to 20 pods; rate limiter caps per-tenant |
| Schema migration breaks running pods | Medium | Medium | Expand-migrate-contract pattern; all DDL uses IF NOT EXISTS; migration runs before deploy |

---

## 21. Conclusion

The T&T Engine is a production-grade, enterprise-ready tokenization platform that:

- **Protects PII** through convergent tokenization with externalized key management, ensuring plaintext never exists in storage, logs, or application memory
- **Guarantees correctness** through strong consistency on writes (DB upsert), immediate lifecycle enforcement on reads (revoke/expire), and end-to-end idempotency
- **Scales horizontally** with stateless pods, 3-layer caching, batch processing, and Kubernetes autoscaling
- **Resists failures** through circuit breakers, backpressure load shedding, graceful degradation, and runtime kill switches
- **Supports governance** with data classification, role-based access control, per-tenant isolation, and immutable audit trails
- **Enables evolution** through a versioned API (v1/v2), pluggable crypto backend, swappable event bus, and runtime feature flags

The system is deployed via Helm with zero-downtime rolling updates, monitored via Prometheus/Grafana with 8 SLO alert rules, and operated via admin APIs that provide runtime control without redeployment. It is ready for architecture review and production deployment.
