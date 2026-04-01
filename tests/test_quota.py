"""Tests for the quota management system."""

from __future__ import annotations

import pytest

from tnt_engine.security.quota import QuotaExceededError, QuotaManager


class TestQuotaManager:
    def test_no_quota_passes(self) -> None:
        qm = QuotaManager()
        qm.check("any_tenant")  # no exception — no limit set

    def test_within_quota(self) -> None:
        qm = QuotaManager()
        qm.set_limit("acme", 100)
        qm.record_usage("acme", 50)
        qm.check("acme")  # still under limit

    def test_exceeds_quota(self) -> None:
        qm = QuotaManager()
        qm.set_limit("acme", 10)
        qm.record_usage("acme", 10)
        with pytest.raises(QuotaExceededError):
            qm.check("acme")

    def test_usage_tracking(self) -> None:
        qm = QuotaManager()
        qm.set_limit("acme", 100)
        qm.record_usage("acme", 30)
        qm.record_usage("acme", 20)
        usage = qm.get_usage("acme")
        assert usage["used"] == 50
        assert usage["remaining"] == 50

    def test_reset(self) -> None:
        qm = QuotaManager()
        qm.set_limit("acme", 10)
        qm.record_usage("acme", 10)
        qm.reset("acme")
        qm.check("acme")  # passes after reset

    def test_unlimited_tenant(self) -> None:
        qm = QuotaManager()
        qm.set_limit("acme", 0)  # 0 = unlimited
        qm.record_usage("acme", 999999)
        qm.check("acme")  # unlimited — always passes

    def test_get_usage_unknown_tenant(self) -> None:
        qm = QuotaManager()
        usage = qm.get_usage("unknown")
        assert usage["used"] == 0

    def test_tenants_independent(self) -> None:
        qm = QuotaManager()
        qm.set_limit("a", 10)
        qm.set_limit("b", 10)
        qm.record_usage("a", 10)
        qm.check("b")  # b is independent
        with pytest.raises(QuotaExceededError):
            qm.check("a")
