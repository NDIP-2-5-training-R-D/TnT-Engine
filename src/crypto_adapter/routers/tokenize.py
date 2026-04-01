"""Tokenize / detokenize endpoints."""
import asyncio
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from crypto_adapter.client.openbao_client import OpenBaoClient
from crypto_adapter.services.tokenization import TokenizationService

logger = logging.getLogger(__name__)

router = APIRouter()


# ------------------------------------------------------------------ #
# Request / Response schemas                                           #
# ------------------------------------------------------------------ #


class TokenizeRequest(BaseModel):
    value: str
    key_name: str | None = None


class TokenizeResponse(BaseModel):
    token: str
    key_name: str


class DetokenizeRequest(BaseModel):
    token: str
    key_name: str | None = None


class DetokenizeResponse(BaseModel):
    value: str
    key_name: str


class BatchTokenizeItem(BaseModel):
    value: str
    key_name: str | None = None


class BatchTokenizeRequest(BaseModel):
    items: list[BatchTokenizeItem]
    max_items: int = Field(default=100, ge=1, le=1000)


class BatchTokenizeResultItem(BaseModel):
    index: int
    token: str | None = None
    error: str | None = None
    success: bool


class BatchTokenizeResponse(BaseModel):
    results: list[BatchTokenizeResultItem]
    success_count: int
    error_count: int


# ------------------------------------------------------------------ #
# Helpers                                                              #
# ------------------------------------------------------------------ #


async def get_openbao_client() -> OpenBaoClient:
    from crypto_adapter.main import get_openbao_client as _get

    return await _get()


def _resolve_key(key_name: str | None) -> str:
    from crypto_adapter.config import get_settings

    return key_name or get_settings().OPENBAO_TRANSIT_KEY


# ------------------------------------------------------------------ #
# Endpoints                                                            #
# ------------------------------------------------------------------ #


@router.post("/tokenize", response_model=TokenizeResponse)
async def tokenize(
    request: TokenizeRequest,
    client: Annotated[OpenBaoClient, Depends(get_openbao_client)],
) -> TokenizeResponse:
    key_name = _resolve_key(request.key_name)
    svc = TokenizationService(client)
    token = await svc.tokenize(request.value, key_name)
    return TokenizeResponse(token=token, key_name=key_name)


@router.post("/detokenize", response_model=DetokenizeResponse)
async def detokenize(
    request: DetokenizeRequest,
    client: Annotated[OpenBaoClient, Depends(get_openbao_client)],
) -> DetokenizeResponse:
    key_name = _resolve_key(request.key_name)
    svc = TokenizationService(client)
    value = await svc.detokenize(request.token, key_name)
    return DetokenizeResponse(value=value, key_name=key_name)


@router.post("/tokenize/batch", response_model=BatchTokenizeResponse)
async def batch_tokenize(
    request: BatchTokenizeRequest,
    client: Annotated[OpenBaoClient, Depends(get_openbao_client)],
) -> BatchTokenizeResponse:
    items = request.items[: request.max_items]
    svc = TokenizationService(client)

    async def _tokenize_one(item: BatchTokenizeItem) -> str:
        key_name = _resolve_key(item.key_name)
        return await svc.tokenize(item.value, key_name)

    outcomes = await asyncio.gather(
        *(_tokenize_one(item) for item in items), return_exceptions=True
    )

    results: list[BatchTokenizeResultItem] = []
    success_count = 0
    error_count = 0
    for idx, outcome in enumerate(outcomes):
        if isinstance(outcome, Exception):
            results.append(
                BatchTokenizeResultItem(index=idx, success=False, error=str(outcome))
            )
            error_count += 1
        else:
            results.append(
                BatchTokenizeResultItem(index=idx, token=outcome, success=True)
            )
            success_count += 1

    return BatchTokenizeResponse(
        results=results, success_count=success_count, error_count=error_count
    )


@router.get("/tokenize/validate")
async def validate_token(token: str = Query(...)) -> dict:
    valid = TokenizationService.is_valid_token(token)
    return {"valid": valid, "format": "tt1"}
