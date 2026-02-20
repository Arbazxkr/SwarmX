"""
SwarmX OpenAI Provider — Adapter for OpenAI's API.

Supports GPT-4o, GPT-4, GPT-3.5-turbo, and any OpenAI-compatible model.
Also supports function/tool calling for agentic workflows.
"""

from __future__ import annotations

import logging
from typing import Any, AsyncIterator

from swarmx.core.provider import (
    CompletionResponse,
    Message,
    ProviderBase,
    ProviderConfig,
    Role,
)

logger = logging.getLogger("swarmx.providers.openai")


class OpenAIProvider(ProviderBase):
    """
    OpenAI provider adapter.

    Wraps the openai Python SDK to provide completions through the
    SwarmX provider interface.
    """

    def __init__(self, config: ProviderConfig) -> None:
        super().__init__(config)
        self._name = "OpenAI"

        if not config.model:
            config.model = "gpt-4o"

        try:
            from openai import AsyncOpenAI

            client_kwargs: dict[str, Any] = {
                "api_key": config.api_key or None,
                "timeout": config.timeout,
            }
            if config.base_url:
                client_kwargs["base_url"] = config.base_url

            self._client = AsyncOpenAI(**client_kwargs)
        except ImportError:
            raise ImportError(
                "OpenAI provider requires the 'openai' package. "
                "Install it with: pip install openai"
            )

    def _to_openai_messages(self, messages: list[Message]) -> list[dict[str, Any]]:
        """Convert SwarmX messages to OpenAI format."""
        result = []
        for msg in messages:
            entry: dict[str, Any] = {
                "role": msg.role.value,
                "content": msg.content,
            }
            if msg.name:
                entry["name"] = msg.name
            if msg.tool_calls:
                entry["tool_calls"] = msg.tool_calls
            if msg.tool_call_id:
                entry["tool_call_id"] = msg.tool_call_id
            result.append(entry)
        return result

    async def complete(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> CompletionResponse:
        """Send messages to OpenAI and return a standardized response."""
        model = kwargs.pop("model", self.config.model)
        temperature = kwargs.pop("temperature", self.config.temperature)
        max_tokens = kwargs.pop("max_tokens", self.config.max_tokens)

        request_kwargs: dict[str, Any] = {
            "model": model,
            "messages": self._to_openai_messages(messages),
            "temperature": temperature,
            "max_tokens": max_tokens,
            **kwargs,
        }

        if tools:
            request_kwargs["tools"] = tools

        response = await self._client.chat.completions.create(**request_kwargs)

        choice = response.choices[0]
        message = choice.message

        # Convert tool calls if present
        tool_calls = None
        if message.tool_calls:
            tool_calls = [
                {
                    "id": tc.id,
                    "type": tc.type,
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                }
                for tc in message.tool_calls
            ]

        return CompletionResponse(
            message=Message(
                role=Role.ASSISTANT,
                content=message.content or "",
                tool_calls=tool_calls,
            ),
            finish_reason=choice.finish_reason or "stop",
            usage={
                "prompt_tokens": response.usage.prompt_tokens if response.usage else 0,
                "completion_tokens": response.usage.completion_tokens if response.usage else 0,
                "total_tokens": response.usage.total_tokens if response.usage else 0,
            },
            raw_response=response,
            model=model,
        )

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        """Stream completion tokens from OpenAI."""
        model = kwargs.pop("model", self.config.model)
        temperature = kwargs.pop("temperature", self.config.temperature)
        max_tokens = kwargs.pop("max_tokens", self.config.max_tokens)

        request_kwargs: dict[str, Any] = {
            "model": model,
            "messages": self._to_openai_messages(messages),
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,
            **kwargs,
        }

        if tools:
            request_kwargs["tools"] = tools

        stream = await self._client.chat.completions.create(**request_kwargs)

        async for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content
