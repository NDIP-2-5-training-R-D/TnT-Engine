"""Tests for the sandbox crypto backend."""

from __future__ import annotations

from tnt_engine.crypto.sandbox import SandboxCryptoBackend


class TestSandboxCrypto:
    async def test_hmac_deterministic(self) -> None:
        sb = SandboxCryptoBackend()
        h1 = await sb.hmac("hello")
        h2 = await sb.hmac("hello")
        assert h1 == h2

    async def test_hmac_different_inputs(self) -> None:
        sb = SandboxCryptoBackend()
        h1 = await sb.hmac("aaa")
        h2 = await sb.hmac("bbb")
        assert h1 != h2

    async def test_encrypt_decrypt_round_trip(self) -> None:
        sb = SandboxCryptoBackend()
        ct, version = await sb.encrypt("secret_data")
        assert ct.startswith("sandbox:v1:")
        assert version == 1

        pt = await sb.decrypt(ct, version)
        assert pt == "secret_data"

    async def test_close(self) -> None:
        sb = SandboxCryptoBackend()
        await sb.close()  # should not raise
