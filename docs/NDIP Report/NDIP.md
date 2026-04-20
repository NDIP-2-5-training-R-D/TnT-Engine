# NDIP25 — Báo Cáo Tổng Hợp Hệ Thống

> **Ngày:** 2026-04-16
> **Phạm vi:** 8 services, toàn bộ luồng dữ liệu, giao tiếp giữa các node, performance và security

---

## Mục Lục

1. [Tổng Quan Hệ Thống](#1-tổng-quan-hệ-thống)
2. [Danh Sách Services](#2-danh-sách-services)
3. [Cách Các Node Giao Tiếp](#3-cách-các-node-giao-tiếp)
4. [Luồng Dữ Liệu Chi Tiết](#4-luồng-dữ-liệu-chi-tiết)
5. [Vấn Đề Performance](#5-vấn-đề-performance)
6. [Vấn Đề Security](#6-vấn-đề-security)
7. [Đề Xuất Chuyển HTTP Sang Kafka](#7-đề-xuất-chuyển-http-sang-kafka)

---

## 1. Tổng Quan Hệ Thống

NDIP25 (National Data Integration Platform) là nền tảng tích hợp dữ liệu giao thông quốc gia. Hệ thống nhận file XML từ các đơn vị cung cấp dữ liệu (Cục CSGT, tỉnh/thành), xử lý stream, tách PII (dữ liệu định danh cá nhân) khỏi Non-PII, mã hóa PII qua G2 Engine, rồi lưu toàn bộ vào ClickHouse để phân tích.

```
XML Files (SFTP/Local)
        │
        ▼
[File Watcher] ──Kafka──▶ [Flink ETL]
                                │
                   ┌────────────┴────────────┐
                   ▼                         ▼
            Non-PII path               PII path
                   │                         │
                   ▼                         ▼
            [G3 Audit]          [G2 ECP Proxy] ──HTTPS──▶ [G2 Engine]
                   │                         │
                   └────────────┬────────────┘
                                ▼
                          ClickHouse
                        (11 bảng platform.*)
```

---

## 2. Danh Sách Services

| # | Service | Port | Build | Java | Vai trò |
|---|---------|------|-------|------|---------|
| 1 | `ndip25.api.common` | — | Gradle | 11 | Shared library: DTOs, entities, security, utils |
| 2 | `ndip25.api.platform.auth` | 4001 | Gradle | 11 | Authentication, JWT, quản lý tài khoản |
| 3 | `ndip25.api.bussiness.admin` | 4002 | Gradle | 11 | Admin API: datasets, schemas, simulation |
| 4 | `ndip25.etl.ecp` | 4000 | Gradle | 11 | G2 Proxy: nhận PII từ Flink, forward G2 Engine |
| 5 | `ndip25.etl.audit` | 5001 | Maven | 17 | G3: nhận NonPII + pseudoId, ghi ClickHouse |
| 6 | `ndip25.etl.file-watcher` | — | Maven | 17 | Giám sát thư mục, publish Kafka khi có file mới |
| 7 | `ndip25.etl.flink` | — | Maven | 17 | Core ETL: parse XML, tách PII/NonPII, gửi G2/G3 |
| 8 | `ndip25.etl.flink-simulation` | — | Maven | 17 | Phiên bản test của Flink job |

---

## 3. Cách Các Node Giao Tiếp

### 3.1 Bảng Tổng Hợp Giao Thức

| From | To | Giao thức | Endpoint / Topic | Ghi chú |
|------|----|-----------|-----------------|---------|
| File Watcher | Kafka | **Kafka Producer** | topic: `file-events` | JSON: filePath, source, fileSize |
| Kafka | Flink | **Kafka Consumer** | topic: `file-events` | offset: latest, group: file-events |
| Admin | Kafka | **Kafka Producer** | topic: `test` | Publish simulation run ID |
| Kafka | Flink Simulation | **Kafka Consumer** | topic: `test` | Consume simulation run ID |
| Flink | ECP (G2 Proxy) | **HTTP POST** | `http://10.6.8.37:4000/proxy/g2/process-data` | PII plaintext, không auth |
| Flink | G3 Audit | **HTTP POST** | `http://10.6.8.37:5001/api/non-pii/push` | NonPII base64, không auth |
| ECP | G2 Engine | **HTTPS POST** | `https://tnt.gtelcds.vn/api/v1/deid` | Header: X-API-KEY, body: base64 |
| ECP | G3 Audit | **HTTP POST** | `http://10.6.8.37:5001/api/pii/push` | pseudoId base64, không auth |

### 3.2 Tại Sao Dùng Kafka Ở Một Số Chỗ, HTTP Ở Chỗ Khác?

**Kafka được dùng khi:**
- Không cần response ngay (fire-and-forget)
- File Watcher → Flink: chỉ cần báo "có file mới", Flink tự đọc
- Admin → Flink Simulation: chỉ cần trigger, không chờ kết quả

**HTTP được dùng khi:**
- Cần response để tiếp tục xử lý
- Flink gửi PII sang ECP: cần biết pseudoId để ghi ClickHouse
- ECP gọi G2 Engine: bắt buộc request-response vì G2 Engine là external REST API
- ECP forward sang G3: cần biết ghi thành công hay không

**Vấn đề cốt lõi:**

```
Flink xử lý 1 record violation có 11 PII fields:
  bienSo, tenNguoiViPham, ngaySinh, soCMND, ... (11 fields)

Mỗi field phải được gửi sang G2 Engine để lấy pseudoId riêng.
G2 Engine là external HTTPS API → bắt buộc request-response.
→ Không thể dùng Kafka để gọi external API.
→ HTTP là lựa chọn tự nhiên cho toàn bộ chuỗi Flink → ECP → G3.
```

### 3.3 Kafka Message Format

**Topic `file-events` (File Watcher → Flink):**
```json
{
  "eventType":    "FILE_READY",
  "filePath":     "C:\\ndip\\data\\CO8\\data_20260414.xml",
  "fileName":     "data_20260414.xml",
  "fileSize":     102400,
  "lastModified": 1710701400000,
  "eventTime":    "2026-04-14T10:30:00.123Z",
  "source":       "CO8"
}
```

**Topic `test` (Admin → Flink Simulation):**
```
"550e8400-e29b-41d4-a716-446655440000"   ← UUID của SimulationRun
```

### 3.4 HTTP Payload Format

**Flink → ECP (PII):**
```json
{
  "lineage_id": "uuid-correlationId",
  "alg_type": {
    "engine": "G2",
    "use_case": "VEHICLE",
    "algo": "PSEUDONYMIZATION",
    "param": "..."
  },
  "data": {
    "table_key": "platform.violation",
    "pii_field": { "key": "bienSo", "value": "51A-12345" }
  }
}
```

**ECP → G2 Engine (external):**
```json
{ "data": "<base64 encoded PiiPayLoad>" }
```
Header: `X-API-KEY: a3f1c2d4-7e8b-4f9a-b0c1-2d3e4f5a6b7c`

**G2 Engine → ECP (response):**
```json
{ "data": "<base64 encoded PiiEngineRp>" }
```
Decoded: `{ "pseudoid": "hashed_abc123", "uuid": "...", "tableKey": "platform.violation" }`

**Flink → G3 Audit (NonPII):**
```json
{
  "lineage_id": "uuid-correlationId",
  "data": {
    "table_key": "platform.violation",
    "non_pii_group": { "key": "platform.violation", "value": "<base64 JSON>" }
  }
}
```

---

## 4. Luồng Dữ Liệu Chi Tiết

### 4.1 Luồng Production (Main Pipeline)

```
BƯỚC 1 — Phát hiện file
  File XML xuất hiện trong C:\ndip\data\CO8\
  File Watcher phát hiện qua Java NIO WatchService
  Debounce 1000ms (chờ file ghi xong)
  Double-check: đọc size+mod 2 lần cách nhau 1s → nếu bằng nhau → file ổn định
  Publish Kafka topic "file-events" (key=filePath, acks=all, idempotence=true)

BƯỚC 2 — Flink đọc và parse
  Kafka Consumer consume message từ "file-events"
  MinioXmlFetcher: parse JSON → lấy filePath, source
  FullXmlParser: đọc file XML từ disk, XmlMapper → PhuongTienTongHop POJO
  PatientCheckinExtractor:
    - correlationId = UUID.randomUUID()
    - FlattenUtil.flatten(pojo) → Map<String, Object> (dot-notation)
    - So sánh từng key với PiiConfigMap (load từ PostgreSQL lúc khởi động)
    - Tách thành: piiFields + nonPiiFields
    - Build Tuple12(ViolationDTO, ..., 10 DTOs khác, PiiPayload)

BƯỚC 3 — Gửi song song NonPII và PII

  NonPII path (11 sinks song song):
    ViolationSink/PointSink/.../AccidentSink
    Gom batch (batchSize=1000, flushInterval=5000ms)
    Mỗi record: JSON → Base64 → HTTP POST /api/non-pii/push
    G3 Audit nhận:
      - Decode Base64 → parse JSON → build DTO
      - Lưu StagingNonPii {status=SUCCESS}
      - INSERT vào ClickHouse (platform.violation, ...)

  PII path (1 G2Sink):
    Gom batch (batchSize=1000, flushInterval=5000ms)
    Mỗi PII field: HTTP POST /proxy/g2/process-data
    ECP nhận:
      - Lưu StagingPii {status=WAITING} vào PostgreSQL
      - Build PiiPayLoad → JSON → Base64
      - HTTPS POST G2 Engine với X-API-KEY
      G2 Engine trả về pseudoId
      - UPDATE StagingPii {encryptedJson=pseudoId}
      - HTTP POST /api/pii/push sang G3 Audit
    G3 Audit nhận:
      - Decode Base64 → lấy pseudoId, correlationId
      - Tìm StagingPii theo recordId+tableName+status=WAITING
      - Validate whitelist (chống SQL injection)
      - ALTER TABLE platform.violation UPDATE bienSo='pseudoId' WHERE id='correlationId'
      - UPDATE StagingPii {status=SUCCESS}

BƯỚC 4 — Dữ liệu trong ClickHouse
  platform.violation: NonPII fields đã có, PII fields được UPDATE pseudoId
  Mỗi record có correlationId để link PII ↔ NonPII
```

### 4.2 Luồng Simulation (Test Pipeline)

```
Admin upload file XML mẫu
  → Business Admin lưu file
  → Publish Kafka topic "test" với SimulationRun UUID

Flink Simulation consume "test"
  → Đọc SimulationRun từ PostgreSQL
  → Parse XML giống production
  → Gửi NonPII sang /api/non-pii/push-simulation
  → Gửi PII sang /proxy/g2/process-data-simulation

G3 Audit ghi vào simulation tables
  → Redis counter: increment mỗi record xử lý xong
  → Khi count == total → SimulationRun.status = COMPLETED

Admin query kết quả:
  GET /simulations/preview/{id}   → ClickHouse
  GET /simulations/risk-analysis/{id} → K-Anonymity score
```

### 4.3 Vòng Đời Trạng Thái StagingPii

```
INSERT (ECP nhận request từ Flink)
  status = WAITING

UPDATE (G2 Engine trả về pseudoId)
  status = WAITING → encryptedJson = pseudoId (chưa đổi status)

UPDATE (G3 Audit nhận từ ECP)
  status = SUCCESS

[MergeService — hiện bị comment out]
  status = SUCCESS → MERGED
```

### 4.4 Database Được Dùng Bởi Từng Service

| Service | PostgreSQL | ClickHouse | Redis | Kafka |
|---------|-----------|-----------|-------|-------|
| Auth | auth.user, role_history | — | sessions, JWT | — |
| Admin | datasets, schemas, simulation | simulation results | cache | producer: test |
| ECP | staging_pii | update pseudoId | cache | — |
| Audit | staging_pii, staging_non_pii | 11 platform tables | simulation counter | — |
| Flink | PiiConfig (SELECT only) | — | — | consumer: file-events |
| File Watcher | — | — | — | producer: file-events |

---

## 5. Vấn Đề Performance

### 5.1 Batch Collection Có — Batch Sending Chưa Có

**Hiện trạng:**

```java
// G2Sink.java và ViolationSink.java — pattern giống nhau
private void flushBatch() {
    List<G2RequestDto> currentBatch = new ArrayList<>(batch);
    batch.clear();

    for (G2RequestDto dto : currentBatch) {
        callG2Api(dto);   // ← vòng for tuần tự, 1 record = 1 HTTP call
    }
}
```

Records được gom vào `List` (batchSize=1000, flushInterval=5000ms) — đây là **batch collection**. Tuy nhiên khi flush, vẫn loop tuần tự từng record — **batch sending chưa có**.

**Vấn đề kỹ thuật:**

`flushBatch()` chạy trên Flink task thread. Mỗi `callG2Api()` là synchronous HTTP call — thread block cho đến khi nhận response. Toàn bộ batch phải xử lý xong tuần tự trên 1 thread trước khi checkpoint có thể tiến lên. Điều này:

- **Block Flink operator chain**: downstream operator không nhận record mới trong thời gian flush
- **Tăng checkpoint latency**: checkpoint interval 15s không có ý nghĩa nếu 1 flush block lâu hơn 15s
- **Không tận dụng parallelism**: `parallelism=2` nghĩa là 2 task, nhưng mỗi task vẫn flush tuần tự — concurrency thực tế = 2, không phải 2×batchSize

**Giải pháp:**

```java
// Parallel flush với CompletableFuture
List<CompletableFuture<Void>> futures = currentBatch.stream()
    .map(dto -> CompletableFuture.runAsync(() -> callG2Api(dto), executor))
    .collect(Collectors.toList());
CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();

// Hoặc bulk API — gom toàn bộ batch thành 1 request nếu G2/G3 hỗ trợ
ApiClient.pushNonPiiBulk(tableKey, currentBatch);
```

### 5.2 HTTP Cascade Per-Record

**Vị trí:** `G2Sink.java`, `ApiClient.java`

`G2Sink` iterate từng PII field và gọi HTTP tuần tự — mỗi field là 1 round-trip độc lập:

```java
// G2Sink.java
for (PiiField field : record.getPiiFields()) {
    callG2Api(field);   // ← synchronous, chờ response trước khi gọi field tiếp theo
}
```

Với bảng `platform.violation` có nhiều PII field (biển số, CMND, họ tên...), mỗi record kéo theo một chuỗi HTTP call tuyến tính xuyên qua 3 hop:

```
Flink → ECP → G2 Engine → ECP → G3 Audit
         ↑_________1 call/field_________↑
         mỗi field block cho đến khi cả chain trả về
```

**Vấn đề kỹ thuật:**

- **Fan-out nhân tuyến tính với số PII field**: thêm 1 PII field vào schema → toàn bộ throughput giảm tỷ lệ tương ứng
- **Không có request pipelining**: ECP không dùng HTTP/2 hay multiplexing — mỗi call mở connection mới hoặc chờ connection từ pool
- **Back-pressure từ G2 Engine nhân lên**: nếu G2 Engine chậm do HSM load, Flink → ECP cũng bị block theo — không có buffer layer

**Giải pháp:** Gom tất cả PII field của 1 record thành 1 request (`List<PiiField>` thay vì gọi từng cái), hoặc parallel calls với `CompletableFuture`.

### 5.3 ClickHouse Connection Pool Riêng Mỗi Sink

**Vị trí:** `ViolationSink.java`, `PointSink.java`, ... (12 file giống hệt)

```java
public void open(Configuration parameters) {
    dataSource = new ClickHouseDataSource(Contants.CLICK_URL);
    // Không config pool size, không share với sink khác
}
```

Mỗi `RichSinkFunction.open()` tạo 1 `ClickHouseDataSource` mới — không dùng singleton, không share pool. Với 12 sink và `parallelism=2`, có 24 pool instance song song tồn tại đồng thời.

**Vấn đề kỹ thuật:**

- **Connection exhaustion**: ClickHouse mặc định giới hạn `max_concurrent_queries`. 24 pool × default pool size vượt ngưỡng này → các query sau bị reject hoặc timeout
- **Không có pool lifecycle management**: `DataSource` được tạo trong `open()` nhưng không có `close()` tương ứng — connection leak khi Flink task restart
- **Thiếu backoff khi ClickHouse overloaded**: không có retry logic, lỗi connection → task fail ngay lập tức

**Giải pháp:** Shared `ClickHouseDataSource` singleton qua static field hoặc Flink `BroadcastState`, với explicit `close()` trong `RichSinkFunction.close()`.

### 5.4 HikariCP Pool Quá Nhỏ

**Vị trí:** `application-local.properties` (tất cả service)

```properties
spring.datasource.hikari.maximumPoolSize=5
```

**Vấn đề kỹ thuật:**

HikariCP pool size 5 được cấu hình cho tất cả Spring Boot service (Audit, Admin, Auth). Pool size này không tính đến concurrency thực tế:

- **Audit service**: nhận NonPII và PII song song từ nhiều Flink sink — nếu 6+ request đồng thời đến, request thứ 6 trở đi phải chờ connection từ pool → `SQLTimeoutException` sau `connectionTimeout` (mặc định 30s)
- **HikariCP deadlock pattern**: nếu 1 transaction đang giữ connection và cần acquire connection thứ 2 (nested transaction) → deadlock khi pool đã đầy
- **Pool size cần tính theo công thức**: `connections = (core_count × 2) + effective_spindle_count` (PostgreSQL best practice) — với pool=5 thường phù hợp cho máy 2 core đơn workload, không phải multi-service concurrent

**Giải pháp:** Tính toán lại pool size theo số thread concurrent thực tế của từng service. Audit cần pool lớn hơn do nhận từ nhiều upstream cùng lúc.

### 5.5 PII Config Không Cache, Query DB Mỗi Lần

**Vị trí:** `MergeService.java`, `ConfigService.java`

```java
// ConfigService.java — có comment TODO
// TODO: lấy từ cache ← đang query DB mỗi lần thay vì Redis
public Config getConfig(Enums.Config code) {
    return configRepository.findById(code.name()); // DB call mỗi request
}
```

`PiiConfigLoader` load 1 lần khi Flink khởi động — đúng. Nhưng `MergeService` query DB mỗi record để lấy required PII fields → N+1 problem.

### 5.6 Base64 Encode/Decode Mỗi Hop

Base64 được dùng ở mọi hop kể cả giữa các service nội bộ:

```
NonPII path:  Flink serialize DTO → JSON → Base64 → HTTP body → G3 decode Base64 → JSON → DTO → ClickHouse INSERT
PII path:     Flink → ECP (raw JSON) → ECP encode Base64 → G2 Engine → decode → encode response Base64 → ECP decode → encode Base64 → G3 decode
```

**Vấn đề kỹ thuật:**

- **Overhead không cần thiết trên internal calls**: Base64 là binary-to-text encoding dùng để truyền binary data qua text-only channel (email, XML). HTTP body không có hạn chế này — JSON object có thể truyền trực tiếp mà không cần encode
- **Payload size tăng ~33%**: với throughput cao, overhead này cộng dồn đáng kể trên network
- **Mất type safety**: khi wrap vào `{ "data": "<base64>" }`, receiver phải decode và re-parse — không có schema validation ở tầng HTTP, lỗi chỉ phát hiện bên trong business logic
- **Double serialization tại ECP**: ECP nhận JSON từ Flink, encode thành Base64 để gửi G2 Engine, rồi lại decode response và encode lại khi forward sang G3 — 4 lần serialize/deserialize cho 1 record

Base64 chỉ thực sự cần tại boundary với G2 Engine (external service, có thể có yêu cầu riêng về format). Internal calls giữa Flink → ECP → G3 nên truyền JSON trực tiếp.

### 5.7 Staging Table Không Có Index, Không Cleanup

**Vị trí:** `MergeService.java` (query không có composite index)

```sql
-- PiiBusiness.java — query tìm StagingPii để UPDATE
SELECT * FROM common.staging_pii
WHERE record_id = ? AND table_name = ? AND status = 'WAITING'
-- Không có composite index trên (record_id, table_name, status)
```

**Vấn đề kỹ thuật:**

- **Sequential scan tăng theo thời gian**: `staging_pii` không có TTL, không có cleanup job — mọi record từ ngày đầu vẫn còn trong bảng. PostgreSQL sequential scan cost tỷ lệ tuyến tính với số row. Query trên sẽ chậm dần theo thời gian mà không có cảnh báo
- **`status` column có low cardinality**: chỉ có `WAITING / SUCCESS / FAILED` — index riêng trên `status` không hiệu quả. Composite index `(record_id, table_name, status)` mới đúng vì selectivity cao ở 2 column đầu
- **`SELECT *` thay vì chỉ cần `id`**: kéo toàn bộ `payload_g1_json` và `encrypted_json` về memory dù chỉ cần update status
- **Không có partition**: nếu dùng range partition theo `created_at` (theo tháng), PostgreSQL có thể prune partition → chỉ scan tháng hiện tại thay vì toàn bộ bảng

**Giải pháp:**

```sql
CREATE INDEX idx_staging_pii_lookup ON staging_pii (record_id, table_name, status);
-- Partition theo tháng
CREATE TABLE staging_pii_2026_04 PARTITION OF staging_pii
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
-- Cleanup: drop partition cũ thay vì DELETE từng row
```

### 5.8 Flink Không Có Restart Strategy

**Vị trí:** `App.java`

```java
// Có checkpoint:
env.enableCheckpointing(15000);
env.getCheckpointConfig().setCheckpointingMode(CheckpointingMode.EXACTLY_ONCE);

// Thiếu restart strategy:
// Nếu Flink task fail → job dừng hẳn, không tự restart
// Không có exponential backoff
// Không có Dead Letter Queue cho records lỗi
```

### 5.9 Hạn Chế Kiến Trúc 12 Sink

**Hiện trạng — 1 bảng = 1 sink class:**

Flink hiện có **12 sink class riêng biệt**, mỗi class tương ứng với 1 bảng ClickHouse:

```
G2Sink.java               ← PII → ECP
ViolationSink.java        ← platform.violation
ViolationPenaltySink.java ← platform.violation_penalty
DriverLicenseSink.java    ← platform.driver_license
PointSink.java            ← platform.points
TrafficFineSink.java      ← platform.traffic_fine
TrafficStatusSink.java    ← platform.traffic_status
VehicleRegistrationSink.java
VehicleInspectationSink.java
VehicleInsuranceSink.java
RoadInfraSink.java
AccidentSink.java
```

Tất cả 11 NonPII sink có cùng cấu trúc — chỉ khác tên bảng và tên DTO.

**Vấn đề — Thêm bảng mới phải sửa 8 chỗ thủ công:**

```
1. dtos/database/CustomsDeclarationDTO.java   ← tạo DTO mới
2. enums/CustomsJsonKey.java                  ← key mapping mới
3. servicve/clickhouse/CustomsSink.java       ← tạo sink mới (copy-paste)
4. App.java                                   ← thêm stream + addSink(new CustomsSink(...))
5. PatientCheckinExtractor.java               ← build thêm DTO trong flatMap
6. ultis/sql/ClickHouseSql.java               ← thêm INSERT SQL
7. Tuple12 → Tuple13                          ← tăng index Tuple
8. ClickHouse schema                          ← tạo bảng thực tế
```

Flink không có cơ chế tự động phát hiện bảng mới. Toàn bộ pipeline định nghĩa cứng tại compile time trong `App.java`. Muốn thêm sink → phải rebuild và redeploy toàn bộ Flink job.

**Giới hạn cứng của Flink Tuple:**

```java
// App.java — hiện tại
DataStream<Tuple12<ViolationDTO, ViolationPenaltyDTO, ..., PiiPayload>> stage3
// Flink chỉ hỗ trợ tối đa Tuple25 → hiện còn 13 slot
```

**Giải pháp — Dynamic sink dựa trên metadata:**

```java
// Thay Tuple12 bằng wrapper object
class ExtractedRecord {
    String correlationId;
    Map<String, Object> nonPiiByTable;  // "platform.violation" → ViolationDTO
    List<G2RequestDto> piiFields;
}

// 1 generic sink thay 11 sink riêng
class DynamicNonPiiSink extends RichSinkFunction<Map.Entry<String, Object>> {
    void invoke(entry, context) {
        String tableKey = entry.getKey();   // "platform.violation"
        Object dto      = entry.getValue();
        ApiClient.pushNonPii(tableKey, correlationId, toBase64(dto));
    }
}
```

Khi thêm bảng mới: chỉ INSERT vào `common.schema_definition` — không cần sửa code, không cần redeploy Flink.

---

### 5.10 Tóm Tắt Performance

| Vấn đề | Hiện trạng | Impact | Giải pháp |
|--------|-----------|--------|-----------|
| Vấn đề | Root Cause | Hệ Quả Kỹ Thuật | Giải Pháp |
|--------|-----------|-----------------|-----------|
| Batch sending | `flushBatch()` loop synchronous trên task thread | Block operator chain, tăng checkpoint latency | `CompletableFuture` parallel flush hoặc bulk API |
| HTTP cascade per-field | `G2Sink` gọi 1 HTTP/field, không pipeline | Throughput tỷ lệ nghịch với số PII field trong schema | Gom fields thành 1 request, hoặc async parallel calls |
| Connection pool isolation | Mỗi `RichSinkFunction.open()` tạo `DataSource` mới | Connection exhaustion, không có lifecycle `close()` | Shared singleton `DataSource` với explicit `close()` |
| HikariCP pool nhỏ | `maximumPoolSize=5` cho mọi service | `SQLTimeoutException` khi concurrent requests > 5 | Tính pool size theo `core_count × 2 + spindle_count` |
| Config không cache | `MergeService` query DB mỗi record | N+1 problem — latency tăng tuyến tính theo throughput | `@Cacheable` với Redis hoặc Caffeine |
| Base64 trên internal calls | Encode/decode ở mọi hop kể cả nội bộ | Double serialization tại ECP, mất type safety, tăng payload size | Chỉ encode tại boundary với G2 Engine (external) |
| Staging table không index | Không có composite index, không partition, không TTL | Sequential scan degradation theo thời gian tích lũy data | Composite index `(record_id, table_name, status)` + range partition |
| Không có restart strategy | `App.java` không set `RestartStrategies` | Flink task fail → job dừng hẳn, checkpoint không được dùng | `exponentialDelay` restart + Dead Letter Queue |
| 12 sink hardcoded | 1 class/bảng, `Tuple12` compile-time | Thêm bảng mới phải sửa 8 chỗ + redeploy toàn bộ job | Dynamic sink + metadata-driven schema |

---

## 6. Vấn Đề Security

### 6.1 Toàn Cảnh — Không Có Lớp Bảo Vệ Nào

```
Hiện trạng:
  Transport:          HTTP plaintext (trừ ECP → G2 Engine là HTTPS)
  Service authn:      Không có — tất cả endpoint permitAll()
  Service authz:      Không có
  Encryption at-rest: AES-CTR (sai mode, không có integrity check)
  Key management:     Hardcode trong source code
  Kafka:              PLAINTEXT, không auth
  JWT:                HS256 shared secret
  SSL verification:   Bị tắt (trust all certs)
```

### 6.2 [CRITICAL] PII Endpoints Không Có Authentication

**Vị trí:** `WebSecurityConfig.java`

```java
.antMatchers("/api/pii/push").permitAll()
.antMatchers("/api/non-pii/push").permitAll()
.antMatchers("/proxy/g2/process-data").permitAll()
```

Bất kỳ máy nào trong cùng network có thể POST trực tiếp vào G3 Audit với pseudoId giả, làm nhiễm toàn bộ dữ liệu trong ClickHouse mà không có cách phát hiện.

**Cần:** JWT service account (RS256) với role `INTERNAL_SERVICE`. Chỉ Flink và ECP được phép gọi các endpoint này.

### 6.3 [CRITICAL] HTTP Thuần Cho PII Data

**Vị trí:** `Contants.java` (Flink)

```java
G3NonPii   = "http://10.6.8.37:5001/api/non-pii/push"
G2_ECP_Pii = "http://10.6.8.37:4000/proxy/g2/process-data"
```

Dữ liệu PII (biển số xe, số CMND, tên người...) truyền qua mạng nội bộ dưới dạng JSON plaintext. Bất kỳ ai capture traffic (tcpdump, Wireshark trên switch nội bộ) đều đọc được toàn bộ.

**Cần:** HTTPS minimum cho internal calls. mTLS via Istio khi lên Kubernetes.

### 6.4 [CRITICAL] AES-CTR Không Có Authentication Tag

**Vị trí:** `AesUtils.java`

```java
Cipher cipher = Cipher.getInstance("AES/CTR/NoPadding");
// CTR mode không có authentication tag
// Attacker có thể flip bits → dữ liệu PII bị sửa mà hệ thống không phát hiện
// (bit-flip attack: C2 = C1 XOR P1 XOR P2 → decrypt ra P2 tùy ý)
```

**Cần:** AES-256-GCM (AEAD — Authenticated Encryption with Associated Data). GCM tự động detect tampering, ném `AEADBadTagException` nếu ciphertext bị sửa.

### 6.5 [CRITICAL] Secrets Hardcode Trong Source Code

**Vị trí:** `Constants.java`, `Contants.java` (Flink), `application-local.properties`

```java
// Constants.java (api.common)
SECRET_KEY_ENC_DATA_IN_DB = "oXUNMBlukY7mMt27Zt9H-neNiYNhyubZUjVimGDxEt4=";

// Contants.java (Flink)
CLICK_PASS = "Gtel@123";
PSQL_PASS  = "Gtel@123";

// application-local.properties (tất cả service)
ndip.security.jwt.secret-key=PiXGE/AdFKL...
```

Ai clone được repo → có toàn bộ credentials → giải mã được toàn bộ PII trong database.

**Cần:** Đưa tất cả secrets vào environment variables hoặc HashiCorp Vault. Thêm `application-local.properties` vào `.gitignore`.

### 6.6 [MAJOR] JWT Dùng HS256 (Symmetric Shared Secret)

**Vị trí:** `JwtSigner.java`

```java
Jwts.builder().signWith(secretKey, SignatureAlgorithm.HS256)
// HS256: mọi service đều biết secret key để VERIFY
// → Mọi service cũng có thể FORGE token của bất kỳ user nào
// → 1 service bị compromise = toàn hệ thống bị compromise
```

**RS256 (asymmetric):** Auth service giữ private key để ký. Các service khác chỉ có public key để verify — không thể forge dù có public key. Compromise 1 service không ảnh hưởng service khác.

### 6.7 [MAJOR] SSL Verification Bị Tắt

**Vị trí:** `RestTemplateConfig.java`

```java
SSLContext sslContext = SSLContexts.custom()
    .loadTrustMaterial(null, (chain, authType) -> true) // trust ALL certificates
    .build();
// TODO: remove this in production ← vẫn còn trong code production
```

Mở cửa hoàn toàn cho Man-in-the-Middle attack khi ECP gọi G2 Engine. Kẻ tấn công có thể intercept và modify PII data trên đường truyền.

### 6.8 [MAJOR] Kafka PLAINTEXT, Không Authentication

```java
// Kafka config — không có security.protocol, không có ssl.*, không có sasl.*
KAFKA_HOST = "10.6.8.37:9092"
```

Ai vào được network nội bộ có thể:
- Nghe lén file events (biết khi nào có file mới, file ở đâu)
- Inject message giả vào topic `file-events` hoặc `test` → Flink xử lý file không hợp lệ

**Cần:** Kafka SASL_SSL với SCRAM-SHA-512.

### 6.9 [MAJOR] Argon2d Sai Variant

**Vị trí:** `Argon2Utils.java`

```java
Argon2d argon2 = Argon2Factory.create(Argon2Factory.Argon2Types.ARGON2d);
// Argon2d: chống GPU attack tốt nhưng vulnerable với side-channel timing attack
// Hash output chỉ 16 bytes — quá ngắn
```

**Cần:** Argon2id (RFC 9106 khuyến nghị) — kết hợp cả GPU resistance và side-channel resistance. Output 32 bytes.

### 6.10 [MAJOR] Không Có Audit Trail Cho PII Access

Không có logging nào khi:
- PII được đọc từ database
- PII được gửi qua network
- Admin truy cập dữ liệu nhạy cảm

Vi phạm GDPR Art.30 (records of processing activities) và Nghị định 13/2023/NĐ-CP (yêu cầu nhật ký xử lý dữ liệu cá nhân).

### 6.11 [MAJOR] RSA Private Key Lưu Trong Database

**Vị trí:** `AuthUserBusiness.createAccount()`

```java
// Khi tạo tài khoản data_owner
entity.privateKey = Base64(privateKey);  // lưu thẳng vào PostgreSQL
entity.publicKey  = Base64(publicKey);
```

Private key của `data_owner` (đơn vị cung cấp dữ liệu) lưu dưới dạng Base64 trong PostgreSQL. Nếu DB bị lộ → private key bị lộ theo.

### 6.12 Bài Toán Security Giữa Các Node — Phân Tích và Giải Pháp

#### Mô Hình Mối Đe Dọa (Threat Model)

Pipeline ETL xử lý PII — dữ liệu định danh cá nhân như biển số, CMND, họ tên. Attacker có thể đến từ nhiều phía:

```
Threat 1 — Insider / compromised service:
  Một service bị compromise (malware, dependency injection)
  → Dùng quyền của service đó để gọi service khác
  → Inject pseudoId giả vào G3, làm sai dữ liệu trong ClickHouse
  → Đọc PII raw từ staging_pii mà không có quyền

Threat 2 — Network attacker (nội bộ):
  Ai đó có access vào LAN nội bộ (10.6.8.x)
  → Capture traffic HTTP → đọc PII plaintext
  → Replay request cũ → duplicate/sai dữ liệu
  → Inject request giả mạo G1 → G3 bypass toàn bộ pipeline

Threat 3 — MITM trên đường ECP → G2 Engine:
  SSL verification bị tắt → attacker intercept HTTPS
  → Thay thế pseudoId trong response → PII bị sai
  → Hoặc thu thập PII raw trước khi G2 Engine mã hóa
```

**Hiện trạng:** Cả 3 threat đều không có biện pháp phòng thủ.

---

#### Bài Toán Cần Giải

Có 4 call cần bảo vệ trong pipeline, mỗi call có đặc thù khác nhau:

```
[1] G1 (Flink) ──HTTP──▶ G2 (ECP)          PII raw — nhạy cảm nhất
[2] G2 (ECP)   ──HTTPS─▶ G2 Engine         PII raw — đang có TLS nhưng verify tắt
[3] G2 (ECP)   ──HTTP──▶ G3 (Audit)        pseudoId — đã qua mã hóa nhưng có thể bị tamper
[4] G1 (Flink) ──HTTP──▶ G3 (Audit)        NonPII — không có PII nhưng cần integrity
```

Yêu cầu cho mỗi call:
- **Confidentiality**: dữ liệu không bị đọc trộm trên đường truyền
- **Integrity**: dữ liệu không bị sửa mà receiver không phát hiện
- **Authentication**: receiver biết chắc caller là ai (G1 chứ không phải attacker)
- **Authorization**: G1 chỉ được gọi `/non-pii/push` và `/proxy/g2`, không được gọi `/admin/*`

---

#### Hai Lựa Chọn Kiến Trúc

**Lựa chọn A — JWT Service Account (RS256)**

Mỗi service được cấp 1 JWT service account token, ký bởi Auth service dùng RSA private key:

```
Auth Service giữ: RSA private key  (ký JWT)
G1, G2, G3 giữ:  RSA public key   (verify JWT)

Khi G1 gọi G2:
  G1 đính kèm JWT: { sub: "svc-flink", role: "INTERNAL_SERVICE", exp: ... }
  G2 verify JWT bằng public key → xác thực G1 là Flink, không phải attacker
  G2 check role: chỉ INTERNAL_SERVICE mới được POST /proxy/g2/process-data
```

Lý do dùng RS256 thay vì HS256: với HS256, mọi service đều biết secret để verify → cũng có thể dùng secret đó để **forge** token. Với RS256, chỉ Auth service có private key → compromise G2 hoặc G3 không thể tạo token giả mạo G1.

```java
// G1 (Flink) — đính kèm JWT vào mọi request nội bộ
RestTemplate restTemplate = new RestTemplate();
restTemplate.getInterceptors().add((request, body, execution) -> {
    request.getHeaders().setBearerAuth(serviceAccountToken);
    return execution.execute(request, body);
});

// G2 (ECP) — Spring Security config
@Bean
public SecurityFilterChain filterChain(HttpSecurity http) {
    http.authorizeRequests()
        .antMatchers("/proxy/g2/process-data")
            .hasRole("INTERNAL_SERVICE")   // chỉ service account mới vào được
        .anyRequest().denyAll();
    http.oauth2ResourceServer().jwt();     // verify JWT bằng public key
    return http.build();
}
```

**Lựa chọn B — mTLS (Mutual TLS)**

Thay vì JWT, mỗi service có TLS certificate riêng. Khi kết nối, cả 2 phía đều present certificate và verify lẫn nhau:

```
Certificate Authority (CA) nội bộ ký cert cho từng service:
  G1: CN=svc-flink,  issued by internal-CA
  G2: CN=svc-ecp,    issued by internal-CA
  G3: CN=svc-audit,  issued by internal-CA

Khi G1 kết nối G2:
  G2 verify cert của G1: "cert này do CA nội bộ ký, CN=svc-flink → đây là Flink"
  G1 verify cert của G2: "cert này do CA nội bộ ký, CN=svc-ecp → đây là ECP"
  → Mutual authentication, không cần JWT layer
```

**So sánh:**

| Tiêu chí | JWT RS256 | mTLS |
|----------|-----------|------|
| Độ phức tạp triển khai | Thấp — thêm JWT vào Spring Security | Cao — cần PKI nội bộ, cert rotation |
| Phù hợp môi trường | Bare-metal, VM | Kubernetes (Istio tự quản lý cert) |
| Rotation secret | Đổi keypair, deploy Auth service | Cert có TTL, tự expire |
| Overhead mỗi request | Parse + verify JWT (~1ms) | TLS handshake (1 lần/connection) |
| **Khuyến nghị** | **Dùng ngay với hạ tầng hiện tại** | Dùng khi lên K8s với Istio |

---

#### Giải Pháp Cụ Thể Cho Từng Call

**Call [1]: G1 → G2 — PII raw (nhạy cảm nhất)**

```
Vấn đề: HTTP plaintext + không auth → attacker đọc được PII, inject request giả

Giải pháp:
  Transport:      HTTPS (TLS 1.3) — G2 expose port 4000 với cert hợp lệ
  Authentication: G1 gửi JWT service account trong Authorization header
  Authorization:  G2 chỉ accept role=INTERNAL_SERVICE trên /proxy/g2/*
  Integrity:      TLS đảm bảo — không cần thêm lớp

Cấu hình G2 (ECP):
  server.ssl.enabled=true
  server.ssl.key-store=classpath:keystore.p12
  server.ssl.key-store-password=${SSL_KEYSTORE_PASSWORD}

Cấu hình G1 (Flink):
  RestTemplate với TrustStore chứa cert của G2
  + Bearer JWT service account
```

**Call [2]: G2 → G2 Engine — PII raw qua HTTPS (hiện tại verify tắt)**

```
Vấn đề: SSL verification bị tắt → MITM có thể intercept PII, thay pseudoId trong response

Giải pháp:
  Bỏ trust-all → load TrustStore chứa cert của G2 Engine (hoặc CA của họ)
  Pin certificate nếu G2 Engine dùng self-signed cert
  Kiểm tra CN/SAN của certificate khớp với hostname G2 Engine

// Thay thế RestTemplateConfig.java hiện tại
SSLContext sslContext = SSLContexts.custom()
    .loadTrustMaterial(trustStore, null)   // trust chỉ cert trong trustStore
    .build();
// Không dùng (chain, authType) -> true
```

**Call [3]: G2 → G3 — pseudoId**

```
Vấn đề: HTTP plaintext + không auth → attacker inject pseudoId giả vào G3
         → ClickHouse bị update với pseudoId sai → dữ liệu PII không đúng

Giải pháp:
  Transport:      HTTPS
  Authentication: JWT service account (G2 present token, G3 verify)
  Thêm request signing: G2 ký body bằng HMAC-SHA256 với shared secret
  G3 verify signature trước khi UPDATE ClickHouse

  // G2 ký body
  String signature = HMAC.sign(requestBody, internalSecret);
  headers.add("X-Signature", signature);

  // G3 verify
  if (!HMAC.verify(requestBody, signature, internalSecret)) {
      throw new SecurityException("Invalid request signature");
  }
```

**Call [4]: G1 → G3 — NonPII**

```
Vấn đề: Không auth → attacker INSERT dữ liệu giả vào ClickHouse

Giải pháp:
  Transport:      HTTPS
  Authentication: JWT service account
  Authorization:  G3 chỉ accept /non-pii/push từ role=INTERNAL_SERVICE
  (Ít nhạy cảm hơn NonPII nhưng vẫn cần integrity — sai NonPII làm hỏng analytics)
```

---

#### Thứ Tự Triển Khai

```
Bước 1 — Transport (ngay):
  Bật HTTPS cho G2 và G3
  Fix SSL verification trên ECP → G2 Engine
  → Giải quyết Confidentiality và Integrity cho tất cả 4 call

Bước 2 — Authentication (tuần 1):
  Auth service issue RSA keypair
  Mỗi service được cấp JWT service account với role INTERNAL_SERVICE
  G2, G3 thêm Spring Security JWT filter cho internal endpoints
  → Giải quyết Authentication

Bước 3 — Authorization (tuần 1, song song):
  G3: antMatchers("/api/pii/push").hasRole("INTERNAL_SERVICE")
  G3: antMatchers("/api/non-pii/push").hasRole("INTERNAL_SERVICE")
  G2: antMatchers("/proxy/g2/**").hasRole("INTERNAL_SERVICE")
  → Giải quyết Authorization

Bước 4 — Defense in depth (tháng 1):
  Request signing cho G2 → G3 (pseudoId write là thao tác nhạy cảm nhất)
  Kafka SASL_SSL
  Vault cho secret management

Bước 5 — Dài hạn (K8s):
  Istio mTLS strict mode — Bước 1-3 được xử lý tự động ở infrastructure level
  NetworkPolicy: G1 chỉ được kết nối G2 và G3, không được kết nối các service khác
```

### 6.13 [MAJOR] Nhiều Service Dùng Chung Database — Không Có Isolation

**Hiện trạng:**

```
Tất cả service kết nối vào cùng 1 PostgreSQL instance (10.6.8.37:5432/postgres)
với cùng 1 user credentials (admin / Gtel@123):

  ECP   → đọc/ghi staging_pii
  Audit → đọc/ghi staging_pii, staging_non_pii, simulation_run
  Admin → đọc/ghi datasets, schemas, simulation
  Flink → đọc pii_config, pii_field_config

Không có DB user riêng theo service.
Không có schema-level permission.
```

**Hệ quả:**

```
1. Lateral movement: ECP bị compromise → attacker có thể query
   bảng của Admin (datasets), bảng của Flink (pii_config)
   — dù ECP không có nghiệp vụ gì với các bảng đó.

2. Privilege escalation: credentials "admin/Gtel@123" hardcode trong source code
   → ai có repo là có full access toàn bộ database.

3. Blast radius: 1 service bị SQL injection → toàn bộ schema bị lộ,
   không phân vùng được thiệt hại.

4. Audit không khả thi: mọi query đều từ user "admin"
   → không phân biệt được service nào đã truy cập bảng nào.
```

**Cần — Nguyên tắc Least Privilege theo từng service:**

```sql
-- Mỗi service có DB user riêng, chỉ có quyền với bảng của mình

CREATE USER svc_ecp     WITH PASSWORD '...';
CREATE USER svc_audit   WITH PASSWORD '...';
CREATE USER svc_flink   WITH PASSWORD '...';
CREATE USER svc_admin   WITH PASSWORD '...';

-- ECP chỉ đọc/ghi staging_pii
GRANT SELECT, INSERT, UPDATE ON staging_pii TO svc_ecp;

-- Audit chỉ đọc/ghi staging_pii, staging_non_pii, simulation_run
GRANT SELECT, INSERT, UPDATE ON staging_pii, staging_non_pii, simulation_run TO svc_audit;

-- Flink chỉ đọc config
GRANT SELECT ON pii_config, pii_field_config TO svc_flink;

-- Admin không được đọc staging (PII raw data)
GRANT SELECT, INSERT, UPDATE, DELETE ON datasets, schemas, simulation TO svc_admin;
REVOKE ALL ON staging_pii FROM svc_admin;
```

**Nên tách schema theo service:**

```
postgres/
├── schema: auth        ← chỉ Auth service
├── schema: etl         ← staging_pii, staging_non_pii (ECP + Audit)
├── schema: business    ← datasets, schemas, simulation (Admin)
└── schema: config      ← pii_config, pii_field_config (Flink, read-only)
```

---

## 7. Đề Xuất Chuyển HTTP Sang Kafka

### 7.1 Tại Sao Nên Chuyển

**Vấn đề cốt lõi của HTTP trong pipeline hiện tại:**

HTTP là synchronous request-response — mỗi hop phải chờ hop trước hoàn thành. Trong pipeline 3-hop (Flink → ECP → G2 Engine → ECP → G3), latency cộng dồn và back-pressure truyền ngược:

```
Nếu ECP down:         Flink block → records tích lũy trong heap Flink → OOM
Nếu G3 down:         ECP block → Flink block — toàn bộ pipeline đứng
Nếu G2 Engine chậm: Flink task thread block, không xử lý record mới
```

Không có buffer layer — bất kỳ service nào chậm hoặc down đều kéo toàn bộ pipeline xuống theo.

### 7.2 Kiến Trúc Đề Xuất — Full Kafka

```
HIỆN TẠI:
File Watcher ──Kafka──▶ Flink ──HTTP──▶ ECP ──HTTPS──▶ G2 Engine
                              └──HTTP──▶ G3

ĐỀ XUẤT (nếu G2 Engine hỗ trợ Kafka):
File Watcher ──Kafka(file-events)──▶ Flink
                                       ├──Kafka(pii-requests)──▶ G2 Engine
                                       │                              └──Kafka(pii-results)──▶ G3
                                       └──Kafka(non-pii-events)──▶ G3
```

**ECP Proxy (ndip25.etl.ecp) có thể bị loại bỏ** — vai trò duy nhất của nó là làm adapter HTTP giữa Flink và G2 Engine. Nếu cả hai đều dùng Kafka, adapter không còn cần thiết.

### 7.3 Kafka Topics Cần Thêm

| Topic | Producer | Consumer | Nội dung |
|-------|----------|----------|---------|
| `file-events` | File Watcher | Flink | Đã có |
| `pii-requests` | Flink | G2 Engine | PII field cần de-identification |
| `pii-results` | G2 Engine | G3 Audit | pseudoId kết quả |
| `non-pii-events` | Flink | G3 Audit | NonPII data cần INSERT |
| `pii-dlq` | G2 Engine | Alert/Retry | Records lỗi sau max retry |

### 7.4 Điều Kiện Để Hoạt Động Đúng

**correlationId phải đi xuyên suốt:**
```json
// pii-requests (Flink publish)
{ "correlationId": "uuid-abc", "tableKey": "platform.violation",
  "fieldKey": "bienSo", "value": "51A-12345", "algorithm": "PSEUDONYMIZATION" }

// pii-results (G2 Engine publish)
{ "correlationId": "uuid-abc",   ← giữ nguyên
  "tableKey": "platform.violation", "fieldKey": "bienSo", "pseudoId": "hashed_x7k9m" }

// G3 nhận pii-results → ALTER TABLE UPDATE ... WHERE correlationId = 'uuid-abc'
```

**NonPII phải INSERT trước PII UPDATE:**
```
Flink gửi non-pii-events → G3 INSERT → row tồn tại trong ClickHouse
Flink gửi pii-requests → G2 Engine → pii-results → G3 UPDATE pseudoId
Thứ tự tự nhiên vì NonPII không cần G2 Engine nên luôn đến trước
```

**Idempotent processing tại G2 Engine:**
```
Kafka retry có thể gửi cùng 1 message 2 lần
G2 Engine phải check: correlationId này đã xử lý chưa?
Nếu rồi → trả lại kết quả cũ (không tạo pseudoId mới)
```

### 7.5 Lợi Ích Sau Khi Chuyển

```
Fault tolerance:
  Trước: ECP/G3 down → Flink bị block → pipeline đứng
  Sau:   G2 Engine/G3 down → messages queue trong Kafka
         Service restart → tự consume lại từ offset → không mất data

Throughput:
  Trước: Flink chờ từng round-trip HTTP
  Sau:   Flink publish liên tục không chờ → throughput tăng đáng kể

Scalability:
  Thêm Flink instance → chỉ cần tăng Kafka partition
  Thêm G2 Engine instance → cùng consumer group, tự load balance

Loại bỏ ECP Proxy:
  Giảm 1 service cần maintain, deploy, monitor
```

### 7.6 Đánh Đổi Cần Chấp Nhận

```
Latency tăng:
  HTTP: ~300ms end-to-end (nhưng blocking)
  Kafka: ~500ms-1s (nhưng non-blocking, throughput cao hơn)
  → Chấp nhận được nếu hệ thống không yêu cầu real-time millisecond

Phức tạp hơn:
  Thêm 4 Kafka topics cần manage
  G2 Engine phải implement Kafka consumer + producer
  Cần xử lý ordering, idempotency, DLQ

Staging table vẫn cần:
  Để monitor trạng thái: bao nhiêu records đang WAITING trong G2 Engine
  Alert nếu WAITING quá lâu → G2 Engine có vấn đề
```

### 7.7 Kafka vs HTTP — So Sánh Bảo Mật

#### So Sánh Mặc Định (Không Cấu Hình Security)

```
HTTP mặc định:   Plaintext, không auth    → không bảo mật
Kafka mặc định:  PLAINTEXT, không auth    → không bảo mật

Cả hai đều không an toàn nếu không cấu hình thêm.
Hiện tại NDIP dùng cả hai đều ở trạng thái mặc định → không có gì bảo vệ.
```

#### Khi Được Cấu Hình Đúng

**HTTP với TLS + JWT:**
```
Transport:      HTTPS (TLS 1.3) — mã hóa dữ liệu trên đường truyền
Authentication: JWT Bearer token — xác thực caller
Authorization:  Role-based endpoint access
Data lifetime:  Dữ liệu chỉ tồn tại trong transit — không lưu ở đâu
```

**Kafka với SASL_SSL + ACLs:**
```
Transport:      TLS — mã hóa dữ liệu trên đường truyền
Authentication: SASL SCRAM-SHA-512 — xác thực producer/consumer
Authorization:  Kafka ACLs — topic-level access control
Data lifetime:  Dữ liệu LƯU TRÊN BROKER theo retention period
```

#### Điểm Khác Biệt Quan Trọng Nhất — Data Persistence

Đây là điểm khác biệt lớn nhất về security giữa hai giao thức:

```
HTTP:
  Flink gửi PII → ECP nhận → xử lý xong → dữ liệu biến mất
  PII chỉ tồn tại trong memory trong thời gian request

Kafka:
  Flink gửi PII → Kafka BROKER LƯU XUỐNG DISK
  Message tồn tại trong broker: mặc định 7 ngày (log.retention.hours=168)
  Trong 7 ngày: bất kỳ consumer group mới nào cũng có thể đọc lại toàn bộ PII
```

**Hệ quả với dữ liệu PII:**

| Tình huống | HTTP | Kafka |
|-----------|------|-------|
| Broker/Server bị hack | PII không còn trên server | PII vẫn còn trong broker logs |
| Thêm consumer group mới | Không ảnh hưởng | Có thể đọc lại toàn bộ PII cũ |
| Audit trail | Cần log riêng | Built-in offset tracking |
| Data retention | Không có (transient) | Có — cần set retention ngắn cho PII |
| Encryption at-rest | Không cần (không lưu) | Bắt buộc nếu dùng cho PII |

#### Rủi Ro Đặc Thù Khi Dùng Kafka Cho PII

**Rủi ro 1 — Broker storage:**
```
Kafka lưu message dưới dạng log file trên disk.
Nếu không encrypt at-rest:
  /var/kafka/pii-requests-0/00000000000000000000.log
  → Đọc file này → lấy được toàn bộ PII plaintext
```

**Rủi ro 2 — Consumer group không kiểm soát:**
```
Kafka ACLs cần được cấu hình chặt:
  Chỉ G2 Engine được phép consume pii-requests
  Chỉ G3 được phép consume pii-results
  KHÔNG có wildcard consumer

Nếu ACL lỏng → bất kỳ service mới nào join cluster cũng có thể đọc PII
```

**Rủi ro 3 — Replay attack:**
```
Kafka cho phép seek offset về bất kỳ thời điểm nào.
Attacker có quyền admin trên Kafka cluster:
  → Reset consumer offset về 0
  → Đọc lại toàn bộ PII từ đầu
```

#### Điều Kiện Để Kafka An Toàn Cho PII

Nếu quyết định dùng Kafka cho PII data, **bắt buộc** phải có:

```
1. TLS encryption in-transit (SASL_SSL)
   security.protocol=SASL_SSL
   ssl.truststore.location=...

2. Encryption at-rest trên broker
   Kafka không có built-in → dùng disk encryption (LUKS) hoặc
   encrypt payload trước khi publish (AES-256-GCM)

3. ACL chặt chẽ
   Chỉ Flink được produce vào pii-requests
   Chỉ G2 Engine được consume từ pii-requests
   Chỉ G2 Engine được produce vào pii-results
   Chỉ G3 được consume từ pii-results

4. Retention ngắn cho PII topic
   log.retention.hours=1  (xóa message sau 1 giờ)
   Đủ thời gian để G2 Engine xử lý, không giữ PII lâu trên disk

5. Payload encryption (defense-in-depth)
   Encrypt PII payload bằng AES-256-GCM trước khi publish
   Dù broker bị hack → chỉ lấy được ciphertext
```

#### Kết Luận So Sánh

```
Câu hỏi: Cái nào bảo mật hơn?
Trả lời: Phụ thuộc vào cấu hình, không phải giao thức.

HTTP (HTTPS + JWT):
  ✅ Đơn giản hơn để secure đúng cách
  ✅ PII không persist — không có attack surface từ storage
  ✅ Point-to-point — không ai khác đọc được
  ❌ Tight coupling, cascade failure

Kafka (SASL_SSL + ACL + encrypt at-rest):
  ✅ Fault tolerant, decoupled
  ✅ Audit trail built-in
  ❌ PII persist trên broker — attack surface lớn hơn
  ❌ Phức tạp hơn để cấu hình đúng
  ❌ Cần encrypt payload thêm 1 lớp (defense-in-depth)

Với dữ liệu PII đặc thù:
  HTTP có lợi thế tự nhiên hơn vì data không persist.
  Kafka có thể đạt mức bảo mật tương đương nhưng đòi hỏi nhiều cấu hình hơn
  (retention ngắn + at-rest encryption + ACL chặt + payload encryption).
```

---
