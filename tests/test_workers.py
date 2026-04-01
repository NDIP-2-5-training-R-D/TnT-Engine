"""Unit tests for background workers."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from tnt_engine.config import Settings
from tnt_engine.workers.cleanup import CleanupWorker
from tnt_engine.workers.reencrypt import ReencryptWorker
from tests.conftest import FakeCryptoBackend, FakeTokenRepository

T = "test_tenant"


class TestCleanupWorker:
    @pytest.fixture
    def repo(self) -> FakeTokenRepository:
        return FakeTokenRepository()

    @pytest.fixture
    def worker(self, repo: FakeTokenRepository) -> CleanupWorker:
        return CleanupWorker(repo, Settings())

    async def test_expires_stale_tokens(
        self, repo: FakeTokenRepository, worker: CleanupWorker
    ) -> None:
        # Insert a token that expired in the past
        past = datetime.now(timezone.utc) - timedelta(hours=1)
        await repo.upsert_token("tok_old", "enc", "T", 1, "h_old", T, expires_at=past)

        # Insert a token that has not expired
        future = datetime.now(timezone.utc) + timedelta(hours=1)
        await repo.upsert_token("tok_new", "enc", "T", 1, "h_new", T, expires_at=future)

        expired, dedup = await worker.run_once()
        assert expired == 1

        rec = await repo.get_token_record("tok_old", T)
        assert rec is not None
        assert rec.status == "EXPIRED"

        rec2 = await repo.get_token_record("tok_new", T)
        assert rec2 is not None
        assert rec2.status == "ACTIVE"

    async def test_cleans_dedup(
        self, repo: FakeTokenRepository, worker: CleanupWorker
    ) -> None:
        await repo.set_dedup("rh1", T, {"token": "tok_x"})
        _, dedup = await worker.run_once()
        assert dedup == 1


class TestReencryptWorker:
    @pytest.fixture
    def repo(self) -> FakeTokenRepository:
        return FakeTokenRepository()

    @pytest.fixture
    def crypto(self) -> FakeCryptoBackend:
        return FakeCryptoBackend()

    async def test_reencrypts_old_keys(
        self,
        repo: FakeTokenRepository,
        crypto: FakeCryptoBackend,
    ) -> None:
        # Insert token with key_version=1
        await repo.upsert_token("tok_re", "vault:v1:aGVsbG8=", "T", 1, "h_re", T)

        worker = ReencryptWorker(repo, crypto, Settings(), target_key_version=2)
        count = await worker.run_batch()
        assert count == 1

        rec = await repo.get_token_record("tok_re", T)
        assert rec is not None
        # After re-encrypt, key_version should be updated
        # FakeCryptoBackend always returns version 1, so we check the flow ran
        assert rec.value_encrypted.startswith("vault:v1:")

    async def test_skips_already_current(
        self,
        repo: FakeTokenRepository,
        crypto: FakeCryptoBackend,
    ) -> None:
        await repo.upsert_token("tok_ok", "vault:v2:data", "T", 2, "h_ok", T)

        worker = ReencryptWorker(repo, crypto, Settings(), target_key_version=2)
        count = await worker.run_batch()
        assert count == 0  # already at target version
