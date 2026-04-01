import logging

from fastapi import FastAPI, Request

from crypto_adapter.routers import health

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="TT Crypto Adapter", version="0.1.0")

app.include_router(health.router)


@app.on_event("startup")
async def on_startup() -> None:
    logger.info("Service starting...")


@app.middleware("http")
async def log_requests(request: Request, call_next):
    response = await call_next(request)
    logger.info("%s %s %s", request.method, request.url.path, response.status_code)
    return response
