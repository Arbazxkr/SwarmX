/**
 * Tests for the Groklets EventBus.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EventBus, createEvent, EventPriority, type SwarmEvent } from "../src/core/event-bus.js";

describe("EventBus", () => {
    let bus: EventBus;

    beforeEach(() => {
        bus = new EventBus();
    });

    it("should deliver events to subscribers", async () => {
        const received: SwarmEvent[] = [];

        bus.subscribe("test.topic", async (event) => {
            received.push(event);
        }, "test-sub");

        await bus.start();
        await bus.publish(createEvent({ topic: "test.topic", payload: { data: "hello" } }));
        await new Promise((r) => setTimeout(r, 200));
        await bus.stop();

        expect(received).toHaveLength(1);
        expect(received[0].payload.data).toBe("hello");
    });

    it("should match wildcard subscriptions", async () => {
        const received: SwarmEvent[] = [];

        bus.subscribe("task.*", async (event) => {
            received.push(event);
        }, "wild-sub");

        await bus.start();
        await bus.publish(createEvent({ topic: "task.created" }));
        await bus.publish(createEvent({ topic: "task.completed" }));
        await bus.publish(createEvent({ topic: "other.topic" })); // Should NOT match
        await new Promise((r) => setTimeout(r, 200));
        await bus.stop();

        expect(received).toHaveLength(2);
    });

    it("should deliver to global (*) subscribers", async () => {
        const received: SwarmEvent[] = [];

        bus.subscribe("*", async (event) => {
            received.push(event);
        }, "global-sub");

        await bus.start();
        await bus.publish(createEvent({ topic: "foo" }));
        await bus.publish(createEvent({ topic: "bar.baz" }));
        await new Promise((r) => setTimeout(r, 200));
        await bus.stop();

        expect(received).toHaveLength(2);
    });

    it("should unsubscribe handlers", async () => {
        const received: SwarmEvent[] = [];

        bus.subscribe("test", async (event) => {
            received.push(event);
        }, "unsub-test");

        const removed = bus.unsubscribe("unsub-test");
        expect(removed).toBe(1);

        await bus.start();
        await bus.publish(createEvent({ topic: "test" }));
        await new Promise((r) => setTimeout(r, 200));
        await bus.stop();

        expect(received).toHaveLength(0);
    });

    it("should isolate errors between handlers", async () => {
        const received: SwarmEvent[] = [];

        bus.subscribe("test", async () => {
            throw new Error("Handler error");
        }, "bad");

        bus.subscribe("test", async (event) => {
            received.push(event);
        }, "good");

        await bus.start();
        await bus.publish(createEvent({ topic: "test" }));
        await new Promise((r) => setTimeout(r, 200));
        await bus.stop();

        expect(received).toHaveLength(1);
        expect(bus.stats.errors).toBeGreaterThanOrEqual(1);
    });

    it("should track stats", async () => {
        bus.subscribe("test", async () => { }, "stats-test");

        await bus.start();
        await bus.publish(createEvent({ topic: "test" }));
        await bus.publish(createEvent({ topic: "test" }));
        await new Promise((r) => setTimeout(r, 200));
        await bus.stop();

        expect(bus.stats.published).toBe(2);
        expect(bus.stats.dispatched).toBe(2);
    });

    it("should track subscription count", () => {
        expect(bus.subscriptionCount).toBe(0);
        bus.subscribe("a", async () => { }, "s1");
        bus.subscribe("b", async () => { }, "s2");
        expect(bus.subscriptionCount).toBe(2);
    });
});
