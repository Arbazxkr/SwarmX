/**
 * SwarmX Security — Sandboxing, skill trust, and input validation.
 *
 * Features:
 *   - Skill signature verification
 *   - Input sanitization
 *   - Rate limiting
 *   - Sandboxed code execution
 *   - Allowlist / blocklist for tools
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Security");

// ── Skill Trust ───────────────────────────────────────────────

export interface TrustEntry {
    skillName: string;
    hash: string;
    trusted: boolean;
    verifiedAt: number;
    source: "bundled" | "community" | "local";
}

export class SkillTrustManager {
    private trusted = new Map<string, TrustEntry>();

    /**
     * Compute SHA-256 hash of a skill's index.js.
     */
    hashSkill(skillPath: string): string {
        const indexPath = join(skillPath, "index.js");
        if (!existsSync(indexPath)) throw new Error(`Skill not found: ${skillPath}`);
        const content = readFileSync(indexPath);
        return createHash("sha256").update(content).digest("hex");
    }

    /**
     * Trust a skill after verification.
     */
    trust(skillName: string, skillPath: string, source: TrustEntry["source"] = "local"): TrustEntry {
        const hash = this.hashSkill(skillPath);
        const entry: TrustEntry = {
            skillName, hash, trusted: true,
            verifiedAt: Date.now(), source,
        };
        this.trusted.set(skillName, entry);
        log.info(`Trusted skill: ${skillName} (${source}, ${hash.slice(0, 8)}...)`);
        return entry;
    }

    /**
     * Verify a skill hasn't been tampered with.
     */
    verify(skillName: string, skillPath: string): boolean {
        const entry = this.trusted.get(skillName);
        if (!entry) return false;
        const currentHash = this.hashSkill(skillPath);
        const valid = currentHash === entry.hash;
        if (!valid) log.warn(`Skill '${skillName}' hash mismatch — possible tampering`);
        return valid;
    }

    isTrusted(skillName: string): boolean {
        return this.trusted.get(skillName)?.trusted ?? false;
    }

    get entries(): TrustEntry[] { return [...this.trusted.values()]; }
}

// ── Input Sanitization ────────────────────────────────────────

export class InputSanitizer {
    private blockedPatterns: RegExp[] = [
        /(<script[\s>])/gi,
        /(javascript:)/gi,
        /(on\w+\s*=)/gi,
        /(\beval\s*\()/gi,
        /(\bexec\s*\()/gi,
        /(rm\s+-rf\s+\/)/gi,
        /(DROP\s+TABLE)/gi,
        /(;\s*--)/gi,
        /(\|\|\s*curl\b)/gi,
        /(\|\|\s*wget\b)/gi,
    ];

    private maxLength = 100_000;

    /**
     * Sanitize user input.
     */
    sanitize(input: string): { clean: string; blocked: boolean; reason?: string } {
        if (input.length > this.maxLength) {
            return { clean: input.slice(0, this.maxLength), blocked: true, reason: "Input too long" };
        }

        for (const pattern of this.blockedPatterns) {
            if (pattern.test(input)) {
                log.warn(`Blocked input matching ${pattern.source}`);
                return { clean: "", blocked: true, reason: `Blocked pattern: ${pattern.source}` };
            }
        }

        return { clean: input, blocked: false };
    }

    addBlockedPattern(pattern: RegExp): void {
        this.blockedPatterns.push(pattern);
    }
}

// ── Rate Limiter ──────────────────────────────────────────────

interface RateBucket {
    tokens: number;
    lastRefill: number;
}

export class RateLimiter {
    private buckets = new Map<string, RateBucket>();
    private maxTokens: number;
    private refillRate: number; // tokens per second
    private refillIntervalMs: number;

    constructor(maxTokens = 60, refillPerSecond = 1) {
        this.maxTokens = maxTokens;
        this.refillRate = refillPerSecond;
        this.refillIntervalMs = 1000 / refillPerSecond;
    }

    /**
     * Check if a request is allowed (token bucket algorithm).
     */
    allow(key: string, cost = 1): boolean {
        let bucket = this.buckets.get(key);

        if (!bucket) {
            bucket = { tokens: this.maxTokens, lastRefill: Date.now() };
            this.buckets.set(key, bucket);
        }

        // Refill
        const now = Date.now();
        const elapsed = now - bucket.lastRefill;
        const newTokens = Math.floor(elapsed / this.refillIntervalMs) * this.refillRate;
        bucket.tokens = Math.min(this.maxTokens, bucket.tokens + newTokens);
        bucket.lastRefill = now;

        // Consume
        if (bucket.tokens >= cost) {
            bucket.tokens -= cost;
            return true;
        }

        log.debug(`Rate limited: ${key} (${bucket.tokens} tokens remaining)`);
        return false;
    }

    remaining(key: string): number {
        return this.buckets.get(key)?.tokens ?? this.maxTokens;
    }

    reset(key: string): void {
        this.buckets.delete(key);
    }
}

// ── Tool Allowlist ────────────────────────────────────────────

export class ToolGuard {
    private allowed = new Set<string>();
    private blocked = new Set<string>();
    private mode: "allowlist" | "blocklist" = "blocklist";

    constructor(mode: "allowlist" | "blocklist" = "blocklist") {
        this.mode = mode;
    }

    allow(toolName: string): void { this.allowed.add(toolName); }
    block(toolName: string): void { this.blocked.add(toolName); }

    /**
     * Check if a tool is permitted to execute.
     */
    canExecute(toolName: string): boolean {
        if (this.mode === "allowlist") {
            return this.allowed.has(toolName);
        }
        return !this.blocked.has(toolName);
    }

    /**
     * Validate tool arguments for dangerous patterns.
     */
    validateArgs(toolName: string, args: Record<string, unknown>): { safe: boolean; reason?: string } {
        const argsStr = JSON.stringify(args);

        // Block shell injection in any arg
        if (/[;&|`$]/.test(argsStr) && toolName.includes("browser") || toolName.includes("evaluate")) {
            return { safe: false, reason: "Potential shell injection in arguments" };
        }

        // Block path traversal
        if (/\.\.[\/\\]/.test(argsStr)) {
            return { safe: false, reason: "Path traversal detected" };
        }

        return { safe: true };
    }
}

// ── Sandboxed Execution ───────────────────────────────────────

export class Sandbox {
    private timeout: number;

    constructor(timeoutMs = 5000) {
        this.timeout = timeoutMs;
    }

    /**
     * Execute code in a sandboxed context (vm module).
     */
    async execute(code: string, context: Record<string, unknown> = {}): Promise<string> {
        const { createContext, runInContext } = await import("node:vm");

        const sandbox = {
            console: { log: (...args: unknown[]) => args.join(" ") },
            JSON,
            Math,
            Date,
            parseInt,
            parseFloat,
            String,
            Number,
            Boolean,
            Array,
            Object,
            ...context,
            result: undefined as unknown,
        };

        const vmContext = createContext(sandbox);

        try {
            runInContext(code, vmContext, { timeout: this.timeout });
            return JSON.stringify(sandbox.result ?? "undefined");
        } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
    }
}
