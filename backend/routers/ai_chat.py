"""Chat streaming proxy — Phase 2.4a.

Thin FastAPI surface that:
  1. Looks up the saved AI provider connection by `profile_id`.
  2. Looks up the matching adapter from `services.llm_adapters`.
  3. Asks the adapter to stream the chat; rewraps each yielded
     `NormalisedEvent` as one SSE `data:` line for the browser.

Provider knowledge is intentionally absent from this file — every
URL, header, payload shape, and event-name lives inside the
adapter package. See `backend/services/llm_adapters/base.py` for
the contract.
"""
import json
from typing import Any, List, Optional, Union

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from models.user_preferences import ModelCapabilities
from services.llm_adapters import ChatMessage, get_adapter
from services.user_preferences_service import read_user_preferences, write_user_preferences


router = APIRouter(prefix="/ai", tags=["ai-chat"])


class ChatStreamRequest(BaseModel):
    profile_id: str
    model: str
    messages: List[ChatMessage]
    system_prompt: Optional[str] = None
    # Phase 2.5f — reasoning controls. `reasoning_level` is the
    # writer's slider value when the reasoning button is ON; None
    # means reasoning is OFF for this send (adapter omits the field
    # from the outgoing request). String for enum adapters
    # (LM Studio / OpenRouter / openai_compatible). Integer for
    # adapters that take a numeric budget (Anthropic, when it ships).
    # `reasoning_summary` is OpenRouter-only — controls the verbosity
    # of the surfaced reasoning content. None means omit the field
    # (default behaviour, no extra summarisation tokens).
    reasoning_level: Optional[Union[str, int]] = None
    reasoning_summary: Optional[str] = None
    # Per-send tool-use opt-out. Only the main chat composer sends
    # tools; prose surfaces (prompt blocks, scene description, inline)
    # pass `disable_tools: True` so no tool definitions ride along and
    # waste context where tools are never called. When True we skip
    # the MCP integration regardless of the connection's `mcp_enabled`.
    disable_tools: bool = False


@router.post("/chat-stream")
async def chat_stream(req: ChatStreamRequest, request: Request) -> StreamingResponse:
    """Open a streaming chat request against the writer's saved
    connection. Returns a `text/event-stream` response where every
    line is one normalised event JSON object."""
    prefs = read_user_preferences()
    profile = next((p for p in (prefs.ai_provider_profiles or []) if p.id == req.profile_id), None)
    if profile is None:
        raise HTTPException(status_code=404, detail=f"Connection '{req.profile_id}' not found")

    adapter = get_adapter(profile.api_type)
    if adapter is None:
        raise HTTPException(
            status_code=501,
            detail=f"api_type '{profile.api_type}' is not yet implemented. Registered adapters: see services.llm_adapters.registry.",
        )
    # Visible breadcrumb in the backend console — which adapter
    # actually handled this chat. Lets the writer verify from the
    # terminal that a new connection routes through the expected
    # adapter (since the chat panel itself can't tell from the
    # response shape alone).
    print(
        f"[ai_chat] adapter={profile.api_type} model={req.model!r} "
        f"profile={profile.name!r} base={profile.base_url}",
        flush=True,
    )

    # Resolve MCP integration. The decision is shared across two
    # axes: the writer's per-profile `mcp_enabled` toggle AND the
    # adapter's `supports_mcp` class attribute. Only when both are
    # truthy do we hand the adapter our MCP server URL. Adapters
    # that don't support MCP ignore the argument either way; the
    # capability check just keeps us from confusing the writer's
    # intent ("MCP on") with "MCP supported here".
    mcp_server_url: Optional[str] = None
    if profile.mcp_enabled and getattr(adapter, "supports_mcp", False) and not req.disable_tools:
        from services.mcp_control import MCP_STATIC_PORT
        mcp_server_url = f"http://localhost:{MCP_STATIC_PORT}/mcp/server"

    async def is_cancelled() -> bool:
        return await request.is_disconnected()

    # Look up the cached per-model capability record so the adapter
    # can short-circuit known-incompatible wire shapes. Defaults to
    # None when the profile has no entry for this model — the adapter
    # then tries the spec-correct shape first and falls back on 400.
    model_caps: Optional[ModelCapabilities] = None
    if profile.model_capabilities:
        model_caps = profile.model_capabilities.get(req.model)

    def capability_sink(model_id: str, key: str, value: Any) -> None:
        """Persist a runtime-detected capability fact on the
        profile's `model_capabilities[model_id]` and write the
        whole user_preferences file. Invoked by the adapter when
        it discovers (for example) that the upstream has rejected
        `type:"file"` content parts and the writer should default
        to the fallback shape on subsequent sends. Re-reads the
        prefs from disk inside this function so we don't clobber
        concurrent updates from elsewhere — the `prefs` captured
        in the request scope above is a snapshot taken at request
        start."""
        try:
            fresh_prefs = read_user_preferences()
            fresh_profile = next(
                (p for p in (fresh_prefs.ai_provider_profiles or []) if p.id == req.profile_id),
                None,
            )
            if fresh_profile is None:
                return
            if fresh_profile.model_capabilities is None:
                fresh_profile.model_capabilities = {}
            existing = fresh_profile.model_capabilities.get(model_id)
            if existing is None:
                fresh_profile.model_capabilities[model_id] = ModelCapabilities(**{key: value})
            else:
                setattr(existing, key, value)
            write_user_preferences(fresh_prefs)
            print(
                f"[ai_chat] capability persisted: profile={fresh_profile.name!r} "
                f"model={model_id!r} {key}={value!r}",
                flush=True,
            )
        except Exception as e:  # noqa: BLE001 — capability persistence is best-effort
            print(f"[ai_chat] capability_sink write failed (non-fatal): {e}", flush=True)

    async def event_source():
        async for event in adapter.stream_chat(
            base_url=profile.base_url,
            api_key=profile.api_key,
            model=req.model,
            messages=req.messages,
            system_prompt=req.system_prompt,
            mcp_server_url=mcp_server_url,
            is_cancelled=is_cancelled,
            model_capabilities=model_caps,
            capability_sink=capability_sink,
            reasoning_level=req.reasoning_level,
            reasoning_summary=req.reasoning_summary,
            max_tool_rounds=profile.mcp_max_tool_rounds,
        ):
            yield f"data: {json.dumps(event.model_dump(exclude_none=True))}\n\n"

    return StreamingResponse(event_source(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })
