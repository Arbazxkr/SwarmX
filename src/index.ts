/**
 * SwarmX — Multi-Agent Orchestration Framework
 * @module swarmx
 */

export { EventBus, type SwarmEvent, type EventHandler, EventPriority, createEvent } from "./core/event-bus.js";
export { Agent, AgentState, type AgentConfig } from "./core/agent.js";
export {
  type ProviderBase,
  ProviderRegistry,
  type Message,
  Role,
  type CompletionResponse,
  type ProviderConfig,
  type ToolDefinition,
} from "./core/provider.js";
export { SwarmEngine } from "./core/engine.js";
export { TaskScheduler, TaskStatus, type Task, createTask } from "./core/scheduler.js";
export { loadConfig, buildEngineFromConfig, loadAndBuild } from "./utils/config.js";
export { Logger, createLogger } from "./utils/logger.js";

export const VERSION = "0.1.0";
