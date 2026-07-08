"""LLM adapter package. See `base.py` for the architecture and the
hard rule about where provider-specific code is allowed to live.
Public surface re-exported here so callers can do:

    from services.llm_adapters import get_adapter, ChatMessage
"""
from .base import (
    CancellationProbe,
    ChatMessage,
    DiscoveredModel,
    LlmAdapter,
    NormalisedEvent,
)
from .registry import get_adapter, list_adapters

__all__ = [
    "CancellationProbe",
    "ChatMessage",
    "DiscoveredModel",
    "LlmAdapter",
    "NormalisedEvent",
    "get_adapter",
    "list_adapters",
]
