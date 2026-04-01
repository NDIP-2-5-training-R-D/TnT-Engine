"""Unit tests for the masking engine."""

from __future__ import annotations

from tnt_engine.service.masking import mask_value


class TestMaskEmail:
    def test_normal(self) -> None:
        assert mask_value("john@example.com", "email") == "j***@example.com"

    def test_single_char_local(self) -> None:
        assert mask_value("j@example.com", "email") == "j***@example.com"

    def test_no_at_sign_falls_back(self) -> None:
        # degenerate case — no @ sign, falls through to default masking
        result = mask_value("x", "email")
        assert len(result) == 1  # single char value gets fully masked


class TestMaskSSN:
    def test_normal(self) -> None:
        assert mask_value("123-45-6789", "ssn") == "***-**-6789"

    def test_no_dashes(self) -> None:
        assert mask_value("123456789", "ssn") == "***-**-6789"

    def test_short(self) -> None:
        result = mask_value("12", "ssn")
        assert result == "**"


class TestMaskCard:
    def test_normal(self) -> None:
        assert mask_value("4111111111111111", "card") == "****-****-****-1111"

    def test_with_dashes(self) -> None:
        assert mask_value("4111-1111-1111-1111", "card") == "****-****-****-1111"

    def test_credit_card_alias(self) -> None:
        assert mask_value("4111111111111111", "credit_card") == "****-****-****-1111"


class TestMaskPhone:
    def test_normal(self) -> None:
        assert mask_value("555-123-4567", "phone") == "***-***-4567"

    def test_digits_only(self) -> None:
        assert mask_value("5551234567", "phone") == "***-***-4567"


class TestMaskName:
    def test_full_name(self) -> None:
        assert mask_value("John Doe", "name") == "J*** D***"

    def test_single_name(self) -> None:
        assert mask_value("Alice", "name") == "A***"

    def test_first_name_alias(self) -> None:
        assert mask_value("John", "first_name") == "J***"


class TestMaskDefault:
    def test_unknown_field(self) -> None:
        result = mask_value("hello world", "unknown_field")
        assert result == "he***ld"

    def test_short_value(self) -> None:
        assert mask_value("ab", "unknown") == "**"
