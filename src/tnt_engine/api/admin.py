"""Internal admin API for runtime control and debugging.

These endpoints are NOT for application consumers (Dev A/B).
They are for platform operators and SREs.

Security: In production, protect with network policy or auth middleware.
The admin router uses a separate prefix (/admin) that can be restricted
at the ingress level.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, field_validator

from tnt_engine.governance.classification import ClassificationRegistry, FieldClassification, SensitivityLevel

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

    vault_status = {}
    token_manager = getattr(request.app.state, "vault_token_manager", None)
    if token_manager and token_manager.token_info:
        vault_status = {
            "auth_method": getattr(token_manager, "_provider", None)
            and token_manager._provider.method_name or "unknown",
            "token_ttl_remaining": round(token_manager.token_info.remaining_ttl, 1),
            "renewable": token_manager.token_info.renewable,
        }

    return {
        "circuit_breaker": cb.state,
        "l1_cache_size": cache.l1_size,
        "feature_flags": flags.get_all(),
        "dynamic_config": cfg.to_dict(),
        "event_subscriptions": events.subscriptions,
        "vault_token": vault_status,
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


# ── Audit Writer ─────────────────────────────────────────────────────

@admin_router.get("/audit/status")
async def audit_status(request: Request) -> dict:
    """Get audit writer status: buffer size, DLQ size."""
    writer = getattr(request.app.state, "audit_writer", None)
    if not writer:
        return {"status": "not_configured"}
    return {
        "buffer_size": writer.buffer_size,
        "dlq_size_bytes": writer.dlq_size_bytes,
    }


@admin_router.post("/audit/flush")
async def audit_flush(request: Request) -> dict:
    """Force an immediate audit buffer flush."""
    writer = getattr(request.app.state, "audit_writer", None)
    if not writer:
        raise HTTPException(status_code=404, detail="Audit writer not configured")
    count = await writer.flush_now()
    return {"status": "flushed", "entries_written": count}


@admin_router.post("/audit/dlq/replay")
async def audit_dlq_replay(request: Request) -> dict:
    """Replay dead letter queue entries back to the database."""
    writer = getattr(request.app.state, "audit_writer", None)
    if not writer:
        raise HTTPException(status_code=404, detail="Audit writer not configured")
    count = await writer.replay_dlq()
    return {"status": "replayed", "entries_recovered": count}


# ── Token Lifecycle Management ────────────────────────────────────────

@admin_router.get("/tokens")
async def list_tokens(
    request: Request,
    tenant_id: str = "",
    status: str | None = None,
    transformation: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    """List token records — safe metadata only, no plaintext or ciphertext.

    Fields returned: token, transformation, key_version, tenant_id,
                     status, expires_at, created_at, updated_at.
    value_encrypted is intentionally excluded.
    """
    db = getattr(request.app.state, "db", None)
    if not db:
        raise HTTPException(status_code=503, detail="Database not available")

    if limit > 200:
        raise HTTPException(status_code=400, detail="limit cannot exceed 200")

    from tnt_engine.db.repository import TokenRepository
    repo = TokenRepository(db)

    tokens = await repo.list_tokens(
        tenant_id=tenant_id or None,
        status=status,
        transformation=transformation,
        limit=limit,
        offset=offset,
    )
    stats = await repo.count_tokens_by_status(tenant_id=tenant_id or None)

    return {
        "tokens": tokens,
        "count": len(tokens),
        "stats": stats,
        "offset": offset,
        "limit": limit,
    }


# ── Transform Rules (dynamic, DB-backed) ─────────────────────────────

class RuleUpsert(BaseModel):
    name: str
    type: Literal["fpe", "masking", "hash"]
    template: str = ""
    tweak_source: str = "internal"
    allowed_roles: list[str] = ["tnt-engine"]
    classification: Literal["HIGH_SENSITIVE", "MEDIUM", "LOW", "UNCLASSIFIED"]
    allowed_operations: list[str]
    description: str = ""
    retention_days: int | None = None

    @field_validator("name")
    @classmethod
    def name_slug(cls, v: str) -> str:
        v = v.strip().lower().replace(" ", "_")
        if not v:
            raise ValueError("name must not be empty")
        return v

    @field_validator("allowed_operations")
    @classmethod
    def ops_not_empty(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("allowed_operations must contain at least one operation")
        valid = {"TOKENIZE", "MASK", "HMAC", "HASH", "PASSTHROUGH"}
        invalid = set(v) - valid
        if invalid:
            raise ValueError(f"unknown operations: {invalid}")
        return [op.upper() for op in v]


async def _get_db_or_503(request: Request):
    db = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=503, detail="Database not available")
    return db


@admin_router.get("/rules")
async def list_rules(request: Request) -> dict:
    """List all active transform rules from the database."""
    db = await _get_db_or_503(request)
    rows = await db.read_pool.fetch(
        """
        SELECT id, name, type, template, tweak_source, allowed_roles,
               classification, allowed_operations, description, retention_days,
               is_active, created_at, updated_at
        FROM transform_rules
        WHERE is_active = true
        ORDER BY
            CASE classification
                WHEN 'HIGH_SENSITIVE' THEN 1
                WHEN 'MEDIUM' THEN 2
                WHEN 'LOW' THEN 3
                ELSE 4
            END, name
        """
    )
    rules = []
    for row in rows:
        r = dict(row)
        for k, v in r.items():
            if hasattr(v, "isoformat"):
                r[k] = v.isoformat()
        rules.append(r)
    return {"rules": rules, "count": len(rules)}


@admin_router.post("/rules", status_code=201)
async def create_rule(body: RuleUpsert, request: Request) -> dict:
    """Create a new transform rule and register it in the live governance registry."""
    db = await _get_db_or_503(request)
    governance: ClassificationRegistry = request.app.state.governance

    try:
        await db.pool.execute(
            """
            INSERT INTO transform_rules
                (name, type, template, tweak_source, allowed_roles,
                 classification, allowed_operations, description, retention_days)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            """,
            body.name, body.type, body.template, body.tweak_source,
            body.allowed_roles, body.classification, body.allowed_operations,
            body.description, body.retention_days,
        )
    except Exception as exc:
        if "unique" in str(exc).lower():
            raise HTTPException(status_code=409, detail=f"Rule '{body.name}' already exists")
        raise HTTPException(status_code=500, detail=str(exc))

    governance.register(FieldClassification(
        field_type=body.name,
        level=SensitivityLevel(body.classification),
        description=body.description,
        retention_days=body.retention_days,
    ))
    return {"status": "created", "name": body.name}


@admin_router.put("/rules/{name}")
async def update_rule(name: str, body: RuleUpsert, request: Request) -> dict:
    """Update an existing transform rule and refresh the live governance registry."""
    db = await _get_db_or_503(request)
    governance: ClassificationRegistry = request.app.state.governance

    result = await db.pool.execute(
        """
        UPDATE transform_rules SET
            type = $2, template = $3, tweak_source = $4, allowed_roles = $5,
            classification = $6, allowed_operations = $7, description = $8,
            retention_days = $9
        WHERE name = $1 AND is_active = true
        """,
        name, body.type, body.template, body.tweak_source, body.allowed_roles,
        body.classification, body.allowed_operations, body.description,
        body.retention_days,
    )
    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail=f"Rule '{name}' not found")

    governance.register(FieldClassification(
        field_type=name,
        level=SensitivityLevel(body.classification),
        description=body.description,
        retention_days=body.retention_days,
    ))
    return {"status": "updated", "name": name}


@admin_router.delete("/rules/{name}")
async def delete_rule(name: str, request: Request) -> dict:
    """Soft-delete a transform rule and remove it from the live governance registry."""
    db = await _get_db_or_503(request)
    governance: ClassificationRegistry = request.app.state.governance

    result = await db.pool.execute(
        "UPDATE transform_rules SET is_active = false WHERE name = $1 AND is_active = true",
        name,
    )
    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail=f"Rule '{name}' not found")

    governance.deregister(name)
    return {"status": "deleted", "name": name}


# ── Audit Query ───────────────────────────────────────────────────────

class AuditQueryParams(BaseModel):
    tenant_id: str = ""
    action: str | None = None
    field: str | None = None
    since: str | None = None
    limit: int = 50


@admin_router.post("/audit/query")
async def audit_query(body: AuditQueryParams, request: Request) -> dict:
    """Query audit log entries with filters."""
    from datetime import datetime, timezone

    repo = getattr(request.app.state, "db", None)
    if not repo:
        raise HTTPException(status_code=503, detail="Database not available")

    from tnt_engine.db.repository import TokenRepository
    token_repo = TokenRepository(repo)

    since_dt = None
    if body.since:
        try:
            since_dt = datetime.fromisoformat(body.since.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid since format (use ISO 8601)")

    # If no tenant filter, query all entries directly
    if not body.tenant_id:
        conditions = []
        params: list = []
        idx = 1
        if body.action:
            conditions.append(f"action = ${idx}")
            params.append(body.action)
            idx += 1
        if body.field:
            conditions.append(f"field = ${idx}")
            params.append(body.field)
            idx += 1
        if since_dt:
            conditions.append(f"performed_at >= ${idx}")
            params.append(since_dt)
            idx += 1
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        rows = await repo.read_pool.fetch(
            f"SELECT * FROM audit_log {where} ORDER BY performed_at DESC LIMIT ${idx}",
            *params, min(body.limit, 500),
        )
        entries = [dict(r) for r in rows]
    else:
        entries = await token_repo.query_audit(
            tenant_id=body.tenant_id,
            action=body.action,
            field=body.field,
            since=since_dt,
            limit=min(body.limit, 500),
        )

    # Serialize datetime fields
    for e in entries:
        for k, v in e.items():
            if hasattr(v, "isoformat"):
                e[k] = v.isoformat()

    return {"entries": entries, "count": len(entries)}
