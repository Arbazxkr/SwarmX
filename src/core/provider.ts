/**
 * SwarmX Provider Abstraction — Model-agnostic LLM provider interface.
 *
 * The provider layer ensures the core engine has zero dependency on
 * any specific LLM vendor. Providers are fully interchangeable and
 * agents bind to them declaratively via config.
 */

import { createLogger } from "../utils/logger.js";

const log = createLogger("Provider");

export enum Role {
    SYSTEM = "system",
    USER = "user",
    ASSISTANT = "assistant",
    TOOL = "tool",
}

export interface Message {
    role: Role;
    content: string;
    name?: string;
    toolCalls?: ToolCall[];
    toolCallId?: string;
    metadata?: Record<string, unknown>;
}

export interface ToolCall {
    id: string;
    type: string;
    function: { name: string; arguments: string };
}

export interface CompletionResponse {
    message: Message;
    finishReason: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    rawResponse?: unknown;
    model: string;
}

export interface ProviderConfig {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    temperature?: number;
    maxTokens?: number;
    timeout?: number;
    maxRetries?: number;
    extra?: Record<string, unknown>;
}

export interface ToolDefinition {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}

/**
 * Every provider must implement this interface.
 * The engine interacts exclusively through it.
 */
export interface ProviderBase {
    readonly name: string;
    readonly config: ProviderConfig;
    complete(messages: Message[], tools?: ToolDefinition[], overrides?: Partial<ProviderConfig>): Promise<CompletionResponse>;
    stream?(messages: Message[], tools?: ToolDefinition[], overrides?: Partial<ProviderConfig>): AsyncIterable<string>;
    healthCheck?(): Promise<boolean>;
}

/**
 * Provider Registry — agents reference providers by name.
 */
export class ProviderRegistry {
    private providers = new Map<string, ProviderBase>();
    private factories = new Map<string, new (config: ProviderConfig) => ProviderBase>();

    registerClass(name: string, cls: new (config: ProviderConfig) => ProviderBase): void {
        this.factories.set(name, cls);
        log.debug(`Registered provider class: ${name}`);
    }

    registerInstance(name: string, provider: ProviderBase): void {
        this.providers.set(name, provider);
        log.debug(`Registered provider: ${name} → ${provider.name}`);
    }

    get(name: string): ProviderBase {
        const p = this.providers.get(name);
        if (p) return p;
        throw new Error(`Provider not found: '${name}'. Available: ${this.available.join(", ")}`);
    }

    create(name: string, config: ProviderConfig): ProviderBase {
        const Factory = this.factories.get(name);
        if (!Factory) throw new Error(`Unknown provider type: '${name}'`);
        const instance = new Factory(config);
        this.providers.set(name, instance);
        return instance;
    }

    get available(): string[] {
        return [...new Set([...this.providers.keys(), ...this.factories.keys()])];
    }

    has(name: string): boolean {
        return this.providers.has(name) || this.factories.has(name);
    }
}
