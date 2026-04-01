"""Internal admin API for runtime control and debugging.

These endpoints are NOT for application consumers (Dev A/B).
They are for platform operators and SREs.

Security: In production, protect with network policy or auth middleware.
The admin router uses a separate prefix (/admin) that can be restricted
at the ingress level.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

admin_router = APIRouter(prefix="/admin", tags=["admin"])


# ── Feature Flags ────────────────────────────────────────────────────

class FlagUpdate(BaseModel):
    flag: str
    enabled: bool
    tenant_id: str | None = None


@admin_router.get("/flags")
async def get_flags(request: Request, tenant_id: str | None = None) -> dict:
    """Get current feature flag state."""
    flags = request.app.state.feature_flags
    if tenant_id:
        return {"tenant_id": tenant_id, "flags": flags.get_effective(tenant_id)}
    return {"flags": flags.get_all()}


@admin_router.post("/flags")
async def set_flag(body: FlagUpdate, request: Request) -> dict:
    """Set a feature flag (global or per-tenant)."""
    flags = request.app.state.feature_flags
    if body.tenant_id:
        flags.set_for_tenant(body.tenant_id, body.flag, body.enabled)
    else:
        flags.set(body.flag, body.enabled)
    return {"status": "updated", "flag": body.flag, "enabled": body.enabled}


# ── Dynamic Config ───────────────────────────────────────────────────

class ConfigUpdate(BaseModel):
    key: str
    value: int | float | None


@admin_router.get("/config")
async def get_config(request: Request) -> dict:
    """Get current dynamic configuration."""
    return request.app.state.dynamic_config.to_dict()


@admin_router.post("/config")
async def update_config(body: ConfigUpdate, request: Request) -> dict:
    """Update a dynamic config value at runtime."""
    cfg = request.app.state.dynamic_config
    if not cfg.update(body.key, body.value):
        raise HTTPException(status_code=404, detail=f"Unknown config key: {body.key}")
    return {"status": "updated", "key": body.key, "value": body.value}


# ── Quotas ───────────────────────────────────────────────────────────

class QuotaUpdate(BaseModel):
    tenant_id: str
    monthly_limit: int


@admin_router.get("/quota/{tenant_id}")
async def get_quota(tenant_id: str, request: Request) -> dict:
    """Get quota usage for a tenant."""
    return request.app.state.quota_manager.get_usage(tenant_id)


@admin_router.post("/quota")
async def set_quota(body: QuotaUpdate, request: Request) -> dict:
    """Set monthly quota for a tenant."""
    request.app.state.quota_manager.set_limit(body.tenant_id, body.monthly_limit)
    return {"status": "updated", "tenant_id": body.tenant_id, "limit": body.monthly_limit}


@admin_router.post("/quota/{tenant_id}/reset")
async def reset_quota(tenant_id: str, request: Request) -> dict:
    """Reset quota usage counter for a tenant."""
    request.app.state.quota_manager.reset(tenant_id)
    return {"status": "reset", "tenant_id": tenant_id}


# ── System Status ────────────────────────────────────────────────────

@admin_router.get("/status")
async def system_status(request: Request) -> dict:
    """Comprehensive system status for debugging."""
    cb = request.app.state.circuit_breaker
    cache = request.app.state.layered_cache
    flags = request.app.state.feature_flags
    cfg = request.app.state.dynamic_config
    events = request.app.state.event_bus

    return {
        "circuit_breaker": cb.state,
        "l1_cache_size": cache.l1_size,
        "feature_flags": flags.get_all(),
        "dynamic_config": cfg.to_dict(),
        "event_subscriptions": events.subscriptions,
    }


# ── Cache Control ────────────────────────────────────────────────────

@admin_router.post("/cache/rebuild")
async def cache_rebuild(request: Request) -> dict:
    """Trigger a cache rebuild from DB."""
    worker = request.app.state.cache_rebuild_worker
    total = await worker.run()
    return {"status": "complete", "entries_populated": total}


# ── Rate Limiter ─────────────────────────────────────────────────────

@admin_router.post("/rate-limit/{tenant_id}/reset")
async def reset_rate_limit(tenant_id: str, request: Request) -> dict:
    """Reset rate limit counters for a tenant."""
    request.app.state.rate_limiter.reset(tenant_id)
    return {"status": "reset", "tenant_id": tenant_id}
