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
  - hmac:              SHA-256 HMAC (deterministic, convergent)
  - hmac_sha512:       SHA-512 HMAC (deterministic)
  - encrypt/decrypt:   base64 encoding with "sandbox:v1:" prefix
  - encrypt_aes256_gcm96: AES-256-GCM with fixed sandbox key, returns <iv>.<ct>.<tag>
  - fpe_ff31:          Feistel-network FPE simulation (format-preserving, NOT full FF3-1)
"""

from __future__ import annotations

import base64
import hashlib
import hmac as _hmac
import os

from tnt_engine.crypto.interface import CryptoBackend
from tnt_engine.errors import EnvironmentSafetyError
from tnt_engine.logging import get_logger

logger = get_logger(__name__)

_BLOCKED_ENVIRONMENTS = frozenset({"production", "staging"})

# Fixed sandbox keys — NOT secrets, development-only.
_SANDBOX_HMAC_512_KEY = b"sandbox-hmac-sha512-key"
_SANDBOX_AES_KEY = hashlib.sha256(b"sandbox-aes256-gcm96-key").digest()  # 32 bytes
_SANDBOX_FPE_KEY = b"sandbox-fpe-ff31-key"


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

    # ── HMACService ──────────────────────────────────────────────────

    async def hmac(self, plaintext: str, key_name: str | None = None) -> str:
        return hashlib.sha256(plaintext.encode()).hexdigest()

    async def hmac_sha512(self, plaintext: str, key_name: str | None = None) -> str:
        """HMAC-SHA-512 using fixed sandbox key. Returns 128-char hex digest."""
        digest = _hmac.new(_SANDBOX_HMAC_512_KEY, plaintext.encode(), hashlib.sha512).hexdigest()
        return digest

    # ── EncryptionService ────────────────────────────────────────────

    async def encrypt(self, plaintext: str, key_name: str | None = None) -> tuple[str, int]:
        b64 = base64.b64encode(plaintext.encode()).decode()
        return f"sandbox:v1:{b64}", 1

    async def decrypt(
        self, ciphertext: str, key_version: int, key_name: str | None = None
    ) -> str:
        b64 = ciphertext.split(":", 2)[2]
        return base64.b64decode(b64).decode()

    async def encrypt_aes256_gcm96(
        self, plaintext: str, key_name: str | None = None
    ) -> tuple[str, int]:
        """AES-256-GCM encryption with a 96-bit (12-byte) random nonce.

        Returns (formatted_ciphertext, key_version=1) where:
            formatted_ciphertext = "<iv_b64url>.<ciphertext_b64url>.<authtag_b64url>"
        """
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        nonce = os.urandom(12)  # 96-bit nonce
        aesgcm = AESGCM(_SANDBOX_AES_KEY)
        # AESGCM.encrypt appends 16-byte auth tag to ciphertext
        ct_with_tag = aesgcm.encrypt(nonce, plaintext.encode(), None)
        ct = ct_with_tag[:-16]
        tag = ct_with_tag[-16:]

        formatted = (
            f"{base64.urlsafe_b64encode(nonce).rstrip(b'=').decode()}"
            f".{base64.urlsafe_b64encode(ct).rstrip(b'=').decode()}"
            f".{base64.urlsafe_b64encode(tag).rstrip(b'=').decode()}"
        )
        return formatted, 1

    async def fpe_ff31(self, plaintext: str, key_name: str | None = None) -> str:
        """Format-Preserving Encryption — sandbox Feistel simulation.

        Uses a 4-round Feistel network with HMAC-SHA-256 as the round function.
        The key material is derived from _SANDBOX_FPE_KEY.

        Preserves character class at each position:
          digit → digit  |  upper → upper  |  lower → lower  |  other → unchanged

        NOTE: This is a *simulation* of FPE behaviour for sandbox/testing.
              Production should use the dedicated OpenBao FPE transit key.
        """
        return _feistel_fpe(plaintext, _SANDBOX_FPE_KEY)

    async def close(self) -> None:
        pass


# ── Feistel FPE helper (shared between sandbox and openbao fallback) ──

_DIGITS = "0123456789"
_UPPER  = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_LOWER  = "abcdefghijklmnopqrstuvwxyz"


def _feistel_fpe(plaintext: str, key: bytes, rounds: int = 4) -> str:
    """4-round Feistel FPE over the sequence of alphabet positions.

    Each character is mapped to its index within its alphabet class.
    The Feistel round function is HMAC-SHA-256(key || round || right_half).
    Non-alphabet characters (separators, spaces) are passed through unchanged.
    """
    # Separate out the alphabet characters and their positions
    positions: list[int] = []  # indices into plaintext of alpha chars
    alphabets: list[str] = []  # which alphabet each position belongs to

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

    # Convert to index sequence
    chars = list(plaintext)
    indices = [alphabets[i].index(chars[positions[i]]) for i in range(len(positions))]
    n = len(indices)

    # Split into left / right halves (by position in the indices list)
    split = n // 2
    left  = indices[:split]
    right = indices[split:]

    def _round_fn(r: int, half: list[int]) -> list[int]:
        """Pseudo-random permutation based on HMAC-SHA-256."""
        data = f"{r}:" + ",".join(str(x) for x in half)
        h = _hmac.new(key, data.encode(), hashlib.sha256).digest()
        # Expand hash bytes to cover the other half
        result = []
        for i, idx in enumerate(indices[:split] if r % 2 == 0 else indices[split:]):
            shift = h[i % len(h)]
            alpha = alphabets[positions[i]] if r % 2 == 0 else alphabets[positions[split + i] if split + i < len(positions) else i]
            result.append(shift % len(alpha))
        return result

    # Feistel rounds
    for rnd in range(rounds):
        if rnd % 2 == 0:
            f_out = _round_fn(rnd, right)
            left = [(left[i] + f_out[i % len(f_out)]) % len(alphabets[positions[i]])
                    for i in range(len(left))]
        else:
            f_out = _round_fn(rnd, left)
            right = [(right[i] + f_out[i % len(f_out)]) % len(alphabets[positions[split + i]])
                     for i in range(len(right))]

    # Merge back
    result_indices = left + right
    for seq_i, pos in enumerate(positions):
        chars[pos] = alphabets[seq_i][result_indices[seq_i] % len(alphabets[seq_i])]

    return "".join(chars)
