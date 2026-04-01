"""Adaptive backpressure — reject requests fast when overloaded.

Tracks the number of in-flight requests. When the count exceeds
the configured threshold, new requests are immediately rejected
with HTTP 503 (Service Unavailable) + Retry-After header.

This prevents cascading failures: under extreme load, the system
sheds excess traffic instead of queuing it (which would increase
latency for ALL requests and eventually OOM).

Usage:
    app.add_middleware(BackpressureMiddleware, max_concurrent=200)

Design:
    - Atomic counter via asyncio (no lock needed on single event loop)
    - Zero overhead in normal operation (just increment/decrement)
    - Kicks in only when genuinely overloaded
    - Returns 503 + Retry-After header for client-side backoff
"""

from __future__ import annotations

from prometheus_client import Counter, Gauge
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

INFLIGHT = Gauge("tnt_inflight_requests", "Current in-flight requests")
SHED = Counter("tnt_requests_shed_total", "Requests shed due to backpressure")


class BackpressureMiddleware(BaseHTTPMiddleware):
    """Rejects requests when in-flight count exceeds threshold."""

    def __init__(self, app, max_concurrent: int = 200) -> None:  # type: ignore[override]
        super().__init__(app)
        self._max = max_concurrent
        self._inflight = 0

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        # Skip health/ready/metrics — always allow
        path = request.url.path
        if path in ("/api/v1/health", "/api/v1/ready", "/metrics"):
            return await call_next(request)

        if self._inflight >= self._max:
            SHED.inc()
            return JSONResponse(
                status_code=503,
                content={"detail": "Service overloaded — try again shortly"},
                headers={"Retry-After": "1"},
            )

        self._inflight += 1
        INFLIGHT.set(self._inflight)
        try:
            return await call_next(request)
        finally:
            self._inflight -= 1
            INFLIGHT.set(self._inflight)
