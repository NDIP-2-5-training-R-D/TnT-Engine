"""Runtime-tunable configuration parameters.

Unlike Settings (loaded once at startup from env vars), DynamicConfig
values can be changed at runtime via the admin API. This is useful for:
  - Adjusting cache TTL during incidents
  - Changing retry count without redeploy
  - Tuning rate limits based on load
  - Adjusting worker batch sizes

Values are stored in-memory with optional persistence to Redis for
multi-replica consistency.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from tnt_engine.logging import get_logger

logger = get_logger(__name__)


@dataclass
class DynamicConfig:
    """Runtime-tunable parameters with defaults from Settings."""

    # Cache
    cache_ttl_seconds: int = 3600
    l1_ttl_seconds: int = 300

    # Retry
    crypto_max_retries: int = 3
    crypto_timeout_seconds: float = 5.0

    # Rate limiting
    rate_limit_max_requests: int = 5000
    rate_limit_window_seconds: int = 60

    # Workers
    cleanup_interval_seconds: int = 60
    cleanup_batch_size: int = 1000

    # Data retention
    default_token_ttl_seconds: int | None = None  # None = no auto-expire
    dedup_ttl_seconds: int = 3600
    soft_delete_purge_after_days: int = 30

    def update(self, key: str, value: int | float | None) -> bool:
        """Update a config value. Returns True if the key exists."""
        if not hasattr(self, key):
            return False
        setattr(self, key, value)
        logger.info("dynamic_config_updated", key=key, value=value)
        return True

    def get(self, key: str) -> int | float | None:
        """Get a config value by key."""
        return getattr(self, key, None)

    def to_dict(self) -> dict:
        """Return all config values as a dict."""
        return {
            k: v for k, v in self.__dict__.items()
            if not k.startswith("_")
        }
