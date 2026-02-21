# Workflows

Build complex multi-step AI workflows with DAG execution.

## Pipeline (Sequential)

Steps run one after another:

```typescript
import { WorkflowOrchestrator, pipeline } from "groklets";

const orchestrator = new WorkflowOrchestrator();

const result = await orchestrator.run(
    pipeline("research-pipeline", [
        {
            id: "research",
            name: "Research",
            execute: async () => ({
                output: "Key findings about quantum computing...",
            }),
        },
        {
            id: "write",
            name: "Write Report",
            dependsOn: ["research"],
            execute: async (_bb, inputs) => ({
                output: `Report: ${inputs?.research?.output}`,
            }),
        },
    ]),
);
```

## Fan-Out/Fan-In (Parallel)

Multiple steps run in parallel, then results combine:

```typescript
import { fanOutFanIn } from "groklets";

const result = await orchestrator.run(
    fanOutFanIn("analysis", {
        fanOut: [
            { id: "market", name: "Market", execute: async () => ({ output: "Growing" }) },
            { id: "tech", name: "Tech", execute: async () => ({ output: "Maturing" }) },
            { id: "risk", name: "Risk", execute: async () => ({ output: "Low" }) },
        ],
        fanIn: {
            id: "combine",
            name: "Combine",
            execute: async (_bb, inputs) => ({
                output: JSON.stringify(inputs),
            }),
        },
    }),
);
```

## Features

- **Dependency resolution** — Steps only run when dependencies are complete
- **Parallel execution** — Independent steps run simultaneously
- **Retry logic** — Failed steps retry with configurable backoff
- **Timeouts** — Per-step timeout limits
- **Conditional execution** — Steps can have `condition` functions
- **Blackboard** — Shared state between steps
- **Custom output keys** — Route outputs to specific blackboard keys
