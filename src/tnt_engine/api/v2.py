"""API v2 — extends v1 with quota enforcement and event emission.

v1 endpoints continue to work unchanged. v2 adds:
  - Quota checks before tokenize
  - Event emission after tokenize/revoke/delete
  - Quota usage in response headers

Consumers migrate to v2 when ready. No v1 breaking changes.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from tnt_engine.errors import (
    InvalidTokenFormatError,
    TokenExpiredError,
    TokenNotFoundError,
    TokenRevokedError,
)
from tnt_engine.events.bus import Event, EventBus
from tnt_engine.models.domain import (
    BatchTokenizeRequest,
    BatchTokenizeResponse,
    DetokenizeRequest,
    DetokenizeResponse,
    RevokeRequest,
    DeleteRequest,
    TokenizeRequest,
    TokenizeResponse,
)
from tnt_engine.security.quota import QuotaExceededError, QuotaManager
from tnt_engine.service.token_service import TokenService
from tnt_engine.tracing import ensure_trace_id, get_trace_id

v2_router = APIRouter(prefix="/api/v2", tags=["tokenization-v2"])


def _svc(request: Request) -> TokenService:
    return request.app.state.token_service


def _bus(request: Request) -> EventBus:
    return request.app.state.event_bus


def _quota(request: Request) -> QuotaManager:
    return request.app.state.quota_manager


@v2_router.post("/tokenize", response_model=TokenizeResponse)
async def tokenize_v2(
    body: TokenizeRequest,
    response: Response,
    svc: TokenService = Depends(_svc),
    bus: EventBus = Depends(_bus),
    quota: QuotaManager = Depends(_quota),
) -> TokenizeResponse:
    ensure_trace_id()

    # Quota enforcement (v2 addition)
    try:
        quota.check(body.tenant_id)
    except QuotaExceededError as e:
        raise HTTPException(status_code=429, detail=str(e))

    result = await svc.tokenize(body)

    # Record usage + emit event (v2 addition)
    quota.record_usage(body.tenant_id)
    bus.publish_fire_and_forget(Event(
        type="TOKEN_CREATED",
        tenant_id=body.tenant_id,
        data={"token_prefix": result.token[:12], "field": body.field},
        trace_id=get_trace_id(),
    ))

    # Usage header (v2 addition)
    usage = quota.get_usage(body.tenant_id)
    if usage["limit"] > 0:
        response.headers["X-Quota-Remaining"] = str(usage["remaining"])

    return result


@v2_router.post("/tokenize/batch", response_model=BatchTokenizeResponse)
async def batch_tokenize_v2(
    body: BatchTokenizeRequest,
    response: Response,
    svc: TokenService = Depends(_svc),
    bus: EventBus = Depends(_bus),
    quota: QuotaManager = Depends(_quota),
) -> BatchTokenizeResponse:
    ensure_trace_id()
    tenant_id = body.items[0].tenant_id

    try:
        quota.check(tenant_id)
    except QuotaExceededError as e:
        raise HTTPException(status_code=429, detail=str(e))

    results = await svc.batch_tokenize(body.items)

    quota.record_usage(tenant_id, count=len(body.items))
    bus.publish_fire_and_forget(Event(
        type="BATCH_TOKEN_CREATED",
        tenant_id=tenant_id,
        data={"count": len(body.items)},
        trace_id=get_trace_id(),
    ))

    usage = quota.get_usage(tenant_id)
    if usage["limit"] > 0:
        response.headers["X-Quota-Remaining"] = str(usage["remaining"])

    return BatchTokenizeResponse(results=results)


@v2_router.post("/detokenize", response_model=DetokenizeResponse)
async def detokenize_v2(
    body: DetokenizeRequest,
    svc: TokenService = Depends(_svc),
) -> DetokenizeResponse:
    """Detokenize — identical to v1 (no breaking changes)."""
    ensure_trace_id()
    try:
        value = await svc.detokenize(body.token, body.tenant_id)
    except TokenNotFoundError:
        raise HTTPException(status_code=404, detail="Token not found")
    except TokenRevokedError:
        raise HTTPException(status_code=410, detail="Token has been revoked")
    except TokenExpiredError:
        raise HTTPException(status_code=410, detail="Token has expired")
    except InvalidTokenFormatError:
        raise HTTPException(status_code=400, detail="Invalid token format")
    return DetokenizeResponse(value=value)


@v2_router.post("/token/revoke")
async def revoke_v2(
    body: RevokeRequest,
    svc: TokenService = Depends(_svc),
    bus: EventBus = Depends(_bus),
) -> dict:
    ensure_trace_id()
    try:
        ok = await svc.revoke(body.token, body.tenant_id)
    except InvalidTokenFormatError:
        raise HTTPException(status_code=400, detail="Invalid token format")
    if not ok:
        raise HTTPException(status_code=404, detail="Token not found or already inactive")

    bus.publish_fire_and_forget(Event(
        type="TOKEN_REVOKED",
        tenant_id=body.tenant_id,
        data={"token_prefix": body.token[:12]},
        trace_id=get_trace_id(),
    ))
    return {"status": "revoked"}


@v2_router.post("/token/delete")
async def delete_v2(
    body: DeleteRequest,
    svc: TokenService = Depends(_svc),
    bus: EventBus = Depends(_bus),
) -> dict:
    ensure_trace_id()
    try:
        ok = await svc.delete(body.token, body.tenant_id)
    except InvalidTokenFormatError:
        raise HTTPException(status_code=400, detail="Invalid token format")
    if not ok:
        raise HTTPException(status_code=404, detail="Token not found")

    bus.publish_fire_and_forget(Event(
        type="TOKEN_DELETED",
        tenant_id=body.tenant_id,
        data={"token_prefix": body.token[:12]},
        trace_id=get_trace_id(),
    ))
    return {"status": "deleted"}
