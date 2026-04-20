# Báo cáo phân tích: `ndip25.etl.ecp`

> **Ngày:** 2026-04-15
> **Module:** `ndip25.etl.ecp` — ECP Proxy Service cho hệ thống NDIP25

---

## 1. Tổng quan

`ndip25.etl.ecp` là **service proxy nội bộ** — cầu nối giữa Flink và G2 Engine (bên thứ ba). Nhiệm vụ duy nhất: nhận PII từ Flink, chuyển đổi format, gọi G2 Engine để pseudonymization, rồi forward kết quả sang Audit service.

| Thông tin | Chi tiết |
|---|---|
| **Vai trò** | Proxy/Adapter — che giấu chi tiết của G2 Engine khỏi Flink |
| **Input** | HTTP POST từ `ndip25.etl.flink` (G2Sink) |
| **Output** | HTTP POST → G2 Engine (third-party ECP) + HTTP POST → `ndip25.etl.audit` |
| **Port** | 4000 |

**Build:** Gradle | **Java:** 11 | **Version:** 1.0.0
**Framework:** Spring Boot 2.7.18

Để build và chạy:
```bash
./gradlew clean build -x test
java -jar build/libs/*.jar
```

---

## 2. Phân lớp kiến trúc

```
ndip25.etl.ecp/
│
├── src/main/java/sdeg/api/
│   ├── Application.java                            ← Spring Boot entry point (@EnableScheduling)
│   ├── controller/
│   │   └── ProxyController.java                    ← 2 endpoint POST /proxy/g2/*
│   ├── business/
│   │   └── ProxyBusiness.java                      ← Toàn bộ logic (~300 lines)
│   ├── dto/
│   │   ├── RequestDto.java                         ← { data: String } — input simulation
│   │   ├── RequestSimulationDto.java               ← { data: String } — input simulation
│   │   ├── ApiResponse.java                        ← { data: String } — G2 Engine response
│   │   └── PiiEngineRp.java                        ← { source_id, uuid, pseudoid, table_key, algo_type }
│   ├── mappers/flatform/
│   │   └── ClickHousePlatformMapper.java           ← MyBatis: UPDATE pseudoId vào ClickHouse
│   └── repository/flatform/
│       └── ClickHousePlatformRepository.java       ← (interface rỗng, placeholder)
│
├── common-module/                                  ← Git submodule — chia sẻ với các service khác
│   └── libs/hsm-lib-0.0.1.jar                     ← HSM (Hardware Security Module) library
│
└── src/main/resources/
    ├── application-local.properties                ← Config: port, DB, Redis, SFTP, JWT
    └── mappers/clickhouse/ClickHousePlatformMapper.xml  ← SQL ALTER TABLE UPDATE
```

Project **cực kỳ gọn** — chỉ 9 Java file, toàn bộ logic nằm trong `ProxyBusiness.java`.

---

## 3. Cấu hình (`application-local.properties`)

```properties
server.port=4000
spring.application.name=Proxy G2

# PostgreSQL (lưu StagingPii)
spring.datasource.business.url=jdbc:postgresql://10.6.8.37:5432/postgres
spring.datasource.business.username=admin

# ClickHouse (UPDATE pseudoId)
spring.datasource.clickhouse.url=jdbc:clickhouse://10.6.8.37:8123/default
spring.datasource.clickhouse.enabled=true

# Redis
spring.redis.host=10.6.8.37
spring.redis.port=6379

# Auth DB (tắt — ECP không cần auth)
spring.datasource.auth.enabled=false
```

Config đọc từ file `.env` chung (`sdeg.env`) qua `dotenv-java`:
```properties
spring.config.import=optional:dotenv:file:../sdeg.env
```

---

## 4. Các thành phần chính

### 4.1 `ProxyController` — Điểm nhận request

```java
@RestController
@RequestMapping("/proxy/g2")

POST /proxy/g2/process-data             ← Production: nhận từ Flink G2Sink
POST /proxy/g2/process-data-simulation  ← Simulation: test thủ công
```

Hai endpoint nhưng logic gần giống nhau — khác nhau ở format input và cách build payload gửi G3.

---

### 4.2 `ProxyBusiness.processData()` — Luồng production

**Bước 1 — Lưu StagingPii để tracking:**

```java
// table_key = "platform.violation"
// → split(".") → table = "platform", column = "violation"
// → toCamelCase("violation") → "violation"

StagingPii staging = StagingPii.builder()
    .recordId(lineage_id)
    .tableName("platform")
    .fieldName("violation")
    .payloadG1Json(jsonG1Payload)   // lưu toàn bộ request gốc
    .status("WAITING")
    .build();
stagingPiiRepository.save(staging);
```

Nếu record đã tồn tại (retry) → update `encryptedJson` thay vì tạo mới.

**Bước 2 — Convert format sang G2 Engine:**

```java
// Flink gửi (PiiPayLoadRq):
{
  lineage_id: "uuid-123",
  alg_type: { algo: "PSEUDONYMIZATION", param: "..." },
  data: { table_key: "platform.violation", pii_field: { key: "licensePlate", value: "51A-12345" } }
}

// ECP build lại cho G2 Engine (PiiPayLoad):
{
  source_id: "uuid-123",
  uuid:      "uuid-123",
  algo_type: "PSEUDONYMIZATION",
  pii_field: { key: "licensePlate", value: "51A-12345" },
  table_key: "platform.violation",
  param:     "..."
}
→ JSON → Base64 encode
→ payload = { "data": "<base64>" }
```

**Bước 3 — Gọi G2 Engine:**

```java
POST Constants.Url.G2Eng
Header: X-API-KEY = "a3f1c2d4-7e8b-4f9a-b0c1-2d3e4f5a6b7c"
Body: { "data": "<base64>" }

// Response:
ApiResponse { data: "<base64>" }
→ decode Base64 → PiiEngineRp { pseudoid: "hashed_abc123", algoType: "PSEUDONYMIZATION" }
```

**Bước 4 — Cập nhật StagingPii với pseudoId:**

```java
staging.setEncryptedJson({ "violation": "hashed_abc123" });
staging.setUpdatedAt(LocalDateTime.now());
stagingPiiRepository.save(staging);
```

**Bước 5 — Forward pseudoId sang G3 (Audit):**

```java
POST Constants.Url.G3Audit
Body: { "data": "<base64 của pseudoId>" }
```

**Bước 6 — Trả response về Flink:**

```java
EcpRp {
    success: true,
    error: { code: "ERROR_00", message: "Success!!!" },
    data: {
        lineageId:  "uuid-123",
        algo:       "PSEUDONYMIZATION",
        deidValue:  "hashed_abc123",
        tableKey:   "platform.violation"
    }
}
```

---

### 4.3 `ProxyBusiness.simulation()` — Luồng test

Tương tự production nhưng:
- Input là Base64 encoded `PiiPayLoad` (không qua Flink format)
- Gửi thẳng sang G2 Engine mà không lưu StagingPii
- Forward sang `Constants.Url.G3AuditSimulation` thay vì `G3Audit`

Dùng để test thủ công G2 Engine khi không chạy Flink.

---

### 4.4 `ClickHousePlatformMapper` — UPDATE pseudoId vào ClickHouse

```xml
<!-- ClickHousePlatformMapper.xml -->
<update id="updatePseudoId">
    ALTER TABLE ${table}
    UPDATE ${column} = #{pseudoid}
    WHERE id = #{uuid}
</update>
```

ClickHouse không hỗ trợ `UPDATE` thông thường — phải dùng `ALTER TABLE ... UPDATE` (mutation). Mapper này là dự phòng để ECP có thể tự UPDATE ClickHouse nếu cần, nhưng flow chính vẫn để Audit service làm.

---

### 4.5 `hsm-lib-0.0.1.jar` — Hardware Security Module

```
common-module/libs/hsm-lib-0.0.1.jar
```

HSM (Hardware Security Module) là thư viện kết nối với thiết bị phần cứng bảo mật chuyên dụng — nơi G2 Engine thực hiện pseudonymization ở mức hardware. Khóa mã hóa được giữ trong HSM, không bao giờ lộ ra ngoài.

---

## 5. Luồng dữ liệu đầy đủ

```
ndip25.etl.flink (G2Sink)
    │  POST /proxy/g2/process-data
    │  PiiPayLoadRq { lineage_id, alg_type, data { table_key, pii_field } }
    ▼
ndip25.etl.ecp (port 4000)
    │
    ├── 1. Lưu StagingPii { status=WAITING }          → PostgreSQL
    ├── 2. Convert PiiPayLoadRq → PiiPayLoad
    ├── 3. JSON → Base64 encode
    │
    │  POST G2 Engine (third-party ECP)
    │  Header: X-API-KEY
    │  Body: { data: base64 }
    ▼
G2 Engine (HSM-backed)
    │  Response: { data: base64(PiiEngineRp) }
    │  PiiEngineRp { pseudoid: "hashed_abc123", ... }
    ▼
ndip25.etl.ecp (tiếp tục)
    │
    ├── 4. Decode response → lấy pseudoid
    ├── 5. Cập nhật StagingPii { encryptedJson=pseudoid }  → PostgreSQL
    │
    │  POST ndip25.etl.audit (G3Audit)
    │  Body: { data: base64(pseudoid) }
    ▼
ndip25.etl.audit
    └── UPDATE ClickHouse: pii_pseudo_id = pseudoid
        WHERE correlation_id = lineage_id
```

---

## 6. Kết nối với các service liên quan

| Service | Kết nối | Mục đích |
|---|---|---|
| `ndip25.etl.flink` | HTTP POST (upstream) | Nhận PII cần pseudonymization |
| **G2 Engine** | HTTP POST + X-API-KEY | Third-party thực hiện mã hóa |
| `ndip25.etl.audit` | HTTP POST (downstream) | Forward pseudoId để lưu ClickHouse |
| PostgreSQL | Spring JPA | Lưu/đọc `StagingPii` |
| ClickHouse | MyBatis JDBC | UPDATE pseudoId trực tiếp (dự phòng) |

---

## 7. Điểm đáng chú ý

### Design decisions

| Quyết định | Lý do |
|---|---|
| Tách thành proxy riêng | Flink không cần biết format/auth của G2 Engine — dễ thay third-party sau này |
| Lưu `StagingPii` trước khi gọi G2 | Tracking — biết record nào đang `WAITING` để retry khi G2 lỗi |
| `toCamelCase` cho column name | `table_key = "platform.violation"` → column = `"violation"` theo Java naming convention |
| Dùng `common-module` submodule | Chia sẻ `StagingPii` entity và `Constants` với các service khác mà không duplicate code |
| `simulation` endpoint riêng | Test thủ công G2 Engine mà không cần chạy toàn bộ pipeline |

### Giới hạn hiện tại

| Vấn đề | Mô tả |
|---|---|
| **`StagingPii` không set `SUCCESS`** | Sau khi G2 thành công, code chỉ lưu `encryptedJson`, không set `status=SUCCESS` — Audit service mới cập nhật, dễ nhầm lẫn trạng thái |
| **`existingError.get()` không an toàn** | Trong catch block gọi `existingError.get()` không kiểm tra `isPresent()` → `NoSuchElementException` nếu record không tồn tại |
| **RestTemplate không có timeout** | Nếu G2 Engine không phản hồi → thread bị block vô thời hạn |
| **Không retry khi G2 thất bại** | Catch exception → set `status=FAILED` rồi trả lỗi về Flink, không có cơ chế tự retry |
| **`common-module` không checked out** | Git submodule rỗng trong repo → phải init submodule riêng khi clone |

---

## 8. Dependencies (`build.gradle`)

| Dependency | Mục đích |
|---|---|
| `spring-boot-starter-web` | REST API |
| `spring-boot-starter-data-jpa` | JPA cho PostgreSQL (StagingPii) |
| `mybatis-spring-boot-starter` | MyBatis cho ClickHouse |
| `clickhouse-jdbc` | JDBC driver ClickHouse |
| `postgresql` | JDBC driver PostgreSQL |
| `spring-boot-starter-data-redis` | Redis (dùng qua common-module) |
| `hsm-lib-0.0.1.jar` | HSM library — kết nối Hardware Security Module |
| `dotenv-java` | Đọc config từ file `.env` |
| `lombok` | Boilerplate reduction |
| `jjwt` | JWT (dùng qua common-module) |
| `spring-security` | Security filter (dùng qua common-module) |
