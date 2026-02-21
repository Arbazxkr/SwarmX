/**
 * Groklets Anthropic Provider — Claude 3.5, Claude 3, and future models.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
    type ProviderBase, type ProviderConfig, type Message,
    type CompletionResponse, type ToolDefinition, Role,
} from "../core/provider.js";
import { withRetry } from "../utils/retry.js";

export class AnthropicProvider implements ProviderBase {
    readonly name = "Anthropic";
    readonly config: ProviderConfig;
    private client: Anthropic;

    constructor(config: ProviderConfig) {
        this.config = { model: "claude-sonnet-4-20250514", temperature: 0.7, maxTokens: 4096, maxRetries: 3, ...config };
        this.client = new Anthropic({
            apiKey: config.apiKey,
            timeout: (config.timeout ?? 60) * 1000,
            maxRetries: 0,
        });
    }

    private prepareMessages(messages: Message[]): { system: string; conversation: Anthropic.Messages.MessageParam[] } {
        let system = "";
        const conversation: Anthropic.Messages.MessageParam[] = [];
        for (const msg of messages) {
            if (msg.role === Role.SYSTEM) system += msg.content + "\n";
            else conversation.push({ role: msg.role === Role.USER ? "user" : "assistant", content: msg.content });
        }
        return { system: system.trim(), conversation };
    }

    async complete(messages: Message[], tools?: ToolDefinition[], overrides?: Partial<ProviderConfig>): Promise<CompletionResponse> {
        const model = (overrides?.model ?? this.config.model) as string;
        const { system, conversation } = this.prepareMessages(messages);

        const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
            model,
            messages: conversation,
            max_tokens: overrides?.maxTokens ?? this.config.maxTokens ?? 4096,
            temperature: overrides?.temperature ?? this.config.temperature,
        };
        if (system) params.system = system;
        if (tools?.length) {
            params.tools = tools.map((t) => ({
                name: t.function.name,
                description: t.function.description ?? "",
                input_schema: (t.function.parameters ?? {}) as Anthropic.Messages.Tool.InputSchema,
            }));
        }

        const response = await withRetry(() => this.client.messages.create(params), {
            maxRetries: this.config.maxRetries ?? 3,
        });

        let content = "";
        let toolCalls: Message["toolCalls"];
        for (const block of response.content) {
            if (block.type === "text") content += block.text;
            else if (block.type === "tool_use") {
                toolCalls = toolCalls ?? [];
                toolCalls.push({
                    id: block.id, type: "function",
                    function: { name: block.name, arguments: JSON.stringify(block.input) },
                });
            }
        }

        return {
            message: { role: Role.ASSISTANT, content, toolCalls },
            finishReason: response.stop_reason ?? "end_turn",
            usage: {
                promptTokens: response.usage.input_tokens,
                completionTokens: response.usage.output_tokens,
                totalTokens: response.usage.input_tokens + response.usage.output_tokens,
            },
            rawResponse: response,
            model,
        };
    }

    async *stream(messages: Message[], tools?: ToolDefinition[], overrides?: Partial<ProviderConfig>): AsyncIterable<string> {
        const model = (overrides?.model ?? this.config.model) as string;
        const { system, conversation } = this.prepareMessages(messages);
        const params: Anthropic.Messages.MessageCreateParamsStreaming = {
            model, messages: conversation,
            max_tokens: overrides?.maxTokens ?? this.config.maxTokens ?? 4096,
            temperature: overrides?.temperature ?? this.config.temperature,
            stream: true,
        };
        if (system) params.system = system;

        const stream = this.client.messages.stream(params);
        for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                yield event.delta.text;
            }
        }
    }
}
