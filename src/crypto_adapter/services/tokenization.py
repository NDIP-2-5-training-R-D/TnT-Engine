"""Tokenization service: encrypt + encode into URL-safe opaque tokens (reversible).

Token format:  tt1_<base64url-no-padding>
               where the base64url payload is the full OpenBao ciphertext
               (including the vault:vN: version prefix).

Encoding the complete ciphertext — rather than stripping the vault:vN: prefix —
ensures tokens remain detokenizable after key rotation, when OpenBao starts
returning vault:v2:, vault:v3:, … prefixes.
"""
import base64
import re

from crypto_adapter.client.openbao_client import OpenBaoClient

_TOKEN_PREFIX = "tt1_"
_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")


class TokenizationService:
    def __init__(self, client: OpenBaoClient) -> None:
        self._client = client

    async def tokenize(self, value: str, key_name: str) -> str:
        """Encrypt *value* and return an opaque tt1_ token.

        The full OpenBao ciphertext (vault:vN:…) is base64url-encoded so the
        token remains valid across key rotations.
        """
        ciphertext = await self._client.encrypt(value, key_name)
        encoded = (
            base64.urlsafe_b64encode(ciphertext.encode()).rstrip(b"=").decode()
        )
        return f"{_TOKEN_PREFIX}{encoded}"

    async def detokenize(self, token: str, key_name: str) -> str:
        """Decode an opaque tt1_ token and return the original plaintext."""
        if not token.startswith(_TOKEN_PREFIX):
            raise ValueError("Invalid token format")
        encoded = token[len(_TOKEN_PREFIX):]
        padding = (4 - len(encoded) % 4) % 4
        ciphertext = base64.urlsafe_b64decode(encoded + "=" * padding).decode()
        return await self._client.decrypt(ciphertext, key_name)

    @staticmethod
    def is_valid_token(token: str) -> bool:
        """Return True if *token* has the tt1_ prefix and valid base64url characters."""
        if not token.startswith(_TOKEN_PREFIX):
            return False
        encoded = token[len(_TOKEN_PREFIX):]
        return bool(encoded) and bool(_B64URL_RE.match(encoded))
