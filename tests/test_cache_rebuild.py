"""Tests for the cache rebuild worker."""

from __future__ import annotations

import pytest

from tnt_engine.config import Settings
from tnt_engine.workers.cache_rebuild import CacheRebuildWorker
from tests.conftest import FakeLayeredCache, FakeTokenRepository, TENANT

T = TENANT


class TestCacheRebuildWorker:
    @pytest.fixture
    def repo(self) -> FakeTokenRepository:
        return FakeTokenRepository()

    @pytest.fixture
    def cache(self) -> FakeLayeredCache:
        return FakeLayeredCache()

    async def test_rebuild_populates_cache(
        self, repo: FakeTokenRepository, cache: FakeLayeredCache
    ) -> None:
        # Insert some tokens into the repo
        await repo.upsert_token("tok_a", "enc", "T", 1, "h_a", T)
        await repo.upsert_token("tok_b", "enc", "T", 1, "h_b", T)

        worker = CacheRebuildWorker(repo, cache, Settings())  # type: ignore[arg-type]
        total = await worker.run()
        assert total == 2

        # Verify cache was populated
        assert await cache.get("h_a", T) == "tok_a"
        assert await cache.get("h_b", T) == "tok_b"

    async def test_rebuild_empty_db(
        self, repo: FakeTokenRepository, cache: FakeLayeredCache
    ) -> None:
        worker = CacheRebuildWorker(repo, cache, Settings())  # type: ignore[arg-type]
        total = await worker.run()
        assert total == 0
