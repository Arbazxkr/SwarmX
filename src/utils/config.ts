/**
 * SwarmX Config Loader — YAML-based swarm definition parser.
 * Supports .env files and environment variable resolution.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import YAML from "yaml";
import dotenv from "dotenv";
import { SwarmEngine } from "../core/engine.js";
import { type AgentConfig } from "../core/agent.js";
import { type ProviderConfig } from "../core/provider.js";
import { OpenAIProvider } from "../providers/openai-provider.js";
import { AnthropicProvider } from "../providers/anthropic-provider.js";
import { GoogleProvider } from "../providers/google-provider.js";
import { XAIProvider } from "../providers/xai-provider.js";
import { createLogger } from "./logger.js";

const log = createLogger("Config");

interface SwarmConfigFile {
    swarm: {
        name?: string;
        providers?: Record<string, Record<string, unknown>>;
        agents?: Record<string, Record<string, unknown>>;
    };
}

const PROVIDER_MAP: Record<string, new (config: ProviderConfig) => any> = {
    openai: OpenAIProvider,
    anthropic: AnthropicProvider,
    google: GoogleProvider,
    xai: XAIProvider,
};

/**
 * Resolve ${ENV_VAR} references.
 */
export function resolveEnvVars(value: string): string {
    if (typeof value === "string" && value.startsWith("${") && value.endsWith("}")) {
        const envVar = value.slice(2, -1);
        return process.env[envVar] ?? "";
    }
    return value;
}

/**
 * Load a YAML config file. Automatically loads .env if present.
 */
export function loadConfig(path: string): SwarmConfigFile {
    const fullPath = resolve(path);

    if (!existsSync(fullPath)) {
        throw new Error(`Config not found: ${fullPath}`);
    }

    // Auto-load .env from config directory
    const envPath = join(dirname(fullPath), ".env");
    if (existsSync(envPath)) {
        dotenv.config({ path: envPath });
        log.debug(`Loaded .env from ${envPath}`);
    } else {
        dotenv.config(); // Try cwd
    }

    const raw = readFileSync(fullPath, "utf-8");
    const config = YAML.parse(raw) as SwarmConfigFile;

    if (!config?.swarm) {
        throw new Error(`Invalid config: missing 'swarm' section in ${path}`);
    }

    return config;
}

/**
 * Build a SwarmEngine from parsed config.
 */
export function buildEngineFromConfig(config: SwarmConfigFile): SwarmEngine {
    const engine = new SwarmEngine();
    const swarm = config.swarm;

    // Providers
    for (const [name, def] of Object.entries(swarm.providers ?? {})) {
        const type = (def.type as string) ?? name;
        const providerConfig: ProviderConfig = {
            apiKey: resolveEnvVars((def.api_key as string) ?? ""),
            model: (def.model as string) ?? undefined,
            baseUrl: def.base_url as string | undefined,
            temperature: (def.temperature as number) ?? 0.7,
            maxTokens: (def.max_tokens as number) ?? 4096,
            timeout: (def.timeout as number) ?? 60,
            maxRetries: (def.max_retries as number) ?? 3,
        };

        const Cls = PROVIDER_MAP[type];
        if (Cls) {
            engine.registerProvider(name, new Cls(providerConfig));
        } else {
            log.warn(`Unknown provider type: ${type}`);
        }
    }

    // Agents
    for (const [name, def] of Object.entries(swarm.agents ?? {})) {
        engine.addAgent({
            name,
            provider: (def.provider as string) ?? "",
            model: def.model as string | undefined,
            systemPrompt: (def.system_prompt as string) ?? undefined,
            subscriptions: (def.subscriptions as string[]) ?? ["task.created"],
            maxHistory: (def.max_history as number) ?? 50,
            temperature: def.temperature as number | undefined,
            metadata: (def.metadata as Record<string, unknown>) ?? {},
        });
    }

    log.info(`Loaded swarm "${swarm.name ?? "unnamed"}" — ${Object.keys(swarm.providers ?? {}).length} providers, ${Object.keys(swarm.agents ?? {}).length} agents`);
    return engine;
}

export function loadAndBuild(path: string): SwarmEngine {
    const config = loadConfig(path);
    return buildEngineFromConfig(config);
}
