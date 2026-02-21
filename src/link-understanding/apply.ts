/**
 * Link Understanding — apply to agent messages.
 *
 * Scans a user message for URLs, fetches their content,
 * and injects it into the message context so the agent
 * can reason about linked content.
 */

import type { Message } from "../core/provider.js";
import { createLogger } from "../utils/logger.js";
import { formatLinkUnderstandingBody } from "./format.js";
import { runLinkUnderstanding, type LinkConfig, type LinkUnderstandingResult } from "./runner.js";

const log = createLogger("LinkUnderstanding");

export interface ApplyLinkUnderstandingResult extends LinkUnderstandingResult {
    /** The enriched message with link content appended. */
    enrichedContent: string;
}

/**
 * Apply link understanding to a message.
 *
 * Takes a user message, extracts URLs, fetches their content,
 * and returns an enriched version of the message with the
 * fetched content appended.
 *
 * Usage:
 * ```ts
 * const result = await applyLinkUnderstanding(
 *     "Check out https://example.com",
 *     { maxLinks: 3 }
 * );
 * // result.enrichedContent contains the original message
 * // plus the fetched page content
 * ```
 */
export async function applyLinkUnderstanding(
    message: string,
    config?: LinkConfig,
): Promise<ApplyLinkUnderstandingResult> {
    const result = await runLinkUnderstanding(message, config);

    if (result.outputs.length === 0) {
        return { ...result, enrichedContent: message };
    }

    const enrichedContent = formatLinkUnderstandingBody({
        body: message,
        outputs: result.outputs,
    });

    log.info(`Enriched message with ${result.outputs.length} link(s)`);

    return { ...result, enrichedContent };
}

/**
 * Middleware: Process messages array and enrich any user messages
 * that contain URLs. Returns a new messages array with enriched content.
 */
export async function enrichMessagesWithLinks(
    messages: Message[],
    config?: LinkConfig,
): Promise<Message[]> {
    const enriched: Message[] = [];

    for (const msg of messages) {
        if (msg.role === "user" && typeof msg.content === "string") {
            const result = await applyLinkUnderstanding(msg.content, config);
            if (result.urls.length > 0 && result.enrichedContent !== msg.content) {
                enriched.push({ ...msg, content: result.enrichedContent });
                continue;
            }
        }
        enriched.push(msg);
    }

    return enriched;
}
