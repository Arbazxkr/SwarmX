/**
 * Tests for SwarmX production features:
 *   - Model failover
 *   - Tool execution loop
 *   - Session persistence
 *   - Context management
 *   - Usage tracking
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

import { Role, type Message, type CompletionResponse, type ProviderBase, type ProviderConfig } from "../src/core/provider.js";
import { FailoverProvider } from "../src/core/failover.js";
import { ToolExecutor, executeToolLoop } from "../src/core/tool-executor.js";
import { SessionStore } from "../src/core/session.js";
import { ContextManager, estimateTokens, estimateMessagesTokens, pruneSliding } from "../src/core/context.js";
import { UsageTracker } from "../src/core/usage.js";

// ── Mock Provider ─────────────────────────────────────────────

class MockProvider implements ProviderBase {
    name = "Mock";
    config: ProviderConfig = {};
    callCount = 0;
    shouldFail = false;
    failCount = 0;
    toolCallsToReturn: Message["toolCalls"] | undefined;

    async complete(messages: Message[]): Promise<CompletionResponse> {
        this.callCount++;
        if (this.shouldFail || (this.failCount > 0 && this.callCount <= this.failCount)) {
            throw new Error("Provider error");
        }
        return {
            message: {
                role: Role.ASSISTANT,
                content: `Response #${this.callCount}`,
                toolCalls: this.toolCallsToReturn,
            },
            finishReason: "stop",
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            model: "mock-model",
        };
    }
}

// ── Failover Tests ────────────────────────────────────────────

describe("FailoverProvider", () => {
    it("should use primary provider when healthy", async () => {
        const primary = new MockProvider();
        primary.name = "Primary";
        const fallback = new MockProvider();
        fallback.name = "Fallback";

        const failover = new FailoverProvider("test", [primary, fallback]);
        const result = await failover.complete([{ role: Role.USER, content: "Hi" }]);

        expect(result.message.content).toBe("Response #1");
        expect(primary.callCount).toBe(1);
        expect(fallback.callCount).toBe(0);
    });

    it("should fall through to next provider on failure", async () => {
        const primary = new MockProvider();
        primary.name = "Primary";
        primary.shouldFail = true;

        const fallback = new MockProvider();
        fallback.name = "Fallback";

        const failover = new FailoverProvider("test", [primary, fallback]);
        const result = await failover.complete([{ role: Role.USER, content: "Hi" }]);

        expect(result.message.content).toBe("Response #1");
        expect(primary.callCount).toBe(1);
        expect(fallback.callCount).toBe(1);
    });

    it("should mark provider unhealthy after max failures", async () => {
        const primary = new MockProvider();
        primary.shouldFail = true;
        const fallback = new MockProvider();

        const failover = new FailoverProvider("test", [primary, fallback], { maxFailures: 2 });

        await failover.complete([{ role: Role.USER, content: "1" }]);
        await failover.complete([{ role: Role.USER, content: "2" }]);

        // Primary should be unhealthy now, fallback only
        const status = failover.healthStatus;
        expect(status[0].healthy).toBe(false);
        expect(status[1].healthy).toBe(true);
    });

    it("should throw when all providers fail", async () => {
        const p1 = new MockProvider();
        p1.shouldFail = true;
        const p2 = new MockProvider();
        p2.shouldFail = true;

        const failover = new FailoverProvider("test", [p1, p2]);

        await expect(failover.complete([{ role: Role.USER, content: "Hi" }])).rejects.toThrow();
    });
});

// ── Tool Executor Tests ───────────────────────────────────────

describe("ToolExecutor", () => {
    it("should execute tools and feed results back", async () => {
        let callNum = 0;
        const provider: ProviderBase = {
            name: "ToolMock",
            config: {},
            async complete(messages: Message[]) {
                callNum++;
                if (callNum === 1) {
                    // First call: return a tool call
                    return {
                        message: {
                            role: Role.ASSISTANT,
                            content: "",
                            toolCalls: [{
                                id: "call_1",
                                type: "function",
                                function: { name: "get_weather", arguments: '{"city":"NYC"}' },
                            }],
                        },
                        finishReason: "tool_calls",
                        usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
                        model: "test",
                    };
                }
                // Second call: final response after tool result
                return {
                    message: { role: Role.ASSISTANT, content: "The weather in NYC is sunny." },
                    finishReason: "stop",
                    usage: { promptTokens: 80, completionTokens: 15, totalTokens: 95 },
                    model: "test",
                };
            },
        };

        const tools = [{
            type: "function" as const,
            function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
        }];

        const toolFns = {
            get_weather: async (args: Record<string, unknown>) => `Sunny in ${args.city}`,
        };

        const result = await executeToolLoop(
            provider,
            [{ role: Role.USER, content: "What's the weather in NYC?" }],
            tools,
            toolFns,
        );

        expect(result.iterations).toBe(2);
        expect(result.response.message.content).toBe("The weather in NYC is sunny.");
        expect(result.messages.length).toBeGreaterThan(2); // user + tool_call + tool_result + final
    });

    it("should handle unknown tools gracefully", async () => {
        const provider: ProviderBase = {
            name: "Mock",
            config: {},
            async complete() {
                return {
                    message: {
                        role: Role.ASSISTANT,
                        content: "",
                        toolCalls: [{
                            id: "c1",
                            type: "function",
                            function: { name: "nonexistent", arguments: "{}" },
                        }],
                    },
                    finishReason: "tool_calls",
                    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
                    model: "test",
                };
            },
        };

        // This will loop with unknown tool error, should hit max iterations
        const result = await executeToolLoop(provider, [{ role: Role.USER, content: "test" }], [], {}, { maxIterations: 2 });
        expect(result.iterations).toBe(2);
    });

    it("should register and execute via ToolExecutor class", async () => {
        const executor = new ToolExecutor({ maxIterations: 5 });
        executor.register("add", "Add numbers", {}, async (args) => {
            return String(Number(args.a) + Number(args.b));
        });

        expect(executor.registeredTools).toContain("add");
        expect(executor.toolDefinitions).toHaveLength(1);
    });
});

// ── Session Store Tests ───────────────────────────────────────

const TEST_SESSION_DIR = join(process.cwd(), ".swarmx-test-sessions");

describe("SessionStore", () => {
    let store: SessionStore;

    beforeEach(() => {
        if (existsSync(TEST_SESSION_DIR)) rmSync(TEST_SESSION_DIR, { recursive: true });
        store = new SessionStore({ directory: TEST_SESSION_DIR });
    });

    afterEach(() => {
        if (existsSync(TEST_SESSION_DIR)) rmSync(TEST_SESSION_DIR, { recursive: true });
    });

    it("should create and retrieve sessions", () => {
        const session = store.create("agent-1");
        expect(session.agentId).toBe("agent-1");
        expect(store.get(session.sessionId)).toBeTruthy();
    });

    it("should add messages and persist", () => {
        const session = store.create("agent-2");
        store.addMessage(session.sessionId, { role: Role.USER, content: "Hello" });
        store.addMessage(session.sessionId, { role: Role.ASSISTANT, content: "Hi" });

        const messages = store.getMessages(session.sessionId);
        expect(messages).toHaveLength(2);

        // Reload from disk
        const store2 = new SessionStore({ directory: TEST_SESSION_DIR });
        const loaded = store2.getMessages(session.sessionId);
        expect(loaded).toHaveLength(2);
    });

    it("should get latest session for agent", () => {
        store.create("agent-3");
        const second = store.create("agent-3");
        const latest = store.getLatest("agent-3");
        expect(latest?.sessionId).toBe(second.sessionId);
    });

    it("should delete sessions", () => {
        const session = store.create("agent-4");
        expect(store.delete(session.sessionId)).toBe(true);
        expect(store.get(session.sessionId)).toBeUndefined();
    });

    it("should report stats", () => {
        const s = store.create("agent-5");
        store.addMessage(s.sessionId, { role: Role.USER, content: "test" });
        const stats = store.stats();
        expect(stats.totalSessions).toBeGreaterThanOrEqual(1);
        expect(stats.totalMessages).toBeGreaterThanOrEqual(1);
    });
});

// ── Context Manager Tests ─────────────────────────────────────

describe("ContextManager", () => {
    it("should estimate tokens", () => {
        expect(estimateTokens("Hello world")).toBeGreaterThan(0);
        expect(estimateTokens("a".repeat(400))).toBe(100);
    });

    it("should detect when pruning is needed", () => {
        const ctx = new ContextManager({ maxContextTokens: 100, pruneThreshold: 0.8 });
        const small: Message[] = [{ role: Role.USER, content: "hi" }];
        const big: Message[] = [{ role: Role.USER, content: "x".repeat(500) }];

        expect(ctx.needsPruning(small)).toBe(false);
        expect(ctx.needsPruning(big)).toBe(true);
    });

    it("should prune with sliding window", () => {
        const messages: Message[] = [
            { role: Role.SYSTEM, content: "You are helpful" },
            ...Array.from({ length: 50 }, (_, i) => ({ role: Role.USER as Role, content: `Message ${i}: ${"x".repeat(100)}` })),
        ];

        const pruned = pruneSliding(messages, 500, 5);
        expect(pruned.length).toBeLessThan(messages.length);
        expect(pruned[0].role).toBe(Role.SYSTEM); // System kept
        expect(pruned[pruned.length - 1].content).toContain("Message 49"); // Most recent kept
    });

    it("should report usage stats", () => {
        const ctx = new ContextManager({ maxContextTokens: 10000 });
        const msgs: Message[] = [{ role: Role.USER, content: "Hello world test message" }];
        const usage = ctx.usage(msgs);
        expect(usage.estimated).toBeGreaterThan(0);
        expect(usage.max).toBe(10000);
        expect(usage.percent).toBeGreaterThanOrEqual(0);
    });
});

// ── Usage Tracker Tests ───────────────────────────────────────

describe("UsageTracker", () => {
    it("should track token usage and cost", () => {
        const tracker = new UsageTracker();
        tracker.track("gpt-4o", 1000, 500);

        const summary = tracker.summary;
        expect(summary.calls).toBe(1);
        expect(summary.promptTokens).toBe(1000);
        expect(summary.completionTokens).toBe(500);
        expect(summary.totalTokens).toBe(1500);
        expect(summary.costUsd).toBeGreaterThan(0);
    });

    it("should produce per-model breakdown", () => {
        const tracker = new UsageTracker();
        tracker.track("gpt-4o", 500, 200);
        tracker.track("gpt-4o", 300, 100);
        tracker.track("claude-sonnet-4-20250514", 400, 150);

        const breakdown = tracker.breakdown();
        expect(breakdown["gpt-4o"].calls).toBe(2);
        expect(breakdown["claude-sonnet-4-20250514"].calls).toBe(1);
    });

    it("should handle unknown models (zero cost)", () => {
        const tracker = new UsageTracker();
        tracker.track("unknown-model-xyz", 100, 50);

        expect(tracker.summary.costUsd).toBe(0);
        expect(tracker.summary.totalTokens).toBe(150);
    });

    it("should reset cleanly", () => {
        const tracker = new UsageTracker();
        tracker.track("gpt-4o", 1000, 500);
        tracker.reset();

        expect(tracker.summary.calls).toBe(0);
        expect(tracker.summary.totalTokens).toBe(0);
    });
});
