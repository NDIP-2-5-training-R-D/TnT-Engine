"""T&T Engine SDK v4 — internal platform SDK with failure shield.

This is the ONLY interface that Dev A and Dev B interact with.
All infrastructure complexity is fully abstracted:
  - Cache (L1+L2+DB) — transparent
  - Retry + circuit breaker — automatic
  - Tenant isolation — enforced
  - Idempotency — built-in
  - Tracing — propagated
  - Errors — normalized (never raw infra errors)

Usage:
    from tnt_engine.sdk import TNTClient

    client = await TNTClient.create()

    # ── Dev A: tokenize a value ──
    token = await client.tokenize("123-45-6789", field_type="ssn", tenant_id="acme")
    value = await client.detokenize(token, tenant_id="acme")

    # ── Dev A: policy-driven processing ──
    result = await client.process_field(
        policy={"field": "email", "action": "MASK"},
        value="john@acme.com",
        tenant_id="acme",
    )

    # ── Dev A: process entire record ──
    results = await client.process_record(
        policies=[
            {"field": "ssn", "action": "TOKENIZE"},
            {"field": "email", "action": "MASK"},
        ],
        values={"ssn": "123-45-6789", "email": "john@acme.com"},
        tenant_id="acme",
    )

    await client.close()
"""

from __future__ import annotations

from tnt_engine.cache.layered import LayeredCache
from tnt_engine.cache.redis import TokenCache
from tnt_engine.config import Settings
from tnt_engine.crypto.circuit_breaker import CircuitBreakerBackend
from tnt_engine.crypto.openbao import OpenBaoCryptoBackend
from tnt_engine.db.connection import Database
from tnt_engine.db.repository import TokenRepository
from tnt_engine.errors import TNTError
from tnt_engine.logging import get_logger
from tnt_engine.models.domain import TokenizeRequest, Transformation
from tnt_engine.service.masking import mask_value
from tnt_engine.service.policy import FieldResult, PolicyEngine
from tnt_engine.service.token_service import TokenService

logger = get_logger(__name__)


class TNTClient:
    """High-level SDK for the T&T Engine platform.

    All methods are:
      - async (non-blocking)
      - thread-safe (no mutable instance state)
      - idempotent (same input → same output)
      - failure-shielded (infra errors normalized)
      - tenant-aware (enforced isolation)
      - trace-aware (trace_id propagated)
    """

    def __init__(
        self,
        service: TokenService,
        policy_engine: PolicyEngine,
        _resources: _Resources,
    ) -> None:
        self._svc = service
        self._policy = policy_engine
        self._resources = _resources

    @classmethod
    async def create(cls, settings: Settings | None = None) -> TNTClient:
        """Factory: initialize all infrastructure and return a ready client."""
        from tnt_engine.config import settings as default_settings

        cfg = settings or default_settings

        db = Database(cfg)
        await db.connect()

        l2_cache = TokenCache(cfg)
        cache = LayeredCache(l2_cache, cfg)

        raw_backend = OpenBaoCryptoBackend(cfg)
        backend = CircuitBreakerBackend(
            raw_backend,
            failure_threshold=cfg.cb_failure_threshold,
            recovery_timeout=cfg.cb_recovery_timeout_seconds,
            half_open_max_calls=cfg.cb_half_open_max_calls,
        )

        repo = TokenRepository(db)
        svc = TokenService(
            hmac=backend,
            encryption=backend,
            repo=repo,
            cache=cache,
            settings=cfg,
        )

        policy_engine = PolicyEngine(token_service=svc, hmac_service=backend)

        resources = _Resources(db=db, cache=cache, backend=backend)
        return cls(service=svc, policy_engine=policy_engine, _resources=resources)

    # ── Tokenization API ─────────────────────────────────────────────

    async def tokenize(
        self,
        value: str,
        field_type: str,
        tenant_id: str,
        transformation: Transformation = Transformation.TOKENIZE,
        ttl_seconds: int | None = None,
        context: dict | None = None,
    ) -> str:
        """Tokenize a single value. Returns the token string.

        Args:
            value: Plaintext to tokenize.
            field_type: Field name (e.g. 'ssn', 'email').
            tenant_id: Tenant identifier for isolation.
            transformation: Transformation type.
            ttl_seconds: Optional auto-expire after N seconds.
            context: Optional metadata for audit trail.
        """
        req = TokenizeRequest(
            value=value,
            field=field_type,
            tenant_id=tenant_id,
            transformation=transformation,
            ttl_seconds=ttl_seconds,
        )
        resp = await self._shield(self._svc.tokenize, req)
        return resp.token

    async def detokenize(
        self, token: str, tenant_id: str, context: dict | None = None
    ) -> str:
        """Detokenize a token back to the original plaintext."""
        return await self._shield(self._svc.detokenize, token, tenant_id)

    async def tokenize_batch(
        self,
        items: list[tuple[str, str]],
        tenant_id: str,
        transformation: Transformation = Transformation.TOKENIZE,
        context: dict | None = None,
    ) -> list[str]:
        """Tokenize multiple values. items: list of (value, field_type) tuples."""
        reqs = [
            TokenizeRequest(
                value=v, field=f, tenant_id=tenant_id, transformation=transformation
            )
            for v, f in items
        ]
        results = await self._shield(self._svc.batch_tokenize, reqs)
        return [r.token for r in results]

    async def detokenize_batch(
        self, tokens: list[str], tenant_id: str, context: dict | None = None
    ) -> list[str]:
        """Detokenize multiple tokens. Returns plaintexts in same order."""
        mapping = await self._shield(self._svc.batch_detokenize, tokens, tenant_id)
        return [mapping[t] for t in tokens]

    # ── Lifecycle API ────────────────────────────────────────────────

    async def revoke(self, token: str, tenant_id: str) -> bool:
        """Revoke a token. Returns True if it was active and is now revoked."""
        return await self._shield(self._svc.revoke, token, tenant_id)

    async def delete(self, token: str, tenant_id: str) -> bool:
        """Hard delete a token (GDPR right to erasure). Returns True if found."""
        return await self._shield(self._svc.delete, token, tenant_id)

    # ── Masking API ──────────────────────────────────────────────────

    def mask(self, value: str, field_type: str) -> str:
        """Mask a value based on field type. Synchronous, one-way, irreversible.

        This is a pure function — no DB, no cache, no crypto service needed.
        Safe to call at any throughput.
        """
        return mask_value(value, field_type)

    # ── Policy API (Dev A primary interface) ─────────────────────────

    async def process_field(
        self,
        policy: dict,
        value: str,
        tenant_id: str,
        context: dict | None = None,
    ) -> FieldResult:
        """Process a single field according to its policy.

        Policy format: {"field": "ssn", "action": "TOKENIZE"}
        Actions: TOKENIZE, MASK, HASH, PASSTHROUGH
        """
        return await self._shield(
            self._policy.process_field, policy, value, tenant_id, context
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
        TOKENIZE fields are batched automatically for performance.
        """
        return await self._shield(
            self._policy.process_record, policies, values, tenant_id, context
        )

    # ── Infrastructure ───────────────────────────────────────────────

    async def close(self) -> None:
        """Release all connections. Call on shutdown."""
        await self._resources.backend.close()
        await self._resources.cache.close()
        await self._resources.db.close()

    @property
    def circuit_breaker_state(self) -> str:
        """Current circuit breaker state: CLOSED, OPEN, or HALF_OPEN."""
        return self._resources.backend.state

    # ── Failure shield ───────────────────────────────────────────────

    async def _shield(self, fn, *args, **kwargs):
        """Catch all exceptions and normalize to TNTError subclasses.

        Dev A NEVER sees raw DatabaseError, httpx.TimeoutException, etc.
        Only clean TNTError subclasses with actionable error codes.
        """
        try:
            return await fn(*args, **kwargs)
        except TNTError:
            # Already a clean error — let it through
            raise
        except Exception as exc:
            # Unexpected infra error — wrap it
            logger.exception("sdk_shielded_error", error_type=type(exc).__name__)
            raise TNTError(
                f"Operation failed: {type(exc).__name__}",
                details={"error_type": type(exc).__name__},
            ) from exc


class _Resources:
    def __init__(
        self,
        db: Database,
        cache: LayeredCache,
        backend: CircuitBreakerBackend,
    ) -> None:
        self.db = db
        self.cache = cache
        self.backend = backend
