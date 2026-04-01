"""Data integrity reconciliation worker.

Validates that stored tokens can be correctly decrypted, catching:
  - Silent ciphertext corruption (bit rot, storage errors)
  - Key rotation gaps (tokens encrypted with deleted key versions)
  - HMAC consistency (hash in token_lookup matches re-computed hash of decrypted value)

Runs as a background scan:
  1. Fetch a batch of ACTIVE tokens
  2. Decrypt each ciphertext
  3. Re-compute HMAC of decrypted value
  4. Verify the HMAC matches the stored hash in token_lookup
  5. Report discrepancies without modifying data

This is a READ-ONLY audit — it never writes or modifies tokens.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from prometheus_client import Counter

from tnt_engine.crypto.interface import EncryptionService, HMACService
from tnt_engine.db.connection import Database
from tnt_engine.logging import get_logger
from tnt_engine.models.domain import TokenRecord

logger = get_logger(__name__)

RECONCILE_CHECKED = Counter("tnt_reconcile_checked_total", "Tokens checked by reconciliation")
RECONCILE_ERRORS = Counter("tnt_reconcile_errors_total", "Reconciliation errors found", ["type"])


@dataclass
class ReconciliationReport:
    """Results of a reconciliation run."""
    checked: int = 0
    healthy: int = 0
    decrypt_failures: int = 0
    hmac_mismatches: int = 0
    lookup_missing: int = 0
    errors: list[dict] = field(default_factory=list)
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    completed_at: datetime | None = None

    @property
    def is_clean(self) -> bool:
        return self.decrypt_failures == 0 and self.hmac_mismatches == 0 and self.lookup_missing == 0


class ReconciliationWorker:
    """Read-only data integrity validator."""

    def __init__(
        self,
        db: Database,
        hmac_service: HMACService,
        encryption_service: EncryptionService,
        batch_size: int = 500,
    ) -> None:
        self._db = db
        self._hmac = hmac_service
        self._encryption = encryption_service
        self._batch_size = batch_size

    async def run(self, limit: int | None = None) -> ReconciliationReport:
        """Run a full reconciliation scan. Returns a report."""
        report = ReconciliationReport()
        offset = 0
        max_check = limit or 1_000_000

        while report.checked < max_check:
            batch = await self._fetch_batch(offset, min(self._batch_size, max_check - report.checked))
            if not batch:
                break

            for record, stored_hash in batch:
                await self._check_record(record, stored_hash, report)
                RECONCILE_CHECKED.inc()

            offset += len(batch)

        report.completed_at = datetime.now(timezone.utc)
        logger.info(
            "reconciliation_complete",
            checked=report.checked,
            healthy=report.healthy,
            decrypt_failures=report.decrypt_failures,
            hmac_mismatches=report.hmac_mismatches,
            lookup_missing=report.lookup_missing,
        )
        return report

    async def _fetch_batch(
        self, offset: int, limit: int
    ) -> list[tuple[TokenRecord, str | None]]:
        """Fetch tokens joined with their lookup hash."""
        rows = await self._db.read_pool.fetch(
            """
            SELECT ts.token, ts.value_encrypted, ts.transformation,
                   ts.key_version, ts.tenant_id, ts.status::text,
                   ts.expires_at, ts.created_at, ts.updated_at,
                   tl.hash AS lookup_hash
            FROM token_store ts
            LEFT JOIN token_lookup tl ON tl.token = ts.token AND tl.tenant_id = ts.tenant_id
            WHERE ts.status = 'ACTIVE'
            ORDER BY ts.created_at
            OFFSET $1 LIMIT $2
            """,
            offset, limit,
        )
        results = []
        for row in rows:
            d = dict(row)
            lookup_hash = d.pop("lookup_hash", None)
            record = TokenRecord(**d)
            results.append((record, lookup_hash))
        return results

    async def _check_record(
        self, record: TokenRecord, stored_hash: str | None, report: ReconciliationReport
    ) -> None:
        report.checked += 1

        # 1. Check lookup exists
        if stored_hash is None:
            report.lookup_missing += 1
            RECONCILE_ERRORS.labels(type="lookup_missing").inc()
            report.errors.append({
                "token_prefix": record.token[:12],
                "type": "lookup_missing",
                "tenant_id": record.tenant_id,
            })
            return

        # 2. Try decrypting
        try:
            plaintext = await self._encryption.decrypt(
                record.value_encrypted, record.key_version
            )
        except Exception:
            report.decrypt_failures += 1
            RECONCILE_ERRORS.labels(type="decrypt_failure").inc()
            report.errors.append({
                "token_prefix": record.token[:12],
                "type": "decrypt_failure",
                "key_version": record.key_version,
                "tenant_id": record.tenant_id,
            })
            return

        # 3. Verify HMAC consistency
        try:
            computed_hash = await self._hmac.hmac(plaintext)
            if computed_hash != stored_hash:
                report.hmac_mismatches += 1
                RECONCILE_ERRORS.labels(type="hmac_mismatch").inc()
                report.errors.append({
                    "token_prefix": record.token[:12],
                    "type": "hmac_mismatch",
                    "tenant_id": record.tenant_id,
                })
                return
        except Exception:
            report.decrypt_failures += 1
            RECONCILE_ERRORS.labels(type="hmac_compute_failure").inc()
            return

        report.healthy += 1
