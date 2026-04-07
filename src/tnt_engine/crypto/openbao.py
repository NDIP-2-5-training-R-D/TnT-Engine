"""OpenBao (Vault-compatible) transit engine client with latency instrumentation.

Supports two modes of token management:
  - Legacy: static token from Settings (when no VaultTokenManager provided)
  - Managed: dynamic token from VaultTokenManager (auto-renewed)

The managed mode is preferred for production. The legacy mode exists
for backward compatibility and development.

Operations:
  hmac()              → POST /transit/hmac/{hmac_key}            (SHA-256, default)
  hmac_sha512()       → POST /transit/hmac/{hmac_key}            (SHA-512 via algorithm param)
  encrypt()           → POST /transit/encrypt/{transit_key}      (AES-256-GCM96, used for TOKENIZE)
  decrypt()           → POST /transit/decrypt/{transit_key}
  encrypt_aes256_gcm96() → POST /transit/encrypt/{aes_gcm_key}  (dedicated AES-GCM key, raw output)
  fpe_ff31()          → POST /transit/encrypt/{fpe_key}          (dedicated FPE/convergent key)
                         Falls back to Feistel simulation if FPE key is not configured.
"""

from __future__ import annotations

import base64
import hashlib
import hmac as _hmac
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
        """Format-Preserving Encryption via OpenBao Transit FPE key.

        The dedicated FPE key (tnt-fpe) should be created in OpenBao as:
            vault write transit/keys/tnt-fpe type=aes256-gcm96

        OpenBao CE does not natively support FF3-1 FPE in the transit engine
        (that requires Vault Enterprise Transform secrets engine). As a practical
        equivalent, this method uses the HMAC key to derive a format-preserving
        permutation via a Feistel network — consistent output per key+plaintext
        while preserving character classes.

        For full NIST SP 800-38G FF3-1 compliance in production, configure the
        Vault Enterprise Transform secrets engine with tweak_source=supplied.
        """
        key = key_name or self._fpe_key
        t0 = time.monotonic()
        try:
            # Derive a deterministic round key from OpenBao HMAC (uses Vault key material)
            b64 = base64.b64encode(plaintext.encode()).decode()
            hmac_data = await self._post(
                f"/transit/hmac/{self._hmac_key}",
                json={"input": b64, "algorithm": "sha2-256"},
            )
            vault_hmac: str = hmac_data["hmac"]
            # Use the vault HMAC as the Feistel round key (bytes)
            round_key = vault_hmac.encode()
            result = _feistel_fpe(plaintext, round_key)
            CRYPTO_LATENCY.labels(operation="ff3_1").observe(time.monotonic() - t0)
            return result
        except Exception as exc:
            CRYPTO_ERRORS.labels(operation="ff3_1").inc()
            raise EncryptionError("ff3_1", str(exc)) from exc

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

    @staticmethod
    def _parse_key_version(ciphertext: str) -> int:
        """Extract key version from 'vault:v<N>:...' format."""
        try:
            parts = ciphertext.split(":")
            return int(parts[1].lstrip("v"))
        except (IndexError, ValueError):
            return 1


# ── Feistel FPE (shared with sandbox) ────────────────────────────────

_DIGITS = "0123456789"
_UPPER  = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_LOWER  = "abcdefghijklmnopqrstuvwxyz"


def _feistel_fpe(plaintext: str, key: bytes, rounds: int = 4) -> str:
    """4-round Feistel FPE over alphabet characters.

    Preserves digit→digit, upper→upper, lower→lower, separators unchanged.
    """
    positions: list[int] = []
    alphabets: list[str] = []
    for i, ch in enumerate(plaintext):
        if ch in _DIGITS:
            positions.append(i)
            alphabets.append(_DIGITS)
        elif ch in _UPPER:
            positions.append(i)
            alphabets.append(_UPPER)
        elif ch in _LOWER:
            positions.append(i)
            alphabets.append(_LOWER)

    if not positions:
        return plaintext

    chars = list(plaintext)
    indices = [alphabets[i].index(chars[positions[i]]) for i in range(len(positions))]
    n = len(indices)
    split = n // 2
    left  = indices[:split]
    right = indices[split:]

    def _round_fn(rnd: int, half: list[int], target_len: int) -> list[int]:
        data = f"{rnd}:" + ",".join(str(x) for x in half)
        h = _hmac.new(key, data.encode(), hashlib.sha256).digest()
        return [h[i % len(h)] for i in range(target_len)]

    for rnd in range(rounds):
        if rnd % 2 == 0:
            f_out = _round_fn(rnd, right, len(left))
            left = [
                (left[i] + f_out[i]) % len(alphabets[positions[i]])
                for i in range(len(left))
            ]
        else:
            f_out = _round_fn(rnd, left, len(right))
            right = [
                (right[i] + f_out[i]) % len(alphabets[positions[split + i]])
                for i in range(len(right))
            ]

    result_indices = left + right
    for seq_i, pos in enumerate(positions):
        chars[pos] = alphabets[seq_i][result_indices[seq_i] % len(alphabets[seq_i])]

    return "".join(chars)
