import logging

from fastapi import FastAPI, Request

from crypto_adapter.auth import AppRoleAuth
from crypto_adapter.client.openbao_client import OpenBaoClient
from crypto_adapter.config import get_settings
from crypto_adapter.routers import health
from crypto_adapter.routers import crypto

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="TT Crypto Adapter", version="0.1.0")

app.include_router(health.router)
app.include_router(crypto.router, prefix="/crypto")

# Module-level singletons — populated during startup
_auth_instance: AppRoleAuth | None = None
_openbao_client: OpenBaoClient | None = None


@app.on_event("startup")
async def on_startup() -> None:
    global _auth_instance, _openbao_client
    logger.info("Service starting...")
    settings = get_settings()
    _auth_instance = AppRoleAuth(settings)
    await _auth_instance.start()
    _openbao_client = OpenBaoClient(settings, _auth_instance)
    await _openbao_client.start()


@app.on_event("shutdown")
async def on_shutdown() -> None:
    global _auth_instance, _openbao_client
    if _openbao_client is not None:
        await _openbao_client.stop()
        _openbao_client = None
    if _auth_instance is not None:
        await _auth_instance.stop()
        _auth_instance = None


async def get_auth() -> AppRoleAuth:
    assert _auth_instance is not None, "Auth not initialised"
    return _auth_instance


async def get_openbao_client() -> OpenBaoClient:
    assert _openbao_client is not None, "OpenBaoClient not initialised"
    return _openbao_client


@app.middleware("http")
async def log_requests(request: Request, call_next):
    response = await call_next(request)
    logger.info("%s %s %s", request.method, request.url.path, response.status_code)
    return response
