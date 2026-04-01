"""Unit tests for the circuit breaker."""

from __future__ import annotations

import asyncio

import pytest

from tnt_engine.crypto.circuit_breaker import CircuitBreakerBackend
from tnt_engine.errors import CryptoServiceUnavailableError, EncryptionError
from tests.conftest import FakeCryptoBackend


class FailingBackend(FakeCryptoBackend):
    def __init__(self) -> None:
        super().__init__()
        self.should_fail = False

    async def hmac(self, plaintext: str, key_name: str | None = None) -> str:
        if self.should_fail:
            raise EncryptionError("hmac", "simulated")
        return await super().hmac(plaintext, key_name)


class TestCircuitBreaker:
    @pytest.fixture
    def backend(self) -> FailingBackend:
        return FailingBackend()

    @pytest.fixture
    def cb(self, backend: FailingBackend) -> CircuitBreakerBackend:
        return CircuitBreakerBackend(backend, failure_threshold=3, recovery_timeout=0.1)

    async def test_closed_passes(self, cb: CircuitBreakerBackend) -> None:
        assert await cb.hmac("test")
        assert cb.state == "CLOSED"

    async def test_opens_after_threshold(
        self, cb: CircuitBreakerBackend, backend: FailingBackend
    ) -> None:
        backend.should_fail = True
        for _ in range(3):
            with pytest.raises(EncryptionError):
                await cb.hmac("test")
        assert cb.state == "OPEN"
        with pytest.raises(CryptoServiceUnavailableError):
            await cb.hmac("test")

    async def test_half_open_recovery(self, backend: FailingBackend) -> None:
        cb = CircuitBreakerBackend(backend, failure_threshold=1, recovery_timeout=0.01)
        backend.should_fail = True
        with pytest.raises(EncryptionError):
            await cb.hmac("test")
        assert cb.state == "OPEN"
        await asyncio.sleep(0.02)
        backend.should_fail = False
        assert await cb.hmac("test")
        assert cb.state == "CLOSED"

    async def test_half_open_reopen(self, backend: FailingBackend) -> None:
        cb = CircuitBreakerBackend(backend, failure_threshold=1, recovery_timeout=0.01)
        backend.should_fail = True
        with pytest.raises(EncryptionError):
            await cb.hmac("test")
        await asyncio.sleep(0.02)
        with pytest.raises(EncryptionError):
            await cb.hmac("test")
        assert cb.state == "OPEN"
