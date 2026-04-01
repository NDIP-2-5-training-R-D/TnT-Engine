"""T&T Engine HTTP Client SDK — cross-service integration via REST API.

Unlike the in-process TNTClient (which requires direct module imports),
this client communicates with the T&T Engine over HTTP. It is designed
for use by external microservices that need tokenization capabilities.

Features:
  - Async HTTP client (httpx-based)
  - Automatic OpenBao/Vault token management (optional)
  - Retry with exponential backoff on transient failures
  - Request tracing (X-Trace-ID propagation)
  - Structured error handling (TNTAPIError hierarchy)
  - Batch operations support
  - Configurable timeouts and connection pooling

Usage:
    from tnt_engine.sdk.http_client import TNTHttpClient

    async with TNTHttpClient(base_url="http://tnt-engine:8000") as client:
        # Tokenize
        resp = await client.tokenize("123-45-6789", field="ssn", tenant_id="acme")
        print(resp.token)

        # Detokenize
        value = await client.detokenize(resp.token, tenant_id="acme")

        # Batch
        tokens = await client.batch_tokenize([
            {"value": "123-45-6789", "field": "ssn"},
            {"value": "john@acme.com", "field": "email"},
        ], tenant_id="acme")

        # Policy processing
        result = await client.process_field(
            policy={"field": "ssn", "action": "TOKENIZE"},
            value="123-45-6789",
            tenant_id="acme",
        )
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from typing import Any

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)


# ── Response Models ─────────────────────────────────────────────────


@dataclass(frozen=True)
class TokenizeResult:
    """Result of a tokenize operation."""
    token: str
    field: str
    cached: bool = False


@dataclass(frozen=True)
class FieldResult:
    """Result of a policy field processing operation."""
    field: str
    action: str
    value: str


# ── Errors ──────────────────────────────────────────────────────────


class TNTAPIError(Exception):
    """Base error for T&T Engine API calls."""

    def __init__(self, status_code: int, detail: str, code: str = "") -> None:
        self.status_code = status_code
        self.detail = detail
        self.code = code
        super().__init__(f"[{status_code}] {detail}")


class TokenNotFoundAPIError(TNTAPIError):
    """Token was not found."""
    pass


class TokenInactiveAPIError(TNTAPIError):
    """Token is revoked or expired."""
    pass


class ValidationAPIError(TNTAPIError):
    """Request validation failed."""
    pass


class ServerAPIError(TNTAPIError):
    """Server-side error."""
    pass


# ── Client ──────────────────────────────────────────────────────────


class TNTHttpClient:
    """HTTP client for the T&T Engine REST API.

    Supports async context manager for automatic resource cleanup.

    Args:
        base_url: T&T Engine API base URL (e.g., "http://tnt-engine:8000")
        api_prefix: API version prefix (default: "/api/v1")
        timeout: Request timeout in seconds
        max_retries: Maximum retry attempts for transient errors
        headers: Additional headers for all requests
    """

    def __init__(
        self,
        base_url: str,
        api_prefix: str = "/api/v1",
        timeout: float = 10.0,
        max_retries: int = 3,
        headers: dict[str, str] | None = None,
    ) -> None:
        self._base = base_url.rstrip("/") + api_prefix
        self._max_retries = max_retries
        default_headers = {"Content-Type": "application/json"}
        if headers:
            default_headers.update(headers)
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout),
            headers=default_headers,
        )

    async def __aenter__(self) -> TNTHttpClient:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    async def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        await self._client.aclose()

    # ── Tokenize ────────────────────────────────────────────────────

    async def tokenize(
        self,
        value: str,
        field: str,
        tenant_id: str,
        ttl_seconds: int | None = None,
        trace_id: str | None = None,
    ) -> TokenizeResult:
        """Tokenize a single value."""
        payload: dict[str, Any] = {
            "value": value,
            "field": field,
            "tenant_id": tenant_id,
        }
        if ttl_seconds is not None:
            payload["ttl_seconds"] = ttl_seconds

        data = await self._post("/tokenize", payload, trace_id=trace_id)
        return TokenizeResult(
            token=data["token"],
            field=data["field"],
            cached=data.get("cached", False),
        )

    async def batch_tokenize(
        self,
        items: list[dict[str, str]],
        tenant_id: str,
        trace_id: str | None = None,
    ) -> list[TokenizeResult]:
        """Tokenize multiple values in a single request.

        Each item should have "value" and "field" keys.
        """
        payload = {
            "items": [
                {"value": it["value"], "field": it["field"], "tenant_id": tenant_id}
                for it in items
            ]
        }
        data = await self._post("/tokenize/batch", payload, trace_id=trace_id)
        return [
            TokenizeResult(token=r["token"], field=r["field"], cached=r.get("cached", False))
            for r in data["results"]
        ]

    # ── Detokenize ──────────────────────────────────────────────────

    async def detokenize(
        self,
        token: str,
        tenant_id: str,
        trace_id: str | None = None,
    ) -> str:
        """Detokenize a single token. Returns the original value."""
        data = await self._post(
            "/detokenize",
            {"token": token, "tenant_id": tenant_id},
            trace_id=trace_id,
        )
        return data["value"]

    async def batch_detokenize(
        self,
        tokens: list[str],
        tenant_id: str,
        trace_id: str | None = None,
    ) -> list[str]:
        """Detokenize multiple tokens in a single request."""
        data = await self._post(
            "/detokenize/batch",
            {"tokens": tokens, "tenant_id": tenant_id},
            trace_id=trace_id,
        )
        return [r["value"] for r in data["results"]]

    # ── Lifecycle ───────────────────────────────────────────────────

    async def revoke(
        self, token: str, tenant_id: str, trace_id: str | None = None
    ) -> None:
        """Revoke a token (soft delete — cannot be detokenized)."""
        await self._post(
            "/token/revoke",
            {"token": token, "tenant_id": tenant_id},
            trace_id=trace_id,
        )

    async def delete(
        self, token: str, tenant_id: str, trace_id: str | None = None
    ) -> None:
        """Hard delete a token (GDPR compliance)."""
        await self._post(
            "/token/delete",
            {"token": token, "tenant_id": tenant_id},
            trace_id=trace_id,
        )

    # ── Policy Processing ───────────────────────────────────────────

    async def process_field(
        self,
        policy: dict[str, str],
        value: str,
        tenant_id: str,
        trace_id: str | None = None,
    ) -> FieldResult:
        """Process a single field according to a policy."""
        data = await self._post(
            "/process/field",
            {"policy": policy, "value": value, "tenant_id": tenant_id},
            trace_id=trace_id,
        )
        return FieldResult(field=data["field"], action=data["action"], value=data["value"])

    async def process_record(
        self,
        policies: list[dict[str, str]],
        values: dict[str, str],
        tenant_id: str,
        trace_id: str | None = None,
    ) -> dict[str, FieldResult]:
        """Process all fields in a record according to policies."""
        data = await self._post(
            "/process/record",
            {"policies": policies, "values": values, "tenant_id": tenant_id},
            trace_id=trace_id,
        )
        return {
            field: FieldResult(field=field, action=r["action"], value=r["value"])
            for field, r in data.items()
        }

    # ── Health ──────────────────────────────────────────────────────

    async def health(self) -> dict:
        """Check T&T Engine health status."""
        resp = await self._client.get(f"{self._base}/health")
        resp.raise_for_status()
        return resp.json()

    async def ready(self) -> bool:
        """Check if the T&T Engine is ready to accept traffic."""
        try:
            resp = await self._client.get(f"{self._base}/ready")
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    # ── Internals ───────────────────────────────────────────────────

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=0.1, max=2),
        retry=retry_if_exception_type((httpx.TransportError, httpx.TimeoutException)),
        reraise=True,
    )
    async def _post(
        self, path: str, payload: dict, trace_id: str | None = None
    ) -> dict:
        headers = {}
        if trace_id:
            headers["X-Trace-ID"] = trace_id
        else:
            headers["X-Trace-ID"] = secrets.token_hex(16)

        url = f"{self._base}{path}"
        resp = await self._client.post(url, json=payload, headers=headers)

        if resp.status_code == 404:
            body = resp.json() if resp.content else {}
            raise TokenNotFoundAPIError(404, body.get("detail", "Not found"))
        elif resp.status_code == 410:
            body = resp.json() if resp.content else {}
            raise TokenInactiveAPIError(410, body.get("detail", "Token inactive"))
        elif resp.status_code == 400:
            body = resp.json() if resp.content else {}
            raise ValidationAPIError(400, body.get("detail", "Validation error"))
        elif resp.status_code >= 500:
            raise ServerAPIError(resp.status_code, f"Server error: {resp.text[:200]}")

        resp.raise_for_status()
        return resp.json()
