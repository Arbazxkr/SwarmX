/**
 * SwarmX Model Failover — Automatic fallback when a provider fails.
 *
 * Wraps multiple providers in priority order. If the primary fails,
 * automatically tries the next one. Tracks health per-provider
 * and routes away from unhealthy providers.
 */

import {
    type ProviderBase,
    type ProviderConfig,
    type Message,
    type CompletionResponse,
    type ToolDefinition,
} from "./provider.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Failover");

interface ProviderHealth {
    name: string;
    provider: ProviderBase;
    failures: number;
    lastFailure: number;
    cooldownMs: number;
    healthy: boolean;
}

export interface FailoverConfig {
    /** Max consecutive failures before marking unhealthy */
    maxFailures?: number;
    /** Cooldown before retrying an unhealthy provider (ms) */
    cooldownMs?: number;
}

/**
 * Failover provider — wraps N providers in priority order.
 * If provider[0] fails, tries provider[1], etc.
 * Unhealthy providers are skipped until cooldown expires.
 */
export class FailoverProvider implements ProviderBase {
    readonly name: string;
    readonly config: ProviderConfig;
    private chain: ProviderHealth[];
    private maxFailures: number;
    private defaultCooldown: number;

    constructor(
        name: string,
        providers: ProviderBase[],
        opts: FailoverConfig = {},
    ) {
        if (providers.length === 0) throw new Error("FailoverProvider needs at least 1 provider");

        this.name = name;
        this.config = providers[0].config;
        this.maxFailures = opts.maxFailures ?? 3;
        this.defaultCooldown = opts.cooldownMs ?? 30_000;

        this.chain = providers.map((p) => ({
            name: p.name,
            provider: p,
            failures: 0,
            lastFailure: 0,
            cooldownMs: this.defaultCooldown,
            healthy: true,
        }));

        log.info(`Failover chain: ${this.chain.map((c) => c.name).join(" → ")}`);
    }

    private getAvailable(): ProviderHealth[] {
        const now = Date.now();
        return this.chain.filter((p) => {
            if (p.healthy) return true;
            // Check if cooldown expired
            if (now - p.lastFailure > p.cooldownMs) {
                p.healthy = true;
                p.failures = 0;
                log.info(`Provider ${p.name} recovered (cooldown expired)`);
                return true;
            }
            return false;
        });
    }

    private markFailed(entry: ProviderHealth): void {
        entry.failures++;
        entry.lastFailure = Date.now();
        if (entry.failures >= this.maxFailures) {
            entry.healthy = false;
            log.warn(`Provider ${entry.name} marked unhealthy (${entry.failures} consecutive failures, cooling down ${entry.cooldownMs}ms)`);
        }
    }

    private markSuccess(entry: ProviderHealth): void {
        if (entry.failures > 0) {
            log.debug(`Provider ${entry.name} recovered`);
        }
        entry.failures = 0;
        entry.healthy = true;
    }

    async complete(messages: Message[], tools?: ToolDefinition[], overrides?: Partial<ProviderConfig>): Promise<CompletionResponse> {
        const available = this.getAvailable();
        if (available.length === 0) {
            throw new Error("All providers in failover chain are unhealthy");
        }

        let lastError: unknown;
        for (const entry of available) {
            try {
                const result = await entry.provider.complete(messages, tools, overrides);
                this.markSuccess(entry);
                return result;
            } catch (err) {
                lastError = err;
                this.markFailed(entry);
                log.warn(`Provider ${entry.name} failed: ${err instanceof Error ? err.message : err}`);

                // Don't retry on auth errors
                const status = (err as any)?.status ?? 0;
                if (status === 401 || status === 403) throw err;
            }
        }

        throw lastError;
    }

    async *stream(messages: Message[], tools?: ToolDefinition[], overrides?: Partial<ProviderConfig>): AsyncIterable<string> {
        const available = this.getAvailable();
        if (available.length === 0) throw new Error("All providers unhealthy");

        let lastError: unknown;
        for (const entry of available) {
            try {
                if (!entry.provider.stream) {
                    log.debug(`Provider ${entry.name} doesn't support streaming, skipping`);
                    continue;
                }
                yield* entry.provider.stream(messages, tools, overrides);
                this.markSuccess(entry);
                return;
            } catch (err) {
                lastError = err;
                this.markFailed(entry);
            }
        }

        throw lastError;
    }

    async healthCheck(): Promise<boolean> {
        const results = await Promise.allSettled(
            this.chain.map(async (entry) => {
                if (entry.provider.healthCheck) return entry.provider.healthCheck();
                return true;
            }),
        );
        return results.some((r) => r.status === "fulfilled" && r.value === true);
    }

    /** Current health status of all providers in chain */
    get healthStatus(): Array<{ name: string; healthy: boolean; failures: number }> {
        return this.chain.map((c) => ({ name: c.name, healthy: c.healthy, failures: c.failures }));
    }
}
