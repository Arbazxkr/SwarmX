/**
 * Groklets Context Manager — Smart context window management.
 *
 * Handles:
 *   - Token counting (rough + provider-reported)
 *   - Session pruning when hitting token limits
 *   - Context compaction (summarize old messages to save tokens)
 *   - Sliding window over conversation history
 */

import { type Message, type ProviderBase, Role } from "./provider.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Context");

export interface ContextConfig {
    /** Max tokens for the context window */
    maxContextTokens?: number;
    /** Keep at least this many recent messages */
    minRecentMessages?: number;
    /** When to trigger pruning (% of max tokens) */
    pruneThreshold?: number;
    /** Strategy for pruning */
    strategy?: "sliding-window" | "summarize" | "drop-oldest";
}

const DEFAULTS: ContextConfig = {
    maxContextTokens: 100_000,
    minRecentMessages: 10,
    pruneThreshold: 0.85,
    strategy: "sliding-window",
};

/**
 * Rough token estimate. ~4 chars per token for English.
 */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
        total += estimateTokens(msg.content) + 4; // 4 tokens overhead per message
    }
    return total;
}

/**
 * Prune messages using sliding window.
 * Keeps system messages + the most recent N messages.
 */
export function pruneSliding(messages: Message[], maxTokens: number, minRecent: number): Message[] {
    const system = messages.filter((m) => m.role === Role.SYSTEM);
    const nonSystem = messages.filter((m) => m.role !== Role.SYSTEM);
    const systemTokens = estimateMessagesTokens(system);

    const budget = maxTokens - systemTokens;
    if (budget <= 0) return system;

    // Keep recent messages that fit within budget
    const kept: Message[] = [];
    let used = 0;

    for (let i = nonSystem.length - 1; i >= 0; i--) {
        const msgTokens = estimateTokens(nonSystem[i].content) + 4;
        if (used + msgTokens > budget && kept.length >= minRecent) break;
        kept.unshift(nonSystem[i]);
        used += msgTokens;
    }

    const result = [...system, ...kept];
    const dropped = nonSystem.length - kept.length;
    if (dropped > 0) {
        log.info(`Pruned ${dropped} messages (${estimateMessagesTokens(messages)} → ${estimateMessagesTokens(result)} est. tokens)`);
    }

    return result;
}

/**
 * Compact messages by summarizing old conversation into a single message.
 * Uses the LLM itself to create the summary.
 */
export async function compactWithSummary(
    messages: Message[],
    provider: ProviderBase,
    maxTokens: number,
    minRecent: number,
): Promise<Message[]> {
    const system = messages.filter((m) => m.role === Role.SYSTEM);
    const nonSystem = messages.filter((m) => m.role !== Role.SYSTEM);

    if (estimateMessagesTokens(messages) <= maxTokens) return messages;

    // Split: old messages to summarize, recent to keep
    const keepCount = Math.max(minRecent, Math.floor(nonSystem.length * 0.3));
    const toSummarize = nonSystem.slice(0, -keepCount);
    const toKeep = nonSystem.slice(-keepCount);

    if (toSummarize.length === 0) return messages;

    log.info(`Compacting ${toSummarize.length} messages into summary...`);

    // Ask LLM to summarize
    const summaryPrompt: Message[] = [
        {
            role: Role.SYSTEM,
            content: "You are a conversation summarizer. Produce a concise summary of the following conversation, preserving key facts, decisions, and context. Output ONLY the summary, no preamble.",
        },
        {
            role: Role.USER,
            content: toSummarize.map((m) => `${m.role}: ${m.content}`).join("\n"),
        },
    ];

    try {
        const result = await provider.complete(summaryPrompt);
        const summaryMsg: Message = {
            role: Role.SYSTEM,
            content: `[Previous conversation summary]\n${result.message.content}`,
        };

        const compacted = [...system, summaryMsg, ...toKeep];
        log.info(`Compacted: ${messages.length} → ${compacted.length} messages (${estimateMessagesTokens(compacted)} est. tokens)`);
        return compacted;
    } catch (err) {
        log.error(`Compaction failed, falling back to sliding window: ${err}`);
        return pruneSliding(messages, maxTokens, minRecent);
    }
}

/**
 * ContextManager — manages a single agent's context window.
 */
export class ContextManager {
    private config: Required<ContextConfig>;

    constructor(config?: ContextConfig) {
        this.config = { ...DEFAULTS, ...config } as Required<ContextConfig>;
    }

    /**
     * Check if messages need pruning.
     */
    needsPruning(messages: Message[]): boolean {
        const tokens = estimateMessagesTokens(messages);
        const threshold = this.config.maxContextTokens * this.config.pruneThreshold;
        return tokens > threshold;
    }

    /**
     * Prune messages using configured strategy.
     */
    prune(messages: Message[]): Message[] {
        if (!this.needsPruning(messages)) return messages;

        switch (this.config.strategy) {
            case "drop-oldest": {
                const system = messages.filter((m) => m.role === Role.SYSTEM);
                const recent = messages.filter((m) => m.role !== Role.SYSTEM).slice(-this.config.minRecentMessages);
                return [...system, ...recent];
            }
            case "sliding-window":
            default:
                return pruneSliding(messages, this.config.maxContextTokens, this.config.minRecentMessages);
        }
    }

    /**
     * Compact messages using LLM summarization.
     */
    async compact(messages: Message[], provider: ProviderBase): Promise<Message[]> {
        return compactWithSummary(messages, provider, this.config.maxContextTokens, this.config.minRecentMessages);
    }

    /**
     * Token usage stats for a message list.
     */
    usage(messages: Message[]): { estimated: number; max: number; percent: number } {
        const estimated = estimateMessagesTokens(messages);
        return {
            estimated,
            max: this.config.maxContextTokens,
            percent: Math.round((estimated / this.config.maxContextTokens) * 100),
        };
    }
}
