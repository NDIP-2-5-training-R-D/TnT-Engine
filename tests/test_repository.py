"""Unit tests for FakeTokenRepository — validates test infrastructure."""

from __future__ import annotations

import pytest

from tnt_engine.models.domain import AuditAction, AuditEntry
from tests.conftest import TENANT, FakeTokenRepository

T = TENANT


class TestFakeRepository:
    @pytest.fixture
    def repo(self) -> FakeTokenRepository:
        return FakeTokenRepository()

    async def test_upsert_and_find(self, repo: FakeTokenRepository) -> None:
        winner = await repo.upsert_token("tok_a", "enc", "T", 1, "h1", T)
        assert winner == "tok_a"
        assert await repo.find_token_by_hash("h1", T) == "tok_a"

    async def test_find_missing(self, repo: FakeTokenRepository) -> None:
        assert await repo.find_token_by_hash("missing", T) is None

    async def test_batch_upsert(self, repo: FakeTokenRepository) -> None:
        records = [
            ("t1", "e1", "T", 1, "h1", T, None),
            ("t2", "e2", "T", 1, "h2", T, None),
        ]
        results = await repo.batch_upsert_tokens(records)
        assert results == {"h1": "t1", "h2": "t2"}

    async def test_tenant_isolation(self, repo: FakeTokenRepository) -> None:
        await repo.upsert_token("tok_a", "enc", "T", 1, "h1", "tenant_a")
        assert await repo.find_token_by_hash("h1", "tenant_b") is None
        assert await repo.find_token_by_hash("h1", "tenant_a") == "tok_a"

    async def test_revoke(self, repo: FakeTokenRepository) -> None:
        await repo.upsert_token("tok_r", "enc", "T", 1, "hr", T)
        assert await repo.revoke_token("tok_r", T) is True
        rec = await repo.get_token_record("tok_r", T)
        assert rec is not None
        assert rec.status == "REVOKED"

    async def test_delete(self, repo: FakeTokenRepository) -> None:
        await repo.upsert_token("tok_d", "enc", "T", 1, "hd", T)
        assert await repo.delete_token("tok_d", T) is True
        assert await repo.get_token_record("tok_d", T) is None

    async def test_conflict_returns_winner(self, repo: FakeTokenRepository) -> None:
        w1 = await repo.upsert_token("tok_a", "e", "T", 1, "hc", T)
        w2 = await repo.upsert_token("tok_b", "e", "T", 1, "hc", T)
        assert w1 == "tok_a"
        assert w2 == "tok_a"

    async def test_audit(self, repo: FakeTokenRepository) -> None:
        entry = AuditEntry(action=AuditAction.TOKENIZE, field="ssn", tenant_id=T)
        await repo.write_audit(entry)
        assert len(repo.audit_entries) == 1

    async def test_dedup(self, repo: FakeTokenRepository) -> None:
        await repo.set_dedup("rh1", T, {"token": "tok_x"})
        assert await repo.get_dedup("rh1", T) == {"token": "tok_x"}
        assert await repo.get_dedup("rh1", "other") is None
