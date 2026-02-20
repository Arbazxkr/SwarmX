/**
 * SwarmX — Multi-Agent Orchestration Framework
 *
 * A model-agnostic, async, event-driven multi-agent orchestration framework.
 * Inspired by architectural patterns from the OpenClaw project (MIT).
 *
 * @module swarmx
 */

export { EventBus, type SwarmEvent, type EventHandler, EventPriority } from "./core/event-bus.js";
export { Agent, AgentState, type AgentConfig } from "./core/agent.js";
export {
    type ProviderBase,
    ProviderRegistry,
    type Message,
    Role,
    type CompletionResponse,
    type ProviderConfig,
} from "./core/provider.js";
export { SwarmEngine } from "./core/engine.js";
export { TaskScheduler, TaskStatus, type Task } from "./core/scheduler.js";
export { loadConfig, buildEngineFromConfig, loadAndBuild } from "./utils/config.js";

export const VERSION = "0.1.0";
