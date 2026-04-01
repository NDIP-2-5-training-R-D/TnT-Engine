"""Unit tests for the policy-driven processing engine + governance."""

from __future__ import annotations

import pytest

from tnt_engine.governance.classification import (
    ClassificationRegistry,
    GovernanceError,
)
from tnt_engine.service.policy import FieldPolicy, PolicyEngine
from tnt_engine.service.token_service import TokenService
from tests.conftest import TENANT, FakeCryptoBackend

T = TENANT


@pytest.fixture
def policy_engine(
    token_service: TokenService,
    fake_crypto: FakeCryptoBackend,
) -> PolicyEngine:
    """Engine WITHOUT governance — backward compatible."""
    return PolicyEngine(token_service=token_service, hmac_service=fake_crypto)


@pytest.fixture
def governed_engine(
    token_service: TokenService,
    fake_crypto: FakeCryptoBackend,
) -> PolicyEngine:
    """Engine WITH governance enforcement."""
    return PolicyEngine(
        token_service=token_service,
        hmac_service=fake_crypto,
        governance=ClassificationRegistry(),
    )


class TestFieldPolicy:
    def test_parse_valid(self) -> None:
        fp = FieldPolicy.from_dict({"field": "ssn", "action": "TOKENIZE"})
        assert fp.field == "ssn"
        assert fp.action == "TOKENIZE"

    def test_parse_case_insensitive(self) -> None:
        fp = FieldPolicy.from_dict({"field": "email", "action": "mask"})
        assert fp.action == "MASK"

    def test_parse_missing_field_raises(self) -> None:
        with pytest.raises(ValueError, match="field"):
            FieldPolicy.from_dict({"action": "TOKENIZE"})

    def test_parse_invalid_action_raises(self) -> None:
        with pytest.raises(ValueError, match="Unknown action"):
            FieldPolicy.from_dict({"field": "x", "action": "ENCRYPT"})


class TestProcessField:
    async def test_tokenize(self, policy_engine: PolicyEngine) -> None:
        result = await policy_engine.process_field(
            {"field": "ssn", "action": "TOKENIZE"},
            value="123-45-6789",
            tenant_id=T,
        )
        assert result.field == "ssn"
        assert result.action == "TOKENIZE"
        assert result.transformed_value.startswith("tok_")
        assert result.original_value == "123-45-6789"

    async def test_mask(self, policy_engine: PolicyEngine) -> None:
        result = await policy_engine.process_field(
            {"field": "email", "action": "MASK"},
            value="john@example.com",
            tenant_id=T,
        )
        assert result.action == "MASK"
        assert result.transformed_value == "j***@example.com"

    async def test_hash(self, policy_engine: PolicyEngine) -> None:
        result = await policy_engine.process_field(
            {"field": "id", "action": "HASH"},
            value="some-value",
            tenant_id=T,
        )
        assert result.action == "HASH"
        assert len(result.transformed_value) == 64

    async def test_passthrough(self, policy_engine: PolicyEngine) -> None:
        result = await policy_engine.process_field(
            {"field": "account_id", "action": "PASSTHROUGH"},
            value="A001",
            tenant_id=T,
        )
        assert result.action == "PASSTHROUGH"
        assert result.transformed_value == "A001"


class TestProcessRecord:
    async def test_mixed_policies(self, policy_engine: PolicyEngine) -> None:
        results = await policy_engine.process_record(
            policies=[
                {"field": "ssn", "action": "TOKENIZE"},
                {"field": "email", "action": "MASK"},
                {"field": "name", "action": "MASK"},
                {"field": "account_id", "action": "PASSTHROUGH"},
            ],
            values={
                "ssn": "123-45-6789",
                "email": "john@acme.com",
                "name": "John Doe",
                "account_id": "A001",
            },
            tenant_id=T,
        )
        assert len(results) == 4
        assert results["ssn"].transformed_value.startswith("tok_")
        assert results["email"].transformed_value == "j***@acme.com"
        assert results["name"].transformed_value == "J*** D***"
        assert results["account_id"].transformed_value == "A001"

    async def test_missing_field_skipped(self, policy_engine: PolicyEngine) -> None:
        results = await policy_engine.process_record(
            policies=[
                {"field": "ssn", "action": "TOKENIZE"},
                {"field": "missing_field", "action": "MASK"},
            ],
            values={"ssn": "123-45-6789"},
            tenant_id=T,
        )
        assert "ssn" in results
        assert "missing_field" not in results

    async def test_batch_tokenize_efficiency(
        self,
        policy_engine: PolicyEngine,
        fake_crypto: FakeCryptoBackend,
    ) -> None:
        fake_crypto.encrypt_call_count = 0
        results = await policy_engine.process_record(
            policies=[
                {"field": "ssn", "action": "TOKENIZE"},
                {"field": "email", "action": "TOKENIZE"},
                {"field": "phone", "action": "TOKENIZE"},
            ],
            values={
                "ssn": "123-45-6789",
                "email": "john@acme.com",
                "phone": "555-0100",
            },
            tenant_id=T,
        )
        assert len(results) == 3
        assert fake_crypto.encrypt_call_count == 3


class TestGovernanceEnforcement:
    """Tests with governance registry enabled."""

    async def test_high_sensitive_tokenize_allowed(
        self, governed_engine: PolicyEngine
    ) -> None:
        result = await governed_engine.process_field(
            {"field": "ssn", "action": "TOKENIZE"},
            value="123-45-6789",
            tenant_id=T,
        )
        assert result.transformed_value.startswith("tok_")

    async def test_high_sensitive_mask_rejected(
        self, governed_engine: PolicyEngine
    ) -> None:
        with pytest.raises(GovernanceError):
            await governed_engine.process_field(
                {"field": "ssn", "action": "MASK"},
                value="123-45-6789",
                tenant_id=T,
            )

    async def test_high_sensitive_passthrough_rejected(
        self, governed_engine: PolicyEngine
    ) -> None:
        with pytest.raises(GovernanceError):
            await governed_engine.process_field(
                {"field": "card", "action": "PASSTHROUGH"},
                value="4111111111111111",
                tenant_id=T,
            )

    async def test_medium_mask_allowed(
        self, governed_engine: PolicyEngine
    ) -> None:
        result = await governed_engine.process_field(
            {"field": "email", "action": "MASK"},
            value="john@acme.com",
            tenant_id=T,
        )
        assert result.transformed_value == "j***@acme.com"

    async def test_medium_passthrough_rejected(
        self, governed_engine: PolicyEngine
    ) -> None:
        with pytest.raises(GovernanceError):
            await governed_engine.process_field(
                {"field": "email", "action": "PASSTHROUGH"},
                value="john@acme.com",
                tenant_id=T,
            )

    async def test_low_passthrough_allowed(
        self, governed_engine: PolicyEngine
    ) -> None:
        result = await governed_engine.process_field(
            {"field": "name", "action": "PASSTHROUGH"},
            value="John Doe",
            tenant_id=T,
        )
        assert result.transformed_value == "John Doe"

    async def test_record_with_governance_violation_fails_early(
        self, governed_engine: PolicyEngine
    ) -> None:
        """Governance violation on any field should fail before processing ANY field."""
        with pytest.raises(GovernanceError):
            await governed_engine.process_record(
                policies=[
                    {"field": "ssn", "action": "PASSTHROUGH"},  # VIOLATION
                    {"field": "name", "action": "MASK"},
                ],
                values={"ssn": "123", "name": "John"},
                tenant_id=T,
            )

    async def test_no_governance_skips_enforcement(
        self, policy_engine: PolicyEngine
    ) -> None:
        """Without governance registry, all actions are allowed."""
        result = await policy_engine.process_field(
            {"field": "ssn", "action": "PASSTHROUGH"},
            value="123",
            tenant_id=T,
        )
        assert result.transformed_value == "123"
