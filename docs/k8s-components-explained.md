# Giải thích thuật ngữ & cách hoạt động — K8s HA Stack

**Ngày**: 2026-04-09  
**Mục đích**: Giải thích toàn bộ thuật ngữ và cơ chế hoạt động của các component trong hệ thống T&T Engine triển khai trên Kubernetes

---

## Mục lục

1. [Kubernetes cơ bản](#1-kubernetes-cơ-bản)
2. [RKE2](#2-rke2)
3. [Kong & KIC](#3-kong--kic)
4. [Redis Sentinel](#4-redis-sentinel)
5. [OpenBao Raft](#5-openbao-raft)
6. [PostgreSQL & Patroni](#6-postgresql--patroni)
7. [HPA và PDB](#7-hpa-và-pdb)
8. [Observability](#8-observability)
9. [Toàn cảnh hệ thống](#9-toàn-cảnh-hệ-thống)

---

## 1. Kubernetes cơ bản

### Node
Một máy chủ (vật lý hoặc VM) tham gia vào cluster Kubernetes.

```
Cluster = tập hợp nhiều Node
Node    = 1 máy chủ chạy các ứng dụng
```

Có 2 loại node:
- **Control Plane Node** (server): não của cluster — quyết định chạy gì, ở đâu
- **Worker Node** (agent): tay chân — thực sự chạy ứng dụng

---

### Pod
Đơn vị nhỏ nhất trong K8s. Một Pod chứa 1 hoặc nhiều container.

```
Node
└── Pod
    └── Container (ví dụ: tnt-engine process)
```

Pod có thể chết và được tạo lại. Mỗi lần tạo lại thì IP thay đổi → đó là lý do cần Service.

---

### Deployment
Bản mô tả "tôi muốn chạy N bản sao của ứng dụng X". K8s đọc Deployment rồi tự tạo đúng số Pod.

```
Deployment (muốn 3 pod)
├── Pod 1  (đang chạy)
├── Pod 2  (đang chạy)
└── Pod 3  (đang chạy)

Pod 2 chết → K8s tự tạo Pod 4 để bù vào
```

---

### StatefulSet
Giống Deployment nhưng dành cho ứng dụng có **state** (dữ liệu). Mỗi Pod có tên cố định và storage riêng.

```
StatefulSet (PostgreSQL)
├── postgres-0  (Primary)   ← tên không đổi dù restart
├── postgres-1  (Replica 1)
└── postgres-2  (Replica 2)
```

Khác Deployment ở chỗ: Pod có tên cố định, storage gắn với Pod đó, không bị xáo trộn khi restart.

---

### Service
Địa chỉ IP cố định đứng trước các Pod. Client gọi Service, Service chuyển tới Pod nào đang sống.

```
Client → Service (IP cố định: 10.96.0.1)
              ├── Pod 1 (IP: 10.244.1.5)
              ├── Pod 2 (IP: 10.244.2.3)
              └── Pod 3 (IP: 10.244.3.7)
```

Tại sao cần Service? Vì Pod chết/tái tạo thì IP đổi. Service giúp client không cần biết IP thật của Pod.

---

### Ingress
Cổng vào từ bên ngoài vào cluster. Định nghĩa rule: URL nào → Service nào.

```
Internet
   ↓
Ingress (rule: /api → tnt-engine-service)
   ↓
Service
   ↓
Pod
```

---

### ConfigMap / Secret

- **ConfigMap**: lưu config (biến môi trường, file config) dưới dạng plaintext
- **Secret**: lưu thông tin nhạy cảm (password, token) — base64 encoded, giới hạn quyền truy cập

---

### Namespace
Cách chia "phòng" trong cluster. Các namespace tách biệt nhau về network, quota, quyền truy cập.

```
Cluster
├── namespace: gateway        (Kong)
├── namespace: tnt-engine     (App)
├── namespace: data           (PostgreSQL, Redis, OpenBao)
└── namespace: observability  (Prometheus, Grafana, Loki)
```

---

### etcd
Database phân tán lưu toàn bộ trạng thái của K8s cluster (có bao nhiêu Pod, chúng đang ở đâu, config là gì...).

```
etcd = "bộ nhớ" của cluster
→ etcd mất = cluster không biết mình đang làm gì
→ Phải chạy HA (3 node)
```

---

### Quorum
Số node tối thiểu phải còn sống thì cluster mới được phép hoạt động và ra quyết định.

```
Công thức: quorum = floor(n / 2) + 1

n = 3  →  quorum = 2  →  chịu được mất 1 node ✅
n = 5  →  quorum = 3  →  chịu được mất 2 node ✅
n = 2  →  quorum = 2  →  mất 1 là mất luôn   ❌
```

Tại sao cần quorum? Để tránh **split-brain**: 2 node bị tách mạng, mỗi bên nghĩ mình là leader, ghi data khác nhau → data corrupt. Quorum đảm bảo chỉ 1 bên có đủ phiếu để hoạt động.

---

## 2. RKE2

### RKE2 là gì?
Rancher Kubernetes Engine 2 — một bản phân phối Kubernetes dành cho production. Cài K8s lên các máy chủ kèm theo hardening bảo mật sẵn.

```
RKE2 = Kubernetes + bảo mật cứng (CIS Benchmark) + etcd nhúng sẵn + FIPS 140-2
```

### Control Plane Node (Server Node)
Node chạy các thành phần điều khiển cluster:

| Thành phần | Vai trò |
|---|---|
| **API Server** | Cổng giao tiếp duy nhất với cluster. Mọi lệnh `kubectl` đều đi qua đây |
| **etcd** | Lưu trạng thái cluster |
| **Scheduler** | Quyết định Pod mới chạy trên Worker nào |
| **Controller Manager** | Liên tục kiểm tra: "thực tế có khớp với mong muốn không?" |

### Worker Node (Agent Node)
Node chạy ứng dụng thực sự. Chứa:

| Thành phần | Vai trò |
|---|---|
| **kubelet** | Nhận lệnh từ API Server, quản lý Pod trên node này |
| **kube-proxy** | Xử lý network routing cho Service |
| **containerd** | Container runtime — thực sự chạy container |

### Cách hoạt động tổng thể

```
Bạn chạy: kubectl apply -f deployment.yaml
              ↓
         API Server nhận lệnh → lưu vào etcd
              ↓
         Scheduler thấy "có Pod mới cần chạy"
         → Chọn Worker Node phù hợp (đủ CPU/RAM, không quá tải)
              ↓
         kubelet trên Worker nhận lệnh
         → Pull image → Chạy container
              ↓
         Controller Manager liên tục kiểm tra
         "Pod đang chạy 3/3? Nếu không → tạo thêm"
```

### Load Balancer trước Control Plane
Vì có 3 CP node, cần 1 LB đứng trước để:
- Client/Worker không cần biết node nào đang là "chính"
- Nếu 1 CP node chết, LB tự chuyển traffic sang 2 node còn lại

```
kubectl / Worker Node
         ↓
[Load Balancer]
 :9345 (registration)
 :6443 (K8s API)
         ↓
  ┌──────┼──────┐
 CP1    CP2    CP3
etcd   etcd   etcd
```

### CNI (Container Network Interface)
Plugin quản lý network giữa các Pod và Node.

| CNI | NetworkPolicy | eBPF | Ghi chú |
|---|---|---|---|
| Flannel | ❌ | ❌ | Đơn giản nhất, không dùng cho production bảo mật |
| Canal | ✅ | ❌ | Mặc định của RKE2 (Flannel + Calico) |
| **Cilium** | ✅ | ✅ | Khuyến nghị cho production — hiệu năng cao, có Hubble observability |
| Calico | ✅ | Một phần | Ổn định, phổ biến |

**Khuyến nghị: Cilium** — dùng eBPF thay iptables, nhanh hơn và hỗ trợ NetworkPolicy đầy đủ.

### NetworkPolicy
Tường lửa nội bộ trong K8s — kiểm soát Pod nào được nói chuyện với Pod nào.

```yaml
# Ví dụ: chỉ cho Kong gọi vào tnt-engine
ingress:
- from:
  - namespaceSelector:
      matchLabels:
        name: gateway
```

### Topology RKE2 cluster tối thiểu cho SLA 99.9%

```
                    [External Load Balancer]
                    Port 9345 + 6443 → CP nodes
                            ↓
         ┌──────────────────┼──────────────────┐
    [CP Node 1]        [CP Node 2]        [CP Node 3]
    etcd + API         etcd + API         etcd + API
         └──────────────────┼──────────────────┘
                            ↓ (schedule workloads)
         ┌──────────────────┼──────────────────┐
   [Worker Node 1]   [Worker Node 2]   [Worker Node 3]
    Kong, App pods    Kong, App pods    Kong, App pods
```

### Ports bắt buộc mở giữa các node

| Port | Protocol | Chiều | Mục đích |
|---|---|---|---|
| 9345 | TCP | Agent → CP | RKE2 node registration |
| 6443 | TCP | All → CP | Kubernetes API Server |
| 2379 | TCP | CP → CP | etcd client requests |
| 2380 | TCP | CP → CP | etcd peer communication |
| 10250 | TCP | CP → Worker | Kubelet API |
| 10255 | TCP | CP → Worker | Kubelet read-only |
| 4789 | UDP | All → All | CNI VXLAN overlay (Cilium) |

---

## 3. Kong & KIC

### Kong Gateway
API Gateway — proxy đứng giữa client và ứng dụng. Thực hiện:

| Chức năng | Mô tả |
|---|---|
| **Rate Limiting** | Giới hạn số request/phút mỗi client |
| **Authentication** | Xác thực API key, JWT, OAuth |
| **Logging** | Ghi log mọi request (ai gọi gì, lúc nào, kết quả gì) |
| **TLS Termination** | Xử lý HTTPS phía ngoài, chuyển HTTP vào trong |
| **Load Balancing** | Phân phối request đều giữa các Pod app |

```
Client (HTTPS) → Kong → App (HTTP nội bộ)
                  ↓
         [rate limit, auth, log, TLS]
```

### KIC (Kong Ingress Controller)
Thành phần "dịch" Kubernetes Ingress/CRD rules sang config Kong. **Không xử lý traffic** — chỉ cấu hình.

```
Bạn viết Ingress YAML
    ↓
KIC đọc K8s API liên tục (watch)
    ↓
KIC cấu hình Kong Gateway
    ↓
Kong biết: "URL /api/v1 → Service tnt-engine"
```

### DB-less mode vs DB mode

| Mode | Config lưu ở đâu | Khi nào dùng |
|---|---|---|
| **DB-less** | Memory, sync từ K8s CRDs | ✅ K8s native — không cần PostgreSQL riêng cho Kong |
| DB mode | PostgreSQL riêng | Khi cần Kong Manager UI đầy đủ |

Với K8s: dùng **DB-less** — đơn giản, không cần thêm database.

### Số replica khuyến nghị

```
Kong Gateway:    3 replica  (anti-affinity: mỗi worker node 1 pod)
KIC Controller:  2 replica  (leader election: 1 active, 1 standby)
```

### Cách hoạt động khi có request

```
1. Client: POST https://tnt-engine.internal/api/v1/tokenize
2. Kong nhận request
3. Kong kiểm tra:
   - Rate limit: client này còn quota không?
   - Auth: token hợp lệ không?
4. Pass → Kong forward tới K8s Service tnt-engine
5. K8s Service chọn 1 Pod tnt-engine (round-robin)
6. Pod xử lý → trả kết quả về Kong
7. Kong trả về Client
```

### Anti-affinity
Đảm bảo các Pod của cùng 1 Deployment không nằm trên cùng 1 Worker Node — tránh mất toàn bộ khi 1 node chết.

```yaml
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchLabels:
          app: kong
      topologyKey: kubernetes.io/hostname
# → K8s sẽ từ chối đặt 2 pod kong trên cùng 1 node
```

---

## 4. Redis Sentinel

### Redis Primary / Replica

- **Primary**: nhận cả đọc lẫn ghi
- **Replica**: copy data từ Primary — phục vụ đọc hoặc dự phòng failover

```
App → Primary (ghi + đọc)
         ↓ replication (async)
      Replica (dự phòng)
```

### Replication hoạt động thế nào?

```
Primary nhận: SET user:1 "Alice"
→ Thực thi xong
→ Gửi lệnh SET đó sang Replica
→ Replica thực thi theo
→ Replica luôn là bản sao của Primary
```

Replication là **async** → có độ trễ nhỏ → khi Primary chết đột ngột, Replica có thể thiếu vài lệnh cuối (mất data nhỏ).

### Sentinel
Tiến trình **giám sát** Redis. Khi Primary chết, Sentinel tự động promote Replica thành Primary mới.

```
[Sentinel 1] [Sentinel 2] [Sentinel 3]
      ↑            ↑            ↑
      └────────────┴────────────┘
                   │ monitor (ping mỗi giây)
             [Redis Primary]
                   │ replication
             [Redis Replica]
```

### Cách Sentinel phát hiện và xử lý Primary chết

```
Bước 1: Mỗi Sentinel ping Primary mỗi giây
Bước 2: Primary không trả lời trong 5000ms (down-after-milliseconds)
        → Sentinel đó đánh dấu "SDOWN" (Subjectively Down — tôi thấy nó chết)
Bước 3: Sentinel hỏi các Sentinel khác: "mày thấy Primary sống không?"
Bước 4: Nếu đủ quorum (2/3) xác nhận chết
        → đánh dấu "ODOWN" (Objectively Down — đồng thuận nó chết)
Bước 5: Bầu 1 Sentinel làm "coordinator" (người dẫn dắt failover)
Bước 6: Coordinator ra lệnh Replica → promote thành Primary mới
Bước 7: Báo cho App biết địa chỉ Primary mới
Toàn bộ: < 60 giây
```

### Tại sao cần 3 Sentinel?

```
1 Sentinel: Sentinel chết → không ai monitor → Primary chết không ai xử lý ❌
2 Sentinel: Cần 2/2 đồng ý → 1 Sentinel lỗi mạng → deadlock, không failover ❌
3 Sentinel: Cần 2/3 đồng ý → 1 Sentinel chết → 2 còn lại vẫn failover được ✅
```

### SDOWN vs ODOWN

| Trạng thái | Tên đầy đủ | Ý nghĩa |
|---|---|---|
| SDOWN | Subjectively Down | 1 Sentinel thấy Primary không response |
| ODOWN | Objectively Down | Đủ quorum Sentinel đồng thuận Primary chết → bắt đầu failover |

### Các tham số quan trọng

| Tham số | Giá trị | Ý nghĩa |
|---|---|---|
| `quorum` | 2 | Cần 2/3 Sentinel đồng ý → ODOWN |
| `down-after-milliseconds` | 5000 | 5s không response → SDOWN |
| `failover-timeout` | 60000 | Failover tối đa 60s |
| `parallel-syncs` | 1 | Sync 1 Replica/lần sau failover (an toàn hơn) |
| `min-replicas-to-write` | 1 | Primary dừng nhận write nếu không Replica nào sync |
| `min-replicas-max-lag` | 10 | Trong 10s |

---

## 5. OpenBao Raft

### OpenBao là gì?
Fork của HashiCorp Vault — lưu trữ và quản lý secrets (passwords, API keys, encryption keys). T&T Engine dùng OpenBao để:
- Tính **HMAC** (hash) cho tokenization — đảm bảo cùng 1 plaintext luôn ra cùng 1 hash
- **Encrypt / Decrypt** plaintext qua Transit engine

```
T&T Engine → OpenBao Transit API → trả về: hash hoặc ciphertext
```

### Raft Consensus Algorithm
Thuật toán giúp nhiều node thống nhất với nhau — đảm bảo mọi node đều có cùng data.

```
3 node OpenBao:
├── openbao-0: LEADER   ← nhận mọi request từ app, ra quyết định
├── openbao-1: Follower ← nhận và lưu copy data từ leader
└── openbao-2: Follower ← nhận và lưu copy data từ leader
```

### Cách Raft hoạt động (ghi data)

```
1. App gọi OpenBao: encrypt "Alice"
2. Request tới LEADER (openbao-0)
3. Leader ghi vào log của mình: [entry #42: encrypt "Alice"]
4. Leader gửi log entry sang tất cả Follower
5. Follower xác nhận đã nhận: "OK, tôi có entry #42"
6. Khi đa số (quorum=2/3) xác nhận → Leader "commit"
7. Leader thực thi → trả kết quả về App
```

Kết quả: mọi node đều có entry #42 → data đồng bộ.

### Khi Leader chết

```
Leader (openbao-0) chết
    ↓
Follower không nhận được heartbeat từ Leader trong ~1-2s
    ↓
Follower tự ứng cử làm Leader mới (random timeout)
    ↓
Bỏ phiếu: node nào có log mới nhất và đủ phiếu → thành Leader mới
    ↓
openbao-1 thắng → trở thành Leader mới
    ↓
Cluster tiếp tục hoạt động (~10-30s gián đoạn)
```

### Sealed / Unsealed
OpenBao có cơ chế bảo mật đặc biệt để bảo vệ encryption key master:

```
OpenBao khởi động → Sealed (chưa có key → từ chối mọi request)
→ Admin nhập unseal key 1/3
→ Admin nhập unseal key 2/3
→ Admin nhập unseal key 3/3
→ Unsealed → hoạt động bình thường
```

Mỗi lần Pod restart phải unseal lại. Trong production dùng **Auto Unseal** (lấy key từ cloud KMS tự động).

### Raft vs Sentinel (so sánh)

| Khía cạnh | Raft (OpenBao) | Sentinel (Redis) |
|---|---|---|
| Mô hình | Mọi node đều có full copy data | Primary ghi, Replica đọc |
| Request | Chỉ Leader nhận | Primary nhận ghi, Replica nhận đọc |
| Failover | Raft bầu Leader mới tự động | Sentinel promote Replica |
| Consistency | Strong (commit = đa số xác nhận) | Eventual (async replication) |

---

## 6. PostgreSQL & Patroni

### WAL (Write-Ahead Log)
Journal của PostgreSQL — mọi thay đổi data được ghi vào WAL trước khi apply vào DB thật.

```
App: INSERT INTO tokens VALUES (...)
→ Ghi vào WAL: [entry: INSERT ...]
→ Apply vào DB
→ Gửi WAL stream sang Replica
→ Replica apply WAL → đồng bộ với Primary
```

### Streaming Replication
Primary gửi liên tục WAL stream sang Replica — Replica luôn cập nhật.

```
Primary ──WAL stream──→ Replica 1
         ──WAL stream──→ Replica 2
```

### Patroni
Công cụ quản lý HA cho PostgreSQL. Chạy trên mỗi node, wrap quanh PostgreSQL process.

```
[Patroni + postgres-0]   [Patroni + postgres-1]   [Patroni + postgres-2]
      (Primary)                (Replica 1)              (Replica 2)
         ↑
   [K8s API / etcd]  ← Patroni dùng làm "bảng bầu chọn" leader
```

### Cách Patroni failover

```
Bước 1: postgres-0 (Primary) chết
Bước 2: Patroni trên postgres-1 và postgres-2 phát hiện (mất heartbeat)
Bước 3: Cả 2 tranh nhau ghi vào K8s ConfigMap: "Tôi muốn làm leader"
Bước 4: Người ghi trước thắng (K8s đảm bảo atomic) → postgres-1 thắng
Bước 5: postgres-1 promote: "tôi là Primary mới"
Bước 6: postgres-2 kết nối lại với Primary mới (postgres-1)
Bước 7: K8s Service tự trỏ sang postgres-1
Toàn bộ: ~30 giây
```

### PgBouncer
Connection pooler — đứng trước PostgreSQL, gom nhiều kết nối app thành ít kết nối DB thật.

```
App Pod 1 ─┐
App Pod 2 ─┼─→ PgBouncer → PostgreSQL
App Pod 3 ─┘
(30 connections)   (chỉ 10 conn thật)
```

Tại sao cần? PostgreSQL chịu được ~100-200 connection. 20 app pod × 10 conn = 200 conn → chạm giới hạn → PgBouncer giảm tải.

### Số replica theo môi trường

| Môi trường | Cấu hình | Lý do |
|---|---|---|
| Dev/Staging | 1 Primary + 1 Replica | Đủ test HA |
| **Production** | **1 Primary + 2 Replica** | Promote 1 → vẫn còn 1 Replica |

Lý do cần 2 Replica ở production:
- Primary chết → Patroni promote Replica 1 thành Primary mới
- Vẫn còn Replica 2 → read queries không bị ảnh hưởng → không mất read HA

---

## 7. HPA và PDB

### HPA — Horizontal Pod Autoscaler
Tự động tăng/giảm số Pod dựa trên CPU / memory / custom metrics.

```
Bình thường (CPU 30%):     3 pod
Traffic tăng (CPU 80%):    K8s tạo thêm pod → 5 pod
Traffic giảm (CPU 20%):    K8s xóa bớt pod → 3 pod (sau 5 phút chờ)
```

**Công thức tính:**
```
pod_mới = ceil(pod_hiện_tại × CPU_thực_tế / CPU_target)
        = ceil(3 × 80% / 70%)
        = ceil(3.43)
        = 4 pod
```

**Stabilization window** — tránh scale up/down quá nhanh:
```
scaleUp:   0s    → scale up ngay khi vượt ngưỡng (traffic spike cần xử lý nhanh)
scaleDown: 300s  → chờ 5 phút trước khi scale down (tránh scale lên xuống liên tục)
```

### PDB — Pod Disruption Budget
Giới hạn số Pod bị tắt cùng lúc khi có **voluntary disruption** (upgrade, drain node).

```
3 pod, PDB minAvailable=2:
→ Chỉ được tắt tối đa 1 pod tại 1 thời điểm
→ Luôn còn ít nhất 2 pod phục vụ traffic
```

Hai loại disruption:

| Loại | Ví dụ | PDB can thiệp? |
|---|---|---|
| **Voluntary** (có chủ đích) | Drain node, upgrade cluster, delete pod | ✅ Có — PDB chặn nếu vi phạm |
| **Involuntary** (đột ngột) | Node mất điện, kernel panic, OOM kill | ❌ Không — PDB không can thiệp được |

### minAvailable vs maxUnavailable

```yaml
# Cách 1: minAvailable — "phải còn ít nhất bao nhiêu pod"
spec:
  minAvailable: 2    # Với 3 pod: chỉ được xóa 1 lúc

# Cách 2: maxUnavailable — "được phép mất tối đa bao nhiêu pod"
spec:
  maxUnavailable: 1  # Với 3 pod: chỉ được mất 1 lúc
```

Kết quả tương đương với 3 pod. Dùng `minAvailable` khi cần đảm bảo số tuyệt đối.

### Rolling Update — Zero Downtime Deploy

```
Cấu hình:
  maxSurge: 1        → Tạo 1 pod mới trước khi xóa pod cũ
  maxUnavailable: 0  → Không được có pod unavailable trong khi update
```

**Quá trình deploy phiên bản mới:**
```
Ban đầu:  [v1] [v1] [v1]
Bước 1:   [v1] [v1] [v1] [v2]   ← tạo pod v2 mới (surge +1)
Bước 2:   [v1] [v1] [v2]        ← v2 Ready → xóa 1 pod v1
Bước 3:   [v1] [v1] [v2] [v2]   ← tạo pod v2 tiếp theo
Bước 4:   [v1] [v2] [v2]        ← v2 Ready → xóa 1 pod v1
Bước 5:   [v1] [v2] [v2] [v2]   ← tạo pod v2 cuối
Bước 6:   [v2] [v2] [v2]        ← xong
→ Không có giây nào dưới 3 pod → zero downtime
```

### Readiness Probe vs Liveness Probe

| Probe | Mục đích | Khi fail |
|---|---|---|
| **Readiness** | "Pod đã sẵn sàng nhận traffic chưa?" | K8s ngừng gửi traffic → pod bị remove khỏi Service |
| **Liveness** | "Pod còn sống không?" | K8s restart container |

```yaml
# Ví dụ config cho T&T Engine
readinessProbe:
  httpGet:
    path: /health/ready
    port: 8000
  initialDelaySeconds: 10
  periodSeconds: 5

livenessProbe:
  httpGet:
    path: /health/live
    port: 8000
  initialDelaySeconds: 30
  periodSeconds: 10
```

---

## 8. Observability

### Prometheus
Thu thập metrics từ các ứng dụng. App expose endpoint `/metrics`, Prometheus tự động scrape định kỳ.

```
T&T Engine → GET /metrics → Prometheus lưu time-series data
(expose số liệu)              (thu thập mỗi 15s)
```

Metrics là các con số theo thời gian: request count, latency, error rate, CPU...

### Grafana
Dashboard hiển thị metrics từ Prometheus dưới dạng biểu đồ, bảng, alert.

```
Prometheus (data) → Grafana (visualize) → Engineer nhìn dashboard
```

### Loki
Thu thập và lưu trữ logs — tương tự Prometheus nhưng cho logs thay vì metrics.

```
Pod → log stdout → Promtail (agent chạy trên mỗi node) → Loki → Grafana
```

### Promtail
Agent chạy trên mỗi Worker Node, đọc log của các Pod trên node đó và đẩy sang Loki.

### ServiceMonitor
CRD của Prometheus Operator — mô tả "Prometheus cần scrape Service nào".

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: tnt-engine
spec:
  selector:
    matchLabels:
      app: tnt-engine
  endpoints:
  - port: metrics
    path: /metrics
```

---

## 9. Toàn cảnh hệ thống

### Luồng request hoàn chỉnh

```
[Client]
   │ HTTPS
   ↓
[External Load Balancer]
   │ TCP :443
   ↓
[Kong Gateway Pod × 3]          namespace: gateway
   │ rate limit ✓ auth ✓ log ✓
   │ HTTP nội bộ
   ↓
[K8s Service: tnt-engine]       namespace: tnt-engine
   │ round-robin
   ↓
[T&T Engine Pod]                (1 trong 3-20 pod)
   │
   ├──→ [Redis Primary]         namespace: data
   │      L2 cache lookup (~1-5ms)
   │      Sentinel monitor: 3 instance
   │
   ├──→ [PostgreSQL Primary]    namespace: data
   │      token storage (~5-50ms)
   │      Patroni HA: 1P + 2R
   │
   └──→ [OpenBao Leader]        namespace: data
          HMAC + encrypt (~5ms)
          Raft cluster: 3 node
   │
   ↓
[Response] → Kong → Client

[Prometheus] ← scrape /metrics từ tất cả services (mỗi 15s)
[Grafana]    ← hiển thị dashboard, alert
[Loki]       ← thu thập logs từ tất cả pods
```

### Bảng tổng hợp component

| Component | Loại | Replica | HA Mechanism | Recover time |
|---|---|---|---|---|
| RKE2 Control Plane | Server Node | 3 | etcd Raft | < 30s |
| RKE2 Worker | Agent Node | 3+ | K8s rescheduling | < 60s |
| Kong Gateway | Deployment | 3 | K8s + anti-affinity | < 30s |
| KIC Controller | Deployment | 2 | Leader election | < 15s |
| T&T Engine | Deployment + HPA | 3 → 20 | Rolling update + PDB | 0s |
| PostgreSQL | StatefulSet | 1P + 2R | Patroni (~30s) | ~30s |
| Redis | StatefulSet | 1P + 1R | Sentinel (3 instance) | < 60s |
| OpenBao | StatefulSet | 3 | Raft leader election | < 30s |

### Tại sao mỗi component cần số replica như vậy?

```
RKE2 CP × 3:
  etcd quorum = 2/3 → mất 1 node vẫn hoạt động

Kong × 3:
  anti-affinity → mỗi node 1 pod
  → mất 1 worker node → còn 2 Kong pod

T&T Engine min=3, PDB minAvailable=2:
  → mất 1 pod → còn 2 pod phục vụ traffic
  → không có downtime khi rolling update

PostgreSQL 1P+2R:
  Primary chết → promote Replica 1
  → vẫn còn Replica 2 cho read queries

Redis 1P+1R + 3 Sentinel:
  Primary chết → Sentinel promote Replica
  3 Sentinel → majority = 2 → mất 1 Sentinel vẫn failover được

OpenBao × 3 Raft:
  Leader chết → Raft bầu Leader mới từ 2 Follower
  quorum = 2/3 → vẫn đủ
```

### Kết luận SLA

```
Mỗi component fail → tự recover trong < 60s
Giả sử 10 incident/năm:
  10 × 60s = 600s = 0.17h downtime/năm

Ngưỡng SLA: 8.7h/năm
0.17h << 8.7h → đạt SLA 99.9% ✅
```
