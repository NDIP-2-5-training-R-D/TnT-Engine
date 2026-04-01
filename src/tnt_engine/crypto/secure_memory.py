"""Secure memory handling for sensitive plaintext data.

Python strings are immutable and cannot be reliably zeroed out.
This module provides a mutable buffer that overwrites its contents
when the context exits, minimizing the window where plaintext
resides in memory.

Usage:
    async with secure_plaintext(decrypt_coro) as plaintext:
        ciphertext, version = await encrypt(plaintext)
    # plaintext buffer is zeroed here

Limitations:
  - Python's garbage collector may still hold copies in internal buffers
  - This is defense-in-depth, not a guarantee — true memory protection
    requires HSM-only processing (R1) where plaintext never enters app memory
  - The bytearray is zeroed on exit, but any str() conversions create copies
"""

from __future__ import annotations

import time
from contextlib import asynccontextmanager
from typing import AsyncIterator

from tnt_engine.logging import get_logger
from tnt_engine.metrics import REENCRYPT_PLAINTEXT_EXPOSURE

logger = get_logger(__name__)


class SecureBuffer:
    """A mutable buffer that can be explicitly zeroed.

    Holds plaintext as a bytearray so it can be overwritten in-place
    when no longer needed, unlike Python's immutable str/bytes.
    """

    __slots__ = ("_data", "_cleared")

    def __init__(self, data: str) -> None:
        self._data = bytearray(data.encode("utf-8"))
        self._cleared = False

    def to_str(self) -> str:
        """Return the plaintext as a string. Use sparingly — creates an immutable copy."""
        if self._cleared:
            raise ValueError("SecureBuffer has been cleared")
        return self._data.decode("utf-8")

    def clear(self) -> None:
        """Overwrite the buffer with zeros and mark as cleared."""
        if not self._cleared:
            for i in range(len(self._data)):
                self._data[i] = 0
            self._cleared = True

    @property
    def is_cleared(self) -> bool:
        return self._cleared

    def __del__(self) -> None:
        self.clear()

    def __repr__(self) -> str:
        if self._cleared:
            return "SecureBuffer(cleared)"
        return f"SecureBuffer({len(self._data)} bytes)"


@asynccontextmanager
async def secure_plaintext(plaintext: str) -> AsyncIterator[SecureBuffer]:
    """Context manager that wraps plaintext in a SecureBuffer and tracks exposure time.

    The buffer is zeroed when the context exits, and the exposure
    duration is recorded to the REENCRYPT_PLAINTEXT_EXPOSURE histogram.

    Usage:
        async with secure_plaintext(decrypted_value) as buf:
            new_ct, new_ver = await encrypt(buf.to_str())
        # buf is zeroed, exposure time recorded
    """
    buf = SecureBuffer(plaintext)
    t0 = time.monotonic()
    try:
        yield buf
    finally:
        buf.clear()
        elapsed = time.monotonic() - t0
        REENCRYPT_PLAINTEXT_EXPOSURE.observe(elapsed)
