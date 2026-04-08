"""Sandbox crypto backend — no external service required.

Uses deterministic local crypto for development and testing.
NEVER use in production — this is NOT secure encryption.

Activated via:
  - environment variable: TNT_CRYPTO_BACKEND=sandbox
  - programmatically when creating TNTClient

Safety guard:
  - REFUSES to instantiate when TNT_ENVIRONMENT=production or staging
  - Factory enforces this, but the backend also self-checks

Behavior:
  - hmac:                 SHA-256 HMAC (deterministic, convergent)
  - hmac_sha512:          SHA-512 HMAC (deterministic)
  - encrypt/decrypt:      base64 encoding with "sandbox:v1:" prefix
  - encrypt_aes256_gcm96: AES-256-GCM with fixed sandbox key, returns <iv>.<ct>.<tag>
  - fpe_ff31:             FF3-1 FPE using fixed sandbox DEK (ff3 library, radix=10)
"""

from __future__ import annotations

import base64
import hashlib
import hmac as _hmac
import os

from tnt_engine.crypto.interface import CryptoBackend
from tnt_engine.errors import EnvironmentSafetyError
from tnt_engine.logging import get_logger

logger = get_logger(__name__)

_BLOCKED_ENVIRONMENTS = frozenset({"production", "staging"})

# Fixed sandbox keys — NOT secrets, development-only.
_SANDBOX_HMAC_512_KEY = b"sandbox-hmac-sha512-key"
_SANDBOX_AES_KEY = hashlib.sha256(b"sandbox-aes256-gcm96-key").digest()  # 32 bytes
# Fixed DEK for FF3-1 — deterministic, NOT secure; production uses envelope encryption.
_SANDBOX_FPE_DEK = hashlib.sha256(b"sandbox-fpe-ff31-key").digest()  # 32 bytes


class SandboxCryptoBackend(CryptoBackend):
    """Local deterministic crypto for development. NOT for production.

    Raises EnvironmentSafetyError if instantiated in production/staging.
    """

    def __init__(self, environment: str = "development") -> None:
        if environment.lower() in _BLOCKED_ENVIRONMENTS:
            raise EnvironmentSafetyError(
                f"SandboxCryptoBackend cannot be used in '{environment}' environment. "
                f"Use 'openbao' or 'hsm' crypto backend for {environment}."
            )
        logger.warning(
            "sandbox_crypto_active",
            environment=environment,
            msg="Using sandbox crypto — NOT for production",
        )

    # ── HMACService ──────────────────────────────────────────────────

    async def hmac(self, plaintext: str, key_name: str | None = None) -> str:
        return hashlib.sha256(plaintext.encode()).hexdigest()

    async def hmac_sha512(self, plaintext: str, key_name: str | None = None) -> str:
        """HMAC-SHA-512 using fixed sandbox key. Returns 128-char hex digest."""
        digest = _hmac.new(_SANDBOX_HMAC_512_KEY, plaintext.encode(), hashlib.sha512).hexdigest()
        return digest

    # ── EncryptionService ────────────────────────────────────────────

    async def encrypt(self, plaintext: str, key_name: str | None = None) -> tuple[str, int]:
        b64 = base64.b64encode(plaintext.encode()).decode()
        return f"sandbox:v1:{b64}", 1

    async def decrypt(
        self, ciphertext: str, key_version: int, key_name: str | None = None
    ) -> str:
        b64 = ciphertext.split(":", 2)[2]
        return base64.b64decode(b64).decode()

    async def encrypt_aes256_gcm96(
        self, plaintext: str, key_name: str | None = None
    ) -> tuple[str, int]:
        """AES-256-GCM encryption with a 96-bit (12-byte) random nonce.

        Returns (formatted_ciphertext, key_version=1) where:
            formatted_ciphertext = "<iv_b64url>.<ciphertext_b64url>.<authtag_b64url>"
        """
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        nonce = os.urandom(12)  # 96-bit nonce
        aesgcm = AESGCM(_SANDBOX_AES_KEY)
        # AESGCM.encrypt appends 16-byte auth tag to ciphertext
        ct_with_tag = aesgcm.encrypt(nonce, plaintext.encode(), None)
        ct = ct_with_tag[:-16]
        tag = ct_with_tag[-16:]

        formatted = (
            f"{base64.urlsafe_b64encode(nonce).rstrip(b'=').decode()}"
            f".{base64.urlsafe_b64encode(ct).rstrip(b'=').decode()}"
            f".{base64.urlsafe_b64encode(tag).rstrip(b'=').decode()}"
        )
        return formatted, 1

    async def fpe_ff31(self, plaintext: str, key_name: str | None = None) -> str:
        """FF3-1 Format-Preserving Encryption using a fixed sandbox DEK.

        Uses the same ``ff3`` library as the production OpenBao backend but with
        a fixed, deterministic DEK derived from a constant string — NOT secure.
        Production uses envelope encryption (DEK wrapped in OpenBao KV + Transit).

        Preserves non-digit separators (dashes, spaces, …) unchanged.
        Inputs with fewer than 6 digit characters are returned unchanged.
        """
        from tnt_engine.crypto._fpe import ff3_fpe_encrypt

        return ff3_fpe_encrypt(plaintext, _SANDBOX_FPE_DEK)

    async def close(self) -> None:
        pass

