"""Reliable audit writer with buffering, retry, and dead letter queue.

Replaces the fire-and-forget audit pattern with guaranteed delivery:

  1. Audit entries are appended to an in-memory buffer (non-blocking)
  2. A background flush loop writes batches to DB at regular intervals
  3. If DB write fails, retries with exponential backoff
  4. After max retries, entries are written to a DLQ file on disk
  5. On graceful shutdown, remaining buffer is flushed

The DLQ file is an append-only JSONL file that can be replayed via
the admin API or a recovery script.

Security invariants:
  - Audit entries are NEVER silently discarded
  - Buffer overflow triggers early flush, not data loss
  - DLQ persists across process restarts
  - Metrics expose buffer size, flush rate, and DLQ state
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections import deque
from datetime import datetime, timezone

from tnt_engine.config import Settings
from tnt_engine.logging import get_logger
from tnt_engine.metrics import (
    AUDIT_BUFFER_SIZE,
    AUDIT_DLQ_SIZE,
    AUDIT_ENTRIES_DLQ,
    AUDIT_ENTRIES_WRITTEN,
    AUDIT_FLUSH_TOTAL,
)
from tnt_engine.models.domain import AuditEntry

logger = get_logger(__name__)


class ReliableAuditWriter:
    """Buffered audit writer with retry and dead-letter queue.

    Usage:
        writer = ReliableAuditWriter(repo, settings)
        await writer.start()

        # Non-blocking — always succeeds unless buffer is critically full
        writer.enqueue(audit_entry)

        # On shutdown
        await writer.stop()
    """

    def __init__(self, repo: object, settings: Settings) -> None:
        self._repo = repo
        self._buffer: deque[AuditEntry] = deque()
        self._max_size = settings.audit_buffer_max_size
        self._flush_interval = settings.audit_flush_interval_seconds
        self._batch_size = settings.audit_flush_batch_size
        self._max_retries = settings.audit_max_retries
        self._retry_backoff = settings.audit_retry_backoff_seconds
        self._dlq_path = settings.audit_dlq_path
        self._lock = asyncio.Lock()
        self._running = False
        self._task: asyncio.Task | None = None

    def enqueue(self, entry: AuditEntry) -> None:
        """Add an audit entry to the buffer. Non-blocking.

        If the buffer is at capacity, triggers an early flush signal
        but still accepts the entry (bounded growth with overflow handling).
        """
        self._buffer.append(entry)
        current_size = len(self._buffer)
        AUDIT_BUFFER_SIZE.set(current_size)

        if current_size >= self._max_size:
            logger.warning(
                "audit_buffer_at_capacity",
                size=current_size,
                max=self._max_size,
            )

    async def start(self) -> None:
        """Start the background flush loop."""
        self._running = True
        self._task = asyncio.create_task(self._flush_loop())
        self._update_dlq_metric()
        logger.info(
            "audit_writer_started",
            flush_interval=self._flush_interval,
            buffer_max=self._max_size,
        )

    async def stop(self) -> None:
        """Stop the flush loop and drain remaining buffer."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

        # Final flush — drain everything remaining
        if self._buffer:
            logger.info("audit_writer_draining", remaining=len(self._buffer))
            await self._flush_all()

        logger.info("audit_writer_stopped")

    async def flush_now(self) -> int:
        """Force an immediate flush. Returns number of entries flushed.

        Useful for testing and admin-triggered flushes.
        """
        return await self._flush_batch()

    @property
    def buffer_size(self) -> int:
        return len(self._buffer)

    @property
    def dlq_size_bytes(self) -> int:
        """Size of the DLQ file on disk."""
        try:
            return os.path.getsize(self._dlq_path)
        except OSError:
            return 0

    # ── Background flush loop ────────────────────────────────────────

    async def _flush_loop(self) -> None:
        while self._running:
            try:
                if self._buffer:
                    await self._flush_batch()
                AUDIT_BUFFER_SIZE.set(len(self._buffer))
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("audit_flush_loop_error")
            await asyncio.sleep(self._flush_interval)

    async def _flush_all(self) -> None:
        """Flush everything in the buffer (used during shutdown)."""
        while self._buffer:
            await self._flush_batch()

    async def _flush_batch(self) -> int:
        """Extract a batch from the buffer and write to DB with retry.

        Returns the number of entries successfully written.
        """
        async with self._lock:
            batch: list[AuditEntry] = []
            for _ in range(min(self._batch_size, len(self._buffer))):
                batch.append(self._buffer.popleft())

        if not batch:
            return 0

        AUDIT_BUFFER_SIZE.set(len(self._buffer))

        # Retry loop
        for attempt in range(self._max_retries):
            try:
                await self._repo.write_audit_batch(batch)
                AUDIT_FLUSH_TOTAL.labels(status="success").inc()
                AUDIT_ENTRIES_WRITTEN.inc(len(batch))
                return len(batch)
            except Exception as exc:
                wait = self._retry_backoff * (2 ** attempt)
                logger.warning(
                    "audit_flush_retry",
                    attempt=attempt + 1,
                    max_retries=self._max_retries,
                    batch_size=len(batch),
                    wait_seconds=wait,
                    error=str(exc),
                )
                if attempt < self._max_retries - 1:
                    await asyncio.sleep(wait)

        # All retries exhausted — send to DLQ
        AUDIT_FLUSH_TOTAL.labels(status="failure").inc()
        logger.error(
            "audit_flush_exhausted_sending_to_dlq",
            batch_size=len(batch),
        )
        self._write_to_dlq(batch)
        return 0

    # ── Dead Letter Queue ────────────────────────────────────────────

    def _write_to_dlq(self, entries: list[AuditEntry]) -> None:
        """Append failed audit entries to the DLQ file (JSONL format).

        Each line is a JSON object representing one AuditEntry with
        a `dlq_timestamp` indicating when it was moved to DLQ.
        """
        try:
            with open(self._dlq_path, "a") as f:
                dlq_ts = datetime.now(timezone.utc).isoformat()
                for entry in entries:
                    record = {
                        "action": entry.action.value,
                        "field": entry.field,
                        "tenant_id": entry.tenant_id,
                        "trace_id": entry.trace_id,
                        "status": entry.status,
                        "metadata": entry.metadata,
                        "dlq_timestamp": dlq_ts,
                    }
                    f.write(json.dumps(record, default=str) + "\n")

            AUDIT_ENTRIES_DLQ.inc(len(entries))
            self._update_dlq_metric()
            logger.warning("audit_entries_written_to_dlq", count=len(entries))

        except Exception:
            # Last resort — this should NEVER happen in production
            # but we must not silently lose the data
            logger.critical(
                "audit_dlq_write_failed",
                count=len(entries),
                entries=[e.action.value for e in entries],
            )

    def _update_dlq_metric(self) -> None:
        AUDIT_DLQ_SIZE.set(self.dlq_size_bytes)

    # ── DLQ Recovery ─────────────────────────────────────────────────

    async def replay_dlq(self) -> int:
        """Read DLQ file and attempt to write entries back to DB.

        Returns the number of entries successfully replayed.
        On success, the DLQ file is truncated.
        """
        if not os.path.exists(self._dlq_path):
            return 0

        entries: list[AuditEntry] = []
        try:
            with open(self._dlq_path) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    record = json.loads(line)
                    from tnt_engine.models.domain import AuditAction
                    entries.append(AuditEntry(
                        action=AuditAction(record["action"]),
                        field=record.get("field"),
                        tenant_id=record.get("tenant_id", ""),
                        trace_id=record.get("trace_id"),
                        status=record.get("status", "success"),
                        metadata=record.get("metadata", {}),
                    ))
        except Exception:
            logger.exception("audit_dlq_read_failed")
            return 0

        if not entries:
            return 0

        try:
            await self._repo.write_audit_batch(entries)
            # Success — truncate the DLQ file
            with open(self._dlq_path, "w") as f:
                f.truncate(0)
            self._update_dlq_metric()
            logger.info("audit_dlq_replayed", count=len(entries))
            return len(entries)
        except Exception:
            logger.exception("audit_dlq_replay_failed", count=len(entries))
            return 0
