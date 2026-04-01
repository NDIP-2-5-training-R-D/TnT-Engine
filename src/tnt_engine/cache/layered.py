"""Layered cache: L1 (in-memory) → L2 (Redis) → L3 (DB via caller).

Cache keys are scoped by tenant_id:  "{tenant_id}:{hmac_hash}"

Lookup flow:
  1. L1 hit → return immediately (< 1μs)
  2. L1 miss → check L2 (Redis), backfill L1 on hit
  3. L2 miss → caller falls through to DB, then calls set() to backfill both

Write-through:
  - set() writes to both L1 and L2
  - delete() invalidates both L1 and L2
"""

from __future__ import annotations

from prometheus_client import Counter

from tnt_engine.cache.memory import L1Cache
from tnt_engine.cache.redis import TokenCache
from tnt_engine.config import Settings

L1_HIT = Counter("tnt_l1_cache_hits_total", "L1 in-memory cache hits")
L1_MISS = Counter("tnt_l1_cache_misses_total", "L1 in-memory cache misses")


def _key(tenant_id: str, hmac_hash: str) -> str:
    return f"{tenant_id}:{hmac_hash}"


class LayeredCache:
    """L1 (memory) + L2 (Redis) cache with tenant-scoped keys."""

    def __init__(self, l2: TokenCache, settings: Settings) -> None:
        self._l1 = L1Cache(max_size=settings.l1_max_size, ttl_seconds=settings.l1_ttl_seconds)
        self._l2 = l2

    async def get(self, hmac_hash: str, tenant_id: str) -> str | None:
        k = _key(tenant_id, hmac_hash)

        # L1
        val = self._l1.get(k)
        if val is not None:
            L1_HIT.inc()
            return val
        L1_MISS.inc()

        # L2
        val = await self._l2.get(k)
        if val is not None:
            self._l1.set(k, val)  # backfill L1
            return val

        return None

    async def set(self, hmac_hash: str, tenant_id: str, token: str) -> None:
        k = _key(tenant_id, hmac_hash)
        self._l1.set(k, token)
        await self._l2.set(k, token)

    async def get_multi(
        self, hmac_hashes: list[str], tenant_id: str
    ) -> dict[str, str | None]:
        if not hmac_hashes:
            return {}

        keys = [_key(tenant_id, h) for h in hmac_hashes]

        # L1 batch
        l1_results = self._l1.get_multi(keys)
        result: dict[str, str | None] = {}
        l2_needed_hashes: list[str] = []
        l2_needed_keys: list[str] = []

        for h, k in zip(hmac_hashes, keys):
            val = l1_results.get(k)
            if val is not None:
                L1_HIT.inc()
                result[h] = val
            else:
                L1_MISS.inc()
                l2_needed_hashes.append(h)
                l2_needed_keys.append(k)

        # L2 batch for misses
        if l2_needed_keys:
            l2_results = await self._l2.get_multi(l2_needed_keys)
            l1_backfill: dict[str, str] = {}
            for h, k in zip(l2_needed_hashes, l2_needed_keys):
                val = l2_results.get(k)
                result[h] = val
                if val is not None:
                    l1_backfill[k] = val

            if l1_backfill:
                self._l1.set_multi(l1_backfill)

        return result

    async def set_multi(
        self, mapping: dict[str, str], tenant_id: str
    ) -> None:
        if not mapping:
            return
        keyed = {_key(tenant_id, h): tok for h, tok in mapping.items()}
        self._l1.set_multi(keyed)
        await self._l2.set_multi(keyed)

    async def delete(self, hmac_hash: str, tenant_id: str) -> None:
        k = _key(tenant_id, hmac_hash)
        self._l1.delete(k)
        await self._l2.delete(k)

    async def close(self) -> None:
        await self._l2.close()

    @property
    def l1_size(self) -> int:
        return self._l1.size
