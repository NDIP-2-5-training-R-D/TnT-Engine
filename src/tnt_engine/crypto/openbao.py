"""OpenBao (Vault-compatible) transit engine client with latency instrumentation.

Supports two modes of token management:
  - Legacy: static token from Settings (when no VaultTokenManager provided)
  - Managed: dynamic token from VaultTokenManager (auto-renewed)

The managed mode is preferred for production. The legacy mode exists
for backward compatibility and development.

Operations:
  hmac()                 → POST /transit/hmac/{hmac_key}           (SHA-256, default)
  hmac_sha512()          → POST /transit/hmac/{hmac_key}           (SHA-512 via algorithm param)
  encrypt()              → POST /transit/encrypt/{transit_key}     (AES-256-GCM96, TOKENIZE)
  decrypt()              → POST /transit/decrypt/{transit_key}
  encrypt_aes256_gcm96() → POST /transit/encrypt/{aes_gcm_key}    (dedicated AES-GCM key)
  fpe_ff31()             → Envelope encryption: DEK from OpenBao KV, FF3-1 in Python RAM
                           1. GET  /secret/data/tnt/fpe-dek        (wrapped DEK)
                           2. POST /transit/decrypt/{fpe_key}      (unwrap DEK)
                           3. ff3.FF3Cipher.encrypt() on RAM copy of DEK
                           4. Zeroize DEK bytearray before return
"""

from __future__ import annotations

import base64
import time
from typing import TYPE_CHECKING

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from tnt_engine.config import Settings
from tnt_engine.crypto.interface import CryptoBackend
from tnt_engine.errors import EncryptionError
from tnt_engine.logging import get_logger
from tnt_engine.metrics import CRYPTO_ERRORS, CRYPTO_LATENCY

if TYPE_CHECKING:
    from tnt_engine.crypto.vault_auth import VaultTokenManager

logger = get_logger(__name__)


class OpenBaoCryptoBackend(CryptoBackend):
    """Production implementation backed by OpenBao Transit engine."""

    def __init__(
        self,
        settings: Settings,
        token_manager: VaultTokenManager | None = None,
    ) -> None:
        self._base = settings.crypto_base_url.rstrip("/")
        self._transit_key = settings.crypto_transit_key
        self._hmac_key = settings.crypto_hmac_key
        self._aes_gcm_key = settings.crypto_aes_gcm_key
        self._fpe_key = settings.crypto_fpe_key
        self._max_retries = settings.crypto_max_retries
        self._token_manager = token_manager

        # Legacy static token mode (when no token_manager provided)
        self._static_token = settings.crypto_token if token_manager is None else None

        from tnt_engine.crypto._http import build_httpx_client
        self._client = build_httpx_client(settings)

    def _get_token(self) -> str:
        """Get the current valid token (managed or static)."""
        if self._token_manager is not None:
            return self._token_manager.token
        return self._static_token or ""

    # ── HMACService ──────────────────────────────────────────────────

    async def hmac(self, plaintext: str, key_name: str | None = None) -> str:
        """HMAC-SHA-256 via OpenBao Transit /transit/hmac/{key}."""
        key = key_name or self._hmac_key
        b64 = base64.b64encode(plaintext.encode()).decode()
        t0 = time.monotonic()
        try:
            data = await self._post(f"/transit/hmac/{key}", json={"input": b64})
            CRYPTO_LATENCY.labels(operation="hmac").observe(time.monotonic() - t0)
            return data["hmac"]
        except Exception as exc:
            CRYPTO_ERRORS.labels(operation="hmac").inc()
            raise EncryptionError("hmac", str(exc)) from exc

    async def hmac_sha512(self, plaintext: str, key_name: str | None = None) -> str:
        """HMAC-SHA-512 via OpenBao Transit /transit/hmac/{key}?algorithm=sha2-512.

        OpenBao Transit supports the `algorithm` parameter to select the digest:
          sha2-224, sha2-256 (default), sha2-384, sha2-512
        """
        key = key_name or self._hmac_key
        b64 = base64.b64encode(plaintext.encode()).decode()
        t0 = time.monotonic()
        try:
            data = await self._post(
                f"/transit/hmac/{key}",
                json={"input": b64, "algorithm": "sha2-512"},
            )
            CRYPTO_LATENCY.labels(operation="hmac_sha512").observe(time.monotonic() - t0)
            # OpenBao returns "hmac:v1:sha2-512:..." — return the full HMAC string
            return data["hmac"]
        except Exception as exc:
            CRYPTO_ERRORS.labels(operation="hmac_sha512").inc()
            raise EncryptionError("hmac_sha512", str(exc)) from exc

    # ── EncryptionService ────────────────────────────────────────────

    async def encrypt(self, plaintext: str, key_name: str | None = None) -> tuple[str, int]:
        """Standard encrypt via /transit/encrypt/{transit_key} (used for TOKENIZE)."""
        key = key_name or self._transit_key
        b64 = base64.b64encode(plaintext.encode()).decode()
        t0 = time.monotonic()
        try:
            data = await self._post(f"/transit/encrypt/{key}", json={"plaintext": b64})
            ciphertext: str = data["ciphertext"]
            key_version = data.get("key_version", self._parse_key_version(ciphertext))
            CRYPTO_LATENCY.labels(operation="encrypt").observe(time.monotonic() - t0)
            return ciphertext, key_version
        except EncryptionError:
            CRYPTO_ERRORS.labels(operation="encrypt").inc()
            raise
        except Exception as exc:
            CRYPTO_ERRORS.labels(operation="encrypt").inc()
            raise EncryptionError("encrypt", str(exc)) from exc

    async def decrypt(
        self, ciphertext: str, key_version: int, key_name: str | None = None
    ) -> str:
        key = key_name or self._transit_key
        t0 = time.monotonic()
        try:
            data = await self._post(
                f"/transit/decrypt/{key}",
                json={"ciphertext": ciphertext},
            )
            plaintext_b64: str = data["plaintext"]
            CRYPTO_LATENCY.labels(operation="decrypt").observe(time.monotonic() - t0)
            return base64.b64decode(plaintext_b64).decode()
        except EncryptionError:
            CRYPTO_ERRORS.labels(operation="decrypt").inc()
            raise
        except Exception as exc:
            CRYPTO_ERRORS.labels(operation="decrypt").inc()
            raise EncryptionError("decrypt", str(exc)) from exc

    async def encrypt_aes256_gcm96(
        self, plaintext: str, key_name: str | None = None
    ) -> tuple[str, int]:
        """AES-256-GCM96 encryption via a dedicated transit key.

        Uses the aes_gcm_key (default: "tnt-aes-gcm") which must be created
        with type=aes256-gcm96 in OpenBao:
            vault write transit/keys/tnt-aes-gcm type=aes256-gcm96

        Returns (vault_ciphertext, key_version) where vault_ciphertext has the
        format "vault:vN:<base64>" — this is the raw AES-256-GCM96 output.
        """
        key = key_name or self._aes_gcm_key
        b64 = base64.b64encode(plaintext.encode()).decode()
        t0 = time.monotonic()
        try:
            data = await self._post(f"/transit/encrypt/{key}", json={"plaintext": b64})
            ciphertext: str = data["ciphertext"]
            key_version = data.get("key_version", self._parse_key_version(ciphertext))
            CRYPTO_LATENCY.labels(operation="aes256_gcm96").observe(time.monotonic() - t0)
            return ciphertext, key_version
        except EncryptionError:
            CRYPTO_ERRORS.labels(operation="aes256_gcm96").inc()
            raise
        except Exception as exc:
            CRYPTO_ERRORS.labels(operation="aes256_gcm96").inc()
            raise EncryptionError("aes256_gcm96", str(exc)) from exc

    async def fpe_ff31(self, plaintext: str, key_name: str | None = None) -> str:
        """FF3-1 Format-Preserving Encryption via envelope encryption.

        Flow (all I/O to OpenBao; FF3-1 runs entirely in Python RAM):
          1. GET  /secret/data/tnt/fpe-dek    — read wrapped DEK from KV v2
          2. POST /transit/decrypt/{fpe_key}  — unwrap DEK (plaintext is base64)
          3. ff3.FF3Cipher(dek).encrypt()     — run FF3-1 on digit characters
          4. Zeroize DEK bytearray in finally block

        The DEK never persists; it lives only in a bytearray for the duration
        of this call and is zeroed before the function returns.

        Requires:
          - KV v2 engine mounted at ``secret/``
          - Secret ``secret/data/tnt/fpe-dek`` with key ``wrapped_dek``
            (bootstrapped by ``scripts/init-openbao-dev.sh``)
          - Transit key ``tnt-fpe`` (aes256-gcm96) for DEK wrapping
        """
        from tnt_engine.crypto._fpe import ff3_fpe_encrypt

        t0 = time.monotonic()
        dek_arr: bytearray | None = None
        try:
            # Step 1 — fetch wrapped DEK from KV v2
            kv_resp = await self._get("/secret/data/tnt/fpe-dek")
            wrapped_dek: str = kv_resp["data"]["wrapped_dek"]

            # Step 2 — decrypt (unwrap) DEK via Transit
            decrypt_resp = await self._post(
                f"/transit/decrypt/{self._fpe_key}",
                json={"ciphertext": wrapped_dek},
            )
            dek_b64: str = decrypt_resp["plaintext"]
            dek_arr = bytearray(base64.b64decode(dek_b64))

            # Step 3 — run FF3-1 in Python RAM
            result = ff3_fpe_encrypt(plaintext, bytes(dek_arr))

            CRYPTO_LATENCY.labels(operation="ff3_1").observe(time.monotonic() - t0)
            return result
        except Exception as exc:
            CRYPTO_ERRORS.labels(operation="ff3_1").inc()
            raise EncryptionError("ff3_1", str(exc)) from exc
        finally:
            # Step 4 — zeroize DEK bytes regardless of success or failure
            if dek_arr is not None:
                for i in range(len(dek_arr)):
                    dek_arr[i] = 0

    async def close(self) -> None:
        await self._client.aclose()
        if self._token_manager is not None:
            await self._token_manager.stop()

    # ── Internals ────────────────────────────────────────────────────

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=0.1, max=2),
        retry=retry_if_exception_type((httpx.TransportError, httpx.TimeoutException)),
        reraise=True,
    )
    async def _post(self, path: str, json: dict) -> dict:
        url = f"{self._base}{path}"
        headers = {"X-Vault-Token": self._get_token()}
        resp = await self._client.post(url, json=json, headers=headers)
        resp.raise_for_status()
        body = resp.json()
        return body.get("data", body)

    async def _get(self, path: str) -> dict:
        """HTTP GET to OpenBao API; returns the ``data`` envelope or raw body."""
        url = f"{self._base}{path}"
        headers = {"X-Vault-Token": self._get_token()}
        resp = await self._client.get(url, headers=headers)
        resp.raise_for_status()
        body = resp.json()
        return body.get("data", body)

    @staticmethod
    def _parse_key_version(ciphertext: str) -> int:
        """Extract key version from 'vault:v<N>:...' format."""
        try:
            parts = ciphertext.split(":")
            return int(parts[1].lstrip("v"))
        except (IndexError, ValueError):
            return 1

