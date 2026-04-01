"""HSM-backed crypto backend using PKCS#11.

Implements CryptoBackend interface with hardware-secured key operations.
All cryptographic operations are delegated to the HSM via PKCS#11:
  - HMAC: CKM_SHA256_HMAC (FIPS-approved)
  - Encrypt: CKM_AES_GCM with 12-byte IV (FIPS-approved)
  - Decrypt: CKM_AES_GCM

Ciphertext format: "hsm:v<key_version>:<base64(iv + ciphertext + tag)>"
  - Prefix allows ReencryptWorker to distinguish HSM vs OpenBao ciphertexts
  - IV is 12 bytes, prepended to ciphertext
  - GCM tag is 16 bytes, appended by the HSM

Security invariants:
  - Key material NEVER leaves the HSM boundary
  - Plaintext enters HSM for encrypt, exits HSM on decrypt — no local key copy
  - All operations instrumented with Prometheus metrics
"""

from __future__ import annotations

import asyncio
import base64
import os
import time
from functools import partial

import PyKCS11

from tnt_engine.config import Settings
from tnt_engine.crypto.interface import CryptoBackend
from tnt_engine.crypto.pkcs11_session import PKCS11SessionPool
from tnt_engine.errors import EncryptionError, HSMError
from tnt_engine.logging import get_logger
from tnt_engine.metrics import CRYPTO_ERRORS, CRYPTO_LATENCY

logger = get_logger(__name__)

# GCM parameters
_GCM_IV_SIZE = 12  # NIST recommended IV size for AES-GCM
_GCM_TAG_BITS = 128  # 16 bytes


class HSMCryptoBackend(CryptoBackend):
    """Production HSM-backed implementation using PKCS#11.

    Requires a configured HSM or SoftHSM2 with:
      - An AES-256 key for encryption (label from settings)
      - An HMAC key for SHA-256 HMAC (label from settings)
    """

    def __init__(self, settings: Settings, session_pool: PKCS11SessionPool) -> None:
        self._pool = session_pool
        self._encrypt_key_label = settings.hsm_encrypt_key_label
        self._hmac_key_label = settings.hsm_hmac_key_label
        self._timeout = settings.hsm_operation_timeout_seconds
        # Key version — incremented when HSM keys are rotated
        # In production this would be read from key metadata
        self._key_version = 1

    # ── HMACService ──────────────────────────────────────────────────

    async def hmac(self, plaintext: str, key_name: str | None = None) -> str:
        label = key_name or self._hmac_key_label
        t0 = time.monotonic()
        try:
            result = await asyncio.wait_for(
                self._run_hmac(plaintext.encode(), label),
                timeout=self._timeout,
            )
            CRYPTO_LATENCY.labels(operation="hmac").observe(time.monotonic() - t0)
            return result
        except asyncio.TimeoutError:
            CRYPTO_ERRORS.labels(operation="hmac").inc()
            raise EncryptionError("hmac", "HSM operation timed out")
        except (HSMError, EncryptionError):
            CRYPTO_ERRORS.labels(operation="hmac").inc()
            raise
        except Exception as exc:
            CRYPTO_ERRORS.labels(operation="hmac").inc()
            raise EncryptionError("hmac", str(exc)) from exc

    async def _run_hmac(self, data: bytes, label: str) -> str:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, partial(self._hmac_sync, data, label))

    def _hmac_sync(self, data: bytes, label: str) -> str:
        session = self._pool.acquire(timeout=self._timeout)
        try:
            key = self._pool.find_key(session, label)
            mechanism = PyKCS11.Mechanism(PyKCS11.CKM_SHA256_HMAC)
            # Sign == HMAC for symmetric keys
            signature = session.sign(key, data, mechanism)
            return bytes(signature).hex()
        except HSMError:
            raise
        except PyKCS11.PyKCS11Error as exc:
            raise EncryptionError("hmac", str(exc)) from exc
        finally:
            self._pool.release(session)

    # ── EncryptionService ────────────────────────────────────────────

    async def encrypt(self, plaintext: str, key_name: str | None = None) -> tuple[str, int]:
        label = key_name or self._encrypt_key_label
        t0 = time.monotonic()
        try:
            ciphertext = await asyncio.wait_for(
                self._run_encrypt(plaintext.encode(), label),
                timeout=self._timeout,
            )
            CRYPTO_LATENCY.labels(operation="encrypt").observe(time.monotonic() - t0)
            return ciphertext, self._key_version
        except asyncio.TimeoutError:
            CRYPTO_ERRORS.labels(operation="encrypt").inc()
            raise EncryptionError("encrypt", "HSM operation timed out")
        except (HSMError, EncryptionError):
            CRYPTO_ERRORS.labels(operation="encrypt").inc()
            raise
        except Exception as exc:
            CRYPTO_ERRORS.labels(operation="encrypt").inc()
            raise EncryptionError("encrypt", str(exc)) from exc

    async def _run_encrypt(self, data: bytes, label: str) -> str:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, partial(self._encrypt_sync, data, label))

    def _encrypt_sync(self, data: bytes, label: str) -> str:
        session = self._pool.acquire(timeout=self._timeout)
        try:
            key = self._pool.find_key(session, label)
            iv = os.urandom(_GCM_IV_SIZE)
            mechanism = PyKCS11.AES_GCM_Mechanism(iv, b"", _GCM_TAG_BITS)
            encrypted = session.encrypt(key, data, mechanism)
            # Pack: iv + encrypted (which includes GCM tag)
            packed = iv + bytes(encrypted)
            b64 = base64.b64encode(packed).decode()
            return f"hsm:v{self._key_version}:{b64}"
        except PyKCS11.PyKCS11Error as exc:
            raise EncryptionError("encrypt", str(exc)) from exc
        finally:
            self._pool.release(session)

    async def decrypt(
        self, ciphertext: str, key_version: int, key_name: str | None = None
    ) -> str:
        label = key_name or self._encrypt_key_label
        t0 = time.monotonic()
        try:
            plaintext = await asyncio.wait_for(
                self._run_decrypt(ciphertext, label),
                timeout=self._timeout,
            )
            CRYPTO_LATENCY.labels(operation="decrypt").observe(time.monotonic() - t0)
            return plaintext
        except asyncio.TimeoutError:
            CRYPTO_ERRORS.labels(operation="decrypt").inc()
            raise EncryptionError("decrypt", "HSM operation timed out")
        except (HSMError, EncryptionError):
            CRYPTO_ERRORS.labels(operation="decrypt").inc()
            raise
        except Exception as exc:
            CRYPTO_ERRORS.labels(operation="decrypt").inc()
            raise EncryptionError("decrypt", str(exc)) from exc

    async def _run_decrypt(self, ciphertext: str, label: str) -> str:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, partial(self._decrypt_sync, ciphertext, label))

    def _decrypt_sync(self, ciphertext: str, label: str) -> str:
        # Parse "hsm:v<N>:<base64>" format
        try:
            parts = ciphertext.split(":", 2)
            if len(parts) != 3 or parts[0] != "hsm":
                raise EncryptionError("decrypt", f"Invalid HSM ciphertext format: {ciphertext[:20]}")
            packed = base64.b64decode(parts[2])
        except (ValueError, IndexError) as exc:
            raise EncryptionError("decrypt", f"Malformed ciphertext: {exc}") from exc

        if len(packed) < _GCM_IV_SIZE + 1:
            raise EncryptionError("decrypt", "Ciphertext too short")

        iv = packed[:_GCM_IV_SIZE]
        encrypted_data = packed[_GCM_IV_SIZE:]

        session = self._pool.acquire(timeout=self._timeout)
        try:
            key = self._pool.find_key(session, label)
            mechanism = PyKCS11.AES_GCM_Mechanism(iv, b"", _GCM_TAG_BITS)
            decrypted = session.decrypt(key, encrypted_data, mechanism)
            return bytes(decrypted).decode()
        except PyKCS11.PyKCS11Error as exc:
            raise EncryptionError("decrypt", str(exc)) from exc
        finally:
            self._pool.release(session)

    async def close(self) -> None:
        self._pool.close()
        logger.info("hsm_crypto_backend_closed")
