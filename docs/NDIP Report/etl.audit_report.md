# Báo cáo phân tích: `ndip25.etl.audit`

> **Ngày:** 2026-04-15
> **Module:** `ndip25.etl.audit` — Audit Service cho hệ thống NDIP25

---

## 1. Tổng quan

`ndip25.etl.audit` là **điểm cuối của pipeline ETL** — nhận NonPII từ Flink để INSERT vào ClickHouse, và nhận pseudoId từ ECP để UPDATE trường PII đã được mã hóa. Đây là service ghi dữ liệu thực sự vào data warehouse.

| Thông tin | Chi tiết |
|---|---|
| **Vai trò** | Ghi dữ liệu cuối pipeline — INSERT NonPII + UPDATE PII pseudoId vào ClickHouse |
| **Input NonPII** | HTTP POST từ `ndip25.etl.flink` (11 NonPii sinks) |
| **Input PII** | HTTP POST từ `ndip25.etl.ecp` (sau khi G2 Engine trả về pseudoId) |
| **Output** | ClickHouse (11 bảng `platform.*`) + PostgreSQL (StagingNonPii, StagingPii) |
| **Port** | 4001 |

**Build:** Maven | **Java:** 17 | **Spring Boot:** dùng `ndip25.api.common`
**Framework:** Spring Boot + MyBatis + JPA

Để build và chạy:
```bash
mvn clean package -DskipTests
java -jar target/*.jar
```

---

## 2. Phân lớp kiến trúc

```
ndip25.etl.audit/
│
└── src/main/java/ndip/api/
    ├── Application.java                        ← Spring Boot entry point
    │
    ├── audit/controller/
    │   ├── NonPiiController.java               ← 2 endpoint: /non-pii/push + /push-simulation
    │   └── PiiController.java                  ← 2 endpoint: /pii/push + /push-simulation
    │
    └── audit/business/
        ├── NonPiiBuusiness.java                ← Logic INSERT NonPII vào ClickHouse
        ├── PiiBusiness.java                    ← Logic UPDATE pseudoId vào ClickHouse
        ├── MergeService.java                   ← Merge PII + NonPII (hiện bị comment out)
        ├── RedisProgressService.java           ← Đếm tiến độ simulation qua Redis
        └── SimulationRunInitService.java       ← Khởi tạo SimulationRun nếu chưa có
```

Toàn bộ entity, mapper, repository, utils đến từ **`ndip25.api.common`** (dependency dùng chung).
Project này chỉ có 8 Java file — toàn bộ logic nghiệp vụ nằm trong 2 Business class.

---

## 3. Cấu hình (`application-local.properties`)

```properties
server.port=4001
endpoint.login.enabled=false    ← tắt login — Audit không cần auth

# PostgreSQL (StagingNonPii, StagingPii, SimulationRun)
spring.datasource.business.url=jdbc:postgresql://10.6.8.37:5432/postgres

# ClickHouse (ghi data thực)
spring.datasource.clickhouse.url=jdbc:clickhouse://10.6.8.37:8123/default

# Auth DB: tắt
spring.datasource.auth.enabled=false

# Redis (đếm tiến độ simulation)
spring.redis.host=10.6.8.37
spring.redis.port=6379
```

---

## 4. Các endpoint

```
POST /api/non-pii/push              ← Flink gọi — production
POST /api/non-pii/push-simulation   ← flink-simulation gọi — test
POST /api/pii/push                  ← ECP gọi — production
POST /api/pii/push-simulation       ← ECP simulation gọi — test
```

---

## 5. Các thành phần chính

### 5.1 `NonPiiBuusiness.pushDataNonPii()` — INSERT NonPII

```
Input: NonPiiRq {
    lineage_id: "uuid-123",
    data: {
        tableKey: "platform.violation",
        nonPiiGroup: { value: "<base64 JSON>" }
    }
}

Bước 1: tableName = "platform.violation"
        decode Base64 → JSON string → parse thành DTO

Bước 2: Lưu StagingNonPii {
            recordId:  "uuid-123",
            tableName: "violation",
            dataJson:  decodedJson,
            status:    SUCCESS
        }

Bước 3: switch(tableName):
    "platform.violation"         → violationMapper.insert(ViolationDTO)
    "platform.driver_license"    → driverLicenseMapper.insert(DriverLicenseDTO)
    "platform.points"            → pointsMapper.insert(PointsDTO)
    "platform.road_infra"        → roadInfraMapper.insert(RoadInfraDTO)
    "platform.traffic_fine"      → trafficFineMapper.insert(TrafficFineDTO)
    "platform.traffic_status"    → trafficStatusMapper.insert(TrafficStatusDTO)
    "platform.vehicle_inspectation" → vehicleInspectationMapper.insert(...)
    "platform.vehicle_insurance" → vehicleInsuranceMapper.insert(...)
    "platform.vehicle_registration" → vehicleRegistrationMapper.insert(...)
    "platform.violation_penalty" → violationPenaltyMapper.insert(...)
    default: log warn

Bước 4: INSERT vào bảng ClickHouse tương ứng
```

Nếu insert lỗi → StagingNonPii `status=FAILED`, log error, tiếp tục (không throw).

---

### 5.2 `PiiBusiness.processPiiData()` — UPDATE pseudoId

```
Input: PiiRequestDto { data: "<base64 của PiiEngineRp>" }

Bước 1: decode Base64 → PiiEngineRp {
            uuid:     "uuid-123",
            pseudoid: "hashed_abc123",
            tableKey: "platform.violation",
            algoType: "PSEUDONYMIZATION"
        }

Bước 2: tableKey.split(".") → table="platform", column="violation"
        toCamelCase("violation") → "violation"

Bước 3: Tìm StagingPii {
            recordId  = uuid,
            tableName = table,
            fieldName = camelColumn,
            status    = WAITING
        }
        → Nếu không tìm thấy → trả lỗi 400

Bước 4: validate(table, column) ← kiểm tra whitelist chống SQL injection

Bước 5: clickHousePlatformMapper.updatePseudoId(table, column, uuid, pseudoid)
        → ALTER TABLE platform.violation
          UPDATE violation = 'hashed_abc123'
          WHERE id = 'uuid-123'

Bước 6: StagingPii.status = SUCCESS
```

**Tại sao validate whitelist?** MyBatis dùng `${table}` (string substitution, không phải `#{}` parameterized) → nguy cơ SQL injection nếu không kiểm soát. `Constants.TABLE_COLUMNS` chứa map whitelist `{ table → Set<column> }`.

---

### 5.3 `MergeService` — Merge PII + NonPII (đang tắt)

```java
// Bị comment out ở cả 2 nơi gọi:
// mergeService.tryMerge(recordId, table);
```

Logic được thiết kế ban đầu:

```
tryMerge(recordId, table):
    1. Kiểm tra StagingNonPii có tồn tại chưa
    2. Lấy danh sách PII fields required từ PiiFieldConfig
    3. Kiểm tra tất cả StagingPii đã SUCCESS chưa
    4. Nếu thiếu PII → StagingNonPii.status = WAITING_PII → chờ

    merge(recordId, table):
    1. Đọc NonPii.dataJson → Map
    2. Đọc từng StagingPii.encryptedJson → Map (pseudoIds)
    3. Gộp 2 Map lại (PII ghi đè lên NonPII)
    4. Build DTO từ merged Map → INSERT vào ClickHouse
    5. StagingNonPii.status = MERGED
    6. StagingPii.status = MERGED (tất cả)
```

Hiện tại flow đã được đơn giản hóa: NonPII insert thẳng, PII update riêng qua `ALTER TABLE UPDATE` — không cần chờ nhau. MergeService là thiết kế cũ chưa bị xóa.

---

### 5.4 `RedisProgressService` — Đếm tiến độ simulation

Dùng cho simulation mode — theo dõi 1 batch simulation đã hoàn thành bao nhiêu record:

```
Redis Hash key: "simulation:run:{runId}"
    total: 100    ← tổng số record cần xử lý (lấy từ SimulationRun.totalFields)
    count: 0      ← đếm tăng dần mỗi khi 1 record xử lý xong

Mỗi record NonPII/PII xong → increment(runId) → count++
Khi count == total:
    → tryComplete() dùng Redis SET NX (setIfAbsent)
      → chỉ 1 thread được mark COMPLETED (race condition safe)
    → SimulationRun.status = COMPLETED
    → clear Redis key
```

**TTL:** key tự xóa sau 24 giờ nếu simulation không hoàn thành.

---

### 5.5 `SimulationRunInitService` — Khởi tạo SimulationRun

```java
initIfNeeded(runId):
    SimulationRun run = simulationRunRepository.findById(runId)
    redisService.initRun(runId, run.getTotalFields())
    // Khởi tạo Redis hash: { total: N, count: 0 }
    // Nếu key đã tồn tại → bỏ qua (idempotent)
```

Được gọi khi nhận record đầu tiên của mỗi simulation run.

---

## 6. Luồng dữ liệu đầy đủ

```
                    ndip25.etl.flink (11 NonPii sinks)
                              │
                              │ POST /api/non-pii/push
                              │ NonPiiRq { lineage_id, tableKey, base64(JSON) }
                              ▼
                    NonPiiBuusiness
                              │
                    ┌─────────┴──────────┐
                    │                   │
                    ▼                   ▼
            StagingNonPii          switch(tableName)
            { status=SUCCESS }     → mapper.insert(DTO)
                                        │
                                        ▼
                                   ClickHouse INSERT
                                   platform.violation
                                   platform.accident
                                   ... (11 bảng)


                    ndip25.etl.ecp
                              │
                              │ POST /api/pii/push
                              │ PiiRequestDto { data: base64(PiiEngineRp) }
                              ▼
                    PiiBusiness
                              │
                    ┌─────────┴──────────┐
                    │                   │
                    ▼                   ▼
            StagingPii             clickHousePlatformMapper
            { status=SUCCESS }     .updatePseudoId()
                                        │
                                        ▼
                                   ALTER TABLE platform.violation
                                   UPDATE violation = 'pseudoId'
                                   WHERE id = 'correlationId'
```

---

## 7. Kết nối với các service liên quan

| Service | Kết nối | Mục đích |
|---|---|---|
| `ndip25.etl.flink` | HTTP POST (upstream) | Nhận 11 stream NonPII |
| `ndip25.etl.ecp` | HTTP POST (upstream) | Nhận pseudoId sau khi G2 Engine xử lý |
| PostgreSQL | JPA + Spring Data | Lưu StagingNonPii, StagingPii, SimulationRun |
| ClickHouse | MyBatis JDBC | INSERT 11 bảng + UPDATE pseudoId |
| Redis | Spring Data Redis | Đếm tiến độ simulation run |

---

## 8. Điểm đáng chú ý

### Design decisions

| Quyết định | Lý do |
|---|---|
| INSERT NonPII ngay khi nhận | Không chờ PII — đơn giản hóa flow, PII update sau qua ALTER TABLE |
| `ALTER TABLE UPDATE` cho PII | ClickHouse mutation — cách duy nhất update data đã insert |
| Whitelist validate trước UPDATE | `${table}` trong MyBatis không parameterized → phải validate thủ công chống SQL injection |
| Redis SET NX cho completion | Tránh race condition khi nhiều thread cùng kiểm tra count == total |
| `endpoint.login.enabled=false` | Audit không cần authentication — chỉ nhận từ các service nội bộ |

### Giới hạn hiện tại

| Vấn đề | Mô tả |
|---|---|
| **MergeService bị comment** | Logic merge PII+NonPII tắt hoàn toàn — nếu cần đồng bộ lại phải bật lên và test |
| **switch 11 case lặp code** | Mỗi case trong `pushDataNonPii` gần như giống nhau — nên refactor thành registry pattern |
| **`simulationRunRepository.findById().orElseThrow()`** | Nếu SimulationRun chưa tạo → throw ngay, không có thông báo rõ ràng |
| **NonPII insert không retry** | Nếu ClickHouse tạm thời lỗi → StagingNonPii `status=FAILED`, không có cơ chế tự retry |
| **Tên class typo** | `NonPiiBuusiness` (2 chữ u) — tên sai nhưng không ảnh hưởng chức năng |

---

## 9. Dependencies chính

| Dependency | Mục đích |
|---|---|
| `ndip25.api.common` | Entity (StagingPii, StagingNonPii, SimulationRun), Mapper, Repository, Utils |
| `spring-boot-starter-web` | REST API |
| `spring-boot-starter-data-jpa` | JPA cho PostgreSQL |
| `mybatis-spring-boot-starter` | MyBatis cho ClickHouse |
| `clickhouse-jdbc` | JDBC driver ClickHouse |
| `spring-boot-starter-data-redis` | Redis cho simulation progress tracking |
| `lombok` | Boilerplate reduction |
