"""
SwarmX Event Bus — Central non-blocking event routing system.

Inspired by the Gateway pattern from OpenClaw, adapted for multi-agent
orchestration. The EventBus acts as the central nervous system: agents
subscribe to event topics, emit events, and the bus routes them without
requiring direct agent-to-agent coupling.

Architecture pattern adapted from OpenClaw's WebSocket control plane,
reimplemented as a pure async Python event system.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Coroutine

logger = logging.getLogger("swarmx.event_bus")


class EventPriority(Enum):
    """Priority levels for event processing ordering."""

    LOW = 0
    NORMAL = 1
    HIGH = 2
    CRITICAL = 3


@dataclass
class Event:
    """
    An immutable event that flows through the SwarmX event bus.

    Events are the fundamental communication primitive. Agents never call
    each other directly — they publish and subscribe to typed events.

    Attributes:
        topic: The event topic/channel (e.g. "task.created", "agent.response").
        payload: Arbitrary data attached to the event.
        source: Identifier of the event producer (agent ID, "engine", "cli", etc.).
        event_id: Unique identifier for tracing and deduplication.
        timestamp: Unix timestamp of event creation.
        priority: Processing priority (higher = processed first).
        metadata: Optional metadata for routing, tracing, and filtering.
    """

    topic: str
    payload: dict[str, Any] = field(default_factory=dict)
    source: str = ""
    event_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    timestamp: float = field(default_factory=time.time)
    priority: EventPriority = EventPriority.NORMAL
    metadata: dict[str, Any] = field(default_factory=dict)


# Type alias for event handler coroutines
EventHandler = Callable[[Event], Coroutine[Any, Any, None]]


@dataclass
class _Subscription:
    """Internal subscription record."""

    handler: EventHandler
    subscriber_id: str
    topic_pattern: str
    priority: EventPriority = EventPriority.NORMAL


class EventBus:
    """
    Central async event bus for SwarmX agent coordination.

    The bus supports topic-based pub/sub with wildcard matching:
      - "task.created"      → exact match
      - "task.*"            → matches any subtopic under "task"
      - "*"                 → matches everything (global listener)

    All event dispatch is non-blocking. Handlers execute as async tasks
    and exceptions in individual handlers do not stop other handlers.
    """

    def __init__(self, max_queue_size: int = 10_000) -> None:
        self._subscriptions: dict[str, list[_Subscription]] = {}
        self._global_subscriptions: list[_Subscription] = []
        self._event_queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=max_queue_size)
        self._running = False
        self._dispatch_task: asyncio.Task[None] | None = None
        self._event_history: list[Event] = []
        self._max_history = 1000
        self._stats: dict[str, int] = {"published": 0, "dispatched": 0, "errors": 0}

    # ── Subscription Management ─────────────────────────────────────

    def subscribe(
        self,
        topic: str,
        handler: EventHandler,
        subscriber_id: str = "",
        priority: EventPriority = EventPriority.NORMAL,
    ) -> str:
        """
        Subscribe a handler to a topic pattern.

        Returns the subscriber_id (generated if not provided).
        """
        if not subscriber_id:
            subscriber_id = uuid.uuid4().hex[:8]

        sub = _Subscription(
            handler=handler,
            subscriber_id=subscriber_id,
            topic_pattern=topic,
            priority=priority,
        )

        if topic == "*":
            self._global_subscriptions.append(sub)
        else:
            if topic not in self._subscriptions:
                self._subscriptions[topic] = []
            self._subscriptions[topic].append(sub)

        logger.debug("Subscription added: %s → %s", subscriber_id, topic)
        return subscriber_id

    def unsubscribe(self, subscriber_id: str) -> int:
        """Remove all subscriptions for a given subscriber. Returns count removed."""
        removed = 0

        # Remove from topic-specific subscriptions
        for topic in list(self._subscriptions.keys()):
            before = len(self._subscriptions[topic])
            self._subscriptions[topic] = [
                s for s in self._subscriptions[topic] if s.subscriber_id != subscriber_id
            ]
            removed += before - len(self._subscriptions[topic])
            if not self._subscriptions[topic]:
                del self._subscriptions[topic]

        # Remove from global subscriptions
        before = len(self._global_subscriptions)
        self._global_subscriptions = [
            s for s in self._global_subscriptions if s.subscriber_id != subscriber_id
        ]
        removed += before - len(self._global_subscriptions)

        if removed:
            logger.debug("Unsubscribed %s (%d handlers removed)", subscriber_id, removed)
        return removed

    # ── Publishing ──────────────────────────────────────────────────

    async def publish(self, event: Event) -> None:
        """Enqueue an event for async dispatch."""
        await self._event_queue.put(event)
        self._stats["published"] += 1
        logger.debug(
            "Event published: [%s] %s from %s",
            event.event_id,
            event.topic,
            event.source,
        )

    def publish_nowait(self, event: Event) -> None:
        """Enqueue an event without waiting (raises QueueFull if at capacity)."""
        self._event_queue.put_nowait(event)
        self._stats["published"] += 1

    # ── Dispatch Loop ───────────────────────────────────────────────

    async def start(self) -> None:
        """Start the event dispatch loop."""
        if self._running:
            return
        self._running = True
        self._dispatch_task = asyncio.create_task(self._dispatch_loop())
        logger.info("EventBus started")

    async def stop(self) -> None:
        """Gracefully stop the event dispatch loop, processing remaining events."""
        if not self._running:
            return
        self._running = False

        # Drain remaining events
        while not self._event_queue.empty():
            event = self._event_queue.get_nowait()
            await self._dispatch_event(event)

        if self._dispatch_task:
            self._dispatch_task.cancel()
            try:
                await self._dispatch_task
            except asyncio.CancelledError:
                pass
            self._dispatch_task = None

        logger.info("EventBus stopped (stats: %s)", self._stats)

    async def _dispatch_loop(self) -> None:
        """Main dispatch loop — dequeues events and fans out to handlers."""
        while self._running:
            try:
                event = await asyncio.wait_for(self._event_queue.get(), timeout=0.1)
                await self._dispatch_event(event)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Unexpected error in dispatch loop")
                self._stats["errors"] += 1

    async def _dispatch_event(self, event: Event) -> None:
        """Dispatch a single event to all matching handlers."""
        # Record history
        self._event_history.append(event)
        if len(self._event_history) > self._max_history:
            self._event_history = self._event_history[-self._max_history:]

        # Collect matching handlers
        handlers: list[_Subscription] = []

        # Exact topic match
        if event.topic in self._subscriptions:
            handlers.extend(self._subscriptions[event.topic])

        # Wildcard match: "task.*" matches "task.created", "task.completed", etc.
        topic_parts = event.topic.split(".")
        for i in range(len(topic_parts)):
            wildcard = ".".join(topic_parts[: i + 1]) + ".*" if i < len(topic_parts) - 1 else ""
            if wildcard and wildcard in self._subscriptions:
                handlers.extend(self._subscriptions[wildcard])

        # Parent wildcard: "task.*" should also match "task.sub.deep"
        for pattern, subs in self._subscriptions.items():
            if pattern.endswith(".*"):
                prefix = pattern[:-2]
                if event.topic.startswith(prefix + ".") and pattern not in [
                    ".".join(topic_parts[: i + 1]) + ".*"
                    for i in range(len(topic_parts))
                ]:
                    handlers.extend(subs)

        # Global listeners
        handlers.extend(self._global_subscriptions)

        # Sort by priority (highest first)
        handlers.sort(key=lambda s: s.priority.value, reverse=True)

        # Execute handlers concurrently
        if handlers:
            tasks = [self._safe_call(sub.handler, event, sub.subscriber_id) for sub in handlers]
            await asyncio.gather(*tasks)

        self._stats["dispatched"] += 1

    async def _safe_call(
        self, handler: EventHandler, event: Event, subscriber_id: str
    ) -> None:
        """Execute a handler with error isolation."""
        try:
            await handler(event)
        except Exception:
            logger.exception(
                "Handler error in subscriber %s for event %s",
                subscriber_id,
                event.topic,
            )
            self._stats["errors"] += 1

    # ── Introspection ───────────────────────────────────────────────

    @property
    def stats(self) -> dict[str, int]:
        """Return event bus statistics."""
        return dict(self._stats)

    @property
    def subscription_count(self) -> int:
        """Total number of active subscriptions."""
        return sum(len(subs) for subs in self._subscriptions.values()) + len(
            self._global_subscriptions
        )

    def recent_events(self, limit: int = 20) -> list[Event]:
        """Return the most recent events."""
        return self._event_history[-limit:]
