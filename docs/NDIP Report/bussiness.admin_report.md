# Báo cáo phân tích: `ndip25.api.bussiness.admin`

> **Ngày:** 2026-04-15
> **Module:** `ndip25.api.bussiness.admin` — Admin CMS Service cho hệ thống NDIP25

---

## 1. Tổng quan

`ndip25.api.bussiness.admin` là **Admin CMS service** — cung cấp API cho giao diện quản trị. Đây là service trung tâm cho admin theo dõi dataset, cấu hình PII template, upload file dữ liệu, và chạy simulation để kiểm tra pipeline trước khi vào production.

| Thông tin | Chi tiết |
|---|---|
| **Vai trò** | Admin CMS — quản lý dataset, datasource, PII template, simulation |
| **Input** | HTTP từ admin portal / đơn vị cung cấp dữ liệu |
| **Output** | Đọc PostgreSQL + ClickHouse, ghi file disk, gửi Kafka |
| **Port** | 4001 |
| **Auth** | `endpoint.login.enabled=false` — dùng JWT từ `platform.auth` |

**Build:** Gradle | **Java:** 11+ | **Spring Boot:** 2.x

Để build và chạy:
```bash
./gradlew clean build -x test
java -jar build/libs/*.jar
```

---

## 2. Phân lớp kiến trúc

```
ndip25.api.bussiness.admin/
│
└── src/main/java/ndip/api/
    ├── Application.java
    │
    └── feature/
        ├── dataset/
        │   ├── controller/DatasetController.java        ← 5 endpoint GET dataset + schema
        │   └── business/DatasetBusiness.java            ← Tổng hợp dataset detail, tính sensitivity
        │
        ├── datasource/
        │   ├── controller/DataSourceController.java     ← 1 endpoint GET datasource
        │   └── business/DataSourceBusiness.java         ← Tìm kiếm datasource phân trang
        │
        ├── pii/
        │   ├── controller/PiiFieldTemplateController.java ← 3 endpoint GET PII template
        │   └── business/PiiFieldTemplateBusiness.java   ← Tìm kiếm + chi tiết PII template
        │
        ├── simulation/
        │   ├── controller/SimulationController.java     ← 4 endpoint upload + xem kết quả
        │   └── business/SimulationBusiness.java         ← Logic upload XML, risk analysis
        │
        └── upload/
            ├── controller/FileUploadController.java     ← 1 endpoint nhận file từ data_owner
            └── business/FileUploadBusiness.java         ← Lưu file + lịch sử upload
```

Toàn bộ entity, mapper, repository đến từ **`ndip25.api.common`** (dependency dùng chung).

---

## 3. Cấu hình (`application-local.properties`)

```properties
server.port=4001
endpoint.login.enabled=false    ← tắt login — dùng JWT từ platform.auth

# PostgreSQL — Business DB
spring.datasource.business.url=jdbc:postgresql://localhost:5432/postgres

# Auth DB — tắt
spring.datasource.auth.enabled=false

# ClickHouse — đọc kết quả simulation
spring.datasource.clickhouse.url=jdbc:clickhouse://localhost:8123/platform

# Redis
spring.redis.host=localhost
spring.redis.port=6379

# File upload
upload.path=/tmp/ndip/upload
upload.path.simulation=/tmp/ndip/upload/simulation
upload.allowed-extensions=xml
upload.max-size=5MB

# Kafka — gửi SimulationRun ID sau khi upload
spring.kafka.bootstrap-servers=localhost:9092
kafka.topic=test
```

---

## 4. Các endpoint

```
# Dataset
GET /api/v1/datasets                              ← Tìm kiếm dataset
GET /api/v1/datasets/{id}                         ← Chi tiết dataset
GET /api/v1/datasets/{id}/schema-fields           ← Fields của schema version active
GET /api/v1/datasets/{id}/schema-fields/{versionId} ← Fields theo version cụ thể
GET /api/v1/datasets/{id}/versions                ← Lịch sử các version schema

# Datasource
GET /api/v1/datasources                           ← Tìm kiếm datasource

# PII Template
GET /api/v1/pii-templates                         ← Tìm kiếm PII template
GET /api/v1/pii-templates/{id}                    ← Chi tiết template
GET /api/v1/pii-templates/{id}/de-id-configs      ← Cấu hình de-identification

# Simulation
POST /api/v1/simulations/upload-sample            ← Upload XML + validate schema
GET  /api/v1/simulations/preview/{uploadId}       ← Xem dữ liệu gốc vs đã mã hóa
GET  /api/v1/simulations/risk-analysis/{uploadId} ← Phân tích rủi ro privacy
GET  /api/v1/simulations/apply-transformation/{uploadId} ← Kết quả de-identification

# File Upload (nhận từ data_owner)
POST /api/file/upload                             ← Nhận file XML base64
```

---

## 5. Các thành phần chính

### 5.1 `DatasetBusiness` — Quản lý Dataset

#### `getDatasets()`

Tìm kiếm phân trang, sau khi có kết quả tính thêm `sensitivityRating` cho từng dataset:

```
sensitivityRating = calculatePiiLevel(totalFields, totalPiiFields)

ratio < 0.30  → "Low"    (ví dụ: "12% (Low)")
ratio ≤ 0.70  → "Medium"
ratio > 0.70  → "High"
```

#### `getDatasetById()`

Tổng hợp từ nhiều nguồn:

```
1. Lấy DatasetDetail từ DatasetMapper (PostgreSQL)
2. Tìm schema version đang Active (schemaMapper)
3. Lấy danh sách fields của version active
4. Đếm PII fields:
   classification="PII" + piiType="Sensitive" → sensitivePii
   classification="PII" + piiType khác        → basicPii
5. Tính sensitivityScore
6. Trả DatasetDetailRp {
     id, name, sourceSystem, ownerName, status,
     piiSummary: { totalFields, basicPii, sensitivePii },
     sensitivityScore, fields
   }
```

#### `getDatasetSchemaFields()`

Ẩn thông tin cấu hình de-identification với NonPII field:

```java
if (!"PII".equalsIgnoreCase(field.getClassification())) {
    field.setPiiType(null);
    field.setPiiTemplateId(null);
    field.setAlgorithm(null);
    field.setConfigVersion(null);
}
// NonPII field chỉ hiện tên và kiểu dữ liệu — không lộ cấu hình mã hóa
```

---

### 5.2 `DataSourceBusiness` — Datasource

```
getDatasources(source, search, page, size):
    → dataSourceMapper.searchDataSources(source, search, createdBy=null, size, offset)
    → Phân trang, trả DataSourceRs list
```

`Servant` được inject để lấy userId nhưng `createdBy` luôn để `null` — hiện trả toàn bộ datasource, không lọc theo user.

---

### 5.3 `PiiFieldTemplateBusiness` — PII Template

PII Template là bộ cấu hình cho 1 loại dữ liệu PII — định nghĩa cách xử lý (pseudonymization, tokenization, ...) khi field đó đi qua pipeline.

```
getPiiTemplates(status, piiType, classificationLevel, search):
    → piiFieldTemplateMapper.searchTemplates(...)
    → Phân trang

getDeIdConfigsByTemplateId(id):
    → piiFieldTemplateMapper.getDeIdConfigsByTemplateId(id)
    → Trả DeidConfigRp { algorithm, configVersion, ... }
```

---

### 5.4 `SimulationBusiness` — Luồng Simulation

#### `uploadSample()` — Upload XML và kích hoạt simulation

```
Input: datasetId, schemaVersionId, file (XML, tối đa 5MB)

Bước 1 — Validate file:
    Không rỗng, không có ".." (path traversal), extension phải là ".xml"

Bước 2 — Lấy schema fields từ DB
    → Nếu không tìm thấy → 400 Invalid Request

Bước 3 — Parse XML (XXE protected):
    factory.setFeature("disallow-doctype-decl", true) ← chặn XXE injection

Bước 4 — Phát hiện cấu trúc XML:
    rootIsRecord=true  → root là 1 record duy nhất
    rootIsRecord=false → root là wrapper chứa nhiều records

Bước 5 — So sánh fields với schema:
    allFields     = union(mọi field trong file)
    commonFields  = intersection(fields có mặt trong MỌI record)
    extraFields   = allFields − expectedFields   (thừa)
    missingFields = expectedFields − commonFields (thiếu)
    matchedFields = commonFields ∩ expectedFields (khớp)

Bước 6 — Nếu schema matched hoàn toàn:
    → Lưu file vào disk: {upload.path.simulation}/{filename}
    → Tạo SimulationRun {
          datasetId, schemaVersionId,
          totalFields, sampleSize (recordCount),
          status = PENDING, sampleFilePath
      }
    → KafkaUtils.send(topic="test", payload=simulationRunId)
      ← Flink-simulation consumer nhận và xử lý

Output: {
    upload_id, record_count,
    schema_check: { outcome: "Passed/Failed", matched/missing/extra fields }
}
```

#### `viewDataSimulation()` — Xem kết quả

```
Yêu cầu: SimulationRun.status = COMPLETED

→ clickHouseSimulationMapper.viewDataSimulation(uploadId)
→ Phân loại theo type:
    type="origin" → dữ liệu gốc
    type="hash"   → dữ liệu sau khi de-identification
→ Trả { origin: [...], hash: [...] }
```

#### `getRiskAnalysis()` — Phân tích rủi ro privacy

Tính toán 2 metric chính:

**1. Singling Out Risk** — khả năng xác định danh tính cá nhân:

```
uniqueRecordCount = số record có class_size = 1
                   (record không có bản sao nào giống hệt)

score = uniqueRecordCount / totalRecord

score < 0.09  → "Low"
score ≤ 0.33  → "Medium"
score > 0.33  → "High"
```

**2. K-Anonymity** — đảm bảo mỗi cá nhân không thể phân biệt với ít nhất k-1 người khác:

```
k = min(class_size) trong tất cả nhóm quasi-identifier

k ≥ 5  → "Low"   (mỗi nhóm ≥ 5 người — khó xác định cá nhân)
score=1 → "High"  (tất cả unique)
khác   → "Medium"
```

`class_size` lấy từ ClickHouse — số record trong cùng nhóm quasi-identifier (các field kết hợp lại có thể định danh người dùng, ví dụ: tuổi + tỉnh + nghề nghiệp).

#### `applyTransformation()` — Kiểm tra kết quả de-identification

```
→ Lấy PII fields từ schema
→ Lấy transformation stats từ ClickHouse:
   { fieldName, totalRecords, successCount, failureCount }
→ Tính status từng field:
   failureCount > 0    → "Fail"
   totalRecords = 0    → "No Data"
   không có lỗi        → "Pass"
→ Trả ApplyTransformationRp {
    fieldResults: [{ fieldName, configApplied, totalRecords, successCount, failureCount, status }],
    summary: { totalPiiFields, transformedFields, transformFailures }
  }
```

---

### 5.5 `FileUploadBusiness` — Nhận file từ data_owner

Endpoint này nhận file XML từ **đơn vị cung cấp dữ liệu** (data_owner) theo format chuẩn NDIP.

#### Format request

```json
{
  "header": {
    "lineageId":    "uuid-123",
    "senderId":     "SOURCE_CODE",
    "receiverId":   "NDIP",
    "txnId":        "txn-456",
    "version":      "1.0",
    "sendDatetime": 1713160000,
    "txnType":      "UPLOAD"
  },
  "data":      "<base64 encoded XML>",
  "signature": "<RSA signature>"
}
```

#### Luồng xử lý hiện tại

```
1. detectExtensionFromBase64():
   Decode 100 byte đầu → kiểm tra magic number:
   0x3C 0x3F 0x78 0x6D ("<?xm") → ".xml"
   0xFF 0xD8 0xFF               → ".jpg"
   0x89 0x50 0x4E 0x47          → ".png"
   0x25 0x50 0x44 0x46 ("%PDF") → ".pdf"

2. Validate senderId tồn tại trong DataSource table

3. Decode Base64 → bytes → ghi file:
   Path: {upload.path}/{dataSource.code}/{lineageId}.xml

4. Lưu LineageIdUploadHistory {
     id:            lineageId,
     filePath:      đường dẫn file trên disk,
     userIdUploaded: userId từ Redis session
   }

5. Trả UploadRpDTO { header, data: { status: "success" } }
```

#### RSA Signature Verification (đang bị comment out)

Code đã thiết kế đầy đủ flow xác thực chữ ký RSA nhưng bị tắt:

```java
// Thiết kế ban đầu (comment out):
// 1. Load private/public key của user từ Redis
//    → fallback: lấy từ DB nếu cache miss
// 2. Verify signature:
//    compareData = SHA256(header) + "." + SHA256(data)
//    HSMLocalService.verifyData(signature, compareData, publicKey)
//    → Sai chữ ký → trả lỗi PS_SIGNATURE_INVALID
// 3. Sign response với private key
//    HSMLocalService.signData(compareData, privateKey, RSA, 256)
```

Khi bật lại sẽ đảm bảo: chỉ data_owner sở hữu private key mới có thể gửi file hợp lệ.

---

## 6. Luồng dữ liệu

```
Admin Portal
    │
    ├── GET /api/v1/datasets/**            ← Xem thông tin dataset
    │       └── PostgreSQL (DatasetMapper, SchemaMapper)
    │
    ├── GET /api/v1/pii-templates/**       ← Xem PII template
    │       └── PostgreSQL (PiiFieldTemplateMapper)
    │
    ├── POST /api/v1/simulations/upload-sample
    │       ├── 1. Validate XML + so sánh schema (PostgreSQL)
    │       ├── 2. Lưu file vào disk
    │       ├── 3. Tạo SimulationRun (PostgreSQL)
    │       └── 4. Gửi Kafka → flink-simulation xử lý
    │
    └── GET /api/v1/simulations/preview|risk-analysis|apply-transformation
            └── ClickHouse (kết quả simulation đã được flink ghi vào)

Data Owner
    │
    └── POST /api/file/upload
            ├── Validate senderId (PostgreSQL DataSource)
            ├── Ghi file XML lên disk
            └── Lưu LineageIdUploadHistory (PostgreSQL)
                → file-watcher đọc và đưa vào Kafka → flink production
```

---

## 7. Kết nối với các service liên quan

| Service | Kết nối | Mục đích |
|---|---|---|
| `ndip25.api.platform.auth` | JWT (upstream) | Xác thực user admin |
| `ndip25.etl.flink-simulation` | Kafka (downstream) | Nhận SimulationRun ID, xử lý XML simulation |
| `ndip25.etl.file-watcher` | File system (indirect) | Đọc file đã upload qua `/api/file/upload` |
| PostgreSQL | Spring JPA + MyBatis | Dataset, Schema, PII Template, SimulationRun, DataSource |
| ClickHouse | MyBatis | Đọc kết quả simulation (preview, risk, transformation) |
| Redis | CacheUtils | User session, userId lookup |
| Disk (`/tmp/ndip/upload`) | Java NIO | Lưu file XML upload |

---

## 8. Điểm đáng chú ý

### Design decisions

| Quyết định | Lý do |
|---|---|
| Tất cả endpoint đều READ-ONLY (ngoài upload) | Admin CMS chủ yếu để xem — thay đổi cấu hình qua DB trực tiếp hoặc service khác |
| Ẩn cấu hình de-identification với NonPII fields | Cấu hình mã hóa chỉ dành cho PII — không cần expose cho NonPII |
| XXE protection trong parse XML | `disallow-doctype-decl=true` — chặn XML External Entity injection |
| Kafka sau khi upload simulation | Tách biệt bước nhận file và xử lý — flink-simulation xử lý bất đồng bộ |
| lineageId làm tên file | Đảm bảo idempotency — upload lại cùng lineageId sẽ ghi đè file cũ |

### Giới hạn hiện tại

| Vấn đề | Mô tả |
|---|---|
| **RSA signature bị comment** | `FileUploadBusiness` không verify chữ ký — bất kỳ ai biết format đều gửi được file |
| **`extension != ".xml"` dùng `!=`** | So sánh String bằng reference equality thay vì `.equals()` — bug tiềm ẩn, điều kiện luôn sai với runtime String |
| **`createdBy = null` trong datasource** | Tìm kiếm datasource không lọc theo user — trả toàn bộ |
| **`overallRiskLevel` hardcode "High"** | `getRiskAnalysis()` dòng 529: `String overallRiskLevel = "High"` — chưa tính toán thực tế |
| **`totalClassSize += dto.getClassSize() + 1`** | Bug trong tính `avgGroup`: cộng thêm 1 vào mỗi classSize trước khi tính trung bình — kết quả sai |
| **Không xử lý `kRiskLevel` khi `score=1`** | Điều kiện `else if (score == 1)` dùng double equality — dễ sai do floating point |
| **Không validate `riskAnalysiRps` rỗng** | `riskAnalysiRps.get(0)` ném `IndexOutOfBoundsException` nếu ClickHouse trả danh sách rỗng |

---

## 9. Dependencies chính

| Dependency | Mục đích |
|---|---|
| `ndip25.api.common` (common-module) | Entity, Repository, Mapper, BaseController, JWT, Security |
| `spring-boot-starter-web` | REST API |
| `spring-boot-starter-data-jpa` | JPA cho PostgreSQL |
| `mybatis-spring-boot-starter` | MyBatis cho ClickHouse + complex query |
| `clickhouse-jdbc` | JDBC driver ClickHouse |
| `spring-boot-starter-data-redis` | User session lookup |
| `spring-kafka` | Gửi SimulationRun ID sau upload |
| `hsm-lib-0.0.1.jar` | HSM — verify RSA signature (hiện comment out) |
| `springdoc-openapi-ui` | Swagger UI |
| `dotenv-java` | Đọc config từ file `.env` |
| `lombok` | Boilerplate reduction |
