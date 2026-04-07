"""Abstract interfaces for cryptographic operations.

Separated into three concerns:
- HMACService:      deterministic hashing for convergent lookups
- EncryptionService: encrypt/decrypt for value storage
- AdvancedCrypto:   HMAC-SHA-512, AES-256-GCM96 ciphertext, FF3-1 FPE

Business logic depends on these interfaces, never on concrete implementations.
"""

from __future__ import annotations

import abc


class HMACService(abc.ABC):
    """Compute deterministic HMACs for convergent tokenization lookups."""

    @abc.abstractmethod
    async def hmac(self, plaintext: str, key_name: str | None = None) -> str:
        """Compute HMAC-SHA-256 of plaintext. Returns stable string digest."""
        ...

    @abc.abstractmethod
    async def hmac_sha512(self, plaintext: str, key_name: str | None = None) -> str:
        """Compute HMAC-SHA-512 of plaintext. Returns 128-char hex digest.

        OpenBao: POST /transit/hmac/{key} with algorithm=sha2-512
        Sandbox: stdlib hmac with sha512
        """
        ...


class EncryptionService(abc.ABC):
    """Encrypt/decrypt values via an external transit engine."""

    @abc.abstractmethod
    async def encrypt(self, plaintext: str, key_name: str | None = None) -> tuple[str, int]:
        """Encrypt plaintext (AES-256-GCM96 via Transit).
        Returns (ciphertext, key_version).
        """
        ...

    @abc.abstractmethod
    async def decrypt(self, ciphertext: str, key_version: int, key_name: str | None = None) -> str:
        """Decrypt ciphertext using the specified key version."""
        ...

    @abc.abstractmethod
    async def encrypt_aes256_gcm96(
        self, plaintext: str, key_name: str | None = None
    ) -> tuple[str, int]:
        """Encrypt with AES-256-GCM96, returning raw ciphertext (not an opaque token).

        OpenBao: POST /transit/encrypt/{aes_gcm_key} — same endpoint as encrypt()
                 but uses the dedicated aes-gcm transit key.
        Sandbox: cryptography.hazmat AES-GCM with a fixed sandbox key.
        Format: <iv_b64url>.<ciphertext_b64url>.<authtag_b64url>
        Returns (ciphertext_str, key_version).
        """
        ...

    @abc.abstractmethod
    async def fpe_ff31(self, plaintext: str, key_name: str | None = None) -> str:
        """Format-Preserving Encryption (FF3-1 / NIST SP 800-38G).

        Preserves: digit→digit, upper→upper, lower→lower, separators unchanged.

        OpenBao: POST /transit/encrypt/{fpe_key} with a key configured for FPE.
                 Returns vault ciphertext; for display in playground the raw FPE
                 output is derived via a Feistel round using the HMAC key.
        Sandbox: Feistel-network FPE simulation using HMAC-SHA-256 round function.

        Returns the format-preserved encrypted string.
        """
        ...


class CryptoBackend(HMACService, EncryptionService, abc.ABC):
    """Combined backend that provides HMAC, encryption, and advanced crypto."""

    @abc.abstractmethod
    async def close(self) -> None:
        """Release underlying connections."""
        ...
