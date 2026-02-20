/**
 * SwarmX — Multi-Agent Orchestration Framework
 * @module swarmx
 */

// Core
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
  type ToolCall,
} from "./core/provider.js";
export { SwarmEngine, type EngineConfig } from "./core/engine.js";
export { TaskScheduler, TaskStatus, type Task, createTask } from "./core/scheduler.js";

// Production features
export { FailoverProvider, type FailoverConfig } from "./core/failover.js";
export { ToolExecutor, executeToolLoop, type ToolFunction, type ToolRegistry } from "./core/tool-executor.js";
export { SessionStore, type Session, type SessionStoreConfig } from "./core/session.js";
export { ContextManager, estimateTokens, estimateMessagesTokens, pruneSliding, type ContextConfig } from "./core/context.js";
export { UsageTracker } from "./core/usage.js";
export { Gateway, type GatewayConfig } from "./core/gateway.js";

// Utils
export { loadConfig, buildEngineFromConfig, loadAndBuild } from "./utils/config.js";
export { Logger, createLogger } from "./utils/logger.js";
export { withRetry, type RetryOptions } from "./utils/retry.js";

export const VERSION = "0.2.0";
