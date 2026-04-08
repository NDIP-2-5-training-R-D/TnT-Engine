"""Shared FF3-1 Format-Preserving Encryption helper.

Implements digit-preserving FPE using the ``ff3`` library (NIST SP 800-38G Rev 1).

Strategy
--------
1. Extract every decimal-digit character, noting its original position.
2. Run FF3-1 on that digit-only string (radix = 10, AES-256 key).
3. Reconstruct the original string: encrypted digits at their original positions,
   separator characters (dashes, spaces, slashes, …) left unchanged.

Examples::

    SSN  "123-45-6789"    → "XYZ-AB-CDEF"   (dashes preserved)
    CC   "1234 5678 9012" → "XYZW ABCD EFGH" (spaces preserved)

Minimum 6 digit characters are required (FF3-1 constraint for radix = 10).
Inputs with fewer than 6 digits are returned unchanged; no error is raised,
so callers can safely pass arbitrary field values.
"""

from __future__ import annotations

# Minimum plaintext length for FF3-1 with radix=10 (ceil(log10(1_000_000)) = 6)
_MIN_DIGITS = 6


def ff3_fpe_encrypt(
    plaintext: str,
    dek: bytes,
    tweak: bytes | None = None,
) -> str:
    """Encrypt decimal digits in *plaintext* using FF3-1, preserving format.

    Args:
        plaintext: The value to transform.  Non-digit characters are unchanged.
        dek:       32-byte Data Encryption Key (AES-256).  Caller is responsible
                   for zeroizing the source ``bytearray`` after this call.
        tweak:     7-byte FF3-1 tweak; defaults to all-zero bytes if omitted.

    Returns:
        Format-preserved string identical in structure to *plaintext* but with
        digit characters replaced by their FF3-1 encrypted equivalents.
        Returns *plaintext* unchanged when fewer than 6 digit characters are
        present (FF3-1 minimum-length constraint for radix = 10).
    """
    from ff3 import FF3Cipher  # deferred — not installed in all environments

    if tweak is None:
        tweak = b"\x00" * 7

    # ── Extract digit characters and remember their positions ──────────
    digit_positions: list[tuple[int, str]] = [
        (i, ch) for i, ch in enumerate(plaintext) if ch.isdigit()
    ]
    digit_str = "".join(ch for _, ch in digit_positions)

    if len(digit_str) < _MIN_DIGITS:
        # Too short for FF3-1 at radix=10 — return plaintext unchanged.
        return plaintext

    key_hex = dek.hex()      # 32 bytes → 64-char hex string
    tweak_hex = tweak.hex()  # 7 bytes  → 14-char hex string

    cipher = FF3Cipher(key_hex, tweak_hex, radix=10)
    encrypted_digits = cipher.encrypt(digit_str)

    # ── Reconstruct: replace digit positions with encrypted digits ─────
    result = list(plaintext)
    for seq_i, (pos, _) in enumerate(digit_positions):
        result[pos] = encrypted_digits[seq_i]

    return "".join(result)
