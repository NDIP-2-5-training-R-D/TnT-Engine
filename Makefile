.PHONY: help dev test lint build push deploy rollback migrate backup

IMAGE ?= ghcr.io/geic/tnt-engine
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

deploy: ## Helm deploy (ENV=dev|staging|prod)
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
