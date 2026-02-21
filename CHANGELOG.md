# Changelog

All notable changes to Groklets will be documented in this file.

## [0.6.0] - 2026-02-21

### Added
- **Workflow Engine** — DAG-based multi-agent orchestration with parallel execution, conditional steps, shared blackboard state, structured output validation, step retries, and timeouts.
- **`pipeline()` builder** — create linear agent chains: A → B → C.
- **`fanOutFanIn()` builder** — run N agents in parallel, merge results through a final agent.
- **Pluggable provider system** — register custom providers via `registerClass()`, `registerFactory()`, or `registerInstance()`. Any OpenAI-compatible endpoint auto-works with `base_url`.
- **Structured output validation** — validate agent outputs against type schemas before passing downstream.
- **Provider factory functions** — alternative to class-based provider registration.
- **89 tests** across 7 test files covering workflows, providers, memory, security, router, scheduler, and engine.
- **GitHub Actions CI** — automated testing on Node 20 + 22, type checking, linting, Docker build.
- **CONTRIBUTING.md**, **SECURITY.md**, **CHANGELOG.md** — open source infrastructure.

### Changed
- Provider registry now supports `create(typeName, instanceName, config)` with fallback for unknown types.
- Config loader registers built-in provider types on the engine's registry instead of using a hardcoded map.
- README rewritten as orchestration framework documentation with mermaid diagrams.

### Removed
- Hardcoded `PROVIDER_MAP` in config loader.

## [0.5.0] - 2026-02-20

### Added
- Rebranded from SwarmX to **Groklets**.
- Updated CLI tool name, banner, and all commands.
- Updated package.json metadata (name, bin, repository, homepage).
- README with project overview, features, architecture, and configuration.

## [0.4.0] - 2026-02-19

### Added
- **10 messaging channels**: WhatsApp (Baileys), Telegram (grammY), Discord (discord.js), Slack (Bolt), Signal (signal-cli), iMessage (BlueBubbles), Google Chat, Microsoft Teams, Matrix, WebChat.
- **Voice engine**: ElevenLabs TTS + OpenAI Whisper STT.
- **Media pipeline**: image/audio/video ingest with Whisper transcription and GPT-4o vision.
- **Canvas A2UI**: agents push interactive UI components to connected clients.
- **Message router**: activation modes (always, mention, keyword, dm-only), group isolation, priority queue, dedup.
- **Browser control**: CDP-based Chrome automation (navigate, screenshot, click, type, evaluate).
- **Cron scheduler**: simplified format (`every 5m`, `daily 09:00`).
- **Webhook server**: HTTP routes with authentication.
- **Skills platform**: installable tool packs with manifest + trust verification.
- **Dashboard**: dark-mode web UI served from Gateway.
- **Docker**: multi-stage Dockerfile + docker-compose.
- **Native apps**: macOS (SwiftUI), iOS (SwiftUI), Android (Jetpack Compose).

## [0.3.0] - 2026-02-18

### Added
- **Gateway**: WebSocket control plane for sessions, presence, and events.
- **Session store**: per-chat isolation with persistence.
- **Context manager**: token-aware pruning and window management.
- **Usage tracker**: per-model cost tracking across all providers.
- **Model failover**: health checks, cooldown periods, automatic rerouting.

## [0.2.0] - 2026-02-17

### Added
- **Memory store**: TF-IDF semantic search, automatic fact extraction, persistent storage.
- **Security**: input sanitization, token bucket rate limiter, skill trust (SHA-256), tool guard, VM sandbox.
- **4 LLM providers**: OpenAI, Anthropic, Google Gemini, xAI Grok.
- **Tool executor**: agentic tool loop with streaming.

## [0.1.0] - 2026-02-16

### Added
- Initial release.
- **SwarmEngine**: event-driven multi-agent orchestration engine.
- **EventBus**: async pub/sub with wildcard subscriptions and priority levels.
- **Agent**: lifecycle management, tool loop, context handling.
- **TaskScheduler**: dependency-aware task queue with priorities.
- **CLI**: `run`, `gateway`, `validate`, `status`, `doctor`, `health`, `init`, `onboard` commands.
