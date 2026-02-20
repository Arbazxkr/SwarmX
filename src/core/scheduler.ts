/**
 * SwarmX Task Scheduler — Async task lifecycle management.
 *
 * Distributes work to agents via the event bus. Supports priority scheduling,
 * delayed execution, task dependencies, and automatic retries.
 */

import { randomUUID } from "node:crypto";
import { EventBus, createEvent, type SwarmEvent, EventPriority } from "./event-bus.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Scheduler");

export enum TaskStatus {
    PENDING = "pending",
    SCHEDULED = "scheduled",
    RUNNING = "running",
    COMPLETED = "completed",
    FAILED = "failed",
    CANCELLED = "cancelled",
}

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
    maxRetries: number;
    retryCount: number;
}

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
        maxRetries: partial.maxRetries ?? 0,
        retryCount: partial.retryCount ?? 0,
    };
}

export class TaskScheduler {
    private tasks = new Map<string, Task>();
    private running = false;

    constructor(private readonly eventBus: EventBus) {
        this.eventBus.subscribe("task.completed", (e) => this.onTaskCompleted(e), "scheduler");
        this.eventBus.subscribe("task.failed", (e) => this.onTaskFailed(e), "scheduler");
    }

    async submit(task: Task): Promise<string> {
        this.tasks.set(task.taskId, task);
        log.debug(`Task submitted: ${task.taskId} "${task.name}"`);

        if (this.canSchedule(task)) {
            await this.scheduleTask(task);
        }
        return task.taskId;
    }

    async submitMany(tasks: Task[]): Promise<string[]> {
        return Promise.all(tasks.map((t) => this.submit(t)));
    }

    getTask(taskId: string): Task | undefined { return this.tasks.get(taskId); }
    getStatus(taskId: string): TaskStatus | undefined { return this.tasks.get(taskId)?.status; }

    async cancel(taskId: string): Promise<boolean> {
        const task = this.tasks.get(taskId);
        if (!task) return false;
        if (task.status === TaskStatus.PENDING || task.status === TaskStatus.SCHEDULED) {
            task.status = TaskStatus.CANCELLED;
            log.info(`Task cancelled: ${taskId}`);
            return true;
        }
        return false;
    }

    private canSchedule(task: Task): boolean {
        return task.dependsOn.every((id) => {
            const dep = this.tasks.get(id);
            return dep && dep.status === TaskStatus.COMPLETED;
        });
    }

    private async scheduleTask(task: Task): Promise<void> {
        if (task.status === TaskStatus.CANCELLED) return;

        if (task.delayMs > 0) {
            task.status = TaskStatus.SCHEDULED;
            await new Promise((r) => setTimeout(r, task.delayMs));
        }

        task.status = TaskStatus.RUNNING;
        task.startedAt = Date.now();

        await this.eventBus.publish(createEvent({
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
        }));

        log.info(`Task dispatched: ${task.taskId} → ${task.targetTopic}`);
    }

    private async onTaskCompleted(event: SwarmEvent): Promise<void> {
        const taskId = event.payload.taskId as string;
        const task = this.tasks.get(taskId);
        if (task) {
            task.status = TaskStatus.COMPLETED;
            task.completedAt = Date.now();
            task.result = event.payload.result;
            log.info(`Task completed: ${taskId} (${task.completedAt - (task.startedAt ?? task.createdAt)}ms)`);
            await this.checkDependents(taskId);
        }
    }

    private async onTaskFailed(event: SwarmEvent): Promise<void> {
        const taskId = event.payload.taskId as string;
        const task = this.tasks.get(taskId);
        if (!task) return;

        // Retry logic
        if (task.retryCount < task.maxRetries) {
            task.retryCount++;
            log.warn(`Retrying task ${taskId} (attempt ${task.retryCount}/${task.maxRetries})`);
            task.status = TaskStatus.PENDING;
            await this.scheduleTask(task);
            return;
        }

        task.status = TaskStatus.FAILED;
        task.completedAt = Date.now();
        task.error = (event.payload.error as string) ?? "Unknown error";
        log.error(`Task failed: ${taskId} — ${task.error}`);
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

    async start(): Promise<void> { this.running = true; log.info("Scheduler started"); }
    async stop(): Promise<void> { this.running = false; log.info("Scheduler stopped"); }

    get allTasks() { return new Map(this.tasks); }
    get pendingCount() { return [...this.tasks.values()].filter((t) => t.status === TaskStatus.PENDING).length; }
    get runningCount() { return [...this.tasks.values()].filter((t) => t.status === TaskStatus.RUNNING).length; }
}
