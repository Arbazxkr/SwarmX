"""
SwarmX Google Provider — Adapter for Google's Generative AI API (Gemini).

Supports Gemini 2.0, Gemini 1.5, and future models via the
google-genai SDK.
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

logger = logging.getLogger("swarmx.providers.google")


class GoogleProvider(ProviderBase):
    """
    Google Generative AI (Gemini) provider adapter.

    Wraps the google-genai SDK to provide completions through the
    SwarmX provider interface.
    """

    def __init__(self, config: ProviderConfig) -> None:
        super().__init__(config)
        self._name = "Google"

        if not config.model:
            config.model = "gemini-2.0-flash"

        try:
            from google import genai

            self._genai = genai
            self._client = genai.Client(api_key=config.api_key or None)
        except ImportError:
            raise ImportError(
                "Google provider requires the 'google-genai' package. "
                "Install it with: pip install google-genai"
            )

    def _to_gemini_contents(
        self, messages: list[Message]
    ) -> tuple[str | None, list[dict[str, Any]]]:
        """
        Convert SwarmX messages to Gemini format.

        Returns (system_instruction, contents).
        Gemini uses 'user' and 'model' roles (not 'assistant').
        """
        system_instruction = None
        contents: list[dict[str, Any]] = []

        for msg in messages:
            if msg.role == Role.SYSTEM:
                system_instruction = msg.content
            elif msg.role == Role.USER:
                contents.append({
                    "role": "user",
                    "parts": [{"text": msg.content}],
                })
            elif msg.role == Role.ASSISTANT:
                contents.append({
                    "role": "model",
                    "parts": [{"text": msg.content}],
                })

        return system_instruction, contents

    async def complete(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> CompletionResponse:
        """Send messages to Gemini and return a standardized response."""
        model = kwargs.pop("model", self.config.model)
        temperature = kwargs.pop("temperature", self.config.temperature)
        max_tokens = kwargs.pop("max_tokens", self.config.max_tokens)

        system_instruction, contents = self._to_gemini_contents(messages)

        # Build generation config
        generation_config = {
            "temperature": temperature,
            "max_output_tokens": max_tokens,
        }

        config_obj = self._genai.types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=temperature,
            max_output_tokens=max_tokens,
        )

        response = await self._client.aio.models.generate_content(
            model=model,
            contents=contents,
            config=config_obj,
        )

        # Extract text
        content = ""
        if response.text:
            content = response.text

        # Extract usage
        usage = {}
        if response.usage_metadata:
            usage = {
                "prompt_tokens": response.usage_metadata.prompt_token_count or 0,
                "completion_tokens": response.usage_metadata.candidates_token_count or 0,
                "total_tokens": response.usage_metadata.total_token_count or 0,
            }

        return CompletionResponse(
            message=Message(role=Role.ASSISTANT, content=content),
            finish_reason="stop",
            usage=usage,
            raw_response=response,
            model=model,
        )

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        """Stream completion tokens from Gemini."""
        model = kwargs.pop("model", self.config.model)
        temperature = kwargs.pop("temperature", self.config.temperature)
        max_tokens = kwargs.pop("max_tokens", self.config.max_tokens)

        system_instruction, contents = self._to_gemini_contents(messages)

        config_obj = self._genai.types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=temperature,
            max_output_tokens=max_tokens,
        )

        async for chunk in await self._client.aio.models.generate_content_stream(
            model=model,
            contents=contents,
            config=config_obj,
        ):
            if chunk.text:
                yield chunk.text
