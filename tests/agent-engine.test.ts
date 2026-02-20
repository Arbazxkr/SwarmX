/**
 * Tests for the SwarmX Agent and Engine.
 * Uses a mock provider to avoid real API calls.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Agent, AgentState, type AgentConfig } from "../src/core/agent.js";
import { SwarmEngine } from "../src/core/engine.js";
import { EventBus, createEvent, type SwarmEvent } from "../src/core/event-bus.js";
import {
    type ProviderBase,
    ProviderRegistry,
    type ProviderConfig,
    type Message,
    type CompletionResponse,
    Role,
} from "../src/core/provider.js";

/** Mock provider for testing without real API calls. */
class MockProvider implements ProviderBase {
    readonly name = "MockProvider";
    readonly config: ProviderConfig;
    callCount = 0;
    lastMessages: Message[] = [];

    constructor(config?: ProviderConfig) {
        this.config = config ?? {};
    }

    async complete(messages: Message[]): Promise<CompletionResponse> {
        this.callCount++;
        this.lastMessages = messages;
        return {
            message: { role: Role.ASSISTANT, content: `Mock response #${this.callCount}` },
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            model: "mock-model",
        };
    }
}

describe("Agent", () => {
    let bus: EventBus;
    let registry: ProviderRegistry;
    let mockProvider: MockProvider;

    beforeEach(() => {
        bus = new EventBus();
        registry = new ProviderRegistry();
        mockProvider = new MockProvider();
        registry.registerInstance("mock", mockProvider);
    });

    it("should initialize and bind to provider", async () => {
        const config: AgentConfig = {
            name: "test-agent",
            provider: "mock",
            systemPrompt: "You are a test agent.",
            subscriptions: ["test.topic"],
        };
        const agent = new Agent(config, bus, registry);

        await agent.initialize();

        expect(agent.state).toBe(AgentState.IDLE);
        expect(agent.history).toHaveLength(1); // system prompt
        expect(bus.subscriptionCount).toBe(1);
    });

    it("should process input through provider", async () => {
        const config: AgentConfig = { name: "thinker", provider: "mock" };
        const agent = new Agent(config, bus, registry);
        await agent.initialize();

        const response = await agent.think("Hello!");

        expect(response).not.toBeNull();
        expect(response!.message.content).toBe("Mock response #1");
        expect(mockProvider.callCount).toBe(1);
        expect(agent.history).toHaveLength(2); // user + assistant
    });

    it("should handle events and emit responses", async () => {
        const responses: SwarmEvent[] = [];
        bus.subscribe("agent.response.*", async (event) => {
            responses.push(event);
        }, "test-capture");

        const config: AgentConfig = {
            name: "handler",
            provider: "mock",
            subscriptions: ["task.created"],
        };
        const agent = new Agent(config, bus, registry);

        await bus.start();
        await agent.initialize();

        await bus.publish(createEvent({
            topic: "task.created",
            payload: { content: "Do something" },
        }));
        await new Promise((r) => setTimeout(r, 500));
        await bus.stop();

        expect(mockProvider.callCount).toBe(1);
        expect(responses.length).toBeGreaterThanOrEqual(1);
        expect((responses[0].payload.content as string)).toContain("Mock response");
    });

    it("should unsubscribe on shutdown", async () => {
        const config: AgentConfig = {
            name: "shutdown-test",
            provider: "mock",
            subscriptions: ["a", "b"],
        };
        const agent = new Agent(config, bus, registry);
        await agent.initialize();

        expect(bus.subscriptionCount).toBe(2);

        await agent.shutdown();

        expect(agent.state).toBe(AgentState.SHUTDOWN);
        expect(bus.subscriptionCount).toBe(0);
    });
});

describe("SwarmEngine", () => {
    it("should start and stop cleanly", async () => {
        const engine = new SwarmEngine();
        const mock = new MockProvider();
        engine.registerProvider("mock", mock);
        engine.addAgent({ name: "agent1", provider: "mock" });

        await engine.start();
        expect(engine.isRunning).toBe(true);

        await engine.stop();
        expect(engine.isRunning).toBe(false);
    });

    it("should report status", async () => {
        const engine = new SwarmEngine();
        const mock = new MockProvider();
        engine.registerProvider("mock", mock);
        engine.addAgent({ name: "agent1", provider: "mock" });
        engine.addAgent({ name: "agent2", provider: "mock" });

        await engine.start();
        const status = engine.status();

        expect(status.running).toBe(true);
        expect(Object.keys(status.agents as object)).toHaveLength(2);
        expect((status.providers as string[])).toContain("mock");

        await engine.stop();
    });

    it("should submit tasks and route to agents", async () => {
        const engine = new SwarmEngine();
        const mock = new MockProvider();
        engine.registerProvider("mock", mock);
        engine.addAgent({
            name: "worker",
            provider: "mock",
            subscriptions: ["task.created"],
        });

        await engine.start();
        const taskId = await engine.submitTask("Test task");
        expect(taskId).toBeTruthy();

        await new Promise((r) => setTimeout(r, 500));
        expect(mock.callCount).toBeGreaterThanOrEqual(1);

        await engine.stop();
    });

    it("should route to multiple agents", async () => {
        const engine = new SwarmEngine();
        const mock = new MockProvider();
        engine.registerProvider("mock", mock);

        engine.addAgent({ name: "a1", provider: "mock", subscriptions: ["task.created"] });
        engine.addAgent({ name: "a2", provider: "mock", subscriptions: ["task.created"] });

        await engine.start();
        await engine.submitTask("Shared task");
        await new Promise((r) => setTimeout(r, 1000));

        expect(mock.callCount).toBeGreaterThanOrEqual(2);

        await engine.stop();
    });
});
