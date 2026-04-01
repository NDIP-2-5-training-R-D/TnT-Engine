"""FastAPI middleware for request-level metrics and trace propagation.

Emits:
  - tnt_http_requests_total (counter) — by method, endpoint, status
  - tnt_http_request_duration_seconds (histogram) — by method, endpoint

Also ensures a trace_id is set for every incoming request, either from
the X-Trace-ID header or generated fresh.
"""

from __future__ import annotations

import time

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from tnt_engine.metrics import REQUEST_COUNT, REQUEST_LATENCY
from tnt_engine.tracing import generate_trace_id, set_trace_id


class MetricsMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        # Propagate or generate trace_id
        trace_id = request.headers.get("x-trace-id") or generate_trace_id()
        set_trace_id(trace_id)

        method = request.method
        path = request.url.path

        t0 = time.monotonic()
        response = await call_next(request)
        elapsed = time.monotonic() - t0

        status = str(response.status_code)
        REQUEST_COUNT.labels(method=method, endpoint=path, status=status).inc()
        REQUEST_LATENCY.labels(method=method, endpoint=path).observe(elapsed)

        response.headers["X-Trace-ID"] = trace_id
        return response
