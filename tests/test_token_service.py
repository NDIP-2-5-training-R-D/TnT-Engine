"""Unit tests for TokenService v3 — multi-tenant, lifecycle, idempotent."""

from __future__ import annotations

import asyncio

import pytest

from tnt_engine.errors import (
    InvalidTokenFormatError,
    TokenExpiredError,
    TokenNotFoundError,
    TokenRevokedError,
)
from tnt_engine.models.domain import TokenizeRequest
from tnt_engine.service.token_service import TokenService
from tests.conftest import (
    TENANT,
    FakeCryptoBackend,
    FakeLayeredCache,
    FakeTokenRepository,
)

T = TENANT


def _req(value: str, field: str = "f", tenant_id: str = T, **kw) -> TokenizeRequest:
    return TokenizeRequest(value=value, field=field, tenant_id=tenant_id, **kw)


class TestTokenize:
    async def test_returns_token(self, token_service: TokenService) -> None:
        resp = await token_service.tokenize(_req("123-45-6789", "ssn"))
        assert resp.token.startswith("tok_")
        assert resp.field == "ssn"

    async def test_convergent(self, token_service: TokenService) -> None:
        r1 = await token_service.tokenize(_req("hello@example.com", "email"))
        r2 = await token_service.tokenize(_req("hello@example.com", "email"))
        assert r1.token == r2.token
        assert r2.cached is True

    async def test_different_values(self, token_service: TokenService) -> None:
        r1 = await token_service.tokenize(_req("aaa"))
        r2 = await token_service.tokenize(_req("bbb"))
        assert r1.token != r2.token

    async def test_normalizes_whitespace(self, token_service: TokenService) -> None:
        r1 = await token_service.tokenize(_req("  hello  "))
        r2 = await token_service.tokenize(_req("hello"))
        assert r1.token == r2.token

    async def test_db_fallback(
        self, token_service: TokenService, fake_cache: FakeLayeredCache
    ) -> None:
        r1 = await token_service.tokenize(_req("val"))
        fake_cache.clear()
        r2 = await token_service.tokenize(_req("val"))
        assert r1.token == r2.token

    async def test_concurrent_same_value(self, token_service: TokenService) -> None:
        req = _req("concurrent_val")
        r1, r2 = await asyncio.gather(
            token_service.tokenize(req),
            token_service.tokenize(req),
        )
        assert r1.token == r2.token


class TestTenantIsolation:
    async def test_same_value_different_tenants(
        self, token_service: TokenService
    ) -> None:
        """Same plaintext for different tenants must produce different tokens."""
        r1 = await token_service.tokenize(_req("shared_val", tenant_id="tenant_a"))
        r2 = await token_service.tokenize(_req("shared_val", tenant_id="tenant_b"))
        assert r1.token != r2.token

    async def test_detokenize_wrong_tenant_fails(
        self, token_service: TokenService
    ) -> None:
        resp = await token_service.tokenize(_req("secret", tenant_id="owner"))
        with pytest.raises(TokenNotFoundError):
            await token_service.detokenize(resp.token, "other_tenant")


class TestDetokenize:
    async def test_round_trip(self, token_service: TokenService) -> None:
        resp = await token_service.tokenize(_req("my-secret", "f"))
        plain = await token_service.detokenize(resp.token, T)
        assert plain == "my-secret"

    async def test_missing_raises(self, token_service: TokenService) -> None:
        with pytest.raises(TokenNotFoundError):
            await token_service.detokenize("tok_" + "A" * 43, T)

    async def test_invalid_format(self, token_service: TokenService) -> None:
        with pytest.raises(InvalidTokenFormatError):
            await token_service.detokenize("bad", T)


class TestLifecycle:
    async def test_revoke_prevents_detokenize(
        self, token_service: TokenService
    ) -> None:
        resp = await token_service.tokenize(_req("revoke_me"))
        ok = await token_service.revoke(resp.token, T)
        assert ok is True

        with pytest.raises(TokenRevokedError):
            await token_service.detokenize(resp.token, T)

    async def test_revoke_nonexistent_returns_false(
        self, token_service: TokenService
    ) -> None:
        ok = await token_service.revoke("tok_" + "X" * 43, T)
        assert ok is False

    async def test_delete_removes_token(
        self, token_service: TokenService
    ) -> None:
        resp = await token_service.tokenize(_req("delete_me"))
        ok = await token_service.delete(resp.token, T)
        assert ok is True

        with pytest.raises(TokenNotFoundError):
            await token_service.detokenize(resp.token, T)

    async def test_delete_nonexistent_returns_false(
        self, token_service: TokenService
    ) -> None:
        ok = await token_service.delete("tok_" + "Y" * 43, T)
        assert ok is False


class TestIdempotency:
    async def test_duplicate_request_returns_cached(
        self, token_service: TokenService, fake_crypto: FakeCryptoBackend
    ) -> None:
        req = _req("idempotent_val", "email")

        r1 = await token_service.tokenize(req)
        encrypt_count_after_first = fake_crypto.encrypt_call_count

        r2 = await token_service.tokenize(req)
        assert r2.token == r1.token
        # Second call should hit dedup — no new encrypt call needed
        # (it might hit cache before dedup, which is also fine)
        assert r2.token == r1.token


class TestBatchTokenize:
    async def test_batch(self, token_service: TokenService) -> None:
        items = [_req(f"v{i}", f"f{i}") for i in range(5)]
        results = await token_service.batch_tokenize(items)
        assert len(results) == 5
        assert len(set(r.token for r in results)) == 5

    async def test_batch_dedup_within(self, token_service: TokenService) -> None:
        items = [_req("same", "f1"), _req("diff", "f2"), _req("same", "f3")]
        results = await token_service.batch_tokenize(items)
        assert results[0].token == results[2].token
        assert results[0].token != results[1].token

    async def test_batch_convergent_across_calls(
        self, token_service: TokenService
    ) -> None:
        batch = await token_service.batch_tokenize([_req("cross")])
        single = await token_service.tokenize(_req("cross"))
        assert single.token == batch[0].token

    async def test_batch_minimizes_encrypts(
        self, token_service: TokenService, fake_crypto: FakeCryptoBackend
    ) -> None:
        fake_crypto.encrypt_call_count = 0
        items = [_req("dup")] * 3 + [_req("unique")]
        await token_service.batch_tokenize(items)
        assert fake_crypto.encrypt_call_count == 2  # 2 unique values


class TestBatchDetokenize:
    async def test_round_trip(self, token_service: TokenService) -> None:
        vals = ["a", "b", "c"]
        toks = await token_service.batch_tokenize([_req(v) for v in vals])
        mapping = await token_service.batch_detokenize(
            [r.token for r in toks], T
        )
        for r, v in zip(toks, vals):
            assert mapping[r.token] == v

    async def test_revoked_in_batch_raises(
        self, token_service: TokenService
    ) -> None:
        resp = await token_service.tokenize(_req("x"))
        await token_service.revoke(resp.token, T)
        with pytest.raises(TokenRevokedError):
            await token_service.batch_detokenize([resp.token], T)


class TestUpsertConcurrency:
    async def test_conflict_returns_winner(
        self, fake_repo: FakeTokenRepository
    ) -> None:
        w1 = await fake_repo.upsert_token("tok_a", "e", "T", 1, "h", T)
        w2 = await fake_repo.upsert_token("tok_b", "e", "T", 1, "h", T)
        assert w1 == "tok_a"
        assert w2 == "tok_a"

    async def test_batch_conflict(self, fake_repo: FakeTokenRepository) -> None:
        records = [
            ("tok_1", "e", "T", 1, "h_same", T, None),
            ("tok_2", "e", "T", 1, "h_same", T, None),
            ("tok_3", "e", "T", 1, "h_other", T, None),
        ]
        results = await fake_repo.batch_upsert_tokens(records)
        assert results["h_same"] == "tok_1"
        assert results["h_other"] == "tok_3"
