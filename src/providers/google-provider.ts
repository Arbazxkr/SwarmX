/**
 * SwarmX Google Provider — Adapter for Google's Generative AI API (Gemini).
 * Supports Gemini 2.0, Gemini 1.5, and future models via @google/genai.
 */

import { GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import {
    type ProviderBase,
    type ProviderConfig,
    type Message,
    type CompletionResponse,
    type ToolDefinition,
    Role,
} from "../core/provider.js";

export class GoogleProvider implements ProviderBase {
    readonly name = "Google";
    readonly config: ProviderConfig;
    private client: GoogleGenAI;

    constructor(config: ProviderConfig) {
        this.config = { model: "gemini-2.0-flash", temperature: 0.7, maxTokens: 4096, ...config };
        this.client = new GoogleGenAI({ apiKey: config.apiKey });
    }

    /**
     * Convert SwarmX messages to Gemini format.
     * Gemini uses 'user' and 'model' roles (not 'assistant').
     */
    private toGeminiContents(messages: Message[]): {
        systemInstruction?: string;
        contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    } {
        let systemInstruction: string | undefined;
        const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

        for (const msg of messages) {
            if (msg.role === Role.SYSTEM) {
                systemInstruction = msg.content;
            } else if (msg.role === Role.USER) {
                contents.push({ role: "user", parts: [{ text: msg.content }] });
            } else if (msg.role === Role.ASSISTANT) {
                contents.push({ role: "model", parts: [{ text: msg.content }] });
            }
        }

        return { systemInstruction, contents };
    }

    async complete(
        messages: Message[],
        tools?: ToolDefinition[],
        overrides?: Partial<ProviderConfig>,
    ): Promise<CompletionResponse> {
        const model = (overrides?.model ?? this.config.model) as string;
        const temperature = overrides?.temperature ?? this.config.temperature;
        const maxTokens = overrides?.maxTokens ?? this.config.maxTokens;

        const { systemInstruction, contents } = this.toGeminiContents(messages);

        const response = await this.client.models.generateContent({
            model,
            contents,
            config: {
                systemInstruction,
                temperature,
                maxOutputTokens: maxTokens,
            },
        });

        const content = response.text ?? "";

        const usage = {
            promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
            completionTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
            totalTokens: response.usageMetadata?.totalTokenCount ?? 0,
        };

        return {
            message: { role: Role.ASSISTANT, content },
            finishReason: "stop",
            usage,
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

        const { systemInstruction, contents } = this.toGeminiContents(messages);

        const stream = await this.client.models.generateContentStream({
            model,
            contents,
            config: {
                systemInstruction,
                temperature,
                maxOutputTokens: maxTokens,
            },
        });

        for await (const chunk of stream) {
            if (chunk.text) {
                yield chunk.text;
            }
        }
    }
}
