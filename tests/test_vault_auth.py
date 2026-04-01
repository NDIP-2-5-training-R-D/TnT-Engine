"""Tests for Vault token lifecycle management.

Covers:
  - Auth providers: static, approle, kubernetes
  - TokenInfo TTL tracking
  - VaultTokenManager: start, stop, renewal loop
  - Factory: provider creation from settings
  - Error handling: auth failure, renewal failure, re-authentication
"""

from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from tnt_engine.config import Settings
from tnt_engine.crypto.vault_auth import (
    AppRoleProvider,
    KubernetesAuthProvider,
    StaticTokenProvider,
    TokenInfo,
    VaultTokenManager,
    create_auth_provider,
)
from tnt_engine.errors import VaultAuthError, VaultTokenExpiredError


# ── TokenInfo Tests ─────────────────────────────────────────────────


class TestTokenInfo:
    def test_initial_ttl(self) -> None:
        info = TokenInfo(token="test-token", ttl=3600, renewable=True)
        assert info.remaining_ttl > 3599
        assert info.remaining_ttl <= 3600
        assert not info.is_expired

    def test_expired_token(self) -> None:
        info = TokenInfo(token="test-token", ttl=0, renewable=False)
        # TTL=0 means infinite (Vault convention), remaining should be 0
        assert info.remaining_ttl == 0

    def test_ttl_decreases_over_time(self) -> None:
        info = TokenInfo(token="test-token", ttl=100, renewable=True)
        initial = info.remaining_ttl
        # Simulate time passage by adjusting obtained_at
        info.obtained_at = time.monotonic() - 50
        assert info.remaining_ttl < initial
        assert info.remaining_ttl <= 50

    def test_is_expired_after_ttl(self) -> None:
        info = TokenInfo(token="test-token", ttl=1, renewable=True)
        info.obtained_at = time.monotonic() - 2  # 2 seconds ago, TTL was 1
        assert info.is_expired


# ── Static Token Provider Tests ─────────────────────────────────────


class TestStaticTokenProvider:
    async def test_authenticate_returns_static_token(self) -> None:
        provider = StaticTokenProvider("my-dev-token")
        client = httpx.AsyncClient()
        try:
            info = await provider.authenticate(client, "http://localhost:8200/v1")
            assert info.token == "my-dev-token"
            assert info.ttl == 0  # infinite
            assert not info.renewable
        finally:
            await client.aclose()

    def test_method_name(self) -> None:
        provider = StaticTokenProvider("tok")
        assert provider.method_name == "static"


# ── AppRole Provider Tests ──────────────────────────────────────────


class TestAppRoleProvider:
    def test_method_name(self) -> None:
        provider = AppRoleProvider("role-id", "secret-id")
        assert provider.method_name == "approle"

    async def test_authenticate_success(self) -> None:
        provider = AppRoleProvider("role-id", "secret-id", mount="approle")

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "auth": {
                "client_token": "s.new-token-123",
                "lease_duration": 7200,
                "renewable": True,
            }
        }

        client = AsyncMock(spec=httpx.AsyncClient)
        client.post = AsyncMock(return_value=mock_response)

        info = await provider.authenticate(client, "http://vault:8200/v1")
        assert info.token == "s.new-token-123"
        assert info.ttl == 7200
        assert info.renewable is True

        client.post.assert_called_once_with(
            "http://vault:8200/v1/auth/approle/login",
            json={"role_id": "role-id", "secret_id": "secret-id"},
        )

    async def test_authenticate_http_error(self) -> None:
        provider = AppRoleProvider("role-id", "bad-secret")

        mock_response = MagicMock()
        mock_response.status_code = 403
        mock_response.raise_for_status.side_effect = httpx.HTTPStatusError(
            "Forbidden", request=MagicMock(), response=mock_response
        )

        client = AsyncMock(spec=httpx.AsyncClient)
        client.post = AsyncMock(return_value=mock_response)

        with pytest.raises(VaultAuthError, match="approle"):
            await provider.authenticate(client, "http://vault:8200/v1")


# ── Kubernetes Provider Tests ───────────────────────────────────────


class TestKubernetesAuthProvider:
    def test_method_name(self) -> None:
        provider = KubernetesAuthProvider("my-role")
        assert provider.method_name == "kubernetes"

    async def test_authenticate_success(self) -> None:
        provider = KubernetesAuthProvider("my-role", token_path="/tmp/fake-token")

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "auth": {
                "client_token": "s.k8s-token-abc",
                "lease_duration": 3600,
                "renewable": True,
            }
        }

        client = AsyncMock(spec=httpx.AsyncClient)
        client.post = AsyncMock(return_value=mock_response)

        with patch.object(provider, "_read_sa_token", return_value="fake-jwt"):
            info = await provider.authenticate(client, "http://vault:8200/v1")

        assert info.token == "s.k8s-token-abc"
        assert info.ttl == 3600

    async def test_authenticate_missing_sa_token(self) -> None:
        provider = KubernetesAuthProvider("my-role", token_path="/nonexistent/path")
        client = AsyncMock(spec=httpx.AsyncClient)

        with pytest.raises(VaultAuthError) as exc_info:
            await provider.authenticate(client, "http://vault:8200/v1")
        assert "SA token not found" in exc_info.value.details["cause"]

    async def test_authenticate_http_error(self) -> None:
        provider = KubernetesAuthProvider("my-role")

        mock_response = MagicMock()
        mock_response.status_code = 403
        mock_response.raise_for_status.side_effect = httpx.HTTPStatusError(
            "Forbidden", request=MagicMock(), response=mock_response
        )

        client = AsyncMock(spec=httpx.AsyncClient)
        client.post = AsyncMock(return_value=mock_response)

        with patch.object(provider, "_read_sa_token", return_value="fake-jwt"):
            with pytest.raises(VaultAuthError, match="kubernetes"):
                await provider.authenticate(client, "http://vault:8200/v1")


# ── VaultTokenManager Tests ────────────────────────────────────────


class FakeProvider(StaticTokenProvider):
    """Test provider that tracks authenticate calls."""

    def __init__(self, token: str = "test-token", ttl: int = 0) -> None:
        super().__init__(token)
        self._ttl = ttl
        self.auth_count = 0

    async def authenticate(self, client, base_url) -> TokenInfo:
        self.auth_count += 1
        return TokenInfo(token=self._token, ttl=self._ttl, renewable=self._ttl > 0)


class TestVaultTokenManager:
    @pytest.fixture
    def settings(self) -> Settings:
        return Settings(
            crypto_base_url="http://localhost:8200/v1",
            vault_auth_method="static",
            vault_token_renewal_buffer_seconds=60,
            crypto_timeout_seconds=5.0,
        )

    async def test_start_static_no_loop(self, settings: Settings) -> None:
        provider = FakeProvider("my-token", ttl=0)
        manager = VaultTokenManager(provider, settings)
        await manager.start()
        try:
            assert manager.token == "my-token"
            assert manager._task is None  # No renewal loop for static
        finally:
            await manager.stop()

    async def test_start_with_ttl_starts_loop(self, settings: Settings) -> None:
        provider = FakeProvider("my-token", ttl=3600)
        manager = VaultTokenManager(provider, settings)
        await manager.start()
        try:
            assert manager.token == "my-token"
            assert manager._task is not None
            assert manager._running is True
        finally:
            await manager.stop()

    async def test_stop_cancels_task(self, settings: Settings) -> None:
        provider = FakeProvider("my-token", ttl=3600)
        manager = VaultTokenManager(provider, settings)
        await manager.start()
        await manager.stop()
        assert manager._running is False

    async def test_token_property_raises_when_no_token(self, settings: Settings) -> None:
        provider = FakeProvider("my-token", ttl=0)
        manager = VaultTokenManager(provider, settings)
        # Don't start — token_info is None
        with pytest.raises(VaultTokenExpiredError):
            _ = manager.token
        await manager.stop()

    async def test_token_property_raises_when_expired(self, settings: Settings) -> None:
        provider = FakeProvider("my-token", ttl=1)
        manager = VaultTokenManager(provider, settings)
        await manager.start()
        # Artificially expire the token
        manager._token_info.obtained_at = time.monotonic() - 10
        with pytest.raises(VaultTokenExpiredError):
            _ = manager.token
        await manager.stop()

    async def test_token_info_available_after_start(self, settings: Settings) -> None:
        provider = FakeProvider("my-token", ttl=300)
        manager = VaultTokenManager(provider, settings)
        await manager.start()
        try:
            assert manager.token_info is not None
            assert manager.token_info.token == "my-token"
            assert manager.token_info.remaining_ttl > 0
        finally:
            await manager.stop()

    async def test_authenticate_called_on_start(self, settings: Settings) -> None:
        provider = FakeProvider("my-token", ttl=0)
        manager = VaultTokenManager(provider, settings)
        await manager.start()
        try:
            assert provider.auth_count == 1
        finally:
            await manager.stop()

    async def test_renew_token_success(self, settings: Settings) -> None:
        provider = FakeProvider("my-token", ttl=3600)
        manager = VaultTokenManager(provider, settings)
        await manager.start()

        # Mock the renewal HTTP call
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {
            "auth": {
                "client_token": "my-token",
                "lease_duration": 7200,
                "renewable": True,
            }
        }
        manager._client.post = AsyncMock(return_value=mock_resp)

        success = await manager._renew_token()
        assert success is True
        assert manager.token_info.ttl == 7200

        await manager.stop()

    async def test_renew_token_failure_returns_false(self, settings: Settings) -> None:
        provider = FakeProvider("my-token", ttl=3600)
        manager = VaultTokenManager(provider, settings)
        await manager.start()

        # Mock failure
        manager._client.post = AsyncMock(side_effect=httpx.ConnectError("connection refused"))

        success = await manager._renew_token()
        assert success is False
        # Original token should still be available
        assert manager.token == "my-token"

        await manager.stop()

    async def test_renew_non_renewable_returns_false(self, settings: Settings) -> None:
        provider = FakeProvider("my-token", ttl=0)
        manager = VaultTokenManager(provider, settings)
        await manager.start()

        success = await manager._renew_token()
        assert success is False

        await manager.stop()


# ── Factory Tests ───────────────────────────────────────────────────


class TestCreateAuthProvider:
    def test_static(self) -> None:
        cfg = Settings(vault_auth_method="static", crypto_token="my-token")
        provider = create_auth_provider(cfg)
        assert isinstance(provider, StaticTokenProvider)
        assert provider.method_name == "static"

    def test_approle(self) -> None:
        cfg = Settings(
            vault_auth_method="approle",
            vault_approle_role_id="role-123",
            vault_approle_secret_id="secret-456",
            vault_approle_mount="custom-approle",
        )
        provider = create_auth_provider(cfg)
        assert isinstance(provider, AppRoleProvider)
        assert provider._mount == "custom-approle"

    def test_approle_missing_role_id(self) -> None:
        cfg = Settings(vault_auth_method="approle", vault_approle_role_id="")
        with pytest.raises(ValueError, match="vault_approle_role_id"):
            create_auth_provider(cfg)

    def test_approle_missing_secret_id(self) -> None:
        cfg = Settings(
            vault_auth_method="approle",
            vault_approle_role_id="role-123",
            vault_approle_secret_id="",
        )
        with pytest.raises(ValueError, match="vault_approle_secret_id"):
            create_auth_provider(cfg)

    def test_kubernetes(self) -> None:
        cfg = Settings(
            vault_auth_method="kubernetes",
            vault_k8s_role="my-role",
            vault_k8s_mount="custom-k8s",
        )
        provider = create_auth_provider(cfg)
        assert isinstance(provider, KubernetesAuthProvider)
        assert provider._role == "my-role"

    def test_kubernetes_missing_role(self) -> None:
        cfg = Settings(vault_auth_method="kubernetes", vault_k8s_role="")
        with pytest.raises(ValueError, match="vault_k8s_role"):
            create_auth_provider(cfg)

    def test_unknown_method(self) -> None:
        cfg = Settings(vault_auth_method="ldap")
        with pytest.raises(ValueError, match="Unknown vault_auth_method"):
            create_auth_provider(cfg)


# ── Error Tests ─────────────────────────────────────────────────────


class TestVaultErrors:
    def test_vault_auth_error(self) -> None:
        err = VaultAuthError("approle", cause="HTTP 403")
        assert "approle" in err.message
        assert err.code == "VAULT_AUTH_FAILED"
        assert err.details["method"] == "approle"
        assert err.details["cause"] == "HTTP 403"

    def test_vault_token_expired_error(self) -> None:
        err = VaultTokenExpiredError()
        assert "expired" in err.message.lower()
        assert err.code == "VAULT_TOKEN_EXPIRED"
