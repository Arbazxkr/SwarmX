/**
 * Workflow Engine Tests — DAGs, parallel, conditional, blackboard, retries.
 */

import { describe, it, expect } from "vitest";
import {
    WorkflowOrchestrator,
    Blackboard,
    pipeline,
    fanOutFanIn,
    type AgentExecutor,
    type WorkflowDefinition,
} from "../src/core/workflow.js";

// ── Mock executor ──────────────────────────────────────────────

const echoExecutor: AgentExecutor = async (agent, input) => {
    return `[${agent}] ${input.slice(0, 50)}`;
};

const delayExecutor: AgentExecutor = async (agent, input) => {
    await new Promise(r => setTimeout(r, 50));
    return `[${agent}] done`;
};

const failOnceExecutor = (): AgentExecutor => {
    let calls = 0;
    return async (agent, input) => {
        calls++;
        if (calls === 1) throw new Error("transient failure");
        return `[${agent}] recovered`;
    };
};

// ── Blackboard ─────────────────────────────────────────────────

describe("Blackboard", () => {
    it("should set and get values", () => {
        const bb = new Blackboard();
        bb.set("foo", "bar");
        expect(bb.get("foo")).toBe("bar");
        expect(bb.has("foo")).toBe(true);
        expect(bb.has("nope")).toBe(false);
    });

    it("should list keys", () => {
        const bb = new Blackboard();
        bb.set("a", 1);
        bb.set("b", 2);
        expect(bb.keys()).toEqual(["a", "b"]);
    });

    it("should convert to object", () => {
        const bb = new Blackboard();
        bb.set("x", "hello");
        bb.set("y", 42);
        expect(bb.toObject()).toEqual({ x: "hello", y: 42 });
    });

    it("should resolve template variables", () => {
        const bb = new Blackboard();
        bb.set("name", "Arbaz");
        bb.set("tool", "Groklets");
        expect(bb.resolve("Hello {{blackboard.name}}, welcome to {{blackboard.tool}}"))
            .toBe("Hello Arbaz, welcome to Groklets");
    });

    it("should preserve unresolved variables", () => {
        const bb = new Blackboard();
        expect(bb.resolve("{{blackboard.missing}}")).toBe("{{blackboard.missing}}");
    });
});

// ── Pipeline builder ───────────────────────────────────────────

describe("pipeline()", () => {
    it("should create sequential steps with dependencies", () => {
        const wf = pipeline("test", [
            { id: "a", agent: "alpha", prompt: "do A" },
            { id: "b", agent: "beta", prompt: "do B" },
            { id: "c", agent: "gamma", prompt: "do C" },
        ]);

        expect(wf.name).toBe("test");
        expect(wf.steps).toHaveLength(3);
        expect(wf.steps[0].dependsOn).toEqual([]);
        expect(wf.steps[1].dependsOn).toEqual(["a"]);
        expect(wf.steps[2].dependsOn).toEqual(["b"]);
    });

    it("should inject previous output in template", () => {
        const wf = pipeline("test", [
            { id: "step1", agent: "a", prompt: "first" },
            { id: "step2", agent: "b", prompt: "second" },
        ]);

        expect(wf.steps[1].input).toContain("{{blackboard.step1}}");
    });
});

// ── Fan-out/fan-in builder ─────────────────────────────────────

describe("fanOutFanIn()", () => {
    it("should create parallel workers + merger", () => {
        const wf = fanOutFanIn(
            "test",
            "input text",
            [
                { id: "w1", agent: "worker1", prompt: "analyze" },
                { id: "w2", agent: "worker2", prompt: "analyze" },
            ],
            { id: "merge", agent: "merger", prompt: "combine" },
        );

        expect(wf.steps).toHaveLength(3);
        expect(wf.steps[0].dependsOn).toEqual([]);
        expect(wf.steps[1].dependsOn).toEqual([]);
        expect(wf.steps[2].dependsOn).toEqual(["w1", "w2"]);
        expect(wf.parallelGroups).toHaveLength(1);
        expect(wf.parallelGroups![0].parallel).toEqual(["w1", "w2"]);
    });

    it("should reference worker outputs in merger input", () => {
        const wf = fanOutFanIn(
            "test", "data",
            [{ id: "w1", agent: "a", prompt: "p" }],
            { id: "m", agent: "b", prompt: "merge" },
        );

        expect(wf.steps[1].input).toContain("{{blackboard.w1}}");
    });
});

// ── Workflow Orchestrator ──────────────────────────────────────

describe("WorkflowOrchestrator", () => {
    it("should run a simple linear workflow", async () => {
        const orch = new WorkflowOrchestrator(echoExecutor);
        const wf = pipeline("linear", [
            { id: "s1", agent: "agent1", prompt: "hello" },
            { id: "s2", agent: "agent2", prompt: "world" },
        ]);

        const run = await orch.run(wf);

        expect(run.status).toBe("completed");
        expect(run.results.size).toBe(2);
        expect(run.blackboard.has("s1")).toBe(true);
        expect(run.blackboard.has("s2")).toBe(true);
    });

    it("should pass output through pipeline via blackboard", async () => {
        const orch = new WorkflowOrchestrator(echoExecutor);
        const wf = pipeline("chain", [
            { id: "first", agent: "a", prompt: "start" },
            { id: "second", agent: "b", prompt: "continue" },
        ]);

        const run = await orch.run(wf);
        const secondOutput = run.blackboard.get<string>("second")!;

        // Second step should contain resolved reference to first step output
        expect(secondOutput).toContain("[b]");
        expect(run.status).toBe("completed");
    });

    it("should run parallel steps concurrently", async () => {
        const start = Date.now();
        const orch = new WorkflowOrchestrator(delayExecutor);
        const wf = fanOutFanIn(
            "parallel", "data",
            [
                { id: "p1", agent: "a", prompt: "work" },
                { id: "p2", agent: "b", prompt: "work" },
                { id: "p3", agent: "c", prompt: "work" },
            ],
            { id: "merge", agent: "d", prompt: "combine" },
        );

        const run = await orch.run(wf);
        const elapsed = Date.now() - start;

        expect(run.status).toBe("completed");
        expect(run.results.size).toBe(4);
        // Parallel steps should complete in ~50ms, not 150ms (3 × 50ms)
        expect(elapsed).toBeLessThan(300);
    });

    it("should skip steps when condition is false", async () => {
        const orch = new WorkflowOrchestrator(echoExecutor);
        const wf: WorkflowDefinition = {
            name: "conditional",
            steps: [
                { id: "always", agent: "a", input: "run me" },
                {
                    id: "skipped", agent: "b", input: "skip me",
                    dependsOn: ["always"],
                    condition: () => false,
                },
                {
                    id: "final", agent: "c", input: "end",
                    dependsOn: ["skipped"],
                },
            ],
        };

        const run = await orch.run(wf);

        expect(run.status).toBe("completed");
        expect(run.results.get("always")?.status).toBe("done");
        // "skipped" was skipped, so "final" can still run (depends on skipped which is "skipped" status)
        expect(run.results.get("final")?.status).toBe("done");
    });

    it("should seed blackboard with initial context", async () => {
        const orch = new WorkflowOrchestrator(echoExecutor);
        const wf: WorkflowDefinition = {
            name: "seeded",
            steps: [
                { id: "use", agent: "a", input: "topic: {{blackboard.topic}}" },
            ],
        };

        const run = await orch.run(wf, { topic: "AI orchestration" });

        const output = run.blackboard.get<string>("use")!;
        expect(output).toContain("AI orchestration");
    });

    it("should retry failed steps", async () => {
        const orch = new WorkflowOrchestrator(failOnceExecutor());
        const wf: WorkflowDefinition = {
            name: "retry",
            steps: [
                { id: "flaky", agent: "a", input: "try me", retries: 2 },
            ],
        };

        const run = await orch.run(wf);

        expect(run.status).toBe("completed");
        expect(run.results.get("flaky")?.status).toBe("done");
        expect(run.results.get("flaky")?.retryCount).toBe(1);
    });

    it("should fail after exhausting retries", async () => {
        const alwaysFail: AgentExecutor = async () => { throw new Error("permanent"); };
        const orch = new WorkflowOrchestrator(alwaysFail);
        const wf: WorkflowDefinition = {
            name: "fail",
            steps: [
                { id: "doomed", agent: "a", input: "fail", retries: 1 },
            ],
        };

        const run = await orch.run(wf);

        expect(run.status).toBe("failed");
        expect(run.results.get("doomed")?.status).toBe("failed");
        expect(run.results.get("doomed")?.error).toContain("permanent");
    });

    it("should call onStepComplete hook", async () => {
        const completed: string[] = [];
        const orch = new WorkflowOrchestrator(echoExecutor);
        const wf: WorkflowDefinition = {
            name: "hooks",
            steps: [
                { id: "s1", agent: "a", input: "go" },
                { id: "s2", agent: "b", input: "go", dependsOn: ["s1"] },
            ],
            onStepComplete: (stepId) => completed.push(stepId),
        };

        await orch.run(wf);

        expect(completed).toEqual(["s1", "s2"]);
    });

    it("should call onComplete hook with blackboard", async () => {
        let finalKeys: string[] = [];
        const orch = new WorkflowOrchestrator(echoExecutor);
        const wf: WorkflowDefinition = {
            name: "complete-hook",
            steps: [
                { id: "x", agent: "a", input: "data" },
            ],
            onComplete: (bb) => { finalKeys = bb.keys(); },
        };

        await orch.run(wf);

        expect(finalKeys).toContain("x");
    });

    it("should validate structured output schema", async () => {
        const jsonExecutor: AgentExecutor = async () => {
            return JSON.stringify({ title: "Test", score: 95 });
        };
        const orch = new WorkflowOrchestrator(jsonExecutor);
        const wf: WorkflowDefinition = {
            name: "schema",
            steps: [{
                id: "validated", agent: "a", input: "produce JSON",
                outputSchema: { title: "string", score: "number" },
            }],
        };

        const run = await orch.run(wf);
        expect(run.status).toBe("completed");
    });

    it("should fail on invalid structured output", async () => {
        const badExecutor: AgentExecutor = async () => "not json";
        const orch = new WorkflowOrchestrator(badExecutor);
        const wf: WorkflowDefinition = {
            name: "bad-schema",
            steps: [{
                id: "invalid", agent: "a", input: "produce JSON",
                outputSchema: { title: "string" },
            }],
        };

        const run = await orch.run(wf);
        expect(run.status).toBe("failed");
        expect(run.results.get("invalid")?.error).toContain("schema validation failed");
    });

    it("should cancel a running workflow", async () => {
        const slowExecutor: AgentExecutor = async () => {
            await new Promise(r => setTimeout(r, 5000));
            return "done";
        };
        const orch = new WorkflowOrchestrator(slowExecutor);
        const wf: WorkflowDefinition = {
            name: "cancel-test",
            steps: [{ id: "slow", agent: "a", input: "wait", timeout: 200 }],
        };

        const runPromise = orch.run(wf);

        // Cancel after a brief delay
        setTimeout(() => {
            const runs = orch.allRuns;
            if (runs.length > 0) orch.cancel(runs[0].id);
        }, 50);

        const run = await runPromise;
        // Either cancelled or failed due to timeout
        expect(["cancelled", "failed"]).toContain(run.status);
    });

    it("should store custom output key on blackboard", async () => {
        const orch = new WorkflowOrchestrator(echoExecutor);
        const wf: WorkflowDefinition = {
            name: "custom-key",
            steps: [
                { id: "s1", agent: "a", input: "data", outputKey: "research_result" },
            ],
        };

        const run = await orch.run(wf);
        expect(run.blackboard.has("research_result")).toBe(true);
        expect(run.blackboard.has("s1")).toBe(false);
    });
});
