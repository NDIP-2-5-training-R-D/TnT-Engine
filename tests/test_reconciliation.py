"""Tests for data integrity reconciliation worker."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from tnt_engine.workers.reconciliation import ReconciliationReport, ReconciliationWorker
from tests.conftest import FakeCryptoBackend, FakeTokenRepository, TENANT

_NOW = datetime.now(timezone.utc)


class FakeDatabase:
    """Minimal fake that exposes a read_pool with fetch()."""

    def __init__(self, repo: FakeTokenRepository) -> None:
        self._repo = repo
        self.read_pool = self

    async def fetch(self, query: str, *args) -> list[dict]:
        """Simulate the reconciliation query."""
        offset, limit = args[0], args[1]
        results = []
        items = list(self._repo.token_store.items())[offset:offset + limit]
        for token, rec in items:
            if rec.get("status", "ACTIVE") != "ACTIVE":
                continue
            # Find the lookup hash
            lookup_hash = None
            for (h, tid), t in self._repo.token_lookup.items():
                if t == token and tid == rec.get("tenant_id", TENANT):
                    lookup_hash = h
                    break
            row = {
                "token": token,
                "value_encrypted": rec["value_encrypted"],
                "transformation": rec["transformation"],
                "key_version": rec["key_version"],
                "tenant_id": rec.get("tenant_id", TENANT),
                "status": rec.get("status", "ACTIVE"),
                "expires_at": rec.get("expires_at"),
                "created_at": _NOW,
                "updated_at": _NOW,
                "lookup_hash": lookup_hash,
            }
            results.append(row)
        return results


class TestReconciliation:
    @pytest.fixture
    def repo(self) -> FakeTokenRepository:
        return FakeTokenRepository()

    @pytest.fixture
    def crypto(self) -> FakeCryptoBackend:
        return FakeCryptoBackend()

    async def test_clean_report(
        self, repo: FakeTokenRepository, crypto: FakeCryptoBackend
    ) -> None:
        # Insert a valid token
        import base64
        import hashlib

        plaintext = "test_value"
        hmac_hash = hashlib.sha256(plaintext.encode()).hexdigest()
        b64 = base64.b64encode(plaintext.encode()).decode()
        ciphertext = f"vault:v1:{b64}"

        await repo.upsert_token("tok_valid", ciphertext, "TOKENIZE", 1, hmac_hash, TENANT)

        db = FakeDatabase(repo)
        worker = ReconciliationWorker(db, crypto, crypto, batch_size=100)  # type: ignore
        report = await worker.run(limit=100)

        assert report.checked == 1
        assert report.healthy == 1
        assert report.is_clean is True

    async def test_missing_lookup_detected(
        self, repo: FakeTokenRepository, crypto: FakeCryptoBackend
    ) -> None:
        # Insert token_store entry WITHOUT a corresponding token_lookup entry
        repo.token_store["tok_orphan"] = {
            "value_encrypted": "vault:v1:dGVzdA==",
            "transformation": "TOKENIZE",
            "key_version": 1,
            "tenant_id": TENANT,
            "status": "ACTIVE",
            "expires_at": None,
        }
        # Intentionally skip token_lookup

        db = FakeDatabase(repo)
        worker = ReconciliationWorker(db, crypto, crypto, batch_size=100)  # type: ignore
        report = await worker.run(limit=100)

        assert report.checked == 1
        assert report.lookup_missing == 1
        assert report.is_clean is False

    async def test_empty_db(
        self, repo: FakeTokenRepository, crypto: FakeCryptoBackend
    ) -> None:
        db = FakeDatabase(repo)
        worker = ReconciliationWorker(db, crypto, crypto, batch_size=100)  # type: ignore
        report = await worker.run(limit=100)

        assert report.checked == 0
        assert report.is_clean is True

    def test_report_properties(self) -> None:
        r = ReconciliationReport(checked=10, healthy=8, decrypt_failures=1, hmac_mismatches=1)
        assert r.is_clean is False
