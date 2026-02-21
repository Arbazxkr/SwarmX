/**
 * Groklets WhatsApp Channel — Baileys (Web) adapter.
 *
 * Uses @whiskeysockets/baileys to connect via WhatsApp Web protocol.
 * No Meta Business API needed — runs locally.
 */

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    type WASocket,
    type proto,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { ChannelAdapter, type ChannelConfig, type ChannelMessage } from "./adapter.js";
import { type SwarmEngine } from "../core/engine.js";

export interface WhatsAppConfig extends ChannelConfig {
    /** Directory to store auth state */
    authDir?: string;
    /** Auto-reconnect on disconnect */
    autoReconnect?: boolean;
    /** Send "typing..." indicator before replying */
    sendTyping?: boolean;
}

export class WhatsAppChannel extends ChannelAdapter {
    private sock: WASocket | null = null;
    private whatsappConfig: WhatsAppConfig;

    constructor(engine: SwarmEngine, config: WhatsAppConfig) {
        super(engine, { ...config, name: config.name ?? "whatsapp" });
        this.whatsappConfig = {
            authDir: config.authDir ?? join(process.cwd(), ".Groklets", "whatsapp-auth"),
            autoReconnect: config.autoReconnect ?? true,
            sendTyping: config.sendTyping ?? true,
            ...config,
        };
    }

    protected async connect(): Promise<void> {
        const authDir = this.whatsappConfig.authDir!;
        if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();

        this.sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            browser: ["Groklets", "Chrome", "1.0.0"],
        });

        this.sock.ev.on("creds.update", saveCreds);

        this.sock.ev.on("connection.update", (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                this.log.info("Scan the QR code above to connect WhatsApp");
            }

            if (connection === "close") {
                const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
                const shouldReconnect = reason !== DisconnectReason.loggedOut;

                this.log.warn(`Connection closed (reason: ${reason})`);

                if (shouldReconnect && this.whatsappConfig.autoReconnect && this.running) {
                    this.log.info("Reconnecting...");
                    setTimeout(() => this.connect(), 3000);
                } else if (reason === DisconnectReason.loggedOut) {
                    this.log.error("Logged out — delete auth folder and re-scan QR");
                }
            }

            if (connection === "open") {
                this.log.info("WhatsApp connected");
            }
        });

        // Handle incoming messages
        this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify") return;

            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;

                const content = this.extractContent(msg);
                if (!content) continue;

                const channelMsg: ChannelMessage = {
                    messageId: msg.key.id ?? "",
                    senderId: msg.key.remoteJid ?? "",
                    senderName: msg.pushName ?? msg.key.remoteJid ?? "Unknown",
                    content,
                    channel: "whatsapp",
                    chatId: msg.key.remoteJid ?? "",
                    isGroup: msg.key.remoteJid?.endsWith("@g.us") ?? false,
                    raw: msg,
                    timestamp: (msg.messageTimestamp as number) * 1000,
                };

                await this.onMessage(channelMsg);
            }
        });
    }

    protected async disconnect(): Promise<void> {
        if (this.sock) {
            this.sock.end(undefined);
            this.sock = null;
        }
    }

    async sendMessage(chatId: string, content: string): Promise<void> {
        if (!this.sock) {
            this.log.error("Not connected");
            return;
        }

        // Send typing indicator
        if (this.whatsappConfig.sendTyping) {
            await this.sock.presenceSubscribe(chatId);
            await this.sock.sendPresenceUpdate("composing", chatId);
        }

        // Split long messages (WhatsApp limit ~65536 chars, but readability at ~4000)
        const chunks = this.splitMessage(content, 4000);
        for (const chunk of chunks) {
            await this.sock.sendMessage(chatId, { text: chunk });
        }

        if (this.whatsappConfig.sendTyping) {
            await this.sock.sendPresenceUpdate("paused", chatId);
        }
    }

    private extractContent(msg: proto.IWebMessageInfo): string | null {
        const m = msg.message;
        if (!m) return null;

        if (m.conversation) return m.conversation;
        if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
        if (m.imageMessage?.caption) return m.imageMessage.caption;
        if (m.videoMessage?.caption) return m.videoMessage.caption;
        if (m.documentMessage?.caption) return m.documentMessage.caption;

        return null;
    }

    private splitMessage(text: string, maxLen: number): string[] {
        if (text.length <= maxLen) return [text];
        const chunks: string[] = [];
        let remaining = text;
        while (remaining.length > 0) {
            let splitAt = Math.min(remaining.length, maxLen);
            if (splitAt < remaining.length) {
                const lastNewline = remaining.lastIndexOf("\n", splitAt);
                if (lastNewline > maxLen * 0.5) splitAt = lastNewline;
            }
            chunks.push(remaining.slice(0, splitAt));
            remaining = remaining.slice(splitAt);
        }
        return chunks;
    }
}
