"""
SwarmX Provider Abstraction — Model-agnostic LLM provider interface.

Adapted from OpenClaw's multi-model support pattern. The provider layer
ensures the core engine has zero dependency on any specific LLM vendor.
Providers are interchangeable and agents bind to them declaratively.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, AsyncIterator

logger = logging.getLogger("swarmx.provider")


class Role(Enum):
    """Standard message roles across all providers."""

    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


@dataclass
class Message:
    """
    A provider-agnostic message.

    All providers consume and produce Message objects, enabling
    seamless provider switching without touching agent logic.
    """

    role: Role
    content: str
    name: str | None = None
    tool_calls: list[dict[str, Any]] | None = None
    tool_call_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class CompletionResponse:
    """
    Standardized response from any provider.

    Wraps the provider-specific response into a uniform format
    that the engine and agents can consume without knowing which
    provider generated it.
    """

    message: Message
    finish_reason: str = "stop"
    usage: dict[str, int] = field(default_factory=dict)
    raw_response: Any = None  # Original provider response for advanced access
    model: str = ""


@dataclass
class ProviderConfig:
    """Configuration for a provider instance."""

    api_key: str = ""
    model: str = ""
    base_url: str | None = None
    temperature: float = 0.7
    max_tokens: int = 4096
    timeout: float = 60.0
    extra: dict[str, Any] = field(default_factory=dict)


class ProviderBase(ABC):
    """
    Abstract base class for all LLM providers.

    Every provider must implement `complete()` and optionally `stream()`.
    The engine interacts exclusively through this interface.
    """

    def __init__(self, config: ProviderConfig) -> None:
        self.config = config
        self._name: str = self.__class__.__name__

    @property
    def name(self) -> str:
        """Human-readable provider name."""
        return self._name

    @abstractmethod
    async def complete(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> CompletionResponse:
        """
        Send a list of messages and return a completion.

        Args:
            messages: Conversation history as Message objects.
            tools: Optional tool/function definitions the model can call.
            **kwargs: Provider-specific overrides.

        Returns:
            A CompletionResponse with the model's output.
        """
        ...

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        """
        Stream a completion token-by-token.

        Default implementation falls back to non-streaming `complete()`.
        Providers can override for true streaming support.
        """
        response = await self.complete(messages, tools, **kwargs)
        yield response.message.content

    async def health_check(self) -> bool:
        """Verify the provider is reachable and the API key is valid."""
        try:
            test_msg = [Message(role=Role.USER, content="ping")]
            await self.complete(test_msg)
            return True
        except Exception:
            logger.warning("Health check failed for %s", self.name)
            return False

    def __repr__(self) -> str:
        return f"<{self.name} model={self.config.model}>"


class ProviderRegistry:
    """
    Registry of available providers.

    Providers register themselves by name, and agents reference
    providers declaratively by name in their configuration.
    This pattern is adapted from OpenClaw's channel adapter registry.
    """

    def __init__(self) -> None:
        self._providers: dict[str, ProviderBase] = {}
        self._factory: dict[str, type[ProviderBase]] = {}

    def register_class(self, name: str, provider_class: type[ProviderBase]) -> None:
        """Register a provider class for lazy instantiation."""
        self._factory[name] = provider_class
        logger.debug("Provider class registered: %s", name)

    def register_instance(self, name: str, provider: ProviderBase) -> None:
        """Register a pre-configured provider instance."""
        self._providers[name] = provider
        logger.debug("Provider instance registered: %s → %s", name, provider)

    def get(self, name: str) -> ProviderBase:
        """Retrieve a provider by name."""
        if name in self._providers:
            return self._providers[name]
        raise KeyError(f"Provider not found: '{name}'. Available: {list(self.available)}")

    def create(self, name: str, config: ProviderConfig) -> ProviderBase:
        """Create a provider instance from a registered class."""
        if name not in self._factory:
            raise KeyError(
                f"Provider class not registered: '{name}'. "
                f"Available: {list(self._factory.keys())}"
            )
        provider = self._factory[name](config)
        self._providers[name] = provider
        return provider

    @property
    def available(self) -> list[str]:
        """List available provider names."""
        return list(set(list(self._providers.keys()) + list(self._factory.keys())))

    def __contains__(self, name: str) -> bool:
        return name in self._providers or name in self._factory
