/**
 * SwarmX Config Loader — YAML-based swarm definition parser.
 *
 * Loads swarm configurations from YAML files, creating the full
 * SwarmEngine with providers, agents, and their bindings.
 *
 * Adapted from OpenClaw's config-driven architecture.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { SwarmEngine } from "../core/engine.js";
import { type AgentConfig } from "../core/agent.js";
import { type ProviderConfig } from "../core/provider.js";
import { OpenAIProvider } from "../providers/openai-provider.js";
import { AnthropicProvider } from "../providers/anthropic-provider.js";
import { GoogleProvider } from "../providers/google-provider.js";
import { XAIProvider } from "../providers/xai-provider.js";

interface SwarmConfigFile {
    swarm: {
        name?: string;
        providers?: Record<string, Record<string, unknown>>;
        agents?: Record<string, Record<string, unknown>>;
    };
}

/**
 * Resolve ${ENV_VAR} references in a string.
 */
function resolveEnvVars(value: string): string {
    if (typeof value === "string" && value.startsWith("${") && value.endsWith("}")) {
        const envVar = value.slice(2, -1);
        return process.env[envVar] ?? "";
    }
    return value;
}

/**
 * Load a YAML configuration file.
 */
export function loadConfig(path: string): SwarmConfigFile {
    const fullPath = resolve(path);
    const raw = readFileSync(fullPath, "utf-8");
    const config = YAML.parse(raw) as SwarmConfigFile;

    if (!config || !config.swarm) {
        throw new Error(`Invalid config file: missing 'swarm' section in ${path}`);
    }

    return config;
}

/**
 * Map of provider type names to their classes.
 */
const PROVIDER_MAP: Record<string, new (config: ProviderConfig) => any> = {
    openai: OpenAIProvider,
    anthropic: AnthropicProvider,
    google: GoogleProvider,
    xai: XAIProvider,
};

/**
 * Build a complete SwarmEngine from a parsed config.
 */
export function buildEngineFromConfig(config: SwarmConfigFile): SwarmEngine {
    const engine = new SwarmEngine();
    const swarm = config.swarm;

    // ── Load providers ──────────────────────────────────────
    const providers = swarm.providers ?? {};
    for (const [providerName, providerDef] of Object.entries(providers)) {
        const type = (providerDef.type as string) ?? providerName;
        const apiKey = resolveEnvVars((providerDef.api_key as string) ?? "");
        const model = (providerDef.model as string) ?? undefined;
        const baseUrl = providerDef.base_url as string | undefined;
        const temperature = (providerDef.temperature as number) ?? 0.7;
        const maxTokens = (providerDef.max_tokens as number) ?? 4096;
        const timeout = (providerDef.timeout as number) ?? 60;

        const providerConfig: ProviderConfig = {
            apiKey,
            model,
            baseUrl,
            temperature,
            maxTokens,
            timeout,
        };

        const ProviderClass = PROVIDER_MAP[type];
        if (ProviderClass) {
            const instance = new ProviderClass(providerConfig);
            engine.registerProvider(providerName, instance);
        } else {
            console.warn(`Unknown provider type: ${type}`);
        }
    }

    // ── Load agents ─────────────────────────────────────────
    const agents = swarm.agents ?? {};
    for (const [agentName, agentDef] of Object.entries(agents)) {
        const agentConfig: AgentConfig = {
            name: agentName,
            provider: (agentDef.provider as string) ?? "",
            model: agentDef.model as string | undefined,
            systemPrompt: (agentDef.system_prompt as string) ?? undefined,
            subscriptions: (agentDef.subscriptions as string[]) ?? ["task.created"],
            maxHistory: (agentDef.max_history as number) ?? 50,
            temperature: agentDef.temperature as number | undefined,
            metadata: (agentDef.metadata as Record<string, unknown>) ?? {},
        };

        engine.addAgent(agentConfig);
    }

    return engine;
}

/**
 * Convenience: load a YAML config and build the engine in one call.
 */
export function loadAndBuild(path: string): SwarmEngine {
    const config = loadConfig(path);
    return buildEngineFromConfig(config);
}
