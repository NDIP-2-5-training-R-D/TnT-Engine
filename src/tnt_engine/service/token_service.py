"""Core tokenization engine v3 — multi-tenant, lifecycle-aware, idempotent.

Architecture:
  - Every operation is scoped by tenant_id (enforced at repository + cache layers)
  - Tokens have lifecycle states: ACTIVE → EXPIRED | REVOKED
  - Idempotency via request hash deduplication
  - 3-layer cache: L1 (memory) → L2 (Redis) → L3 (DB)
  - Concurrency-safe via DB upsert function
  - Batch operations deduplicate within a single call

Security invariants:
  - NEVER stores plaintext PII
  - NEVER logs plaintext PII
  - Encryption happens BEFORE any storage
  - Token format validated before any DB access
  - Tenant isolation enforced at every layer
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import secrets
import time
import unicodedata
from datetime import datetime, timedelta, timezone

from prometheus_client import Counter, Histogram

from typing import TYPE_CHECKING

from tnt_engine.cache.layered import LayeredCache
from tnt_engine.config import Settings
from tnt_engine.crypto.interface import EncryptionService, HMACService
from tnt_engine.db.repository import TokenRepository

if TYPE_CHECKING:
    from tnt_engine.service.audit_writer import ReliableAuditWriter
from tnt_engine.errors import (
    InvalidTokenFormatError,
    TokenExpiredError,
    TokenNotFoundError,
    TokenRevokedError,
)
from tnt_engine.logging import get_logger
from tnt_engine.models.domain import (
    AuditAction,
    AuditEntry,
    TokenizeRequest,
    TokenizeResponse,
    TokenRecord,
    TokenStatus,
)
from tnt_engine.tracing import ensure_trace_id, get_trace_id

logger = get_logger(__name__)

# ── Prometheus metrics ───────────────────────────────────────────────

TOKENIZE_LATENCY = Histogram(
    "tnt_tokenize_seconds", "Tokenize latency",
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0),
)
DETOKENIZE_LATENCY = Histogram(
    "tnt_detokenize_seconds", "Detokenize latency",
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0),
)
TOKEN_CREATED = Counter("tnt_tokens_created_total", "New tokens created")
ERRORS = Counter("tnt_errors_total", "Service errors", ["operation"])
CONFLICT_RESOLVED = Counter("tnt_conflict_resolved_total", "Upsert conflicts resolved")
DEDUP_HIT = Counter("tnt_dedup_hits_total", "Idempotent request cache hits")
LIFECYCLE_OPS = Counter("tnt_lifecycle_ops_total", "Token lifecycle operations", ["op"])

_TOKEN_RE = re.compile(r"^tok_[A-Za-z0-9_-]{20,}$")


class TokenService:
    """Multi-tenant convergent tokenization engine."""

    def __init__(
        self,
        hmac: HMACService,
        encryption: EncryptionService,
        repo: TokenRepository,
        cache: LayeredCache,
        settings: Settings,
        audit_writer: ReliableAuditWriter | None = None,
    ) -> None:
        self._hmac = hmac
        self._encryption = encryption
        self._repo = repo
        self._cache = cache
        self._prefix = settings.token_prefix
        self._token_bytes = settings.token_length
        self._dedup_ttl = settings.dedup_ttl_seconds
        self._audit_writer = audit_writer

    # ------------------------------------------------------------------
    # Tokenize (single)
    # ------------------------------------------------------------------

    async def tokenize(self, req: TokenizeRequest) -> TokenizeResponse:
        ensure_trace_id()
        t0 = time.monotonic()
        try:
            # Idempotency check
            req_hash = self._request_hash("tokenize", req.tenant_id, req.value, req.field)
            cached_resp = await self._repo.get_dedup(req_hash, req.tenant_id)
            if cached_resp:
                DEDUP_HIT.inc()
                cached_resp["cached"] = True
                return TokenizeResponse(**cached_resp)

            normalized = self._normalize(req.value)
            hmac_hash = await self._hmac.hmac(normalized)

            # L1 → L2 → L3 lookup
            cached_token = await self._cache.get(hmac_hash, req.tenant_id)
            if cached_token:
                TOKENIZE_LATENCY.observe(time.monotonic() - t0)
                resp = TokenizeResponse(token=cached_token, field=req.field, cached=True)
                self._fire_audit(AuditAction.TOKENIZE, req.field, req.tenant_id, source="cache")
                await self._repo.set_dedup(req_hash, req.tenant_id, resp.model_dump())
                return resp

            # DB lookup
            db_token = await self._repo.find_token_by_hash(hmac_hash, req.tenant_id)
            if db_token:
                await self._cache.set(hmac_hash, req.tenant_id, db_token)
                TOKENIZE_LATENCY.observe(time.monotonic() - t0)
                resp = TokenizeResponse(token=db_token, field=req.field, cached=False)
                self._fire_audit(AuditAction.TOKENIZE, req.field, req.tenant_id, source="db")
                await self._repo.set_dedup(req_hash, req.tenant_id, resp.model_dump())
                return resp

            # Create new (concurrency-safe)
            proposed = self._generate_token()
            ciphertext, key_version = await self._encryption.encrypt(normalized)
            expires_at = self._compute_expiry(req.ttl_seconds)

            winning = await self._repo.upsert_token(
                token=proposed,
                value_encrypted=ciphertext,
                transformation=req.transformation.value,
                key_version=key_version,
                hmac_hash=hmac_hash,
                tenant_id=req.tenant_id,
                expires_at=expires_at,
            )

            if winning != proposed:
                CONFLICT_RESOLVED.inc()

            await self._cache.set(hmac_hash, req.tenant_id, winning)
            TOKEN_CREATED.inc()
            TOKENIZE_LATENCY.observe(time.monotonic() - t0)
            resp = TokenizeResponse(token=winning, field=req.field, cached=False)
            self._fire_audit(AuditAction.TOKENIZE, req.field, req.tenant_id, source="new")
            await self._repo.set_dedup(req_hash, req.tenant_id, resp.model_dump())
            return resp

        except Exception:
            ERRORS.labels(operation="tokenize").inc()
            logger.exception("tokenize_failed", field=req.field, tenant_id=req.tenant_id)
            raise

    # ------------------------------------------------------------------
    # Batch tokenize
    # ------------------------------------------------------------------

    async def batch_tokenize(
        self, items: list[TokenizeRequest]
    ) -> list[TokenizeResponse]:
        ensure_trace_id()
        if not items:
            return []
        tenant_id = items[0].tenant_id
        t0 = time.monotonic()
        try:
            normalized = [self._normalize(it.value) for it in items]
            hmac_hashes = list(
                await asyncio.gather(*[self._hmac.hmac(n) for n in normalized])
            )

            # L1 → L2 batch lookup
            cache_results = await self._cache.get_multi(hmac_hashes, tenant_id)

            responses: dict[int, TokenizeResponse] = {}
            db_lookup_indices: list[int] = []

            for i, h in enumerate(hmac_hashes):
                cached = cache_results.get(h)
                if cached:
                    responses[i] = TokenizeResponse(
                        token=cached, field=items[i].field, cached=True
                    )
                else:
                    db_lookup_indices.append(i)

            # DB batch lookup for misses
            if db_lookup_indices:
                hashes_to_check = [hmac_hashes[i] for i in db_lookup_indices]
                db_results = await self._repo.find_tokens_by_hashes(hashes_to_check, tenant_id)

                new_indices: list[int] = []
                cache_backfill: dict[str, str] = {}

                for i in db_lookup_indices:
                    h = hmac_hashes[i]
                    if h in db_results:
                        responses[i] = TokenizeResponse(
                            token=db_results[h], field=items[i].field, cached=False
                        )
                        cache_backfill[h] = db_results[h]
                    else:
                        new_indices.append(i)

                if cache_backfill:
                    await self._cache.set_multi(cache_backfill, tenant_id)

                # Create new tokens (deduplicated within batch)
                if new_indices:
                    seen: dict[str, int] = {}
                    unique_indices: list[int] = []
                    for i in new_indices:
                        h = hmac_hashes[i]
                        if h not in seen:
                            seen[h] = i
                            unique_indices.append(i)

                    encrypt_results = await asyncio.gather(
                        *[self._encryption.encrypt(normalized[i]) for i in unique_indices]
                    )

                    upsert_records = []
                    for idx_pos, i in enumerate(unique_indices):
                        token = self._generate_token()
                        ct, kv = encrypt_results[idx_pos]
                        h = hmac_hashes[i]
                        exp = self._compute_expiry(items[i].ttl_seconds)
                        upsert_records.append((token, ct, items[i].transformation.value, kv, h, tenant_id, exp))

                    hash_to_winner = await self._repo.batch_upsert_tokens(upsert_records)

                    new_cache: dict[str, str] = {}
                    for i in new_indices:
                        h = hmac_hashes[i]
                        winner = hash_to_winner[h]
                        responses[i] = TokenizeResponse(
                            token=winner, field=items[i].field, cached=False
                        )
                        new_cache[h] = winner

                    await self._cache.set_multi(new_cache, tenant_id)
                    TOKEN_CREATED.inc(len(unique_indices))

            TOKENIZE_LATENCY.observe(time.monotonic() - t0)
            self._fire_audit(AuditAction.BATCH_TOKENIZE, None, tenant_id, count=len(items))
            return [responses[i] for i in range(len(items))]

        except Exception:
            ERRORS.labels(operation="batch_tokenize").inc()
            logger.exception("batch_tokenize_failed", tenant_id=tenant_id)
            raise

    # ------------------------------------------------------------------
    # Detokenize
    # ------------------------------------------------------------------

    async def detokenize(self, token: str, tenant_id: str) -> str:
        ensure_trace_id()
        self._validate_token_format(token)
        t0 = time.monotonic()
        try:
            record = await self._repo.get_token_record(token, tenant_id)
            if record is None:
                raise TokenNotFoundError(token)
            self._check_token_status(record)

            plaintext = await self._encryption.decrypt(
                record.value_encrypted, record.key_version
            )
            DETOKENIZE_LATENCY.observe(time.monotonic() - t0)
            self._fire_audit(AuditAction.DETOKENIZE, None, tenant_id)
            return plaintext

        except (TokenNotFoundError, InvalidTokenFormatError, TokenRevokedError, TokenExpiredError):
            raise
        except Exception:
            ERRORS.labels(operation="detokenize").inc()
            logger.exception("detokenize_failed", tenant_id=tenant_id)
            raise

    async def batch_detokenize(
        self, tokens: list[str], tenant_id: str
    ) -> dict[str, str]:
        ensure_trace_id()
        for t in tokens:
            self._validate_token_format(t)

        t0 = time.monotonic()
        try:
            records = await self._repo.get_token_records(tokens, tenant_id)
            missing = set(tokens) - set(records.keys())
            if missing:
                raise TokenNotFoundError(next(iter(missing)))

            for rec in records.values():
                self._check_token_status(rec)

            plaintexts = await asyncio.gather(
                *[
                    self._encryption.decrypt(records[t].value_encrypted, records[t].key_version)
                    for t in tokens
                ]
            )
            result = dict(zip(tokens, plaintexts))
            DETOKENIZE_LATENCY.observe(time.monotonic() - t0)
            self._fire_audit(AuditAction.BATCH_DETOKENIZE, None, tenant_id, count=len(tokens))
            return result

        except (TokenNotFoundError, InvalidTokenFormatError, TokenRevokedError, TokenExpiredError):
            raise
        except Exception:
            ERRORS.labels(operation="batch_detokenize").inc()
            logger.exception("batch_detokenize_failed", tenant_id=tenant_id)
            raise

    # ------------------------------------------------------------------
    # Lifecycle management
    # ------------------------------------------------------------------

    async def revoke(self, token: str, tenant_id: str) -> bool:
        """Revoke a token. Returns True if it was active and revoked."""
        ensure_trace_id()
        self._validate_token_format(token)
        ok = await self._repo.revoke_token(token, tenant_id)
        if ok:
            LIFECYCLE_OPS.labels(op="revoke").inc()
            self._fire_audit(AuditAction.REVOKE, None, tenant_id)
        return ok

    async def delete(self, token: str, tenant_id: str) -> bool:
        """Hard delete a token (GDPR). Cascades to lookup. Returns True if found."""
        ensure_trace_id()
        self._validate_token_format(token)
        ok = await self._repo.delete_token(token, tenant_id)
        if ok:
            LIFECYCLE_OPS.labels(op="delete").inc()
            self._fire_audit(AuditAction.DELETE, None, tenant_id)
        return ok

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    @staticmethod
    def _normalize(value: str) -> str:
        return unicodedata.normalize("NFC", value.strip())

    def _generate_token(self) -> str:
        return f"{self._prefix}{secrets.token_urlsafe(self._token_bytes)}"

    def _validate_token_format(self, token: str) -> None:
        if not _TOKEN_RE.match(token):
            raise InvalidTokenFormatError(token)

    @staticmethod
    def _check_token_status(record: TokenRecord) -> None:
        if record.status == TokenStatus.REVOKED.value:
            raise TokenRevokedError(record.token)
        if record.status == TokenStatus.EXPIRED.value:
            raise TokenExpiredError(record.token)

    @staticmethod
    def _compute_expiry(ttl_seconds: int | None) -> datetime | None:
        if ttl_seconds is None:
            return None
        return datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)

    @staticmethod
    def _request_hash(operation: str, tenant_id: str, *args: str) -> str:
        """Deterministic hash for idempotency keying."""
        payload = f"{operation}:{tenant_id}:" + ":".join(args)
        return hashlib.sha256(payload.encode()).hexdigest()

    def _fire_audit(
        self, action: AuditAction, field: str | None, tenant_id: str, **extra: object
    ) -> None:
        entry = AuditEntry(
            action=action,
            field=field,
            tenant_id=tenant_id,
            trace_id=get_trace_id(),
            metadata=extra,
        )
        if self._audit_writer is not None:
            self._audit_writer.enqueue(entry)
        else:
            # Legacy fire-and-forget fallback
            asyncio.create_task(self._write_audit_legacy(entry))

    async def _write_audit_legacy(self, entry: AuditEntry) -> None:
        """Legacy direct-write path. Used when no ReliableAuditWriter is configured."""
        try:
            await self._repo.write_audit(entry)
        except Exception:
            logger.warning("audit_write_failed", action=entry.action.value)
