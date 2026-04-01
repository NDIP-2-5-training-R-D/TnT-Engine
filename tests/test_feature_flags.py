"""Tests for the feature flag system."""

from __future__ import annotations

from tnt_engine.runtime.feature_flags import FeatureFlags


class TestFeatureFlags:
    def test_defaults_enabled(self) -> None:
        flags = FeatureFlags()
        assert flags.is_enabled("enable_tokenization") is True
        assert flags.is_enabled("enable_cache") is True
        assert flags.is_enabled("sandbox_mode") is False

    def test_set_global(self) -> None:
        flags = FeatureFlags()
        flags.set("enable_cache", False)
        assert flags.is_enabled("enable_cache") is False

    def test_unknown_flag_returns_false(self) -> None:
        flags = FeatureFlags()
        assert flags.is_enabled("nonexistent_flag") is False

    def test_tenant_override(self) -> None:
        flags = FeatureFlags()
        flags.set("enable_cache", True)
        flags.set_for_tenant("acme", "enable_cache", False)

        assert flags.is_enabled("enable_cache") is True
        assert flags.is_enabled("enable_cache", tenant_id="acme") is False
        assert flags.is_enabled("enable_cache", tenant_id="other") is True

    def test_remove_tenant_override(self) -> None:
        flags = FeatureFlags()
        flags.set_for_tenant("acme", "enable_cache", False)
        flags.remove_tenant_override("acme", "enable_cache")
        assert flags.is_enabled("enable_cache", tenant_id="acme") is True

    def test_get_all(self) -> None:
        flags = FeatureFlags()
        all_flags = flags.get_all()
        assert "enable_tokenization" in all_flags
        assert "sandbox_mode" in all_flags

    def test_get_effective(self) -> None:
        flags = FeatureFlags()
        flags.set_for_tenant("acme", "sandbox_mode", True)
        effective = flags.get_effective("acme")
        assert effective["sandbox_mode"] is True
        assert effective["enable_tokenization"] is True
