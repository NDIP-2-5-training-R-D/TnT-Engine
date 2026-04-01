"""Per-tenant quota management.

Tracks cumulative usage per tenant and enforces monthly/daily limits.
Unlike RateLimiter (requests per window), quotas track total operations
over a billing period.

Usage:
    quotas = QuotaManager()
    quotas.set_limit("acme", monthly_limit=100_000)
    quotas.record_usage("acme", count=1)
    quotas.check("acme")  # raises QuotaExceededError if over limit
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from prometheus_client import Counter, Gauge

from tnt_engine.logging import get_logger

logger = get_logger(__name__)

QUOTA_EXCEEDED = Counter(
    "tnt_quota_exceeded_total", "Quota exceeded events", ["tenant_id"]
)
QUOTA_USAGE = Gauge(
    "tnt_quota_usage", "Current quota usage", ["tenant_id"]
)


class QuotaExceededError(Exception):
    """Raised when a tenant exceeds their operation quota."""

    def __init__(self, tenant_id: str, used: int, limit: int) -> None:
        self.tenant_id = tenant_id
        self.used = used
        self.limit = limit
        super().__init__(
            f"Quota exceeded for tenant '{tenant_id}': "
            f"{used}/{limit} operations used"
        )


@dataclass
class TenantQuota:
    """Quota state for a single tenant."""
    monthly_limit: int = 0          # 0 = unlimited
    used: int = 0
    period_start: float = field(default_factory=time.monotonic)


class QuotaManager:
    """Tracks and enforces per-tenant operation quotas."""

    def __init__(self, default_limit: int = 0) -> None:
        self._default_limit = default_limit  # 0 = unlimited
        self._tenants: dict[str, TenantQuota] = {}

    def set_limit(self, tenant_id: str, monthly_limit: int) -> None:
        """Set or update a tenant's monthly quota."""
        quota = self._tenants.get(tenant_id)
        if quota:
            quota.monthly_limit = monthly_limit
        else:
            self._tenants[tenant_id] = TenantQuota(monthly_limit=monthly_limit)
        logger.info(
            "quota_updated", tenant_id=tenant_id, monthly_limit=monthly_limit
        )

    def check(self, tenant_id: str) -> None:
        """Check if tenant is within quota. Raises QuotaExceededError if not."""
        quota = self._tenants.get(tenant_id)
        if not quota:
            return  # No quota set → unlimited
        if quota.monthly_limit <= 0:
            return  # Unlimited
        if quota.used >= quota.monthly_limit:
            QUOTA_EXCEEDED.labels(tenant_id=tenant_id).inc()
            raise QuotaExceededError(tenant_id, quota.used, quota.monthly_limit)

    def record_usage(self, tenant_id: str, count: int = 1) -> None:
        """Record operations used by a tenant."""
        quota = self._tenants.setdefault(
            tenant_id, TenantQuota(monthly_limit=self._default_limit)
        )
        quota.used += count
        QUOTA_USAGE.labels(tenant_id=tenant_id).set(quota.used)

    def get_usage(self, tenant_id: str) -> dict:
        """Return current usage stats for a tenant."""
        quota = self._tenants.get(tenant_id)
        if not quota:
            return {"tenant_id": tenant_id, "used": 0, "limit": 0, "remaining": -1}
        remaining = quota.monthly_limit - quota.used if quota.monthly_limit > 0 else -1
        return {
            "tenant_id": tenant_id,
            "used": quota.used,
            "limit": quota.monthly_limit,
            "remaining": remaining,
        }

    def reset(self, tenant_id: str) -> None:
        """Reset usage counter for a tenant (called at period boundary)."""
        quota = self._tenants.get(tenant_id)
        if quota:
            quota.used = 0
            quota.period_start = time.monotonic()
            QUOTA_USAGE.labels(tenant_id=tenant_id).set(0)

    def reset_all(self) -> None:
        """Reset all tenant usage counters."""
        for tid in self._tenants:
            self.reset(tid)
