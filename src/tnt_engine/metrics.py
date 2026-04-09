"""Centralized metrics registry for the T&T Engine.

All Prometheus metrics are defined here to avoid duplication and provide
a single source of truth for dashboards and alert rules.

Dependency-level histograms track latency at each infrastructure boundary:
  - DB operations (queries, upserts)
  - Redis operations (get, set, mget)
  - Crypto operations (hmac, encrypt, decrypt)
  - HTTP requests (incoming API calls)

SLO thresholds are exported as constants for alert rule generation.
"""

from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram, Info

# ── SLO thresholds (export for alerting config) ─────────────────────

SLO_LATENCY_P99_SECONDS = 0.200      # 200ms
SLO_ERROR_RATE_PERCENT = 1.0          # 1%
SLO_CACHE_HIT_RATE_PERCENT = 80.0     # 80%

# ── Request-level metrics (API layer) ────────────────────────────────

REQUEST_COUNT = Counter(
    "tnt_http_requests_total",
    "Total HTTP requests",
    ["method", "endpoint", "status"],
)
REQUEST_LATENCY = Histogram(
    "tnt_http_request_duration_seconds",
    "HTTP request latency",
    ["method", "endpoint"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1.0, 2.5),
)

# ── Database metrics ─────────────────────────────────────────────────

DB_LATENCY = Histogram(
    "tnt_db_operation_duration_seconds",
    "Database operation latency",
    ["operation"],
    buckets=(0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0),
)
DB_ERRORS = Counter(
    "tnt_db_errors_total",
    "Database errors",
    ["operation"],
)
DB_POOL_SIZE = Gauge(
    "tnt_db_pool_size",
    "Current DB connection pool size",
    ["pool"],
)

# ── Redis metrics ────────────────────────────────────────────────────

REDIS_LATENCY = Histogram(
    "tnt_redis_operation_duration_seconds",
    "Redis operation latency",
    ["operation"],
    buckets=(0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1),
)
REDIS_ERRORS = Counter(
    "tnt_redis_errors_total",
    "Redis errors",
    ["operation"],
)

# ── Crypto metrics ───────────────────────────────────────────────────

CRYPTO_LATENCY = Histogram(
    "tnt_crypto_operation_duration_seconds",
    "External crypto service latency",
    ["operation"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0),
)
CRYPTO_ERRORS = Counter(
    "tnt_crypto_errors_total",
    "External crypto service errors",
    ["operation"],
)

# ── Vault token metrics ──────────────────────────────────────────────

VAULT_TOKEN_TTL = Gauge(
    "tnt_vault_token_ttl_seconds",
    "Remaining TTL of the current Vault token",
)
VAULT_TOKEN_RENEWALS = Counter(
    "tnt_vault_token_renewals_total",
    "Vault token renewal attempts",
    ["status"],  # "success" or "failure"
)
VAULT_AUTH_ERRORS = Counter(
    "tnt_vault_auth_errors_total",
    "Vault authentication errors",
    ["method"],  # "approle", "kubernetes", "renew"
)
VAULT_HEALTH_SEALED = Gauge(
    "tnt_vault_health_sealed",
    "1 if OpenBao/Vault is sealed, 0 if healthy",
)

# ── Audit metrics ────────────────────────────────────────────────────

AUDIT_BUFFER_SIZE = Gauge(
    "tnt_audit_buffer_size",
    "Current number of audit entries buffered in memory",
)
AUDIT_FLUSH_TOTAL = Counter(
    "tnt_audit_flush_total",
    "Audit buffer flush attempts",
    ["status"],  # "success", "failure"
)
AUDIT_ENTRIES_WRITTEN = Counter(
    "tnt_audit_entries_written_total",
    "Audit entries successfully written to DB",
)
AUDIT_ENTRIES_DLQ = Counter(
    "tnt_audit_entries_dlq_total",
    "Audit entries sent to dead letter queue",
)
AUDIT_DLQ_SIZE = Gauge(
    "tnt_audit_dlq_file_size_bytes",
    "Size of the audit dead letter queue file on disk",
)

# ── Reencrypt worker metrics ─────────────────────────────────────────

REENCRYPT_PLAINTEXT_EXPOSURE = Histogram(
    "tnt_reencrypt_plaintext_exposure_seconds",
    "Duration plaintext is held in memory during re-encryption",
    buckets=(0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5),
)

# ── Service-level metrics (already exist in token_service.py) ────────
# These are re-exported references for dashboard consistency.
# The actual Counter/Histogram objects are defined in token_service.py
# to avoid circular imports. This module provides the dependency-level
# metrics that those don't cover.

# ── Kafka audit metrics ──────────────────────────────────────────────

KAFKA_PRODUCE_TOTAL = Counter(
    "tnt_kafka_audit_produce_total",
    "Kafka audit produce attempts",
    ["topic", "status"],  # status: "success" | "failure"
)
KAFKA_PRODUCE_ERRORS = Counter(
    "tnt_kafka_audit_produce_errors_total",
    "Kafka audit produce errors",
    ["topic"],
)
KAFKA_CONSUMER_LAG = Gauge(
    "tnt_kafka_audit_consumer_lag",
    "Kafka consumer lag for audit topic",
    ["topic", "group"],
)

# ── Build info ───────────────────────────────────────────────────────

BUILD_INFO = Info("tnt_engine", "T&T Engine build information")
BUILD_INFO.info({
    "version": "0.3.0",
    "component": "tokenization-engine",
})
