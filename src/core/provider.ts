/**
 * SwarmX Provider Abstraction — Model-agnostic LLM provider interface.
 *
 * Adapted from OpenClaw's multi-model support pattern. The provider layer
 * ensures the core engine has zero dependency on any specific LLM vendor.
 * Providers are interchangeable and agents bind to them declaratively.
 */

export enum Role {
    SYSTEM = "system",
    USER = "user",
    ASSISTANT = "assistant",
    TOOL = "tool",
}

/**
 * A provider-agnostic message.
 * All providers consume and produce Message objects.
 */
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
    function: {
        name: string;
        arguments: string;
    };
}

/**
 * Standardized response from any provider.
 */
export interface CompletionResponse {
    message: Message;
    finishReason: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    rawResponse?: unknown;
    model: string;
}

/**
 * Configuration for a provider instance.
 */
export interface ProviderConfig {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    temperature?: number;
    maxTokens?: number;
    timeout?: number;
    extra?: Record<string, unknown>;
}

/**
 * Tool/Function definition for providers.
 */
export interface ToolDefinition {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}

/**
 * Abstract provider interface.
 * Every provider must implement complete() and optionally stream().
 * The engine interacts exclusively through this interface.
 */
export interface ProviderBase {
    readonly name: string;
    readonly config: ProviderConfig;

    /**
     * Send a list of messages and return a completion.
     */
    complete(
        messages: Message[],
        tools?: ToolDefinition[],
        overrides?: Partial<ProviderConfig>,
    ): Promise<CompletionResponse>;

    /**
     * Stream a completion token-by-token.
     * Default implementation can fall back to non-streaming.
     */
    stream?(
        messages: Message[],
        tools?: ToolDefinition[],
        overrides?: Partial<ProviderConfig>,
    ): AsyncIterable<string>;

    /**
     * Verify the provider is reachable.
     */
    healthCheck?(): Promise<boolean>;
}

/**
 * Registry of available providers.
 * Providers register themselves by name, and agents reference
 * providers declaratively by name in their configuration.
 *
 * Adapted from OpenClaw's channel adapter registry.
 */
export class ProviderRegistry {
    private providers = new Map<string, ProviderBase>();
    private factories = new Map<string, new (config: ProviderConfig) => ProviderBase>();

    /**
     * Register a provider class for lazy instantiation.
     */
    registerClass(name: string, providerClass: new (config: ProviderConfig) => ProviderBase): void {
        this.factories.set(name, providerClass);
    }

    /**
     * Register a pre-configured provider instance.
     */
    registerInstance(name: string, provider: ProviderBase): void {
        this.providers.set(name, provider);
    }

    /**
     * Retrieve a provider by name.
     */
    get(name: string): ProviderBase {
        const provider = this.providers.get(name);
        if (provider) return provider;
        throw new Error(`Provider not found: '${name}'. Available: ${this.available.join(", ")}`);
    }

    /**
     * Create a provider instance from a registered class.
     */
    create(name: string, config: ProviderConfig): ProviderBase {
        const Factory = this.factories.get(name);
        if (!Factory) {
            throw new Error(
                `Provider class not registered: '${name}'. Available: ${[...this.factories.keys()].join(", ")}`,
            );
        }
        const provider = new Factory(config);
        this.providers.set(name, provider);
        return provider;
    }

    /**
     * List available provider names.
     */
    get available(): string[] {
        return [...new Set([...this.providers.keys(), ...this.factories.keys()])];
    }

    has(name: string): boolean {
        return this.providers.has(name) || this.factories.has(name);
    }
}
