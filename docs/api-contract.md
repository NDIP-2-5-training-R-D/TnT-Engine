# TT Crypto Adapter — API Contract

> **Audience:** Engine Core team  
> **Version:** 0.1.0  
> **Last updated:** 2026-04-01

---

## Base URL

```
http://crypto-adapter:8300
```

The service is **internal-network only**. There is no external authentication — all traffic must originate from within the service mesh. Callers are trusted by network policy.

---

## Authentication

No token or API key is required from callers. The service authenticates to OpenBao internally using AppRole credentials configured at deploy time.

---

## Request / Response Conventions

| Header | Direction | Description |
|---|---|---|
| `Content-Type: application/json` | Request | Required for all POST endpoints |
| `X-Request-ID` | Request (optional) | Caller-supplied trace ID; any string ≤ 128 chars |
| `X-Request-ID` | Response | Echo of the caller's ID, or a server-generated UUID4 if not supplied |

All responses are `application/json`.

---

## Endpoints

### Health & Readiness

#### `GET /health`

Liveness probe. Always returns 200 if the process is running.

**Response 200**
```json
{
  "status": "ok",
  "service": "tt-crypto-adapter",
  "version": "0.1.0"
}
```

#### `GET /ready`

Readiness probe. Returns 200 only when an OpenBao token has been obtained successfully.

**Response 200**
```json
{ "status": "ready", "openbao": "connected" }
```

**Response 503**
```json
{ "status": "not_ready", "openbao": "unreachable" }
```

---

### Internal Unified Endpoint (Engine Core)

#### `POST /internal/crypto`

Execute a single crypto operation.

**Request**
```json
{
  "operation": "hmac",
  "input": "<string>",
  "key_name": "tt-engine-key",
  "request_id": "optional-trace-id"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `operation` | enum | Yes | `hmac` \| `encrypt` \| `decrypt` \| `tokenize` \| `detokenize` |
| `input` | string | Yes | The value to process |
| `key_name` | string | No | Transit key name; defaults to `OPENBAO_TRANSIT_KEY` env var |
| `request_id` | string | No | Trace ID forwarded into the response |

**Response 200**
```json
{
  "operation": "hmac",
  "output": "vault:v1:hmac-sha512:k3BT…",
  "key_name": "tt-engine-key",
  "request_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6"
}
```

**Example — HMAC**
```bash
curl -s -X POST http://crypto-adapter:8300/internal/crypto \
  -H "Content-Type: application/json" \
  -d '{"operation": "hmac", "input": "hello"}' | jq .
```

**Example — Encrypt then decrypt**
```bash
# Encrypt
CT=$(curl -s -X POST http://crypto-adapter:8300/internal/crypto \
  -H "Content-Type: application/json" \
  -d '{"operation": "encrypt", "input": "my-secret"}' | jq -r .output)

# Decrypt
curl -s -X POST http://crypto-adapter:8300/internal/crypto \
  -H "Content-Type: application/json" \
  -d "{\"operation\": \"decrypt\", \"input\": \"$CT\"}" | jq .
```

---

#### `POST /internal/crypto/batch`

Execute up to **500** operations concurrently in a single call.

**Request**
```json
{
  "items": [
    {"operation": "hmac",      "input": "value-0"},
    {"operation": "tokenize",  "input": "PAN-1111"},
    {"operation": "encrypt",   "input": "secret-2"}
  ]
}
```

**Response 200**
```json
{
  "results": [
    {
      "success": true,
      "operation": "hmac",
      "output": "vault:v1:hmac-sha512:…",
      "key_name": "tt-engine-key",
      "request_id": "…"
    },
    {
      "success": false,
      "operation": "tokenize",
      "key_name": "tt-engine-key",
      "request_id": "…",
      "error_code": "CRYPTO_ERROR",
      "error_message": "OpenBao returned 400: …"
    }
  ],
  "total": 3,
  "success_count": 2,
  "error_count": 1,
  "duration_ms": 84.3
}
```

**Limits**
- Maximum **500 items** per batch. Exceeding this returns `400 INVALID_INPUT`.
- All items run concurrently via `asyncio.gather`. Expect < 2 s for 100 items under normal load.
- Per-item failures are reported inline (`success: false`); they do **not** abort the batch.

---

### Crypto Endpoints (Direct)

#### `POST /crypto/hmac`
```json
// Request
{"input": "hello", "key_name": "tt-engine-key"}

// Response 200
{"hmac": "vault:v1:hmac-sha512:…", "key_name": "tt-engine-key", "algorithm": "sha2-512"}
```

#### `POST /crypto/encrypt`
```json
// Request
{"plaintext": "my-secret", "key_name": "tt-engine-key"}

// Response 200
{"ciphertext": "vault:v1:…", "key_name": "tt-engine-key"}
```

#### `POST /crypto/decrypt`
```json
// Request
{"ciphertext": "vault:v1:…", "key_name": "tt-engine-key"}

// Response 200
{"plaintext": "my-secret"}
```

#### `POST /crypto/rotate-key`
```json
// Request
{"key_name": "tt-engine-key"}

// Response 200
{"rotated": true, "key_name": "tt-engine-key"}
```

---

### Tokenization Endpoints

#### `POST /tokenize`
```json
// Request
{"value": "PAN:4111111111111111", "key_name": "tt-engine-key"}

// Response 200
{"token": "tt1_dGhlLXNlY3JldA", "key_name": "tt-engine-key"}
```

#### `POST /detokenize`
```json
// Request
{"token": "tt1_dGhlLXNlY3JldA", "key_name": "tt-engine-key"}

// Response 200
{"value": "PAN:4111111111111111", "key_name": "tt-engine-key"}
```

#### `POST /tokenize/batch`
```json
// Request
{"items": [{"value": "v1", "key_name": "k"}, {"value": "v2"}]}

// Response 200
{"results": [...], "success_count": 2, "error_count": 0}
```

#### `GET /tokenize/validate?token=tt1_…`
```json
{"valid": true, "format": "tt1"}
```

---

## Token Format Specification

```
tt1_<base64url-no-padding>
```

| Component | Description |
|---|---|
| `tt1_` | Fixed prefix identifying the T&T token format version 1 |
| `<base64url-no-padding>` | URL-safe base64 (RFC 4648 §5) encoding of the OpenBao transit ciphertext, minus the `vault:v1:` prefix |

**Important:** `tokenize` is **NON-DETERMINISTIC**. Calling `tokenize("hello")` twice produces two *different* tokens (AES-GCM with a fresh nonce each call). This is intentional for security.

> **For lookups, always use `hmac`.** HMAC-SHA-512 is deterministic — the same input always yields the same digest. Store the HMAC alongside the token and query by HMAC.  
> **For storage, use `tokenize`.** The opaque token reveals nothing about the original value.

---

## HMAC Format Specification

```
vault:v1:hmac-sha512:<base64-digest>
```

| Component | Description |
|---|---|
| `vault:v1:` | OpenBao transit versioning prefix |
| `hmac-sha512:` | Algorithm identifier |
| `<base64-digest>` | Standard base64 (RFC 4648 §4) encoding of the 64-byte SHA-512 digest |

The HMAC is keyed with the named transit key. Rotating the key changes future HMACs; existing stored HMACs remain valid against the previous key version.

---

## Error Codes

All error responses follow this schema:

```json
{
  "error_code": "AUTH_FAILED",
  "message": "Human-readable description",
  "request_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "timestamp": "2026-04-01T12:00:00.000000+00:00"
}
```

| Error Code | HTTP Status | Cause |
|---|---|---|
| `AUTH_FAILED` | 401 | AppRole login or token renewal failure |
| `CRYPTO_ERROR` | 422 | Transit operation rejected by OpenBao |
| `VAULT_UNAVAILABLE` | 503 | OpenBao unreachable (network error / timeout) |
| `CIRCUIT_OPEN` | 503 | Circuit breaker tripped after repeated OpenBao failures |
| `INVALID_INPUT` | 400 | Malformed request body or failed validation |
| `INVALID_TOKEN` | 400 | Token does not have `tt1_` prefix or contains invalid characters |
| `NOT_FOUND` | 404 | Requested resource does not exist |

---

## Batch Limits

| Constraint | Value |
|---|---|
| Max items per batch | 500 |
| Concurrency model | `asyncio.gather` — all items run concurrently |
| Per-item timeout | Inherits the 10 s HTTP client timeout to OpenBao |
| Partial failures | Reported inline; do not abort the rest of the batch |

---

## Health Check Endpoints for Kubernetes Probes

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 8300
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /ready
    port: 8300
  initialDelaySeconds: 10
  periodSeconds: 5
  failureThreshold: 3
```

`/health` — checks the process is alive (no OpenBao contact).  
`/ready` — checks OpenBao connectivity by attempting to obtain a valid token.
