"""
Format-Preserving Encryption (FF3-1) tokenizer for phone numbers.
Uses ff3 library - same algorithm as Vault Enterprise Transform engine.

Key and tweak are read from environment:
  FPE_KEY   - 32-byte hex string (AES-256), default: dev key (DO NOT use in prod)
  FPE_TWEAK - 14-char hex string (7 bytes),  default: dev tweak
"""
import os
import logging
from ff3 import FF3Cipher

log = logging.getLogger(__name__)

# Dev defaults — override via env in production
_DEFAULT_KEY   = "2DE79D232DF5585D68CE47882AE256D6"   # 16-byte hex = AES-128 (ff3 requires 16/24/32-byte hex)
_DEFAULT_TWEAK = "CBD09280979564"                      # 7-byte hex (14 hex chars)

RADIX = 10  # digits 0-9


def _get_cipher() -> FF3Cipher:
    key   = os.getenv("FPE_KEY",   _DEFAULT_KEY)
    tweak = os.getenv("FPE_TWEAK", _DEFAULT_TWEAK)
    return FF3Cipher(key, tweak, RADIX)


def tokenize_phone(phone: str) -> str:
    """
    Encrypt a 10-digit phone number, returning another 10-digit string.
    Raises ValueError if input is not exactly 10 digits.
    """
    if not (phone.isdigit() and len(phone) == 10):
        raise ValueError(f"Phone must be exactly 10 digits, got: len={len(phone)}")
    cipher = _get_cipher()
    result = cipher.encrypt(phone)
    log.debug("tokenize_phone: input_len=10 -> output_len=%d", len(result))
    return result


def detokenize_phone(token: str) -> str:
    """
    Decrypt a tokenized 10-digit string back to the original phone number.
    """
    if not (token.isdigit() and len(token) == 10):
        raise ValueError(f"Token must be exactly 10 digits, got: len={len(token)}")
    cipher = _get_cipher()
    result = cipher.decrypt(token)
    log.debug("detokenize_phone: OK")
    return result


if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)
    phone   = "0912345678"
    token   = tokenize_phone(phone)
    decoded = detokenize_phone(token)
    print(f"Original : {phone}")
    print(f"Token    : {token}")
    print(f"Decoded  : {decoded}")
    print(f"Match    : {decoded == phone}")
