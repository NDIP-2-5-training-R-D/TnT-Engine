"""Tests for the HTTP Client SDK.

Uses httpx mock transport to simulate T&T Engine API responses.
Covers: tokenize, detokenize, batch ops, lifecycle, policy, health, errors.
"""

from __future__ import annotations

import json

import httpx
import pytest

from tnt_engine.sdk.http_client import (
    FieldResult,
    ServerAPIError,
    TNTHttpClient,
    TokenInactiveAPIError,
    TokenNotFoundAPIError,
    TokenizeResult,
    ValidationAPIError,
)


# ── Mock Transport ──────────────────────────────────────────────────


class MockTransport(httpx.AsyncBaseTransport):
    """Simulates T&T Engine API responses for SDK testing."""

    def __init__(self) -> None:
        self.last_request: httpx.Request | None = None
        self.routes: dict[str, tuple[int, dict]] = {}

    def add_route(self, path: str, status: int, body: dict) -> None:
        self.routes[path] = (status, body)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.last_request = request
        path = request.url.path

        if path in self.routes:
            status, body = self.routes[path]
            return httpx.Response(status, json=body)

        # Default routes
        if path.endswith("/tokenize") and not path.endswith("/batch"):
            return httpx.Response(200, json={
                "token": "tok_abc123def456ghi789jkl",
                "field": "ssn",
                "cached": False,
            })
        elif path.endswith("/tokenize/batch"):
            req_body = json.loads(request.content)
            results = [
                {"token": f"tok_batch_{i:020d}", "field": it["field"], "cached": False}
                for i, it in enumerate(req_body["items"])
            ]
            return httpx.Response(200, json={"results": results})
        elif path.endswith("/detokenize") and not path.endswith("/batch"):
            return httpx.Response(200, json={"value": "123-45-6789"})
        elif path.endswith("/detokenize/batch"):
            req_body = json.loads(request.content)
            results = [{"value": f"value-{i}"} for i in range(len(req_body["tokens"]))]
            return httpx.Response(200, json={"results": results})
        elif path.endswith("/token/revoke"):
            return httpx.Response(200, json={"status": "revoked"})
        elif path.endswith("/token/delete"):
            return httpx.Response(200, json={"status": "deleted"})
        elif path.endswith("/process/field"):
            return httpx.Response(200, json={
                "field": "ssn", "action": "TOKENIZE", "value": "tok_xxx",
            })
        elif path.endswith("/process/record"):
            return httpx.Response(200, json={
                "ssn": {"action": "TOKENIZE", "value": "tok_xxx"},
                "email": {"action": "MASK", "value": "j***@acme.com"},
            })
        elif path.endswith("/health"):
            return httpx.Response(200, json={"status": "ok"})
        elif path.endswith("/ready"):
            return httpx.Response(200, json={"ready": True})

        return httpx.Response(404, json={"detail": "Not found"})


@pytest.fixture
def transport() -> MockTransport:
    return MockTransport()


@pytest.fixture
def client(transport: MockTransport) -> TNTHttpClient:
    c = TNTHttpClient(base_url="http://test:8000")
    c._client = httpx.AsyncClient(transport=transport)
    return c


# ── Tokenize Tests ──────────────────────────────────────────────────


class TestTokenize:
    async def test_tokenize_single(self, client: TNTHttpClient) -> None:
        result = await client.tokenize("123-45-6789", field="ssn", tenant_id="acme")
        assert isinstance(result, TokenizeResult)
        assert result.token.startswith("tok_")
        assert result.field == "ssn"

    async def test_tokenize_with_trace_id(
        self, client: TNTHttpClient, transport: MockTransport
    ) -> None:
        await client.tokenize("test", field="ssn", tenant_id="acme", trace_id="trace-123")
        assert transport.last_request is not None
        assert transport.last_request.headers["x-trace-id"] == "trace-123"

    async def test_tokenize_auto_trace_id(
        self, client: TNTHttpClient, transport: MockTransport
    ) -> None:
        await client.tokenize("test", field="ssn", tenant_id="acme")
        assert "x-trace-id" in transport.last_request.headers

    async def test_batch_tokenize(self, client: TNTHttpClient) -> None:
        results = await client.batch_tokenize(
            [{"value": "111-11-1111", "field": "ssn"},
             {"value": "john@test.com", "field": "email"}],
            tenant_id="acme",
        )
        assert len(results) == 2
        assert all(isinstance(r, TokenizeResult) for r in results)


# ── Detokenize Tests ────────────────────────────────────────────────


class TestDetokenize:
    async def test_detokenize_single(self, client: TNTHttpClient) -> None:
        value = await client.detokenize("tok_abc123def456ghi789jkl", tenant_id="acme")
        assert value == "123-45-6789"

    async def test_batch_detokenize(self, client: TNTHttpClient) -> None:
        values = await client.batch_detokenize(
            ["tok_a", "tok_b"], tenant_id="acme"
        )
        assert len(values) == 2


# ── Lifecycle Tests ─────────────────────────────────────────────────


class TestLifecycle:
    async def test_revoke(self, client: TNTHttpClient) -> None:
        await client.revoke("tok_abc123def456ghi789jkl", tenant_id="acme")

    async def test_delete(self, client: TNTHttpClient) -> None:
        await client.delete("tok_abc123def456ghi789jkl", tenant_id="acme")


# ── Policy Tests ────────────────────────────────────────────────────


class TestPolicy:
    async def test_process_field(self, client: TNTHttpClient) -> None:
        result = await client.process_field(
            policy={"field": "ssn", "action": "TOKENIZE"},
            value="123-45-6789",
            tenant_id="acme",
        )
        assert isinstance(result, FieldResult)
        assert result.action == "TOKENIZE"

    async def test_process_record(self, client: TNTHttpClient) -> None:
        results = await client.process_record(
            policies=[
                {"field": "ssn", "action": "TOKENIZE"},
                {"field": "email", "action": "MASK"},
            ],
            values={"ssn": "123-45-6789", "email": "john@acme.com"},
            tenant_id="acme",
        )
        assert "ssn" in results
        assert "email" in results
        assert results["email"].value == "j***@acme.com"


# ── Health Tests ────────────────────────────────────────────────────


class TestHealth:
    async def test_health(self, client: TNTHttpClient) -> None:
        result = await client.health()
        assert result["status"] == "ok"

    async def test_ready(self, client: TNTHttpClient) -> None:
        ready = await client.ready()
        assert ready is True


# ── Error Tests ─────────────────────────────────────────────────────


class TestErrors:
    async def test_404_raises_not_found(
        self, transport: MockTransport
    ) -> None:
        transport.add_route("/api/v1/detokenize", 404, {"detail": "Token not found"})
        client = TNTHttpClient(base_url="http://test:8000")
        client._client = httpx.AsyncClient(transport=transport)

        with pytest.raises(TokenNotFoundAPIError) as exc_info:
            await client.detokenize("tok_missing", tenant_id="acme")
        assert exc_info.value.status_code == 404

    async def test_410_raises_inactive(
        self, transport: MockTransport
    ) -> None:
        transport.add_route("/api/v1/detokenize", 410, {"detail": "Token revoked"})
        client = TNTHttpClient(base_url="http://test:8000")
        client._client = httpx.AsyncClient(transport=transport)

        with pytest.raises(TokenInactiveAPIError):
            await client.detokenize("tok_revoked", tenant_id="acme")

    async def test_400_raises_validation(
        self, transport: MockTransport
    ) -> None:
        transport.add_route("/api/v1/tokenize", 400, {"detail": "Invalid input"})
        client = TNTHttpClient(base_url="http://test:8000")
        client._client = httpx.AsyncClient(transport=transport)

        with pytest.raises(ValidationAPIError):
            await client.tokenize("", field="ssn", tenant_id="acme")

    async def test_500_raises_server_error(
        self, transport: MockTransport
    ) -> None:
        transport.add_route("/api/v1/tokenize", 500, {})
        client = TNTHttpClient(base_url="http://test:8000")
        client._client = httpx.AsyncClient(transport=transport)

        with pytest.raises(ServerAPIError):
            await client.tokenize("test", field="ssn", tenant_id="acme")

    async def test_context_manager(self) -> None:
        async with TNTHttpClient(base_url="http://test:8000") as client:
            assert client is not None
