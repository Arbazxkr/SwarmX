/**
 * SwarmX Agent — Base agent class with event-driven lifecycle.
 *
 * Adapted from OpenClaw's agent architecture: agents have isolated state,
 * bind to a provider declaratively, and communicate exclusively through
 * the event bus. No direct agent-to-agent calls are permitted.
 *
 * Agent lifecycle:
 *   1. initialize() — one-time setup, subscribe to events
 *   2. onEvent()    — handle incoming events
 *   3. think()      — process messages through the provider
 *   4. emit()       — publish results back to the bus
 *   5. shutdown()   — cleanup
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

export enum AgentState {
    CREATED = "created",
    INITIALIZING = "initializing",
    IDLE = "idle",
    PROCESSING = "processing",
    ERROR = "error",
    SHUTDOWN = "shutdown",
}

/**
 * Declarative agent configuration.
 * Agents are defined by config — the provider, subscriptions,
 * system prompt, and tools are all declared upfront. This enables
 * config-driven swarm definitions via YAML.
 */
export interface AgentConfig {
    name: string;
    /** Provider name from the registry */
    provider: string;
    /** Override provider's default model */
    model?: string;
    systemPrompt?: string;
    subscriptions?: string[];
    tools?: ToolDefinition[];
    maxHistory?: number;
    temperature?: number;
    metadata?: Record<string, unknown>;
}

/**
 * Base agent class for SwarmX.
 *
 * Agents are autonomous units that:
 *   - Subscribe to events via the EventBus
 *   - Process events through an LLM provider
 *   - Emit response events back to the bus
 *
 * Extend this class to create specialized agents with custom
 * event handling, tool execution, or output formatting.
 */
export class Agent {
    readonly agentId: string;
    state: AgentState = AgentState.CREATED;

    protected messageHistory: Message[] = [];
    protected provider: ProviderBase | null = null;
    private processingLock = false;

    constructor(
        readonly config: AgentConfig,
        protected readonly eventBus: EventBus,
        protected readonly providerRegistry: ProviderRegistry,
    ) {
        this.agentId = `${config.name}-${randomUUID().slice(0, 6)}`;
    }

    // ── Lifecycle ───────────────────────────────────────────────

    /**
     * Initialize the agent: resolve provider, set up subscriptions.
     * Called once by the engine before the agent starts processing.
     */
    async initialize(): Promise<void> {
        this.state = AgentState.INITIALIZING;

        // Resolve provider from registry
        this.provider = this.providerRegistry.get(this.config.provider);

        // Set system prompt
        if (this.config.systemPrompt) {
            this.messageHistory.push({
                role: Role.SYSTEM,
                content: this.config.systemPrompt,
            });
        }

        // Subscribe to configured topics
        const topics = this.config.subscriptions ?? [];
        for (const topic of topics) {
            this.eventBus.subscribe(topic, (event) => this.handleEvent(event), this.agentId);
        }

        this.state = AgentState.IDLE;
    }

    /**
     * Gracefully shut down the agent.
     */
    async shutdown(): Promise<void> {
        this.state = AgentState.SHUTDOWN;
        this.eventBus.unsubscribe(this.agentId);
    }

    // ── Event Handling ──────────────────────────────────────────

    private async handleEvent(event: SwarmEvent): Promise<void> {
        if (this.processingLock) return; // Skip if already processing
        this.processingLock = true;
        this.state = AgentState.PROCESSING;

        try {
            await this.onEvent(event);
        } catch (err) {
            this.state = AgentState.ERROR;
            console.error(`[Agent ${this.agentId}] Error processing event ${event.topic}:`, err);
            await this.emit("agent.error", {
                agentId: this.agentId,
                eventTopic: event.topic,
                error: err instanceof Error ? err.message : "Processing failed",
            });
        } finally {
            if (this.state === AgentState.PROCESSING) {
                this.state = AgentState.IDLE;
            }
            this.processingLock = false;
        }
    }

    /**
     * Handle an incoming event.
     *
     * Default implementation extracts a user message from the event
     * payload and sends it through the provider. Override this for
     * custom event handling logic.
     */
    async onEvent(event: SwarmEvent): Promise<void> {
        const content =
            (event.payload.content as string) ?? (event.payload.message as string) ?? "";

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

    /**
     * Process user input through the LLM provider.
     * Manages conversation history and returns the provider's response.
     */
    async think(userInput: string): Promise<CompletionResponse | null> {
        if (!this.provider) {
            console.error(`[Agent ${this.agentId}] No provider bound`);
            return null;
        }

        // Add user message to history
        this.messageHistory.push({ role: Role.USER, content: userInput });

        // Trim history if needed
        const maxHistory = this.config.maxHistory ?? 50;
        if (this.messageHistory.length > maxHistory) {
            const systemMsgs = this.messageHistory.filter((m) => m.role === Role.SYSTEM);
            const recent = this.messageHistory.slice(-(maxHistory - systemMsgs.length));
            this.messageHistory = [...systemMsgs, ...recent];
        }

        // Call provider
        const overrides: Record<string, unknown> = {};
        if (this.config.model) overrides.model = this.config.model;
        if (this.config.temperature !== undefined) overrides.temperature = this.config.temperature;

        const response = await this.provider.complete(
            this.messageHistory,
            this.config.tools ?? undefined,
            overrides,
        );

        // Add assistant response to history
        this.messageHistory.push(response.message);

        return response;
    }

    // ── Event Emission ──────────────────────────────────────────

    /**
     * Publish an event to the bus from this agent.
     */
    async emit(
        topic: string,
        payload: Record<string, unknown>,
        priority: EventPriority = EventPriority.NORMAL,
    ): Promise<void> {
        const event = createEvent({
            topic,
            payload,
            source: this.agentId,
            priority,
        });
        await this.eventBus.publish(event);
    }

    // ── Introspection ───────────────────────────────────────────

    get history(): Message[] {
        return [...this.messageHistory];
    }

    toString(): string {
        return `<Agent '${this.agentId}' state=${this.state} provider=${this.config.provider}>`;
    }
}
