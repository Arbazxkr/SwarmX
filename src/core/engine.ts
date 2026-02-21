/**
 * Groklets Engine — Production-grade orchestration engine.
 *
 * Integrates all core subsystems:
 *   - EventBus (async event routing)
 *   - ProviderRegistry (model management + failover)
 *   - TaskScheduler (dependency-aware task queue)
 *   - SessionStore (persistent conversations)
 *   - UsageTracker (cost tracking)
 *   - ContextManager (token management)
 */

import { EventBus, createEvent, type SwarmEvent } from "./event-bus.js";
import { Agent, type AgentConfig } from "./agent.js";
import { ProviderRegistry, type ProviderBase, type ProviderConfig } from "./provider.js";
import { TaskScheduler, createTask } from "./scheduler.js";
import { SessionStore, type SessionStoreConfig } from "./session.js";
import { UsageTracker } from "./usage.js";
import { FailoverProvider, type FailoverConfig } from "./failover.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Engine");

export interface EngineConfig {
    sessions?: SessionStoreConfig;
    failover?: FailoverConfig;
}

export class SwarmEngine {
    readonly eventBus: EventBus;
    readonly providerRegistry: ProviderRegistry;
    readonly scheduler: TaskScheduler;
    readonly sessionStore: SessionStore;
    readonly usageTracker: UsageTracker;

    private agents = new Map<string, Agent>();
    private _running = false;
    private shutdownHandlers: (() => void)[] = [];
    private engineConfig: EngineConfig;

    constructor(config?: EngineConfig, eventBus?: EventBus) {
        this.engineConfig = config ?? {};
        this.eventBus = eventBus ?? new EventBus();
        this.providerRegistry = new ProviderRegistry();
        this.scheduler = new TaskScheduler(this.eventBus);
        this.sessionStore = new SessionStore(config?.sessions);
        this.usageTracker = new UsageTracker();

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

    /**
     * Create a failover provider from multiple providers.
     * First provider is primary, rest are fallbacks.
     */
    registerFailover(name: string, providerNames: string[], config?: FailoverConfig): void {
        const providers = providerNames.map((n) => this.providerRegistry.get(n));
        const failover = new FailoverProvider(name, providers, config);
        this.providerRegistry.registerInstance(name, failover);
        log.info(`Failover registered: ${name} (${providerNames.join(" → ")})`);
    }

    // ── Agents ──────────────────────────────────────────────────

    addAgent(
        config: AgentConfig,
        AgentClass?: new (...args: ConstructorParameters<typeof Agent>) => Agent,
    ): Agent {
        const Cls = AgentClass ?? Agent;
        const agent = new Cls(config, this.eventBus, this.providerRegistry, this.sessionStore);
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

    /**
     * Send a message from one agent to another via event bus.
     */
    async agentToAgent(fromAgent: string, toAgent: string, message: string): Promise<void> {
        await this.eventBus.publish(createEvent({
            topic: `agent.message.${toAgent}`,
            payload: { content: message, from: fromAgent },
            source: fromAgent,
        }));
    }

    // ── Lifecycle ───────────────────────────────────────────────

    async start(): Promise<void> {
        if (this._running) return;

        log.info("Starting Groklets engine...");

        await this.eventBus.start();

        const results = await Promise.allSettled(
            [...this.agents.values()].map((a) => a.initialize()),
        );
        const failed = results.filter((r) => r.status === "rejected");
        if (failed.length > 0) {
            log.warn(`${failed.length} agent(s) failed to initialize`);
        }

        await this.scheduler.start();
        this._running = true;
        this.trapSignals();

        log.info(`Engine running — ${this.agents.size} agents, ${this.providerRegistry.available.length} providers`);
    }

    async stop(): Promise<void> {
        if (!this._running) return;

        log.info("Shutting down...");

        this.shutdownHandlers.forEach((fn) => fn());
        this.shutdownHandlers = [];

        // Shutdown agents (saves sessions)
        await Promise.allSettled([...this.agents.values()].map((a) => a.shutdown()));

        // Save all sessions
        this.sessionStore.saveAll();

        await this.scheduler.stop();
        await this.eventBus.stop();

        this._running = false;

        // Log final usage
        const usage = this.getUsageSummary();
        log.info(`Engine stopped — ${usage.totalCalls} calls, ${usage.totalTokens} tokens, ${usage.totalCost}`);
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

    private async onAgentResponse(event: SwarmEvent): Promise<void> {
        // Track usage from agent responses
        const usage = event.payload.usage as { promptTokens?: number; completionTokens?: number } | undefined;
        const model = event.payload.model as string | undefined;
        if (usage && model) {
            this.usageTracker.track(model, usage.promptTokens ?? 0, usage.completionTokens ?? 0);
        }
    }

    private async onAgentError(event: SwarmEvent): Promise<void> {
        log.error(`Agent error: ${event.payload.agentId} — ${event.payload.error}`);
    }

    // ── Introspection ───────────────────────────────────────────

    get allAgents() { return new Map(this.agents); }
    get isRunning() { return this._running; }

    getUsageSummary(): { totalCalls: number; totalTokens: number; totalCost: string; breakdown: Record<string, unknown> } {
        // Aggregate from all agents + engine-level
        let totalCalls = this.usageTracker.summary.calls;
        let totalTokens = this.usageTracker.summary.totalTokens;
        let totalCostUsd = this.usageTracker.summary.costUsd;

        for (const agent of this.agents.values()) {
            const agentUsage = agent.usageTracker.summary;
            totalCalls += agentUsage.calls;
            totalTokens += agentUsage.totalTokens;
            totalCostUsd += agentUsage.costUsd;
        }

        return {
            totalCalls,
            totalTokens,
            totalCost: `$${totalCostUsd.toFixed(4)}`,
            breakdown: this.usageTracker.breakdown(),
        };
    }

    status(): Record<string, unknown> {
        const agents: Record<string, unknown> = {};
        for (const [id, agent] of this.agents) {
            agents[id] = {
                name: agent.config.name,
                state: agent.state,
                provider: agent.config.provider,
                contextUsage: agent.contextUsage,
                usage: agent.usageTracker.summary,
                tools: agent.toolExecutor.registeredTools,
            };
        }
        return {
            running: this._running,
            agents,
            providers: this.providerRegistry.available,
            eventBus: this.eventBus.stats,
            scheduler: { pending: this.scheduler.pendingCount, running: this.scheduler.runningCount },
            sessions: this.sessionStore.stats(),
            usage: this.getUsageSummary(),
        };
    }

    /**
     * Full diagnostics — like `openclaw doctor`.
     */
    async doctor(): Promise<Array<{ check: string; status: "pass" | "warn" | "fail"; detail: string }>> {
        const checks: Array<{ check: string; status: "pass" | "warn" | "fail"; detail: string }> = [];

        // Engine
        checks.push({
            check: "Engine running",
            status: this._running ? "pass" : "fail",
            detail: this._running ? "Engine is running" : "Engine is not started",
        });

        // Providers
        for (const name of this.providerRegistry.available) {
            try {
                const provider = this.providerRegistry.get(name);
                if (provider.healthCheck) {
                    const ok = await provider.healthCheck();
                    checks.push({
                        check: `Provider: ${name}`,
                        status: ok ? "pass" : "fail",
                        detail: ok ? "Connected" : "Unreachable",
                    });
                } else {
                    checks.push({ check: `Provider: ${name}`, status: "warn", detail: "No health check available" });
                }
            } catch (err) {
                checks.push({ check: `Provider: ${name}`, status: "fail", detail: (err as Error).message });
            }
        }

        // Agents
        for (const [, agent] of this.agents) {
            const ctx = agent.contextUsage;
            checks.push({
                check: `Agent: ${agent.config.name}`,
                status: agent.state === "idle" ? "pass" : agent.state === "error" ? "fail" : "warn",
                detail: `State: ${agent.state}, Context: ${ctx.percent}% (${ctx.estimated}/${ctx.max} tokens)`,
            });
        }

        // Sessions
        const sessionStats = this.sessionStore.stats();
        checks.push({
            check: "Session store",
            status: "pass",
            detail: `${sessionStats.totalSessions} sessions, ${sessionStats.totalMessages} messages`,
        });

        return checks;
    }
}
