# TnT-Engine — Hướng dẫn vận hành

PII Tokenization & Transformation Service — chạy local qua **Docker Compose** hoặc **Kubernetes (Docker Desktop)**.

---

## Yêu cầu

| Tool | Phiên bản tối thiểu | Ghi chú |
|------|---------------------|---------|
| Docker Desktop | 4.x+ | Bật Kubernetes trong Settings |
| kubectl | 1.24+ | Đi kèm Docker Desktop hoặc cài riêng |
| Helm | 3.x | Chỉ cần cho `make k8s-helm-local` / `make deploy` |
| Python | 3.11+ | Cần cho `make test` / `make lint` |
| make | bất kỳ | GNU Make |

---

## Cấu trúc thư mục liên quan

```
TnT-Engine/
├── k8s/local/              # Manifests K8s cho Docker Desktop (all-in-one)
│   ├── namespace.yaml
│   ├── serviceaccount.yaml
│   ├── configmap.yaml      # Biến môi trường (internal K8s DNS)
│   ├── secrets.yaml        # Dev secrets (KHÔNG dùng production)
│   ├── postgres.yaml       # PostgreSQL Deployment + PVC + Service
│   ├── redis.yaml          # Redis Deployment + Service
│   ├── openbao.yaml        # OpenBao Deployment + Service (dev mode)
│   ├── deployment.yaml     # TnT-Engine (image local, 1 replica)
│   └── service.yaml        # LoadBalancer → localhost:8000
├── k8s/                    # Manifests production (multi-node)
├── helm/                   # Helm charts (dev / staging / prod / local)
├── docker-compose.yml      # Stack đầy đủ cho Docker Compose
├── Makefile                # Tất cả lệnh vận hành
└── scripts/
    └── init-openbao-dev.sh # Khởi tạo transit keys OpenBao
```

---

## Phần 1: Chạy với Docker Compose (đơn giản nhất)

Phù hợp để phát triển nhanh, không cần bật Kubernetes.

### Khởi động

```bash
make dev
```

Lệnh này sẽ:
1. Build image `tnt-engine`
2. Khởi chạy: PostgreSQL → Redis → OpenBao → TnT-Engine
3. Tự động khởi tạo OpenBao transit keys

### Dừng

```bash
make dev-down
```

### Truy cập

| Service | URL |
|---------|-----|
| API | http://localhost:8000 |
| Swagger UI | http://localhost:8000/docs |
| Health check | http://localhost:8000/api/v1/health |
| OpenBao UI | http://localhost:8200/ui (token: `dev-token`) |

---

## Phần 2: Chạy với Kubernetes qua Docker Desktop

### Bước 0: Bật Kubernetes trong Docker Desktop

1. Mở **Docker Desktop** → **Settings** → **Kubernetes**
2. Tick **"Enable Kubernetes"** → **Apply & Restart**
3. Chờ indicator "Kubernetes running" màu xanh (khoảng 2-3 phút)
4. Kiểm tra:

```bash
kubectl config current-context
# Kết quả phải là: docker-desktop
```

### Bước 1: Deploy toàn bộ stack lên K8s

```bash
make k8s-up
```

Lệnh này sẽ tự động:
1. Build Docker image `tnt-engine:local`
2. Tạo namespace `tnt-engine`
3. Deploy PostgreSQL, Redis, OpenBao
4. Chờ các dependency sẵn sàng
5. Khởi tạo OpenBao transit keys
6. Deploy TnT-Engine app
7. Expose qua `LoadBalancer` trên port `8000`

**Kết quả:**
```
Stack is ready!
  App:     http://localhost:8000
  Docs:    http://localhost:8000/docs
  Health:  http://localhost:8000/api/v1/health
```

### Bước 2: Chạy database migration (lần đầu)

```bash
make k8s-migrate
```

### Kiểm tra trạng thái

```bash
make k8s-status
```

```
=== Pods ===
NAME                           READY   STATUS    RESTARTS   AGE
openbao-xxx                    1/1     Running   0          2m
postgres-xxx                   1/1     Running   0          2m
redis-xxx                      1/1     Running   0          2m
tnt-engine-xxx                 1/1     Running   0          1m

=== Services ===
NAME         TYPE           CLUSTER-IP     EXTERNAL-IP   PORT(S)
openbao      ClusterIP      10.96.x.x      <none>        8200/TCP
postgres     ClusterIP      10.96.x.x      <none>        5432/TCP
redis        ClusterIP      10.96.x.x      <none>        6379/TCP
tnt-engine   LoadBalancer   10.96.x.x      localhost     8000:xxxxx/TCP
```

### Xem logs

```bash
# Logs của tnt-engine (live)
make k8s-logs

# Logs tất cả services
make k8s-logs-all
```

### Sau khi sửa code — rebuild và reload

```bash
make k8s-build    # rebuild image
make k8s-restart  # rolling restart deployment
```

Hoặc gộp 1 lệnh:

```bash
make k8s-build && make k8s-restart
```

### Mở shell trong pod

```bash
make k8s-shell
```

### Dọn dẹp — xóa toàn bộ

```bash
make k8s-down
```

---

## Phần 3: Deploy qua Helm (nâng cao)

### Hybrid mode (K8s app + Docker Compose dependencies)

Cần chạy docker-compose trước cho postgres/redis/openbao, sau đó deploy app qua Helm:

```bash
# Bước 1: Khởi động dependencies
docker compose up -d postgres redis openbao
bash scripts/init-openbao-dev.sh

# Bước 2: Deploy app qua Helm
make k8s-helm-local
```

### Full Helm deploy (dev / staging / prod)

```bash
make deploy ENV=dev        # Helm deploy lên môi trường dev
make deploy ENV=staging    # Helm deploy lên staging
make deploy ENV=prod       # Helm deploy lên production
```

### Rollback

```bash
make rollback              # Rollback về revision trước
```

### Kiểm tra Helm release

```bash
make status                # Helm status + pods + HPA
make history               # Lịch sử releases
make template ENV=dev      # Render templates (dry-run)
```

---

## Tóm tắt tất cả lệnh `make`

### Docker Compose

| Lệnh | Mô tả |
|------|-------|
| `make dev` | Khởi động full stack (postgres + redis + openbao + app) |
| `make dev-down` | Dừng toàn bộ |
| `make dev-hsm` | Khởi động stack với SoftHSM2 PKCS#11 |

### Kubernetes (Docker Desktop)

| Lệnh | Mô tả |
|------|-------|
| `make k8s-build` | Build Docker image `tnt-engine:local` |
| `make k8s-up` | Deploy toàn bộ stack (build + apply + init) |
| `make k8s-init` | Khởi tạo OpenBao transit keys |
| `make k8s-migrate` | Chạy database migration |
| `make k8s-status` | Xem pods, services, deployments |
| `make k8s-logs` | Stream logs tnt-engine |
| `make k8s-logs-all` | Logs tất cả services |
| `make k8s-port-forward` | Forward port 8000 thủ công |
| `make k8s-restart` | Rolling restart tnt-engine |
| `make k8s-shell` | Shell vào trong pod tnt-engine |
| `make k8s-down` | Xóa toàn bộ K8s resources |
| `make k8s-helm-local` | Deploy qua Helm (hybrid mode) |

### Helm / Production

| Lệnh | Mô tả |
|------|-------|
| `make deploy ENV=dev` | Helm deploy lên dev |
| `make deploy ENV=staging` | Helm deploy lên staging |
| `make deploy ENV=prod` | Helm deploy lên production |
| `make rollback` | Rollback Helm release |
| `make status` | Trạng thái Helm release |
| `make template ENV=dev` | Dry-run render Helm templates |

### Build & Test

| Lệnh | Mô tả |
|------|-------|
| `make build` | Build image đẩy lên registry |
| `make push` | Push image lên registry |
| `make test` | Chạy unit tests |
| `make integration-test` | Chạy integration tests |
| `make lint` | Lint code (ruff) |
| `make typecheck` | Type check (mypy) |
| `make loadtest TYPE=load` | Load test |

### Database & Vault

| Lệnh | Mô tả |
|------|-------|
| `make migrate ENV=dev` | Chạy DB migrations |
| `make backup` | Backup database |
| `make vault-backup` | Backup OpenBao raft storage |

### Monitoring

| Lệnh | Mô tả |
|------|-------|
| `make monitoring-install` | Cài Prometheus + Grafana + Loki |
| `make alerts` | Deploy Prometheus alert rules |
| `make dashboards` | Provision Grafana dashboards |

---

## Troubleshooting

### Kubernetes không khởi động được

```bash
# Kiểm tra context
kubectl config current-context  # phải là docker-desktop

# Kiểm tra nodes
kubectl get nodes

# Xem events namespace
kubectl -n tnt-engine get events --sort-by='.lastTimestamp'
```

### Pod ở trạng thái `ImagePullBackOff`

Image `tnt-engine:local` chưa được build. Chạy:
```bash
make k8s-build
```

Hoặc nếu đã build mà vẫn lỗi, kiểm tra `imagePullPolicy: Never` đã được set trong `k8s/local/deployment.yaml`.

### Pod ở trạng thái `CrashLoopBackOff`

```bash
# Xem logs để tìm lỗi
make k8s-logs

# Xem logs pod cụ thể (kể cả đã crash)
kubectl -n tnt-engine logs <pod-name> --previous
```

Nguyên nhân thường gặp:
- OpenBao chưa được init → chạy `make k8s-init`
- Schema DB chưa được apply → chạy `make k8s-migrate`

### Port 8000 không truy cập được

Docker Desktop LoadBalancer mất vài giây để bind. Kiểm tra:
```bash
kubectl -n tnt-engine get svc tnt-engine
# EXTERNAL-IP phải là localhost, không phải <pending>
```

Nếu vẫn `<pending>`, dùng port-forward thủ công:
```bash
make k8s-port-forward
```

### OpenBao báo lỗi `transit path not found`

Cần chạy lại init:
```bash
make k8s-init
```

### Xóa sạch và bắt đầu lại

```bash
make k8s-down
make k8s-up
```

---

## Kiến trúc service trong K8s local

```
                    ┌─────────────────────────────────────┐
                    │     Namespace: tnt-engine            │
                    │                                      │
  localhost:8000 ──►│  tnt-engine (LoadBalancer :8000)    │
                    │       │                              │
                    │       ▼                              │
                    │  [tnt-engine pod]                    │
                    │    initContainers:                   │
                    │      wait-postgres                   │
                    │      wait-redis                      │
                    │      wait-openbao                    │
                    │       │                              │
                    │  ┌────┼────────────────┐             │
                    │  ▼    ▼                ▼             │
                    │ postgres  redis    openbao           │
                    │ :5432     :6379    :8200             │
                    │ (PVC 1Gi)                            │
                    └─────────────────────────────────────┘
```
