"""L1 in-memory LRU cache with TTL.

Process-local, zero-latency cache. Sits in front of Redis (L2).
Uses OrderedDict for LRU eviction and per-entry TTL expiry.
Thread-safe via asyncio (single-threaded event loop).
"""

from __future__ import annotations

import time
from collections import OrderedDict


class L1Cache:
    """In-memory LRU cache with per-entry TTL."""

    def __init__(self, max_size: int = 10_000, ttl_seconds: int = 300) -> None:
        self._max_size = max_size
        self._ttl = ttl_seconds
        self._store: OrderedDict[str, tuple[str, float]] = OrderedDict()

    def get(self, key: str) -> str | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        value, expires_at = entry
        if time.monotonic() > expires_at:
            del self._store[key]
            return None
        # Move to end (most recently used)
        self._store.move_to_end(key)
        return value

    def set(self, key: str, value: str) -> None:
        if key in self._store:
            self._store.move_to_end(key)
        self._store[key] = (value, time.monotonic() + self._ttl)
        if len(self._store) > self._max_size:
            self._store.popitem(last=False)

    def delete(self, key: str) -> None:
        self._store.pop(key, None)

    def get_multi(self, keys: list[str]) -> dict[str, str | None]:
        return {k: self.get(k) for k in keys}

    def set_multi(self, mapping: dict[str, str]) -> None:
        for k, v in mapping.items():
            self.set(k, v)

    def clear(self) -> None:
        self._store.clear()

    @property
    def size(self) -> int:
        return len(self._store)
