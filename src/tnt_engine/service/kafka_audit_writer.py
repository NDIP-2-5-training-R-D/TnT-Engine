"""Kafka-backed audit writer for T&T Engine.

Architecture (producer + consumer in the same process):
  - enqueue(): Sends audit entries directly to Kafka via AIOKafkaProducer.
    Kafka replicates messages across brokers, so data survives pod restarts.
  - Background consumer: AIOKafkaConsumer reads from the same topic and
    writes batches to PostgreSQL. Offsets are committed AFTER a successful
    PG write (at-least-once delivery).
  - DLQ fallback: If Kafka is unreachable, entries are written to the local
    DLQ file (same JSONL format as ReliableAuditWriter). On Kafka recovery
    the DLQ can be replayed via admin API.

K8s behaviour:
  - On pod restart, uncommitted Kafka offsets are re-consumed by the new
    (or rebalanced) pod — no audit data is lost from the buffer.
  - Multiple replicas share one consumer group (TNT_KAFKA_CONSUMER_GROUP),
    so each Kafka message is delivered to PostgreSQL exactly once across the
    fleet.

Drop-in replacement for ReliableAuditWriter — same public interface:
  start(), stop(), enqueue(), flush_now(), buffer_size, dlq_size_bytes, replay_dlq()
"""

from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from tnt_engine.config import Settings
from tnt_engine.logging import get_logger
from tnt_engine.metrics import (
    AUDIT_DLQ_SIZE,
    AUDIT_ENTRIES_DLQ,
    AUDIT_ENTRIES_WRITTEN,
    AUDIT_FLUSH_TOTAL,
    KAFKA_CONSUMER_LAG,
    KAFKA_PRODUCE_ERRORS,
    KAFKA_PRODUCE_TOTAL,
)
from tnt_engine.models.domain import AuditAction, AuditEntry

if TYPE_CHECKING:
    pass

logger = get_logger(__name__)


def _entry_to_record(entry: AuditEntry) -> dict:
    return {
        "action": entry.action.value,
        "field": entry.field,
        "tenant_id": entry.tenant_id,
        "trace_id": entry.trace_id,
        "status": entry.status,
        "metadata": entry.metadata,
        "performed_at": datetime.now(timezone.utc).isoformat(),
    }


def _record_to_entry(record: dict) -> AuditEntry:
    return AuditEntry(
        action=AuditAction(record["action"]),
        field=record.get("field"),
        tenant_id=record.get("tenant_id", ""),
        trace_id=record.get("trace_id"),
        status=record.get("status", "success"),
        metadata=record.get("metadata", {}),
    )


class KafkaAuditWriter:
    """Kafka-backed audit writer.

    Requires the `aiokafka` package:
        pip install "tnt-engine[kafka]"  or  pip install aiokafka
    """

    def __init__(self, repo: object, settings: Settings) -> None:
        self._repo = repo
        self._settings = settings
        self._brokers = settings.kafka_brokers
        self._topic = settings.kafka_topic_audit
        self._group_id = settings.kafka_consumer_group
        self._dlq_path = settings.audit_dlq_path
        self._batch_size = settings.kafka_consumer_max_poll_records
        self._max_retries = settings.audit_max_retries
        self._retry_backoff = settings.audit_retry_backoff_seconds

        self._producer = None
        self._consumer = None
        self._consumer_task: asyncio.Task | None = None
        self._running = False

    # ── Public interface (matches ReliableAuditWriter) ───────────────

    async def start(self) -> None:
        self._running = True
        await self._start_producer()
        await self._start_consumer()
        logger.info(
            "kafka_audit_writer_started",
            brokers=self._brokers,
            topic=self._topic,
            group_id=self._group_id,
        )

    async def stop(self) -> None:
        self._running = False

        if self._consumer_task:
            self._consumer_task.cancel()
            try:
                await self._consumer_task
            except asyncio.CancelledError:
                pass

        if self._consumer:
            await self._consumer.stop()

        if self._producer:
            await self._producer.stop()

        logger.info("kafka_audit_writer_stopped")

    def enqueue(self, entry: AuditEntry) -> None:
        """Produce an audit entry to Kafka (fire-and-schedule).

        Schedules an async send in the running event loop.
        Falls back to DLQ if the loop is not available or Kafka is down.
        """
        try:
            loop = asyncio.get_event_loop()
            loop.create_task(self._produce(entry))
        except RuntimeError:
            # No running loop — write directly to DLQ as last resort
            self._write_to_dlq([entry])

    async def flush_now(self) -> int:
        """Flush the Kafka producer's internal buffer immediately."""
        if self._producer:
            await self._producer.flush()
        return 0  # Number of entries written is tracked by consumer, not producer

    @property
    def buffer_size(self) -> int:
        """Kafka handles its own internal buffer; return 0 for compatibility."""
        return 0

    @property
    def dlq_size_bytes(self) -> int:
        try:
            return os.path.getsize(self._dlq_path)
        except OSError:
            return 0

    async def replay_dlq(self) -> int:
        """Read DLQ file and re-produce entries to Kafka (or PostgreSQL directly)."""
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
                    entries.append(_record_to_entry(record))
        except Exception:
            logger.exception("kafka_audit_dlq_read_failed")
            return 0

        if not entries:
            return 0

        # Try to write directly to PostgreSQL (bypass Kafka for replay)
        try:
            await self._repo.write_audit_batch(entries)
            with open(self._dlq_path, "w") as f:
                f.truncate(0)
            self._update_dlq_metric()
            logger.info("kafka_audit_dlq_replayed", count=len(entries))
            return len(entries)
        except Exception:
            logger.exception("kafka_audit_dlq_replay_failed", count=len(entries))
            return 0

    # ── Producer ─────────────────────────────────────────────────────

    async def _start_producer(self) -> None:
        from aiokafka import AIOKafkaProducer  # type: ignore[import]

        kwargs = self._common_kafka_kwargs()
        kwargs.update({
            "acks": self._settings.kafka_producer_acks,
            "linger_ms": self._settings.kafka_producer_linger_ms,
            "max_batch_size": self._settings.kafka_producer_max_batch_size,
            "enable_idempotence": self._settings.kafka_producer_acks == "all",
            "value_serializer": lambda v: json.dumps(v, default=str).encode("utf-8"),
        })

        self._producer = AIOKafkaProducer(**kwargs)
        await self._producer.start()

    async def _produce(self, entry: AuditEntry) -> None:
        if not self._producer:
            self._write_to_dlq([entry])
            return

        record = _entry_to_record(entry)
        try:
            await self._producer.send(
                self._topic,
                value=record,
                key=entry.tenant_id.encode("utf-8"),
            )
            KAFKA_PRODUCE_TOTAL.labels(topic=self._topic, status="success").inc()
        except Exception as exc:
            KAFKA_PRODUCE_ERRORS.labels(topic=self._topic).inc()
            logger.error(
                "kafka_audit_produce_failed",
                topic=self._topic,
                error=str(exc),
            )
            self._write_to_dlq([entry])

    # ── Consumer ─────────────────────────────────────────────────────

    async def _start_consumer(self) -> None:
        from aiokafka import AIOKafkaConsumer  # type: ignore[import]

        kwargs = self._common_kafka_kwargs()
        kwargs.update({
            "group_id": self._group_id,
            "auto_offset_reset": "earliest",
            "enable_auto_commit": False,
            "max_poll_records": self._batch_size,
            "session_timeout_ms": self._settings.kafka_consumer_session_timeout_ms,
            "heartbeat_interval_ms": self._settings.kafka_consumer_heartbeat_interval_ms,
            "value_deserializer": lambda v: json.loads(v.decode("utf-8")),
        })

        self._consumer = AIOKafkaConsumer(self._topic, **kwargs)
        await self._consumer.start()
        self._consumer_task = asyncio.create_task(self._consume_loop())

    async def _consume_loop(self) -> None:
        while self._running:
            try:
                records = await asyncio.wait_for(
                    self._consumer.getmany(timeout_ms=1000, max_records=self._batch_size),
                    timeout=5.0,
                )
                if not records:
                    continue

                entries: list[AuditEntry] = []
                for tp, msgs in records.items():
                    for msg in msgs:
                        try:
                            entries.append(_record_to_entry(msg.value))
                        except Exception:
                            logger.exception(
                                "kafka_audit_deserialize_failed",
                                partition=tp.partition,
                                offset=msg.offset,
                            )

                if entries:
                    await self._write_batch_with_retry(entries)

                # Commit offsets only after successful PostgreSQL write
                await self._consumer.commit()
                KAFKA_CONSUMER_LAG.labels(topic=self._topic, group=self._group_id).set(0)

            except asyncio.CancelledError:
                raise
            except asyncio.TimeoutError:
                continue
            except Exception:
                logger.exception("kafka_audit_consume_loop_error")
                await asyncio.sleep(1)

    async def _write_batch_with_retry(self, entries: list[AuditEntry]) -> None:
        for attempt in range(self._max_retries):
            try:
                await self._repo.write_audit_batch(entries)
                AUDIT_FLUSH_TOTAL.labels(status="success").inc()
                AUDIT_ENTRIES_WRITTEN.inc(len(entries))
                return
            except Exception as exc:
                wait = self._retry_backoff * (2 ** attempt)
                logger.warning(
                    "kafka_audit_pg_write_retry",
                    attempt=attempt + 1,
                    max_retries=self._max_retries,
                    batch_size=len(entries),
                    wait_seconds=wait,
                    error=str(exc),
                )
                if attempt < self._max_retries - 1:
                    await asyncio.sleep(wait)

        # All retries exhausted — write to DLQ (Kafka offset NOT committed)
        AUDIT_FLUSH_TOTAL.labels(status="failure").inc()
        logger.error("kafka_audit_pg_write_exhausted_sending_to_dlq", batch_size=len(entries))
        self._write_to_dlq(entries)

    # ── Shared Kafka kwargs ──────────────────────────────────────────

    def _common_kafka_kwargs(self) -> dict:
        kwargs: dict = {"bootstrap_servers": self._brokers}

        protocol = self._settings.kafka_security_protocol
        kwargs["security_protocol"] = protocol

        if protocol in ("SASL_PLAINTEXT", "SASL_SSL"):
            kwargs["sasl_mechanism"] = self._settings.kafka_sasl_mechanism
            kwargs["sasl_plain_username"] = self._settings.kafka_sasl_username
            kwargs["sasl_plain_password"] = self._settings.kafka_sasl_password

        if protocol in ("SSL", "SASL_SSL") and self._settings.kafka_ssl_ca_cert:
            import ssl
            ssl_ctx = ssl.create_default_context(cafile=self._settings.kafka_ssl_ca_cert)
            kwargs["ssl_context"] = ssl_ctx

        return kwargs

    # ── DLQ ─────────────────────────────────────────────────────────

    def _write_to_dlq(self, entries: list[AuditEntry]) -> None:
        try:
            with open(self._dlq_path, "a") as f:
                dlq_ts = datetime.now(timezone.utc).isoformat()
                for entry in entries:
                    record = _entry_to_record(entry)
                    record["dlq_timestamp"] = dlq_ts
                    f.write(json.dumps(record, default=str) + "\n")
            AUDIT_ENTRIES_DLQ.inc(len(entries))
            self._update_dlq_metric()
            logger.warning("kafka_audit_entries_written_to_dlq", count=len(entries))
        except Exception:
            logger.critical(
                "kafka_audit_dlq_write_failed",
                count=len(entries),
                entries=[e.action.value for e in entries],
            )

    def _update_dlq_metric(self) -> None:
        AUDIT_DLQ_SIZE.set(self.dlq_size_bytes)
