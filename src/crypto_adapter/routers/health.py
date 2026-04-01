import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from crypto_adapter.config import get_settings

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "tt-crypto-adapter", "version": "0.1.0"}


@router.get("/ready")
async def ready() -> JSONResponse:
    settings = get_settings()
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{settings.OPENBAO_ADDR}/v1/sys/health")
            resp.raise_for_status()
        return JSONResponse(
            status_code=200,
            content={"status": "ready", "openbao": "connected"},
        )
    except Exception:
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "openbao": "unreachable"},
        )
