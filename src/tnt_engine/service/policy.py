"""Policy-driven field processing engine with governance enforcement.

This is the primary abstraction for Dev A. Instead of manually calling
tokenize/mask/encrypt, Dev A defines field policies and the engine
routes each field to the correct transformation — after verifying
that the operation is permitted by the data governance layer.

Usage:
    engine = PolicyEngine(token_service, hmac_service, governance=registry)

    result = await engine.process_field(
        policy={"field": "ssn", "action": "TOKENIZE"},
        value="123-45-6789",
        tenant_id="acme",
    )

    # This would raise GovernanceError:
    # SSN is HIGH_SENSITIVE, PASSTHROUGH is not allowed
    result = await engine.process_field(
        policy={"field": "ssn", "action": "PASSTHROUGH"},
        value="123-45-6789",
        tenant_id="acme",
    )

Actions:
    TOKENIZE   — convergent tokenization via TokenService (reversible)
    MASK       — one-way masking, irreversible, retains field structure
    HASH       — HMAC hash via crypto service (one-way, deterministic)
    PASSTHROUGH — no transformation, value returned as-is
"""

from __future__ import annotations

from dataclasses import dataclass

from tnt_engine.crypto.interface import HMACService
from tnt_engine.governance.classification import (
    ClassificationRegistry,
    GovernanceError,
)
from tnt_engine.logging import get_logger
from tnt_engine.models.domain import TokenizeRequest, Transformation
from tnt_engine.service.masking import mask_value
from tnt_engine.service.token_service import TokenService

logger = get_logger(__name__)


@dataclass(frozen=True)
class FieldPolicy:
    """Parsed and validated policy for a single field."""
    field: str
    action: str  # TOKENIZE, MASK, HASH, PASSTHROUGH

    @classmethod
    def from_dict(cls, d: dict) -> FieldPolicy:
        field = d.get("field", "")
        action = d.get("action", "").upper()
        if not field:
            raise ValueError("Policy must include 'field'")
        if action not in ("TOKENIZE", "MASK", "HASH", "PASSTHROUGH"):
            raise ValueError(f"Unknown action: {action}")
        return cls(field=field, action=action)


@dataclass
class FieldResult:
    """Result of processing a single field."""
    field: str
    action: str
    original_value: str  # NEVER logged or stored — only for caller's in-memory use
    transformed_value: str


class PolicyEngine:
    """Routes field values to the correct transformation based on policy.

    When a ClassificationRegistry is provided, governance rules are enforced
    BEFORE processing. HIGH_SENSITIVE fields cannot be passed through, etc.

    Dev A uses this instead of calling TokenService directly.
    All infrastructure details (cache, retry, crypto) are invisible.
    """

    def __init__(
        self,
        token_service: TokenService,
        hmac_service: HMACService,
        governance: ClassificationRegistry | None = None,
    ) -> None:
        self._token_svc = token_service
        self._hmac = hmac_service
        self._governance = governance

    async def process_field(
        self,
        policy: dict,
        value: str,
        tenant_id: str,
        context: dict | None = None,
    ) -> FieldResult:
        """Process a single field according to its policy."""
        fp = FieldPolicy.from_dict(policy)
        self._enforce_governance(fp)
        transformed = await self._apply(fp, value, tenant_id)
        return FieldResult(
            field=fp.field,
            action=fp.action,
            original_value=value,
            transformed_value=transformed,
        )

    async def process_record(
        self,
        policies: list[dict],
        values: dict[str, str],
        tenant_id: str,
        context: dict | None = None,
    ) -> dict[str, FieldResult]:
        """Process all fields in a record according to their policies.

        Returns {field_name: FieldResult}.
        Fields present in policies but missing from values are skipped.
        """
        parsed = [FieldPolicy.from_dict(p) for p in policies]

        # Enforce governance on all policies before processing any
        for fp in parsed:
            if fp.field in values:
                self._enforce_governance(fp)

        # Batch tokenization for efficiency
        tokenize_fields: list[tuple[FieldPolicy, str]] = []
        results: dict[str, FieldResult] = {}

        for fp in parsed:
            val = values.get(fp.field)
            if val is None:
                continue

            if fp.action == "TOKENIZE":
                tokenize_fields.append((fp, val))
            else:
                transformed = await self._apply(fp, val, tenant_id)
                results[fp.field] = FieldResult(
                    field=fp.field, action=fp.action,
                    original_value=val, transformed_value=transformed,
                )

        if tokenize_fields:
            reqs = [
                TokenizeRequest(value=v, field=fp.field, tenant_id=tenant_id)
                for fp, v in tokenize_fields
            ]
            tok_results = await self._token_svc.batch_tokenize(reqs)
            for (fp, val), tok_resp in zip(tokenize_fields, tok_results):
                results[fp.field] = FieldResult(
                    field=fp.field, action="TOKENIZE",
                    original_value=val, transformed_value=tok_resp.token,
                )

        return results

    def _enforce_governance(self, fp: FieldPolicy) -> None:
        """Check governance rules. Raises GovernanceError if violated."""
        if self._governance is None:
            return  # No governance registry — skip enforcement
        if not self._governance.is_action_allowed(fp.field, fp.action):
            classification = self._governance.classify(fp.field)
            raise GovernanceError(fp.field, fp.action, classification.level)

    async def _apply(
        self, fp: FieldPolicy, value: str, tenant_id: str
    ) -> str:
        if fp.action == "TOKENIZE":
            req = TokenizeRequest(value=value, field=fp.field, tenant_id=tenant_id)
            resp = await self._token_svc.tokenize(req)
            return resp.token

        if fp.action == "MASK":
            return mask_value(value, fp.field)

        if fp.action == "HASH":
            return await self._hmac.hmac(value)

        # PASSTHROUGH
        return value
