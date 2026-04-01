"""Per-tenant sliding window rate limiter.

Prevents brute-force token lookups and abuse by enforcing
request limits per tenant per time window.

Implementation uses an in-memory sliding window counter.
For multi-replica deployments, swap to Redis-based implementation.

Usage:
    limiter = RateLimiter(max_requests=1000, window_seconds=60)
    limiter.check("tenant_acme")  # raises RateLimitExceeded if over limit
"""

from __future__ import annotations

import time
from collections import defaultdict

from prometheus_client import Counter

RATE_LIMIT_EXCEEDED = Counter(
    "tnt_rate_limit_exceeded_total",
    "Rate limit exceeded events",
    ["tenant_id"],
)


class RateLimitExceeded(Exception):
    """Raised when a tenant exceeds the request rate limit."""

    def __init__(self, tenant_id: str, limit: int, window: int) -> None:
        self.tenant_id = tenant_id
        self.limit = limit
        self.window = window
        super().__init__(
            f"Rate limit exceeded for tenant '{tenant_id}': "
            f"{limit} requests per {window}s"
        )


class RateLimiter:
    """Sliding window rate limiter, keyed by tenant_id.

    Thread-safe for asyncio (single event loop). For multi-process
    deployments, implement a Redis-based variant using INCR + EXPIRE.
    """

    def __init__(self, max_requests: int = 5000, window_seconds: int = 60) -> None:
        self._max = max_requests
        self._window = window_seconds
        self._buckets: dict[str, list[float]] = defaultdict(list)

    def check(self, tenant_id: str) -> None:
        """Check rate limit. Raises RateLimitExceeded if over the limit."""
        now = time.monotonic()
        cutoff = now - self._window

        # Prune old entries
        bucket = self._buckets[tenant_id]
        while bucket and bucket[0] < cutoff:
            bucket.pop(0)

        if len(bucket) >= self._max:
            RATE_LIMIT_EXCEEDED.labels(tenant_id=tenant_id).inc()
            raise RateLimitExceeded(tenant_id, self._max, self._window)

        bucket.append(now)

    def get_remaining(self, tenant_id: str) -> int:
        """Return how many requests remain in the current window."""
        now = time.monotonic()
        cutoff = now - self._window
        bucket = self._buckets.get(tenant_id, [])
        active = sum(1 for t in bucket if t >= cutoff)
        return max(0, self._max - active)

    def reset(self, tenant_id: str) -> None:
        """Reset rate limit for a tenant (admin operation)."""
        self._buckets.pop(tenant_id, None)
