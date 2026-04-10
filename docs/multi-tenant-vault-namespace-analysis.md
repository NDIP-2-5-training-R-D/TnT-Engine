# Phân Tích: Multi-Tenant Vault Namespace trong TnT-Engine

> **Ngày phân tích:** 2026-04-09  
> **Phạm vi:** OpenBao (Vault) namespace, isolation theo tenant, kiến trúc multi-tenant

---

## 1. Tổng Quan Kiến Trúc Hiện Tại

TnT-Engine là một platform tokenization PII (Personally Identifiable Information) với kiến trúc multi-tenant. Hệ thống sử dụng **OpenBao** (fork mã nguồn mở của HashiCorp Vault) làm backend mã hóa thông qua Transit Secrets Engine.

### 1.1 Sơ Đồ Luồng Tenant

```
Tenant A / Tenant B / Tenant C
         │
         ▼
┌─────────────────────────────────────┐
│  API Layer (FastAPI)                │
│  TokenizeRequest { tenant_id: "A" } │
└────────────────┬────────────────────┘
                 │
         ┌───────▼────────┐
         │  Token Service  │  ← tenant_id bắt buộc ở mọi operation
         └───────┬─────────┘
    ┌────────────┼────────────┐
    ▼            ▼            ▼
┌────────┐  ┌────────┐  ┌──────────────────┐
│  DB    │  │ Cache  │  │  OpenBao Transit  │
│(tenant_│  │(tenant_│  │  (shared engine,  │
│ scope) │  │ scope) │  │   shared keys)    │
└────────┘  └────────┘  └──────────────────┘
```

---

## 2. Cách Triển Khai Multi-Tenant Hiện Tại

### 2.1 Application-Level Isolation (Đang áp dụng)

Hệ thống thực hiện isolation **tại tầng ứng dụng**, không phải tại tầng Vault namespace.

#### Tầng Database — `src/tnt_engine/db/repository.py`

Mọi query đều có `tenant_id` như một điều kiện bắt buộc:

```python
# Token lookup — chỉ trả về token của đúng tenant
async def find_token_by_hash(self, hmac_hash: str, tenant_id: str) -> str | None:
    row = await self._db.read_pool.fetchrow(
        "SELECT token FROM token_lookup WHERE hash = $1 AND tenant_id = $2",
        hmac_hash, tenant_id,  # tenant_id luôn được enforce
    )

# Token store — phân biệt theo tenant
async def get_token_record(self, token: str, tenant_id: str) -> TokenRecord | None:
    row = await self._db.read_pool.fetchrow(
        "SELECT ... FROM token_store WHERE token = $1 AND tenant_id = $2",
        token, tenant_id,
    )

# Revoke — chỉ revoke token thuộc tenant đó
async def revoke_token(self, token: str, tenant_id: str) -> bool:
    result = await self._db.pool.execute(
        "UPDATE token_store SET status = 'REVOKED'
         WHERE token = $1 AND tenant_id = $2 AND status = 'ACTIVE'",
        token, tenant_id,
    )
```

**Database constraint:** `UNIQUE(hash, tenant_id)` — đảm bảo cùng plaintext + cùng tenant luôn cho cùng 1 token, nhưng khác tenant thì khác token.

#### Tầng Cache

Cache key được xây dựng có chứa `tenant_id`, tránh cache poisoning giữa các tenant:

```
L1 (in-memory) + L2 (Redis): key = f"{tenant_id}:{hmac_hash}"
```

#### Tầng HMAC/Mã Hóa — `terraform/openbao/modules/transit/main.tf`

```hcl
# Tất cả tenant dùng chung 1 encryption key
resource "vault_transit_secret_backend_key" "encryption" {
  name = var.transit_key_name   # "tnt-key" — shared across ALL tenants
  convergent_encryption = false # HMAC riêng biệt, không dùng convergent của Vault
}

resource "vault_transit_secret_backend_key" "hmac" {
  name = var.transit_hmac_key_name  # "tnt-hmac" — shared across ALL tenants
}
```

> **Lưu ý quan trọng:** HMAC được tính có bao gồm `tenant_id` như một phần của input, tạo ra hash duy nhất theo từng tenant, dù dùng cùng một key.

#### Tầng API Request Model — `src/tnt_engine/models/domain.py`

```python
class TokenizeRequest(BaseModel):
    tenant_id: str  # BẮT BUỘC — không có default
    fields: list[FieldValue]

class DetokenizeRequest(BaseModel):
    tenant_id: str  # BẮT BUỘC
    tokens: list[str]
```

---

### 2.2 Vault Namespace Support (Tùy chọn — Enterprise Feature)

#### Control Plane — `control-plane/src/lib/namespace-context.tsx`

```tsx
// Namespace được lưu trong localStorage, gửi qua query param đến BFF
// BFF thêm header X-Vault-Namespace vào mọi request tới OpenBao
```

#### BFF API Routes — `control-plane/src/lib/vault-client.ts`

```typescript
interface VaultRequestOptions {
  namespace?: string;  // OpenBao namespace (X-Vault-Namespace header)
}

export async function vaultRequest<T>(path: string, options: VaultRequestOptions = {}): Promise<T> {
  if (namespace) {
    headers["X-Vault-Namespace"] = namespace;  // gửi namespace header
  }
}
```

#### Namespace Listing — `control-plane/src/app/api/namespaces/route.ts`

```typescript
// List tất cả namespaces có sẵn (Enterprise/OpenBao feature)
const res = await fetch(`${VAULT_ADDR}/v1/sys/namespaces?list=true`, {
  headers: { "X-Vault-Token": VAULT_TOKEN },
});
// Returns: ["root", "tenant-a", "tenant-b", ...]
```

---

### 2.3 Kubernetes Auth Binding — `terraform/openbao/modules/auth/main.tf`

```hcl
resource "vault_kubernetes_auth_backend_role" "tnt_engine" {
  role_name                        = "tnt-engine"
  bound_service_account_names      = [var.k8s_service_account]      # "tnt-engine"
  bound_service_account_namespaces = [var.k8s_namespace]            # "tnt-engine"
  token_policies                   = [var.transit_policy_name]      # "tnt-transit"
  token_ttl                        = 3600  # 1 giờ
  token_max_ttl                    = 14400 # 4 giờ
}
```

Pod chỉ được authenticate nếu:
- Chạy trong đúng namespace Kubernetes: `tnt-engine`
- Dùng đúng ServiceAccount: `tnt-engine`

---

## 3. Đánh Giá Isolation

### 3.1 Bảng Tổng Hợp Isolation Theo Layer

| Layer | Cơ Chế Isolation | Isolated? | Ghi Chú |
|-------|-----------------|-----------|---------|
| **Database (token_store)** | `WHERE tenant_id = $N` ở mọi query | ✅ Yes | DB unique constraint `(hash, tenant_id)` |
| **Database (token_lookup)** | `WHERE tenant_id = $N` ở mọi query | ✅ Yes | Hash khác nhau giữa các tenant |
| **Database (audit_log)** | `WHERE tenant_id = $1` ở query audit | ✅ Yes | Tenant chỉ xem audit của mình |
| **Cache L1 (memory)** | Key chứa `tenant_id` | ✅ Yes | Không thể cross-tenant cache hit |
| **Cache L2 (Redis)** | Key chứa `tenant_id` | ✅ Yes | Namespace key riêng theo tenant |
| **HMAC computation** | Input bao gồm `tenant_id` | ✅ Yes | Hash khác nhau cho cùng plaintext |
| **Vault Transit (encrypt)** | Dùng chung key `tnt-key` | ⚠️ Partial | Ciphertext khác nhau nhờ nonce ngẫu nhiên, nhưng key là shared |
| **Vault Transit (HMAC)** | Dùng chung key `tnt-hmac` | ⚠️ Partial | Key shared, nhưng input có tenant_id |
| **Vault Namespace** | Enterprise feature, optional | ⚠️ Optional | Chỉ dùng ở control plane UI, không ở data path |
| **Vault Policies** | 1 policy cho tất cả tenant | ⚠️ Shared | `tnt-transit.hcl` áp dụng cho toàn bộ service |
| **Kubernetes Namespace** | 1 namespace `tnt-engine` | ⚠️ Shared | Tất cả tenant chạy cùng pod |
| **Network Policy** | Restrict ingress/egress | ✅ Yes | Pod không nói chuyện ra ngoài trừ postgres/redis/openbao |
| **API Request** | `tenant_id` bắt buộc | ✅ Yes | Validated ở model layer |

---

### 3.2 Điểm Mạnh — Isolation Tốt

**1. Database-level isolation hoàn chỉnh**

Không có trường hợp nào mà query không có `tenant_id`. Ngay cả `list_tokens` (admin view) cũng hỗ trợ filter theo `tenant_id`. `revoke_token` và `delete_token` đều có `tenant_id` như điều kiện bắt buộc — một tenant không thể revoke token của tenant khác dù biết token value.

**2. Convergent tokenization đúng cách**

```
token = f(encrypt(plaintext), tenant_id)
lookup_hash = HMAC(plaintext + tenant_id)
```

Cùng số điện thoại `0912345678`:
- Tenant A → HMAC key `tnt-hmac` với input `"A:0912345678"` → hash_A
- Tenant B → HMAC key `tnt-hmac` với input `"B:0912345678"` → hash_B
- hash_A ≠ hash_B → không thể cross-tenant lookup

**3. Idempotency dedup có tenant scope**

```python
# request_dedup table: UNIQUE(request_hash, tenant_id)
# Tenant A không thể replay response của Tenant B
```

**4. Token lifecycle scope**

Revoke/expire/delete hoạt động chính xác theo tenant. Không có bulk operation nào bỏ sót `tenant_id`.

---

### 3.3 Điểm Yếu — Isolation Chưa Hoàn Toàn

**1. Vault Keys Được Chia Sẻ Giữa Tất Cả Tenant**

```hcl
# Tất cả tenant encrypt/decrypt với cùng key
vault_transit_secret_backend_key "encryption" { name = "tnt-key" }
vault_transit_secret_backend_key "hmac"       { name = "tnt-hmac" }
```

**Rủi ro:** Nếu key bị leak hoặc compromised, **tất cả** tenant bị ảnh hưởng. Nếu một tenant yêu cầu key rotation theo compliance riêng (ví dụ PCI-DSS), không thể rotate cho tenant đó mà không ảnh hưởng các tenant khác.

**2. Vault Policy Shared**

```hcl
# tnt-transit.hcl — áp dụng cho tất cả tenant qua 1 AppRole/K8s role
path "transit/encrypt/tnt-key" { capabilities = ["update"] }
path "transit/decrypt/tnt-key" { capabilities = ["update"] }
```

Không có policy riêng theo tenant. Nếu service bị compromise, attacker có thể encrypt/decrypt dữ liệu của **mọi** tenant.

**3. Vault Namespace Chỉ Dùng Ở Control Plane UI**

```typescript
// vault-client.ts — chỉ gửi X-Vault-Namespace từ UI operator
if (namespace) {
  headers["X-Vault-Namespace"] = namespace;
}
```

Data path (Python service) hoàn toàn không dùng Vault namespace. Transit engine hoạt động ở `root` namespace cho tất cả tenant. Vault namespace hiện tại chỉ là tính năng UI để operator quan sát, không có ý nghĩa isolation thực sự.

**4. `get_tokens_for_reencrypt` Không Có Tenant Scope**

```python
# repository.py:183 — đây là vấn đề tiềm ẩn
async def get_tokens_for_reencrypt(self, max_key_version: int, batch_size: int = 500):
    rows = await self._db.pool.fetch(
        """
        SELECT ... FROM token_store
        WHERE key_version < $1 AND status = 'ACTIVE'
        ORDER BY created_at LIMIT $2
        FOR UPDATE SKIP LOCKED
        """,
        max_key_version, batch_size,  # KHÔNG CÓ tenant_id filter!
    )
```

Và `update_encrypted_value` (repository.py:196) cũng không có `tenant_id`:

```python
async def update_encrypted_value(self, token: str, value_encrypted: str, key_version: int):
    await self._db.pool.execute(
        "UPDATE token_store SET value_encrypted = $2, key_version = $3 WHERE token = $1",
        token, value_encrypted, key_version,  # KHÔNG CÓ tenant_id!
    )
```

Đây không phải security bug ngay lập tức (vì reencrypt worker dùng shared key), nhưng khi chuyển sang per-tenant key thì sẽ thành lỗ hổng.

**5. Không Có Rate Limiting Theo Tenant**

Không thấy cơ chế giới hạn request rate per-tenant. Một tenant có thể "bóp" resource của các tenant khác (noisy neighbor problem).

---

## 4. Kiến Trúc Đề Xuất: True Vault Namespace Isolation

Nếu yêu cầu **hard isolation** (mỗi tenant hoàn toàn độc lập về key material và policy):

### 4.1 Mô Hình Vault Namespace Per Tenant

```
OpenBao (root)
├── namespace: tenant-a/
│   ├── transit/
│   │   ├── tnt-key      ← key riêng của tenant A
│   │   └── tnt-hmac     ← hmac key riêng của tenant A
│   ├── auth/kubernetes/ ← role riêng cho tenant A
│   └── sys/policies/    ← policy riêng cho tenant A
│
├── namespace: tenant-b/
│   ├── transit/
│   │   ├── tnt-key      ← key riêng của tenant B
│   │   └── tnt-hmac
│   └── ...
│
└── namespace: tenant-c/
    └── ...
```

**Lợi ích:**
- Key material hoàn toàn isolated (compromise 1 tenant không ảnh hưởng tenant khác)
- Key rotation độc lập cho từng tenant
- Audit log tách biệt theo namespace
- Comply với PCI-DSS / SOC2 yêu cầu key isolation

**Chi phí:**
- Yêu cầu OpenBao Enterprise hoặc OpenBao với namespace feature enabled
- Terraform phức tạp hơn (loop qua danh sách tenant)
- Python client cần biết `vault_namespace` của từng tenant

### 4.2 Thay Đổi Cần Thiết Nếu Triển Khai

#### Terraform — Tạo Namespace Per Tenant

```hcl
variable "tenants" {
  type    = list(string)
  default = ["tenant-a", "tenant-b", "tenant-c"]
}

resource "vault_namespace" "tenants" {
  for_each = toset(var.tenants)
  path     = each.key
}

# Transit engine per namespace
resource "vault_mount" "transit" {
  for_each  = toset(var.tenants)
  namespace = vault_namespace.tenants[each.key].path
  path      = "transit"
  type      = "transit"
}

# Key per namespace
resource "vault_transit_secret_backend_key" "encryption" {
  for_each  = toset(var.tenants)
  namespace = vault_namespace.tenants[each.key].path
  backend   = vault_mount.transit[each.key].path
  name      = "tnt-key"
}
```

#### Python — Namespace-Aware Client

```python
# config.py — thêm mapping tenant → vault namespace
class Settings(BaseSettings):
    vault_namespace_map: dict[str, str] = {}
    # {"tenant-a": "tenant-a", "tenant-b": "tenant-b"}

# openbao.py — gửi X-Vault-Namespace header
async def encrypt(self, plaintext: str, tenant_id: str) -> str:
    namespace = settings.vault_namespace_map.get(tenant_id, "root")
    headers = {"X-Vault-Namespace": namespace, ...}
```

#### Repository — Fix `get_tokens_for_reencrypt`

```python
async def get_tokens_for_reencrypt(
    self, tenant_id: str, max_key_version: int, batch_size: int = 500
) -> list[TokenRecord]:
    rows = await self._db.pool.fetch(
        """
        SELECT ... FROM token_store
        WHERE tenant_id = $1 AND key_version < $2 AND status = 'ACTIVE'
        ORDER BY created_at LIMIT $3
        FOR UPDATE SKIP LOCKED
        """,
        tenant_id, max_key_version, batch_size,
    )
```

---

## 5. So Sánh Hai Mô Hình

| Tiêu Chí | Model Hiện Tại (Shared Key) | Model Đề Xuất (Namespace Per Tenant) |
|---------|-----------------------------|--------------------------------------|
| **Key isolation** | ❌ Shared key | ✅ Key riêng mỗi tenant |
| **Blast radius nếu key bị leak** | Tất cả tenant | Chỉ 1 tenant |
| **Key rotation độc lập** | ❌ Không | ✅ Có |
| **Vault policy per tenant** | ❌ Shared policy | ✅ Policy riêng |
| **Operational complexity** | Thấp | Cao |
| **Vault licensing** | OSS/Community | Enterprise / OpenBao |
| **DB isolation** | ✅ tenant_id scope | ✅ tenant_id scope |
| **Application isolation** | ✅ Đầy đủ | ✅ Đầy đủ |
| **PCI-DSS / SOC2 compliance** | ⚠️ Cần đánh giá | ✅ Đáp ứng tốt hơn |
| **Noisy neighbor (rate limit)** | ❌ Chưa có | ❌ Cần thêm riêng |

---

## 6. Kết Luận

### Hiện Tại: Isolated ở Application Layer, Shared ở Vault Layer

Hệ thống TnT-Engine **có isolation thực sự** ở các tầng quan trọng nhất với người dùng cuối:

- ✅ Dữ liệu database hoàn toàn cách biệt theo tenant
- ✅ Cache không bị cross-tenant leak
- ✅ Token lifecycle (revoke/delete/expire) chỉ ảnh hưởng đúng tenant
- ✅ HMAC lookup không thể cross-tenant
- ✅ Audit log phân tách theo tenant

Tuy nhiên, ở **tầng cryptographic material** (Vault keys và policies), tất cả tenant dùng chung. Đây là **soft isolation**, không phải **hard isolation**.

### Khi Nào Cần Nâng Lên Vault Namespace Per Tenant?

| Trường hợp | Khuyến nghị |
|-----------|-------------|
| Internal SaaS, trust giữa các tenant | ✅ Model hiện tại đủ |
| Yêu cầu PCI-DSS Level 1 / SOC2 Type II với key isolation | Nâng lên per-tenant namespace |
| Tenant là các tổ chức độc lập, contract riêng | Nâng lên per-tenant namespace |
| Cần key rotation độc lập cho từng tenant | Nâng lên per-tenant namespace |
| Quy mô < 100 tenant | ✅ Model hiện tại ổn |
| Quy mô > 1000 tenant | Cần đánh giá lại về operational overhead |

### Action Items Ngắn Hạn (Không Cần Thay Đổi Kiến Trúc)

1. **Fix `get_tokens_for_reencrypt`** — thêm `tenant_id` filter (`repository.py:183`)
2. **Fix `update_encrypted_value`** — thêm `tenant_id` vào WHERE clause (`repository.py:196`)
3. **Thêm rate limiting per-tenant** ở API layer để tránh noisy neighbor
4. **Document rõ ràng** rằng Vault namespace hiện tại chỉ là UI feature, không phải data-path isolation

---

*File này được tạo tự động dựa trên phân tích source code tại commit hiện tại của branch `claude/multi-tenant-vault-analysis-pKp6W`.*
