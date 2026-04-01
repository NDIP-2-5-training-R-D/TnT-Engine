# CI/CD Setup Guide

## GitLab CI Variables

Configure these in **GitLab → Settings → CI/CD → Variables**.
All secrets must be **Masked** and **Protected**.

### Per-environment variables

| Variable | Dev | Staging | Prod | Type |
|---|---|---|---|---|
| `DEV_KUBE_CONTEXT` | `geic/tnt-engine:dev-agent` | — | — | Variable |
| `STAGING_KUBE_CONTEXT` | — | `geic/tnt-engine:stg-agent` | — | Variable |
| `PROD_KUBE_CONTEXT` | — | — | `geic/tnt-engine:prod-agent` | Variable (Protected) |
| `DEV_DB_HOST` | `postgres.dev.internal` | — | — | Variable |
| `DEV_DB_USER` | `tnt` | — | — | Variable |
| `DEV_DB_PASSWORD` | `***` | — | — | Variable (Masked) |
| `DEV_DB_NAME` | `tnt_engine` | — | — | Variable |
| `STAGING_DB_HOST` | — | `postgres.stg.internal` | — | Variable |
| `STAGING_DB_USER` | — | `tnt` | — | Variable |
| `STAGING_DB_PASSWORD` | — | `***` | — | Variable (Masked) |
| `STAGING_DB_NAME` | — | `tnt_engine` | — | Variable |
| `PROD_DB_HOST` | — | — | `postgres.prod.internal` | Variable (Protected) |
| `PROD_DB_USER` | — | — | `tnt` | Variable (Protected) |
| `PROD_DB_PASSWORD` | — | — | `***` | Variable (Masked, Protected) |
| `PROD_DB_NAME` | — | — | `tnt_engine` | Variable (Protected) |

### Kubernetes Agent Setup

Each environment needs a [GitLab Agent for Kubernetes](https://docs.gitlab.com/ee/user/clusters/agent/) registered:

```bash
# Register agents (one per environment)
gitlab-agent-install --name=dev-agent --context=dev-cluster
gitlab-agent-install --name=stg-agent --context=staging-cluster
gitlab-agent-install --name=prod-agent --context=prod-cluster
```

## Pipeline Flow

```
  MR / feature branch:
    validate (lint + test + typecheck)  →  security (SAST + deps)
                                        [stops here — no deploy]

  main branch:
    validate → security → build → scan → deploy_dev → verify_dev
                                            ↓
                                        deploy_staging → verify_staging

  git tag (v*):
    validate → security → build → scan → deploy_prod (MANUAL) → verify_prod
```

## Deployment Strategy

- **Dev + Staging**: auto-deploy on every push to `main`
- **Production**: manual approval required, triggered only by git tags
- **Rollback**: one-click manual job in the pipeline UI
- **Zero downtime**: `maxUnavailable=0` + readiness probe must pass before old pod is removed

## Release Process

```bash
# 1. Merge to main (auto-deploys to dev → staging)
git checkout main && git merge feature/xyz

# 2. Verify in staging (check Grafana dashboard)

# 3. Tag for production
git tag v0.4.1 && git push --tags

# 4. Go to GitLab pipeline → click "deploy_prod" → approve

# 5. If issues → click "rollback_prod"
```

## Adding a New Service

New services reuse the same templates. In the new service's repo:

```yaml
# .gitlab-ci.yml
include:
  - project: 'geic/tnt-engine'
    ref: main
    file:
      - ci/templates/validate.yml
      - ci/templates/docker.yml
      - ci/templates/deploy.yml
      - ci/templates/post-deploy.yml

variables:
  SERVICE_NAME: "my-new-service"
  NAMESPACE: "my-new-service"

stages:
  - validate
  - build
  - deploy

lint:
  extends: .lint
  stage: validate

test:
  extends: .unit_test
  stage: validate

build:
  extends: .docker_build
  stage: build
  rules:
    - if: $CI_COMMIT_BRANCH == "main"

deploy_dev:
  extends: .deploy_base
  stage: deploy
  needs: ["build"]
  variables:
    KUBE_CONTEXT: $DEV_KUBE_CONTEXT
  environment:
    name: dev
```
