/**
 * Link Understanding — runner.
 *
 * Fetches URL content and converts to text for agent context.
 * Supports two modes:
 *   1. Built-in HTTP fetch (default) — uses Node's fetch + HTML-to-text
 *   2. CLI command — runs an external command (like OpenClaw)
 */

import { createLogger } from "../utils/logger.js";
import { extractLinksFromMessage } from "./detect.js";
import {
    DEFAULT_LINK_TIMEOUT_SECONDS,
    DEFAULT_MAX_RESPONSE_BYTES,
    DEFAULT_USER_AGENT,
} from "./defaults.js";

const log = createLogger("LinkUnderstanding");

// ── Types ──────────────────────────────────────────────────────

export interface LinkConfig {
    /** Enable/disable link understanding. Default: true */
    enabled?: boolean;
    /** Maximum links per message. Default: 3 */
    maxLinks?: number;
    /** Timeout per link in seconds. Default: 30 */
    timeoutSeconds?: number;
    /** Max response size in bytes. Default: 512KB */
    maxResponseBytes?: number;
    /** Fetch mode: "builtin" (default) or "cli" */
    mode?: "builtin" | "cli";
    /** CLI command template. Use {{url}} for the URL placeholder. */
    command?: string;
    /** Custom headers for HTTP requests. */
    headers?: Record<string, string>;
}

export interface LinkResult {
    url: string;
    content: string | null;
    error?: string;
    durationMs: number;
}

export interface LinkUnderstandingResult {
    urls: string[];
    outputs: string[];
    results: LinkResult[];
}

// ── HTML to Text ───────────────────────────────────────────────

function htmlToText(html: string): string {
    let text = html;

    // Remove script and style blocks
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");

    // Convert common elements
    text = text.replace(/<title[^>]*>([\s\S]*?)<\/title>/gi, "# $1\n\n");
    text = text.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n## $1\n");
    text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n");
    text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<hr\s*\/?>/gi, "\n---\n");

    // Extract link text
    text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)");

    // Remove all remaining tags
    text = text.replace(/<[^>]+>/g, "");

    // Decode common HTML entities
    text = text.replace(/&amp;/g, "&");
    text = text.replace(/&lt;/g, "<");
    text = text.replace(/&gt;/g, ">");
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&nbsp;/g, " ");

    // Collapse whitespace
    text = text.replace(/\n{3,}/g, "\n\n");
    text = text.replace(/[ \t]+/g, " ");

    return text.trim();
}

// ── Fetchers ───────────────────────────────────────────────────

async function fetchBuiltin(
    url: string,
    config: LinkConfig,
): Promise<string | null> {
    const timeoutMs = (config.timeoutSeconds ?? DEFAULT_LINK_TIMEOUT_SECONDS) * 1000;
    const maxBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                "User-Agent": DEFAULT_USER_AGENT,
                "Accept": "text/html, application/json, text/plain",
                ...config.headers,
            },
            redirect: "follow",
        });

        if (!response.ok) {
            log.debug(`HTTP ${response.status} for ${url}`);
            return null;
        }

        const contentType = response.headers.get("content-type") ?? "";

        // Read with size limit
        const reader = response.body?.getReader();
        if (!reader) return null;

        const chunks: Uint8Array[] = [];
        let totalSize = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalSize += value.length;
            if (totalSize > maxBytes) {
                reader.cancel();
                break;
            }
            chunks.push(value);
        }

        const body = new TextDecoder().decode(
            Buffer.concat(chunks),
        );

        // Convert based on content type
        if (contentType.includes("application/json")) {
            try {
                const parsed = JSON.parse(body);
                return JSON.stringify(parsed, null, 2).slice(0, 10_000);
            } catch {
                return body.slice(0, 10_000);
            }
        }

        if (contentType.includes("text/plain")) {
            return body.slice(0, 10_000);
        }

        // HTML — convert to text
        return htmlToText(body).slice(0, 10_000);
    } finally {
        clearTimeout(timer);
    }
}

async function fetchCli(
    url: string,
    config: LinkConfig,
): Promise<string | null> {
    const command = config.command?.replace(/\{\{url\}\}/g, url);
    if (!command) {
        log.warn("CLI mode enabled but no command configured");
        return null;
    }

    const { execSync } = await import("node:child_process");
    const timeoutMs = (config.timeoutSeconds ?? DEFAULT_LINK_TIMEOUT_SECONDS) * 1000;

    try {
        const output = execSync(command, {
            timeout: timeoutMs,
            maxBuffer: DEFAULT_MAX_RESPONSE_BYTES,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        });
        return output.trim() || null;
    } catch (err) {
        log.debug(`CLI fetch failed for ${url}: ${(err as Error).message}`);
        return null;
    }
}

// ── Main Runner ────────────────────────────────────────────────

async function fetchLink(
    url: string,
    config: LinkConfig,
): Promise<LinkResult> {
    const start = Date.now();

    try {
        const content = config.mode === "cli"
            ? await fetchCli(url, config)
            : await fetchBuiltin(url, config);

        return {
            url,
            content,
            durationMs: Date.now() - start,
        };
    } catch (err) {
        return {
            url,
            content: null,
            error: (err as Error).message,
            durationMs: Date.now() - start,
        };
    }
}

/**
 * Run link understanding on a message.
 *
 * 1. Extracts URLs from the message
 * 2. Fetches content from each URL (with timeout + size limits)
 * 3. Returns structured results
 */
export async function runLinkUnderstanding(
    message: string,
    config?: LinkConfig,
): Promise<LinkUnderstandingResult> {
    const cfg: LinkConfig = { enabled: true, ...config };

    if (cfg.enabled === false) {
        return { urls: [], outputs: [], results: [] };
    }

    const urls = extractLinksFromMessage(message, { maxLinks: cfg.maxLinks });
    if (urls.length === 0) {
        return { urls: [], outputs: [], results: [] };
    }

    log.info(`Processing ${urls.length} link(s)`);

    // Fetch all links concurrently
    const results = await Promise.all(
        urls.map((url) => fetchLink(url, cfg)),
    );

    const outputs: string[] = [];
    for (const result of results) {
        if (result.content) {
            outputs.push(`[Content from ${result.url}]\n${result.content}`);
            log.debug(`Fetched ${result.url} (${result.durationMs}ms)`);
        } else if (result.error) {
            log.warn(`Failed ${result.url}: ${result.error}`);
        }
    }

    return { urls, outputs, results };
}
