# Guardrails

Input and output validation for AI agent safety.

## Overview

Guardrails run before (input) and after (output) every agent interaction:

```
User Message → [INPUT GUARDRAILS] → LLM → [OUTPUT GUARDRAILS] → Response
```

If a blocking guardrail fails, the message is rejected.

## Usage

```typescript
import { GuardrailRunner, piiGuardrail, maxLengthGuardrail, toxicityGuardrail } from "groklets";

const guardrails = new GuardrailRunner({
    input: [
        maxLengthGuardrail(5000),
        piiGuardrail(),
        toxicityGuardrail(["harmful", "dangerous"]),
    ],
    output: [
        maxLengthGuardrail(10000),
    ],
});

// Check input
const result = await guardrails.checkInput("Hello, how are you?");
if (!result.passed) {
    console.log("Blocked:", result.reports);
}

// Check output
const output = await guardrails.checkOutput(llmResponse);
if (!output.passed) {
    console.log("Output blocked:", output.reports);
}
```

## Built-in Guardrails

| Guardrail | What it does |
|-----------|-------------|
| `maxLengthGuardrail(n)` | Block messages over N characters |
| `piiGuardrail()` | Block emails, phone numbers, SSNs, credit cards |
| `toxicityGuardrail(words)` | Block messages containing specific words |
| `blockedPatternsGuardrail(patterns)` | Block regex patterns |
| `requiredContentGuardrail(terms)` | Ensure output contains required terms |
| `jsonOutputGuardrail()` | Ensure output is valid JSON |

## Custom Guardrails

```typescript
guardrails.addInput({
    name: "language-check",
    check: (content) => ({
        passed: !content.includes("TODO"),
        message: "Message contains unfinished items",
    }),
    blocking: true,  // true = block, false = warn only
});
```

## Non-Blocking Guardrails

Set `blocking: false` for guardrails that should warn but not block:

```typescript
guardrails.addInput({
    name: "sentiment-check",
    check: (content) => ({
        passed: !content.includes("angry"),
        message: "Negative sentiment detected",
    }),
    blocking: false,  // Log warning, don't block
});
```
