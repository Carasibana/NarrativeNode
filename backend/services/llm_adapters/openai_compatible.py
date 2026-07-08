"""OpenAI-compatible chat adapter — Phase 2.5a.

Speaks the de-facto "OpenAI-compatible" wire format that's the
common denominator across the OpenAI hosted API, OpenRouter,
Groq, Together AI, Ollama, vLLM, llama.cpp's `--api` server,
LM Studio's OpenAI-compat path (not the LM Studio-native REST v1
path the sibling adapter speaks), and most other local-inference
servers. The same client speaks to all of them by virtue of the
shape being stable; per-upstream differences live in the writer's
`base_url` and `api_key`, not in the request body.

The authoritative shape is `.References/openapi.yaml`
(`createChatCompletion` operation at line 3254, request schema at
`CreateChatCompletionRequest`). When something subtle comes up,
grep there first; the cheat sheet at `.References/OpenAI Chat
Completions API.md` is faster to scan but a paraphrase.

Endpoints used:
  * `GET  {base_url}/v1/models`           — discovery
  * `POST {base_url}/v1/chat/completions` — streaming chat

Wire shape (per OpenAPI 3.1 spec, distilled):

  * Authentication via `Authorization: Bearer {api_key}` header.
    Omitted entirely when no key is configured so local installs
    with auth disabled don't see a stray empty bearer token
    (which some servers reject — the LM Studio adapter has the
    same dance).

  * Streaming request body shape:
        {
          "model": "...",
          "messages": [{"role": "user|assistant|system", "content": "..."}, ...],
          "stream": true,
          "stream_options": {"include_usage": true}  # optional
        }
    System prompt is delivered as the first `system` (or
    `developer` for o1+ models, but we use `system` — most
    upstreams accept it and reasoning-specific knobs are out of
    scope for v1).

  * SSE event flow:
        data: {"id":"...","object":"chat.completion.chunk", ...
                "choices":[{"index":0,"delta":{"role":"assistant","content":""}, ...}]}
        data: {... "choices":[{"index":0,"delta":{"content":"Hello"}, ...}]}
        data: {... "choices":[{"index":0,"delta":{"content":" world"}, ...}]}
        ...
        data: {... "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
        data: {... "choices":[], "usage":{...}}   # only when stream_options.include_usage:true
        data: [DONE]

    Clients accumulate `choices[0].delta.content` strings as they
    arrive. The final-content chunk carries `finish_reason` and
    an empty `delta`; the literal `data: [DONE]` line is the
    stream terminator.

Tool calling: the OpenAI-compatible shape carries tool calls via
`messages[].tool_calls` (assistant turns) and a `tool` role for
the result. Phase 2.5a does not declare any tools to the
upstream, so no tool-call deltas can come back. Parsing the tool
deltas is therefore a no-op here — they're skipped silently if
an upstream ever emits one with no provoking `tools` declaration
in the request. Add tool support when a later phase wires it up
across the adapter interface.

MCP: not supported on the openai-compat shape. The MCP server
URL the caller passes is ignored entirely — this matches the
"no MCP integration toggle for openai_compatible" rule in the
Phase 2.5a ToDo.
"""
import asyncio
import json
import time
from typing import Any, AsyncIterator, Callable, List, Optional

import httpx


def _now_ms() -> int:
    """Monotonic millisecond timestamp for measuring reasoning-stream
    wall-clock. Monotonic so NTP adjustments mid-stream can't
    produce a negative duration."""
    return int(time.monotonic() * 1000)

from version import PROGRAM_VERSION

from .base import (
    CancellationProbe,
    ChatMessage,
    DiscoveredModel,
    LlmAdapter,
    NormalisedEvent,
    extract_cached_input_tokens,
)
from services.dev_tool_call_log import flush_pending_failure
from .inline_image_scanner import (
    download_remote_image_to_data_url,
    extract_inline_images_from_chunk,
)
from .mcp_tool_bridge import (
    consume_tool_call_deltas,
    elide_aged_tool_results,
    execute_buffered_tool_calls,
    list_mcp_tools_as_openai_functions,
    mcp_session_is_active,
    resolve_tool_round_cap,
)


_DISCOVERY_TIMEOUT_SECONDS = 15.0
_STREAM_TIMEOUT_SECONDS = 120.0

# Attribution headers. `User-Agent` identifies us in any
# OpenAI-compatible upstream's server logs. `X-Title` and
# `HTTP-Referer` are OpenRouter-specific extensions to the
# OpenAI-compatible shape (other upstreams ignore them) — they
# drive OpenRouter's per-app leaderboard at openrouter.ai/rankings.
# Both are harmless on non-OpenRouter upstreams. v1 hardcodes both;
# Phase 2.5b makes them writer-configurable so power users can
# override on a per-connection basis.
_USER_AGENT = f"NarrativeNode/{PROGRAM_VERSION}"
_X_TITLE = "NarrativeNode"
_HTTP_REFERER = "https://carasibana.github.io/NarrativeNode/"


class OpenAiCompatibleAdapter(LlmAdapter):
    api_type = "openai_compatible"
    # Client-side MCP: when the writer enables tool access for this
    # connection, we declare NarrativeNode's MCP tools as standard
    # OpenAI function `tools`, catch the model's `tool_calls`, run them
    # locally against our own MCP server, and feed results back. The
    # upstream never connects to our MCP server, so a localhost server
    # works even against a network-exposed upstream (e.g. LM Studio's
    # OpenAI-compatible `/v1` endpoint). See `_stream_chat_with_tools`.
    supports_mcp = True

    # ── Base URL normalisation ─────────────────────────────────

    @classmethod
    def normalise_base_url(cls, url: str) -> str:
        """Trim any documented `/v1/...` tail the writer may have
        pasted so what's persisted is the bit BEFORE the adapter's
        own `/v1/chat/completions` / `/v1/models` paths.

        Common writer mistakes this catches:
          * `https://openrouter.ai/api/v1`                       → `https://openrouter.ai/api`
          * `https://openrouter.ai/api/v1/chat/completions`      → `https://openrouter.ai/api`
          * `https://api.openai.com/v1`                          → `https://api.openai.com`
          * `https://api.openai.com/v1/chat/completions`         → `https://api.openai.com`
          * `https://api.openai.com/v1/models`                   → `https://api.openai.com`
          * any of the above with a trailing slash.
        """
        trimmed = (url or "").strip().rstrip("/")
        # Strip the longest known tail first so e.g. `/v1/chat/completions`
        # is matched before a shorter `/v1` substring inside it.
        # Order matters: longest → shortest.
        for suffix in (
            "/v1/chat/completions",
            "/v1/completions",
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
        url = f"{base_url.rstrip('/')}/v1/models"
        data, err = await _http_get_json(url, self._auth_headers(api_key))
        if data is None:
            raise RuntimeError(f"Failed to reach {url}: {err}")
        return _normalise_models(data)

    async def test_chat_endpoint(
        self,
        base_url: str,
        api_key: Optional[str],
    ) -> tuple[bool, Optional[str]]:
        # Hit /v1/chat/completions with an empty body. Any reachable
        # OpenAI-compatible upstream will return a structured 4xx
        # (typically 400 "messages is required" or similar). 401/403
        # mean auth is rejecting us; 404 means the endpoint isn't
        # there; 5xx means the upstream is broken.
        url = f"{base_url.rstrip('/')}/v1/chat/completions"
        try:
            async with httpx.AsyncClient(timeout=_DISCOVERY_TIMEOUT_SECONDS) as client:
                resp = await client.post(url, headers=self._auth_headers(api_key), json={})
        except httpx.HTTPError as e:
            return False, f"network error ({type(e).__name__}): {e}"

        if resp.status_code == 404:
            return False, "404 Not Found"
        if resp.status_code in (401, 403):
            return False, f"{resp.status_code} {resp.reason_phrase}"
        if resp.status_code >= 500:
            return False, f"{resp.status_code} {resp.reason_phrase}"
        return True, None

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
        model_capabilities: Optional[Any] = None,
        capability_sink: Optional[Callable[..., None]] = None,
        reasoning_level: Optional[Any] = None,
        reasoning_summary: Optional[str] = None,  # noqa: ARG002 — OpenRouter-only; openai_compatible ignores
        max_tool_rounds: Optional[int] = None,
    ) -> AsyncIterator[NormalisedEvent]:
        url = f"{base_url.rstrip('/')}/v1/chat/completions"
        headers = self._auth_headers(api_key)
        headers["Accept"] = "text/event-stream"
        headers["Content-Type"] = "application/json"

        # API-standard-first + retry-on-400 with fallback.
        #
        # `supports_file_content_part` carries any runtime-detected
        # fact about whether THIS specific model's upstream accepts
        # OpenAI's `type:"file"` content part:
        #   * None — unknown. Try the spec shape (prefer_file_shape=
        #     True). If the upstream rejects it with a 400 AND the
        #     message had text-kind attachments, retry once with the
        #     XML-inline fallback and persist `supports_file_content_part
        #     = False` so the next send skips the failed attempt.
        #   * True — previously confirmed. Use the spec shape.
        #   * False — previously rejected. Skip straight to the XML
        #     fallback for text-kind attachments; no retry, no extra
        #     HTTP round-trip.
        # Binary kinds (PDF / .docx / .pptx / .xlsx) have no fallback
        # shape, so a 400 on those surfaces as an error either way.
        cached_supports_file: Optional[bool] = None
        if model_capabilities is not None:
            cached_supports_file = getattr(model_capabilities, "supports_file_content_part", None)
        prefer_file_shape = (cached_supports_file is not False)

        has_text_attachments = any(
            a.kind == "text" for m in messages for a in (m.attachments or [])
        )

        # Client-side MCP tool loop. A truthy `mcp_server_url` is the
        # chat router's signal that the writer enabled tool access for
        # this connection; the URL itself is unused (we run tools
        # locally, never connecting the upstream to our MCP server).
        # When tools exist, run the multi-round loop and return; the
        # single-shot path below is left exactly as it was for the
        # no-tools case.
        if mcp_server_url:
            tools_payload = await list_mcp_tools_as_openai_functions()
            if tools_payload:
                async for ev in self._stream_chat_with_tools(
                    url=url,
                    headers=headers,
                    model=model,
                    messages=messages,
                    system_prompt=system_prompt,
                    prefer_file_shape=prefer_file_shape,
                    model_capabilities=model_capabilities,
                    reasoning_level=reasoning_level,
                    tools_payload=tools_payload,
                    max_tool_rounds=max_tool_rounds,
                    is_cancelled=is_cancelled,
                ):
                    yield ev
                return

        body = {
            "model": model,
            "messages": _build_messages(messages, system_prompt, prefer_file_shape=prefer_file_shape),
            "stream": True,
            # Token accounting alongside the stream. Some local
            # servers reject unknown stream_options keys with a 400;
            # if writers report that we can move this behind a
            # connection-level toggle, but Ollama / LM Studio /
            # vLLM / OpenAI all accept it as of the spec's 2.3.0.
            "stream_options": {"include_usage": True},
        }
        # Phase 2.5e — opt into image output when the active model
        # advertises `image` in its `output_modalities`. The hint
        # tells the upstream we accept inline images in the
        # response. Models that don't have the capability omit the
        # field entirely — preserves the existing wire shape.
        # The scanner runs on every response regardless, so even if
        # an upstream emits images without us asking we'd still
        # render them.
        out_mods = getattr(model_capabilities, "output_modalities", None) if model_capabilities else None
        if isinstance(out_mods, list) and "image" in out_mods:
            body["modalities"] = ["image", "text"]
        # Phase 2.5f — reasoning effort on outgoing requests. The
        # OpenAI Chat Completions spec puts this at top level as
        # `reasoning_effort: "<value>"`. Adapters that wrap a
        # provider with a different request shape (notably
        # OpenRouter's `reasoning: {effort, summary}` object) override
        # by rebuilding the body in their own `stream_chat`. None
        # means reasoning is OFF for this send and we omit the field
        # entirely; non-None means the writer's slider value goes
        # through verbatim.
        if reasoning_level is not None and isinstance(reasoning_level, str) and reasoning_level:
            body["reasoning_effort"] = reasoning_level

        # Retry is eligible when:
        #   (a) we tried the spec shape (prefer_file_shape=True), AND
        #   (b) the message had text-kind attachments (the only kind
        #       with a fallback wire shape), AND
        #   (c) the upstream returned 400.
        retry_eligible = prefer_file_shape and has_text_attachments

        try:
            async with httpx.AsyncClient(timeout=_STREAM_TIMEOUT_SECONDS) as client:
                async with client.stream("POST", url, headers=headers, json=body) as upstream:
                    if upstream.status_code == 400 and retry_eligible:
                        # Read the 400 body so we can log it, then
                        # fall through to the retry path below. We
                        # do NOT yield an error event here — the
                        # writer should see only the successful
                        # retry's events if the fallback works.
                        body_text_400 = (await upstream.aread()).decode("utf-8", errors="replace")[:2000]
                        print(
                            f"[openai_compat] 400 on type:file attempt for model={model!r}; "
                            f"retrying with XML-inline fallback. Upstream said: {body_text_400[:300]}",
                            flush=True,
                        )
                    elif upstream.status_code >= 400:
                        body_text = (await upstream.aread()).decode("utf-8", errors="replace")[:2000]
                        yield NormalisedEvent(
                            type="error",
                            detail=_extract_error_detail(upstream.status_code, upstream.reason_phrase, body_text),
                        )
                        return
                    else:
                        # Success — pump the stream and return.
                        async for event in self._pump_chat_stream(upstream, is_cancelled):
                            yield event
                        # First attempt succeeded — persist the positive
                        # capability fact if we don't already have it
                        # cached. Skip the write when it's already True
                        # (avoids touching user_preferences on every send).
                        if cached_supports_file is not True and capability_sink is not None:
                            try:
                                capability_sink(model, "supports_file_content_part", True)
                            except Exception as e:  # noqa: BLE001
                                print(f"[openai_compat] capability_sink failed (non-fatal): {e}", flush=True)
                        return

            # Reached only via the retry-eligible 400 branch above.
            # Rebuild with the XML-inline fallback and try once more.
            body["messages"] = _build_messages(messages, system_prompt, prefer_file_shape=False)
            if capability_sink is not None:
                try:
                    capability_sink(model, "supports_file_content_part", False)
                except Exception as e:  # noqa: BLE001
                    print(f"[openai_compat] capability_sink failed (non-fatal): {e}", flush=True)

            async with httpx.AsyncClient(timeout=_STREAM_TIMEOUT_SECONDS) as client:
                async with client.stream("POST", url, headers=headers, json=body) as upstream2:
                    if upstream2.status_code >= 400:
                        body_text = (await upstream2.aread()).decode("utf-8", errors="replace")[:2000]
                        yield NormalisedEvent(
                            type="error",
                            detail=_extract_error_detail(upstream2.status_code, upstream2.reason_phrase, body_text),
                        )
                        return
                    async for event in self._pump_chat_stream(upstream2, is_cancelled):
                        yield event
        except httpx.HTTPError as e:
            yield NormalisedEvent(type="error", detail=f"network error ({type(e).__name__}): {e}")
        except asyncio.CancelledError:
            return
        except Exception as e:  # noqa: BLE001
            yield NormalisedEvent(type="error", detail=f"Unexpected error: {e}")

    async def _stream_chat_with_tools(
        self,
        *,
        url: str,
        headers: dict,
        model: str,
        messages: List[ChatMessage],
        system_prompt: Optional[str],
        prefer_file_shape: bool,
        model_capabilities: Optional[Any],
        reasoning_level: Optional[Any],
        tools_payload: List[dict],
        max_tool_rounds: Optional[int],
        is_cancelled: CancellationProbe,
    ) -> AsyncIterator[NormalisedEvent]:
        """Client-side MCP tool loop over the OpenAI-compatible
        `/v1/chat/completions` shape. Declares our MCP tools as
        function `tools`, streams content / reasoning / tool-call
        deltas, and on `finish_reason == "tool_calls"` executes the
        calls locally (shared `mcp_tool_bridge` machinery), appends the
        assistant tool-call turn + tool results, then loops until the
        model replies without calling a tool, or the per-connection
        round cap is hit. The upstream never reaches our MCP server.

        Kept separate from the single-shot `stream_chat` path so the
        no-tools flow is untouched. The per-line parse mirrors
        `_pump_chat_stream`; the round loop mirrors the OpenRouter
        adapter (minus OpenRouter-specific cache / reasoning shaping).
        File-shape handling uses the caller's resolved
        `prefer_file_shape`; the in-loop 400 retry is intentionally
        omitted (tool turns rarely carry attachments, and a retry mid-
        loop would muddy the running message list)."""
        effective_cap = resolve_tool_round_cap(max_tool_rounds)

        out_mods = getattr(model_capabilities, "output_modalities", None) if model_capabilities else None
        send_image_modality = isinstance(out_mods, list) and "image" in out_mods

        # Running messages: system + history, grown by (assistant
        # tool-call turn, one tool message per call) on each round.
        running_messages = _build_messages(messages, system_prompt, prefer_file_shape=prefer_file_shape)

        emitted_start = False
        emitted_end = False
        text_accumulator: List[str] = []
        last_finish_reason: Optional[str] = None
        last_cached_input_tokens: Optional[int] = None
        # P0: the payload passed in was built under the session state at call
        # time. Track that state so a session GRANTED mid-turn rebuilds the
        # catalogue (surfacing the write tools) on the next round.
        tools_payload_active = await mcp_session_is_active()

        try:
            async with httpx.AsyncClient(timeout=_STREAM_TIMEOUT_SECONDS) as client:
                for _round_index in range(effective_cap):
                    # Phase 7.4 Track D: drop old, large tool results from the
                    # running list so they stop re-sending every round once the
                    # model has consumed them (the tool catalogue is re-sent
                    # regardless; this stops results compounding on top of it).
                    elide_aged_tool_results(running_messages)
                    # P0: rebuild the served catalogue when the session-active
                    # state has flipped since the payload was built, so a
                    # mid-turn session grant surfaces the write tools now
                    # instead of only on a fresh turn.
                    now_session_active = await mcp_session_is_active()
                    if now_session_active != tools_payload_active:
                        tools_payload = await list_mcp_tools_as_openai_functions()
                        tools_payload_active = now_session_active
                    body: dict = {
                        "model": model,
                        "messages": running_messages,
                        "stream": True,
                        "stream_options": {"include_usage": True},
                        "tools": tools_payload,
                        "tool_choice": "auto",
                    }
                    if send_image_modality:
                        body["modalities"] = ["image", "text"]
                    if reasoning_level is not None and isinstance(reasoning_level, str) and reasoning_level:
                        body["reasoning_effort"] = reasoning_level

                    # Per-round state. Reset each iteration so calls /
                    # reasoning accumulate independently per round.
                    tool_buffers: dict = {}
                    finish_reason: Optional[str] = None
                    cached_input_tokens_round: Optional[int] = None
                    reasoning_token_count_round: Optional[int] = None
                    reasoning_started_at_ms: Optional[int] = None
                    reasoning_active = False
                    reasoning_end_emitted = False

                    async with client.stream("POST", url, headers=headers, json=body) as upstream:
                        if upstream.status_code >= 400:
                            body_text = (await upstream.aread()).decode("utf-8", errors="replace")[:2000]
                            yield NormalisedEvent(
                                type="error",
                                detail=_extract_error_detail(upstream.status_code, upstream.reason_phrase, body_text),
                            )
                            return
                        async for line in upstream.aiter_lines():
                            if await is_cancelled():
                                return
                            if not line or not line.startswith("data:"):
                                continue
                            payload_text = line[5:].strip()
                            if not payload_text:
                                continue
                            if payload_text == "[DONE]":
                                break
                            try:
                                payload = json.loads(payload_text)
                            except Exception:
                                continue
                            if not emitted_start:
                                yield NormalisedEvent(type="start", message_id=payload.get("id"))
                                emitted_start = True
                            usage = payload.get("usage")
                            if isinstance(usage, dict):
                                if isinstance(usage.get("reasoning_tokens"), int):
                                    reasoning_token_count_round = usage["reasoning_tokens"]
                                details = usage.get("completion_tokens_details")
                                if isinstance(details, dict) and isinstance(details.get("reasoning_tokens"), int):
                                    reasoning_token_count_round = details["reasoning_tokens"]
                                _cached = extract_cached_input_tokens(usage)
                                if _cached is not None:
                                    cached_input_tokens_round = _cached
                            for choice in (payload.get("choices") or []):
                                delta = choice.get("delta") or {}
                                reasoning_piece = delta.get("reasoning")
                                if isinstance(reasoning_piece, str) and reasoning_piece:
                                    if not reasoning_active:
                                        reasoning_active = True
                                        reasoning_started_at_ms = _now_ms()
                                    yield NormalisedEvent(type="reasoning_delta", text=reasoning_piece)
                                content_piece = delta.get("content")
                                if isinstance(content_piece, str) and content_piece:
                                    if reasoning_active and not reasoning_end_emitted:
                                        duration_ms = _now_ms() - reasoning_started_at_ms if reasoning_started_at_ms is not None else None
                                        yield NormalisedEvent(
                                            type="reasoning_end",
                                            reasoning_token_count=reasoning_token_count_round,
                                            reasoning_duration_ms=duration_ms,
                                        )
                                        reasoning_end_emitted = True
                                        reasoning_active = False
                                    text_accumulator.append(content_piece)
                                    yield NormalisedEvent(type="delta", text=content_piece)
                                for ev in consume_tool_call_deltas(delta.get("tool_calls") or [], tool_buffers):
                                    yield ev
                                cf = choice.get("finish_reason")
                                if cf:
                                    finish_reason = cf
                            for receipt in extract_inline_images_from_chunk(payload):
                                async for image_event in self._emit_image_receipt(receipt):
                                    yield image_event

                    last_finish_reason = finish_reason
                    if cached_input_tokens_round is not None:
                        last_cached_input_tokens = cached_input_tokens_round
                    if finish_reason == "tool_calls" and tool_buffers:
                        # Execute the buffered calls locally, emit their
                        # events, and append the assistant tool-call turn
                        # + tool results so the next round sees them.
                        assistant_tool_calls: List[dict] = []
                        tool_result_messages: List[dict] = []
                        async for ev in execute_buffered_tool_calls(
                            tool_buffers, assistant_tool_calls, tool_result_messages
                        ):
                            yield ev
                        running_messages.append({
                            "role": "assistant",
                            "content": None,
                            "tool_calls": assistant_tool_calls,
                        })
                        running_messages.extend(tool_result_messages)
                        continue
                    # Any non-tool finish reason ends the chat turn.
                    break
                else:
                    # for...else: ran out of tool rounds without a final reply.
                    yield NormalisedEvent(
                        type="error",
                        detail=f"Tool-call loop exceeded {effective_cap} rounds without a final reply.",
                    )

            # Dev-mode diagnostic: flush a trailing failed call that had no
            # following tool call this turn (no-op unless launched with --dev).
            flush_pending_failure()
            if not emitted_end:
                yield NormalisedEvent(
                    type="end",
                    text="".join(text_accumulator),
                    finish_reason=last_finish_reason,
                    cached_input_tokens=last_cached_input_tokens,
                )
                emitted_end = True
        except httpx.HTTPError as e:
            yield NormalisedEvent(type="error", detail=f"network error ({type(e).__name__}): {e}")
        except asyncio.CancelledError:
            return
        except Exception as e:  # noqa: BLE001
            yield NormalisedEvent(type="error", detail=f"Unexpected error: {e}")

    async def _pump_chat_stream(
        self,
        upstream,
        is_cancelled: CancellationProbe,
    ) -> AsyncIterator[NormalisedEvent]:
        """Consume the upstream SSE stream and yield NormalisedEvents.
        Factored out so the API-standard-first / fallback retry path
        in `stream_chat` can call it twice without duplicating the
        per-line parse + accumulator state."""
        # `start` is synthesised on the first chunk so the frontend
        # gets one before any content shows up. `end` is emitted
        # exactly once — either on the `data: [DONE]` terminator
        # (the normal path) or as a fallback if the upstream closes
        # the connection without sending [DONE]. The accumulator
        # buffers the full reply for the `end.text` field, which is
        # what chat-panel persistence reads.
        text_accumulator: List[str] = []
        finish_reason: Optional[str] = None
        emitted_start = False
        emitted_end = False
        # Phase 2.5f — reasoning stream state. Mirrors the
        # text accumulator + wall-clock duration tracking used by
        # the LM Studio adapter.
        reasoning_token_count: Optional[int] = None
        reasoning_started_at_ms: Optional[int] = None
        reasoning_active = False
        reasoning_end_emitted = False
        # Phase 2.5i — prompt-cache hit count from the usage chunk
        # (OpenAI's `usage.prompt_tokens_details.cached_tokens`).
        # Populated when present; None if the upstream doesn't
        # report it for this turn. Surfaced on the terminal `end`
        # event so the chat panel can render a "cached: N tokens"
        # indicator.
        cached_input_tokens: Optional[int] = None

        def _record_reasoning_delta(text: str) -> NormalisedEvent:
            nonlocal reasoning_active, reasoning_started_at_ms
            if not reasoning_active:
                reasoning_active = True
                reasoning_started_at_ms = _now_ms()
            return NormalisedEvent(type="reasoning_delta", text=text)

        def _maybe_emit_reasoning_end() -> Optional[NormalisedEvent]:
            nonlocal reasoning_active, reasoning_end_emitted
            if not reasoning_active or reasoning_end_emitted:
                return None
            duration_ms = None
            if reasoning_started_at_ms is not None:
                duration_ms = _now_ms() - reasoning_started_at_ms
            reasoning_end_emitted = True
            reasoning_active = False
            return NormalisedEvent(
                type="reasoning_end",
                reasoning_token_count=reasoning_token_count,
                reasoning_duration_ms=duration_ms,
            )

        async for line in upstream.aiter_lines():
            if await is_cancelled():
                return
            if not line or not line.startswith("data:"):
                continue
            payload_text = line[5:].strip()
            if not payload_text:
                continue
            if payload_text == "[DONE]":
                # Emit reasoning_end if reasoning was active and we
                # never saw a clean transition into content (some
                # upstreams just stop emitting reasoning chunks
                # without a marker).
                trail = _maybe_emit_reasoning_end()
                if trail is not None:
                    yield trail
                if not emitted_end:
                    yield NormalisedEvent(
                        type="end",
                        text="".join(text_accumulator),
                        finish_reason=finish_reason,
                        cached_input_tokens=cached_input_tokens,
                    )
                    emitted_end = True
                return
            try:
                payload = json.loads(payload_text)
            except Exception:
                continue

            if not emitted_start:
                yield NormalisedEvent(
                    type="start",
                    message_id=payload.get("id"),
                )
                emitted_start = True

            # Pick up reasoning token count from usage when the
            # upstream reports it. OpenAI puts this under
            # `usage.completion_tokens_details.reasoning_tokens`;
            # OpenRouter puts it under `usage.reasoning_tokens` (plus
            # mirroring the OpenAI shape). Read both opportunistically.
            #
            # Phase 2.5i — also opportunistically pick up the
            # prompt-cache hit count. OpenAI's automatic prompt
            # caching reports it on `usage.prompt_tokens_details.cached_tokens`
            # for any prompt ≥1024 tokens (field is present but 0 for
            # smaller prompts). Surfaced on the terminal `end` event
            # below so the chat panel can render a "cached: N tokens"
            # indicator without per-adapter shape knowledge.
            usage = payload.get("usage")
            if isinstance(usage, dict):
                if isinstance(usage.get("reasoning_tokens"), int):
                    reasoning_token_count = usage["reasoning_tokens"]
                details = usage.get("completion_tokens_details")
                if isinstance(details, dict) and isinstance(details.get("reasoning_tokens"), int):
                    reasoning_token_count = details["reasoning_tokens"]
                prompt_details = usage.get("prompt_tokens_details")
                if isinstance(prompt_details, dict) and isinstance(prompt_details.get("cached_tokens"), int):
                    cached_input_tokens = prompt_details["cached_tokens"]

            # `choices` may be empty on the usage-only chunk that
            # arrives just before [DONE] when stream_options.include_usage
            # is set; the rest of the chunk shape is the same.
            choices = payload.get("choices") or []
            for choice in choices:
                delta = choice.get("delta") or {}
                # Phase 2.5f — reasoning delta. OpenAI / OpenRouter
                # surface streaming reasoning content on `delta.reasoning`
                # (string), alongside the usual `delta.content` for the
                # final response. Some upstreams also emit a
                # `reasoning_details` array — we ignore that for now
                # since the plain `reasoning` field carries the text
                # we need. Once final content starts arriving we
                # transition out of reasoning mode and emit the
                # reasoning_end marker.
                reasoning_piece = delta.get("reasoning")
                if isinstance(reasoning_piece, str) and reasoning_piece:
                    yield _record_reasoning_delta(reasoning_piece)
                content_piece = delta.get("content")
                # Text-delta path. Note: when the upstream emits the
                # OpenAI multimodal `content` ARRAY (shape #3 in the
                # planning doc) `content` will be a list, not a
                # string — we skip the string fast-path then and let
                # the image scanner below handle the parts.
                if isinstance(content_piece, str) and content_piece:
                    # Final-response text starting → reasoning stream
                    # is over. Flush the reasoning_end before any
                    # content chunks so the frontend can collapse the
                    # Thinking widget before the visible text starts.
                    trail = _maybe_emit_reasoning_end()
                    if trail is not None:
                        yield trail
                    text_accumulator.append(content_piece)
                    yield NormalisedEvent(type="delta", text=content_piece)
                cf = choice.get("finish_reason")
                if cf:
                    finish_reason = cf

            # Inline-image scanner (Phase 2.5e). Runs on every chunk
            # regardless of which upstream / model — the scanner
            # walks the chunk for known image-bearing shapes. Hosted
            # URLs trigger a server-side download to a data URL for
            # local display; the original URL is preserved on the
            # event as `image_wire_url` for re-forwarding on
            # subsequent turns.
            for receipt in extract_inline_images_from_chunk(payload):
                async for image_event in self._emit_image_receipt(receipt):
                    yield image_event

        # Fallback: some buggy upstreams close the connection
        # without ever sending `data: [DONE]`. Emit the close-out
        # event here so the chat panel reliably gets one.
        if not emitted_end:
            yield NormalisedEvent(
                type="end",
                text="".join(text_accumulator),
                finish_reason=finish_reason,
                cached_input_tokens=cached_input_tokens,
            )

    async def _emit_image_receipt(self, receipt) -> AsyncIterator[NormalisedEvent]:
        """Promote a scanner receipt to a normalised event. Downloads
        hosted URLs to a data URL before yielding; failures surface
        as `error` events so the writer sees what went wrong rather
        than a broken-image placeholder."""
        try:
            if not receipt.display_url.startswith("data:"):
                # Hosted URL — fetch bytes server-side and replace
                # `display_url` with the data URL.
                downloaded = await download_remote_image_to_data_url(receipt.wire_url)
                display_url = downloaded.display_url
                mime_type = downloaded.mime_type
            else:
                display_url = receipt.display_url
                mime_type = receipt.mime_type
        except Exception as e:  # noqa: BLE001
            yield NormalisedEvent(
                type="error",
                detail=f"Couldn't download generated image from upstream: {e}",
            )
            return
        yield NormalisedEvent(
            type="image",
            image_data_url=display_url,
            image_wire_url=receipt.wire_url,
            image_mime_type=mime_type,
        )

    # ── Helpers ────────────────────────────────────────────────

    @staticmethod
    def _auth_headers(api_key: Optional[str]) -> dict:
        """OpenAI-compatible upstreams use Bearer auth. Header
        omitted entirely when no key is set so local installs with
        auth disabled don't see a stray empty bearer token (which
        some servers reject).

        Also sets the attribution headers — `User-Agent` (identifies
        us in every upstream's server logs), plus the OpenRouter-
        specific `X-Title` and `HTTP-Referer` (drive attribution on
        their per-app leaderboard; ignored elsewhere)."""
        headers: dict = {
            "User-Agent": _USER_AGENT,
            "X-Title": _X_TITLE,
            "HTTP-Referer": _HTTP_REFERER,
        }
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        return headers


# ── Private translation helpers ──────────────────────────────────


def _build_messages(messages: List[ChatMessage], system_prompt: Optional[str], *, prefer_file_shape: bool = True) -> list:
    """Build the `messages` array. System prompt rides as the first
    message with role `system`; the rest of the history rides
    verbatim. ChatMessage's provider-agnostic `{role, content}`
    matches the OpenAI shape one-to-one for `user / assistant /
    system`, so no translation needed beyond stitching.

    Attachments (Phase 2.5e wire-encoding): when a message carries
    attachments, its `content` is promoted from a string to a
    content-parts array per the OpenAI spec
    (`.References/OpenAI Chat Completions API.md` lines 86–90).

    `prefer_file_shape` controls how TEXT-kind attachments serialise:
      * True (default) — emit each text attachment as its own
        `{type:"file", file:{file_data, filename}}` content part,
        the API-standard shape. OpenAI's hosted endpoint, OpenRouter,
        and any other compliant implementer extract the text on the
        upstream so the model sees the attachment as a named file.
      * False — inline text attachments into the leading `{type:"text"}`
        content part using Anthropic's `<documents>` / `<document>`
        XML convention. This is the fallback we use when an upstream
        rejected `type:"file"` (e.g. LM Studio's OpenAI-compat path,
        which only supports `text` and `image_url` content types per
        their 400 response: 'content objects must have a type field
        that is either text or image_url').

    Image-kind and binary file-kind attachments always use their
    native content parts — no fallback shape exists for them. Binary
    rejections by the upstream surface as errors to the writer."""
    out: list = []
    if system_prompt:
        out.append({"role": "system", "content": system_prompt})
    for m in messages:
        if m.attachments:
            out.append({"role": m.role, "content": _build_content_parts(m.content, m.attachments, prefer_file_shape=prefer_file_shape)})
        else:
            out.append({"role": m.role, "content": m.content})
    return out


def _build_content_parts(text: str, attachments: list, *, prefer_file_shape: bool = True) -> list:
    """Translate a `(text, attachments)` pair into the OpenAI
    content-parts array shape.

    `prefer_file_shape` (default True) controls text-attachment
    handling — see `_build_messages` docstring for the full rationale.
    Briefly: True = each text attachment becomes its own
    `type:"file"` content part (API standard). False = text
    attachments inline into the leading text part as XML-wrapped
    `<document>` blocks (fallback for upstreams that reject the
    file content part).

    Image and binary file kinds are unaffected by the flag — they
    always use their native content parts.
    """
    parts: list = []
    text_attachments = [a for a in attachments if a.kind == "text"]
    other_attachments = [a for a in attachments if a.kind != "text"]

    if not prefer_file_shape and text_attachments:
        # Fallback shape: wrap text attachments as Anthropic-style
        # `<document><source>name</source><content>...</content></document>`
        # blocks and prepend to the writer's typed text in a single
        # `{type:"text"}` content part. Documents come BEFORE the
        # user message so the model has the data before the question.
        doc_blocks = [_format_text_attachment_as_xml(att) for att in text_attachments]
        if len(doc_blocks) > 1:
            doc_prefix = "<documents>\n" + "\n".join(doc_blocks) + "\n</documents>"
        else:
            doc_prefix = doc_blocks[0]
        combined = doc_prefix + ("\n\n" + text if text else "")
        parts.append({"type": "text", "text": combined})
    else:
        # API-standard shape: writer's text leads, text attachments
        # follow as `type:"file"` content parts.
        if text:
            parts.append({"type": "text", "text": text})
        for att in text_attachments:
            parts.append(_format_text_attachment_part(att))

    # Image and binary file kinds always use their native shapes.
    for att in other_attachments:
        if att.kind == "image":
            parts.append(_format_image_attachment_part(att))
        elif att.kind == "file":
            parts.append(_format_file_attachment_part(att))
    return parts


def _format_text_attachment_as_xml(att) -> str:
    """Fallback text-attachment shape — XML-wrapped `<document>`
    block for inlining when the upstream rejects `type:"file"`.
    Same convention as the LM Studio native adapter uses; widely
    trained across Llama / Qwen / Pixtral / Gemma and (of course)
    Claude. The `<source>` tag carries the filename so the model
    can refer to it by name."""
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


# ── Per-kind attachment formatters (OpenAI-compatible) ────────────
#
# Each emits the native content-part shape from the OpenAI Chat
# Completions spec for the given attachment kind. Subclassed
# adapters (e.g. OpenRouter) inherit these unchanged because the
# wire shape is identical end-to-end; OpenRouter handles internal
# routing / file-parser plugin invocation on its side.


def _format_text_attachment_part(att) -> dict:
    """OpenAI Chat Completions `type:"file"` content part for a text
    attachment. Per OpenAI's File Inputs guide, text and code files
    (.txt, .md, .docx, .py, etc.) are accepted alongside PDFs via
    the same `file_data` data-URL shape — the API extracts text
    from non-PDF document types on the model's behalf, so the model
    sees the attachment as a NAMED FILE, not as pasted body text in
    the user's message. This is what `properly handles a text file`
    means for this API surface."""
    return {
        "type": "file",
        "file": {
            "file_data": f"data:{att.mime_type};base64,{att.data_base64}",
            "filename": att.name,
        },
    }


def _format_image_attachment_part(att) -> dict:
    """OpenAI `type:"image_url"` content part. Two sources for the
    URL:

      * `wire_url` (Phase 2.5e assistant-image roll-forward) — when
        the persisted assistant attachment carries the upstream's
        original hosted URL, forward it verbatim. Avoids re-uploading
        bytes the model already gave us; preserves whatever shape the
        upstream emitted on the FIRST turn for every subsequent turn.
      * `data_base64` (default) — the writer's uploaded image bytes
        with the frontend's 1568 px long-edge cap + JPEG q85 / PNG-
        if-alpha re-encode already applied.
    """
    if att.wire_url:
        return {
            "type": "image_url",
            "image_url": {"url": att.wire_url},
        }
    return {
        "type": "image_url",
        "image_url": {"url": f"data:{att.mime_type};base64,{att.data_base64}"},
    }


def _format_file_attachment_part(att) -> dict:
    """OpenAI `type:"file"` content part for PDFs (and any other
    binary file kinds the picker may surface in future). Same
    shape as the text formatter above; the MIME inside the data
    URL is what tells the upstream how to handle it."""
    return {
        "type": "file",
        "file": {
            "file_data": f"data:{att.mime_type};base64,{att.data_base64}",
            "filename": att.name,
        },
    }


def _b64_to_text(data_base64: str) -> str:
    import base64
    return base64.b64decode(data_base64).decode("utf-8", errors="replace")


def _extract_error_detail(status_code: int, reason_phrase: str, body_text: str) -> str:
    """Build a writer-readable error detail from an upstream
    non-2xx response. OpenAI-compatible upstreams return:
        { "error": { "message": "...", "type": "...", "code": "..." } }
    but many local servers return a free-form text body or a
    differently-shaped JSON. Falls back to status + reason +
    truncated body when the envelope isn't there."""
    try:
        payload = json.loads(body_text)
    except Exception:
        return f"{status_code} {reason_phrase}: {body_text}"
    err = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(err, dict):
        msg = err.get("message")
        if isinstance(msg, str) and msg.strip():
            code = err.get("code") or err.get("type")
            return f"{status_code} {reason_phrase}: {msg}" + (f" ({code})" if code else "")
    # Some upstreams (Ollama in older versions) put the error
    # message directly on the top-level `message` field.
    msg = payload.get("message") if isinstance(payload, dict) else None
    if isinstance(msg, str) and msg.strip():
        return f"{status_code} {reason_phrase}: {msg}"
    return f"{status_code} {reason_phrase}: {body_text}"


def _normalise_models(payload: dict) -> List[DiscoveredModel]:
    """Convert /v1/models output into the cross-provider
    `DiscoveredModel` list. The OpenAI-compatible models endpoint
    returns:
        { "object": "list", "data": [
            { "id": "...", "object": "model", "created": ..., "owned_by": "..." },
            ...
        ]}
    Per-upstream extensions sneak in extra fields; this normaliser
    opportunistically picks up structured `architecture` data when
    present (OpenRouter's `/v1/models` surfaces it with
    `architecture.input_modalities` / `architecture.output_modalities`)
    so vision / file / audio gating can run from a single discovery
    call. When the upstream doesn't surface modality info, we fall
    back to the hardcoded `_KNOWN_MODEL_CAPABILITIES` table keyed by
    id-prefix for the well-known vision-capable model families
    (gpt-4o, gpt-4-vision, claude-3+, gemini, etc.). Models with
    no match in either source land with `input_modalities=None`,
    which downstream consumers treat as text-only.
    """
    raw = payload.get("data")
    if not isinstance(raw, list):
        return []
    out: List[DiscoveredModel] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get("id") or entry.get("model")
        if not model_id:
            continue
        owned_by = entry.get("owned_by")

        input_modalities: Optional[List[str]] = None
        output_modalities: Optional[List[str]] = None
        supports_tool_use: Optional[bool] = None
        supports_reasoning: Optional[bool] = None
        reasoning_options: Optional[List[str]] = None

        arch = entry.get("architecture")
        if isinstance(arch, dict):
            in_mods = arch.get("input_modalities")
            if isinstance(in_mods, list):
                input_modalities = [str(m) for m in in_mods if isinstance(m, (str,))]
            out_mods = arch.get("output_modalities")
            if isinstance(out_mods, list):
                output_modalities = [str(m) for m in out_mods if isinstance(m, (str,))]
        # OpenRouter exposes a `supported_parameters` array on each
        # model entry (enum includes `tools`, `tool_choice`,
        # `parallel_tool_calls`, `reasoning`, `include_reasoning`,
        # `reasoning_effort`, etc.). Reading these is more reliable
        # than guessing from the model id — a model that surfaces
        # `tools` in its supported params accepts tool calling, full
        # stop. Same for reasoning. We treat None (field absent) as
        # "unknown" and only set the flag when the array makes the
        # answer explicit.
        #
        # Phase 2.5f — when reasoning is signalled via decoration,
        # also populate `reasoning_options` with the OpenRouter
        # API-wide enum. The unified OpenRouter shape accepts the
        # same effort set for every reasoning-capable model on its
        # surface; non-OpenRouter upstreams that happen to send the
        # `supported_parameters` array typically follow the same
        # shape so the same enum is the safe default for tier 1.
        params = entry.get("supported_parameters")
        if isinstance(params, list):
            params_set = {str(p) for p in params if isinstance(p, str)}
            if "tools" in params_set or "tool_choice" in params_set:
                supports_tool_use = True
            if any(k in params_set for k in ("reasoning", "include_reasoning", "reasoning_effort")):
                supports_reasoning = True
                reasoning_options = list(_OPENROUTER_REASONING_OPTIONS)

        if (
            input_modalities is None
            or supports_tool_use is None
            or supports_reasoning is None
            or reasoning_options is None
        ):
            # Fall back to the hardcoded prefix table for upstreams
            # that don't return capability info — and for individual
            # fields that the upstream surfaced partial info for.
            hit = _capabilities_from_model_id(str(model_id))
            if hit is not None:
                if input_modalities is None:
                    input_modalities = hit.get("input_modalities")
                if output_modalities is None:
                    output_modalities = hit.get("output_modalities")
                if supports_tool_use is None:
                    supports_tool_use = hit.get("supports_tool_use")
                if supports_reasoning is None:
                    supports_reasoning = hit.get("supports_reasoning")
                if reasoning_options is None and hit.get("reasoning_options"):
                    reasoning_options = list(hit["reasoning_options"])

        # Phase 3.10 Layer 5 — context window. OpenRouter surfaces
        # `context_length` per model; the generic OpenAI-compatible
        # surface doesn't carry it (returns None and the scene-wiring
        # chunker falls back to its conservative default). Defensive
        # int-coerce so a stringified value doesn't crash discovery.
        ctx_raw = entry.get("context_length")
        try:
            context_window = int(ctx_raw) if ctx_raw is not None else None
        except (TypeError, ValueError):
            context_window = None

        out.append(DiscoveredModel(
            id=str(model_id),
            display_name=None,
            publisher=str(owned_by) if owned_by else None,
            capabilities=None,
            params_string=None,
            input_modalities=input_modalities,
            output_modalities=output_modalities,
            supports_tool_use=supports_tool_use,
            supports_reasoning=supports_reasoning,
            reasoning_options=reasoning_options,
            context_window=context_window,
        ))
    return out


# OpenRouter's API-wide reasoning-effort enum, per `.References/openrouter-api.yaml`
# (`BaseReasoningConfig.effort`). Every reasoning-capable model on
# OpenRouter accepts the same string set — the API decides per-model
# what each value maps to internally. We populate this on every model
# whose `supported_parameters` array contains `"reasoning"`.
_OPENROUTER_REASONING_OPTIONS = ["none", "minimal", "low", "medium", "high", "xhigh"]

# OpenAI reasoning families per the official Responses + Chat
# Completions reasoning docs. The o1/o3 generation predates `minimal`
# and ONLY accepts `low / medium / high`. The GPT-5 family adds
# `minimal` for fast TTFT. `xhigh` exists on some GPT-5.x variants
# but is intentionally NOT added here (we'd guess wrong as often as
# right — leave it to a future per-model table if we ever ship one).
_OPENAI_O_FAMILY_OPTIONS    = ["low", "medium", "high"]
_OPENAI_GPT5_FAMILY_OPTIONS = ["minimal", "low", "medium", "high"]

# Universal subset every reasoning-capable enum-based provider
# accepts. Used as the fallback for adapter-table entries that mark a
# model as reasoning-capable without a more specific option list.
_UNIVERSAL_REASONING_OPTIONS = ["low", "medium", "high"]


# Hardcoded model→capabilities lookup table for OpenAI-compatible
# upstreams that don't surface capability info on `/v1/models`. Keys
# are case-insensitive substring matches against the model id. The
# entry chosen is the FIRST whose key appears in the id (in iteration
# order). When no key matches, we leave the structured fields None
# and the frontend treats that as "text only / unknown."
#
# Bump entries here when new vision-capable model families appear.
# Authoritative shape mirrors the OpenRouter modality vocabulary
# (`text`, `image`, `file`, `audio`, `video`).
_KNOWN_MODEL_CAPABILITIES: List[tuple[str, dict]] = [
    # OpenAI reasoning models (o-series) — text only on input,
    # explicit reasoning-mode support. Tool use is supported on the
    # newer o3/o4 generation but historically not on o1; treat the
    # whole series as tool-capable since the API surface accepts it
    # and providers will reject when not supported.
    ("o1",                {"input_modalities": ["text"], "output_modalities": ["text"], "supports_tool_use": True, "supports_reasoning": True, "reasoning_options": _OPENAI_O_FAMILY_OPTIONS}),
    ("o3",                {"input_modalities": ["text", "image"], "output_modalities": ["text"], "supports_tool_use": True, "supports_reasoning": True, "reasoning_options": _OPENAI_O_FAMILY_OPTIONS}),
    ("o4",                {"input_modalities": ["text", "image"], "output_modalities": ["text"], "supports_tool_use": True, "supports_reasoning": True, "reasoning_options": _OPENAI_O_FAMILY_OPTIONS}),
    # OpenAI multimodal models — vision input, text output.
    ("gpt-4o",            {"input_modalities": ["text", "image"], "output_modalities": ["text"], "supports_tool_use": True}),
    ("gpt-4-vision",      {"input_modalities": ["text", "image"], "output_modalities": ["text"], "supports_tool_use": True}),
    ("gpt-4-turbo",       {"input_modalities": ["text", "image"], "output_modalities": ["text"], "supports_tool_use": True}),
    ("gpt-5",             {"input_modalities": ["text", "image"], "output_modalities": ["text"], "supports_tool_use": True, "supports_reasoning": True, "reasoning_options": _OPENAI_GPT5_FAMILY_OPTIONS}),
    # Anthropic Claude 3+ — vision input + PDFs (file modality) on
    # Claude 3.5+ via direct API; treat the whole 3.x family as
    # vision-capable, with PDF only on 3.5 / 4.x. Claude 3.7 / 4.x
    # ship extended-thinking (reasoning) support. Anthropic's actual
    # native wire shape is numeric `budget_tokens`, not an enum, but
    # via the openai_compatible adapter (i.e. proxied through
    # OpenRouter or similar) the writer hits an effort-style enum
    # surface. Universal subset is the safe choice.
    ("claude-3-5",        {"input_modalities": ["text", "image", "file"], "output_modalities": ["text"], "supports_tool_use": True}),
    ("claude-3.5",        {"input_modalities": ["text", "image", "file"], "output_modalities": ["text"], "supports_tool_use": True}),
    ("claude-3-7",        {"input_modalities": ["text", "image", "file"], "output_modalities": ["text"], "supports_tool_use": True, "supports_reasoning": True, "reasoning_options": _UNIVERSAL_REASONING_OPTIONS}),
    ("claude-4",          {"input_modalities": ["text", "image", "file"], "output_modalities": ["text"], "supports_tool_use": True, "supports_reasoning": True, "reasoning_options": _UNIVERSAL_REASONING_OPTIONS}),
    ("claude-3",          {"input_modalities": ["text", "image"], "output_modalities": ["text"], "supports_tool_use": True}),
    # Google Gemini multimodal. 2.x has thinking mode.
    ("gemini-1.5",        {"input_modalities": ["text", "image", "file", "audio", "video"], "output_modalities": ["text"], "supports_tool_use": True}),
    ("gemini-2",          {"input_modalities": ["text", "image", "file", "audio", "video"], "output_modalities": ["text"], "supports_tool_use": True, "supports_reasoning": True, "reasoning_options": _UNIVERSAL_REASONING_OPTIONS}),
    ("gemini-pro-vision", {"input_modalities": ["text", "image"], "output_modalities": ["text"], "supports_tool_use": True}),
    # Llama 3.2 Vision family.
    ("llama-3.2-11b-vision", {"input_modalities": ["text", "image"], "output_modalities": ["text"], "supports_tool_use": False}),
    ("llama-3.2-90b-vision", {"input_modalities": ["text", "image"], "output_modalities": ["text"], "supports_tool_use": False}),
    # Qwen 2/2.5/3 vision-language families. Qwen3-thinking variants
    # ship reasoning support.
    ("qwen2-vl",          {"input_modalities": ["text", "image"], "output_modalities": ["text"], "supports_tool_use": False}),
    ("qwen2.5-vl",        {"input_modalities": ["text", "image"], "output_modalities": ["text"], "supports_tool_use": False}),
    ("qwen3-thinking",    {"input_modalities": ["text"], "output_modalities": ["text"], "supports_tool_use": True, "supports_reasoning": True, "reasoning_options": _UNIVERSAL_REASONING_OPTIONS}),
    ("qwq",               {"input_modalities": ["text"], "output_modalities": ["text"], "supports_tool_use": False, "supports_reasoning": True, "reasoning_options": _UNIVERSAL_REASONING_OPTIONS}),
    # DeepSeek R1 family — reasoning-trained.
    ("deepseek-r1",       {"input_modalities": ["text"], "output_modalities": ["text"], "supports_tool_use": False, "supports_reasoning": True, "reasoning_options": _UNIVERSAL_REASONING_OPTIONS}),
    # Pixtral.
    ("pixtral",           {"input_modalities": ["text", "image"], "output_modalities": ["text"], "supports_tool_use": False}),
]


def _capabilities_from_model_id(model_id: str) -> Optional[dict]:
    """First-match case-insensitive substring lookup against
    `_KNOWN_MODEL_CAPABILITIES`. Returns the matching dict or None."""
    if not model_id:
        return None
    lower = model_id.lower()
    for prefix, caps in _KNOWN_MODEL_CAPABILITIES:
        if prefix in lower:
            return caps
    return None


async def _http_get_json(url: str, headers: dict) -> tuple[Optional[dict], Optional[str]]:
    """Shared GET-JSON helper, mirrors the one in
    `lmstudio_rest_v1.py`. Returns `(payload, None)` on success or
    `(None, error_string)` on failure."""
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
