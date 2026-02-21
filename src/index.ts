/**
 * Groklets — Multi-Agent Orchestration Framework
 * @module groklets
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
export { type ProviderFactory } from "./core/provider.js";
export { SwarmEngine, type EngineConfig } from "./core/engine.js";
export { TaskScheduler, TaskStatus, type Task, createTask } from "./core/scheduler.js";

// Production features
export { FailoverProvider, type FailoverConfig } from "./core/failover.js";
export { ToolExecutor, executeToolLoop, type ToolFunction, type ToolRegistry } from "./core/tool-executor.js";
export { SessionStore, type Session, type SessionStoreConfig } from "./core/session.js";
export { ContextManager, estimateTokens, estimateMessagesTokens, pruneSliding, type ContextConfig } from "./core/context.js";
export { UsageTracker } from "./core/usage.js";
export { Gateway, type GatewayConfig } from "./core/gateway.js";
export { MemoryStore, type MemoryEntry, type MemoryConfig } from "./core/memory.js";
export { SkillTrustManager, InputSanitizer, RateLimiter, ToolGuard, Sandbox } from "./core/security.js";
export { MediaPipeline, type MediaFile, type MediaConfig } from "./core/media.js";
export { VoiceEngine, type VoiceConfig, type VoiceProfile } from "./core/voice.js";
export { MessageRouter, type RouteRule, type ActivationMode } from "./core/router.js";
export { CanvasManager, type CanvasState, type CanvasComponent } from "./core/canvas.js";
export {
  WorkflowOrchestrator, Blackboard, pipeline, fanOutFanIn,
  type WorkflowDefinition, type WorkflowStep, type WorkflowRun,
  type StepResult, type AgentExecutor,
} from "./core/workflow.js";
export {
  applyLinkUnderstanding, enrichMessagesWithLinks,
  extractLinksFromMessage, runLinkUnderstanding, formatLinkUnderstandingBody,
  type LinkConfig, type LinkResult, type LinkUnderstandingResult,
} from "./link-understanding/index.js";
export {
  GuardrailRunner, maxLengthGuardrail, blockedPatternsGuardrail,
  requiredContentGuardrail, piiGuardrail, jsonOutputGuardrail, toxicityGuardrail,
  type GuardrailConfig, type GuardrailsConfig, type GuardrailResult, type GuardrailReport,
} from "./core/guardrails.js";
export {
  compactMessages,
  type CompactionConfig, type CompactionResult,
} from "./core/compaction.js";
export {
  Tracer, globalTracer,
  type Span, type Trace, type TracingConfig,
} from "./core/tracing.js";

// Utils
export { loadConfig, buildEngineFromConfig, loadAndBuild } from "./utils/config.js";
export { Logger, createLogger } from "./utils/logger.js";
export { withRetry, type RetryOptions } from "./utils/retry.js";

// Channels (10 platforms)
export { ChannelAdapter, type ChannelConfig, type ChannelMessage } from "./channels/adapter.js";
export { WhatsAppChannel, type WhatsAppConfig } from "./channels/whatsapp.js";
export { TelegramChannel, type TelegramConfig } from "./channels/telegram.js";
export { DiscordChannel, type DiscordConfig } from "./channels/discord.js";
export { SlackChannel, type SlackConfig } from "./channels/slack.js";
export { WebChatChannel, type WebChatConfig } from "./channels/webchat.js";
export { SignalChannel, type SignalConfig } from "./channels/signal.js";
export { IMessageChannel, type IMessageConfig } from "./channels/imessage.js";
export { GoogleChatChannel, type GoogleChatConfig } from "./channels/googlechat.js";
export { TeamsChannel, type TeamsConfig } from "./channels/teams.js";
export { MatrixChannel, type MatrixConfig } from "./channels/matrix.js";

// Plugins
export { SkillRegistry, type SkillManifest, type LoadedSkill } from "./plugins/skills.js";
export { BrowserController, type BrowserConfig } from "./plugins/browser.js";
export { CronScheduler, WebhookServer, type WebhookConfig } from "./plugins/automation.js";
export { Dashboard, type DashboardConfig } from "./plugins/dashboard.js";

export const VERSION = "0.7.0";
