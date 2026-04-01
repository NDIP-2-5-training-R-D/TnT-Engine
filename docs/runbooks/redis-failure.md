# Runbook: Redis Failure

## Alert
`TNTRedisSlow` or Redis connection errors in logs.

## Impact
- **Tokenize latency increases** (L1 cache still works, but L2 misses fall through to DB)
- **No data loss** — Redis is a cache, DB is source of truth
- **Service remains available** — graceful degradation by design

## Diagnosis
```bash
# Check Redis pod status
kubectl -n tnt-engine get pods -l app=redis

# Check Redis connectivity from app pod
kubectl -n tnt-engine exec deploy/tnt-engine -- python -c \
  "import redis; r = redis.Redis.from_url('redis://redis:6379'); print(r.ping())"

# Check Redis memory
kubectl -n tnt-engine exec deploy/redis -- redis-cli INFO memory

# Check app metrics for Redis errors
curl -s http://tnt-engine:8000/metrics | grep tnt_redis_errors
```

## Resolution

### If Redis is down:
1. Service auto-degrades to L1 cache + DB. No action required for availability.
2. Restart Redis: `kubectl -n tnt-engine rollout restart deployment/redis`
3. After Redis recovers, trigger cache rebuild:
   ```bash
   curl -X POST http://tnt-engine:8000/api/v1/admin/cache-rebuild
   ```

### If Redis is slow:
1. Check `maxmemory` eviction — may need more memory.
2. Check for large keys: `redis-cli --bigkeys`
3. Check client connections: `redis-cli CLIENT LIST`

## Escalation
- **L1**: Platform on-call (Slack: #tnt-engine-alerts)
- **L2**: Infrastructure team (if Redis cluster issue)
