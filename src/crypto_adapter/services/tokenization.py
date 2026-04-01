"""Tokenization service: encrypt + encode into URL-safe opaque tokens (reversible)."""
import base64
import re

from crypto_adapter.client.openbao_client import OpenBaoClient

_VAULT_PREFIX = "vault:v1:"
_TOKEN_PREFIX = "tt1_"
_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")


class TokenizationService:
    def __init__(self, client: OpenBaoClient) -> None:
        self._client = client

    async def tokenize(self, value: str, key_name: str) -> str:
        """Encrypt *value* and return an opaque tt1_ token."""
        ciphertext = await self._client.encrypt(value, key_name)
        # Strip "vault:v1:" prefix, base64url-encode the remainder (no padding)
        vault_suffix = ciphertext[len(_VAULT_PREFIX):]
        encoded = base64.urlsafe_b64encode(vault_suffix.encode()).rstrip(b"=").decode()
        return f"{_TOKEN_PREFIX}{encoded}"

    async def detokenize(self, token: str, key_name: str) -> str:
        """Decode an opaque tt1_ token and return the original plaintext."""
        if not token.startswith(_TOKEN_PREFIX):
            raise ValueError("Invalid token format")
        encoded = token[len(_TOKEN_PREFIX):]
        # Restore padding so b64decode is happy
        padding = (4 - len(encoded) % 4) % 4
        vault_suffix = base64.urlsafe_b64decode(encoded + "=" * padding).decode()
        ciphertext = _VAULT_PREFIX + vault_suffix
        return await self._client.decrypt(ciphertext, key_name)

    @staticmethod
    def is_valid_token(token: str) -> bool:
        """Return True if *token* has the tt1_ prefix and valid base64url characters."""
        if not token.startswith(_TOKEN_PREFIX):
            return False
        encoded = token[len(_TOKEN_PREFIX):]
        return bool(encoded) and bool(_B64URL_RE.match(encoded))
