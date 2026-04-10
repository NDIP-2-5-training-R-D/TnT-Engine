# TnT Engine — K8s Deployment Guide

**Môi trường:** Ubuntu 24.04 LTS  
**Ngày triển khai:** 2026-04-09  
**Stack:** RKE2 (Kubernetes) + Kong Gateway + PostgreSQL + Redis + OpenBao

---

## Hai chế độ triển khai

| | Mode A: Single VM | Mode B: Two VM (HA) |
|--|--|--|
| Số VM | 1 (VM1) | 2 (VM1 + VM2) |
| PostgreSQL | 1 instance | Primary (VM1) + Replica (VM2) |
| Redis | 1 instance | Primary + Replica + 3 Sentinel |
| Failover | Không | Tự động, 0 downtime |
| Phù hợp | Dev / Benchmark | Production SLA 99.9% |

---

## Bước chung 1: Cài đặt RKE2 trên VM1

### Cài RKE2

```bash
curl -sfL https://get.rke2.io | sudo sh -
sudo systemctl enable rke2-server --now
```

### Cấu hình `/etc/rancher/rke2/config.yaml`

```yaml
token: tnt-engine-secret-2026
tls-san:
  - 10.10.55.11
  - localhost
cni: cilium
node-taint: []
```

### Cài kubectl và helm

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

### Cài local-path-provisioner (StorageClass)

> RKE2 không có default StorageClass — cần cài thêm để PVC hoạt động.

```bash
BASE="https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.28/deploy/"
kubectl apply -f "${BASE}local-path-storage.yaml"
kubectl patch storageclass local-path \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

### Verify

```bash
kubectl get nodes
# NAME                  STATUS   ROLES                       AGE
# geic-dashcam-vm1      Ready    control-plane,etcd,master   ...
```

---

## Bước chung 2: Deploy Kong Gateway

```bash
helm repo add kong https://charts.konghq.com && helm repo update
kubectl create namespace gateway

helm upgrade --install kong kong/ingress \
  -n gateway \
  --set controller.ingressController.enabled=true \
  --set proxy.type=NodePort
```

**Verify:**

```bash
kubectl -n gateway get pods
kubectl -n gateway get svc kong-gateway-proxy
# PORT(S): 80:30911/TCP, 443:32592/TCP
```

---

## Bước chung 3: Deploy OpenBao

```bash
helm repo add hashicorp https://helm.releases.hashicorp.com && helm repo update

helm upgrade --install openbao openbao/openbao \
  -n data --create-namespace \
  --set server.dev.enabled=true \
  --set server.dev.devRootToken=root-token-dev \
  --set injector.enabled=true

kubectl -n data wait pod/openbao-0 --for=condition=Ready --timeout=60s
```

**Khởi tạo transit engine và keys:**

```bash
kubectl -n data exec openbao-0 -- env VAULT_TOKEN=root-token-dev bao secrets enable transit
kubectl -n data exec openbao-0 -- env VAULT_TOKEN=root-token-dev bao write -f transit/keys/tnt-key
kubectl -n data exec openbao-0 -- env VAULT_TOKEN=root-token-dev bao write -f transit/keys/tnt-hmac type=hmac key_size=32
```

---

## Bước chung 4: Build TnT Engine image

> RKE2 dùng containerd, không dùng Docker daemon. Image phải import qua `ctr`.

```bash
cd ~/Desktop/TnT-Engine
docker build -t tnt-engine:vmbench .
docker save tnt-engine:vmbench | sudo ctr -n k8s.io images import -
sudo ctr -n k8s.io images list | grep tnt-engine
```

---

## Mode A: Single VM

### A1: Deploy PostgreSQL + Redis

```bash
kubectl create namespace data
```

**PostgreSQL** — lưu vào `/tmp/postgres.yaml`:

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
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ReadWriteOnce]
      resources:
        requests:
          storage: 5Gi
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
kubectl -n data exec postgres-0 -- psql -U postgres -d tnt_engine -f /dev/stdin < sql/schema.sql
```

**Redis** — lưu vào `/tmp/redis.yaml`:

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

### A2: Deploy TnT Engine

```bash
cd ~/Desktop/TnT-Engine
bash scripts/k8s-deploy.sh
```

Script chạy:
```bash
helm upgrade --install tnt-engine ./helm/tnt-engine \
  -n tnt-engine --create-namespace \
  -f ./helm/values-k8s.yaml
```

### A3: Verify

```bash
kubectl -n tnt-engine get pods
curl http://tnt-engine.internal:30911/api/v1/health
```

---

## Mode B: Two VM (HA)

### B1: Setup VM2 làm Worker Node

Lấy token từ VM1:

```bash
sudo cat /var/lib/rancher/rke2/server/node-token
```

Mở firewall VM1 cho VM2:

```bash
sudo ufw allow from 10.10.55.12 comment "VM2 node"
sudo ufw reload
```

Copy script lên VM2, sửa `RKE2_TOKEN`, rồi chạy:

```bash
scp scripts/ha-setup-vm2.sh linhnt1@10.10.55.12:~/Desktop/
ssh linhnt1@10.10.55.12
nano ~/Desktop/ha-setup-vm2.sh   # sửa RKE2_TOKEN
bash ~/Desktop/ha-setup-vm2.sh
```

Script tự động: mở UFW ports (8472/udp Cilium VXLAN, 10250/tcp Kubelet), cài RKE2 agent, join cluster.

Verify trên **VM1**:

```bash
kubectl get nodes -o wide
# geic-dashcam-vm1   Ready    control-plane,etcd   ...
# geic-dashcam-vm2   Ready    <none>               ...
```

### B2: Deploy HA Storage (PostgreSQL + Redis)

Trên **VM1**:

```bash
bash scripts/ha-setup-storage.sh
```

Script tự động:
- Label nodes (VM1=primary, VM2=replica)
- Deploy PostgreSQL Primary (VM1) + Replica (VM2) + streaming replication
- Tạo replication user và cập nhật `pg_hba.conf`
- Deploy Redis Primary (VM1) + Replica (VM2) + 3 Sentinel (quorum=2)

Verify:

```bash
kubectl -n data get pods -o wide
# postgres-primary-0   1/1 Running   geic-dashcam-vm1
# postgres-replica-0   1/1 Running   geic-dashcam-vm2
# redis-primary-0      1/1 Running   geic-dashcam-vm1
# redis-replica-0      1/1 Running   geic-dashcam-vm2
# redis-sentinel-*     1/1 Running   (3 pods)
```

### B3: Deploy TnT Engine

Giống Mode A — deploy TnT Engine dùng `postgres.data.svc.cluster.local` (trỏ vào primary):

```bash
bash scripts/k8s-deploy.sh
```

### B4: Test Failover

```bash
bash scripts/ha-test-failover.sh
```

Kết quả mong đợi: **60/60 success, 0 errors** cho cả PostgreSQL và Redis failover.

---

## Truy cập app

```bash
# Thêm hostname vào /etc/hosts (chỉ cần làm 1 lần)
echo "10.10.55.11 tnt-engine.internal" | sudo tee -a /etc/hosts

curl http://tnt-engine.internal:30911/api/v1/health
```

**Response mong đợi:**
```json
{
  "status": "ok",
  "circuit_breaker": "CLOSED",
  "vault": { "status": "healthy", "sealed": false }
}
```

### Các endpoint chính

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/api/v1/health` | Full health check |
| GET | `/api/v1/ready` | Readiness probe |
| POST | `/api/v1/tokenize` | Tokenize giá trị |
| POST | `/api/v1/detokenize` | Detokenize token |
| GET | `/metrics/` | Prometheus metrics |

---

## Khởi động và tắt

### Tắt

```bash
kubectl -n tnt-engine scale deployment tnt-engine --replicas=0
sudo systemctl stop rke2-server
```

### Bật lại (VM1)

```bash
# 1. Bật RKE2
sudo systemctl start rke2-server

# 2. Chờ pods tự lên (~1-2 phút)
kubectl get pods -A | grep -v Running | grep -v Completed

# 3. Re-init OpenBao (bắt buộc vì dev mode mất keys sau mỗi restart)
kubectl -n data exec openbao-0 -- env VAULT_TOKEN=root-token-dev bao secrets enable transit
kubectl -n data exec openbao-0 -- env VAULT_TOKEN=root-token-dev bao write -f transit/keys/tnt-key
kubectl -n data exec openbao-0 -- env VAULT_TOKEN=root-token-dev bao write -f transit/keys/tnt-hmac type=hmac key_size=32

# 4. Verify
curl http://tnt-engine.internal:30911/api/v1/health
```

### Bật lại VM2 (Mode B)

```bash
# Trên VM2
sudo systemctl start rke2-agent

# Verify trên VM1
kubectl get nodes -o wide
```

### Xóa và cài lại

```bash
# Chỉ xóa TnT Engine (giữ data)
helm uninstall tnt-engine -n tnt-engine

# Xóa toàn bộ
kubectl delete namespace tnt-engine data gateway
```

---

## Troubleshooting

```bash
# Xem logs crash
kubectl -n tnt-engine logs <pod-name> --previous
kubectl -n tnt-engine describe pod <pod-name>

# Logs realtime
kubectl -n tnt-engine logs -f deployment/tnt-engine

# Restart deployment
kubectl -n tnt-engine rollout restart deployment tnt-engine
```

**Nguyên nhân thường gặp:**

| Triệu chứng | Nguyên nhân | Fix |
|-------------|-------------|-----|
| Connection refused tới DB/Redis/OpenBao | NetworkPolicy block egress cross-namespace | `networkPolicy: enabled: false` trong values |
| ImagePullBackOff | Image chưa import vào containerd | `docker save ... \| sudo ctr -n k8s.io images import -` |
| CrashLoopBackOff + schema error | Schema chưa apply | `kubectl exec postgres-0 -- psql ... < sql/schema.sql` |
| postgres-replica Init:0/1 mãi | UFW VM2 block Cilium VXLAN | Mở port 8472/udp trên VM2 |
| redis-sentinel CrashLoopBackOff | DNS resolve hostname fail lúc startup | Script `ha-setup-storage.sh` đã fix — dùng IP thay hostname |

---

## Tasks tiếp theo

- [ ] Deploy Prometheus + Grafana — dashboard metrics realtime
- [ ] Cấu hình NetworkPolicy đúng cho production (thay vì `enabled: false`)

### Observability (Prometheus + Grafana)

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
kubectl create namespace monitoring

helm upgrade --install kube-prom prometheus-community/kube-prometheus-stack \
  -n monitoring \
  --set grafana.service.type=NodePort \
  --set grafana.service.nodePort=32000
```

Truy cập Grafana: `http://10.10.55.11:32000` — user `admin` / pass `prom-operator`

### NetworkPolicy cho production

Sửa `helm/tnt-engine/templates/networkpolicy.yaml` để thêm `namespaceSelector`:

```yaml
egress:
  - to:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: data
    ports:
      - port: 5432
      - port: 6379
      - port: 8200
```

Sau đó bật lại:
```yaml
networkPolicy:
  enabled: true
```
