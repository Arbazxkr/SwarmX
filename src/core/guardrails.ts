/**
 * Guardrails — Input/output validation for agents.
 *
 * Configurable safety checks that run before and after agent completions:
 *   - Input guardrails: validate/transform user messages before sending to LLM
 *   - Output guardrails: validate/transform LLM responses before returning
 *
 * Follows OpenAI Agents SDK pattern.
 */

import { createLogger } from "../utils/logger.js";

const log = createLogger("Guardrails");

// ── Types ──────────────────────────────────────────────────────

export interface GuardrailResult {
    passed: boolean;
    message?: string;
    transformed?: string;
}

export type GuardrailFn = (content: string, context?: Record<string, unknown>) => GuardrailResult | Promise<GuardrailResult>;

export interface GuardrailConfig {
    /** Name of this guardrail for logging. */
    name: string;
    /** The validation function. */
    check: GuardrailFn;
    /** If true, block the message. If false, just warn. Default: true */
    blocking?: boolean;
}

export interface GuardrailsConfig {
    input?: GuardrailConfig[];
    output?: GuardrailConfig[];
}

export interface GuardrailReport {
    guardrail: string;
    passed: boolean;
    blocking: boolean;
    message?: string;
    durationMs: number;
}

// ── Built-in Guardrails ────────────────────────────────────────

/** Block messages that exceed a maximum length. */
export function maxLengthGuardrail(maxChars: number): GuardrailConfig {
    return {
        name: "max-length",
        check: (content) => ({
            passed: content.length <= maxChars,
            message: content.length > maxChars
                ? `Message too long: ${content.length} chars (max: ${maxChars})`
                : undefined,
        }),
    };
}

/** Block messages containing specific keywords/patterns. */
export function blockedPatternsGuardrail(patterns: (string | RegExp)[]): GuardrailConfig {
    return {
        name: "blocked-patterns",
        check: (content) => {
            for (const pattern of patterns) {
                const regex = typeof pattern === "string" ? new RegExp(pattern, "i") : pattern;
                if (regex.test(content)) {
                    return { passed: false, message: `Blocked pattern detected: ${pattern}` };
                }
            }
            return { passed: true };
        },
    };
}

/** Ensure output contains required keywords. */
export function requiredContentGuardrail(requiredTerms: string[]): GuardrailConfig {
    return {
        name: "required-content",
        check: (content) => {
            const lower = content.toLowerCase();
            const missing = requiredTerms.filter((t) => !lower.includes(t.toLowerCase()));
            return {
                passed: missing.length === 0,
                message: missing.length > 0
                    ? `Missing required terms: ${missing.join(", ")}`
                    : undefined,
            };
        },
    };
}

/** Block PII (emails, phone numbers, SSNs). */
export function piiGuardrail(): GuardrailConfig {
    const PII_PATTERNS = [
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,           // Email
        /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/,                          // Phone (US)
        /\b\d{3}-\d{2}-\d{4}\b/,                                   // SSN
        /\b(?:\d{4}[-\s]?){3}\d{4}\b/,                             // Credit card
    ];

    return {
        name: "pii-detection",
        check: (content) => {
            for (const pattern of PII_PATTERNS) {
                if (pattern.test(content)) {
                    return { passed: false, message: "PII detected in content" };
                }
            }
            return { passed: true };
        },
    };
}

/** Ensure output is valid JSON (for structured output agents). */
export function jsonOutputGuardrail(): GuardrailConfig {
    return {
        name: "json-output",
        check: (content) => {
            try {
                JSON.parse(content);
                return { passed: true };
            } catch {
                return { passed: false, message: "Output is not valid JSON" };
            }
        },
    };
}

/** Custom word/phrase filter. */
export function toxicityGuardrail(blockedWords: string[]): GuardrailConfig {
    return {
        name: "toxicity-filter",
        check: (content) => {
            const lower = content.toLowerCase();
            const found = blockedWords.filter((w) => lower.includes(w.toLowerCase()));
            return {
                passed: found.length === 0,
                message: found.length > 0 ? `Toxic content detected` : undefined,
            };
        },
    };
}

// ── Guardrail Runner ───────────────────────────────────────────

export class GuardrailRunner {
    private inputGuardrails: GuardrailConfig[];
    private outputGuardrails: GuardrailConfig[];

    constructor(config?: GuardrailsConfig) {
        this.inputGuardrails = config?.input ?? [];
        this.outputGuardrails = config?.output ?? [];
    }

    addInput(guardrail: GuardrailConfig): void {
        this.inputGuardrails.push(guardrail);
    }

    addOutput(guardrail: GuardrailConfig): void {
        this.outputGuardrails.push(guardrail);
    }

    /**
     * Run input guardrails on a user message.
     * Returns transformed content + report of all checks.
     */
    async checkInput(
        content: string,
        context?: Record<string, unknown>,
    ): Promise<{ content: string; passed: boolean; reports: GuardrailReport[] }> {
        return this.runGuardrails(this.inputGuardrails, content, context);
    }

    /**
     * Run output guardrails on an LLM response.
     * Returns transformed content + report of all checks.
     */
    async checkOutput(
        content: string,
        context?: Record<string, unknown>,
    ): Promise<{ content: string; passed: boolean; reports: GuardrailReport[] }> {
        return this.runGuardrails(this.outputGuardrails, content, context);
    }

    private async runGuardrails(
        guardrails: GuardrailConfig[],
        content: string,
        context?: Record<string, unknown>,
    ): Promise<{ content: string; passed: boolean; reports: GuardrailReport[] }> {
        const reports: GuardrailReport[] = [];
        let currentContent = content;
        let allPassed = true;

        for (const guardrail of guardrails) {
            const start = Date.now();
            const blocking = guardrail.blocking !== false;

            try {
                const result = await guardrail.check(currentContent, context);
                const report: GuardrailReport = {
                    guardrail: guardrail.name,
                    passed: result.passed,
                    blocking,
                    message: result.message,
                    durationMs: Date.now() - start,
                };
                reports.push(report);

                if (!result.passed) {
                    if (blocking) {
                        allPassed = false;
                        log.warn(`Guardrail BLOCKED: ${guardrail.name} — ${result.message}`);
                        break; // Stop on first blocking failure
                    } else {
                        log.info(`Guardrail warning: ${guardrail.name} — ${result.message}`);
                    }
                }

                // Apply transformation if provided
                if (result.transformed) {
                    currentContent = result.transformed;
                }
            } catch (err) {
                reports.push({
                    guardrail: guardrail.name,
                    passed: false,
                    blocking,
                    message: `Guardrail error: ${(err as Error).message}`,
                    durationMs: Date.now() - start,
                });
                if (blocking) {
                    allPassed = false;
                    break;
                }
            }
        }

        return { content: currentContent, passed: allPassed, reports };
    }

    get inputCount(): number { return this.inputGuardrails.length; }
    get outputCount(): number { return this.outputGuardrails.length; }
}
