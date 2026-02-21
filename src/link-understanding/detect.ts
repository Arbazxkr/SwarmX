/**
 * Link Understanding — URL detection.
 *
 * Extracts URLs from user messages with:
 *   - Markdown link stripping (avoid double-counting)
 *   - SSRF protection (block private IPs, localhost)
 *   - Deduplication
 *   - Configurable max links
 */

import { DEFAULT_MAX_LINKS } from "./defaults.js";

// ── Regexes ────────────────────────────────────────────────────

/** Matches markdown-style links: [text](https://...) */
const MARKDOWN_LINK_RE = /\[[^\]]*]\((https?:\/\/\S+?)\)/gi;

/** Matches bare URLs: https://example.com/path */
const BARE_LINK_RE = /https?:\/\/\S+/gi;

// ── SSRF Protection ────────────────────────────────────────────

const BLOCKED_HOSTNAMES = new Set([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "[::1]",
    "metadata.google.internal",
    "169.254.169.254",       // AWS/GCP metadata
    "metadata.google.internal",
]);

const PRIVATE_IP_PREFIXES = [
    "10.",
    "172.16.", "172.17.", "172.18.", "172.19.",
    "172.20.", "172.21.", "172.22.", "172.23.",
    "172.24.", "172.25.", "172.26.", "172.27.",
    "172.28.", "172.29.", "172.30.", "172.31.",
    "192.168.",
    "fc00:", "fd00:",       // IPv6 private
];

function isBlockedHostname(hostname: string): boolean {
    const lower = hostname.toLowerCase();

    if (BLOCKED_HOSTNAMES.has(lower)) return true;

    // Block private IP ranges
    for (const prefix of PRIVATE_IP_PREFIXES) {
        if (lower.startsWith(prefix)) return true;
    }

    // Block .local and .internal TLDs
    if (lower.endsWith(".local") || lower.endsWith(".internal")) return true;

    return false;
}

// ── Core ───────────────────────────────────────────────────────

function stripMarkdownLinks(message: string): string {
    return message.replace(MARKDOWN_LINK_RE, " ");
}

function isAllowedUrl(raw: string): boolean {
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return false;
        }
        if (isBlockedHostname(parsed.hostname)) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Extract valid HTTP/HTTPS URLs from a message.
 *
 * Features:
 *   - Strips markdown links before scanning (avoids duplicates)
 *   - SSRF protection (blocks private IPs, localhost, metadata endpoints)
 *   - Deduplicates URLs
 *   - Respects maxLinks limit
 */
export function extractLinksFromMessage(
    message: string,
    opts?: { maxLinks?: number },
): string[] {
    const source = message?.trim();
    if (!source) return [];

    const maxLinks = (opts?.maxLinks && opts.maxLinks > 0) ? opts.maxLinks : DEFAULT_MAX_LINKS;
    const sanitized = stripMarkdownLinks(source);
    const seen = new Set<string>();
    const results: string[] = [];

    for (const match of sanitized.matchAll(BARE_LINK_RE)) {
        let raw = match[0]?.trim();
        if (!raw) continue;

        // Strip trailing punctuation that's not part of URLs
        raw = raw.replace(/[)}\].,;:!?'"]+$/, "");

        if (!isAllowedUrl(raw)) continue;
        if (seen.has(raw)) continue;

        seen.add(raw);
        results.push(raw);

        if (results.length >= maxLinks) break;
    }

    return results;
}
