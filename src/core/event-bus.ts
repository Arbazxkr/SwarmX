/**
 * SwarmX Event Bus — Central non-blocking event routing system.
 *
 * Inspired by the Gateway pattern from OpenClaw, adapted for multi-agent
 * orchestration. The EventBus acts as the central nervous system: agents
 * subscribe to event topics, emit events, and the bus routes them without
 * requiring direct agent-to-agent coupling.
 *
 * Architecture pattern adapted from OpenClaw's WebSocket control plane,
 * reimplemented as a pure TypeScript async event system.
 */

import { randomUUID } from "node:crypto";

export enum EventPriority {
    LOW = 0,
    NORMAL = 1,
    HIGH = 2,
    CRITICAL = 3,
}

export interface SwarmEvent {
    /** The event topic/channel (e.g. "task.created", "agent.response"). */
    topic: string;
    /** Arbitrary data attached to the event. */
    payload: Record<string, unknown>;
    /** Identifier of the event producer (agent ID, "engine", "cli", etc.). */
    source: string;
    /** Unique identifier for tracing and deduplication. */
    eventId: string;
    /** Unix timestamp of event creation. */
    timestamp: number;
    /** Processing priority (higher = processed first). */
    priority: EventPriority;
    /** Optional metadata for routing, tracing, and filtering. */
    metadata: Record<string, unknown>;
}

export type EventHandler = (event: SwarmEvent) => Promise<void>;

interface Subscription {
    handler: EventHandler;
    subscriberId: string;
    topicPattern: string;
    priority: EventPriority;
}

/**
 * Create a new SwarmEvent with defaults filled in.
 */
export function createEvent(partial: Partial<SwarmEvent> & { topic: string }): SwarmEvent {
    return {
        topic: partial.topic,
        payload: partial.payload ?? {},
        source: partial.source ?? "",
        eventId: partial.eventId ?? randomUUID().slice(0, 12),
        timestamp: partial.timestamp ?? Date.now(),
        priority: partial.priority ?? EventPriority.NORMAL,
        metadata: partial.metadata ?? {},
    };
}

/**
 * Central async event bus for SwarmX agent coordination.
 *
 * The bus supports topic-based pub/sub with wildcard matching:
 *   - "task.created"      → exact match
 *   - "task.*"            → matches any subtopic under "task"
 *   - "*"                 → matches everything (global listener)
 *
 * All event dispatch is non-blocking. Handlers execute as microtasks
 * and exceptions in individual handlers do not stop other handlers.
 */
export class EventBus {
    private subscriptions = new Map<string, Subscription[]>();
    private globalSubscriptions: Subscription[] = [];
    private eventQueue: SwarmEvent[] = [];
    private processing = false;
    private running = false;
    private eventHistory: SwarmEvent[] = [];
    private maxHistory = 1000;
    private intervalId: ReturnType<typeof setInterval> | null = null;

    private _stats = { published: 0, dispatched: 0, errors: 0 };

    // ── Subscription Management ─────────────────────────────────

    /**
     * Subscribe a handler to a topic pattern.
     * Returns the subscriberId (generated if not provided).
     */
    subscribe(
        topic: string,
        handler: EventHandler,
        subscriberId?: string,
        priority: EventPriority = EventPriority.NORMAL,
    ): string {
        const id = subscriberId ?? randomUUID().slice(0, 8);

        const sub: Subscription = {
            handler,
            subscriberId: id,
            topicPattern: topic,
            priority,
        };

        if (topic === "*") {
            this.globalSubscriptions.push(sub);
        } else {
            const existing = this.subscriptions.get(topic) ?? [];
            existing.push(sub);
            this.subscriptions.set(topic, existing);
        }

        return id;
    }

    /**
     * Remove all subscriptions for a given subscriber.
     * Returns count of removed subscriptions.
     */
    unsubscribe(subscriberId: string): number {
        let removed = 0;

        for (const [topic, subs] of this.subscriptions.entries()) {
            const before = subs.length;
            const filtered = subs.filter((s) => s.subscriberId !== subscriberId);
            removed += before - filtered.length;

            if (filtered.length === 0) {
                this.subscriptions.delete(topic);
            } else {
                this.subscriptions.set(topic, filtered);
            }
        }

        const beforeGlobal = this.globalSubscriptions.length;
        this.globalSubscriptions = this.globalSubscriptions.filter(
            (s) => s.subscriberId !== subscriberId,
        );
        removed += beforeGlobal - this.globalSubscriptions.length;

        return removed;
    }

    // ── Publishing ──────────────────────────────────────────────

    /**
     * Enqueue an event for async dispatch.
     */
    async publish(event: SwarmEvent): Promise<void> {
        this.eventQueue.push(event);
        this._stats.published++;

        // Trigger processing if running
        if (this.running && !this.processing) {
            await this.processQueue();
        }
    }

    /**
     * Publish without awaiting (fire-and-forget).
     */
    publishSync(event: SwarmEvent): void {
        this.eventQueue.push(event);
        this._stats.published++;

        if (this.running && !this.processing) {
            this.processQueue().catch(() => { });
        }
    }

    // ── Dispatch Loop ───────────────────────────────────────────

    /**
     * Start the event dispatch loop.
     */
    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;

        // Periodic check for queued events
        this.intervalId = setInterval(() => {
            if (!this.processing && this.eventQueue.length > 0) {
                this.processQueue().catch(() => { });
            }
        }, 50);
    }

    /**
     * Gracefully stop the event dispatch loop, processing remaining events.
     */
    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;

        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }

        // Drain remaining events
        await this.processQueue();
    }

    private async processQueue(): Promise<void> {
        if (this.processing) return;
        this.processing = true;

        try {
            while (this.eventQueue.length > 0) {
                const event = this.eventQueue.shift()!;
                await this.dispatchEvent(event);
            }
        } finally {
            this.processing = false;
        }
    }

    private async dispatchEvent(event: SwarmEvent): Promise<void> {
        // Record history
        this.eventHistory.push(event);
        if (this.eventHistory.length > this.maxHistory) {
            this.eventHistory = this.eventHistory.slice(-this.maxHistory);
        }

        // Collect matching handlers
        const handlers: Subscription[] = [];

        // Exact topic match
        const exact = this.subscriptions.get(event.topic);
        if (exact) handlers.push(...exact);

        // Wildcard match: "task.*" matches "task.created", "task.completed", etc.
        for (const [pattern, subs] of this.subscriptions.entries()) {
            if (pattern.endsWith(".*")) {
                const prefix = pattern.slice(0, -2);
                if (event.topic.startsWith(prefix + ".") && event.topic !== pattern) {
                    handlers.push(...subs);
                }
            }
        }

        // Global listeners
        handlers.push(...this.globalSubscriptions);

        // Sort by priority (highest first)
        handlers.sort((a, b) => b.priority - a.priority);

        // Execute handlers concurrently
        if (handlers.length > 0) {
            const tasks = handlers.map((sub) => this.safeCall(sub.handler, event, sub.subscriberId));
            await Promise.allSettled(tasks);
        }

        this._stats.dispatched++;
    }

    private async safeCall(
        handler: EventHandler,
        event: SwarmEvent,
        subscriberId: string,
    ): Promise<void> {
        try {
            await handler(event);
        } catch (err) {
            console.error(`[EventBus] Handler error in subscriber ${subscriberId} for ${event.topic}:`, err);
            this._stats.errors++;
        }
    }

    // ── Introspection ───────────────────────────────────────────

    get stats(): { published: number; dispatched: number; errors: number } {
        return { ...this._stats };
    }

    get subscriptionCount(): number {
        let count = this.globalSubscriptions.length;
        for (const subs of this.subscriptions.values()) {
            count += subs.length;
        }
        return count;
    }

    recentEvents(limit = 20): SwarmEvent[] {
        return this.eventHistory.slice(-limit);
    }
}
