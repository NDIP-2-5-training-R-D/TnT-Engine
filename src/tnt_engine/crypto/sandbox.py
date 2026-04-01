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
  - HMAC: SHA-256 hash (deterministic, convergent)
  - Encrypt: base64 encoding with "sandbox:v1:" prefix
  - Decrypt: base64 decode (strips prefix)
"""

from __future__ import annotations

import base64
import hashlib

from tnt_engine.crypto.interface import CryptoBackend
from tnt_engine.errors import EnvironmentSafetyError
from tnt_engine.logging import get_logger

logger = get_logger(__name__)

_BLOCKED_ENVIRONMENTS = frozenset({"production", "staging"})


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

    async def hmac(self, plaintext: str, key_name: str | None = None) -> str:
        return hashlib.sha256(plaintext.encode()).hexdigest()

    async def encrypt(self, plaintext: str, key_name: str | None = None) -> tuple[str, int]:
        b64 = base64.b64encode(plaintext.encode()).decode()
        return f"sandbox:v1:{b64}", 1

    async def decrypt(
        self, ciphertext: str, key_version: int, key_name: str | None = None
    ) -> str:
        b64 = ciphertext.split(":", 2)[2]
        return base64.b64decode(b64).decode()

    async def close(self) -> None:
        pass
