"""Tests for the event bus — including deduplication."""

from __future__ import annotations

from tnt_engine.events.bus import Event, EventBus


class TestEventBus:
    async def test_publish_to_subscriber(self) -> None:
        bus = EventBus()
        received: list[Event] = []

        async def handler(event: Event) -> None:
            received.append(event)

        bus.subscribe("TOKEN_CREATED", handler)
        await bus.publish(Event(type="TOKEN_CREATED", tenant_id="acme"))

        assert len(received) == 1
        assert received[0].type == "TOKEN_CREATED"
        assert received[0].tenant_id == "acme"

    async def test_no_subscribers(self) -> None:
        bus = EventBus()
        await bus.publish(Event(type="UNKNOWN", tenant_id="x"))

    async def test_multiple_subscribers(self) -> None:
        bus = EventBus()
        count = [0]

        async def h1(e: Event) -> None:
            count[0] += 1

        async def h2(e: Event) -> None:
            count[0] += 10

        bus.subscribe("TOKEN_REVOKED", h1)
        bus.subscribe("TOKEN_REVOKED", h2)
        await bus.publish(Event(type="TOKEN_REVOKED", tenant_id="acme"))

        assert count[0] == 11

    async def test_handler_failure_does_not_propagate(self) -> None:
        bus = EventBus()
        calls = [0]

        async def failing_handler(e: Event) -> None:
            raise RuntimeError("boom")

        async def good_handler(e: Event) -> None:
            calls[0] += 1

        bus.subscribe("TEST", failing_handler)
        bus.subscribe("TEST", good_handler)

        await bus.publish(Event(type="TEST", tenant_id="x"))
        assert calls[0] == 1

    async def test_event_has_id(self) -> None:
        event = Event(type="TOKEN_CREATED", tenant_id="acme")
        assert event.event_id
        assert len(event.event_id) == 32  # 16 bytes hex

    async def test_deduplication(self) -> None:
        """Same event_id published twice -> handler called only once."""
        bus = EventBus()
        count = [0]

        async def handler(e: Event) -> None:
            count[0] += 1

        bus.subscribe("TOKEN_CREATED", handler)

        event = Event(type="TOKEN_CREATED", tenant_id="acme", event_id="fixed-id-123")
        await bus.publish(event)
        await bus.publish(event)  # duplicate

        assert count[0] == 1

    async def test_different_ids_both_processed(self) -> None:
        bus = EventBus()
        count = [0]

        async def handler(e: Event) -> None:
            count[0] += 1

        bus.subscribe("TOKEN_CREATED", handler)

        await bus.publish(Event(type="TOKEN_CREATED", tenant_id="a", event_id="id-1"))
        await bus.publish(Event(type="TOKEN_CREATED", tenant_id="a", event_id="id-2"))

        assert count[0] == 2

    async def test_event_data(self) -> None:
        bus = EventBus()
        received: list[Event] = []

        async def handler(e: Event) -> None:
            received.append(e)

        bus.subscribe("TOKEN_CREATED", handler)
        await bus.publish(Event(
            type="TOKEN_CREATED",
            tenant_id="acme",
            data={"token_prefix": "tok_abc", "field": "ssn"},
        ))

        assert received[0].data["field"] == "ssn"

    def test_subscriptions(self) -> None:
        bus = EventBus()

        async def h(e: Event) -> None:
            pass

        bus.subscribe("A", h)
        bus.subscribe("A", h)
        bus.subscribe("B", h)

        assert bus.subscriptions == {"A": 2, "B": 1}
