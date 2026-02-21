/**
 * SwarmX Matrix Channel — matrix-js-sdk adapter.
 */

import { ChannelAdapter, type ChannelConfig, type ChannelMessage } from "./adapter.js";
import { type SwarmEngine } from "../core/engine.js";

export interface MatrixConfig extends ChannelConfig {
    /** Matrix homeserver URL */
    homeserverUrl: string;
    /** Access token */
    accessToken: string;
    /** User ID (@bot:matrix.org) */
    userId: string;
}

export class MatrixChannel extends ChannelAdapter {
    private matrixConfig: MatrixConfig;
    private syncToken: string | null = null;
    private pollTimer?: ReturnType<typeof setInterval>;

    constructor(engine: SwarmEngine, config: MatrixConfig) {
        super(engine, { ...config, name: config.name ?? "matrix" });
        this.matrixConfig = config;
    }

    protected async connect(): Promise<void> {
        // Initial sync to get sync token
        const res = await fetch(`${this.matrixConfig.homeserverUrl}/_matrix/client/v3/sync?timeout=0`, {
            headers: { Authorization: `Bearer ${this.matrixConfig.accessToken}` },
        });
        const data = await res.json() as { next_batch: string };
        this.syncToken = data.next_batch;

        this.log.info("Matrix connected");

        // Long-poll for events
        this.pollTimer = setInterval(() => this.sync(), 3000);
    }

    private async sync(): Promise<void> {
        try {
            const url = `${this.matrixConfig.homeserverUrl}/_matrix/client/v3/sync?since=${this.syncToken}&timeout=5000`;
            const res = await fetch(url, {
                headers: { Authorization: `Bearer ${this.matrixConfig.accessToken}` },
            });
            const data = await res.json() as any;
            this.syncToken = data.next_batch;

            // Process room events
            for (const [roomId, room] of Object.entries(data.rooms?.join ?? {})) {
                const events = (room as any).timeline?.events ?? [];
                for (const event of events) {
                    if (event.type !== "m.room.message") continue;
                    if (event.sender === this.matrixConfig.userId) continue;
                    if (event.content?.msgtype !== "m.text") continue;

                    const msg: ChannelMessage = {
                        messageId: event.event_id ?? "",
                        senderId: event.sender ?? "",
                        senderName: event.sender?.split(":")[0]?.slice(1) ?? "Unknown",
                        content: event.content.body ?? "",
                        channel: "matrix",
                        chatId: roomId,
                        isGroup: true,
                        raw: event,
                        timestamp: event.origin_server_ts ?? Date.now(),
                    };

                    await this.onMessage(msg);
                }
            }
        } catch (err) {
            this.log.error(`Matrix sync failed: ${err}`);
        }
    }

    protected async disconnect(): Promise<void> {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    }

    async sendMessage(chatId: string, content: string): Promise<void> {
        const txnId = `swarmx_${Date.now()}`;
        await fetch(
            `${this.matrixConfig.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(chatId)}/send/m.room.message/${txnId}`,
            {
                method: "PUT",
                headers: {
                    Authorization: `Bearer ${this.matrixConfig.accessToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ msgtype: "m.text", body: content }),
            },
        );
    }
}
