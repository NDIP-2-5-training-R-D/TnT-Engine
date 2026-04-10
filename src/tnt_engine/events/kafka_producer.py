"""Kafka producer for durable audit-log delivery.

The in-memory audit buffer + on-disk DLQ is bounded by the lifetime of the
process and its local filesystem. In Kubernetes, a pod killed mid-flush loses
whatever was buffered in RAM, and an ephemeral DLQ file goes with the pod.

By tee-ing every audit batch to a Kafka topic *before* the DB write, we move
durability out of the pod and into the broker. Even if PostgreSQL is down, or
the pod is killed, or the DB flush enters a crash-loop, the audit entries live
in Kafka and can be replayed.

This module only implements the producer side. A downstream consumer
(Kafka → DB, or Kafka → SIEM) is out of scope for the initial container
bring-up.

Design notes:
  - acks="all" + enable_idempotence=True: guarantees at-least-once durability
    across broker restarts without duplicates (within a producer session).
  - Non-fatal on startup: if the broker is unreachable, we log and disable the
    sink rather than blocking service startup. The DB path still runs.
  - Per-entry JSON serialization: keeps the topic schema easy to consume from
    any downstream tool. Keys are tenant_id so ordering is preserved per tenant.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from tnt_engine.logging import get_logger
from tnt_engine.metrics import (
    AUDIT_KAFKA_FAILURES,
    AUDIT_KAFKA_PUBLISHED,
)

if TYPE_CHECKING:
    from tnt_engine.config import Settings
    from tnt_engine.models.domain import AuditEntry

logger = get_logger(__name__)


class KafkaAuditProducer:
    """Async Kafka producer dedicated to the audit topic.

    The producer is lazy: ``start()`` must be called before any ``publish``.
    Failure to connect is logged but not raised — the caller should treat
    ``started`` as authoritative and skip the sink when it's False.
    """

    def __init__(self, settings: "Settings") -> None:
        self._bootstrap = settings.kafka_bootstrap_servers
        self._topic = settings.kafka_audit_topic
        self._client_id = settings.kafka_client_id
        self._request_timeout_ms = int(settings.kafka_request_timeout_seconds * 1000)
        self._producer = None  # type: ignore[var-annotated]
        self._started = False

    @property
    def started(self) -> bool:
        return self._started

    @property
    def topic(self) -> str:
        return self._topic

    async def start(self) -> None:
        """Create and start the underlying AIOKafkaProducer.

        Safe to call multiple times; only the first call has effect.
        If aiokafka isn't installed or the broker is unreachable, the
        producer stays disabled and all publishes become no-ops.
        """
        if self._started:
            return

        try:
            from aiokafka import AIOKafkaProducer
        except ImportError:
            logger.warning(
                "kafka_producer_disabled_missing_dependency",
                hint="pip install aiokafka",
            )
            return

        try:
            self._producer = AIOKafkaProducer(
                bootstrap_servers=self._bootstrap,
                client_id=self._client_id,
                acks="all",
                enable_idempotence=True,
                request_timeout_ms=self._request_timeout_ms,
                linger_ms=20,
                compression_type="gzip",
            )
            await self._producer.start()
            self._started = True
            logger.info(
                "kafka_audit_producer_started",
                bootstrap=self._bootstrap,
                topic=self._topic,
            )
        except Exception as exc:
            self._producer = None
            self._started = False
            logger.warning(
                "kafka_audit_producer_start_failed",
                bootstrap=self._bootstrap,
                error=str(exc),
            )

    async def stop(self) -> None:
        """Flush any buffered records and close the underlying producer."""
        if not self._started or self._producer is None:
            return
        try:
            await self._producer.stop()
            logger.info("kafka_audit_producer_stopped")
        except Exception:
            logger.exception("kafka_audit_producer_stop_failed")
        finally:
            self._producer = None
            self._started = False

    async def publish_batch(self, entries: list["AuditEntry"]) -> bool:
        """Publish a batch of audit entries to Kafka.

        Returns True on success, False on any failure (including the producer
        being disabled). Caller decides whether to fall back / retry — this
        class does not mutate the DB-side DLQ.
        """
        if not self._started or self._producer is None or not entries:
            return self._started and not entries  # nothing to do is success

        try:
            for entry in entries:
                payload = _serialize(entry)
                key = (entry.tenant_id or "").encode("utf-8") or None
                await self._producer.send_and_wait(
                    self._topic,
                    value=payload,
                    key=key,
                )
            AUDIT_KAFKA_PUBLISHED.inc(len(entries))
            return True
        except Exception as exc:
            AUDIT_KAFKA_FAILURES.inc(len(entries))
            logger.warning(
                "kafka_audit_publish_failed",
                batch_size=len(entries),
                topic=self._topic,
                error=str(exc),
            )
            return False


def _serialize(entry: "AuditEntry") -> bytes:
    """Encode an AuditEntry as JSON bytes for the Kafka topic."""
    record = {
        "action": entry.action.value,
        "field": entry.field,
        "tenant_id": entry.tenant_id,
        "trace_id": entry.trace_id,
        "status": entry.status,
        "metadata": entry.metadata,
        "published_at": datetime.now(timezone.utc).isoformat(),
    }
    return json.dumps(record, default=str).encode("utf-8")
