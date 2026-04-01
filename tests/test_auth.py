"""Unit tests for AppRoleAuth using pytest-asyncio + respx."""
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
import respx
from httpx import Response

from crypto_adapter.auth.approle import AppRoleAuth
from crypto_adapter.auth.exceptions import OpenBaoAuthError
from crypto_adapter.auth.models import OpenBaoToken
from crypto_adapter.config import Settings

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

LOGIN_URL = "http://openbao-test:8200/v1/auth/approle/login"

GOOD_LOGIN_RESPONSE = {
    "auth": {
        "client_token": "test-token-abc",
        "lease_duration": 3600,
        "renewable": True,
    }
}


def _make_settings() -> Settings:
    return Settings(
        OPENBAO_ADDR="http://openbao-test:8200",
        OPENBAO_ROLE_ID="test-role",
        OPENBAO_SECRET_ID="test-secret",
    )


async def _started_auth(settings: Settings | None = None) -> AppRoleAuth:
    """Return an AppRoleAuth with the httpx client initialised but without starting the renew task."""
    import httpx

    settings = settings or _make_settings()
    auth = AppRoleAuth(settings)
    # Manually create client so we don't need a live server
    auth._client = httpx.AsyncClient(base_url=settings.OPENBAO_ADDR, timeout=10.0)
    return auth


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_login_success():
    """A successful POST to /v1/auth/approle/login stores the token."""
    respx.post(LOGIN_URL).mock(return_value=Response(200, json=GOOD_LOGIN_RESPONSE))

    auth = await _started_auth()
    await auth.login()

    assert auth._token is not None
    assert auth._token.client_token == "test-token-abc"
    assert auth._token.lease_duration == 3600
    assert auth._token.renewable is True

    await auth._client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_login_failure_raises():
    """A 403 response from login raises OpenBaoAuthError."""
    respx.post(LOGIN_URL).mock(return_value=Response(403, json={"errors": ["permission denied"]}))

    auth = await _started_auth()

    with pytest.raises(OpenBaoAuthError):
        await auth.login()

    await auth._client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_get_token_cache_hit():
    """Calling get_token() twice only triggers login once (cache hit on second call)."""
    route = respx.post(LOGIN_URL).mock(return_value=Response(200, json=GOOD_LOGIN_RESPONSE))

    auth = await _started_auth()
    token1 = await auth.get_token()
    token2 = await auth.get_token()

    assert token1 is token2
    assert route.call_count == 1

    await auth._client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_expired_token_triggers_relogin():
    """If the cached token is expired, get_token() performs a fresh login."""
    # First login returns token with very short TTL already in the past
    route = respx.post(LOGIN_URL).mock(return_value=Response(200, json=GOOD_LOGIN_RESPONSE))

    auth = await _started_auth()

    # Seed an already-expired token (acquired 2 hours ago, TTL 1s)
    auth._token = OpenBaoToken(
        client_token="old-token",
        lease_duration=1,
        renewable=False,
        acquired_at=datetime.now(timezone.utc) - timedelta(hours=2),
    )

    token = await auth.get_token()

    assert token.client_token == "test-token-abc"
    assert route.call_count == 1  # re-login was triggered exactly once

    await auth._client.aclose()
