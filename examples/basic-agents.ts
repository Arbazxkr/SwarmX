/**
 * Example: Basic multi-agent setup.
 *
 * This example shows how to:
 *   1. Create a SwarmEngine
 *   2. Register providers
 *   3. Add agents with different roles
 *   4. Submit tasks and get coordinated results
 *
 * Usage:
 *   OPENAI_API_KEY=sk-xxx npx tsx examples/basic-agents.ts
 */

import { SwarmEngine } from "../src/index.js";
import { OpenAIProvider } from "../src/providers/openai-provider.js";

async function main() {
    // 1. Create the engine
    const engine = new SwarmEngine();

    // 2. Register providers (bring your own keys)
    engine.registerProvider("openai", new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY!,
        model: "gpt-4o-mini",
    }));

    // 3. Add specialized agents
    engine.addAgent({
        name: "researcher",
        provider: "openai",
        systemPrompt: "You are a research assistant. Find key facts and data about any topic.",
        topics: ["task.created"],
    });

    engine.addAgent({
        name: "writer",
        provider: "openai",
        systemPrompt: "You are a skilled writer. Take research findings and write clear, engaging summaries.",
        topics: ["agent.response.researcher"],
    });

    // 4. Start the engine
    await engine.start();

    // 5. Submit a task — researcher processes first, writer picks up the result
    await engine.submitTask("What are the latest developments in quantum computing?", {
        name: "quantum-research",
    });

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 10_000));

    // 6. Check results
    console.log("\n--- Engine Status ---");
    console.log(JSON.stringify(engine.status(), null, 2));

    // 7. Shutdown
    await engine.stop();
}

main().catch(console.error);
