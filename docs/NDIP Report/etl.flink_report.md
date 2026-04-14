# Báo cáo phân tích: `ndip25.etl.flink`

> **Ngày:** 2026-04-14
> **Module:** `ndip25.etl.flink` — Stream Processing Service cho hệ thống NDIP25

---

## 1. Tổng quan

`ndip25.etl.flink` là **service xử lý luồng dữ liệu trung tâm** — consume event từ Kafka, đọc file XML từ filesystem, parse ra POJO, tách PII/NonPII, sau đó gửi PII đến ECP (G2 Engine pseudonymization) và NonPII đến Audit service để insert vào ClickHouse.

| Thông tin | Chi tiết |
|---|---|
| **Vai trò** | Core ETL — xử lý và phân luồng dữ liệu XML |
| **Input** | Kafka topic `file-events` (từ `ndip25.etl.file-watcher`) |
| **Output PII** | HTTP POST → `ndip25.etl.ecp` (G2 pseudonymization) |
| **Output NonPII** | HTTP POST → `ndip25.etl.audit` (ClickHouse insert) |

**Build:** Maven | **Java:** 17 | **Version:** 1.0.0
**Framework:** Apache Flink 1.17.1 (không có Spring, không có web server)

Để build và chạy:
```bash
mvn clean package -DskipTests
flink run -c App target/*.jar
# hoặc standalone:
java -jar target/*.jar
```

---

## 2. Phân lớp kiến trúc

```
ndip25.etl.flink/
│
├── App.java                              ← Flink entry point, pipeline setup
│
├── servicve/                             ← (typo của "service") Logic xử lý chính
│   ├── MinioXmlFetcher.java              ← Stage 1: parse Kafka JSON → FileContentDto
│   ├── FullXmlParser.java                ← Stage 2: đọc file XML → POJO
│   ├── PatientCheckinExtractor.java      ← Stage 3: flatten + tách PII/NonPII → Tuple12
│   └── clickhouse/                       ← 12 Sink classes
│       ├── G2Sink.java                   ← PII sink: batch → HTTP → ECP
│       ├── ViolationSink.java            ← NonPII sink: batch → HTTP → Audit
│       └── ... (10 sink khác tương tự)
│
├── constant/                             ← Hằng số, enum, HTTP client, factory
│   ├── Contants.java                     ← URLs, Kafka config, tên bảng ClickHouse
│   ├── Enums.java                        ← Log message templates
│   ├── ApiClient.java                    ← Static HTTP client (gọi Audit/ECP)
│   └── ObjectMapperFactory.java          ← Tạo Jackson ObjectMapper chuẩn
│
├── config/                               ← Load cấu hình từ DB
│   └── PiiConfigLoader.java              ← Query PostgreSQL lấy danh sách PII fields
│
├── enums/                                ← Ánh xạ tên field JSON cho từng bảng
│   ├── ViolationJsonKey.java             ← key mapping cho platform.violation
│   ├── AccidentJsonKey.java              ← key mapping cho platform.accident
│   └── ... (7 enum khác)
│
├── dtos/                                 ← Data Transfer Objects (4 nhóm)
│   ├── (root) PhuongTienTongHop.java     ← XML root POJO
│   ├── (root) ViPham.java, ...           ← Các XML node POJO
│   ├── database/                         ← Shape của 11 bảng ClickHouse
│   │   ├── ViolationDTO.java
│   │   └── ... (10 DTO khác)
│   ├── pii/                              ← Request/Response cho G2 path
│   │   ├── G2RequestDto.java
│   │   ├── PiiPayLoad.java
│   │   ├── PiiConfig.java
│   │   └── ...
│   └── nonPii/                           ← Request cho Audit path
│       ├── DataNonPiiRqDto.java
│       └── NonPiiGroup.java
│
└── ultis/                                ← Helper functions
    ├── FlattenUtil.java                  ← Recursive POJO → flat Map (dot-notation)
    ├── JdbcBindUtils.java                ← Null-safe bind cho PreparedStatement
    ├── JsonNodeUtils.java                ← Đọc field từ JsonNode, trả null nếu thiếu
    ├── ParseUtils.java                   ← Parse JsonNode → BigDecimal/Long/Integer
    ├── JsonUtils.java                    ← Serialize/deserialize JSON wrapper
    └── sql/ClickHouseSql.java            ← Tất cả INSERT SQL cho 11 bảng
```

Không phụ thuộc vào `ndip25.api.common`. Toàn bộ config qua biến môi trường hoặc hardcode trong `Contants.java`.

---

## 2.1 Vai trò từng package

### `constant/`
Chứa các giá trị cố định và tiện ích cấp thấp dùng toàn project:

| File | Nhiệm vụ |
|---|---|
| `Contants.java` | URLs endpoint, Kafka host/topic, tên 11 bảng ClickHouse |
| `Enums.java` | Log message template — dùng `logger.info(Enums.INSERT_SUCCESS.getMessage(), ...)` thay vì string literal |
| `ApiClient.java` | Static HTTP client — gọi `pushNonPii()` đến Audit service. Dùng `static` vì Flink tạo Sink bằng serialization, không qua Spring IoC |
| `ObjectMapperFactory.java` | Factory tạo `ObjectMapper` chuẩn — tránh `new ObjectMapper()` rải rác nhiều nơi |

### `config/`
Load cấu hình nghiệp vụ từ PostgreSQL một lần khi khởi động:

```java
// PiiConfigLoader.load() → Map<String, PiiConfig>
// { "bienSo" → {algo: "PSEUDONYMIZATION", useCase: "VEHICLE", ...} }
```

Kết nối qua biến môi trường: `PSQL_URL`, `PSQL_USER`, `PSQL_PASS`.

### `enums/`
Mỗi enum chứa danh sách **tên key JSON** tương ứng với 1 bảng, tránh dùng string literal trực tiếp:

```java
// Thay vì: node.get("ma_don_vi_csgt")
// Dùng:    node.get(ViolationJsonKey.POLICE_UNIT_CODE.key())
ViolationJsonKey.POLICE_UNIT_CODE  → "ma_don_vi_csgt"
ViolationJsonKey.LICENSE_PLATE_COLOR → "mau_bien"
ViolationJsonKey.INCIDENT_CODE     → "ma_vu_viec"
```

Giảm typo, IDE gợi ý, dễ refactor khi tên key thay đổi.

### `dtos/`
**DTO = Data Transfer Object** — class chỉ chứa data (fields + getter/setter), không có logic. Chia 4 nhóm:

| Nhóm | Vị trí | Mục đích |
|---|---|---|
| **XML POJOs** | `dtos/` root | Ánh xạ cấu trúc file XML — `XmlMapper` tự điền khi parse |
| **Database DTOs** | `dtos/database/` | Shape của từng bảng ClickHouse — 1 DTO = 1 bảng |
| **PII DTOs** | `dtos/pii/` | Format request body gửi ECP (`PiiPayLoad`, `G2RequestDto`, ...) |
| **NonPII DTOs** | `dtos/nonPii/` | Format request body gửi Audit (`NonPiiRequestDto`, `DataNonPiiRqDto`, ...) |

### `ultis/`
Helper functions tái sử dụng:

| File | Nhiệm vụ |
|---|---|
| `FlattenUtil.java` | Đệ quy POJO → `Map<String, Object>` dạng dot-notation (`"violation.bienSo"`) |
| `JdbcBindUtils.java` | Bind giá trị vào `PreparedStatement` an toàn (null → `setNull` đúng type thay vì NPE) |
| `JsonNodeUtils.java` | Đọc field từ `JsonNode` theo path, trả `null` thay vì throw nếu không tìm thấy |
| `ParseUtils.java` | Parse string số có ký tự lạ → `BigDecimal/Long/Integer`, không throw để tránh crash Flink |
| `ClickHouseSql.java` | Tập trung toàn bộ câu INSERT SQL — không rải SQL trong sink classes |

---

## 3. Cấu hình (`Contants.java`)

```java
public class Keys {
    public static final String CO8_FILE = "C08";      // Filter source name
}

public class Url {
    public static final String G3NonPii       = "http://10.6.8.37:5001/api/non-pii/push";
    public static final String G2_ECP_Pii     = "http://10.6.8.37:4000/proxy/g2/process-data";
}

public class Connect {
    public static final String KAFKA_HOST     = "10.6.8.37:9092";
    public static final String KAFKA_TOPIC    = "file-events";
    public static final String KAFKA_GROUP    = "file-events";
}

public class DB {
    // 11 tên bảng ClickHouse: platform.violation, platform.vehicle, ...
}
```

**Cấu hình DB qua biến môi trường** (trong `PiiConfigLoader.java`):
```
POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASS
CH_HOST, CH_PORT, CH_DB, CH_USER, CH_PASS
```

---

## 4. Pipeline chính (`App.java`)

### 4.1 Khởi tạo Flink environment

```java
StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();

// Exactly-once checkpointing mỗi 15 giây
env.enableCheckpointing(15000);
env.getCheckpointConfig().setCheckpointingMode(CheckpointingMode.EXACTLY_ONCE);
```

### 4.2 Kafka Source

```java
KafkaSource<String> source = KafkaSource.<String>builder()
    .setBootstrapServers(Connect.KAFKA_HOST)     // "10.6.8.37:9092"
    .setTopics(Connect.KAFKA_TOPIC)              // "file-events"
    .setGroupId(Connect.KAFKA_GROUP)             // "file-events"
    .setStartingOffsets(OffsetsInitializer.latest())
    .setValueOnlyDeserializer(new SimpleStringSchema())
    .build();

DataStream<String> rawStream = env.fromSource(source, WatermarkStrategy.noWatermarks(), "Kafka Source");
```

`latest()` offset → bỏ qua message cũ khi restart, chỉ đọc message mới.

### 4.3 Ba giai đoạn transformation

```java
DataStream<FileContentDto>   stage1 = rawStream.flatMap(new MinioXmlFetcher());
DataStream<FileContentGdDto> stage2 = stage1.flatMap(new FullXmlParser());
DataStream<Tuple12<...>>     stage3 = stage2.flatMap(new PatientCheckinExtractor());
```

Dùng `flatMap` thay `map` vì mỗi stage có thể emit 0 phần tử (skip record lỗi).

### 4.4 Split Tuple12 → 12 DataStreams + 12 Sinks

```java
processStreams(stage3, env);

// Bên trong processStreams():
DataStream<ViolationDTO> violationStream = stage3.map(t -> t.f0);
violationStream.addSink(new ViolationSink(1000, 5000)).setParallelism(2);

DataStream<PiiPayload> piiStream = stage3.map(t -> t.f11);
piiStream.addSink(new G2Sink(1000, 5000)).setParallelism(2);

// ... 10 stream NonPII khác tương tự
```

Mỗi sink: `batchSize=1000`, `flushInterval=5000ms`, `parallelism=2`.

---

## 5. Các thành phần chính

### 5.1 `MinioXmlFetcher` — Stage 1

`RichFlatMapFunction<String, FileContentDto>`

```java
// Input: JSON string từ Kafka
{
  "filePath": "C:\\ndip\\data\\CO8\\data_20260414.xml",
  "source":   "CO8"
}

// Xử lý:
1. ObjectMapper.readTree(jsonString)
2. Lấy filePath, source
3. Nếu filePath bắt đầu "/ndip" → strip prefix (Linux mount path)
4. Emit FileContentDto { filePath, source }
```

Nếu JSON parse lỗi → emit 0 phần tử (record bị skip, Flink tiếp tục).

---

### 5.2 `FullXmlParser` — Stage 2

`RichFlatMapFunction<FileContentDto, FileContentGdDto>`

```java
// Xử lý:
1. Kiểm tra file tồn tại + có thể đọc
2. Lọc: if (!source.contains("C08")) → skip
3. XmlMapper.readValue(file, PhuongTienTongHop.class)  ← Jackson XML
4. Emit FileContentGdDto { pojo, source, filePath }
```

`PhuongTienTongHop` là POJO ánh xạ toàn bộ cấu trúc XML (phương tiện, vi phạm, hành khách, ...).

**Chú ý:** Filter dùng `"C08"` (số 0), trong khi file-watcher extract source là `"CO8"` (chữ O) — xem mục 8 về điểm bất thường.

---

### 5.3 `PatientCheckinExtractor` — Stage 3 (phức tạp nhất)

`RichFlatMapFunction<FileContentGdDto, Tuple12<...>>`

#### `open()` — Khởi tạo một lần khi Flink task start:

```java
// 1. Kết nối ClickHouse qua JDBC
connection = DriverManager.getConnection("jdbc:clickhouse://...");

// 2. Load PiiConfig từ PostgreSQL
piiConfigMap = PiiConfigLoader.load();
// → Map<String, PiiConfigEntry> { "bienSo" → {algo, useCase, xmlField, ...} }
```

#### `flatMap()` — Xử lý mỗi record:

```
1. correlationId = UUID.randomUUID()
   ← dùng để link PII record và NonPII record cùng nguồn gốc

2. FlattenUtil.flatten(pojo)
   → Map<String, Object> {
       "violation.bienSo":    "51A-12345",
       "violation.thoiGian":  "2026-04-14T10:00:00",
       "violation.tocDo":     85,
       "vehicle.loaiXe":      "Ô tô con",
       ...
     }

3. Phân loại từng key:
   if (piiConfigMap.containsKey(key)):
       → đưa vào piiFields list
   else:
       → giữ trong nonPiiFields

4. Build 11 NonPII DTOs từ nonPiiFields (theo tên bảng)
5. Build PiiPayload từ piiFields

6. Emit Tuple12(violationDto, ..., 10 DTOs khác..., piiPayload)
```

---

### 5.4 `FlattenUtil` — Recursive POJO Flattener

```java
// Đầu vào: POJO Java bất kỳ
// Đầu ra:  Map<String, Object> với key dạng dot-notation

// Ví dụ:
class Violation {
    String bienSo = "51A-12345";
    int tocDo = 85;
    List<String> tags = ["tag1", "tag2"];
}

// Output:
{
  "violation.bienSo":  "51A-12345",
  "violation.tocDo":   85,
  "violation.tags[0]": "tag1",
  "violation.tags[1]": "tag2"
}
```

**Logic đệ quy:**
- `String / Number / Boolean / LocalDate / LocalDateTime` → leaf node (ghi vào map)
- `Map` → đệ quy với key của map
- `Iterable / List` → đệ quy với index `[0]`, `[1]`, ...
- `POJO` → dùng reflection `getDeclaredFields()`, đệ quy từng field

---

### 5.5 `PiiConfigLoader` — Load cấu hình PII từ PostgreSQL

```java
// SQL join 3 bảng:
SELECT sf.field_name,
       sf.xml_fields,
       dc.algorithm,
       dc.parameters,
       dc.type,
       dc.use_case
FROM schema_field sf
JOIN pii_field_template pft ON sf.id = pft.schema_field_id
JOIN deid_config dc ON pft.deid_config_id = dc.id
WHERE dc.active = true
```

Kết quả: biết field nào là PII, dùng thuật toán gì, use_case gì để gửi G2 Engine.

---

### 5.6 `G2Sink` — PII Batch Sink → ECP

`RichSinkFunction<PiiPayload>` với batch pattern:

```java
// Mỗi record: thêm vào batch
batch.add(value);
if (batch.size() >= 1000 || (now - lastFlush) >= 5000ms) {
    flush();
}

// flush():
PiiPayLoad requestBody = {
    lineage_id: correlationId,
    alg_type: {
        engine:   "G2",
        use_case: "VEHICLE",
        algo:     "PSEUDONYMIZATION",
        param:    "..."
    },
    data: {
        table_key: "platform.violation",
        pii_field: [
            { key: "bienSo", value: "51A-12345" },
            ...
        ]
    }
}
POST http://10.6.8.37:4000/proxy/g2/process-data
```

ECP nhận, gửi sang G2 Engine, nhận lại `pseudoId`, sau đó update ClickHouse:
```sql
ALTER TABLE platform.violation
UPDATE pii_pseudo_id = '<pseudoId>'
WHERE correlation_id = '<correlationId>'
```

---

### 5.7 `ViolationSink` — NonPII Batch Sink → Audit

`RichSinkFunction<ViolationDTO>` với cùng batch pattern:

```java
// flush():
for (ViolationDTO dto : batch) {
    String json    = ObjectMapper.writeValueAsString(dto);
    String base64  = Base64.encode(json);

    NonPiiRequestDto request = {
        lineage_id: dto.getCorrelationId(),
        data: {
            table_key: "platform.violation",
            non_pii_group: [
                { key: "bienSo",   value: "<base64>" },
                { key: "tocDo",    value: "<base64>" },
                ...
            ]
        }
    }
}
POST http://10.6.8.37:5001/api/non-pii/push
```

Audit service nhận, decode Base64, insert vào ClickHouse `platform.violation`.

---

### 5.8 `ApiClient` — Static HTTP Client

```java
// Static methods, không cần Spring injection
public static void pushNonPii(String tableKey, String correlationId, String base64Data) {
    // Build NonPiiRequestDto
    // OkHttpClient.newCall(request).execute()
    // Log response
}
```

Dùng `static` vì được gọi từ `RichSinkFunction` — Flink tạo instance sink bằng serialization, không qua Spring IoC.

---

## 6. Luồng dữ liệu đầy đủ

```
Kafka topic "file-events"
    │  { "filePath": "C:\ndip\data\CO8\data.xml", "source": "CO8" }
    ▼
MinioXmlFetcher
    │  FileContentDto { filePath, source }
    ▼
FullXmlParser
    │  Đọc file XML từ disk
    │  XmlMapper → PhuongTienTongHop (POJO)
    │  FileContentGdDto { pojo, source, filePath }
    ▼
PatientCheckinExtractor
    │  correlationId = UUID
    │  FlattenUtil.flatten(pojo) → Map<String, Object>
    │  So sánh với PiiConfig → tách PII / NonPII
    │  Tuple12 ( ViolationDTO, ..., 10 NonPII DTOs..., PiiPayload )
    │
    ├──────────────────────────────────────────────┐
    │  11 NonPII streams                           │ 1 PII stream
    ▼                                              ▼
ViolationSink (+ 10 sink khác)               G2Sink
    │  batch 1000 records / 5s                │  batch 1000 records / 5s
    │  JSON → Base64                          │  raw PII values
    ▼                                              ▼
POST /api/non-pii/push                   POST /proxy/g2/process-data
    │  ndip25.etl.audit                       │  ndip25.etl.ecp
    ▼                                              ▼
ClickHouse INSERT                         G2 Engine pseudonymization
platform.violation, ...                        │
                                               ▼
                                     ALTER TABLE UPDATE pii_pseudo_id
                                     WHERE correlation_id = '<id>'
```

---

## 7. Exactly-Once đảm bảo không mất / không trùng dữ liệu

```
Flink Checkpoint (mỗi 15s)
    │
    ├── Lưu Kafka offset vào checkpoint storage
    ├── Lưu state của mỗi operator (batch đang pending)
    └── Barrier synchronization giữa các operator

Khi crash và restart:
    → Khôi phục offset Kafka → đọc lại từ điểm checkpoint
    → Khôi phục batch state → không mất record đang trong buffer
    → EXACTLY_ONCE: mỗi record được xử lý đúng 1 lần
```

---

## 8. Kết nối với các service liên quan

| Service | Kết nối | Mục đích |
|---|---|---|
| `ndip25.etl.file-watcher` | Kafka `file-events` (upstream) | Nhận event file XML mới |
| `ndip25.etl.ecp` | HTTP POST `/proxy/g2/process-data` | Gửi PII để pseudonymization |
| `ndip25.etl.audit` | HTTP POST `/api/non-pii/push` | Gửi NonPII để insert ClickHouse |
| PostgreSQL | JDBC trực tiếp | Đọc PiiConfig (schema_field, deid_config) |
| ClickHouse | JDBC trực tiếp (trong PatientCheckinExtractor) | Dùng connection, nhưng insert do Audit thực hiện |

---

## 9. Điểm đáng chú ý

### Design decisions

| Quyết định | Lý do |
|---|---|
| `flatMap` thay `map` | Cho phép skip record lỗi (emit 0) mà không crash pipeline |
| `Tuple12` làm output | Ghép 12 stream khác nhau vào 1 operator → chia sẻ correlationId + 1 lần flatten |
| `PiiConfigLoader` load trong `open()` | Load 1 lần khi task khởi động, không query DB mỗi record |
| Batch sink 1000 / 5s | Giảm số HTTP request, tránh overload Audit/ECP service |
| `parallelism=2` mỗi sink | 2 Flink task instance chạy song song, tăng throughput |
| `correlationId = UUID` | Link PII record và NonPII record cùng nguồn — ECP dùng để UPDATE đúng hàng ClickHouse |
| NonPII value encode Base64 | Tránh vấn đề encoding khi truyền qua HTTP JSON |
| Kafka offset = `latest()` | Không xử lý lại file cũ khi restart; file-watcher sẽ re-emit nếu cần |

### Giới hạn hiện tại

| Vấn đề | Mô tả |
|---|---|
| **"C08" vs "CO8"** | `Contants.Keys.CO8_FILE = "C08"` (số 0) nhưng file-watcher extract source `"CO8"` (chữ O) → `source.contains("C08")` có thể không match — cần kiểm tra lại |
| **PiiConfig không reload** | Load 1 lần trong `open()` — phải restart Flink job nếu thay đổi config PII |
| **File đọc từ local disk** | Flink phải chạy trên cùng máy/mount với thư mục data — không scale ngang được |
| **HTTP sink fire-and-forget** | Nếu Audit/ECP trả lỗi, Flink chỉ log, không retry, không DLQ |
| **Không có schema validation** | Nếu XML sai cấu trúc, Jackson throw exception → record bị skip mà không có alert |

---

## 11. Phân tích kiến trúc và hạn chế thiết kế

### 11.1 Vấn đề với mô hình "1 bảng = 1 sink"

Hiện tại project dùng **12 sink riêng biệt** (11 NonPII + 1 G2). Mỗi lần thêm bảng mới phải sửa **8 chỗ**:

```
1. dtos/database/NewTableDTO.java        ← DTO mới
2. dtos/ (XML POJO nếu node XML mới)    ← nếu XML có node mới
3. enums/NewTableJsonKey.java            ← key mapping mới
4. servicve/clickhouse/NewTableSink.java ← sink mới
5. App.java                             ← thêm stream + addSink
6. PatientCheckinExtractor.java         ← build thêm DTO trong flatMap
7. ultis/sql/ClickHouseSql.java         ← thêm INSERT SQL
8. Tuple12 → Tuple13                    ← tăng index Tuple
```

**Rủi ro:** Quên sửa 1 trong 8 chỗ → compile pass nhưng data bị mất lúc runtime.

**Giới hạn cứng của Flink:** `TupleN` chỉ hỗ trợ tối đa `Tuple25`. Hiện tại đang dùng `Tuple12`, còn 13 slot — không phải vô hạn.

### 11.2 Hướng cải thiện có thể áp dụng

Thay vì `Tuple12` cứng, dùng **wrapper object**:

```java
// Thay thế Tuple12
class ExtractedRecord {
    String correlationId;
    Map<String, Object> nonPiiByTable;  // tableKey → DTO
    List<G2RequestDto> piiFields;
}
```

Rồi dùng **1 generic sink** duy nhất:

```java
class GenericNonPiiSink extends RichSinkFunction<Map.Entry<String, Object>> {
    void invoke(entry) {
        // tableKey tự lấy từ data → không cần biết bảng cụ thể
        ApiClient.pushNonPii(entry.getKey(), recordId, toBase64(entry.getValue()));
    }
}
```

Khi thêm bảng mới chỉ cần: thêm DTO + thêm mapping trong `PatientCheckinExtractor` — không cần thêm sink, không cần sửa Tuple.

**Lý do thiết kế hiện tại vẫn chấp nhận được:** Số bảng cố định theo nghiệp vụ (vi phạm, tai nạn, đăng kiểm...), không thêm thường xuyên. Trade-off **verbose nhưng type-safe và rõ ràng** phù hợp với giai đoạn phát triển ban đầu.

### 11.3 Vấn đề với DTO

Mỗi bảng có 1 DTO riêng vì:
- Mỗi bảng ClickHouse có **schema khác nhau** — không thể dùng `Map<String, Object>` chung
- **Type safety** — IDE gợi ý đủ fields, typo bị phát hiện lúc compile thay vì runtime
- Dễ đọc code hơn `Map.get("fieldName")`

**Hạn chế:** Khi thêm/bớt cột trong bảng ClickHouse → phải sửa DTO tương ứng + SQL trong `ClickHouseSql.java`.

### 11.4 Vấn đề với `PatientCheckinExtractor`

Class này đang làm **quá nhiều việc** (God Object):
- Kết nối 2 DB (PostgreSQL + ClickHouse)
- Load PiiConfig
- Flatten POJO
- Tách PII/NonPII
- Build 12 DTO khác nhau

Nếu logic build 1 DTO bị sai → phải vào đúng class này tìm, dù class đã rất dài. Lý tưởng hơn là tách mỗi nhóm build-DTO thành class riêng (extractor per domain).

---

## 10. Dependencies (`pom.xml`)

| Dependency | Version | Mục đích |
|---|---|---|
| `flink-streaming-java` | 1.17.1 | Flink stream processing core |
| `flink-connector-kafka` | 1.17.1 | Kafka source connector |
| `jackson-databind` | 2.15.x | JSON + XML deserialization |
| `jackson-dataformat-xml` | 2.15.x | `XmlMapper` cho parse XML |
| `clickhouse-jdbc` | - | JDBC driver cho ClickHouse |
| `postgresql` | - | JDBC driver cho PostgreSQL (PiiConfig) |
| `okhttp` | - | HTTP client cho gọi ECP/Audit |
| `lombok` | - | Boilerplate reduction |