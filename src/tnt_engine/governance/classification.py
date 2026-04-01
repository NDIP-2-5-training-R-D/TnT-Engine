"""Data classification and governance enforcement.

Every field processed by the platform is assigned a sensitivity level.
The classification determines which operations are permitted:

  HIGH_SENSITIVE  — card numbers, SSN, tax ID
    Allowed: TOKENIZE only (reversible encryption required)
    Denied:  MASK, HASH, PASSTHROUGH

  MEDIUM          — email, phone, date of birth
    Allowed: TOKENIZE, MASK, HASH
    Denied:  PASSTHROUGH

  LOW             — name, address, city
    Allowed: TOKENIZE, MASK, HASH, PASSTHROUGH

  UNCLASSIFIED    — unknown fields (default)
    Allowed: TOKENIZE, MASK, HASH
    Denied:  PASSTHROUGH (force protection by default)

Classification is enforced at the PolicyEngine level — Dev A cannot
bypass it. The registry is extensible: teams can register new field
types without code changes.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field

from tnt_engine.logging import get_logger

logger = get_logger(__name__)


class SensitivityLevel(str, enum.Enum):
    HIGH_SENSITIVE = "HIGH_SENSITIVE"
    MEDIUM = "MEDIUM"
    LOW = "LOW"
    UNCLASSIFIED = "UNCLASSIFIED"


# Actions permitted per sensitivity level
_ALLOWED_ACTIONS: dict[SensitivityLevel, frozenset[str]] = {
    SensitivityLevel.HIGH_SENSITIVE: frozenset({"TOKENIZE"}),
    SensitivityLevel.MEDIUM: frozenset({"TOKENIZE", "MASK", "HASH"}),
    SensitivityLevel.LOW: frozenset({"TOKENIZE", "MASK", "HASH", "PASSTHROUGH"}),
    SensitivityLevel.UNCLASSIFIED: frozenset({"TOKENIZE", "MASK", "HASH"}),
}


@dataclass
class FieldClassification:
    """Classification metadata for a field type."""
    field_type: str
    level: SensitivityLevel
    description: str = ""
    retention_days: int | None = None  # None = indefinite


class ClassificationRegistry:
    """Registry of field-type → sensitivity classifications.

    Pre-loaded with standard PII field types. Teams can extend
    via `register()` without modifying platform code.
    """

    def __init__(self) -> None:
        self._registry: dict[str, FieldClassification] = {}
        self._load_defaults()

    def register(self, classification: FieldClassification) -> None:
        """Register or update a field classification."""
        self._registry[classification.field_type] = classification
        logger.info(
            "field_classification_registered",
            field_type=classification.field_type,
            level=classification.level.value,
        )

    def classify(self, field_type: str) -> FieldClassification:
        """Look up classification for a field type. Returns UNCLASSIFIED if unknown."""
        return self._registry.get(
            field_type,
            FieldClassification(field_type=field_type, level=SensitivityLevel.UNCLASSIFIED),
        )

    def is_action_allowed(self, field_type: str, action: str) -> bool:
        """Check if an action is permitted for the given field type."""
        classification = self.classify(field_type)
        return action.upper() in _ALLOWED_ACTIONS[classification.level]

    def get_allowed_actions(self, field_type: str) -> frozenset[str]:
        classification = self.classify(field_type)
        return _ALLOWED_ACTIONS[classification.level]

    @property
    def all_classifications(self) -> dict[str, FieldClassification]:
        return dict(self._registry)

    def _load_defaults(self) -> None:
        """Load standard PII field classifications."""
        defaults = [
            # HIGH_SENSITIVE — must be tokenized, never passed through or masked only
            FieldClassification("ssn", SensitivityLevel.HIGH_SENSITIVE, "Social Security Number"),
            FieldClassification("tax_id", SensitivityLevel.HIGH_SENSITIVE, "Tax Identification Number"),
            FieldClassification("card", SensitivityLevel.HIGH_SENSITIVE, "Payment Card Number"),
            FieldClassification("credit_card", SensitivityLevel.HIGH_SENSITIVE, "Credit Card Number"),
            FieldClassification("bank_account", SensitivityLevel.HIGH_SENSITIVE, "Bank Account Number"),
            FieldClassification("passport", SensitivityLevel.HIGH_SENSITIVE, "Passport Number"),

            # MEDIUM — tokenize or mask, but not passthrough
            FieldClassification("email", SensitivityLevel.MEDIUM, "Email Address"),
            FieldClassification("phone", SensitivityLevel.MEDIUM, "Phone Number"),
            FieldClassification("date_of_birth", SensitivityLevel.MEDIUM, "Date of Birth"),
            FieldClassification("drivers_license", SensitivityLevel.MEDIUM, "Driver's License"),

            # LOW — any action permitted
            FieldClassification("name", SensitivityLevel.LOW, "Person Name"),
            FieldClassification("first_name", SensitivityLevel.LOW, "First Name"),
            FieldClassification("last_name", SensitivityLevel.LOW, "Last Name"),
            FieldClassification("address", SensitivityLevel.LOW, "Street Address"),
            FieldClassification("city", SensitivityLevel.LOW, "City"),
            FieldClassification("zip_code", SensitivityLevel.LOW, "ZIP/Postal Code"),
        ]
        for fc in defaults:
            self._registry[fc.field_type] = fc


class GovernanceError(Exception):
    """Raised when a governance policy is violated."""

    def __init__(self, field_type: str, action: str, level: SensitivityLevel) -> None:
        self.field_type = field_type
        self.action = action
        self.level = level
        allowed = _ALLOWED_ACTIONS[level]
        super().__init__(
            f"Action '{action}' not permitted for field '{field_type}' "
            f"(classification: {level.value}). Allowed: {sorted(allowed)}"
        )
