/**
 * Groklets Provider Abstraction — Model-agnostic LLM provider interface.
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
 * Provider factory function — alternative to class-based registration.
 * Users can register a simple function that returns a ProviderBase.
 */
export type ProviderFactory = (config: ProviderConfig) => ProviderBase;

/**
 * Provider Registry — agents reference providers by name.
 *
 * Supports:
 *   - Built-in types (openai, anthropic, google, xai)
 *   - Custom provider classes (registerClass)
 *   - Custom provider factories (registerFactory)
 *   - Provider instances (registerInstance)
 *   - OpenAI-compatible fallback (any unknown type with a base_url)
 */
export class ProviderRegistry {
    private providers = new Map<string, ProviderBase>();
    private factories = new Map<string, ProviderFactory>();
    private classes = new Map<string, new (config: ProviderConfig) => ProviderBase>();

    /** Register a provider class by type name. */
    registerClass(name: string, cls: new (config: ProviderConfig) => ProviderBase): void {
        this.classes.set(name, cls);
        log.debug(`Registered provider class: ${name}`);
    }

    /** Register a provider factory function by type name. */
    registerFactory(name: string, factory: ProviderFactory): void {
        this.factories.set(name, factory);
        log.debug(`Registered provider factory: ${name}`);
    }

    /** Register a ready-to-use provider instance. */
    registerInstance(name: string, provider: ProviderBase): void {
        this.providers.set(name, provider);
        log.debug(`Registered provider: ${name} → ${provider.name}`);
    }

    /** Get a provider by name. */
    get(name: string): ProviderBase {
        const p = this.providers.get(name);
        if (p) return p;
        throw new Error(`Provider not found: '${name}'. Available: ${this.available.join(", ")}`);
    }

    /**
     * Create a provider from a registered type.
     * If the type is unknown but config has a baseUrl, falls back to
     * OpenAI-compatible mode (works with Ollama, LM Studio, vLLM,
     * Together, Groq, Mistral, etc.).
     */
    create(typeName: string, instanceName: string, config: ProviderConfig): ProviderBase {
        // 1. Check factories first
        const factory = this.factories.get(typeName);
        if (factory) {
            const instance = factory(config);
            this.providers.set(instanceName, instance);
            return instance;
        }

        // 2. Check registered classes
        const Cls = this.classes.get(typeName);
        if (Cls) {
            const instance = new Cls(config);
            this.providers.set(instanceName, instance);
            return instance;
        }

        // 3. Unknown type — if it has a baseUrl, assume OpenAI-compatible
        if (config.baseUrl) {
            const openaiCls = this.classes.get("openai");
            if (openaiCls) {
                log.info(`Unknown provider type '${typeName}' — using OpenAI-compatible mode with baseUrl: ${config.baseUrl}`);
                const instance = new openaiCls(config);
                this.providers.set(instanceName, instance);
                return instance;
            }
        }

        throw new Error(
            `Unknown provider type: '${typeName}'. ` +
            `Register it with registerClass() or registerFactory(), ` +
            `or set base_url for OpenAI-compatible mode. ` +
            `Built-in types: ${[...this.classes.keys()].join(", ")}`
        );
    }

    /** List all available provider names. */
    get available(): string[] {
        return [...new Set([...this.providers.keys()])];
    }

    /** List all registered provider type names. */
    get registeredTypes(): string[] {
        return [...new Set([...this.classes.keys(), ...this.factories.keys()])];
    }

    has(name: string): boolean {
        return this.providers.has(name);
    }

    hasType(typeName: string): boolean {
        return this.classes.has(typeName) || this.factories.has(typeName);
    }
}

