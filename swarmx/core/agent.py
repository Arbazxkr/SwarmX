"""
SwarmX Agent — Base agent class with event-driven lifecycle.

Adapted from OpenClaw's agent architecture: agents have isolated state,
bind to a provider declaratively, and communicate exclusively through
the event bus. No direct agent-to-agent calls are permitted.

The agent lifecycle follows:
  1. initialize() — one-time setup, subscribe to events
  2. on_event()   — handle incoming events
  3. think()      — process messages through the provider
  4. emit()       — publish results back to the bus
  5. shutdown()   — cleanup
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from swarmx.core.event_bus import Event, EventBus, EventPriority
from swarmx.core.provider import (
    CompletionResponse,
    Message,
    ProviderBase,
    ProviderRegistry,
    Role,
)

logger = logging.getLogger("swarmx.agent")


class AgentState(Enum):
    """Lifecycle states for an agent."""

    CREATED = "created"
    INITIALIZING = "initializing"
    IDLE = "idle"
    PROCESSING = "processing"
    ERROR = "error"
    SHUTDOWN = "shutdown"


@dataclass
class AgentConfig:
    """
    Declarative agent configuration.

    Agents are defined by config — the provider, subscriptions,
    system prompt, and tools are all declared upfront. This enables
    config-driven swarm definitions via YAML.
    """

    name: str
    provider: str  # Provider name from the registry
    model: str = ""  # Override provider's default model
    system_prompt: str = ""
    subscriptions: list[str] = field(default_factory=list)
    tools: list[dict[str, Any]] = field(default_factory=list)
    max_history: int = 50
    temperature: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class Agent:
    """
    Base agent class for SwarmX.

    Agents are autonomous units that:
      - Subscribe to events via the EventBus
      - Process events through an LLM provider
      - Emit response events back to the bus

    Subclass this to create specialized agents with custom
    event handling, tool execution, or output formatting.
    """

    def __init__(
        self,
        config: AgentConfig,
        event_bus: EventBus,
        provider_registry: ProviderRegistry,
    ) -> None:
        self.config = config
        self.event_bus = event_bus
        self.provider_registry = provider_registry

        self.agent_id: str = f"{config.name}-{uuid.uuid4().hex[:6]}"
        self.state: AgentState = AgentState.CREATED
        self._message_history: list[Message] = []
        self._provider: ProviderBase | None = None
        self._processing_lock = asyncio.Lock()

    # ── Lifecycle ───────────────────────────────────────────────────

    async def initialize(self) -> None:
        """
        Initialize the agent: resolve provider, set up subscriptions.

        Called once by the engine before the agent starts processing.
        """
        self.state = AgentState.INITIALIZING

        # Resolve provider from registry
        self._provider = self.provider_registry.get(self.config.provider)
        logger.info(
            "Agent '%s' bound to provider '%s' (%s)",
            self.agent_id,
            self.config.provider,
            self._provider,
        )

        # Set system prompt
        if self.config.system_prompt:
            self._message_history.append(
                Message(role=Role.SYSTEM, content=self.config.system_prompt)
            )

        # Subscribe to configured topics
        for topic in self.config.subscriptions:
            self.event_bus.subscribe(
                topic=topic,
                handler=self._handle_event,
                subscriber_id=self.agent_id,
            )
            logger.debug("Agent '%s' subscribed to '%s'", self.agent_id, topic)

        self.state = AgentState.IDLE
        logger.info("Agent '%s' initialized and ready", self.agent_id)

    async def shutdown(self) -> None:
        """Gracefully shut down the agent."""
        self.state = AgentState.SHUTDOWN
        self.event_bus.unsubscribe(self.agent_id)
        logger.info("Agent '%s' shut down", self.agent_id)

    # ── Event Handling ──────────────────────────────────────────────

    async def _handle_event(self, event: Event) -> None:
        """Internal event handler — delegates to on_event with locking."""
        async with self._processing_lock:
            self.state = AgentState.PROCESSING
            try:
                await self.on_event(event)
            except Exception:
                self.state = AgentState.ERROR
                logger.exception("Agent '%s' error processing event %s", self.agent_id, event.topic)
                await self.emit(
                    "agent.error",
                    {
                        "agent_id": self.agent_id,
                        "event_topic": event.topic,
                        "error": "Processing failed",
                    },
                )
            finally:
                if self.state == AgentState.PROCESSING:
                    self.state = AgentState.IDLE

    async def on_event(self, event: Event) -> None:
        """
        Handle an incoming event.

        Default implementation extracts a user message from the event
        payload and sends it through the provider. Override this for
        custom event handling logic.
        """
        # Extract the message content from the event
        content = event.payload.get("content", "")
        if not content:
            content = event.payload.get("message", "")
        if not content:
            logger.debug("Agent '%s' ignoring event with no content: %s", self.agent_id, event.topic)
            return

        # Think and respond
        response = await self.think(content)
        if response:
            await self.emit(
                f"agent.response.{self.config.name}",
                {
                    "agent_id": self.agent_id,
                    "content": response.message.content,
                    "model": response.model,
                    "usage": response.usage,
                    "source_event": event.event_id,
                },
            )

    # ── Core Intelligence ───────────────────────────────────────────

    async def think(self, user_input: str) -> CompletionResponse | None:
        """
        Process user input through the LLM provider.

        Manages conversation history and returns the provider's response.
        """
        if not self._provider:
            logger.error("Agent '%s' has no provider bound", self.agent_id)
            return None

        # Add user message to history
        self._message_history.append(Message(role=Role.USER, content=user_input))

        # Trim history if needed
        if len(self._message_history) > self.config.max_history:
            # Keep system prompt + recent messages
            system_msgs = [m for m in self._message_history if m.role == Role.SYSTEM]
            recent = self._message_history[-(self.config.max_history - len(system_msgs)):]
            self._message_history = system_msgs + recent

        # Call provider
        kwargs: dict[str, Any] = {}
        if self.config.model:
            kwargs["model"] = self.config.model
        if self.config.temperature is not None:
            kwargs["temperature"] = self.config.temperature

        response = await self._provider.complete(
            messages=self._message_history,
            tools=self.config.tools or None,
            **kwargs,
        )

        # Add assistant response to history
        self._message_history.append(response.message)

        logger.debug(
            "Agent '%s' completed thinking (tokens: %s)",
            self.agent_id,
            response.usage,
        )
        return response

    # ── Event Emission ──────────────────────────────────────────────

    async def emit(
        self,
        topic: str,
        payload: dict[str, Any],
        priority: EventPriority = EventPriority.NORMAL,
    ) -> None:
        """Publish an event to the bus from this agent."""
        event = Event(
            topic=topic,
            payload=payload,
            source=self.agent_id,
            priority=priority,
        )
        await self.event_bus.publish(event)

    # ── Introspection ───────────────────────────────────────────────

    @property
    def history(self) -> list[Message]:
        """Current message history."""
        return list(self._message_history)

    @property
    def provider(self) -> ProviderBase | None:
        """The agent's bound provider."""
        return self._provider

    def __repr__(self) -> str:
        return (
            f"<Agent '{self.agent_id}' state={self.state.value} "
            f"provider={self.config.provider}>"
        )
