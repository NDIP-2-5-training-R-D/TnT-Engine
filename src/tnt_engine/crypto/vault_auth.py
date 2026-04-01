"""OpenBao/Vault token lifecycle management.

Provides automatic authentication and token renewal for OpenBao.
Supports three auth methods:

  - static:     Use a pre-configured token (dev/legacy only)
  - approle:    Authenticate with role_id + secret_id (service-to-service)
  - kubernetes: Authenticate with K8s ServiceAccount JWT (K8s workloads)

The VaultTokenManager runs a background renewal loop that:
  1. Checks token TTL at regular intervals
  2. Renews before expiry (configurable buffer)
  3. Re-authenticates if renewal fails
  4. Exposes current token via thread-safe property

Security invariants:
  - secret_id and ServiceAccount JWT are NEVER logged
  - Token value is NEVER logged (only TTL and metadata)
  - Concurrent readers always see a valid token (asyncio.Lock on writes)
"""

from __future__ import annotations

import abc
import asyncio
import time

import httpx

from tnt_engine.config import Settings
from tnt_engine.errors import VaultAuthError, VaultTokenExpiredError
from tnt_engine.logging import get_logger
from tnt_engine.metrics import VAULT_AUTH_ERRORS, VAULT_TOKEN_RENEWALS, VAULT_TOKEN_TTL

logger = get_logger(__name__)


# ── Auth Provider Interface ─────────────────────────────────────────


class VaultAuthProvider(abc.ABC):
    """Authenticates to OpenBao/Vault and returns a client token."""

    @abc.abstractmethod
    async def authenticate(self, client: httpx.AsyncClient, base_url: str) -> TokenInfo:
        """Perform authentication. Returns token info with TTL."""
        ...

    @property
    @abc.abstractmethod
    def method_name(self) -> str:
        """Name of the auth method for logging/metrics."""
        ...


class TokenInfo:
    """Holds a Vault token and its metadata."""

    __slots__ = ("token", "ttl", "renewable", "obtained_at")

    def __init__(self, token: str, ttl: int, renewable: bool) -> None:
        self.token = token
        self.ttl = ttl  # seconds
        self.renewable = renewable
        self.obtained_at = time.monotonic()

    @property
    def remaining_ttl(self) -> float:
        """Estimated remaining TTL in seconds."""
        elapsed = time.monotonic() - self.obtained_at
        return max(0.0, self.ttl - elapsed)

    @property
    def is_expired(self) -> bool:
        return self.remaining_ttl <= 0


# ── Static Token Provider ───────────────────────────────────────────


class StaticTokenProvider(VaultAuthProvider):
    """Uses a pre-configured static token. No renewal possible.

    Suitable for development or when an external system manages rotation.
    """

    def __init__(self, token: str) -> None:
        self._token = token

    async def authenticate(self, client: httpx.AsyncClient, base_url: str) -> TokenInfo:
        # Static tokens are assumed non-expiring (TTL=0 means infinite in Vault)
        return TokenInfo(token=self._token, ttl=0, renewable=False)

    @property
    def method_name(self) -> str:
        return "static"


# ── AppRole Provider ────────────────────────────────────────────────


class AppRoleProvider(VaultAuthProvider):
    """Authenticates via AppRole (role_id + secret_id).

    Used for service-to-service auth. The secret_id should be
    injected from a secure source (K8s Secret, env var).
    """

    def __init__(self, role_id: str, secret_id: str, mount: str = "approle") -> None:
        self._role_id = role_id
        self._secret_id = secret_id
        self._mount = mount

    async def authenticate(self, client: httpx.AsyncClient, base_url: str) -> TokenInfo:
        url = f"{base_url}/auth/{self._mount}/login"
        try:
            resp = await client.post(
                url,
                json={"role_id": self._role_id, "secret_id": self._secret_id},
            )
            resp.raise_for_status()
            data = resp.json()
            auth = data["auth"]
            return TokenInfo(
                token=auth["client_token"],
                ttl=auth.get("lease_duration", 3600),
                renewable=auth.get("renewable", True),
            )
        except httpx.HTTPStatusError as exc:
            VAULT_AUTH_ERRORS.labels(method="approle").inc()
            raise VaultAuthError("approle", cause=f"HTTP {exc.response.status_code}") from exc
        except Exception as exc:
            VAULT_AUTH_ERRORS.labels(method="approle").inc()
            raise VaultAuthError("approle", cause=str(exc)) from exc

    @property
    def method_name(self) -> str:
        return "approle"


# ── Kubernetes Provider ─────────────────────────────────────────────


class KubernetesAuthProvider(VaultAuthProvider):
    """Authenticates via Kubernetes ServiceAccount JWT.

    Reads the SA token from the pod's mounted volume.
    """

    def __init__(
        self, role: str, mount: str = "kubernetes",
        token_path: str = "/var/run/secrets/kubernetes.io/serviceaccount/token",
    ) -> None:
        self._role = role
        self._mount = mount
        self._token_path = token_path

    async def authenticate(self, client: httpx.AsyncClient, base_url: str) -> TokenInfo:
        try:
            jwt = self._read_sa_token()
        except FileNotFoundError as exc:
            VAULT_AUTH_ERRORS.labels(method="kubernetes").inc()
            raise VaultAuthError(
                "kubernetes", cause=f"SA token not found: {self._token_path}"
            ) from exc

        url = f"{base_url}/auth/{self._mount}/login"
        try:
            resp = await client.post(
                url,
                json={"role": self._role, "jwt": jwt},
            )
            resp.raise_for_status()
            data = resp.json()
            auth = data["auth"]
            return TokenInfo(
                token=auth["client_token"],
                ttl=auth.get("lease_duration", 3600),
                renewable=auth.get("renewable", True),
            )
        except httpx.HTTPStatusError as exc:
            VAULT_AUTH_ERRORS.labels(method="kubernetes").inc()
            raise VaultAuthError("kubernetes", cause=f"HTTP {exc.response.status_code}") from exc
        except VaultAuthError:
            raise
        except Exception as exc:
            VAULT_AUTH_ERRORS.labels(method="kubernetes").inc()
            raise VaultAuthError("kubernetes", cause=str(exc)) from exc

    def _read_sa_token(self) -> str:
        with open(self._token_path) as f:
            return f.read().strip()

    @property
    def method_name(self) -> str:
        return "kubernetes"


# ── Token Manager ───────────────────────────────────────────────────


class VaultTokenManager:
    """Manages the Vault token lifecycle: authenticate, renew, re-auth.

    The manager runs a background loop that keeps the token fresh.
    Consumers access the current token via the `token` property,
    which is always safe to call from any coroutine.

    Usage:
        manager = VaultTokenManager(provider, settings)
        await manager.start()

        # In OpenBaoCryptoBackend:
        token = manager.token  # always current

        await manager.stop()
    """

    def __init__(
        self,
        provider: VaultAuthProvider,
        settings: Settings,
    ) -> None:
        self._provider = provider
        self._base_url = settings.crypto_base_url.rstrip("/").rsplit("/v1", 1)[0] + "/v1"
        self._renewal_buffer = settings.vault_token_renewal_buffer_seconds
        self._timeout = settings.crypto_timeout_seconds

        self._token_info: TokenInfo | None = None
        self._lock = asyncio.Lock()
        from tnt_engine.crypto._http import build_httpx_client
        self._client = build_httpx_client(settings, timeout=self._timeout)
        self._task: asyncio.Task | None = None
        self._running = False

    @property
    def token(self) -> str:
        """Current valid token. Raises VaultTokenExpiredError if unavailable."""
        if self._token_info is None:
            raise VaultTokenExpiredError()
        if self._token_info.is_expired and self._token_info.ttl > 0:
            raise VaultTokenExpiredError()
        return self._token_info.token

    @property
    def token_info(self) -> TokenInfo | None:
        return self._token_info

    async def start(self) -> None:
        """Perform initial authentication and start the renewal loop."""
        await self._authenticate()
        if self._token_info and self._token_info.ttl > 0:
            self._running = True
            self._task = asyncio.create_task(self._renewal_loop())
            logger.info(
                "vault_token_manager_started",
                method=self._provider.method_name,
                ttl=self._token_info.ttl,
                renewable=self._token_info.renewable,
            )
        else:
            logger.info(
                "vault_token_manager_static",
                method=self._provider.method_name,
                msg="Token has no TTL, renewal loop not started",
            )

    async def stop(self) -> None:
        """Stop the renewal loop and close the HTTP client."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        await self._client.aclose()
        logger.info("vault_token_manager_stopped")

    async def _authenticate(self) -> None:
        """Perform full authentication via the configured provider."""
        async with self._lock:
            token_info = await self._provider.authenticate(self._client, self._base_url)
            self._token_info = token_info
            if token_info.ttl > 0:
                VAULT_TOKEN_TTL.set(token_info.ttl)
            logger.info(
                "vault_authenticated",
                method=self._provider.method_name,
                ttl=token_info.ttl,
                renewable=token_info.renewable,
            )

    async def _renew_token(self) -> bool:
        """Attempt to renew the current token. Returns True on success."""
        if not self._token_info or not self._token_info.renewable:
            return False

        try:
            resp = await self._client.post(
                f"{self._base_url}/auth/token/renew-self",
                headers={"X-Vault-Token": self._token_info.token},
            )
            resp.raise_for_status()
            data = resp.json()
            auth = data.get("auth", {})

            async with self._lock:
                new_ttl = auth.get("lease_duration", self._token_info.ttl)
                self._token_info = TokenInfo(
                    token=auth.get("client_token", self._token_info.token),
                    ttl=new_ttl,
                    renewable=auth.get("renewable", True),
                )
                VAULT_TOKEN_TTL.set(new_ttl)

            VAULT_TOKEN_RENEWALS.labels(status="success").inc()
            logger.info("vault_token_renewed", new_ttl=new_ttl)
            return True

        except Exception as exc:
            VAULT_TOKEN_RENEWALS.labels(status="failure").inc()
            VAULT_AUTH_ERRORS.labels(method="renew").inc()
            logger.warning("vault_token_renewal_failed", error=str(exc))
            return False

    async def _renewal_loop(self) -> None:
        """Background loop that renews the token before it expires."""
        while self._running:
            try:
                if self._token_info is None:
                    await self._authenticate()
                    await asyncio.sleep(10)
                    continue

                remaining = self._token_info.remaining_ttl
                VAULT_TOKEN_TTL.set(remaining)

                # Calculate sleep time: wake up when TTL hits the renewal buffer
                sleep_time = max(remaining - self._renewal_buffer, 10)

                if remaining <= self._renewal_buffer:
                    # Time to renew
                    success = await self._renew_token()
                    if not success:
                        # Renewal failed — try full re-authentication
                        logger.warning("vault_renewal_failed_reauthenticating")
                        try:
                            await self._authenticate()
                        except VaultAuthError:
                            logger.error(
                                "vault_reauth_failed",
                                remaining_ttl=self._token_info.remaining_ttl
                                if self._token_info else 0,
                            )
                            # Back off and retry
                            await asyncio.sleep(min(30, remaining / 2))
                            continue
                    # After successful renewal/reauth, recalculate
                    continue

                await asyncio.sleep(sleep_time)

            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("vault_renewal_loop_error")
                await asyncio.sleep(10)


# ── Factory ─────────────────────────────────────────────────────────


def create_auth_provider(settings: Settings) -> VaultAuthProvider:
    """Create the appropriate VaultAuthProvider based on settings."""
    method = settings.vault_auth_method.lower()

    if method == "static":
        return StaticTokenProvider(settings.crypto_token)

    elif method == "approle":
        if not settings.vault_approle_role_id:
            raise ValueError("vault_approle_role_id is required when vault_auth_method=approle")
        if not settings.vault_approle_secret_id:
            raise ValueError("vault_approle_secret_id is required when vault_auth_method=approle")
        return AppRoleProvider(
            role_id=settings.vault_approle_role_id,
            secret_id=settings.vault_approle_secret_id,
            mount=settings.vault_approle_mount,
        )

    elif method == "kubernetes":
        if not settings.vault_k8s_role:
            raise ValueError("vault_k8s_role is required when vault_auth_method=kubernetes")
        return KubernetesAuthProvider(
            role=settings.vault_k8s_role,
            mount=settings.vault_k8s_mount,
            token_path=settings.vault_k8s_token_path,
        )

    else:
        raise ValueError(
            f"Unknown vault_auth_method: {method!r}. "
            f"Expected one of: static, approle, kubernetes"
        )
