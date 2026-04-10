"""FastAPI application entry point — resilience-hardened platform."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from prometheus_client import make_asgi_app

from tnt_engine.api.admin import admin_router
from tnt_engine.api.middleware import MetricsMiddleware
from tnt_engine.api.routes import router
from tnt_engine.api.v2 import v2_router
from tnt_engine.cache.layered import LayeredCache
from tnt_engine.cache.redis import TokenCache
from tnt_engine.config import Settings, settings
from tnt_engine.crypto.circuit_breaker import CircuitBreakerBackend
from tnt_engine.crypto.factory import create_crypto_backend
from tnt_engine.crypto.vault_health import VaultHealthChecker
from tnt_engine.db.connection import Database
from tnt_engine.db.repository import TokenRepository
from tnt_engine.events.bus import EventBus
from tnt_engine.events.kafka_producer import KafkaAuditProducer
from tnt_engine.governance.classification import ClassificationRegistry
from tnt_engine.logging import configure_logging
from tnt_engine.resilience.backpressure import BackpressureMiddleware
from tnt_engine.resilience.guardrails import GuardrailsMiddleware
from tnt_engine.resilience.shutdown import ShutdownCoordinator
from tnt_engine.runtime.dynamic_config import DynamicConfig
from tnt_engine.runtime.feature_flags import FeatureFlags
from tnt_engine.security.quota import QuotaManager
from tnt_engine.security.rate_limiter import RateLimiter
from tnt_engine.service.audit_writer import ReliableAuditWriter
from tnt_engine.service.policy import PolicyEngine
from tnt_engine.service.token_service import TokenService
from tnt_engine.workers.cache_rebuild import CacheRebuildWorker
from tnt_engine.workers.cleanup import CleanupWorker


import logging as _log

async def _ensure_transit_keys(cfg: "Settings") -> None:
    """Auto-provision OpenBao transit engine and keys if not already present.

    Idempotent — safe to call on every startup. Failures are logged and
    swallowed so a missing key causes a clear crypto error per-request
    rather than preventing the service from starting.
    """
    import httpx as _httpx

    base = cfg.crypto_base_url.rstrip("/")
    token = cfg.crypto_token
    headers = {"X-Vault-Token": token, "Content-Type": "application/json"}
    log = _log.getLogger(__name__)

    async with _httpx.AsyncClient(verify=cfg.crypto_verify_ssl, timeout=10) as client:
        # 0. Wait for OpenBao to be ready (up to 30s)
        import asyncio as _asyncio
        for attempt in range(15):
            try:
                r = await client.get(f"{base}/sys/health")
                if r.status_code in (200, 429, 472, 473):  # any response = alive
                    break
            except Exception:
                pass
            if attempt < 14:
                log.info("waiting_for_openbao attempt=%d", attempt + 1)
                await _asyncio.sleep(2)
        else:
            log.warning("openbao_not_ready_after_30s — transit keys may not be provisioned")
            return

        # 1. Enable transit engine (ignore 400 = already mounted)
        try:
            r = await client.post(f"{base}/sys/mounts/transit", headers=headers,
                                  json={"type": "transit"})
            if r.status_code not in (200, 204, 400):
                log.warning("vault_mount_transit_failed status=%s", r.status_code)
        except Exception as exc:
            log.warning("vault_mount_transit_error: %s", exc)

        # 2. Enable KV v2 (ignore 400 = already mounted)
        try:
            r = await client.post(f"{base}/sys/mounts/secret", headers=headers,
                                  json={"type": "kv", "options": {"version": "2"}})
            if r.status_code not in (200, 204, 400):
                log.warning("vault_mount_kv_failed status=%s", r.status_code)
        except Exception as exc:
            log.warning("vault_mount_kv_error: %s", exc)

        # 3. Create transit keys (200/204 = created, 400 = already exists)
        key_specs = [
            (cfg.crypto_transit_key, {}),
            (cfg.crypto_hmac_key,    {"type": "hmac"}),
            (cfg.crypto_aes_gcm_key, {"type": "aes256-gcm96"}),
            (cfg.crypto_fpe_key,     {"type": "aes256-gcm96"}),
        ]
        for key_name, body in key_specs:
            try:
                r = await client.post(f"{base}/transit/keys/{key_name}", headers=headers,
                                      json=body)
                if r.status_code not in (200, 204, 400):
                    log.warning("vault_create_key_failed key=%s status=%s", key_name, r.status_code)
                else:
                    log.info("vault_transit_key_ready key=%s", key_name)
            except Exception as exc:
                log.warning("vault_create_key_error key=%s: %s", key_name, exc)

        # 4. Bootstrap FPE DEK if not present
        try:
            r = await client.get(f"{base}/secret/data/tnt/fpe-dek", headers=headers)
            if r.status_code == 404:
                import base64 as _b64, os as _os
                raw = _b64.b64encode(_os.urandom(32)).decode()
                enc = await client.post(f"{base}/transit/encrypt/{cfg.crypto_fpe_key}",
                                        headers=headers, json={"plaintext": raw})
                if enc.status_code == 200:
                    wrapped = enc.json()["data"]["ciphertext"]
                    await client.post(f"{base}/secret/data/tnt/fpe-dek", headers=headers,
                                      json={"data": {"wrapped_dek": wrapped}})
                    log.info("vault_fpe_dek_bootstrapped")
        except Exception as exc:
            log.warning("vault_fpe_dek_bootstrap_error: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    configure_logging()
    cfg = settings

    # ── Infrastructure ───────────────────────────────────────────
    db = Database(cfg)
    await db.connect()

    l2_cache = TokenCache(cfg)
    layered_cache = LayeredCache(l2_cache, cfg)

    raw_backend = await create_crypto_backend(cfg)
    # Expose token manager for admin status (if OpenBao backend with managed tokens)
    _token_manager = getattr(raw_backend, "_token_manager", None)

    # ── Auto-initialize OpenBao transit keys (idempotent) ────────
    if cfg.crypto_backend.lower() == "openbao":
        await _ensure_transit_keys(cfg)

    cb_backend = CircuitBreakerBackend(
        raw_backend,
        failure_threshold=cfg.cb_failure_threshold,
        recovery_timeout=cfg.cb_recovery_timeout_seconds,
        half_open_max_calls=cfg.cb_half_open_max_calls,
    )

    repo = TokenRepository(db)

    # ── Audit Writer ─────────────────────────────────────────────
    # In-memory buffer → Kafka (durability tee) → PostgreSQL batch writes.
    # Kafka is optional and disabled by default; when enabled it protects
    # audit records from pod-eviction / ephemeral-storage loss.
    kafka_producer: KafkaAuditProducer | None = None
    if cfg.kafka_enabled:
        kafka_producer = KafkaAuditProducer(cfg)
        await kafka_producer.start()

    audit_writer = ReliableAuditWriter(repo, cfg, kafka_producer=kafka_producer)
    await audit_writer.start()

    svc = TokenService(
        hmac=cb_backend,
        encryption=cb_backend,
        repo=repo,
        cache=layered_cache,
        settings=cfg,
        audit_writer=audit_writer,
    )

    # ── Governance + Security ────────────────────────────────────
    governance = ClassificationRegistry()
    # Load persisted rules from DB — overrides in-memory defaults.
    # The transform_rules table is seeded with the same 16 defaults on first boot,
    # so this is a no-op on fresh installs and picks up admin changes on restart.
    try:
        rows = await db.read_pool.fetch(
            "SELECT name, classification, description, retention_days "
            "FROM transform_rules WHERE is_active = true"
        )
        if rows:
            governance.load_from_rows([dict(r) for r in rows])
    except Exception as _exc:
        import logging as _logging
        _logging.getLogger(__name__).warning(
            "transform_rules_load_failed — using defaults: %s", _exc
        )

    rate_limiter = RateLimiter(max_requests=5000, window_seconds=60)
    quota_manager = QuotaManager()

    # ── Runtime Control ──────────────────────────────────────────
    feature_flags = FeatureFlags()
    dynamic_config = DynamicConfig(
        cache_ttl_seconds=cfg.redis_token_ttl_seconds,
        l1_ttl_seconds=cfg.l1_ttl_seconds,
        crypto_max_retries=cfg.crypto_max_retries,
        crypto_timeout_seconds=cfg.crypto_timeout_seconds,
        cleanup_interval_seconds=cfg.worker_cleanup_interval_seconds,
        cleanup_batch_size=cfg.worker_cleanup_batch_size,
        dedup_ttl_seconds=cfg.dedup_ttl_seconds,
    )
    event_bus = EventBus()
    shutdown = ShutdownCoordinator()

    # ── Workers ──────────────────────────────────────────────────
    cleanup_worker = CleanupWorker(repo, cfg)
    await cleanup_worker.start()
    cache_rebuild_worker = CacheRebuildWorker(repo, layered_cache, cfg)

    # ── Policy engine ────────────────────────────────────────────
    policy_engine = PolicyEngine(
        token_service=svc,
        hmac_service=cb_backend,
        governance=governance,
    )

    # ── App state ────────────────────────────────────────────────
    app.state.db = db
    app.state.layered_cache = layered_cache
    app.state.circuit_breaker = cb_backend
    app.state.token_service = svc
    app.state.policy_engine = policy_engine
    app.state.governance = governance
    app.state.rate_limiter = rate_limiter
    app.state.quota_manager = quota_manager
    app.state.feature_flags = feature_flags
    app.state.dynamic_config = dynamic_config
    app.state.event_bus = event_bus
    app.state.shutdown = shutdown
    app.state.cleanup_worker = cleanup_worker
    app.state.cache_rebuild_worker = cache_rebuild_worker
    app.state.vault_token_manager = _token_manager
    app.state.audit_writer = audit_writer
    app.state.kafka_audit_producer = kafka_producer

    # OpenBao health checker (for /health and /ready endpoints)
    vault_health_checker = VaultHealthChecker(cfg.crypto_base_url, settings=cfg)
    app.state.vault_health_checker = vault_health_checker

    yield

    # ── Graceful shutdown ────────────────────────────────────────
    await shutdown.initiate()
    await audit_writer.stop()  # Drain audit buffer before closing DB
    if kafka_producer is not None:
        await kafka_producer.stop()
    await cleanup_worker.stop()
    await vault_health_checker.close()
    await cb_backend.close()
    await layered_cache.close()
    await db.close()


def create_app(cfg: Settings | None = None) -> FastAPI:
    from fastapi import Request
    from fastapi.responses import JSONResponse
    from tnt_engine.errors import (
        CryptoServiceUnavailableError,
        EncryptionError,
        TNTError,
    )

    app = FastAPI(
        title="T&T Engine",
        description="Enterprise PII Tokenization & Data Governance Platform",
        version="0.6.0",
        lifespan=lifespan,
    )

    # ── Global exception handlers ────────────────────────────────────
    # Ensure crypto failures always return JSON (not Starlette plain-text 500).

    @app.exception_handler(CryptoServiceUnavailableError)
    async def _crypto_unavailable(request: Request, exc: CryptoServiceUnavailableError) -> JSONResponse:
        return JSONResponse(
            status_code=503,
            content={"detail": exc.message, "code": exc.code},
        )

    @app.exception_handler(EncryptionError)
    async def _encryption_error(request: Request, exc: EncryptionError) -> JSONResponse:
        return JSONResponse(
            status_code=503,
            content={"detail": exc.message, "code": exc.code, "cause": exc.details.get("cause", "")},
        )

    @app.exception_handler(TNTError)
    async def _tnt_error(request: Request, exc: TNTError) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={"detail": exc.message, "code": exc.code},
        )

    # Middleware stack (applied in reverse order — last added runs first)
    # 1. Metrics (outermost — always runs)
    app.add_middleware(MetricsMiddleware)
    # 2. Guardrails (body size + timeout)
    app.add_middleware(GuardrailsMiddleware)
    # 3. Backpressure (load shedding — innermost check)
    app.add_middleware(BackpressureMiddleware, max_concurrent=200)

    # API routers
    app.include_router(router)       # v1
    app.include_router(v2_router)    # v2
    app.include_router(admin_router) # admin

    # Prometheus
    metrics_app = make_asgi_app()
    app.mount("/metrics", metrics_app)

    return app


app = create_app()
