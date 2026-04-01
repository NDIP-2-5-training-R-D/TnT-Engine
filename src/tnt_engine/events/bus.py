"""Event bus with at-least-once delivery and consumer-side deduplication.

Events carry a unique `event_id` for deduplication. Consumers that
need exactly-once semantics track processed event_ids and skip duplicates.

In-process implementation. Swap the EventBus class for a Kafka/Redis
Streams publisher when cross-service events are needed — the Event
dataclass and EventHandler interface remain the same.

Usage:
    bus = EventBus()
    bus.subscribe("TOKEN_CREATED", my_handler)
    await bus.publish(Event(type="TOKEN_CREATED", tenant_id="acme", data={...}))
    # event.event_id is auto-generated if not provided
"""

from __future__ import annotations

import asyncio
import secrets
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine

from prometheus_client import Counter

from tnt_engine.logging import get_logger

logger = get_logger(__name__)

EVENTS_PUBLISHED = Counter("tnt_events_published_total", "Events published", ["event_type"])
EVENTS_FAILED = Counter("tnt_events_handler_failures_total", "Event handler failures", ["event_type"])
EVENTS_DEDUPED = Counter("tnt_events_deduplicated_total", "Events skipped by dedup", ["event_type"])


def _generate_event_id() -> str:
    return secrets.token_hex(16)


@dataclass(frozen=True)
class Event:
    """An immutable event emitted by the platform."""
    type: str
    tenant_id: str
    data: dict = field(default_factory=dict)
    event_id: str = field(default_factory=_generate_event_id)
    trace_id: str | None = None
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


EventHandler = Callable[[Event], Coroutine[Any, Any, None]]


class EventBus:
    """In-process async event bus with deduplication.

    Tracks recently published event_ids to prevent duplicate processing
    when events are retried (at-least-once delivery guarantee).
    """

    def __init__(self, dedup_window_size: int = 10_000) -> None:
        self._handlers: dict[str, list[EventHandler]] = {}
        self._seen: OrderedDict[str, bool] = OrderedDict()
        self._dedup_max = dedup_window_size

    def subscribe(self, event_type: str, handler: EventHandler) -> None:
        """Register a handler for an event type."""
        self._handlers.setdefault(event_type, []).append(handler)

    async def publish(self, event: Event) -> None:
        """Publish an event. Deduplicates by event_id."""
        # Dedup check
        if event.event_id in self._seen:
            EVENTS_DEDUPED.labels(event_type=event.type).inc()
            return

        # Track this event_id (bounded LRU)
        self._seen[event.event_id] = True
        if len(self._seen) > self._dedup_max:
            self._seen.popitem(last=False)

        EVENTS_PUBLISHED.labels(event_type=event.type).inc()
        handlers = self._handlers.get(event.type, [])
        for handler in handlers:
            try:
                await handler(event)
            except Exception:
                EVENTS_FAILED.labels(event_type=event.type).inc()
                logger.warning(
                    "event_handler_failed",
                    event_type=event.type,
                    handler=handler.__name__,
                )

    def publish_fire_and_forget(self, event: Event) -> None:
        """Schedule event publication without awaiting."""
        asyncio.create_task(self.publish(event))

    @property
    def subscriptions(self) -> dict[str, int]:
        """Return {event_type: handler_count} for debugging."""
        return {k: len(v) for k, v in self._handlers.items()}
