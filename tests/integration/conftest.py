"""Integration test fixtures — real infrastructure connections.

These fixtures connect to services started by docker-compose.yml.
All tests in this directory are automatically marked with @pytest.mark.integration.

Ports (non-default to avoid dev conflicts):
  - Postgres: 15432
  - Redis:    16379
  - OpenBao:  18200
"""

from __future__ import annotations

import httpx
import pytest

from tnt_engine.config import Settings


def pytest_collection_modifyitems(items: list) -> None:
    """Auto-mark all tests in integration/ with the integration marker."""
    for item in items:
        if "integration" in str(item.fspath):
            item.add_marker(pytest.mark.integration)


@pytest.fixture(scope="session")
def integration_settings() -> Settings:
    """Settings pointing at docker-compose integration services."""
    return Settings(
        db_host="localhost",
        db_port=15432,
        db_name="tnt_engine_test",
        db_user="tnt_test",
        db_password="tnt_test_secret",
        db_pool_min=2,
        db_pool_max=5,
        redis_url="redis://localhost:16379/0",
        crypto_base_url="http://localhost:18200/v1",
        crypto_token="test-token",
        vault_auth_method="static",
        crypto_backend="openbao",
        environment="development",
    )


@pytest.fixture(scope="session")
async def setup_transit_keys(integration_settings: Settings) -> None:
    """Create transit keys in OpenBao for integration testing."""
    base = integration_settings.crypto_base_url
    headers = {"X-Vault-Token": integration_settings.crypto_token}

    async with httpx.AsyncClient() as client:
        # Enable transit engine (idempotent in dev mode)
        await client.post(
            f"{base}/sys/mounts/transit",
            headers=headers,
            json={"type": "transit"},
        )
        # Create encryption key
        await client.post(
            f"{base}/transit/keys/{integration_settings.crypto_transit_key}",
            headers=headers,
        )
        # Create HMAC key
        await client.post(
            f"{base}/transit/keys/{integration_settings.crypto_hmac_key}",
            headers=headers,
        )
