"""
SwarmX — Multi-Agent Orchestration Framework

A model-agnostic, async, event-driven multi-agent orchestration framework
for developers. Inspired by architectural patterns from the OpenClaw project.

MIT License — see LICENSE for details.
"""

__version__ = "0.1.0"

from swarmx.core.agent import Agent, AgentConfig
from swarmx.core.engine import SwarmEngine
from swarmx.core.event_bus import Event, EventBus
from swarmx.core.scheduler import TaskScheduler
from swarmx.core.provider import ProviderBase, ProviderRegistry, Message, Role

__all__ = [
    "Agent",
    "AgentConfig",
    "SwarmEngine",
    "Event",
    "EventBus",
    "TaskScheduler",
    "ProviderBase",
    "ProviderRegistry",
    "Message",
    "Role",
]
