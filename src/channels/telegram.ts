/**
 * Groklets Telegram Channel — grammY bot adapter.
 */

import { Bot, type Context } from "grammy";
import { ChannelAdapter, type ChannelConfig, type ChannelMessage } from "./adapter.js";
import { type SwarmEngine } from "../core/engine.js";

export interface TelegramConfig extends ChannelConfig {
    /** Telegram Bot Token from @BotFather */
    botToken: string;
    /** Send typing action before replying */
    sendTyping?: boolean;
}

export class TelegramChannel extends ChannelAdapter {
    private bot: Bot | null = null;
    private telegramConfig: TelegramConfig;

    constructor(engine: SwarmEngine, config: TelegramConfig) {
        super(engine, { ...config, name: config.name ?? "telegram" });
        this.telegramConfig = { sendTyping: true, ...config };
    }

    protected async connect(): Promise<void> {
        this.bot = new Bot(this.telegramConfig.botToken);

        // Handle text messages
        this.bot.on("message:text", async (ctx: Context) => {
            const msg = ctx.message;
            if (!msg || !msg.text) return;

            const channelMsg: ChannelMessage = {
                messageId: msg.message_id.toString(),
                senderId: msg.from?.id.toString() ?? "",
                senderName: msg.from?.first_name ?? "Unknown",
                content: msg.text,
                channel: "telegram",
                chatId: msg.chat.id.toString(),
                isGroup: msg.chat.type === "group" || msg.chat.type === "supergroup",
                raw: msg,
                timestamp: msg.date * 1000,
            };

            await this.onMessage(channelMsg);
        });

        // Handle photo captions
        this.bot.on("message:photo", async (ctx: Context) => {
            const caption = ctx.message?.caption;
            if (!caption) return;

            const msg = ctx.message!;
            const channelMsg: ChannelMessage = {
                messageId: msg.message_id.toString(),
                senderId: msg.from?.id.toString() ?? "",
                senderName: msg.from?.first_name ?? "Unknown",
                content: caption,
                channel: "telegram",
                chatId: msg.chat.id.toString(),
                isGroup: msg.chat.type === "group" || msg.chat.type === "supergroup",
                raw: msg,
                timestamp: msg.date * 1000,
            };

            await this.onMessage(channelMsg);
        });

        // Start polling
        this.bot.start({
            onStart: () => this.log.info("Telegram bot started"),
        });
    }

    protected async disconnect(): Promise<void> {
        if (this.bot) {
            this.bot.stop();
            this.bot = null;
        }
    }

    async sendMessage(chatId: string, content: string): Promise<void> {
        if (!this.bot) {
            this.log.error("Bot not connected");
            return;
        }

        const numericChatId = parseInt(chatId);

        // Send typing indicator
        if (this.telegramConfig.sendTyping) {
            await this.bot.api.sendChatAction(numericChatId, "typing");
        }

        // Telegram max message length = 4096
        const chunks = this.splitMessage(content, 4000);
        for (const chunk of chunks) {
            await this.bot.api.sendMessage(numericChatId, chunk, { parse_mode: "Markdown" }).catch(async () => {
                // Fallback: send without markdown if parsing fails
                await this.bot!.api.sendMessage(numericChatId, chunk);
            });
        }
    }

    private splitMessage(text: string, maxLen: number): string[] {
        if (text.length <= maxLen) return [text];
        const chunks: string[] = [];
        let remaining = text;
        while (remaining.length > 0) {
            const splitAt = Math.min(remaining.length, maxLen);
            chunks.push(remaining.slice(0, splitAt));
            remaining = remaining.slice(splitAt);
        }
        return chunks;
    }
}
