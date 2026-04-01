"""Key management endpoints."""
import logging
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

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
    return await client.get_key_info(key_name)


@router.get("/{key_name}/version")
async def get_key_version(
    key_name: str,
    client: Annotated[OpenBaoClient, Depends(get_openbao_client)],
) -> dict:
    svc = KeyManagementService(client)
    return await svc.get_key_version(key_name)


@router.post("/{key_name}/rotate")
async def rotate_key(
    key_name: str,
    client: Annotated[OpenBaoClient, Depends(get_openbao_client)],
) -> dict:
    svc = KeyManagementService(client)
    return await svc.rotate_key(key_name)


@router.post("/{key_name}/config")
async def set_key_config(
    key_name: str,
    request: KeyConfigRequest,
    client: Annotated[OpenBaoClient, Depends(get_openbao_client)],
) -> dict:
    svc = KeyManagementService(client)
    return await svc.set_min_decryption_version(request.min_decryption_version, key_name)
