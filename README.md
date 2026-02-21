# <img src="Groklets.jpg" width="48" align="center" /> Groklets

**A model-agnostic, async, event-driven multi-agent orchestration framework.**

> Built by Arbaz Khan — one person, zero fluff, full OpenClaw feature parity.

---

## ⚡ Groklets vs OpenClaw — Side-by-Side

| Category | OpenClaw | Groklets | Status |
|---|---|---|---|
| **TypeScript** | 592,027 lines | 7,288 lines | ✅ Feature parity at 1.2% size |
| **Swift (macOS + iOS)** | 71,017 lines | 965 lines | ✅ Core features covered |
| **Kotlin (Android)** | 12,155 lines | 402 lines | ✅ Core features covered |
| **Contributors** | 708 | 1 | 💪 |
| **Releases** | 48 | — | v0.5.0 |

### Engine Core

| Feature | OpenClaw | Groklets |
|---|---|---|
| Event bus (pub/sub + wildcards) | ✅ | ✅ |
| Agent lifecycle + tool loop | ✅ | ✅ |
| Providers (OpenAI, Anthropic, Google, xAI) | ✅ 4 | ✅ 4 |
| Model failover + health checks | ✅ | ✅ |
| Streaming (SSE) | ✅ | ✅ |
| Task scheduler (deps + priorities) | ✅ | ✅ |
| Tool executor (agentic loop) | ✅ | ✅ |
| Session persistence | ✅ | ✅ |
| Context management (prune + compact) | ✅ | ✅ |
| Usage tracking (cost per model) | ✅ | ✅ |
| Gateway WebSocket control plane | ✅ | ✅ |
| Memory (TF-IDF search + facts) | ✅ | ✅ |
| Security (trust, sanitize, rate limit, sandbox) | ✅ | ✅ |
| Media pipeline (Whisper + vision) | ✅ | ✅ |
| Voice (ElevenLabs TTS + Whisper STT) | ✅ | ✅ |
| Advanced routing (activation modes, groups) | ✅ | ✅ |
| Canvas A2UI (push/eval/snapshot) | ✅ | ✅ |

### Messaging Channels

| Channel | OpenClaw | Groklets | Library |
|---|---|---|---|
| WhatsApp | ✅ | ✅ | Baileys |
| Telegram | ✅ | ✅ | grammY |
| Discord | ✅ | ✅ | discord.js |
| Slack | ✅ | ✅ | Bolt |
| Signal | ✅ | ✅ | signal-cli |
| iMessage | ✅ | ✅ | BlueBubbles |
| Google Chat | ✅ | ✅ | Webhook |
| Microsoft Teams | ✅ | ✅ | Bot Framework |
| Matrix | ✅ | ✅ | Client-Server API |
| WebChat | ✅ | ✅ | Built-in |
| Zalo | ✅ | — | — |
| LINE | ✅ | — | — |
| **Total** | **13** | **10** | |

### Plugins & Tools

| Plugin | OpenClaw | Groklets |
|---|---|---|
| Skills / Plugin system | ✅ ClawHub | ✅ SkillRegistry |
| Browser control (CDP) | ✅ | ✅ |
| Cron scheduler | ✅ | ✅ |
| Webhooks | ✅ | ✅ |
| Dashboard (web UI) | ✅ | ✅ |
| Docker + Compose | ✅ | ✅ |

### Native Apps

| App | OpenClaw | Groklets |
|---|---|---|
| macOS (menu bar) | ✅ 54k Swift | ✅ 480 lines Swift |
| iOS (companion node) | ✅ 17k Swift | ✅ 485 lines Swift |
| Android (companion node) | ✅ 12k Kotlin | ✅ 402 lines Kotlin |
| Voice Wake / Talk Mode | ✅ | ✅ |
| Canvas surface | ✅ | ✅ |
| Camera / screen capture | ✅ | ✅ |

---

## 🚀 Quick Start

```bash
# Install
npm install -g groklets

# Setup (interactive wizard)
groklets wizard

# Start Gateway
groklets gateway config.yaml

# Or via Docker
docker compose up -d
```

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────┐
│                  Groklets Engine                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │  Agent 1  │  │  Agent 2  │  │  Agent N  │     │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘      │
│       │              │              │             │
│  ┌────┴──────────────┴──────────────┴────┐       │
│  │            Event Bus (pub/sub)         │       │
│  └────┬──────────────┬──────────────┬────┘       │
│       │              │              │             │
│  ┌────┴─────┐  ┌────┴─────┐  ┌────┴─────┐      │
│  │ Providers │  │  Tools   │  │ Sessions │       │
│  │ (4 LLMs) │  │ Registry │  │  Store   │       │
│  └──────────┘  └──────────┘  └──────────┘       │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │  Memory  │  │ Security │  │  Media   │       │
│  │  (TF-IDF)│  │(sandbox) │  │(pipeline)│       │
│  └──────────┘  └──────────┘  └──────────┘       │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │  Voice   │  │  Canvas  │  │  Router  │       │
│  │(11Labs)  │  │  (A2UI)  │  │(groups)  │       │
│  └──────────┘  └──────────┘  └──────────┘       │
└───────────────────┬─────────────────────────────┘
                    │ WebSocket
        ┌───────────┼───────────┐
        │           │           │
   ┌────┴────┐ ┌───┴────┐ ┌───┴────┐
   │ Gateway │ │  CLI   │ │  Web   │
   │  (WS)  │ │(9 cmds)│ │ (Chat) │
   └────┬────┘ └────────┘ └───┬────┘
        │                      │
   ┌────┴──────────────────────┴────┐
   │        10 Channels             │
   │  WA · TG · Discord · Slack    │
   │  Signal · iMsg · GChat        │
   │  Teams · Matrix · WebChat     │
   └────────────────────────────────┘
        │
   ┌────┴──────────────────────┐
   │       Native Apps         │
   │  macOS · iOS · Android    │
   └───────────────────────────┘
```

## 📦 What's Inside

```
src/
├── core/           # Engine, agents, providers, event bus
│   ├── agent.ts        # Agent lifecycle + tool loop
│   ├── canvas.ts       # A2UI push system
│   ├── context.ts      # Context window management
│   ├── engine.ts       # Orchestration engine
│   ├── event-bus.ts    # Pub/sub with wildcards
│   ├── failover.ts     # Model failover
│   ├── gateway.ts      # WebSocket control plane
│   ├── media.ts        # Image/audio/video pipeline
│   ├── memory.ts       # TF-IDF memory + fact extraction
│   ├── provider.ts     # LLM provider abstraction
│   ├── router.ts       # Advanced message routing
│   ├── scheduler.ts    # Task scheduler
│   ├── security.ts     # Trust, sanitize, rate limit
│   ├── session.ts      # Session persistence
│   ├── tool-executor.ts # Agentic tool loop
│   ├── usage.ts        # Cost tracking
│   └── voice.ts        # ElevenLabs TTS + Whisper STT
├── channels/       # 10 messaging platforms
├── plugins/        # Skills, browser, cron, dashboard
├── providers/      # OpenAI, Anthropic, Google, xAI
├── cli/            # 9 CLI commands
└── utils/          # Config, logger, retry

apps/
├── macos/          # SwiftUI menu bar app
├── ios/            # SwiftUI companion node
└── android/        # Jetpack Compose companion
```

## 📜 License

MIT — Arbaz Khan
