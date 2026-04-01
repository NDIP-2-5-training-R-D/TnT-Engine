# 🤖 Claude VS Code — Prompt Script: T&T Engine Core (Đức Long)

> Copy toàn bộ nội dung này và paste vào Claude trong VS Code.

---

## CONTEXT

Tôi đang build lại từ đầu hệ thống **Transform & Transit (T&T) Engine** bằng **Python / FastAPI**.

Đây là phần **Engine Core** gồm:
- API Layer
- Orchestrator Engine
- Policy Loader
- Canonicalization
- Error Handling
- Batch Processing

Phần **OpenBao / Crypto** (do teammate Longth0903 làm) và phần **DB / Postgres / Redis** (do teammate Thienlinh làm) đang được làm song song. Vì vậy, phần Core của tôi cần **mock/abstract** những phần đó qua interface — không gọi thật vào OpenBao hay DB trong giai đoạn này.

---

## YÊU CẦU BUILD

### 1. Cấu trúc project

```
tnt-engine/
├── app/
│   ├── main.py                  # FastAPI app entry point
│   ├── api/
│   │   ├── __init__.py
│   │   ├── routes/
│   │   │   ├── transform.py     # Các route /v1/transform/...
│   │   │   ├── transit.py       # Các route /v1/transit/...
│   │   │   └── process.py       # Route /process và /process/batch
│   │   └── dependencies.py      # Auth header, policy loader injection
│   ├── core/
│   │   ├── orchestrator.py      # Pipeline engine động
│   │   ├── canonicalizer.py     # Canonicalization: sort key, trim, NFC
│   │   ├── policy_loader.py     # Load pipeline config từ DB (mock trước)
│   │   └── pipeline_steps/
│   │       ├── __init__.py
│   │       ├── canonicalize.py
│   │       ├── hmac_step.py
│   │       ├── tokenize.py
│   │       └── mask.py
│   ├── adapters/
│   │   ├── crypto_adapter.py    # Interface gọi OpenBao (mock)
│   │   └── db_adapter.py        # Interface gọi DB/Redis (mock)
│   ├── models/
│   │   ├── requests.py          # Pydantic request schemas
│   │   └── responses.py         # Pydantic response schemas
│   └── config.py                # Settings từ env
├── tests/
│   ├── test_api.py
│   ├── test_orchestrator.py
│   └── test_canonicalizer.py
├── docker-compose.yml
├── Dockerfile
├── requirements.txt
└── README.md
```

---

### 2. API Layer

Tạo các API theo chuẩn Postman collection đính kèm. Auth qua header `X-Vault-Token`.

#### Transform / Role
| Method | Path | Body |
|--------|------|------|
| POST | `/v1/transform/role/{role_name}` | `{"transformations": ["fpe-ssn", "token-cc"]}` |
| GET | `/v1/transform/role/{role_name}` | — |
| GET | `/v1/transform/role` (LIST) | — |
| DELETE | `/v1/transform/role/{role_name}` | — |

#### Transform / Template (Masking)
| Method | Path | Body |
|--------|------|------|
| POST | `/v1/transform/template/{template_name}` | `{"type": "regex", "pattern": "..."}` |
| GET | `/v1/transform/template/{template_name}` | — |
| GET | `/v1/transform/template` (LIST) | — |
| DELETE | `/v1/transform/template/{template_name}` | — |

#### Transform / Transformations
| Method | Path | Body |
|--------|------|------|
| POST | `/v1/transform/transformations/masking/{name}` | `{"type":"masking","template":"cc-mask","masking_character":"X","allowed_roles":["test-role"]}` |
| POST | `/v1/transform/transformations/fpe/{name}` | `{"type":"fpe","alphabet":"numeric","tweak_source":"internal","allowed_roles":["test-role"]}` |
| POST | `/v1/transform/transformations/tokenization/{name}` | `{"type":"tokenization","mapping_mode":"default","convergent":false,"allowed_roles":["test-role"],"store":"postgres"}` |
| GET | `/v1/transform/transformation/{name}` | — |
| GET | `/v1/transform/transformation` (LIST) | — |
| DELETE | `/v1/transform/transformation/{name}` | — |

#### Transform / Alphabet (FPE)
| Method | Path | Body |
|--------|------|------|
| POST | `/v1/transform/alphabet/{alphabet_name}` | `{"alphabet": "0123456789"}` |

#### Transform / Encode & Decode
| Method | Path | Body |
|--------|------|------|
| POST | `/v1/transform/encode/{role_name}` | `{"value": "...", "transformation": "..."}` |
| POST | `/v1/transform/decode/{role_name}` | `{"value": "...", "transformation": "..."}` |

#### Transform / Key Management
| Method | Path |
|--------|------|
| POST | `/v1/transform/transformations/fpe/{name}/rotate-key` |
| GET | `/v1/transform/transformations/fpe/{name}/keys` |
| POST | `/v1/transform/transformations/tokenization/{name}/rotate-key` |
| GET | `/v1/transform/transformations/tokenization/{name}/keys` |

#### Transit (Encrypt / Decrypt / Sign / Verify)
| Method | Path | Body |
|--------|------|------|
| POST | `/v1/transit/keys/{key_name}` | `{"type": "aes256-gcm96"}` |
| POST | `/v1/transit/encrypt/{key_name}` | `{"plaintext": "<base64>"}` |
| POST | `/v1/transit/decrypt/{key_name}` | `{"ciphertext": "vault:v1:..."}` |
| POST | `/v1/transit/sign/{key_name}` | `{"input": "<base64>"}` |
| POST | `/v1/transit/verify/{key_name}` | `{"input": "<base64>", "signature": "..."}` |

#### Process API (Unified)
| Method | Path | Body |
|--------|------|------|
| POST | `/process` | `{"role": "...", "fields": [{"name": "card_number", "value": "...", "transformation": "token-cc"}]}` |
| POST | `/process/batch` | `{"items": [{ role, fields }]}` |

---

### 3. Orchestrator Engine

```python
# Yêu cầu:
# - Pipeline động, load từ Policy Loader
# - Chạy đúng thứ tự các step
# - Support multi-step trên cùng 1 field
# - Nếu 1 step fail -> vẫn chạy step khác, ghi lỗi vào result
# - Output đúng mapping: {"field_name": {"original": ..., "result": ..., "steps": [...], "errors": [...]}}

# Các step được support:
# - canonicalize   -> dùng Canonicalizer
# - hmac           -> gọi crypto_adapter.hmac()
# - tokenize       -> gọi crypto_adapter.tokenize()
# - mask           -> xử lý local theo masking template

# Ví dụ pipeline config từ DB:
# {
#   "role": "test-role",
#   "fields": {
#     "card_number": ["canonicalize", "hmac", "tokenize"],
#     "name": ["canonicalize", "mask"]
#   }
# }
```

---

### 4. Canonicalizer

```python
# Yêu cầu đảm bảo deterministic HMAC:
# 1. Sort keys nếu input là dict
# 2. Strip whitespace (trim)
# 3. Unicode normalize về NFC
# 4. Lowercase (optional, configurable)

import unicodedata

def canonicalize(value: str) -> str:
    value = value.strip()
    value = unicodedata.normalize("NFC", value)
    return value

def canonicalize_dict(data: dict) -> str:
    sorted_items = sorted(data.items())
    parts = [f"{k}={canonicalize(str(v))}" for k, v in sorted_items]
    return "&".join(parts)
```

---

### 5. Policy Loader

```python
# Yêu cầu:
# - Load pipeline config từ DB (không hardcode)
# - Trong giai đoạn này: mock từ file JSON hoặc in-memory dict
# - Interface phải giống như khi load từ DB thật để dễ swap sau

# Interface:
class PolicyLoader:
    async def get_pipeline(self, role: str) -> dict:
        """Trả về pipeline config cho role"""
        ...

    async def get_transformation(self, name: str) -> dict:
        """Trả về config của transformation"""
        ...

# Mock implementation: load từ policies/mock_policies.json
```

---

### 6. Adapters (Mock)

```python
# crypto_adapter.py — Mock, sẽ được thay bằng OpenBao thật
class CryptoAdapter:
    async def hmac(self, key_name: str, value: str) -> str:
        """Mock: return fake HMAC"""
        import hashlib, hmac
        return hmac.new(b"mock-key", value.encode(), hashlib.sha512).hexdigest()

    async def tokenize(self, transformation: str, value: str, convergent: bool = False) -> str:
        """Mock: return fake token"""
        import uuid
        return f"tok_{uuid.uuid4().hex[:16]}"

    async def detokenize(self, transformation: str, token: str) -> str:
        """Mock: not reversible in mock"""
        return "MOCK_DETOKENIZED"

# db_adapter.py — Mock, sẽ được thay bằng Postgres/Redis thật
class DbAdapter:
    async def save_token(self, token: str, original: str): ...
    async def lookup_token(self, token: str) -> str: ...
```

---

### 7. Validation & Error Handling

```python
# Yêu cầu:
# - Validate input bằng Pydantic (missing field -> 422 rõ ràng)
# - Không crash khi field bị thiếu hoặc null
# - Return chuẩn structure dù có lỗi hay không:

# Response structure chuẩn:
{
  "status": "success" | "partial" | "error",
  "request_id": "uuid",
  "results": {
    "field_name": {
      "original": "...",
      "result": "...",
      "steps_applied": ["canonicalize", "hmac"],
      "errors": []
    }
  },
  "errors": []
}

# Nếu 1 step fail:
# - step đó ghi vào field.errors
# - step tiếp theo vẫn chạy với giá trị trước đó
# - status trả về "partial"
```

---

### 8. Batch Processing

```python
# POST /process/batch
# - Xử lý song song bằng asyncio.gather()
# - Không block khi 1 item fail
# - Response:
{
  "status": "partial" | "success" | "error",
  "total": 10,
  "succeeded": 9,
  "failed": 1,
  "results": [ ... ],
  "errors": [ ... ]
}
```

---

### 9. Tiêu chí chất lượng

- [ ] Tất cả API có Pydantic schema (request + response)
- [ ] Auth header `X-Vault-Token` được check ở dependency
- [ ] Orchestrator không hardcode step nào
- [ ] Canonicalizer có unit test riêng
- [ ] Batch dùng `asyncio.gather` với `return_exceptions=True`
- [ ] Không có raw `except: pass` — luôn log và trả lỗi có nghĩa
- [ ] Có `GET /health` endpoint
- [ ] Có `docker-compose.yml` chạy được local
- [ ] `requirements.txt` đầy đủ

---

### 10. Tech stack & versions

```
fastapi>=0.111.0
uvicorn[standard]>=0.29.0
pydantic>=2.0.0
pydantic-settings
httpx              # để gọi OpenBao thật sau này
python-multipart
asyncpg            # sẵn sàng cho DB sau này
redis              # sẵn sàng cho cache sau này
pytest
pytest-asyncio
```

---

## LƯU Ý QUAN TRỌNG

1. **Không gọi thật vào OpenBao hay DB** — dùng mock adapter, interface rõ ràng để teammate swap vào sau.
2. **Mọi config** (host, port, secret) phải đọc từ `.env` qua `pydantic-settings`.
3. **Pipeline phải động** — không if/else cứng cho từng transformation type trong Orchestrator.
4. **Ghi rõ TODO** ở những chỗ sẽ cần thay mock bằng real implementation.
5. Tạo file `mock_policies.json` mẫu với ít nhất 2 role: `test-role` và `default-role`.

---

## BẮT ĐẦU

Hãy build theo thứ tự sau:
1. Project scaffold + `requirements.txt` + `docker-compose.yml`
2. Models (Pydantic schemas)
3. Canonicalizer + unit tests
4. Policy Loader (mock)
5. Mock Adapters
6. Orchestrator Engine
7. API routes (`/v1/transform/...`, `/v1/transit/...`)
8. `/process` và `/process/batch`
9. Health check + error middleware
10. README

Bắt đầu từ bước 1 đi nhé.
