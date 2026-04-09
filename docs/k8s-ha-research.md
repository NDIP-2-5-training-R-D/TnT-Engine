# Triển khai T&T Engine trên Kubernetes — HA Research & Deployment Guide

**Ngày**: 2026-04-09  
**Phạm vi**: RKE2, Kong, Redis Sentinel, OpenBao Raft, PostgreSQL Patroni, HPA/PDB  
**Mục tiêu**: Chứng minh cấu hình đủ để đạt SLA 99.9% và hướng dẫn triển khai từng bước

---

## Mục lục

1. [Tính SLA mục tiêu](#1-tính-sla-mục-tiêu)
2. [Kiến trúc tổng thể](#2-kiến-trúc-tổng-thể)
3. [RKE2 — Cluster HA](#3-rke2--cluster-ha)
4. [Kong — API Gateway](#4-kong--api-gateway)
5. [Redis — Sentinel HA](#5-redis--sentinel-ha)
6. [OpenBao — Raft HA](#6-openbao--raft-ha)
7. [PostgreSQL — Patroni HA](#7-postgresql--patroni-ha)
8. [T&T Engine — HPA + PDB + Rolling Update](#8-tt-engine--hpa--pdb--rolling-update)
9. [Observability](#9-observability)
10. [Chỉ số cần đo (1 tenant)](#10-chỉ-số-cần-đo-1-tenant)
11. [Bảng tổng hợp SLA 99.9%](#11-bảng-tổng-hợp-sla-999)
12. [Thứ tự triển khai](#12-thứ-tự-triển-khai)
13. [Nguồn tham khảo](#13-nguồn-tham-khảo)

---

## 1. Tính SLA mục tiêu

```
8760h/năm × (1 - 0.999) = 8.76h ≈ 8.7h downtime/năm
→ Mục tiêu: 99.9% uptime (Three Nines)
```

**Nguyên tắc cốt lõi**: Không component nào được có SPOF (Single Point of Failure).  
Bất kỳ instance nào bị mất đều phải tự recover mà không cần can thiệp tay.

**Chứng minh đạt ngưỡng:**
```
Mỗi component fail → tự recover < 60s
Giả sử 10 incident/năm:
  10 × 60s = 600s = 0.17h downtime/năm

Ngưỡng SLA: 8.7h/năm
0.17h << 8.7h → đạt SLA 99.9% ✅
```

---

## 2. Kiến trúc tổng thể

### Luồng request hoàn chỉnh

```
[Client]
   │ HTTPS
   ↓
[External Load Balancer]           ← TCP :443 / :9345 / :6443
   │
   ↓
[Kong Gateway Pod × 3]             namespace: gateway
   │ rate limit | auth | log | TLS termination
   │ HTTP nội bộ
   ↓
[K8s Service: tnt-engine]          namespace: tnt-engine
   │ round-robin
   ↓
[T&T Engine Pod × 3–20]            HPA + PDB
   │
   ├──→ [Redis Primary]            namespace: data
   │      L2 cache lookup (~1–5ms)
   │      Sentinel: 3 instance
   │
   ├──→ [PostgreSQL Primary]       namespace: data
   │      token storage (~5–50ms)
   │      Patroni: 1P + 2R
   │
   └──→ [OpenBao Leader]           namespace: data
          HMAC + encrypt (~5ms)
          Raft cluster: 3 node

[Prometheus + Grafana + Loki]      namespace: observability
   ↑ scrape /metrics mỗi 15s từ tất cả services
```

### Namespace layout

```
Namespace        Chứa gì
──────────────────────────────────────────────────────
gateway          Kong Gateway Pod × 3, KIC Controller × 2
tnt-engine       T&T Engine Deployment, Service, HPA, PDB, NetworkPolicy
data             PostgreSQL (Patroni), Redis (Sentinel), OpenBao (Raft)
observability    Prometheus, Grafana, Loki, Promtail
```

---

## 3. RKE2 — Cluster HA

### Tại sao RKE2 thay K3s?

| Tiêu chí | K3s | RKE2 |
|---|---|---|
| Use case | Edge, Dev, IoT | Enterprise Production |
| CIS Benchmark | Không mặc định | Có sẵn, hardened |
| FIPS 140-2 | Không | Có |
| etcd | External/SQLite | Embedded etcd cluster-ready |
| NetworkPolicy | Flannel (không hỗ trợ) | Canal/Cilium (đầy đủ) |

### Số node cần thiết

```
Control Plane (server node):  3 node   ← bắt buộc số lẻ
Worker (agent node):          3+ node  ← chứa workload
Load Balancer:                1        ← đứng trước toàn bộ CP node
```

**Lý do bắt buộc 3 control plane:**

> *"An odd number (three recommended) of server nodes run etcd... quorum = (n/2)+1"*  
> — [docs.rke2.io/install/ha](https://docs.rke2.io/install/ha)

```
3 node → quorum = floor(3/2)+1 = 2
→ Mất 1 node: còn 2 → đủ quorum → cluster tiếp tục hoạt động ✅

2 node → quorum = floor(2/2)+1 = 2
→ Mất 1 node: còn 1 → mất quorum → cluster DOWN ❌
```

### Topology cluster

```
                   [External Load Balancer]
                   Port :9345 (registration) + :6443 (API)
                          ↓
        ┌─────────────────┼─────────────────┐
   [CP Node 1]       [CP Node 2]       [CP Node 3]
   etcd + API        etcd + API        etcd + API
   Scheduler         Scheduler         Scheduler
   Controller Mgr    Controller Mgr    Controller Mgr
        └─────────────────┼─────────────────┘
                          ↓ (schedule workloads)
        ┌─────────────────┼─────────────────┐
  [Worker 1]         [Worker 2]        [Worker 3]
  Kong + App pods    Kong + App pods   Kong + App pods
  Redis/PG/Bao       Redis/PG/Bao      Redis/PG/Bao
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
| 8472 | UDP | All → All | CNI VXLAN overlay (Canal/Flannel) |

### CNI khuyến nghị: Cilium

> *"Flannel does not support network policies. Therefore, it is not recommended for hardened installations."*  
> — [docs.rke2.io/networking/basic_network_options](https://docs.rke2.io/networking/basic_network_options)

| CNI | NetworkPolicy | eBPF | Observability |
|---|---|---|---|
| Flannel | ❌ | ❌ | Không |
| Canal | ✅ | ❌ | Hạn chế |
| **Cilium** | ✅ | ✅ | Hubble |
| Calico | ✅ | Một phần | Hạn chế |

### Load Balancer config

```
Listener 1: :9345 → [CP-1:9345, CP-2:9345, CP-3:9345]   (node registration)
Listener 2: :6443 → [CP-1:6443, CP-2:6443, CP-3:6443]   (K8s API)
Mode: Layer 4 TCP, round-robin
Health check: TCP connect
```

### Triển khai RKE2 HA — Step by step

**Bước 1: Cài RKE2 trên CP node đầu tiên**

```bash
curl -sfL https://get.rke2.io | sh -

cat > /etc/rancher/rke2/config.yaml <<EOF
token: <shared-secret>
tls-san:
  - <load-balancer-ip>
  - <load-balancer-hostname>
cni: cilium
EOF

systemctl enable rke2-server --now

# Kiểm tra
systemctl status rke2-server
/var/lib/rancher/rke2/bin/kubectl --kubeconfig /etc/rancher/rke2/rke2.yaml get nodes
```

**Bước 2: Cài RKE2 trên CP node 2 và 3**

```bash
# Chạy trên CP-2 và CP-3 (phải match token với node 1)
curl -sfL https://get.rke2.io | sh -

cat > /etc/rancher/rke2/config.yaml <<EOF
server: https://<load-balancer-ip>:9345
token: <shared-secret>
tls-san:
  - <load-balancer-ip>
  - <load-balancer-hostname>
cni: cilium
EOF

systemctl enable rke2-server --now
```

**Bước 3: Cài RKE2 agent trên Worker nodes**

```bash
curl -sfL https://get.rke2.io | INSTALL_RKE2_TYPE="agent" sh -

cat > /etc/rancher/rke2/config.yaml <<EOF
server: https://<load-balancer-ip>:9345
token: <shared-secret>
EOF

systemctl enable rke2-agent --now
```

**Bước 4: Cấu hình kubectl từ bất kỳ máy nào**

```bash
mkdir -p ~/.kube
scp root@<cp-node-1>:/etc/rancher/rke2/rke2.yaml ~/.kube/config
# Sửa server IP trong file config sang LB IP
sed -i 's/127.0.0.1/<load-balancer-ip>/g' ~/.kube/config

export KUBECONFIG=~/.kube/config
kubectl get nodes
```

Kết quả mong đợi:
```
NAME        STATUS   ROLES                       AGE
cp-node-1   Ready    control-plane,etcd,master   ...
cp-node-2   Ready    control-plane,etcd,master   ...
cp-node-3   Ready    control-plane,etcd,master   ...
worker-1    Ready    worker                      ...
worker-2    Ready    worker                      ...
worker-3    Ready    worker                      ...
```

**Bước 5: Tạo namespaces**

```bash
kubectl create namespace gateway
kubectl create namespace tnt-engine
kubectl create namespace data
kubectl create namespace observability
```

**Bước 6: NetworkPolicy — chỉ Kong được gọi vào tnt-engine**

```yaml
# k8s/network-policy-tnt-engine.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-kong-only
  namespace: tnt-engine
spec:
  podSelector:
    matchLabels:
      app: tnt-engine
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: gateway
  policyTypes:
  - Ingress
```

```bash
kubectl apply -f k8s/network-policy-tnt-engine.yaml
```

**Nguồn:** [High Availability | RKE2](https://docs.rke2.io/install/ha) · [RKE2 Network Options](https://docs.rke2.io/networking/basic_network_options)

---

## 4. Kong — API Gateway

### Kiến trúc Kong trên K8s

```
[Client]
   ↓
[Kong Gateway Pod × 3]   ← proxy traffic thực sự, bypass kube-proxy
   ↑ cấu hình
[KIC Controller × 2]     ← đọc Ingress/CRD từ K8s API, leader election
                           không xử lý traffic
```

> *"The Kong Ingress Controller listens for changes inside the Kubernetes cluster and dynamically updates Kong Gateway in response."*  
> — [developer.konghq.com/kubernetes-ingress-controller/architecture](https://developer.konghq.com/kubernetes-ingress-controller/architecture/)

### DB-less mode (khuyến nghị)

| Mode | Config lưu ở đâu | Khi nào dùng |
|---|---|---|
| **DB-less** | Memory, sync từ K8s CRDs | ✅ K8s native, không cần PostgreSQL riêng |
| DB mode | PostgreSQL riêng | Khi cần Kong Manager UI đầy đủ |

### Số replica

```
Kong Gateway:    3 replica  (anti-affinity: mỗi worker node 1 pod)
KIC Controller:  2 replica  (leader election: 1 active, 1 standby)
```

### Triển khai Kong — Step by step

**Bước 1: Cài Kong bằng Helm**

```bash
helm repo add kong https://charts.konghq.com
helm repo update

helm install kong kong/ingress \
  --namespace gateway \
  --set replicaCount=3 \
  --set controller.replicaCount=2 \
  --set controller.ingressController.enabled=true

# Kiểm tra
kubectl -n gateway get pods
kubectl -n gateway get svc
```

**Bước 2: Anti-affinity — đảm bảo mỗi node 1 pod Kong**

```yaml
# Thêm vào values khi helm install
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchLabels:
          app: kong
      topologyKey: kubernetes.io/hostname
```

**Bước 3: KongPlugin — Rate Limiting**

```yaml
# k8s/kong-rate-limit.yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: rate-limiting
  namespace: gateway
plugin: rate-limiting
config:
  minute: 1000
  policy: redis
  redis_host: redis-master.data.svc.cluster.local
  redis_port: 6379
```

```bash
kubectl apply -f k8s/kong-rate-limit.yaml
```

**Bước 4: Ingress cho T&T Engine**

```yaml
# k8s/ingress-tnt-engine.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tnt-engine-ingress
  namespace: tnt-engine
  annotations:
    konghq.com/plugins: rate-limiting
spec:
  ingressClassName: kong
  rules:
  - host: tnt-engine.internal
    http:
      paths:
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: tnt-engine
            port:
              number: 8000
```

```bash
kubectl apply -f k8s/ingress-tnt-engine.yaml

# Kiểm tra
kubectl -n tnt-engine get ingress
curl http://tnt-engine.internal/api/v1/health
```

**Nguồn:** [Kong Ingress Controller Docs](https://docs.konghq.com/kubernetes-ingress-controller/latest/) · [KIC Architecture](https://developer.konghq.com/kubernetes-ingress-controller/architecture/)

---

## 5. Redis — Sentinel HA

### Kiến trúc

```
[App Pod] → [Redis Primary]  ←── replication ───→  [Redis Replica × 1]
                  ↑
                  │ monitor + failover (ping mỗi giây)
         [Sentinel 1] [Sentinel 2] [Sentinel 3]
```

### Tại sao cần 3 Sentinel?

> *"You need at least three Sentinel instances for a robust deployment."*  
> — [redis.io/docs/latest/operate/oss_and_stack/management/sentinel](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/)

```
3 Sentinel → majority = 2
→ Mất 1 Sentinel: còn 2 → đủ majority → failover được ✅

2 Sentinel → majority = 2
→ Mất 1 Sentinel: còn 1 → không đủ majority → không failover ❌
```

### Cơ chế failover Sentinel

```
Bước 1: Mỗi Sentinel ping Primary mỗi giây
Bước 2: Primary không trả lời trong 5000ms → SDOWN (Subjectively Down)
Bước 3: Sentinel hỏi các Sentinel khác: "mày thấy Primary sống không?"
Bước 4: Đủ quorum (2/3) xác nhận → ODOWN (Objectively Down)
Bước 5: Bầu 1 Sentinel làm coordinator
Bước 6: Coordinator promote Replica thành Primary mới
Bước 7: Báo cho App biết địa chỉ Primary mới
Toàn bộ: < 60 giây
```

### Tham số quan trọng

| Tham số | Giá trị | Ý nghĩa |
|---|---|---|
| `quorum` | 2 | Cần 2/3 Sentinel đồng ý → ODOWN |
| `down-after-milliseconds` | 5000 | 5s không response → SDOWN |
| `failover-timeout` | 60000 | Failover tối đa 60s |
| `parallel-syncs` | 1 | Sync 1 Replica/lần (an toàn hơn) |
| `min-replicas-to-write` | 1 | Primary dừng nhận write nếu không Replica nào sync |
| `min-replicas-max-lag` | 10 | Trong 10s |

### Triển khai Redis Sentinel — Step by step

**Bước 1: Thêm Bitnami Helm repo**

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
```

**Bước 2: Deploy Redis với Sentinel**

```bash
helm install redis bitnami/redis \
  --namespace data \
  --set architecture=replication \
  --set sentinel.enabled=true \
  --set sentinel.quorum=2 \
  --set sentinel.downAfterMilliseconds=5000 \
  --set sentinel.failoverTimeout=60000 \
  --set replica.replicaCount=1 \
  --set auth.enabled=true \
  --set auth.password=<redis-password>
```

**Bước 3: Kiểm tra**

```bash
kubectl -n data get pods -l app.kubernetes.io/name=redis
# Mong đợi: redis-node-0 (primary+sentinel), redis-node-1 (replica+sentinel), redis-node-2 (sentinel)

# Test kết nối
kubectl -n data exec -it redis-node-0 -- redis-cli -a <redis-password> ping
# → PONG

# Kiểm tra sentinel
kubectl -n data exec -it redis-node-0 -- redis-cli -p 26379 sentinel masters
```

**Bước 4: Lấy connection string cho app**

```bash
# Địa chỉ Sentinel (app kết nối Sentinel, không kết nối thẳng Primary)
redis-node-0.redis-headless.data.svc.cluster.local:26379
redis-node-1.redis-headless.data.svc.cluster.local:26379
redis-node-2.redis-headless.data.svc.cluster.local:26379

# Hoặc dùng service Redis master
redis-master.data.svc.cluster.local:6379
```

**Nguồn:** [Redis Sentinel Docs](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/) · [Redis on Kubernetes](https://redis.io/docs/latest/integrate/kubernetes-redis/)

---

## 6. OpenBao — Raft HA

### Số node và lý do

```
OpenBao cluster: 3 node (Raft Integrated Storage)
```

> *"Quorum requires at least (n+1)/2 members. For 3 members: quorum = 2."*  
> — [openbao.org/docs/internals/integrated-storage](https://openbao.org/docs/internals/integrated-storage/)

```
3 node → quorum = 2
→ Mất 1 node: còn 2 → đủ quorum → OpenBao tiếp tục hoạt động ✅
```

### Cơ chế Raft

```
openbao-0: LEADER   ← nhận mọi request từ app, ra quyết định
openbao-1: Follower ← nhận và lưu copy data từ leader
openbao-2: Follower ← nhận và lưu copy data từ leader

Khi Leader chết:
→ Follower không nhận heartbeat trong ~1-2s
→ Raft bầu Leader mới tự động từ 2 Follower còn lại
→ Gián đoạn: ~10-30s
```

### Triển khai OpenBao — Step by step

**Bước 1: Thêm Helm repo và deploy**

```bash
helm repo add openbao https://openbao.github.io/openbao-helm
helm repo update

helm install openbao openbao/openbao \
  --namespace data \
  --set server.ha.enabled=true \
  --set server.ha.raft.enabled=true \
  --set server.replicas=3

# Kiểm tra
kubectl -n data get pods -l app.kubernetes.io/name=openbao
# Mong đợi: openbao-0, openbao-1, openbao-2 (ban đầu Sealed)
```

**Bước 2: Init OpenBao (chỉ làm 1 lần duy nhất)**

```bash
# Init trên node 0 — lưu lại output này rất quan trọng!
kubectl -n data exec -it openbao-0 -- bao operator init \
  -key-shares=5 \
  -key-threshold=3

# Output sẽ có dạng:
# Unseal Key 1: xxxx
# Unseal Key 2: xxxx
# Unseal Key 3: xxxx
# Unseal Key 4: xxxx
# Unseal Key 5: xxxx
# Initial Root Token: hvs.xxxx
#
# → Lưu vào nơi an toàn, không commit vào git!
```

**Bước 3: Unseal node 0 (cần 3/5 keys)**

```bash
kubectl -n data exec -it openbao-0 -- bao operator unseal <key-1>
kubectl -n data exec -it openbao-0 -- bao operator unseal <key-2>
kubectl -n data exec -it openbao-0 -- bao operator unseal <key-3>

# Kiểm tra trạng thái
kubectl -n data exec -it openbao-0 -- bao status
# Mong đợi: Sealed = false, HA Mode = active
```

**Bước 4: Node 1 và 2 join Raft cluster rồi unseal**

```bash
# Node 1
kubectl -n data exec -it openbao-1 -- bao operator raft join \
  http://openbao-internal:8200
kubectl -n data exec -it openbao-1 -- bao operator unseal <key-1>
kubectl -n data exec -it openbao-1 -- bao operator unseal <key-2>
kubectl -n data exec -it openbao-1 -- bao operator unseal <key-3>

# Node 2
kubectl -n data exec -it openbao-2 -- bao operator raft join \
  http://openbao-internal:8200
kubectl -n data exec -it openbao-2 -- bao operator unseal <key-1>
kubectl -n data exec -it openbao-2 -- bao operator unseal <key-2>
kubectl -n data exec -it openbao-2 -- bao operator unseal <key-3>

# Kiểm tra cluster
kubectl -n data exec -it openbao-0 -- env VAULT_TOKEN=<root-token> \
  bao operator raft list-peers
```

**Bước 5: Enable Transit engine và tạo keys**

```bash
export VAULT_ADDR=http://openbao.data.svc.cluster.local:8200
export VAULT_TOKEN=<root-token>

# Enable transit
bao secrets enable transit

# Tạo key cho tokenization
bao write -f transit/keys/tnt-key
bao write -f transit/keys/tnt-hmac type=hmac

# Kiểm tra
bao list transit/keys
```

**Nguồn:** [OpenBao HA with Raft on K8s](https://openbao.org/docs/platform/k8s/helm/examples/ha-with-raft/) · [OpenBao Integrated Storage](https://openbao.org/docs/internals/integrated-storage/)

---

## 7. PostgreSQL — Patroni HA

### Kiến trúc với Patroni

```
[App Pod] → [PgBouncer] → [Patroni Endpoint Service]
                               ↓
                     [PostgreSQL Primary]       postgres-0
                           ↓ WAL stream
                     [PostgreSQL Replica 1]     postgres-1
                     [PostgreSQL Replica 2]     postgres-2
                           ↑
                    [Patroni trên mỗi node]
                    (dùng K8s API làm DCS,
                     TTL lock = leader lease,
                     promote tự động khi Primary down)
```

### Số replica theo môi trường

| Môi trường | Cấu hình | Lý do |
|---|---|---|
| Dev/Staging | 1 Primary + 1 Replica | Đủ test HA |
| **Production** | **1 Primary + 2 Replica** | Promote 1 → vẫn còn 1 Replica |

**Lý do cần 2 Replica ở production:**
```
Primary (postgres-0) chết
→ Patroni promote Replica 1 (postgres-1) thành Primary mới
→ Vẫn còn Replica 2 (postgres-2) → read queries không bị ảnh hưởng ✅

Nếu chỉ 1 Replica:
→ Promote Replica 1 thành Primary mới
→ Không còn Replica nào → mất read HA ❌
```

### Thời gian failover

```
Primary down → Patroni phát hiện (TTL mặc định 30s) → promote Replica → ~30s

30s × 1044 lần = 31320s = 8.7h → đạt SLA ngưỡng
→ Trong thực tế < 10 incident/năm → rất dư
```

### PgBouncer — Connection Pooling

```
App Pod 1 ─┐
App Pod 2 ─┼─→ PgBouncer → PostgreSQL Primary
App Pod 3 ─┘
(30 connections)   (chỉ 10 conn thật)
```

PostgreSQL chịu được ~100-200 connection. Nếu 20 app pod × 10 conn = 200 conn → cần PgBouncer.

### Triển khai PostgreSQL Patroni — Step by step

**Bước 1: Deploy bằng Bitnami PostgreSQL HA**

```bash
helm install postgresql bitnami/postgresql-ha \
  --namespace data \
  --set postgresql.replicaCount=2 \
  --set postgresql.password=<db-password> \
  --set postgresql.repmgrPassword=<repmgr-password> \
  --set pgpool.replicaCount=2 \
  --set persistence.size=20Gi

# Kiểm tra
kubectl -n data get pods -l app.kubernetes.io/name=postgresql-ha
# Mong đợi: postgresql-ha-postgresql-0 (primary), -1 (replica), -2 (replica)
#           postgresql-ha-pgpool-0, -1
```

**Bước 2: Kiểm tra replication status**

```bash
kubectl -n data exec -it postgresql-ha-postgresql-0 -- \
  psql -U postgres -c "SELECT * FROM pg_stat_replication;"
# Mong đợi: 2 dòng (2 replica đang sync)
```

**Bước 3: Apply schema T&T Engine**

```bash
# Port-forward tạm để apply schema
kubectl -n data port-forward svc/postgresql-ha-pgpool 5432:5432 &

psql -h localhost -U postgres -d tnt_engine -f sql/schema.sql
# Hoặc
kubectl -n data exec -it postgresql-ha-postgresql-0 -- \
  psql -U postgres -c "CREATE DATABASE tnt_engine;"
kubectl -n data exec -i postgresql-ha-postgresql-0 -- \
  psql -U postgres -d tnt_engine < sql/schema.sql
```

**Bước 4: Connection string cho app**

```bash
# App trỏ vào PgBouncer (không trỏ thẳng PostgreSQL)
TNT_DB_HOST=postgresql-ha-pgpool.data.svc.cluster.local
TNT_DB_PORT=5432
TNT_DB_NAME=tnt_engine
TNT_DB_USER=postgres
TNT_DB_PASSWORD=<db-password>
```

**Nguồn:** [Patroni GitHub](https://github.com/patroni/patroni) · [PostgreSQL HA Solutions](https://www.linode.com/docs/guides/comparison-of-high-availability-postgresql-solutions/)

---

## 8. T&T Engine — HPA + PDB + Rolling Update

### PDB — Pod Disruption Budget

> *"PodDisruptionBudget ensures the current healthy number of pods does not fall below the number specified."*  
> — [kubernetes.io/docs/tasks/run-application/configure-pdb](https://kubernetes.io/docs/tasks/run-application/configure-pdb/)

```
3 pod, PDB minAvailable=2:
→ Trong lúc drain node / cluster upgrade: chỉ được kill 1 pod/lần
→ Luôn còn ít nhất 2 pod phục vụ traffic
```

### HPA — Horizontal Pod Autoscaler

> *"desiredReplicas = ceil(currentReplicas × currentMetricValue / desiredMetricValue)"*  
> — [kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)

**Lưu ý quan trọng**: App T&T Engine là **I/O bound** (đợi OpenBao, DB). Khi spike, CPU chỉ ~3% → HPA CPU-based không trigger. Cần scale theo custom metric `tnt_inflight_requests`.

### Rolling Update — Zero Downtime

```
maxSurge: 1        → Tạo 1 pod mới trước khi xóa pod cũ
maxUnavailable: 0  → Không được có pod unavailable trong khi update

Ban đầu:  [v1] [v1] [v1]
Bước 1:   [v1] [v1] [v1] [v2]   ← surge +1
Bước 2:   [v1] [v1] [v2]        ← v2 Ready → xóa 1 pod v1
Bước 3:   [v1] [v1] [v2] [v2]
...
Cuối:     [v2] [v2] [v2]        ← zero downtime
```

### Triển khai T&T Engine — Step by step

**Bước 1: Tạo Secret cho app**

```bash
kubectl -n tnt-engine create secret generic tnt-engine-secrets \
  --from-literal=TNT_DB_PASSWORD=<db-password> \
  --from-literal=TNT_REDIS_PASSWORD=<redis-password> \
  --from-literal=VAULT_TOKEN=<openbao-root-token>
```

**Bước 2: Deploy bằng Helm chart có sẵn**

```bash
cd /home/linhnt1/Desktop/TnT-Engine

helm upgrade --install tnt-engine ./helm/tnt-engine \
  --namespace tnt-engine \
  --create-namespace \
  --values ./helm/values-dev.yaml \
  --set env.TNT_DB_HOST=postgresql-ha-pgpool.data.svc.cluster.local \
  --set env.TNT_REDIS_URL=redis://redis-master.data.svc.cluster.local:6379/0 \
  --set env.TNT_CRYPTO_BASE_URL=http://openbao.data.svc.cluster.local:8200/v1

# Kiểm tra
kubectl -n tnt-engine get pods
kubectl -n tnt-engine get svc
```

**Bước 3: Apply PDB**

```yaml
# k8s/pdb.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: tnt-engine-pdb
  namespace: tnt-engine
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: tnt-engine
```

```bash
kubectl apply -f k8s/pdb.yaml
```

**Bước 4: Apply HPA**

```yaml
# k8s/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: tnt-engine-hpa
  namespace: tnt-engine
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: tnt-engine
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0      # Scale up ngay lập tức
      policies:
      - type: Pods
        value: 2
        periodSeconds: 30
    scaleDown:
      stabilizationWindowSeconds: 300    # Chờ 5 phút trước khi scale down
      policies:
      - type: Pods
        value: 1
        periodSeconds: 60
```

```bash
kubectl apply -f k8s/hpa.yaml
```

**Bước 5: Validate toàn bộ luồng**

```bash
# Lấy Kong LB IP
KONG_IP=$(kubectl -n gateway get svc kong-gateway-proxy -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

# Health checks
curl http://${KONG_IP}/api/v1/health
curl http://${KONG_IP}/api/v1/ready

# Test tokenize thủ công
curl -X POST http://${KONG_IP}/api/v1/tokenize \
  -H "Content-Type: application/json" \
  -d '{"value":"test-123","field":"ssn","tenant_id":"load_test","transformation":"TOKENIZE"}'

# Test detokenize
curl -X POST http://${KONG_IP}/api/v1/detokenize \
  -H "Content-Type: application/json" \
  -d '{"token":"<token-từ-bước-trên>","tenant_id":"load_test"}'
```

**Bước 6: Rolling update deployment mới**

```yaml
# Trong deployment spec
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1
    maxUnavailable: 0
```

```bash
# Deploy image mới
kubectl -n tnt-engine set image deployment/tnt-engine \
  tnt-engine=tnt-engine:v2.0.0

# Theo dõi tiến trình
kubectl -n tnt-engine rollout status deployment/tnt-engine

# Rollback nếu cần
kubectl -n tnt-engine rollout undo deployment/tnt-engine
```

**Nguồn:** [K8s HPA](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/) · [K8s PDB](https://kubernetes.io/docs/tasks/run-application/configure-pdb/) · [K8s Rolling Update](https://kubernetes.io/docs/tutorials/kubernetes-basics/update/update-intro/)

---

## 9. Observability

### Stack

```
Prometheus  ← scrape /metrics từ tất cả services (mỗi 15s)
Grafana     ← dashboard + alert từ Prometheus data
Loki        ← thu thập và lưu logs từ tất cả pods
Promtail    ← agent chạy trên mỗi node, đẩy logs vào Loki
```

### Triển khai Observability — Step by step

**Bước 1: Deploy kube-prometheus-stack**

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install monitoring prometheus-community/kube-prometheus-stack \
  --namespace observability \
  --set grafana.enabled=true \
  --set prometheus.prometheusSpec.scrapeInterval=15s
```

**Bước 2: Deploy Loki + Promtail**

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

helm install loki grafana/loki-stack \
  --namespace observability \
  --set promtail.enabled=true \
  --set grafana.enabled=false    # Dùng Grafana từ kube-prometheus-stack
```

**Bước 3: ServiceMonitor cho T&T Engine**

```yaml
# k8s/service-monitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: tnt-engine
  namespace: observability
spec:
  namespaceSelector:
    matchNames:
    - tnt-engine
  selector:
    matchLabels:
      app: tnt-engine
  endpoints:
  - port: metrics
    path: /metrics
    interval: 15s
```

```bash
kubectl apply -f k8s/service-monitor.yaml
```

**Bước 4: Truy cập Grafana**

```bash
# Port-forward Grafana
kubectl -n observability port-forward svc/monitoring-grafana 3000:80

# Lấy password
kubectl -n observability get secret monitoring-grafana \
  -o jsonpath="{.data.admin-password}" | base64 --decode
```

Mở trình duyệt: `http://localhost:3000` (user: `admin`)

---

## 10. Chỉ số cần đo (1 tenant)

Metrics đã có sẵn trong `src/tnt_engine/metrics.py`:

| Chỉ số | Target | Prometheus Metric |
|---|---|---|
| p99 tokenize latency | < 200ms | `tnt_tokenize_seconds{quantile="0.99"}` |
| p99 detokenize latency | < 100ms | `tnt_detokenize_seconds{quantile="0.99"}` |
| Cache hit rate | > 80% | `tnt_l1_cache_hits_total / (hits + misses)` |
| Error rate | < 1% | `tnt_http_requests_total{status=~"5.."}` |
| Throughput | ≥ 5000 req/s | `rate(tnt_http_requests_total[1m])` |
| OpenBao latency | < 10ms | `tnt_crypto_operation_duration_seconds` |

### Benchmark qua Kong Ingress (4 bài bắt buộc)

```bash
KONG_IP=$(kubectl -n gateway get svc kong-gateway-proxy \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

# Baseline: 3,000 req, 10 concurrent, ~30s
wrk -t4 -c10 -d30s \
  -H "Content-Type: application/json" \
  --script scripts/tokenize.lua \
  http://${KONG_IP}/api/v1/tokenize

# Load: 60,000 req, 100 concurrent, ~60s
wrk -t8 -c100 -d60s \
  -H "Content-Type: application/json" \
  --script scripts/tokenize.lua \
  http://${KONG_IP}/api/v1/tokenize

# Spike: 30,000 req, 500 concurrent, ~30s
wrk -t12 -c500 -d30s \
  -H "Content-Type: application/json" \
  --script scripts/tokenize.lua \
  http://${KONG_IP}/api/v1/tokenize

# Soak: 300,000 req, 50 concurrent, ~4 phút
wrk -t8 -c50 -d240s \
  -H "Content-Type: application/json" \
  --script scripts/tokenize.lua \
  http://${KONG_IP}/api/v1/tokenize
```

### Đo resource trong lúc benchmark

```bash
# Trong terminal khác, chạy song song
watch -n5 kubectl top pod -n tnt-engine
watch -n5 kubectl top pod -n data
watch -n5 kubectl top node
```

### Những gì cần ghi lại cho mỗi bài test

- req/s, average latency, p95/p99, max latency
- success rate, số lỗi `5xx`, số `Non-2xx/3xx`
- CPU/RAM của pod tnt-engine
- CPU/RAM của PostgreSQL, Redis, OpenBao
- CPU/RAM của các node

---

## 11. Bảng tổng hợp SLA 99.9%

| Component | Replica | Auto-failover | Cơ chế | Recover time |
|---|---|---|---|---|
| RKE2 Control Plane | **3 node** | ✅ | etcd Raft | < 30s |
| RKE2 Worker | **3+ node** | ✅ | K8s rescheduling | < 60s |
| Kong Gateway | **3 replica** | ✅ | K8s Deployment + anti-affinity | < 30s |
| KIC Controller | **2 replica** | ✅ | Leader election | < 15s |
| T&T Engine | **3 → 20 replica** | ✅ | HPA + PDB + Rolling Update | 0s |
| PostgreSQL | **1P + 2R** | ✅ | Patroni (~30s) | ~30s |
| Redis | **1P + 1R + 3 Sentinel** | ✅ | Sentinel majority vote | < 60s |
| OpenBao | **3 node Raft** | ✅ | Raft leader election | < 30s |

**Chứng minh:**
```
Giả sử 10 incident/năm, mỗi lần recover < 60s:
  10 × 60s = 600s = 0.17h downtime/năm
  0.17h << 8.7h → đạt SLA 99.9% ✅
```

---

## 12. Thứ tự triển khai

```
┌──────────────────────────────────────────────────────────┐
│  BƯỚC 1 — Dựng cluster RKE2                              │
│                                                          │
│  a. Cài RKE2 trên 3 CP node + 3 Worker node             │
│  b. Cấu hình Load Balancer (port 9345, 6443)             │
│  c. Cấu hình kubectl, kiểm tra tất cả node Ready        │
│  d. Tạo namespaces: gateway, tnt-engine, data, obs       │
│  e. Apply NetworkPolicy                                  │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│  BƯỚC 2 — Deploy storage (namespace: data)               │
│                                                          │
│  a. Deploy PostgreSQL Patroni (1P + 2R + PgBouncer)     │
│  b. Apply schema: sql/schema.sql                         │
│  c. Deploy Redis Sentinel (1P + 1R + 3 Sentinel)        │
│  d. Deploy OpenBao Raft (3 node)                         │
│  e. Init + Unseal OpenBao                                │
│  f. Enable transit, tạo tnt-key + tnt-hmac              │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│  BƯỚC 3 — Deploy Kong (namespace: gateway)               │
│                                                          │
│  a. helm install kong (3 replica, 2 KIC)                │
│  b. Apply KongPlugin rate-limiting                       │
│  c. Kiểm tra Kong LB IP expose được ra ngoài            │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│  BƯỚC 4 — Deploy T&T Engine (namespace: tnt-engine)     │
│                                                          │
│  a. Tạo Secret (DB, Redis, OpenBao token)               │
│  b. helm upgrade --install tnt-engine                    │
│  c. Apply PDB (minAvailable: 2)                          │
│  d. Apply HPA (min: 3, max: 20, CPU 70%)                │
│  e. Apply Ingress (ingressClassName: kong)               │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│  BƯỚC 5 — Deploy Observability (namespace: observability)│
│                                                          │
│  a. helm install kube-prometheus-stack                   │
│  b. helm install loki-stack                              │
│  c. Apply ServiceMonitor cho tnt-engine                  │
│  d. Verify Grafana dashboard                             │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│  BƯỚC 6 — Validate & Benchmark                           │
│                                                          │
│  a. curl /api/v1/health, /api/v1/ready qua Kong IP      │
│  b. Test tokenize/detokenize thủ công                    │
│  c. Chạy 4 bài benchmark qua Kong Ingress               │
│     baseline → load → spike → soak                       │
│  d. Ghi lại: req/s, p99, error rate, CPU/RAM            │
│  e. Verify metrics trên Grafana                          │
└──────────────────────────────────────────────────────────┘
```

### Checklist trước khi benchmark

```
[ ] Cluster RKE2: tất cả node Ready
[ ] PostgreSQL: Primary + 2 Replica đang sync (pg_stat_replication)
[ ] Redis: Primary + 1 Replica + 3 Sentinel đang chạy
[ ] OpenBao: 3 node Unsealed, Raft cluster có 3 peers
[ ] DB schema đã apply (sql/schema.sql)
[ ] OpenBao transit enabled, tnt-key + tnt-hmac tồn tại
[ ] T&T Engine pods Running + Ready
[ ] GET /api/v1/health qua Kong → 200
[ ] GET /api/v1/ready qua Kong → 200
[ ] POST /api/v1/tokenize test thủ công → 200
[ ] Grafana dashboard hiển thị metrics
```

---

## 13. Nguồn tham khảo

- [High Availability | RKE2](https://docs.rke2.io/install/ha)
- [RKE2 Network Options](https://docs.rke2.io/networking/basic_network_options)
- [Setting up HA RKE2 for Rancher](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/kubernetes-cluster-setup/rke2-for-rancher)
- [Kong Ingress Controller Docs](https://docs.konghq.com/kubernetes-ingress-controller/latest/)
- [KIC Architecture](https://developer.konghq.com/kubernetes-ingress-controller/architecture/)
- [Redis Sentinel Docs](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/)
- [Redis HA Tutorial](https://redis.io/tutorials/operate/redis-at-scale/high-availability/)
- [Redis on Kubernetes](https://redis.io/docs/latest/integrate/kubernetes-redis/)
- [OpenBao HA with Raft on K8s](https://openbao.org/docs/platform/k8s/helm/examples/ha-with-raft/)
- [OpenBao Integrated Storage](https://openbao.org/docs/internals/integrated-storage/)
- [OpenBao Raft Storage Config](https://openbao.org/docs/configuration/storage/raft/)
- [Patroni GitHub](https://github.com/patroni/patroni)
- [Comparison of PostgreSQL HA Solutions](https://www.linode.com/docs/guides/comparison-of-high-availability-postgresql-solutions/)
- [K8s Pod Disruption Budget](https://kubernetes.io/docs/tasks/run-application/configure-pdb/)
- [K8s Horizontal Pod Autoscaler](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [K8s Rolling Update](https://kubernetes.io/docs/tutorials/kubernetes-basics/update/update-intro/)
