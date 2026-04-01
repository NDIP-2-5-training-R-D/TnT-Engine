"""Tests for data governance — classification + enforcement."""

from __future__ import annotations

import pytest

from tnt_engine.governance.classification import (
    ClassificationRegistry,
    FieldClassification,
    GovernanceError,
    SensitivityLevel,
)


@pytest.fixture
def registry() -> ClassificationRegistry:
    return ClassificationRegistry()


class TestClassification:
    def test_ssn_is_high_sensitive(self, registry: ClassificationRegistry) -> None:
        c = registry.classify("ssn")
        assert c.level == SensitivityLevel.HIGH_SENSITIVE

    def test_email_is_medium(self, registry: ClassificationRegistry) -> None:
        c = registry.classify("email")
        assert c.level == SensitivityLevel.MEDIUM

    def test_name_is_low(self, registry: ClassificationRegistry) -> None:
        c = registry.classify("name")
        assert c.level == SensitivityLevel.LOW

    def test_unknown_is_unclassified(self, registry: ClassificationRegistry) -> None:
        c = registry.classify("random_field_xyz")
        assert c.level == SensitivityLevel.UNCLASSIFIED

    def test_custom_registration(self, registry: ClassificationRegistry) -> None:
        registry.register(
            FieldClassification("biometric_hash", SensitivityLevel.HIGH_SENSITIVE)
        )
        c = registry.classify("biometric_hash")
        assert c.level == SensitivityLevel.HIGH_SENSITIVE


class TestPolicyEnforcement:
    def test_high_sensitive_allows_tokenize(self, registry: ClassificationRegistry) -> None:
        assert registry.is_action_allowed("ssn", "TOKENIZE") is True

    def test_high_sensitive_denies_mask(self, registry: ClassificationRegistry) -> None:
        assert registry.is_action_allowed("ssn", "MASK") is False

    def test_high_sensitive_denies_passthrough(self, registry: ClassificationRegistry) -> None:
        assert registry.is_action_allowed("ssn", "PASSTHROUGH") is False

    def test_medium_allows_tokenize_and_mask(self, registry: ClassificationRegistry) -> None:
        assert registry.is_action_allowed("email", "TOKENIZE") is True
        assert registry.is_action_allowed("email", "MASK") is True

    def test_medium_denies_passthrough(self, registry: ClassificationRegistry) -> None:
        assert registry.is_action_allowed("email", "PASSTHROUGH") is False

    def test_low_allows_everything(self, registry: ClassificationRegistry) -> None:
        for action in ("TOKENIZE", "MASK", "HASH", "PASSTHROUGH"):
            assert registry.is_action_allowed("name", action) is True

    def test_unclassified_denies_passthrough(self, registry: ClassificationRegistry) -> None:
        assert registry.is_action_allowed("unknown_field", "PASSTHROUGH") is False
        assert registry.is_action_allowed("unknown_field", "TOKENIZE") is True

    def test_get_allowed_actions(self, registry: ClassificationRegistry) -> None:
        actions = registry.get_allowed_actions("ssn")
        assert actions == frozenset({"TOKENIZE"})


class TestGovernanceError:
    def test_error_message(self) -> None:
        err = GovernanceError("ssn", "PASSTHROUGH", SensitivityLevel.HIGH_SENSITIVE)
        assert "ssn" in str(err)
        assert "PASSTHROUGH" in str(err)
        assert "HIGH_SENSITIVE" in str(err)
        assert "TOKENIZE" in str(err)  # listed as allowed
