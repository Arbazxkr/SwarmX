# 🐝 SwarmX

**A model-agnostic, async, event-driven multi-agent orchestration framework for developers.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.11+](https://img.shields.io/badge/Python-3.11+-blue.svg)](https://www.python.org/downloads/)

---

## Overview

SwarmX is a lightweight framework for orchestrating multiple AI agents that communicate through an event-driven architecture. It is:

- **Model-agnostic** — Supports OpenAI, Anthropic/Claude, Google/Gemini, and xAI/Grok out of the box
- **Async & event-driven** — Non-blocking event bus with topic-based pub/sub
- **Local-first** — Runs entirely on your machine, no cloud orchestration required
- **CLI-first** — Full-featured CLI for managing swarms from the terminal
- **Config-driven** — Define your entire swarm in a single YAML file
- **Developer-focused** — Clean APIs, comprehensive types, and minimal dependencies

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  SwarmX Engine                     │
│                 (Orchestrator)                     │
├──────────────────────────────────────────────────┤
│                                                    │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│   │ Agent A  │  │ Agent B  │  │ Agent C  │       │
│   │(OpenAI)  │  │(Claude)  │  │(Gemini)  │       │
│   └────┬─────┘  └────┬─────┘  └────┬─────┘       │
│        │              │              │              │
│        ▼              ▼              ▼              │
│   ┌─────────────────────────────────────────┐     │
│   │            Event Bus                     │     │
│   │  (Topic-based pub/sub, non-blocking)     │     │
│   └─────────────────────────────────────────┘     │
│        │                                           │
│        ▼                                           │
│   ┌──────────────┐   ┌───────────────────┐        │
│   │Task Scheduler│   │Provider Registry  │        │
│   └──────────────┘   └───────────────────┘        │
│                                                    │
├──────────────────────────────────────────────────┤
│            Provider Abstraction Layer              │
│  ┌────────┐ ┌─────────┐ ┌────────┐ ┌─────────┐  │
│  │ OpenAI │ │Anthropic│ │ Google │ │   xAI   │  │
│  └────────┘ └─────────┘ └────────┘ └─────────┘  │
└──────────────────────────────────────────────────┘
```

### Core Principles

1. **No direct agent-to-agent calls** — Agents communicate exclusively through the event bus
2. **Provider independence** — The core engine has zero dependency on any specific LLM vendor
3. **Declarative binding** — Agents bind to providers via config, not code
4. **Non-blocking events** — All event dispatch is async with error isolation
5. **Clean lifecycle** — Agents follow: `initialize → process → shutdown`

## Quick Start

### Installation

```bash
# Clone the repository
git clone https://github.com/swarmx/swarmx.git
cd swarmx

# Install in development mode
pip install -e ".[dev]"
```

### Create a Swarm

```bash
# Initialize a new swarm project
swarmx init --name my-swarm --provider openai

# Set your API key
export OPENAI_API_KEY=your-key-here

# Run the swarm
swarmx run my-swarm.yaml --interactive
```

### CLI Commands

```bash
swarmx run <config.yaml>          # Run a swarm
swarmx run <config.yaml> -i       # Run in interactive mode
swarmx run <config.yaml> -t "..."  # Run with an initial task
swarmx validate <config.yaml>     # Validate a config file
swarmx status <config.yaml>       # Show swarm configuration
swarmx init --name <name>         # Scaffold a new swarm project
```

## Configuration

Swarms are defined in YAML:

```yaml
swarm:
  name: "Research Team"

  providers:
    openai:
      type: openai
      api_key: ${OPENAI_API_KEY}
      model: gpt-4o
      temperature: 0.7

    anthropic:
      type: anthropic
      api_key: ${ANTHROPIC_API_KEY}
      model: claude-sonnet-4-20250514

  agents:
    coordinator:
      provider: openai
      system_prompt: |
        You are the coordinator. You break down tasks
        and synthesize agent responses.
      subscriptions:
        - task.created
        - agent.response.*

    researcher:
      provider: anthropic
      system_prompt: |
        You are a research agent. Provide in-depth analysis.
      subscriptions:
        - task.created
        - research.*
```

### Environment Variables

API keys can reference environment variables with `${VAR_NAME}` syntax:

```yaml
api_key: ${OPENAI_API_KEY}
```

## Programmatic API

```python
import asyncio
from swarmx import Agent, AgentConfig, SwarmEngine
from swarmx.core.provider import ProviderConfig

async def main():
    engine = SwarmEngine()

    # Register a provider
    engine.register_provider("openai", config=ProviderConfig(
        api_key="your-key",
        model="gpt-4o",
    ))

    # Add agents
    engine.add_agent(AgentConfig(
        name="assistant",
        provider="openai",
        system_prompt="You are a helpful assistant.",
        subscriptions=["task.created"],
    ))

    # Run
    await engine.start()
    await engine.submit_task("What is the meaning of life?")
    await asyncio.sleep(5)
    await engine.stop()

asyncio.run(main())
```

### Custom Agents

```python
from swarmx import Agent
from swarmx.core.event_bus import Event

class MyAgent(Agent):
    async def on_event(self, event: Event) -> None:
        # Custom event handling logic
        if event.topic == "analysis.request":
            result = await self.think(event.payload["content"])
            await self.emit("analysis.complete", {
                "result": result.message.content,
            })

# Use in engine
engine.add_agent(config, agent_class=MyAgent)
```

## Supported Providers

| Provider | Package | Models |
|----------|---------|--------|
| **OpenAI** | `openai` | GPT-4o, GPT-4, GPT-3.5-turbo |
| **Anthropic** | `anthropic` | Claude 3.5 Sonnet, Claude 3 Opus/Haiku |
| **Google** | `google-genai` | Gemini 2.0 Flash, Gemini 1.5 Pro |
| **xAI** | `openai` (compatible) | Grok-2, Grok-1 |

## Event System

The event bus supports topic-based routing with wildcards:

```
task.created        → exact match
task.*              → matches task.created, task.completed, etc.
agent.response.*    → matches any agent response
*                   → global listener (receives everything)
```

Events are processed asynchronously with error isolation — a failing handler never blocks other handlers.

## Project Structure

```
SwarmX/
├── swarmx/
│   ├── __init__.py              # Package root & public API
│   ├── core/
│   │   ├── agent.py             # Agent base class & lifecycle
│   │   ├── engine.py            # Core orchestration engine
│   │   ├── event_bus.py         # Async event bus with pub/sub
│   │   ├── provider.py          # Provider abstraction layer
│   │   └── scheduler.py         # Task scheduling & dependencies
│   ├── providers/
│   │   ├── openai_provider.py   # OpenAI adapter
│   │   ├── anthropic_provider.py # Anthropic/Claude adapter
│   │   ├── google_provider.py   # Google/Gemini adapter
│   │   └── xai_provider.py      # xAI/Grok adapter
│   ├── cli/
│   │   └── main.py              # CLI entry point (Click + Rich)
│   └── utils/
│       ├── config.py            # YAML config loader
│       └── logging.py           # Rich logging setup
├── tests/
│   ├── test_event_bus.py        # Event bus tests
│   ├── test_agent_engine.py     # Agent & engine tests
│   ├── test_scheduler.py        # Scheduler tests
│   └── test_config.py           # Config loader tests
├── examples/
│   ├── research_team.yaml       # Multi-agent research team
│   ├── multi_provider.yaml      # Multi-provider swarm
│   └── programmatic_usage.py    # Programmatic API example
├── pyproject.toml               # Build config & dependencies
├── LICENSE                      # MIT license with attribution
├── README.md                    # This file
└── .gitignore
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Run with verbose output
pytest -v

# Lint
ruff check .

# Type check
mypy swarmx/
```

## Attribution

SwarmX draws architectural inspiration from the [OpenClaw](https://github.com/openclaw/openclaw) project (MIT License), specifically:

- **Gateway → Engine pattern** — Central control plane for routing and coordination
- **Channel adapters → Provider adapters** — Pluggable integration layer
- **Multi-agent routing** — Isolated agents with declarative bindings
- **Event-driven architecture** — WebSocket event patterns → async event bus
- **Config-driven setup** — Declarative YAML-based definitions

All adapted code has been reimplemented in Python for the multi-agent orchestration domain. See [LICENSE](LICENSE) for full details.

## License

MIT License. See [LICENSE](LICENSE) for details.
