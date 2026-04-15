# Báo cáo phân tích: `ndip25.api.platform.auth`

> **Ngày:** 2026-04-15
> **Module:** `ndip25.api.platform.auth` — Authentication & User Management Service

---

## 1. Tổng quan

`ndip25.api.platform.auth` là **service xác thực và quản lý tài khoản** của hệ thống NDIP25. Đây là service duy nhất trong toàn hệ thống có `endpoint.login.enabled=true` — tức là điểm login thực sự. Ngoài ra còn cung cấp API quản lý tài khoản (CRUD), đổi role, và tra cứu master data hệ thống.

| Thông tin | Chi tiết |
|---|---|
| **Vai trò** | Authentication service — login, JWT, quản lý tài khoản người dùng |
| **Input** | HTTP từ frontend / admin portal |
| **Output** | JWT access token + refresh token, CRUD AccountRegister |
| **Port** | 4001 |
| **Auth** | `endpoint.login.enabled=true` — BẬT login (các service khác đều tắt) |

**Build:** Gradle | **Java:** 11 | **Spring Boot:** 2.7.18

Để build và chạy:
```bash
./gradlew clean build -x test
java -jar build/libs/*.jar
```

---

## 2. Phân lớp kiến trúc

```
ndip25.api.platform.auth/
│
└── src/main/java/ndip/api/
    ├── Application.java
    │
    ├── auth/
    │   ├── controller/
    │   │   └── AuthUserController.java         ← 11 endpoint quản lý tài khoản
    │   ├── business/
    │   │   ├── AuthUserBusiness.java           ← Logic chính: JWT, CRUD account, RSA key
    │   │   └── AuthUserWriteService.java       ← Tách @Transactional write riêng
    │   └── dto/
    │       ├── AccountCreateRq.java            ← Tạo tài khoản (username, password, roleId)
    │       ├── AccountUpdateRq.java            ← Cập nhật thông tin
    │       ├── AccountUpdateRoleRq.java        ← Đổi role (kèm reason)
    │       ├── AccountInitRq.java              ← Khởi tạo admin ban đầu (bị comment)
    │       ├── DeactivateRq.java               ← Vô hiệu hóa (kèm reason)
    │       ├── LogoutRq.java                   ← Logout (sessionId)
    │       └── RefreshTokenRequest.java        ← Làm mới token (refreshToken)
    │
    └── systemdata/
        ├── controller/
        │   └── SystemDataController.java       ← 2 endpoint tra cứu master data
        ├── business/
        │   └── SystemDataBusiness.java         ← Lấy master data, cache Redis
        └── dto/
            └── SystemDataRes.java              ← { id, itemName }
```

Toàn bộ entity, repository, JWT, security filter đến từ **`ndip25.api.common`** (dependency dùng chung).

---

## 3. Cấu hình (`application-local.properties`)

```properties
server.port=4001
endpoint.login.enabled=true    ← BẬT — service này xử lý login

# PostgreSQL — Business DB (SimulationRun, MasterSystemData, ...)
spring.datasource.business.url=jdbc:postgresql://10.6.8.37:5432/postgres

# PostgreSQL — Auth DB (AccountRegister, RoleAssignmentHistory)
spring.datasource.auth.enabled=true
spring.datasource.auth.url=jdbc:postgresql://10.6.8.37:5432/auth

# Redis (session, JWT refresh token, master data cache)
spring.redis.host=10.6.8.37
spring.redis.port=6379

# JWT & Password secret keys
ndip.security.jwt.secret-key=PiXGE/AdFKL...
ndip.security.password.secret-key=EHfqVGr4...
```

Service này dùng **2 PostgreSQL database riêng biệt**:
- `postgres` — business data (MasterSystemData, SimulationRun)
- `auth` — authentication data (AccountRegister, RoleAssignmentHistory)

---

## 4. Các endpoint

```
# Không cần auth:
POST /api/v1/user/refresh-token       ← Làm mới access token
POST /api/v1/user/logout              ← Xóa session

# Chỉ admin:
POST   /api/v1/user                   ← Tạo tài khoản
PUT    /api/v1/user/{id}              ← Cập nhật thông tin
PUT    /api/v1/user/{id}/role         ← Đổi role
GET    /api/v1/user/{id}              ← Lấy chi tiết
GET    /api/v1/user/{id}/role-history ← Lịch sử đổi role
POST   /api/v1/user/{id}/activate     ← Kích hoạt
POST   /api/v1/user/{id}/deactivate   ← Vô hiệu hóa
GET    /api/v1/user                   ← Tìm kiếm danh sách
DELETE /api/v1/user/{id}              ← Xóa tài khoản
POST   /api/v1/user/{id}/regenerate-keys ← Tạo lại RSA key (data_owner)

# Master data (không rõ cần auth không — không có @PreAuthorize):
GET /api/v1/system-data/group/{groupCode}  ← Danh sách items theo group
GET /api/v1/system-data/groups             ← Tất cả group codes
```

---

## 5. Các thành phần chính

### 5.1 `AuthUserBusiness.refreshToken()` — Làm mới JWT

```
Input: RefreshTokenRequest { refreshToken: "eyJ..." }

Bước 1: Parse refresh token → lấy session_id, username
Bước 2: Kiểm tra Redis key "{session_id}-jwt-re-token"
        → Không tồn tại → trả lỗi CM_AUTH_EXPIRED (đã logout hoặc hết TTL)
Bước 3: Tìm AccountRegister theo username → lấy roleCode
Bước 4: Sinh access token mới (giữ nguyên session_id cũ)
Bước 5: Cập nhật lastLoginAt

Output: DataLoginRp {
    token:         "eyJ..." (access token mới)
    refresh_token: "eyJ..." (refresh token giữ nguyên)
    duration:      3600     (giây)
}
```

---

### 5.2 `AuthUserBusiness.logout()` — Xóa session

```
Input: LogoutRq { sessionId: "abc-123" }

Xóa Redis key: "{sessionId}-jwt-re-token"
Xóa Redis key: "user:session:{sessionId}"

Lưu ý: Access token hiện tại vẫn còn hiệu lực đến hết TTL.
        JWT không có blacklist — logout chỉ ngăn refresh.
```

---

### 5.3 `AuthUserBusiness.createAccount()` — Tạo tài khoản

```
Input: AccountCreateRq {
    username, password, confirmPassword,
    fullName, email, organizationUnit,
    roleId
}

Bước 1: Validate username/email không trùng
Bước 2: Lấy roleCode từ Redis (cache master data)
        → Không cho phép assign role "admin"
Bước 3: Hash password (Common.SecurityUtils.hashPassword)
Bước 4: Nếu role = "data_owner":
            HSMLocalService.initProvider()
            KeyPair = HSMLocalService.generateKey(RSA, 2048)
            entity.privateKey = Base64(privateKey)
            entity.publicKey  = Base64(publicKey)
Bước 5: Lưu AccountRegister vào DB (auth database)
Bước 6: Nếu role = "data_owner":
            Push vào Redis:
            "acc:provider:{username}:private_key" → base64PrivateKey
            "acc:provider:{username}:public_key"  → base64PublicKey
```

**Tại sao `data_owner` cần RSA key?**
`data_owner` là role của đơn vị cung cấp dữ liệu — họ cần ký/xác thực dữ liệu trước khi đẩy vào pipeline. HSM sinh key để đảm bảo private key được quản lý an toàn qua phần cứng.

---

### 5.4 `AuthUserBusiness.updateUserRole()` — Đổi role có audit trail

```
Input: AccountUpdateRoleRq { roleId, reason }

Bước 1: Validate không đổi role của tài khoản admin
Bước 2: Validate role mới không phải "admin"
Bước 3: Tạo RoleAssignmentHistory {
            userId, roleId (mới), roleCode (mới),
            preRoleId (cũ), preRoleCode (cũ),
            changedBy, reason
        }
Bước 4: authUserWriteService.saveAccountUpdate(entity, history)
        → Lưu history + entity trong 1 @Transactional
```

Đây là thao tác duy nhất tạo audit trail — `GET /{id}/role-history` trả lại danh sách theo `changedAt` giảm dần.

---

### 5.5 `AuthUserBusiness.deactivateUser()` — Bảo vệ tự vô hiệu hóa

```java
// Không cho user tự vô hiệu hóa tài khoản của chính mình
if (currentUserId.equals(id)) {
    return error(PS_USER_DEACTIVATE_SELF_NOT_ALLOWED);
}
```

---

### 5.6 `AuthUserBusiness.regenerateDataOwnerKeys()` — Rotate RSA key

Tạo lại cặp RSA key mới cho `data_owner` và cập nhật cả DB lẫn Redis. Dùng khi key bị lộ hoặc cần rotate định kỳ.

---

### 5.7 `AuthUserWriteService` — Tại sao tách class riêng?

```java
@Transactional(rollbackFor = Exception.class)
public void saveAccountUpdate(AccountRegister entity, RoleAssignmentHistory history) {
    if (history != null) roleAssignmentHistoryRepo.save(history);
    accountRegisterRepo.save(entity);
}
```

Spring `@Transactional` chỉ hoạt động khi gọi qua Spring proxy. Nếu `AuthUserBusiness` tự gọi method `@Transactional` của chính nó (self-invocation), transaction bị bỏ qua. Tách ra `AuthUserWriteService` đảm bảo transaction luôn active khi lưu nhiều entity cùng lúc.

---

### 5.8 `SystemDataBusiness` — Master data với Redis cache

```java
@Cacheable(value = "system_data", key = "#groupCode")
public BaseRp<?> getByGroupCode(String groupCode) {
    // Lần đầu: query DB → cache vào Redis
    // Lần sau: serve thẳng từ Redis
}
```

Master data (roles, statuses, ...) thay đổi hiếm → cache Redis giảm tải DB.

---

## 6. Luồng dữ liệu

```
Frontend/Admin
    │
    │  POST /api/v1/auth/login  (xử lý trong ndip25.api.common — BaseController)
    │  → Sinh access token + refresh token
    │  → Lưu refresh token vào Redis: "{sessionId}-jwt-re-token"
    │  → Lưu userId vào Redis: "user:session:{sessionId}"
    │
    │  POST /api/v1/user/refresh-token
    │  → Parse refresh token → check Redis → sinh access token mới
    │
    │  POST /api/v1/user/logout
    │  → Xóa Redis keys → access token cũ hết hạn tự nhiên
    │
    │  POST /api/v1/user  [admin only]
    │  → Validate → hash password → (RSA key nếu data_owner) → save DB
    │
    │  PUT /api/v1/user/{id}/role  [admin only]
    │  → Validate → tạo RoleAssignmentHistory → save trong 1 transaction
    ▼
PostgreSQL (auth DB): AccountRegister, RoleAssignmentHistory
Redis: JWT refresh tokens, user sessions, master data cache
```

---

## 7. Kết nối với các service liên quan

| Service | Kết nối | Mục đích |
|---|---|---|
| Frontend / Admin Portal | HTTP REST | Đăng nhập, quản lý tài khoản |
| `ndip25.api.common` | Dependency | BaseController (login), JwtSigner, Security filter, Entity |
| PostgreSQL `auth` DB | Spring Data JPA | AccountRegister, RoleAssignmentHistory |
| PostgreSQL `business` DB | Spring Data JPA | MasterSystemData (roles, statuses) |
| Redis | Spring Data Redis | JWT refresh token, user session, master data cache |
| HSM (`hsm-lib-0.0.1.jar`) | Java library | Sinh RSA key cho `data_owner` |

---

## 8. Điểm đáng chú ý

### Design decisions

| Quyết định | Lý do |
|---|---|
| 2 PostgreSQL datasource riêng | Auth data tách biệt với business data — dễ backup, scale độc lập |
| Logout chỉ xóa Redis | JWT stateless — không thể thu hồi token đã cấp, chỉ ngăn refresh |
| `data_owner` RSA key lưu DB + Redis | DB là nguồn gốc (durable), Redis là cache (fast access khi verify chữ ký) |
| Tách `AuthUserWriteService` | Tránh Spring `@Transactional` self-invocation bug — đảm bảo rollback đúng |
| Role không được đổi thành `admin` | Admin chỉ được tạo qua DB trực tiếp (hoặc `createInitAdmin` đã bị comment) |
| `@Cacheable` cho SystemData | Master data ít thay đổi → cache Redis giảm tải DB khi frontend load lookup list |

### Giới hạn hiện tại

| Vấn đề | Mô tả |
|---|---|
| **`createInitAdmin()` bị comment** | Endpoint `/admin/init` bị tắt — không có cách tạo admin qua API, phải insert thẳng vào DB |
| **JWT không có blacklist** | Access token bị logout vẫn dùng được đến hết TTL — rủi ro nếu TTL dài |
| **RSA private key lưu trong DB** | Private key được base64 encode lưu vào cột `private_key` trong PostgreSQL — nếu DB bị lộ thì key bị lộ theo |
| **Cache không có invalidation** | `@Cacheable("system_data")` không có `@CacheEvict` — thay đổi master data trong DB không tự cập nhật cache, phải restart service |
| **`searchAccounts` dùng raw offset** | `int offset = page * size` — pagination theo offset, không scale tốt với bảng lớn |

---

## 9. Roles trong hệ thống

| Role | Mô tả |
|---|---|
| `admin` | Quản trị viên — toàn quyền, không thể bị xóa/sửa/deactivate qua API |
| `data_owner` | Đơn vị cung cấp dữ liệu — được cấp RSA key pair khi tạo tài khoản |
| Các role khác | Lấy từ `MasterSystemData` (group code = `ROLE`) |

---

## 10. Dependencies chính

| Dependency | Mục đích |
|---|---|
| `ndip25.api.common` (common-module) | Entity, Repository, BaseController (login), JwtSigner, Security |
| `spring-boot-starter-web` | REST API |
| `spring-boot-starter-data-jpa` | JPA cho 2 PostgreSQL datasource |
| `spring-boot-starter-data-redis` | JWT refresh token, session, cache |
| `spring-security` | Security filter, `@PreAuthorize` |
| `jjwt` | Tạo và parse JWT |
| `hsm-lib-0.0.1.jar` | HSM — sinh RSA key cho `data_owner` |
| `springdoc-openapi-ui` | Swagger UI (OpenAPI 3) |
| `dotenv-java` | Đọc config từ file `.env` |
| `lombok` | Boilerplate reduction |
| `jargon2` | Argon2 password hashing |
| `bouncycastle` | Crypto utilities |
