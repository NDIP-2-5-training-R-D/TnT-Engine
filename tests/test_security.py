"""Tests for security — access control + rate limiting."""

from __future__ import annotations

import pytest

from tnt_engine.security.access_control import (
    AccessControl,
    AccessDeniedError,
    Operation,
    Role,
)
from tnt_engine.security.rate_limiter import RateLimitExceeded, RateLimiter


class TestAccessControl:
    @pytest.fixture
    def ac(self) -> AccessControl:
        return AccessControl()

    def test_tokenizer_can_tokenize(self, ac: AccessControl) -> None:
        ac.check(Role.TOKENIZER, Operation.TOKENIZE)  # no exception

    def test_tokenizer_cannot_detokenize(self, ac: AccessControl) -> None:
        with pytest.raises(AccessDeniedError):
            ac.check(Role.TOKENIZER, Operation.DETOKENIZE)

    def test_detokenizer_can_both(self, ac: AccessControl) -> None:
        ac.check(Role.DETOKENIZER, Operation.TOKENIZE)
        ac.check(Role.DETOKENIZER, Operation.DETOKENIZE)

    def test_detokenizer_cannot_delete(self, ac: AccessControl) -> None:
        with pytest.raises(AccessDeniedError):
            ac.check(Role.DETOKENIZER, Operation.DELETE)

    def test_admin_can_everything(self, ac: AccessControl) -> None:
        for op in Operation:
            ac.check(Role.ADMIN, op)  # no exceptions

    def test_is_allowed(self, ac: AccessControl) -> None:
        assert ac.is_allowed(Role.TOKENIZER, Operation.TOKENIZE) is True
        assert ac.is_allowed(Role.TOKENIZER, Operation.DETOKENIZE) is False

    def test_get_permissions(self, ac: AccessControl) -> None:
        perms = ac.get_permissions(Role.ADMIN)
        assert Operation.DELETE in perms
        assert Operation.REVOKE in perms

    def test_error_message(self) -> None:
        err = AccessDeniedError(Role.TOKENIZER, Operation.DETOKENIZE)
        assert "TOKENIZER" in str(err)
        assert "DETOKENIZE" in str(err)


class TestRateLimiter:
    def test_allows_under_limit(self) -> None:
        limiter = RateLimiter(max_requests=5, window_seconds=60)
        for _ in range(5):
            limiter.check("tenant_a")  # no exception

    def test_rejects_over_limit(self) -> None:
        limiter = RateLimiter(max_requests=3, window_seconds=60)
        limiter.check("tenant_a")
        limiter.check("tenant_a")
        limiter.check("tenant_a")
        with pytest.raises(RateLimitExceeded):
            limiter.check("tenant_a")

    def test_tenants_are_independent(self) -> None:
        limiter = RateLimiter(max_requests=2, window_seconds=60)
        limiter.check("tenant_a")
        limiter.check("tenant_a")
        limiter.check("tenant_b")  # different tenant — separate bucket

    def test_get_remaining(self) -> None:
        limiter = RateLimiter(max_requests=10, window_seconds=60)
        assert limiter.get_remaining("tenant_a") == 10
        limiter.check("tenant_a")
        assert limiter.get_remaining("tenant_a") == 9

    def test_reset(self) -> None:
        limiter = RateLimiter(max_requests=2, window_seconds=60)
        limiter.check("tenant_a")
        limiter.check("tenant_a")
        limiter.reset("tenant_a")
        limiter.check("tenant_a")  # works after reset

    def test_error_message(self) -> None:
        err = RateLimitExceeded("acme", 100, 60)
        assert "acme" in str(err)
        assert "100" in str(err)
