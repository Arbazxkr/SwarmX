/**
 * Example: Link Understanding.
 *
 * Shows how Groklets auto-detects URLs in messages,
 * fetches their content, and enriches the agent context.
 *
 * Usage:
 *   npx tsx examples/link-understanding.ts
 */

import {
    extractLinksFromMessage,
    applyLinkUnderstanding,
    enrichMessagesWithLinks,
} from "../src/index.js";

async function main() {
    // 1. Extract links from a message
    console.log("--- Extract Links ---");
    const links = extractLinksFromMessage(
        "Check out https://github.com/Arbazxkr/Groklets and also https://nodejs.org"
    );
    console.log("Found links:", links);

    // 2. SSRF protection — private IPs are blocked
    console.log("\n--- SSRF Protection ---");
    const blocked = extractLinksFromMessage("Visit http://192.168.1.1/admin");
    console.log("Blocked (private IP):", blocked.length === 0 ? "✅ Blocked" : "❌ Allowed");

    // 3. Apply link understanding — fetch content and enrich message
    console.log("\n--- Fetch & Enrich ---");
    const result = await applyLinkUnderstanding(
        "Summarize this page: https://github.com/Arbazxkr/Groklets",
        { maxLinks: 1, timeoutSeconds: 10 },
    );
    console.log(`URLs found: ${result.urls.length}`);
    console.log(`Content fetched: ${result.outputs.length > 0 ? "✅" : "❌"}`);
    console.log(`Enriched content length: ${result.enrichedContent.length} chars`);
    console.log(`First 200 chars: ${result.enrichedContent.slice(0, 200)}...`);

    // 4. Message middleware — enrich a full conversation
    console.log("\n--- Message Middleware ---");
    const messages = await enrichMessagesWithLinks([
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What does this page say? https://nodejs.org" },
    ]);
    console.log(`Messages enriched: ${messages.length}`);
    for (const msg of messages) {
        const preview = typeof msg.content === "string" ? msg.content.slice(0, 100) : "";
        console.log(`  [${msg.role}] ${preview}...`);
    }
}

main().catch(console.error);
