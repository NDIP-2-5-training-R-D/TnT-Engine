import asyncio
import enum
import logging
import time
from collections.abc import Awaitable, Callable
from typing import TypeVar

from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt, wait_exponential

from crypto_adapter.auth.exceptions import CircuitBreakerOpenError, OpenBaoUnavailableError

logger = logging.getLogger(__name__)

T = TypeVar("T")


async def with_retry(coro_func: Callable[[], Awaitable[T]]) -> T:
    """Retry a coroutine on OpenBaoUnavailableError (but not CircuitBreakerOpenError)."""

    def _should_retry(exc: BaseException) -> bool:
        return isinstance(exc, OpenBaoUnavailableError) and not isinstance(
            exc, CircuitBreakerOpenError
        )

    async for attempt in AsyncRetrying(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=0.5, min=0.5, max=4),
        retry=retry_if_exception(_should_retry),
        before_sleep=lambda retry_state: logger.warning(
            "Retry attempt %d after error: %s",
            retry_state.attempt_number,
            retry_state.outcome.exception() if retry_state.outcome else "unknown",
        ),
        reraise=True,
    ):
        with attempt:
            try:
                return await asyncio.wait_for(coro_func(), timeout=2.0)
            except asyncio.TimeoutError as exc:
                raise OpenBaoUnavailableError("Request timed out after 2s") from exc

    raise RuntimeError("Unreachable")  # tenacity always raises or returns


class CircuitBreakerState(enum.Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


class CircuitBreaker:
    """
    Three-state circuit breaker: CLOSED → OPEN → HALF_OPEN → CLOSED.

    Only OpenBaoUnavailableError increments the failure counter.
    All other exceptions pass through without affecting state.
    """

    def __init__(
        self,
        failure_threshold: int = 5,
        recovery_timeout: float = 30.0,
    ) -> None:
        self._failure_threshold = failure_threshold
        self._recovery_timeout = recovery_timeout
        self._state = CircuitBreakerState.CLOSED
        self._failure_count = 0
        self._opened_at: float | None = None
        self._lock = asyncio.Lock()

    @property
    def state(self) -> CircuitBreakerState:
        return self._state

    async def call(self, coro_func: Callable[[], Awaitable[T]]) -> T:
        async with self._lock:
            if self._state == CircuitBreakerState.OPEN:
                elapsed = time.monotonic() - (self._opened_at or 0.0)
                if elapsed >= self._recovery_timeout:
                    self._state = CircuitBreakerState.HALF_OPEN
                    logger.info("Circuit breaker transitioning to HALF_OPEN after %.1fs", elapsed)
                else:
                    raise CircuitBreakerOpenError(
                        f"Circuit breaker is OPEN. Retry after {self._recovery_timeout - elapsed:.1f}s"
                    )
            # CLOSED or HALF_OPEN — allow the call through

        try:
            result = await coro_func()
        except OpenBaoUnavailableError:
            await self._record_failure()
            raise
        else:
            await self._record_success()
            return result

    async def _record_success(self) -> None:
        async with self._lock:
            if self._state != CircuitBreakerState.CLOSED:
                logger.info("Circuit breaker closing (recovered from %s)", self._state.value)
            self._failure_count = 0
            self._state = CircuitBreakerState.CLOSED

    async def _record_failure(self) -> None:
        async with self._lock:
            self._failure_count += 1
            if (
                self._state == CircuitBreakerState.HALF_OPEN
                or self._failure_count >= self._failure_threshold
            ):
                self._state = CircuitBreakerState.OPEN
                self._opened_at = time.monotonic()
                logger.warning(
                    "Circuit breaker OPENED after %d failure(s)", self._failure_count
                )
