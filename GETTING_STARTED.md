# T&T Engine — Hướng Dẫn Chạy & Tổng Quan

## Trạng thái hiện tại

> Server chạy OK. 17/17 tests PASSED.

---

## 1. Yêu cầu

- Python 3.12+
- Không cần Docker, không cần DB, không cần OpenBao — toàn bộ đang dùng **mock**

---

## 2. Cài đặt lần đầu

```bash
# Clone / vào thư mục project
cd "TnT-Engine"

# Tạo virtual environment
python -m venv .venv

# Activate (Windows)
.venv\Scripts\activate

# Cài dependencies
pip install -r requirements.txt
```

---

## 3. Chạy server

```bash
# Activate venv trước (nếu chưa)
.venv\Scripts\activate

# Chạy server (auto-reload khi sửa code)
uvicorn app.main:app --reload --port 8000
```

Server sẽ chạy tại: **http://localhost:8000**

| URL | Mô tả |
|-----|-------|
| http://localhost:8000/docs | Swagger UI — test API trực tiếp |
| http://localhost:8000/redoc | ReDoc — tài liệu API |
| http://localhost:8000/health | Health check |

---

## 4. Chạy tests

```bash
# Activate venv trước
.venv\Scripts\activate

pytest tests/ -v
```

Kết quả hiện tại:
```
17 passed in 1.21s
```

---

## 5. Auth

Tất cả API đều yêu cầu header:

```
X-Vault-Token: mock-vault-token
```

Giá trị này được config trong `.env` hoặc `docker-compose.yml`. Có thể thay đổi bằng cách set biến môi trường `VAULT_TOKEN`.

---

## 6. Những gì đã có

### 6.1 Cấu trúc project

```
TnT-Engine/
├── app/
│   ├── main.py                        # FastAPI entry point, middleware, /health
│   ├── config.py                      # Đọc config từ .env (pydantic-settings)
│   ├── api/
│   │   ├── dependencies.py            # Auth: kiểm tra X-Vault-Token
│   │   └── routes/
│   │       ├── transform.py           # /v1/transform/... (role, template, transformation, encode/decode, key)
│   │       ├── transit.py             # /v1/transit/... (encrypt, decrypt, sign, verify)
│   │       └── process.py             # /process và /process/batch
│   ├── core/
│   │   ├── orchestrator.py            # Pipeline engine động
│   │   ├── canonicalizer.py           # Chuẩn hóa dữ liệu
│   │   ├── policy_loader.py           # Load pipeline config (mock từ JSON)
│   │   └── pipeline_steps/
│   │       ├── canonicalize.py        # Step: chuẩn hóa
│   │       ├── hmac_step.py           # Step: HMAC
│   │       ├── tokenize.py            # Step: tokenize
│   │       └── mask.py                # Step: masking
│   ├── adapters/
│   │   ├── crypto_adapter.py          # Mock OpenBao (Longth0903 sẽ thay)
│   │   └── db_adapter.py              # Mock Postgres/Redis (Thienlinh sẽ thay)
│   └── models/
│       ├── requests.py                # Pydantic request schemas
│       └── responses.py               # Pydantic response schemas
├── policies/
│   └── mock_policies.json             # Pipeline config mẫu: test-role, default-role
├── tests/
│   ├── test_api.py                    # Integration tests (6 tests)
│   ├── test_orchestrator.py           # Orchestrator unit tests (4 tests)
│   └── test_canonicalizer.py          # Canonicalizer unit tests (7 tests)
├── .venv/                             # Virtual environment (không commit)
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
└── pytest.ini
```

### 6.2 API Endpoints

#### Transform — Role
| Method | Path | Mô tả |
|--------|------|-------|
| POST | `/v1/transform/role/{role_name}` | Tạo role |
| GET | `/v1/transform/role/{role_name}` | Xem role |
| GET | `/v1/transform/role` | Danh sách role |
| DELETE | `/v1/transform/role/{role_name}` | Xóa role |

#### Transform — Template (Masking)
| Method | Path | Mô tả |
|--------|------|-------|
| POST | `/v1/transform/template/{template_name}` | Tạo template |
| GET | `/v1/transform/template/{template_name}` | Xem template |
| GET | `/v1/transform/template` | Danh sách template |
| DELETE | `/v1/transform/template/{template_name}` | Xóa template |

#### Transform — Transformations
| Method | Path | Mô tả |
|--------|------|-------|
| POST | `/v1/transform/transformations/masking/{name}` | Tạo masking transformation |
| POST | `/v1/transform/transformations/fpe/{name}` | Tạo FPE transformation |
| POST | `/v1/transform/transformations/tokenization/{name}` | Tạo tokenization transformation |
| GET | `/v1/transform/transformation/{name}` | Xem transformation |
| GET | `/v1/transform/transformation` | Danh sách transformation |
| DELETE | `/v1/transform/transformation/{name}` | Xóa transformation |

#### Transform — Encode / Decode
| Method | Path | Mô tả |
|--------|------|-------|
| POST | `/v1/transform/encode/{role_name}` | FPE encode |
| POST | `/v1/transform/decode/{role_name}` | FPE decode |

#### Transform — Key Management
| Method | Path | Mô tả |
|--------|------|-------|
| POST | `/v1/transform/transformations/fpe/{name}/rotate-key` | Rotate key FPE |
| GET | `/v1/transform/transformations/fpe/{name}/keys` | Xem keys FPE |
| POST | `/v1/transform/transformations/tokenization/{name}/rotate-key` | Rotate key tokenization |
| GET | `/v1/transform/transformations/tokenization/{name}/keys` | Xem keys tokenization |

#### Transit
| Method | Path | Mô tả |
|--------|------|-------|
| POST | `/v1/transit/keys/{key_name}` | Tạo key |
| POST | `/v1/transit/encrypt/{key_name}` | Encrypt (plaintext base64) |
| POST | `/v1/transit/decrypt/{key_name}` | Decrypt (ciphertext vault:v1:...) |
| POST | `/v1/transit/sign/{key_name}` | Sign |
| POST | `/v1/transit/verify/{key_name}` | Verify signature |

#### Process (Unified)
| Method | Path | Mô tả |
|--------|------|-------|
| POST | `/process` | Xử lý 1 request (nhiều fields) |
| POST | `/process/batch` | Xử lý batch song song |
| GET | `/health` | Health check |

---

### 6.3 Orchestrator — Pipeline động

Pipeline được load từ `policies/mock_policies.json`. Ví dụ:

```json
"test-role": {
  "fields": {
    "card_number": ["canonicalize", "hmac", "tokenize"],
    "name":        ["canonicalize", "mask"]
  }
}
```

Khi gọi `/process` với `role: "test-role"`:
- Field `card_number` sẽ chạy qua 3 bước: chuẩn hóa → HMAC → tokenize
- Field `name` sẽ chạy qua 2 bước: chuẩn hóa → masking
- Nếu 1 bước lỗi → bước tiếp vẫn chạy, lỗi ghi vào `errors`, status trả về `"partial"`

### 6.4 Response chuẩn

```json
{
  "status": "success",
  "request_id": "uuid",
  "results": {
    "card_number": {
      "original": "4111111111111111",
      "result": "tok_abc123...",
      "steps_applied": ["canonicalize", "hmac", "tokenize"],
      "errors": []
    }
  },
  "errors": []
}
```

---

## 7. Config (.env)

Tạo file `.env` ở root (nếu cần override):

```env
APP_ENV=development
LOG_LEVEL=info
VAULT_TOKEN=mock-vault-token
CRYPTO_ADAPTER=mock
DB_ADAPTER=mock
PORT=8000
```

---

## 8. Phân công team — những gì cần swap sau

| Phần | Owner | File cần thay |
|------|-------|---------------|
| OpenBao / Crypto | Longth0903 | `app/adapters/crypto_adapter.py` |
| Postgres / Redis | Thienlinh | `app/adapters/db_adapter.py` |
| Policy từ DB thật | Thienlinh | `app/core/policy_loader.py` → hàm `_load()` |

Tìm tất cả các chỗ cần thay bằng lệnh:

```bash
grep -rn "# TODO" app/
```

---

## 9. Chạy bằng Docker (tùy chọn)

```bash
docker-compose up --build
```

Server sẽ chạy tại http://localhost:8000, tự mount code từ `./app` vào container.
