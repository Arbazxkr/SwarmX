/**
 * SwarmX Browser Control — CDP (Chrome DevTools Protocol) automation.
 *
 * Provides tools for agents to control a headless Chrome browser:
 *   - navigate(url)
 *   - screenshot()
 *   - getPageContent()
 *   - click(selector)
 *   - type(selector, text)
 *   - evaluate(script)
 */

import { type ToolFunction } from "../core/tool-executor.js";
import { type ToolDefinition } from "../core/provider.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Browser");

interface CDPSession {
    send: (method: string, params?: Record<string, unknown>) => Promise<any>;
    on: (event: string, handler: (params: any) => void) => void;
}

export interface BrowserConfig {
    /** Chrome/Chromium executable path */
    executablePath?: string;
    /** Run headless */
    headless?: boolean;
    /** Viewport width */
    width?: number;
    /** Viewport height */
    height?: number;
    /** User data directory */
    userDataDir?: string;
}

/**
 * Browser controller using raw CDP over child_process.
 * No puppeteer/playwright dependency — uses Chrome's built-in debugging port.
 */
export class BrowserController {
    private process: any = null;
    private ws: any = null;
    private cdp: CDPSession | null = null;
    private config: BrowserConfig;
    private messageId = 0;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

    constructor(config?: BrowserConfig) {
        this.config = {
            headless: true,
            width: 1280,
            height: 720,
            ...config,
        };
    }

    async launch(): Promise<void> {
        const { spawn } = await import("node:child_process");
        const { WebSocket } = await import("ws");

        const chromePath = this.config.executablePath ?? this.findChrome();
        const args = [
            `--remote-debugging-port=9222`,
            `--window-size=${this.config.width},${this.config.height}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
        ];
        if (this.config.headless) args.push("--headless=new");
        if (this.config.userDataDir) args.push(`--user-data-dir=${this.config.userDataDir}`);

        this.process = spawn(chromePath, args, { stdio: "pipe" });

        // Wait for CDP to be ready
        await new Promise<void>((resolve) => setTimeout(resolve, 2000));

        // Get WebSocket URL
        const http = await import("node:http");
        const wsUrl = await new Promise<string>((resolve, reject) => {
            http.get("http://127.0.0.1:9222/json/version", (res) => {
                let data = "";
                res.on("data", (chunk) => data += chunk);
                res.on("end", () => {
                    const info = JSON.parse(data);
                    resolve(info.webSocketDebuggerUrl);
                });
            }).on("error", reject);
        });

        // Connect CDP WebSocket
        this.ws = new WebSocket(wsUrl);
        await new Promise<void>((resolve) => this.ws.on("open", resolve));

        this.ws.on("message", (data: Buffer) => {
            const msg = JSON.parse(data.toString());
            if (msg.id && this.pending.has(msg.id)) {
                const p = this.pending.get(msg.id)!;
                this.pending.delete(msg.id);
                if (msg.error) p.reject(new Error(msg.error.message));
                else p.resolve(msg.result);
            }
        });

        // Enable necessary domains
        await this.send("Page.enable");
        await this.send("Runtime.enable");
        await this.send("DOM.enable");

        log.info("Browser launched (CDP connected)");
    }

    async close(): Promise<void> {
        if (this.ws) { this.ws.close(); this.ws = null; }
        if (this.process) { this.process.kill(); this.process = null; }
        log.info("Browser closed");
    }

    private send(method: string, params?: Record<string, unknown>): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = ++this.messageId;
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    private findChrome(): string {
        const paths = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium-browser",
            "/usr/bin/chromium",
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        ];
        const { existsSync } = require("node:fs");
        for (const p of paths) {
            if (existsSync(p)) return p;
        }
        throw new Error("Chrome not found. Set executablePath in BrowserConfig.");
    }

    // ── Browser Actions ─────────────────────────────────────────

    async navigate(url: string): Promise<string> {
        await this.send("Page.navigate", { url });
        await this.send("Page.loadEventFired");
        await new Promise((r) => setTimeout(r, 1000)); // Wait for dynamic content
        return `Navigated to ${url}`;
    }

    async screenshot(): Promise<string> {
        const result = await this.send("Page.captureScreenshot", { format: "png" });
        return result.data; // base64
    }

    async getPageContent(): Promise<string> {
        const result = await this.send("Runtime.evaluate", {
            expression: "document.body.innerText",
            returnByValue: true,
        });
        return result.result.value ?? "";
    }

    async getPageHTML(): Promise<string> {
        const result = await this.send("Runtime.evaluate", {
            expression: "document.documentElement.outerHTML",
            returnByValue: true,
        });
        return result.result.value ?? "";
    }

    async click(selector: string): Promise<string> {
        await this.send("Runtime.evaluate", {
            expression: `document.querySelector('${selector}')?.click()`,
        });
        return `Clicked: ${selector}`;
    }

    async type(selector: string, text: string): Promise<string> {
        await this.send("Runtime.evaluate", {
            expression: `(() => { const el = document.querySelector('${selector}'); if(el) { el.focus(); el.value = '${text.replace(/'/g, "\\'")}'; el.dispatchEvent(new Event('input', {bubbles:true})); } })()`,
        });
        return `Typed into ${selector}`;
    }

    async evaluate(script: string): Promise<string> {
        const result = await this.send("Runtime.evaluate", {
            expression: script,
            returnByValue: true,
        });
        return JSON.stringify(result.result.value ?? result.result);
    }

    // ── Tool Definitions for Agent Use ──────────────────────────

    getToolDefinitions(): ToolDefinition[] {
        return [
            { type: "function", function: { name: "browser_navigate", description: "Navigate the browser to a URL", parameters: { type: "object", properties: { url: { type: "string", description: "URL to navigate to" } }, required: ["url"] } } },
            { type: "function", function: { name: "browser_screenshot", description: "Take a screenshot of the current page (returns base64 PNG)", parameters: { type: "object", properties: {} } } },
            { type: "function", function: { name: "browser_get_content", description: "Get the text content of the current page", parameters: { type: "object", properties: {} } } },
            { type: "function", function: { name: "browser_click", description: "Click an element by CSS selector", parameters: { type: "object", properties: { selector: { type: "string", description: "CSS selector" } }, required: ["selector"] } } },
            { type: "function", function: { name: "browser_type", description: "Type text into an input element", parameters: { type: "object", properties: { selector: { type: "string", description: "CSS selector" }, text: { type: "string", description: "Text to type" } }, required: ["selector", "text"] } } },
            { type: "function", function: { name: "browser_evaluate", description: "Execute JavaScript in the browser and return the result", parameters: { type: "object", properties: { script: { type: "string", description: "JavaScript code to evaluate" } }, required: ["script"] } } },
        ];
    }

    getToolFunctions(): Record<string, ToolFunction> {
        return {
            browser_navigate: async (args) => this.navigate(args.url as string),
            browser_screenshot: async () => this.screenshot(),
            browser_get_content: async () => this.getPageContent(),
            browser_click: async (args) => this.click(args.selector as string),
            browser_type: async (args) => this.type(args.selector as string, args.text as string),
            browser_evaluate: async (args) => this.evaluate(args.script as string),
        };
    }

    /**
     * Register all browser tools with an agent.
     */
    registerWithAgent(agent: { registerTool: (name: string, desc: string, params: Record<string, unknown>, fn: ToolFunction) => void }): void {
        const defs = this.getToolDefinitions();
        const fns = this.getToolFunctions();

        for (const def of defs) {
            const name = def.function.name;
            agent.registerTool(name, def.function.description ?? "", def.function.parameters ?? {}, fns[name]);
        }

        log.info("Browser tools registered with agent");
    }
}
