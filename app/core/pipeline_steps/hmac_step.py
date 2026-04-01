from app.adapters.crypto_adapter import get_crypto_adapter


class HMACStep:
    name = "hmac"

    async def run(self, value, context: dict) -> str:
        key_name = context.get("key_name", "default")
        adapter = get_crypto_adapter()
        return await adapter.hmac(key_name, str(value))
