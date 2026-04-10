# Control Plane Deployment Notes

## Mục tiêu

Tài liệu này chuẩn hóa cách cấu hình và deploy `control-plane` theo 2 mode:

- `dev`: chạy local với `.env.local`
- `production-like`: chạy container với `next build` + `next start`

---

## Dev mode

File env tham chiếu:

- [`control-plane/.env.example`](/home/linhnt1/Desktop/TnT-Engine/control-plane/.env.example)

File env local:

- [`control-plane/.env.local`](/home/linhnt1/Desktop/TnT-Engine/control-plane/.env.local)

Chạy:

```bash
cd control-plane
npm install
npm run dev
```

Ghi chú:

- `.env.local` chỉ dành cho dev
- không commit secret thật vào file env

---

## Container / production-like mode

Dockerfile hiện tại:

- [`control-plane/Dockerfile`](/home/linhnt1/Desktop/TnT-Engine/control-plane/Dockerfile)

Đặc điểm:

- multi-stage build
- `npm ci`
- `next build`
- runtime dùng `next start --port 3100`

Build:

```bash
cd control-plane
docker build -t tnt-control-plane:prod .
```

Run:

```bash
docker run --rm -p 3100:3100 --env-file .env.local tnt-control-plane:prod
```

Trong production thật:

- không dùng `.env.local`
- inject env qua:
  - Kubernetes Secret
  - Vault / External Secrets
  - hoặc secret manager tương đương

---

## Auth / env strategy

Biến tối thiểu cần có:

- `VAULT_ADDR`
- `VAULT_TOKEN`
- `TNT_ENGINE_URL`
- `NEXTAUTH_URL`
- `NEXTAUTH_SECRET`
- `AUTH_PROVIDER`

Nếu dùng PostgreSQL-backed CP audit store:

- `CP_AUDIT_STORE=postgres`
- `CP_AUDIT_DATABASE_URL`

Hoặc:

- `PG_HOST`
- `PG_PORT`
- `PG_USER`
- `PG_PASSWORD`
- `PG_DATABASE`

---

## CP audit store modes

Hiện `control-plane` hỗ trợ 2 mode cho CP audit:

- `CP_AUDIT_STORE=file`
  - mặc định
  - dùng cho dev/demo
  - lưu ở `/tmp`

- `CP_AUDIT_STORE=postgres`
  - phù hợp hơn cho multi-replica / persistence
  - tự tạo bảng `cp_audit_log` nếu chưa có

File code:

- [`control-plane/src/lib/cp-audit.ts`](/home/linhnt1/Desktop/TnT-Engine/control-plane/src/lib/cp-audit.ts)

Khuyến nghị:

- dev: dùng `file`
- production-like / production: dùng `postgres`

---

## Ghi chú vận hành

- Nếu đổi `CP_AUDIT_STORE` sang `postgres`, cần cài dependency mới:
  - package `pg`
- Sau khi đổi dependency, chạy lại:

```bash
cd control-plane
npm install
```

- Không nên xem file store `/tmp/tnt-cp-audit.json` là production-ready.
