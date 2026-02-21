/**
 * Groklets Workflow Engine — Structured multi-agent orchestration.
 *
 * Defines workflows as DAGs: steps execute in order, in parallel,
 * or conditionally based on previous outputs. Agents hand off to
 * each other through a shared blackboard.
 *
 * This is the heart of orchestration — "you go first, then you,
 * then you, and if this happens, skip to step 5."
 */

import { EventBus, createEvent } from "./event-bus.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Workflow");

// ── Types ──────────────────────────────────────────────────────

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface WorkflowStep {
    /** Unique step ID within the workflow. */
    id: string;
    /** Agent name to execute this step. */
    agent: string;
    /** Input prompt template. Use {{blackboard.key}} for variable injection. */
    input: string;
    /** Steps that must complete before this one runs. Empty = ready immediately. */
    dependsOn?: string[];
    /** Run condition — if set, step runs only when this returns true. */
    condition?: (blackboard: Blackboard) => boolean;
    /** Output key — result is stored on the blackboard under this key. */
    outputKey?: string;
    /** Maximum retries on failure. */
    retries?: number;
    /** Timeout in ms. */
    timeout?: number;
    /** Structured output schema (Zod-style). If set, output is validated. */
    outputSchema?: Record<string, unknown>;
}

export interface ParallelGroup {
    /** Run these steps in parallel. All must complete before dependents run. */
    parallel: string[];
}

export interface WorkflowDefinition {
    /** Workflow name. */
    name: string;
    /** All steps in the workflow. */
    steps: WorkflowStep[];
    /** Optional: parallel execution groups. */
    parallelGroups?: ParallelGroup[];
    /** Global timeout for the entire workflow (ms). */
    timeout?: number;
    /** Hook: called when a step completes. */
    onStepComplete?: (stepId: string, result: string, blackboard: Blackboard) => void;
    /** Hook: called when workflow completes. */
    onComplete?: (blackboard: Blackboard) => void;
}

export interface StepResult {
    stepId: string;
    agent: string;
    status: StepStatus;
    output: string;
    startedAt: number;
    completedAt: number;
    duration: number;
    retryCount: number;
    error?: string;
}

// ── Blackboard (shared state) ──────────────────────────────────

export class Blackboard {
    private data = new Map<string, unknown>();

    set(key: string, value: unknown): void { this.data.set(key, value); }
    get<T = string>(key: string): T | undefined { return this.data.get(key) as T; }
    has(key: string): boolean { return this.data.has(key); }
    keys(): string[] { return [...this.data.keys()]; }

    /** Get all data as a plain object. */
    toObject(): Record<string, unknown> {
        const obj: Record<string, unknown> = {};
        for (const [k, v] of this.data) obj[k] = v;
        return obj;
    }

    /** Resolve template variables: {{blackboard.key}} → value */
    resolve(template: string): string {
        return template.replace(/\{\{blackboard\.(\w+)\}\}/g, (_, key) => {
            const val = this.data.get(key);
            return val !== undefined ? String(val) : `{{blackboard.${key}}}`;
        });
    }
}

// ── Workflow Run ────────────────────────────────────────────────

export interface WorkflowRun {
    id: string;
    workflow: string;
    status: "running" | "completed" | "failed" | "cancelled";
    blackboard: Blackboard;
    results: Map<string, StepResult>;
    startedAt: number;
    completedAt?: number;
}

// ── Orchestrator ───────────────────────────────────────────────

export type AgentExecutor = (agent: string, input: string) => Promise<string>;

export class WorkflowOrchestrator {
    private runs = new Map<string, WorkflowRun>();

    constructor(
        private execute: AgentExecutor,
        private eventBus?: EventBus,
    ) { }

    /**
     * Run a workflow. Returns the final blackboard.
     */
    async run(def: WorkflowDefinition, initialContext?: Record<string, unknown>): Promise<WorkflowRun> {
        const runId = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const blackboard = new Blackboard();

        // Seed blackboard with initial context
        if (initialContext) {
            for (const [k, v] of Object.entries(initialContext)) {
                blackboard.set(k, v);
            }
        }

        const run: WorkflowRun = {
            id: runId,
            workflow: def.name,
            status: "running",
            blackboard,
            results: new Map(),
            startedAt: Date.now(),
        };

        this.runs.set(runId, run);
        log.info(`Workflow started: ${def.name} (${runId})`);

        this.eventBus?.publish(createEvent({
            topic: "workflow.started", source: "orchestrator", payload: {
                runId, workflow: def.name,
            }
        }));

        // Build dependency graph
        const stepMap = new Map(def.steps.map(s => [s.id, s]));
        const stepStatus = new Map<string, StepStatus>(def.steps.map(s => [s.id, "pending"]));
        const parallelSets = new Set<string>();
        for (const pg of def.parallelGroups ?? []) {
            for (const id of pg.parallel) parallelSets.add(id);
        }

        // Execution loop
        const globalTimeout = def.timeout ?? 300_000; // 5 min default
        const deadline = Date.now() + globalTimeout;

        try {
            while (true) {
                if (Date.now() > deadline) {
                    run.status = "failed";
                    log.error(`Workflow timed out: ${def.name}`);
                    break;
                }

                // Find ready steps (all deps done, not yet running)
                const ready: WorkflowStep[] = [];
                for (const step of def.steps) {
                    if (stepStatus.get(step.id) !== "pending") continue;

                    const depsReady = (step.dependsOn ?? []).every(
                        dep => stepStatus.get(dep) === "done" || stepStatus.get(dep) === "skipped"
                    );
                    if (!depsReady) continue;

                    // Check condition
                    if (step.condition && !step.condition(blackboard)) {
                        stepStatus.set(step.id, "skipped");
                        log.debug(`Step skipped (condition): ${step.id}`);
                        continue;
                    }

                    ready.push(step);
                }

                if (ready.length === 0) {
                    // Check if we're done or stuck
                    const allDone = [...stepStatus.values()].every(s => s === "done" || s === "skipped" || s === "failed");
                    if (allDone) break;

                    const anyRunning = [...stepStatus.values()].some(s => s === "running");
                    if (!anyRunning) {
                        // Stuck — deps can't be satisfied
                        log.error(`Workflow stuck: unresolvable dependencies in ${def.name}`);
                        run.status = "failed";
                        break;
                    }

                    // Wait for running steps
                    await new Promise(r => setTimeout(r, 100));
                    continue;
                }

                // Check which steps can run in parallel
                const parallelBatch = ready.filter(s => parallelSets.has(s.id));
                const sequential = ready.filter(s => !parallelSets.has(s.id));

                // Execute parallel batch
                if (parallelBatch.length > 1) {
                    log.debug(`Parallel: [${parallelBatch.map(s => s.id).join(", ")}]`);
                    await Promise.all(parallelBatch.map(step =>
                        this.executeStep(step, blackboard, stepStatus, run, def)
                    ));
                } else if (parallelBatch.length === 1) {
                    await this.executeStep(parallelBatch[0], blackboard, stepStatus, run, def);
                }

                // Execute sequential (one at a time)
                for (const step of sequential) {
                    if (run.status === "failed") break;
                    await this.executeStep(step, blackboard, stepStatus, run, def);
                }
            }

            // Final status
            const anyFailed = [...stepStatus.values()].some(s => s === "failed");
            if (run.status !== "failed") {
                run.status = anyFailed ? "failed" : "completed";
            }
        } catch (err) {
            run.status = "failed";
            log.error(`Workflow error: ${(err as Error).message}`);
        }

        run.completedAt = Date.now();
        const duration = run.completedAt - run.startedAt;
        log.info(`Workflow ${run.status}: ${def.name} (${duration}ms, ${run.results.size} steps)`);

        this.eventBus?.publish(createEvent({
            topic: "workflow.completed", source: "orchestrator", payload: {
                runId, workflow: def.name, status: run.status,
                duration, blackboard: blackboard.toObject(),
            }
        }));

        def.onComplete?.(blackboard);
        return run;
    }

    private async executeStep(
        step: WorkflowStep,
        blackboard: Blackboard,
        stepStatus: Map<string, StepStatus>,
        run: WorkflowRun,
        def: WorkflowDefinition,
    ): Promise<void> {
        stepStatus.set(step.id, "running");
        const startedAt = Date.now();
        const maxRetries = step.retries ?? 0;
        let retryCount = 0;
        let lastError = "";

        while (retryCount <= maxRetries) {
            try {
                // Resolve template variables from blackboard
                const input = blackboard.resolve(step.input);

                log.debug(`Step ${step.id} → ${step.agent}: "${input.slice(0, 80)}..."`);

                // Execute with timeout
                const timeout = step.timeout ?? 120_000;
                const result = await Promise.race([
                    this.execute(step.agent, input),
                    new Promise<never>((_, rej) =>
                        setTimeout(() => rej(new Error(`Step timeout: ${step.id} (${timeout}ms)`)), timeout)
                    ),
                ]);

                // Validate structured output if schema provided
                let finalResult = result;
                if (step.outputSchema) {
                    try {
                        const parsed = JSON.parse(result);
                        // Basic schema validation: check required keys exist
                        for (const [key, type] of Object.entries(step.outputSchema)) {
                            if (!(key in parsed)) {
                                throw new Error(`Missing required key: '${key}'`);
                            }
                            if (type === "string" && typeof parsed[key] !== "string") {
                                throw new Error(`Key '${key}' must be string, got ${typeof parsed[key]}`);
                            }
                            if (type === "number" && typeof parsed[key] !== "number") {
                                throw new Error(`Key '${key}' must be number, got ${typeof parsed[key]}`);
                            }
                            if (type === "boolean" && typeof parsed[key] !== "boolean") {
                                throw new Error(`Key '${key}' must be boolean, got ${typeof parsed[key]}`);
                            }
                            if (type === "array" && !Array.isArray(parsed[key])) {
                                throw new Error(`Key '${key}' must be array`);
                            }
                        }
                        finalResult = result; // Keep raw JSON string
                    } catch (parseErr) {
                        throw new Error(`Output schema validation failed for step '${step.id}': ${(parseErr as Error).message}`);
                    }
                }

                // Store result
                const completedAt = Date.now();
                const stepResult: StepResult = {
                    stepId: step.id,
                    agent: step.agent,
                    status: "done",
                    output: finalResult,
                    startedAt, completedAt,
                    duration: completedAt - startedAt,
                    retryCount,
                };

                run.results.set(step.id, stepResult);
                stepStatus.set(step.id, "done");

                // Write to blackboard
                const key = step.outputKey ?? step.id;
                blackboard.set(key, finalResult);

                log.debug(`Step ${step.id} done (${stepResult.duration}ms)`);

                this.eventBus?.publish(createEvent({
                    topic: "workflow.step.completed", source: "orchestrator", payload: {
                        runId: run.id, stepId: step.id, agent: step.agent,
                        duration: stepResult.duration,
                    }
                }));

                def.onStepComplete?.(step.id, result, blackboard);
                return;

            } catch (err) {
                lastError = (err as Error).message;
                retryCount++;
                if (retryCount <= maxRetries) {
                    log.warn(`Step ${step.id} failed (retry ${retryCount}/${maxRetries}): ${lastError}`);
                    await new Promise(r => setTimeout(r, 1000 * retryCount)); // backoff
                }
            }
        }

        // All retries exhausted
        const completedAt = Date.now();
        const stepResult: StepResult = {
            stepId: step.id,
            agent: step.agent,
            status: "failed",
            output: "",
            startedAt, completedAt,
            duration: completedAt - startedAt,
            retryCount,
            error: lastError,
        };

        run.results.set(step.id, stepResult);
        stepStatus.set(step.id, "failed");
        log.error(`Step ${step.id} failed: ${lastError}`);

        this.eventBus?.publish(createEvent({
            topic: "workflow.step.failed", source: "orchestrator", payload: {
                runId: run.id, stepId: step.id, error: lastError,
            }
        }));
    }

    /** Get a workflow run by ID. */
    getRun(runId: string): WorkflowRun | undefined {
        return this.runs.get(runId);
    }

    /** Cancel a running workflow. */
    cancel(runId: string): void {
        const run = this.runs.get(runId);
        if (run && run.status === "running") {
            run.status = "cancelled";
            run.completedAt = Date.now();
            log.info(`Workflow cancelled: ${runId}`);
        }
    }

    /** List all runs. */
    get allRuns(): WorkflowRun[] {
        return [...this.runs.values()];
    }
}

// ── Convenience: Pipeline builder ──────────────────────────────

/**
 * Build a linear pipeline: Agent A → Agent B → Agent C.
 * Each agent receives the previous agent's output.
 */
export function pipeline(
    name: string,
    steps: Array<{ id: string; agent: string; prompt: string }>,
): WorkflowDefinition {
    return {
        name,
        steps: steps.map((s, i) => ({
            id: s.id,
            agent: s.agent,
            input: i === 0 ? s.prompt : `${s.prompt}\n\nPrevious result:\n{{blackboard.${steps[i - 1].id}}}`,
            dependsOn: i === 0 ? [] : [steps[i - 1].id],
            outputKey: s.id,
        })),
    };
}

/**
 * Build a fan-out/fan-in pattern: run N agents in parallel,
 * then merge results through a final agent.
 */
export function fanOutFanIn(
    name: string,
    input: string,
    workers: Array<{ id: string; agent: string; prompt: string }>,
    merger: { id: string; agent: string; prompt: string },
): WorkflowDefinition {
    const workerSteps: WorkflowStep[] = workers.map(w => ({
        id: w.id,
        agent: w.agent,
        input: `${w.prompt}\n\nInput:\n${input}`,
        dependsOn: [],
        outputKey: w.id,
    }));

    const workerRefs = workers.map(w => `### ${w.id}:\n{{blackboard.${w.id}}}`).join("\n\n");
    const mergerStep: WorkflowStep = {
        id: merger.id,
        agent: merger.agent,
        input: `${merger.prompt}\n\nResults from all agents:\n${workerRefs}`,
        dependsOn: workers.map(w => w.id),
        outputKey: merger.id,
    };

    return {
        name,
        steps: [...workerSteps, mergerStep],
        parallelGroups: [{ parallel: workers.map(w => w.id) }],
    };
}
