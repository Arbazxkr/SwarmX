# Tracing

Built-in tracing for debugging, replaying, and optimizing agent runs.

## Usage

```typescript
import { Tracer } from "groklets";

const tracer = new Tracer({ autoSave: true, outputDir: ".groklets/traces" });

// Start a trace
const traceId = tracer.startTrace("user-query", { query: "What is AI?" });

// Add spans for each step
const agentSpan = tracer.startSpan(traceId, "agent-research", "agent");
// ... agent does work ...
tracer.endSpan(agentSpan, "success");

const toolSpan = tracer.startSpan(traceId, "web-search", "tool", { url: "https://..." });
tracer.addEvent(toolSpan, "fetched", { bytes: 5000 });
tracer.endSpan(toolSpan, "success");

// End trace
tracer.endTrace(traceId, "success");

// View results
console.log(tracer.summary());
```

## Export

```typescript
// Export as JSON
const json = tracer.toJSON(traceId);

// Save to disk
tracer.saveTrace(traceId);

// View recent traces
const recent = tracer.getRecentTraces(10);
```

## Global Tracer

A global tracer instance is available:

```typescript
import { globalTracer } from "groklets";
globalTracer.startTrace("my-workflow");
```

## Trace Structure

```
Trace
├── rootSpan (agent)
│   ├── child span (tool: web-search)
│   │   └── events: [fetched, parsed]
│   ├── child span (provider: openai)
│   └── child span (guardrail: pii-check)
```
