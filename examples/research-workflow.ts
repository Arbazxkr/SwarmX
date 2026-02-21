/**
 * Groklets Example — Multi-agent research workflow.
 *
 * This shows the core orchestration concept:
 * 3 agents on different models collaborate through a workflow DAG.
 *
 * Usage:
 *   1. Copy this file to your project
 *   2. Set API keys in .env
 *   3. Run: npx tsx examples/research-workflow.ts
 */

import {
    SwarmEngine,
    WorkflowOrchestrator,
    pipeline,
    fanOutFanIn,
    type AgentExecutor,
} from "groklets";

// ── Setup ──────────────────────────────────────────────────────

const engine = new SwarmEngine();

// Register providers — mix models freely
// (In production, use swarm.yaml config instead)

import { OpenAIProvider } from "groklets/providers";
// engine.registerProvider("gpt4", new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: "gpt-4o" }));
// engine.registerProvider("claude", new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: "claude-sonnet-4-20250514" }));

// For this example, we use a mock executor
const mockExecutor: AgentExecutor = async (agent, input) => {
    console.log(`\n  [${agent}] received: "${input.slice(0, 60)}..."`);
    // In production, this calls engine.agentToAgent() or provider.complete()
    return `[${agent} response] Processed: ${input.slice(0, 40)}`;
};

// ── Example 1: Linear Pipeline ─────────────────────────────────

console.log("\n═══ Example 1: Linear Pipeline ═══");
console.log("  researcher → writer → editor\n");

const researchPipeline = pipeline("Research Pipeline", [
    { id: "research", agent: "researcher", prompt: "Research the topic: AI agent orchestration frameworks" },
    { id: "write", agent: "writer", prompt: "Write a blog post based on this research" },
    { id: "edit", agent: "editor", prompt: "Edit and polish this blog post for publication" },
]);

const orchestrator = new WorkflowOrchestrator(mockExecutor);
const run1 = await orchestrator.run(researchPipeline);

console.log(`\n  Status: ${run1.status}`);
console.log(`  Steps: ${run1.results.size}`);
console.log(`  Final output: ${run1.blackboard.get("edit")?.toString().slice(0, 60)}`);

// ── Example 2: Fan-out / Fan-in ────────────────────────────────

console.log("\n\n═══ Example 2: Fan-out / Fan-in ═══");
console.log("  3 analysts work in parallel → synthesizer merges\n");

const analysisWorkflow = fanOutFanIn(
    "Multi-Angle Analysis",
    "Analyze the impact of AI on software development",
    [
        { id: "technical", agent: "tech-analyst", prompt: "Analyze from a technical perspective" },
        { id: "business", agent: "business-analyst", prompt: "Analyze from a business perspective" },
        { id: "social", agent: "social-analyst", prompt: "Analyze from a social impact perspective" },
    ],
    { id: "synthesis", agent: "synthesizer", prompt: "Combine all perspectives into a unified report" },
);

const run2 = await orchestrator.run(analysisWorkflow);

console.log(`\n  Status: ${run2.status}`);
console.log(`  Steps: ${run2.results.size}`);
console.log(`  Blackboard keys: ${run2.blackboard.keys().join(", ")}`);

// ── Example 3: Conditional Workflow ────────────────────────────

console.log("\n\n═══ Example 3: Conditional Workflow ═══");
console.log("  classify → (if code) → code-review → output\n");
console.log("  classify → (if text) → text-review → output\n");

const conditionalWorkflow = {
    name: "Conditional Review",
    steps: [
        {
            id: "classify",
            agent: "classifier",
            input: "Classify this content: function hello() { return 'world'; }",
            outputKey: "type",
        },
        {
            id: "code-review",
            agent: "code-reviewer",
            input: "Review this code: {{blackboard.type}}",
            dependsOn: ["classify"],
            condition: (bb: any) => String(bb.get("type")).includes("code"),
        },
        {
            id: "text-review",
            agent: "text-reviewer",
            input: "Review this text: {{blackboard.type}}",
            dependsOn: ["classify"],
            condition: (bb: any) => !String(bb.get("type")).includes("code"),
        },
        {
            id: "output",
            agent: "formatter",
            input: "Format the final review: {{blackboard.code-review}}{{blackboard.text-review}}",
            dependsOn: ["code-review", "text-review"],
        },
    ],
};

const run3 = await orchestrator.run(conditionalWorkflow);

console.log(`\n  Status: ${run3.status}`);
for (const [id, result] of run3.results) {
    console.log(`  ${id}: ${result.status} (${result.duration}ms)`);
}

// ── Summary ────────────────────────────────────────────────────

console.log("\n\n═══ Summary ═══");
console.log("  Groklets orchestration patterns:");
console.log("  • pipeline()     — A → B → C (sequential handoff)");
console.log("  • fanOutFanIn()  — [A, B, C] → D (parallel + merge)");
console.log("  • conditional    — if/else branching based on agent output");
console.log("  • blackboard     — shared state between all agents");
console.log("  • retries        — per-step retry with backoff");
console.log("  • timeouts       — per-step and per-workflow");
console.log("  • tracing        — events emitted for every step\n");
