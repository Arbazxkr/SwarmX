# Quick Start

Get a multi-agent system running in 5 minutes.

## 1. Install

```bash
npm install groklets
```

## 2. Create your first agents

```typescript
import { SwarmEngine } from "groklets";
import { OpenAIProvider } from "groklets/providers";

// Create the engine
const engine = new SwarmEngine();

// Register a provider (BYOK)
engine.registerProvider("openai", new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: "gpt-4o-mini",
}));

// Add a researcher agent
engine.addAgent({
    name: "researcher",
    provider: "openai",
    systemPrompt: "You are a research assistant. Find key facts about any topic.",
    topics: ["task.created"],
});

// Add a writer agent that picks up research results
engine.addAgent({
    name: "writer",
    provider: "openai",
    systemPrompt: "Take research findings and write clear, engaging summaries.",
    topics: ["agent.response.researcher"],
});

// Start and submit a task
await engine.start();
await engine.submitTask("What are the latest trends in AI?");

// Wait for processing
await new Promise(r => setTimeout(r, 10000));
await engine.stop();
```

## 3. Run it

```bash
OPENAI_API_KEY=sk-xxx npx tsx your-script.ts
```

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Engine** | The orchestrator that manages everything |
| **Provider** | An LLM backend (OpenAI, Claude, Gemini, xAI) |
| **Agent** | An AI agent with a specific role and system prompt |
| **Event Bus** | Routes messages between agents via pub/sub |
| **Workflow** | DAG-based multi-step execution |
| **Channel** | External messaging platform (WhatsApp, Discord, etc.) |

## Next Steps

- [Providers](./providers.md) — Connect multiple AI models
- [Workflows](./workflows.md) — Build DAG pipelines
- [Guardrails](./guardrails.md) — Add safety checks
- [Channels](./channels.md) — Connect to messaging platforms
