"""
Tests for the SwarmX Agent and Engine.

Uses a mock provider to test agent lifecycle, event handling,
and engine orchestration without requiring real API keys.
"""

from __future__ import annotations

import asyncio
import pytest
from unittest.mock import AsyncMock

from swarmx.core.agent import Agent, AgentConfig, AgentState
from swarmx.core.engine import SwarmEngine
from swarmx.core.event_bus import Event, EventBus
from swarmx.core.provider import (
    CompletionResponse,
    Message,
    ProviderBase,
    ProviderConfig,
    ProviderRegistry,
    Role,
)


class MockProvider(ProviderBase):
    """Mock provider for testing without real API calls."""

    def __init__(self, config: ProviderConfig | None = None):
        super().__init__(config or ProviderConfig())
        self._name = "MockProvider"
        self.call_count = 0
        self.last_messages: list[Message] = []

    async def complete(self, messages, tools=None, **kwargs):
        self.call_count += 1
        self.last_messages = messages
        return CompletionResponse(
            message=Message(
                role=Role.ASSISTANT,
                content=f"Mock response #{self.call_count}",
            ),
            finish_reason="stop",
            usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            model="mock-model",
        )


@pytest.fixture
def mock_provider():
    return MockProvider()


@pytest.fixture
def event_bus():
    return EventBus()


@pytest.fixture
def provider_registry(mock_provider):
    registry = ProviderRegistry()
    registry.register_instance("mock", mock_provider)
    return registry


class TestAgent:
    """Test suite for Agent."""

    @pytest.mark.asyncio
    async def test_agent_initialization(self, event_bus, provider_registry):
        """Agent should initialize and bind to provider."""
        config = AgentConfig(
            name="test-agent",
            provider="mock",
            system_prompt="You are a test agent.",
            subscriptions=["test.topic"],
        )
        agent = Agent(config, event_bus, provider_registry)

        await agent.initialize()

        assert agent.state == AgentState.IDLE
        assert agent.provider is not None
        assert agent.provider.name == "MockProvider"
        assert event_bus.subscription_count == 1

    @pytest.mark.asyncio
    async def test_agent_think(self, event_bus, provider_registry, mock_provider):
        """Agent should process input through provider."""
        config = AgentConfig(name="thinker", provider="mock")
        agent = Agent(config, event_bus, provider_registry)
        await agent.initialize()

        response = await agent.think("Hello, agent!")

        assert response is not None
        assert response.message.content == "Mock response #1"
        assert mock_provider.call_count == 1
        assert len(agent.history) == 2  # user + assistant

    @pytest.mark.asyncio
    async def test_agent_event_handling(self, event_bus, provider_registry, mock_provider):
        """Agent should handle events and emit responses."""
        responses: list[Event] = []

        async def capture_response(event: Event):
            responses.append(event)

        config = AgentConfig(
            name="handler",
            provider="mock",
            subscriptions=["task.created"],
        )
        agent = Agent(config, event_bus, provider_registry)
        event_bus.subscribe("agent.response.*", capture_response, subscriber_id="test-capture")

        await event_bus.start()
        await agent.initialize()

        # Publish a task event
        await event_bus.publish(
            Event(topic="task.created", payload={"content": "Do something"})
        )
        await asyncio.sleep(0.5)

        await event_bus.stop()

        assert mock_provider.call_count == 1
        assert len(responses) >= 1
        assert "Mock response" in responses[0].payload.get("content", "")

    @pytest.mark.asyncio
    async def test_agent_shutdown(self, event_bus, provider_registry):
        """Agent should unsubscribe on shutdown."""
        config = AgentConfig(
            name="shutdown-test",
            provider="mock",
            subscriptions=["a", "b"],
        )
        agent = Agent(config, event_bus, provider_registry)
        await agent.initialize()

        assert event_bus.subscription_count == 2

        await agent.shutdown()

        assert agent.state == AgentState.SHUTDOWN
        assert event_bus.subscription_count == 0

    @pytest.mark.asyncio
    async def test_agent_history_trimming(self, event_bus, provider_registry):
        """Agent should trim history when it exceeds max_history."""
        config = AgentConfig(
            name="history-test",
            provider="mock",
            max_history=5,
            system_prompt="System prompt",
        )
        agent = Agent(config, event_bus, provider_registry)
        await agent.initialize()

        # Send many messages
        for i in range(10):
            await agent.think(f"Message {i}")

        # History should be trimmed: system + recent messages
        assert len(agent.history) <= config.max_history + 2  # Allow some slack


class TestSwarmEngine:
    """Test suite for SwarmEngine."""

    @pytest.mark.asyncio
    async def test_engine_lifecycle(self):
        """Engine should start and stop cleanly."""
        engine = SwarmEngine()
        mock = MockProvider()
        engine.register_provider("mock", provider=mock)
        engine.add_agent(AgentConfig(name="agent1", provider="mock"))

        await engine.start()
        assert engine.is_running

        await engine.stop()
        assert not engine.is_running

    @pytest.mark.asyncio
    async def test_engine_status(self):
        """Engine status should report all components."""
        engine = SwarmEngine()
        mock = MockProvider()
        engine.register_provider("mock", provider=mock)
        engine.add_agent(AgentConfig(name="agent1", provider="mock"))
        engine.add_agent(AgentConfig(name="agent2", provider="mock"))

        await engine.start()
        status = engine.status()

        assert status["running"] is True
        assert len(status["agents"]) == 2
        assert "mock" in status["providers"]

        await engine.stop()

    @pytest.mark.asyncio
    async def test_engine_task_submission(self):
        """Engine should submit tasks and route to agents."""
        engine = SwarmEngine()
        mock = MockProvider()
        engine.register_provider("mock", provider=mock)
        engine.add_agent(
            AgentConfig(
                name="worker",
                provider="mock",
                subscriptions=["task.created"],
            )
        )

        await engine.start()
        task_id = await engine.submit_task("Test task")
        assert task_id

        await asyncio.sleep(0.5)
        assert mock.call_count >= 1

        await engine.stop()

    @pytest.mark.asyncio
    async def test_engine_multiple_agents(self):
        """Multiple agents should all receive broadcast events."""
        engine = SwarmEngine()
        mock = MockProvider()
        engine.register_provider("mock", provider=mock)

        engine.add_agent(
            AgentConfig(name="a1", provider="mock", subscriptions=["task.created"])
        )
        engine.add_agent(
            AgentConfig(name="a2", provider="mock", subscriptions=["task.created"])
        )

        await engine.start()
        await engine.submit_task("Shared task")
        await asyncio.sleep(1)

        # Both agents should have processed the task
        assert mock.call_count >= 2

        await engine.stop()
