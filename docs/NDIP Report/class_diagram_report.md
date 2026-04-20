# Class Diagram — Hệ thống NDIP25

> **Ngày:** 2026-04-15
> **Phạm vi:** Toàn bộ 8 module

---

## Đánh giá tổng quan

| Module | Có class diagram? | Lý do |
|---|---|---|
| `ndip25.api.common` | ✅ Entity Model | Toàn bộ domain entity, repository, security |
| `ndip25.api.platform.auth` | ✅ Layered Architecture | Controller → Business → Repository |
| `ndip25.api.bussiness.admin` | ✅ Layered Architecture | 5 feature module rõ ràng |
| `ndip25.etl.audit` | ✅ Layered Architecture | Business + Mapper + Repository |
| `ndip25.etl.ecp` | ✅ Đơn giản | 2 class chính |
| `ndip25.etl.flink` | ✅ Pipeline / Inheritance | Flink class hierarchy |
| `ndip25.etl.flink-simulation` | ✅ Pipeline / Inheritance | Tương tự flink, có khác biệt |
| `ndip25.etl.file-watcher` | ⚠️ Không phù hợp | 1 class static duy nhất |

---

## 1. Domain Entity Model (ndip25.api.common)

Đây là **core domain** của toàn hệ thống — tất cả module khác đều dùng chung entity này.

```plantuml
@startuml Domain_Entity_Model

skinparam classAttributeIconSize 0
skinparam class {
    BackgroundColor White
    BorderColor Black
}

package "Schema: public" {
    class AccountRegister {
        +UUID id
        +String username
        +String password
        +String fullName
        +String email
        +String senderId
        +String organizationUnit
        +UUID roleId
        +String roleCode
        +String status
        +UUID createdBy
        +String publicKey
        +String privateKey
        +LocalDateTime createdAt
        +LocalDateTime updatedAt
        +LocalDateTime lastLoginAt
    }

    class RoleAssignmentHistory {
        +UUID id
        +UUID userId
        +UUID roleId
        +UUID preRoleId
        +String preRoleCode
        +String roleCode
        +UUID changedBy
        +String reason
        +LocalDateTime changedAt
    }
}

package "Schema: common" {
    class DataSource {
        +UUID id
        +String code <<unique>>
        +String name
        +String description
        +Integer datasetCount
        +String ownerName
        +String ownerEmail
        +String ownerPhone
        +String ownerOrg
        +String status
        +UUID createdBy
    }

    class Dataset {
        +UUID id
        +String name <<unique>>
        +String sourceSystem
        +String owner
        +String description
        +String businessUseCase
        +String updateFrequency
        +Integer retentionPeriodDays
        +UUID dataSourceId
        +String status
        +UUID createdBy
    }

    class DatasetSchemaVersion {
        +UUID id
        +UUID datasetId
        +String version
        +String versionType
        +String status
        +UUID submittedBy
        +LocalDateTime submittedAt
        +UUID reviewedBy
        +LocalDateTime reviewedAt
        +String reviewerNotes
        +LocalDateTime activatedAt
    }

    class SchemaField {
        +UUID id
        +UUID schemaVersionId
        +String fieldName
        +String fields
        +String xmlFields
        +String dataType
        +String description
        +Boolean nullable
        +String classification
        +String classificationLevel
        +String piiType
        +Boolean usedAsIdentifier
        +UUID piiTemplateId
        +Boolean isTemplateOverride
        +UUID deidConfigId
        +UUID approvedBy
    }

    class PiiFieldTemplate {
        +UUID id
        +String name <<unique>>
        +String dataType
        +String piiType
        +String classificationLevel
        +Long datasetCount
        +String description
        +String status
        +String category
        +String regexPattern
        +String metadataTag
        +UUID createdBy
        +UUID approvedBy
    }

    class DeidConfig {
        +UUID id
        +UUID piiTemplateId
        +String version
        +String versionType
        +String type
        +String useCase
        +String description
        +String algorithm
        +String parameters <<jsonb>>
        +String status
        +UUID submittedBy
        +UUID approvedBy
        +UUID createdBy
    }

    class SimulationRun {
        +UUID id
        +UUID datasetId
        +UUID schemaVersionId
        +String sampleFilePath
        +Integer sampleSize
        +Integer totalFields
        +String status
        +UUID triggeredBy
        +LocalDateTime startedAt
        +LocalDateTime completedAt
        +String validationOutcome
    }

    class StagingNonPii {
        +Long id
        +String recordId
        +String tableName
        +String status
        +String dataJson
        +LocalDateTime createdAt
        +LocalDateTime updatedAt
    }

    class StagingPii {
        +Long id
        +String recordId
        +String tableName
        +String fieldName
        +String status
        +String encryptedJson
        +String payloadG1Json
        +LocalDateTime createdAt
        +LocalDateTime updatedAt
    }

    class LineageIdUploadHistory {
        +String id <<lineageId>>
        +String filePath
        +UUID userIdUploaded
        +LocalDateTime uploadedAt
    }

    class Config {
        +String code <<PK>>
        +String value
        +String unit
        +String description
        +String type
        +String locale
        +String status
        +Boolean isAllowUpdate
        +getValueAsInt() Integer
        +getValueAsLong() Long
        +getValueAsDouble() Double
    }
}

' Relationships
DataSource "1" --> "*" Dataset : dataSourceId
Dataset "1" --> "*" DatasetSchemaVersion : datasetId
DatasetSchemaVersion "1" --> "*" SchemaField : schemaVersionId
SchemaField "*" --> "0..1" PiiFieldTemplate : piiTemplateId
SchemaField "*" --> "0..1" DeidConfig : deidConfigId
DeidConfig "*" --> "1" PiiFieldTemplate : piiTemplateId
SimulationRun "*" --> "1" Dataset : datasetId
SimulationRun "*" --> "1" DatasetSchemaVersion : schemaVersionId
AccountRegister "1" --> "*" RoleAssignmentHistory : userId
LineageIdUploadHistory "*" --> "1" AccountRegister : userIdUploaded

@enduml
```

---

## 2. Security Layer (ndip25.api.common — security)

```plantuml
@startuml Security_Layer

interface PasswordEncoder <<Spring Security>> {
    +encode(rawPassword) String
    +matches(rawPassword, encodedPassword) boolean
}

abstract class UsernamePasswordAuthenticationFilter <<Spring Security>> {
    +attemptAuthentication()
    +successfulAuthentication()
}

abstract class BasicAuthenticationFilter <<Spring Security>> {
    +doFilterInternal()
}

class Argon2Encoder implements PasswordEncoder {
    +encode(rawPassword) String
    +matches(rawPassword, encodedPassword) boolean
}

class JwtAuthenticationFilter extends UsernamePasswordAuthenticationFilter {
    -AuthenticationManager authManager
    -JwtSigner jwtSigner
    -ConfigRepository configRepository
    -AccountRegisterRepository accountRepo
    +attemptAuthentication(request, response) Authentication
    +successfulAuthentication(request, response, chain, auth)
    ' @ConditionalOnProperty(login.enabled=true)
}

class JwtAuthorizationFilter extends BasicAuthenticationFilter {
    -JwtSigner jwtSigner
    +doFilterInternal(request, response, chain)
    ' Validates JWT + checks Redis session key
}

class JwtSigner {
    -String secretKey
    +generateAccessToken(user, sessionId) String
    +generateRefreshToken(user, sessionId, ttl) String
    +parseToken(token) Claims
    ' Claims: username, session_id, ut(roleCode), email, authorities
}

class WebSecurityConfig {
    -JwtSigner jwtSigner
    -DataSource dataSource
    +configure(http) void
    +configure(auth) void
    ' permitAll: /api/pii/push, /api/non-pii/push, /login, swagger...
}

JwtAuthenticationFilter --> JwtSigner
JwtAuthorizationFilter --> JwtSigner
WebSecurityConfig --> JwtAuthorizationFilter
WebSecurityConfig --> JwtAuthenticationFilter
WebSecurityConfig ..> Argon2Encoder

note right of JwtSigner
  JWT Claims:
  - username
  - session_id (UUID)
  - ut (roleCode)
  - email
  - authorities: ["login","admin"]
  Signed: HS256
end note

note right of JwtAuthorizationFilter
  Redis check:
  "{sessionId}-jwt-re-token" must exist
  → logout deletes this key
end note

@enduml
```

---

## 3. Application Layer — ndip25.api.platform.auth

```plantuml
@startuml Auth_Service

abstract class BaseBusiness {
    #MessageService messageService
    #BuildProperties buildProperties
    #successResponse(data) BaseRp
    #successWithData(data, code) BaseRp
    #errorByCode(code) BaseRp
    #pagingResponse(page) BaseRp
}

abstract class BaseController {
}

class AuthUserBusiness extends BaseBusiness {
    -AccountRegisterRepository accountRegisterRepo
    -RoleRepository roleRepo
    -AuthUserWriteService authUserWriteService
    -Servant servant
    +createAccount(rq) BaseRp
    +updateUserStatus(id, rq) BaseRp
    +updateUserRole(id, rq) BaseRp
    +deleteUser(id) BaseRp
    +getUsers(filters) BaseRp
    +getUserById(id) BaseRp
    +regenerateDataOwnerKeys(id) BaseRp
    -getCurrentUserUuid() UUID
    ' data_owner → HSMLocalService.generateKey(RSA, 2048)
}

class AuthUserWriteService {
    -AccountRegisterRepository accountRegisterRepo
    -RoleAssignmentHistoryRepository roleHistoryRepo
    +saveAccountUpdate(entity, history) void
    ' @Transactional — separate class to avoid Spring proxy bypass
}

class AuthUserController extends BaseController {
    -AuthUserBusiness authUserBusiness
    +createAccount(rq) ResponseEntity
    +updateStatus(id, rq) ResponseEntity
    +updateRole(id, rq) ResponseEntity
    +deleteUser(id) ResponseEntity
    +getUsers(...) ResponseEntity
    +getUserById(id) ResponseEntity
    +regenerateKeys(id) ResponseEntity
    ' @PreAuthorize("hasAuthority('admin')")
}

interface AccountRegisterRepository {
    +findByUsername(username) Optional
    +findById(id) Optional
    +existsByUsername(username) boolean
    +existsByEmail(email) boolean
}

interface RoleAssignmentHistoryRepository {
    +save(entity) RoleAssignmentHistory
    +findByUserId(userId) List
}

AuthUserController --> AuthUserBusiness
AuthUserBusiness --> AuthUserWriteService
AuthUserBusiness --> AccountRegisterRepository
AuthUserBusiness ..> AccountRegister
AuthUserWriteService --> AccountRegisterRepository
AuthUserWriteService --> RoleAssignmentHistoryRepository
AccountRegisterRepository ..> AccountRegister
RoleAssignmentHistoryRepository ..> RoleAssignmentHistory

@enduml
```

---

## 4. Application Layer — ndip25.api.bussiness.admin

```plantuml
@startuml BussinessAdmin_Service

abstract class BaseBusiness {
    #successResponse(data) BaseRp
    #errorByCode(code) BaseRp
    #pagingResponse(page) BaseRp
}

abstract class BaseController {
}

' === Dataset Feature ===
class DatasetBusiness extends BaseBusiness {
    -DatasetRepository datasetRepo
    -DatasetSchemaVersionRepository schemaVersionRepo
    -SchemaFieldRepository schemaFieldRepo
    -DeidConfigRepository deidConfigRepo
    +getDatasets(source,status,search,page,size) BaseRp
    +getDatasetById(id) BaseRp
    +getDatasetSchemaFields(id) BaseRp
    +getDatasetSchemaFieldsByVersion(datasetId,versionId) BaseRp
    +getDatasetVersions(id) BaseRp
    ' Hides deidConfig for NonPII fields
}

class DatasetController extends BaseController {
    -DatasetBusiness datasetBusiness
    +getDatasets(...) ResponseEntity         ' GET /api/v1/datasets
    +getDatasetById(id) ResponseEntity       ' GET /api/v1/datasets/{id}
    +getDatasetSchemaFields(id) ResponseEntity
    +getDatasetSchemaFieldsByVersion(id,vid) ResponseEntity
    +getDatasetVersions(id) ResponseEntity
}

' === DataSource Feature ===
class DataSourceBusiness extends BaseBusiness {
    -DataSourceRepository dataSourceRepo
    -Servant servant
    +getDatasources(source,search,page,size) BaseRp
    ' BUG: createdBy = null — returns all datasources
}

class DataSourceController extends BaseController {
    -DataSourceBusiness dataSourceBusiness
    +getDatasources(...) ResponseEntity      ' GET /api/v1/datasources
}

' === PII Template Feature ===
class PiiFieldTemplateBusiness extends BaseBusiness {
    -PiiFieldTemplateRepository piiTemplateRepo
    -PiiFieldTemplateMapper piiTemplateMapper
    +getPiiTemplates(status,piiType,level,search,page,size) BaseRp
    +getPiiTemplateById(id) BaseRp
    +getDeIdConfigsByTemplateId(id) BaseRp
}

class PiiFieldTemplateController extends BaseController {
    -PiiFieldTemplateBusiness piiTemplateBusiness
    +getPiiTemplates(...) ResponseEntity     ' GET /api/v1/pii-templates
    +getPiiTemplateById(id) ResponseEntity
    +getDeIdConfigsByTemplateId(id) ResponseEntity
}

' === Simulation Feature ===
class SimulationBusiness extends BaseBusiness {
    -SimulationRunRepository simulationRunRepo
    -DatasetRepository datasetRepo
    -DatasetSchemaVersionRepository schemaVersionRepo
    -ClickHouseSimulationMapper simulationMapper
    +uploadSample(datasetId, schemaVersionId, file) BaseRp
    +viewDataSimulation(uploadId) BaseRp
    +getRiskAnalysis(uploadId) BaseRp
    +applyTransformation(uploadId) BaseRp
    ' uploadSample: XXE protection + schema validation + Kafka trigger
    ' BUG: overallRiskLevel hardcoded "High"
    ' BUG: avgGroup off-by-one (+1)
}

class SimulationController extends BaseController {
    -SimulationBusiness simulationBusiness
    +uploadSample(datasetId,schemaVersionId,file) ResponseEntity
    +viewDataSimulation(uploadId) ResponseEntity
    +getRiskAnalysis(uploadId) ResponseEntity
    +applyTransformation(uploadId) ResponseEntity
}

' === File Upload Feature ===
class FileUploadBusiness extends BaseBusiness {
    -DataSourceRepository dataSourceRepo
    -LineageIdUploadHistoryRepository lineageRepo
    -Servant servant
    -AccountRegisterRepository accountRepo
    +uploadFile(payloadJsonRq) ResponseEntity
    -detectExtensionFromBase64(base64) String
    ' BUG: extension != ".xml" (reference equality)
    ' Signature verification COMMENTED OUT
}

class FileUploadController extends BaseController {
    -FileUploadBusiness fileUploadBusiness
    +uploadFile(payloadJsonRq) ResponseEntity  ' POST /api/file/upload
}

DatasetController --> DatasetBusiness
DataSourceController --> DataSourceBusiness
PiiFieldTemplateController --> PiiFieldTemplateBusiness
SimulationController --> SimulationBusiness
FileUploadController --> FileUploadBusiness

DatasetBusiness ..> Dataset
DatasetBusiness ..> DatasetSchemaVersion
DatasetBusiness ..> SchemaField
SimulationBusiness ..> SimulationRun
FileUploadBusiness ..> DataSource
FileUploadBusiness ..> LineageIdUploadHistory

@enduml
```

---

## 5. ETL Layer — ndip25.etl.audit

```plantuml
@startuml ETL_Audit

abstract class BaseBusiness {
}

abstract class BaseController {
}

class NonPiiBuusiness extends BaseBusiness {
    -StagingNonPiiRepository stagingRepo
    -[11 MyBatis Mappers]
    +processPushNonPii(payloadRq) ResponseEntity
    +processPushNonPiiSimulation(payloadRq) ResponseEntity
    ' switch(11 cases) theo tableName
    ' Error → set FAILED status, không throw
}

class PiiBusiness extends BaseBusiness {
    -StagingPiiRepository stagingPiiRepo
    -ClickHousePlatformMapper clickHouseMapper
    +processPushPii(piiPayLoadRq) ResponseEntity
    +processPushPiiSimulation(piiPayLoadRq) ResponseEntity
    ' Whitelist validation: Constants.TABLE_COLUMNS
    ' UPDATE pseudo_id vào ClickHouse
}

class MergeService {
    -ClickHousePlatformMapper clickHouseMapper
    +tryMerge(tableName, uploadId) void
    ' Chỉ implement 2/11 bảng
    ' Không được gọi — cả 2 call site đều COMMENTED OUT
}

class RedisProgressService {
    -StringRedisTemplate redisTemplate
    +tryComplete(runId) boolean
    ' SET NX: "simulation:run:{runId}:completed" → race condition safe
}

class SimulationRunInitService {
    -SimulationRunRepository simulationRunRepo
    +getOrInit(uploadId, datasetId, schemaVersionId) SimulationRun
    ' orElseThrow() với no message
}

class NonPiiController extends BaseController {
    -NonPiiBuusiness nonPiiBusiness
    +pushNonPii(payloadRq) ResponseEntity         ' POST /api/non-pii/push
    +pushNonPiiSimulation(payloadRq) ResponseEntity ' POST /api/non-pii/push-simulation
}

class PiiController extends BaseController {
    -PiiBusiness piiBusiness
    +pushPii(piiPayLoadRq) ResponseEntity         ' POST /api/pii/push
    +pushPiiSimulation(piiPayLoadRq) ResponseEntity ' POST /api/pii/push-simulation
}

interface StagingNonPiiRepository {
    +save(entity) StagingNonPii
    +findById(id) Optional
}

interface StagingPiiRepository {
    +findByRecordIdAndTableNameAndFieldName(...) Optional
    +findByRecordIdAndTableNameAndFieldNameAndStatus(...) Optional
    +save(entity) StagingPii
}

interface ClickHousePlatformMapper {
    +updatePseudoId(table, column, recordId, pseudoId) void
}

NonPiiController --> NonPiiBuusiness
PiiController --> PiiBusiness
NonPiiBuusiness --> StagingNonPiiRepository
PiiBusiness --> StagingPiiRepository
PiiBusiness --> ClickHousePlatformMapper
NonPiiBuusiness ..> RedisProgressService
NonPiiBuusiness ..> SimulationRunInitService
StagingNonPiiRepository ..> StagingNonPii
StagingPiiRepository ..> StagingPii

note right of MergeService
  DEAD CODE:
  Cả 2 call site đều bị
  comment out trong
  NonPiiBuusiness
end note

@enduml
```

---

## 6. ETL Layer — ndip25.etl.ecp

```plantuml
@startuml ETL_ECP

class ProxyController {
    -ProxyBusiness proxyBusiness
    +processData(piiPayLoadRq) ResponseEntity   ' POST /proxy/g2/process-data
    +simulation(requestDto) String              ' POST /proxy/g2/process-data-simulation
}

class ProxyBusiness {
    -StagingPiiRepositoty stagingPiiRepo
    -ObjectMapper objectMapper
    +processData(piiPayLoadRq) ResponseEntity
    +simulation(requestDto) String
    -getTableKey(base64) String
    -toCamelCase(snake) String
}

interface StagingPiiRepositoty {
    +findByRecordIdAndTableNameAndFieldName(...) Optional
    +findByRecordIdAndTableNameAndFieldNameAndStatus(...) Optional
    +save(entity) StagingPii
}

ProxyController --> ProxyBusiness
ProxyBusiness --> StagingPiiRepositoty
StagingPiiRepositoty ..> StagingPii

note right of ProxyBusiness
  Production flow:
  1. Lưu StagingPii (WAITING)
  2. POST → G2 Engine (de-id)
  3. Nhận pseudoId
  4. Cập nhật StagingPii
  5. POST → G3 Audit /pii/push

  Simulation flow:
  1. POST → G2 Engine
  2. Wrap thành SimulationG3Rq
  3. POST → G3 Audit /pii/push-simulation
end note

@enduml
```

---

## 7. ETL Layer — ndip25.etl.flink (Production Pipeline)

```plantuml
@startuml ETL_Flink_Production

abstract class RichFlatMapFunction <<Apache Flink>> {
    +open(parameters) void
    +flatMap(value, out) void
    +close() void
}

abstract class RichSinkFunction <<Apache Flink>> {
    +open(parameters) void
    +invoke(value, context) void
    +close() void
}

class MinioXmlFetcher extends RichFlatMapFunction {
    +flatMap(kafkaMessage: String, out: FileContentDto) void
    ' Parse JSON: { filePath, source }
    ' Output: FileContentDto
}

class FullXmlParser extends RichFlatMapFunction {
    -XmlMapper xmlMapper
    +flatMap(fileContentDto, out: FileContentGdDto) void
    ' Parse XML file → PhuongTienTongHop
    ' Check source contains "C08"
}

class PatientCheckinExtractor extends RichFlatMapFunction {
    -Connection connection (ClickHouse)
    -Map fieldToPiiKeyMap
    +open(parameters) void
    +flatMap(fileContentGdDto, out: Tuple12) void
    +close() void
    ' Load PiiConfig from PostgreSQL in open()
    ' Map XML fields → 12 specific DTOs
    ' Output: Tuple12<PointsDTO,...,TrafficStatusDTO>
}

class PiiConfigLoader {
    +{static} load() Map<String, List<String>>
    ' Query PostgreSQL: toàn bộ PII config
}

class ViolationSink extends RichSinkFunction {
    -List batch
    -ScheduledExecutorService scheduler
    +invoke(violationDTO, context) void
    -flushBatch() void
    ' POST → ApiClient.pushNonPii("platform.violation")
    ' batchSize=1000, flushInterval=5000ms
}

note "Tương tự ViolationSink:\nAccidentSink\nTrafficFineSink\nVehicleRegistrationSink\nVehicleInspectationSink\nVehicleInsuranceSink\nViolationPenaltySink\nDriverLicenseSink\nRoadInfraSink\nTrafficStatusSink\nPointSink\nG2Sink\n(12 Sinks tổng cộng)" as SinkNote

class App {
    +{static} main(args) void
    -{static} processStreams(combinedStream) void
    -{static} addSink(stream, sink, name) void
    ' Kafka topic: "file-events"
    ' Checkpoint: 15s EXACTLY_ONCE
    ' Sink parallelism: 2
}

App --> MinioXmlFetcher
App --> FullXmlParser
App --> PatientCheckinExtractor
App --> ViolationSink
PatientCheckinExtractor --> PiiConfigLoader

MinioXmlFetcher ..> FullXmlParser : FileContentDto
FullXmlParser ..> PatientCheckinExtractor : FileContentGdDto
PatientCheckinExtractor ..> ViolationSink : Tuple12

@enduml
```

---

## 8. ETL Layer — ndip25.etl.flink-simulation

```plantuml
@startuml ETL_Flink_Simulation

abstract class RichFlatMapFunction <<Apache Flink>>
abstract class RichSinkFunction <<Apache Flink>>

class MinioXmlFetcher extends RichFlatMapFunction {
    -Connection connection (PostgreSQL)
    -PreparedStatement selectStatement
    -PreparedStatement updateStatement
    +open(parameters) void
    +flatMap(uploadId: String, out: FileContentDto) void
    +close() void
    ' Query common.simulation_run WHERE id = uploadId AND status = Pending
    ' UPDATE status = Processing
    ' Output FileContentDto + uploadId + datasetId + schemaVersionId
}

class FullXmlParser extends RichFlatMapFunction {
    -XmlMapper xmlMapper
    +flatMap(fileContentDto, out: FileContentGdDto) void
    ' Parse XML → BookstoresDto (generic, không domain-specific)
    ' Truyền uploadId/datasetId/schemaVersionId downstream
}

class PatientCheckinExtractor extends RichFlatMapFunction {
    -Connection connection (PostgreSQL)
    +open(parameters) void
    +flatMap(fileContentGdDto, out: Tuple2) void
    +close() void
    ' Load PiiConfig per datasetId in flatMap() (mỗi file)
    ' FlattenUtil.flatten() toàn bộ XML
    ' Tách PII / NonPII động theo config
    ' Output: Tuple2<List<NonPiiRq>, List<G2RequestDto>>
    ' Table PII hardcode: "platform.simulation"
}

class PiiConfigLoader {
    +{static} load(datasetId: String) Map<String, List<String>>
    ' Query PostgreSQL: filter theo datasetId + Active schema version
    ' BUG: String concatenation SQL (SQL injection risk)
}

class NonPiiSink extends RichSinkFunction {
    -List batch
    -ScheduledExecutorService scheduler
    -HttpClient client
    +invoke(nonPiiRq, context) void
    -flushBatch() void
    -callNonApi(nonPiiRq) void
    ' POST → /api/non-pii/push-simulation
    ' batchSize=1000, flushInterval=5000ms
}

class G2Sink extends RichSinkFunction {
    -List batch
    -ScheduledExecutorService scheduler
    -HttpClient client
    +invoke(g2RequestDto, context) void
    -flushBatch() void
    -callG2Api(g2RequestDto) void
    ' POST → /proxy/g2/process-data-simulation
}

class App {
    +{static} main(args) void
    -{static} processStreams(combinedStream) void
    -{static} addSink(stream, sink, name) void
    ' Kafka topic: "test"
    ' Checkpoint: 15s EXACTLY_ONCE
    ' Sink parallelism: 2
}

App --> MinioXmlFetcher
App --> FullXmlParser
App --> PatientCheckinExtractor
App --> NonPiiSink
App --> G2Sink
PatientCheckinExtractor --> PiiConfigLoader

MinioXmlFetcher ..> FullXmlParser : FileContentDto
FullXmlParser ..> PatientCheckinExtractor : FileContentGdDto
PatientCheckinExtractor ..> NonPiiSink : List<NonPiiRq>
PatientCheckinExtractor ..> G2Sink : List<G2RequestDto>

@enduml
```

---

## 9. ETL Layer — ndip25.etl.file-watcher

```plantuml
@startuml ETL_FileWatcher

note "file-watcher là ứng dụng\nthủ tục (procedural) — 1 class\nvới toàn bộ static methods.\nKhông có OOP class hierarchy." as Note1

class FileWatcherApplication {
    -{static} String WATCH_DIR
    -{static} String KAFKA_BOOTSTRAP
    -{static} String TOPIC
    -{static} long STABLE_DELAY_MS
    -{static} Set<String> IGNORE_SUFFIX
    -{static} KafkaProducer producer
    -{static} Map<Path, ScheduledFuture> PENDING
    -{static} ScheduledExecutorService SCHEDULER
    +{static} main(args) void
    -{static} loadConfig() void
    -{static} initKafkaProducer() void
    -{static} startWatcher() void
    -{static} scheduleStabilityCheck(file) void
    -{static} sendKafkaEvent(file, size, modified) void
    -{static} shouldIgnore(file) boolean
    -{static} registerAll(start, watchService) void
    -{static} extractSource(file) String
}

note right of FileWatcherApplication
  Debounce pattern:
  1. File detected → schedule check
  2. Đo size + modifiedTime lần 1
  3. Sleep STABLE_DELAY_MS
  4. Đo lần 2 — nếu bằng nhau → file done
  5. Publish Kafka: { filePath, source, ... }
  
  Config từ /path/to/config.properties
  hoặc classpath application.properties
end note

@enduml
```

---

## 10. Sơ đồ tổng thể — Cross-Module Relationships

```plantuml
@startuml System_Overview

rectangle "Admin Portal\n(bussiness.admin)" as Admin {
    component [DatasetController] as DC
    component [SimulationController] as SC
    component [FileUploadController] as FUC
    component [PiiFieldTemplateController] as PFTC
    component [DataSourceController] as DSC
}

rectangle "Auth Service\n(platform.auth)" as Auth {
    component [AuthUserController] as AUC
    component [JwtAuthenticationFilter] as JAF
}

rectangle "Audit Service\n(etl.audit)" as Audit {
    component [NonPiiController] as NPC
    component [PiiController] as PC
}

rectangle "ECP Service\n(etl.ecp)" as ECP {
    component [ProxyController] as PXC
}

rectangle "Flink Production\n(etl.flink)" as Flink {
    component [App + Sinks] as FA
}

rectangle "Flink Simulation\n(etl.flink-simulation)" as FlinkSim {
    component [App + NonPiiSink + G2Sink] as FSA
}

rectangle "File Watcher\n(etl.file-watcher)" as FW {
    component [FileWatcherApplication] as FWA
}

database "PostgreSQL" as PG {
    component [common.*] as CMN
    component [public.*] as PUB
}

database "ClickHouse" as CH {
    component [platform.*] as PLT
    component [simulation.*] as SIM
}

queue "Kafka" as KF {
    component [file-events] as KFE
    component [test] as KFT
}

FUC --> PG : save file path
FW --> PG : watch dir
FW --> KFE : publish
KFE --> FA : consume
FA --> Audit : /non-pii/push
FA --> ECP : /process-data
ECP --> Audit : /pii/push
Audit --> CH : INSERT platform.*

SC --> KFT : publish uploadId
KFT --> FSA : consume
FSA --> Audit : /non-pii/push-simulation
FSA --> ECP : /process-data-simulation
ECP --> Audit : /pii/push-simulation
Audit --> CH : INSERT simulation.*

Admin --> PG : read datasets/schema
Admin --> CH : read simulation results
Auth --> PG : read/write users

@enduml
```

---

## Ghi chú cách render

Tất cả diagram trên viết theo cú pháp **PlantUML**. Để render:

1. **VS Code**: cài extension `PlantUML` + Graphviz
2. **Online**: paste vào [plantuml.com/plantuml](http://www.plantuml.com/plantuml/uml/)
3. **IntelliJ IDEA**: cài plugin `PlantUML Integration`

Copy từng block `@startuml ... @enduml` riêng lẻ để render từng diagram.
