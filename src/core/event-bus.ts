/**
 * Groklets Event Bus — Central non-blocking event routing system.
 *
 * The EventBus is the nervous system of every swarm. Agents subscribe
 * to topics, emit events, and the bus routes them. No direct coupling
 * between agents — everything flows through events.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const log = createLogger("EventBus");

export enum EventPriority {
    LOW = 0,
    NORMAL = 1,
    HIGH = 2,
    CRITICAL = 3,
}

export interface SwarmEvent {
    topic: string;
    payload: Record<string, unknown>;
    source: string;
    eventId: string;
    timestamp: number;
    priority: EventPriority;
    metadata: Record<string, unknown>;
}

export type EventHandler = (event: SwarmEvent) => Promise<void>;

interface Subscription {
    handler: EventHandler;
    subscriberId: string;
    topicPattern: string;
    priority: EventPriority;
}

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
 * Central async event bus for Groklets.
 *
 * Supports topic routing with wildcards:
 *   "task.created"   → exact match
 *   "task.*"         → matches task.created, task.completed, etc.
 *   "*"              → global listener
 */
export class EventBus {
    private subscriptions = new Map<string, Subscription[]>();
    private globalSubscriptions: Subscription[] = [];
    private eventQueue: SwarmEvent[] = [];
    private processing = false;
    private running = false;
    private eventHistory: SwarmEvent[] = [];
    private maxHistory: number;
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private _stats = { published: 0, dispatched: 0, errors: 0 };

    constructor(opts?: { maxHistory?: number }) {
        this.maxHistory = opts?.maxHistory ?? 1000;
    }

    // ── Subscriptions ───────────────────────────────────────────

    subscribe(
        topic: string,
        handler: EventHandler,
        subscriberId?: string,
        priority: EventPriority = EventPriority.NORMAL,
    ): string {
        const id = subscriberId ?? randomUUID().slice(0, 8);
        const sub: Subscription = { handler, subscriberId: id, topicPattern: topic, priority };

        if (topic === "*") {
            this.globalSubscriptions.push(sub);
        } else {
            const existing = this.subscriptions.get(topic) ?? [];
            existing.push(sub);
            this.subscriptions.set(topic, existing);
        }

        log.debug(`Subscribed ${id} → ${topic}`);
        return id;
    }

    unsubscribe(subscriberId: string): number {
        let removed = 0;

        for (const [topic, subs] of this.subscriptions.entries()) {
            const before = subs.length;
            const filtered = subs.filter((s) => s.subscriberId !== subscriberId);
            removed += before - filtered.length;
            if (filtered.length === 0) this.subscriptions.delete(topic);
            else this.subscriptions.set(topic, filtered);
        }

        const beforeGlobal = this.globalSubscriptions.length;
        this.globalSubscriptions = this.globalSubscriptions.filter(
            (s) => s.subscriberId !== subscriberId,
        );
        removed += beforeGlobal - this.globalSubscriptions.length;

        if (removed > 0) log.debug(`Unsubscribed ${subscriberId} (${removed} handlers)`);
        return removed;
    }

    // ── Publishing ──────────────────────────────────────────────

    async publish(event: SwarmEvent): Promise<void> {
        this.eventQueue.push(event);
        this._stats.published++;
        log.debug(`Published [${event.eventId}] ${event.topic} from ${event.source}`);

        if (this.running && !this.processing) {
            await this.processQueue();
        }
    }

    publishSync(event: SwarmEvent): void {
        this.eventQueue.push(event);
        this._stats.published++;
        if (this.running && !this.processing) {
            this.processQueue().catch(() => { });
        }
    }

    // ── Dispatch ────────────────────────────────────────────────

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.intervalId = setInterval(() => {
            if (!this.processing && this.eventQueue.length > 0) {
                this.processQueue().catch(() => { });
            }
        }, 50);
        log.info("Event bus started");
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        await this.processQueue();
        log.info(`Event bus stopped — ${this._stats.published} published, ${this._stats.dispatched} dispatched, ${this._stats.errors} errors`);
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
        this.eventHistory.push(event);
        if (this.eventHistory.length > this.maxHistory) {
            this.eventHistory = this.eventHistory.slice(-this.maxHistory);
        }

        const handlers: Subscription[] = [];

        // Exact topic match
        const exact = this.subscriptions.get(event.topic);
        if (exact) handlers.push(...exact);

        // Wildcard match
        for (const [pattern, subs] of this.subscriptions.entries()) {
            if (pattern.endsWith(".*")) {
                const prefix = pattern.slice(0, -2);
                if (event.topic.startsWith(prefix + ".") && event.topic !== pattern) {
                    handlers.push(...subs);
                }
            }
        }

        // Global
        handlers.push(...this.globalSubscriptions);

        // Priority sort
        handlers.sort((a, b) => b.priority - a.priority);

        if (handlers.length > 0) {
            await Promise.allSettled(
                handlers.map((sub) => this.safeCall(sub.handler, event, sub.subscriberId)),
            );
        }

        this._stats.dispatched++;
    }

    private async safeCall(handler: EventHandler, event: SwarmEvent, subscriberId: string): Promise<void> {
        try {
            await handler(event);
        } catch (err) {
            log.error(`Handler error [${subscriberId}] on ${event.topic}: ${err}`);
            this._stats.errors++;
        }
    }

    // ── Introspection ───────────────────────────────────────────

    get stats() { return { ...this._stats }; }
    get subscriptionCount(): number {
        let c = this.globalSubscriptions.length;
        for (const s of this.subscriptions.values()) c += s.length;
        return c;
    }
    recentEvents(limit = 20): SwarmEvent[] { return this.eventHistory.slice(-limit); }
}
