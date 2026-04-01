"""Unit tests for L1 in-memory cache and layered cache logic."""

from __future__ import annotations

import time

import pytest

from tnt_engine.cache.memory import L1Cache


class TestL1Cache:
    def test_set_get(self) -> None:
        c = L1Cache(max_size=10, ttl_seconds=60)
        c.set("k1", "v1")
        assert c.get("k1") == "v1"

    def test_miss(self) -> None:
        c = L1Cache()
        assert c.get("missing") is None

    def test_ttl_expiry(self) -> None:
        c = L1Cache(max_size=10, ttl_seconds=0)  # instant expiry
        c.set("k1", "v1")
        # Entry is expired immediately (ttl=0 → expires_at is in the past or exactly now)
        # We need a tiny sleep to ensure monotonic clock advances
        time.sleep(0.001)
        assert c.get("k1") is None

    def test_lru_eviction(self) -> None:
        c = L1Cache(max_size=3, ttl_seconds=60)
        c.set("a", "1")
        c.set("b", "2")
        c.set("c", "3")
        c.set("d", "4")  # evicts "a"
        assert c.get("a") is None
        assert c.get("b") == "2"
        assert c.size == 3

    def test_get_multi(self) -> None:
        c = L1Cache(max_size=10, ttl_seconds=60)
        c.set("a", "1")
        c.set("b", "2")
        result = c.get_multi(["a", "b", "c"])
        assert result == {"a": "1", "b": "2", "c": None}

    def test_delete(self) -> None:
        c = L1Cache()
        c.set("k", "v")
        c.delete("k")
        assert c.get("k") is None

    def test_clear(self) -> None:
        c = L1Cache()
        c.set("a", "1")
        c.set("b", "2")
        c.clear()
        assert c.size == 0


class TestFakeLayeredCache:
    """Test the FakeLayeredCache from conftest to validate test infra."""

    async def test_tenant_scoped(self) -> None:
        from tests.conftest import FakeLayeredCache

        cache = FakeLayeredCache()
        await cache.set("hash1", "tenant_a", "tok_a")
        await cache.set("hash1", "tenant_b", "tok_b")

        assert await cache.get("hash1", "tenant_a") == "tok_a"
        assert await cache.get("hash1", "tenant_b") == "tok_b"
        assert await cache.get("hash1", "tenant_c") is None

    async def test_multi(self) -> None:
        from tests.conftest import FakeLayeredCache

        cache = FakeLayeredCache()
        await cache.set_multi({"h1": "t1", "h2": "t2"}, "ten")
        result = await cache.get_multi(["h1", "h2", "h3"], "ten")
        assert result["h1"] == "t1"
        assert result["h2"] == "t2"
        assert result["h3"] is None
