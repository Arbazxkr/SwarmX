/**
 * SwarmX WebChat Channel — Browser-based chat served from the Gateway.
 *
 * Connects to the WebSocket Gateway and provides a simple
 * HTTP endpoint serving a chat UI. No external deps — just HTML.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ChannelAdapter, type ChannelConfig, type ChannelMessage } from "./adapter.js";
import { type SwarmEngine } from "../core/engine.js";

export interface WebChatConfig extends ChannelConfig {
    /** HTTP port for the chat UI */
    port?: number;
    /** Title shown in the chat UI */
    title?: string;
}

const WEBCHAT_HTML = (title: string, wsPort: number) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0f; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }
  .header { padding: 16px 24px; background: #12121a; border-bottom: 1px solid #1e1e2e; display: flex; align-items: center; gap: 12px; }
  .header .dot { width: 10px; height: 10px; border-radius: 50%; background: #22c55e; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  .header h1 { font-size: 16px; font-weight: 600; color: #fff; }
  .header .sub { font-size: 12px; color: #666; margin-left: auto; }
  .messages { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 16px; }
  .msg { max-width: 80%; padding: 12px 16px; border-radius: 16px; line-height: 1.5; font-size: 14px; white-space: pre-wrap; word-wrap: break-word; }
  .msg.user { align-self: flex-end; background: #2563eb; color: white; border-bottom-right-radius: 4px; }
  .msg.agent { align-self: flex-start; background: #1e1e2e; color: #e0e0e0; border-bottom-left-radius: 4px; border: 1px solid #2a2a3e; }
  .msg.system { align-self: center; font-size: 12px; color: #666; }
  .msg .name { font-size: 11px; color: #888; margin-bottom: 4px; }
  .input-area { padding: 16px 24px; background: #12121a; border-top: 1px solid #1e1e2e; display: flex; gap: 12px; }
  input { flex: 1; padding: 12px 16px; border-radius: 12px; border: 1px solid #2a2a3e; background: #0a0a0f; color: #e0e0e0; font-size: 14px; outline: none; transition: border-color 0.2s; }
  input:focus { border-color: #2563eb; }
  button { padding: 12px 24px; border-radius: 12px; border: none; background: #2563eb; color: white; font-weight: 600; cursor: pointer; transition: background 0.2s; }
  button:hover { background: #1d4ed8; }
  button:disabled { background: #333; cursor: not-allowed; }
</style>
</head>
<body>
<div class="header">
  <div class="dot"></div>
  <h1>⚛ ${title}</h1>
  <span class="sub" id="status">Connecting...</span>
</div>
<div class="messages" id="messages"></div>
<div class="input-area">
  <input id="input" placeholder="Type a message..." autocomplete="off" />
  <button id="send" onclick="send()">Send</button>
</div>
<script>
const msgs = document.getElementById('messages');
const input = document.getElementById('input');
const status = document.getElementById('status');
const btn = document.getElementById('send');
let ws;

function connect() {
  ws = new WebSocket('ws://127.0.0.1:${wsPort}');
  ws.onopen = () => {
    status.textContent = 'Connected';
    ws.send(JSON.stringify({ type: 'event.subscribe', payload: { topics: ['agent.response.*', 'stream.*'] } }));
    addMsg('system', '', 'Connected to SwarmX');
  };
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'event.forward' && data.payload.topic?.startsWith('agent.response')) {
      addMsg('agent', data.payload.payload.agentId || 'Agent', data.payload.payload.content);
    }
    if (data.type === 'agent.response') {
      addMsg('agent', data.payload.agent || 'Agent', data.payload.content);
    }
  };
  ws.onclose = () => { status.textContent = 'Disconnected'; setTimeout(connect, 3000); };
}

function send() {
  const text = input.value.trim();
  if (!text || !ws) return;
  addMsg('user', 'You', text);
  ws.send(JSON.stringify({ type: 'task.submit', payload: { content: text } }));
  input.value = '';
}

input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

function addMsg(type, name, content) {
  const d = document.createElement('div');
  d.className = 'msg ' + type;
  if (name && type !== 'system') d.innerHTML = '<div class="name">' + name + '</div>' + content;
  else d.textContent = content;
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight;
}

connect();
</script>
</body>
</html>`;

export class WebChatChannel extends ChannelAdapter {
    private server: ReturnType<typeof createServer> | null = null;
    private webChatConfig: WebChatConfig;
    private wsPort: number;

    constructor(engine: SwarmEngine, config: WebChatConfig, wsPort?: number) {
        super(engine, { ...config, name: config.name ?? "webchat" });
        this.webChatConfig = { port: 3737, title: "SwarmX Chat", ...config };
        this.wsPort = wsPort ?? 18789;
    }

    protected async connect(): Promise<void> {
        const port = this.webChatConfig.port!;

        this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(WEBCHAT_HTML(this.webChatConfig.title!, this.wsPort));
        });

        await new Promise<void>((resolve) => {
            this.server!.listen(port, () => {
                this.log.info(`WebChat UI: http://localhost:${port}`);
                resolve();
            });
        });
    }

    protected async disconnect(): Promise<void> {
        if (this.server) {
            await new Promise<void>((resolve) => this.server!.close(() => resolve()));
            this.server = null;
        }
    }

    async sendMessage(_chatId: string, _content: string): Promise<void> {
        // WebChat messages are handled via the WebSocket Gateway directly
        // No platform-specific sending needed
    }
}
