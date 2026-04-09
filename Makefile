.PHONY: help dev test lint build push deploy rollback migrate backup \
        k8s-build k8s-up k8s-down k8s-init k8s-status k8s-logs \
        k8s-port-forward k8s-restart k8s-shell k8s-migrate k8s-helm-local

IMAGE ?= ghcr.io/thiennlinh/tnt-engine
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
ENV ?= dev
NAMESPACE ?= tnt-engine
RELEASE ?= tnt-engine

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

# ── Development ──────────────────────────────────────────────────────

dev: ## Start full local dev (postgres + redis + openbao + tnt-engine app)
	docker compose up -d --build
	bash scripts/init-openbao-dev.sh

dev-down: ## Stop local dev environment
	docker compose down

dev-hsm: ## Start local dev with OpenBao + SoftHSM2 PKCS#11 seal
	@test -f dev/.env || (echo "ERROR: dev/.env not found. Run: cp dev/.env.example dev/.env" && exit 1)
	docker compose -f dev/docker-compose.dev.yml up --build -d

dev-hsm-down: ## Stop OpenBao + SoftHSM2 dev environment
	docker compose -f dev/docker-compose.dev.yml down

dev-hsm-init: ## Initialize OpenBao after first start (creates transit keys)
	@echo "Initializing OpenBao (first time only)..."
	docker exec tnt-openbao-hsm bao operator init -key-shares=1 -key-threshold=1 2>&1 | tee dev/.init-output
	@echo ""
	@echo "IMPORTANT: Save the Recovery Key and Root Token from above!"
	@echo "Then run: make dev-hsm-transit ROOT_TOKEN=<token>"

dev-hsm-transit: ## Enable transit engine and create T&T keys (ROOT_TOKEN required)
	@test -n "$(ROOT_TOKEN)" || (echo "Usage: make dev-hsm-transit ROOT_TOKEN=<root-token>" && exit 1)
	docker exec -e VAULT_TOKEN=$(ROOT_TOKEN) tnt-openbao-hsm bao secrets enable transit || true
	docker exec -e VAULT_TOKEN=$(ROOT_TOKEN) tnt-openbao-hsm bao write -f transit/keys/tnt-key
	docker exec -e VAULT_TOKEN=$(ROOT_TOKEN) tnt-openbao-hsm bao write -f transit/keys/tnt-hmac
	@echo "Transit engine ready. Keys: tnt-key, tnt-hmac"

dev-hsm-status: ## Show OpenBao seal status and PKCS#11 info
	docker exec tnt-openbao-hsm bao status || true
	@echo ""
	docker exec tnt-openbao-hsm softhsm2-util --show-slots 2>/dev/null | head -20

test: ## Run unit tests (excludes integration)
	python3 -m pytest tests/ -v --ignore=tests/integration -m "not integration"

integration-test: ## Run integration tests (requires docker-compose services)
	docker compose -f tests/integration/docker-compose.yml up -d --wait
	python3 -m pytest tests/integration/ -v -m integration --timeout=60; \
	EXIT_CODE=$$?; \
	docker compose -f tests/integration/docker-compose.yml down; \
	exit $$EXIT_CODE

lint: ## Run linter
	python3 -m ruff check src/ tests/

typecheck: ## Run type checker
	python3 -m mypy src/

# ── Build ────────────────────────────────────────────────────────────

build: ## Build Docker image
	docker build -t $(IMAGE):$(VERSION) -t $(IMAGE):latest .

push: ## Push Docker image to registry
	docker push $(IMAGE):$(VERSION)
	docker push $(IMAGE):latest

# ── Helm deploy ──────────────────────────────────────────────────────

deploy: ## Helm deploy (ENV=dev|staging|prod|local)
	helm upgrade --install $(RELEASE) ./helm/tnt-engine \
		--namespace $(NAMESPACE) --create-namespace \
		--values ./helm/values-$(ENV).yaml \
		--set image.tag=$(VERSION) \
		--wait --atomic --timeout 180s

rollback: ## Helm rollback to previous revision
	helm -n $(NAMESPACE) rollback $(RELEASE) 0 --wait --timeout 120s

status: ## Show deployment status
	@echo "=== Helm release ==="
	@helm -n $(NAMESPACE) status $(RELEASE) 2>/dev/null || echo "Not deployed"
	@echo ""
	@echo "=== Pods ==="
	@kubectl -n $(NAMESPACE) get pods -l app.kubernetes.io/name=tnt-engine
	@echo ""
	@echo "=== HPA ==="
	@kubectl -n $(NAMESPACE) get hpa 2>/dev/null || true

history: ## Show Helm release history (for rollback reference)
	helm -n $(NAMESPACE) history $(RELEASE)

template: ## Render Helm templates locally (dry-run)
	helm template $(RELEASE) ./helm/tnt-engine --values ./helm/values-$(ENV).yaml

# ── Database ─────────────────────────────────────────────────────────

migrate: ## Run database migration (ENV=dev|staging|prod)
	bash scripts/db-migrate.sh $(ENV)

backup: ## Backup database
	bash scripts/db-backup.sh

vault-backup: ## Backup OpenBao raft storage
	bash scripts/vault-backup.sh

vault-restore: ## Restore OpenBao from raft snapshot (SNAPSHOT=/path/to/file)
	bash scripts/vault-restore.sh $(SNAPSHOT)

# ── Monitoring ───────────────────────────────────────────────────────

monitoring-install: ## Install full monitoring stack (Prometheus + Grafana + Loki)
	helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
	helm repo add grafana https://grafana.github.io/helm-charts
	helm repo update
	helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
		--namespace monitoring --create-namespace \
		--values monitoring/kube-prometheus-stack-values.yaml
	helm upgrade --install loki grafana/loki-stack \
		--namespace monitoring \
		--values monitoring/loki-values.yaml

alerts: ## Deploy Prometheus alert rules + ServiceMonitor
	kubectl apply -f monitoring/prometheus-rules.yaml
	kubectl apply -f monitoring/servicemonitor.yaml

dashboards: ## Provision Grafana dashboards from JSON files
	kubectl -n monitoring create configmap tnt-engine-dashboards \
		--from-file=tnt-overview.json=monitoring/dashboards/tnt-overview.json \
		--from-file=tnt-infrastructure.json=monitoring/dashboards/tnt-infrastructure.json \
		--from-file=tnt-dependencies.json=monitoring/dashboards/tnt-dependencies.json \
		--dry-run=client -o yaml | \
		kubectl label -f - --local grafana_dashboard=1 -o yaml | \
		kubectl apply -f -

exporters: ## Install DB + Redis exporters
	helm upgrade --install pg-exporter prometheus-community/prometheus-postgres-exporter \
		--namespace $(NAMESPACE) --values monitoring/postgres-exporter.yaml
	helm upgrade --install redis-exporter prometheus-community/prometheus-redis-exporter \
		--namespace $(NAMESPACE) --values monitoring/redis-exporter.yaml

# ── Load testing ─────────────────────────────────────────────────────

loadtest: ## Run load test (TYPE=baseline|load|spike|soak)
	bash scripts/load-test.sh http://localhost:8000 $(TYPE)

# ── Kubernetes (Docker Desktop) ──────────────────────────────────────

K8S_LOCAL_DIR = k8s/local
LOCAL_IMAGE   = tnt-engine:local

k8s-build: ## Build Docker image cho local K8s (tag: tnt-engine:local)
	docker build -t $(LOCAL_IMAGE) .
	@echo "Image built: $(LOCAL_IMAGE)"

k8s-up: k8s-build ## Deploy toàn bộ stack lên Docker Desktop K8s
	@echo "==> Applying namespace & RBAC..."
	kubectl apply -f $(K8S_LOCAL_DIR)/namespace.yaml
	kubectl apply -f $(K8S_LOCAL_DIR)/serviceaccount.yaml
	@echo "==> Applying config & secrets..."
	kubectl apply -f $(K8S_LOCAL_DIR)/secrets.yaml
	kubectl apply -f $(K8S_LOCAL_DIR)/configmap.yaml
	@echo "==> Deploying dependencies (postgres, redis, openbao)..."
	kubectl apply -f $(K8S_LOCAL_DIR)/postgres.yaml
	kubectl apply -f $(K8S_LOCAL_DIR)/redis.yaml
	kubectl apply -f $(K8S_LOCAL_DIR)/openbao.yaml
	@echo "==> Waiting for dependencies to be ready..."
	kubectl -n tnt-engine rollout status deployment/postgres  --timeout=120s
	kubectl -n tnt-engine rollout status deployment/redis     --timeout=60s
	kubectl -n tnt-engine rollout status deployment/openbao   --timeout=60s
	@echo "==> Initializing OpenBao transit keys..."
	$(MAKE) k8s-init
	@echo "==> Deploying tnt-engine..."
	kubectl apply -f $(K8S_LOCAL_DIR)/deployment.yaml
	kubectl apply -f $(K8S_LOCAL_DIR)/service.yaml
	kubectl -n tnt-engine rollout status deployment/tnt-engine --timeout=180s
	@echo ""
	@echo "Stack is ready!"
	@echo "  App:     http://localhost:8000"
	@echo "  Docs:    http://localhost:8000/docs"
	@echo "  Health:  http://localhost:8000/api/v1/health"

k8s-init: ## Khởi tạo OpenBao transit keys trong K8s (port-forward tạm thời)
	@echo "==> Waiting for OpenBao pod..."
	kubectl -n tnt-engine wait --for=condition=ready pod -l app=openbao --timeout=60s
	@echo "==> Starting port-forward localhost:18200 -> openbao:8200..."
	kubectl -n tnt-engine port-forward svc/openbao 18200:8200 & echo $$! > /tmp/tnt-pf-openbao.pid
	@sleep 3
	VAULT_ADDR=http://localhost:18200 bash scripts/init-openbao-dev.sh
	@kill $$(cat /tmp/tnt-pf-openbao.pid) 2>/dev/null || true; rm -f /tmp/tnt-pf-openbao.pid
	@echo "==> OpenBao initialized."

k8s-migrate: ## Chạy database migration trong K8s
	@echo "==> Waiting for postgres pod..."
	kubectl -n tnt-engine wait --for=condition=ready pod -l app=postgres --timeout=60s
	@echo "==> Applying schema..."
	kubectl -n tnt-engine exec -i deploy/postgres -- psql -U tnt tnt_engine < sql/schema.sql
	@echo "==> Migration complete."

k8s-down: ## Xóa toàn bộ K8s resources (namespace + tất cả resources bên trong)
	kubectl delete namespace tnt-engine --ignore-not-found
	@echo "Namespace tnt-engine deleted."

k8s-status: ## Xem trạng thái pods, services, deployments
	@echo "=== Pods ==="
	kubectl -n tnt-engine get pods -o wide
	@echo ""
	@echo "=== Services ==="
	kubectl -n tnt-engine get svc
	@echo ""
	@echo "=== Deployments ==="
	kubectl -n tnt-engine get deploy

k8s-logs: ## Xem logs của tnt-engine (follow)
	kubectl -n tnt-engine logs -l app=tnt-engine -f --tail=100

k8s-logs-all: ## Xem logs tất cả services (postgres, redis, openbao, tnt-engine)
	@echo "==> [postgres]" && kubectl -n tnt-engine logs -l app=postgres --tail=20 || true
	@echo "==> [redis]"    && kubectl -n tnt-engine logs -l app=redis    --tail=20 || true
	@echo "==> [openbao]"  && kubectl -n tnt-engine logs -l app=openbao  --tail=20 || true
	@echo "==> [tnt-engine]" && kubectl -n tnt-engine logs -l app=tnt-engine --tail=50 || true

k8s-port-forward: ## Forward port 8000 → localhost:8000 (chỉ cần khi service không phải LoadBalancer)
	@echo "Forwarding http://localhost:8000 -> tnt-engine:8000  (Ctrl+C để dừng)"
	kubectl -n tnt-engine port-forward svc/tnt-engine 8000:8000

k8s-restart: ## Restart tnt-engine deployment (reload code sau khi rebuild image)
	kubectl -n tnt-engine rollout restart deployment/tnt-engine
	kubectl -n tnt-engine rollout status deployment/tnt-engine --timeout=120s

k8s-shell: ## Mở shell bên trong pod tnt-engine
	kubectl -n tnt-engine exec -it \
		$$(kubectl -n tnt-engine get pod -l app=tnt-engine -o jsonpath='{.items[0].metadata.name}') \
		-- /bin/sh

k8s-helm-local: k8s-build ## Deploy qua Helm với values-local.yaml (hybrid mode)
	helm upgrade --install tnt-engine ./helm/tnt-engine \
		--namespace tnt-engine --create-namespace \
		--values ./helm/values-local.yaml \
		--set image.tag=local \
		--wait --atomic --timeout 180s
