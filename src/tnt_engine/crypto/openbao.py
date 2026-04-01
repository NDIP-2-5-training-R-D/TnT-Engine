"""OpenBao (Vault-compatible) transit engine client with latency instrumentation."""

from __future__ import annotations

import base64
import time

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

logger = get_logger(__name__)


class OpenBaoCryptoBackend(CryptoBackend):
    """Production implementation backed by OpenBao Transit engine."""

    def __init__(self, settings: Settings) -> None:
        self._base = settings.crypto_base_url.rstrip("/")
        self._transit_key = settings.crypto_transit_key
        self._hmac_key = settings.crypto_hmac_key
        self._max_retries = settings.crypto_max_retries
        self._client = httpx.AsyncClient(
            headers={"X-Vault-Token": settings.crypto_token},
            timeout=httpx.Timeout(settings.crypto_timeout_seconds),
        )

    # ── HMACService ──────────────────────────────────────────────────

    async def hmac(self, plaintext: str, key_name: str | None = None) -> str:
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

    # ── EncryptionService ────────────────────────────────────────────

    async def encrypt(self, plaintext: str, key_name: str | None = None) -> tuple[str, int]:
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

    async def close(self) -> None:
        await self._client.aclose()

    # ── Internals ────────────────────────────────────────────────────

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=0.1, max=2),
        retry=retry_if_exception_type((httpx.TransportError, httpx.TimeoutException)),
        reraise=True,
    )
    async def _post(self, path: str, json: dict) -> dict:
        url = f"{self._base}{path}"
        resp = await self._client.post(url, json=json)
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
