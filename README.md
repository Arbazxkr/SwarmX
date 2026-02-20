# ⚛ SwarmX

**A model-agnostic, async, event-driven multi-agent orchestration framework for developers.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)

---

## Overview

SwarmX is a lightweight framework for orchestrating multiple AI agents that communicate through an event-driven architecture. It is:

- **Model-agnostic** — Supports OpenAI, Anthropic/Claude, Google/Gemini, and xAI/Grok out of the box
- **Async & event-driven** — Non-blocking event bus with topic-based pub/sub
- **Local-first** — Runs entirely on your machine, no cloud orchestration required
- **CLI-first** — Full-featured CLI for managing swarms from the terminal
- **Config-driven** — Define your entire swarm in a single YAML file
- **TypeScript-first** — Written in TypeScript with full type safety
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

# Install dependencies
npm install

# Build
npm run build
```

### Create a Swarm

```bash
# Initialize a new swarm project
npx tsx src/cli/main.ts init --name my-swarm --provider openai

# Set your API key
export OPENAI_API_KEY=your-key-here

# Run the swarm
npx tsx src/cli/main.ts run my-swarm.yaml --interactive
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

```typescript
import { SwarmEngine } from "swarmx";
import { OpenAIProvider } from "swarmx/providers";

const engine = new SwarmEngine();

// Register a provider
const openai = new OpenAIProvider({ apiKey: "your-key", model: "gpt-4o" });
engine.registerProvider("openai", openai);

// Add agents
engine.addAgent({
  name: "assistant",
  provider: "openai",
  systemPrompt: "You are a helpful assistant.",
  subscriptions: ["task.created"],
});

// Run
await engine.start();
await engine.submitTask("What is the meaning of life?");
await new Promise((r) => setTimeout(r, 5000));
await engine.stop();
```

### Custom Agents

```typescript
import { Agent, type AgentConfig } from "swarmx";
import { type SwarmEvent } from "swarmx";

class MyAgent extends Agent {
  async onEvent(event: SwarmEvent): Promise<void> {
    if (event.topic === "analysis.request") {
      const result = await this.think(event.payload.content as string);
      await this.emit("analysis.complete", {
        result: result?.message.content,
      });
    }
  }
}

// Use in engine
engine.addAgent(config, MyAgent);
```

## Supported Providers

| Provider | Package | Models |
|----------|---------|--------|
| **OpenAI** | `openai` | GPT-4o, GPT-4, GPT-3.5-turbo |
| **Anthropic** | `@anthropic-ai/sdk` | Claude 3.5 Sonnet, Claude 3 Opus/Haiku |
| **Google** | `@google/genai` | Gemini 2.0 Flash, Gemini 1.5 Pro |
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
├── src/
│   ├── index.ts                 # Package root & public API
│   ├── core/
│   │   ├── agent.ts             # Agent base class & lifecycle
│   │   ├── engine.ts            # Core orchestration engine
│   │   ├── event-bus.ts         # Async event bus with pub/sub
│   │   ├── provider.ts          # Provider abstraction layer
│   │   └── scheduler.ts         # Task scheduling & dependencies
│   ├── providers/
│   │   ├── index.ts             # Provider barrel export
│   │   ├── openai-provider.ts   # OpenAI adapter
│   │   ├── anthropic-provider.ts # Anthropic/Claude adapter
│   │   ├── google-provider.ts   # Google/Gemini adapter
│   │   └── xai-provider.ts      # xAI/Grok adapter
│   ├── cli/
│   │   └── main.ts              # CLI entry point (Commander + chalk)
│   └── utils/
│       └── config.ts            # YAML config loader
├── tests/
│   ├── event-bus.test.ts        # Event bus tests
│   ├── agent-engine.test.ts     # Agent & engine tests
│   └── scheduler.test.ts        # Scheduler tests
├── examples/
│   ├── research_team.yaml       # Multi-agent research team
│   ├── multi_provider.yaml      # Multi-provider swarm
│   └── programmatic-usage.ts    # Programmatic API example
├── package.json                 # Dependencies & scripts
├── tsconfig.json                # TypeScript config
├── vitest.config.ts             # Test config
├── LICENSE                      # MIT license with attribution
├── README.md                    # This file
└── .gitignore
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Type check
npm run typecheck

# Run CLI in dev mode
npx tsx src/cli/main.ts --help
```

## Attribution

SwarmX draws architectural inspiration from the [OpenClaw](https://github.com/openclaw/openclaw) project (MIT License), specifically:

- **Gateway → Engine pattern** — Central control plane for routing and coordination
- **Channel adapters → Provider adapters** — Pluggable integration layer
- **Multi-agent routing** — Isolated agents with declarative bindings
- **Event-driven architecture** — WebSocket event patterns → async event bus
- **Config-driven setup** — Declarative YAML-based definitions
- **TypeScript-first** — Same language choice as the original

## License

MIT License. See [LICENSE](LICENSE) for details.
