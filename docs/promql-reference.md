# PromQL Reference — T&T Engine

Useful queries for debugging, alerting, and capacity planning.

## Request Metrics

```promql
# Request rate (total)
sum(rate(tnt_http_requests_total[1m]))

# Request rate by endpoint
sum(rate(tnt_http_requests_total[1m])) by (endpoint)

# Error rate (%)
sum(rate(tnt_http_requests_total{status=~"5.."}[5m]))
/ sum(rate(tnt_http_requests_total[5m]))

# Latency p50 / p95 / p99
histogram_quantile(0.50, sum(rate(tnt_http_request_duration_seconds_bucket[5m])) by (le))
histogram_quantile(0.95, sum(rate(tnt_http_request_duration_seconds_bucket[5m])) by (le))
histogram_quantile(0.99, sum(rate(tnt_http_request_duration_seconds_bucket[5m])) by (le))

# Slowest endpoints (p99)
histogram_quantile(0.99,
  sum(rate(tnt_http_request_duration_seconds_bucket[5m])) by (le, endpoint)
)
```

## Tokenization Metrics

```promql
# Tokenize rate
sum(rate(tnt_tokenize_seconds_count[1m]))

# Tokenize latency p99
histogram_quantile(0.99, sum(rate(tnt_tokenize_seconds_bucket[5m])) by (le))

# Tokens created per hour
sum(increase(tnt_tokens_created_total[1h]))

# Upsert conflicts resolved (indicates high concurrency)
sum(increase(tnt_conflict_resolved_total[1h]))

# Idempotent request hits (dedup cache)
sum(rate(tnt_dedup_hits_total[5m]))
```

## Cache Metrics

```promql
# L1 cache hit rate
sum(rate(tnt_l1_cache_hits_total[5m]))
/ (sum(rate(tnt_l1_cache_hits_total[5m])) + sum(rate(tnt_l1_cache_misses_total[5m])))

# Redis hit vs miss rate
sum(rate(tnt_redis_operation_duration_seconds_count{operation="get"}[5m]))
```

## Database Metrics

```promql
# DB latency p99 by operation
histogram_quantile(0.99,
  sum(rate(tnt_db_operation_duration_seconds_bucket[5m])) by (le, operation)
)

# DB error rate by operation
sum(rate(tnt_db_errors_total[5m])) by (operation)

# Slowest DB operation
topk(5,
  histogram_quantile(0.99,
    sum(rate(tnt_db_operation_duration_seconds_bucket[5m])) by (le, operation)
  )
)
```

## Redis Metrics

```promql
# Redis latency p99
histogram_quantile(0.99,
  sum(rate(tnt_redis_operation_duration_seconds_bucket[5m])) by (le, operation)
)

# Redis error rate
sum(rate(tnt_redis_errors_total[5m])) by (operation)

# Redis memory (from exporter)
redis_memory_used_bytes / redis_memory_max_bytes
```

## Crypto Service Metrics

```promql
# Crypto latency p99 by operation
histogram_quantile(0.99,
  sum(rate(tnt_crypto_operation_duration_seconds_bucket[5m])) by (le, operation)
)

# Crypto errors (circuit breaker indicator)
sum(increase(tnt_crypto_errors_total[2m]))
```

## Infrastructure

```promql
# Pod CPU usage
sum(rate(container_cpu_usage_seconds_total{namespace="tnt-engine", container="tnt-engine"}[5m])) by (pod)

# Pod memory
sum(container_memory_working_set_bytes{namespace="tnt-engine", container="tnt-engine"}) by (pod)

# Pod restarts (last hour)
sum(increase(kube_pod_container_status_restarts_total{namespace="tnt-engine"}[1h])) by (pod)

# Replica count
kube_deployment_status_replicas_available{namespace="tnt-engine", deployment="tnt-engine"}

# HPA current vs desired
kube_horizontalpodautoscaler_status_current_replicas{namespace="tnt-engine"}
```

## Rate Limiting

```promql
# Rate limit hits
sum(increase(tnt_rate_limit_exceeded_total[5m])) by (tenant_id)
```

## SLO Burn Rate (for alerting)

```promql
# 5m error budget burn rate (target: 99.9% availability = 0.1% error budget)
(
  sum(rate(tnt_http_requests_total{status=~"5.."}[5m]))
  / sum(rate(tnt_http_requests_total[5m]))
) / 0.001
# If > 1, you're burning error budget faster than allowed
```
