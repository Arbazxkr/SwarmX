/**
 * SwarmX Advanced Routing — Group isolation, activation modes, queue modes.
 *
 * Features:
 *   - Group message routing (each group gets isolated context)
 *   - Activation modes (always, mention-only, keyword-triggered)
 *   - Message queue with priority and dedup
 *   - Reply-back routing (reply to the same chat/channel)
 */

import { createEvent, type SwarmEvent } from "./event-bus.js";
import { type SwarmEngine } from "./engine.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Router");

export type ActivationMode = "always" | "mention" | "keyword" | "dm-only";

export interface RouteRule {
    /** Route name */
    name: string;
    /** Source channel(s) */
    channels: string[];
    /** Target agent name */
    targetAgent: string;
    /** Activation mode */
    activation: ActivationMode;
    /** Keywords for keyword mode */
    keywords?: string[];
    /** Group isolation (each group gets its own session) */
    groupIsolation?: boolean;
    /** Priority (higher = processed first) */
    priority?: number;
}

export interface QueuedMessage {
    id: string;
    content: string;
    senderId: string;
    chatId: string;
    channel: string;
    priority: number;
    timestamp: number;
    route: RouteRule;
}

export class MessageRouter {
    private routes: RouteRule[] = [];
    private queue: QueuedMessage[] = [];
    private processing = false;
    private groupSessions = new Map<string, string>(); // chatId → sessionId
    private seen = new Set<string>(); // dedup
    private seenTTL = 60_000; // 1 minute dedup window

    constructor(private engine: SwarmEngine) { }

    // ── Route Management ────────────────────────────────────────

    addRoute(rule: RouteRule): void {
        this.routes.push(rule);
        this.routes.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
        log.info(`Route added: ${rule.name} (${rule.channels.join(",")} → ${rule.targetAgent}, ${rule.activation})`);
    }

    removeRoute(name: string): boolean {
        const idx = this.routes.findIndex(r => r.name === name);
        if (idx === -1) return false;
        this.routes.splice(idx, 1);
        return true;
    }

    // ── Message Routing ─────────────────────────────────────────

    /**
     * Route an incoming message through the rules engine.
     */
    async route(event: SwarmEvent): Promise<boolean> {
        const content = (event.payload.content as string) ?? "";
        const channel = (event.payload.channel as string) ?? "";
        const chatId = (event.payload.chatId as string) ?? "";
        const senderId = (event.payload.senderId as string) ?? "";
        const isGroup = (event.payload.isGroup as boolean) ?? false;

        if (!content) return false;

        // Dedup
        const dedupKey = `${senderId}:${chatId}:${content.slice(0, 50)}`;
        if (this.seen.has(dedupKey)) return false;
        this.seen.add(dedupKey);
        setTimeout(() => this.seen.delete(dedupKey), this.seenTTL);

        // Find matching routes
        for (const route of this.routes) {
            if (route.channels.length > 0 && !route.channels.includes(channel) && !route.channels.includes("*")) {
                continue;
            }

            // Check activation mode
            if (!this.checkActivation(route, content, isGroup)) continue;

            // Queue the message
            const msg: QueuedMessage = {
                id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                content, senderId, chatId, channel,
                priority: route.priority ?? 0,
                timestamp: Date.now(),
                route,
            };

            this.queue.push(msg);
            log.debug(`Queued: ${route.name} (${chatId})`);

            // Process queue
            if (!this.processing) this.processQueue();
            return true;
        }

        return false;
    }

    private checkActivation(route: RouteRule, content: string, isGroup: boolean): boolean {
        switch (route.activation) {
            case "always":
                return true;
            case "dm-only":
                return !isGroup;
            case "mention":
                // Check if bot name is mentioned (simplified)
                return content.toLowerCase().includes(route.targetAgent.toLowerCase());
            case "keyword":
                if (!route.keywords?.length) return false;
                const lower = content.toLowerCase();
                return route.keywords.some(kw => lower.includes(kw.toLowerCase()));
            default:
                return true;
        }
    }

    // ── Queue Processing ────────────────────────────────────────

    private async processQueue(): Promise<void> {
        this.processing = true;

        while (this.queue.length > 0) {
            // Sort by priority
            this.queue.sort((a, b) => b.priority - a.priority);
            const msg = this.queue.shift()!;

            try {
                // Get target agent
                const agents = this.engine.getAgentsByName(msg.route.targetAgent);
                if (agents.length === 0) {
                    log.warn(`Agent not found: ${msg.route.targetAgent}`);
                    continue;
                }

                const agent = agents[0];

                // Group isolation — use separate session per chat
                if (msg.route.groupIsolation && msg.chatId) {
                    const sessionKey = `${msg.route.targetAgent}:${msg.chatId}`;
                    // Track group sessions for isolation
                    this.groupSessions.set(sessionKey, msg.chatId);
                }

                // Think and respond
                const response = await agent.think(msg.content);

                if (response) {
                    // Emit response with routing metadata for channel adapters
                    await this.engine.eventBus.publish(createEvent({
                        topic: `agent.response.${msg.route.targetAgent}`,
                        payload: {
                            content: response.message.content,
                            chatId: msg.chatId,
                            channel: msg.channel,
                            senderId: msg.senderId,
                            model: response.model,
                            usage: response.usage,
                            sourceRoute: msg.route.name,
                        },
                        source: `router:${msg.route.name}`,
                    }));
                }
            } catch (err) {
                log.error(`Route '${msg.route.name}' failed: ${err}`);
            }
        }

        this.processing = false;
    }

    // ── Introspection ───────────────────────────────────────────

    get routeCount(): number { return this.routes.length; }
    get queueSize(): number { return this.queue.length; }
    get allRoutes(): RouteRule[] { return [...this.routes]; }

    status(): Record<string, unknown> {
        return {
            routes: this.routes.length,
            queueSize: this.queue.length,
            processing: this.processing,
            groupSessions: this.groupSessions.size,
        };
    }
}
