/**
 * SwarmX Engine — Core orchestration engine.
 *
 * The SwarmEngine is the top-level coordinator that wires together the
 * event bus, task scheduler, provider registry, and agents.
 *
 * Adapted from OpenClaw's Gateway pattern: the Gateway acts as the single
 * control plane for sessions, channels, tools, and events. The SwarmEngine
 * serves the same role for multi-agent orchestration.
 */

import { EventBus, createEvent, type SwarmEvent } from "./event-bus.js";
import { Agent, type AgentConfig } from "./agent.js";
import { ProviderRegistry, type ProviderBase, type ProviderConfig } from "./provider.js";
import { TaskScheduler, createTask, type Task } from "./scheduler.js";

export class SwarmEngine {
    readonly eventBus: EventBus;
    readonly providerRegistry: ProviderRegistry;
    readonly scheduler: TaskScheduler;

    private agents = new Map<string, Agent>();
    private _running = false;

    constructor(eventBus?: EventBus) {
        this.eventBus = eventBus ?? new EventBus();
        this.providerRegistry = new ProviderRegistry();
        this.scheduler = new TaskScheduler(this.eventBus);

        // Register built-in provider classes
        this.registerBuiltinProviders();

        // Subscribe to engine-level events
        this.eventBus.subscribe(
            "agent.response.*",
            (event) => this.onAgentResponse(event),
            "engine",
        );
        this.eventBus.subscribe(
            "agent.error",
            (event) => this.onAgentError(event),
            "engine",
        );
    }

    // ── Provider Management ─────────────────────────────────────

    private registerBuiltinProviders(): void {
        try {
            // Lazy imports handled at creation time
        } catch {
            // Individual providers will throw if their SDK is missing
        }
    }

    /**
     * Register a provider by instance or by config.
     */
    registerProvider(name: string, provider: ProviderBase): void;
    registerProvider(
        name: string,
        providerClass: new (config: ProviderConfig) => ProviderBase,
        config: ProviderConfig,
    ): void;
    registerProvider(
        name: string,
        providerOrClass: ProviderBase | (new (config: ProviderConfig) => ProviderBase),
        config?: ProviderConfig,
    ): void {
        if (config && typeof providerOrClass === "function") {
            // It's a class + config
            const instance = new providerOrClass(config);
            this.providerRegistry.registerInstance(name, instance);
        } else {
            // It's an instance
            this.providerRegistry.registerInstance(name, providerOrClass as ProviderBase);
        }
    }

    // ── Agent Management ────────────────────────────────────────

    /**
     * Create and register an agent.
     */
    addAgent(config: AgentConfig, AgentClass?: new (...args: ConstructorParameters<typeof Agent>) => Agent): Agent {
        const Cls = AgentClass ?? Agent;
        const agent = new Cls(config, this.eventBus, this.providerRegistry);
        this.agents.set(agent.agentId, agent);
        return agent;
    }

    getAgent(agentId: string): Agent | undefined {
        return this.agents.get(agentId);
    }

    getAgentsByName(name: string): Agent[] {
        return [...this.agents.values()].filter((a) => a.config.name === name);
    }

    // ── Task Submission ─────────────────────────────────────────

    /**
     * Submit a task to the swarm.
     * This is the primary way to send work into the system.
     */
    async submitTask(
        content: string,
        opts?: { name?: string; targetTopic?: string; payload?: Record<string, unknown> },
    ): Promise<string> {
        const task = createTask({
            name: opts?.name ?? content.slice(0, 50),
            description: content,
            targetTopic: opts?.targetTopic ?? "task.created",
            payload: { content, ...opts?.payload },
        });
        return this.scheduler.submit(task);
    }

    /**
     * Publish an event to the bus directly.
     */
    async broadcast(topic: string, payload: Record<string, unknown>): Promise<void> {
        const event = createEvent({ topic, payload, source: "engine" });
        await this.eventBus.publish(event);
    }

    // ── Lifecycle ───────────────────────────────────────────────

    /**
     * Start the SwarmX engine.
     * Initializes all agents, starts the event bus, and begins scheduling.
     */
    async start(): Promise<void> {
        if (this._running) return;

        // Start event bus first
        await this.eventBus.start();

        // Initialize all agents
        const initTasks = [...this.agents.values()].map((agent) =>
            agent.initialize().catch((err) => {
                console.error(`Failed to initialize agent ${agent.agentId}:`, err);
            }),
        );
        await Promise.allSettled(initTasks);

        // Start scheduler
        await this.scheduler.start();

        this._running = true;
    }

    /**
     * Gracefully shut down all subsystems.
     */
    async stop(): Promise<void> {
        if (!this._running) return;

        // Shutdown agents
        const shutdownTasks = [...this.agents.values()].map((agent) =>
            agent.shutdown().catch(() => { }),
        );
        await Promise.allSettled(shutdownTasks);

        // Stop scheduler
        await this.scheduler.stop();

        // Stop event bus last
        await this.eventBus.stop();

        this._running = false;
    }

    // ── Internal Event Handlers ─────────────────────────────────

    private async onAgentResponse(event: SwarmEvent): Promise<void> {
        // Available for subclassing or middleware
    }

    private async onAgentError(event: SwarmEvent): Promise<void> {
        const agentId = event.payload.agentId as string;
        console.error(`[Engine] Agent error from ${agentId}:`, event.payload);
    }

    // ── Introspection ───────────────────────────────────────────

    get allAgents(): Map<string, Agent> {
        return new Map(this.agents);
    }

    get isRunning(): boolean {
        return this._running;
    }

    status(): Record<string, unknown> {
        const agentStatus: Record<string, unknown> = {};
        for (const [id, agent] of this.agents) {
            agentStatus[id] = {
                name: agent.config.name,
                state: agent.state,
                provider: agent.config.provider,
            };
        }

        return {
            running: this._running,
            agents: agentStatus,
            providers: this.providerRegistry.available,
            eventBus: this.eventBus.stats,
            scheduler: {
                pending: this.scheduler.pendingCount,
                running: this.scheduler.runningCount,
            },
        };
    }
}
