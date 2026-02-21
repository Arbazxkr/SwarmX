/**
 * SwarmX Microsoft Teams Channel — Bot Framework adapter.
 */

import { ChannelAdapter, type ChannelConfig, type ChannelMessage } from "./adapter.js";
import { type SwarmEngine } from "../core/engine.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface TeamsConfig extends ChannelConfig {
    /** Bot Framework App ID */
    appId: string;
    /** Bot Framework App Password */
    appPassword: string;
    /** Webhook port */
    webhookPort?: number;
}

export class TeamsChannel extends ChannelAdapter {
    private server: ReturnType<typeof createServer> | null = null;
    private teamsConfig: TeamsConfig;

    constructor(engine: SwarmEngine, config: TeamsConfig) {
        super(engine, { ...config, name: config.name ?? "teams" });
        this.teamsConfig = { webhookPort: 9878, ...config };
    }

    protected async connect(): Promise<void> {
        this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            if (req.method !== "POST") { res.writeHead(405); res.end(); return; }

            let body = "";
            req.on("data", (chunk) => body += chunk);
            req.on("end", async () => {
                try {
                    const activity = JSON.parse(body);

                    if (activity.type === "message" && activity.text) {
                        // Strip bot mention
                        let content = activity.text;
                        if (activity.entities) {
                            for (const entity of activity.entities) {
                                if (entity.type === "mention" && entity.mentioned?.id === this.teamsConfig.appId) {
                                    content = content.replace(entity.text, "").trim();
                                }
                            }
                        }

                        const msg: ChannelMessage = {
                            messageId: activity.id ?? "",
                            senderId: activity.from?.id ?? "",
                            senderName: activity.from?.name ?? "Unknown",
                            content,
                            channel: "teams",
                            chatId: activity.conversation?.id ?? "",
                            isGroup: activity.conversation?.isGroup ?? false,
                            raw: activity,
                            timestamp: Date.now(),
                        };

                        await this.onMessage(msg);
                    }

                    res.writeHead(200);
                    res.end();
                } catch {
                    res.writeHead(400);
                    res.end();
                }
            });
        });

        await new Promise<void>((resolve) => {
            this.server!.listen(this.teamsConfig.webhookPort, () => {
                this.log.info(`Teams webhook: http://localhost:${this.teamsConfig.webhookPort}`);
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
        // In production, use Bot Framework REST API to reply
        this.log.debug(`Teams reply to ${chatId}: ${content.slice(0, 80)}`);
    }
}
