# T&T Engine — Core

Transform & Transit Engine built with FastAPI. This repo covers the **Core** layer:
API, Orchestrator, Policy Loader, Canonicalizer, Adapters (mocked).

## Team

| Part | Owner |
|------|-------|
| Core (this repo) | Đức Long |
| OpenBao / Crypto adapter | Longth0903 |
| DB / Postgres / Redis adapter | Thienlinh |

---

## Quick Start

```bash
# Local (Python 3.12+)
pip install -r requirements.txt
uvicorn app.main:app --reload

# Docker
docker-compose up --build
```

API docs: http://localhost:8000/docs

---

## Auth

All endpoints require `X-Vault-Token` header.

```
X-Vault-Token: mock-vault-token   # set in .env / docker-compose
```

---

## Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/process` | Process fields for a role |
| POST | `/process/batch` | Batch process (parallel) |
| POST | `/v1/transform/role/{name}` | Create role |
| POST | `/v1/transform/encode/{role}` | FPE encode |
| POST | `/v1/transit/encrypt/{key}` | Transit encrypt |

Full list in Swagger: `/docs`

---

## Running Tests

```bash
pytest tests/ -v
```

---

## Configuration (.env)

```env
APP_ENV=development
LOG_LEVEL=info
VAULT_TOKEN=mock-vault-token
CRYPTO_ADAPTER=mock
DB_ADAPTER=mock
```

---

## Swap Mock Adapters

- **Crypto (OpenBao)**: replace `app/adapters/crypto_adapter.py` — all `# TODO` markers show where HTTP calls go.
- **DB/Redis**: replace `app/adapters/db_adapter.py` — same pattern.
- **Policy Loader**: replace `app/core/policy_loader.py` `_load()` with real DB query.

Pipeline steps are registered in `app/core/orchestrator.py` `_STEP_REGISTRY` — add new steps without touching Orchestrator logic.
