"""Key management service: wraps OpenBaoClient with higher-level key operations."""
from datetime import datetime, timezone

from crypto_adapter.client.openbao_client import OpenBaoClient


class KeyManagementService:
    def __init__(self, client: OpenBaoClient) -> None:
        self._client = client

    async def get_key_version(self, key_name: str) -> dict:
        """Return structured version metadata for *key_name*."""
        info = await self._client.get_key_info(key_name)
        return {
            "key_name": key_name,
            "current_version": info["latest_version"],
            "min_decryption_version": info["min_decryption_version"],
            "type": info["type"],
            "versions": info.get("keys", {}),
        }

    async def rotate_key(self, key_name: str) -> dict:
        """Rotate *key_name* and return before/after version details."""
        info_before = await self._client.get_key_info(key_name)
        previous_version = info_before["latest_version"]
        await self._client.rotate_key(key_name)
        info_after = await self._client.get_key_info(key_name)
        new_version = info_after["latest_version"]
        return {
            "key_name": key_name,
            "previous_version": previous_version,
            "new_version": new_version,
            "rotated_at": datetime.now(timezone.utc).isoformat(),
        }

    async def set_min_decryption_version(self, version: int, key_name: str) -> dict:
        """Set the minimum decryption version for *key_name*."""
        await self._client.set_key_config(key_name, {"min_decryption_version": version})
        return {"key_name": key_name, "min_decryption_version": version}
