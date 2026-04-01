"""Unit tests for the SDK client v4 — with policy engine and failure shield."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from tnt_engine.config import Settings
from tnt_engine.errors import InvalidTokenFormatError, TNTError, TokenNotFoundError, TokenRevokedError
from tnt_engine.sdk.client import TNTClient, _Resources
from tnt_engine.service.policy import PolicyEngine
from tnt_engine.service.token_service import TokenService
from tests.conftest import TENANT, FakeCryptoBackend, FakeLayeredCache, FakeTokenRepository

T = TENANT


@pytest.fixture
def sdk_client() -> TNTClient:
    settings = Settings()
    crypto = FakeCryptoBackend()
    repo = FakeTokenRepository()
    cache = FakeLayeredCache()

    svc = TokenService(
        hmac=crypto,           # type: ignore[arg-type]
        encryption=crypto,     # type: ignore[arg-type]
        repo=repo,             # type: ignore[arg-type]
        cache=cache,           # type: ignore[arg-type]
        settings=settings,
    )

    policy_engine = PolicyEngine(token_service=svc, hmac_service=crypto)  # type: ignore[arg-type]

    resources = MagicMock(spec=_Resources)
    resources.backend = MagicMock()
    resources.backend.state = "CLOSED"
    resources.backend.close = AsyncMock()
    resources.cache = MagicMock()
    resources.cache.close = AsyncMock()
    resources.db = MagicMock()
    resources.db.close = AsyncMock()

    return TNTClient(service=svc, policy_engine=policy_engine, _resources=resources)


class TestSDKTokenize:
    async def test_tokenize(self, sdk_client: TNTClient) -> None:
        token = await sdk_client.tokenize("123", field_type="ssn", tenant_id=T)
        assert isinstance(token, str)
        assert token.startswith("tok_")

    async def test_convergent(self, sdk_client: TNTClient) -> None:
        t1 = await sdk_client.tokenize("same", field_type="f", tenant_id=T)
        t2 = await sdk_client.tokenize("same", field_type="f", tenant_id=T)
        assert t1 == t2

    async def test_round_trip(self, sdk_client: TNTClient) -> None:
        token = await sdk_client.tokenize("secret", field_type="name", tenant_id=T)
        value = await sdk_client.detokenize(token, tenant_id=T)
        assert value == "secret"

    async def test_tenant_isolation(self, sdk_client: TNTClient) -> None:
        t1 = await sdk_client.tokenize("val", field_type="f", tenant_id="a")
        t2 = await sdk_client.tokenize("val", field_type="f", tenant_id="b")
        assert t1 != t2

    async def test_context_parameter_accepted(self, sdk_client: TNTClient) -> None:
        """context parameter should be accepted without error."""
        token = await sdk_client.tokenize(
            "val", field_type="f", tenant_id=T,
            context={"request_id": "r-123", "source": "payment_svc"},
        )
        assert token.startswith("tok_")


class TestSDKBatch:
    async def test_batch_tokenize(self, sdk_client: TNTClient) -> None:
        items = [("v1", "f1"), ("v2", "f2"), ("v1", "f3")]
        tokens = await sdk_client.tokenize_batch(items, tenant_id=T)
        assert len(tokens) == 3
        assert tokens[0] == tokens[2]

    async def test_batch_detokenize(self, sdk_client: TNTClient) -> None:
        items = [("a", "f"), ("b", "f")]
        tokens = await sdk_client.tokenize_batch(items, tenant_id=T)
        values = await sdk_client.detokenize_batch(tokens, tenant_id=T)
        assert values == ["a", "b"]


class TestSDKLifecycle:
    async def test_revoke(self, sdk_client: TNTClient) -> None:
        token = await sdk_client.tokenize("rev", field_type="f", tenant_id=T)
        assert await sdk_client.revoke(token, tenant_id=T) is True
        with pytest.raises(TokenRevokedError):
            await sdk_client.detokenize(token, tenant_id=T)

    async def test_delete(self, sdk_client: TNTClient) -> None:
        token = await sdk_client.tokenize("del", field_type="f", tenant_id=T)
        assert await sdk_client.delete(token, tenant_id=T) is True
        with pytest.raises(TokenNotFoundError):
            await sdk_client.detokenize(token, tenant_id=T)


class TestSDKMasking:
    def test_mask_email(self, sdk_client: TNTClient) -> None:
        assert sdk_client.mask("john@example.com", "email") == "j***@example.com"

    def test_mask_ssn(self, sdk_client: TNTClient) -> None:
        assert sdk_client.mask("123-45-6789", "ssn") == "***-**-6789"

    def test_mask_card(self, sdk_client: TNTClient) -> None:
        assert sdk_client.mask("4111111111111111", "card") == "****-****-****-1111"


class TestSDKPolicy:
    async def test_process_field_tokenize(self, sdk_client: TNTClient) -> None:
        result = await sdk_client.process_field(
            {"field": "ssn", "action": "TOKENIZE"},
            value="123-45-6789",
            tenant_id=T,
        )
        assert result.field == "ssn"
        assert result.transformed_value.startswith("tok_")

    async def test_process_field_mask(self, sdk_client: TNTClient) -> None:
        result = await sdk_client.process_field(
            {"field": "email", "action": "MASK"},
            value="john@acme.com",
            tenant_id=T,
        )
        assert result.transformed_value == "j***@acme.com"

    async def test_process_record(self, sdk_client: TNTClient) -> None:
        results = await sdk_client.process_record(
            policies=[
                {"field": "ssn", "action": "TOKENIZE"},
                {"field": "email", "action": "MASK"},
                {"field": "id", "action": "PASSTHROUGH"},
            ],
            values={"ssn": "123", "email": "a@b.com", "id": "X1"},
            tenant_id=T,
        )
        assert results["ssn"].action == "TOKENIZE"
        assert results["email"].action == "MASK"
        assert results["id"].transformed_value == "X1"


class TestSDKFailureShield:
    async def test_invalid_format_raises_tnt_error(self, sdk_client: TNTClient) -> None:
        with pytest.raises(InvalidTokenFormatError):
            await sdk_client.detokenize("bad", tenant_id=T)

    async def test_cb_state(self, sdk_client: TNTClient) -> None:
        assert sdk_client.circuit_breaker_state == "CLOSED"
