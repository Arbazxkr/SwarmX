# Channels

Connect your AI agents to messaging platforms. 10 channels supported out of the box.

## Supported Channels

| Channel | Import | Config Key |
|---------|--------|------------|
| WhatsApp | `WhatsAppChannel` | `WHATSAPP_*` |
| Telegram | `TelegramChannel` | `TELEGRAM_BOT_TOKEN` |
| Discord | `DiscordChannel` | `DISCORD_TOKEN` |
| Slack | `SlackChannel` | `SLACK_BOT_TOKEN` |
| Web Chat | `WebChatChannel` | WebSocket port |
| Signal | `SignalChannel` | `SIGNAL_*` |
| iMessage | `IMessageChannel` | macOS only |
| Google Chat | `GoogleChatChannel` | `GOOGLE_CHAT_*` |
| Microsoft Teams | `TeamsChannel` | `TEAMS_*` |
| Matrix | `MatrixChannel` | `MATRIX_*` |

## Usage

```typescript
import { WhatsAppChannel, TelegramChannel } from "groklets";

// WhatsApp
const whatsapp = new WhatsAppChannel({
    sessionPath: "./.groklets/whatsapp-session",
});

// Telegram
const telegram = new TelegramChannel({
    token: process.env.TELEGRAM_BOT_TOKEN!,
});

// Connect to gateway
import { Gateway } from "groklets";

const gateway = new Gateway({ port: 3000 });
gateway.addChannel("whatsapp", whatsapp);
gateway.addChannel("telegram", telegram);
await gateway.start();
```

## Channel Adapter Interface

All channels implement the same interface:

```typescript
interface ChannelAdapter {
    start(): Promise<void>;
    stop(): Promise<void>;
    send(to: string, message: string): Promise<void>;
    onMessage(handler: (msg: ChannelMessage) => void): void;
}
```

Build your own channel by implementing this interface.
