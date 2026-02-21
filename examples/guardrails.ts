/**
 * Example: Guardrails — Input/output validation.
 *
 * Shows how to add safety checks to agent interactions:
 *   - Block PII in user messages
 *   - Filter toxic content
 *   - Validate output format
 *
 * Usage:
 *   npx tsx examples/guardrails.ts
 */

import {
    GuardrailRunner,
    maxLengthGuardrail,
    piiGuardrail,
    toxicityGuardrail,
    blockedPatternsGuardrail,
} from "../src/core/guardrails.js";

async function main() {
    // Create guardrail runner with input and output checks
    const guardrails = new GuardrailRunner({
        input: [
            maxLengthGuardrail(5000),
            piiGuardrail(),
            toxicityGuardrail(["harmful", "dangerous"]),
        ],
        output: [
            blockedPatternsGuardrail([/make a bomb/i, /hack into/i]),
            maxLengthGuardrail(10000),
        ],
    });

    // Test 1: Clean message — should pass
    console.log("--- Test 1: Clean message ---");
    const clean = await guardrails.checkInput("What is quantum computing?");
    console.log(`Passed: ${clean.passed}`);
    console.log(`Reports:`, clean.reports);

    // Test 2: Message with PII — should block
    console.log("\n--- Test 2: PII detected ---");
    const pii = await guardrails.checkInput("My email is john@example.com and SSN is 123-45-6789");
    console.log(`Passed: ${pii.passed}`);
    console.log(`Reports:`, pii.reports);

    // Test 3: Output with blocked pattern — should block
    console.log("\n--- Test 3: Blocked output ---");
    const blocked = await guardrails.checkOutput("Here's how to hack into a system...");
    console.log(`Passed: ${blocked.passed}`);
    console.log(`Reports:`, blocked.reports);

    // Test 4: Custom guardrail
    console.log("\n--- Test 4: Custom guardrail ---");
    guardrails.addInput({
        name: "no-yelling",
        check: (content) => ({
            passed: content !== content.toUpperCase() || content.length < 10,
            message: "Please don't yell!",
        }),
        blocking: false, // Just warn, don't block
    });

    const yelling = await guardrails.checkInput("THIS IS ALL CAPS MESSAGE");
    console.log(`Passed: ${yelling.passed}`);
    console.log(`Reports:`, yelling.reports);
}

main().catch(console.error);
