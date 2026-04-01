# Runbook: Database Slow Queries

## Alert
`TNTDatabaseSlow` — DB p99 latency above 100ms.

## Impact
- **Tokenize/detokenize latency increases** for cache misses
- **Batch operations become slow**
- **No data loss** — operations succeed, just slowly

## Diagnosis
```bash
# Check DB pod/connection status
kubectl -n tnt-engine get pods -l app=postgres

# Check active queries
kubectl -n tnt-engine exec deploy/postgres -- psql -U tnt -d tnt_engine -c \
  "SELECT pid, now()-query_start AS duration, query FROM pg_stat_activity WHERE state='active' ORDER BY duration DESC LIMIT 10;"

# Check table sizes
kubectl -n tnt-engine exec deploy/postgres -- psql -U tnt -d tnt_engine -c \
  "SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) FROM pg_class WHERE relname LIKE 'token%' ORDER BY pg_total_relation_size(oid) DESC;"

# Check index usage
kubectl -n tnt-engine exec deploy/postgres -- psql -U tnt -d tnt_engine -c \
  "SELECT indexrelname, idx_scan, idx_tup_read FROM pg_stat_user_indexes WHERE schemaname='public' ORDER BY idx_scan;"

# Check app-side DB metrics
curl -s http://tnt-engine:8000/metrics | grep tnt_db_operation
```

## Resolution

### Long-running queries:
1. Kill the query: `SELECT pg_cancel_backend(<pid>);`
2. Statement timeout should auto-cancel at 10s — check if it's set.

### Table bloat:
1. Run `VACUUM ANALYZE token_store;`
2. Schedule regular autovacuum tuning.

### Missing indexes:
1. Verify indexes exist: `\di` in psql
2. Check if `token_lookup(hash, tenant_id)` index is being used.

### Connection pool exhaustion:
1. Check pool metrics: `tnt_db_pool_size`
2. Increase `TNT_DB_POOL_MAX` if needed (max 100 per replica).

## Escalation
- **L1**: Platform on-call
- **L2**: DBA team (if vacuum/index/replication issues)
