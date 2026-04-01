# Runbook: Crypto Service (OpenBao) Failure

## Alert
`TNTCircuitBreakerOpen` — crypto service failures exceeding threshold.

## Impact
- **New tokenize requests fail** (cannot HMAC or encrypt without crypto service)
- **Detokenize of cached tokens still works** (if token record is in DB, decrypt needs crypto)
- **Circuit breaker opens** after 5 consecutive failures — subsequent requests fast-fail
- **Auto-recovery** when crypto service returns — circuit breaker transitions to HALF_OPEN after 30s

## Diagnosis
```bash
# Check OpenBao pod status
kubectl -n tnt-engine get pods -l app=openbao

# Check circuit breaker state via health endpoint
curl -s http://tnt-engine:8000/api/v1/health | jq .circuit_breaker

# Check crypto error metrics
curl -s http://tnt-engine:8000/metrics | grep tnt_crypto_errors

# Check OpenBao seal status
kubectl -n tnt-engine exec deploy/openbao -- bao status

# Check OpenBao transit key
kubectl -n tnt-engine exec deploy/openbao -- bao read transit/keys/tnt-key
```

## Resolution

### If OpenBao is sealed:
1. Unseal: `bao operator unseal <unseal-key>`
2. Circuit breaker auto-recovers after 30s.

### If OpenBao pod is down:
1. Restart: `kubectl -n tnt-engine rollout restart deployment/openbao`
2. Wait for pod ready + circuit breaker recovery (30s).

### If OpenBao is up but transit key missing:
1. Re-create key: `bao write -f transit/keys/tnt-key`
2. Re-create HMAC key: `bao write -f transit/keys/tnt-hmac`

### If token is expired/rotated:
1. Generate new token in OpenBao.
2. Update `TNT_CRYPTO_TOKEN` secret in Kubernetes.
3. Rolling restart: `kubectl -n tnt-engine rollout restart deployment/tnt-engine`

## Recovery verification
```bash
# Circuit breaker should show CLOSED
curl -s http://tnt-engine:8000/api/v1/health | jq .circuit_breaker
# Expected: "CLOSED"

# Test tokenize
curl -X POST http://tnt-engine:8000/api/v1/tokenize \
  -H 'Content-Type: application/json' \
  -d '{"value":"test","field":"ssn","tenant_id":"test"}'
```

## Escalation
- **L1**: Platform on-call
- **L2**: Security team (if key rotation or access policy issue)
