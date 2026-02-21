/**
 * Tests for Guardrails, Context Compaction, and Tracing.
 */

import { describe, it, expect } from "vitest";
import {
    GuardrailRunner,
    maxLengthGuardrail,
    piiGuardrail,
    toxicityGuardrail,
    blockedPatternsGuardrail,
    requiredContentGuardrail,
    jsonOutputGuardrail,
} from "../src/core/guardrails.js";
import { compactMessages } from "../src/core/compaction.js";
import { Tracer } from "../src/core/tracing.js";
import { Role, type Message } from "../src/core/provider.js";

// ── Guardrails ─────────────────────────────────────────────────

describe("GuardrailRunner", () => {
    it("should pass clean input", async () => {
        const runner = new GuardrailRunner({ input: [maxLengthGuardrail(1000)] });
        const result = await runner.checkInput("Hello world");
        expect(result.passed).toBe(true);
    });

    it("should block long messages", async () => {
        const runner = new GuardrailRunner({ input: [maxLengthGuardrail(10)] });
        const result = await runner.checkInput("This is a very long message that exceeds the limit");
        expect(result.passed).toBe(false);
        expect(result.reports[0].guardrail).toBe("max-length");
    });

    it("should detect PII (email)", async () => {
        const runner = new GuardrailRunner({ input: [piiGuardrail()] });
        const result = await runner.checkInput("Contact me at john@example.com");
        expect(result.passed).toBe(false);
    });

    it("should detect PII (phone)", async () => {
        const runner = new GuardrailRunner({ input: [piiGuardrail()] });
        const result = await runner.checkInput("Call me at 555-123-4567");
        expect(result.passed).toBe(false);
    });

    it("should pass when no PII present", async () => {
        const runner = new GuardrailRunner({ input: [piiGuardrail()] });
        const result = await runner.checkInput("What is quantum computing?");
        expect(result.passed).toBe(true);
    });

    it("should filter toxic words", async () => {
        const runner = new GuardrailRunner({
            input: [toxicityGuardrail(["badword"])],
        });
        const result = await runner.checkInput("This contains badword here");
        expect(result.passed).toBe(false);
    });

    it("should block patterns in output", async () => {
        const runner = new GuardrailRunner({
            output: [blockedPatternsGuardrail([/hack into/i])],
        });
        const result = await runner.checkOutput("Here is how to hack into a system");
        expect(result.passed).toBe(false);
    });

    it("should check required content", async () => {
        const runner = new GuardrailRunner({
            output: [requiredContentGuardrail(["disclaimer"])],
        });
        const missing = await runner.checkOutput("Here is some advice.");
        expect(missing.passed).toBe(false);

        const present = await runner.checkOutput("Here is some advice. Disclaimer: not financial advice.");
        expect(present.passed).toBe(true);
    });

    it("should validate JSON output", async () => {
        const runner = new GuardrailRunner({ output: [jsonOutputGuardrail()] });
        const valid = await runner.checkOutput('{"key": "value"}');
        expect(valid.passed).toBe(true);

        const invalid = await runner.checkOutput("not json");
        expect(invalid.passed).toBe(false);
    });

    it("should run multiple guardrails in sequence", async () => {
        const runner = new GuardrailRunner({
            input: [maxLengthGuardrail(1000), piiGuardrail()],
        });
        const result = await runner.checkInput("Email: test@test.com");
        expect(result.passed).toBe(false);
        expect(result.reports.length).toBe(2);
    });

    it("should not block on non-blocking guardrails", async () => {
        const runner = new GuardrailRunner({
            input: [{
                name: "warn-only",
                check: () => ({ passed: false, message: "Just a warning" }),
                blocking: false,
            }],
        });
        const result = await runner.checkInput("test");
        expect(result.passed).toBe(true);
    });
});

// ── Context Compaction ─────────────────────────────────────────

describe("compactMessages", () => {
    function makeMessages(count: number): Message[] {
        const msgs: Message[] = [{ role: Role.SYSTEM, content: "You are a helper." }];
        for (let i = 0; i < count; i++) {
            msgs.push({
                role: i % 2 === 0 ? Role.USER : Role.ASSISTANT,
                content: `Message ${i}: ${"x".repeat(100)}`,
            });
        }
        return msgs;
    }

    it("should not compact when under limit", async () => {
        const msgs = makeMessages(5);
        const result = await compactMessages(msgs, { maxTokens: 50000, keepRecent: 100 });
        expect(result.compacted).toBe(false);
    });

    it("should compact with sliding window", async () => {
        const msgs = makeMessages(50);
        const result = await compactMessages(msgs, {
            strategy: "sliding",
            keepRecent: 10,
            maxTokens: 500,
        });
        expect(result.compacted).toBe(true);
        expect(result.newCount).toBeLessThan(result.originalCount);
        // System message should be preserved
        expect(result.messages[0].role).toBe(Role.SYSTEM);
    });

    it("should preserve system messages", async () => {
        const msgs: Message[] = [
            { role: Role.SYSTEM, content: "System prompt" },
            ...Array.from({ length: 30 }, (_, i) => ({
                role: i % 2 === 0 ? Role.USER : Role.ASSISTANT,
                content: `msg ${i}`,
            } as Message)),
        ];
        const result = await compactMessages(msgs, { strategy: "sliding", keepRecent: 5, maxTokens: 100 });
        const systemMsgs = result.messages.filter(m => m.role === Role.SYSTEM);
        expect(systemMsgs.length).toBeGreaterThan(0);
        expect(systemMsgs[0].content).toBe("System prompt");
    });

    it("should compact with budget strategy", async () => {
        const msgs = makeMessages(50);
        const result = await compactMessages(msgs, {
            strategy: "budget",
            maxTokens: 500,
        });
        expect(result.compacted).toBe(true);
        expect(result.newCount).toBeLessThan(result.originalCount);
    });
});

// ── Tracing ────────────────────────────────────────────────────

describe("Tracer", () => {
    it("should create and end a trace", () => {
        const tracer = new Tracer();
        const traceId = tracer.startTrace("test-trace");
        expect(traceId).toBeTruthy();

        tracer.endTrace(traceId, "success");
        const trace = tracer.getTrace(traceId);
        expect(trace).toBeDefined();
        expect(trace!.status).toBe("success");
        expect(trace!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should add child spans", () => {
        const tracer = new Tracer();
        const traceId = tracer.startTrace("parent");
        const spanId = tracer.startSpan(traceId, "child-tool", "tool", { tool: "search" });

        expect(spanId).toBeTruthy();

        tracer.endSpan(spanId, "success");
        tracer.endTrace(traceId);

        const trace = tracer.getTrace(traceId);
        expect(trace!.spanCount).toBe(2); // root + child
        expect(trace!.rootSpan.children.length).toBe(1);
        expect(trace!.rootSpan.children[0].name).toBe("child-tool");
    });

    it("should add events to spans", () => {
        const tracer = new Tracer();
        const traceId = tracer.startTrace("events-test");
        const spanId = tracer.startSpan(traceId, "my-span", "custom");

        tracer.addEvent(spanId, "checkpoint", { step: 1 });
        tracer.addEvent(spanId, "checkpoint", { step: 2 });

        // Can't easily access span events through public API, but no crash
        tracer.endSpan(spanId);
        tracer.endTrace(traceId);
        expect(tracer.getTrace(traceId)!.status).toBe("success");
    });

    it("should export to JSON", () => {
        const tracer = new Tracer();
        const traceId = tracer.startTrace("json-test");
        tracer.endTrace(traceId);

        const json = tracer.toJSON(traceId);
        expect(json).toBeTruthy();
        const parsed = JSON.parse(json!);
        expect(parsed.name).toBe("json-test");
    });

    it("should return recent traces", () => {
        const tracer = new Tracer();
        for (let i = 0; i < 5; i++) {
            const id = tracer.startTrace(`trace-${i}`);
            tracer.endTrace(id);
        }
        const recent = tracer.getRecentTraces(3);
        expect(recent.length).toBe(3);
    });

    it("should produce summary", () => {
        const tracer = new Tracer();
        const id = tracer.startTrace("summary-test");
        tracer.endTrace(id);
        const summaries = tracer.summary();
        expect(summaries.length).toBeGreaterThan(0);
        expect(summaries[0].name).toBe("summary-test");
    });

    it("should handle disabled tracer", () => {
        const tracer = new Tracer({ enabled: false });
        const traceId = tracer.startTrace("noop");
        expect(traceId).toBe("");
    });

    it("should prune old traces", () => {
        const tracer = new Tracer({ maxTraces: 3 });
        for (let i = 0; i < 10; i++) {
            const id = tracer.startTrace(`trace-${i}`);
            tracer.endTrace(id);
        }
        expect(tracer.getAllTraces().length).toBeLessThanOrEqual(3);
    });
});
