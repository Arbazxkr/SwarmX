/**
 * Provider Registry Tests — pluggable providers, factories, OpenAI-compatible fallback.
 */

import { describe, it, expect } from "vitest";
import {
    ProviderRegistry,
    type ProviderBase,
    type ProviderConfig,
    type Message,
    type CompletionResponse,
    type ToolDefinition,
    Role,
} from "../src/core/provider.js";

// ── Mock provider ──────────────────────────────────────────────

class MockProvider implements ProviderBase {
    readonly name: string;
    readonly config: ProviderConfig;

    constructor(config: ProviderConfig) {
        this.name = `Mock(${config.model ?? "default"})`;
        this.config = config;
    }

    async complete(messages: Message[]): Promise<CompletionResponse> {
        return {
            message: { role: Role.ASSISTANT, content: "mock response" },
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            model: this.config.model ?? "mock",
        };
    }
}

class CustomProvider implements ProviderBase {
    readonly name = "Custom";
    readonly config: ProviderConfig;

    constructor(config: ProviderConfig) {
        this.config = config;
    }

    async complete(messages: Message[]): Promise<CompletionResponse> {
        return {
            message: { role: Role.ASSISTANT, content: "custom response" },
            finishReason: "stop",
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            model: "custom-model",
        };
    }
}

// ── Tests ──────────────────────────────────────────────────────

describe("ProviderRegistry", () => {
    it("should register and retrieve a provider instance", () => {
        const reg = new ProviderRegistry();
        const provider = new MockProvider({ model: "test" });
        reg.registerInstance("mock", provider);

        expect(reg.has("mock")).toBe(true);
        expect(reg.get("mock")).toBe(provider);
    });

    it("should throw on unknown provider", () => {
        const reg = new ProviderRegistry();
        expect(() => reg.get("nonexistent")).toThrow("Provider not found");
    });

    it("should register a provider class and create instances", () => {
        const reg = new ProviderRegistry();
        reg.registerClass("mock", MockProvider);

        const provider = reg.create("mock", "my-mock", { model: "gpt-test" });

        expect(provider.name).toContain("gpt-test");
        expect(reg.has("my-mock")).toBe(true);
        expect(reg.get("my-mock")).toBe(provider);
    });

    it("should register a provider factory function", () => {
        const reg = new ProviderRegistry();
        reg.registerFactory("custom", (config) => new CustomProvider(config));

        const provider = reg.create("custom", "my-custom", { model: "v1" });

        expect(provider.name).toBe("Custom");
        expect(reg.has("my-custom")).toBe(true);
    });

    it("should fallback to OpenAI-compatible for unknown types with baseUrl", () => {
        const reg = new ProviderRegistry();
        reg.registerClass("openai", MockProvider);

        // "ollama" is unknown, but has a baseUrl — should fallback to OpenAI-compatible
        const provider = reg.create("ollama", "local-llama", {
            baseUrl: "http://localhost:11434/v1",
            model: "llama3",
        });

        expect(provider).toBeDefined();
        expect(reg.has("local-llama")).toBe(true);
    });

    it("should throw for unknown type without baseUrl", () => {
        const reg = new ProviderRegistry();
        expect(() =>
            reg.create("unknown", "fail", { model: "test" })
        ).toThrow("Unknown provider type");
    });

    it("should list available provider instances", () => {
        const reg = new ProviderRegistry();
        reg.registerInstance("a", new MockProvider({ model: "a" }));
        reg.registerInstance("b", new MockProvider({ model: "b" }));

        expect(reg.available).toContain("a");
        expect(reg.available).toContain("b");
    });

    it("should list registered type names", () => {
        const reg = new ProviderRegistry();
        reg.registerClass("openai", MockProvider);
        reg.registerFactory("custom", (c) => new CustomProvider(c));

        expect(reg.registeredTypes).toContain("openai");
        expect(reg.registeredTypes).toContain("custom");
    });

    it("should check hasType", () => {
        const reg = new ProviderRegistry();
        reg.registerClass("openai", MockProvider);

        expect(reg.hasType("openai")).toBe(true);
        expect(reg.hasType("unknown")).toBe(false);
    });

    it("should prefer factory over class when both registered", () => {
        const reg = new ProviderRegistry();
        reg.registerClass("test", MockProvider);
        reg.registerFactory("test", (config) => new CustomProvider(config));

        const provider = reg.create("test", "instance", { model: "v1" });

        // Factory should win (checked first)
        expect(provider.name).toBe("Custom");
    });

    it("should support multiple instances of same type", () => {
        const reg = new ProviderRegistry();
        reg.registerClass("mock", MockProvider);

        reg.create("mock", "fast", { model: "gpt-4o-mini", temperature: 0.3 });
        reg.create("mock", "creative", { model: "gpt-4o", temperature: 0.9 });

        expect(reg.has("fast")).toBe(true);
        expect(reg.has("creative")).toBe(true);
        expect(reg.get("fast").config.temperature).toBe(0.3);
        expect(reg.get("creative").config.temperature).toBe(0.9);
    });
});
