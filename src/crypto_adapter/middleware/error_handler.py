"""Global exception handlers — maps domain exceptions to standardised ErrorResponse."""
import logging
import traceback
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from crypto_adapter.auth.exceptions import (
    CircuitBreakerOpenError,
    OpenBaoAuthError,
    OpenBaoCryptoError,
    OpenBaoUnavailableError,
)
from crypto_adapter.schemas.errors import ErrorCode, ErrorResponse

logger = logging.getLogger(__name__)


def _get_request_id(request: Request) -> str:
    return request.headers.get("X-Request-ID", str(uuid.uuid4()))


def _make_response(
    request: Request,
    status_code: int,
    error_code: ErrorCode,
    message: str,
) -> JSONResponse:
    request_id = _get_request_id(request)
    body = ErrorResponse(
        error_code=error_code,
        message=message,
        request_id=request_id,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )
    return JSONResponse(
        status_code=status_code,
        content=body.model_dump(),
        headers={"X-Request-ID": request_id},
    )


def register_exception_handlers(app: FastAPI) -> None:
    """Attach all domain exception → HTTP status code mappings to *app*."""

    @app.exception_handler(CircuitBreakerOpenError)
    async def handle_circuit_open(
        request: Request, exc: CircuitBreakerOpenError
    ) -> JSONResponse:
        return _make_response(request, 503, ErrorCode.CIRCUIT_OPEN, str(exc))

    @app.exception_handler(OpenBaoAuthError)
    async def handle_auth_error(
        request: Request, exc: OpenBaoAuthError
    ) -> JSONResponse:
        return _make_response(request, 401, ErrorCode.AUTH_FAILED, str(exc))

    @app.exception_handler(OpenBaoUnavailableError)
    async def handle_unavailable(
        request: Request, exc: OpenBaoUnavailableError
    ) -> JSONResponse:
        return _make_response(request, 503, ErrorCode.VAULT_UNAVAILABLE, str(exc))

    @app.exception_handler(OpenBaoCryptoError)
    async def handle_crypto_error(
        request: Request, exc: OpenBaoCryptoError
    ) -> JSONResponse:
        return _make_response(request, 422, ErrorCode.CRYPTO_ERROR, str(exc))

    @app.exception_handler(ValueError)
    async def handle_value_error(
        request: Request, exc: ValueError
    ) -> JSONResponse:
        return _make_response(request, 400, ErrorCode.INVALID_INPUT, str(exc))

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return _make_response(
            request, 422, ErrorCode.INVALID_INPUT, str(exc)
        )

    @app.exception_handler(Exception)
    async def handle_generic_error(
        request: Request, exc: Exception
    ) -> JSONResponse:
        logger.error("Unhandled exception:\n%s", traceback.format_exc())
        return _make_response(
            request, 500, ErrorCode.CRYPTO_ERROR, "An internal error occurred"
        )
