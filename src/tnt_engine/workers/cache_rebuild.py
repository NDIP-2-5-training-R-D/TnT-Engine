"""Background worker: rebuild cache from DB.

Scans token_lookup joined with token_store (ACTIVE only) and
populates both L1 and L2 caches. Useful after:
  - Redis flush
  - Cold start / new replica
  - Cache corruption recovery
"""

from __future__ import annotations

from tnt_engine.cache.layered import LayeredCache
from tnt_engine.config import Settings
from tnt_engine.db.repository import TokenRepository
from tnt_engine.logging import get_logger

logger = get_logger(__name__)


class CacheRebuildWorker:
    def __init__(
        self,
        repo: TokenRepository,
        cache: LayeredCache,
        settings: Settings,
    ) -> None:
        self._repo = repo
        self._cache = cache
        self._batch_size = settings.worker_cache_rebuild_batch_size

    async def run(self) -> int:
        """Rebuild cache from DB. Returns total entries populated."""
        total = 0
        offset = 0
        while True:
            batch = await self._repo.get_active_lookups_batch(offset, self._batch_size)
            if not batch:
                break

            # Group by tenant for efficient set_multi
            by_tenant: dict[str, dict[str, str]] = {}
            for hmac_hash, tenant_id, token in batch:
                by_tenant.setdefault(tenant_id, {})[hmac_hash] = token

            for tenant_id, mapping in by_tenant.items():
                await self._cache.set_multi(mapping, tenant_id)

            total += len(batch)
            offset += len(batch)
            logger.info("cache_rebuild_progress", populated=total)

        logger.info("cache_rebuild_complete", total=total)
        return total
