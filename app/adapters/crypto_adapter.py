import hashlib
import hmac as _hmac
import uuid
import logging

logger = logging.getLogger(__name__)


class CryptoAdapter:
    """
    Mock crypto adapter — will be replaced by real OpenBao calls (Longth0903).
    All methods mirror the interface that the real adapter must implement.
    TODO: replace mock implementations with HTTP calls to OpenBao.
    """

    async def hmac(self, key_name: str, value: str) -> str:
        """Mock HMAC-SHA512 using a hardcoded key."""
        # TODO: call OpenBao /v1/transit/hmac/{key_name}
        result = _hmac.new(b"mock-key", value.encode("utf-8"), hashlib.sha512).hexdigest()
        logger.debug("MOCK hmac key=%s result=%s...", key_name, result[:16])
        return result

    async def tokenize(self, transformation: str, value: str, convergent: bool = False) -> str:
        """Mock tokenization — returns a random token each call."""
        # TODO: call OpenBao /v1/transform/encode/{role_name} with tokenization
        token = f"tok_{uuid.uuid4().hex[:16]}"
        logger.debug("MOCK tokenize transformation=%s token=%s", transformation, token)
        return token

    async def detokenize(self, transformation: str, token: str) -> str:
        """Mock detokenization — not reversible in mock mode."""
        # TODO: call OpenBao /v1/transform/decode/{role_name}
        logger.debug("MOCK detokenize transformation=%s token=%s", transformation, token)
        return "MOCK_DETOKENIZED"

    async def fpe_encrypt(self, transformation: str, value: str) -> str:
        """Mock FPE encrypt — reverses string as stand-in."""
        # TODO: call OpenBao /v1/transform/encode/{role_name} with FPE
        return value[::-1]

    async def fpe_decrypt(self, transformation: str, value: str) -> str:
        """Mock FPE decrypt — reverses string back."""
        # TODO: call OpenBao /v1/transform/decode/{role_name} with FPE
        return value[::-1]

    async def transit_encrypt(self, key_name: str, plaintext_b64: str) -> str:
        """Mock transit encrypt."""
        # TODO: call OpenBao /v1/transit/encrypt/{key_name}
        return f"vault:v1:{plaintext_b64[::-1]}"

    async def transit_decrypt(self, key_name: str, ciphertext: str) -> str:
        """Mock transit decrypt — strips prefix and un-reverses."""
        # TODO: call OpenBao /v1/transit/decrypt/{key_name}
        payload = ciphertext.replace("vault:v1:", "")
        return payload[::-1]

    async def transit_sign(self, key_name: str, input_b64: str) -> str:
        """Mock transit sign."""
        # TODO: call OpenBao /v1/transit/sign/{key_name}
        return f"vault:v1:sig_{input_b64[:8]}"

    async def transit_verify(self, key_name: str, input_b64: str, signature: str) -> bool:
        """Mock transit verify — always True in mock."""
        # TODO: call OpenBao /v1/transit/verify/{key_name}
        return True


_crypto_adapter = CryptoAdapter()


def get_crypto_adapter() -> CryptoAdapter:
    return _crypto_adapter
