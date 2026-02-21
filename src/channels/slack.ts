/**
 * Groklets Slack Channel — Bolt adapter.
 */

import { App } from "@slack/bolt";
import { ChannelAdapter, type ChannelConfig, type ChannelMessage } from "./adapter.js";
import { type SwarmEngine } from "../core/engine.js";

export interface SlackConfig extends ChannelConfig {
    /** Slack Bot Token (xoxb-...) */
    botToken: string;
    /** Slack App Token (xapp-...) for Socket Mode */
    appToken: string;
    /** Slack Signing Secret */
    signingSecret?: string;
    /** Only respond when mentioned (@bot) */
    requireMention?: boolean;
    /** Send typing indicator (Slack supports this differently) */
    sendTyping?: boolean;
}

export class SlackChannel extends ChannelAdapter {
    private app: App | null = null;
    private slackConfig: SlackConfig;
    private botUserId: string = "";

    constructor(engine: SwarmEngine, config: SlackConfig) {
        super(engine, { ...config, name: config.name ?? "slack" });
        this.slackConfig = {
            requireMention: true,
            sendTyping: false,
            ...config,
        };
    }

    protected async connect(): Promise<void> {
        this.app = new App({
            token: this.slackConfig.botToken,
            appToken: this.slackConfig.appToken,
            signingSecret: this.slackConfig.signingSecret,
            socketMode: true,
        });

        // Get bot user ID
        const authResult = await this.app.client.auth.test({ token: this.slackConfig.botToken });
        this.botUserId = authResult.user_id ?? "";

        // Handle messages
        this.app.message(async ({ message, say }) => {
            const msg = message as any;
            if (!msg.text || msg.subtype) return;

            const isDM = msg.channel_type === "im";

            // Mention check in channels
            if (!isDM && this.slackConfig.requireMention) {
                if (!msg.text.includes(`<@${this.botUserId}>`)) return;
            }

            // Strip mention
            let content = msg.text;
            if (this.botUserId) {
                content = content.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim();
            }
            if (!content) return;

            // Get user info
            let senderName = "Unknown";
            try {
                const userInfo = await this.app!.client.users.info({ user: msg.user ?? "" });
                senderName = (userInfo.user as any)?.real_name ?? (userInfo.user as any)?.name ?? "Unknown";
            } catch { }

            const channelMsg: ChannelMessage = {
                messageId: msg.ts ?? "",
                senderId: msg.user ?? "",
                senderName,
                content,
                channel: "slack",
                chatId: msg.channel,
                isGroup: !isDM,
                raw: msg,
                timestamp: parseFloat(msg.ts ?? "0") * 1000,
            };

            await this.onMessage(channelMsg);
        });

        await this.app.start();
        this.log.info("Slack bot started (Socket Mode)");
    }

    protected async disconnect(): Promise<void> {
        if (this.app) {
            await this.app.stop();
            this.app = null;
        }
    }

    async sendMessage(chatId: string, content: string): Promise<void> {
        if (!this.app) {
            this.log.error("Bot not connected");
            return;
        }

        // Slack max block = 3000 chars per section
        const chunks = this.splitMessage(content, 3000);
        for (const chunk of chunks) {
            await this.app.client.chat.postMessage({
                channel: chatId,
                text: chunk,
                mrkdwn: true,
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
