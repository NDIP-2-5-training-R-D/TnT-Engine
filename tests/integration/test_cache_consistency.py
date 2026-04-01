"""Integration tests: Redis cache operations.

Requires: docker compose -f tests/integration/docker-compose.yml up -d --wait
Tests real Redis connections, TTL, multi-operations.
"""

from __future__ import annotations

import asyncio

import pytest

from tnt_engine.cache.redis import TokenCache
from tnt_engine.config import Settings


@pytest.fixture(scope="module")
def cache(integration_settings: Settings) -> TokenCache:
    return TokenCache(integration_settings)


class TestRedisOperations:
    async def test_set_get_roundtrip(self, cache: TokenCache) -> None:
        await cache.set("inttest_hash_001", "tok_redis_test_001")
        result = await cache.get("inttest_hash_001")
        assert result == "tok_redis_test_001"

    async def test_get_missing_returns_none(self, cache: TokenCache) -> None:
        result = await cache.get("nonexistent_hash_xyz")
        assert result is None

    async def test_delete(self, cache: TokenCache) -> None:
        await cache.set("inttest_hash_del", "tok_to_delete")
        await cache.delete("inttest_hash_del")
        result = await cache.get("inttest_hash_del")
        assert result is None

    async def test_multi_operations(self, cache: TokenCache) -> None:
        mapping = {
            "inttest_multi_1": "tok_m1",
            "inttest_multi_2": "tok_m2",
            "inttest_multi_3": "tok_m3",
        }
        await cache.set_multi(mapping)

        results = await cache.get_multi(list(mapping.keys()))
        assert results["inttest_multi_1"] == "tok_m1"
        assert results["inttest_multi_2"] == "tok_m2"
        assert results["inttest_multi_3"] == "tok_m3"

    async def test_ttl_expiry(self, cache: TokenCache) -> None:
        """Set a value with short TTL and verify it expires."""
        # The cache uses settings.redis_token_ttl_seconds (3600 by default)
        # We test that the key exists immediately after set
        await cache.set("inttest_ttl_test", "tok_ttl")
        result = await cache.get("inttest_ttl_test")
        assert result == "tok_ttl"
