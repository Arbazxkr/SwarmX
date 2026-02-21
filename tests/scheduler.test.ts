/**
 * Tests for the Groklets Task Scheduler.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EventBus, createEvent, type SwarmEvent } from "../src/core/event-bus.js";
import { TaskScheduler, TaskStatus, createTask } from "../src/core/scheduler.js";

describe("TaskScheduler", () => {
    let bus: EventBus;
    let scheduler: TaskScheduler;

    beforeEach(() => {
        bus = new EventBus();
        scheduler = new TaskScheduler(bus);
    });

    it("should submit and schedule a task", async () => {
        const published: SwarmEvent[] = [];
        bus.subscribe("task.created", async (event) => {
            published.push(event);
        }, "test");

        await bus.start();
        await scheduler.start();

        const task = createTask({ name: "test-task", description: "A test task" });
        const taskId = await scheduler.submit(task);

        await new Promise((r) => setTimeout(r, 300));

        expect(taskId).toBeTruthy();
        expect(scheduler.getStatus(taskId)).toBe(TaskStatus.RUNNING);
        expect(published).toHaveLength(1);

        await scheduler.stop();
        await bus.stop();
    });

    it("should handle task dependencies", async () => {
        await bus.start();
        await scheduler.start();

        const task1 = createTask({ taskId: "t1", name: "task1" });
        const task2 = createTask({ taskId: "t2", name: "task2", dependsOn: ["t1"] });

        await scheduler.submit(task1);
        await scheduler.submit(task2);
        await new Promise((r) => setTimeout(r, 200));

        // task2 should be pending (task1 not completed)
        expect(scheduler.getStatus("t2")).toBe(TaskStatus.PENDING);

        // Complete task1
        await bus.publish(createEvent({
            topic: "task.completed",
            payload: { taskId: "t1", result: "done" },
        }));
        await new Promise((r) => setTimeout(r, 300));

        expect(scheduler.getStatus("t1")).toBe(TaskStatus.COMPLETED);
        expect(scheduler.getStatus("t2")).toBe(TaskStatus.RUNNING);

        await scheduler.stop();
        await bus.stop();
    });

    it("should cancel pending tasks", async () => {
        await bus.start();

        const task = createTask({ taskId: "cancel-me", name: "cancel-test", dependsOn: ["nonexistent"] });
        await scheduler.submit(task);

        expect(scheduler.getStatus("cancel-me")).toBe(TaskStatus.PENDING);
        const result = await scheduler.cancel("cancel-me");
        expect(result).toBe(true);
        expect(scheduler.getStatus("cancel-me")).toBe(TaskStatus.CANCELLED);

        await bus.stop();
    });

    it("should handle task failures", async () => {
        await bus.start();
        await scheduler.start();

        const task = createTask({ taskId: "fail-task", name: "fail-test" });
        await scheduler.submit(task);
        await new Promise((r) => setTimeout(r, 200));

        await bus.publish(createEvent({
            topic: "task.failed",
            payload: { taskId: "fail-task", error: "Something broke" },
        }));
        await new Promise((r) => setTimeout(r, 200));

        expect(scheduler.getStatus("fail-task")).toBe(TaskStatus.FAILED);
        const failedTask = scheduler.getTask("fail-task");
        expect(failedTask?.error).toBe("Something broke");

        await scheduler.stop();
        await bus.stop();
    });
});
