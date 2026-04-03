"""Abstract interfaces for cryptographic operations.

Separated into two concerns:
- HMACService: deterministic hashing for convergent lookups
- EncryptionService: encrypt/decrypt for value storage

Business logic depends on these interfaces, never on concrete implementations.
"""

from __future__ import annotations

import abc


class HMACService(abc.ABC):
    """Compute deterministic HMACs for convergent tokenization lookups."""

    @abc.abstractmethod
    async def hmac(self, plaintext: str, key_name: str | None = None) -> str:
        """Compute HMAC of plaintext. Returns stable string digest."""
        ...


class EncryptionService(abc.ABC):
    """Encrypt/decrypt values via an external transit engine."""

    @abc.abstractmethod
    async def encrypt(self, plaintext: str, key_name: str | None = None) -> tuple[str, int]:
        """
        Encrypt plaintext.
        Returns (ciphertext, key_version).
        """
        ...

    @abc.abstractmethod
    async def decrypt(self, ciphertext: str, key_version: int, key_name: str | None = None) -> str:
        """Decrypt ciphertext using the specified key version."""
        ...


class CryptoBackend(HMACService, EncryptionService, abc.ABC):
    """Combined backend that provides both HMAC and encryption."""

    @abc.abstractmethod
    async def close(self) -> None:
        """Release underlying connections."""
        ...
