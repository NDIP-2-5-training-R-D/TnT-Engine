"""Circuit breaker wrapper for CryptoBackend.

States:
  CLOSED  — requests flow through normally; failures are counted
  OPEN    — requests are immediately rejected; after recovery_timeout, transition to HALF_OPEN
  HALF_OPEN — allow a limited number of probe requests; if they succeed, close; if they fail, reopen

This is async-safe: it uses an asyncio.Lock to protect state transitions.
"""

from __future__ import annotations

import asyncio
import enum
import time

from tnt_engine.crypto.interface import CryptoBackend, EncryptionService, HMACService
from tnt_engine.errors import CryptoServiceUnavailableError
from tnt_engine.logging import get_logger

logger = get_logger(__name__)


class _State(enum.Enum):
    CLOSED = "CLOSED"
    OPEN = "OPEN"
    HALF_OPEN = "HALF_OPEN"


class CircuitBreakerBackend(CryptoBackend):
    """Wraps a CryptoBackend with circuit breaker protection."""

    def __init__(
        self,
        backend: CryptoBackend,
        failure_threshold: int = 5,
        recovery_timeout: float = 30.0,
        half_open_max_calls: int = 3,
    ) -> None:
        self._backend = backend
        self._failure_threshold = failure_threshold
        self._recovery_timeout = recovery_timeout
        self._half_open_max_calls = half_open_max_calls

        self._state = _State.CLOSED
        self._failure_count = 0
        self._last_failure_time: float = 0
        self._half_open_calls = 0
        self._lock = asyncio.Lock()

    @property
    def state(self) -> str:
        return self._state.value

    # ── HMACService ──────────────────────────────────────────────────

    async def hmac(self, plaintext: str, key_name: str | None = None) -> str:
        await self._check_state()
        try:
            result = await self._backend.hmac(plaintext, key_name)
            await self._on_success()
            return result
        except Exception as exc:
            await self._on_failure()
            raise exc

    async def hmac_sha512(self, plaintext: str, key_name: str | None = None) -> str:
        await self._check_state()
        try:
            result = await self._backend.hmac_sha512(plaintext, key_name)
            await self._on_success()
            return result
        except Exception as exc:
            await self._on_failure()
            raise exc

    # ── EncryptionService ────────────────────────────────────────────

    async def encrypt(self, plaintext: str, key_name: str | None = None) -> tuple[str, int]:
        await self._check_state()
        try:
            result = await self._backend.encrypt(plaintext, key_name)
            await self._on_success()
            return result
        except Exception as exc:
            await self._on_failure()
            raise exc

    async def decrypt(self, ciphertext: str, key_version: int, key_name: str | None = None) -> str:
        await self._check_state()
        try:
            result = await self._backend.decrypt(ciphertext, key_version, key_name)
            await self._on_success()
            return result
        except Exception as exc:
            await self._on_failure()
            raise exc

    async def encrypt_aes256_gcm96(
        self, plaintext: str, key_name: str | None = None
    ) -> tuple[str, int]:
        await self._check_state()
        try:
            result = await self._backend.encrypt_aes256_gcm96(plaintext, key_name)
            await self._on_success()
            return result
        except Exception as exc:
            await self._on_failure()
            raise exc

    async def fpe_ff31(self, plaintext: str, key_name: str | None = None) -> str:
        await self._check_state()
        try:
            result = await self._backend.fpe_ff31(plaintext, key_name)
            await self._on_success()
            return result
        except Exception as exc:
            await self._on_failure()
            raise exc

    async def close(self) -> None:
        await self._backend.close()

    # ── State machine ────────────────────────────────────────────────

    async def _check_state(self) -> None:
        async with self._lock:
            if self._state == _State.CLOSED:
                return
            if self._state == _State.OPEN:
                elapsed = time.monotonic() - self._last_failure_time
                if elapsed >= self._recovery_timeout:
                    logger.info("circuit_breaker_half_open")
                    self._state = _State.HALF_OPEN
                    self._half_open_calls = 0
                else:
                    raise CryptoServiceUnavailableError()
            if self._state == _State.HALF_OPEN:
                if self._half_open_calls >= self._half_open_max_calls:
                    raise CryptoServiceUnavailableError()
                self._half_open_calls += 1

    async def _on_success(self) -> None:
        async with self._lock:
            if self._state == _State.HALF_OPEN:
                logger.info("circuit_breaker_closed")
                self._state = _State.CLOSED
            self._failure_count = 0

    async def _on_failure(self) -> None:
        async with self._lock:
            self._failure_count += 1
            self._last_failure_time = time.monotonic()
            if self._state == _State.HALF_OPEN:
                logger.warning("circuit_breaker_reopened")
                self._state = _State.OPEN
            elif self._failure_count >= self._failure_threshold:
                logger.warning(
                    "circuit_breaker_opened",
                    failure_count=self._failure_count,
                )
                self._state = _State.OPEN
