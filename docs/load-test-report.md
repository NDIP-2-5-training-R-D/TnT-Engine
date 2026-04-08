# Load Test Report — TnT Engine

**Date:** 2026-04-08
**Tool:** `hey` / `wrk` (tùy môi trường)

---

## Mục đích từng bài test

| Test | Mục đích |
|------|---------|
| **Baseline** | Kiểm tra app hoạt động đúng ở tải nhẹ, đo latency cơ bản |
| **Load** | Mô phỏng tải bình thường trong production |
| **Spike** | Mô phỏng tải đột biến đột ngột (flash sale, incident...) |
| **Soak** | Chạy tải kéo dài, phát hiện memory leak / performance degradation |

---

## Lần 1 — Docker Compose (local)

**Environment:** Docker Compose — 1 máy, tất cả services chạy chung (app + PostgreSQL + Redis + OpenBao)
**Target:** `POST http://localhost:8000/api/v1/tokenize`

### Baseline
> 3,000 requests — 10 concurrent — ~30s

| Chỉ số | Giá trị |
|--------|---------|
| Requests/sec | 1,106 |
| Average | 9ms |
| P50 | 8ms |
| P95 | 12ms |
| P99 | 25ms |
| Slowest | 62ms |
| [200] Success | 3,000 (100%) |
| [5xx] Error | 0 |

### Load
> 60,000 requests — 100 concurrent — ~60s

| Chỉ số | Giá trị |
|--------|---------|
| Requests/sec | 1,133 |
| Average | 88ms |
| P50 | 82ms |
| P95 | 115ms |
| P99 | 131ms |
| Slowest | 699ms |
| [200] Success | 60,000 (100%) |
| [5xx] Error | 0 |

### Spike
> 30,000 requests — 500 concurrent — ~30s

| Chỉ số | Giá trị |
|--------|---------|
| Requests/sec | 2,712 |
| Average | 117ms |
| P50 | 29ms |
| P95 | 476ms |
| P99 | 1,003ms |
| Slowest | 5,432ms |
| [200] Success | 8,304 (28%) |
| [503] Backpressure | 21,696 (72%) |

### Soak
> 300,000 requests — 50 concurrent — ~4 phút

| Chỉ số | Giá trị |
|--------|---------|
| Requests/sec | 1,235 |
| Average | 40ms |
| P50 | 38ms |
| P95 | 61ms |
| P99 | 67ms |
| Slowest | 523ms |
| [200] Success | 300,000 (100%) |
| [5xx] Error | 0 |

### Resource usage (docker stats trong lúc soak test)

| Chỉ số | Giá trị |
|--------|---------|
| CPU | ~92% (của 1 core) |
| Memory used | 93.77 MiB |
| Memory limit | 7.61 GiB (toàn bộ RAM máy) |
| Memory % | 1.2% |

### Tổng hợp Lần 1

| Test | Concurrent | Req/s | P99 | Success |
|------|-----------|-------|-----|---------|
| Baseline | 10 | 1,106 | 25ms | 100% |
| Load | 100 | 1,133 | 131ms | 100% |
| Spike | 500 | 2,712 | 1,003ms | 28% |
| Soak | 50 | 1,235 | 67ms | 100% |

---

## Lần 2 — K8s local (Docker Desktop)

**Environment:** K8s Docker Desktop — 3 pods, truy cập qua `kubectl port-forward`
**Target:** `POST http://localhost:8080/api/v1/tokenize`
**Lưu ý:** Kết quả bị ảnh hưởng bởi overhead của `kubectl port-forward` — **không phản ánh hiệu năng thực của K8s production**.

### Baseline

| Chỉ số | Giá trị |
|--------|---------|
| Requests/sec | 514 |
| Average | 19ms |
| P99 | 67ms |
| [200] Success | 3,000 (100%) |

### Load

| Chỉ số | Giá trị |
|--------|---------|
| Requests/sec | 459 |
| Average | 217ms |
| P99 | 301ms |
| [200] Success | 60,000 (100%) |

### Spike

| Chỉ số | Giá trị |
|--------|---------|
| Requests/sec | 1,261 |
| Average | 242ms |
| P99 | 3,927ms |
| Slowest | 10,439ms |
| [200] Success | 6,306 (21%) |
| [503] Backpressure | 23,694 (79%) |

### Soak
> 300,000 requests — 50 concurrent — ~10 phút

| Chỉ số | Giá trị |
|--------|---------|
| Requests/sec | 502 |
| Average | 99ms |
| P50 | 97ms |
| P95 | 164ms |
| P99 | 181ms |
| Slowest | 1,095ms |
| [200] Success | 300,000 (100%) |
| [5xx] Error | 0 |

**Nhận xét:** Ổn định hoàn toàn trong ~10 phút trong môi trường local. P99 181ms cao hơn Docker (67ms), nhưng số liệu này vẫn bị ảnh hưởng bởi `kubectl port-forward`, nên chỉ dùng để tham khảo sơ bộ.

### Tổng hợp Lần 2

| Test | Concurrent | Req/s | P99 | Success |
|------|-----------|-------|-----|---------|
| Baseline | 10 | 514 | 67ms | 100% |
| Load | 100 | 459 | 301ms | 100% |
| Spike | 500 | 1,261 | 3,927ms | 21% |
| Soak | 50 | 502 | 181ms | 100% |

---

## So sánh Docker vs K8s local

| Test | Docker req/s | K8s req/s | Docker P99 | K8s P99 |
|------|-------------|-----------|------------|---------|
| Baseline | 1,106 | 514 | 25ms | 67ms |
| Load | 1,133 | 459 | 131ms | 301ms |
| Spike | 2,712 | 1,261 | 1,003ms | 3,927ms |
| Soak | 1,235 | 502 | 67ms | 181ms |

**Lưu ý:** K8s local trong bài test này chậm hơn Docker local, nhưng chưa thể quy kết cho Kubernetes vì đường truy cập đang đi qua `kubectl port-forward`.

---

## Lần 3 — Docker trên VM GEIC

**Environment:** Docker Compose trên VM GEIC, tất cả services chạy cùng VM  
**Target:** `POST http://localhost:8000/api/v1/tokenize`  
**Tool:** `wrk`  
**Lưu ý:** Đây là số liệu trên VM thật, nhưng vẫn chưa phải benchmark production-like qua K8s + Ingress/LB. Benchmark K8s sẽ chỉ được cập nhật sau khi hoàn tất toàn bộ flow triển khai và kiểm tra dependency trong cluster.

### Baseline

| Chỉ số | Giá trị |
|--------|---------|
| Requests/sec | 871.50 |
| Average | 9.73ms |
| Max | 193.92ms |
| Success rate | ~100% |

**Peak resource quan sát được:**
- `tnt-engine`: CPU ~122.64%, RAM ~90.36 MiB

### Load

| Chỉ số | Giá trị |
|--------|---------|
| Requests/sec | 716.68 |
| Average | 140.58ms |
| Max | 820.47ms |
| Success rate | ~100% |

**Peak resource quan sát được:**
- `tnt-engine`: CPU ~112.98%, RAM ~107.5 MiB
- Từ raw `docker stats` log:
  `openbao` ~30-31 MiB, `postgres` ~106-107 MiB, `redis` ~4.5-5.5 MiB

### Spike

| Chỉ số | Giá trị |
|--------|---------|
| Requests/sec | 4,661.68 |
| Average | 243.66ms |
| Max | 1.95s |
| Timeout | 172 |
| Non-2xx/3xx | 133,762 |
| Success rate | ~4.5% |

**Peak resource quan sát được:**
- `tnt-engine`: CPU ~101.93%, RAM ~107.5 MiB

### Soak

| Chỉ số | Giá trị |
|--------|---------|
| Requests/sec | 789.62 |
| Average | 60.78ms |
| Max | 205.07ms |
| Success rate | ~100% |

**Peak resource quan sát được:**
- `tnt-engine`: CPU ~131.26%, RAM ~110.2 MiB

### Tổng hợp Lần 3

| Test | Concurrent | Req/s | Average | Success |
|------|-----------|-------|---------|---------|
| Baseline | 10 | 871.50 | 9.73ms | ~100% |
| Load | 100 | 716.68 | 140.58ms | ~100% |
| Spike | 500 | 4,661.68 | 243.66ms | ~4.5% |
| Soak | 50 | 789.62 | 60.78ms | ~100% |

**Nhận xét:** Benchmark trên VM xác nhận app ổn ở tải baseline/load/soak, nhưng spike vẫn shed/lỗi rất mạnh. Peak RAM của riêng `tnt-engine` trên VM lên khoảng `90-110 MiB`, nên chưa có cơ sở hạ memory production xuống mức quá sát ngưỡng.

---

## Phạm vi áp dụng của kết quả hiện tại

Các số liệu trong tài liệu này mới phản ánh:

- Docker Compose local.
- Kubernetes local.
- Docker Compose trên VM GEIC.
- Truy cập qua `localhost` hoặc `kubectl port-forward`.

**Chưa bao gồm:**

- benchmark qua K8s + Ingress trên VM GEIC
- benchmark với full dependency path hoàn chỉnh trong cluster

Các số liệu này **đã tốt hơn local-only**, nhưng vẫn chưa đủ cơ sở để chốt production sizing vì còn thiếu:

- network thật giữa app, OpenBao, PostgreSQL, Redis;
- ingress/load balancer thật;
- CPU/RAM thật của VM triển khai;
- ảnh hưởng của Kubernetes service routing và resource contention;
- hành vi thực của OpenBao/DB/cache khi tách node.

---

## Thông số chỉ nên xem là tạm thời

### Đã quan sát được từ local test

| Thông số | Trước | Sau | Căn cứ |
|---------|-------|-----|--------|
| `memory request` | 512Mi | 128Mi | Docker stats: thực tế chỉ dùng ~94MB |
| `memory limit` | 1Gi | 256Mi | Buffer 2.5x so với thực tế |

**Trạng thái:** Không nên áp dụng trực tiếp cho production trước khi benchmark lại trên VM/cluster thật.

### Quan sát sơ bộ từ test scale local

| Thông số | Giá trị | Căn cứ |
|---------|---------|--------|
| `minReplicas` | 5 | Test spike 5 pods → 48.7% success (từ 28%) |

**Trạng thái:** Đây là quan sát định hướng, chưa phải cấu hình production cuối cùng.

### Chưa thể điều chỉnh (cần cluster thật)

| Thông số | Lý do |
|---------|-------|
| `maxReplicas` | Chưa biết throughput thực trên hạ tầng công ty |
| `targetCPUUtilizationPercentage` | App I/O bound — CPU 3% khi spike, HPA CPU không phù hợp |
| `HPA custom metric` | Cần KEDA hoặc Prometheus Adapter, chưa setup |
| Network latency | Chưa có network thật giữa pod và OpenBao/DB |

---

## Kết luận tạm thời

### Điều đã quan sát được từ local + VM
- Ổn định ở tải bình thường trong local test và VM test.
- Chưa thấy dấu hiệu memory leak rõ ràng trong soak test local và VM.
- Backpressure hoạt động đúng theo hướng bảo vệ hệ thống khi overload.
- Benchmark trên VM cho số liệu thực tế hơn local laptop.

### Giả thuyết cần xác nhận thêm trên VM/cluster thật
- Ngưỡng backpressure `200 concurrent` có thể hợp lý cho HTTP request/response thông thường.
- Throughput trên VM của 1 instance hiện nằm khoảng `~700–870 req/s` ở baseline/load/soak.
- Spike trên VM cho success rate rất thấp (`~4.5%`), nên cần đo tiếp trên K8s/Ingress để xác định bottleneck chính xác.
- OpenBao, PostgreSQL và network path vẫn cần được tách ra đo rõ hơn trên hạ tầng thật.

### Cần bổ sung
- Chạy lại 4 bài test qua **LoadBalancer hoặc Ingress** trên K8s/cluster thật.
- Đo resource đầy đủ của app, OpenBao, PostgreSQL, Redis trong lúc chạy benchmark.
- Hoàn tất luồng triển khai K8s trước khi ghi nhận số liệu benchmark K8s vào tài liệu này.
- Xác nhận lại memory sizing trước khi giảm `requests/limits` cho production.
- Tách rõ nguyên nhân spike fail: backpressure app, OpenBao, DB hay network path.
- Chỉ quyết định HPA theo CPU hay custom metric sau khi có số đo thật trên cluster.
- Đánh giá tăng CPU/RAM hoặc cấu hình cluster cho OpenBao trước khi nghĩ đến sharding tenant.

---

## Cải thiện Spike — Kết quả 3 hướng test

### Bối cảnh
Spike test local cho thấy tỉ lệ thành công chỉ 28% (1 pod, Docker). Benchmark VM còn thấp hơn, khoảng `~4.5% success` ở 500 concurrent. Điều này cho thấy hệ thống hiện chưa chịu burst tốt trên môi trường VM, nhưng vẫn cần benchmark qua K8s/Ingress để tách rõ bottleneck.

### Hướng 1 — Tăng backpressure threshold (đã test, bác bỏ)

**Thay đổi:** `TNT_MAX_CONCURRENT=400` (mặc định 200)

| Chỉ số | Threshold 200 | Threshold 400 |
|--------|--------------|--------------|
| Success | 8,304 (28%) | 6,479 (21.6%) |
| P99 | 1,003ms | 5,434ms |
| Req/s | 2,712 | 1,233 |
| Connection reset | 0 | ~170 lỗi |

**Kết luận tạm thời:** Trong local test, tăng threshold làm kết quả xấu hơn. Tạm thời chưa có cơ sở tăng ngưỡng này trước khi benchmark lại trên VM.

---

### Hướng 2 — Tăng minReplicas (đã test, hiệu quả nhất)

**Thay đổi:** `minReplicas: 2` → `5`, test trên K8s local với LoadBalancer (không dùng port-forward)

| Chỉ số | 1 pod | 5 pods |
|--------|-------|--------|
| Success | 8,304 (28%) | 14,618 (48.7%) |
| P99 | 1,003ms | 2,397ms |
| Req/s | 2,712 | 1,411 |
| Connection reset | 0 | 0 |

**Kết luận tạm thời:** Success rate tăng đáng kể trong local K8s test. Tuy nhiên vẫn cần xác nhận lại trên hạ tầng thật trước khi chốt `minReplicas` cho production.

---

### Hướng 3 — HPA scale nhanh hơn (đã test, không hiệu quả)

**Thay đổi:** `stabilizationWindowSeconds: 30` → `0`, `periodSeconds: 60` → `15`, bắt đầu từ 2 pod

| Chỉ số | Giá trị |
|--------|---------|
| Success | 13,625 (45%) |
| CPU trong lúc spike | 3% (không vượt ngưỡng 70%) |
| HPA scale up | Không xảy ra |

**Kết luận:** HPA không kích hoạt vì app là **I/O bound** — khi spike, app chủ yếu đợi OpenBao trả lời, không tốn CPU. HPA CPU-based không phù hợp với workload này. Cần scale theo custom metric `tnt_inflight_requests` (đã export qua Prometheus) — cần KEDA hoặc Prometheus Adapter để implement.

---

### Tổng kết

| Hướng | Success rate | Kết quả |
|-------|-------------|---------|
| 1 pod, threshold 200 (gốc) | 28% | Baseline |
| Tăng threshold 400 | 21.6% | Tệ hơn — bác bỏ |
| **5 pods, threshold 200** | **48.7%** | **Tốt nhất** |
| 2 pods + HPA CPU | ~45% | HPA không trigger |

**Khuyến nghị hiện tại:** Chưa chốt tuning production chỉ từ local test. Ưu tiên benchmark tiếp trên K8s/Ingress thật trước khi quyết định `minReplicas`, HPA hay scale OpenBao.

---

## Lộ trình tối ưu production

Cache hit rate — yếu tố quyết định có cần scale OpenBao hay không — chỉ đo được khi có **data thực từ production** (cùng số CMND, số điện thoại được tokenize nhiều lần). Trên local test, data random 100% → cache miss 100% → không phản ánh thực tế.

**Thứ tự đúng:**

1. Lên cluster công ty với `minReplicas: >= 5`
2. Chạy với data thực một thời gian
3. Đo cache hit rate qua Prometheus (metric `tnt_cache_hits_total` / `tnt_cache_requests_total` đã có sẵn)
4. Nếu hit rate cao → OpenBao không phải vấn đề, không cần scale
5. Nếu hit rate thấp + OpenBao vẫn là bottleneck → implement sharding theo tenant

Tránh over-engineering trước khi có data thực.
