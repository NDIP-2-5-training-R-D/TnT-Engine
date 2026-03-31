"""
Low-level async HTTP client for OpenBao (Vault-compatible) REST API.
"""
import base64
import httpx
from app.core.config import settings


class OpenBaoClient:
    def __init__(self):
        self._base = settings.openbao_addr.rstrip("/")
        self._headers = {
            "X-Vault-Token": settings.openbao_token,
            "Content-Type": "application/json",
        }

    # ------------------------------------------------------------------
    # Internal helper
    # ------------------------------------------------------------------
    async def _post(self, path: str, body: dict) -> dict:
        url = f"{self._base}/v1/{path}"
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, headers=self._headers, json=body)
            resp.raise_for_status()
            return resp.json()

    # ------------------------------------------------------------------
    # Transit
    # ------------------------------------------------------------------
    async def encrypt(self, key_name: str, plaintext: str) -> str:
        """Return vault ciphertext string."""
        b64 = base64.b64encode(plaintext.encode()).decode()
        data = await self._post(f"transit/encrypt/{key_name}", {"plaintext": b64})
        return data["data"]["ciphertext"]

    async def decrypt(self, key_name: str, ciphertext: str) -> str:
        """Return original plaintext string."""
        data = await self._post(f"transit/decrypt/{key_name}", {"ciphertext": ciphertext})
        b64 = data["data"]["plaintext"]
        return base64.b64decode(b64).decode()

    # ------------------------------------------------------------------
    # Transform (FPE tokenization)
    # ------------------------------------------------------------------
    async def tokenize(self, role: str, transformation: str, value: str) -> str:
        data = await self._post(
            f"transform/encode/{role}",
            {"value": value, "transformation": transformation},
        )
        return data["data"]["encoded_value"]

    async def detokenize(self, role: str, transformation: str, value: str) -> str:
        data = await self._post(
            f"transform/decode/{role}",
            {"value": value, "transformation": transformation},
        )
        return data["data"]["decoded_value"]


# Singleton
bao_client = OpenBaoClient()
