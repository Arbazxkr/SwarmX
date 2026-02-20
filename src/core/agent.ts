/**
 * SwarmX Agent — Production-grade agent with full lifecycle.
 *
 * Features:
 *   - Event-driven communication via the EventBus
 *   - Session persistence (survives restarts)
 *   - Context window management (auto-prune / compact)
 *   - Tool execution loop
 *   - Usage tracking per agent
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
import { ToolExecutor, type ToolFunction } from "./tool-executor.js";
import { ContextManager, type ContextConfig } from "./context.js";
import { SessionStore } from "./session.js";
import { UsageTracker } from "./usage.js";
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
    context?: ContextConfig;
    persistSessions?: boolean;
}

export class Agent {
    readonly agentId: string;
    state: AgentState = AgentState.CREATED;

    protected messageHistory: Message[] = [];
    protected provider: ProviderBase | null = null;
    private processingLock = false;
    private log: ReturnType<typeof createLogger>;

    // Production features
    readonly toolExecutor: ToolExecutor;
    readonly contextManager: ContextManager;
    readonly usageTracker: UsageTracker;
    private sessionStore: SessionStore | null = null;
    private currentSessionId: string | null = null;

    constructor(
        readonly config: AgentConfig,
        protected readonly eventBus: EventBus,
        protected readonly providerRegistry: ProviderRegistry,
        sessionStore?: SessionStore,
    ) {
        this.agentId = `${config.name}-${randomUUID().slice(0, 6)}`;
        this.log = createLogger(`Agent:${this.agentId}`);

        this.toolExecutor = new ToolExecutor({ maxIterations: 10, toolTimeoutMs: 30_000 });
        this.contextManager = new ContextManager(config.context);
        this.usageTracker = new UsageTracker();

        if (sessionStore || config.persistSessions !== false) {
            this.sessionStore = sessionStore ?? new SessionStore();
        }
    }

    // ── Lifecycle ───────────────────────────────────────────────

    async initialize(): Promise<void> {
        this.state = AgentState.INITIALIZING;

        this.provider = this.providerRegistry.get(this.config.provider);
        this.log.info(`Bound to provider: ${this.config.provider}`);

        // Load or create session
        if (this.sessionStore) {
            const session = this.sessionStore.getOrCreate(this.agentId);
            this.currentSessionId = session.sessionId;
            if (session.messages.length > 0) {
                this.messageHistory = [...session.messages];
                this.log.info(`Restored session: ${session.messages.length} messages`);
            }
        }

        // Add system prompt if not already present
        if (this.config.systemPrompt && !this.messageHistory.some((m) => m.role === Role.SYSTEM)) {
            this.messageHistory.unshift({ role: Role.SYSTEM, content: this.config.systemPrompt });
        }

        // Subscribe to events
        const topics = this.config.subscriptions ?? [];
        for (const topic of topics) {
            this.eventBus.subscribe(topic, (event) => this.handleEvent(event), this.agentId);
        }

        this.state = AgentState.IDLE;
        this.log.info(`Ready (subscriptions: ${topics.join(", ") || "none"}, tools: ${this.toolExecutor.registeredTools.length})`);
    }

    async shutdown(): Promise<void> {
        // Persist session before shutdown
        if (this.sessionStore && this.currentSessionId) {
            this.sessionStore.save(this.currentSessionId);
            this.log.debug("Session saved");
        }

        this.state = AgentState.SHUTDOWN;
        this.eventBus.unsubscribe(this.agentId);
        this.log.info(`Shut down (usage: ${this.usageTracker.summary.costFormatted})`);
    }

    // ── Tools ───────────────────────────────────────────────────

    /**
     * Register a tool the agent can use during think().
     */
    registerTool(
        name: string,
        description: string,
        parameters: Record<string, unknown>,
        fn: ToolFunction,
    ): void {
        this.toolExecutor.register(name, description, parameters, fn);
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

        // Add user message
        this.messageHistory.push({ role: Role.USER, content: userInput });

        // Context pruning
        if (this.contextManager.needsPruning(this.messageHistory)) {
            this.log.debug("Context window full, pruning...");
            this.messageHistory = this.contextManager.prune(this.messageHistory);
        }

        const overrides: Record<string, unknown> = {};
        if (this.config.model) overrides.model = this.config.model;
        if (this.config.temperature !== undefined) overrides.temperature = this.config.temperature;

        let response: CompletionResponse;

        // If agent has tools, use the tool execution loop
        if (this.toolExecutor.registeredTools.length > 0) {
            const result = await this.toolExecutor.execute(this.provider, this.messageHistory);
            response = result.response;
            // Replace history with the full loop conversation
            this.messageHistory = result.messages;
        } else {
            response = await this.provider.complete(
                this.messageHistory,
                this.config.tools ?? undefined,
                overrides,
            );
            this.messageHistory.push(response.message);
        }

        // Track usage
        this.usageTracker.track(
            response.model,
            response.usage.promptTokens,
            response.usage.completionTokens,
        );

        // Persist to session
        if (this.sessionStore && this.currentSessionId) {
            this.sessionStore.addMessage(this.currentSessionId, { role: Role.USER, content: userInput });
            this.sessionStore.addMessage(this.currentSessionId, response.message);
        }

        this.log.debug(`Completed (${response.usage.totalTokens} tokens, ${this.usageTracker.summary.costFormatted} total)`);
        return response;
    }

    /**
     * Compact the conversation history using LLM summarization.
     */
    async compact(): Promise<void> {
        if (!this.provider) return;
        this.messageHistory = await this.contextManager.compact(this.messageHistory, this.provider);
    }

    /**
     * Reset the conversation (start a new session).
     */
    resetSession(): void {
        const systemMsgs = this.messageHistory.filter((m) => m.role === Role.SYSTEM);
        this.messageHistory = [...systemMsgs];

        if (this.sessionStore) {
            const session = this.sessionStore.create(this.agentId);
            this.currentSessionId = session.sessionId;
        }

        this.log.info("Session reset");
    }

    // ── Emission ────────────────────────────────────────────────

    async emit(
        topic: string,
        payload: Record<string, unknown>,
        priority: EventPriority = EventPriority.NORMAL,
    ): Promise<void> {
        await this.eventBus.publish(createEvent({ topic, payload, source: this.agentId, priority }));
    }

    // ── Streaming ──────────────────────────────────────────────

    /**
     * Stream a response token-by-token.
     * Yields each token as it arrives from the provider.
     */
    async *thinkStream(userInput: string): AsyncIterable<string> {
        if (!this.provider?.stream) {
            // Fallback to non-streaming
            const response = await this.think(userInput);
            if (response) yield response.message.content;
            return;
        }

        this.messageHistory.push({ role: Role.USER, content: userInput });

        if (this.contextManager.needsPruning(this.messageHistory)) {
            this.messageHistory = this.contextManager.prune(this.messageHistory);
        }

        const overrides: Record<string, unknown> = {};
        if (this.config.model) overrides.model = this.config.model;
        if (this.config.temperature !== undefined) overrides.temperature = this.config.temperature;

        let fullContent = "";
        for await (const token of this.provider.stream(this.messageHistory, undefined, overrides)) {
            fullContent += token;
            yield token;
        }

        // Add to history
        this.messageHistory.push({ role: Role.ASSISTANT, content: fullContent });

        // Persist
        if (this.sessionStore && this.currentSessionId) {
            this.sessionStore.addMessage(this.currentSessionId, { role: Role.USER, content: userInput });
            this.sessionStore.addMessage(this.currentSessionId, { role: Role.ASSISTANT, content: fullContent });
        }

        // Emit response event
        await this.emit(`agent.response.${this.config.name}`, {
            agentId: this.agentId,
            content: fullContent,
            streamed: true,
        });
    }

    // ── Introspection ───────────────────────────────────────────

    get history(): Message[] { return [...this.messageHistory]; }
    get contextUsage() { return this.contextManager.usage(this.messageHistory); }
    toString(): string { return `<Agent ${this.agentId} state=${this.state}>`; }
}
