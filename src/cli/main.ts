#!/usr/bin/env node

/**
 * Groklets CLI — Production-grade CLI for managing and running swarms.
 */

import { Command } from "commander";
import chalk from "chalk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { loadConfig, loadAndBuild, resolveEnvVars } from "../utils/config.js";
import { VERSION } from "../index.js";

const program = new Command();

// ── Helpers ───────────────────────────────────────────────────

function banner(): void {
    console.log("");
    console.log(chalk.cyan("  ⚛  ") + chalk.bold.white("Groklets") + chalk.dim(` v${VERSION}`));
    console.log(chalk.dim("  Multi-Agent Orchestration Framework"));
    console.log(chalk.dim("  ─".repeat(22)));
    console.log("");
}

function table(title: string, headers: string[], rows: string[][]): void {
    console.log(chalk.bold.cyan(`  ${title}`));
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
    console.log(`  ${headers.map((h, i) => chalk.dim(h.padEnd(widths[i]))).join("  ")}`);
    console.log(`  ${widths.map((w) => chalk.dim("─".repeat(w))).join("  ")}`);
    for (const row of rows) {
        console.log(`  ${row.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ")}`);
    }
    console.log("");
}

function success(msg: string): void { console.log(chalk.green(`  ✓ ${msg}`)); }
function warn(msg: string): void { console.log(chalk.yellow(`  ⚠ ${msg}`)); }
function fail(msg: string): void { console.log(chalk.red(`  ✗ ${msg}`)); }

// ── CLI Setup ─────────────────────────────────────────────────

program
    .name("groklets")
    .description("⚛ Groklets — Multi-Agent Orchestration Framework")
    .version(VERSION);

// ── Run ───────────────────────────────────────────────────────

program
    .command("run")
    .description("Run a swarm from a YAML configuration file")
    .argument("<config>", "Path to the swarm YAML config")
    .option("-t, --task <task>", "Submit a task immediately after starting")
    .option("-i, --interactive", "Enter interactive mode")
    .option("-l, --log-level <level>", "Log level (debug, info, warn, error)", "info")
    .action(async (configFile: string, opts: { task?: string; interactive?: boolean; logLevel?: string }) => {
        banner();

        if (opts.logLevel) process.env.Groklets_LOG_LEVEL = opts.logLevel;

        let engine;
        try {
            engine = loadAndBuild(configFile);
        } catch (err) {
            fail(`Config error: ${(err as Error).message}`);
            process.exit(1);
        }

        await engine.start();
        success("Swarm started\n");

        // Status table
        const status = engine.status();
        const agents = Object.entries(status.agents as Record<string, any>);
        table("Agents", ["Name", "Provider", "State"], agents.map(([_, a]) => [a.name, a.provider, a.state]));

        // Initial task
        if (opts.task) {
            console.log(chalk.cyan(`  Submitting: ${opts.task}`));
            const taskId = await engine.submitTask(opts.task);
            success(`Task: ${taskId}`);
            await new Promise((r) => setTimeout(r, 3000));

            // Show responses
            showResponses(engine);
        }

        // Interactive mode
        if (opts.interactive || !opts.task) {
            await interactiveLoop(engine);
        }

        await engine.stop();
    });

function showResponses(engine: any): void {
    const recent = engine.eventBus.recentEvents(20);
    for (const event of recent) {
        if (event.topic.startsWith("agent.response")) {
            const name = event.topic.split(".").pop();
            console.log(`\n  ${chalk.bold.cyan(name)}:`);
            console.log(`  ${(event.payload.content as string).split("\n").join("\n  ")}`);
        }
    }
}

async function interactiveLoop(engine: any): Promise<void> {
    console.log(chalk.dim("  Type a task and press Enter. /help for commands.\n"));

    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: chalk.cyan("  ⚛ > ") });
    rl.prompt();

    for await (const line of rl) {
        const input = line.trim();
        if (!input) { rl.prompt(); continue; }

        if (input === "/quit" || input === "/exit") { rl.close(); return; }

        if (input === "/help") {
            console.log(chalk.dim("\n  Commands:"));
            console.log(chalk.dim("    /status   — Show engine status"));
            console.log(chalk.dim("    /agents   — List agents"));
            console.log(chalk.dim("    /events   — Recent events"));
            console.log(chalk.dim("    /clear    — Clear screen"));
            console.log(chalk.dim("    /quit     — Exit\n"));
            rl.prompt(); continue;
        }

        if (input === "/status") {
            const s = engine.status();
            const bus = s.eventBus as any;
            console.log(`\n  ${chalk.bold("Status:")} ${s.running ? chalk.green("running") : chalk.red("stopped")}`);
            console.log(`  Events: ${bus.published} published, ${bus.dispatched} dispatched, ${bus.errors} errors`);
            console.log(`  Scheduler: ${(s.scheduler as any).pending} pending, ${(s.scheduler as any).running} running\n`);
            rl.prompt(); continue;
        }

        if (input === "/agents") {
            const agents = engine.allAgents as Map<string, any>;
            table("Agents", ["ID", "Name", "Provider", "State"],
                [...agents.entries()].map(([id, a]: [string, any]) => [id.slice(0, 20), a.config.name, a.config.provider, a.state]));
            rl.prompt(); continue;
        }

        if (input === "/events") {
            const events = engine.eventBus.recentEvents(10);
            if (events.length === 0) { console.log(chalk.dim("  No events yet.\n")); }
            else { table("Events", ["ID", "Topic", "Source"], events.map((e: any) => [e.eventId, e.topic, e.source])); }
            rl.prompt(); continue;
        }

        if (input === "/clear") { console.clear(); banner(); rl.prompt(); continue; }

        if (input.startsWith("/")) { warn(`Unknown command: ${input}`); rl.prompt(); continue; }

        // Submit task
        const taskId = await engine.submitTask(input);
        console.log(chalk.dim(`  Task: ${taskId}`));

        process.stdout.write(chalk.dim("  Thinking..."));
        await new Promise((r) => setTimeout(r, 2000));
        process.stdout.write("\r" + " ".repeat(30) + "\r");

        showResponses(engine);
        console.log("");
        rl.prompt();
    }
}

// ── Validate ──────────────────────────────────────────────────

program
    .command("validate")
    .description("Validate a swarm configuration file")
    .argument("<config>", "Path to the swarm YAML config")
    .action((configFile: string) => {
        try {
            const config = loadConfig(configFile);
            const swarm = config.swarm;
            const issues: string[] = [];

            if (!swarm.providers || Object.keys(swarm.providers).length === 0) issues.push("No providers defined");
            if (!swarm.agents || Object.keys(swarm.agents).length === 0) issues.push("No agents defined");

            const providerNames = new Set(Object.keys(swarm.providers ?? {}));
            for (const [name, def] of Object.entries(swarm.agents ?? {})) {
                const p = (def as any).provider as string;
                if (p && !providerNames.has(p)) issues.push(`Agent '${name}' → unknown provider '${p}'`);
            }

            // Check API keys
            for (const [name, def] of Object.entries(swarm.providers ?? {})) {
                const key = resolveEnvVars((def as any).api_key ?? "");
                if (!key) issues.push(`Provider '${name}' has no API key`);
            }

            if (issues.length > 0) {
                issues.forEach((i) => fail(i));
                process.exit(1);
            } else {
                success("Configuration is valid");
                console.log(chalk.dim(`  ${Object.keys(swarm.providers ?? {}).length} providers, ${Object.keys(swarm.agents ?? {}).length} agents`));
            }
        } catch (err) {
            fail((err as Error).message);
            process.exit(1);
        }
    });

// ── Status ────────────────────────────────────────────────────

program
    .command("status")
    .description("Show swarm configuration details")
    .argument("<config>", "Path to the swarm YAML config")
    .action((configFile: string) => {
        try {
            const config = loadConfig(configFile);
            const swarm = config.swarm;

            banner();
            console.log(chalk.bold(`  ${swarm.name ?? "Unnamed Swarm"}`));
            console.log("");

            table("Providers", ["Name", "Type", "Model"],
                Object.entries(swarm.providers ?? {}).map(([n, d]) => [n, (d as any).type ?? n, (d as any).model ?? "default"]));

            table("Agents", ["Name", "Provider", "Subscriptions"],
                Object.entries(swarm.agents ?? {}).map(([n, d]) => [n, (d as any).provider ?? "", ((d as any).subscriptions ?? []).join(", ")]));
        } catch (err) {
            fail((err as Error).message);
            process.exit(1);
        }
    });

// ── Init ──────────────────────────────────────────────────────

program
    .command("init")
    .description("Scaffold a new Groklets project")
    .option("-n, --name <name>", "Project name", "my-swarm")
    .option("-p, --provider <provider>", "Default provider", "openai")
    .action((opts: { name: string; provider: string }) => {
        banner();

        const dir = opts.name;
        const configPath = `${dir}/swarm.yaml`;
        const envPath = `${dir}/.env`;

        if (existsSync(dir)) {
            warn(`Directory '${dir}' already exists`);
            return;
        }

        mkdirSync(dir, { recursive: true });

        const envVars: Record<string, string> = {
            openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY",
            google: "GOOGLE_API_KEY", xai: "XAI_API_KEY",
        };
        const models: Record<string, string> = {
            openai: "gpt-4o", anthropic: "claude-sonnet-4-20250514",
            google: "gemini-2.0-flash", xai: "grok-2-latest",
        };

        const envVar = envVars[opts.provider] ?? `${opts.provider.toUpperCase()}_API_KEY`;
        const model = models[opts.provider] ?? "";

        writeFileSync(configPath, `swarm:
  name: "${opts.name}"

  providers:
    ${opts.provider}:
      type: ${opts.provider}
      api_key: \${${envVar}}
      model: ${model}
      temperature: 0.7
      max_tokens: 4096

  agents:
    coordinator:
      provider: ${opts.provider}
      system_prompt: |
        You are the coordinator agent. You receive tasks, break them down,
        and coordinate with other agents to accomplish goals.
      subscriptions:
        - task.created
        - agent.response.*

    researcher:
      provider: ${opts.provider}
      system_prompt: |
        You are a research agent. Analyze information, find patterns,
        and provide detailed insights.
      subscriptions:
        - research.*
        - task.created

    writer:
      provider: ${opts.provider}
      system_prompt: |
        You are a writing agent. Take research and analysis and produce
        clear, well-structured output.
      subscriptions:
        - writing.*
        - task.created
`);

        writeFileSync(envPath, `# Groklets Environment\n${envVar}=your-key-here\n`);
        writeFileSync(`${dir}/.gitignore`, `.env\nnode_modules/\n`);

        success(`Created project: ${dir}/`);
        console.log(chalk.dim(`  ${configPath}`));
        console.log(chalk.dim(`  ${envPath}`));
        console.log(chalk.dim(`  ${dir}/.gitignore`));
        console.log("");
        console.log(chalk.dim("  Next steps:"));
        console.log(`  1. ${chalk.cyan(`cd ${dir}`)}`);
        console.log(`  2. Edit ${chalk.cyan(".env")} with your API key`);
        console.log(`  3. ${chalk.cyan("groklets run swarm.yaml --interactive")}`);
        console.log("");
    });

// ── Onboard ───────────────────────────────────────────────────

program
    .command("onboard")
    .description("Interactive setup wizard for new users")
    .action(async () => {
        banner();
        console.log(chalk.bold("  Welcome to Groklets! Let's get you set up.\n"));

        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const ask = (q: string): Promise<string> => new Promise((res) => rl.question(chalk.cyan(`  ${q} `), res));

        // Project name
        const name = (await ask("Project name [my-swarm]:")).trim() || "my-swarm";

        // Provider selection
        console.log(chalk.dim("\n  Available providers:"));
        console.log("    1. OpenAI (GPT-4o)");
        console.log("    2. Anthropic (Claude)");
        console.log("    3. Google (Gemini)");
        console.log("    4. xAI (Grok)");
        const providerChoice = (await ask("\n  Provider [1]:")).trim() || "1";
        const providerMap: Record<string, string> = { "1": "openai", "2": "anthropic", "3": "google", "4": "xai" };
        const provider = providerMap[providerChoice] ?? "openai";

        // API key
        const envVars: Record<string, string> = {
            openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY",
            google: "GOOGLE_API_KEY", xai: "XAI_API_KEY",
        };
        const envVar = envVars[provider];
        const existingKey = process.env[envVar];

        let apiKey = "";
        if (existingKey) {
            console.log(chalk.green(`\n  ✓ Found ${envVar} in environment`));
        } else {
            apiKey = (await ask(`\n  ${envVar}:`)).trim();
        }

        rl.close();

        // Create project
        const dir = name;
        if (existsSync(dir)) {
            warn(`Directory '${dir}' already exists, using it.`);
        } else {
            mkdirSync(dir, { recursive: true });
        }

        const models: Record<string, string> = {
            openai: "gpt-4o", anthropic: "claude-sonnet-4-20250514",
            google: "gemini-2.0-flash", xai: "grok-2-latest",
        };

        writeFileSync(`${dir}/swarm.yaml`, `swarm:
  name: "${name}"

  providers:
    ${provider}:
      type: ${provider}
      api_key: \${${envVar}}
      model: ${models[provider]}
      temperature: 0.7

  agents:
    coordinator:
      provider: ${provider}
      system_prompt: |
        You are the coordinator. Break down incoming tasks,
        delegate as needed, and synthesize results.
      subscriptions:
        - task.created
        - agent.response.*

    analyst:
      provider: ${provider}
      system_prompt: |
        You are an analyst. Provide data-driven insights
        and thorough analysis of topics presented.
      subscriptions:
        - task.created
`);

        writeFileSync(`${dir}/.env`, `${envVar}=${apiKey || "your-key-here"}\n`);
        writeFileSync(`${dir}/.gitignore`, `.env\nnode_modules/\n`);

        console.log("");
        success(`Project created: ${dir}/`);
        console.log("");
        console.log(chalk.bold("  Run your swarm:"));
        console.log(chalk.cyan(`    cd ${dir} && groklets run swarm.yaml -i`));
        console.log("");
    });

// ── Gateway ───────────────────────────────────────────────────

program
    .command("gateway")
    .description("Start the WebSocket Gateway control plane")
    .argument("<config>", "Path to the swarm YAML config")
    .option("-p, --port <port>", "Gateway port", "18789")
    .option("--host <host>", "Gateway host", "127.0.0.1")
    .option("--auth <token>", "Auth token for clients")
    .option("-l, --log-level <level>", "Log level", "info")
    .action(async (configFile: string, opts: { port: string; host: string; auth?: string; logLevel?: string }) => {
        banner();

        if (opts.logLevel) process.env.Groklets_LOG_LEVEL = opts.logLevel;

        let engine;
        try {
            engine = loadAndBuild(configFile);
        } catch (err) {
            fail(`Config error: ${(err as Error).message}`);
            process.exit(1);
        }

        // Import Gateway dynamically to avoid requiring ws at CLI parse time
        const { Gateway } = await import("../core/gateway.js");
        const gateway = new Gateway(engine, {
            port: parseInt(opts.port),
            host: opts.host,
            authToken: opts.auth,
        });

        await engine.start();
        await gateway.start();

        success(`Swarm started`);
        success(`Gateway running on ws://${opts.host}:${opts.port}`);
        if (opts.auth) success(`Auth required: token set`);
        console.log("");

        const status = engine.status();
        const agents = Object.entries(status.agents as Record<string, any>);
        table("Agents", ["Name", "Provider", "State"], agents.map(([_, a]) => [a.name, a.provider, a.state]));

        console.log(chalk.dim("  Gateway is running. Press Ctrl+C to stop.\n"));

        // Keep alive
        await new Promise(() => { });
    });

// ── Doctor ─────────────────────────────────────────────────────

program
    .command("doctor")
    .description("Run full system diagnostics")
    .argument("<config>", "Path to the swarm YAML config")
    .action(async (configFile: string) => {
        banner();

        let engine;
        try {
            engine = loadAndBuild(configFile);
        } catch (err) {
            fail(`Config error: ${(err as Error).message}`);
            process.exit(1);
        }

        await engine.start();
        const checks = await engine.doctor();
        await engine.stop();

        console.log(chalk.bold("  System Diagnostics\n"));

        for (const check of checks) {
            const icon = check.status === "pass" ? chalk.green("✓") : check.status === "warn" ? chalk.yellow("⚠") : chalk.red("✗");
            console.log(`  ${icon} ${check.check.padEnd(25)} ${chalk.dim(check.detail)}`);
        }

        const passed = checks.filter((c) => c.status === "pass").length;
        const warnings = checks.filter((c) => c.status === "warn").length;
        const failed = checks.filter((c) => c.status === "fail").length;

        console.log("");
        console.log(`  ${chalk.bold("Result:")} ${chalk.green(`${passed} passed`)}, ${chalk.yellow(`${warnings} warnings`)}, ${chalk.red(`${failed} failed`)}`);
        console.log("");
    });

// ── Health ────────────────────────────────────────────────────

program
    .command("health")
    .description("Check provider connectivity and API key validity")
    .argument("<config>", "Path to the swarm YAML config")
    .action(async (configFile: string) => {
        banner();

        let engine;
        try {
            engine = loadAndBuild(configFile);
        } catch (err) {
            fail((err as Error).message);
            process.exit(1);
        }

        console.log(chalk.bold("  Provider Health Check\n"));

        for (const name of engine.providerRegistry.available) {
            process.stdout.write(`  ${name.padEnd(15)}`);
            try {
                const provider = engine.providerRegistry.get(name);
                if (provider.healthCheck) {
                    const ok = await provider.healthCheck();
                    if (ok) console.log(chalk.green("✓ connected"));
                    else console.log(chalk.red("✗ unreachable"));
                } else {
                    console.log(chalk.yellow("? no health check"));
                }
            } catch (err) {
                console.log(chalk.red(`✗ ${(err as Error).message}`));
            }
        }
        console.log("");
    });

// ── Parse ─────────────────────────────────────────────────────

program.parse();
