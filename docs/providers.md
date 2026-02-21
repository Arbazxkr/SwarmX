# Providers

Groklets supports multiple AI model providers out of the box. Use one or mix them with failover.

## Supported Providers

| Provider | Models | Import |
|----------|--------|--------|
| **OpenAI** | GPT-4o, GPT-4o-mini, o1, etc. | `OpenAIProvider` |
| **Anthropic** | Claude 3.5 Sonnet, Claude 3 Opus, etc. | `AnthropicProvider` |
| **Google** | Gemini 2.0, Gemini 1.5 Pro, etc. | `GoogleProvider` |
| **xAI** | Grok-2, Grok-beta, etc. | `XAIProvider` |
| **Any OpenAI-compatible** | Local models, Ollama, Together, etc. | `OpenAIProvider` with custom `baseUrl` |

## Usage

```typescript
import { SwarmEngine } from "groklets";
import { OpenAIProvider, AnthropicProvider, GoogleProvider, XAIProvider } from "groklets/providers";

const engine = new SwarmEngine();

// OpenAI
engine.registerProvider("openai", new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: "gpt-4o-mini",
}));

// Anthropic (Claude)
engine.registerProvider("claude", new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: "claude-3-5-sonnet-20241022",
}));

// Google (Gemini)
engine.registerProvider("gemini", new GoogleProvider({
    apiKey: process.env.GOOGLE_API_KEY!,
    model: "gemini-2.0-flash",
}));

// xAI (Grok)
engine.registerProvider("grok", new XAIProvider({
    apiKey: process.env.XAI_API_KEY!,
    model: "grok-2",
}));
```

## OpenAI-Compatible Providers

Use any OpenAI-compatible API (Ollama, Together, Groq, etc.):

```typescript
engine.registerProvider("local", new OpenAIProvider({
    apiKey: "ollama",
    model: "llama3.2",
    baseUrl: "http://localhost:11434/v1",
}));
```

## Failover

Configure automatic failover between providers:

```typescript
// Register multiple providers
engine.registerProvider("primary", new OpenAIProvider({ ... }));
engine.registerProvider("backup", new AnthropicProvider({ ... }));

// Create failover chain
engine.registerFailover("resilient", ["primary", "backup"], {
    maxRetries: 3,
    retryDelayMs: 1000,
});

// Use the failover provider
engine.addAgent({
    name: "assistant",
    provider: "resilient",  // Falls back automatically!
    systemPrompt: "...",
    topics: ["task.created"],
});
```
