import logging

from fastapi import Depends, FastAPI, Request

from crypto_adapter.auth import AppRoleAuth
from crypto_adapter.config import get_settings
from crypto_adapter.routers import health

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="TT Crypto Adapter", version="0.1.0")

app.include_router(health.router)

# Module-level singleton — populated during startup
_auth_instance: AppRoleAuth | None = None


@app.on_event("startup")
async def on_startup() -> None:
    global _auth_instance
    logger.info("Service starting...")
    settings = get_settings()
    _auth_instance = AppRoleAuth(settings)
    await _auth_instance.start()


@app.on_event("shutdown")
async def on_shutdown() -> None:
    global _auth_instance
    if _auth_instance is not None:
        await _auth_instance.stop()
        _auth_instance = None


async def get_auth() -> AppRoleAuth:
    assert _auth_instance is not None, "Auth not initialised"
    return _auth_instance


@app.middleware("http")
async def log_requests(request: Request, call_next):
    response = await call_next(request)
    logger.info("%s %s %s", request.method, request.url.path, response.status_code)
    return response
