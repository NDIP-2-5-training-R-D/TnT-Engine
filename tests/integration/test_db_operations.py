"""Integration tests: PostgreSQL database operations.

Requires: docker compose -f tests/integration/docker-compose.yml up -d --wait
Tests real DB connections, token CRUD, tenant isolation.
"""

from __future__ import annotations

import pytest

from tnt_engine.config import Settings
from tnt_engine.db.connection import Database
from tnt_engine.db.repository import TokenRepository


@pytest.fixture(scope="module")
async def database(integration_settings: Settings) -> Database:
    db = Database(integration_settings)
    await db.connect()
    yield db
    await db.close()


@pytest.fixture
async def repo(database: Database) -> TokenRepository:
    return TokenRepository(database)


class TestDatabaseConnection:
    async def test_connect_and_query(self, database: Database) -> None:
        row = await database.pool.fetchrow("SELECT 1 AS result")
        assert row["result"] == 1

    async def test_read_pool_fallback(self, database: Database) -> None:
        """Without read replica configured, read_pool falls back to primary."""
        row = await database.read_pool.fetchrow("SELECT current_database()")
        assert row[0] == "tnt_engine_test"


class TestTokenRepository:
    async def test_upsert_and_find(self, repo: TokenRepository) -> None:
        token = await repo.upsert_token(
            token="tok_inttest_001_abcdefgh",
            value_encrypted="vault:v1:encrypted_data",
            transformation="TOKENIZE",
            key_version=1,
            hmac_hash="hash_integration_test_001",
            tenant_id="integration_tenant",
        )
        assert token == "tok_inttest_001_abcdefgh"

        found = await repo.find_token_by_hash("hash_integration_test_001", "integration_tenant")
        assert found == "tok_inttest_001_abcdefgh"

    async def test_tenant_isolation(self, repo: TokenRepository) -> None:
        await repo.upsert_token(
            token="tok_inttest_002_abcdefgh",
            value_encrypted="vault:v1:data",
            transformation="TOKENIZE",
            key_version=1,
            hmac_hash="hash_isolation_test",
            tenant_id="tenant_a",
        )
        # Different tenant cannot find the token
        result = await repo.find_token_by_hash("hash_isolation_test", "tenant_b")
        assert result is None

    async def test_audit_write(self, repo: TokenRepository) -> None:
        from tnt_engine.models.domain import AuditAction, AuditEntry

        entry = AuditEntry(
            action=AuditAction.TOKENIZE,
            field="ssn",
            tenant_id="integration_tenant",
            trace_id="trace-integration-001",
        )
        # Should not raise
        await repo.write_audit(entry)
