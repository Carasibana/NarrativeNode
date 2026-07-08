"""LLM adapter interface — Phase 2.4a.

================================================================
ARCHITECTURE — HOW THIS PACKAGE WORKS
================================================================

The adapter package is the ONLY place in the backend that knows
the wire-level details of any specific AI provider. Every other
module (FastAPI routers, settings code, future chat features)
works exclusively against the abstract interface defined below.

  ┌──────────────────────┐     uses interface only
  │  routers/ai_chat.py  │ ──────────────────────────┐
  │  routers/ai_models.py│                           │
  └──────────────────────┘                           ▼
                                            ┌────────────────────┐
                                            │  base.py           │
                                            │  - LlmAdapter      │
                                            │  - DiscoveredModel │
                                            │  - ChatMessage     │
                                            │  - NormalisedEvent │
                                            └────────────────────┘
                                                     ▲
                                                     │ implements
              ┌───────────────────┬──────────────────┼─────────────────────┐
              │                   │                  │                     │
   ┌────────────────────┐ ┌──────────────────────┐  ┌──────────────────┐
   │ lmstudio_rest_v1.py│ │ openai_compatible.py │  │ anthropic.py     │
   │ (LM Studio REST v1)│ │ (future)             │  │ (future)         │
   └────────────────────┘ └──────────────────────┘  └──────────────────┘

Lookups go through `registry.py`:

    from services.llm_adapters.registry import get_adapter
    adapter = get_adapter(profile.api_type)   # by api_type string
    async for event in adapter.stream_chat(...):
        ...

----------------------------------------------------------------
HARD RULE
----------------------------------------------------------------
NO provider-specific code may live OUTSIDE this package.
That includes:
  * URL paths (`/api/v1/chat`, `/v1/models`, etc.)
  * Request body shapes (`input` field name, content-parts format,
    `system_prompt` vs `messages` differences, etc.)
  * Authentication conventions (`Authorization: Bearer` vs
    `x-api-key`, `anthropic-version` header, etc.)
  * Streaming event names (`message.delta`, `chat.completion.chunk`,
    `content_block_delta`, etc.)
  * Provider-specific features (LM Studio `ephemeral_mcp`
    integrations, OpenAI tool calls, Anthropic prompt caching, …).

If you find yourself reaching for an `if api_type == "lmstudio_rest_v1":`
branch anywhere outside this package — STOP. That logic belongs in
an adapter method, with all sibling adapters implementing the same
method. The caller never knows which provider it's talking to.

----------------------------------------------------------------
ADDING A NEW PROVIDER (procedure)
----------------------------------------------------------------
1. Create a new file in this package (e.g. `openai_compatible.py`).
2. Subclass `LlmAdapter` and set `api_type` to the literal string
   that will appear in `AiProviderProfile.api_type`.
3. Implement all `@abstractmethod`s. The method bodies are where
   you put every URL, header, payload shape, and event-translation
   detail for the new provider.
4. Register an instance in `registry.py` by adding it to
   `_ADAPTERS`.
5. Add the matching literal to
   `backend/models/user_preferences.py:AiProviderProfile.api_type`'s
   Literal type so the schema accepts it.
6. Optionally surface a default base URL + UI label in the
   frontend's `API_TYPE_OPTIONS` / `DEFAULT_BASE_URL_BY_API_TYPE`
   (`McpAndApiConnectionsTab.jsx`) — these are UI defaults only,
   not protocol details.

Nothing in `routers/ai_chat.py`, `routers/ai_models.py`, or any
chat-panel UI needs to change. They look the new adapter up by
`api_type` via the registry and call the same interface methods.

----------------------------------------------------------------
KEY DESIGN CONTRACTS
----------------------------------------------------------------
* **History flattening lives in the adapter.** Callers always
  pass a `List[ChatMessage]` with the provider-agnostic
  `{role, content: str}` shape. The adapter is responsible for
  translating that into whatever its wire format demands
  (LM Studio's flat content-parts array, OpenAI's `messages`,
  Anthropic's `messages` + separate `system`, …).

* **Errors are events, not exceptions.** `stream_chat` yields a
  final `NormalisedEvent(type='error', detail=...)` rather than
  raising. The HTTP layer surfaces this verbatim through the SSE
  stream, so the chat panel handles upstream failures the same
  way as any other event. Discovery and test-connection methods
  follow their own contracts (see method docstrings).

* **Cancellation is cooperative.** The router passes a
  `CancellationProbe` coroutine into `stream_chat`. The adapter
  awaits it between upstream reads; when it returns True (writer
  hit Cancel, browser tab closed, etc.) the adapter tears down
  its upstream connection and returns. No `Request` object
  reaches the adapter — keeps FastAPI out of provider code.

* **MCP is opt-in per call.** The router resolves whether MCP
  tool access is enabled (`profile.lmstudio_mcp_enabled === True`
  for now; extends to other providers when supported) and passes
  the MCP server URL or `None`. Adapters that don't support MCP
  ignore the argument entirely; adapters that do (LM Studio
  native) inject the right integration payload into their
  request body. The router never knows the wire format.
"""
from abc import ABC, abstractmethod
from typing import Any, Awaitable, Callable, Dict, List, Literal, Optional, AsyncIterator

from pydantic import BaseModel


# ── Shared cross-provider types ──────────────────────────────────


class DiscoveredModel(BaseModel):
    """Normalised cross-provider model entry. `id` is always the raw
    model identifier used for completion requests; the optional
    fields are populated only by providers that return them.

    `capabilities` (existing free-form tag list) carries provider-
    specific descriptive metadata for display in the model picker —
    LM Studio puts `type` + `arch` in here (e.g. `["llm", "gemma3"]`),
    OpenAI-compatible leaves it None. Not used for routing decisions.

    The structured `input_modalities` / `output_modalities` /
    `supports_tool_use` fields are what downstream features (file
    attachment, future MCP gating, etc.) consume to decide whether
    a given model can accept a given input type. Modality enum
    mirrors OpenRouter's vocabulary: `text`, `image`, `file`,
    `audio`, `video` (input) and `text`, `image`, `embeddings`,
    `audio`, `video`, `rerank`, `speech`, `transcription` (output).
    `None` means the adapter couldn't determine the capability —
    callers should default to text-only in that case rather than
    assume any extra capability."""
    id: str
    display_name: Optional[str] = None
    publisher: Optional[str] = None
    capabilities: Optional[List[str]] = None
    params_string: Optional[str] = None
    input_modalities: Optional[List[str]] = None
    output_modalities: Optional[List[str]] = None
    supports_tool_use: Optional[bool] = None
    supports_reasoning: Optional[bool] = None
    # Phase 3.10 Layer 5 — model's input context window in tokens
    # when the provider exposes it. Populated by adapters that can
    # read the field from their respective `/models` endpoints:
    # LM Studio (`max_context_length`), OpenRouter (`context_length`).
    # Stays `None` for providers that don't publish it via the API
    # (Anthropic, OpenAI, generic openai_compatible). Downstream code
    # treats `None` as "unknown, use conservative default" per the
    # planning doc's no-hard-coded-model-table decision.
    context_window: Optional[int] = None
    # Phase 2.5f — per-model reasoning level catalogue. Exactly one
    # of the two fields is populated when reasoning is supported;
    # the other stays None.
    #
    # `reasoning_options` — word-based effort enum (LM Studio,
    # OpenRouter, openai_compatible). Strings in slider order; the
    # literal `"off"` value is kept in the catalogue when the model
    # declares it (LM Studio surfaces it) so consumers see the
    # complete declared set, but the UI filters it out at render
    # time because the reasoning button handles off-state.
    #
    # `reasoning_budget_range` — numeric token-budget range for
    # adapters that take a budget instead of an effort enum
    # (Anthropic extended thinking, when that adapter ships).
    # Shape `{"min": 1024, "max": <model cap>}`.
    reasoning_options: Optional[List[str]] = None
    reasoning_budget_range: Optional[Dict[str, int]] = None
    # Phase 2.5f — model's declared default reasoning value, when
    # the upstream exposes one. Drives the chat panel's
    # model-default hint animation when the writer switches models.
    # See `ModelCapabilities.reasoning_default` for full semantics.
    reasoning_default: Optional[str] = None


class ChatAttachment(BaseModel):
    """One file attached to a chat message. Encoded by the frontend
    into base64 before the request reaches the backend so the wire
    shape stays JSON-clean (no multipart needed for the chat path).

    Fields:
      * `kind` — one of the three buckets the picker classifies into:
        `text` (inlined as plain-text preamble in the user message,
        universal across adapters), `image` (binary, routed to the
        adapter's vision content-part shape), `file` (binary,
        currently PDFs only; routed to the adapter's file content-
        part shape on adapters that support it).
      * `name` — original filename, used as display label and the
        `filename` field on OpenAI's file content part.
      * `mime_type` — picked up from the browser File.type or
        derived from the extension; embedded in the `data:` URL
        prefix the adapter builds.
      * `data_base64` — bare base64 string (no `data:` prefix); the
        adapter prepends `data:<mime>;base64,` when assembling the
        data URL the upstream wants. Frontend image preprocessing
        (resize + re-encode) happens before this base64 is built,
        so the bytes here are already the post-resize payload.
    """
    kind: Literal["text", "image", "file"]
    name: str
    mime_type: str
    data_base64: str = ""
    # Phase 2.5e — assistant-image roll-forward. When a persisted
    # assistant image rides this turn's history with the upstream's
    # ORIGINAL hosted URL (the model returned a URL rather than raw
    # bytes), the wire builder forwards the URL verbatim by setting
    # `wire_url` instead of re-encoding bytes we don't have. When
    # set, the adapter uses this string directly in the `image_url`
    # content part and ignores `data_base64`. Empty / None on every
    # user-side attachment and on assistant images whose upstream
    # emitted raw bytes (those ride `data_base64` like normal).
    wire_url: Optional[str] = None


class ChatMessage(BaseModel):
    """Provider-agnostic single message in a conversation history.
    Adapters translate this into their native payload shape before
    sending — e.g. LM Studio's flat content-parts array.

    `attachments` is populated on the latest user message only when
    the writer attached files to the outgoing turn (paperclip picker
    or drag-drop). Older user/assistant turns and system messages
    always have an empty list — attachments are session-only and
    never persisted into history."""
    role: Literal["user", "assistant", "system"]
    content: str
    attachments: List[ChatAttachment] = []


class NormalisedEvent(BaseModel):
    """One step of a streaming chat response, after the adapter has
    translated its provider-native event into the cross-provider
    shape. The chat panel consumes this without knowing which
    provider produced it.

    Fields by `type`:
      * `start`       — message_id (optional)
      * `delta`       — text (the new token chunk; never empty)
      * `end`         — text (full accumulated text or empty),
                        finish_reason (optional), message_id (optional)
      * `error`       — detail (human-readable error message)
      * `tool_call`   — tool_call_id (correlation handle, stable
                        across phases of the same call),
                        tool_call_phase (start | arguments | success
                        | failure), tool_name, plus optional payload
                        fields the adapter fills as the phases
                        progress: tool_provider_type,
                        tool_server_label, tool_plugin_id,
                        tool_arguments, tool_output, tool_error_reason,
                        tool_error_type. The chat panel folds these
                        into a per-message `tool_calls` list that
                        gets persisted alongside the assistant reply.
      * `image`       — image_data_url (display copy — always a
                        `data:image/...;base64,...` string, locally
                        downloaded if the upstream emitted a hosted
                        URL), image_wire_url (original shape from
                        the upstream — either the same data URL or
                        the hosted https:// URL the model returned;
                        re-sent verbatim on subsequent turns so
                        we never re-encode bytes the model already
                        gave us), image_mime_type. One event per
                        image; multiple images in one chunk emit
                        multiple events.
      * `reasoning_delta` — text (the new reasoning chunk; never
                        empty). One per streamed reasoning chunk.
                        Frontend accumulates onto the assistant
                        message's `reasoning_text` field for the
                        bubble's Thinking disclosure widget.
                        Reasoning content is per-turn ephemeral on
                        the wire: persisted on the assistant message
                        for display only, never re-sent on
                        subsequent turns (cross-adapter contract;
                        Anthropic + tool_use is the one exception,
                        handled inside that adapter).
      * `reasoning_end` — terminal signal that the reasoning stream
                        for this turn is complete. Optional `text`
                        (full accumulated reasoning if the adapter
                        wants to ship it consolidated),
                        reasoning_token_count (when the upstream
                        reports it via usage / response metadata),
                        reasoning_duration_ms (the adapter
                        measures wall-clock time between the first
                        reasoning_delta and the terminal event).
                        Frontend uses this to stop the streaming
                        animation and reveal the duration / token
                        metadata in the disclosure header.
    """
    type: Literal["start", "delta", "end", "error", "tool_call", "image", "reasoning_delta", "reasoning_end"]
    text: Optional[str] = None
    message_id: Optional[str] = None
    finish_reason: Optional[str] = None
    detail: Optional[str] = None
    # Tool-call fields. Only meaningful when `type == 'tool_call'`.
    tool_call_id: Optional[str] = None
    tool_call_phase: Optional[Literal["start", "arguments", "success", "failure"]] = None
    tool_name: Optional[str] = None
    tool_provider_type: Optional[str] = None
    tool_server_label: Optional[str] = None
    tool_plugin_id: Optional[str] = None
    tool_arguments: Optional[dict] = None
    tool_output: Optional[str] = None
    tool_error_reason: Optional[str] = None
    tool_error_type: Optional[str] = None
    # Image fields (Phase 2.5e). Only meaningful when `type == 'image'`.
    # `image_data_url` is the local copy used for chat-bubble display
    # and the Media Preview Panel — always a `data:` URL even when
    # the upstream emitted a hosted URL (we download server-side and
    # encode). `image_wire_url` is what the chat panel re-sends back
    # to the model on subsequent turns (history forwarding): if the
    # upstream gave us a hosted URL we ship that URL back; if it gave
    # us a data URL we ship the data URL back. Avoids re-encoding
    # bytes the model already provided. `image_mime_type` is sniffed
    # from the data URL prefix or the Content-Type response header.
    image_data_url: Optional[str] = None
    image_wire_url: Optional[str] = None
    image_mime_type: Optional[str] = None
    # Reasoning fields (Phase 2.5f). Only meaningful when
    # `type == 'reasoning_delta'` (`text` carries the chunk) or
    # `type == 'reasoning_end'` (`text` optional consolidated body,
    # plus the optional metadata below from upstream `usage` /
    # response metadata where reported). Adapters that don't have
    # the data leave them None and the frontend renders the
    # disclosure header with whatever fields ARE present.
    reasoning_token_count: Optional[int] = None
    reasoning_duration_ms: Optional[int] = None
    # Prompt-cache reporting (Phase 2.5i). Only meaningful on the
    # `end` event; carries the count of prompt-input tokens served
    # from the upstream's prompt cache on this turn.
    #
    # Reading sources by adapter (read at the final usage chunk;
    # all routes require `stream_options: {include_usage: true}`,
    # which is already set on the OpenAI-compat and OpenRouter
    # adapters for reasoning-token plumbing):
    #   - openai_compatible.py → `usage.prompt_tokens_details.cached_tokens`
    #     (automatic caching kicks in at ≥1024-token prompts; field is 0
    #     when no hit or when prompt is below that minimum).
    #   - openrouter.py → `usage.cache_read_input_tokens` (the
    #     OpenRouter-normalised read-count across providers; mirrors
    #     OpenAI's `cached_tokens` when routing to OpenAI / DeepSeek
    #     and reports Anthropic-native cache reads when routing to
    #     Claude). The companion `usage.cache_creation_input_tokens`
    #     (Anthropic cache writes) is also reported by OpenRouter
    #     but isn't surfaced through this field — it represents
    #     a one-time cost we already paid, not ongoing reuse.
    #   - lmstudio_rest_v1.py → not populated. Local KV-cache reuse
    #     is automatic but lmstudio-bug-tracker #778 keeps the
    #     `cached_tokens` field at zero on `/v1/chat/completions`
    #     even when caching is active.
    cached_input_tokens: Optional[int] = None


def extract_cached_input_tokens(usage) -> Optional[int]:
    """Read the count of cached (reused) prompt tokens from a streaming
    `usage` object, spanning the differing field names providers use:
      - `cache_read_input_tokens` (Anthropic-native / OpenRouter-normalised)
      - `prompt_tokens_details.cached_tokens` (OpenAI shape; auto-caches at
        prompts >= 1024 tokens)
      - `prompt_cache_hit_tokens` (DeepSeek)
    Returns the first present integer, or None when none is reported. This
    is the single place to add a new provider's cache field so every adapter
    that calls it picks the field up at once."""
    if not isinstance(usage, dict):
        return None
    direct = usage.get("cache_read_input_tokens")
    if isinstance(direct, int):
        return direct
    details = usage.get("prompt_tokens_details")
    if isinstance(details, dict) and isinstance(details.get("cached_tokens"), int):
        return details["cached_tokens"]
    hit = usage.get("prompt_cache_hit_tokens")
    if isinstance(hit, int):
        return hit
    return None


# Async callable the adapter polls to know when the downstream
# (e.g. the browser) has disconnected. Lets adapters tear down
# their upstream connection promptly on cancellation without ever
# importing FastAPI types.
CancellationProbe = Callable[[], Awaitable[bool]]


# ── Adapter interface ───────────────────────────────────────────


class LlmAdapter(ABC):
    """Interface every provider adapter implements. Subclass and
    set `api_type` to the literal string used in
    `AiProviderProfile.api_type`; the registry indexes adapters by
    that field."""

    api_type: str = ""  # subclasses override
    # Whether this adapter wires NarrativeNode's MCP server into
    # its upstream's tool-calling channel when the connection profile
    # has `mcp_enabled: true`. The router checks this attribute
    # alongside the profile flag before resolving an MCP URL to pass
    # in. Adapters that don't support MCP just ignore the URL
    # argument entirely (interface contract — but advertising the
    # support here lets the chat router AND the UI hide the toggle
    # cleanly without per-adapter `if api_type == ...` branches).
    supports_mcp: bool = False

    # ── Base URL normalisation ─────────────────────────────────

    @classmethod
    def normalise_base_url(cls, url: str) -> str:
        """Trim a writer-entered base URL into the form this adapter
        expects (the bit BEFORE any of the `/v1/...` paths the
        adapter appends itself). Default implementation just strips
        trailing whitespace + slashes; provider-specific subclasses
        override to also trim documented suffixes the writer might
        paste (e.g. `/v1`, `/v1/chat/completions`).

        Called from the user-preferences save path so what's persisted
        is always in the canonical form the adapter expects. Returning
        the input unchanged is fine — the caller compares against the
        original to decide whether to surface a "we trimmed your URL"
        hint to the writer."""
        return (url or "").strip().rstrip("/")

    # ── Discovery / Test connection ────────────────────────────

    @abstractmethod
    async def discover_models(
        self,
        base_url: str,
        api_key: Optional[str],
    ) -> List[DiscoveredModel]:
        """List models the writer can pick from. Raises any error
        upstream returned — the caller translates to HTTP errors."""

    @abstractmethod
    async def test_chat_endpoint(
        self,
        base_url: str,
        api_key: Optional[str],
    ) -> tuple[bool, Optional[str]]:
        """Fallback connection probe used when discover_models()
        fails. Should hit the provider's chat endpoint with a
        minimal payload and report whether it's reachable + auth
        is accepted. Returns (ok, error_message). Auth failures
        (401 / 403) and 404s should return False with a useful
        message."""

    # ── Chat ───────────────────────────────────────────────────

    @abstractmethod
    def stream_chat(
        self,
        *,
        base_url: str,
        api_key: Optional[str],
        model: str,
        messages: List[ChatMessage],
        system_prompt: Optional[str],
        mcp_server_url: Optional[str],
        is_cancelled: CancellationProbe,
        model_capabilities: Optional[Any] = None,
        capability_sink: Optional[Callable[..., None]] = None,
        reasoning_level: Optional[Any] = None,
        reasoning_summary: Optional[str] = None,
        max_tool_rounds: Optional[int] = None,
    ) -> AsyncIterator[NormalisedEvent]:
        """Open a streaming chat request and yield normalised
        events as the response arrives.

        `max_tool_rounds` is the per-connection ceiling on tool-call
        rounds within a single chat turn — overrides the adapter's
        built-in default when set. None → use adapter's default. 0 →
        no limit (treated as ~10_000 rounds in practice). Only
        meaningful when the adapter advertises `supports_mcp=True`
        and the writer has enabled MCP for this connection.

        `mcp_server_url` is None when the writer hasn't enabled
        MCP tool access for this connection (or when the provider
        doesn't support it). Adapters that DO support MCP
        integration include it in their request payload; others
        ignore it.

        `is_cancelled` is a coroutine the adapter awaits between
        upstream reads — when it returns True, the adapter should
        stop pumping the upstream and exit cleanly.

        `model_capabilities` carries the cached per-model capability
        record from the profile (`ModelCapabilities` object — Any-
        typed here to keep this module free of pydantic-model
        imports beyond `ChatMessage`). Adapters use it to short-
        circuit known-incompatible wire shapes — e.g. skip the
        `type:"file"` attempt when the upstream has previously
        rejected it. None means no prior capability data; adapters
        should try the spec-correct shape first.

        `capability_sink` is an optional `(model_id, key, value)`
        callable the adapter invokes when runtime detection
        discovers a capability fact worth persisting (e.g. the
        upstream rejected `type:"file"` and we successfully
        fell back). The router's implementation writes the value
        to the profile's `model_capabilities[model_id]` and
        persists user_preferences. Adapters that have no runtime-
        detected capabilities to surface can ignore the sink.

        `reasoning_level` is the writer's chosen reasoning effort
        for this send (Phase 2.5f). `None` means reasoning is off /
        the field should be omitted from the outgoing request. A
        string value (e.g. `"low"` / `"medium"` / `"high"`) means
        the writer turned reasoning on at that effort tier — the
        adapter translates it into its native wire field name
        (`reasoning` for LM Studio, `reasoning.effort` for
        OpenRouter, `reasoning_effort` for openai_compatible). An
        integer value is the numeric token budget for adapters
        that take a budget instead of an enum (Anthropic, when it
        ships).

        `reasoning_summary` is OpenRouter-specific — controls the
        `reasoning.summary` verbosity field. `None` means omit
        the field (default behaviour, no extra summarisation
        tokens). Adapters other than OpenRouter ignore this
        argument.

        Errors should be yielded as a final
        `NormalisedEvent(type='error', detail=...)` rather than
        raised — keeps the consumer's contract uniform."""
