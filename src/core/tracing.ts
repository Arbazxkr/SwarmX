/**
 * Tracing — structured trace logs for agent runs.
 *
 * Records every step of agent execution for debugging,
 * replay, and optimization. Inspired by OpenAI Agents SDK tracing.
 *
 * Features:
 *   - Automatic span creation for agent runs
 *   - Tool call tracing with inputs/outputs
 *   - Timing data for performance analysis
 *   - Export to JSON for external tools
 *   - Custom span support
 */

import { createLogger } from "../utils/logger.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const log = createLogger("Tracing");

// ── Types ──────────────────────────────────────────────────────

export interface Span {
    id: string;
    parentId?: string;
    name: string;
    type: "agent" | "tool" | "provider" | "guardrail" | "custom";
    startTime: number;
    endTime?: number;
    durationMs?: number;
    status: "running" | "success" | "error";
    attributes: Record<string, unknown>;
    events: SpanEvent[];
    children: Span[];
}

export interface SpanEvent {
    name: string;
    timestamp: number;
    attributes?: Record<string, unknown>;
}

export interface Trace {
    id: string;
    name: string;
    startTime: number;
    endTime?: number;
    durationMs?: number;
    rootSpan: Span;
    spanCount: number;
    status: "running" | "success" | "error";
}

export interface TracingConfig {
    enabled?: boolean;
    /** Directory to save trace files. */
    outputDir?: string;
    /** Max traces to keep in memory. Default: 100 */
    maxTraces?: number;
    /** Auto-save traces to disk. Default: false */
    autoSave?: boolean;
}

// ── ID Generation ──────────────────────────────────────────────

let counter = 0;
function generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${(++counter).toString(36)}`;
}

// ── Tracer ─────────────────────────────────────────────────────

export class Tracer {
    private traces: Map<string, Trace> = new Map();
    private activeSpans: Map<string, Span> = new Map();
    private config: TracingConfig;

    constructor(config?: TracingConfig) {
        this.config = { enabled: true, maxTraces: 100, ...config };
    }

    get enabled(): boolean {
        return this.config.enabled !== false;
    }

    // ── Trace Lifecycle ────────────────────────────────────────

    /**
     * Start a new trace (top-level execution).
     */
    startTrace(name: string, attributes?: Record<string, unknown>): string {
        if (!this.enabled) return "";

        const traceId = generateId("trace");
        const rootSpan = this.createSpan(name, "agent", attributes);

        const trace: Trace = {
            id: traceId,
            name,
            startTime: Date.now(),
            rootSpan,
            spanCount: 1,
            status: "running",
        };

        this.traces.set(traceId, trace);
        this.pruneOldTraces();

        log.debug(`Trace started: ${name} (${traceId})`);
        return traceId;
    }

    /**
     * End a trace.
     */
    endTrace(traceId: string, status: "success" | "error" = "success"): void {
        if (!this.enabled) return;

        const trace = this.traces.get(traceId);
        if (!trace) return;

        trace.endTime = Date.now();
        trace.durationMs = trace.endTime - trace.startTime;
        trace.status = status;

        // End root span
        this.endSpan(trace.rootSpan.id, status);

        log.debug(`Trace ended: ${trace.name} (${trace.durationMs}ms, ${status})`);

        if (this.config.autoSave) {
            this.saveTrace(traceId);
        }
    }

    // ── Span Lifecycle ─────────────────────────────────────────

    private createSpan(
        name: string,
        type: Span["type"],
        attributes?: Record<string, unknown>,
    ): Span {
        const span: Span = {
            id: generateId("span"),
            name,
            type,
            startTime: Date.now(),
            status: "running",
            attributes: attributes ?? {},
            events: [],
            children: [],
        };
        this.activeSpans.set(span.id, span);
        return span;
    }

    /**
     * Start a child span within a trace.
     */
    startSpan(
        traceId: string,
        name: string,
        type: Span["type"],
        attributes?: Record<string, unknown>,
        parentSpanId?: string,
    ): string {
        if (!this.enabled) return "";

        const trace = this.traces.get(traceId);
        if (!trace) return "";

        const span = this.createSpan(name, type, attributes);
        span.parentId = parentSpanId ?? trace.rootSpan.id;

        // Attach to parent
        const parent = parentSpanId
            ? this.findSpan(trace.rootSpan, parentSpanId)
            : trace.rootSpan;

        if (parent) {
            parent.children.push(span);
        }

        trace.spanCount++;
        return span.id;
    }

    /**
     * End a span.
     */
    endSpan(spanId: string, status: "success" | "error" = "success"): void {
        if (!this.enabled) return;

        const span = this.activeSpans.get(spanId);
        if (!span) return;

        span.endTime = Date.now();
        span.durationMs = span.endTime - span.startTime;
        span.status = status;
        this.activeSpans.delete(spanId);
    }

    /**
     * Add an event to a span (like a log within the span).
     */
    addEvent(spanId: string, name: string, attributes?: Record<string, unknown>): void {
        if (!this.enabled) return;

        const span = this.activeSpans.get(spanId);
        if (!span) return;

        span.events.push({ name, timestamp: Date.now(), attributes });
    }

    /**
     * Set attributes on a span.
     */
    setAttributes(spanId: string, attributes: Record<string, unknown>): void {
        if (!this.enabled) return;

        const span = this.activeSpans.get(spanId);
        if (!span) return;

        Object.assign(span.attributes, attributes);
    }

    // ── Lookup ─────────────────────────────────────────────────

    private findSpan(root: Span, id: string): Span | null {
        if (root.id === id) return root;
        for (const child of root.children) {
            const found = this.findSpan(child, id);
            if (found) return found;
        }
        return null;
    }

    // ── Retrieval ──────────────────────────────────────────────

    getTrace(traceId: string): Trace | undefined {
        return this.traces.get(traceId);
    }

    getAllTraces(): Trace[] {
        return [...this.traces.values()].sort((a, b) => b.startTime - a.startTime);
    }

    getRecentTraces(limit = 10): Trace[] {
        return this.getAllTraces().slice(0, limit);
    }

    // ── Export ──────────────────────────────────────────────────

    /**
     * Export a trace as JSON.
     */
    toJSON(traceId: string): string | null {
        const trace = this.traces.get(traceId);
        if (!trace) return null;
        return JSON.stringify(trace, null, 2);
    }

    /**
     * Save a trace to disk.
     */
    saveTrace(traceId: string): string | null {
        const json = this.toJSON(traceId);
        if (!json) return null;

        const dir = this.config.outputDir ?? ".groklets/traces";
        try {
            mkdirSync(dir, { recursive: true });
            const filename = `${traceId}.json`;
            const filepath = join(dir, filename);
            writeFileSync(filepath, json);
            log.debug(`Trace saved: ${filepath}`);
            return filepath;
        } catch (err) {
            log.warn(`Failed to save trace: ${(err as Error).message}`);
            return null;
        }
    }

    /**
     * Export all traces as a summary.
     */
    summary(): Array<{
        id: string;
        name: string;
        status: string;
        durationMs: number | undefined;
        spans: number;
        time: string;
    }> {
        return this.getAllTraces().map((t) => ({
            id: t.id,
            name: t.name,
            status: t.status,
            durationMs: t.durationMs,
            spans: t.spanCount,
            time: new Date(t.startTime).toISOString(),
        }));
    }

    // ── Helpers ─────────────────────────────────────────────────

    private pruneOldTraces(): void {
        const max = this.config.maxTraces ?? 100;
        if (this.traces.size <= max) return;

        const sorted = [...this.traces.entries()]
            .sort(([, a], [, b]) => a.startTime - b.startTime);

        const toRemove = sorted.slice(0, sorted.length - max);
        for (const [id] of toRemove) {
            this.traces.delete(id);
        }
    }

    clear(): void {
        this.traces.clear();
        this.activeSpans.clear();
    }
}

/** Global tracer instance. */
export const globalTracer = new Tracer();
