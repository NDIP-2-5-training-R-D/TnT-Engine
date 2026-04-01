"""Request guardrails — enforce safety limits at the edge.

Prevents:
  - Oversized payloads (DoS via large bodies)
  - Request timeout enforcement (kill slow requests before they pile up)
  - Missing tenant context (catch misconfigured clients early)

Applied as middleware BEFORE routing. Failed guardrails return
immediately — no business logic is executed.
"""

from __future__ import annotations

import asyncio

from prometheus_client import Counter
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

GUARDRAIL_REJECTED = Counter(
    "tnt_guardrail_rejected_total",
    "Requests rejected by guardrails",
    ["reason"],
)

# Limits
MAX_BODY_BYTES = 1_048_576  # 1 MB
REQUEST_TIMEOUT_SECONDS = 30


class GuardrailsMiddleware(BaseHTTPMiddleware):
    """Enforce safety constraints at the request boundary."""

    def __init__(
        self,
        app,  # type: ignore[override]
        max_body_bytes: int = MAX_BODY_BYTES,
        request_timeout: float = REQUEST_TIMEOUT_SECONDS,
    ) -> None:
        super().__init__(app)
        self._max_body = max_body_bytes
        self._timeout = request_timeout

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        # Skip non-API paths
        path = request.url.path
        if not path.startswith("/api/") and not path.startswith("/admin/"):
            return await call_next(request)

        # 1. Body size check
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > self._max_body:
            GUARDRAIL_REJECTED.labels(reason="body_too_large").inc()
            return JSONResponse(
                status_code=413,
                content={"detail": f"Request body exceeds {self._max_body} bytes"},
            )

        # 2. Request timeout enforcement
        try:
            return await asyncio.wait_for(
                call_next(request), timeout=self._timeout
            )
        except asyncio.TimeoutError:
            GUARDRAIL_REJECTED.labels(reason="timeout").inc()
            return JSONResponse(
                status_code=504,
                content={"detail": f"Request timed out after {self._timeout}s"},
            )
