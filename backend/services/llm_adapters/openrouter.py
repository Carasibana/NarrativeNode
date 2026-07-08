"""OpenRouter adapter — Phase 2.5b.

Subclasses `OpenAiCompatibleAdapter` because the chat-completions
shape is identical (OpenRouter publishes itself as OpenAI-compatible
for `/v1/chat/completions` and `/v1/models`). What this adapter
adds on top is **client-side MCP tool use**: when the writer turns
the MCP toggle on for an OpenRouter connection, we enumerate every
tool on NarrativeNode's local MCP server, declare them as standard
OpenAI function tools on the chat request, and execute the tool
calls locally as they stream back. This is the only architecture
that works for cloud-hosted upstreams — they can't reach the
writer's `localhost:13316` no matter what URL we'd hand them.

The flow per chat turn:

  1. List local MCP tools (`mcp_tool_bridge.list_mcp_tools_as_openai_functions`)
     and inject them into the request body's `tools` array.
  2. POST and stream the response. Content deltas surface as
     normal `delta` events; tool-call deltas accumulate into a
     per-call buffer keyed by `tool_calls[].index`.
  3. When `finish_reason: "tool_calls"` arrives, execute each
     buffered call locally via `mcp_tool_bridge.invoke_mcp_tool`,
     emit `tool_call` events with `start → arguments → success`
     phases (the chat panel renders the chip status off these),
     append the assistant turn (with its `tool_calls`) plus one
     `role: "tool"` message per result to the running messages
     list, and loop back to step 1.
  4. When `finish_reason` is anything else (`stop`, `length`, ...),
     emit the close-out `end` event and return.

Why not OpenRouter's server-side MCP shape (`tools[].type: "mcp"`
with `server_url`)? Because OpenRouter would call that URL from
their data centres. The writer's MCP server lives at
`http://localhost:13316/mcp/server` — from OpenRouter's POV,
`localhost` is OpenRouter's loopback, not the writer's. Server-side
MCP works for upstreams that share the writer's machine (LM Studio);
it doesn't work for cloud upstreams. Public-tunnel workarounds were
explicitly rejected.

What this adapter does NOT do in v1:
  * Per-message provider preferences, `transforms`, `models`
    fallback array, `route: "fallback"`.
  * Cost / generation telemetry streamed alongside content.
  * Per-connection `HTTP-Referer` / `X-Title` overrides.
  * MCP session-state gating beyond what the MCP server / frontend
    dispatcher already enforce. Write tools that require an active
    MCP session will return a session-state error envelope just as
    they would for an external MCP client; the model sees the
    envelope as the tool's output and reacts.

The OpenRouter wire spec lives at `.References/openrouter-api.yaml`.
"""
import json
from typing import Any, AsyncIterator, Callable, List, Optional

import httpx

from services.dev_tool_call_log import flush_pending_failure, record_tool_call
from .base import CancellationProbe, ChatMessage, NormalisedEvent, extract_cached_input_tokens
from .inline_image_scanner import extract_inline_images_from_chunk
from .mcp_tool_bridge import (
    consume_tool_call_deltas,
    elide_aged_tool_results,
    invoke_mcp_tool,
    list_mcp_tools_as_openai_functions,
    mcp_session_is_active,
    resolve_tool_round_cap,
    tool_result_is_error,
    try_parse_tool_args,
)
from .openai_compatible import (
    OpenAiCompatibleAdapter,
    _STREAM_TIMEOUT_SECONDS,
    _build_messages,
    _extract_error_detail,
    _now_ms,
)


# Tool-round cap (default 8, per-connection via
# `ApiConnectionProfile.mcp_max_tool_rounds`, ∞ for the slider's "No
# limit") is resolved by the shared `resolve_tool_round_cap` helper.


class OpenRouterAdapter(OpenAiCompatibleAdapter):
    api_type = "openrouter"
    supports_mcp = True

    # Discovery, test-connection, URL normalisation, auth headers all
    # inherit from `OpenAiCompatibleAdapter` unchanged. Only
    # `stream_chat` is overridden, because OpenRouter chats can
    # interleave tool-call rounds with content streaming — the
    # control flow is fundamentally different from the
    # single-request OpenAI-compat path.

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
        capability_sink: Optional[Callable[..., None]] = None,  # noqa: ARG002 — OpenRouter guarantees file support, no retry path
        reasoning_level: Optional[Any] = None,
        reasoning_summary: Optional[str] = None,
        max_tool_rounds: Optional[int] = None,
    ) -> AsyncIterator[NormalisedEvent]:
        # Resolve the per-connection tool-round cap (shared helper).
        effective_cap = resolve_tool_round_cap(max_tool_rounds)
        url = f"{base_url.rstrip('/')}/v1/chat/completions"
        headers = self._auth_headers(api_key)
        headers["Accept"] = "text/event-stream"
        headers["Content-Type"] = "application/json"

        # OpenRouter's `type:"file"` content part is documented for
        # PDF documents only (their ChatContentFile schema + file-
        # parser plugin are explicitly PDF-focused; the Mistral OCR
        # engine is the canonical handler). For text / markdown /
        # source-code attachments, OpenRouter does NOT document
        # support via `type:"file"` and individual upstream models
        # routed through OpenRouter reject the shape with HTTP 400.
        #
        # So on OpenRouter we default text-kind attachments to the
        # XML-inline fallback shape (Anthropic's `<document>` /
        # `<documents>` convention — widely-trained across the
        # models OpenRouter routes to). Binary file kinds (.pdf,
        # .docx, .pptx, .xlsx) still ride as `type:"file"` because
        # they have no text fallback and OpenRouter's parser does
        # accept them.
        #
        # `supports_file_content_part=True` cached on the model can
        # still flip this back to the spec shape — a future
        # capability discovery step might confirm a specific model
        # actually handles text via type:"file", and the cached
        # value overrides the default.
        cached_supports_file: Optional[bool] = None
        if model_capabilities is not None:
            cached_supports_file = getattr(model_capabilities, "supports_file_content_part", None)
        # Default False for OpenRouter; only True when the cache
        # explicitly says so.
        prefer_file_shape = (cached_supports_file is True)

        # Retry on round 0 is a defensive safety net — fires when
        # we DID try the spec shape (cached True) and got a 400.
        # Almost never reached in practice because the default is
        # already False for text on this adapter.
        has_text_attachments = any(
            a.kind == "text" for m in messages for a in (m.attachments or [])
        )

        # Running messages list. Starts with the system + history,
        # grows by (assistant tool-call turn, one tool message per
        # call) on each tool-execution round, then keeps going.
        running_messages = _build_messages(messages, system_prompt, prefer_file_shape=prefer_file_shape)
        # Declare our MCP tools when the writer has the toggle on.
        # `mcp_server_url` is the legacy signalling channel from
        # the chat router (truthy when the writer has enabled MCP
        # for this connection); we ignore the URL itself because
        # we execute tools locally, but the presence of a value
        # tells us the writer wants MCP turned on.
        tools_payload: Optional[List[dict]] = None
        if mcp_server_url:
            tools_payload = await list_mcp_tools_as_openai_functions()
            if not tools_payload:
                tools_payload = None  # No tools to expose; skip the field.
        # P0: track the session-active state the payload was built under, so a
        # session GRANTED mid-turn rebuilds the catalogue on the next round
        # (Track E gates the write-tool half on an active session).
        tools_payload_active = await mcp_session_is_active() if mcp_server_url else None

        emitted_start = False
        emitted_end = False
        text_accumulator: List[str] = []
        last_finish_reason: Optional[str] = None
        # Phase 2.5i — last round's cache-hit count. Carried forward
        # so the terminal `end` event reports whichever round
        # consumed the cached input prefix (always round 0 in
        # practice, since tool rounds run with different running
        # message lists that wouldn't share a cacheable prefix).
        last_cached_input_tokens: Optional[int] = None

        try:
            async with httpx.AsyncClient(timeout=_STREAM_TIMEOUT_SECONDS) as client:
                # Phase 2.5e — image-output opt-in. When the active
                # model advertises `image` in `output_modalities`,
                # tell the upstream we accept inline images in the
                # response. The scanner picks images up regardless,
                # but the hint nudges the model to actually emit
                # them when the prompt is image-shaped.
                out_mods = getattr(model_capabilities, "output_modalities", None) if model_capabilities else None
                send_image_modality = isinstance(out_mods, list) and "image" in out_mods

                for round_index in range(effective_cap):
                    # Phase 7.4 Track D: drop old, large tool results from the
                    # running list so they stop re-sending every round once the
                    # model has consumed them.
                    elide_aged_tool_results(running_messages)
                    # P0: rebuild the served catalogue when the session-active
                    # state has flipped since the payload was built, so a
                    # mid-turn session grant surfaces the write tools now
                    # instead of only after a fresh turn.
                    if mcp_server_url:
                        now_session_active = await mcp_session_is_active()
                        if now_session_active != tools_payload_active:
                            rebuilt = await list_mcp_tools_as_openai_functions()
                            tools_payload = rebuilt or None
                            tools_payload_active = now_session_active
                    body: dict = {
                        "model": model,
                        "messages": running_messages,
                        "stream": True,
                        "stream_options": {"include_usage": True},
                        # Phase 2.5i — prompt caching. OpenRouter
                        # accepts `cache_control` at the top level as
                        # a documented universal field; for Claude
                        # routes it auto-places an Anthropic-native
                        # cache_control marker on the last cacheable
                        # block, for OpenAI / DeepSeek routes the
                        # field is silently ignored (those providers
                        # auto-cache without a flag). 5m TTL is the
                        # safe default — break-even on cache writes
                        # at ~2 reads, which any thread with a
                        # follow-up question already clears.
                        "cache_control": {"type": "ephemeral", "ttl": "5m"},
                    }
                    if send_image_modality:
                        body["modalities"] = ["image", "text"]
                    if tools_payload is not None:
                        body["tools"] = tools_payload
                        # Let the model decide; `"auto"` is the
                        # canonical no-coercion choice.
                        body["tool_choice"] = "auto"
                    # Phase 2.5f — OpenRouter unified `reasoning`
                    # object per `.References/openrouter-api.yaml`
                    # `BaseReasoningConfig` (lines 2809-2818) / chat
                    # request shape (lines 4426-4448). `effort` is
                    # the string enum (`none / minimal / low / medium
                    # / high / xhigh`), `summary` is the verbosity
                    # control. Both are optional; we emit whichever
                    # the writer set. None on the reasoning_level
                    # arg means reasoning is OFF for this send and we
                    # omit the whole `reasoning` object.
                    reasoning_obj: dict = {}
                    if reasoning_level is not None and isinstance(reasoning_level, str) and reasoning_level:
                        reasoning_obj["effort"] = reasoning_level
                    if reasoning_summary is not None and isinstance(reasoning_summary, str) and reasoning_summary:
                        reasoning_obj["summary"] = reasoning_summary
                    if reasoning_obj:
                        body["reasoning"] = reasoning_obj

                    # Per-tool-call buffer for this round. Reset on
                    # every iteration so each round's tool calls
                    # accumulate independently.
                    tool_buffers: dict = {}
                    finish_reason: Optional[str] = None
                    round_message_id: Optional[str] = None
                    round_done = False
                    # Phase 2.5i — prompt-cache reporting for this
                    # round. OpenRouter normalises cache usage into
                    # `usage.cache_read_input_tokens` (Anthropic-
                    # native field, mirrors OpenAI's `cached_tokens`
                    # on OpenAI / DeepSeek routes). Surfaced on the
                    # round's terminal `end` event so the chat panel
                    # can render the "cached: N tokens" indicator.
                    cached_input_tokens_round: Optional[int] = None
                    # Phase 2.5f — per-round reasoning state. Each
                    # round is its own HTTP request and so may have
                    # its own reasoning stream; reset on every round.
                    reasoning_started_at_ms: Optional[int] = None
                    reasoning_active = False
                    reasoning_end_emitted = False
                    reasoning_token_count_round: Optional[int] = None

                    async with client.stream("POST", url, headers=headers, json=body) as upstream:
                        # Round-0 retry: if the spec `type:"file"`
                        # shape was rejected by the upstream (a
                        # specific OpenRouter / upstream-provider
                        # quirk we've observed for text/markdown
                        # files routed to certain models), rebuild
                        # the messages with text attachments inlined
                        # as XML and re-issue this same round. Only
                        # eligible when (a) we're on round 0, (b)
                        # we attempted the spec shape, (c) text-kind
                        # attachments are present. Persists
                        # `supports_file_content_part=False` so
                        # future sends skip the failed attempt.
                        if (
                            upstream.status_code == 400
                            and round_index == 0
                            and prefer_file_shape
                            and has_text_attachments
                        ):
                            body_text_400 = (await upstream.aread()).decode("utf-8", errors="replace")[:2000]
                            print(
                                f"[openrouter] 400 on type:file attempt for model={model!r}; "
                                f"retrying with XML-inline fallback. Upstream said: {body_text_400[:300]}",
                                flush=True,
                            )
                            prefer_file_shape = False
                            running_messages = _build_messages(messages, system_prompt, prefer_file_shape=False)
                            if capability_sink is not None:
                                try:
                                    capability_sink(model, "supports_file_content_part", False)
                                except Exception as e:  # noqa: BLE001
                                    print(f"[openrouter] capability_sink failed (non-fatal): {e}", flush=True)
                            # Re-issue round 0 by sending a new POST
                            # with the fallback shape. We do this
                            # inline (one nested `async with`) so we
                            # don't have to refactor the round loop.
                            body["messages"] = running_messages
                            async with client.stream("POST", url, headers=headers, json=body) as upstream2:
                                if upstream2.status_code >= 400:
                                    body_text = (await upstream2.aread()).decode("utf-8", errors="replace")[:2000]
                                    yield NormalisedEvent(
                                        type="error",
                                        detail=_extract_error_detail(upstream2.status_code, upstream2.reason_phrase, body_text),
                                    )
                                    return
                                # Swap upstream → upstream2 for the
                                # rest of the round body. Python
                                # rebinding is fine since `upstream`
                                # is just a name in this scope.
                                upstream = upstream2  # noqa: PLW2901 — intentional rebind
                                async for line in upstream.aiter_lines():
                                    # Inline the line-handling that
                                    # the outer `async for` was about
                                    # to run. Falls into the same
                                    # logic after this branch.
                                    if await is_cancelled():
                                        return
                                    if not line or not line.startswith("data:"):
                                        continue
                                    payload_text = line[5:].strip()
                                    if not payload_text:
                                        continue
                                    if payload_text == "[DONE]":
                                        round_done = True
                                        break
                                    try:
                                        payload = json.loads(payload_text)
                                    except Exception:
                                        continue
                                    if not emitted_start:
                                        yield NormalisedEvent(type="start", message_id=payload.get("id"))
                                        emitted_start = True
                                    if round_message_id is None and payload.get("id"):
                                        round_message_id = payload["id"]
                                    # Pick up reasoning token count if reported.
                                    # Phase 2.5i — also opportunistically read the
                                    # cache-hit count. OpenRouter normalises this
                                    # to `usage.cache_read_input_tokens` (Anthropic
                                    # field; mirrors OpenAI's `cached_tokens` on
                                    # OpenAI / DeepSeek routes). Fall back to the
                                    # OpenAI `prompt_tokens_details.cached_tokens`
                                    # shape if the upstream emits that instead.
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
                                    # Inline-image scanner (Phase 2.5e).
                                    # Same path as the parent's
                                    # `_pump_chat_stream` — runs once
                                    # per chunk, downloads hosted URLs
                                    # server-side before yielding.
                                    for receipt in extract_inline_images_from_chunk(payload):
                                        async for image_event in self._emit_image_receipt(receipt):
                                            yield image_event
                                # Skip the original-attempt's
                                # line-iteration below; the retry's
                                # already pumped the stream.
                                # `continue` from this inner async
                                # for / nested `with` would still
                                # land in the outer's line-iteration
                                # which has already exited via the
                                # rebinding above. Cleanest: fall
                                # through to the round-end logic
                                # below.
                            # End of fallback retry branch.
                        elif upstream.status_code >= 400:
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
                                round_done = True
                                break
                            try:
                                payload = json.loads(payload_text)
                            except Exception:
                                continue

                            if not emitted_start:
                                yield NormalisedEvent(type="start", message_id=payload.get("id"))
                                emitted_start = True
                            if round_message_id is None and payload.get("id"):
                                round_message_id = payload["id"]
                            # Pick up reasoning token count if reported.
                            # Phase 2.5i — also read the cache-hit count
                            # (`usage.cache_read_input_tokens` on Anthropic
                            # routes, `usage.prompt_tokens_details.cached_tokens`
                            # on OpenAI / DeepSeek routes).
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
                                # Phase 2.5f — reasoning delta. Per
                                # OpenRouter spec lines 4741-4745
                                # (`ChatStreamChoiceDelta.reasoning`),
                                # streaming reasoning content arrives as
                                # `delta.reasoning` string. Flush
                                # `reasoning_end` when final-response
                                # content starts so the frontend can
                                # collapse the Thinking widget.
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
                            # Inline-image scanner (Phase 2.5e). Mirrors
                            # the parent's `_pump_chat_stream` path —
                            # one call per chunk, downloads hosted URLs
                            # server-side before yielding the event.
                            for receipt in extract_inline_images_from_chunk(payload):
                                async for image_event in self._emit_image_receipt(receipt):
                                    yield image_event
                        # async-for over upstream lines done.
                    # `async with client.stream(...)` exit point.

                    last_finish_reason = finish_reason
                    if cached_input_tokens_round is not None:
                        last_cached_input_tokens = cached_input_tokens_round
                    if finish_reason == "tool_calls" and tool_buffers:
                        # Execute each buffered call locally, emit
                        # `arguments` + `success`/`failure` events,
                        # and append the appropriate messages so
                        # the next round sees them.
                        assistant_tool_calls: List[dict] = []
                        tool_result_messages: List[dict] = []
                        for slot in tool_buffers.values():
                            if not slot.get("emitted_start"):
                                continue
                            args_text = slot.get("args_text") or ""
                            parsed_args = try_parse_tool_args(args_text)
                            yield NormalisedEvent(
                                type="tool_call",
                                tool_call_id=slot.get("id"),
                                tool_call_phase="arguments",
                                tool_name=slot.get("name"),
                                tool_provider_type="mcp",
                                tool_server_label="narrativenode",
                                tool_arguments=parsed_args,
                            )
                            # Invoke locally. The bridge serialises
                            # the result to a string ready for the
                            # `tool` role message body.
                            try:
                                output = await invoke_mcp_tool(slot.get("name") or "", parsed_args or {})
                            except Exception as e:  # noqa: BLE001
                                output = json.dumps({"error": f"local invocation error: {e}"})
                                failed = True
                                yield NormalisedEvent(
                                    type="tool_call",
                                    tool_call_id=slot.get("id"),
                                    tool_call_phase="failure",
                                    tool_name=slot.get("name"),
                                    tool_provider_type="mcp",
                                    tool_server_label="narrativenode",
                                    tool_arguments=parsed_args,
                                    tool_error_reason=str(e),
                                )
                            else:
                                # Heuristically classify the result
                                # as success vs failure based on the
                                # presence of an `error` key in a
                                # parsed JSON envelope. Tools that
                                # return plain text always count as
                                # success.
                                failed = tool_result_is_error(output)
                                yield NormalisedEvent(
                                    type="tool_call",
                                    tool_call_id=slot.get("id"),
                                    tool_call_phase="failure" if failed else "success",
                                    tool_name=slot.get("name"),
                                    tool_provider_type="mcp",
                                    tool_server_label="narrativenode",
                                    tool_arguments=parsed_args,
                                    tool_output=output,
                                )
                            # Dev-mode diagnostic (no-op unless launched
                            # with --dev): record a failing call, paired
                            # with whatever the model attempts next.
                            record_tool_call(slot.get("name"), parsed_args, failed, output)
                            # Assemble the upstream-shape pieces.
                            assistant_tool_calls.append({
                                "id": slot.get("id"),
                                "type": "function",
                                "function": {
                                    "name": slot.get("name"),
                                    "arguments": args_text or "{}",
                                },
                            })
                            tool_result_messages.append({
                                "role": "tool",
                                "tool_call_id": slot.get("id"),
                                "content": output,
                            })
                        # Append the assistant's tool-calling turn
                        # and each tool's result to the running
                        # message list for the next round.
                        running_messages.append({
                            "role": "assistant",
                            "content": None,
                            "tool_calls": assistant_tool_calls,
                        })
                        running_messages.extend(tool_result_messages)
                        # Loop to the next round.
                        continue
                    # Any non-tool finish reason ends the chat turn.
                    break
                else:
                    # `for ... else`: ran out of tool rounds.
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
        except Exception as e:  # noqa: BLE001
            yield NormalisedEvent(type="error", detail=f"Unexpected error: {e}")


# Tool-call delta merging, argument parsing, and error classification
# now live in `mcp_tool_bridge` (`consume_tool_call_deltas`,
# `try_parse_tool_args`, `tool_result_is_error`) so this adapter and the
# base OpenAI-compatible one share one implementation.
