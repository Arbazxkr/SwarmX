/**
 * Groklets Scheduler — Cron jobs + Webhook triggers.
 *
 * Allows agents to be triggered on a schedule or by incoming HTTP webhooks.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type SwarmEngine } from "../core/engine.js";
import { createEvent } from "../core/event-bus.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Automation");

// ── Cron ──────────────────────────────────────────────────────

interface CronJob {
    name: string;
    schedule: string; // simplified: "every 5m", "every 1h", "every 30s", "daily 09:00"
    topic: string;
    payload: Record<string, unknown>;
    enabled: boolean;
    timer?: ReturnType<typeof setInterval>;
    lastRun?: number;
    runCount: number;
}

/**
 * Parse simplified schedule format into milliseconds.
 * Supports: "every 30s", "every 5m", "every 1h", "every 1d"
 */
function parseScheduleMs(schedule: string): number {
    const match = schedule.match(/every\s+(\d+)(s|m|h|d)/i);
    if (!match) throw new Error(`Invalid schedule: ${schedule}. Use "every Ns|m|h|d"`);

    const val = parseInt(match[1]);
    const unit = match[2].toLowerCase();

    switch (unit) {
        case "s": return val * 1000;
        case "m": return val * 60_000;
        case "h": return val * 3_600_000;
        case "d": return val * 86_400_000;
        default: throw new Error(`Unknown unit: ${unit}`);
    }
}

export class CronScheduler {
    private jobs = new Map<string, CronJob>();
    private engine: SwarmEngine;

    constructor(engine: SwarmEngine) {
        this.engine = engine;
    }

    /**
     * Add a cron job.
     */
    add(name: string, schedule: string, topic: string, payload?: Record<string, unknown>): void {
        if (this.jobs.has(name)) throw new Error(`Job already exists: ${name}`);

        this.jobs.set(name, {
            name,
            schedule,
            topic,
            payload: payload ?? {},
            enabled: false,
            runCount: 0,
        });

        log.info(`Cron job added: ${name} (${schedule} → ${topic})`);
    }

    /**
     * Start all jobs.
     */
    startAll(): void {
        for (const job of this.jobs.values()) {
            this.startJob(job);
        }
    }

    /**
     * Start a single job.
     */
    start(name: string): void {
        const job = this.jobs.get(name);
        if (!job) throw new Error(`Job not found: ${name}`);
        this.startJob(job);
    }

    private startJob(job: CronJob): void {
        const ms = parseScheduleMs(job.schedule);

        job.timer = setInterval(async () => {
            job.lastRun = Date.now();
            job.runCount++;

            log.debug(`Cron firing: ${job.name} (run #${job.runCount})`);

            await this.engine.eventBus.publish(createEvent({
                topic: job.topic,
                payload: { ...job.payload, cronJob: job.name, runCount: job.runCount },
                source: `cron:${job.name}`,
            }));
        }, ms);

        job.enabled = true;
        log.info(`Cron started: ${job.name} (every ${ms / 1000}s)`);
    }

    /**
     * Stop a job.
     */
    stop(name: string): void {
        const job = this.jobs.get(name);
        if (!job) return;
        if (job.timer) clearInterval(job.timer);
        job.enabled = false;
    }

    /**
     * Stop all jobs.
     */
    stopAll(): void {
        for (const job of this.jobs.values()) {
            if (job.timer) clearInterval(job.timer);
            job.enabled = false;
        }
        log.info("All cron jobs stopped");
    }

    /**
     * Remove a job.
     */
    remove(name: string): boolean {
        this.stop(name);
        return this.jobs.delete(name);
    }

    get allJobs(): CronJob[] { return [...this.jobs.values()]; }
    get count(): number { return this.jobs.size; }
}

// ── Webhooks ──────────────────────────────────────────────────

interface WebhookRoute {
    path: string;
    topic: string;
    method: "GET" | "POST" | "PUT";
    secret?: string; // shared secret for auth
}

export interface WebhookConfig {
    port?: number;
    host?: string;
    routes?: WebhookRoute[];
}

export class WebhookServer {
    private server: ReturnType<typeof createServer> | null = null;
    private routes = new Map<string, WebhookRoute>();
    private engine: SwarmEngine;
    private config: Required<Omit<WebhookConfig, "routes">>;

    constructor(engine: SwarmEngine, config?: WebhookConfig) {
        this.engine = engine;
        this.config = {
            port: config?.port ?? 9876,
            host: config?.host ?? "127.0.0.1",
        };

        for (const route of config?.routes ?? []) {
            this.routes.set(`${route.method}:${route.path}`, route);
        }
    }

    /**
     * Add a webhook route.
     */
    addRoute(path: string, topic: string, method: "GET" | "POST" | "PUT" = "POST", secret?: string): void {
        this.routes.set(`${method}:${path}`, { path, topic, method, secret });
        log.info(`Webhook route: ${method} ${path} → ${topic}`);
    }

    /**
     * Start the webhook server.
     */
    async start(): Promise<void> {
        this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            const method = req.method ?? "GET";
            const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
            const key = `${method}:${url.pathname}`;

            // Health endpoint
            if (url.pathname === "/health") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "ok", routes: this.routes.size }));
                return;
            }

            const route = this.routes.get(key);
            if (!route) {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Not found" }));
                return;
            }

            // Auth check
            if (route.secret) {
                const auth = req.headers.authorization ?? url.searchParams.get("secret");
                if (auth !== `Bearer ${route.secret}` && auth !== route.secret) {
                    res.writeHead(401, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Unauthorized" }));
                    return;
                }
            }

            // Parse body
            let body: Record<string, unknown> = {};
            if (method === "POST" || method === "PUT") {
                body = await new Promise<Record<string, unknown>>((resolve) => {
                    let data = "";
                    req.on("data", (chunk) => data += chunk);
                    req.on("end", () => {
                        try { resolve(JSON.parse(data)); }
                        catch { resolve({ raw: data }); }
                    });
                });
            }

            // Include query params
            for (const [k, v] of url.searchParams) {
                body[k] = v;
            }

            // Publish event
            await this.engine.eventBus.publish(createEvent({
                topic: route.topic,
                payload: { ...body, webhookPath: route.path },
                source: `webhook:${route.path}`,
            }));

            log.info(`Webhook triggered: ${method} ${url.pathname} → ${route.topic}`);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, topic: route.topic }));
        });

        await new Promise<void>((resolve) => {
            this.server!.listen(this.config.port, this.config.host, () => {
                log.info(`Webhook server: http://${this.config.host}:${this.config.port}`);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        if (this.server) {
            await new Promise<void>((resolve) => this.server!.close(() => resolve()));
            this.server = null;
        }
    }
}
