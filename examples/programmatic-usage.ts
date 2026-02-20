/**
 * SwarmX Example — Programmatic API Usage (TypeScript)
 *
 * Demonstrates how to use SwarmX programmatically without YAML configs.
 * Useful for embedding SwarmX in larger applications.
 *
 * Usage:
 *   npx tsx examples/programmatic-usage.ts
 */

import { Agent, SwarmEngine, type AgentConfig } from "../src/index.js";
import { type SwarmEvent } from "../src/core/event-bus.js";
import { OpenAIProvider } from "../src/providers/openai-provider.js";

/**
 * Custom agent that logs all events it receives.
 * Demonstrates how to subclass Agent for custom behavior.
 */
class LoggingAgent extends Agent {
    async onEvent(event: SwarmEvent): Promise<void> {
        console.log(`[${this.agentId}] Received event: ${event.topic}`);
        console.log(`  Payload:`, event.payload);

        // Still call the parent handler for LLM processing
        await super.onEvent(event);
    }
}

async function main(): Promise<void> {
    // Create the engine
    const engine = new SwarmEngine();

    // Register a provider
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

    // Add a custom logging agent
    engine.addAgent(
        {
            name: "logger",
            provider: "openai",
            systemPrompt: "You are an observer. Summarize what you see.",
            subscriptions: ["agent.response.*"],
        },
        LoggingAgent,
    );

    // Start the engine
    await engine.start();
    console.log("Engine started!");
    console.log("Status:", engine.status());

    // Submit a task
    const taskId = await engine.submitTask("What are the top 3 benefits of async programming?");
    console.log(`Task submitted: ${taskId}`);

    // Wait for processing
    await new Promise((r) => setTimeout(r, 5000));

    // Check events
    const events = engine.eventBus.recentEvents(10);
    for (const event of events) {
        if (event.topic.startsWith("agent.response")) {
            console.log(`\nResponse from ${event.payload.agentId}:`);
            console.log(event.payload.content);
        }
    }

    // Shutdown
    await engine.stop();
    console.log("\nEngine stopped.");
}

main().catch(console.error);
