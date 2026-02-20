"""
SwarmX Anthropic Provider — Adapter for Anthropic's Claude API.

Supports Claude 3.5, Claude 3 (Opus, Sonnet, Haiku), and future models.
Handles Anthropic's unique message format (system prompt is separate from messages).
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

logger = logging.getLogger("swarmx.providers.anthropic")


class AnthropicProvider(ProviderBase):
    """
    Anthropic/Claude provider adapter.

    Wraps the anthropic Python SDK. Handles the key difference
    that Anthropic takes the system prompt as a separate parameter
    rather than as a message in the conversation.
    """

    def __init__(self, config: ProviderConfig) -> None:
        super().__init__(config)
        self._name = "Anthropic"

        if not config.model:
            config.model = "claude-sonnet-4-20250514"

        try:
            from anthropic import AsyncAnthropic

            client_kwargs: dict[str, Any] = {
                "api_key": config.api_key or None,
                "timeout": config.timeout,
            }
            if config.base_url:
                client_kwargs["base_url"] = config.base_url

            self._client = AsyncAnthropic(**client_kwargs)
        except ImportError:
            raise ImportError(
                "Anthropic provider requires the 'anthropic' package. "
                "Install it with: pip install anthropic"
            )

    def _prepare_messages(
        self, messages: list[Message]
    ) -> tuple[str, list[dict[str, Any]]]:
        """
        Separate system prompt from conversation messages.

        Anthropic requires system messages to be passed separately.
        Returns (system_prompt, conversation_messages).
        """
        system_prompt = ""
        conversation: list[dict[str, Any]] = []

        for msg in messages:
            if msg.role == Role.SYSTEM:
                system_prompt += msg.content + "\n"
            else:
                role = "user" if msg.role == Role.USER else "assistant"
                conversation.append({
                    "role": role,
                    "content": msg.content,
                })

        return system_prompt.strip(), conversation

    async def complete(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> CompletionResponse:
        """Send messages to Anthropic and return a standardized response."""
        model = kwargs.pop("model", self.config.model)
        temperature = kwargs.pop("temperature", self.config.temperature)
        max_tokens = kwargs.pop("max_tokens", self.config.max_tokens)

        system_prompt, conversation = self._prepare_messages(messages)

        request_kwargs: dict[str, Any] = {
            "model": model,
            "messages": conversation,
            "max_tokens": max_tokens,
            "temperature": temperature,
            **kwargs,
        }

        if system_prompt:
            request_kwargs["system"] = system_prompt

        if tools:
            # Convert OpenAI-style tool definitions to Anthropic format
            anthropic_tools = []
            for tool in tools:
                if "function" in tool:
                    func = tool["function"]
                    anthropic_tools.append({
                        "name": func["name"],
                        "description": func.get("description", ""),
                        "input_schema": func.get("parameters", {}),
                    })
                else:
                    anthropic_tools.append(tool)
            request_kwargs["tools"] = anthropic_tools

        response = await self._client.messages.create(**request_kwargs)

        # Extract text content
        content = ""
        tool_calls = None
        for block in response.content:
            if block.type == "text":
                content += block.text
            elif block.type == "tool_use":
                if tool_calls is None:
                    tool_calls = []
                tool_calls.append({
                    "id": block.id,
                    "type": "function",
                    "function": {
                        "name": block.name,
                        "arguments": str(block.input),
                    },
                })

        return CompletionResponse(
            message=Message(
                role=Role.ASSISTANT,
                content=content,
                tool_calls=tool_calls,
            ),
            finish_reason=response.stop_reason or "end_turn",
            usage={
                "prompt_tokens": response.usage.input_tokens,
                "completion_tokens": response.usage.output_tokens,
                "total_tokens": response.usage.input_tokens + response.usage.output_tokens,
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
        """Stream completion tokens from Anthropic."""
        model = kwargs.pop("model", self.config.model)
        temperature = kwargs.pop("temperature", self.config.temperature)
        max_tokens = kwargs.pop("max_tokens", self.config.max_tokens)

        system_prompt, conversation = self._prepare_messages(messages)

        request_kwargs: dict[str, Any] = {
            "model": model,
            "messages": conversation,
            "max_tokens": max_tokens,
            "temperature": temperature,
            **kwargs,
        }

        if system_prompt:
            request_kwargs["system"] = system_prompt

        async with self._client.messages.stream(**request_kwargs) as stream:
            async for text in stream.text_stream:
                yield text
