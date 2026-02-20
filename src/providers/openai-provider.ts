/**
 * SwarmX OpenAI Provider — Adapter for OpenAI's API.
 * Supports GPT-4o, GPT-4, GPT-3.5-turbo, and any OpenAI-compatible model.
 */

import OpenAI from "openai";
import {
    type ProviderBase,
    type ProviderConfig,
    type Message,
    type CompletionResponse,
    type ToolDefinition,
    Role,
} from "../core/provider.js";

export class OpenAIProvider implements ProviderBase {
    readonly name = "OpenAI";
    readonly config: ProviderConfig;
    private client: OpenAI;

    constructor(config: ProviderConfig) {
        this.config = { model: "gpt-4o", temperature: 0.7, maxTokens: 4096, ...config };
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.baseUrl,
            timeout: (config.timeout ?? 60) * 1000,
        });
    }

    private toOpenAIMessages(messages: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
        return messages.map((msg) => {
            const entry: Record<string, unknown> = {
                role: msg.role,
                content: msg.content,
            };
            if (msg.name) entry.name = msg.name;
            if (msg.toolCalls) entry.tool_calls = msg.toolCalls;
            if (msg.toolCallId) entry.tool_call_id = msg.toolCallId;
            return entry as unknown as OpenAI.Chat.ChatCompletionMessageParam;
        });
    }

    async complete(
        messages: Message[],
        tools?: ToolDefinition[],
        overrides?: Partial<ProviderConfig>,
    ): Promise<CompletionResponse> {
        const model = (overrides?.model ?? this.config.model) as string;
        const temperature = overrides?.temperature ?? this.config.temperature;
        const maxTokens = overrides?.maxTokens ?? this.config.maxTokens;

        const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
            model,
            messages: this.toOpenAIMessages(messages),
            temperature,
            max_tokens: maxTokens,
        };

        if (tools && tools.length > 0) {
            params.tools = tools as OpenAI.Chat.ChatCompletionTool[];
        }

        const response = await this.client.chat.completions.create(params);
        const choice = response.choices[0];
        const message = choice.message;

        let toolCalls: Message["toolCalls"];
        if (message.tool_calls) {
            toolCalls = message.tool_calls.map((tc) => ({
                id: tc.id,
                type: tc.type,
                function: { name: tc.function.name, arguments: tc.function.arguments },
            }));
        }

        return {
            message: {
                role: Role.ASSISTANT,
                content: message.content ?? "",
                toolCalls,
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

    async *stream(
        messages: Message[],
        tools?: ToolDefinition[],
        overrides?: Partial<ProviderConfig>,
    ): AsyncIterable<string> {
        const model = (overrides?.model ?? this.config.model) as string;
        const temperature = overrides?.temperature ?? this.config.temperature;
        const maxTokens = overrides?.maxTokens ?? this.config.maxTokens;

        const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
            model,
            messages: this.toOpenAIMessages(messages),
            temperature,
            max_tokens: maxTokens,
            stream: true,
        };

        const stream = await this.client.chat.completions.create(params);

        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content;
            if (content) yield content;
        }
    }
}
