import asyncio
import base64
import logging

import httpx

from crypto_adapter.auth import AppRoleAuth
from crypto_adapter.auth.exceptions import OpenBaoAuthError, OpenBaoCryptoError, OpenBaoUnavailableError
from crypto_adapter.client.resilience import CircuitBreaker, with_retry
from crypto_adapter.config import Settings

logger = logging.getLogger(__name__)


class OpenBaoClient:
    def __init__(self, settings: Settings, auth: AppRoleAuth) -> None:
        self._settings = settings
        self._auth = auth
        self._client: httpx.AsyncClient | None = None
        self._circuit_breaker = CircuitBreaker()

    async def start(self) -> None:
        self._client = httpx.AsyncClient(
            base_url=self._settings.OPENBAO_ADDR,
            timeout=10.0,
        )

    async def stop(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _request(self, method: str, path: str, payload: dict | None = None) -> dict:
        assert self._client is not None, "Client not started; call start() first"
        client = self._client

        async def _do() -> dict:
            token = await self._auth.get_token()
            headers = {"X-Vault-Token": token.client_token}
            try:
                resp = await client.request(method, path, json=payload, headers=headers)
            except httpx.TransportError as exc:
                raise OpenBaoUnavailableError(f"OpenBao unreachable: {exc}") from exc

            if resp.status_code == 403:
                logger.warning("Got 403 from OpenBao — forcing re-login and retrying once")
                await self._auth.login()
                fresh_token = await self._auth.get_token()
                headers = {"X-Vault-Token": fresh_token.client_token}
                try:
                    resp = await client.request(method, path, json=payload, headers=headers)
                except httpx.TransportError as exc:
                    raise OpenBaoUnavailableError(f"OpenBao unreachable after re-login: {exc}") from exc

            if resp.status_code == 403:
                raise OpenBaoAuthError(f"Auth failed even after re-login: {resp.text}")

            if resp.status_code not in (200, 204):
                raise OpenBaoCryptoError(
                    f"OpenBao returned {resp.status_code}: {resp.text}"
                )

            return resp.json() if resp.status_code == 200 else {}

        return await self._circuit_breaker.call(_do)

    # ------------------------------------------------------------------ #
    # Public crypto operations                                             #
    # ------------------------------------------------------------------ #

    async def hmac(self, input_data: str, key_name: str) -> str:
        """Compute HMAC-SHA-512 of input_data using the named transit key."""
        b64_input = base64.b64encode(input_data.encode()).decode()
        result = await with_retry(
            lambda: self._request(
                "POST",
                f"/v1/transit/hmac/{key_name}/sha2-512",
                {"input": b64_input},
            )
        )
        return result["data"]["hmac"]

    async def encrypt(self, plaintext: str, key_name: str) -> str:
        """Encrypt plaintext using the named transit key."""
        b64_plaintext = base64.b64encode(plaintext.encode()).decode()
        result = await with_retry(
            lambda: self._request(
                "POST",
                f"/v1/transit/encrypt/{key_name}",
                {"plaintext": b64_plaintext},
            )
        )
        return result["data"]["ciphertext"]

    async def decrypt(self, ciphertext: str, key_name: str) -> str:
        """Decrypt ciphertext using the named transit key."""
        result = await with_retry(
            lambda: self._request(
                "POST",
                f"/v1/transit/decrypt/{key_name}",
                {"ciphertext": ciphertext},
            )
        )
        return base64.b64decode(result["data"]["plaintext"]).decode()

    async def get_key_info(self, key_name: str) -> dict:
        """Return key metadata for the named transit key."""
        result = await with_retry(
            lambda: self._request("GET", f"/v1/transit/keys/{key_name}")
        )
        return result["data"]

    async def rotate_key(self, key_name: str) -> None:
        """Rotate the named transit key."""
        await with_retry(
            lambda: self._request("POST", f"/v1/transit/keys/{key_name}/rotate")
        )
