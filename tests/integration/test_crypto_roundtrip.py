"""Integration tests: OpenBao Transit crypto operations.

Requires: docker compose -f tests/integration/docker-compose.yml up -d --wait
Tests real encrypt/decrypt/hmac operations against OpenBao dev server.
"""

from __future__ import annotations

import pytest

from tnt_engine.config import Settings
from tnt_engine.crypto.openbao import OpenBaoCryptoBackend
from tnt_engine.crypto.vault_auth import StaticTokenProvider, VaultTokenManager


@pytest.fixture(scope="module")
async def crypto_backend(
    integration_settings: Settings, setup_transit_keys: None
) -> OpenBaoCryptoBackend:
    provider = StaticTokenProvider(integration_settings.crypto_token)
    manager = VaultTokenManager(provider, integration_settings)
    await manager.start()
    backend = OpenBaoCryptoBackend(integration_settings, manager)
    yield backend
    await backend.close()


class TestTransitEncryptDecrypt:
    async def test_encrypt_decrypt_roundtrip(self, crypto_backend) -> None:
        plaintext = "123-45-6789"
        ciphertext, key_version = await crypto_backend.encrypt(plaintext)

        assert ciphertext.startswith("vault:v")
        assert key_version >= 1

        decrypted = await crypto_backend.decrypt(ciphertext, key_version)
        assert decrypted == plaintext

    async def test_encrypt_different_inputs_differ(self, crypto_backend) -> None:
        ct1, _ = await crypto_backend.encrypt("value_a")
        ct2, _ = await crypto_backend.encrypt("value_b")
        assert ct1 != ct2

    async def test_encrypt_same_input_differs(self, crypto_backend) -> None:
        """Non-convergent encryption: same plaintext → different ciphertext."""
        ct1, _ = await crypto_backend.encrypt("same_value")
        ct2, _ = await crypto_backend.encrypt("same_value")
        # Transit non-convergent mode produces different ciphertext each time
        assert ct1 != ct2


class TestTransitHMAC:
    async def test_hmac_deterministic(self, crypto_backend) -> None:
        h1 = await crypto_backend.hmac("test-value")
        h2 = await crypto_backend.hmac("test-value")
        assert h1 == h2

    async def test_hmac_different_inputs(self, crypto_backend) -> None:
        h1 = await crypto_backend.hmac("value_a")
        h2 = await crypto_backend.hmac("value_b")
        assert h1 != h2

    async def test_hmac_returns_prefixed_string(self, crypto_backend) -> None:
        h = await crypto_backend.hmac("test")
        assert "hmac" in h.lower() or len(h) > 20
