/**
 * SwarmX Dashboard — Web control panel served from the Gateway.
 *
 * A self-contained HTML dashboard for managing the engine.
 * No React/build tools — pure HTML + CSS + inline JS.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type SwarmEngine } from "../core/engine.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Dashboard");

export interface DashboardConfig {
    port?: number;
    host?: string;
    wsPort?: number;
}

const DASHBOARD_HTML = (wsPort: number) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SwarmX Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root { --bg: #09090b; --card: #18181b; --border: #27272a; --text: #fafafa; --dim: #71717a; --accent: #3b82f6; --green: #22c55e; --red: #ef4444; --yellow: #eab308; }
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
  .header { padding: 20px 32px; background: var(--card); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 16px; }
  .header h1 { font-size: 18px; font-weight: 700; }
  .header .badge { padding: 4px 12px; border-radius: 20px; font-size: 11px; font-weight: 600; }
  .badge.online { background: rgba(34,197,94,0.15); color: var(--green); }
  .badge.offline { background: rgba(239,68,68,0.15); color: var(--red); }
  .header .right { margin-left: auto; font-size: 12px; color: var(--dim); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; padding: 24px 32px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--dim); margin-bottom: 16px; font-weight: 600; }
  .stat { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); }
  .stat:last-child { border-bottom: none; }
  .stat .label { font-size: 13px; color: var(--dim); }
  .stat .value { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .agent-row { padding: 12px; border-radius: 8px; background: rgba(255,255,255,0.02); margin-bottom: 8px; display: flex; align-items: center; gap: 12px; }
  .agent-row .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot.idle { background: var(--green); }
  .dot.processing { background: var(--yellow); animation: pulse 1.5s infinite; }
  .dot.error { background: var(--red); }
  .dot.created { background: var(--dim); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
  .agent-row .info { flex: 1; }
  .agent-row .name { font-size: 13px; font-weight: 600; }
  .agent-row .meta { font-size: 11px; color: var(--dim); }
  .events-log { max-height: 300px; overflow-y: auto; font-family: 'SF Mono', monospace; font-size: 12px; }
  .event-line { padding: 6px 8px; border-bottom: 1px solid var(--border); display: flex; gap: 12px; }
  .event-line .time { color: var(--dim); font-size: 11px; min-width: 70px; }
  .event-line .topic { color: var(--accent); }
  .checks { list-style: none; }
  .checks li { padding: 8px 0; border-bottom: 1px solid var(--border); display: flex; gap: 8px; font-size: 13px; }
  .checks li:last-child { border-bottom: none; }
  .full-width { grid-column: 1 / -1; }
</style>
</head>
<body>
<div class="header">
  <div>⚛</div>
  <h1>SwarmX Dashboard</h1>
  <span class="badge offline" id="statusBadge">Connecting</span>
  <div class="right" id="clock"></div>
</div>
<div class="grid">
  <div class="card">
    <h2>Engine</h2>
    <div id="engineStats"></div>
  </div>
  <div class="card">
    <h2>Usage</h2>
    <div id="usageStats"></div>
  </div>
  <div class="card">
    <h2>Agents</h2>
    <div id="agentsList"></div>
  </div>
  <div class="card">
    <h2>Sessions</h2>
    <div id="sessionStats"></div>
  </div>
  <div class="card full-width">
    <h2>Live Events</h2>
    <div class="events-log" id="eventsLog"></div>
  </div>
</div>
<script>
let ws;
const $ = (id) => document.getElementById(id);
function connect() {
  ws = new WebSocket('ws://127.0.0.1:${wsPort}');
  ws.onopen = () => {
    $('statusBadge').textContent = 'Online';
    $('statusBadge').className = 'badge online';
    ws.send(JSON.stringify({ type: 'event.subscribe', payload: { topics: ['*'] } }));
    refresh();
  };
  ws.onclose = () => { $('statusBadge').textContent = 'Offline'; $('statusBadge').className = 'badge offline'; setTimeout(connect, 3000); };
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'engine.status') renderStatus(data.payload);
    if (data.type === 'event.forward') addEvent(data.payload);
  };
}
function refresh() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'engine.status' }));
}
setInterval(refresh, 5000);
setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString(); }, 1000);

function renderStatus(s) {
  $('engineStats').innerHTML = stat('Status', s.running ? '🟢 Running' : '🔴 Stopped')
    + stat('Providers', s.providers?.length ?? 0)
    + stat('Events Published', s.eventBus?.published ?? 0)
    + stat('Events Dispatched', s.eventBus?.dispatched ?? 0)
    + stat('Scheduler Pending', s.scheduler?.pending ?? 0);

  const u = s.usage || {};
  $('usageStats').innerHTML = stat('Total Calls', u.totalCalls ?? 0)
    + stat('Total Tokens', (u.totalTokens ?? 0).toLocaleString())
    + stat('Total Cost', u.totalCost ?? '$0.0000');

  const agents = Object.entries(s.agents || {});
  $('agentsList').innerHTML = agents.map(([id, a]) =>
    '<div class="agent-row"><div class="dot ' + (a.state || 'created') + '"></div><div class="info"><div class="name">' + a.name + '</div><div class="meta">' + a.provider + ' · ' + (a.contextUsage?.percent ?? 0) + '% ctx · ' + (a.tools?.length ?? 0) + ' tools</div></div></div>'
  ).join('') || '<div style="color:var(--dim);font-size:13px">No agents</div>';

  const ss = s.sessions || {};
  $('sessionStats').innerHTML = stat('Total Sessions', ss.totalSessions ?? 0)
    + stat('Total Messages', ss.totalMessages ?? 0)
    + stat('Estimated Tokens', (ss.estimatedTokens ?? 0).toLocaleString());
}

function stat(label, value) { return '<div class="stat"><span class="label">' + label + '</span><span class="value">' + value + '</span></div>'; }

function addEvent(ev) {
  const log = $('eventsLog');
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = 'event-line';
  line.innerHTML = '<span class="time">' + time + '</span><span class="topic">' + (ev.topic || '') + '</span><span>' + (ev.source || '') + '</span>';
  log.prepend(line);
  while (log.children.length > 100) log.lastChild.remove();
}

connect();
</script>
</body>
</html>`;

export class Dashboard {
    private server: ReturnType<typeof createServer> | null = null;
    private config: Required<DashboardConfig>;

    constructor(private engine: SwarmEngine, config?: DashboardConfig) {
        this.config = {
            port: config?.port ?? 3838,
            host: config?.host ?? "127.0.0.1",
            wsPort: config?.wsPort ?? 18789,
        };
    }

    async start(): Promise<void> {
        this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
            if (req.url === "/api/status") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(this.engine.status()));
                return;
            }

            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(DASHBOARD_HTML(this.config.wsPort));
        });

        await new Promise<void>((resolve) => {
            this.server!.listen(this.config.port, this.config.host, () => {
                log.info(`Dashboard: http://${this.config.host}:${this.config.port}`);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        if (this.server) {
            await new Promise<void>((resolve) => this.server!.close(() => resolve()));
            this.server = null;
        }
    }
}
