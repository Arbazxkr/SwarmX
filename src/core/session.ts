/**
 * SwarmX Session Store — Persistent conversation storage.
 *
 * Saves agent conversation history to disk so sessions survive
 * process restarts. Supports multiple concurrent sessions.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type Message } from "./provider.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Session");

export interface Session {
    sessionId: string;
    agentId: string;
    messages: Message[];
    createdAt: number;
    updatedAt: number;
    metadata: Record<string, unknown>;
    tokenCount: number;
}

export interface SessionStoreConfig {
    /** Directory to store session files */
    directory?: string;
    /** Max sessions to keep per agent */
    maxSessionsPerAgent?: number;
    /** Auto-save after every message */
    autoSave?: boolean;
}

export class SessionStore {
    private sessions = new Map<string, Session>();
    private dir: string;
    private maxPerAgent: number;
    private autoSave: boolean;

    constructor(config?: SessionStoreConfig) {
        this.dir = config?.directory ?? join(process.cwd(), ".swarmx", "sessions");
        this.maxPerAgent = config?.maxSessionsPerAgent ?? 100;
        this.autoSave = config?.autoSave ?? true;

        if (!existsSync(this.dir)) {
            mkdirSync(this.dir, { recursive: true });
        }

        this.loadAll();
    }

    // ── CRUD ────────────────────────────────────────────────────

    create(agentId: string, metadata?: Record<string, unknown>): Session {
        const sessionId = `${agentId}-${Date.now()}`;
        const session: Session = {
            sessionId,
            agentId,
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            metadata: metadata ?? {},
            tokenCount: 0,
        };

        this.sessions.set(sessionId, session);
        if (this.autoSave) this.save(sessionId);

        // Prune old sessions
        this.pruneAgentSessions(agentId);

        log.debug(`Session created: ${sessionId}`);
        return session;
    }

    get(sessionId: string): Session | undefined {
        return this.sessions.get(sessionId);
    }

    getByAgent(agentId: string): Session[] {
        return [...this.sessions.values()]
            .filter((s) => s.agentId === agentId)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    getLatest(agentId: string): Session | undefined {
        return this.getByAgent(agentId)[0];
    }

    getOrCreate(agentId: string): Session {
        const existing = this.getLatest(agentId);
        if (existing) return existing;
        return this.create(agentId);
    }

    // ── Messages ────────────────────────────────────────────────

    addMessage(sessionId: string, message: Message): void {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error(`Session not found: ${sessionId}`);

        session.messages.push(message);
        session.updatedAt = Date.now();

        // Rough token estimate (4 chars ≈ 1 token)
        session.tokenCount += Math.ceil(message.content.length / 4);

        if (this.autoSave) this.save(sessionId);
    }

    getMessages(sessionId: string): Message[] {
        return this.sessions.get(sessionId)?.messages ?? [];
    }

    getHistory(sessionId: string, limit?: number): Message[] {
        const msgs = this.getMessages(sessionId);
        if (limit) return msgs.slice(-limit);
        return msgs;
    }

    // ── Persistence ─────────────────────────────────────────────

    save(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        const filePath = join(this.dir, `${sessionId}.json`);
        writeFileSync(filePath, JSON.stringify(session, null, 2));
    }

    saveAll(): void {
        for (const id of this.sessions.keys()) {
            this.save(id);
        }
        log.debug(`Saved ${this.sessions.size} sessions`);
    }

    private loadAll(): void {
        if (!existsSync(this.dir)) return;

        const files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
        for (const file of files) {
            try {
                const raw = readFileSync(join(this.dir, file), "utf-8");
                const session = JSON.parse(raw) as Session;
                this.sessions.set(session.sessionId, session);
            } catch (err) {
                log.warn(`Failed to load session ${file}: ${err}`);
            }
        }

        if (files.length > 0) {
            log.info(`Loaded ${files.length} sessions from disk`);
        }
    }

    // ── Cleanup ─────────────────────────────────────────────────

    delete(sessionId: string): boolean {
        const removed = this.sessions.delete(sessionId);
        const filePath = join(this.dir, `${sessionId}.json`);
        if (existsSync(filePath)) {
            try { unlinkSync(filePath); } catch { }
        }
        return removed;
    }

    clear(agentId?: string): number {
        let count = 0;
        for (const [id, session] of this.sessions) {
            if (!agentId || session.agentId === agentId) {
                this.delete(id);
                count++;
            }
        }
        return count;
    }

    private pruneAgentSessions(agentId: string): void {
        const sessions = this.getByAgent(agentId);
        if (sessions.length > this.maxPerAgent) {
            const toRemove = sessions.slice(this.maxPerAgent);
            for (const s of toRemove) {
                this.delete(s.sessionId);
            }
            log.debug(`Pruned ${toRemove.length} old sessions for ${agentId}`);
        }
    }

    // ── Introspection ───────────────────────────────────────────

    get count(): number { return this.sessions.size; }
    get allSessions(): Session[] { return [...this.sessions.values()]; }

    stats(): Record<string, unknown> {
        const agents = new Map<string, number>();
        let totalMessages = 0;
        let totalTokens = 0;
        for (const s of this.sessions.values()) {
            agents.set(s.agentId, (agents.get(s.agentId) ?? 0) + 1);
            totalMessages += s.messages.length;
            totalTokens += s.tokenCount;
        }
        return {
            totalSessions: this.sessions.size,
            totalMessages,
            estimatedTokens: totalTokens,
            agentSessions: Object.fromEntries(agents),
        };
    }
}
