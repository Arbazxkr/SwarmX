/**
 * SwarmX Memory System — Persistent long-term memory + RAG.
 *
 * Features:
 *   - Key-value memory store (facts, preferences, context)
 *   - Vector-like semantic search (TF-IDF based, no external deps)
 *   - Conversation summaries for long-term recall
 *   - Memory files persisted to disk (.swarmx/memory/)
 *   - Auto-extract important facts from conversations
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Memory");

export interface MemoryEntry {
    id: string;
    content: string;
    type: "fact" | "preference" | "summary" | "note" | "context";
    tags: string[];
    source: string;
    createdAt: number;
    updatedAt: number;
    accessCount: number;
    importance: number; // 0-1
}

export interface MemoryConfig {
    /** Directory for memory persistence */
    dir?: string;
    /** Max entries before pruning */
    maxEntries?: number;
    /** Auto-save interval in ms */
    autoSaveMs?: number;
}

export class MemoryStore {
    private entries = new Map<string, MemoryEntry>();
    private dir: string;
    private maxEntries: number;
    private dirty = false;
    private autoSaveTimer?: ReturnType<typeof setInterval>;
    private idf = new Map<string, number>(); // inverse doc frequency

    constructor(config?: MemoryConfig) {
        this.dir = config?.dir ?? join(process.cwd(), ".swarmx", "memory");
        this.maxEntries = config?.maxEntries ?? 10_000;

        if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
        this.load();

        if (config?.autoSaveMs) {
            this.autoSaveTimer = setInterval(() => this.save(), config.autoSaveMs);
        }
    }

    // ── CRUD ────────────────────────────────────────────────────

    add(content: string, type: MemoryEntry["type"], tags: string[] = [], source = "system", importance = 0.5): MemoryEntry {
        const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const entry: MemoryEntry = {
            id, content, type, tags, source,
            createdAt: Date.now(), updatedAt: Date.now(),
            accessCount: 0, importance,
        };
        this.entries.set(id, entry);
        this.rebuildIDF();
        this.dirty = true;

        if (this.entries.size > this.maxEntries) this.prune();
        log.debug(`Memory added: ${type} (${id})`);
        return entry;
    }

    get(id: string): MemoryEntry | undefined {
        const entry = this.entries.get(id);
        if (entry) { entry.accessCount++; entry.updatedAt = Date.now(); }
        return entry;
    }

    update(id: string, content: string): boolean {
        const entry = this.entries.get(id);
        if (!entry) return false;
        entry.content = content;
        entry.updatedAt = Date.now();
        this.rebuildIDF();
        this.dirty = true;
        return true;
    }

    delete(id: string): boolean {
        const result = this.entries.delete(id);
        if (result) { this.rebuildIDF(); this.dirty = true; }
        return result;
    }

    // ── Search ──────────────────────────────────────────────────

    /**
     * Semantic search using TF-IDF scoring (no embeddings API needed).
     */
    search(query: string, limit = 10, typeFilter?: MemoryEntry["type"]): MemoryEntry[] {
        const queryTokens = this.tokenize(query);
        const scored: Array<{ entry: MemoryEntry; score: number }> = [];

        for (const entry of this.entries.values()) {
            if (typeFilter && entry.type !== typeFilter) continue;

            const docTokens = this.tokenize(entry.content);
            let score = 0;

            for (const qt of queryTokens) {
                const tf = docTokens.filter(t => t === qt).length / (docTokens.length || 1);
                const idf = this.idf.get(qt) ?? 0;
                score += tf * idf;
            }

            // Boost by importance and recency
            score *= (0.5 + entry.importance * 0.5);
            score *= (1 + Math.min(entry.accessCount, 10) * 0.05);

            if (score > 0) scored.push({ entry, score });
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map(s => s.entry);
    }

    /**
     * Get memories by tag.
     */
    findByTag(tag: string): MemoryEntry[] {
        return [...this.entries.values()].filter(e => e.tags.includes(tag));
    }

    /**
     * Get memories by type.
     */
    findByType(type: MemoryEntry["type"]): MemoryEntry[] {
        return [...this.entries.values()].filter(e => e.type === type);
    }

    /**
     * Get recent memories.
     */
    recent(limit = 20): MemoryEntry[] {
        return [...this.entries.values()]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, limit);
    }

    // ── Fact Extraction ─────────────────────────────────────────

    /**
     * Extract facts from a conversation turn.
     * Simple heuristic-based extraction (no LLM needed).
     */
    extractFacts(text: string, source = "conversation"): MemoryEntry[] {
        const facts: MemoryEntry[] = [];
        const sentences = text.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 15);

        for (const sentence of sentences) {
            const lower = sentence.toLowerCase();

            // Preference patterns
            if (/\b(i prefer|i like|i love|i hate|i don't like|my favorite)\b/i.test(sentence)) {
                facts.push(this.add(sentence, "preference", ["auto-extracted"], source, 0.7));
            }
            // Fact patterns
            else if (/\b(i am|i'm|my name|i work|i live|i have|i was born)\b/i.test(sentence)) {
                facts.push(this.add(sentence, "fact", ["auto-extracted", "personal"], source, 0.8));
            }
            // Important info
            else if (/\b(remember|important|don't forget|always|never)\b/i.test(sentence)) {
                facts.push(this.add(sentence, "note", ["auto-extracted", "important"], source, 0.9));
            }
        }

        if (facts.length > 0) log.info(`Extracted ${facts.length} facts from conversation`);
        return facts;
    }

    // ── Context Builder ─────────────────────────────────────────

    /**
     * Build a context string from relevant memories for injection into prompt.
     */
    buildContext(query: string, maxTokens = 500): string {
        const relevant = this.search(query, 10);
        if (relevant.length === 0) return "";

        let context = "## Relevant Memories\n";
        let estimatedTokens = 10;

        for (const entry of relevant) {
            const line = `- [${entry.type}] ${entry.content}\n`;
            const lineTokens = Math.ceil(line.length / 4);
            if (estimatedTokens + lineTokens > maxTokens) break;
            context += line;
            estimatedTokens += lineTokens;
        }

        return context;
    }

    // ── Persistence ─────────────────────────────────────────────

    save(): void {
        if (!this.dirty) return;
        const data = JSON.stringify([...this.entries.values()], null, 2);
        writeFileSync(join(this.dir, "store.json"), data);
        this.dirty = false;
        log.debug(`Saved ${this.entries.size} memories`);
    }

    private load(): void {
        const path = join(this.dir, "store.json");
        if (!existsSync(path)) return;

        try {
            const data = JSON.parse(readFileSync(path, "utf-8")) as MemoryEntry[];
            for (const entry of data) {
                this.entries.set(entry.id, entry);
            }
            this.rebuildIDF();
            log.info(`Loaded ${this.entries.size} memories`);
        } catch (err) {
            log.warn(`Failed to load memory: ${err}`);
        }
    }

    // ── TF-IDF ──────────────────────────────────────────────────

    private tokenize(text: string): string[] {
        return text.toLowerCase()
            .replace(/[^a-z0-9\s]/g, "")
            .split(/\s+/)
            .filter(t => t.length > 2 && !STOP_WORDS.has(t));
    }

    private rebuildIDF(): void {
        const docCount = this.entries.size || 1;
        const df = new Map<string, number>();

        for (const entry of this.entries.values()) {
            const tokens = new Set(this.tokenize(entry.content));
            for (const t of tokens) {
                df.set(t, (df.get(t) ?? 0) + 1);
            }
        }

        this.idf.clear();
        for (const [term, count] of df) {
            this.idf.set(term, Math.log(docCount / count));
        }
    }

    private prune(): void {
        const entries = [...this.entries.values()]
            .sort((a, b) => (a.importance * 0.5 + (a.accessCount / 100) * 0.3 + (a.updatedAt / Date.now()) * 0.2) -
                (b.importance * 0.5 + (b.accessCount / 100) * 0.3 + (b.updatedAt / Date.now()) * 0.2));

        const toRemove = entries.slice(0, Math.floor(this.maxEntries * 0.2));
        for (const e of toRemove) this.entries.delete(e.id);
        this.rebuildIDF();
        log.info(`Pruned ${toRemove.length} low-value memories`);
    }

    // ── Introspection ───────────────────────────────────────────

    get size(): number { return this.entries.size; }

    stats(): Record<string, unknown> {
        const byType: Record<string, number> = {};
        for (const e of this.entries.values()) {
            byType[e.type] = (byType[e.type] ?? 0) + 1;
        }
        return { total: this.entries.size, byType, dir: this.dir };
    }

    shutdown(): void {
        this.save();
        if (this.autoSaveTimer) clearInterval(this.autoSaveTimer);
    }
}

const STOP_WORDS = new Set([
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "has",
    "her", "was", "one", "our", "out", "his", "had", "how", "its", "may",
    "who", "did", "get", "got", "let", "say", "she", "too", "use", "way",
    "about", "been", "from", "have", "just", "more", "most", "much", "some",
    "than", "that", "them", "then", "they", "this", "very", "what", "when",
    "where", "which", "will", "with", "would", "could", "should", "into",
]);
