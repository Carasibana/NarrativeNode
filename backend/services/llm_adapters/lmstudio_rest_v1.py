"""LM Studio REST v1 adapter — Phase 2.4a.

Owns every wire-level detail of talking to LM Studio's REST API v1
— LM Studio's own product name for the surface at `/api/v1/...`
(plus the older `/api/v0/...`), as opposed to the OpenAI-compatible
surface they also expose at `/v1/chat/completions` / `/v1/models`.
Nothing in this file leaks outside the adapter package — callers
go through `LlmAdapter` instead.

Endpoints used:
  * `GET  {base}/api/v0/models` — discovery (rich metadata)
  * `GET  {base}/v1/models`     — discovery fallback (older builds)
  * `POST {base}/api/v1/chat`   — streaming chat (REST v1)
  * `POST {base}/v1/chat/completions` — chat fallback used by the
                                       Test connection probe

LM Studio REST v1 quirks (per `.References/LM Studio API.md`):

  * The `input` field on POST /api/v1/chat is `string | array`.
    - String form: simplest single-user-turn shape. Used by every
      curl example in the docs.
    - Array form: each item is either a TEXT input
      (`{type: 'text', content: '...'}` per the curl examples
      around line 1448; older spec text on line 1283 also lists
      `type: 'message'` — both appear to be accepted but `text`
      matches the working example) or an IMAGE input
      (`{type: 'image', data_url: '...'}`).
    - The endpoint does NOT support including assistant messages
      in the request (comparison table line 113). Multi-turn
      stateless chat has to be flattened into one user turn;
      proper multi-turn requires `previous_response_id` stateful
      mode (deferred).

  * SSE event flow (per the streaming events section of the docs):
        chat.start
        [model_load.{start,progress,end}]
        [prompt_processing.{start,progress,end}]
        [reasoning.{start,delta,end}]
        [tool_call.{start,arguments,success|failure}]
        message.start, message.delta..., message.end (potentially
                                                       multiple cycles
                                                       if tool calls
                                                       interrupt)
        chat.end                            ← stream terminator

  * `message.delta` payload carries the token chunk DIRECTLY as
    `content` on the event object, not nested under a `delta`
    field. `message.end` does NOT end the stream; only `chat.end`
    does. `chat.end.result.output[]` is the aggregated final
    output, with items of type `'message' | 'tool_call' |
    'reasoning' | 'invalid_tool_call'`.

  * MCP tool access is enabled per request via the `integrations`
    array — see `_build_integrations` below. The endpoint
    documentation lists `ephemeral_mcp` and `plugin` as the two
    integration kinds; we use `ephemeral_mcp` pointing at
    NarrativeNode's MCP server.
"""
import asyncio
import json
import time
import uuid
from typing import Any, AsyncIterator, Callable, List, Optional

import httpx


def _now_ms() -> int:
    """Monotonic millisecond timestamp for measuring stream durations
    (reasoning stream wall-clock, etc.). Monotonic so clock drift /
    NTP adjustments mid-stream can't produce a negative duration."""
    return int(time.monotonic() * 1000)

from version import PROGRAM_VERSION

from .base import (
    CancellationProbe,
    ChatMessage,
    DiscoveredModel,
    LlmAdapter,
    NormalisedEvent,
)


_DISCOVERY_TIMEOUT_SECONDS = 15.0
_STREAM_TIMEOUT_SECONDS = 120.0

# NarrativeNode's MCP server as the writer registers it in their LM
# Studio `mcp.json`. LM Studio plugin ids are `owner/name`; the
# documented convention is to name the entry `narrativenode`, which LM
# Studio addresses as `mcp/narrativenode`. Hardcoded by convention (not
# per-connection) so the probe + chat integration agree.
NARRATIVENODE_PLUGIN_ID = "mcp/narrativenode"

# Identifies us in LM Studio's server logs and on any reverse
# proxy in front of it. Tracks the running version so installs
# don't blur together in the writer's logs.
_USER_AGENT = f"NarrativeNode/{PROGRAM_VERSION}"


class LmStudioRestV1Adapter(LlmAdapter):
    api_type = "lmstudio_rest_v1"
    supports_mcp = True

    # ── Base URL normalisation ─────────────────────────────────

    @classmethod
    def normalise_base_url(cls, url: str) -> str:
        """Trim any documented path suffix the writer may have pasted
        so what's persisted is the bare host. The adapter appends
        `/api/v1/chat` / `/api/v0/models` / `/v1/models` /
        `/v1/chat/completions` itself, so the base URL should end
        at the host.

        Catches mistakes like pasting the LM Studio docs' example URL
        in full (`http://localhost:1234/v1/chat/completions`) or
        trimming only part of it.
        """
        trimmed = (url or "").strip().rstrip("/")
        # Longest paths first so e.g. `/api/v1/chat/completions` (if
        # ever exposed) is matched before a shorter `/api/v1` substring.
        for suffix in (
            # LM Studio native REST surface
            "/api/v1/chat/completions",
            "/api/v1/embeddings",
            "/api/v1/responses",
            "/api/v1/models",
            "/api/v1/chat",
            "/api/v0/chat/completions",
            "/api/v0/embeddings",
            "/api/v0/models",
            "/api/v0/chat",
            "/api/v1",
            "/api/v0",
            # OpenAI-compat surface that LM Studio also exposes
            "/v1/chat/completions",
            "/v1/completions",
            "/v1/embeddings",
            "/v1/responses",
            "/v1/models",
            "/v1",
        ):
            if trimmed.endswith(suffix):
                trimmed = trimmed[: -len(suffix)]
                break
        return trimmed.rstrip("/")

    # ── Discovery / Test ───────────────────────────────────────

    async def discover_models(
        self,
        base_url: str,
        api_key: Optional[str],
    ) -> List[DiscoveredModel]:
        base = base_url.rstrip("/")
        headers = self._auth_headers(api_key)

        # Discovery endpoint preference, richest first:
        #   `/api/v1/models` — `{models: [{key, architecture, capabilities:{vision, trained_for_tool_use, reasoning}, ...}]}`
        #     The richest of the three. `capabilities.reasoning` is an
        #     object `{allowed_options, default}` (LM Studio 0.3.20+).
        #   `/api/v0/models` — `{data: [{id, arch, capabilities: ["tool_use", ...]}]}`
        #     Older native shape some 0.3.x builds still serve. Array-
        #     style capabilities; no reasoning surface.
        #   `/v1/models`     — OpenAI-compat `{data: [{id, object}]}`. No
        #     capabilities. Last-resort fallback used by non-LM-Studio
        #     servers a writer happened to label "lmstudio_rest_v1".
        for path, kind in (
            ("/api/v1/models", "lms_v1"),
            ("/api/v0/models", "lms_v0"),
            ("/v1/models",     "openai_compat"),
        ):
            url = f"{base}{path}"
            data, err = await _http_get_json(url, headers)
            if data is not None:
                return _normalise_models(data, kind=kind)
            if not (err and err.startswith("404")):
                raise RuntimeError(f"Failed to reach {url}: {err}")
        raise RuntimeError(f"No models endpoint reachable under {base}")

    async def test_chat_endpoint(
        self,
        base_url: str,
        api_key: Optional[str],
    ) -> tuple[bool, Optional[str]]:
        # Probe LM Studio's NATIVE chat endpoint (`/api/v1/chat`)
        # first — that's where `stream_chat` actually sends requests.
        # Falls back to the OpenAI-compat surface (`/v1/chat/completions`)
        # as a last resort so non-LM-Studio servers a writer happened
        # to label as "lmstudio_rest_v1" still test green.
        #
        # An empty-body POST gets a structured 4xx back when the
        # endpoint is reachable (only our intentionally-bad request
        # is being rejected). 401 / 403 means the credentials are
        # wrong; 404 means the endpoint isn't there → try the next
        # one. 5xx is treated as endpoint-down → try the next.
        base = base_url.rstrip("/")
        headers = self._auth_headers(api_key)
        last_err: Optional[str] = None
        for path in ("/api/v1/chat", "/v1/chat/completions"):
            url = f"{base}{path}"
            try:
                async with httpx.AsyncClient(timeout=_DISCOVERY_TIMEOUT_SECONDS) as client:
                    resp = await client.post(url, headers=headers, json={})
            except httpx.HTTPError as e:
                last_err = f"network error ({type(e).__name__}): {e}"
                continue
            if resp.status_code == 404:
                last_err = f"{path}: 404 Not Found"
                continue
            if resp.status_code in (401, 403):
                # Credential failure is authoritative — no point
                # trying the other path with the same credentials.
                return False, f"{resp.status_code} {resp.reason_phrase}"
            if resp.status_code >= 500:
                last_err = f"{path}: {resp.status_code} {resp.reason_phrase}"
                continue
            return True, None
        return False, last_err or "no reachable chat endpoint"

    async def probe_plugin(
        self,
        base_url: str,
        api_key: Optional[str],
    ) -> tuple[Optional[bool], str]:
        """Detect whether the `mcp/narrativenode` plugin is registered
        in this LM Studio's `mcp.json`. Sends a minimal `/api/v1/chat`
        carrying the plugin integration: LM Studio returns a
        `plugin_connection_error` when the plugin isn't configured, and
        a normal reply when it is (it resolves the plugin and loads its
        tool catalogue to answer).

        Returns `(available, detail)` where `available` is:
          * True  — the plugin is configured and reachable.
          * False — definitively not configured (`plugin_connection_error`).
          * None  — couldn't determine (no model to probe with, network
                    failure, or an unexpected error shape).

        The connection-test endpoint calls this for REST v1 connections;
        the UI offers the tool toggle only when it comes back True. A
        served model is required because `/api/v1/chat` needs one; any
        model works (the prompt is trivial)."""
        try:
            models = await self.discover_models(base_url, api_key)
        except Exception as e:  # noqa: BLE001
            return None, f"Could not list models to run the plugin probe: {e}"
        if not models:
            return None, "No models available to run the plugin probe."

        url = f"{base_url.rstrip('/')}/api/v1/chat"
        headers = self._auth_headers(api_key)
        headers["Content-Type"] = "application/json"
        body = {
            "model": models[0].id,
            "input": "Reply with the single word OK.",
            "integrations": [{"type": "plugin", "id": NARRATIVENODE_PLUGIN_ID}],
        }
        try:
            async with httpx.AsyncClient(timeout=_STREAM_TIMEOUT_SECONDS) as client:
                resp = await client.post(url, headers=headers, json=body)
        except httpx.HTTPError as e:
            return None, f"network error ({type(e).__name__}): {e}"

        text = resp.text or ""
        low = text.lower()
        # Plugin not registered → definitive "not configured".
        if "plugin_connection_error" in text or "cannot find plugin handle" in low:
            return False, (
                "NarrativeNode is not registered as an MCP plugin in this "
                "LM Studio. Add it to mcp.json named 'narrativenode'."
            )
        # A clean reply → the plugin resolved and its tools loaded.
        if resp.status_code < 400:
            return True, "NarrativeNode MCP plugin detected in LM Studio."
        # The plugin resolved and loaded its tool catalogue, but the model's
        # context window can't hold it (NarrativeNode exposes a large set of
        # tools). That still PROVES the plugin is configured — a tiny prompt
        # without the plugin would never overflow context. Detection is all
        # we need here; whether the model can actually fit the tools at chat
        # time is a separate, model-context concern surfaced in chat.
        if "exceed_context_size_error" in low or "exceeds the available context" in low:
            return True, (
                "NarrativeNode MCP plugin detected. Note: its tool catalogue is "
                "large; raise the model's context length in LM Studio to use the "
                "tools."
            )
        return None, f"Plugin probe failed ({resp.status_code}): {text[:200]}"

    # ── Chat ───────────────────────────────────────────────────

    async def stream_chat(
        self,
        *,
        base_url: str,
        api_key: Optional[str],
        model: str,
        messages: List[ChatMessage],
        system_prompt: Optional[str],
        mcp_server_url: Optional[str],
        is_cancelled: CancellationProbe,
        model_capabilities: Optional[Any] = None,  # noqa: ARG002 — LM Studio native always uses XML inline; no spec-vs-fallback choice
        capability_sink: Optional[Callable[..., None]] = None,  # noqa: ARG002 — no runtime-detected capabilities to surface
        reasoning_level: Optional[Any] = None,
        reasoning_summary: Optional[str] = None,  # noqa: ARG002 — LM Studio native has no verbosity field; OpenRouter-only
        max_tool_rounds: Optional[int] = None,  # noqa: ARG002 — LM Studio REST doesn't loop tool-calls in the adapter
    ) -> AsyncIterator[NormalisedEvent]:
        url = f"{base_url.rstrip('/')}/api/v1/chat"
        headers = self._auth_headers(api_key)
        headers["Accept"] = "text/event-stream"

        body = {
            "model": model,
            "input": _build_input(messages),
            "stream": True,
            "store": False,
        }
        if system_prompt:
            body["system_prompt"] = system_prompt
        integrations = _build_integrations(mcp_server_url)
        if integrations:
            body["integrations"] = integrations
        # Phase 2.5f — reasoning level rides as a top-level `reasoning`
        # field (per LM Studio REST v1 spec). Value must be one of the
        # model's declared `allowed_options`. We forward whatever the
        # writer's slider selected verbatim; if the value isn't
        # accepted by the model the upstream returns a clear error
        # which our error event surfaces back to the chat panel.
        if reasoning_level is not None and isinstance(reasoning_level, str) and reasoning_level:
            body["reasoning"] = reasoning_level

        # Track wall-clock duration of the reasoning stream so the
        # `reasoning_end` event can carry `reasoning_duration_ms`
        # even when the upstream doesn't report it in usage.
        reasoning_started_at_ms: Optional[int] = None

        # Tracks the currently-open tool call. LM Studio's events don't
        # carry an id, so we mint one on `tool_call.start` and forward
        # it through the subsequent `arguments` / `success` / `failure`
        # events so the frontend can correlate phases of the same call.
        current_tool_call_id: Optional[str] = None
        try:
            async with httpx.AsyncClient(timeout=_STREAM_TIMEOUT_SECONDS) as client:
                async with client.stream("POST", url, headers=headers, json=body) as upstream:
                    if upstream.status_code >= 400:
                        body_text = (await upstream.aread()).decode("utf-8", errors="replace")[:2000]
                        yield NormalisedEvent(
                            type="error",
                            detail=f"{upstream.status_code} {upstream.reason_phrase}: {body_text}",
                        )
                        return

                    async for line in upstream.aiter_lines():
                        if await is_cancelled():
                            return
                        if not line or not line.startswith("data:"):
                            continue
                        payload_text = line[5:].strip()
                        if not payload_text or payload_text == "[DONE]":
                            continue
                        try:
                            payload = json.loads(payload_text)
                        except Exception:
                            continue
                        event_type = payload.get("type") or payload.get("event")
                        # Tool-call event family is handled inline so the
                        # per-call correlation id we mint on `start` can
                        # ride through the rest of the call's events. All
                        # four phases yield, then we let the loop continue.
                        if event_type == "tool_call.start":
                            current_tool_call_id = uuid.uuid4().hex
                            yield _translate_tool_call_start(payload, current_tool_call_id)
                            continue
                        if event_type == "tool_call.arguments":
                            yield _translate_tool_call_arguments(payload, current_tool_call_id)
                            continue
                        if event_type == "tool_call.success":
                            yield _translate_tool_call_success(payload, current_tool_call_id)
                            current_tool_call_id = None
                            continue
                        if event_type == "tool_call.failure":
                            yield _translate_tool_call_failure(payload, current_tool_call_id)
                            current_tool_call_id = None
                            continue
                        # Phase 2.5f — reasoning event family. LM Studio
                        # emits `reasoning.start / reasoning.delta /
                        # reasoning.end` SSE events with chunk text on
                        # `content` (same shape as message.delta).
                        # Normalise to `reasoning_delta` / `reasoning_end`.
                        if event_type == "reasoning.start":
                            reasoning_started_at_ms = _now_ms()
                            continue
                        if event_type == "reasoning.delta":
                            text = payload.get("content") or ""
                            if not text:
                                continue
                            yield NormalisedEvent(type="reasoning_delta", text=text)
                            continue
                        if event_type == "reasoning.end":
                            duration_ms = None
                            if reasoning_started_at_ms is not None:
                                duration_ms = _now_ms() - reasoning_started_at_ms
                                reasoning_started_at_ms = None
                            yield NormalisedEvent(
                                type="reasoning_end",
                                reasoning_duration_ms=duration_ms,
                            )
                            continue
                        event = _translate_event(payload)
                        if event is None:
                            continue
                        yield event
                        if event.type == "end" and getattr(event, "finish_reason", None) == "__chat_end__":
                            return
        except httpx.HTTPError as e:
            yield NormalisedEvent(type="error", detail=f"network error ({type(e).__name__}): {e}")
        except asyncio.CancelledError:
            return
        except Exception as e:  # noqa: BLE001
            yield NormalisedEvent(type="error", detail=f"Unexpected error: {e}")

    # ── Helpers ────────────────────────────────────────────────

    @staticmethod
    def _auth_headers(api_key: Optional[str]) -> dict:
        """LM Studio uses OpenAI-style bearer auth on both surfaces.
        The bearer header is omitted entirely when no key is set so
        local installs with auth disabled don't see a stray empty
        bearer token (which some servers reject). The User-Agent
        identifies us in LM Studio's server logs."""
        headers: dict = {"User-Agent": _USER_AGENT}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        return headers


# ── Private translation helpers ──────────────────────────────────


def _build_input(messages: List[ChatMessage]):
    """LM Studio's /api/v1/chat `input` field is `string | array`.
    Per the REST v1 docs the `/api/v1/chat` endpoint does NOT
    support assistant messages in the request — the comparison
    table at `.References/LM Studio API.md` (line 113) lists
    "Include assistant messages in the request" as ❌ for this
    endpoint. Multi-turn stateless chat therefore has to be
    flattened into one user turn (with role labels baked into the
    text) — proper multi-turn requires `previous_response_id`
    stateful mode (deferred per Phase 2.4a planning).

    Without attachments: a plain string, matching the curl examples
    in the docs. With attachments: the structured array form
    `[{type:"text", content:"..."}, {type:"image", data_url:"..."}]`
    documented at `.References/LM Studio API.md` line 1437-1458.

    Text-kind attachments inline into the flattened text before the
    binary attachments — universal (the structured array path is
    only used when at least one image is present, since LM Studio
    /api/v1/chat doesn't define a non-image binary content type).
    File-kind (PDF) attachments are inlined as a placeholder note
    on this adapter since LM Studio's native chat endpoint has no
    `file` content-part shape — writers wanting PDF support should
    use OpenAI-compatible / OpenRouter."""
    has_image_attachment = any(
        att.kind == "image"
        for m in messages
        for att in (m.attachments or [])
    )
    flattened_text = _flatten_text(messages)
    if not has_image_attachment:
        return flattened_text

    # Structured-array path: emit the flattened text first, then
    # one `{type:"image", data_url:...}` entry per image across
    # the whole conversation. Order of images preserves message
    # order then per-message attachment order so the model sees
    # them in the same sequence the writer attached them.
    parts: list = [{"type": "text", "content": flattened_text}]
    for m in messages:
        for att in (m.attachments or []):
            if att.kind == "image":
                # Phase 2.5e — prefer the persisted upstream URL when
                # the assistant image was originally returned as a
                # hosted URL (LM Studio accepts `data_url` as either
                # a `data:` or hosted scheme — the field name is its
                # convention, the value can be either).
                url = att.wire_url or f"data:{att.mime_type};base64,{att.data_base64}"
                parts.append({
                    "type": "image",
                    "data_url": url,
                })
    return parts


def _flatten_text(messages: List[ChatMessage]) -> str:
    """Flatten the message history into a single user-turn string,
    inlining any text-kind attachments as a preamble before the
    message body they ride with. Image attachments are handled
    separately by the caller (they ride in the structured `input`
    array, not in the text).

    Only `text` and `image` attachment kinds can reach this
    adapter — the frontend's `useActiveModelCapabilities` /
    `validateAttachment` gate enforces that LM Studio profiles
    (which don't expose `file` in `input_modalities`) can't even
    pick a PDF in the first place. If a `file`-kind attachment
    somehow appears here it's a frontend-side gate bug; we skip
    it silently rather than dribble a useless 'we received a file
    you can't see' note to the model.

    Text-kind attachments are wrapped in the per-API formatter
    `_format_text_attachment_block` (XML `<document>` shape — see
    that function's docstring for the rationale). Multiple text
    attachments on the same message get a `<documents>` wrapper
    so the model sees a single labelled group."""
    chunks: list = []
    for m in messages:
        text_blocks: list = []
        for att in (m.attachments or []):
            if att.kind == "text":
                block = _format_text_attachment_block(att)
                if block:
                    text_blocks.append(block)
        if len(text_blocks) > 1:
            # Multiple documents → wrap the lot in <documents> per
            # Anthropic's convention (works on the Llama / Qwen /
            # Pixtral / Gemma vision models LM Studio hosts).
            prefix = "<documents>\n" + "\n".join(text_blocks) + "\n</documents>"
        else:
            prefix = text_blocks[0] if text_blocks else ""
        text_for_this_message = m.content
        if prefix:
            text_for_this_message = "\n\n".join([prefix, m.content]) if m.content else prefix
        if len(messages) == 1 and m.role == "user":
            return text_for_this_message
        chunks.append(f"{m.role.capitalize()}: {text_for_this_message}")
    return "\n\n".join(chunks)


# ── Per-kind attachment formatters (LM Studio native) ─────────────
#
# LM Studio REST v1's chat endpoint accepts only `text` and `image`
# content types in the `input` array. The image formatter lives
# inline in `_build_input` because the shape is just one line:
# `{type:"image", data_url:"..."}`. Text-kind attachments go
# through the helper below so each adapter owns its own framing.


def _format_text_attachment_block(att) -> str:
    """LM Studio inline text-attachment block using Anthropic's
    `<document>` XML convention. Claude was explicitly trained on
    this shape; Llama / Qwen / Pixtral / Gemma vision models that
    LM Studio commonly hosts have also seen it widely in their
    training data. The `<source>` tag carries the filename so the
    model can refer to it by name when asked about 'a file' or
    'the attached file' rather than mistaking the body for pasted
    text in the user's message."""
    try:
        decoded = _b64_to_text(att.data_base64)
    except Exception:
        return f"<document>\n  <source>{att.name}</source>\n  <content>\n    (could not decode file content)\n  </content>\n</document>"
    return (
        f"<document>\n"
        f"  <source>{att.name}</source>\n"
        f"  <content>\n{decoded}\n  </content>\n"
        f"</document>"
    )


def _b64_to_text(data_base64: str) -> str:
    import base64
    return base64.b64decode(data_base64).decode("utf-8", errors="replace")


def _build_integrations(mcp_server_url: Optional[str]) -> Optional[list]:
    """LM Studio's `integrations` array. When the writer has enabled
    tool access (signalled by a truthy `mcp_server_url`), reference the
    locally-configured `mcp/narrativenode` plugin from their LM Studio
    `mcp.json`.

    We use the `plugin` integration, NOT `ephemeral_mcp`. LM Studio
    refuses a dynamic remote MCP `server_url` that resolves to a
    non-public address, so the old `ephemeral_mcp` + `localhost:13316`
    shape was rejected on every local LM Studio (and wouldn't have
    reached us on a remote one either, since that `localhost` is LM
    Studio's loopback, not ours). A plugin the writer registered in
    their own `mcp.json` is trusted and works on localhost. The
    `mcp_server_url` value is unused now; its presence is purely the
    on/off signal. `probe_plugin` verifies the plugin is configured
    before the UI offers the tool toggle."""
    if not mcp_server_url:
        return None
    return [{"type": "plugin", "id": NARRATIVENODE_PLUGIN_ID}]


def _translate_event(payload: dict) -> Optional[NormalisedEvent]:
    """Map one LM Studio REST v1 SSE event onto the cross-provider
    `NormalisedEvent` shape. Unrecognised events return None so the
    caller skips them silently.

    Event flow (per `.References/LM Studio API.md`):
        chat.start
        [model_load.{start,progress,end}]   ← skipped (informational)
        [prompt_processing.{start,progress,end}]  ← skipped
        [reasoning.start, reasoning.delta..., reasoning.end]  ← Phase 2.5f: handled inline in stream_chat() (translated to NormalisedEvent reasoning_delta / reasoning_end)
        [tool_call.{start,arguments,success|failure}]  ← skipped (Phase 2.4 surfaces these later)
        message.start, message.delta..., message.end (potentially multiple cycles)
        chat.end                            ← terminator + aggregate result

    Important:
      * `message.delta` puts the token chunk DIRECTLY on the
        payload as `content` — not nested under a `delta` object.
      * `message.end` doesn't end the stream. Only `chat.end`
        does. A single chat response can contain multiple
        message blocks (e.g. when interspersed with tool calls).
      * `chat.end.result.output[]` carries the aggregated final
        content; we pull the joined text out of message-typed
        items for the `end` event's `text` field.
    """
    event_type = payload.get("type") or payload.get("event")
    if not event_type:
        return None

    if event_type == "chat.start":
        return NormalisedEvent(
            type="start",
            message_id=payload.get("model_instance_id"),
        )
    if event_type == "message.delta":
        text = payload.get("content") or ""
        if not text:
            return None
        return NormalisedEvent(type="delta", text=text)
    if event_type == "message.start" or event_type == "message.end":
        # Don't surface these — we treat the chat as one stream
        # to the writer regardless of how many internal message
        # blocks the model emits. The visible "start" / "end"
        # signals come from chat.start / chat.end.
        return None
    if event_type == "chat.end":
        result = payload.get("result") or {}
        output = result.get("output") or []
        text_parts = [
            (item.get("content") or "")
            for item in output
            if isinstance(item, dict) and item.get("type") == "message"
        ]
        full_text = "".join(text_parts)
        return NormalisedEvent(
            type="end",
            text=full_text,
            message_id=result.get("response_id"),
            finish_reason="__chat_end__",
        )
    if event_type == "error":
        err = payload.get("error") or {}
        if isinstance(err, dict):
            detail = err.get("message") or err.get("code") or str(err)
        else:
            detail = str(err)
        return NormalisedEvent(type="error", detail=detail)
    return None


def _extract_provider(payload: dict) -> dict:
    """Pull the `provider_info` block off a tool_call.* event. Always
    returns a dict (possibly empty) so callers can do `.get(...)`
    without a None check."""
    info = payload.get("provider_info")
    return info if isinstance(info, dict) else {}


def _extract_tool_name(payload: dict) -> Optional[str]:
    """Resolve the tool name from a tool_call.* event payload.
    LM Studio's REST v1 docs list the canonical key as `tool` on
    every tool_call.* event, but some integrations have been
    observed surfacing the name on `name` instead (e.g. when the
    upstream MCP server reports it differently). Fall back through
    a few plausible keys so the chip never has to render a
    `tool call` placeholder when the name is in fact present
    somewhere on the payload."""
    for key in ("tool", "name", "tool_name"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value
    # Tool name occasionally hides inside a function-call block when
    # the upstream is OpenAI-compatible rather than strict LM Studio.
    function = payload.get("function")
    if isinstance(function, dict):
        name = function.get("name")
        if isinstance(name, str) and name.strip():
            return name
    return None


def _translate_tool_call_start(payload: dict, call_id: Optional[str]) -> NormalisedEvent:
    info = _extract_provider(payload)
    return NormalisedEvent(
        type="tool_call",
        tool_call_id=call_id,
        tool_call_phase="start",
        tool_name=_extract_tool_name(payload),
        tool_provider_type=info.get("type"),
        tool_server_label=info.get("server_label"),
        tool_plugin_id=info.get("plugin_id"),
    )


def _translate_tool_call_arguments(payload: dict, call_id: Optional[str]) -> NormalisedEvent:
    info = _extract_provider(payload)
    args = payload.get("arguments")
    if not isinstance(args, dict):
        args = None
    return NormalisedEvent(
        type="tool_call",
        tool_call_id=call_id,
        tool_call_phase="arguments",
        tool_name=_extract_tool_name(payload),
        tool_provider_type=info.get("type"),
        tool_server_label=info.get("server_label"),
        tool_plugin_id=info.get("plugin_id"),
        tool_arguments=args,
    )


def _translate_tool_call_success(payload: dict, call_id: Optional[str]) -> NormalisedEvent:
    info = _extract_provider(payload)
    args = payload.get("arguments")
    if not isinstance(args, dict):
        args = None
    output = payload.get("output")
    if output is not None and not isinstance(output, str):
        # Some servers may return non-string output; coerce so the
        # frontend doesn't have to think about it.
        output = json.dumps(output)
    return NormalisedEvent(
        type="tool_call",
        tool_call_id=call_id,
        tool_call_phase="success",
        tool_name=_extract_tool_name(payload),
        tool_provider_type=info.get("type"),
        tool_server_label=info.get("server_label"),
        tool_plugin_id=info.get("plugin_id"),
        tool_arguments=args,
        tool_output=output,
    )


def _translate_tool_call_failure(payload: dict, call_id: Optional[str]) -> NormalisedEvent:
    meta = payload.get("metadata")
    meta = meta if isinstance(meta, dict) else {}
    info = meta.get("provider_info")
    info = info if isinstance(info, dict) else {}
    args = meta.get("arguments")
    if not isinstance(args, dict):
        args = None
    # Failure events carry the tool name under `metadata.tool_name`
    # per the docs, but the same fallback chain applies in case the
    # field varies — check the metadata block first, then the
    # outer payload as a last resort.
    tool_name = _extract_tool_name(meta) or _extract_tool_name(payload)
    return NormalisedEvent(
        type="tool_call",
        tool_call_id=call_id,
        tool_call_phase="failure",
        tool_name=tool_name,
        tool_provider_type=info.get("type"),
        tool_server_label=info.get("server_label"),
        tool_plugin_id=info.get("plugin_id"),
        tool_arguments=args,
        tool_error_reason=payload.get("reason"),
        tool_error_type=meta.get("type"),
    )


def _normalise_models(payload: dict, kind: str) -> List[DiscoveredModel]:
    """Convert one of LM Studio's three model-list payloads into the
    cross-provider `DiscoveredModel` list. `kind` selects the parser:

      * `"lms_v1"`         — `/api/v1/models`. The richest of the
        three. Top-level `{"models": [...]}`. Each entry uses `key`
        as the id, `architecture` (full word), `quantization` as an
        object `{name, bits_per_weight}`, and `capabilities` as an
        OBJECT with `vision`, `trained_for_tool_use`, and (when the
        model is reasoning-trained) a `reasoning` field whose value
        is `{allowed_options: [...], default: ...}`.
      * `"lms_v0"`         — `/api/v0/models`. Older native shape.
        Top-level `{"data": [...]}` (OpenAI-style wrapper). Each
        entry uses `id`, `arch` (short), `quantization` as a STRING.
        `type` is `"llm" | "vlm" | "embeddings"` and `capabilities`
        is an ARRAY OF STRINGS (e.g. `["tool_use"]`). Vision is
        signalled by `type == "vlm"`, not via the capabilities array.
      * `"openai_compat"`  — `/v1/models`. The OpenAI-compatible
        surface, no capabilities. Fall back to the hardcoded
        substring table for capability info.
    """
    if kind == "lms_v1":
        return _normalise_lms_v1(payload)
    if kind == "lms_v0":
        return _normalise_lms_v0(payload)
    return _normalise_openai_compat(payload)


def _normalise_lms_v1(payload: dict) -> List[DiscoveredModel]:
    raw_models = payload.get("models") or []
    out: List[DiscoveredModel] = []
    for entry in raw_models:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get("key") or entry.get("id")
        if not model_id:
            continue
        entry_type = entry.get("type")
        # Display tags for the picker (LM Studio "type · arch").
        caps: list[str] = []
        if entry_type:
            caps.append(str(entry_type))
        arch_val = entry.get("architecture") or entry.get("arch")
        if arch_val:
            caps.append(str(arch_val))
        capabilities = caps or None
        params_bits: list[str] = []
        quant = entry.get("quantization")
        if isinstance(quant, dict):
            qname = quant.get("name")
            if qname:
                params_bits.append(str(qname))
        elif quant:
            params_bits.append(str(quant))
        if entry.get("max_context_length"):
            params_bits.append(f"{entry['max_context_length']} ctx")
        params_string = " · ".join(params_bits) if params_bits else None

        # Structured capabilities — object shape on v1.
        input_modalities: Optional[List[str]] = None
        output_modalities: Optional[List[str]] = None
        supports_tool_use: Optional[bool] = None
        supports_reasoning: Optional[bool] = None
        reasoning_options: Optional[List[str]] = None
        reasoning_default: Optional[str] = None
        caps_obj = entry.get("capabilities")
        # Embedding models omit `capabilities`; only conversational
        # models (llm / vlm) carry modality info.
        if entry_type and str(entry_type).lower() != "embedding":
            mods: list[str] = ["text"]
            if isinstance(caps_obj, dict) and bool(caps_obj.get("vision")):
                mods.append("image")
            elif str(entry_type).lower() == "vlm":
                # Defensive: a "vlm" type without an explicit vision
                # flag is still a vision-language model.
                mods.append("image")
            input_modalities = mods
            output_modalities = ["text"]
            if isinstance(caps_obj, dict):
                if "trained_for_tool_use" in caps_obj:
                    supports_tool_use = bool(caps_obj["trained_for_tool_use"])
                # Reasoning: presence of a `reasoning` config that
                # includes any "on"/"low"/"medium"/"high" option means
                # the model supports reasoning. A bare object whose
                # only allowed option is "off" would mean reasoning
                # is disabled — but in practice LM Studio omits the
                # field entirely when the model isn't reasoning-
                # trained, so presence is a reliable signal.
                #
                # Phase 2.5f — also persist the full `allowed_options`
                # array on `reasoning_options` so the adaptive slider
                # can render exactly what the model declared (e.g.
                # Gemma 4 reduces to a no-flyout button-only control
                # because its only non-"off" option is "on"; other
                # models declaring `["off","low","medium","high"]`
                # render the full slider).
                reasoning_obj = caps_obj.get("reasoning")
                if isinstance(reasoning_obj, dict):
                    options = reasoning_obj.get("allowed_options") or []
                    options_list = [str(opt) for opt in options if isinstance(opt, (str, int))]
                    if any(opt != "off" for opt in options_list):
                        supports_reasoning = True
                        reasoning_options = options_list
                    # Phase 2.5f — capture the model's declared
                    # default reasoning value when present. Drives
                    # the chat panel's model-default hint animation
                    # when the writer switches to this model.
                    declared_default = reasoning_obj.get("default")
                    if isinstance(declared_default, str) and declared_default:
                        reasoning_default = declared_default
                    else:
                        reasoning_default = None
                elif reasoning_obj is True:
                    supports_reasoning = True
                    reasoning_default = None
                else:
                    reasoning_default = None

        # Reasoning fallback for models the API didn't flag — apply
        # the hardcoded id-substring table so locally-loaded reasoning
        # models still light up the badge. Also pull `reasoning_options`
        # from the table entry when present, so an LM-Studio-loaded
        # third-party model that the API didn't decorate still gets
        # an adaptive slider.
        if supports_reasoning is None or reasoning_options is None:
            from .openai_compatible import _capabilities_from_model_id
            hit = _capabilities_from_model_id(str(model_id))
            if hit is not None:
                if supports_reasoning is None and "supports_reasoning" in hit:
                    supports_reasoning = hit["supports_reasoning"]
                if reasoning_options is None and hit.get("reasoning_options"):
                    reasoning_options = list(hit["reasoning_options"])

        # Phase 3.10 Layer 5 — surface LM Studio's `max_context_length`
        # as a structured field so scene wiring can size chunks
        # without re-parsing the display string. None when missing.
        ctx_raw = entry.get("max_context_length")
        try:
            context_window = int(ctx_raw) if ctx_raw is not None else None
        except (TypeError, ValueError):
            context_window = None

        out.append(DiscoveredModel(
            id=str(model_id),
            display_name=str(entry.get("display_name")) if entry.get("display_name") else None,
            publisher=str(entry.get("publisher")) if entry.get("publisher") else None,
            capabilities=capabilities,
            params_string=params_string,
            input_modalities=input_modalities,
            output_modalities=output_modalities,
            supports_tool_use=supports_tool_use,
            supports_reasoning=supports_reasoning,
            reasoning_options=reasoning_options,
            reasoning_default=reasoning_default,
            context_window=context_window,
        ))
    return out


def _normalise_lms_v0(payload: dict) -> List[DiscoveredModel]:
    raw_models = payload.get("data") or []
    out: List[DiscoveredModel] = []
    for entry in raw_models:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get("id") or entry.get("model")
        if not model_id:
            continue
        entry_type = entry.get("type")
        caps_tags: list[str] = []
        if entry_type:
            caps_tags.append(str(entry_type))
        if entry.get("arch"):
            caps_tags.append(str(entry["arch"]))
        capabilities = caps_tags or None
        params_bits: list[str] = []
        if entry.get("quantization"):
            params_bits.append(str(entry["quantization"]))
        if entry.get("max_context_length"):
            params_bits.append(f"{entry['max_context_length']} ctx")
        params_string = " · ".join(params_bits) if params_bits else None

        # v0 capabilities are an array of strings.
        input_modalities: Optional[List[str]] = None
        output_modalities: Optional[List[str]] = None
        supports_tool_use: Optional[bool] = None
        supports_reasoning: Optional[bool] = None
        caps_list = entry.get("capabilities")
        caps_set = set(caps_list) if isinstance(caps_list, list) else set()
        if entry_type and str(entry_type).lower() != "embeddings":
            mods: list[str] = ["text"]
            if str(entry_type).lower() == "vlm" or "vision" in caps_set:
                mods.append("image")
            input_modalities = mods
            output_modalities = ["text"]
            if "tool_use" in caps_set:
                supports_tool_use = True

        # Reasoning fallback via the hardcoded id-substring table.
        from .openai_compatible import _capabilities_from_model_id
        hit = _capabilities_from_model_id(str(model_id))
        if hit is not None and supports_tool_use is None and "supports_tool_use" in hit:
            supports_tool_use = hit["supports_tool_use"]
        if hit is not None and "supports_reasoning" in hit:
            supports_reasoning = hit["supports_reasoning"]

        # Phase 3.10 Layer 5 — same `max_context_length` surface as the
        # v1 path; some LM Studio installs return it on the v0 shape too.
        ctx_raw = entry.get("max_context_length")
        try:
            context_window = int(ctx_raw) if ctx_raw is not None else None
        except (TypeError, ValueError):
            context_window = None

        out.append(DiscoveredModel(
            id=str(model_id),
            display_name=str(entry.get("display_name")) if entry.get("display_name") else None,
            publisher=str(entry.get("publisher")) if entry.get("publisher") else None,
            capabilities=capabilities,
            params_string=params_string,
            input_modalities=input_modalities,
            output_modalities=output_modalities,
            supports_tool_use=supports_tool_use,
            supports_reasoning=supports_reasoning,
            context_window=context_window,
        ))
    return out


def _normalise_openai_compat(payload: dict) -> List[DiscoveredModel]:
    raw_models = payload.get("data") or []
    out: List[DiscoveredModel] = []
    for entry in raw_models:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get("id") or entry.get("model")
        if not model_id:
            continue
        # OpenAI-compat surface has no capability info. Fall back to
        # the hardcoded id-substring table for known model families.
        from .openai_compatible import _capabilities_from_model_id
        hit = _capabilities_from_model_id(str(model_id))
        out.append(DiscoveredModel(
            id=str(model_id),
            display_name=None,
            publisher=str(entry.get("owned_by")) if entry.get("owned_by") else None,
            capabilities=None,
            params_string=None,
            input_modalities=hit.get("input_modalities") if hit else None,
            output_modalities=hit.get("output_modalities") if hit else None,
            supports_tool_use=hit.get("supports_tool_use") if hit else None,
            supports_reasoning=hit.get("supports_reasoning") if hit else None,
        ))
    return out


async def _http_get_json(url: str, headers: dict) -> tuple[Optional[dict], Optional[str]]:
    """Shared GET-JSON helper. Distinguishes 404 (so callers can
    fall through to a sibling path) from other failures."""
    try:
        async with httpx.AsyncClient(timeout=_DISCOVERY_TIMEOUT_SECONDS) as client:
            resp = await client.get(url, headers=headers)
    except httpx.HTTPError as e:
        return None, f"network error ({type(e).__name__}): {e}"

    if resp.status_code == 404:
        return None, "404 Not Found"
    if resp.status_code >= 400:
        try:
            detail = resp.json()
        except Exception:
            detail = resp.text[:500]
        return None, f"{resp.status_code} {resp.reason_phrase}: {detail}"
    try:
        return resp.json(), None
    except Exception as e:
        return None, f"invalid JSON in response: {e}"
