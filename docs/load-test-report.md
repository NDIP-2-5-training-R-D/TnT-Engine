# Load Test Report — TnT Engine

**Date:** 2026-04-07
**Tool:** [hey](https://github.com/rakyll/hey)

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

**Nhận xét:** Ổn định hoàn toàn trong ~10 phút. Không có memory leak, không degradation. P99 181ms — cao hơn Docker (67ms) do port-forward overhead nhưng vẫn trong ngưỡng chấp nhận được.

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

**K8s chậm hơn ~2x** do `port-forward` thêm proxy tunnel vào mỗi request — không phải K8s kém hơn Docker.

---

## Thông số điều chỉnh được từ 2 lần test

### Đã điều chỉnh (có cơ sở từ test)

| Thông số | Trước | Sau | Căn cứ |
|---------|-------|-----|--------|
| `memory request` | 512Mi | 128Mi | Docker stats: thực tế chỉ dùng ~94MB |
| `memory limit` | 1Gi | 256Mi | Buffer 2.5x so với thực tế |

File đã cập nhật: `helm/values-prod.yaml`

### Chưa thể điều chỉnh (cần cluster thật)

| Thông số | Lý do |
|---------|-------|
| `minReplicas / maxReplicas` | Chưa biết throughput thực trên hạ tầng công ty |
| `targetCPUUtilizationPercentage` | Chưa đo CPU thực trên K8s node thật |
| `HPA trigger` | port-forward làm lệch số liệu |
| Network latency | Chưa có network thật giữa pod và OpenBao/DB |

---

## Kết luận

### Điểm mạnh (xác nhận qua test)
- Ổn định 100% ở tải bình thường (≤100 concurrent)
- Không có memory leak, không degradation theo thời gian (soak 300k requests)
- Backpressure hoạt động đúng — bảo vệ hệ thống khi overload
- Deploy thành công lên K8s, health check pass ✓

### Giới hạn xác định được
- Ngưỡng backpressure: **200 concurrent** → vượt qua bị 503
- Throughput tối đa: **~1,100–1,235 req/s** trên 1 pod (Docker local)
- Bottleneck: **OpenBao crypto layer** — throughput không tăng dù tăng concurrent

### Cần bổ sung
- Chạy lại 4 bài test trên **cluster thật** của công ty (không dùng port-forward)
- Đo `docker stats` trong lúc chạy **load test** (không chỉ soak) để có CPU baseline chính xác hơn
- Test với **HPA tự động scale** để đo throughput khi nhiều pod
- Cân nhắc tăng `backpressure threshold` nếu muốn chịu spike tốt hơn trên production
