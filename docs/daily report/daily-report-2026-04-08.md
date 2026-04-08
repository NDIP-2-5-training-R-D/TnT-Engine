# Daily Report — 2026-04-08

## Mục tiêu trong ngày

Xử lý các điểm review còn mở liên quan đến:

- Control Plane audit/realtime behavior
- benchmark claims và production sizing
- readiness để benchmark trên VM và chuẩn bị benchmark theo hướng K8s

---

## 1. Những gì đã làm được

### 1.1 Control Plane

- Bỏ SSE ở trang Audit và chuyển hoàn toàn sang polling HTTP.
- Xóa `event-bus` nội bộ và toàn bộ `emitCpEvent(...)`.
- Tối giản CP audit log, giảm `detail` dư thừa và tránh ghi metadata không cần thiết.
- Bổ sung `.env.example` cho `control-plane`.
- Chuyển `control-plane/Dockerfile` sang flow production-like:
  - build bằng `next build`
  - run bằng `next start`
- Viết thêm tài liệu deploy/config cho Control Plane.

### 1.2 CP Audit persistence

- Nâng `cp-audit` từ file-only thành 2 mode:
  - `file` cho dev/demo
  - `postgres` cho persistent storage
- Cập nhật các route Control Plane dùng `await logCpAction(...)`.
- Verify thành công runtime path với PostgreSQL:
  - action `KEY_ROTATE` đã được ghi vào bảng `cp_audit_log`

### 1.3 Benchmark và tài liệu

- Benchmark lại trên **VM GEIC** bằng Docker Compose.
- Thu được số liệu cho:
  - `baseline`
  - `load`
  - `spike`
  - `soak`
- Cập nhật `docs/load-test-report.md` theo hướng:
  - local/VM results là số liệu tạm thời
  - chưa chốt production sizing
  - benchmark K8s sẽ chỉ cập nhật sau khi hoàn tất flow triển khai
- Trả `helm/values-prod.yaml` về hướng an toàn hơn, không giữ tuning memory quá sớm từ local test.

### 1.4 Tài liệu bổ sung

- Thêm guide benchmark K8s trên VM
- Thêm guide triển khai K8s
- Cập nhật `docs/todo.md`
- Tổng hợp follow-up từ review trong `docs/pr-review-followups.md`

---

## 2. Kết quả benchmark trên VM GEIC

### Baseline

- Requests/sec: `871.50`
- Average latency: `9.73ms`
- Success rate: `~100%`
- Peak `tnt-engine`:
  - CPU: `~122.64%`
  - RAM: `~90.36 MiB`

### Load

- Requests/sec: `716.68`
- Average latency: `140.58ms`
- Success rate: `~100%`
- Peak `tnt-engine`:
  - CPU: `~112.98%`
  - RAM: `~107.5 MiB`

### Spike

- Requests/sec: `4661.68`
- Average latency: `243.66ms`
- Success rate: `~4.5%`
- Timeout: `172`
- `Non-2xx/3xx`: `133,762`

### Soak

- Requests/sec: `789.62`
- Average latency: `60.78ms`
- Success rate: `~100%`
- Peak `tnt-engine`:
  - CPU: `~131.26%`
  - RAM: `~110.2 MiB`

### Nhận định

- `baseline`, `load`, `soak` ổn định trên VM.
- `spike` vẫn fail mạnh, chưa thể kết luận hệ thống chịu burst tốt.
- Peak RAM của `tnt-engine` trên VM nằm khoảng `90–110 MiB`, nên chưa có cơ sở giảm memory production xuống mức quá sát.
- Benchmark trên VM có giá trị hơn local laptop, nhưng **chưa phải production-like benchmark** vì chưa đi qua K8s + Ingress/LB.

---

## 3. Trạng thái theo review

### Đã hoàn tất

- Bỏ SSE ở audit page
- Bỏ `event-bus`
- Tối giản CP audit log
- Hạ claim benchmark local
- Rollback tuning production chưa đủ dữ liệu
- Làm sạch env/config strategy cho Control Plane
- Nâng CP audit sang hỗ trợ PostgreSQL và verify runtime pass

### Còn mở

- Hoàn tất môi trường benchmark K8s
- Đưa benchmark đi qua đúng path reviewer mong muốn:

```text
client -> ingress/lb -> service -> pod -> dependencies
```

- Chạy lại benchmark K8s sau khi hoàn tất dependency path

---

## 4. Trạng thái K8s hiện tại

Đã làm:

- cài K3s trên VM
- cài Helm
- deploy được chart app
- sửa image pull theo hướng dùng image local import vào K3s
- sửa ingress class sang `traefik`

Đang vướng:

- app trong K8s cần dependency path hợp lệ cho:
  - PostgreSQL
  - Redis
  - OpenBao
- hiện benchmark K8s chưa hoàn chỉnh vì stack dependency trong cluster chưa hoàn tất

---

## 5. Kết luận

Hôm nay đã xử lý gần hết các điểm review ở mức code, config, tài liệu và benchmark trên VM. Những phần sửa ngay trong PR hầu như đã hoàn thành. Phần còn lại lớn nhất là benchmark theo đúng hướng reviewer yêu cầu: chạy qua K8s + Ingress/LB với dependency path hoàn chỉnh, sau đó mới chốt kết luận cuối về latency, bottleneck và production sizing.
