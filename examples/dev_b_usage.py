"""
Example: How Dev B extends the T&T Engine with a custom crypto backend.

Dev B is a security/crypto engineer. They implement the CryptoBackend
interface to integrate a new key management system or HSM.

The platform's caching, batching, lifecycle, tenancy, and metrics
are all automatic — Dev B only writes the crypto operations.
"""

import asyncio
import base64
import hashlib

from tnt_engine.cache.layered import LayeredCache
from tnt_engine.cache.redis import TokenCache
from tnt_engine.config import Settings, settings
from tnt_engine.crypto.circuit_breaker import CircuitBreakerBackend
from tnt_engine.crypto.interface import CryptoBackend
from tnt_engine.db.connection import Database
from tnt_engine.db.repository import TokenRepository
from tnt_engine.sdk.client import TNTClient, _Resources
from tnt_engine.service.policy import PolicyEngine
from tnt_engine.service.token_service import TokenService


# ─────────────────────────────────────────────────────────────────────
# Step 1: Dev B implements the CryptoBackend interface
# ─────────────────────────────────────────────────────────────────────

class MyHSMCryptoBackend(CryptoBackend):
    """Example: custom crypto backend backed by an HSM or cloud KMS.

    Dev B only implements these 4 methods. Everything else
    (cache, DB, tenancy, metrics, retry) is handled by the platform.
    """

    def __init__(self, hsm_endpoint: str, api_key: str) -> None:
        self._endpoint = hsm_endpoint
        self._api_key = api_key
        # In production: initialize HSM client, connection pool, etc.

    async def hmac(self, plaintext: str, key_name: str | None = None) -> str:
        """Compute HMAC for convergent tokenization lookups."""
        # In production: call HSM HMAC API
        # For this example: local SHA-256
        return hashlib.sha256(plaintext.encode()).hexdigest()

    async def encrypt(self, plaintext: str, key_name: str | None = None) -> tuple[str, int]:
        """Encrypt plaintext. Returns (ciphertext, key_version)."""
        # In production: call HSM encrypt API
        b64 = base64.b64encode(plaintext.encode()).decode()
        ciphertext = f"hsm:v1:{b64}"
        key_version = 1
        return ciphertext, key_version

    async def decrypt(
        self, ciphertext: str, key_version: int, key_name: str | None = None
    ) -> str:
        """Decrypt ciphertext using the specified key version."""
        # In production: call HSM decrypt API with key version routing
        b64 = ciphertext.split(":", 2)[2]
        return base64.b64decode(b64).decode()

    async def close(self) -> None:
        """Release HSM connections."""
        pass


# ─────────────────────────────────────────────────────────────────────
# Step 2: Wire the custom backend into the platform
# ─────────────────────────────────────────────────────────────────────

async def create_client_with_custom_backend() -> TNTClient:
    """Create a TNTClient using Dev B's custom crypto backend."""
    cfg = settings

    # Standard infrastructure — Dev B doesn't change these
    db = Database(cfg)
    await db.connect()

    l2_cache = TokenCache(cfg)
    cache = LayeredCache(l2_cache, cfg)

    # Dev B's custom backend, wrapped with circuit breaker
    raw_backend = MyHSMCryptoBackend(
        hsm_endpoint="https://hsm.internal:8443",
        api_key="hsm-api-key",
    )
    backend = CircuitBreakerBackend(
        raw_backend,
        failure_threshold=cfg.cb_failure_threshold,
        recovery_timeout=cfg.cb_recovery_timeout_seconds,
    )

    repo = TokenRepository(db)
    svc = TokenService(
        hmac=backend,
        encryption=backend,
        repo=repo,
        cache=cache,
        settings=cfg,
    )

    policy_engine = PolicyEngine(token_service=svc, hmac_service=backend)
    resources = _Resources(db=db, cache=cache, backend=backend)
    return TNTClient(service=svc, policy_engine=policy_engine, _resources=resources)


async def main():
    client = await create_client_with_custom_backend()

    # From here on, usage is identical to Dev A — the custom backend
    # is completely transparent to the caller.

    token = await client.tokenize(
        value="123-45-6789",
        field_type="ssn",
        tenant_id="acme",
    )
    print(f"Token (via custom HSM backend): {token}")

    original = await client.detokenize(token, tenant_id="acme")
    print(f"Decrypted: {original}")
    assert original == "123-45-6789"

    await client.close()
    print("Done — custom crypto backend works with zero platform changes.")


if __name__ == "__main__":
    asyncio.run(main())
