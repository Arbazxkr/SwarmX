/**
 * SwarmX xAI Provider — Grok-2, Grok-1, and future models.
 * Uses OpenAI-compatible API with custom base URL.
 */

import OpenAI from "openai";
import {
    type ProviderBase, type ProviderConfig, type Message,
    type CompletionResponse, type ToolDefinition, Role,
} from "../core/provider.js";
import { withRetry } from "../utils/retry.js";

const XAI_BASE_URL = "https://api.x.ai/v1";

export class XAIProvider implements ProviderBase {
    readonly name = "xAI";
    readonly config: ProviderConfig;
    private client: OpenAI;

    constructor(config: ProviderConfig) {
        this.config = { model: "grok-2-latest", temperature: 0.7, maxTokens: 4096, baseUrl: XAI_BASE_URL, maxRetries: 3, ...config };
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: this.config.baseUrl ?? XAI_BASE_URL,
            timeout: (config.timeout ?? 60) * 1000,
            maxRetries: 0,
        });
    }

    private toMessages(messages: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
        return messages.map((msg) => {
            const e: Record<string, unknown> = { role: msg.role, content: msg.content };
            if (msg.name) e.name = msg.name;
            if (msg.toolCalls) e.tool_calls = msg.toolCalls;
            if (msg.toolCallId) e.tool_call_id = msg.toolCallId;
            return e as unknown as OpenAI.Chat.ChatCompletionMessageParam;
        });
    }

    async complete(messages: Message[], tools?: ToolDefinition[], overrides?: Partial<ProviderConfig>): Promise<CompletionResponse> {
        const model = (overrides?.model ?? this.config.model) as string;
        const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
            model,
            messages: this.toMessages(messages),
            temperature: overrides?.temperature ?? this.config.temperature,
            max_tokens: overrides?.maxTokens ?? this.config.maxTokens,
        };
        if (tools?.length) params.tools = tools as OpenAI.Chat.ChatCompletionTool[];

        const response = await withRetry(() => this.client.chat.completions.create(params), {
            maxRetries: this.config.maxRetries ?? 3,
        });
        const choice = response.choices[0];

        return {
            message: {
                role: Role.ASSISTANT,
                content: choice.message.content ?? "",
                toolCalls: choice.message.tool_calls?.map((tc) => ({
                    id: tc.id, type: tc.type,
                    function: { name: tc.function.name, arguments: tc.function.arguments },
                })),
            },
            finishReason: choice.finish_reason ?? "stop",
            usage: {
                promptTokens: response.usage?.prompt_tokens ?? 0,
                completionTokens: response.usage?.completion_tokens ?? 0,
                totalTokens: response.usage?.total_tokens ?? 0,
            },
            rawResponse: response,
            model,
        };
    }

    async *stream(messages: Message[], tools?: ToolDefinition[], overrides?: Partial<ProviderConfig>): AsyncIterable<string> {
        const model = (overrides?.model ?? this.config.model) as string;
        const stream = await this.client.chat.completions.create({
            model, messages: this.toMessages(messages),
            temperature: overrides?.temperature ?? this.config.temperature,
            max_tokens: overrides?.maxTokens ?? this.config.maxTokens,
            stream: true,
        });
        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content;
            if (content) yield content;
        }
    }
}
