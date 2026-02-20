"""
Tests for the SwarmX Task Scheduler.
"""

from __future__ import annotations

import asyncio
import pytest

from swarmx.core.event_bus import Event, EventBus, EventPriority
from swarmx.core.scheduler import Task, TaskScheduler, TaskStatus


@pytest.fixture
def event_bus():
    return EventBus()


@pytest.fixture
def scheduler(event_bus):
    return TaskScheduler(event_bus)


class TestTaskScheduler:
    """Test suite for TaskScheduler."""

    @pytest.mark.asyncio
    async def test_submit_task(self, event_bus, scheduler):
        """Should submit and schedule a task."""
        published_events: list[Event] = []

        async def capture(event: Event):
            published_events.append(event)

        event_bus.subscribe("task.created", capture, subscriber_id="test")
        await event_bus.start()
        await scheduler.start()

        task = Task(name="test-task", description="A test task")
        task_id = await scheduler.submit(task)

        await asyncio.sleep(0.3)

        assert task_id
        assert scheduler.get_status(task_id) == TaskStatus.RUNNING
        assert len(published_events) == 1

        await scheduler.stop()
        await event_bus.stop()

    @pytest.mark.asyncio
    async def test_task_dependencies(self, event_bus, scheduler):
        """Tasks with dependencies should wait."""
        await event_bus.start()
        await scheduler.start()

        # Create two tasks where task2 depends on task1
        task1 = Task(task_id="t1", name="task1")
        task2 = Task(task_id="t2", name="task2", depends_on=["t1"])

        await scheduler.submit(task1)
        await scheduler.submit(task2)

        await asyncio.sleep(0.3)

        # task2 should still be pending (task1 not completed)
        assert scheduler.get_status("t2") == TaskStatus.PENDING

        # Complete task1
        await event_bus.publish(
            Event(topic="task.completed", payload={"task_id": "t1", "result": "done"})
        )
        await asyncio.sleep(0.3)

        # Now task2 should be running
        assert scheduler.get_status("t1") == TaskStatus.COMPLETED
        assert scheduler.get_status("t2") == TaskStatus.RUNNING

        await scheduler.stop()
        await event_bus.stop()

    @pytest.mark.asyncio
    async def test_cancel_task(self, event_bus, scheduler):
        """Should cancel pending tasks."""
        await event_bus.start()

        task = Task(task_id="cancel-me", name="cancel-test", depends_on=["nonexistent"])
        await scheduler.submit(task)

        assert scheduler.get_status("cancel-me") == TaskStatus.PENDING
        result = await scheduler.cancel("cancel-me")
        assert result is True
        assert scheduler.get_status("cancel-me") == TaskStatus.CANCELLED

        await event_bus.stop()

    @pytest.mark.asyncio
    async def test_task_failure(self, event_bus, scheduler):
        """Should handle task failures."""
        await event_bus.start()
        await scheduler.start()

        task = Task(task_id="fail-task", name="fail-test")
        await scheduler.submit(task)

        await asyncio.sleep(0.2)

        # Simulate failure
        await event_bus.publish(
            Event(
                topic="task.failed",
                payload={"task_id": "fail-task", "error": "Something broke"},
            )
        )
        await asyncio.sleep(0.2)

        assert scheduler.get_status("fail-task") == TaskStatus.FAILED
        failed_task = scheduler.get_task("fail-task")
        assert failed_task and failed_task.error == "Something broke"

        await scheduler.stop()
        await event_bus.stop()
