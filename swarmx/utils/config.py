"""
SwarmX Config Loader — YAML-based swarm definition parser.

Loads swarm configurations from YAML files, creating the full
SwarmEngine with providers, agents, and their bindings.

Adapted from OpenClaw's config-driven architecture where agents,
channels, and tools are all defined declaratively.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

import yaml

from swarmx.core.agent import AgentConfig
from swarmx.core.engine import SwarmEngine
from swarmx.core.provider import ProviderConfig

logger = logging.getLogger("swarmx.config")


def load_config(path: str | Path) -> dict[str, Any]:
    """Load a YAML configuration file."""
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Config file not found: {path}")

    with open(path) as f:
        config = yaml.safe_load(f)

    if not config:
        raise ValueError(f"Empty config file: {path}")

    return config


def resolve_env_vars(value: str) -> str:
    """Resolve environment variable references like ${OPENAI_API_KEY}."""
    if isinstance(value, str) and value.startswith("${") and value.endswith("}"):
        env_var = value[2:-1]
        resolved = os.environ.get(env_var, "")
        if not resolved:
            logger.warning("Environment variable not set: %s", env_var)
        return resolved
    return value


def build_engine_from_config(config: dict[str, Any]) -> SwarmEngine:
    """
    Build a complete SwarmEngine from a parsed config dictionary.

    Expected config structure:
        swarm:
          name: "My Swarm"
          providers:
            openai:
              type: openai
              api_key: ${OPENAI_API_KEY}
              model: gpt-4o
          agents:
            researcher:
              provider: openai
              system_prompt: "You are a research assistant."
              subscriptions:
                - task.created
                - research.*
    """
    engine = SwarmEngine()

    swarm_config = config.get("swarm", config)
    swarm_name = swarm_config.get("name", "SwarmX")
    logger.info("Loading swarm: %s", swarm_name)

    # ── Load providers ──────────────────────────────────────────
    providers_config = swarm_config.get("providers", {})
    for provider_name, provider_def in providers_config.items():
        provider_type = provider_def.get("type", provider_name)
        api_key = resolve_env_vars(provider_def.get("api_key", ""))
        model = provider_def.get("model", "")
        base_url = provider_def.get("base_url")
        temperature = provider_def.get("temperature", 0.7)
        max_tokens = provider_def.get("max_tokens", 4096)
        timeout = provider_def.get("timeout", 60.0)

        pc = ProviderConfig(
            api_key=api_key,
            model=model,
            base_url=base_url,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
            extra=provider_def.get("extra", {}),
        )

        engine.register_provider(provider_name, config=pc)
        logger.info("Provider loaded: %s (type=%s, model=%s)", provider_name, provider_type, model)

    # ── Load agents ─────────────────────────────────────────────
    agents_config = swarm_config.get("agents", {})
    for agent_name, agent_def in agents_config.items():
        ac = AgentConfig(
            name=agent_name,
            provider=agent_def.get("provider", ""),
            model=agent_def.get("model", ""),
            system_prompt=agent_def.get("system_prompt", ""),
            subscriptions=agent_def.get("subscriptions", ["task.created"]),
            tools=agent_def.get("tools", []),
            max_history=agent_def.get("max_history", 50),
            temperature=agent_def.get("temperature"),
            metadata=agent_def.get("metadata", {}),
        )
        engine.add_agent(ac)
        logger.info("Agent loaded: %s (provider=%s)", agent_name, ac.provider)

    return engine


def load_and_build(path: str | Path) -> SwarmEngine:
    """Convenience: load a YAML config and build the engine in one call."""
    config = load_config(path)
    return build_engine_from_config(config)
