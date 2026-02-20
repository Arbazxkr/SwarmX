"""
SwarmX xAI Provider — Adapter for xAI's Grok API.

Supports Grok-2, Grok-1, and future models. The xAI API is
OpenAI-compatible, so this provider leverages the openai SDK
with a custom base_url.
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

logger = logging.getLogger("swarmx.providers.xai")

XAI_BASE_URL = "https://api.x.ai/v1"


class XAIProvider(ProviderBase):
    """
    xAI/Grok provider adapter.

    Uses the OpenAI-compatible API at api.x.ai. Because the API
    is OpenAI-compatible, this provider reuses the openai SDK
    with a custom base URL.
    """

    def __init__(self, config: ProviderConfig) -> None:
        super().__init__(config)
        self._name = "xAI"

        if not config.model:
            config.model = "grok-2-latest"

        if not config.base_url:
            config.base_url = XAI_BASE_URL

        try:
            from openai import AsyncOpenAI

            self._client = AsyncOpenAI(
                api_key=config.api_key or None,
                base_url=config.base_url,
                timeout=config.timeout,
            )
        except ImportError:
            raise ImportError(
                "xAI provider requires the 'openai' package (OpenAI-compatible API). "
                "Install it with: pip install openai"
            )

    def _to_messages(self, messages: list[Message]) -> list[dict[str, Any]]:
        """Convert SwarmX messages to OpenAI-compatible format."""
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
        """Send messages to xAI/Grok and return a standardized response."""
        model = kwargs.pop("model", self.config.model)
        temperature = kwargs.pop("temperature", self.config.temperature)
        max_tokens = kwargs.pop("max_tokens", self.config.max_tokens)

        request_kwargs: dict[str, Any] = {
            "model": model,
            "messages": self._to_messages(messages),
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
        """Stream completion tokens from xAI/Grok."""
        model = kwargs.pop("model", self.config.model)
        temperature = kwargs.pop("temperature", self.config.temperature)
        max_tokens = kwargs.pop("max_tokens", self.config.max_tokens)

        request_kwargs: dict[str, Any] = {
            "model": model,
            "messages": self._to_messages(messages),
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
