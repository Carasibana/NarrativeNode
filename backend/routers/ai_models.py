"""Model discovery + connection test endpoints — Phase 2.3c / 2.4a.

Thin FastAPI surface; all provider knowledge (URL paths, auth
headers, response normalisation) lives inside the adapter package.
See `backend/services/llm_adapters/base.py` for the architecture.

Endpoints:
  * `POST /api/ai/discover-models`  — list models on a connection
  * `POST /api/ai/test-connection`  — probe connectivity / auth
"""
from typing import List, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.llm_adapters import DiscoveredModel, get_adapter


router = APIRouter(prefix="/ai", tags=["ai-models"])


# ── Discovery ────────────────────────────────────────────────────


class DiscoverModelsRequest(BaseModel):
    base_url: str
    api_key: Optional[str] = None
    api_type: Literal["openai_compatible", "openrouter", "anthropic", "lmstudio_rest_v1"]


class DiscoverModelsResponse(BaseModel):
    """Discovery payload. `base_url_used` is the URL that actually
    reached the upstream — usually identical to what the writer sent,
    but a 404 on the first attempt triggers a retry against the
    adapter's normalised form (trimming any documented `/v1/...`
    tail the writer may have pasted in). The frontend uses the diff
    to update the profile's URL + surface a brief "we trimmed your
    URL" note."""
    models: List[DiscoveredModel]
    base_url_used: str


@router.post("/discover-models", response_model=DiscoverModelsResponse)
async def discover_models(req: DiscoverModelsRequest) -> DiscoverModelsResponse:
    base = req.base_url.rstrip("/")
    if not base:
        raise HTTPException(status_code=400, detail="base_url is required")

    adapter = get_adapter(req.api_type)
    if adapter is None:
        raise HTTPException(
            status_code=501,
            detail=f"api_type '{req.api_type}' is not yet implemented.",
        )

    # Pre-normalise so a writer pasting a full URL like
    # `http://localhost:1234/v1/models` or `http://localhost:1234/api/v1/chat`
    # gets the right endpoint hit on the FIRST attempt instead of
    # waiting for a 404 + retry. The returned `base_url_used` carries
    # the post-trim URL so the frontend can surface a "we trimmed
    # your URL" inline note when the diff is non-empty.
    base_to_use = adapter.normalise_base_url(base) or base
    try:
        models = await adapter.discover_models(base_to_use, req.api_key)
        return DiscoverModelsResponse(models=models, base_url_used=base_to_use)
    except RuntimeError as e:
        primary_err = str(e)
    # Pre-normalisation already ran — retry only buys us anything if
    # the URL is somehow STILL malformed after trim. Keep the legacy
    # 404 retry for completeness in case `normalise_base_url` missed
    # a suffix variant we haven't catalogued.
    if "404" in primary_err and base_to_use != base:
        try:
            models = await adapter.discover_models(base, req.api_key)
            return DiscoverModelsResponse(models=models, base_url_used=base)
        except RuntimeError as e2:
            primary_err = f"{primary_err} | Retried with original URL {base}: {e2}"
    raise HTTPException(status_code=502, detail=primary_err)


# ── Test connection ──────────────────────────────────────────────


class TestConnectionRequest(BaseModel):
    base_url: str
    api_key: Optional[str] = None
    api_type: Literal["openai_compatible", "openrouter", "anthropic", "lmstudio_rest_v1"]


class TestConnectionResponse(BaseModel):
    """Result of a connection probe.

    `ok` is True only when the writer's chosen endpoint is reachable
    AND auth (if any) is accepted. `model_count` is populated when
    the primary `discover_models` check succeeded; `fell_back` is
    True when the adapter's chat-endpoint probe had to be used (the
    connection doesn't expose a `/models`-shaped surface).
    `base_url_used` carries the URL that actually reached the
    upstream — usually identical to what the writer sent, but a 404
    on the first attempt triggers a retry against the adapter's
    normalised form (trimming any documented `/v1/...` tail). The
    frontend uses the diff to update the field + surface a brief
    inline note."""
    ok: bool
    model_count: Optional[int] = None
    fell_back: bool = False
    detail: str
    base_url_used: str
    # LM Studio (REST v1) only: whether the `mcp/narrativenode` plugin is
    # registered in the writer's LM Studio `mcp.json`, probed via a tiny
    # chat request carrying the plugin integration. True = configured,
    # False = definitively not configured, None = not probed / couldn't
    # determine. The UI offers the tool-access toggle only when True
    # (LM Studio rejects the remote-MCP path on local/private addresses,
    # so the local plugin is the only route that works there).
    plugin_available: Optional[bool] = None


async def _probe_once(adapter, base: str, api_key: Optional[str]) -> tuple[bool, Optional[int], bool, str]:
    """Single probe attempt against `base`. Returns
    `(ok, model_count, fell_back, detail)`. The primary probe is
    `discover_models`; if that fails, falls back to
    `test_chat_endpoint` (useful for upstreams that don't expose
    a `/models` surface but do accept chat)."""
    try:
        models = await adapter.discover_models(base, api_key)
        count = len(models)
        plural = "" if count == 1 else "s"
        return True, count, False, f"Connected — {count} model{plural} reachable."
    except RuntimeError as primary_err:
        primary_message = str(primary_err)
    except Exception as e:  # noqa: BLE001
        primary_message = f"Unexpected error: {e}"

    fallback_ok, fallback_err = await adapter.test_chat_endpoint(base, api_key)
    if fallback_ok:
        return True, None, True, "Connected — /models not available, but chat endpoint responded."
    return False, None, False, f"{primary_message} | Chat fallback: {fallback_err}"


async def _maybe_probe_plugin(adapter, api_type: str, base: str, api_key: Optional[str]) -> Optional[bool]:
    """For LM Studio (REST v1), probe whether the `mcp/narrativenode`
    plugin is registered in the writer's LM Studio `mcp.json` (see
    `LmStudioRestV1Adapter.probe_plugin`). Returns True (configured),
    False (definitively not), or None (couldn't determine). Other
    api_types return None — they don't use LM Studio's plugin
    integration. Best-effort: any failure collapses to None so a probe
    hiccup never fails the connection test itself."""
    if api_type != "lmstudio_rest_v1":
        return None
    probe = getattr(adapter, "probe_plugin", None)
    if probe is None:
        return None
    try:
        available, _detail = await probe(base, api_key)
        return available
    except Exception:  # noqa: BLE001
        return None


@router.post("/test-connection", response_model=TestConnectionResponse)
async def test_connection(req: TestConnectionRequest) -> TestConnectionResponse:
    base = req.base_url.rstrip("/")
    if not base:
        return TestConnectionResponse(ok=False, detail="Base URL is required.", base_url_used="")

    adapter = get_adapter(req.api_type)
    if adapter is None:
        return TestConnectionResponse(
            ok=False,
            detail=f"api_type '{req.api_type}' is not yet implemented.",
            base_url_used=base,
        )

    # Pre-normalise so a writer pasting a full endpoint URL gets the
    # right host probed on the FIRST attempt. `base_url_used` carries
    # the trimmed URL back to the frontend, which surfaces the diff
    # as a "we trimmed your URL" inline note.
    base_to_use = adapter.normalise_base_url(base) or base
    ok, count, fell_back, detail = await _probe_once(adapter, base_to_use, req.api_key)
    if ok:
        was_trimmed = base_to_use != base
        return TestConnectionResponse(
            ok=True,
            model_count=count,
            fell_back=fell_back,
            detail=detail + (f" (Trimmed your URL to {base_to_use}.)" if was_trimmed else ""),
            base_url_used=base_to_use,
            plugin_available=await _maybe_probe_plugin(adapter, req.api_type, base_to_use, req.api_key),
        )

    # Legacy 404 retry against the original URL — guards against the
    # rare case where pre-normalisation over-trimmed.
    if "404" in detail and base_to_use != base:
        ok2, count2, fell_back2, detail2 = await _probe_once(adapter, base, req.api_key)
        if ok2:
            return TestConnectionResponse(
                ok=True,
                model_count=count2,
                fell_back=fell_back2,
                detail=detail2,
                base_url_used=base,
                plugin_available=await _maybe_probe_plugin(adapter, req.api_type, base, req.api_key),
            )
        detail = f"{detail} | Retried with original URL {base}: {detail2}"
    return TestConnectionResponse(ok=False, detail=detail, base_url_used=base_to_use)
