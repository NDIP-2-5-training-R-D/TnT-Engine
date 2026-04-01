"""FastAPI routes — multi-tenant, lifecycle-aware API."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from tnt_engine.errors import (
    InvalidTokenFormatError,
    TokenExpiredError,
    TokenNotFoundError,
    TokenRevokedError,
)
from tnt_engine.models.domain import (
    BatchDetokenizeRequest,
    BatchDetokenizeResponse,
    BatchTokenizeRequest,
    BatchTokenizeResponse,
    DeleteRequest,
    DetokenizeRequest,
    DetokenizeResponse,
    RevokeRequest,
    TokenizeRequest,
    TokenizeResponse,
)
from tnt_engine.service.policy import PolicyEngine
from tnt_engine.service.token_service import TokenService
from tnt_engine.tracing import ensure_trace_id

router = APIRouter(prefix="/api/v1", tags=["tokenization"])


def _get_service(request: Request) -> TokenService:
    return request.app.state.token_service


# ── Tokenize ─────────────────────────────────────────────────────────

@router.post("/tokenize", response_model=TokenizeResponse)
async def tokenize(
    body: TokenizeRequest,
    svc: TokenService = Depends(_get_service),
) -> TokenizeResponse:
    ensure_trace_id()
    return await svc.tokenize(body)


@router.post("/tokenize/batch", response_model=BatchTokenizeResponse)
async def batch_tokenize(
    body: BatchTokenizeRequest,
    svc: TokenService = Depends(_get_service),
) -> BatchTokenizeResponse:
    ensure_trace_id()
    results = await svc.batch_tokenize(body.items)
    return BatchTokenizeResponse(results=results)


# ── Detokenize ───────────────────────────────────────────────────────

@router.post("/detokenize", response_model=DetokenizeResponse)
async def detokenize(
    body: DetokenizeRequest,
    svc: TokenService = Depends(_get_service),
) -> DetokenizeResponse:
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


@router.post("/detokenize/batch", response_model=BatchDetokenizeResponse)
async def batch_detokenize(
    body: BatchDetokenizeRequest,
    svc: TokenService = Depends(_get_service),
) -> BatchDetokenizeResponse:
    ensure_trace_id()
    try:
        mapping = await svc.batch_detokenize(body.tokens, body.tenant_id)
    except TokenNotFoundError as e:
        raise HTTPException(status_code=404, detail=e.message)
    except (TokenRevokedError, TokenExpiredError) as e:
        raise HTTPException(status_code=410, detail=e.message)
    except InvalidTokenFormatError:
        raise HTTPException(status_code=400, detail="Invalid token format")
    results = [DetokenizeResponse(value=mapping[t]) for t in body.tokens]
    return BatchDetokenizeResponse(results=results)


# ── Lifecycle ────────────────────────────────────────────────────────

@router.post("/token/revoke")
async def revoke_token(
    body: RevokeRequest,
    svc: TokenService = Depends(_get_service),
) -> dict:
    ensure_trace_id()
    try:
        ok = await svc.revoke(body.token, body.tenant_id)
    except InvalidTokenFormatError:
        raise HTTPException(status_code=400, detail="Invalid token format")
    if not ok:
        raise HTTPException(status_code=404, detail="Token not found or already inactive")
    return {"status": "revoked"}


@router.post("/token/delete")
async def delete_token(
    body: DeleteRequest,
    svc: TokenService = Depends(_get_service),
) -> dict:
    ensure_trace_id()
    try:
        ok = await svc.delete(body.token, body.tenant_id)
    except InvalidTokenFormatError:
        raise HTTPException(status_code=400, detail="Invalid token format")
    if not ok:
        raise HTTPException(status_code=404, detail="Token not found")
    return {"status": "deleted"}


# ── Policy processing ────────────────────────────────────────────────


class ProcessFieldRequest(BaseModel):
    policy: dict
    value: str = Field(..., min_length=1)
    tenant_id: str = Field(..., min_length=1)


class ProcessRecordRequest(BaseModel):
    policies: list[dict] = Field(..., min_length=1)
    values: dict[str, str]
    tenant_id: str = Field(..., min_length=1)


def _get_policy_engine(request: Request) -> PolicyEngine:
    return request.app.state.policy_engine


@router.post("/process/field")
async def process_field(
    body: ProcessFieldRequest,
    engine: PolicyEngine = Depends(_get_policy_engine),
) -> dict:
    ensure_trace_id()
    result = await engine.process_field(body.policy, body.value, body.tenant_id)
    return {"field": result.field, "action": result.action, "value": result.transformed_value}


@router.post("/process/record")
async def process_record(
    body: ProcessRecordRequest,
    engine: PolicyEngine = Depends(_get_policy_engine),
) -> dict:
    ensure_trace_id()
    results = await engine.process_record(body.policies, body.values, body.tenant_id)
    return {
        field: {"action": r.action, "value": r.transformed_value}
        for field, r in results.items()
    }


# ── Health ───────────────────────────────────────────────────────────

@router.get("/health")
async def health(request: Request) -> dict:
    """Full health check — includes dependency status. Used by liveness probe."""
    cb = request.app.state.circuit_breaker
    cache = request.app.state.layered_cache
    return {
        "status": "ok",
        "circuit_breaker": cb.state,
        "l1_cache_size": cache.l1_size,
    }


@router.get("/ready")
async def ready(request: Request) -> dict:
    """Readiness probe — lightweight check that the service can accept traffic.
    Returns 200 if the app is initialized. Does NOT check dependencies
    (DB/Redis/crypto) — those have their own circuit breakers and graceful degradation.
    """
    return {"ready": True}
