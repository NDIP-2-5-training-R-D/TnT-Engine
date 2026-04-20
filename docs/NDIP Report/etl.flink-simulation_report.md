# Báo cáo phân tích: `ndip25.etl.flink` & `ndip25.etl.flink-simulation`

> **Ngày:** 2026-04-15
> **Module:** `ndip25.etl.flink` — Production ETL Pipeline | `ndip25.etl.flink-simulation` — Simulation ETL Pipeline

---

## 1. Tổng quan

Hai module này đều là **Apache Flink streaming job** — đọc message từ Kafka, parse file XML, phân loại PII/NonPII, rồi gửi dữ liệu đến các service xử lý tiếp theo. Điểm khác biệt cốt lõi là **mục đích sử dụng**:

| Thông tin | `flink` (Production) | `flink-simulation` (Sandbox) |
|---|---|---|
| **Vai trò** | ETL pipeline dữ liệu thật từ `data_owner` | ETL pipeline dữ liệu mẫu do admin upload |
| **Kafka topic** | `file-events` | `test` |
| **Trigger** | `file-watcher` phát hiện file mới trên disk | Admin gọi `POST /simulations/upload-sample` |
| **Output Tuple** | `Tuple12` — 12 bảng giao thông riêng biệt | `Tuple2` — NonPii list + G2 list |
| **Sink đích** | Gọi audit `/non-pii/push` (production) | Gọi `/push-simulation` + `/process-data-simulation` |
| **PII Config** | Load toàn bộ config (không lọc dataset) | Load config theo `datasetId` cụ thể |
| **Checkpoint** | 15s, EXACTLY_ONCE | 15s, EXACTLY_ONCE |
| **Parallelism per sink** | 2 | 2 |

---

## 2. Kiến trúc pipeline

### 2.1 flink (Production)

```
Kafka "file-events"
  │  message = JSON { filePath, source }
  ▼
MinioXmlFetcher           ← parse JSON → lấy filePath + source từ message
  │  FileContentDto
  ▼
FullXmlParser             ← đọc file XML từ disk → parse thành PhuongTienTongHop
  │  FileContentGdDto
  ▼
PatientCheckinExtractor   ← map từng trường XML → 12 DTO cụ thể + G2RequestDto list
  │  Tuple12<PointsDTO, AccidentDTO, ViolationDTO, List<G2RequestDto>,
  │          TrafficFineDTO, VehicleRegistrationDTO, VehicleInspectationDTO,
  │          VehicleInsuranceDTO, ViolationPenaltyDTO, DriverLicenseDTO,
  │          RoadInfraDTO, TrafficStatusDTO>
  ▼
processStreams()
  ├── PointSink            → /api/non-pii/push (audit)
  ├── AccidentSink         → /api/non-pii/push
  ├── ViolationSink        → /api/non-pii/push
  ├── TrafficFineSink      → /api/non-pii/push
  ├── VehicleRegistrationSink → /api/non-pii/push
  ├── VehicleInspectationSink → /api/non-pii/push
  ├── VehicleInsuranceSink → /api/non-pii/push
  ├── ViolationPenaltySink → /api/non-pii/push
  ├── DriverLicenseSink    → /api/non-pii/push
  ├── RoadInfraSink        → /api/non-pii/push
  ├── TrafficStatusSink    → /api/non-pii/push
  └── G2Sink               → /proxy/g2/process-data (ECP — de-identification PII)
```

### 2.2 flink-simulation (Sandbox)

```
Kafka "test"
  │  message = uploadId (UUID string)
  ▼
MinioXmlFetcher           ← query PostgreSQL common.simulation_run by uploadId
  │                          → lấy filePath, datasetId, schemaVersionId
  │                          → UPDATE status = 'Processing'
  │  FileContentDto (có thêm uploadId, datasetId, schemaVersionId)
  ▼
FullXmlParser             ← đọc file XML từ disk → parse thành BookstoresDto (generic)
  │  FileContentGdDto (có thêm uploadId, datasetId, schemaVersionId)
  ▼
PatientCheckinExtractor   ← load PII config theo datasetId
  │                          → FlattenUtil.flatten() toàn bộ XML
  │                          → tách PII fields / NonPII fields động
  │  Tuple2<List<NonPiiRq>, List<G2RequestDto>>
  ▼
processStreams()
  ├── NonPiiSink  → /api/non-pii/push-simulation (audit simulation)
  └── G2Sink      → /proxy/g2/process-data-simulation (ECP simulation)
```

---

## 3. Phân tích chi tiết từng file

### 3.1 `MinioXmlFetcher.java` — Bước 1: Lấy thông tin file từ message

**flink (production):**
```java
// Message Kafka là JSON string
JSONObject json = new JSONObject(objectKey);
String filePathRp = json.optString("filePath", null);
String sourceRp = json.optString("source", null);
// Chỉ cần filePath và source — không cần DB
String filePath = filePathRp.replace("/ndip", "");
```

**flink-simulation:**
```java
// Message Kafka là UUID string của uploadId
UUID uuid = UUID.fromString(objectKey);

// Query PostgreSQL để lấy thông tin
String sql = "SELECT sr.id, sr.dataset_id, sr.schema_version_id, sr.sample_file_path, sr.status
              FROM common.simulation_run sr WHERE id = ? AND status = 'Pending'";

// Update trạng thái ngay sau khi nhận
"UPDATE common.simulation_run SET status = 'Processing' WHERE id = ? AND status = 'Pending'"

// Trả về FileContentDto có thêm uploadId, datasetId, schemaVersionId
```

**Điểm khác biệt quan trọng:** Simulation dùng PostgreSQL làm trung gian để lưu trạng thái xử lý (`Pending → Processing`), giúp admin biết file đang được xử lý. Production không cần vì file-watcher đã quản lý.

---

### 3.2 `FullXmlParser.java` — Bước 2: Parse XML thành POJO

**flink (production):**
```java
// Parse vào class cố định theo domain giao thông
if (source.contains("C08")) {
    phuongTienTongHop = xmlMapper.readValue(path.toFile(), PhuongTienTongHop.class);
} else {
    logger.error("Không có Source {}", source); return; // bỏ qua source không biết
}
// Không truyền uploadId/datasetId downstream
```

**flink-simulation:**
```java
// Parse vào class generic BookstoresDto (không phụ thuộc domain)
bookstoresDto = xmlMapper.readValue(path.toFile(), BookstoresDto.class);

// Truyền thêm metadata downstream
out.collect(FileContentGdDto.builder()
    .content(bookstoresDto)
    .uploadId(json.getUploadId())
    .schemaVersionId(json.getSchemaVersionId())
    .datasetId(json.getDatasetId())
    .build());
```

**Điểm khác biệt quan trọng:** Production parse XML vào struct cứng `PhuongTienTongHop` (domain-specific), simulation parse vào `BookstoresDto` (generic) và truyền metadata để downstream biết context.

---

### 3.3 `PiiConfigLoader.java` — Load cấu hình PII

**flink (production):**
```java
// Load() — không tham số, lấy toàn bộ PII config của hệ thống
public static Map<String, List<String>> load() {
    String sql = ClickHouseSql.DB.GET_FIELDS_CONFIG; // SQL cố định trong constant
    // Trả về: { "1": [algorithm, xml_fields, fieldName, param, algorithmType, use_case] }
}
// Gọi 1 lần trong open() — dùng chung cho mọi file
```

**flink-simulation:**
```java
// load(datasetId) — lọc theo dataset cụ thể
public static Map<String, List<String>> load(String datasetId) {
    String sql = "SELECT sf.fields, dc.algorithm, dc.parameters
                  FROM common.schema_field sf
                  JOIN common.dataset_schema_version dsv ON ...
                  JOIN common.dataset dt ON dt.id = dsv.dataset_id
                  JOIN common.deid_config dc ON dc.id = sf.deid_config_id
                  WHERE dt.id = '" + datasetId + "'
                    AND dsv.status = 'Active'
                    AND sf.classification = 'PII'";
    // Trả về: { "1": [algorithm, fieldName, param] }
}
// Gọi mỗi file — mỗi file có thể thuộc dataset khác nhau
```

> **Lỗ hổng bảo mật (SQL Injection):** `flink-simulation/PiiConfigLoader` concatenate `datasetId` trực tiếp vào SQL string. Nếu `datasetId` được kiểm soát bởi input người dùng và không được validate kỹ, đây là lỗ hổng SQL injection. Mặc dù UUID format khó exploit, nên dùng PreparedStatement với `?` placeholder.

---

### 3.4 `PatientCheckinExtractor.java` — Bước 3: Phân loại PII/NonPII

**flink (production):**
- Output: `Tuple12` — map cứng từng trường XML vào đúng DTO (`ViolationDTO.violatorName`, `AccidentDTO.plateNumber`...)
- Kết nối **ClickHouse** để đọc config (không phải PostgreSQL)
- Load PII config 1 lần trong `open()` — toàn bộ hệ thống
- Logic mapping tường minh, từng field được gán đúng bảng

**flink-simulation:**
- Output: `Tuple2<List<NonPiiRq>, List<G2RequestDto>>` — generic, không phụ thuộc schema
- Kết nối **PostgreSQL** để đọc config theo datasetId
- Load PII config mỗi file trong `flatMap()` — theo từng dataset
- Dùng `FlattenUtil.flatten()` để flat toàn bộ XML thành `Map<String, Object>`
- Tách PII/NonPII động dựa trên config
- Table PII hardcode: `"platform.simulation"` cho mọi PII field
- **snakeToCamel()** để convert field name từ DB sang camelCase khi so sánh với XML

---

### 3.5 Sink — Bước 4: Gửi dữ liệu đến đích

**flink (production) — ViolationSink (đại diện cho 11 sink bảng):**
```java
// Gọi ApiClient.pushNonPii() — gửi đến audit production
String json = objectMapper.writeValueAsString(reg);
String base64Encoded = Base64.getEncoder().encodeToString(json.getBytes());
ApiClient.pushNonPii("platform.violation", reg.getRecordId(), base64Encoded);
// URL đích: http://10.6.8.37:5001/api/non-pii/push
```

**flink-simulation — NonPiiSink:**
```java
// Gọi audit simulation endpoint
String url = Contants.Url.G3NonPiiSimulation; // /api/non-pii/push-simulation
String json = objectMapper.writeValueAsString(currentBatch);
String base64Encoded = Base64.getEncoder().encodeToString(json.getBytes());
// Wrap vào {"data": "<base64>"} rồi POST
```

**Cả hai Sink đều dùng cùng pattern:**
- Batch trong memory (`List<T>`)
- Flush khi đủ `batchSize = 1000` hoặc mỗi `flushInterval = 5000ms`
- `ScheduledExecutorService` cho periodic flush
- `synchronized(batch)` để thread-safe
- Flush nốt khi `close()` (graceful shutdown)

---

## 4. So sánh tổng thể code flink vs flink-simulation

| File | flink (Production) | flink-simulation | Giống nhau? |
|---|---|---|---|
| `App.java` | Tuple12, topic `file-events` | Tuple2, topic `test` | Cấu trúc tương tự, khác output type |
| `MinioXmlFetcher.java` | Parse JSON message | Query PostgreSQL by uploadId | **Khác hoàn toàn** |
| `FullXmlParser.java` | Parse → `PhuongTienTongHop` | Parse → `BookstoresDto` | Cấu trúc giống, DTO khác |
| `PatientCheckinExtractor.java` | Tuple12, mapping cứng 12 bảng | Tuple2, tách PII/NonPII động | **Khác hoàn toàn** |
| `PiiConfigLoader.java` | `load()` — toàn bộ hệ thống | `load(datasetId)` — theo dataset | Khác signature và SQL |
| `Sink (ClickHouse*)` | 12 sink riêng → audit `/push` | 2 sink → `/push-simulation` | Cùng batch pattern, khác URL |
| `Contants.java` | URL production | URL simulation + credentials hardcode | **Khác** |
| `DTO (Thong tin*.java)` | Giống nhau hoàn toàn | Giống nhau hoàn toàn | **Giống 100%** |
| `FlattenUtil.java` | Giống nhau | Giống nhau | **Giống 100%** |

**Kết luận:** ~40% code là duplicate (DTO, utils), ~60% là logic khác nhau có chủ đích.

---

## 5. Luồng dữ liệu đầy đủ

### Production
```
data_owner gửi file XML
  → POST /api/file/upload (bussiness.admin)
  → lưu file vào disk /upload/{sourceCode}/
  → ndip25.etl.file-watcher phát hiện
  → publish Kafka "file-events": { filePath, source }
  → flink đọc → parse → phân loại
  → 12 Sink → ApiClient.pushNonPii() → /api/non-pii/push (ndip25.etl.audit)
  → audit insert vào ClickHouse platform.*
  → G2Sink → /proxy/g2/process-data (ndip25.etl.ecp)
  → ECP de-identify → gọi lại audit /api/pii/push
  → audit UPDATE pseudo_id vào ClickHouse
```

### Simulation
```
admin upload XML mẫu
  → POST /api/v1/simulations/upload-sample (bussiness.admin)
  → validate schema fields
  → lưu SimulationRun (status=Pending) vào PostgreSQL
  → publish Kafka "test": uploadId
  → flink-simulation đọc uploadId
  → MinioXmlFetcher query PostgreSQL → lấy filePath, UPDATE status=Processing
  → FullXmlParser parse XML
  → PatientCheckinExtractor tách PII/NonPII theo datasetId
  → NonPiiSink → /api/non-pii/push-simulation (ndip25.etl.audit)
  → audit lưu vào ClickHouse bảng simulation
  → G2Sink → /proxy/g2/process-data-simulation (ndip25.etl.ecp)
  → ECP de-identify simulation
  → admin gọi GET /simulations/preview/{uploadId} → ClickHouseSimulationMapper
  → admin gọi GET /simulations/risk-analysis/{uploadId} → K-Anonymity, Singling Out
```

---

## 6. Vấn đề đã phát hiện

### 6.1 SQL Injection trong PiiConfigLoader (flink-simulation)
```java
// Nguy cơ SQL injection — nên dùng PreparedStatement
String sql = "... WHERE dt.id = '" + datasetId + "' ...";
// Sửa: dùng ? placeholder
preparedStatement.setObject(1, UUID.fromString(datasetId));
```

### 6.2 Kafka topic hardcode là "test" (flink-simulation)
```java
// Contants.java
public static String KAFKA_TOPIC = "test";
// Tên topic không phản ánh đúng chức năng, dễ nhầm với môi trường test
// Nên đổi thành: "simulation-events"
```

### 6.3 Credentials hardcode trong Contants.java (flink-simulation)
```java
public static String CLICK_URL = "jdbc:clickhouse://10.6.8.37:1812/default";
public static String CLICK_USER = "admin";
public static String CLICK_PASS = "Gtel@123";  // hardcode password
// flink production đọc từ env var (an toàn hơn)
// flink-simulation nên làm tương tự
```

### 6.4 Không có status cập nhật khi flink xong (flink-simulation)
```java
// MinioXmlFetcher UPDATE status = 'Processing' khi bắt đầu
// Nhưng không có UPDATE status = 'Done'/'Failed' khi kết thúc
// Admin không biết khi nào poll kết quả là hợp lệ
```

### 6.5 PiiConfigLoader gọi DB mỗi file (flink-simulation)
```java
// Trong PatientCheckinExtractor.flatMap():
Map<String, List<String>> fieldToPiiKeyMap = PiiConfigLoader.load(fileContentGdDto.getDatasetId());
// Mỗi file → 1 DB query → không cache
// Nên cache theo datasetId hoặc load trong open()
```

### 6.6 flink (production) kết nối ClickHouse để load PII config
```java
// PatientCheckinExtractor.open():
connection = DriverManager.getConnection(CLICK_URL, CLICK_USER, CLICK_PASS); // ClickHouse
fieldToPiiKeyMap = PiiConfigLoader.load(); // đọc từ PostgreSQL trong PiiConfigLoader
// Kết nối ClickHouse mở nhưng không dùng trong PatientCheckinExtractor
```

---

## 7. Thiết kế đáng chú ý

### 7.1 Batch Sink với dual flush trigger
Cả hai module đều dùng pattern:
```java
// Flush khi đủ batch
if (batch.size() >= batchSize) flushBatch();

// Flush định kỳ kể cả khi chưa đủ batch
scheduler.scheduleAtFixedRate(this::flushBatch, flushInterval, flushInterval, MILLISECONDS);

// Flush nốt khi shutdown
public void close() { flushBatch(); }
```
Đảm bảo không bị mất dữ liệu dù traffic thấp (periodic flush) hay cao (size-based flush).

### 7.2 EXACTLY_ONCE checkpoint
```java
env.enableCheckpointing(15000L, CheckpointingMode.EXACTLY_ONCE);
```
Flink checkpoint mỗi 15 giây — nếu job crash, recover từ checkpoint gần nhất, không xử lý lại dữ liệu đã commit.

### 7.3 flink-simulation dùng PostgreSQL để track trạng thái
Simulation dùng bảng `common.simulation_run` như một **state machine**: `Pending → Processing → (Done/Failed chưa implement)`. Đây là thiết kế đúng hướng — phân biệt được file đang chờ, đang xử lý, hoặc đã xong.
