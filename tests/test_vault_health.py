"""Tests for OpenBao/Vault health checker.

Covers:
  - Healthy (200), Standby (429), Sealed (503), Uninitialized (501)
  - Unreachable (connection error)
  - is_operational property
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from tnt_engine.crypto.vault_health import VaultHealthChecker, VaultHealthResult, VaultStatus


class MockTransport(httpx.AsyncBaseTransport):
    def __init__(self, status_code: int, body: dict) -> None:
        self._status = status_code
        self._body = body

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        return httpx.Response(self._status, json=self._body)


class ErrorTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused")


class TestVaultHealthChecker:
    async def test_healthy(self) -> None:
        checker = VaultHealthChecker("http://localhost:8200")
        checker._client = httpx.AsyncClient(transport=MockTransport(200, {
            "initialized": True, "sealed": False, "version": "2.1.0",
            "cluster_name": "tnt-openbao",
        }))

        result = await checker.check()
        assert result.status == VaultStatus.HEALTHY
        assert result.initialized is True
        assert result.sealed is False
        assert result.version == "2.1.0"
        assert result.is_operational is True

    async def test_standby(self) -> None:
        checker = VaultHealthChecker("http://localhost:8200")
        checker._client = httpx.AsyncClient(transport=MockTransport(429, {
            "initialized": True, "sealed": False, "version": "2.1.0",
        }))

        result = await checker.check()
        assert result.status == VaultStatus.STANDBY
        assert result.is_operational is True

    async def test_sealed(self) -> None:
        checker = VaultHealthChecker("http://localhost:8200")
        checker._client = httpx.AsyncClient(transport=MockTransport(503, {
            "initialized": True, "sealed": True, "version": "2.1.0",
        }))

        result = await checker.check()
        assert result.status == VaultStatus.SEALED
        assert result.sealed is True
        assert result.is_operational is False

    async def test_uninitialized(self) -> None:
        checker = VaultHealthChecker("http://localhost:8200")
        checker._client = httpx.AsyncClient(transport=MockTransport(501, {
            "initialized": False, "sealed": True,
        }))

        result = await checker.check()
        assert result.status == VaultStatus.UNINITIALIZED
        assert result.is_operational is False

    async def test_unreachable(self) -> None:
        checker = VaultHealthChecker("http://localhost:8200")
        checker._client = httpx.AsyncClient(transport=ErrorTransport())

        result = await checker.check()
        assert result.status == VaultStatus.UNREACHABLE
        assert result.is_operational is False

    async def test_close(self) -> None:
        checker = VaultHealthChecker("http://localhost:8200")
        await checker.close()  # Should not raise


class TestVaultHealthResult:
    def test_healthy_is_operational(self) -> None:
        r = VaultHealthResult(status=VaultStatus.HEALTHY, initialized=True, sealed=False)
        assert r.is_operational is True

    def test_standby_is_operational(self) -> None:
        r = VaultHealthResult(status=VaultStatus.STANDBY, initialized=True, sealed=False)
        assert r.is_operational is True

    def test_sealed_not_operational(self) -> None:
        r = VaultHealthResult(status=VaultStatus.SEALED, initialized=True, sealed=True)
        assert r.is_operational is False

    def test_unreachable_not_operational(self) -> None:
        r = VaultHealthResult(status=VaultStatus.UNREACHABLE)
        assert r.is_operational is False
