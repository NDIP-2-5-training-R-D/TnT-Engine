"""Internal unified crypto endpoint for Engine Core team.

POST /internal/crypto       — single operation
POST /internal/crypto/batch — up to 500 operations in one call
"""
import asyncio
import time
import uuid
from enum import Enum
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from crypto_adapter.auth.exceptions import (
    CircuitBreakerOpenError,
    OpenBaoAuthError,
    OpenBaoCryptoError,
    OpenBaoUnavailableError,
)
from crypto_adapter.client.openbao_client import OpenBaoClient
from crypto_adapter.schemas.errors import ErrorCode

router = APIRouter(prefix="/internal")

_BATCH_MAX = 500


# ---------------------------------------------------------------------------
# Enums and request/response models
# ---------------------------------------------------------------------------


class CryptoOperation(str, Enum):
    hmac = "hmac"
    encrypt = "encrypt"
    decrypt = "decrypt"
    tokenize = "tokenize"
    detokenize = "detokenize"


class InternalCryptoRequest(BaseModel):
    operation: CryptoOperation
    input: str
    key_name: Optional[str] = None
    request_id: Optional[str] = None


class InternalCryptoResponse(BaseModel):
    operation: CryptoOperation
    output: str
    key_name: str
    request_id: str


class BatchItemResult(BaseModel):
    success: bool
    operation: Optional[CryptoOperation] = None
    output: Optional[str] = None
    key_name: Optional[str] = None
    request_id: Optional[str] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None


class InternalBatchRequest(BaseModel):
    items: list[InternalCryptoRequest] = Field(
        ..., max_length=_BATCH_MAX
    )


class InternalBatchResponse(BaseModel):
    results: list[BatchItemResult]
    total: int
    success_count: int
    error_count: int
    duration_ms: float


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _get_client() -> OpenBaoClient:
    from crypto_adapter.main import get_openbao_client

    return await get_openbao_client()


def _resolve_key(key_name: Optional[str]) -> str:
    from crypto_adapter.config import get_settings

    return key_name or get_settings().OPENBAO_TRANSIT_KEY


def _exc_to_error_code(exc: Exception) -> str:
    if isinstance(exc, CircuitBreakerOpenError):
        return ErrorCode.CIRCUIT_OPEN
    if isinstance(exc, OpenBaoAuthError):
        return ErrorCode.AUTH_FAILED
    if isinstance(exc, OpenBaoUnavailableError):
        return ErrorCode.VAULT_UNAVAILABLE
    if isinstance(exc, OpenBaoCryptoError):
        return ErrorCode.CRYPTO_ERROR
    if isinstance(exc, ValueError):
        return ErrorCode.INVALID_INPUT
    return ErrorCode.CRYPTO_ERROR


async def _run_operation(
    item: InternalCryptoRequest,
    client: OpenBaoClient,
) -> InternalCryptoResponse:
    """Execute a single crypto operation and return a typed response."""
    from crypto_adapter.services.tokenization import TokenizationService

    key_name = _resolve_key(item.key_name)
    request_id = item.request_id or str(uuid.uuid4())

    if item.operation == CryptoOperation.hmac:
        output = await client.hmac(item.input, key_name)
    elif item.operation == CryptoOperation.encrypt:
        output = await client.encrypt(item.input, key_name)
    elif item.operation == CryptoOperation.decrypt:
        output = await client.decrypt(item.input, key_name)
    elif item.operation == CryptoOperation.tokenize:
        svc = TokenizationService(client)
        output = await svc.tokenize(item.input, key_name)
    elif item.operation == CryptoOperation.detokenize:
        svc = TokenizationService(client)
        output = await svc.detokenize(item.input, key_name)
    else:  # pragma: no cover — enum exhaustive
        raise ValueError(f"Unknown operation: {item.operation}")

    return InternalCryptoResponse(
        operation=item.operation,
        output=output,
        key_name=key_name,
        request_id=request_id,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/crypto", response_model=InternalCryptoResponse)
async def single_crypto(
    request: InternalCryptoRequest,
    client: Annotated[OpenBaoClient, Depends(_get_client)],
) -> InternalCryptoResponse:
    """Execute a single crypto operation."""
    return await _run_operation(request, client)


@router.post("/crypto/batch", response_model=InternalBatchResponse)
async def batch_crypto(
    request: InternalBatchRequest,
    client: Annotated[OpenBaoClient, Depends(_get_client)],
) -> InternalBatchResponse:
    """Execute up to 500 crypto operations concurrently."""
    if len(request.items) > _BATCH_MAX:
        raise ValueError(
            f"Batch size {len(request.items)} exceeds maximum of {_BATCH_MAX}"
        )

    t0 = time.perf_counter()

    outcomes: list[Any] = await asyncio.gather(
        *[_run_operation(item, client) for item in request.items],
        return_exceptions=True,
    )

    duration_ms = round((time.perf_counter() - t0) * 1000, 2)

    results: list[BatchItemResult] = []
    for item, outcome in zip(request.items, outcomes):
        if isinstance(outcome, Exception):
            results.append(
                BatchItemResult(
                    success=False,
                    operation=item.operation,
                    key_name=_resolve_key(item.key_name),
                    request_id=item.request_id or str(uuid.uuid4()),
                    error_code=_exc_to_error_code(outcome),
                    error_message=str(outcome),
                )
            )
        else:
            results.append(
                BatchItemResult(
                    success=True,
                    operation=outcome.operation,
                    output=outcome.output,
                    key_name=outcome.key_name,
                    request_id=outcome.request_id,
                )
            )

    success_count = sum(1 for r in results if r.success)

    return InternalBatchResponse(
        results=results,
        total=len(results),
        success_count=success_count,
        error_count=len(results) - success_count,
        duration_ms=duration_ms,
    )
