"""Shared HTTP client factory with TLS support for OpenBao/Vault connections.

All httpx.AsyncClient instances that connect to OpenBao should be created
via this module to ensure consistent TLS configuration.

TLS behavior:
  - crypto_verify_ssl=True (default): httpx verifies server cert using system CA bundle
  - crypto_ca_cert set: uses custom CA cert file for verification
  - crypto_client_cert + crypto_client_key set: enables mTLS (client certificate auth)
  - crypto_verify_ssl=False: disables verification (ONLY for dev with self-signed certs)
"""

from __future__ import annotations

import httpx

from tnt_engine.config import Settings


def build_httpx_client(settings: Settings, timeout: float | None = None) -> httpx.AsyncClient:
    """Create an httpx.AsyncClient with TLS settings from config.

    Args:
        settings: Application settings containing TLS config
        timeout: Override timeout (defaults to settings.crypto_timeout_seconds)
    """
    t = timeout or settings.crypto_timeout_seconds

    # SSL verification: custom CA cert path, True (system CAs), or False (disabled)
    verify: str | bool = True
    if settings.crypto_ca_cert:
        verify = settings.crypto_ca_cert
    elif not settings.crypto_verify_ssl:
        verify = False

    # Client certificate for mTLS
    cert = None
    if settings.crypto_client_cert and settings.crypto_client_key:
        cert = (settings.crypto_client_cert, settings.crypto_client_key)

    return httpx.AsyncClient(
        timeout=httpx.Timeout(t),
        verify=verify,
        cert=cert,
    )
