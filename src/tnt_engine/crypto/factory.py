"""Crypto backend factory — selects backend based on configuration.

Supported backends:
  - "openbao": OpenBao Transit engine (default, existing behavior)
  - "hsm": PKCS#11 HSM backend (FIPS 140-2 compliant)
  - "sandbox": Local deterministic crypto (dev/test only)

Selection is driven by the TNT_CRYPTO_BACKEND environment variable
or the `crypto_backend` config field.

When using the OpenBao backend, a VaultTokenManager is created
based on the configured auth method (static/approle/kubernetes).
"""

from __future__ import annotations

from tnt_engine.config import Settings
from tnt_engine.crypto.interface import CryptoBackend
from tnt_engine.logging import get_logger

logger = get_logger(__name__)


async def create_crypto_backend(settings: Settings) -> CryptoBackend:
    """Create the appropriate CryptoBackend based on settings.

    Returns an initialized backend ready for use.
    The caller is responsible for wrapping with CircuitBreakerBackend if desired.
    """
    backend_type = settings.crypto_backend.lower()

    if backend_type == "hsm":
        return _create_hsm_backend(settings)
    elif backend_type == "sandbox":
        return _create_sandbox_backend(settings)
    elif backend_type == "openbao":
        return await _create_openbao_backend(settings)
    else:
        raise ValueError(
            f"Unknown crypto backend: {backend_type!r}. "
            f"Expected one of: openbao, hsm, sandbox"
        )


async def _create_openbao_backend(settings: Settings) -> CryptoBackend:
    from tnt_engine.crypto.openbao import OpenBaoCryptoBackend
    from tnt_engine.crypto.vault_auth import (
        VaultTokenManager,
        create_auth_provider,
    )

    auth_provider = create_auth_provider(settings)
    token_manager = VaultTokenManager(auth_provider, settings)
    await token_manager.start()

    logger.info(
        "crypto_backend_selected",
        backend="openbao",
        auth_method=auth_provider.method_name,
    )
    return OpenBaoCryptoBackend(settings, token_manager)


def _create_hsm_backend(settings: Settings) -> CryptoBackend:
    from tnt_engine.crypto.hsm import HSMCryptoBackend
    from tnt_engine.crypto.pkcs11_session import PKCS11SessionPool

    if not settings.hsm_pin:
        raise ValueError("HSM PIN is required when crypto_backend=hsm (set TNT_HSM_PIN)")

    pool = PKCS11SessionPool(
        lib_path=settings.hsm_pkcs11_library,
        slot=settings.hsm_slot,
        pin=settings.hsm_pin,
        pool_size=settings.hsm_session_pool_size,
    )
    pool.initialize()

    logger.info(
        "crypto_backend_selected",
        backend="hsm",
        slot=settings.hsm_slot,
        pool_size=settings.hsm_session_pool_size,
    )
    return HSMCryptoBackend(settings, pool)


def _create_sandbox_backend(settings: Settings) -> CryptoBackend:
    from tnt_engine.crypto.sandbox import SandboxCryptoBackend

    logger.info("crypto_backend_selected", backend="sandbox", environment=settings.environment)
    return SandboxCryptoBackend(environment=settings.environment)
