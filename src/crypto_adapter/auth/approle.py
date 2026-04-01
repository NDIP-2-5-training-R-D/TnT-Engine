import asyncio
import logging
from datetime import datetime, timezone

import httpx

from crypto_adapter.auth.exceptions import OpenBaoAuthError, OpenBaoUnavailableError
from crypto_adapter.auth.models import OpenBaoToken
from crypto_adapter.config import Settings

logger = logging.getLogger(__name__)


class AppRoleAuth:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client: httpx.AsyncClient | None = None
        self._token: OpenBaoToken | None = None
        self._lock = asyncio.Lock()
        self._renew_task: asyncio.Task | None = None

    async def start(self) -> None:
        self._client = httpx.AsyncClient(
            base_url=self._settings.OPENBAO_ADDR,
            timeout=10.0,
        )
        await self.login()
        self._renew_task = asyncio.create_task(self._auto_renew_loop())

    async def stop(self) -> None:
        if self._renew_task is not None:
            self._renew_task.cancel()
            try:
                await self._renew_task
            except asyncio.CancelledError:
                pass
            self._renew_task = None
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def login(self) -> None:
        assert self._client is not None, "Client not initialised; call start() first"
        try:
            resp = await self._client.post(
                "/v1/auth/approle/login",
                json={
                    "role_id": self._settings.OPENBAO_ROLE_ID,
                    "secret_id": self._settings.OPENBAO_SECRET_ID,
                },
            )
        except httpx.TransportError as exc:
            raise OpenBaoUnavailableError(f"OpenBao unreachable during login: {exc}") from exc

        if resp.status_code != 200:
            raise OpenBaoAuthError(
                f"AppRole login failed with status {resp.status_code}: {resp.text}"
            )

        data = resp.json()["auth"]
        self._token = OpenBaoToken(
            client_token=data["client_token"],
            lease_duration=data["lease_duration"],
            renewable=data["renewable"],
            acquired_at=datetime.now(timezone.utc),
        )
        logger.info(
            "AppRole login successful. Token expires at %s", self._token.expires_at.isoformat()
        )

    async def get_token(self) -> OpenBaoToken:
        # Fast path: valid token already cached — no lock needed.
        # asyncio is single-threaded so reading self._token here is race-free;
        # the only yield points are inside `await self.login()` below.
        if self._token is not None and not self._token.is_expired:
            return self._token

        # Slow path: acquire lock, re-check, then login if still needed.
        # Other callers that arrive while login is in flight will wait here
        # and find a fresh token on their turn — avoiding duplicate logins.
        async with self._lock:
            if self._token is None or self._token.is_expired:
                logger.info("Token absent or expired — re-logging in")
                await self.login()
        return self._token  # type: ignore[return-value]

    async def renew_token(self) -> None:
        assert self._client is not None
        assert self._token is not None
        try:
            resp = await self._client.post(
                "/v1/auth/token/renew-self",
                headers={"X-Vault-Token": self._token.client_token},
            )
        except httpx.TransportError as exc:
            raise OpenBaoUnavailableError(f"OpenBao unreachable during renew: {exc}") from exc

        if resp.status_code == 403:
            logger.warning("Token renewal returned 403 — falling back to login")
            await self.login()
            return

        if resp.status_code != 200:
            raise OpenBaoAuthError(
                f"Token renewal failed with status {resp.status_code}: {resp.text}"
            )

        data = resp.json()["auth"]
        self._token = OpenBaoToken(
            client_token=data["client_token"],
            lease_duration=data["lease_duration"],
            renewable=data["renewable"],
            acquired_at=datetime.now(timezone.utc),
        )
        logger.info("Token renewed. New expiry: %s", self._token.expires_at.isoformat())

    async def _auto_renew_loop(self) -> None:
        """Background coroutine that renews the token before it expires. Never raises."""
        while True:
            try:
                token = self._token
                if token is None:
                    await asyncio.sleep(5)
                    continue

                sleep_for = token.seconds_until_renew
                if sleep_for > 0:
                    await asyncio.sleep(sleep_for)

                await self.renew_token()
            except asyncio.CancelledError:
                return
            except Exception as exc:  # noqa: BLE001
                logger.error("Error in auto-renew loop: %s — retrying in 30s", exc)
                await asyncio.sleep(30)
