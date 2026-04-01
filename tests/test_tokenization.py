"""Unit tests for TokenizationService."""
import asyncio
import base64
from unittest.mock import AsyncMock

import pytest

from crypto_adapter.auth.exceptions import OpenBaoCryptoError
from crypto_adapter.services.tokenization import TokenizationService

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_client(encrypt_return: str = "vault:v1:ABCDEFGH", decrypt_return: str = "secret") -> AsyncMock:
    client = AsyncMock()
    client.encrypt.return_value = encrypt_return
    client.decrypt.return_value = decrypt_return
    return client


def _vault_ct(plaintext: str) -> str:
    """Build a fake vault ciphertext that looks like OpenBao would return."""
    return "vault:v1:" + base64.b64encode(plaintext.encode()).decode()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tokenize_produces_tt1_prefix():
    client = _make_client(encrypt_return="vault:v1:ABCDEFGH")
    svc = TokenizationService(client)
    token = await svc.tokenize("secret", "test-key")
    assert token.startswith("tt1_")


@pytest.mark.asyncio
async def test_detokenize_recovers_original():
    original = "my-secret-value"
    fake_ct = _vault_ct(original)
    client = _make_client(encrypt_return=fake_ct, decrypt_return=original)
    svc = TokenizationService(client)

    token = await svc.tokenize(original, "test-key")

    # detokenize should reconstruct the exact ciphertext and call decrypt with it
    result = await svc.detokenize(token, "test-key")

    assert result == original
    client.decrypt.assert_awaited_once_with(fake_ct, "test-key")


@pytest.mark.asyncio
async def test_tokenize_detokenize_roundtrip():
    """Ten different inputs should all round-trip correctly."""
    for i in range(10):
        original = f"value-number-{i}"
        fake_ct = _vault_ct(original)
        client = _make_client(encrypt_return=fake_ct, decrypt_return=original)
        svc = TokenizationService(client)

        token = await svc.tokenize(original, "test-key")
        assert token.startswith("tt1_"), f"Token for input {i} missing tt1_ prefix"

        recovered = await svc.detokenize(token, "test-key")
        assert recovered == original, f"Round-trip failed for input {i}"


@pytest.mark.asyncio
async def test_invalid_token_raises_value_error():
    client = AsyncMock()
    svc = TokenizationService(client)

    with pytest.raises(ValueError, match="Invalid token format"):
        await svc.detokenize("not-a-valid-token", "test-key")

    with pytest.raises(ValueError, match="Invalid token format"):
        await svc.detokenize("vault:v1:ABCDEF", "test-key")

    # Client should never have been called
    client.decrypt.assert_not_awaited()


@pytest.mark.asyncio
async def test_batch_tokenize_partial_failure():
    """1 item fails; the other 3 succeed and per-item error is reported."""
    items = ["good-0", "good-1", "bad-value", "good-3"]

    async def mock_encrypt(value: str, key_name: str) -> str:
        if value == "bad-value":
            raise OpenBaoCryptoError("Simulated encryption failure")
        return _vault_ct(value)

    client = AsyncMock()
    client.encrypt.side_effect = mock_encrypt

    svc = TokenizationService(client)

    tasks = [svc.tokenize(v, "test-key") for v in items]
    outcomes = await asyncio.gather(*tasks, return_exceptions=True)

    successes = [o for o in outcomes if not isinstance(o, Exception)]
    errors = [o for o in outcomes if isinstance(o, Exception)]

    assert len(successes) == 3
    assert len(errors) == 1
    assert isinstance(errors[0], OpenBaoCryptoError)

    # Successful tokens all carry the tt1_ prefix
    for token in successes:
        assert token.startswith("tt1_")

    # The failure is at index 2 (bad-value)
    assert isinstance(outcomes[2], OpenBaoCryptoError)
