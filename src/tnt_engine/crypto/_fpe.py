"""Shared FF3-1 Format-Preserving Encryption helper.

Implements FPE using the ``ff3`` library (NIST SP 800-38G Rev 1).

Character-class strategy (format-preserving)
---------------------------------------------
Each character class is encrypted independently with its own FF3Cipher so that:
  * Digits     → Digits    (radix=10,  minlen=6)
  * Uppercase  → Uppercase (radix=26,  minlen=5)
  * Lowercase  → Lowercase (radix=26,  minlen=5)
  * Separators (spaces, dashes, slashes …) → unchanged

Classes that do not meet their minimum length are left unchanged.
The function never fails silently — if the caller wants to know whether
encryption actually happened, compare the return value to the input.

Examples::

    "123-45-6789"   → "371-40-8010"   (9 digits encrypted, dashes preserved)
    "JOHNSMITH"     → "QEDCIYXQY"     (9 uppercase letters encrypted)
    "john smith"    → "kjpn rvajb"    (9 lowercase letters encrypted, space preserved)
    "John"          → "John"          (J=1 upper, ohn=3 lower — both below minlen)
"""

from __future__ import annotations

_DIGITS = "0123456789"
_UPPER  = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_LOWER  = "abcdefghijklmnopqrstuvwxyz"

# Minimum plaintext length per alphabet (FF3-1 constraint: ceil(log_radix(1_000_000)))
_MIN_DIGITS = 6  # radix=10
_MIN_ALPHA  = 5  # radix=26


def ff3_fpe_encrypt(
    plaintext: str,
    dek: bytes,
    tweak: bytes | None = None,
) -> str:
    """Encrypt *plaintext* using FF3-1, preserving format character-class–by–class.

    Each character class (digit / uppercase / lowercase) is encrypted independently
    with the appropriate FF3Cipher so that the output has the exact same structure
    as the input.  Separator characters and character classes whose count falls
    below the FF3-1 minimum are left unchanged.

    Args:
        plaintext: The value to transform.
        dek:       32-byte Data Encryption Key (AES-256).  Caller is responsible
                   for zeroizing the source ``bytearray`` after this call.
        tweak:     7-byte FF3-1 tweak; defaults to all-zero bytes if omitted.

    Returns:
        Format-preserved string.  Returns *plaintext* unchanged only if every
        character class present has fewer characters than FF3-1 requires
        (digits < 6, uppercase < 5, lowercase < 5).
    """
    from ff3 import FF3Cipher  # deferred — not installed in all environments

    if tweak is None:
        tweak = b"\x00" * 7

    key_hex   = dek.hex()      # 32 bytes → 64-char hex string
    tweak_hex = tweak.hex()    # 7 bytes  → 14-char hex string

    result = list(plaintext)

    # ── Digits (radix=10, minlen=6) ───────────────────────────────────
    digit_pos = [(i, ch) for i, ch in enumerate(plaintext) if ch in _DIGITS]
    if len(digit_pos) >= _MIN_DIGITS:
        digit_str = "".join(ch for _, ch in digit_pos)
        c_digit = FF3Cipher(key_hex, tweak_hex, radix=10)
        enc = c_digit.encrypt(digit_str)
        for seq_i, (pos, _) in enumerate(digit_pos):
            result[pos] = enc[seq_i]

    # ── Uppercase letters (radix=26, minlen=5) ────────────────────────
    upper_pos = [(i, ch) for i, ch in enumerate(plaintext) if ch in _UPPER]
    if len(upper_pos) >= _MIN_ALPHA:
        upper_str = "".join(ch for _, ch in upper_pos)
        c_upper = FF3Cipher.withCustomAlphabet(key_hex, tweak_hex, _UPPER)
        enc = c_upper.encrypt(upper_str)
        for seq_i, (pos, _) in enumerate(upper_pos):
            result[pos] = enc[seq_i]

    # ── Lowercase letters (radix=26, minlen=5) ────────────────────────
    lower_pos = [(i, ch) for i, ch in enumerate(plaintext) if ch in _LOWER]
    if len(lower_pos) >= _MIN_ALPHA:
        lower_str = "".join(ch for _, ch in lower_pos)
        c_lower = FF3Cipher.withCustomAlphabet(key_hex, tweak_hex, _LOWER)
        enc = c_lower.encrypt(lower_str)
        for seq_i, (pos, _) in enumerate(lower_pos):
            result[pos] = enc[seq_i]

    return "".join(result)
