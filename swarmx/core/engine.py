"""
SwarmX Engine — Core orchestration engine.

The SwarmEngine is the top-level coordinator that wires together the
event bus, task scheduler, provider registry, and agents. It is
responsible for:
  - Loading swarm definitions from config
  - Instantiating and managing agent lifecycles
  - Starting/stopping all subsystems
  - Providing a clean API for the CLI and programmatic use

Adapted from OpenClaw's Gateway pattern: the Gateway acts as the single
control plane for sessions, channels, tools, and events. The SwarmEngine
serves the same role for multi-agent orchestration.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from swarmx.core.agent import Agent, AgentConfig, AgentState
from swarmx.core.event_bus import Event, EventBus
from swarmx.core.provider import ProviderBase, ProviderConfig, ProviderRegistry
from swarmx.core.scheduler import Task, TaskScheduler

logger = logging.getLogger("swarmx.engine")


class SwarmEngine:
    """
    The SwarmX orchestration engine.

    Usage:
        engine = SwarmEngine()
        engine.register_provider("openai", OpenAIProvider(config))
        engine.add_agent(AgentConfig(name="researcher", provider="openai", ...))
        await engine.start()
        await engine.submit_task("Analyze the market")
        await engine.stop()
    """

    def __init__(self, event_bus: EventBus | None = None) -> None:
        self.event_bus = event_bus or EventBus()
        self.provider_registry = ProviderRegistry()
        self.scheduler = TaskScheduler(self.event_bus)

        self._agents: dict[str, Agent] = {}
        self._running = False

        # Register built-in provider classes
        self._register_builtin_providers()

        # Subscribe to engine-level events
        self.event_bus.subscribe(
            "agent.response.*",
            self._on_agent_response,
            subscriber_id="engine",
        )
        self.event_bus.subscribe(
            "agent.error",
            self._on_agent_error,
            subscriber_id="engine",
        )

    # ── Provider Management ─────────────────────────────────────────

    def _register_builtin_providers(self) -> None:
        """Register the built-in provider classes for lazy instantiation."""
        try:
            from swarmx.providers.openai_provider import OpenAIProvider
            self.provider_registry.register_class("openai", OpenAIProvider)
        except ImportError:
            pass

        try:
            from swarmx.providers.anthropic_provider import AnthropicProvider
            self.provider_registry.register_class("anthropic", AnthropicProvider)
        except ImportError:
            pass

        try:
            from swarmx.providers.google_provider import GoogleProvider
            self.provider_registry.register_class("google", GoogleProvider)
        except ImportError:
            pass

        try:
            from swarmx.providers.xai_provider import XAIProvider
            self.provider_registry.register_class("xai", XAIProvider)
        except ImportError:
            pass

    def register_provider(
        self, name: str, provider: ProviderBase | None = None, config: ProviderConfig | None = None
    ) -> None:
        """
        Register a provider by instance or by config (lazy creation).

        Args:
            name: Provider name that agents will reference.
            provider: A pre-configured provider instance.
            config: Config for lazy provider creation from registered classes.
        """
        if provider:
            self.provider_registry.register_instance(name, provider)
        elif config:
            self.provider_registry.create(name, config)
        else:
            raise ValueError("Must provide either a provider instance or config")

    # ── Agent Management ────────────────────────────────────────────

    def add_agent(
        self,
        config: AgentConfig,
        agent_class: type[Agent] | None = None,
    ) -> Agent:
        """
        Create and register an agent.

        Args:
            config: Agent configuration.
            agent_class: Optional custom agent class (defaults to base Agent).

        Returns:
            The created Agent instance.
        """
        cls = agent_class or Agent
        agent = cls(
            config=config,
            event_bus=self.event_bus,
            provider_registry=self.provider_registry,
        )
        self._agents[agent.agent_id] = agent
        logger.info("Agent added: %s", agent.agent_id)
        return agent

    def get_agent(self, agent_id: str) -> Agent | None:
        """Look up an agent by ID."""
        return self._agents.get(agent_id)

    def get_agents_by_name(self, name: str) -> list[Agent]:
        """Find all agents with a given name (there may be multiple instances)."""
        return [a for a in self._agents.values() if a.config.name == name]

    # ── Task Submission ─────────────────────────────────────────────

    async def submit_task(
        self,
        content: str,
        name: str = "",
        target_topic: str = "task.created",
        **kwargs: Any,
    ) -> str:
        """
        Submit a task to the swarm.

        This is the primary way to send work into the system.
        The task is published as an event and handled by subscribed agents.

        Returns:
            The task ID for tracking.
        """
        task = Task(
            name=name or content[:50],
            description=content,
            target_topic=target_topic,
            payload={"content": content, **kwargs},
        )
        return await self.scheduler.submit(task)

    async def broadcast(self, topic: str, payload: dict[str, Any]) -> None:
        """Publish an event to the bus directly."""
        event = Event(topic=topic, payload=payload, source="engine")
        await self.event_bus.publish(event)

    # ── Lifecycle ───────────────────────────────────────────────────

    async def start(self) -> None:
        """
        Start the SwarmX engine.

        Initializes all agents, starts the event bus, and begins scheduling.
        """
        if self._running:
            logger.warning("Engine already running")
            return

        logger.info("Starting SwarmX engine...")

        # Start event bus first
        await self.event_bus.start()

        # Initialize all agents
        init_tasks = [agent.initialize() for agent in self._agents.values()]
        await asyncio.gather(*init_tasks, return_exceptions=True)

        # Start scheduler
        await self.scheduler.start()

        self._running = True
        logger.info(
            "SwarmX engine started (%d agents, %d providers)",
            len(self._agents),
            len(self.provider_registry.available),
        )

    async def stop(self) -> None:
        """Gracefully shut down all subsystems."""
        if not self._running:
            return

        logger.info("Stopping SwarmX engine...")

        # Shutdown agents
        shutdown_tasks = [agent.shutdown() for agent in self._agents.values()]
        await asyncio.gather(*shutdown_tasks, return_exceptions=True)

        # Stop scheduler
        await self.scheduler.stop()

        # Stop event bus last
        await self.event_bus.stop()

        self._running = False
        logger.info("SwarmX engine stopped")

    # ── Internal Event Handlers ─────────────────────────────────────

    async def _on_agent_response(self, event: Event) -> None:
        """Handle agent response events (logging/routing)."""
        agent_id = event.payload.get("agent_id", "unknown")
        content = event.payload.get("content", "")
        logger.debug(
            "Agent response from %s: %s",
            agent_id,
            content[:100] + "..." if len(content) > 100 else content,
        )

    async def _on_agent_error(self, event: Event) -> None:
        """Handle agent error events."""
        agent_id = event.payload.get("agent_id", "unknown")
        logger.error("Agent error from %s: %s", agent_id, event.payload)

    # ── Introspection ───────────────────────────────────────────────

    @property
    def agents(self) -> dict[str, Agent]:
        """All registered agents."""
        return dict(self._agents)

    @property
    def is_running(self) -> bool:
        """Whether the engine is currently running."""
        return self._running

    def status(self) -> dict[str, Any]:
        """Return a summary of the engine's current state."""
        return {
            "running": self._running,
            "agents": {
                aid: {
                    "name": a.config.name,
                    "state": a.state.value,
                    "provider": a.config.provider,
                }
                for aid, a in self._agents.items()
            },
            "providers": self.provider_registry.available,
            "event_bus": self.event_bus.stats,
            "scheduler": {
                "pending": self.scheduler.pending_count,
                "running": self.scheduler.running_count,
            },
        }

    def __repr__(self) -> str:
        return (
            f"<SwarmEngine agents={len(self._agents)} "
            f"running={self._running}>"
        )
