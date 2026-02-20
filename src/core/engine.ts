/**
 * SwarmX Engine — Core orchestration engine.
 *
 * The top-level coordinator that wires event bus, task scheduler,
 * provider registry, and agents into a single cohesive system.
 * Handles graceful startup, shutdown, and signal trapping.
 */

import { EventBus, createEvent, type SwarmEvent } from "./event-bus.js";
import { Agent, type AgentConfig } from "./agent.js";
import { ProviderRegistry, type ProviderBase, type ProviderConfig } from "./provider.js";
import { TaskScheduler, createTask } from "./scheduler.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Engine");

export class SwarmEngine {
    readonly eventBus: EventBus;
    readonly providerRegistry: ProviderRegistry;
    readonly scheduler: TaskScheduler;

    private agents = new Map<string, Agent>();
    private _running = false;
    private shutdownHandlers: (() => void)[] = [];

    constructor(eventBus?: EventBus) {
        this.eventBus = eventBus ?? new EventBus();
        this.providerRegistry = new ProviderRegistry();
        this.scheduler = new TaskScheduler(this.eventBus);

        this.eventBus.subscribe("agent.response.*", (e) => this.onAgentResponse(e), "engine");
        this.eventBus.subscribe("agent.error", (e) => this.onAgentError(e), "engine");
    }

    // ── Providers ───────────────────────────────────────────────

    registerProvider(name: string, provider: ProviderBase): void;
    registerProvider(name: string, cls: new (c: ProviderConfig) => ProviderBase, config: ProviderConfig): void;
    registerProvider(
        name: string,
        providerOrClass: ProviderBase | (new (c: ProviderConfig) => ProviderBase),
        config?: ProviderConfig,
    ): void {
        if (config && typeof providerOrClass === "function") {
            const instance = new providerOrClass(config);
            this.providerRegistry.registerInstance(name, instance);
        } else {
            this.providerRegistry.registerInstance(name, providerOrClass as ProviderBase);
        }
        log.info(`Provider registered: ${name}`);
    }

    // ── Agents ──────────────────────────────────────────────────

    addAgent(
        config: AgentConfig,
        AgentClass?: new (...args: ConstructorParameters<typeof Agent>) => Agent,
    ): Agent {
        const Cls = AgentClass ?? Agent;
        const agent = new Cls(config, this.eventBus, this.providerRegistry);
        this.agents.set(agent.agentId, agent);
        log.info(`Agent added: ${agent.agentId} → ${config.provider}`);
        return agent;
    }

    getAgent(id: string): Agent | undefined { return this.agents.get(id); }
    getAgentsByName(name: string): Agent[] {
        return [...this.agents.values()].filter((a) => a.config.name === name);
    }

    // ── Tasks ───────────────────────────────────────────────────

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

    async broadcast(topic: string, payload: Record<string, unknown>): Promise<void> {
        await this.eventBus.publish(createEvent({ topic, payload, source: "engine" }));
    }

    // ── Lifecycle ───────────────────────────────────────────────

    async start(): Promise<void> {
        if (this._running) return;

        log.info("Starting SwarmX engine...");

        // Start event bus
        await this.eventBus.start();

        // Initialize agents
        const results = await Promise.allSettled(
            [...this.agents.values()].map((a) => a.initialize()),
        );
        const failed = results.filter((r) => r.status === "rejected");
        if (failed.length > 0) {
            log.warn(`${failed.length} agent(s) failed to initialize`);
        }

        // Start scheduler
        await this.scheduler.start();

        this._running = true;

        // Graceful shutdown on signals
        this.trapSignals();

        log.info(`Engine running — ${this.agents.size} agents, ${this.providerRegistry.available.length} providers`);
    }

    async stop(): Promise<void> {
        if (!this._running) return;

        log.info("Shutting down...");

        // Cleanup signal handlers
        this.shutdownHandlers.forEach((fn) => fn());
        this.shutdownHandlers = [];

        // Shutdown agents
        await Promise.allSettled([...this.agents.values()].map((a) => a.shutdown()));

        await this.scheduler.stop();
        await this.eventBus.stop();

        this._running = false;
        log.info("Engine stopped");
    }

    private trapSignals(): void {
        const handler = async () => {
            log.info("Received shutdown signal");
            await this.stop();
            process.exit(0);
        };

        const sigint = () => { handler(); };
        const sigterm = () => { handler(); };

        process.on("SIGINT", sigint);
        process.on("SIGTERM", sigterm);

        this.shutdownHandlers.push(
            () => process.removeListener("SIGINT", sigint),
            () => process.removeListener("SIGTERM", sigterm),
        );
    }

    // ── Internal Handlers ───────────────────────────────────────

    private async onAgentResponse(_event: SwarmEvent): Promise<void> { /* extensible */ }
    private async onAgentError(event: SwarmEvent): Promise<void> {
        log.error(`Agent error: ${event.payload.agentId} — ${event.payload.error}`);
    }

    // ── Introspection ───────────────────────────────────────────

    get allAgents() { return new Map(this.agents); }
    get isRunning() { return this._running; }

    status(): Record<string, unknown> {
        const agents: Record<string, unknown> = {};
        for (const [id, agent] of this.agents) {
            agents[id] = { name: agent.config.name, state: agent.state, provider: agent.config.provider };
        }
        return {
            running: this._running,
            agents,
            providers: this.providerRegistry.available,
            eventBus: this.eventBus.stats,
            scheduler: { pending: this.scheduler.pendingCount, running: this.scheduler.runningCount },
        };
    }
}
