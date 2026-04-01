"""Tests for the reliable audit writer.

Covers:
  - Buffer enqueue and flush to DB
  - Batch flush with multiple entries
  - Retry on DB failure with exponential backoff
  - Dead letter queue (DLQ) on exhausted retries
  - DLQ replay back to DB
  - Graceful shutdown drains buffer
  - Buffer capacity warning
  - Integration with TokenService
"""

from __future__ import annotations

import json
import os
import tempfile

import pytest

from tnt_engine.config import Settings
from tnt_engine.models.domain import AuditAction, AuditEntry
from tnt_engine.service.audit_writer import ReliableAuditWriter


# ── Fake Repository ─────────────────────────────────────────────────


class FakeAuditRepo:
    """In-memory audit repository for testing."""

    def __init__(self, fail_count: int = 0) -> None:
        self.entries: list[AuditEntry] = []
        self.batch_calls: int = 0
        self._fail_count = fail_count  # Number of consecutive failures
        self._call_count = 0

    async def write_audit(self, entry: AuditEntry) -> None:
        self._call_count += 1
        if self._call_count <= self._fail_count:
            raise ConnectionError("DB unavailable")
        self.entries.append(entry)

    async def write_audit_batch(self, entries: list[AuditEntry]) -> None:
        self.batch_calls += 1
        self._call_count += 1
        if self._call_count <= self._fail_count:
            raise ConnectionError("DB unavailable")
        self.entries.extend(entries)


def _make_entry(action: str = "TOKENIZE", tenant: str = "test") -> AuditEntry:
    return AuditEntry(
        action=AuditAction(action),
        field="ssn",
        tenant_id=tenant,
        trace_id="trace-123",
    )


# ── Fixtures ────────────────────────────────────────────────────────


@pytest.fixture
def dlq_path(tmp_path) -> str:
    return str(tmp_path / "test-dlq.jsonl")


@pytest.fixture
def settings(dlq_path: str) -> Settings:
    return Settings(
        audit_buffer_max_size=100,
        audit_flush_interval_seconds=0.1,
        audit_flush_batch_size=50,
        audit_max_retries=2,
        audit_retry_backoff_seconds=0.01,  # fast retries for tests
        audit_dlq_path=dlq_path,
    )


# ── Core Tests ──────────────────────────────────────────────────────


class TestReliableAuditWriter:
    async def test_enqueue_and_flush(self, settings: Settings) -> None:
        repo = FakeAuditRepo()
        writer = ReliableAuditWriter(repo, settings)
        await writer.start()

        writer.enqueue(_make_entry())
        writer.enqueue(_make_entry())
        assert writer.buffer_size == 2

        count = await writer.flush_now()
        assert count == 2
        assert len(repo.entries) == 2
        assert writer.buffer_size == 0

        await writer.stop()

    async def test_batch_flush(self, settings: Settings) -> None:
        repo = FakeAuditRepo()
        writer = ReliableAuditWriter(repo, settings)
        await writer.start()

        for _ in range(10):
            writer.enqueue(_make_entry())

        count = await writer.flush_now()
        assert count == 10
        assert repo.batch_calls == 1

        await writer.stop()

    async def test_flush_respects_batch_size(self, settings: Settings) -> None:
        settings_small = Settings(
            audit_flush_batch_size=3,
            audit_max_retries=2,
            audit_retry_backoff_seconds=0.01,
            audit_dlq_path=settings.audit_dlq_path,
        )
        repo = FakeAuditRepo()
        writer = ReliableAuditWriter(repo, settings_small)
        await writer.start()

        for _ in range(7):
            writer.enqueue(_make_entry())

        # First flush takes 3
        count = await writer.flush_now()
        assert count == 3
        assert writer.buffer_size == 4

        # Second flush takes 3 more
        count = await writer.flush_now()
        assert count == 3
        assert writer.buffer_size == 1

        await writer.stop()

    async def test_empty_flush_returns_zero(self, settings: Settings) -> None:
        repo = FakeAuditRepo()
        writer = ReliableAuditWriter(repo, settings)
        await writer.start()

        count = await writer.flush_now()
        assert count == 0

        await writer.stop()


# ── Retry Tests ─────────────────────────────────────────────────────


class TestRetry:
    async def test_retry_succeeds_on_second_attempt(self, settings: Settings) -> None:
        repo = FakeAuditRepo(fail_count=1)  # First call fails, second succeeds
        writer = ReliableAuditWriter(repo, settings)
        await writer.start()

        writer.enqueue(_make_entry())
        count = await writer.flush_now()
        assert count == 1
        assert len(repo.entries) == 1

        await writer.stop()

    async def test_retries_exhausted_sends_to_dlq(
        self, settings: Settings, dlq_path: str
    ) -> None:
        repo = FakeAuditRepo(fail_count=999)  # Always fails
        writer = ReliableAuditWriter(repo, settings)
        await writer.start()

        writer.enqueue(_make_entry("TOKENIZE", "tenant-a"))
        writer.enqueue(_make_entry("DETOKENIZE", "tenant-b"))

        count = await writer.flush_now()
        assert count == 0  # All failed

        # DLQ file should exist with 2 entries
        assert os.path.exists(dlq_path)
        with open(dlq_path) as f:
            lines = f.readlines()
        assert len(lines) == 2

        # Verify DLQ content
        record = json.loads(lines[0])
        assert record["action"] == "TOKENIZE"
        assert record["tenant_id"] == "tenant-a"
        assert "dlq_timestamp" in record

        await writer.stop()


# ── DLQ Tests ───────────────────────────────────────────────────────


class TestDLQ:
    async def test_dlq_replay_success(
        self, settings: Settings, dlq_path: str
    ) -> None:
        # Write some entries to DLQ manually
        entries = [
            {"action": "TOKENIZE", "field": "ssn", "tenant_id": "t1",
             "trace_id": "tr1", "status": "success", "metadata": {},
             "dlq_timestamp": "2026-01-01T00:00:00+00:00"},
            {"action": "DETOKENIZE", "field": None, "tenant_id": "t2",
             "trace_id": "tr2", "status": "success", "metadata": {},
             "dlq_timestamp": "2026-01-01T00:00:00+00:00"},
        ]
        with open(dlq_path, "w") as f:
            for e in entries:
                f.write(json.dumps(e) + "\n")

        repo = FakeAuditRepo()
        writer = ReliableAuditWriter(repo, settings)
        await writer.start()

        replayed = await writer.replay_dlq()
        assert replayed == 2
        assert len(repo.entries) == 2

        # DLQ file should be truncated
        assert os.path.getsize(dlq_path) == 0

        await writer.stop()

    async def test_dlq_replay_empty_file(
        self, settings: Settings, dlq_path: str
    ) -> None:
        # Create empty DLQ
        with open(dlq_path, "w") as f:
            f.write("")

        repo = FakeAuditRepo()
        writer = ReliableAuditWriter(repo, settings)
        await writer.start()

        replayed = await writer.replay_dlq()
        assert replayed == 0

        await writer.stop()

    async def test_dlq_replay_no_file(self, settings: Settings) -> None:
        repo = FakeAuditRepo()
        writer = ReliableAuditWriter(repo, settings)
        await writer.start()

        replayed = await writer.replay_dlq()
        assert replayed == 0

        await writer.stop()

    async def test_dlq_replay_fails_keeps_file(
        self, settings: Settings, dlq_path: str
    ) -> None:
        # Write entry to DLQ
        with open(dlq_path, "w") as f:
            f.write(json.dumps({
                "action": "TOKENIZE", "field": "ssn", "tenant_id": "t1",
                "trace_id": "tr1", "status": "success", "metadata": {},
                "dlq_timestamp": "2026-01-01T00:00:00+00:00",
            }) + "\n")

        repo = FakeAuditRepo(fail_count=999)
        writer = ReliableAuditWriter(repo, settings)
        await writer.start()

        replayed = await writer.replay_dlq()
        assert replayed == 0

        # DLQ should still have the entry
        assert os.path.getsize(dlq_path) > 0

        await writer.stop()

    def test_dlq_size_bytes(self, settings: Settings, dlq_path: str) -> None:
        repo = FakeAuditRepo()
        writer = ReliableAuditWriter(repo, settings)

        assert writer.dlq_size_bytes == 0

        with open(dlq_path, "w") as f:
            f.write('{"test": true}\n')

        assert writer.dlq_size_bytes > 0


# ── Shutdown Tests ──────────────────────────────────────────────────


class TestShutdown:
    async def test_stop_drains_buffer(self, settings: Settings) -> None:
        repo = FakeAuditRepo()
        writer = ReliableAuditWriter(repo, settings)
        await writer.start()

        for _ in range(5):
            writer.enqueue(_make_entry())

        assert writer.buffer_size == 5

        await writer.stop()

        # After stop, all entries should be flushed to DB
        assert len(repo.entries) == 5
        assert writer.buffer_size == 0


# ── Buffer Capacity Tests ───────────────────────────────────────────


class TestBufferCapacity:
    async def test_enqueue_at_capacity_still_accepts(self, dlq_path: str) -> None:
        cfg = Settings(
            audit_buffer_max_size=3,
            audit_flush_interval_seconds=10,  # long interval — won't auto-flush
            audit_max_retries=2,
            audit_retry_backoff_seconds=0.01,
            audit_dlq_path=dlq_path,
        )
        repo = FakeAuditRepo()
        writer = ReliableAuditWriter(repo, cfg)
        await writer.start()

        # Enqueue past capacity — entries are still accepted
        for _ in range(5):
            writer.enqueue(_make_entry())

        assert writer.buffer_size == 5  # All accepted

        await writer.stop()
        assert len(repo.entries) == 5  # All flushed on stop


# ── Integration with TokenService ───────────────────────────────────


class TestTokenServiceIntegration:
    async def test_token_service_uses_audit_writer(self, settings: Settings) -> None:
        """Verify TokenService routes audit through ReliableAuditWriter."""
        from tests.conftest import FakeCryptoBackend, FakeLayeredCache, FakeTokenRepository
        from tnt_engine.models.domain import TokenizeRequest
        from tnt_engine.service.token_service import TokenService

        repo = FakeAuditRepo()
        writer = ReliableAuditWriter(repo, settings)
        await writer.start()

        fake_crypto = FakeCryptoBackend()
        fake_repo = FakeTokenRepository()
        fake_cache = FakeLayeredCache()

        svc = TokenService(
            hmac=fake_crypto,
            encryption=fake_crypto,
            repo=fake_repo,
            cache=fake_cache,
            settings=settings,
            audit_writer=writer,
        )

        # Tokenize should route audit through the writer
        req = TokenizeRequest(value="test-ssn", field="ssn", tenant_id="acme")
        await svc.tokenize(req)

        # Flush to see the audit entry
        count = await writer.flush_now()
        assert count >= 1
        assert any(e.action == AuditAction.TOKENIZE for e in repo.entries)

        await writer.stop()
