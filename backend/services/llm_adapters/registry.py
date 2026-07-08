"""Adapter registry — maps `api_type` strings onto the
`LlmAdapter` instance that handles that provider.

To register a new provider:
  1. Implement `LlmAdapter` in a new module in this package (see
     `base.py` for the architecture).
  2. Import the adapter class here and add an instance to
     `_ADAPTERS`. That's it — callers automatically pick it up
     via `get_adapter(api_type)`.

Why instances rather than classes:
  Adapters are stateless service objects; one shared instance per
  provider is enough and avoids constructing a new adapter on
  every request. If a future provider needs per-request state,
  the adapter's methods can create it locally.
"""
from typing import Dict, List

from .base import LlmAdapter
from .lmstudio_rest_v1 import LmStudioRestV1Adapter
from .openai_compatible import OpenAiCompatibleAdapter
from .openrouter import OpenRouterAdapter


# api_type → adapter instance
_ADAPTERS: Dict[str, LlmAdapter] = {
    LmStudioRestV1Adapter.api_type: LmStudioRestV1Adapter(),
    OpenAiCompatibleAdapter.api_type: OpenAiCompatibleAdapter(),
    OpenRouterAdapter.api_type: OpenRouterAdapter(),
    # Future:
    #   AnthropicAdapter.api_type:        AnthropicAdapter(),
}


def get_adapter(api_type: str) -> LlmAdapter | None:
    """Return the adapter for `api_type`, or None if the
    `api_type` isn't registered. Callers translate None into the
    appropriate HTTP error (typically 501 Not Implemented for
    chat-related operations)."""
    return _ADAPTERS.get(api_type)


def list_adapters() -> List[str]:
    """List every registered `api_type`. Useful for diagnostic
    endpoints / smoke tests."""
    return sorted(_ADAPTERS.keys())
