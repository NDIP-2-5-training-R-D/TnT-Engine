"""Repository layer — tenant-scoped, lifecycle-aware, instrumented.

Every query is scoped by tenant_id. Read-only queries route to the
read replica pool when available. All operations emit latency histograms.
"""

from __future__ import annotations

import json
import time
from datetime import datetime
from functools import wraps
from typing import Any, Callable, Coroutine

from tnt_engine.db.connection import Database
from tnt_engine.errors import DatabaseError
from tnt_engine.logging import get_logger
from tnt_engine.metrics import DB_ERRORS, DB_LATENCY
from tnt_engine.models.domain import AuditEntry, TokenRecord

logger = get_logger(__name__)


def _track(operation: str):
    """Decorator that emits DB latency histogram and error counter."""
    def decorator(fn: Callable[..., Coroutine[Any, Any, Any]]):
        @wraps(fn)
        async def wrapper(self: TokenRepository, *args: Any, **kwargs: Any):
            t0 = time.monotonic()
            try:
                result = await fn(self, *args, **kwargs)
                DB_LATENCY.labels(operation=operation).observe(time.monotonic() - t0)
                return result
            except DatabaseError:
                DB_ERRORS.labels(operation=operation).inc()
                DB_LATENCY.labels(operation=operation).observe(time.monotonic() - t0)
                raise
            except Exception as exc:
                DB_ERRORS.labels(operation=operation).inc()
                DB_LATENCY.labels(operation=operation).observe(time.monotonic() - t0)
                raise DatabaseError(operation, str(exc)) from exc
        return wrapper
    return decorator


class TokenRepository:
    def __init__(self, db: Database) -> None:
        self._db = db

    # ------------------------------------------------------------------
    # Token lookup (convergent, tenant-scoped) — uses read replica
    # ------------------------------------------------------------------

    @_track("find_token_by_hash")
    async def find_token_by_hash(self, hmac_hash: str, tenant_id: str) -> str | None:
        row = await self._db.read_pool.fetchrow(
            "SELECT token FROM token_lookup WHERE hash = $1 AND tenant_id = $2",
            hmac_hash, tenant_id,
        )
        return row["token"] if row else None

    @_track("find_tokens_by_hashes")
    async def find_tokens_by_hashes(
        self, hmac_hashes: list[str], tenant_id: str
    ) -> dict[str, str]:
        if not hmac_hashes:
            return {}
        rows = await self._db.read_pool.fetch(
            "SELECT hash, token FROM token_lookup "
            "WHERE hash = ANY($1::text[]) AND tenant_id = $2",
            hmac_hashes, tenant_id,
        )
        return {row["hash"]: row["token"] for row in rows}

    # ------------------------------------------------------------------
    # Token store (tenant-scoped) — reads use replica
    # ------------------------------------------------------------------

    @_track("get_token_record")
    async def get_token_record(self, token: str, tenant_id: str) -> TokenRecord | None:
        row = await self._db.read_pool.fetchrow(
            """
            SELECT token, value_encrypted, transformation, key_version,
                   tenant_id, status::text, expires_at, created_at, updated_at
            FROM token_store WHERE token = $1 AND tenant_id = $2
            """,
            token, tenant_id,
        )
        if not row:
            return None
        return TokenRecord(**dict(row))

    @_track("get_token_records")
    async def get_token_records(
        self, tokens: list[str], tenant_id: str
    ) -> dict[str, TokenRecord]:
        if not tokens:
            return {}
        rows = await self._db.read_pool.fetch(
            """
            SELECT token, value_encrypted, transformation, key_version,
                   tenant_id, status::text, expires_at, created_at, updated_at
            FROM token_store WHERE token = ANY($1::text[]) AND tenant_id = $2
            """,
            tokens, tenant_id,
        )
        return {row["token"]: TokenRecord(**dict(row)) for row in rows}

    # ------------------------------------------------------------------
    # Concurrency-safe upsert — PRIMARY only
    # ------------------------------------------------------------------

    @_track("upsert_token")
    async def upsert_token(
        self,
        token: str,
        value_encrypted: str,
        transformation: str,
        key_version: int,
        hmac_hash: str,
        tenant_id: str,
        expires_at: datetime | None = None,
    ) -> str:
        row = await self._db.pool.fetchrow(
            "SELECT upsert_token($1, $2, $3, $4, $5, $6, $7) AS token",
            token, value_encrypted, transformation, key_version,
            hmac_hash, tenant_id, expires_at,
        )
        return row["token"]

    @_track("batch_upsert_tokens")
    async def batch_upsert_tokens(
        self,
        records: list[tuple[str, str, str, int, str, str, datetime | None]],
    ) -> dict[str, str]:
        if not records:
            return {}
        async with self._db.pool.acquire() as conn:
            async with conn.transaction():
                results: dict[str, str] = {}
                for token, enc, trans, kv, h, tid, exp in records:
                    row = await conn.fetchrow(
                        "SELECT upsert_token($1, $2, $3, $4, $5, $6, $7) AS token",
                        token, enc, trans, kv, h, tid, exp,
                    )
                    results[h] = row["token"]
                return results

    # ------------------------------------------------------------------
    # Lifecycle — PRIMARY only
    # ------------------------------------------------------------------

    @_track("revoke_token")
    async def revoke_token(self, token: str, tenant_id: str) -> bool:
        result = await self._db.pool.execute(
            """
            UPDATE token_store SET status = 'REVOKED'
            WHERE token = $1 AND tenant_id = $2 AND status = 'ACTIVE'
            """,
            token, tenant_id,
        )
        return result == "UPDATE 1"

    @_track("delete_token")
    async def delete_token(self, token: str, tenant_id: str) -> bool:
        result = await self._db.pool.execute(
            "DELETE FROM token_store WHERE token = $1 AND tenant_id = $2",
            token, tenant_id,
        )
        return result == "DELETE 1"

    @_track("expire_stale_tokens")
    async def expire_stale_tokens(self, batch_size: int = 1000) -> int:
        row = await self._db.pool.fetchrow(
            "SELECT expire_stale_tokens($1) AS cnt", batch_size,
        )
        return row["cnt"]

    @_track("get_tokens_for_reencrypt")
    async def get_tokens_for_reencrypt(
        self, max_key_version: int, batch_size: int = 500
    ) -> list[TokenRecord]:
        rows = await self._db.pool.fetch(
            """
            SELECT token, value_encrypted, transformation, key_version,
                   tenant_id, status::text, expires_at, created_at, updated_at
            FROM token_store
            WHERE key_version < $1 AND status = 'ACTIVE'
            ORDER BY created_at LIMIT $2
            FOR UPDATE SKIP LOCKED
            """,
            max_key_version, batch_size,
        )
        return [TokenRecord(**dict(r)) for r in rows]

    @_track("update_encrypted_value")
    async def update_encrypted_value(
        self, token: str, value_encrypted: str, key_version: int
    ) -> None:
        await self._db.pool.execute(
            """
            UPDATE token_store
            SET value_encrypted = $2, key_version = $3
            WHERE token = $1
            """,
            token, value_encrypted, key_version,
        )

    # ------------------------------------------------------------------
    # Idempotency / dedup
    # ------------------------------------------------------------------

    async def get_dedup(self, request_hash: str, tenant_id: str) -> dict | None:
        try:
            row = await self._db.read_pool.fetchrow(
                "SELECT response_cache FROM request_dedup "
                "WHERE request_hash = $1 AND tenant_id = $2",
                request_hash, tenant_id,
            )
            if row:
                return json.loads(row["response_cache"])
            return None
        except Exception:
            logger.warning("dedup_get_failed")
            return None

    async def set_dedup(
        self, request_hash: str, tenant_id: str, response: dict
    ) -> None:
        try:
            await self._db.pool.execute(
                """
                INSERT INTO request_dedup (request_hash, tenant_id, response_cache)
                VALUES ($1, $2, $3::jsonb)
                ON CONFLICT (request_hash, tenant_id) DO NOTHING
                """,
                request_hash, tenant_id, json.dumps(response),
            )
        except Exception:
            logger.warning("dedup_set_failed")

    @_track("cleanup_dedup")
    async def cleanup_dedup(self, max_age_seconds: int = 3600) -> int:
        from datetime import timedelta
        row = await self._db.pool.fetchrow(
            "SELECT cleanup_dedup($1::interval) AS cnt",
            timedelta(seconds=max_age_seconds),
        )
        return row["cnt"]

    @_track("list_tokens")
    async def list_tokens(
        self,
        tenant_id: str | None = None,
        status: str | None = None,
        transformation: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict]:
        """List token records — SAFE metadata only (no value_encrypted or plaintext)."""
        conditions: list[str] = []
        params: list = []
        idx = 1

        if tenant_id:
            conditions.append(f"tenant_id = ${idx}"); params.append(tenant_id); idx += 1
        if status:
            conditions.append(f"status = ${idx}"); params.append(status.upper()); idx += 1
        if transformation:
            conditions.append(f"transformation = ${idx}"); params.append(transformation.upper()); idx += 1

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        rows = await self._db.read_pool.fetch(
            f"""
            SELECT token, transformation, key_version, tenant_id,
                   status::text, expires_at, created_at, updated_at
            FROM token_store
            {where}
            ORDER BY created_at DESC
            LIMIT ${idx} OFFSET ${idx + 1}
            """,
            *params, limit, offset,
        )
        result = []
        for row in rows:
            record = dict(row)
            for k, v in record.items():
                if hasattr(v, "isoformat"):
                    record[k] = v.isoformat()
            result.append(record)
        return result

    @_track("count_tokens_by_status")
    async def count_tokens_by_status(self, tenant_id: str | None = None) -> dict[str, int]:
        """Count tokens grouped by status for dashboard stats."""
        where = "WHERE tenant_id = $1" if tenant_id else ""
        params = [tenant_id] if tenant_id else []
        rows = await self._db.read_pool.fetch(
            f"SELECT status::text, COUNT(*)::int AS cnt FROM token_store {where} GROUP BY status",
            *params,
        )
        return {row["status"]: row["cnt"] for row in rows}

    # ------------------------------------------------------------------
    # Cache rebuild support
    # ------------------------------------------------------------------

    @_track("get_active_lookups_batch")
    async def get_active_lookups_batch(
        self, offset: int, limit: int
    ) -> list[tuple[str, str, str]]:
        """Fetch (hash, tenant_id, token) for cache warm-up."""
        rows = await self._db.read_pool.fetch(
            """
            SELECT tl.hash, tl.tenant_id, tl.token
            FROM token_lookup tl
            JOIN token_store ts ON ts.token = tl.token
            WHERE ts.status = 'ACTIVE'
            ORDER BY ts.created_at
            OFFSET $1 LIMIT $2
            """,
            offset, limit,
        )
        return [(r["hash"], r["tenant_id"], r["token"]) for r in rows]

    # ------------------------------------------------------------------
    # Audit log
    # ------------------------------------------------------------------

    async def write_audit(self, entry: AuditEntry) -> None:
        try:
            await self._db.pool.execute(
                """
                INSERT INTO audit_log (action, field, tenant_id, trace_id, status, metadata)
                VALUES ($1, $2, $3, $4, $5, $6::jsonb)
                """,
                entry.action.value, entry.field, entry.tenant_id,
                entry.trace_id, entry.status, json.dumps(entry.metadata),
            )
        except Exception:
            logger.warning("audit_write_failed", action=entry.action.value)

    async def write_audit_batch(self, entries: list[AuditEntry]) -> None:
        if not entries:
            return
        try:
            await self._db.pool.executemany(
                """
                INSERT INTO audit_log (action, field, tenant_id, trace_id, status, metadata)
                VALUES ($1, $2, $3, $4, $5, $6::jsonb)
                """,
                [
                    (e.action.value, e.field, e.tenant_id, e.trace_id,
                     e.status, json.dumps(e.metadata))
                    for e in entries
                ],
            )
        except Exception:
            logger.warning("audit_batch_write_failed")

    async def query_audit(
        self,
        tenant_id: str,
        action: str | None = None,
        field: str | None = None,
        since: datetime | None = None,
        limit: int = 100,
    ) -> list[dict]:
        conditions = ["tenant_id = $1"]
        params: list = [tenant_id]
        idx = 2
        if action:
            conditions.append(f"action = ${idx}")
            params.append(action)
            idx += 1
        if field:
            conditions.append(f"field = ${idx}")
            params.append(field)
            idx += 1
        if since:
            conditions.append(f"performed_at >= ${idx}")
            params.append(since)
            idx += 1
        where = f"WHERE {' AND '.join(conditions)}"
        rows = await self._db.read_pool.fetch(
            f"SELECT * FROM audit_log {where} ORDER BY performed_at DESC LIMIT ${idx}",
            *params, limit,
        )
        return [dict(r) for r in rows]
