/**
 * Groklets iMessage Channel — BlueBubbles adapter.
 *
 * Uses BlueBubbles HTTP API to send/receive iMessages.
 * Requires BlueBubbles server running on a Mac.
 */

import { ChannelAdapter, type ChannelConfig, type ChannelMessage } from "./adapter.js";
import { type SwarmEngine } from "../core/engine.js";

export interface IMessageConfig extends ChannelConfig {
    /** BlueBubbles server URL */
    serverUrl: string;
    /** BlueBubbles password */
    password: string;
    /** Polling interval in ms */
    pollIntervalMs?: number;
}

export class IMessageChannel extends ChannelAdapter {
    private imsgConfig: IMessageConfig;
    private pollTimer?: ReturnType<typeof setInterval>;
    private lastTimestamp = Date.now();

    constructor(engine: SwarmEngine, config: IMessageConfig) {
        super(engine, { ...config, name: config.name ?? "imessage" });
        this.imsgConfig = { pollIntervalMs: 3000, ...config };
    }

    protected async connect(): Promise<void> {
        // Verify connection
        const res = await fetch(`${this.imsgConfig.serverUrl}/api/v1/server/info?password=${this.imsgConfig.password}`);
        if (!res.ok) throw new Error(`BlueBubbles connection failed: ${res.status}`);

        this.log.info("Connected to BlueBubbles");

        // Poll for new messages
        this.pollTimer = setInterval(() => this.pollMessages(), this.imsgConfig.pollIntervalMs!);
    }

    private async pollMessages(): Promise<void> {
        try {
            const res = await fetch(
                `${this.imsgConfig.serverUrl}/api/v1/message?password=${this.imsgConfig.password}&after=${this.lastTimestamp}&limit=50&sort=asc`,
            );
            if (!res.ok) return;

            const data = await res.json() as { data: any[] };
            for (const msg of data.data ?? []) {
                if (msg.isFromMe || !msg.text) continue;

                this.lastTimestamp = Math.max(this.lastTimestamp, msg.dateCreated + 1);

                const channelMsg: ChannelMessage = {
                    messageId: msg.guid ?? "",
                    senderId: msg.handle?.address ?? "",
                    senderName: msg.handle?.displayName ?? msg.handle?.address ?? "Unknown",
                    content: msg.text,
                    channel: "imessage",
                    chatId: msg.chats?.[0]?.guid ?? msg.handle?.address ?? "",
                    isGroup: (msg.chats?.[0]?.participants?.length ?? 0) > 1,
                    raw: msg,
                    timestamp: msg.dateCreated ?? Date.now(),
                };

                await this.onMessage(channelMsg);
            }
        } catch (err) {
            this.log.error(`Poll failed: ${err}`);
        }
    }

    protected async disconnect(): Promise<void> {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    }

    async sendMessage(chatId: string, content: string): Promise<void> {
        await fetch(`${this.imsgConfig.serverUrl}/api/v1/message/text`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chatGuid: chatId,
                message: content,
                method: "private-api",
                tempGuid: `temp_${Date.now()}`,
                password: this.imsgConfig.password,
            }),
        });
    }
}
