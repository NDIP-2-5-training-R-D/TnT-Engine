# Runbook: Disaster Recovery

**Scope**: Full T&T Engine environment recovery  
**Owner**: Platform team + Security team

## Recovery Targets

| Component | RPO | RTO | Backup Method |
|---|---|---|---|
| PostgreSQL | 1 hour | 30 minutes | `scripts/db-backup.sh` (pg_dump, hourly cron) |
| OpenBao | 4 hours | 1 hour | `scripts/vault-backup.sh` (raft snapshot, 4h cron) |
| Redis | N/A | 5 minutes | Ephemeral cache — restart and warm from DB |
| Application | N/A | 5 minutes | Stateless — Helm rollout from registry |

## 1. PostgreSQL Recovery

```bash
# List available backups
ls -lt /tmp/tnt-backups/tnt_engine_*.sql.gz

# Restore from latest backup
export PGHOST=postgres PGUSER=tnt PGDATABASE=tnt_engine
gunzip -c /tmp/tnt-backups/tnt_engine_LATEST.sql.gz | pg_restore -d tnt_engine --clean --if-exists

# Verify
psql -c "SELECT count(*) FROM token_store;"
psql -c "SELECT count(*) FROM audit_log;"
```

## 2. OpenBao Recovery

```bash
# List available snapshots
ls -lt /tmp/tnt-vault-backups/vault_raft_*.snap

# Restore from latest snapshot
export VAULT_ADDR=http://openbao:8200 VAULT_TOKEN=<root-token>
bash scripts/vault-restore.sh /tmp/tnt-vault-backups/vault_raft_LATEST.snap

# Unseal after restore
bao operator unseal  # provide key shares

# Verify transit keys exist
bao read transit/keys/tnt-key
bao read transit/keys/tnt-hmac

# If transit keys are missing, re-create
bao write -f transit/keys/tnt-key type=aes256-gcm96
bao write -f transit/keys/tnt-hmac type=aes256-gcm96
```

## 3. Redis Recovery

Redis is an ephemeral cache. No backup needed.

```bash
# Restart Redis
kubectl -n tnt-engine rollout restart deployment/redis

# Warm the cache from DB via admin API
curl -X POST http://tnt-engine:8000/admin/cache/rebuild
```

## 4. Application Recovery

The T&T Engine is stateless — all state is in PostgreSQL and OpenBao.

```bash
# Deploy from latest known-good image
helm upgrade --install tnt-engine ./helm/tnt-engine \
  --values ./helm/values-prod.yaml \
  --set image.tag=<last-known-good-sha>

# Verify health
kubectl -n tnt-engine get pods
curl -s http://tnt-engine:8000/api/v1/health
```

## 5. Full Environment Rebuild Checklist

1. [ ] PostgreSQL restored and verified
2. [ ] OpenBao restored, unsealed, transit keys verified
3. [ ] Redis restarted
4. [ ] Application deployed and healthy
5. [ ] Cache warmed (`/admin/cache/rebuild`)
6. [ ] Audit DLQ replayed (`/admin/audit/dlq/replay`)
7. [ ] Circuit breaker CLOSED
8. [ ] Tokenize/detokenize end-to-end test passed
9. [ ] Prometheus alerts cleared
10. [ ] Stakeholders notified

## 6. Post-Recovery Key Rotation

After any DR event, rotate keys as a precaution:

```bash
# Rotate transit encryption key
bao write -f transit/keys/tnt-key/rotate

# Trigger re-encryption of old tokens (background worker)
curl -X POST http://tnt-engine:8000/admin/reencrypt \
  -H 'Content-Type: application/json' \
  -d '{"target_key_version": <new_version>}'

# Rotate AppRole secret_id
cd terraform/openbao
terraform taint vault_approle_auth_backend_role_secret_id.tnt_engine
terraform apply
# Update the K8s secret with the new secret_id
```
