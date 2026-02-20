/**
 * SwarmX Task Scheduler — Async task scheduling and execution.
 *
 * Manages the lifecycle of tasks within the swarm, distributing work
 * to agents via the event bus. Supports priority-based scheduling,
 * delayed execution, and task dependency chains.
 */

import { randomUUID } from "node:crypto";
import { EventBus, createEvent, type SwarmEvent, EventPriority } from "./event-bus.js";

export enum TaskStatus {
    PENDING = "pending",
    SCHEDULED = "scheduled",
    RUNNING = "running",
    COMPLETED = "completed",
    FAILED = "failed",
    CANCELLED = "cancelled",
}

/**
 * A unit of work to be executed within the swarm.
 */
export interface Task {
    taskId: string;
    name: string;
    description: string;
    targetTopic: string;
    payload: Record<string, unknown>;
    priority: EventPriority;
    status: TaskStatus;
    dependsOn: string[];
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
    result?: unknown;
    error?: string;
    delayMs: number;
}

/**
 * Create a Task with defaults.
 */
export function createTask(partial: Partial<Task> & { name: string }): Task {
    return {
        taskId: partial.taskId ?? randomUUID().slice(0, 10),
        name: partial.name,
        description: partial.description ?? "",
        targetTopic: partial.targetTopic ?? "task.created",
        payload: partial.payload ?? {},
        priority: partial.priority ?? EventPriority.NORMAL,
        status: partial.status ?? TaskStatus.PENDING,
        dependsOn: partial.dependsOn ?? [],
        createdAt: partial.createdAt ?? Date.now(),
        delayMs: partial.delayMs ?? 0,
    };
}

/**
 * Async task scheduler for the SwarmX engine.
 *
 * Responsibilities:
 *   - Accept and queue tasks
 *   - Resolve dependencies between tasks
 *   - Schedule tasks by publishing events
 *   - Track task status and results
 *   - Support delayed execution
 */
export class TaskScheduler {
    private tasks = new Map<string, Task>();
    private running = false;

    constructor(private readonly eventBus: EventBus) {
        // Subscribe to task lifecycle events
        this.eventBus.subscribe(
            "task.completed",
            (event) => this.onTaskCompleted(event),
            "scheduler",
        );
        this.eventBus.subscribe(
            "task.failed",
            (event) => this.onTaskFailed(event),
            "scheduler",
        );
    }

    // ── Task Submission ─────────────────────────────────────────

    /**
     * Submit a task for scheduling. Returns the task ID.
     */
    async submit(task: Task): Promise<string> {
        this.tasks.set(task.taskId, task);

        if (this.canSchedule(task)) {
            await this.scheduleTask(task);
        }

        return task.taskId;
    }

    /**
     * Submit multiple tasks. Returns list of task IDs.
     */
    async submitMany(tasks: Task[]): Promise<string[]> {
        const ids: string[] = [];
        for (const task of tasks) {
            ids.push(await this.submit(task));
        }
        return ids;
    }

    // ── Task Management ─────────────────────────────────────────

    getTask(taskId: string): Task | undefined {
        return this.tasks.get(taskId);
    }

    getStatus(taskId: string): TaskStatus | undefined {
        return this.tasks.get(taskId)?.status;
    }

    async cancel(taskId: string): Promise<boolean> {
        const task = this.tasks.get(taskId);
        if (!task) return false;

        if (task.status === TaskStatus.PENDING || task.status === TaskStatus.SCHEDULED) {
            task.status = TaskStatus.CANCELLED;
            return true;
        }

        return false;
    }

    // ── Scheduling Logic ────────────────────────────────────────

    private canSchedule(task: Task): boolean {
        for (const depId of task.dependsOn) {
            const dep = this.tasks.get(depId);
            if (!dep || dep.status !== TaskStatus.COMPLETED) {
                return false;
            }
        }
        return true;
    }

    private async scheduleTask(task: Task): Promise<void> {
        if (task.status === TaskStatus.CANCELLED) return;

        // Handle delayed execution
        if (task.delayMs > 0) {
            task.status = TaskStatus.SCHEDULED;
            await new Promise((resolve) => setTimeout(resolve, task.delayMs));
        }

        task.status = TaskStatus.RUNNING;
        task.startedAt = Date.now();

        // Publish the task as an event
        const event = createEvent({
            topic: task.targetTopic,
            payload: {
                taskId: task.taskId,
                name: task.name,
                description: task.description,
                content: (task.payload.content as string) ?? task.description,
                ...task.payload,
            },
            source: "scheduler",
            priority: task.priority,
            metadata: { taskId: task.taskId },
        });

        await this.eventBus.publish(event);
    }

    // ── Completion Handlers ─────────────────────────────────────

    private async onTaskCompleted(event: SwarmEvent): Promise<void> {
        const taskId = event.payload.taskId as string;
        const task = this.tasks.get(taskId);
        if (task) {
            task.status = TaskStatus.COMPLETED;
            task.completedAt = Date.now();
            task.result = event.payload.result;

            // Check dependent tasks
            await this.checkDependents(taskId);
        }
    }

    private async onTaskFailed(event: SwarmEvent): Promise<void> {
        const taskId = event.payload.taskId as string;
        const task = this.tasks.get(taskId);
        if (task) {
            task.status = TaskStatus.FAILED;
            task.completedAt = Date.now();
            task.error = (event.payload.error as string) ?? "Unknown error";
        }
    }

    private async checkDependents(completedTaskId: string): Promise<void> {
        for (const task of this.tasks.values()) {
            if (
                task.status === TaskStatus.PENDING &&
                task.dependsOn.includes(completedTaskId) &&
                this.canSchedule(task)
            ) {
                await this.scheduleTask(task);
            }
        }
    }

    // ── Lifecycle ───────────────────────────────────────────────

    async start(): Promise<void> {
        this.running = true;
    }

    async stop(): Promise<void> {
        this.running = false;
    }

    // ── Introspection ───────────────────────────────────────────

    get allTasks(): Map<string, Task> {
        return new Map(this.tasks);
    }

    get pendingCount(): number {
        let count = 0;
        for (const t of this.tasks.values()) {
            if (t.status === TaskStatus.PENDING) count++;
        }
        return count;
    }

    get runningCount(): number {
        let count = 0;
        for (const t of this.tasks.values()) {
            if (t.status === TaskStatus.RUNNING) count++;
        }
        return count;
    }
}
