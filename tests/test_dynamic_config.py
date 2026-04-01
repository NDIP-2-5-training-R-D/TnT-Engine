"""Tests for the dynamic configuration system."""

from __future__ import annotations

from tnt_engine.runtime.dynamic_config import DynamicConfig


class TestDynamicConfig:
    def test_defaults(self) -> None:
        cfg = DynamicConfig()
        assert cfg.cache_ttl_seconds == 3600
        assert cfg.crypto_max_retries == 3

    def test_update(self) -> None:
        cfg = DynamicConfig()
        assert cfg.update("cache_ttl_seconds", 1800) is True
        assert cfg.cache_ttl_seconds == 1800

    def test_update_unknown_key(self) -> None:
        cfg = DynamicConfig()
        assert cfg.update("nonexistent", 42) is False

    def test_get(self) -> None:
        cfg = DynamicConfig()
        assert cfg.get("crypto_max_retries") == 3
        assert cfg.get("nonexistent") is None

    def test_to_dict(self) -> None:
        cfg = DynamicConfig()
        d = cfg.to_dict()
        assert "cache_ttl_seconds" in d
        assert "crypto_max_retries" in d
        assert d["rate_limit_max_requests"] == 5000

    def test_custom_init(self) -> None:
        cfg = DynamicConfig(cache_ttl_seconds=600, crypto_max_retries=5)
        assert cfg.cache_ttl_seconds == 600
        assert cfg.crypto_max_retries == 5
