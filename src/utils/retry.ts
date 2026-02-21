/**
 * Groklets — Retry utility for provider API calls.
 */

import { createLogger } from "./logger.js";

const log = createLogger("Retry");

export interface RetryOptions {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
}

const DEFAULTS: RetryOptions = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
};

/**
 * Retry a function with exponential backoff.
 * Handles rate limits (429) and server errors (5xx) gracefully.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    opts: Partial<RetryOptions> = {},
): Promise<T> {
    const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULTS, ...opts };

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            lastError = err;

            // Don't retry on auth errors or bad requests
            const status = err?.status ?? err?.statusCode ?? 0;
            if (status === 401 || status === 403 || status === 400) throw err;

            if (attempt >= maxRetries) break;

            // Exponential backoff with jitter
            const delay = Math.min(baseDelayMs * 2 ** attempt + Math.random() * 500, maxDelayMs);
            log.warn(`Attempt ${attempt + 1}/${maxRetries} failed, retrying in ${Math.round(delay)}ms`);
            await new Promise((r) => setTimeout(r, delay));
        }
    }

    throw lastError;
}
