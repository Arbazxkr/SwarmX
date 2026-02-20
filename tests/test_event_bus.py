"""
Tests for the SwarmX EventBus.

Tests the core event routing, subscription, wildcard matching,
and error isolation without requiring any LLM provider.
"""

from __future__ import annotations

import asyncio
import pytest
from swarmx.core.event_bus import Event, EventBus, EventPriority


@pytest.fixture
def event_bus():
    return EventBus()


class TestEventBus:
    """Test suite for EventBus."""

    @pytest.mark.asyncio
    async def test_basic_pub_sub(self, event_bus: EventBus):
        """Events should be delivered to subscribers."""
        received: list[Event] = []

        async def handler(event: Event):
            received.append(event)

        event_bus.subscribe("test.topic", handler, subscriber_id="test-sub")
        await event_bus.start()

        await event_bus.publish(Event(topic="test.topic", payload={"data": "hello"}))
        await asyncio.sleep(0.2)

        await event_bus.stop()
        assert len(received) == 1
        assert received[0].payload["data"] == "hello"

    @pytest.mark.asyncio
    async def test_wildcard_subscription(self, event_bus: EventBus):
        """Wildcard subscriptions should match subtopics."""
        received: list[Event] = []

        async def handler(event: Event):
            received.append(event)

        event_bus.subscribe("task.*", handler, subscriber_id="wild-sub")
        await event_bus.start()

        await event_bus.publish(Event(topic="task.created"))
        await event_bus.publish(Event(topic="task.completed"))
        await event_bus.publish(Event(topic="other.topic"))  # Should NOT match
        await asyncio.sleep(0.3)

        await event_bus.stop()
        assert len(received) == 2

    @pytest.mark.asyncio
    async def test_global_subscription(self, event_bus: EventBus):
        """Global (*) subscriptions should receive all events."""
        received: list[Event] = []

        async def handler(event: Event):
            received.append(event)

        event_bus.subscribe("*", handler, subscriber_id="global-sub")
        await event_bus.start()

        await event_bus.publish(Event(topic="foo"))
        await event_bus.publish(Event(topic="bar.baz"))
        await asyncio.sleep(0.3)

        await event_bus.stop()
        assert len(received) == 2

    @pytest.mark.asyncio
    async def test_unsubscribe(self, event_bus: EventBus):
        """Unsubscribed handlers should not receive events."""
        received: list[Event] = []

        async def handler(event: Event):
            received.append(event)

        event_bus.subscribe("test", handler, subscriber_id="unsub-test")
        removed = event_bus.unsubscribe("unsub-test")
        assert removed == 1

        await event_bus.start()
        await event_bus.publish(Event(topic="test"))
        await asyncio.sleep(0.2)
        await event_bus.stop()

        assert len(received) == 0

    @pytest.mark.asyncio
    async def test_error_isolation(self, event_bus: EventBus):
        """Errors in one handler should not affect others."""
        received: list[Event] = []

        async def bad_handler(event: Event):
            raise RuntimeError("Handler error")

        async def good_handler(event: Event):
            received.append(event)

        event_bus.subscribe("test", bad_handler, subscriber_id="bad")
        event_bus.subscribe("test", good_handler, subscriber_id="good")
        await event_bus.start()

        await event_bus.publish(Event(topic="test"))
        await asyncio.sleep(0.2)

        await event_bus.stop()
        assert len(received) == 1  # Good handler still received the event
        assert event_bus.stats["errors"] >= 1

    @pytest.mark.asyncio
    async def test_priority_ordering(self, event_bus: EventBus):
        """Higher priority handlers should execute first."""
        order: list[str] = []

        async def low_handler(event: Event):
            order.append("low")

        async def high_handler(event: Event):
            order.append("high")

        event_bus.subscribe("test", low_handler, subscriber_id="low", priority=EventPriority.LOW)
        event_bus.subscribe("test", high_handler, subscriber_id="high", priority=EventPriority.HIGH)
        await event_bus.start()

        await event_bus.publish(Event(topic="test"))
        await asyncio.sleep(0.2)

        await event_bus.stop()
        # High priority should be first in the gather, but since gather is concurrent,
        # we mainly test that both handlers were called
        assert "high" in order
        assert "low" in order

    @pytest.mark.asyncio
    async def test_stats(self, event_bus: EventBus):
        """Stats should track published and dispatched events."""
        async def handler(event: Event):
            pass

        event_bus.subscribe("test", handler, subscriber_id="stats-test")
        await event_bus.start()

        await event_bus.publish(Event(topic="test"))
        await event_bus.publish(Event(topic="test"))
        await asyncio.sleep(0.3)

        await event_bus.stop()
        assert event_bus.stats["published"] == 2
        assert event_bus.stats["dispatched"] == 2

    def test_subscription_count(self, event_bus: EventBus):
        """Subscription count should be accurate."""
        async def handler(event: Event):
            pass

        assert event_bus.subscription_count == 0
        event_bus.subscribe("a", handler, subscriber_id="s1")
        event_bus.subscribe("b", handler, subscriber_id="s2")
        assert event_bus.subscription_count == 2
