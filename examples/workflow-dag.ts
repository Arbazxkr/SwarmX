/**
 * Example: Workflow with DAG execution.
 *
 * Shows how to build a multi-step workflow where:
 *   - Steps run in sequence or parallel
 *   - Steps can depend on each other
 *   - Results flow through a shared Blackboard
 *
 * Usage:
 *   npx tsx examples/workflow-dag.ts
 */

import { WorkflowOrchestrator, Blackboard, pipeline, fanOutFanIn } from "../src/index.js";

async function main() {
    const orchestrator = new WorkflowOrchestrator();

    // Simple pipeline: research → analyze → write
    const result = await orchestrator.run(
        pipeline("content-pipeline", [
            {
                id: "research",
                name: "Research",
                execute: async () => ({
                    output: "Quantum computing uses qubits that can be 0, 1, or both simultaneously.",
                }),
            },
            {
                id: "analyze",
                name: "Analyze",
                dependsOn: ["research"],
                execute: async (_bb, inputs) => ({
                    output: `Key insight from research: ${inputs?.research?.output}. This enables exponential speedup.`,
                }),
            },
            {
                id: "write",
                name: "Write Report",
                dependsOn: ["analyze"],
                execute: async (_bb, inputs) => ({
                    output: `## Report\n\n${inputs?.analyze?.output}\n\nConclusion: Quantum computing will revolutionize cryptography.`,
                }),
            },
        ]),
    );

    console.log("Pipeline result:", result.results.get("write")?.output);
    console.log(`Duration: ${result.durationMs}ms`);

    // Fan-out/fan-in: run 3 analyses in parallel, then combine
    const parallelResult = await orchestrator.run(
        fanOutFanIn("parallel-analysis", {
            fanOut: [
                {
                    id: "market",
                    name: "Market Analysis",
                    execute: async () => ({ output: "Market growing 25% YoY" }),
                },
                {
                    id: "tech",
                    name: "Tech Analysis",
                    execute: async () => ({ output: "Technology maturing rapidly" }),
                },
                {
                    id: "risk",
                    name: "Risk Analysis",
                    execute: async () => ({ output: "Regulatory risks present" }),
                },
            ],
            fanIn: {
                id: "combine",
                name: "Combine Results",
                execute: async (_bb, inputs) => ({
                    output: Object.entries(inputs ?? {})
                        .map(([k, v]) => `${k}: ${(v as { output: string }).output}`)
                        .join("\n"),
                }),
            },
        }),
    );

    console.log("\nParallel result:", parallelResult.results.get("combine")?.output);
    console.log(`Duration: ${parallelResult.durationMs}ms`);
}

main().catch(console.error);
