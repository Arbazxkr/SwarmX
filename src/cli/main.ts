#!/usr/bin/env node

/**
 * SwarmX CLI — Command-line interface for managing and running swarms.
 *
 * Provides commands to:
 *   - Run a swarm from a YAML config
 *   - Submit tasks interactively
 *   - Validate configurations
 *   - Initialize new swarm projects
 *   - Check swarm status
 *
 * Inspired by OpenClaw's CLI-first approach.
 */

import { Command } from "commander";
import chalk from "chalk";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { loadConfig, loadAndBuild } from "../utils/config.js";
import { VERSION } from "../index.js";

const program = new Command();

// ── Helpers ───────────────────────────────────────────────────

function printBanner(): void {
    const border = chalk.cyan("─".repeat(48));
    console.log(border);
    console.log(
        `  ${chalk.bold.cyan("⚛ SwarmX")} ${chalk.dim(`v${VERSION}`)} ${chalk.white("— Multi-Agent Orchestration")}`,
    );
    console.log(border);
}

function printTable(title: string, headers: string[], rows: string[][]): void {
    console.log(`\n${chalk.bold.cyan(title)}`);

    // Calculate column widths
    const widths = headers.map((h, i) =>
        Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
    );

    // Header
    const headerLine = headers.map((h, i) => chalk.bold(h.padEnd(widths[i]))).join("  ");
    console.log(`  ${headerLine}`);
    console.log(`  ${widths.map((w) => "─".repeat(w)).join("  ")}`);

    // Rows
    for (const row of rows) {
        const line = row.map((cell, i) => (cell ?? "").padEnd(widths[i])).join("  ");
        console.log(`  ${line}`);
    }
}

// ── CLI Setup ─────────────────────────────────────────────────

program
    .name("swarmx")
    .description("⚛ SwarmX — Multi-Agent Orchestration Framework")
    .version(VERSION);

// ── Run Command ───────────────────────────────────────────────

program
    .command("run")
    .description("Run a swarm from a YAML configuration file")
    .argument("<config>", "Path to the swarm YAML config file")
    .option("-t, --task <task>", "Task to submit immediately after starting")
    .option("-i, --interactive", "Enter interactive mode after starting")
    .action(async (configFile: string, opts: { task?: string; interactive?: boolean }) => {
        printBanner();

        let engine;
        try {
            engine = loadAndBuild(configFile);
        } catch (err) {
            console.error(chalk.red("Error loading config:"), (err as Error).message);
            process.exit(1);
        }

        await engine.start();
        console.log(chalk.green("\n✅ Swarm started\n"));

        // Print status
        const status = engine.status();
        const agentEntries = Object.entries(status.agents as Record<string, any>);
        printTable(
            "Agents",
            ["ID", "Name", "Provider", "State"],
            agentEntries.map(([id, a]) => [
                id.slice(0, 20),
                a.name,
                a.provider,
                a.state,
            ]),
        );

        console.log(
            `\n  ${chalk.dim("Providers:")} ${(status.providers as string[]).join(", ")}`,
        );

        // Submit initial task
        if (opts.task) {
            console.log(`\n${chalk.cyan("Submitting task:")} ${opts.task}`);
            const taskId = await engine.submitTask(opts.task);
            console.log(`${chalk.green("Task submitted:")} ${taskId}`);
            await new Promise((r) => setTimeout(r, 3000));
        }

        // Interactive mode
        if (opts.interactive || !opts.task) {
            await interactiveLoop(engine);
        }

        await engine.stop();
        console.log(chalk.yellow("\nSwarm stopped."));
    });

async function interactiveLoop(engine: any): Promise<void> {
    console.log(
        chalk.dim(
            "\nInteractive mode. Type a task and press Enter.\nCommands: /status, /agents, /events, /quit\n",
        ),
    );

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: chalk.cyan("⚛ > "),
    });

    rl.prompt();

    for await (const line of rl) {
        const input = line.trim();
        if (!input) {
            rl.prompt();
            continue;
        }

        if (input === "/quit") {
            rl.close();
            return;
        }

        if (input === "/status") {
            const status = engine.status();
            console.log(chalk.bold("\nStatus:"));
            console.log(`  Running: ${status.running ? chalk.green("yes") : chalk.red("no")}`);
            const bus = status.eventBus as any;
            console.log(
                `  Events: Published=${bus.published} Dispatched=${bus.dispatched} Errors=${bus.errors}`,
            );
            const sched = status.scheduler as any;
            console.log(`  Scheduler: Pending=${sched.pending} Running=${sched.running}`);
            rl.prompt();
            continue;
        }

        if (input === "/agents") {
            const agents = engine.allAgents as Map<string, any>;
            const rows = [...agents.entries()].map(([id, a]: [string, any]) => [
                id.slice(0, 20),
                a.config.name,
                a.config.provider,
                a.state,
            ]);
            printTable("Agents", ["ID", "Name", "Provider", "State"], rows);
            rl.prompt();
            continue;
        }

        if (input === "/events") {
            const events = engine.eventBus.recentEvents(10);
            if (events.length === 0) {
                console.log(chalk.dim("  No events recorded yet."));
            } else {
                const rows = events.map((e: any) => [
                    e.eventId,
                    e.topic,
                    e.source,
                    JSON.stringify(e.payload).slice(0, 50),
                ]);
                printTable("Recent Events", ["ID", "Topic", "Source", "Payload"], rows);
            }
            rl.prompt();
            continue;
        }

        if (input.startsWith("/")) {
            console.log(chalk.red(`Unknown command: ${input}`));
            rl.prompt();
            continue;
        }

        // Submit as task
        const taskId = await engine.submitTask(input);
        console.log(`${chalk.green("Task submitted:")} ${taskId}`);

        // Wait for agents to process
        await new Promise((r) => setTimeout(r, 2000));

        // Show agent responses
        const recent = engine.eventBus.recentEvents(10);
        for (const event of recent) {
            if (event.topic.startsWith("agent.response")) {
                const content = event.payload.content as string;
                const agentId = event.payload.agentId as string;
                console.log(`\n${chalk.bold.cyan(agentId)}:`);
                console.log(content);
            }
        }

        rl.prompt();
    }
}

// ── Validate Command ──────────────────────────────────────────

program
    .command("validate")
    .description("Validate a swarm configuration file")
    .argument("<config>", "Path to the swarm YAML config file")
    .action((configFile: string) => {
        try {
            const config = loadConfig(configFile);
            const swarm = config.swarm;
            const issues: string[] = [];

            if (!swarm.providers || Object.keys(swarm.providers).length === 0) {
                issues.push("Missing 'providers' section");
            }
            if (!swarm.agents || Object.keys(swarm.agents).length === 0) {
                issues.push("Missing 'agents' section");
            }

            // Check agent-provider bindings
            const providerNames = new Set(Object.keys(swarm.providers ?? {}));
            for (const [agentName, agentDef] of Object.entries(swarm.agents ?? {})) {
                const provider = (agentDef as any).provider as string;
                if (provider && !providerNames.has(provider)) {
                    issues.push(`Agent '${agentName}' references unknown provider '${provider}'`);
                }
            }

            if (issues.length > 0) {
                console.log(chalk.red("Validation issues:"));
                issues.forEach((i) => console.log(`  ❌ ${i}`));
                process.exit(1);
            } else {
                console.log(chalk.green("✅ Configuration is valid!"));
                console.log(`  Providers: ${Object.keys(swarm.providers ?? {}).length}`);
                console.log(`  Agents: ${Object.keys(swarm.agents ?? {}).length}`);
            }
        } catch (err) {
            console.error(chalk.red("Error:"), (err as Error).message);
            process.exit(1);
        }
    });

// ── Status Command ────────────────────────────────────────────

program
    .command("status")
    .description("Show the status of a swarm configuration")
    .argument("<config>", "Path to the swarm YAML config file")
    .action((configFile: string) => {
        try {
            const config = loadConfig(configFile);
            const swarm = config.swarm;

            console.log(`\n${chalk.bold.cyan("Swarm:")} ${swarm.name ?? "unnamed"}`);

            // Providers
            const providers = swarm.providers ?? {};
            printTable(
                "Providers",
                ["Name", "Type", "Model"],
                Object.entries(providers).map(([name, def]) => [
                    name,
                    (def as any).type ?? name,
                    (def as any).model ?? "default",
                ]),
            );

            // Agents
            const agents = swarm.agents ?? {};
            printTable(
                "Agents",
                ["Name", "Provider", "Subscriptions"],
                Object.entries(agents).map(([name, def]) => [
                    name,
                    (def as any).provider ?? "",
                    ((def as any).subscriptions ?? []).join(", "),
                ]),
            );
        } catch (err) {
            console.error(chalk.red("Error:"), (err as Error).message);
            process.exit(1);
        }
    });

// ── Init Command ──────────────────────────────────────────────

program
    .command("init")
    .description("Initialize a new SwarmX project with a sample config")
    .option("-n, --name <name>", "Swarm project name", "my-swarm")
    .option("-p, --provider <provider>", "Default provider", "openai")
    .action((opts: { name: string; provider: string }) => {
        printBanner();

        const configPath = `${opts.name}.yaml`;
        if (existsSync(configPath)) {
            console.log(chalk.yellow(`Warning: ${configPath} already exists.`));
            return;
        }

        const envVars: Record<string, string> = {
            openai: "OPENAI_API_KEY",
            anthropic: "ANTHROPIC_API_KEY",
            google: "GOOGLE_API_KEY",
            xai: "XAI_API_KEY",
        };
        const models: Record<string, string> = {
            openai: "gpt-4o",
            anthropic: "claude-sonnet-4-20250514",
            google: "gemini-2.0-flash",
            xai: "grok-2-latest",
        };

        const envVar = envVars[opts.provider] ?? `${opts.provider.toUpperCase()}_API_KEY`;
        const model = models[opts.provider] ?? "";

        const content = `# SwarmX Configuration — ${opts.name}
# Docs: https://github.com/swarmx/swarmx

swarm:
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
        and coordinate with other agents to accomplish goals. Be concise
        and structured in your responses.
      subscriptions:
        - task.created
        - agent.response.*

    researcher:
      provider: ${opts.provider}
      system_prompt: |
        You are a research agent. You analyze information, find patterns,
        and provide detailed insights. Focus on accuracy and depth.
      subscriptions:
        - research.*
        - task.created

    writer:
      provider: ${opts.provider}
      system_prompt: |
        You are a writing agent. You take research and analysis and
        produce clear, well-structured output. Focus on clarity and
        readability.
      subscriptions:
        - writing.*
`;

        writeFileSync(configPath, content);
        console.log(chalk.green(`\n✅ Created: ${configPath}`));
        console.log(chalk.dim("\nSet your API key:"));
        console.log(`  export ${envVar}=your-key-here`);
        console.log(chalk.dim("\nRun your swarm:"));
        console.log(`  swarmx run ${configPath} --interactive`);
    });

// ── Parse & Run ───────────────────────────────────────────────

program.parse();
