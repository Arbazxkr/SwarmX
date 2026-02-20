/**
 * SwarmX Channel Adapter — Base interface for messaging platforms.
 *
 * Every channel adapter (WhatsApp, Telegram, Discord, Slack, WebChat)
 * implements this interface to bridge external messages ↔ event bus.
 *
 * Flow:
 *   Platform message → adapter.onMessage() → eventBus.publish(channel.message.*)
 *   eventBus agent.response.* → adapter.sendMessage() → Platform reply
 */

import { type SwarmEngine } from "../core/engine.js";
import { createEvent, type SwarmEvent } from "../core/event-bus.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Channel");

export interface ChannelMessage {
    /** Unique message ID from the platform */
    messageId: string;
    /** Sender ID (phone number, user ID, etc.) */
    senderId: string;
    /** Sender display name */
    senderName: string;
    /** Message content */
    content: string;
    /** Channel type */
    channel: string;
    /** Chat/group ID */
    chatId: string;
    /** Is this a group message? */
    isGroup: boolean;
    /** Raw platform-specific data */
    raw?: unknown;
    /** Timestamp */
    timestamp: number;
}

export interface ChannelConfig {
    /** Channel name identifier */
    name: string;
    /** Which agent to route messages to (default: all via task.created) */
    targetAgent?: string;
    /** Target event topic (default: task.created) */
    targetTopic?: string;
    /** Allowed sender IDs (empty = allow all) */
    allowedSenders?: string[];
    /** Auto-reply while processing */
    typingIndicator?: boolean;
}

export abstract class ChannelAdapter {
    readonly name: string;
    protected engine: SwarmEngine;
    protected config: ChannelConfig;
    protected running = false;
    protected log: ReturnType<typeof createLogger>;

    constructor(engine: SwarmEngine, config: ChannelConfig) {
        this.engine = engine;
        this.config = config;
        this.name = config.name;
        this.log = createLogger(`Channel:${config.name}`);
    }

    // ── Lifecycle ───────────────────────────────────────────────

    async start(): Promise<void> {
        // Subscribe to agent responses to send back
        this.engine.eventBus.subscribe(
            "agent.response.*",
            async (event) => this.handleAgentResponse(event),
            `channel-${this.name}`,
        );

        await this.connect();
        this.running = true;
        this.log.info("Channel started");
    }

    async stop(): Promise<void> {
        this.running = false;
        this.engine.eventBus.unsubscribe(`channel-${this.name}`);
        await this.disconnect();
        this.log.info("Channel stopped");
    }

    // ── Abstract Methods (implement per platform) ───────────────

    /** Connect to the messaging platform */
    protected abstract connect(): Promise<void>;

    /** Disconnect from the platform */
    protected abstract disconnect(): Promise<void>;

    /** Send a message back to the platform */
    abstract sendMessage(chatId: string, content: string): Promise<void>;

    // ── Message Routing ─────────────────────────────────────────

    /**
     * Called when a message arrives from the platform.
     * Routes it into the event bus.
     */
    protected async onMessage(msg: ChannelMessage): Promise<void> {
        // Access control
        if (this.config.allowedSenders?.length) {
            if (!this.config.allowedSenders.includes(msg.senderId)) {
                this.log.debug(`Blocked message from ${msg.senderId} (not in allowlist)`);
                return;
            }
        }

        this.log.info(`Message from ${msg.senderName} (${msg.senderId}): ${msg.content.slice(0, 80)}`);

        // Publish to event bus
        const topic = this.config.targetTopic ?? "task.created";
        await this.engine.eventBus.publish(createEvent({
            topic,
            payload: {
                content: msg.content,
                senderId: msg.senderId,
                senderName: msg.senderName,
                chatId: msg.chatId,
                channel: this.name,
                messageId: msg.messageId,
                isGroup: msg.isGroup,
            },
            source: `channel:${this.name}`,
            metadata: {
                channel: this.name,
                chatId: msg.chatId,
                senderId: msg.senderId,
            },
        }));
    }

    /**
     * Called when an agent responds. Routes response back to the platform.
     */
    protected async handleAgentResponse(event: SwarmEvent): Promise<void> {
        const content = event.payload.content as string;
        if (!content) return;

        // Find the original chat ID from the source event
        const sourceEvent = event.payload.sourceEvent as string;
        const chatId = event.payload.chatId as string;
        const channel = event.payload.channel as string;

        // Only handle responses meant for this channel
        if (channel && channel !== this.name) return;

        // If we have a chatId, reply directly
        if (chatId) {
            await this.sendMessage(chatId, content);
            return;
        }

        // Otherwise, try to find last chat from this channel
        // (this is a fallback — ideally responses carry chatId)
        this.log.debug("Agent response without chatId — cannot route to platform");
    }

    // ── Introspection ───────────────────────────────────────────

    get isRunning() { return this.running; }

    status(): Record<string, unknown> {
        return {
            name: this.name,
            running: this.running,
            targetTopic: this.config.targetTopic ?? "task.created",
            targetAgent: this.config.targetAgent,
            allowedSenders: this.config.allowedSenders?.length ?? 0,
        };
    }
}
