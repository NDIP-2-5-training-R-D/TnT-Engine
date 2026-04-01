# T&T Engine — C4 Architecture Diagrams

---

## Level 1: System Context

Ai/hệ thống nào tương tác với T&T Engine, và tương tác như thế nào.

```mermaid
C4Context
    title T&T Engine — System Context Diagram

    Person(devA, "Dev A", "Business application developer.<br/>Uses SDK to tokenize/detokenize PII.")
    Person(devB, "Dev B", "Crypto/security engineer.<br/>Implements custom CryptoBackend.")
    Person(sre, "SRE / Operator", "Platform operator.<br/>Uses Admin API for runtime control.")

    System(tnt, "T&T Engine", "Enterprise PII Tokenization Platform.<br/>Convergent tokenization, multi-tenant,<br/>lifecycle management, data governance.")

    System_Ext(openbao, "OpenBao Transit", "External key management service.<br/>Provides HMAC computation and<br/>transit encryption/decryption.<br/>HSM-backed in production.")
    System_Ext(prometheus, "Prometheus + Grafana", "Monitoring & alerting stack.<br/>Scrapes /metrics endpoint.")
    System_Ext(loki, "Loki", "Centralized log aggregation.<br/>Collects structured JSON logs.")
    System_Ext(gitlab, "GitLab CI/CD", "Build, test, scan, deploy pipeline.<br/>Helm-based K8s deployment.")

    Rel(devA, tnt, "Tokenize / Detokenize / Process", "SDK or REST API")
    Rel(devB, tnt, "Plugs custom CryptoBackend", "Python interface")
    Rel(sre, tnt, "Feature flags / Config / Quotas", "Admin API")
    Rel(tnt, openbao, "HMAC, Encrypt, Decrypt", "HTTP/REST")
    Rel(prometheus, tnt, "Scrapes metrics", "HTTP GET /metrics")
    Rel(loki, tnt, "Collects logs", "Promtail agent")
    Rel(gitlab, tnt, "Build & Deploy", "Helm upgrade --atomic")
```

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Dev A     │     │    Dev B     │     │  SRE / Operator │
│ (Business)  │     │  (Crypto)   │     │                 │
└──────┬──────┘     └──────┬──────┘     └────────┬────────┘
       │ SDK/REST          │ CryptoBackend        │ Admin API
       │                   │ interface            │
       ▼                   ▼                      ▼
┌──────────────────────────────────────────────────────────┐
│                                                          │
│                    T&T ENGINE                            │
│         Enterprise PII Tokenization Platform             │
│                                                          │
│  Convergent tokenization · Multi-tenant · Lifecycle      │
│  Data governance · Rate limiting · Quotas                │
│                                                          │
└──────┬──────────────┬──────────────────┬─────────────────┘
       │              │                  │
       ▼              ▼                  ▼
┌──────────────┐ ┌──────────┐  ┌─────────────────────┐
│ OpenBao      │ │Prometheus│  │ GitLab CI/CD        │
│ Transit      │ │+ Grafana │  │                     │
│              │ │          │  │ Build → Test → Scan  │
│ HMAC         │ │ Scrapes  │  │ → Deploy (Helm)     │
│ Encrypt      │ │ /metrics │  │                     │
│ Decrypt      │ └──────────┘  └─────────────────────┘
└──────────────┘
```

---

## Level 2: Container Diagram

Các container (process/runtime) bên trong platform và data store nào được sử dụng.

```mermaid
C4Container
    title T&T Engine — Container Diagram

    Person(consumer, "API Consumer", "Dev A / Dev B / SRE")

    System_Boundary(tnt, "T&T Engine Platform") {

        Container(api, "API Server", "Python / FastAPI / Uvicorn", "REST API endpoints:<br/>/api/v1, /api/v2, /admin<br/>Middleware: Metrics, Guardrails, Backpressure")

        Container(workers, "Background Workers", "Python / asyncio", "CleanupWorker: expire tokens + prune dedup<br/>ReencryptWorker: key rotation<br/>CacheRebuildWorker: warm cache<br/>ReconciliationWorker: integrity check")

        ContainerDb(postgres, "PostgreSQL 16", "Primary + Read Replica", "token_store: encrypted PII<br/>token_lookup: convergent index<br/>request_dedup: idempotency<br/>audit_log: immutable trail")

        ContainerDb(redis, "Redis 7", "L2 Cache", "Token lookup cache<br/>Key: {tenant}:{hash}<br/>TTL: 1 hour<br/>Write-through from API Server")

        Container(l1, "L1 Cache", "In-memory LRU", "Per-pod cache<br/>10K entries, 5min TTL<br/>Fastest lookup: < 1μs")
    }

    System_Ext(openbao, "OpenBao Transit", "HMAC + Encrypt/Decrypt")
    System_Ext(prometheus, "Prometheus", "Metrics collection")

    Rel(consumer, api, "REST API calls", "HTTPS")
    Rel(api, l1, "L1 lookup/write", "In-process")
    Rel(api, redis, "L2 lookup/write", "Redis protocol")
    Rel(api, postgres, "Read/Write (asyncpg)", "TCP/5432")
    Rel(api, openbao, "HMAC, Encrypt, Decrypt", "HTTP/8200")
    Rel(workers, postgres, "Expire, Re-encrypt, Rebuild", "TCP/5432")
    Rel(workers, openbao, "Decrypt + Re-encrypt", "HTTP/8200")
    Rel(workers, redis, "Cache rebuild", "Redis protocol")
    Rel(prometheus, api, "Scrape /metrics", "HTTP/8000")
```

```
┌─────────────────────────────────────────────────────────────────────┐
│                        T&T ENGINE PLATFORM                          │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │              API SERVER (FastAPI / Uvicorn)                  │   │
│  │                                                             │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │   │
│  │  │  /api/v1     │  │  /api/v2     │  │  /admin      │     │   │
│  │  │  Tokenize    │  │  + Quotas    │  │  Flags       │     │   │
│  │  │  Detokenize  │  │  + Events    │  │  Config      │     │   │
│  │  │  Revoke      │  │              │  │  Quotas      │     │   │
│  │  │  Delete      │  │              │  │  Status      │     │   │
│  │  │  Process     │  │              │  │  Cache       │     │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘     │   │
│  │                                                             │   │
│  │  Middleware: [Metrics] → [Guardrails] → [Backpressure]     │   │
│  └──────┬──────────┬───────────────┬───────────────────────────┘   │
│         │          │               │                               │
│  ┌──────▼──────┐   │        ┌──────▼──────────────┐               │
│  │ L1 Cache    │   │        │ Background Workers  │               │
│  │ In-memory   │   │        │                     │               │
│  │ LRU 10K     │   │        │ · CleanupWorker     │               │
│  │ TTL: 5min   │   │        │ · ReencryptWorker   │               │
│  └─────────────┘   │        │ · CacheRebuildWorker│               │
│                     │        │ · ReconciliationWkr │               │
│                     │        └──────┬──────────────┘               │
│                     │               │                              │
│         ┌───────────┼───────────────┤                              │
│         ▼           ▼               ▼                              │
│  ┌─────────────┐  ┌──────────────────┐                            │
│  │   Redis 7   │  │  PostgreSQL 16   │                            │
│  │   L2 Cache  │  │                  │                            │
│  │             │  │ ┌──────────────┐ │                            │
│  │ {tenant}:   │  │ │ token_store  │ │                            │
│  │ {hash}      │  │ │ token_lookup │ │                            │
│  │ → token     │  │ │ request_dedup│ │                            │
│  │             │  │ │ audit_log    │ │                            │
│  │ TTL: 1hr    │  │ └──────────────┘ │                            │
│  └─────────────┘  │                  │                            │
│                    │ Primary + Read   │                            │
│                    │ Replica          │                            │
│                    └──────────────────┘                            │
└─────────────────────────┬─────────────────────────────────────────┘
                          │
                          ▼
                   ┌──────────────┐
                   │ OpenBao      │
                   │ Transit API  │
                   │              │
                   │ /transit/    │
                   │   hmac/      │
                   │   encrypt/   │
                   │   decrypt/   │
                   └──────────────┘
```

---

## Level 3: Component Diagram

Các component bên trong API Server container — logic phân tầng chi tiết.

```mermaid
C4Component
    title T&T Engine — Component Diagram (API Server)

    Container_Boundary(api, "API Server") {

        Component(middleware, "Middleware Stack", "Starlette", "MetricsMiddleware<br/>GuardrailsMiddleware (1MB, 30s)<br/>BackpressureMiddleware (200 max)")

        Component(router_v1, "API v1 Router", "FastAPI", "/api/v1/*<br/>tokenize, detokenize, batch,<br/>revoke, delete, process")
        Component(router_v2, "API v2 Router", "FastAPI", "/api/v2/*<br/>+ quota check + events")
        Component(router_admin, "Admin Router", "FastAPI", "/admin/*<br/>flags, config, quotas, status")

        Component(policy, "PolicyEngine", "Python", "Governance enforcement<br/>Field routing:<br/>TOKENIZE/MASK/HASH/PASSTHROUGH")
        Component(svc, "TokenService", "Python", "Core tokenization engine<br/>Idempotency, normalization,<br/>convergent lookup, lifecycle")
        Component(masking, "MaskingService", "Python", "One-way field masking<br/>SSN, email, card, phone, name")

        Component(flags, "FeatureFlags", "Python", "Runtime toggles<br/>Global + per-tenant overrides")
        Component(dynconfig, "DynamicConfig", "Python", "Runtime-tunable params<br/>cache TTL, retries, limits")
        Component(events, "EventBus", "Python", "At-least-once delivery<br/>Dedup by event_id (LRU 10K)")

        Component(cache, "LayeredCache", "Python", "L1 (Memory) → L2 (Redis)<br/>Write-through, tenant-scoped<br/>Key: {tenant}:{hash}")
        Component(repo, "TokenRepository", "Python / asyncpg", "Tenant-scoped data access<br/>Read replica routing<br/>Latency instrumented")
        Component(crypto, "CircuitBreakerBackend", "Python", "3-state FSM: CLOSED→OPEN→HALF_OPEN<br/>Wraps CryptoBackend<br/>Threshold: 5 failures, 30s recovery")

        Component(governance, "ClassificationRegistry", "Python", "HIGH/MEDIUM/LOW/UNCLASSIFIED<br/>Policy enforcement rules")
        Component(ratelimit, "RateLimiter", "Python", "Per-tenant sliding window<br/>5000 req/60s default")
        Component(quota, "QuotaManager", "Python", "Per-tenant monthly quotas<br/>Usage tracking + enforcement")
    }

    ContainerDb(postgres, "PostgreSQL", "")
    ContainerDb(redis, "Redis", "")
    System_Ext(openbao, "OpenBao Transit", "")

    Rel(middleware, router_v1, "Routes request")
    Rel(middleware, router_v2, "Routes request")
    Rel(middleware, router_admin, "Routes request")

    Rel(router_v1, svc, "tokenize / detokenize")
    Rel(router_v1, policy, "process_field / process_record")
    Rel(router_v2, svc, "tokenize + quota + events")
    Rel(router_v2, quota, "check / record_usage")
    Rel(router_v2, events, "publish TOKEN_CREATED")
    Rel(router_admin, flags, "get / set flags")
    Rel(router_admin, dynconfig, "get / update config")

    Rel(policy, svc, "delegates TOKENIZE")
    Rel(policy, masking, "delegates MASK")
    Rel(policy, governance, "enforces classification")

    Rel(svc, cache, "L1→L2 lookup/write")
    Rel(svc, repo, "DB read/write")
    Rel(svc, crypto, "HMAC + encrypt/decrypt")

    Rel(cache, redis, "L2 operations")
    Rel(repo, postgres, "SQL queries")
    Rel(crypto, openbao, "Transit API calls")
```

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                           API SERVER COMPONENTS                                │
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                      MIDDLEWARE STACK                                    │   │
│  │   [MetricsMiddleware] → [GuardrailsMiddleware] → [BackpressureMW]      │   │
│  │    req count/latency     body≤1MB, timeout≤30s    inflight≤200         │   │
│  └───────────┬──────────────────┬──────────────────────┬───────────────────┘   │
│              │                  │                      │                       │
│  ┌───────────▼────┐ ┌──────────▼─────────┐ ┌──────────▼────────────┐         │
│  │  API v1 Router │ │   API v2 Router    │ │   Admin Router       │         │
│  │  /api/v1/*     │ │   /api/v2/*        │ │   /admin/*           │         │
│  │                │ │                    │ │                      │         │
│  │ · tokenize     │ │ · tokenize         │ │ · GET/POST flags    │         │
│  │ · detokenize   │ │   + quota check    │ │ · GET/POST config   │         │
│  │ · batch (x2)   │ │   + event emit     │ │ · GET/POST quota    │         │
│  │ · revoke       │ │ · batch            │ │ · POST cache/rebuild│         │
│  │ · delete       │ │   + quota + events │ │ · GET status        │         │
│  │ · process/field│ │ · detokenize       │ │ · POST rate-limit   │         │
│  │ · process/rec  │ │ · revoke + event   │ │   /reset            │         │
│  │ · health       │ │ · delete + event   │ │                      │         │
│  │ · ready        │ │                    │ │                      │         │
│  └──┬─────────┬───┘ └──┬──────┬────┬────┘ └──┬──────┬──────┬────┘         │
│     │         │         │      │    │         │      │      │              │
│  ┌──▼─────────▼─────────▼──┐   │    │    ┌────▼──┐ ┌─▼────┐ │              │
│  │      PolicyEngine       │   │    │    │Feature│ │Dyn.  │ │              │
│  │                         │   │    │    │Flags  │ │Config│ │              │
│  │ ┌─────────────────────┐ │   │    │    └───────┘ └──────┘ │              │
│  │ │ClassificationRegistry│ │   │    │                      │              │
│  │ │ HIGH → TOKENIZE only │ │   │    │              ┌───────▼──────┐       │
│  │ │ MEDIUM → +MASK,HASH │ │   │    │              │ QuotaManager │       │
│  │ │ LOW → +PASSTHROUGH   │ │   │    │              └──────────────┘       │
│  │ └─────────────────────┘ │   │    │                                     │
│  │                         │   │    │              ┌──────────────┐        │
│  │ Routes to:              │   │    └─────────────▶│  EventBus    │        │
│  │  · TokenService (TOK)   │   │                   │ event_id dedup│       │
│  │  · MaskingService (MASK)│   │                   │ LRU 10K      │        │
│  │  · HMACService (HASH)   │   │                   └──────────────┘        │
│  └──────────┬──────────────┘   │                                           │
│             │                  │         ┌──────────────┐                  │
│             │                  │         │ RateLimiter   │                  │
│             ▼                  │         │ 5000 req/60s  │                  │
│  ┌──────────────────────────────────┐    │ per tenant    │                  │
│  │         TokenService             │    └──────────────┘                  │
│  │                                  │                                      │
│  │  normalize → HMAC → cache lookup │                                      │
│  │  → DB lookup → encrypt → upsert │                                      │
│  │  → cache backfill → dedup store  │                                      │
│  │                                  │                                      │
│  │  Idempotent · Convergent         │                                      │
│  │  Concurrent-safe · Lifecycle-aware│                                     │
│  └──┬──────────┬──────────┬─────────┘                                      │
│     │          │          │                                                │
│  ┌──▼────┐  ┌──▼────┐  ┌──▼──────────────────────┐                        │
│  │Layered│  │Token  │  │CircuitBreakerBackend    │                        │
│  │Cache  │  │Repo   │  │                          │                        │
│  │       │  │       │  │ CLOSED ─(5 fails)→ OPEN │                        │
│  │L1: LRU│  │asyncpg│  │ OPEN ──(30s)────→ HALF  │                        │
│  │L2: Red│  │tenant │  │ HALF ──(success)→ CLOSED│                        │
│  │       │  │scoped │  │                          │                        │
│  └──┬──┬─┘  └──┬────┘  └──────────┬───────────────┘                        │
│     │  │       │                  │                                        │
└─────┼──┼───────┼──────────────────┼────────────────────────────────────────┘
      │  │       │                  │
      ▼  ▼       ▼                  ▼
   ┌────┐┌─────┐┌──────────┐┌──────────────┐
   │ L1 ││Redis││PostgreSQL││ OpenBao      │
   │mem ││ L2  ││ Primary  ││ Transit API  │
   │    ││     ││ + Replica││              │
   └────┘└─────┘└──────────┘└──────────────┘
```

---

## Level 4: Code Diagram — Tokenization Flow

Chi tiết class-level cho flow tokenize (operation quan trọng nhất).

```mermaid
classDiagram
    class TokenService {
        -HMACService _hmac
        -EncryptionService _encryption
        -TokenRepository _repo
        -LayeredCache _cache
        -Settings _settings
        +tokenize(TokenizeRequest) TokenizeResponse
        +batch_tokenize(list) list
        +detokenize(token, tenant_id) str
        +batch_detokenize(tokens, tenant_id) dict
        +revoke(token, tenant_id) bool
        +delete(token, tenant_id) bool
        -_normalize(value) str
        -_generate_token() str
        -_validate_token_format(token)
        -_check_token_status(TokenRecord)
        -_request_hash(op, tenant, args) str
        -_fire_audit(action, field, tenant)
    }

    class HMACService {
        <<interface>>
        +hmac(plaintext, key_name) str
    }

    class EncryptionService {
        <<interface>>
        +encrypt(plaintext, key_name) tuple[str, int]
        +decrypt(ciphertext, key_version, key_name) str
    }

    class CryptoBackend {
        <<interface>>
        +hmac()
        +encrypt()
        +decrypt()
        +close()
    }

    class CircuitBreakerBackend {
        -CryptoBackend _backend
        -int _failure_threshold
        -float _recovery_timeout
        -State _state
        +hmac(plaintext) str
        +encrypt(plaintext) tuple
        +decrypt(ciphertext, version) str
        -_check_state()
        -_on_success()
        -_on_failure()
    }

    class OpenBaoCryptoBackend {
        -str _base
        -AsyncClient _client
        +hmac(plaintext) str
        +encrypt(plaintext) tuple
        +decrypt(ciphertext, version) str
        -_post(path, json) dict
    }

    class LayeredCache {
        -L1Cache _l1
        -TokenCache _l2
        +get(hash, tenant_id) str?
        +set(hash, tenant_id, token)
        +get_multi(hashes, tenant_id) dict
        +set_multi(mapping, tenant_id)
    }

    class TokenRepository {
        -Database _db
        +find_token_by_hash(hash, tenant) str?
        +upsert_token(token, enc, trans, kv, hash, tenant) str
        +get_token_record(token, tenant) TokenRecord?
        +revoke_token(token, tenant) bool
        +delete_token(token, tenant) bool
        +write_audit(AuditEntry)
    }

    class PolicyEngine {
        -TokenService _token_svc
        -HMACService _hmac
        -ClassificationRegistry _governance
        +process_field(policy, value, tenant) FieldResult
        +process_record(policies, values, tenant) dict
        -_enforce_governance(FieldPolicy)
        -_apply(FieldPolicy, value, tenant) str
    }

    HMACService <|.. CryptoBackend
    EncryptionService <|.. CryptoBackend
    CryptoBackend <|.. OpenBaoCryptoBackend
    CryptoBackend <|.. CircuitBreakerBackend
    CircuitBreakerBackend o-- CryptoBackend : wraps

    TokenService --> HMACService : _hmac
    TokenService --> EncryptionService : _encryption
    TokenService --> TokenRepository : _repo
    TokenService --> LayeredCache : _cache

    PolicyEngine --> TokenService : _token_svc
    PolicyEngine --> HMACService : _hmac
```

```
┌─────────────────────────────────────────────────────────────────┐
│                     CLASS RELATIONSHIPS                          │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐     │
│  │                   PolicyEngine                         │     │
│  │  _token_svc ──▶ TokenService                          │     │
│  │  _hmac ────────▶ HMACService (interface)              │     │
│  │  _governance ──▶ ClassificationRegistry               │     │
│  └────────────────────┬───────────────────────────────────┘     │
│                       │                                         │
│                       ▼                                         │
│  ┌────────────────────────────────────────────────────────┐     │
│  │                   TokenService                         │     │
│  │                                                        │     │
│  │  _hmac ─────────▶ HMACService ◀─────────┐            │     │
│  │  _encryption ───▶ EncryptionService ◀────┤            │     │
│  │  _repo ─────────▶ TokenRepository        │            │     │
│  │  _cache ────────▶ LayeredCache            │            │     │
│  └───────────────────────────────────────────┤────────────┘     │
│                                              │                  │
│                                    ┌─────────▼──────────┐       │
│                         ┌─────────│  CryptoBackend     │       │
│                         │         │  <<interface>>      │       │
│                         │         │  hmac()             │       │
│                         │         │  encrypt()          │       │
│                         │         │  decrypt()          │       │
│                         │         └─────────┬──────────┘       │
│                         │                   │                   │
│              ┌──────────▼────────┐  ┌───────▼────────────┐     │
│              │CircuitBreaker     │  │SandboxCrypto       │     │
│              │Backend            │  │Backend             │     │
│              │                   │  │(dev/test only)     │     │
│              │ wraps any         │  └────────────────────┘     │
│              │ CryptoBackend     │                              │
│              │                   │                              │
│              │ _backend ────────▶│  OpenBaoCrypto               │
│              │                   │  Backend                     │
│              │ States:           │  (production)                │
│              │ CLOSED→OPEN       │                              │
│              │ →HALF_OPEN        │                              │
│              └───────────────────┘                              │
│                                                                 │
│  ┌─────────────────┐        ┌──────────────────────┐           │
│  │  LayeredCache    │        │  TokenRepository     │           │
│  │                  │        │                      │           │
│  │ ┌──────┐        │        │  _db.pool (write)    │           │
│  │ │  L1  │ LRU    │        │  _db.read_pool (read)│           │
│  │ │ 10K  │ 5min   │        │                      │           │
│  │ └──┬───┘        │        │  @_track(operation)  │           │
│  │    ▼            │        │  → DB_LATENCY hist   │           │
│  │ ┌──────┐        │        │  → DB_ERRORS counter │           │
│  │ │  L2  │ Redis  │        │                      │           │
│  │ │ 50cn │ 1hr    │        └──────────────────────┘           │
│  │ └──────┘        │                                           │
│  └─────────────────┘                                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Level 3.5: Data Flow Diagram — Tokenize Request

Dòng dữ liệu chi tiết khi một request tokenize đi qua hệ thống.

```
Request: POST /api/v1/tokenize
Body: {"value": "123-45-6789", "field": "ssn", "tenant_id": "acme"}

    ┌────────┐
    │ Client │
    └───┬────┘
        │ HTTP POST
        ▼
┌───────────────────────────────────────────────────────────────┐
│ MIDDLEWARE STACK                                               │
│                                                               │
│ 1. MetricsMiddleware                                          │
│    · Generate/propagate trace_id                              │
│    · Start latency timer                                      │
│                                                               │
│ 2. GuardrailsMiddleware                                       │
│    · Check: body size ≤ 1MB? ─── NO ──▶ 413 Payload Too Large│
│    · Enforce: 30s timeout                                     │
│                                                               │
│ 3. BackpressureMiddleware                                     │
│    · Check: inflight < 200? ──── NO ──▶ 503 + Retry-After: 1 │
│    · Increment inflight counter                               │
└───────────────────────┬───────────────────────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────────────────────┐
│ TokenService.tokenize(req)                                    │
│                                                               │
│ ① IDEMPOTENCY CHECK                                          │
│    hash = SHA256("tokenize:acme:123-45-6789:ssn")             │
│    dedup = await repo.get_dedup(hash, "acme")                 │
│    ── hit? ──▶ return cached response (skip everything below) │
│                                                               │
│ ② NORMALIZE                                                   │
│    "  123-45-6789  " → "123-45-6789" (NFC + strip)           │
│                                                               │
│ ③ HMAC (via CircuitBreaker → OpenBao)                        │
│    hmac_hash = await crypto.hmac("123-45-6789")               │
│    ── circuit OPEN? ──▶ raise CryptoServiceUnavailableError   │
│    Result: "vault:v1:a3f8c2d1..."                             │
│                                                               │
│ ④ CACHE LOOKUP (3-layer)                                      │
│    L1.get("acme:vault:v1:a3f8c2d1...")                        │
│    ── L1 hit? ──▶ return token (fastest path, < 1μs)          │
│    L2.get("acme:vault:v1:a3f8c2d1...")                        │
│    ── L2 hit? ──▶ backfill L1, return token                   │
│                                                               │
│ ⑤ DB LOOKUP                                                   │
│    token = await repo.find_token_by_hash(hash, "acme")        │
│    ── DB hit? ──▶ backfill L1+L2, return token                │
│                                                               │
│ ⑥ CREATE NEW TOKEN (cold path)                                │
│    proposed = "tok_" + secrets.token_urlsafe(32)              │
│    ciphertext, key_ver = await crypto.encrypt("123-45-6789")  │
│    ── Result: ("vault:v1:encrypted...", 1)                    │
│                                                               │
│ ⑦ CONCURRENCY-SAFE UPSERT                                    │
│    winning = await repo.upsert_token(                         │
│        proposed, ciphertext, "TOKENIZE", 1, hash, "acme"      │
│    )                                                          │
│    ── race lost? ──▶ winning ≠ proposed (use winner's token)  │
│                                                               │
│ ⑧ CACHE BACKFILL                                              │
│    await cache.set(hash, "acme", winning)  [L1 + L2]          │
│                                                               │
│ ⑨ DEDUP STORE                                                 │
│    await repo.set_dedup(req_hash, "acme", response_dict)      │
│                                                               │
│ ⑩ AUDIT (fire-and-forget)                                     │
│    asyncio.create_task(write_audit(TOKENIZE, "ssn", "acme"))  │
│                                                               │
│ Return: TokenizeResponse(token="tok_A3f8x...", field="ssn")   │
└───────────────────────────────────────────────────────────────┘
```

---

## Deployment Diagram (Kubernetes)

```
┌─────────────────────── Kubernetes Cluster ──────────────────────────┐
│                                                                     │
│  ┌─── tnt-engine namespace ─────────────────────────────────────┐  │
│  │                                                               │  │
│  │  Deployment: tnt-engine (RollingUpdate, maxUnavailable=0)    │  │
│  │  ┌────────┐ ┌────────┐ ┌────────┐          ┌────────┐       │  │
│  │  │ Pod 1  │ │ Pod 2  │ │ Pod 3  │   ...    │ Pod N  │       │  │
│  │  │ 250m-1 │ │ 250m-1 │ │ 250m-1 │          │        │       │  │
│  │  │ CPU    │ │ CPU    │ │ CPU    │          │        │       │  │
│  │  │ 256-   │ │ 256-   │ │ 256-   │          │        │       │  │
│  │  │ 512Mi  │ │ 512Mi  │ │ 512Mi  │          │        │       │  │
│  │  └────────┘ └────────┘ └────────┘          └────────┘       │  │
│  │                                                               │  │
│  │  HPA: min=3, max=20, CPU target=70%                          │  │
│  │  PDB: minAvailable=2                                         │  │
│  │                                                               │  │
│  │  Service ──▶ ClusterIP :80 → :8000                           │  │
│  │  Ingress ──▶ nginx, TLS (prod)                               │  │
│  │  NetworkPolicy ──▶ ingress: nginx+monitoring                 │  │
│  │                    egress: pg+redis+openbao+dns               │  │
│  │                                                               │  │
│  │  ┌────────────┐  ┌──────────┐  ┌──────────────┐             │  │
│  │  │ PostgreSQL │  │  Redis   │  │   OpenBao    │             │  │
│  │  │ Primary    │  │  7-alpine│  │   Transit    │             │  │
│  │  │ + Replica  │  │  256MB   │  │   :8200      │             │  │
│  │  └────────────┘  └──────────┘  └──────────────┘             │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─── monitoring namespace ──────────────────────────────────────┐ │
│  │  Prometheus (ServiceMonitor → tnt-engine /metrics)            │ │
│  │  Grafana (3 dashboards: overview, infra, dependencies)        │ │
│  │  Alertmanager (8 rules → Slack #tnt-engine-alerts)            │ │
│  │  Loki + Promtail (structured JSON log collection)             │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Cách render diagrams

### Mermaid (GitLab / GitHub / VS Code)
Các diagram Mermaid trong document này render tự động trên GitLab/GitHub markdown. Trong VS Code, cài extension "Markdown Preview Mermaid Support".

### PlantUML
Để convert sang PlantUML format, sử dụng C4-PlantUML library:
```
!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml
```

### Export sang PNG/SVG
```bash
# Mermaid CLI
npx -p @mermaid-js/mermaid-cli mmdc -i docs/c4-diagrams.md -o docs/c4-diagrams.png

# Hoặc dùng Kroki API
curl -X POST https://kroki.io/mermaid/svg -d @diagram.mermaid -o diagram.svg
```
