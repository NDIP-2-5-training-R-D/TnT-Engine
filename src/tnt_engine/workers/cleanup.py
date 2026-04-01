"""Background worker: expire stale tokens + clean dedup table.

Runs on a configurable interval. Uses SKIP LOCKED to avoid
contention with other instances in a multi-replica deployment.
"""

from __future__ import annotations

import asyncio

from tnt_engine.config import Settings
from tnt_engine.db.repository import TokenRepository
from tnt_engine.logging import get_logger

logger = get_logger(__name__)


class CleanupWorker:
    def __init__(self, repo: TokenRepository, settings: Settings) -> None:
        self._repo = repo
        self._interval = settings.worker_cleanup_interval_seconds
        self._batch_size = settings.worker_cleanup_batch_size
        self._dedup_ttl = settings.dedup_ttl_seconds
        self._running = False
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        self._running = True
        self._task = asyncio.create_task(self._loop())
        logger.info("cleanup_worker_started", interval=self._interval)

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("cleanup_worker_stopped")

    async def _loop(self) -> None:
        while self._running:
            try:
                await self._run_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("cleanup_worker_error")
            await asyncio.sleep(self._interval)

    async def _run_once(self) -> None:
        # Expire tokens past their expires_at
        expired_count = await self._repo.expire_stale_tokens(self._batch_size)
        if expired_count > 0:
            logger.info("tokens_expired", count=expired_count)

        # Clean old dedup entries
        dedup_count = await self._repo.cleanup_dedup(self._dedup_ttl)
        if dedup_count > 0:
            logger.info("dedup_cleaned", count=dedup_count)

    async def run_once(self) -> tuple[int, int]:
        """Run a single cleanup cycle. Returns (expired_count, dedup_count)."""
        expired = await self._repo.expire_stale_tokens(self._batch_size)
        dedup = await self._repo.cleanup_dedup(self._dedup_ttl)
        return expired, dedup
