# Báo cáo phân tích: `ndip25.etl.file-watcher`

> **Ngày:** 2026-04-14
> **Module:** `ndip25.etl.file-watcher` — File Watcher Service cho hệ thống NDIP25

---

## 1. Tổng quan

`ndip25.etl.file-watcher` là **service giám sát thư mục** — phát hiện file XML mới xuất hiện trên filesystem, đảm bảo file đã ghi xong (stable), sau đó publish event lên Kafka để Flink xử lý.

| Thông tin | Chi tiết |
|---|---|
| **Vai trò** | Đầu vào của pipeline ETL — cầu nối giữa filesystem và Kafka |
| **Output** | Kafka topic `file-events` |
| **Consumer** | `ndip25.etl.flink` |

**Build:** Maven | **Java:** 17 | **Version:** 1.0.0
**Framework:** Spring Boot 4.1.0-SNAPSHOT (chỉ dùng Kafka + Lombok, không có web server)

Để build và chạy:
```bash
mvn clean package -DskipTests
java -Dconfig.file=/path/to/config.properties -jar target/*.jar
```

---

## 2. Phân lớp kiến trúc

```
ndip25.etl.file-watcher/
│
├── FileWatcherApplication.java   ← Toàn bộ logic (main class, ~255 lines)
└── ultis/Contants.java           ← 2 constant string (config key names)

src/main/resources/
└── application.properties        ← Config: watch.dir, kafka, debounce, ignore
```

Project này **cực kỳ gọn** — toàn bộ logic nằm trong 1 class duy nhất, không có Controller/Service/Repository. Không phụ thuộc vào `ndip25.api.common`.

---

## 3. Cấu hình (`application.properties`)

```properties
# Thư mục gốc cần giám sát (đệ quy tất cả subfolder)
watch.dir=C:\\ndip\\data

# Debounce: chờ file ổn định trước khi gửi Kafka (milliseconds)
stable.delay.ms=1000

# Kafka
kafka.bootstrap.servers=10.6.8.37:9092
kafka.topic=file-events

# Bỏ qua file tạm
ignore.suffix=.tmp,.part,.swp
```

**Ưu tiên load config:**
```
1. External file: java -Dconfig.file=/etc/ndip/watcher.properties -jar ...
2. Classpath:     src/main/resources/application.properties  (mặc định)
```

Nếu không tìm thấy config → throw `IllegalStateException` và dừng ngay.

---

## 4. Các thành phần chính

### 4.1 Static fields — Trạng thái toàn cục

```java
// Config
private static String  WATCH_DIR;       // Thư mục giám sát
private static String  KAFKA_BOOTSTRAP; // Kafka broker address
private static String  TOPIC;           // Kafka topic name
private static long    STABLE_DELAY_MS; // Debounce delay (ms)
private static Set<String> IGNORE_SUFFIX; // Suffix file bỏ qua

// Runtime state
private static final Map<Path, ScheduledFuture<?>> PENDING
    = new ConcurrentHashMap<>();         // Debounce tracker: file → scheduled task

private static final ScheduledExecutorService SCHEDULER
    = Executors.newScheduledThreadPool(4); // 4 thread xử lý song song

private static KafkaProducer<String, String> producer; // Kafka producer
```

---

### 4.2 `loadConfig()` — Đọc cấu hình

Kiểm tra system property `-Dconfig.file`, nếu có thì đọc từ file ngoài, không thì đọc từ classpath. Các key bắt buộc phải có (dùng `require()` — throw nếu thiếu):

```
watch.dir, stable.delay.ms, kafka.bootstrap.servers, kafka.topic, ignore.suffix
```

---

### 4.3 `initKafkaProducer()` — Kafka Producer

```java
props.put(ACKS_CONFIG,             "all");  // Chờ tất cả replica xác nhận
props.put(RETRIES_CONFIG,          5);      // Retry 5 lần khi lỗi
props.put(ENABLE_IDEMPOTENCE_CONFIG, true); // Chống duplicate khi retry
```

`enable.idempotence=true` kết hợp `acks=all` → **exactly-once semantics** cho producer: dù retry bao nhiêu lần, message chỉ được ghi vào Kafka đúng 1 lần.

**Shutdown hook:**
```java
Runtime.getRuntime().addShutdownHook(new Thread(() -> {
    producer.close();    // Flush hết message đang pending
    SCHEDULER.shutdown(); // Dừng 4 debounce threads
}));
```
Khi `Ctrl+C` hoặc `kill`, producer flush xong mới tắt → không mất message.

---

### 4.4 `startWatcher()` — Vòng lặp giám sát chính

```
1. registerAll(rootDir, watchService)
   → Files.walk(rootDir) tìm tất cả subfolder
   → Mỗi folder đăng ký 2 event: ENTRY_CREATE + ENTRY_MODIFY

2. while(true):
   WatchKey key = watchService.take()  ← BLOCK tại đây, đợi event
   
   for each event:
     if OVERFLOW   → skip (event queue bị tràn)
     if Directory  → registerAll(newDir) ← tự động watch folder mới
     if File:
       shouldIgnore() → skip .tmp, .part, .swp
       scheduleStabilityCheck(file)  ← debounce
   
   key.reset()  ← bắt buộc để tiếp tục nhận event
```

**Tại sao phải `registerAll` đệ quy?**
`WatchService` chỉ watch directory, không watch subfolder tự động. Phải gọi `registerAll` lại mỗi khi phát hiện thư mục con mới được tạo.

---

### 4.5 `scheduleStabilityCheck()` — Debounce + Kiểm tra ổn định

**Vấn đề:** File XML lớn ghi từng chunk → OS bắn hàng chục `ENTRY_MODIFY` liên tiếp. Nếu gửi Kafka ngay → Flink đọc file khi chưa ghi xong.

**Giải pháp — Double-check stability:**

```java
void scheduleStabilityCheck(Path file) {
    // Cancel schedule cũ nếu có → debounce
    ScheduledFuture<?> old = PENDING.get(file);
    if (old != null) old.cancel(false);

    // Tạo schedule mới sau STABLE_DELAY_MS
    ScheduledFuture<?> future = SCHEDULER.schedule(() -> {
        long size1 = Files.size(file);
        long mod1  = Files.getLastModifiedTime(file).toMillis();

        Thread.sleep(STABLE_DELAY_MS);  // Chờ thêm 1 lần nữa

        long size2 = Files.size(file);
        long mod2  = Files.getLastModifiedTime(file).toMillis();

        if (size1 == size2 && mod1 == mod2) {
            sendKafkaEvent(file, size2, mod2);  // ✅ File ổn định → gửi
        }
        // Nếu khác nhau → file vẫn đang ghi → không làm gì
        // Event MODIFY tiếp theo sẽ reschedule
        PENDING.remove(file);
    }, STABLE_DELAY_MS, TimeUnit.MILLISECONDS);

    PENDING.put(file, future);
}
```

**Timeline ví dụ — file đang ghi 800ms:**
```
T=0ms    ENTRY_CREATE file.xml  → PENDING: {file → task@T+1000ms}
T=300ms  ENTRY_MODIFY file.xml  → cancel task cũ → PENDING: {file → task@T+1300ms}
T=700ms  ENTRY_MODIFY file.xml  → cancel task cũ → PENDING: {file → task@T+1700ms}
T=800ms  (ghi xong, không có event mới)

T=1700ms Check lần 1: size1=102400, mod1=800ms
         sleep 1000ms
T=2700ms Check lần 2: size2=102400, mod2=800ms
         size1==size2 && mod1==mod2 → GỬI KAFKA ✅
```

**`ConcurrentHashMap` PENDING** — thread-safe vì `SCHEDULER` có 4 thread chạy song song, nhiều file có thể được check cùng lúc.

---

### 4.6 `sendKafkaEvent()` — Publish Kafka message

```java
Map<String, Object> payload = new HashMap<>();
payload.put("eventType",    "FILE_READY");
payload.put("filePath",     "/data/CO8/file.xml");  // đường dẫn tuyệt đối
payload.put("fileName",     "file.xml");
payload.put("fileSize",     102400);
payload.put("lastModified", 1710701400000L);
payload.put("eventTime",    "2026-04-14T10:30:00.123Z");
payload.put("source",       "CO8");                 // ← từ extractSource()

// Key = filePath → cùng file luôn vào cùng Kafka partition
producer.send(new ProducerRecord<>(TOPIC, file.toString(), json), callback);
```

Kafka message (JSON):
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

---

### 4.7 `extractSource()` — Xác định nguồn dữ liệu

```java
// watch.dir = C:\ndip\data
// file path  = C:\ndip\data\CO8\subdir\2026\file.xml
// relative   = CO8\subdir\2026\file.xml
// source     = "CO8"  ← folder cấp 1 = mã nguồn dữ liệu

// File ngay trong root: C:\ndip\data\file.xml → source = "UNKNOWN"
```

`source` được Flink dùng để filter: chỉ xử lý file từ nguồn `CO8`.

---

### 4.8 `shouldIgnore()` — Lọc file không cần xử lý

```java
boolean shouldIgnore(Path file) {
    String name = file.getFileName().toString().toLowerCase();
    return IGNORE_SUFFIX.stream().anyMatch(name::endsWith);
}
// Bỏ qua: .tmp (file đang tạo), .part (download chưa xong), .swp (vim swap file)
```

---

## 5. Luồng dữ liệu đầy đủ

```
FileSystem (C:\ndip\data\CO8\*.xml)
    │
    │  OS event: ENTRY_CREATE / ENTRY_MODIFY
    ▼
WatchService.take()  ← block loop
    │
    ├── OVERFLOW?      → skip
    ├── isDirectory?   → registerAll(newDir) → tiếp tục watch
    ├── shouldIgnore?  → skip (.tmp, .part, .swp)
    │
    ▼
scheduleStabilityCheck(file)
    │
    ├── Cancel task cũ (debounce)
    └── Schedule task mới sau 1000ms
              │
              ▼ (sau 1000ms)
         Đọc size1, mod1
         sleep(1000ms)
         Đọc size2, mod2
              │
              ├── size1 != size2 || mod1 != mod2 → File vẫn đang ghi → bỏ qua
              │
              └── size1 == size2 && mod1 == mod2 → FILE STABLE ✅
                        │
                        ▼
                  extractSource(file) → "CO8"
                  Build JSON payload
                  KafkaProducer.send(topic="file-events", key=filePath, value=json)
                        │
                        ▼
                  Kafka topic: file-events
                        │
                        ▼
                  ndip25.etl.flink (consumer)
```

---

## 6. Kết nối với service tiếp theo

`ndip25.etl.flink` consume từ topic `file-events`, đọc field `filePath` để tìm file trên disk và field `source` để filter:

```java
// Flink: MinioXmlFetcher
FileContentDto {
    pathFile: "C:\\ndip\\data\\CO8\\data_20260414.xml",
    source:   "CO8"
}
// → Chỉ tiếp tục nếu source.contains("CO8")
```

---

## 7. Điểm đáng chú ý

### Design decisions

| Quyết định | Lý do |
|---|---|
| Debounce bằng `ConcurrentHashMap<Path, ScheduledFuture>` | Thread-safe, cancel được task cũ mỗi khi có event mới |
| Double-check stability (đọc 2 lần cách nhau 1s) | Đề phòng trường hợp file vừa vặn không có event trong khoảng debounce nhưng vẫn đang ghi |
| `registerAll` đệ quy + tự re-register khi tạo folder mới | `WatchService` không tự watch subfolder — phải tự handle |
| Kafka key = filePath | Cùng file luôn đến cùng partition → Flink xử lý đúng thứ tự |
| `enable.idempotence=true` + `acks=all` | Exactly-once producer: không mất, không trùng |
| `ScheduledThreadPool(4)` | 4 file có thể đang trong giai đoạn check ổn định song song |
| Source = tên folder cấp 1 | Convention đặt data theo `{watch.dir}/{source}/...` → không cần config thêm |
| Không dùng Spring Bean | Toàn bộ là `static` — application đơn giản, không cần IoC |

### Giới hạn hiện tại

| Vấn đề | Mô tả |
|---|---|
| **Không có retry khi Kafka down** | Nếu Kafka không kết nối được, event bị mất (chỉ log error) |
| **Không có dedup** | Nếu service restart khi file đang trong PENDING, có thể gửi event trùng |
| **Single process** | Không có clustering — chỉ chạy 1 instance |
| **Không xác nhận Flink xử lý xong** | Fire-and-forget, không biết Flink có xử lý thành công không |

---

## 8. Dependencies (`pom.xml`)

| Dependency | Version | Mục đích |
|---|---|---|
| `spring-boot-starter-kafka` | 4.1.0 | Kafka client |
| `jackson-databind` | 2.21.0 | Serialize payload thành JSON |
| `lombok` | - | `@Log4j2` annotation |
| `commons-codec` | 1.16.0 | Có trong pom nhưng chưa dùng |
| Java NIO `WatchService` | JDK 17 | File system monitoring |