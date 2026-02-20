/**
 * SwarmX Discord Channel — discord.js adapter.
 */

import { Client, GatewayIntentBits, type Message as DiscordMessage } from "discord.js";
import { ChannelAdapter, type ChannelConfig, type ChannelMessage } from "./adapter.js";
import { type SwarmEngine } from "../core/engine.js";

export interface DiscordConfig extends ChannelConfig {
    /** Discord Bot Token */
    botToken: string;
    /** Only respond when mentioned (@bot) in servers */
    requireMention?: boolean;
    /** Respond to DMs */
    allowDMs?: boolean;
    /** Send typing indicator */
    sendTyping?: boolean;
}

export class DiscordChannel extends ChannelAdapter {
    private client: Client | null = null;
    private discordConfig: DiscordConfig;
    private botUserId: string = "";

    constructor(engine: SwarmEngine, config: DiscordConfig) {
        super(engine, { ...config, name: config.name ?? "discord" });
        this.discordConfig = {
            requireMention: true,
            allowDMs: true,
            sendTyping: true,
            ...config,
        };
    }

    protected async connect(): Promise<void> {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages,
            ],
        });

        this.client.on("ready", () => {
            this.botUserId = this.client!.user?.id ?? "";
            this.log.info(`Discord bot ready: ${this.client!.user?.tag}`);
        });

        this.client.on("messageCreate", async (msg: DiscordMessage) => {
            // Skip bot messages
            if (msg.author.bot) return;

            const isDM = !msg.guild;
            const isGroup = !!msg.guild;

            // DM check
            if (isDM && !this.discordConfig.allowDMs) return;

            // Mention check in servers
            if (isGroup && this.discordConfig.requireMention) {
                if (!msg.mentions.has(this.botUserId)) return;
            }

            // Strip bot mention from content
            let content = msg.content;
            if (this.botUserId) {
                content = content.replace(new RegExp(`<@!?${this.botUserId}>`, "g"), "").trim();
            }
            if (!content) return;

            const channelMsg: ChannelMessage = {
                messageId: msg.id,
                senderId: msg.author.id,
                senderName: msg.author.displayName ?? msg.author.username,
                content,
                channel: "discord",
                chatId: msg.channel.id,
                isGroup,
                raw: msg,
                timestamp: msg.createdTimestamp,
            };

            await this.onMessage(channelMsg);
        });

        await this.client.login(this.discordConfig.botToken);
    }

    protected async disconnect(): Promise<void> {
        if (this.client) {
            this.client.destroy();
            this.client = null;
        }
    }

    async sendMessage(chatId: string, content: string): Promise<void> {
        if (!this.client) {
            this.log.error("Bot not connected");
            return;
        }

        const channel = await this.client.channels.fetch(chatId);
        if (!channel || !("send" in channel)) {
            this.log.error(`Cannot send to channel: ${chatId}`);
            return;
        }

        // Send typing indicator
        if (this.discordConfig.sendTyping && "sendTyping" in channel) {
            await (channel as any).sendTyping();
        }

        // Discord max = 2000 chars
        const chunks = this.splitMessage(content, 1950);
        for (const chunk of chunks) {
            await (channel as any).send(chunk);
        }
    }

    private splitMessage(text: string, maxLen: number): string[] {
        if (text.length <= maxLen) return [text];
        const chunks: string[] = [];
        let remaining = text;
        while (remaining.length > 0) {
            let splitAt = Math.min(remaining.length, maxLen);
            const lastNewline = remaining.lastIndexOf("\n", splitAt);
            if (lastNewline > maxLen * 0.5) splitAt = lastNewline;
            chunks.push(remaining.slice(0, splitAt));
            remaining = remaining.slice(splitAt);
        }
        return chunks;
    }
}
