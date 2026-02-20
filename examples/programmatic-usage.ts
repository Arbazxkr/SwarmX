/**
 * SwarmX Example — Programmatic API Usage
 *
 * Usage: npx tsx examples/programmatic-usage.ts
 */

import { Agent, SwarmEngine, type AgentConfig } from "../src/index.js";
import { type SwarmEvent } from "../src/core/event-bus.js";
import { OpenAIProvider } from "../src/providers/openai-provider.js";

/**
 * Custom agent that logs events before processing.
 */
class LoggingAgent extends Agent {
    async onEvent(event: SwarmEvent): Promise<void> {
        console.log(`[${this.agentId}] Event: ${event.topic}`);
        await super.onEvent(event);
    }
}

async function main(): Promise<void> {
    const engine = new SwarmEngine();

    // Register provider
    const openai = new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY,
        model: "gpt-4o",
    });
    engine.registerProvider("openai", openai);

    // Add agents
    engine.addAgent({
        name: "assistant",
        provider: "openai",
        systemPrompt: "You are a helpful assistant. Be concise.",
        subscriptions: ["task.created"],
    });

    engine.addAgent(
        {
            name: "observer",
            provider: "openai",
            systemPrompt: "You summarize what other agents produce.",
            subscriptions: ["agent.response.*"],
        },
        LoggingAgent,
    );

    await engine.start();
    console.log("Engine started:", engine.status());

    // Submit a task
    const taskId = await engine.submitTask("What are 3 benefits of async programming?");
    console.log(`Task: ${taskId}`);

    // Wait for processing
    await new Promise((r) => setTimeout(r, 5000));

    // Print responses
    for (const event of engine.eventBus.recentEvents(10)) {
        if (event.topic.startsWith("agent.response")) {
            console.log(`\n${event.payload.agentId}:`);
            console.log(event.payload.content);
        }
    }

    await engine.stop();
}

main().catch(console.error);
