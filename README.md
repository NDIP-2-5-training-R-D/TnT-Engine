# TT Crypto Adapter

A FastAPI microservice that wraps [OpenBao](https://openbao.org/) transit secrets for the T&T Engine Core team. It provides HMAC signing, AES-256 encryption/decryption, and opaque tokenisation over a simple HTTP API.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Engine Core Services                    │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP (internal network only)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   TT Crypto Adapter :8300                   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  AuditLogMiddleware  (structured JSON, no plaintext) │   │
│  └───────────────────────────┬─────────────────────────┘   │
│                              │                              │
│  ┌────────────┐  ┌──────────────────┐  ┌────────────────┐  │
│  │  /health   │  │ /internal/crypto │  │ /crypto  /keys │  │
│  │  /ready    │  │ /internal/crypto │  │ /tokenize      │  │
│  │  (k8s)     │  │   /batch         │  │ /detokenize    │  │
│  └────────────┘  └────────┬─────────┘  └───────┬────────┘  │
│                           │                    │            │
│              ┌────────────▼────────────────────▼──────┐    │
│              │         OpenBaoClient                   │    │
│              │   AppRoleAuth  ·  CircuitBreaker        │    │
│              │   Retry (×3, exponential backoff)       │    │
│              └────────────────────────┬────────────────┘    │
└───────────────────────────────────────┼─────────────────────┘
                                        │ HTTP :8200
                                        ▼
                        ┌───────────────────────────┐
                        │       OpenBao :8200        │
                        │  Transit secrets engine    │
                        │  AppRole auth method       │
                        └───────────────────────────┘
```

---

## Quick Start (< 5 minutes)

### Prerequisites
- Docker ≥ 24 and Docker Compose v2
- `curl` and `jq` (for the smoke test)

### 1 — Start the stack

```bash
git clone <repo-url> tt-crypto-adapter
cd tt-crypto-adapter
docker compose up -d
```

This starts:
- **openbao** — OpenBao in dev mode (root token: `root`)
- **openbao-init** — one-shot initialisation (transit engine, AppRole, policy)
- **crypto-adapter** — the service on port 8300

### 2 — Get the AppRole credentials

The init script prints `ROLE_ID` and `SECRET_ID` to its logs:

```bash
docker compose logs openbao-init | grep -E "ROLE_ID|SECRET_ID"
```

Example output:
```
ROLE_ID=3fa85f64-5717-4562-b3fc-2c963f66afa6
SECRET_ID=8d4b3c2a-1e7f-4a9b-8c6d-5e2f1b0a9d8e
```

### 3 — Configure credentials

```bash
cp .env.example .env
# Edit .env and set OPENBAO_ROLE_ID and OPENBAO_SECRET_ID
```

### 4 — Restart the adapter with credentials

```bash
docker compose up -d crypto-adapter
```

### 5 — Smoke test

```bash
# Liveness
curl http://localhost:8300/health

# HMAC
curl -s -X POST http://localhost:8300/internal/crypto \
  -H "Content-Type: application/json" \
  -d '{"operation": "hmac", "input": "hello"}' | jq .

# Encrypt → decrypt round-trip
CT=$(curl -s -X POST http://localhost:8300/internal/crypto \
  -H "Content-Type: application/json" \
  -d '{"operation": "encrypt", "input": "my-secret"}' | jq -r .output)

curl -s -X POST http://localhost:8300/internal/crypto \
  -H "Content-Type: application/json" \
  -d "{\"operation\": \"decrypt\", \"input\": \"$CT\"}" | jq .
```

---

## API Endpoints Summary

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness probe |
| GET | `/ready` | Readiness probe (checks OpenBao) |
| POST | `/internal/crypto` | **Unified single operation** |
| POST | `/internal/crypto/batch` | **Unified batch (max 500)** |
| POST | `/crypto/hmac` | HMAC-SHA-512 |
| POST | `/crypto/encrypt` | AES-256-GCM encrypt |
| POST | `/crypto/decrypt` | AES-256-GCM decrypt |
| POST | `/crypto/rotate-key` | Rotate transit key |
| GET | `/crypto/key-info` | Key metadata |
| POST | `/tokenize` | Encrypt → opaque `tt1_` token |
| POST | `/detokenize` | Token → plaintext |
| POST | `/tokenize/batch` | Batch tokenise |
| GET | `/tokenize/validate` | Validate token format |
| GET | `/keys/{key_name}/info` | Key info |
| GET | `/keys/{key_name}/version` | Key version metadata |
| POST | `/keys/{key_name}/rotate` | Rotate named key |
| POST | `/keys/{key_name}/config` | Update key config |

Full request/response examples → [`docs/api-contract.md`](docs/api-contract.md)

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENBAO_ADDR` | `http://openbao:8200` | OpenBao server URL |
| `OPENBAO_ROLE_ID` | _(required)_ | AppRole role ID |
| `OPENBAO_SECRET_ID` | _(required)_ | AppRole secret ID |
| `OPENBAO_TRANSIT_KEY` | `tt-engine-key` | Default transit key name |
| `OPENBAO_TOKEN_CACHE_TTL` | `3600` | Token cache TTL in seconds |
| `SERVICE_PORT` | `8300` | Listening port |
| `SERVICE_HOST` | `0.0.0.0` | Listening address |
| `LOG_LEVEL` | `INFO` | Python log level |
| `INTEGRATION_BASE_URL` | `http://localhost:8300` | Base URL for integration tests |

Copy `.env.example` to `.env` and fill in `OPENBAO_ROLE_ID` and `OPENBAO_SECRET_ID`.

---

## Running Tests

### Unit tests (no docker required)

```bash
pip install -e ".[dev]"
pytest tests/test_auth.py tests/test_tokenization.py -v
```

### Integration tests (requires docker-compose)

```bash
docker compose up -d
# Wait for healthy:
docker compose ps

pytest -m integration tests/test_integration.py -v
```

---

## How to Rotate Keys Safely

Key rotation does **not** invalidate existing ciphertext — OpenBao keeps all previous key versions for decryption while using the newest version for new encryptions.

### Step 1 — Rotate

```bash
curl -s -X POST http://localhost:8300/crypto/rotate-key \
  -H "Content-Type: application/json" \
  -d '{"key_name": "tt-engine-key"}' | jq .
```

Response:
```json
{"rotated": true, "key_name": "tt-engine-key"}
```

### Step 2 — Verify new version

```bash
curl "http://localhost:8300/crypto/key-info?key_name=tt-engine-key" | jq .latest_version
```

### Step 3 — (Optional) Raise min decryption version

Once you have re-encrypted all data with the new key version, you can prevent decryption with older versions:

```bash
curl -s -X POST http://localhost:8300/keys/tt-engine-key/config \
  -H "Content-Type: application/json" \
  -d '{"min_decryption_version": 2}' | jq .
```

> **Warning:** Setting `min_decryption_version` higher than the version used to encrypt any stored data will permanently prevent decryption of that data.

---

## Integration Guide for Engine Core Team

### Recommended workflow

```
Lookup  →  HMAC (deterministic, use as DB index)
Storage →  tokenize (non-deterministic, opaque)
```

1. On ingest: call `hmac(value)` → store the HMAC in your search index.
2. On ingest: call `tokenize(value)` → store the token in your main record.
3. On lookup: call `hmac(query)` → search your index by HMAC.
4. On display: call `detokenize(token)` → retrieve the original value.

### Using the batch endpoint

For bulk operations (e.g., ingesting a CSV), use `/internal/crypto/batch` to minimise round-trips. Up to 500 items run concurrently; expect ~84 ms per 100 items on co-located services.

```python
import httpx

items = [{"operation": "hmac", "input": row["ssn"]} for row in csv_rows]
resp = httpx.post(
    "http://crypto-adapter:8300/internal/crypto/batch",
    json={"items": items},
    timeout=10,
)
results = resp.json()["results"]
```

### Tracing

Pass `X-Request-ID` on every request. The same ID is echoed in the response and appears in every audit log line, making it trivial to correlate across services.

### Resilience

The adapter includes:
- **Automatic retry** — 3 attempts with exponential backoff (0.5 s → 4 s) on OpenBao network errors.
- **Circuit breaker** — trips after 5 consecutive OpenBao failures; recovers after 30 s. Returns `503 CIRCUIT_OPEN` while open.
- **Token auto-renewal** — renews the OpenBao AppRole token 120 s before expiry; falls back to a fresh login if renewal fails.

Callers should implement their own retry on `503 VAULT_UNAVAILABLE` and `503 CIRCUIT_OPEN` with exponential backoff.
