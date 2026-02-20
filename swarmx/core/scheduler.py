"""
SwarmX Task Scheduler — Async task scheduling and execution.

Manages the lifecycle of tasks within the swarm, distributing work
to agents via the event bus. Supports priority-based scheduling,
delayed execution, and task dependency chains.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from swarmx.core.event_bus import Event, EventBus, EventPriority

logger = logging.getLogger("swarmx.scheduler")


class TaskStatus(Enum):
    """Task lifecycle states."""

    PENDING = "pending"
    SCHEDULED = "scheduled"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class Task:
    """
    A unit of work to be executed within the swarm.

    Tasks are dispatched to agents via events. The scheduler tracks
    their lifecycle and manages dependencies between tasks.
    """

    task_id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])
    name: str = ""
    description: str = ""
    target_topic: str = "task.created"
    payload: dict[str, Any] = field(default_factory=dict)
    priority: EventPriority = EventPriority.NORMAL
    status: TaskStatus = TaskStatus.PENDING
    depends_on: list[str] = field(default_factory=list)  # Task IDs this depends on
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    completed_at: float | None = None
    result: Any = None
    error: str | None = None
    delay_seconds: float = 0.0  # Delay before scheduling


class TaskScheduler:
    """
    Async task scheduler for the SwarmX engine.

    Responsibilities:
      - Accept and queue tasks
      - Resolve dependencies between tasks
      - Schedule tasks by publishing events
      - Track task status and results
      - Support delayed execution
    """

    def __init__(self, event_bus: EventBus) -> None:
        self.event_bus = event_bus
        self._tasks: dict[str, Task] = {}
        self._pending_queue: asyncio.Queue[Task] = asyncio.Queue()
        self._running = False
        self._scheduler_task: asyncio.Task[None] | None = None

        # Subscribe to task completion events
        self.event_bus.subscribe(
            "task.completed",
            self._on_task_completed,
            subscriber_id="scheduler",
        )
        self.event_bus.subscribe(
            "task.failed",
            self._on_task_failed,
            subscriber_id="scheduler",
        )

    # ── Task Submission ─────────────────────────────────────────────

    async def submit(self, task: Task) -> str:
        """
        Submit a task for scheduling.

        Returns the task ID. The task will be scheduled when all
        dependencies are met.
        """
        self._tasks[task.task_id] = task
        logger.info("Task submitted: %s (%s)", task.task_id, task.name)

        if self._can_schedule(task):
            await self._schedule_task(task)
        else:
            logger.debug(
                "Task %s waiting on dependencies: %s",
                task.task_id,
                task.depends_on,
            )

        return task.task_id

    async def submit_many(self, tasks: list[Task]) -> list[str]:
        """Submit multiple tasks. Returns list of task IDs."""
        return [await self.submit(task) for task in tasks]

    # ── Task Management ─────────────────────────────────────────────

    def get_task(self, task_id: str) -> Task | None:
        """Retrieve a task by ID."""
        return self._tasks.get(task_id)

    def get_status(self, task_id: str) -> TaskStatus | None:
        """Get the current status of a task."""
        task = self._tasks.get(task_id)
        return task.status if task else None

    async def cancel(self, task_id: str) -> bool:
        """Cancel a pending or scheduled task."""
        task = self._tasks.get(task_id)
        if not task:
            return False

        if task.status in (TaskStatus.PENDING, TaskStatus.SCHEDULED):
            task.status = TaskStatus.CANCELLED
            logger.info("Task cancelled: %s", task_id)
            return True

        logger.warning("Cannot cancel task %s in state %s", task_id, task.status.value)
        return False

    # ── Scheduling Logic ────────────────────────────────────────────

    def _can_schedule(self, task: Task) -> bool:
        """Check if all task dependencies are satisfied."""
        for dep_id in task.depends_on:
            dep_task = self._tasks.get(dep_id)
            if not dep_task or dep_task.status != TaskStatus.COMPLETED:
                return False
        return True

    async def _schedule_task(self, task: Task) -> None:
        """Schedule a task by publishing it as an event."""
        if task.status == TaskStatus.CANCELLED:
            return

        # Handle delayed execution
        if task.delay_seconds > 0:
            task.status = TaskStatus.SCHEDULED
            await asyncio.sleep(task.delay_seconds)

        task.status = TaskStatus.RUNNING
        task.started_at = time.time()

        # Publish the task as an event
        event = Event(
            topic=task.target_topic,
            payload={
                "task_id": task.task_id,
                "name": task.name,
                "description": task.description,
                "content": task.payload.get("content", task.description),
                **task.payload,
            },
            source="scheduler",
            priority=task.priority,
            metadata={"task_id": task.task_id},
        )
        await self.event_bus.publish(event)
        logger.info("Task scheduled: %s → %s", task.task_id, task.target_topic)

    # ── Completion Handlers ─────────────────────────────────────────

    async def _on_task_completed(self, event: Event) -> None:
        """Handle task completion events."""
        task_id = event.payload.get("task_id", "")
        task = self._tasks.get(task_id)
        if task:
            task.status = TaskStatus.COMPLETED
            task.completed_at = time.time()
            task.result = event.payload.get("result")
            logger.info("Task completed: %s", task_id)

            # Check if any dependent tasks can now be scheduled
            await self._check_dependents(task_id)

    async def _on_task_failed(self, event: Event) -> None:
        """Handle task failure events."""
        task_id = event.payload.get("task_id", "")
        task = self._tasks.get(task_id)
        if task:
            task.status = TaskStatus.FAILED
            task.completed_at = time.time()
            task.error = event.payload.get("error", "Unknown error")
            logger.error("Task failed: %s — %s", task_id, task.error)

    async def _check_dependents(self, completed_task_id: str) -> None:
        """Check and schedule tasks that depended on the completed task."""
        for task in self._tasks.values():
            if (
                task.status == TaskStatus.PENDING
                and completed_task_id in task.depends_on
                and self._can_schedule(task)
            ):
                await self._schedule_task(task)

    # ── Lifecycle ───────────────────────────────────────────────────

    async def start(self) -> None:
        """Start the scheduler."""
        self._running = True
        logger.info("TaskScheduler started")

    async def stop(self) -> None:
        """Stop the scheduler."""
        self._running = False
        logger.info(
            "TaskScheduler stopped (tasks: %d total, %d completed, %d failed)",
            len(self._tasks),
            sum(1 for t in self._tasks.values() if t.status == TaskStatus.COMPLETED),
            sum(1 for t in self._tasks.values() if t.status == TaskStatus.FAILED),
        )

    # ── Introspection ───────────────────────────────────────────────

    @property
    def all_tasks(self) -> dict[str, Task]:
        """All tracked tasks."""
        return dict(self._tasks)

    @property
    def pending_count(self) -> int:
        """Number of pending tasks."""
        return sum(1 for t in self._tasks.values() if t.status == TaskStatus.PENDING)

    @property
    def running_count(self) -> int:
        """Number of running tasks."""
        return sum(1 for t in self._tasks.values() if t.status == TaskStatus.RUNNING)
