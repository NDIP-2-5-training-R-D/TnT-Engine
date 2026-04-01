"""Tests for chaos testing hooks."""

from __future__ import annotations

import pytest

from tnt_engine.testing.chaos import ChaosError, ChaosProxy, FaultConfig
from tests.conftest import FakeCryptoBackend


class TestChaosProxy:
    async def test_no_faults_passes_through(self) -> None:
        backend = FakeCryptoBackend()
        proxy = ChaosProxy(backend, FaultConfig())
        result = await proxy.hmac("test")
        assert result  # valid HMAC

    async def test_total_failure(self) -> None:
        backend = FakeCryptoBackend()
        proxy = ChaosProxy(backend, FaultConfig(total_failure=True))
        with pytest.raises(ChaosError, match="Total failure"):
            await proxy.hmac("test")

    async def test_error_rate_100_percent(self) -> None:
        backend = FakeCryptoBackend()
        proxy = ChaosProxy(backend, FaultConfig(error_rate=1.0))
        with pytest.raises(ChaosError):
            await proxy.hmac("test")

    async def test_error_rate_zero_passes(self) -> None:
        backend = FakeCryptoBackend()
        proxy = ChaosProxy(backend, FaultConfig(error_rate=0.0))
        result = await proxy.hmac("test")
        assert result

    async def test_latency_injection(self) -> None:
        import time

        backend = FakeCryptoBackend()
        proxy = ChaosProxy(backend, FaultConfig(latency_ms=50))

        t0 = time.monotonic()
        await proxy.hmac("test")
        elapsed_ms = (time.monotonic() - t0) * 1000

        assert elapsed_ms >= 40  # Allow some margin

    async def test_config_can_be_changed(self) -> None:
        backend = FakeCryptoBackend()
        proxy = ChaosProxy(backend, FaultConfig())

        # Works normally
        await proxy.hmac("test")

        # Flip to total failure
        proxy.config = FaultConfig(total_failure=True)
        with pytest.raises(ChaosError):
            await proxy.hmac("test")

        # Flip back
        proxy.config = FaultConfig()
        await proxy.hmac("test")  # works again

    async def test_encrypt_and_decrypt_proxied(self) -> None:
        backend = FakeCryptoBackend()
        proxy = ChaosProxy(backend, FaultConfig())
        ciphertext, version = await proxy.encrypt("hello")
        plaintext = await proxy.decrypt(ciphertext, version)
        assert plaintext == "hello"
