/**
 * SwarmX Google Chat Channel — Google Chat API adapter.
 */

import { ChannelAdapter, type ChannelConfig, type ChannelMessage } from "./adapter.js";
import { type SwarmEngine } from "../core/engine.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface GoogleChatConfig extends ChannelConfig {
    /** Port for incoming webhook */
    webhookPort?: number;
    /** Service account credentials JSON path */
    credentialsPath?: string;
}

export class GoogleChatChannel extends ChannelAdapter {
    private server: ReturnType<typeof createServer> | null = null;
    private gcConfig: GoogleChatConfig;

    constructor(engine: SwarmEngine, config: GoogleChatConfig) {
        super(engine, { ...config, name: config.name ?? "googlechat" });
        this.gcConfig = { webhookPort: 9877, ...config };
    }

    protected async connect(): Promise<void> {
        this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            if (req.method !== "POST") { res.writeHead(405); res.end(); return; }

            let body = "";
            req.on("data", (chunk) => body += chunk);
            req.on("end", async () => {
                try {
                    const event = JSON.parse(body);

                    if (event.type === "MESSAGE" && event.message?.text) {
                        const msg: ChannelMessage = {
                            messageId: event.message.name ?? "",
                            senderId: event.user?.name ?? "",
                            senderName: event.user?.displayName ?? "Unknown",
                            content: event.message.text,
                            channel: "googlechat",
                            chatId: event.space?.name ?? "",
                            isGroup: event.space?.type === "ROOM",
                            raw: event,
                            timestamp: Date.now(),
                        };

                        await this.onMessage(msg);
                    }

                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ text: "" }));
                } catch {
                    res.writeHead(400);
                    res.end();
                }
            });
        });

        await new Promise<void>((resolve) => {
            this.server!.listen(this.gcConfig.webhookPort, () => {
                this.log.info(`Google Chat webhook: http://localhost:${this.gcConfig.webhookPort}`);
                resolve();
            });
        });
    }

    protected async disconnect(): Promise<void> {
        if (this.server) {
            await new Promise<void>((r) => this.server!.close(() => r()));
            this.server = null;
        }
    }

    async sendMessage(chatId: string, content: string): Promise<void> {
        // Requires service account + Google Chat API
        this.log.debug(`Google Chat reply to ${chatId}: ${content.slice(0, 80)}`);
        // In production, use googleapis to post back to the space
    }
}
