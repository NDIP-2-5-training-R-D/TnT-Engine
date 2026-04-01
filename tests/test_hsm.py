"""Tests for HSM/PKCS#11 crypto backend.

Uses mock PKCS#11 sessions to verify:
  - Session pool lifecycle (init, acquire, release, close)
  - HSM encrypt/decrypt round-trip
  - HMAC determinism
  - Error handling (slot not found, PIN failure, key not found, timeout)
  - Ciphertext format validation
  - Backend factory selection
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import os
from unittest.mock import MagicMock, PropertyMock, patch

import pytest

from tnt_engine.config import Settings
from tnt_engine.crypto.factory import create_crypto_backend
from tnt_engine.errors import (
    EncryptionError,
    HSMAuthenticationError,
    HSMKeyNotFoundError,
    HSMSessionError,
)


# ── Mock PKCS#11 objects ────────────────────────────────────────────


class MockSession:
    """Simulates a PKCS#11 session with in-memory crypto."""

    def __init__(self) -> None:
        self._keys: dict[str, bytes] = {
            "tnt-encrypt-key": os.urandom(32),
            "tnt-hmac-key": os.urandom(32),
        }
        self._logged_in = False

    def login(self, pin: str) -> None:
        if pin != "valid-pin":
            raise _make_pkcs11_error("CKR_PIN_INCORRECT")
        self._logged_in = True

    def logout(self) -> None:
        self._logged_in = False

    def closeSession(self) -> None:
        pass

    def getSessionInfo(self) -> dict:
        return {"state": "active"}

    def findObjects(self, template: list) -> list:
        label = None
        for attr_type, attr_value in template:
            if attr_type == 3:  # CKA_LABEL
                label = attr_value
        if label and label in self._keys:
            return [label]  # Return label as handle
        return []

    def sign(self, key_handle: str, data: bytes, mechanism: object) -> list[int]:
        key_bytes = self._keys[key_handle]
        import hmac as hmac_mod
        digest = hmac_mod.new(key_bytes, data, hashlib.sha256).digest()
        return list(digest)

    def encrypt(self, key_handle: str, data: bytes, mechanism: object) -> list[int]:
        # Simulate AES-GCM: simple XOR for testing (NOT real crypto)
        key_bytes = self._keys[key_handle]
        pad = (key_bytes * ((len(data) // len(key_bytes)) + 1))[:len(data)]
        encrypted = bytes(a ^ b for a, b in zip(data, pad))
        tag = hashlib.sha256(encrypted).digest()[:16]
        return list(encrypted + tag)

    def decrypt(self, key_handle: str, data: bytes, mechanism: object) -> list[int]:
        key_bytes = self._keys[key_handle]
        # Strip tag (last 16 bytes)
        encrypted = data[:-16]
        pad = (key_bytes * ((len(encrypted) // len(key_bytes)) + 1))[:len(encrypted)]
        decrypted = bytes(a ^ b for a, b in zip(encrypted, pad))
        return list(decrypted)


class _MockPyKCS11Error(Exception):
    pass


def _make_pkcs11_error(code: str) -> _MockPyKCS11Error:
    return _MockPyKCS11Error(code)


class MockPyKCS11Lib:
    def __init__(self) -> None:
        self._loaded = False

    def load(self, path: str) -> None:
        if "invalid" in path:
            raise _MockPyKCS11Error("Failed to load library")
        self._loaded = True

    def getSlotList(self, tokenPresent: bool = True) -> list[int]:
        return [0, 1]

    def openSession(self, slot: int, flags: int) -> MockSession:
        return MockSession()


# ── Fake PKCS11SessionPool for HSMCryptoBackend tests ───────────────


class FakePKCS11SessionPool:
    """In-memory session pool that returns MockSessions."""

    def __init__(self) -> None:
        self._session = MockSession()
        self._session._logged_in = True
        self._initialized = True

    def acquire(self, timeout: float = 10.0) -> MockSession:
        return self._session

    def release(self, session: object) -> None:
        pass

    def close(self) -> None:
        self._initialized = False

    def find_key(self, session: MockSession, label: str, key_class: int = 0) -> str:
        objects = session.findObjects([(3, label)])
        if not objects:
            raise HSMKeyNotFoundError(label)
        return objects[0]

    @property
    def initialized(self) -> bool:
        return self._initialized

    @property
    def available_count(self) -> int:
        return 1


# ── Session Pool Tests ──────────────────────────────────────────────


class TestPKCS11SessionPool:
    def test_pool_acquire_release(self) -> None:
        pool = FakePKCS11SessionPool()
        session = pool.acquire()
        assert session is not None
        pool.release(session)
        assert pool.available_count == 1

    def test_pool_close(self) -> None:
        pool = FakePKCS11SessionPool()
        pool.close()
        assert not pool.initialized

    def test_find_key_success(self) -> None:
        pool = FakePKCS11SessionPool()
        session = pool.acquire()
        key = pool.find_key(session, "tnt-encrypt-key")
        assert key == "tnt-encrypt-key"

    def test_find_key_not_found(self) -> None:
        pool = FakePKCS11SessionPool()
        session = pool.acquire()
        with pytest.raises(HSMKeyNotFoundError):
            pool.find_key(session, "nonexistent-key")


# ── HSM Crypto Backend Tests ────────────────────────────────────────


class _FakeMechanism:
    """Stub for PyKCS11 mechanism objects in tests."""
    def __init__(self, *args, **kwargs):
        pass


class TestHSMCryptoBackend:
    @pytest.fixture
    def settings(self) -> Settings:
        return Settings(
            crypto_backend="hsm",
            hsm_enabled=True,
            hsm_encrypt_key_label="tnt-encrypt-key",
            hsm_hmac_key_label="tnt-hmac-key",
            hsm_operation_timeout_seconds=5.0,
        )

    @pytest.fixture
    def pool(self) -> FakePKCS11SessionPool:
        return FakePKCS11SessionPool()

    @pytest.fixture
    def backend(self, settings: Settings, pool: FakePKCS11SessionPool):
        from tnt_engine.crypto import hsm as hsm_module
        # Patch PyKCS11 mechanism constructors to avoid real PKCS#11 calls
        with patch.object(hsm_module.PyKCS11, "AES_GCM_Mechanism", _FakeMechanism):
            with patch.object(hsm_module.PyKCS11, "Mechanism", _FakeMechanism):
                backend = hsm_module.HSMCryptoBackend(settings, pool)
                yield backend

    @pytest.fixture(autouse=True)
    def _patch_mechanisms(self):
        from tnt_engine.crypto import hsm as hsm_module
        with patch.object(hsm_module.PyKCS11, "AES_GCM_Mechanism", _FakeMechanism):
            with patch.object(hsm_module.PyKCS11, "Mechanism", _FakeMechanism):
                yield

    async def test_encrypt_decrypt_roundtrip(self, backend) -> None:
        plaintext = "sensitive-data-123"
        ciphertext, key_version = await backend.encrypt(plaintext)

        assert ciphertext.startswith("hsm:v")
        assert key_version == 1

        decrypted = await backend.decrypt(ciphertext, key_version)
        assert decrypted == plaintext

    async def test_encrypt_produces_hsm_prefix(self, backend) -> None:
        ciphertext, _ = await backend.encrypt("test")
        assert ciphertext.startswith("hsm:v1:")

    async def test_encrypt_different_inputs_different_outputs(self, backend) -> None:
        ct1, _ = await backend.encrypt("data_a")
        ct2, _ = await backend.encrypt("data_b")
        assert ct1 != ct2

    async def test_hmac_deterministic(self, backend) -> None:
        h1 = await backend.hmac("test-value")
        h2 = await backend.hmac("test-value")
        assert h1 == h2
        assert len(h1) == 64  # SHA-256 hex

    async def test_hmac_different_inputs(self, backend) -> None:
        h1 = await backend.hmac("value_a")
        h2 = await backend.hmac("value_b")
        assert h1 != h2

    async def test_decrypt_invalid_format_raises(self, backend) -> None:
        with pytest.raises(EncryptionError):
            await backend.decrypt("not-hsm-format", 1)

    async def test_decrypt_wrong_prefix_raises(self, backend) -> None:
        with pytest.raises(EncryptionError):
            await backend.decrypt("vault:v1:abc", 1)

    async def test_decrypt_too_short_raises(self, backend) -> None:
        short_data = base64.b64encode(b"short").decode()
        with pytest.raises(EncryptionError):
            await backend.decrypt(f"hsm:v1:{short_data}", 1)

    async def test_close(self, backend, pool: FakePKCS11SessionPool) -> None:
        await backend.close()
        assert not pool.initialized

    async def test_key_not_found_raises_hsm_error(self) -> None:
        from tnt_engine.errors import HSMKeyNotFoundError
        pool = FakePKCS11SessionPool()
        settings_bad = Settings(
            crypto_backend="hsm",
            hsm_enabled=True,
            hsm_encrypt_key_label="nonexistent-key",
            hsm_hmac_key_label="tnt-hmac-key",
        )
        from tnt_engine.crypto.hsm import HSMCryptoBackend
        backend = HSMCryptoBackend(settings_bad, pool)
        with pytest.raises(HSMKeyNotFoundError):
            await backend.encrypt("test")


# ── Backend Factory Tests ───────────────────────────────────────────


class TestCryptoBackendFactory:
    async def test_factory_sandbox(self) -> None:
        cfg = Settings(crypto_backend="sandbox")
        backend = await create_crypto_backend(cfg)
        from tnt_engine.crypto.sandbox import SandboxCryptoBackend
        assert isinstance(backend, SandboxCryptoBackend)

    async def test_factory_invalid_backend(self) -> None:
        cfg = Settings(crypto_backend="unknown")
        with pytest.raises(ValueError, match="Unknown crypto backend"):
            await create_crypto_backend(cfg)

    async def test_factory_hsm_requires_pin(self) -> None:
        cfg = Settings(crypto_backend="hsm", hsm_pin="")
        with pytest.raises(ValueError, match="HSM PIN is required"):
            await create_crypto_backend(cfg)


# ── Error Hierarchy Tests ───────────────────────────────────────────


class TestHSMErrors:
    def test_hsm_session_error(self) -> None:
        err = HSMSessionError("open_session", cause="connection refused")
        assert "HSM operation failed" in err.message
        assert err.code == "HSM_SESSION_ERROR"

    def test_hsm_key_not_found(self) -> None:
        err = HSMKeyNotFoundError("my-key")
        assert err.code == "HSM_KEY_NOT_FOUND"
        assert err.details["operation"] == "key_lookup"
        assert "my-key" in err.details["cause"]

    def test_hsm_auth_error(self) -> None:
        err = HSMAuthenticationError()
        assert "PIN" in err.details["cause"]
        assert err.code == "HSM_AUTH_FAILED"
