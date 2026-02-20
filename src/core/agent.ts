/**
 * SwarmX Agent — Base agent with event-driven lifecycle.
 *
 * Agents have isolated state, bind to a provider declaratively,
 * and communicate exclusively through the event bus.
 *
 * Lifecycle: initialize → onEvent → think → emit → shutdown
 */

import { randomUUID } from "node:crypto";
import { EventBus, createEvent, type SwarmEvent, EventPriority } from "./event-bus.js";
import {
    type ProviderBase,
    type ProviderRegistry,
    type Message,
    type CompletionResponse,
    type ToolDefinition,
    Role,
} from "./provider.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Agent");

export enum AgentState {
    CREATED = "created",
    INITIALIZING = "initializing",
    IDLE = "idle",
    PROCESSING = "processing",
    ERROR = "error",
    SHUTDOWN = "shutdown",
}

export interface AgentConfig {
    name: string;
    provider: string;
    model?: string;
    systemPrompt?: string;
    subscriptions?: string[];
    tools?: ToolDefinition[];
    maxHistory?: number;
    temperature?: number;
    metadata?: Record<string, unknown>;
}

export class Agent {
    readonly agentId: string;
    state: AgentState = AgentState.CREATED;

    protected messageHistory: Message[] = [];
    protected provider: ProviderBase | null = null;
    private processingLock = false;
    private log: ReturnType<typeof createLogger>;

    constructor(
        readonly config: AgentConfig,
        protected readonly eventBus: EventBus,
        protected readonly providerRegistry: ProviderRegistry,
    ) {
        this.agentId = `${config.name}-${randomUUID().slice(0, 6)}`;
        this.log = createLogger(`Agent:${this.agentId}`);
    }

    // ── Lifecycle ───────────────────────────────────────────────

    async initialize(): Promise<void> {
        this.state = AgentState.INITIALIZING;

        this.provider = this.providerRegistry.get(this.config.provider);
        this.log.info(`Bound to provider: ${this.config.provider}`);

        if (this.config.systemPrompt) {
            this.messageHistory.push({ role: Role.SYSTEM, content: this.config.systemPrompt });
        }

        const topics = this.config.subscriptions ?? [];
        for (const topic of topics) {
            this.eventBus.subscribe(topic, (event) => this.handleEvent(event), this.agentId);
        }

        this.state = AgentState.IDLE;
        this.log.info(`Ready (subscriptions: ${topics.join(", ") || "none"})`);
    }

    async shutdown(): Promise<void> {
        this.state = AgentState.SHUTDOWN;
        this.eventBus.unsubscribe(this.agentId);
        this.log.info("Shut down");
    }

    // ── Event Handling ──────────────────────────────────────────

    private async handleEvent(event: SwarmEvent): Promise<void> {
        if (this.processingLock) return;
        this.processingLock = true;
        this.state = AgentState.PROCESSING;

        try {
            await this.onEvent(event);
        } catch (err) {
            this.state = AgentState.ERROR;
            this.log.error(`Error processing ${event.topic}: ${err}`);
            await this.emit("agent.error", {
                agentId: this.agentId,
                eventTopic: event.topic,
                error: err instanceof Error ? err.message : String(err),
            });
        } finally {
            if (this.state === AgentState.PROCESSING) this.state = AgentState.IDLE;
            this.processingLock = false;
        }
    }

    /**
     * Handle an incoming event. Override for custom behavior.
     */
    async onEvent(event: SwarmEvent): Promise<void> {
        const content = (event.payload.content as string) ?? (event.payload.message as string) ?? "";
        if (!content) return;

        const response = await this.think(content);
        if (response) {
            await this.emit(`agent.response.${this.config.name}`, {
                agentId: this.agentId,
                content: response.message.content,
                model: response.model,
                usage: response.usage,
                sourceEvent: event.eventId,
            });
        }
    }

    // ── Core Intelligence ───────────────────────────────────────

    async think(userInput: string): Promise<CompletionResponse | null> {
        if (!this.provider) {
            this.log.error("No provider bound");
            return null;
        }

        this.messageHistory.push({ role: Role.USER, content: userInput });

        // Trim history
        const max = this.config.maxHistory ?? 50;
        if (this.messageHistory.length > max) {
            const sys = this.messageHistory.filter((m) => m.role === Role.SYSTEM);
            const recent = this.messageHistory.slice(-(max - sys.length));
            this.messageHistory = [...sys, ...recent];
        }

        const overrides: Record<string, unknown> = {};
        if (this.config.model) overrides.model = this.config.model;
        if (this.config.temperature !== undefined) overrides.temperature = this.config.temperature;

        const response = await this.provider.complete(
            this.messageHistory,
            this.config.tools ?? undefined,
            overrides,
        );

        this.messageHistory.push(response.message);
        this.log.debug(`Completed (${response.usage.totalTokens} tokens)`);
        return response;
    }

    // ── Emission ────────────────────────────────────────────────

    async emit(
        topic: string,
        payload: Record<string, unknown>,
        priority: EventPriority = EventPriority.NORMAL,
    ): Promise<void> {
        await this.eventBus.publish(createEvent({ topic, payload, source: this.agentId, priority }));
    }

    // ── Introspection ───────────────────────────────────────────

    get history(): Message[] { return [...this.messageHistory]; }
    toString(): string { return `<Agent ${this.agentId} state=${this.state}>`; }
}
