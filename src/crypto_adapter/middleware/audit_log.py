"""Structured JSON audit-log middleware.

Logs one record per request with metadata only — never logs input values,
plaintext, ciphertext, tokens, HMAC values, or any other sensitive payload.
"""
import json
import logging
import time
import uuid
from typing import Optional

from pythonjsonlogger import jsonlogger
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

# ---------------------------------------------------------------------------
# Dedicated audit logger — JSON-formatted, does not propagate to root logger
# ---------------------------------------------------------------------------

_audit_logger = logging.getLogger("crypto_adapter.audit")
if not _audit_logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        jsonlogger.JsonFormatter(
            fmt="%(asctime)s %(levelname)s %(name)s %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
    )
    _audit_logger.addHandler(_handler)
    _audit_logger.propagate = False

# ---------------------------------------------------------------------------
# Operation detection helpers
# ---------------------------------------------------------------------------

_PATH_SUFFIX_TO_OP: dict[str, str] = {
    "/hmac": "hmac",
    "/encrypt": "encrypt",
    "/decrypt": "decrypt",
    "/tokenize": "tokenize",
    "/detokenize": "detokenize",
    "/rotate-key": "rotate",
    "/rotate": "rotate",
    "/crypto/batch": "batch",
}


def _operation_from_path(path: str) -> Optional[str]:
    for suffix, op in _PATH_SUFFIX_TO_OP.items():
        if path.endswith(suffix):
            return op
    return None


# Sensitive keys that must NEVER appear in audit logs.
_SENSITIVE_KEYS = frozenset(
    {
        "input",
        "plaintext",
        "ciphertext",
        "token",
        "value",
        "items",
        "output",
        "hmac",
        "result",
        "results",
    }
)


def _safe_extract(body_bytes: bytes) -> dict:
    """Parse the JSON body and return ONLY non-sensitive metadata fields."""
    try:
        body = json.loads(body_bytes)
    except (json.JSONDecodeError, ValueError):
        return {}

    if not isinstance(body, dict):
        return {}

    extracted: dict = {}
    # key_name is metadata — safe to log
    if "key_name" in body and isinstance(body["key_name"], (str, type(None))):
        extracted["key_name"] = body["key_name"]
    # operation field from /internal/crypto
    if "operation" in body and isinstance(body["operation"], str):
        extracted["operation"] = body["operation"]
    return extracted


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------


class AuditLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        start = time.perf_counter()

        # Body is cached by Starlette — safe to call multiple times
        body_bytes = await request.body()
        body_meta = _safe_extract(body_bytes)

        path = request.url.path
        operation = body_meta.get("operation") or _operation_from_path(path)
        key_name = body_meta.get("key_name")
        client_ip: Optional[str] = (
            request.client.host if request.client else None
        )

        response = await call_next(request)

        duration_ms = round((time.perf_counter() - start) * 1000, 2)
        success = response.status_code < 400
        error_code: Optional[str] = (
            None if success else response.headers.get("X-Error-Code")
        )

        log_extra: dict = {
            "request_id": request_id,
            "method": request.method,
            "path": path,
            "status_code": response.status_code,
            "duration_ms": duration_ms,
            "client_ip": client_ip,
            "operation": operation,
            "key_name": key_name,
            "success": success,
        }
        if error_code:
            log_extra["error_code"] = error_code

        _audit_logger.info("request", extra=log_extra)

        # Propagate request-id in every response
        response.headers["X-Request-ID"] = request_id
        return response
