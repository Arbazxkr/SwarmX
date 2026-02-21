/**
 * Groklets Canvas — Agent-to-UI (A2UI) Push System.
 *
 * Allows agents to push interactive UI to connected clients
 * (WebChat, iOS, Android, macOS). Agents generate HTML/data,
 * Canvas pushes it through the Gateway to rendering surfaces.
 *
 * Features:
 *   - Push HTML/React to client surfaces
 *   - Eval JavaScript in client context
 *   - Snapshot client state
 *   - Canvas sessions (per-client isolated state)
 */

import { type SwarmEngine } from "./engine.js";
import { createEvent } from "./event-bus.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Canvas");

export interface CanvasState {
    id: string;
    clientId: string;
    html: string;
    data: Record<string, unknown>;
    history: Array<{ action: string; timestamp: number }>;
    createdAt: number;
    updatedAt: number;
}

export class CanvasManager {
    private sessions = new Map<string, CanvasState>();

    constructor(private engine: SwarmEngine) { }

    /**
     * Push HTML content to a client's canvas surface.
     */
    async push(clientId: string, html: string, data?: Record<string, unknown>): Promise<void> {
        let session = this.sessions.get(clientId);

        if (!session) {
            session = {
                id: `canvas_${Date.now()}`,
                clientId,
                html: "",
                data: {},
                history: [],
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            this.sessions.set(clientId, session);
        }

        session.html = html;
        if (data) session.data = { ...session.data, ...data };
        session.updatedAt = Date.now();
        session.history.push({ action: "push", timestamp: Date.now() });

        // Publish to Gateway for forwarding to client
        await this.engine.eventBus.publish(createEvent({
            topic: "canvas.push",
            payload: { clientId, html, data: data ?? {} },
            source: "canvas",
            metadata: { clientId },
        }));

        log.info(`Canvas push to ${clientId} (${html.length} chars)`);
    }

    /**
     * Execute JavaScript in a client's canvas context.
     */
    async eval(clientId: string, script: string): Promise<void> {
        const session = this.sessions.get(clientId);
        if (session) {
            session.history.push({ action: "eval", timestamp: Date.now() });
            session.updatedAt = Date.now();
        }

        await this.engine.eventBus.publish(createEvent({
            topic: "canvas.eval",
            payload: { clientId, script },
            source: "canvas",
            metadata: { clientId },
        }));

        log.debug(`Canvas eval to ${clientId}`);
    }

    /**
     * Request a snapshot of the client's current canvas state.
     */
    async snapshot(clientId: string): Promise<void> {
        await this.engine.eventBus.publish(createEvent({
            topic: "canvas.snapshot",
            payload: { clientId },
            source: "canvas",
        }));
    }

    /**
     * Reset a client's canvas.
     */
    async reset(clientId: string): Promise<void> {
        this.sessions.delete(clientId);

        await this.engine.eventBus.publish(createEvent({
            topic: "canvas.reset",
            payload: { clientId },
            source: "canvas",
        }));

        log.info(`Canvas reset for ${clientId}`);
    }

    /**
     * Push a pre-built UI component.
     */
    async pushComponent(clientId: string, component: CanvasComponent): Promise<void> {
        const html = renderComponent(component);
        await this.push(clientId, html, component.data);
    }

    /**
     * Get canvas session for a client.
     */
    getSession(clientId: string): CanvasState | undefined {
        return this.sessions.get(clientId);
    }

    get activeSessions(): number { return this.sessions.size; }
}

// ── Pre-built Canvas Components ───────────────────────────────

export type CanvasComponent =
    | { type: "card"; title: string; content: string; actions?: string[]; data?: Record<string, unknown> }
    | { type: "form"; fields: Array<{ name: string; label: string; type: string }>; submitLabel?: string; data?: Record<string, unknown> }
    | { type: "chart"; chartType: "bar" | "line" | "pie"; labels: string[]; values: number[]; title?: string; data?: Record<string, unknown> }
    | { type: "table"; headers: string[]; rows: string[][]; data?: Record<string, unknown> }
    | { type: "markdown"; content: string; data?: Record<string, unknown> }
    | { type: "html"; html: string; data?: Record<string, unknown> };

function renderComponent(component: CanvasComponent): string {
    const styles = `<style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:-apple-system,sans-serif; background:#0a0a0f; color:#e0e0e0; padding:20px; }
    .card { background:#18181b; border:1px solid #27272a; border-radius:12px; padding:20px; }
    .card h2 { font-size:18px; margin-bottom:12px; }
    .card p { color:#a1a1aa; line-height:1.6; }
    .btn { padding:8px 16px; border-radius:8px; border:none; background:#3b82f6; color:white; cursor:pointer; margin-right:8px; margin-top:12px; }
    input,select,textarea { width:100%; padding:10px; border-radius:8px; border:1px solid #27272a; background:#0a0a0f; color:#e0e0e0; margin-bottom:12px; }
    table { width:100%; border-collapse:collapse; }
    th,td { padding:10px; border-bottom:1px solid #27272a; text-align:left; }
    th { color:#71717a; font-size:12px; text-transform:uppercase; }
  </style>`;

    switch (component.type) {
        case "card":
            return `${styles}<div class="card"><h2>${component.title}</h2><p>${component.content}</p>${(component.actions ?? []).map(a => `<button class="btn">${a}</button>`).join("")}</div>`;

        case "form":
            const fields = component.fields.map(f =>
                `<label style="display:block;margin-bottom:4px;color:#71717a;font-size:12px">${f.label}</label><input type="${f.type}" name="${f.name}" placeholder="${f.label}" />`
            ).join("");
            return `${styles}<div class="card"><form>${fields}<button class="btn" type="submit">${component.submitLabel ?? "Submit"}</button></form></div>`;

        case "chart":
            const maxVal = Math.max(...component.values, 1);
            const bars = component.labels.map((l, i) =>
                `<div style="display:flex;align-items:center;margin-bottom:8px"><span style="width:80px;font-size:12px;color:#71717a">${l}</span><div style="flex:1;background:#27272a;border-radius:4px;height:24px"><div style="width:${(component.values[i] / maxVal) * 100}%;background:#3b82f6;height:100%;border-radius:4px;display:flex;align-items:center;padding-left:8px;font-size:11px;color:white">${component.values[i]}</div></div></div>`
            ).join("");
            return `${styles}<div class="card">${component.title ? `<h2>${component.title}</h2>` : ""}${bars}</div>`;

        case "table":
            const ths = component.headers.map(h => `<th>${h}</th>`).join("");
            const trs = component.rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("");
            return `${styles}<div class="card"><table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;

        case "markdown":
            return `${styles}<div class="card"><div style="white-space:pre-wrap;line-height:1.6">${component.content}</div></div>`;

        case "html":
            return component.html;
    }
}
