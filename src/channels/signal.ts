/**
 * Groklets Signal Channel — signal-cli adapter.
 *
 * Uses signal-cli (JSON RPC mode) to send/receive Signal messages.
 * Requires signal-cli installed and registered.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { ChannelAdapter, type ChannelConfig, type ChannelMessage } from "./adapter.js";
import { type SwarmEngine } from "../core/engine.js";

export interface SignalConfig extends ChannelConfig {
    /** Phone number registered with signal-cli */
    phoneNumber: string;
    /** Path to signal-cli binary */
    signalCliPath?: string;
}

export class SignalChannel extends ChannelAdapter {
    private process: ChildProcess | null = null;
    private signalConfig: SignalConfig;

    constructor(engine: SwarmEngine, config: SignalConfig) {
        super(engine, { ...config, name: config.name ?? "signal" });
        this.signalConfig = { signalCliPath: "signal-cli", ...config };
    }

    protected async connect(): Promise<void> {
        this.process = spawn(this.signalConfig.signalCliPath!, [
            "-u", this.signalConfig.phoneNumber,
            "jsonRpc",
        ], { stdio: ["pipe", "pipe", "pipe"] });

        const rl = createInterface({ input: this.process.stdout! });

        rl.on("line", async (line) => {
            try {
                const msg = JSON.parse(line);
                if (msg.method === "receive" && msg.params?.envelope?.dataMessage) {
                    const env = msg.params.envelope;
                    const data = env.dataMessage;

                    const channelMsg: ChannelMessage = {
                        messageId: `sig_${Date.now()}`,
                        senderId: env.sourceNumber ?? env.source ?? "",
                        senderName: env.sourceName ?? env.sourceNumber ?? "Unknown",
                        content: data.message ?? "",
                        channel: "signal",
                        chatId: data.groupInfo?.groupId ?? env.sourceNumber ?? "",
                        isGroup: !!data.groupInfo,
                        raw: msg,
                        timestamp: env.timestamp ?? Date.now(),
                    };

                    if (channelMsg.content) await this.onMessage(channelMsg);
                }
            } catch { }
        });

        this.process.on("error", (err) => this.log.error(`signal-cli error: ${err.message}`));
        this.process.on("exit", (code) => {
            if (this.running) this.log.warn(`signal-cli exited with code ${code}`);
        });

        this.log.info("Signal connected via signal-cli");
    }

    protected async disconnect(): Promise<void> {
        if (this.process) { this.process.kill(); this.process = null; }
    }

    async sendMessage(chatId: string, content: string): Promise<void> {
        if (!this.process?.stdin) return;

        const isGroup = chatId.length > 20; // Group IDs are longer
        const cmd = {
            jsonrpc: "2.0", id: Date.now(),
            method: "send",
            params: isGroup
                ? { groupId: chatId, message: content }
                : { recipient: [chatId], message: content },
        };

        this.process.stdin.write(JSON.stringify(cmd) + "\n");
    }
}
