# T&T Engine — Danh sách bổ sung & Gap cần xử lý

**Cập nhật**: 2026-04-07 (1.1 ✅, 2.1 ✅, 2.2 ✅)  
**Nguồn**: Audit & Gap Report v2.0 + Enterprise Gap Report v1.0 + phân tích code trực tiếp  
**Phạm vi**: Backend (T&T Engine) + Control Plane (Next.js dashboard)

> **Lưu ý tài liệu**: `ENTERPRISE_GAP_REPORT.md` v1.0 mô tả trạng thái **trước** khi implement Auth/RBAC/Maker-Checker/SIEM — đã lỗi thời. `AUDIT_AND_GAP_REPORT.md` v2.0 là bản chuẩn hiện tại.

---

## Mục lục

1. [Vấn đề kỹ thuật cần xử lý trước](#1-vấn-đề-kỹ-thuật-cần-xử-lý-trước)
2. [Control Plane — Thiếu hoàn toàn (Critical)](#2-control-plane--thiếu-hoàn-toàn-critical)
3. [Control Plane — Tồn tại nhưng chưa hoạt động đúng (Partial)](#3-control-plane--tồn-tại-nhưng-chưa-hoạt-động-đúng-partial)
4. [Control Plane — Cần cho Production (Security)](#4-control-plane--cần-cho-production-security)
5. [Backend T&T Engine — Gaps còn lại](#5-backend-tt-engine--gaps-còn-lại)
6. [Thứ tự ưu tiên](#6-thứ-tự-ưu-tiên)

---

## 1. Vấn đề kỹ thuật cần xử lý trước

Những vấn đề này cần giải quyết trước khi làm bất kỳ feature nào.

### ✅ 1.1 Bug trong `audit/export/route.ts` — ĐÃ SỬA (2026-04-07)

**Vấn đề**: Route gọi `GET /admin/audit/status` (chỉ trả `buffer_size`, không có entries) thay vì `POST /admin/audit/query`. Kết quả: export CEF/JSON/NDJSON luôn rỗng hoặc chỉ có 1 system event giả.

**File**: `control-plane/src/app/api/audit/export/route.ts` dòng ~43  
**Fix**: Đổi fetch sang `POST /admin/audit/query` với body `{ limit, tenant_id, since }`, giống như `audit/route.ts` đã làm đúng.

**Đã sửa**:
- Thay `GET /admin/audit/status` → `POST /admin/audit/query` với JSON body
- Thêm `Content-Type: application/json` header
- Xóa dead variable `VAULT_TOKEN_HEADER` (khai báo nhưng không dùng)

---

## 2. Control Plane — Thiếu hoàn toàn (Critical)

### ✅ 2.1 [M2] Control Plane Action Audit Trail — ĐÃ LÀM (2026-04-07)

**Mức độ**: HIGH — bắt buộc cho SOC2/PCI  
**Vấn đề**: Mọi hành động trên Control Plane (rotate key, seal, tạo policy, approve, backup) không được ghi lại — không có `lib/cp-audit.ts`, các POST routes không log sau khi thực thi.

**Đã làm**:
- Tạo `lib/cp-audit.ts` — file-based store tại `/tmp/tnt-cp-audit.json` với `logCpAction()` / `listCpAudit()`
- Instrument đủ 8 POST routes (success + failure paths):

| Route | Action |
|---|---|
| `POST /api/keys/rotate` | `KEY_ROTATE` |
| `POST /api/emergency/seal` | `SEAL` |
| `POST /api/policies` | `POLICY_CREATE` |
| `POST /api/approvals` | `APPROVAL_CREATE / APPROVAL_REVIEW` |
| `POST /api/backups` | `BACKUP_TRIGGER` |
| `POST /api/approles` | `APPROLE_SECRET_GEN` |
| `POST /api/init` | `VAULT_INIT` |
| `POST /api/unseal` | `VAULT_UNSEAL` |

- `api/audit/route.ts` trả thêm `cp_entries` + `cp_count`
- `/audit` page có tab riêng "Control Plane" hiển thị bảng CP entries

---

### 2.3 K8s Benchmark Environment chưa hoàn chỉnh

**Mức độ**: HIGH  
**Vấn đề**: Đã benchmark được bằng Docker trên VM GEIC, nhưng luồng benchmark qua K8s + Ingress vẫn chưa hoàn tất. Helm chart hiện mới đưa `tnt-engine` app lên cluster; các dependency cần thiết để app startup và benchmark đúng reviewer path vẫn chưa đầy đủ trong K8s:

- PostgreSQL
- Redis
- OpenBao

**Hệ quả**:
- Pod app có thể fail startup nếu `values-dev.yaml` trỏ tới hostname nội bộ cluster chưa tồn tại
- Chưa benchmark được đúng đường `client -> ingress -> service -> pod -> dependency`
- Chưa đủ cơ sở kết luận latency/overhead K8s theo yêu cầu reviewer

**Cần làm**:
- Hoàn tất tài liệu triển khai K8s: `docs/k8s-deployment-guide.md`
- Chọn 1 trong 2 hướng:
  - benchmark nhanh: app trong K8s, dependency ngoài K8s
  - benchmark đầy đủ: app + dependency đều trong K8s
- Chỉ update kết luận benchmark K8s sau khi pass toàn bộ flow health/ready/tokenize qua ingress

---

### ✅ 2.2 [M3] Real-time Event Stream — ĐÃ LÀM (2026-04-07)

**Mức độ**: MEDIUM  
**Vấn đề**: Hiện dùng SWR polling (health 5s, metrics 15s, audit 10s). Không có WebSocket/SSE — operator có thể miss critical event (seal, key rotation, approval) trong khoảng polling gap.

**Đã làm**:
- Tạo `lib/event-bus.ts` — global singleton `EventEmitter` (pattern `globalThis.__tnt_cp_event_bus` để survive HMR)
- Tạo `api/events/route.ts` — SSE endpoint `GET /api/events`, heartbeat 20s, RBAC-protected
- Mỗi route `logCpAction` xong thì `emitCpEvent` ngay → client nhận trong <1ms
- `/audit` page subscribe `EventSource("/api/events")`, hiện badge Live/Offline, cập nhật CP tab real-time

---

## 3. Control Plane — Tồn tại nhưng chưa hoạt động đúng (Partial)

### 3.1 [P3] Transform Rules Management

**Vấn đề**: Trang `/transforms` hiển thị **16 rules** (HIGH/MEDIUM/LOW) hardcoded trong `CANONICAL_RULES` tại API route — không query từ OpenBao hay T&T Engine. Có badge "Live/Fallback" nhưng chỉ để probe health, data vẫn là static. Không có CRUD.

**Cần làm**:
- Kết nối `GET /api/transforms` với nguồn dữ liệu thực (T&T Engine `governance/classification.py` qua API hoặc config endpoint)
- Implement Create / Edit / Delete transform rules

---

### 3.2 [P5] Namespace Propagation từ UI sang API

**Vấn đề**: `NamespaceSwitcher` trên sidebar cho phép chọn namespace và `namespaceParam()` helper đã tồn tại trong `namespace-context.tsx`, nhưng **không filter gì cả**. `api.ts` không dùng namespace, `keys/route.ts` không extract `?namespace=` param và không truyền `X-Vault-Namespace` header vào `vault-client`.

**Cần làm**:
- SWR hooks truyền `?namespace=...` vào API routes
- API routes extract namespace và pass vào `vault-client` dưới dạng `X-Vault-Namespace` header
- Keys, Policies, AppRoles được filter theo namespace đang chọn

---

### 3.3 [P2] Backup Error Handling UI

**Vấn đề**: Hàm `triggerBackup()` trong `backups/page.tsx` gọi `fetch("/api/backups", ...)` nhưng bỏ qua hoàn toàn response — không `await res.json()`, không set error state. Khi backup thất bại (502 từ OpenBao dev-mode), UI không hiển thị lỗi gì.

**Cần làm**:
- Đọc response của `triggerBackup()` và xử lý error state
- Hiển thị thông báo lỗi rõ ràng khi nhận response không phải 2xx
- Phân biệt rõ: lỗi infra (OpenBao không có Raft) vs lỗi network

---

## 4. Control Plane — Cần cho Production (Security)

Những mục này không blocking cho dev/staging nhưng **bắt buộc trước khi lên production**.

### 4.1 Bật MFA và migrate User Store

| Hiện tại | Cần cho Production |
|---|---|
| `AUTH_PROVIDER=credentials` với JSON file users | Chuyển sang `AUTH_PROVIDER=ldap` hoặc `AUTH_PROVIDER=oidc` — code đã sẵn sàng trong `auth-options.ts` |
| Không có MFA/2FA | Bắt buộc MFA cho admin (LDAP/OIDC provider hỗ trợ qua IdP) |
| Session JWT, `NEXTAUTH_SECRET` hardcode | Rotate `NEXTAUTH_SECRET` định kỳ |

> LDAP (`ldap-auth.ts`) và OIDC provider đã được implement đầy đủ. Chỉ cần set env vars: `AUTH_PROVIDER`, `LDAP_URL/LDAP_BIND_DN/...` hoặc `OIDC_ISSUER/OIDC_CLIENT_ID/...`.

### 4.2 Migrate Approval Queue Storage

| Hiện tại | Cần cho Production |
|---|---|
| File `/tmp/tnt-approvals.json` (`approval-store.ts`) | PostgreSQL table |
| Mất dữ liệu khi restart pod | Persistent, queryable, auditable |

### 4.3 Migrate Backup Store

| Hiện tại | Cần cho Production |
|---|---|
| File `/tmp/tnt-backup-metadata.json` (`backup-store.ts`) | PostgreSQL table |
| Backup lưu tại `/tmp/` (mất khi restart) | S3/GCS/Azure Blob với encryption |

### 4.4 Backup Encryption & Verification

- Raft snapshots hiện lưu unencrypted
- Cần: encrypt snapshot trước khi lưu, validate checksum khi restore
- Cần: scheduled backup worker (cron-based, configurable interval)
- Cần: test-restore định kỳ để xác nhận backup còn dùng được

---

## 5. Backend T&T Engine — Gaps còn lại

Backend được đánh giá là **production-ready** cho core functionality. Các gap còn lại là enterprise features.

### 5.1 SIEM Integration

**Vấn đề**: `siem-formatter.ts` đã có CEF/ECS formatter nhưng chỉ dùng cho export on-demand. Không có cơ chế push real-time ra SIEM.

**Cần làm**:
- Webhook configurable: Splunk HEC, Elasticsearch, custom endpoint
- Retain policy: tự động archive/delete entries sau N ngày (hiện chưa có)
- Signed audit logs: HMAC chain để chứng minh tamper-evidence (cần cho HIPAA)

### 5.2 OpenBao Namespace Headers

**Vấn đề**: `vault-client.ts` hỗ trợ `X-Vault-Namespace` header nhưng các API routes của Control Plane không extract namespace từ request và không truyền vào. Tất cả keys/policies nằm trong default namespace — không có isolation giữa các team/tenant.

**Cần làm**:
- Thêm `namespace` param vào tất cả OpenBao API calls từ BFF
- Map `tenant_id` → OpenBao namespace (hoặc config riêng)

### 5.3 Real-time Event Streaming

**Vấn đề**: `EventBus` hiện là in-process only. Không có publish ra ngoài cho downstream consumers.

**Cần làm** (khi scale):
- Swap transport của `EventBus` sang Kafka/NATS/SQS
- Interface `EventHandler` đã sẵn sàng — chỉ cần thay implementation

---

## 6. Thứ tự ưu tiên

```
┌─────────────────────────────────────────────────────────┐
│  ✅ DONE                                                │
│                                                         │
│  1.1  Fix bug audit/export/route.ts (sai endpoint)     │
└─────────────────────────────────────────────────────────┘
          ↓
┌─────────────────────────────────────────────────────────┐
│  SPRINT 1 — Audit Visibility (Critical)                 │
│                                                         │
│  2.1  CP action audit trail (cp-audit.ts)              │
└─────────────────────────────────────────────────────────┘
          ↓
┌─────────────────────────────────────────────────────────┐
│  SPRINT 2 — Completeness (Medium)                       │
│                                                         │
│  2.3  Hoàn tất môi trường benchmark K8s + Ingress      │
│  3.2  Namespace propagation (NamespaceSwitcher works)  │
│  3.1  Transform rules CRUD (không hardcode)            │
│  3.3  Backup error handling UI                         │
│  2.2  Real-time SSE (thay SWR polling)                 │
└─────────────────────────────────────────────────────────┘
          ↓
┌─────────────────────────────────────────────────────────┐
│  TRƯỚC KHI LÊN PRODUCTION                              │
│                                                         │
│  4.1  Bật AUTH_PROVIDER=ldap/oidc + MFA               │
│  4.2  Migrate approval queue → PostgreSQL              │
│  4.3  Migrate backup store → PostgreSQL + S3           │
│  4.4  Backup encryption + scheduled worker             │
│  5.1  SIEM webhook + audit retention policy            │
│  5.2  OpenBao namespace isolation                      │
└─────────────────────────────────────────────────────────┘
```

---

## Bảng tổng hợp nhanh

| # | Hạng mục | Mức độ | Sprint | Ước lượng |
|---|---|---|---|---|
| ✅ 1.1 | Fix bug `audit/export/route.ts` | HIGH | ~~Ngay~~ | ✅ Done |
| ✅ 2.1 | CP action audit trail | HIGH | ~~Sprint 1~~ | ✅ Done |
| 2.3 | Hoàn tất môi trường benchmark K8s + Ingress | HIGH | Sprint 2 | 1-2 ngày |
| 3.2 | Namespace propagation | MEDIUM | Sprint 2 | 0.5 ngày |
| 3.1 | Transform rules CRUD | MEDIUM | Sprint 2 | 1 ngày |
| 3.3 | Backup error handling UI | LOW | Sprint 2 | 2 giờ |
| ✅ 2.2 | Real-time SSE | MEDIUM | ~~Sprint 2~~ | ✅ Done |
| 4.1 | Bật LDAP/OIDC + MFA (code sẵn) | CRITICAL (prod) | Pre-prod | 0.5 ngày |
| 4.2 | Approval queue → PostgreSQL | HIGH (prod) | Pre-prod | 1 ngày |
| 4.3 | Backup store → PostgreSQL + S3 | HIGH (prod) | Pre-prod | 2 ngày |
| 4.4 | Backup encryption + scheduler | HIGH (prod) | Pre-prod | 2 ngày |
| 5.1 | SIEM webhook + retention | MEDIUM | Pre-prod | 2-3 ngày |
| 5.2 | OpenBao namespace isolation | MEDIUM | Pre-prod | 1-2 ngày |
