/**
 * Groklets Google Provider — Gemini 2.0 Flash, Gemini 1.5 Pro, and future models.
 */

import { GoogleGenAI } from "@google/genai";
import {
    type ProviderBase, type ProviderConfig, type Message,
    type CompletionResponse, type ToolDefinition, Role,
} from "../core/provider.js";
import { withRetry } from "../utils/retry.js";

export class GoogleProvider implements ProviderBase {
    readonly name = "Google";
    readonly config: ProviderConfig;
    private client: GoogleGenAI;

    constructor(config: ProviderConfig) {
        this.config = { model: "gemini-2.0-flash", temperature: 0.7, maxTokens: 4096, maxRetries: 3, ...config };
        this.client = new GoogleGenAI({ apiKey: config.apiKey });
    }

    private toGeminiContents(messages: Message[]) {
        let systemInstruction: string | undefined;
        const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
        for (const msg of messages) {
            if (msg.role === Role.SYSTEM) systemInstruction = msg.content;
            else if (msg.role === Role.USER) contents.push({ role: "user", parts: [{ text: msg.content }] });
            else if (msg.role === Role.ASSISTANT) contents.push({ role: "model", parts: [{ text: msg.content }] });
        }
        return { systemInstruction, contents };
    }

    async complete(messages: Message[], tools?: ToolDefinition[], overrides?: Partial<ProviderConfig>): Promise<CompletionResponse> {
        const model = (overrides?.model ?? this.config.model) as string;
        const { systemInstruction, contents } = this.toGeminiContents(messages);

        const response = await withRetry(() => this.client.models.generateContent({
            model, contents,
            config: {
                systemInstruction,
                temperature: overrides?.temperature ?? this.config.temperature,
                maxOutputTokens: overrides?.maxTokens ?? this.config.maxTokens,
            },
        }), { maxRetries: this.config.maxRetries ?? 3 });

        return {
            message: { role: Role.ASSISTANT, content: response.text ?? "" },
            finishReason: "stop",
            usage: {
                promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
                completionTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
                totalTokens: response.usageMetadata?.totalTokenCount ?? 0,
            },
            rawResponse: response,
            model,
        };
    }

    async *stream(messages: Message[], tools?: ToolDefinition[], overrides?: Partial<ProviderConfig>): AsyncIterable<string> {
        const model = (overrides?.model ?? this.config.model) as string;
        const { systemInstruction, contents } = this.toGeminiContents(messages);
        const stream = await this.client.models.generateContentStream({
            model, contents,
            config: {
                systemInstruction,
                temperature: overrides?.temperature ?? this.config.temperature,
                maxOutputTokens: overrides?.maxTokens ?? this.config.maxTokens,
            },
        });
        for await (const chunk of stream) {
            if (chunk.text) yield chunk.text;
        }
    }
}
