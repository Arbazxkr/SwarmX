/**
 * Core Module Tests — Memory, Security, Router.
 */

import { describe, it, expect } from "vitest";
import { MemoryStore } from "../src/core/memory.js";
import { InputSanitizer, RateLimiter } from "../src/core/security.js";
import { MessageRouter } from "../src/core/router.js";
import { SwarmEngine } from "../src/core/engine.js";
import { EventBus, createEvent } from "../src/core/event-bus.js";

// ── Memory ─────────────────────────────────────────────────────

describe("MemoryStore", () => {
    it("should store and retrieve entries", () => {
        const mem = new MemoryStore();
        mem.add("The capital of France is Paris", "fact");
        mem.add("TypeScript is a programming language", "fact");

        const results = mem.search("capital");
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].content).toContain("Paris");
    });

    it("should return empty for no matches", () => {
        const mem = new MemoryStore();
        const results = mem.search("anything");
        expect(results).toEqual([]);
    });

    it("should find entries by search terms", () => {
        const mem = new MemoryStore();
        mem.add("My name is Arbaz and I live in India", "note");
        mem.add("The weather today is sunny and warm", "note");

        const results = mem.search("Arbaz");
        expect(results.length).toBeGreaterThan(0);
    });

    it("should respect max entries and prune old ones", () => {
        const mem = new MemoryStore({ maxEntries: 3 });
        mem.add("first entry about apples", "fact");
        mem.add("second entry about oranges", "fact");
        mem.add("third entry about bananas", "fact");
        mem.add("fourth entry about grapes", "fact"); // Should trigger prune

        // After pruning, should have at most 3 entries
        const all = mem.search("entry", 10);
        expect(all.length).toBeLessThanOrEqual(3);
    });

    it("should build context from relevant entries", () => {
        const mem = new MemoryStore();
        mem.add("User prefers dark mode for all interfaces", "preference");
        mem.add("User is a software engineer working on AI", "fact");

        const context = mem.buildContext("dark mode interfaces");
        expect(context.length).toBeGreaterThan(0);
    });
});

// ── Security: Input Sanitizer ──────────────────────────────────

describe("InputSanitizer", () => {
    it("should pass clean input", () => {
        const sanitizer = new InputSanitizer();
        const result = sanitizer.sanitize("Hello, how are you?");
        expect(result.blocked).toBe(false);
        expect(result.clean).toBe("Hello, how are you?");
    });

    it("should detect script injection", () => {
        const sanitizer = new InputSanitizer();
        const result = sanitizer.sanitize("<script>alert('xss')</script>");
        expect(result.blocked).toBe(true);
    });

    it("should detect SQL injection patterns", () => {
        const sanitizer = new InputSanitizer();
        const result = sanitizer.sanitize("'; DROP TABLE users; --");
        expect(result.blocked).toBe(true);
    });
});

// ── Security: Rate Limiter ─────────────────────────────────────

describe("RateLimiter", () => {
    it("should allow requests within limit", () => {
        const limiter = new RateLimiter(5, 1);

        expect(limiter.allow("user1")).toBe(true);
        expect(limiter.allow("user1")).toBe(true);
        expect(limiter.allow("user1")).toBe(true);
    });

    it("should block requests exceeding limit", () => {
        const limiter = new RateLimiter(2, 1);

        expect(limiter.allow("user1")).toBe(true);
        expect(limiter.allow("user1")).toBe(true);
        expect(limiter.allow("user1")).toBe(false); // Over limit
    });

    it("should track limits per sender independently", () => {
        const limiter = new RateLimiter(1, 1);

        expect(limiter.allow("user1")).toBe(true);
        expect(limiter.allow("user1")).toBe(false);
        expect(limiter.allow("user2")).toBe(true); // Different sender
    });

    it("should report remaining tokens", () => {
        const limiter = new RateLimiter(5, 1);
        limiter.allow("u1");
        limiter.allow("u1");
        expect(limiter.remaining("u1")).toBe(3);
    });

    it("should reset a sender's bucket", () => {
        const limiter = new RateLimiter(2, 1);
        limiter.allow("u1");
        limiter.allow("u1");
        expect(limiter.allow("u1")).toBe(false);

        limiter.reset("u1");
        expect(limiter.allow("u1")).toBe(true); // Reset worked
    });
});

// ── Router ─────────────────────────────────────────────────────

describe("MessageRouter", () => {
    it("should add routes and route messages", async () => {
        const engine = new SwarmEngine();
        const router = new MessageRouter(engine);

        router.addRoute({
            name: "bot",
            targetAgent: "agent1",
            activation: "always",
            channels: ["telegram"],
        });

        const event = createEvent({
            topic: "channel.message",
            source: "telegram",
            payload: {
                content: "Hello bot",
                channel: "telegram",
                chatId: "chat123",
                senderId: "user1",
                isGroup: false,
            },
        });

        // Route should return true (matched) or false (no agent found)
        // Since we didn't add agent1 to engine, it'll queue but warn
        const matched = await router.route(event);
        expect(matched).toBe(true);
    });

    it("should not route when channel doesn't match", async () => {
        const engine = new SwarmEngine();
        const router = new MessageRouter(engine);

        router.addRoute({
            name: "discord-only",
            targetAgent: "agent1",
            activation: "always",
            channels: ["discord"],
        });

        const event = createEvent({
            topic: "channel.message",
            source: "telegram",
            payload: {
                content: "Hello",
                channel: "telegram",
                chatId: "c1",
                senderId: "u1",
                isGroup: false,
            },
        });

        const matched = await router.route(event);
        expect(matched).toBe(false);
    });

    it("should support keyword activation", async () => {
        const engine = new SwarmEngine();
        const router = new MessageRouter(engine);

        router.addRoute({
            name: "help",
            targetAgent: "helper",
            activation: "keyword",
            keywords: ["help", "support"],
            channels: ["*"],
        });

        const matched = await router.route(createEvent({
            topic: "channel.message",
            payload: {
                content: "I need help please",
                channel: "whatsapp",
                chatId: "c1",
                senderId: "u1",
                isGroup: false,
            },
        }));

        expect(matched).toBe(true);
    });

    it("should not match keyword when absent", async () => {
        const engine = new SwarmEngine();
        const router = new MessageRouter(engine);

        router.addRoute({
            name: "help",
            targetAgent: "helper",
            activation: "keyword",
            keywords: ["help", "support"],
            channels: ["*"],
        });

        const matched = await router.route(createEvent({
            topic: "channel.message",
            payload: {
                content: "Good morning",
                channel: "whatsapp",
                chatId: "c2",
                senderId: "u2",
                isGroup: false,
            },
        }));

        expect(matched).toBe(false);
    });
});
