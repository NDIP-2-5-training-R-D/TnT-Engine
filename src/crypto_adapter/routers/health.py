from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from crypto_adapter.auth import AppRoleAuth

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "tt-crypto-adapter", "version": "0.1.0"}


@router.get("/ready")
async def ready() -> JSONResponse:
    # Import here to avoid circular import at module load time
    from crypto_adapter.main import get_auth

    try:
        auth: AppRoleAuth = await get_auth()
        await auth.get_token()
        return JSONResponse(
            status_code=200,
            content={"status": "ready", "openbao": "connected"},
        )
    except Exception:
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "openbao": "unreachable"},
        )
