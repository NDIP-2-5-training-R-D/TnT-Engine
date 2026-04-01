"""Integration tests for TT Crypto Adapter.

Requires the full docker-compose stack to be running:

    docker-compose up -d

Then run with:

    pytest -m integration tests/test_integration.py -v

Environment variables expected:
    INTEGRATION_BASE_URL  (default: http://localhost:8300)
"""
import io
import json
import logging
import os
import time

import httpx
import pytest
import pytest_asyncio

BASE_URL = os.getenv("INTEGRATION_BASE_URL", "http://localhost:8300")


# ---------------------------------------------------------------------------
# Client fixture
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def client():
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=10.0) as c:
        yield c


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _assert_error_schema(body: dict) -> None:
    """Assert the response body conforms to ErrorResponse."""
    assert "error_code" in body, f"Missing error_code in {body}"
    assert "message" in body, f"Missing message in {body}"
    assert "request_id" in body, f"Missing request_id in {body}"
    assert "timestamp" in body, f"Missing timestamp in {body}"


# ---------------------------------------------------------------------------
# Task 1 — full HMAC flow
# ---------------------------------------------------------------------------


@pytest.mark.integration
@pytest.mark.asyncio
async def test_full_hmac_flow(client: httpx.AsyncClient):
    resp = await client.post(
        "/internal/crypto",
        json={"operation": "hmac", "input": "hello"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["operation"] == "hmac"
    assert body["output"].startswith("vault:v1:hmac-sha512:")
    assert body["key_name"]
    assert body["request_id"]
    # X-Request-ID must be present in response headers
    assert "x-request-id" in resp.headers


# ---------------------------------------------------------------------------
# Task 2 — HMAC is deterministic
# ---------------------------------------------------------------------------


@pytest.mark.integration
@pytest.mark.asyncio
async def test_hmac_deterministic(client: httpx.AsyncClient):
    results = []
    for _ in range(10):
        resp = await client.post(
            "/internal/crypto",
            json={"operation": "hmac", "input": "determinism-test"},
        )
        assert resp.status_code == 200, resp.text
        results.append(resp.json()["output"])

    assert len(set(results)) == 1, f"HMAC not deterministic: {set(results)}"


# ---------------------------------------------------------------------------
# Task 3 — encrypt / decrypt round-trip
# ---------------------------------------------------------------------------


@pytest.mark.integration
@pytest.mark.asyncio
async def test_encrypt_decrypt_roundtrip(client: httpx.AsyncClient):
    original = "super-secret-payload"

    enc_resp = await client.post(
        "/internal/crypto",
        json={"operation": "encrypt", "input": original},
    )
    assert enc_resp.status_code == 200, enc_resp.text
    ciphertext = enc_resp.json()["output"]
    assert ciphertext.startswith("vault:")

    dec_resp = await client.post(
        "/internal/crypto",
        json={"operation": "decrypt", "input": ciphertext},
    )
    assert dec_resp.status_code == 200, dec_resp.text
    assert dec_resp.json()["output"] == original


# ---------------------------------------------------------------------------
# Task 4 — tokenize / detokenize round-trip
# ---------------------------------------------------------------------------


@pytest.mark.integration
@pytest.mark.asyncio
async def test_tokenize_detokenize_roundtrip(client: httpx.AsyncClient):
    original = "PAN:4111111111111111"

    tok_resp = await client.post(
        "/internal/crypto",
        json={"operation": "tokenize", "input": original},
    )
    assert tok_resp.status_code == 200, tok_resp.text
    token = tok_resp.json()["output"]
    assert token.startswith("tt1_"), f"Expected tt1_ prefix, got: {token}"

    detok_resp = await client.post(
        "/internal/crypto",
        json={"operation": "detokenize", "input": token},
    )
    assert detok_resp.status_code == 200, detok_resp.text
    assert detok_resp.json()["output"] == original


# ---------------------------------------------------------------------------
# Task 5 — batch with mixed operations
# ---------------------------------------------------------------------------


@pytest.mark.integration
@pytest.mark.asyncio
async def test_batch_mixed_operations(client: httpx.AsyncClient):
    items = [
        {"operation": "hmac", "input": "batch-item-0"},
        {"operation": "tokenize", "input": "batch-sensitive-0"},
        {"operation": "encrypt", "input": "batch-plain-0"},
        {"operation": "hmac", "input": "batch-item-1"},
        {"operation": "tokenize", "input": "batch-sensitive-1"},
    ]

    t0 = time.perf_counter()
    resp = await client.post("/internal/crypto/batch", json={"items": items})
    elapsed_s = time.perf_counter() - t0

    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["total"] == 5
    assert body["success_count"] == 5
    assert body["error_count"] == 0
    assert elapsed_s < 5.0, f"Batch took too long: {elapsed_s:.2f}s"

    results = body["results"]
    assert results[0]["output"].startswith("vault:v1:hmac-sha512:")
    assert results[1]["output"].startswith("tt1_")
    assert results[2]["output"].startswith("vault:")


@pytest.mark.integration
@pytest.mark.asyncio
async def test_batch_100_mixed_ops_under_2s(client: httpx.AsyncClient):
    """Acceptance criterion: 100 mixed ops complete in < 2 s."""
    items = [
        {"operation": "hmac" if i % 2 == 0 else "encrypt", "input": f"item-{i}"}
        for i in range(100)
    ]

    t0 = time.perf_counter()
    resp = await client.post("/internal/crypto/batch", json={"items": items})
    elapsed_s = time.perf_counter() - t0

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success_count"] == 100
    assert elapsed_s < 2.0, f"100 ops took {elapsed_s:.2f}s — exceeds 2s limit"


# ---------------------------------------------------------------------------
# Task 6 — circuit breaker returns CIRCUIT_OPEN error code
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_circuit_breaker_integration():
    """Verify that a service pointed at an unreachable OpenBao returns
    503 with error_code CIRCUIT_OPEN after the breaker trips.

    This test spins up a temporary in-process FastAPI app (no network
    required for OpenBao) and forces the circuit breaker open by injecting
    a failing client.
    """
    from unittest.mock import AsyncMock

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from crypto_adapter.auth.exceptions import (
        CircuitBreakerOpenError,
        OpenBaoUnavailableError,
    )
    from crypto_adapter.client.resilience import CircuitBreaker
    from crypto_adapter.middleware import register_exception_handlers
    from crypto_adapter.routers.internal import router as internal_router

    # Build a minimal isolated app
    test_app = FastAPI()
    register_exception_handlers(test_app)

    # Inject a broken client that immediately trips the circuit breaker
    broken_client = AsyncMock()
    broken_client.hmac.side_effect = CircuitBreakerOpenError(
        "Circuit breaker is OPEN"
    )

    async def _broken_client():
        return broken_client

    from fastapi import Depends
    from crypto_adapter.routers import internal as _internal_mod

    # Temporarily override the client dependency
    test_app.include_router(internal_router)
    test_app.dependency_overrides[_internal_mod._get_client] = _broken_client

    with TestClient(test_app, raise_server_exceptions=False) as tc:
        resp = tc.post(
            "/internal/crypto",
            json={"operation": "hmac", "input": "test"},
        )

    assert resp.status_code == 503, resp.text
    body = resp.json()
    _assert_error_schema(body)
    assert body["error_code"] == "CIRCUIT_OPEN"


# ---------------------------------------------------------------------------
# Task 7 — audit log contains NO sensitive data
# ---------------------------------------------------------------------------


def test_audit_log_no_sensitive_data():
    """Verify the audit log emits structured JSON that contains ZERO sensitive
    data (input values, HMAC outputs, plaintext, ciphertext, tokens).

    The audit middleware runs in the same process as the request handler, so
    we use an in-process FastAPI TestClient to capture log output directly.
    This approach is reliable regardless of whether docker-compose is running.
    """
    from unittest.mock import AsyncMock

    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from pythonjsonlogger.json import JsonFormatter as _JsonFormatter

    from crypto_adapter.middleware import AuditLogMiddleware, register_exception_handlers
    from crypto_adapter.routers import internal as _internal_mod
    from crypto_adapter.routers.internal import router as internal_router

    fake_hmac = "vault:v1:hmac-sha512:FAKE_HMAC_OUTPUT_DO_NOT_LOG"
    mock_client = AsyncMock()
    mock_client.hmac.return_value = fake_hmac

    isolated_app = FastAPI()
    register_exception_handlers(isolated_app)
    isolated_app.add_middleware(AuditLogMiddleware)
    isolated_app.include_router(internal_router)
    isolated_app.dependency_overrides[_internal_mod._get_client] = (
        lambda: mock_client
    )

    # Attach a JSON-formatted handler to the audit logger so we can inspect output
    audit_logger = logging.getLogger("crypto_adapter.audit")
    json_stream = io.StringIO()
    json_handler = logging.StreamHandler(json_stream)
    json_handler.setFormatter(_JsonFormatter())
    audit_logger.addHandler(json_handler)

    sensitive_input = "sensitive-value-12345"
    try:
        with TestClient(isolated_app, raise_server_exceptions=False) as tc:
            resp = tc.post(
                "/internal/crypto",
                json={"operation": "hmac", "input": sensitive_input},
            )
    finally:
        audit_logger.removeHandler(json_handler)

    assert resp.status_code == 200, resp.text
    log_output = json_stream.getvalue()

    # Log must have produced output
    assert log_output.strip(), "Audit log produced no output"

    # Parse the JSON record to inspect fields precisely
    import json as _json
    log_record = _json.loads(log_output.strip())

    # Sensitive fields must NOT appear anywhere in the raw log text
    assert sensitive_input not in log_output, "Plaintext input leaked into audit log"
    assert fake_hmac not in log_output, "HMAC output leaked into audit log"

    # Structural checks: expected metadata fields must be present
    assert log_record.get("operation") == "hmac"
    assert log_record.get("success") is True
    assert log_record.get("path") == "/internal/crypto"
    assert "request_id" in log_record

    # Sensitive field names must not appear as log record keys
    forbidden_keys = {"input", "output", "plaintext", "ciphertext", "token", "hmac"}
    leaked = forbidden_keys & set(log_record.keys())
    assert not leaked, f"Sensitive keys leaked into audit record: {leaked}"


# ---------------------------------------------------------------------------
# Task 8 — all error responses follow ErrorResponse schema
# ---------------------------------------------------------------------------


@pytest.mark.integration
@pytest.mark.asyncio
async def test_error_response_schema_on_invalid_input(client: httpx.AsyncClient):
    resp = await client.post(
        "/internal/crypto",
        json={"operation": "decrypt", "input": "not-a-valid-ciphertext"},
    )
    # Should fail with a 4xx or 5xx
    assert resp.status_code >= 400, "Expected error for invalid ciphertext"
    _assert_error_schema(resp.json())
    assert "x-request-id" in resp.headers


@pytest.mark.integration
@pytest.mark.asyncio
async def test_x_request_id_propagated_on_success(client: httpx.AsyncClient):
    custom_id = "test-req-abc-123"
    resp = await client.post(
        "/internal/crypto",
        json={"operation": "hmac", "input": "hello"},
        headers={"X-Request-ID": custom_id},
    )
    assert resp.status_code == 200
    assert resp.headers.get("x-request-id") == custom_id


@pytest.mark.integration
@pytest.mark.asyncio
async def test_batch_rejects_over_500_items(client: httpx.AsyncClient):
    items = [{"operation": "hmac", "input": str(i)} for i in range(501)]
    resp = await client.post("/internal/crypto/batch", json={"items": items})
    assert resp.status_code in (400, 422), resp.text
