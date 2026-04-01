import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from crypto_adapter.auth.exceptions import (
    CircuitBreakerOpenError,
    OpenBaoAuthError,
    OpenBaoCryptoError,
    OpenBaoUnavailableError,
)
from crypto_adapter.client.openbao_client import OpenBaoClient

logger = logging.getLogger(__name__)

router = APIRouter()


# ------------------------------------------------------------------ #
# Request / Response schemas                                           #
# ------------------------------------------------------------------ #


class HmacRequest(BaseModel):
    input: str
    key_name: str | None = None


class HmacResponse(BaseModel):
    hmac: str
    key_name: str
    algorithm: str


class EncryptRequest(BaseModel):
    plaintext: str
    key_name: str | None = None


class EncryptResponse(BaseModel):
    ciphertext: str
    key_name: str


class DecryptRequest(BaseModel):
    ciphertext: str
    key_name: str | None = None


class DecryptResponse(BaseModel):
    plaintext: str


class RotateKeyRequest(BaseModel):
    key_name: str | None = None


# ------------------------------------------------------------------ #
# Helpers                                                              #
# ------------------------------------------------------------------ #


def _raise_http(exc: Exception) -> None:
    """Map domain exceptions to HTTP status codes."""
    if isinstance(exc, OpenBaoAuthError):
        raise HTTPException(status_code=401, detail=str(exc))
    if isinstance(exc, (CircuitBreakerOpenError, OpenBaoUnavailableError)):
        raise HTTPException(status_code=503, detail=str(exc))
    if isinstance(exc, OpenBaoCryptoError):
        raise HTTPException(status_code=422, detail=str(exc))
    raise exc


async def get_openbao_client() -> OpenBaoClient:
    # Deferred import to avoid circular dependency at module load time
    from crypto_adapter.main import get_openbao_client as _get

    return await _get()


def _resolve_key(key_name: str | None) -> str:
    from crypto_adapter.config import get_settings

    return key_name or get_settings().OPENBAO_TRANSIT_KEY


# ------------------------------------------------------------------ #
# Endpoints                                                            #
# ------------------------------------------------------------------ #


@router.post("/hmac", response_model=HmacResponse)
async def compute_hmac(
    request: HmacRequest,
    client: Annotated[OpenBaoClient, Depends(get_openbao_client)],
) -> HmacResponse:
    key_name = _resolve_key(request.key_name)
    try:
        hmac_value = await client.hmac(request.input, key_name)
    except Exception as exc:
        _raise_http(exc)
        raise  # unreachable; satisfies type checker
    return HmacResponse(hmac=hmac_value, key_name=key_name, algorithm="sha2-512")


@router.post("/encrypt", response_model=EncryptResponse)
async def encrypt(
    request: EncryptRequest,
    client: Annotated[OpenBaoClient, Depends(get_openbao_client)],
) -> EncryptResponse:
    key_name = _resolve_key(request.key_name)
    try:
        ciphertext = await client.encrypt(request.plaintext, key_name)
    except Exception as exc:
        _raise_http(exc)
        raise
    return EncryptResponse(ciphertext=ciphertext, key_name=key_name)


@router.post("/decrypt", response_model=DecryptResponse)
async def decrypt(
    request: DecryptRequest,
    client: Annotated[OpenBaoClient, Depends(get_openbao_client)],
) -> DecryptResponse:
    key_name = _resolve_key(request.key_name)
    try:
        plaintext = await client.decrypt(request.ciphertext, key_name)
    except Exception as exc:
        _raise_http(exc)
        raise
    return DecryptResponse(plaintext=plaintext)


@router.get("/key-info")
async def key_info(
    client: Annotated[OpenBaoClient, Depends(get_openbao_client)],
    key_name: str | None = Query(default=None),
) -> dict:
    resolved_key = _resolve_key(key_name)
    try:
        return await client.get_key_info(resolved_key)
    except Exception as exc:
        _raise_http(exc)
        raise


@router.post("/rotate-key")
async def rotate_key(
    request: RotateKeyRequest,
    client: Annotated[OpenBaoClient, Depends(get_openbao_client)],
) -> dict:
    key_name = _resolve_key(request.key_name)
    try:
        await client.rotate_key(key_name)
    except Exception as exc:
        _raise_http(exc)
        raise
    return {"rotated": True, "key_name": key_name}
