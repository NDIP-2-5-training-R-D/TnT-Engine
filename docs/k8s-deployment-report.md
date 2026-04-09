# TnT Engine — K8s Deployment Report

**Môi trường:** Ubuntu 24.04 LTS, single VM `Geic-DashCam-VM1` (IP: `10.10.55.11`)  
**Ngày triển khai:** 2026-04-09  
**Trạng thái:** Hoàn tất — toàn bộ stack đang chạy trên Kubernetes

---

## Kiến trúc tổng quan

```
Client
  │
  ▼
Kong Gateway (NodePort :30911)
  │
  ▼
Kong Ingress → tnt-engine Service (ClusterIP)
  │
  ▼
TnT Engine Pod (:8000)
  │
  ├── PostgreSQL 16  (data namespace)
  ├── Redis 7        (data namespace)
  └── OpenBao 2.5.2  (data namespace)
```

**Namespace layout:**

| Namespace | Thành phần |
|-----------|------------|
| `kube-system` | RKE2, Cilium CNI, CoreDNS, ingress-nginx, metrics-server |
| `local-path-storage` | local-path-provisioner (StorageClass) |
| `data` | PostgreSQL, Redis, OpenBao |
| `gateway` | Kong Gateway, Kong Ingress Controller |
| `tnt-engine` | TnT Engine app |

---

## Phần 1: Cài đặt Kubernetes (RKE2)

### 1.1 Cài RKE2

```bash
curl -sfL https://get.rke2.io | sudo sh -
sudo systemctl enable rke2-server --now
```

### 1.2 Cấu hình `/etc/rancher/rke2/config.yaml`

```yaml
token: tnt-engine-secret-2026
tls-san:
  - 10.10.55.11
  - localhost
cni: cilium
node-taint: []
```

### 1.3 Cài kubectl và helm

```bash
# kubectl
sudo cp /var/lib/rancher/rke2/bin/kubectl /usr/local/bin/
sudo chmod +x /usr/local/bin/kubectl

# kubeconfig
mkdir -p ~/.kube
sudo cp /etc/rancher/rke2/rke2.yaml ~/.kube/config
sudo chown $USER ~/.kube/config

# helm
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
```

### 1.4 Cài local-path-provisioner (StorageClass)

> RKE2 không có default StorageClass — cần cài thêm để PVC hoạt động.

```bash
BASE="https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.28/deploy/"
FILE="local-path-storage.yaml"
kubectl apply -f "${BASE}${FILE}"

# Đặt làm default StorageClass
kubectl patch storageclass local-path \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

### 1.5 Kiểm tra node

```bash
kubectl get nodes
# NAME                  STATUS   ROLES                       AGE
# geic-dashcam-vm1      Ready    control-plane,etcd,master   ...
```

---

## Phần 2: Deploy Kong Gateway

```bash
# Thêm Helm repo
helm repo add kong https://charts.konghq.com
helm repo update

# Tạo namespace
kubectl create namespace gateway

# Cài Kong với KIC (Kong Ingress Controller)
helm upgrade --install kong kong/ingress \
  -n gateway \
  --set controller.ingressController.enabled=true \
  --set proxy.type=NodePort
```

**Verify:**

```bash
kubectl -n gateway get pods
# kong-controller-...   1/1 Running
# kong-gateway-...      1/1 Running

kubectl -n gateway get svc kong-gateway-proxy
# PORT(S): 80:30911/TCP, 443:32592/TCP
```

---

## Phần 3: Deploy Data Layer

### 3.1 Tạo namespace

```bash
kubectl create namespace data
```

### 3.2 PostgreSQL 16

Lưu vào `/tmp/postgres.yaml`:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: postgres-secret
  namespace: data
type: Opaque
stringData:
  POSTGRES_PASSWORD: tnt_password
  POSTGRES_DB: tnt_engine
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-pvc
  namespace: data
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 5Gi
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: data
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
      - name: postgres
        image: postgres:16
        ports:
        - containerPort: 5432
        envFrom:
        - secretRef:
            name: postgres-secret
        env:
        - name: POSTGRES_USER
          value: postgres
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: postgres-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: data
spec:
  selector:
    app: postgres
  ports:
  - port: 5432
    targetPort: 5432
```

```bash
kubectl apply -f /tmp/postgres.yaml
kubectl -n data wait pod/postgres-0 --for=condition=Ready --timeout=60s
```

**Apply schema:**

```bash
kubectl -n data exec postgres-0 -- psql -U postgres -d tnt_engine \
  -f /dev/stdin < sql/schema.sql
```

### 3.3 Redis 7

Lưu vào `/tmp/redis.yaml`:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
  namespace: data
spec:
  serviceName: redis
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
      - name: redis
        image: redis:7
        command: ["redis-server", "--requirepass", "tnt_redis_pass"]
        ports:
        - containerPort: 6379
        volumeMounts:
        - name: data
          mountPath: /data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ReadWriteOnce]
      resources:
        requests:
          storage: 2Gi
---
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: data
spec:
  selector:
    app: redis
  ports:
  - port: 6379
    targetPort: 6379
```

```bash
kubectl apply -f /tmp/redis.yaml
kubectl -n data wait pod/redis-0 --for=condition=Ready --timeout=60s
```

### 3.4 OpenBao (dev mode)

```bash
helm repo add hashicorp https://helm.releases.hashicorp.com
helm repo update

helm upgrade --install openbao openbao/openbao \
  -n data \
  --set server.dev.enabled=true \
  --set server.dev.devRootToken=root-token-dev \
  --set injector.enabled=true

kubectl -n data wait pod/openbao-0 --for=condition=Ready --timeout=60s
```

**Khởi tạo transit engine và keys:**

```bash
# Enable transit
kubectl -n data exec openbao-0 -- env VAULT_TOKEN=root-token-dev \
  bao secrets enable transit

# Tạo encryption key
kubectl -n data exec openbao-0 -- env VAULT_TOKEN=root-token-dev \
  bao write -f transit/keys/tnt-key

# Tạo HMAC key
kubectl -n data exec openbao-0 -- env VAULT_TOKEN=root-token-dev \
  bao write -f transit/keys/tnt-hmac type=hmac
```

---

## Phần 4: Build và import TnT Engine image

> RKE2 dùng containerd, không dùng Docker daemon. Image phải được import qua `ctr`.

```bash
cd ~/Desktop/TnT-Engine

# Build image
docker build -t tnt-engine:vmbench .

# Import vào RKE2 containerd
docker save tnt-engine:vmbench | sudo ctr -n k8s.io images import -

# Verify
sudo ctr -n k8s.io images list | grep tnt-engine
```

---

## Phần 5: Deploy TnT Engine qua Helm

### 5.1 Values file (`helm/values-k8s.yaml`)

```yaml
replicaCount: 1

image:
  repository: tnt-engine
  tag: vmbench
  pullPolicy: Never

securityContext:
  runAsNonRoot: false
  readOnlyRootFilesystem: false
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]

autoscaling:
  enabled: false

pdb:
  enabled: false

ingress:
  enabled: true
  className: kong
  annotations: {}
  hosts:
    - host: tnt-engine.internal
      paths:
        - path: /
          pathType: Prefix

config:
  TNT_DB_HOST: "postgres.data.svc.cluster.local"
  TNT_DB_PORT: "5432"
  TNT_DB_NAME: "tnt_engine"
  TNT_DB_USER: "postgres"
  TNT_DB_POOL_MIN: "2"
  TNT_DB_POOL_MAX: "10"
  TNT_REDIS_URL: "redis://:tnt_redis_pass@redis.data.svc.cluster.local:6379/0"
  TNT_CRYPTO_BASE_URL: "http://openbao.data.svc.cluster.local:8200/v1"
  TNT_CRYPTO_VERIFY_SSL: "false"
  TNT_ENVIRONMENT: "development"
  TNT_L1_MAX_SIZE: "1000"
  TNT_WORKER_CLEANUP_INTERVAL_SECONDS: "120"

secrets:
  TNT_DB_PASSWORD: "tnt_password"
  TNT_CRYPTO_TOKEN: "root-token-dev"

networkPolicy:
  enabled: false
```

> **Lưu ý:** `networkPolicy: enabled: false` là bắt buộc vì PostgreSQL/Redis/OpenBao nằm ở namespace `data`, không cùng namespace với app. NetworkPolicy mặc định chỉ cho phép egress trong cùng namespace.

### 5.2 Deploy

```bash
cd ~/Desktop/TnT-Engine
helm upgrade --install tnt-engine ./helm/tnt-engine \
  -n tnt-engine --create-namespace \
  -f ./helm/values-k8s.yaml
```

### 5.3 Verify

```bash
kubectl -n tnt-engine get pods
# NAME                          READY   STATUS    RESTARTS   AGE
# tnt-engine-xxxxx-xxxxx        1/1     Running   0          ...
```

---

## Phần 6: Truy cập app

### Kiểm tra health endpoint

```bash
# Thêm hostname vào /etc/hosts (chỉ cần làm 1 lần)
echo "10.10.55.11 tnt-engine.internal" | sudo tee -a /etc/hosts

# Gọi qua Kong
curl http://tnt-engine.internal:30911/api/v1/health
```

**Response mong đợi:**
```json
{
  "status": "ok",
  "circuit_breaker": "CLOSED",
  "l1_cache_size": 0,
  "vault": {
    "status": "healthy",
    "initialized": true,
    "sealed": false,
    "version": "2.5.2"
  }
}
```

### Các endpoint chính

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/api/v1/health` | Full health check |
| GET | `/api/v1/ready` | Readiness probe |
| POST | `/api/v1/tokens` | Tạo token mới |
| GET | `/api/v1/tokens/{id}` | Lấy token |
| DELETE | `/api/v1/tokens/{id}` | Thu hồi token |

### Ví dụ tạo token

```bash
curl -s -X POST http://tnt-engine.internal:30911/api/v1/tokens \
  -H "Content-Type: application/json" \
  -d '{"tenant_id":"tenant-001","metadata":{"user":"test"}}'
```

---

## Phần 7: Troubleshooting

### Pod CrashLoopBackOff

```bash
# Xem logs crash
kubectl -n tnt-engine logs <pod-name> --previous

# Kiểm tra events
kubectl -n tnt-engine describe pod <pod-name>
```

**Nguyên nhân thường gặp:**

| Triệu chứng | Nguyên nhân | Fix |
|-------------|-------------|-----|
| Connection refused tới DB/Redis/OpenBao | NetworkPolicy block egress cross-namespace | `networkPolicy: enabled: false` trong values |
| ImagePullBackOff | Image chưa import vào containerd | `docker save ... \| sudo ctr -n k8s.io images import -` |
| CrashLoopBackOff + schema error | Schema chưa được apply | `kubectl exec postgres-0 -- psql ... < sql/schema.sql` |

### Xem logs app

```bash
kubectl -n tnt-engine logs -f deployment/tnt-engine
```

### Restart deployment

```bash
kubectl -n tnt-engine rollout restart deployment tnt-engine
kubectl -n tnt-engine rollout status deployment tnt-engine
```

---

## Phần 8: Trạng thái hiện tại (2026-04-09)

| Component | Version | Status | Note |
|-----------|---------|--------|------|
| RKE2 | v1.32+ | Running | Single-node, Cilium CNI |
| Kong Gateway | latest | Running | NodePort HTTP:30911, HTTPS:32592 |
| PostgreSQL | 16 | Running | 5Gi PVC, schema applied |
| Redis | 7 | Running | 2Gi PVC, auth enabled |
| OpenBao | 2.5.2 | Running | Dev mode, transit enabled |
| TnT Engine | 0.4.0 (vmbench) | Running 1/1 | Healthy, all deps OK |

**Bước tiếp theo:** xem Phần 9, 10, 11 bên dưới.

---

## Phần 9: Khởi động và tắt app

### Tắt

```bash
# Bước 1 — Graceful shutdown app
kubectl -n tnt-engine scale deployment tnt-engine --replicas=0

# Bước 2 — Tắt K8s
sudo systemctl stop rke2-server
```

### Bật lại

K8s tự bật lại **tất cả pods** khi RKE2 start — không cần làm thủ công từng service.  
Chỉ cần 3 bước:

```bash
# Bước 1 — Bật RKE2
sudo systemctl start rke2-server

# Bước 2 — Chờ pods tự lên (~1-2 phút)
kubectl get pods -A -w
# Chờ postgres-0, redis-0, openbao-0, tnt-engine đều Running rồi Ctrl+C

# Bước 3 — Re-init OpenBao (bắt buộc vì dev mode mất keys sau mỗi lần restart)
kubectl -n data exec openbao-0 -- env VAULT_TOKEN=root-token-dev bao secrets enable transit
kubectl -n data exec openbao-0 -- env VAULT_TOKEN=root-token-dev bao write -f transit/keys/tnt-key
kubectl -n data exec openbao-0 -- env VAULT_TOKEN=root-token-dev bao write -f transit/keys/tnt-hmac type=hmac
```

**Verify:**

```bash
curl http://tnt-engine.internal:30911/api/v1/health
# Kết quả mong đợi: "status":"ok" và "vault":"healthy"
```

> Nếu TnT Engine crash trước khi OpenBao kịp lên, nó sẽ tự restart và healthy sau khi OpenBao sẵn sàng — không cần can thiệp thủ công.

### Xóa hoàn toàn TnT Engine (giữ data layer)

```bash
helm uninstall tnt-engine -n tnt-engine
```

### Xóa toàn bộ và cài lại từ đầu

```bash
kubectl delete namespace tnt-engine data gateway
# Cài lại từ Phần 2 trở đi
```

---

## Phần 10: Task tiếp theo

### Task 1 — Chạy benchmark

**Mục tiêu đo:**

| Metric | Target |
|--------|--------|
| p99 latency | < 200ms |
| Error rate | < 0.1% |
| Cache hit rate | > 80% |
| Uptime | 99.9% (≤ 8.76h/year downtime) |

**Cài `hey` (load testing tool):**

```bash
# Trên Ubuntu
go install github.com/rakyll/hey@latest
# hoặc
sudo apt install hey
```

**Bước 1 — Smoke test (verify endpoints hoạt động):**

```bash
BASE="http://tnt-engine.internal:30911"

# Health
curl -s $BASE/api/v1/health | python3 -m json.tool

# Tạo token
TOKEN_RESP=$(curl -s -X POST $BASE/api/v1/tokens \
  -H "Content-Type: application/json" \
  -d '{"tenant_id":"tenant-001","metadata":{"env":"bench"}}')
echo $TOKEN_RESP

TOKEN_ID=$(echo $TOKEN_RESP | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

# Lấy token
curl -s $BASE/api/v1/tokens/$TOKEN_ID | python3 -m json.tool

# Detokenize
curl -s -X DELETE $BASE/api/v1/tokens/$TOKEN_ID
```

**Bước 2 — Baseline load test:**

```bash
# 50 concurrent, 1000 requests
hey -n 1000 -c 50 \
  -m POST \
  -H "Content-Type: application/json" \
  -d '{"tenant_id":"tenant-001","metadata":{"env":"bench"}}' \
  http://tnt-engine.internal:30911/api/v1/tokens
```

**Bước 3 — Spike test:**

```bash
# 200 concurrent, 5000 requests
hey -n 5000 -c 200 \
  -m GET \
  http://tnt-engine.internal:30911/api/v1/health
```

**Bước 4 — Soak test (10 phút):**

```bash
# 20 concurrent, chạy liên tục 10 phút
hey -z 10m -c 20 \
  -m POST \
  -H "Content-Type: application/json" \
  -d '{"tenant_id":"tenant-001","metadata":{"env":"soak"}}' \
  http://tnt-engine.internal:30911/api/v1/tokens
```

---

### Task 3 — Observability (Prometheus + Grafana)

TnT Engine đã expose metrics tại `/metrics` (Prometheus format). Cần deploy stack observability để dashboard được.

**Deploy kube-prometheus-stack:**

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

kubectl create namespace monitoring

helm upgrade --install kube-prom prometheus-community/kube-prometheus-stack \
  -n monitoring \
  --set grafana.service.type=NodePort \
  --set grafana.service.nodePort=32000 \
  --set prometheus.prometheusSpec.podMonitorSelectorNilUsesHelmValues=false \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false
```

**Truy cập Grafana:**
- URL: `http://10.10.55.11:32000`
- User: `admin` / Password: `prom-operator`

**Metrics TnT Engine tự động scrape** vì pod đã có annotations:
```yaml
prometheus.io/scrape: "true"
prometheus.io/port: "8000"
prometheus.io/path: "/metrics"
```

---

### Task 4 — Cấu hình NetworkPolicy đúng (production hardening)

Hiện tại `networkPolicy: enabled: false` để bypass vấn đề cross-namespace. Nếu cần bật lại cho môi trường production, sửa `helm/tnt-engine/templates/networkpolicy.yaml` để thêm `namespaceSelector`:

```yaml
egress:
  - to:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: data
        podSelector:
          matchLabels:
            app: postgres
    ports:
      - port: 5432
  # tương tự cho redis, openbao
```

Sau đó bật lại trong values-k8s.yaml:
```yaml
networkPolicy:
  enabled: true
```
