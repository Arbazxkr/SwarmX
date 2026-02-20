"""
SwarmX Example — Programmatic API Usage

Demonstrates how to use SwarmX programmatically (without YAML configs).
This is useful for embedding SwarmX in larger applications.
"""

import asyncio

from swarmx import Agent, AgentConfig, SwarmEngine
from swarmx.core.event_bus import Event
from swarmx.core.provider import ProviderConfig


class LoggingAgent(Agent):
    """
    Custom agent that logs all events it receives.
    Demonstrates how to subclass Agent for custom behavior.
    """

    async def on_event(self, event: Event) -> None:
        """Override default event handling with custom logic."""
        print(f"[{self.agent_id}] Received event: {event.topic}")
        print(f"  Payload: {event.payload}")

        # Still call the parent handler for LLM processing
        await super().on_event(event)


async def main() -> None:
    """Run a simple swarm programmatically."""
    # Create the engine
    engine = SwarmEngine()

    # Register a provider
    engine.register_provider(
        "openai",
        config=ProviderConfig(
            api_key="your-api-key-here",  # Use env var in production
            model="gpt-4o",
        ),
    )

    # Add agents
    engine.add_agent(
        AgentConfig(
            name="assistant",
            provider="openai",
            system_prompt="You are a helpful assistant. Be concise.",
            subscriptions=["task.created"],
        )
    )

    # Add a custom logging agent
    engine.add_agent(
        AgentConfig(
            name="logger",
            provider="openai",
            system_prompt="You are an observer. Summarize what you see.",
            subscriptions=["agent.response.*"],
        ),
        agent_class=LoggingAgent,
    )

    # Start the engine
    await engine.start()
    print("Engine started!")
    print(f"Status: {engine.status()}")

    # Submit a task
    task_id = await engine.submit_task("What are the top 3 benefits of async programming?")
    print(f"Task submitted: {task_id}")

    # Wait for processing
    await asyncio.sleep(5)

    # Check events
    events = engine.event_bus.recent_events(10)
    for event in events:
        if event.topic.startswith("agent.response"):
            print(f"\nResponse from {event.payload.get('agent_id')}:")
            print(event.payload.get("content", ""))

    # Shutdown
    await engine.stop()
    print("\nEngine stopped.")


if __name__ == "__main__":
    asyncio.run(main())
