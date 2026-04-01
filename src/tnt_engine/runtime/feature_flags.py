"""Runtime feature flag system.

Flags can be toggled at runtime via the admin API without redeployment.
Supports global flags and per-tenant overrides.

Usage:
    flags = FeatureFlags()
    flags.set("enable_cache", True)
    flags.set_for_tenant("acme", "enable_cache", False)

    if flags.is_enabled("enable_cache", tenant_id="acme"):
        ...  # False — tenant override wins

Built-in flags:
    enable_tokenization  — master switch for tokenize operations
    enable_detokenization — master switch for detokenize operations
    enable_cache         — toggle L1+L2 cache layer
    enable_dedup         — toggle idempotency layer
    enable_audit         — toggle audit log writes
    sandbox_mode         — use mock crypto instead of OpenBao
"""

from __future__ import annotations

from tnt_engine.logging import get_logger

logger = get_logger(__name__)

# Default flag values (all features enabled)
_DEFAULTS: dict[str, bool] = {
    "enable_tokenization": True,
    "enable_detokenization": True,
    "enable_cache": True,
    "enable_dedup": True,
    "enable_audit": True,
    "sandbox_mode": False,
}


class FeatureFlags:
    """In-memory feature flag store with tenant overrides.

    Thread-safe for asyncio (single event loop). For multi-replica
    consistency, back with Redis pub/sub or a shared config store.
    """

    def __init__(self) -> None:
        self._global: dict[str, bool] = dict(_DEFAULTS)
        self._tenant_overrides: dict[str, dict[str, bool]] = {}

    def is_enabled(self, flag: str, tenant_id: str | None = None) -> bool:
        """Check if a flag is enabled. Tenant override takes precedence."""
        if tenant_id and tenant_id in self._tenant_overrides:
            override = self._tenant_overrides[tenant_id].get(flag)
            if override is not None:
                return override
        return self._global.get(flag, False)

    def set(self, flag: str, enabled: bool) -> None:
        """Set a global flag value."""
        self._global[flag] = enabled
        logger.info("feature_flag_updated", flag=flag, enabled=enabled, scope="global")

    def set_for_tenant(self, tenant_id: str, flag: str, enabled: bool) -> None:
        """Set a tenant-specific flag override."""
        self._tenant_overrides.setdefault(tenant_id, {})[flag] = enabled
        logger.info(
            "feature_flag_updated", flag=flag, enabled=enabled,
            scope="tenant", tenant_id=tenant_id,
        )

    def remove_tenant_override(self, tenant_id: str, flag: str) -> None:
        """Remove a tenant override (falls back to global)."""
        if tenant_id in self._tenant_overrides:
            self._tenant_overrides[tenant_id].pop(flag, None)

    def get_all(self) -> dict[str, bool]:
        """Return all global flags."""
        return dict(self._global)

    def get_tenant_overrides(self, tenant_id: str) -> dict[str, bool]:
        """Return tenant-specific overrides."""
        return dict(self._tenant_overrides.get(tenant_id, {}))

    def get_effective(self, tenant_id: str) -> dict[str, bool]:
        """Return the effective flag state for a tenant (global + overrides)."""
        effective = dict(self._global)
        effective.update(self._tenant_overrides.get(tenant_id, {}))
        return effective
