# T&T Engine — Consistency Model

## Data Ownership

The T&T Engine **owns** the following data:
- `token_store` — encrypted PII values mapped to tokens
- `token_lookup` — convergent hash→token index
- `request_dedup` — idempotency cache
- `audit_log` — immutable audit trail

It does **NOT** own:
- Encryption keys (owned by OpenBao)
- User/tenant metadata (owned by IAM service)
- Business data that references tokens (owned by consuming services)

## Consistency Guarantees

### Tokenize (write path)
**Strong consistency.** The DB `upsert_token()` function uses
`INSERT ... ON CONFLICT` within a single transaction. Two concurrent
requests for the same plaintext+tenant will produce the same token.
The loser gets the winner's token — never a duplicate.

### Detokenize (read path)
**Strong consistency.** Reads from the primary DB (or read replica
with replication lag < 1s). Token status (ACTIVE/REVOKED/EXPIRED)
is checked at read time — a just-revoked token is immediately
unreadable.

### Cache
**Eventually consistent.** The L1 (in-memory) and L2 (Redis) caches
are write-through. On cache miss, the DB is the source of truth.
Cache entries have TTL and are never considered authoritative for
lifecycle status — detokenize ALWAYS checks DB for status.

### Revoke / Delete
**Immediately consistent in DB.** Cache entries may still exist
briefly (up to TTL), but detokenize checks DB status before
returning a value. A revoked/deleted token is never returned
to the caller, even if cached.

### Audit Log
**Best-effort.** Audit writes are fire-and-forget (async). A failed
audit write does NOT fail the user request. Audit logs are eventually
consistent — there may be a small window where an operation succeeded
but the audit entry hasn't been written yet.

### Events
**At-least-once.** Events carry a unique `event_id` for consumer-side
deduplication. If the publisher retries, the same event_id is used.
Consumers must be idempotent.

## Failure Scenarios

| Scenario | Behavior |
|---|---|
| DB down | Tokenize fails (503). Detokenize fails for cache misses. Cached tokens still detokenizable. |
| Redis down | L2 cache bypassed. L1 still works. DB becomes L2. No data loss. |
| OpenBao down | Circuit breaker opens. Tokenize fails fast (no timeout). Detokenize works (uses stored ciphertext + key version). |
| DB slow | Statement timeout kills queries at 10s. Backpressure sheds excess requests at 200 concurrent. |
| Pod restart | Graceful shutdown drains in-flight requests (5s). K8s readiness probe stops new traffic. L1 cache cold — warmed from L2/DB. |

## Multi-Region Readiness

Current design supports multi-region via:
- **Read replicas** per region (already configured in connection.py)
- **Convergent tokenization** — same input in any region produces same HMAC hash (deterministic)
- **Event bus** — swappable for cross-region Kafka for event propagation
- **Idempotent operations** — safe to retry across regions

Not yet implemented:
- Cross-region token_lookup replication (requires distributed DB like CockroachDB or Citus)
- Region-aware cache invalidation
