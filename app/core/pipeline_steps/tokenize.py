from app.adapters.crypto_adapter import get_crypto_adapter


class TokenizeStep:
    name = "tokenize"

    async def run(self, value, context: dict) -> str:
        transformation = context.get("transformation", "default")
        convergent = context.get("convergent", False)
        adapter = get_crypto_adapter()
        return await adapter.tokenize(transformation, str(value), convergent)
