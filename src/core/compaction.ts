/**
 * Context Compaction — smart pruning for long conversations.
 *
 * Strategies:
 *   1. Sliding window — keep last N messages
 *   2. Summary compaction — summarize old messages, keep recent
 *   3. Token budget — prune to fit within token limit
 *   4. Importance scoring — keep important messages, drop filler
 */

import { type Message, Role } from "./provider.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Compaction");

// ── Types ──────────────────────────────────────────────────────

export interface CompactionConfig {
    /** Max tokens before compaction triggers. Default: 8000 */
    maxTokens?: number;
    /** Strategy: "sliding" | "summary" | "budget". Default: "sliding" */
    strategy?: "sliding" | "summary" | "budget";
    /** Number of recent messages to always keep. Default: 10 */
    keepRecent?: number;
    /** Always preserve system messages. Default: true */
    preserveSystem?: boolean;
    /** Summary function (for "summary" strategy). User-provided. */
    summarizer?: (messages: Message[]) => Promise<string>;
}

export interface CompactionResult {
    messages: Message[];
    compacted: boolean;
    originalCount: number;
    newCount: number;
    removedCount: number;
    strategy: string;
}

// ── Token Estimation ───────────────────────────────────────────

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function estimateMessageTokens(messages: Message[]): number {
    return messages.reduce((sum, m) => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return sum + estimateTokens(content) + 4; // 4 tokens overhead per message
    }, 0);
}

// ── Scoring ────────────────────────────────────────────────────

function scoreMessage(msg: Message, index: number, total: number): number {
    let score = 0;

    // System messages are critical
    if (msg.role === "system") return 1000;

    // Recent messages are more important
    const recency = index / total;
    score += recency * 50;

    // Messages with tool calls are important
    if (msg.toolCalls && msg.toolCalls.length > 0) score += 30;
    if (msg.role === "tool") score += 25;

    // Longer messages likely contain more substance
    const content = typeof msg.content === "string" ? msg.content : "";
    if (content.length > 200) score += 10;
    if (content.length > 500) score += 10;

    // Questions are important
    if (content.includes("?")) score += 5;

    return score;
}

// ── Strategies ─────────────────────────────────────────────────

function slidingWindow(
    messages: Message[],
    config: Required<Pick<CompactionConfig, "keepRecent" | "preserveSystem">>,
): Message[] {
    const { keepRecent, preserveSystem } = config;
    const system: Message[] = [];
    const nonSystem: Message[] = [];

    for (const msg of messages) {
        if (preserveSystem && msg.role === "system") {
            system.push(msg);
        } else {
            nonSystem.push(msg);
        }
    }

    const kept = nonSystem.slice(-keepRecent);
    return [...system, ...kept];
}

async function summaryCompaction(
    messages: Message[],
    config: Required<Pick<CompactionConfig, "keepRecent" | "preserveSystem" | "summarizer">>,
): Promise<Message[]> {
    const { keepRecent, preserveSystem, summarizer } = config;
    const system: Message[] = [];
    const nonSystem: Message[] = [];

    for (const msg of messages) {
        if (preserveSystem && msg.role === "system") {
            system.push(msg);
        } else {
            nonSystem.push(msg);
        }
    }

    if (nonSystem.length <= keepRecent) {
        return messages;
    }

    const toSummarize = nonSystem.slice(0, -keepRecent);
    const toKeep = nonSystem.slice(-keepRecent);

    const summary = await summarizer(toSummarize);
    const summaryMessage: Message = {
        role: Role.SYSTEM,
        content: `[Conversation Summary]\n${summary}`,
    };

    return [...system, summaryMessage, ...toKeep];
}

function budgetCompaction(
    messages: Message[],
    config: Required<Pick<CompactionConfig, "maxTokens" | "preserveSystem">>,
): Message[] {
    const { maxTokens, preserveSystem } = config;

    // Score all messages
    const scored = messages.map((msg, i) => ({
        msg,
        score: scoreMessage(msg, i, messages.length),
        index: i,
    }));

    // Sort by score descending (keep highest scored)
    const sorted = [...scored].sort((a, b) => b.score - a.score);

    // Greedily add messages until budget exhausted
    const selected = new Set<number>();
    let tokenBudget = maxTokens;

    for (const item of sorted) {
        const content = typeof item.msg.content === "string" ? item.msg.content : "";
        const tokens = estimateTokens(content) + 4;
        if (tokenBudget - tokens >= 0) {
            selected.add(item.index);
            tokenBudget -= tokens;
        }
    }

    // Return in original order
    return messages.filter((_, i) => selected.has(i));
}

// ── Main API ───────────────────────────────────────────────────

/**
 * Compact a conversation to fit within limits.
 *
 * Usage:
 * ```ts
 * const result = await compactMessages(messages, {
 *     maxTokens: 8000,
 *     strategy: "sliding",
 *     keepRecent: 20,
 * });
 * // result.messages is the compacted array
 * ```
 */
export async function compactMessages(
    messages: Message[],
    config?: CompactionConfig,
): Promise<CompactionResult> {
    const maxTokens = config?.maxTokens ?? 8000;
    const strategy = config?.strategy ?? "sliding";
    const keepRecent = config?.keepRecent ?? 10;
    const preserveSystem = config?.preserveSystem !== false;
    const originalCount = messages.length;

    // Check if compaction is needed
    const currentTokens = estimateMessageTokens(messages);
    if (currentTokens <= maxTokens && messages.length <= keepRecent * 2) {
        return {
            messages,
            compacted: false,
            originalCount,
            newCount: messages.length,
            removedCount: 0,
            strategy: "none",
        };
    }

    let result: Message[];

    switch (strategy) {
        case "summary":
            if (!config?.summarizer) {
                log.warn("Summary strategy requires a summarizer function. Falling back to sliding.");
                result = slidingWindow(messages, { keepRecent, preserveSystem });
            } else {
                result = await summaryCompaction(messages, {
                    keepRecent,
                    preserveSystem,
                    summarizer: config.summarizer,
                });
            }
            break;

        case "budget":
            result = budgetCompaction(messages, { maxTokens, preserveSystem });
            break;

        case "sliding":
        default:
            result = slidingWindow(messages, { keepRecent, preserveSystem });
            break;
    }

    const removedCount = originalCount - result.length;
    if (removedCount > 0) {
        log.info(`Compacted: ${originalCount} → ${result.length} messages (${strategy}, removed ${removedCount})`);
    }

    return {
        messages: result,
        compacted: removedCount > 0,
        originalCount,
        newCount: result.length,
        removedCount,
        strategy,
    };
}
