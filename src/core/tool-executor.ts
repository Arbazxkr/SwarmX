/**
 * Groklets Tool Executor — Agentic tool execution loop.
 *
 * When an LLM returns tool_calls, the executor:
 *   1. Runs each tool function
 *   2. Feeds results back to the LLM
 *   3. Repeats until the LLM produces a final text response
 *
 * This is the core loop that makes agents actually DO things,
 * not just suggest tool calls.
 */

import {
    type ProviderBase,
    type Message,
    type CompletionResponse,
    type ToolDefinition,
    Role,
} from "./provider.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ToolExecutor");

export type ToolFunction = (args: Record<string, unknown>) => Promise<string>;

export interface ToolRegistry {
    [toolName: string]: ToolFunction;
}

export interface ToolExecutorConfig {
    /** Max iterations of the tool loop (prevents infinite loops) */
    maxIterations?: number;
    /** Timeout per individual tool call (ms) */
    toolTimeoutMs?: number;
    /** Whether to include tool results in message history */
    includeInHistory?: boolean;
}

/**
 * Execute the full tool-calling loop.
 *
 * Takes a provider, messages, and available tools. If the LLM
 * returns tool_calls, runs them, feeds results back, and repeats.
 */
export async function executeToolLoop(
    provider: ProviderBase,
    messages: Message[],
    tools: ToolDefinition[],
    toolFunctions: ToolRegistry,
    config?: ToolExecutorConfig,
): Promise<{ response: CompletionResponse; messages: Message[]; iterations: number }> {
    const maxIter = config?.maxIterations ?? 10;
    const timeoutMs = config?.toolTimeoutMs ?? 30_000;
    const conversation = [...messages];
    let iterations = 0;
    let lastResponse: CompletionResponse;

    while (iterations < maxIter) {
        iterations++;

        // Call the LLM
        lastResponse = await provider.complete(conversation, tools);
        conversation.push(lastResponse.message);

        // If no tool calls, we're done
        if (!lastResponse.message.toolCalls || lastResponse.message.toolCalls.length === 0) {
            log.debug(`Tool loop completed in ${iterations} iteration(s)`);
            return { response: lastResponse, messages: conversation, iterations };
        }

        // Execute each tool call
        log.debug(`Iteration ${iterations}: ${lastResponse.message.toolCalls.length} tool call(s)`);

        for (const toolCall of lastResponse.message.toolCalls) {
            const fnName = toolCall.function.name;
            const fn = toolFunctions[fnName];

            let result: string;
            if (!fn) {
                result = JSON.stringify({ error: `Unknown tool: ${fnName}` });
                log.warn(`Unknown tool called: ${fnName}`);
            } else {
                try {
                    const args = JSON.parse(toolCall.function.arguments);
                    log.debug(`Executing tool: ${fnName}(${JSON.stringify(args).slice(0, 100)})`);

                    result = await Promise.race([
                        fn(args),
                        new Promise<string>((_, reject) =>
                            setTimeout(() => reject(new Error(`Tool '${fnName}' timed out after ${timeoutMs}ms`)), timeoutMs),
                        ),
                    ]);
                } catch (err) {
                    result = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
                    log.error(`Tool '${fnName}' failed: ${result}`);
                }
            }

            // Feed tool result back
            conversation.push({
                role: Role.TOOL,
                content: result,
                toolCallId: toolCall.id,
                name: fnName,
            });
        }
    }

    log.warn(`Tool loop hit max iterations (${maxIter})`);
    return { response: lastResponse!, messages: conversation, iterations };
}

/**
 * ToolAgent mixin — adds tool execution to a standard Agent.
 *
 * Use this with Agent.think() to get full tool loop support.
 */
export class ToolExecutor {
    private tools: ToolDefinition[] = [];
    private functions: ToolRegistry = {};
    private config: ToolExecutorConfig;

    constructor(config?: ToolExecutorConfig) {
        this.config = config ?? {};
    }

    /**
     * Register a tool the agent can use.
     */
    register(
        name: string,
        description: string,
        parameters: Record<string, unknown>,
        fn: ToolFunction,
    ): void {
        this.tools.push({
            type: "function",
            function: { name, description, parameters },
        });
        this.functions[name] = fn;
        log.info(`Tool registered: ${name}`);
    }

    /**
     * Remove a tool by name.
     */
    unregister(name: string): boolean {
        const idx = this.tools.findIndex((t) => t.function.name === name);
        if (idx === -1) return false;
        this.tools.splice(idx, 1);
        delete this.functions[name];
        return true;
    }

    /**
     * Run the complete tool loop.
     */
    async execute(
        provider: ProviderBase,
        messages: Message[],
        extraTools?: ToolDefinition[],
    ): Promise<{ response: CompletionResponse; messages: Message[]; iterations: number }> {
        const allTools = [...this.tools, ...(extraTools ?? [])];
        return executeToolLoop(provider, messages, allTools, this.functions, this.config);
    }

    get registeredTools(): string[] {
        return this.tools.map((t) => t.function.name);
    }

    get toolDefinitions(): ToolDefinition[] {
        return [...this.tools];
    }
}
