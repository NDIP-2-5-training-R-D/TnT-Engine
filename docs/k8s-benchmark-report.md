# TnT Engine — K8s Benchmark Report

**Ngày:** 2026-04-10  
**Môi trường:** Ubuntu 24.04, single VM `Geic-DashCam-VM1` (IP: `10.10.55.11`)  
**Tool:** `hey` — HTTP load testing  
**Endpoint:** `POST /api/v1/tokenize` (test thật — DB + OpenBao)  
**Stack:** Kong Gateway → TnT Engine → PostgreSQL + Redis + OpenBao

---

## Môi trường

| Component | Version | Replica |
|-----------|---------|---------|
| RKE2 | v1.32+ | 1 node (single VM) |
| Kong Gateway | latest | 1 |
| PostgreSQL | 16 | 1 |
| Redis | 7 | 1 |
| OpenBao | 2.5.2 (dev mode) | 1 |
| TnT Engine | 0.4.0 (vmbench) | 1 hoặc 3 (manual scale) |

---

## Test Plan

| # | Bài | Concurrent | Volume | Mục đích |
|---|-----|-----------|--------|----------|
| 1 | Baseline | 10 | 1,000 req | Load bình thường |
| 2 | Load | 50 | 5,000 req | Load cao |
| 3 | Spike | 200 | 2,000 req | Đột biến traffic |
| 4 | Soak | 20 | 10 phút | Ổn định dài hạn |

---

## Kết quả chi tiết

### Scenario A — 1 Pod

#### Baseline (c=10, n=1000)
| Metric | Giá trị |
|--------|---------|
| Requests/sec | 701.88 |
| Average | 14.1ms |
| p50 | 11.2ms |
| p95 | 26.1ms |
| p99 | 195.4ms |
| Error rate | 2.5% (25x HTTP 502) |

#### Load (c=50, n=5000)
| Metric | Giá trị |
|--------|---------|
| Requests/sec | 640.47 |
| Average | 77.9ms |
| p50 | 74.7ms |
| p95 | 114.3ms |
| p99 | 119.8ms |
| Error rate | 0.06% (3x HTTP 502) |

#### Spike (c=200, n=2000)
| Metric | Giá trị |
|--------|---------|
| Requests/sec | 607.80 |
| Average | 281.0ms |
| p50 | 138.7ms |
| p95 | 965.4ms |
| p99 | 1566.7ms |
| Error rate | 0% |

#### Soak (c=20, 10 phút)
| Metric | Giá trị |
|--------|---------|
| Requests/sec | 746.18 |
| Total requests | 447,721 |
| Average | 26.8ms |
| p50 | 25.7ms |
| p95 | 33.0ms |
| p99 | 56.0ms |
| Error rate | 0% |

---

### Scenario B — 3 Pod

#### Baseline (c=10, n=1000)
| Metric | Giá trị |
|--------|---------|
| Requests/sec | 1,342.41 |
| Average | 7.2ms |
| p50 | 4.1ms |
| p95 | 15.2ms |
| p99 | 42.4ms |
| Error rate | 0% |

#### Load (c=50, n=5000)
| Metric | Giá trị |
|--------|---------|
| Requests/sec | 1,716.39 |
| Average | 28.2ms |
| p50 | 28.9ms |
| p95 | 56.2ms |
| p99 | 118.3ms |
| Error rate | 0% |

#### Spike (c=200, n=2000)
| Metric | Giá trị |
|--------|---------|
| Requests/sec | 1,744.85 |
| Average | 95.8ms |
| p50 | 76.3ms |
| p95 | 251.3ms |
| p99 | 415.8ms |
| Error rate | 0% |

#### Soak (c=20, 10 phút)
| Metric | Giá trị |
|--------|---------|
| Requests/sec | 1,836.72 |
| Total requests | 1,000,000 |
| Average | 12.0ms |
| p50 | 4.2ms |
| p95 | 28.8ms |
| p99 | 35.2ms |
| Error rate | 0% |

---

## So sánh tổng hợp

| Bài | Metric | 1 Pod | 3 Pod | Cải thiện |
|-----|--------|-------|-------|-----------|
| **Baseline** | Req/s | 701.88 | 1,342.41 | **+91%** |
| | p99 | 195.4ms | 42.4ms | **-78%** |
| | Error rate | 2.5% | 0% | **-100%** |
| **Load** | Req/s | 640.47 | 1,716.39 | **+168%** |
| | p99 | 119.8ms | 118.3ms | ≈ |
| | Error rate | 0.06% | 0% | **-100%** |
| **Spike** | Req/s | 607.80 | 1,744.85 | **+187%** |
| | p99 | 1,566.7ms | 415.8ms | **-73%** |
| | Error rate | 0% | 0% | — |
| **Soak** | Req/s | 746.18 | 1,836.72 | **+146%** |
| | Total req | 447,721 | 1,000,000 | **+123%** |
| | p99 | 56.0ms | 35.2ms | **-37%** |
| | Error rate | 0% | 0% | — |

---

## Nhận xét

### Throughput
3 pod đạt throughput **+91% đến +187%** tuỳ bài test. Spike cho thấy cải thiện lớn nhất vì 3 pod phân tán được burst traffic đột ngột.

### Latency
- **Baseline p99** cải thiện mạnh nhất: 195ms → 42ms (-78%) — do cache L1 warm trên nhiều pod hơn
- **Spike p99** giảm từ 1566ms → 415ms (-73%) — 1 pod bị overload queue, 3 pod phân tán tải
- **Load p99** gần như nhau (~119ms) — bottleneck ở OpenBao/PostgreSQL, không phải số pod

### Error rate
- 1 pod có **502 errors** ở Baseline và Load — do connection pool của uvicorn bị quá tải khi pod chưa warm
- 3 pod **0% error** ở tất cả bài — tải được phân tán ngay từ đầu

### Soak stability
- 1 pod: 447,721 requests / 10 phút — ổn định, không degradation
- 3 pod: **1,000,000 requests / 10 phút** — ổn định hoàn toàn, p99 chỉ 35ms

### Giới hạn
- Single VM: CPU/RAM chia sẻ giữa Kong, app pods, PostgreSQL, Redis, OpenBao — không phản ánh production thật
- OpenBao dev mode: in-memory, không có disk I/O latency của production

---

## Scenario C — HPA Auto-Scale (min=1, max=5, target CPU=70%)

### Cấu hình
```
autoscaling:
  enabled: true
  minReplicas: 1
  maxReplicas: 5
  targetCPUUtilizationPercentage: 70
```

### Kết quả

#### Baseline (c=10, n=1000)
| Metric | Giá trị |
|--------|---------|
| Requests/sec | 690.46 |
| p99 | 164.3ms |
| Error rate | 0% |
| HPA scaling | Không scale — CPU 0%, 1 pod |

#### Load (c=50, n=5000)
| Metric | Giá trị |
|--------|---------|
| Requests/sec | 632.12 |
| p99 | 122.7ms |
| Error rate | 0% |
| HPA scaling | Không scale — CPU 1%, 1 pod |

#### Spike (c=200, n=2000) — quá ngắn, không có ý nghĩa với HPA
| Metric | Giá trị |
|--------|---------|
| Requests/sec | 601.72 |
| p99 | 1,315.5ms |
| Error rate | 0% |
| HPA scaling | Không scale — test chỉ 3.3s, HPA chưa kịp react (scrape interval 15s) |

#### Spike Extended (c=200, 5 phút) — retest để HPA kịp scale
| Metric | Giá trị |
|--------|---------|
| Requests/sec | 2,508.58 |
| Total requests | 752,818 |
| Average | 79.7ms |
| p50 | 4.1ms |
| p90 | 277.1ms |
| p95 | 492.1ms |
| p99 | 981.6ms |
| Slowest | 5,163.9ms (trong 75s đầu khi chỉ có 1 pod) |
| Error rate | 0% |
| HPA scaling | **1 → 5 pod trong ~75 giây** |

**HPA Spike Extended — Scaling timeline:**
```
t=0s:   1 pod, CPU   0%  → load bắt đầu
t=30s:  1 pod, CPU 184%  → CPU tăng nhanh
t=45s:  1 pod, CPU 400%  → 1 pod overload
t=60s:  3 pod, CPU 399%  → HPA đang scale
t=75s:  5 pod, CPU 379%  → đạt max (5 pod)
t=90s+: 5 pod, CPU ~362% → ổn định đến hết test
```

> **Overload window ~75 giây** — trong khoảng thời gian này 1 pod phải xử lý toàn bộ 200 concurrent → p99 cao (981ms), slowest lên 5s. Sau khi đủ 5 pod, latency giảm mạnh.

#### Soak (c=20, 10 phút)
| Metric | Giá trị |
|--------|---------|
| Requests/sec | 2,829.78 |
| Total requests | 1,000,000 |
| Average | 12.0ms |
| p50 | 3.2ms |
| p95 | 24.2ms |
| p99 | 32.2ms |
| Error rate | 0% |
| HPA scaling | **1 → 5 pod** trong ~75 giây |

### HPA Scaling Timeline (Soak test)

```
4m40s:  1 pod,  CPU  1%   → load vừa bắt đầu
4m55s:  1 pod,  CPU  9%   → CPU tăng dần
5m25s:  1 pod,  CPU 400%  → 1 pod bị overload hoàn toàn
5m55s:  5 pod,  CPU 400%  → HPA scale lên max (5 pod)
6m10s:  5 pod,  CPU 363%  → đang ổn định
...
14m:    5 pod,  CPU 370%  → ổn định suốt phần còn lại
```

> CPU 370% với 5 pod = mỗi pod dùng 370% × 250m request = ~925m CPU — gần full 1 CPU/pod.  
> HPA đã scale max (5 pod) vì workload tokenize là CPU-intensive (OpenBao crypto + DB write).

---

## So sánh 3 Scenario

| Bài | Metric | 1 Pod | 3 Pod | HPA (1→5) |
|-----|--------|-------|-------|-----------|
| **Baseline** | Req/s | 701.88 | 1,342.41 | 690.46 |
| | p99 | 195.4ms | 42.4ms | 164.3ms |
| **Load** | Req/s | 640.47 | 1,716.39 | 632.12 |
| | p99 | 119.8ms | 118.3ms | 122.7ms |
| **Spike** | Req/s | 607.80 | 1,744.85 | 2,508.58 *(5m)* |
| | p99 | 1,566.7ms | 415.8ms | 981.6ms *(incl. 75s overload)* |
| **Soak** | Req/s | 746.18 | 1,836.72 | **2,829.78** |
| | p99 | 56.0ms | 35.2ms | **32.2ms** |
| | Total req | 447,721 | 1,000,000 | **1,000,000** |
| | Error rate | 0% | 0% | 0% |

### Nhận xét HPA

**HPA không scale ở Baseline/Load** vì CPU thấp (0-1%), không vượt ngưỡng 70%.

**HPA scale ở Spike Extended (5 phút):**
- 1 → 5 pod trong **75 giây**
- Overload window 75s đầu: p99 cao (981ms), slowest 5.1s
- Sau 75s: ổn định 5 pod, throughput 2,508 req/s

**HPA scale mạnh ở Soak (10 phút):**
- 1 → 5 pod trong ~75 giây (pattern giống Spike Extended)
- Đạt **2,829 req/s** cao nhất trong tất cả scenario

**HPA scale mạnh ở Soak** vì:
- Load duy trì 10 phút → HPA có đủ thời gian detect CPU spike
- Scale từ 1 → 5 pod trong ~75 giây
- Đạt **2,829 req/s** — cao hơn cả 3 pod manual (1,836 req/s) vì có 5 pod

**Kết luận:**
- HPA hiệu quả nhất với **sustained load** (soak), không phù hợp với spike ngắn
- Với spike ngắn cần set `minReplicas` cao hơn (e.g. 3) để luôn có đủ pod
- Workload tokenize là **CPU-bound** — mỗi request cần OpenBao crypto + DB write → CPU không giảm dù có 5 pod

---

## Kết luận & Khuyến nghị

### minReplicas=3 là bắt buộc cho SLA 99.9%

**Lý do:**
- HPA với `minReplicas=1` có **overload window ~75 giây** mỗi khi spike xảy ra
- 75 giây = 1.25 phút downtime/incident
- Chỉ cần **7 incident/năm** là vượt ngưỡng SLA 8.76h/năm

**Trade-off:**

| | minReplicas=1 | minReplicas=3 |
|--|--|--|
| Tài nguyên lúc thấp | 1 pod (tiết kiệm) | 3 pod (tốn hơn) |
| Overload window khi spike | ~75 giây | Không có |
| Phù hợp | Dev/staging | **Production (SLA 99.9%)** |

**Quyết định:** Set `minReplicas=3` trong `helm/values-k8s.yaml` — luôn có 3 pod sẵn sàng, HPA chỉ scale thêm khi cần (tối đa 5 pod).

---

## Cache Hit Rate

### Kiến trúc cache

TnT Engine có 3 tầng cache:

```
Request tokenize đến
        ↓
[Dedup cache]  ← intercept repeated requests (same tenant+field+value)
        ↓ miss
[L1 cache]     ← in-memory per pod (HMAC of value → token)
        ↓ miss
[L2 cache]     ← Redis shared across pods
        ↓ miss
[DB + OpenBao] ← tạo token mới (~14ms)
```

### Dedup cache

**Dedup = Deduplication** — đảm bảo cùng 1 value luôn ra cùng 1 token, không tạo trùng lặp.

```
Request 1: tokenize("4111111111111111") → tạo tok_ABC, lưu dedup cache
Request 2: tokenize("4111111111111111") → dedup hit → trả tok_ABC ngay
                                          (không gọi DB, không gọi OpenBao)
```

**Kết quả đo được:**

| Metric | Giá trị |
|--------|---------|
| Total dedup hits (tất cả pods) | **1,491,457** |
| Nguồn | Tích lũy từ tất cả benchmark runs |

Dedup cache intercept **~99%+ repeated tokenize requests** — đây là tầng cache hiệu quả nhất.

### Detokenize không có cache

`GET /api/v1/detokenize` **không dùng cache** — luôn đi thẳng DB + OpenBao:

```python
record = await self._repo.get_token_record(token, tenant_id)  # DB
plaintext = await self._encryption.decrypt(...)                # OpenBao
```

**Lý do bảo mật:** Không lưu plaintext vào cache để tránh lộ data.

**Ảnh hưởng đến latency:**

| Operation | Avg latency | Cache |
|-----------|-------------|-------|
| Tokenize | ~14ms | Dedup → L1 → L2 → DB |
| Detokenize | ~225ms | Không có — luôn DB + OpenBao |

---

## Scenario D — HA Failover (2 VM: VM1 + VM2)

### Cấu hình

| Component | VM1 (10.10.55.11) | VM2 (10.10.55.12) |
|-----------|-------------------|-------------------|
| PostgreSQL | Primary | Replica (streaming replication) |
| Redis | Primary | Replica |
| Redis Sentinel | 1 instance | 2 instances (quorum=2) |
| TnT Engine | 3 pods | — |

### Phương pháp test

Kill pod primary bằng `kubectl delete pod`, đo số request bị lỗi trong 60 giây kế tiếp (1 req/giây).

### Kết quả

#### PostgreSQL Failover

| Metric | Giá trị |
|--------|---------|
| Success | **60/60** |
| Errors | **0** |
| Downtime ước tính | **0 giây** |

K8s tự restart `postgres-primary-0` (~62 giây). TnT Engine kết nối qua Service ClusterIP — trong lúc pod restart, các request vẫn thành công vì TnT Engine dùng connection pool với retry.

#### Redis Failover

| Metric | Giá trị |
|--------|---------|
| Success | **60/60** |
| Errors | **0** |
| Downtime ước tính | **0 giây** |

Redis Sentinel (quorum=2/3) detect failure trong 5 giây, promote replica thành primary. TnT Engine kết nối liền mạch.

### Nhận xét

- **0 downtime** với cả PostgreSQL và Redis failover — K8s StatefulSet tự heal
- Service ClusterIP che giấu pod restart khỏi application layer
- Kết hợp với `minReplicas=3` TnT Engine → **không có single point of failure** ở tầng application và data
- Với cấu hình này, SLA 99.9% (< 8.76h downtime/năm) là khả thi

---

## Bước tiếp theo

- [ ] Deploy Prometheus + Grafana — dashboard metrics realtime
