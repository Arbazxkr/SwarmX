/**
 * Groklets WebSocket Gateway — Real-time control plane.
 *
 * Runs a WebSocket server that external tools, apps, and UIs
 * can connect to. Bridges the event bus to the outside world.
 *
 * Protocol:
 *   Client → Server: { type, payload }
 *   Server → Client: { type, payload, timestamp }
 *
 * Message types:
 *   task.submit    — submit a task
 *   task.status    — get task status
 *   agent.list     — list agents
 *   agent.message  — message an agent directly
 *   engine.status  — get engine status
 *   engine.doctor  — run diagnostics
 *   event.subscribe — subscribe to event topics
 *   stream.token   — streamed token (server → client)
 *   event.forward  — forwarded event (server → client)
 */

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { type SwarmEngine } from "./engine.js";
import { type SwarmEvent } from "./event-bus.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Gateway");

export interface GatewayConfig {
    /** Port to listen on */
    port?: number;
    /** Host to bind to */
    host?: string;
    /** Auth token (if set, clients must send it in first message) */
    authToken?: string;
    /** Max connections */
    maxConnections?: number;
}

interface Client {
    id: string;
    ws: WebSocket;
    authenticated: boolean;
    subscriptions: Set<string>;
    connectedAt: number;
}

interface GatewayMessage {
    type: string;
    payload?: Record<string, unknown>;
    requestId?: string;
}

interface GatewayResponse {
    type: string;
    payload: Record<string, unknown>;
    requestId?: string;
    timestamp: number;
}

export class Gateway {
    private wss: WebSocketServer | null = null;
    private clients = new Map<string, Client>();
    private engine: SwarmEngine;
    private config: Required<GatewayConfig>;
    private running = false;

    constructor(engine: SwarmEngine, config?: GatewayConfig) {
        this.engine = engine;
        this.config = {
            port: config?.port ?? 18789,
            host: config?.host ?? "127.0.0.1",
            authToken: config?.authToken ?? "",
            maxConnections: config?.maxConnections ?? 100,
        };
    }

    // ── Lifecycle ───────────────────────────────────────────────

    async start(): Promise<void> {
        if (this.running) return;

        this.wss = new WebSocketServer({
            port: this.config.port,
            host: this.config.host,
        });

        this.wss.on("connection", (ws) => this.handleConnection(ws));
        this.wss.on("error", (err) => log.error(`Server error: ${err.message}`));

        // Subscribe to all events and forward to clients
        this.engine.eventBus.subscribe("*", async (event) => this.forwardEvent(event), "gateway");

        this.running = true;
        log.info(`Gateway listening on ws://${this.config.host}:${this.config.port}`);
    }

    async stop(): Promise<void> {
        if (!this.running) return;

        // Close all clients
        for (const client of this.clients.values()) {
            client.ws.close(1001, "Server shutting down");
        }
        this.clients.clear();

        // Close server
        if (this.wss) {
            await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
            this.wss = null;
        }

        this.engine.eventBus.unsubscribe("gateway");
        this.running = false;
        log.info("Gateway stopped");
    }

    // ── Connection Handling ─────────────────────────────────────

    private handleConnection(ws: WebSocket): void {
        if (this.clients.size >= this.config.maxConnections) {
            ws.close(1013, "Max connections reached");
            return;
        }

        const client: Client = {
            id: randomUUID().slice(0, 8),
            ws,
            authenticated: !this.config.authToken, // Auto-auth if no token configured
            subscriptions: new Set(),
            connectedAt: Date.now(),
        };

        this.clients.set(client.id, client);
        log.info(`Client connected: ${client.id} (${this.clients.size} total)`);

        ws.on("message", (data) => {
            try {
                const message = JSON.parse(data.toString()) as GatewayMessage;
                this.handleMessage(client, message);
            } catch (err) {
                this.send(client, { type: "error", payload: { message: "Invalid JSON" }, timestamp: Date.now() });
            }
        });

        ws.on("close", () => {
            this.clients.delete(client.id);
            log.info(`Client disconnected: ${client.id} (${this.clients.size} remaining)`);
        });

        ws.on("error", (err) => {
            log.error(`Client ${client.id} error: ${err.message}`);
        });

        // Send welcome
        this.send(client, {
            type: "connected",
            payload: {
                clientId: client.id,
                authenticated: client.authenticated,
                version: "0.2.0",
            },
            timestamp: Date.now(),
        });
    }

    // ── Message Routing ─────────────────────────────────────────

    private async handleMessage(client: Client, msg: GatewayMessage): Promise<void> {
        // Auth gate
        if (!client.authenticated) {
            if (msg.type === "auth" && msg.payload?.token === this.config.authToken) {
                client.authenticated = true;
                this.reply(client, msg, { type: "auth.ok", payload: { clientId: client.id } });
                return;
            }
            this.reply(client, msg, { type: "error", payload: { message: "Not authenticated. Send { type: 'auth', payload: { token: '...' } }" } });
            return;
        }

        switch (msg.type) {
            case "task.submit": {
                const content = (msg.payload?.content as string) ?? "";
                if (!content) {
                    this.reply(client, msg, { type: "error", payload: { message: "Missing content" } });
                    return;
                }
                const taskId = await this.engine.submitTask(content, {
                    name: msg.payload?.name as string,
                    targetTopic: msg.payload?.topic as string,
                });
                this.reply(client, msg, { type: "task.submitted", payload: { taskId } });
                break;
            }

            case "agent.list": {
                const agents: Record<string, unknown>[] = [];
                for (const [id, agent] of this.engine.allAgents) {
                    agents.push({
                        id,
                        name: agent.config.name,
                        state: agent.state,
                        provider: agent.config.provider,
                        tools: agent.toolExecutor.registeredTools,
                        contextUsage: agent.contextUsage,
                    });
                }
                this.reply(client, msg, { type: "agent.list", payload: { agents } });
                break;
            }

            case "agent.message": {
                const agentName = msg.payload?.agent as string;
                const content = msg.payload?.content as string;
                if (!agentName || !content) {
                    this.reply(client, msg, { type: "error", payload: { message: "Missing agent or content" } });
                    return;
                }
                const agents = this.engine.getAgentsByName(agentName);
                if (agents.length === 0) {
                    this.reply(client, msg, { type: "error", payload: { message: `Agent not found: ${agentName}` } });
                    return;
                }
                const response = await agents[0].think(content);
                this.reply(client, msg, {
                    type: "agent.response",
                    payload: {
                        agent: agentName,
                        content: response?.message.content ?? "",
                        model: response?.model ?? "",
                        usage: response?.usage ?? {},
                    },
                });
                break;
            }

            case "engine.status": {
                this.reply(client, msg, { type: "engine.status", payload: this.engine.status() });
                break;
            }

            case "engine.doctor": {
                const checks = await this.engine.doctor();
                this.reply(client, msg, { type: "engine.doctor", payload: { checks } });
                break;
            }

            case "engine.usage": {
                this.reply(client, msg, { type: "engine.usage", payload: this.engine.getUsageSummary() });
                break;
            }

            case "event.subscribe": {
                const topics = (msg.payload?.topics as string[]) ?? [];
                for (const topic of topics) {
                    client.subscriptions.add(topic);
                }
                this.reply(client, msg, { type: "event.subscribed", payload: { topics: [...client.subscriptions] } });
                break;
            }

            case "event.unsubscribe": {
                const topics = (msg.payload?.topics as string[]) ?? [];
                for (const topic of topics) {
                    client.subscriptions.delete(topic);
                }
                this.reply(client, msg, { type: "event.unsubscribed", payload: { topics: [...client.subscriptions] } });
                break;
            }

            case "session.list": {
                const sessions = this.engine.sessionStore.allSessions.map((s) => ({
                    sessionId: s.sessionId,
                    agentId: s.agentId,
                    messageCount: s.messages.length,
                    tokenCount: s.tokenCount,
                    createdAt: s.createdAt,
                    updatedAt: s.updatedAt,
                }));
                this.reply(client, msg, { type: "session.list", payload: { sessions } });
                break;
            }

            case "session.history": {
                const sessionId = msg.payload?.sessionId as string;
                const limit = (msg.payload?.limit as number) ?? 50;
                const messages = this.engine.sessionStore.getHistory(sessionId, limit);
                this.reply(client, msg, { type: "session.history", payload: { sessionId, messages } });
                break;
            }

            case "ping": {
                this.reply(client, msg, { type: "pong", payload: {} });
                break;
            }

            default:
                this.reply(client, msg, { type: "error", payload: { message: `Unknown message type: ${msg.type}` } });
        }
    }

    // ── Event Forwarding ────────────────────────────────────────

    private forwardEvent(event: SwarmEvent): void {
        for (const client of this.clients.values()) {
            if (!client.authenticated) continue;
            if (client.subscriptions.size === 0) continue;

            // Check if client is subscribed to this topic
            let match = false;
            for (const pattern of client.subscriptions) {
                if (pattern === "*") { match = true; break; }
                if (pattern === event.topic) { match = true; break; }
                if (pattern.endsWith(".*") && event.topic.startsWith(pattern.slice(0, -2) + ".")) { match = true; break; }
            }

            if (match) {
                this.send(client, {
                    type: "event.forward",
                    payload: {
                        topic: event.topic,
                        payload: event.payload,
                        source: event.source,
                        eventId: event.eventId,
                    },
                    timestamp: event.timestamp,
                });
            }
        }
    }

    /**
     * Stream a token to all subscribed clients.
     * Called by agents during streaming completions.
     */
    streamToken(agentId: string, token: string): void {
        for (const client of this.clients.values()) {
            if (!client.authenticated) continue;
            if (client.subscriptions.has("stream.*") || client.subscriptions.has(`stream.${agentId}`) || client.subscriptions.has("*")) {
                this.send(client, {
                    type: "stream.token",
                    payload: { agentId, token },
                    timestamp: Date.now(),
                });
            }
        }
    }

    /**
     * Broadcast to all authenticated clients.
     */
    broadcastAll(type: string, payload: Record<string, unknown>): void {
        for (const client of this.clients.values()) {
            if (client.authenticated) {
                this.send(client, { type, payload, timestamp: Date.now() });
            }
        }
    }

    // ── Helpers ─────────────────────────────────────────────────

    private send(client: Client, response: GatewayResponse): void {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(response));
        }
    }

    private reply(client: Client, request: GatewayMessage, response: Omit<GatewayResponse, "timestamp">): void {
        this.send(client, {
            ...response,
            requestId: request.requestId,
            timestamp: Date.now(),
        });
    }

    // ── Introspection ───────────────────────────────────────────

    get isRunning() { return this.running; }
    get clientCount() { return this.clients.size; }
    get port() { return this.config.port; }

    status(): Record<string, unknown> {
        return {
            running: this.running,
            port: this.config.port,
            host: this.config.host,
            clients: this.clients.size,
            authenticated: [...this.clients.values()].filter((c) => c.authenticated).length,
        };
    }
}
