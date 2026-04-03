# Runbook: OpenBao/Vault Sealed Recovery

**Alert**: `TNTVaultSealed`  
**Severity**: CRITICAL  
**On-call team**: Platform / Security

## Impact

When OpenBao is sealed:
- **ALL tokenize/detokenize operations fail immediately**
- Circuit breaker opens after 5 consecutive failures
- `/api/v1/ready` returns 503 — K8s stops sending traffic
- Audit writes continue (buffered), but new PII cannot be processed

## Diagnosis

```bash
# Check seal status
kubectl -n tnt-engine exec deploy/openbao -- bao status

# Check from T&T Engine health endpoint
curl -s http://tnt-engine:8000/api/v1/health | jq .vault

# Check Prometheus metric
curl -s http://tnt-engine:8000/metrics | grep tnt_vault_health_sealed
```

## Resolution

### If manually sealed (operator error):
```bash
# Unseal with key shares (requires threshold number of key holders)
kubectl -n tnt-engine exec -it deploy/openbao -- bao operator unseal
# Enter unseal key when prompted. Repeat for each key share until threshold met.
```

### If sealed after restart (no auto-unseal configured):
```bash
# Same as above — collect unseal keys from key holders
bao operator unseal <key-share-1>
bao operator unseal <key-share-2>
# ... until threshold reached
```

### If auto-unseal is configured but failing:
```bash
# Check the auto-unseal source (Transit/Cloud KMS)
kubectl -n tnt-engine logs deploy/openbao | grep "seal"

# Common causes:
# 1. Transit seal source is itself sealed or unreachable
# 2. Cloud KMS permissions revoked
# 3. Network policy blocking access to KMS endpoint

# Fix the upstream issue, then restart OpenBao
kubectl -n tnt-engine rollout restart deployment/openbao
```

### If Raft corruption (rare):
```bash
# Restore from latest backup
export VAULT_TOKEN=<root-token>
bash scripts/vault-restore.sh /path/to/latest/vault_raft_YYYYMMDD.snap

# After restore, unseal and verify
bao operator unseal
bao status
```

## Recovery Verification

```bash
# 1. Verify unsealed
bao status  # "Sealed: false"

# 2. Verify health endpoint
curl -s http://tnt-engine:8000/api/v1/health | jq .vault.status
# Expected: "healthy"

# 3. Verify circuit breaker recovers (30s after vault healthy)
curl -s http://tnt-engine:8000/api/v1/health | jq .circuit_breaker
# Expected: "CLOSED"

# 4. Verify tokenize works
curl -X POST http://tnt-engine:8000/api/v1/tokenize \
  -H 'Content-Type: application/json' \
  -d '{"value":"test","field":"ssn","tenant_id":"test"}'
```

## Escalation

- **L1**: Platform on-call — attempt unseal
- **L2**: Security team — key share coordination, KMS access
- **L3**: Infrastructure team — Raft corruption, cluster rebuild
