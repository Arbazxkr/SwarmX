/**
 * SwarmX Usage Tracker — Token counting and cost tracking per model.
 */

import { createLogger } from "../utils/logger.js";

const log = createLogger("Usage");

// Pricing per 1M tokens (USD) — as of 2026
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
    // OpenAI
    "gpt-4o": { input: 2.50, output: 10.00 },
    "gpt-4o-mini": { input: 0.15, output: 0.60 },
    "gpt-4-turbo": { input: 10.00, output: 30.00 },
    "gpt-4": { input: 30.00, output: 60.00 },
    "gpt-3.5-turbo": { input: 0.50, output: 1.50 },
    // Anthropic
    "claude-sonnet-4-20250514": { input: 3.00, output: 15.00 },
    "claude-3-5-sonnet-20241022": { input: 3.00, output: 15.00 },
    "claude-3-opus-20240229": { input: 15.00, output: 75.00 },
    "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
    // Google
    "gemini-2.0-flash": { input: 0.10, output: 0.40 },
    "gemini-1.5-pro": { input: 1.25, output: 5.00 },
    "gemini-1.5-flash": { input: 0.075, output: 0.30 },
    // xAI
    "grok-2-latest": { input: 2.00, output: 10.00 },
};

interface UsageEntry {
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
    timestamp: number;
}

export class UsageTracker {
    private entries: UsageEntry[] = [];
    private totals = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        calls: 0,
    };

    /**
     * Track a completion call.
     */
    track(model: string, promptTokens: number, completionTokens: number): UsageEntry {
        const totalTokens = promptTokens + completionTokens;
        const pricing = MODEL_PRICING[model];

        let costUsd = 0;
        if (pricing) {
            costUsd = (promptTokens / 1_000_000) * pricing.input + (completionTokens / 1_000_000) * pricing.output;
        }

        const entry: UsageEntry = {
            model,
            promptTokens,
            completionTokens,
            totalTokens,
            costUsd,
            timestamp: Date.now(),
        };

        this.entries.push(entry);
        this.totals.promptTokens += promptTokens;
        this.totals.completionTokens += completionTokens;
        this.totals.totalTokens += totalTokens;
        this.totals.costUsd += costUsd;
        this.totals.calls++;

        return entry;
    }

    /**
     * Get totals.
     */
    get summary() {
        return {
            ...this.totals,
            costFormatted: `$${this.totals.costUsd.toFixed(4)}`,
        };
    }

    /**
     * Get per-model breakdown.
     */
    breakdown(): Record<string, { calls: number; tokens: number; costUsd: number }> {
        const models: Record<string, { calls: number; tokens: number; costUsd: number }> = {};
        for (const e of this.entries) {
            if (!models[e.model]) models[e.model] = { calls: 0, tokens: 0, costUsd: 0 };
            models[e.model].calls++;
            models[e.model].tokens += e.totalTokens;
            models[e.model].costUsd += e.costUsd;
        }
        return models;
    }

    /**
     * Get recent entries.
     */
    recent(limit = 20): UsageEntry[] {
        return this.entries.slice(-limit);
    }

    /**
     * Reset all tracking.
     */
    reset(): void {
        this.entries = [];
        this.totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, calls: 0 };
    }

    /**
     * Check if a known model has pricing.
     */
    static hasPricing(model: string): boolean {
        return model in MODEL_PRICING;
    }

    /**
     * Register custom model pricing.
     */
    static registerPricing(model: string, inputPer1M: number, outputPer1M: number): void {
        MODEL_PRICING[model] = { input: inputPer1M, output: outputPer1M };
    }
}
