"""Tests for R4 production hardening.

Covers:
  - R5: Sandbox production guard (environment-aware safety)
  - R7: SecureBuffer memory protection for ReencryptWorker
  - Environment safety error hierarchy
"""

from __future__ import annotations

import pytest

from tnt_engine.config import Settings
from tnt_engine.crypto.sandbox import SandboxCryptoBackend
from tnt_engine.crypto.secure_memory import SecureBuffer, secure_plaintext
from tnt_engine.errors import EnvironmentSafetyError


# ── R5: Sandbox Production Guard ────────────────────────────────────


class TestSandboxGuard:
    def test_sandbox_allowed_in_development(self) -> None:
        backend = SandboxCryptoBackend(environment="development")
        assert backend is not None

    def test_sandbox_allowed_in_test(self) -> None:
        backend = SandboxCryptoBackend(environment="test")
        assert backend is not None

    def test_sandbox_blocked_in_production(self) -> None:
        with pytest.raises(EnvironmentSafetyError, match="production"):
            SandboxCryptoBackend(environment="production")

    def test_sandbox_blocked_in_staging(self) -> None:
        with pytest.raises(EnvironmentSafetyError, match="staging"):
            SandboxCryptoBackend(environment="staging")

    def test_sandbox_blocked_case_insensitive(self) -> None:
        with pytest.raises(EnvironmentSafetyError):
            SandboxCryptoBackend(environment="Production")

    def test_sandbox_default_is_development(self) -> None:
        backend = SandboxCryptoBackend()  # defaults to "development"
        assert backend is not None

    async def test_sandbox_still_works_in_dev(self) -> None:
        backend = SandboxCryptoBackend(environment="development")
        ct, ver = await backend.encrypt("test")
        assert ct.startswith("sandbox:v1:")
        pt = await backend.decrypt(ct, ver)
        assert pt == "test"


class TestFactoryGuard:
    async def test_factory_sandbox_in_dev(self) -> None:
        from tnt_engine.crypto.factory import create_crypto_backend
        cfg = Settings(crypto_backend="sandbox", environment="development")
        backend = await create_crypto_backend(cfg)
        assert isinstance(backend, SandboxCryptoBackend)

    async def test_factory_sandbox_blocked_in_prod(self) -> None:
        from tnt_engine.crypto.factory import create_crypto_backend
        cfg = Settings(crypto_backend="sandbox", environment="production")
        with pytest.raises(EnvironmentSafetyError):
            await create_crypto_backend(cfg)

    async def test_factory_sandbox_blocked_in_staging(self) -> None:
        from tnt_engine.crypto.factory import create_crypto_backend
        cfg = Settings(crypto_backend="sandbox", environment="staging")
        with pytest.raises(EnvironmentSafetyError):
            await create_crypto_backend(cfg)


# ── R7: SecureBuffer Memory Protection ──────────────────────────────


class TestSecureBuffer:
    def test_to_str(self) -> None:
        buf = SecureBuffer("hello world")
        assert buf.to_str() == "hello world"

    def test_clear_zeros_data(self) -> None:
        buf = SecureBuffer("sensitive data")
        buf.clear()
        assert buf.is_cleared
        assert all(b == 0 for b in buf._data)

    def test_to_str_after_clear_raises(self) -> None:
        buf = SecureBuffer("secret")
        buf.clear()
        with pytest.raises(ValueError, match="cleared"):
            buf.to_str()

    def test_double_clear_is_safe(self) -> None:
        buf = SecureBuffer("test")
        buf.clear()
        buf.clear()  # Should not raise
        assert buf.is_cleared

    def test_repr_shows_size_not_content(self) -> None:
        buf = SecureBuffer("secret-data")
        r = repr(buf)
        assert "secret-data" not in r
        assert "bytes" in r

    def test_repr_after_clear(self) -> None:
        buf = SecureBuffer("secret")
        buf.clear()
        assert "cleared" in repr(buf)

    def test_unicode_support(self) -> None:
        buf = SecureBuffer("日本語テスト")
        assert buf.to_str() == "日本語テスト"
        buf.clear()
        assert buf.is_cleared


class TestSecurePlaintextContext:
    async def test_context_provides_buffer(self) -> None:
        async with secure_plaintext("my secret") as buf:
            assert buf.to_str() == "my secret"
            assert not buf.is_cleared

    async def test_context_clears_on_exit(self) -> None:
        async with secure_plaintext("my secret") as buf:
            pass
        assert buf.is_cleared

    async def test_context_clears_on_exception(self) -> None:
        buf_ref = None
        with pytest.raises(RuntimeError):
            async with secure_plaintext("secret") as buf:
                buf_ref = buf
                raise RuntimeError("intentional")
        assert buf_ref.is_cleared

    async def test_encrypt_decrypt_pattern(self) -> None:
        """Simulate the ReencryptWorker pattern."""
        # Simulate decrypt
        plaintext = "sensitive-value"

        async with secure_plaintext(plaintext) as buf:
            # Simulate encrypt
            value = buf.to_str()
            assert value == "sensitive-value"

        # After context, buffer is zeroed
        assert buf.is_cleared


# ── Environment Config Tests ────────────────────────────────────────


class TestEnvironmentConfig:
    def test_default_environment(self) -> None:
        cfg = Settings()
        assert cfg.environment == "development"

    def test_environment_from_setting(self) -> None:
        cfg = Settings(environment="production")
        assert cfg.environment == "production"


# ── Error Type Tests ────────────────────────────────────────────────


class TestEnvironmentSafetyError:
    def test_error_properties(self) -> None:
        err = EnvironmentSafetyError("test message")
        assert err.code == "ENVIRONMENT_SAFETY_VIOLATION"
        assert "test message" in str(err)
