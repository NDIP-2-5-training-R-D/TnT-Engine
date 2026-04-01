"""Key management endpoints."""
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from crypto_adapter.auth.exceptions import (
    CircuitBreakerOpenError,
    OpenBaoAuthError,
    OpenBaoCryptoError,
    OpenBaoUnavailableError,
)
from crypto_adapter.client.openbao_client import OpenBaoClient
from crypto_adapter.services.key_management import KeyManagementService

logger = logging.getLogger(__name__)

router = APIRouter()


# ------------------------------------------------------------------ #
# Request schemas                                                      #
# ------------------------------------------------------------------ #


class KeyConfigRequest(BaseModel):
    min_decryption_version: int


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
    from crypto_adapter.main import get_openbao_client as _get

    return await _get()


# ------------------------------------------------------------------ #
# Endpoints                                                            #
# ------------------------------------------------------------------ #


@router.get("/{key_name}/info")
async def get_key_info(
    key_name: str,
    client: Annotated[OpenBaoClient, Depends(get_openbao_client)],
) -> dict:
    try:
        return await client.get_key_info(key_name)
    except Exception as exc:
        _raise_http(exc)
        raise


@router.get("/{key_name}/version")
async def get_key_version(
    key_name: str,
    client: Annotated[OpenBaoClient, Depends(get_openbao_client)],
) -> dict:
    svc = KeyManagementService(client)
    try:
        return await svc.get_key_version(key_name)
    except Exception as exc:
        _raise_http(exc)
        raise


@router.post("/{key_name}/rotate")
async def rotate_key(
    key_name: str,
    client: Annotated[OpenBaoClient, Depends(get_openbao_client)],
) -> dict:
    svc = KeyManagementService(client)
    try:
        return await svc.rotate_key(key_name)
    except Exception as exc:
        _raise_http(exc)
        raise


@router.post("/{key_name}/config")
async def set_key_config(
    key_name: str,
    request: KeyConfigRequest,
    client: Annotated[OpenBaoClient, Depends(get_openbao_client)],
) -> dict:
    svc = KeyManagementService(client)
    try:
        return await svc.set_min_decryption_version(request.min_decryption_version, key_name)
    except Exception as exc:
        _raise_http(exc)
        raise
