"""Client-side MCP tool bridge for cloud LLM adapters — Phase 2.5b.

Lets adapters whose upstream lives outside the writer's machine
(OpenRouter, OpenAI, Groq, Together AI, ...) declare NarrativeNode's
MCP tools to the model and execute them locally when the model
calls them. Solves the "cloud upstream can't reach localhost MCP
server" problem without exposing the writer's MCP server publicly.

The contract is the standard OpenAI tool-calling shape:

  1. List our MCP tools, convert each to a
     `{type: "function", function: {name, description, parameters}}`
     entry and include them in the upstream chat request's `tools` array.
  2. The upstream model streams `tool_calls` deltas when it picks a
     tool.
  3. When the stream's `finish_reason` is `"tool_calls"`, we
     execute each tool locally against our MCP server (which
     forwards through the WebSocket bridge to the frontend, where
     the actual scene-resolution logic lives), serialise the
     result to a string, and post a `role: "tool"` message back
     with the result.
  4. Repeat until the model finishes without calling a tool.

The MCP server itself is in `services.mcp_server`. `FastMCP` exposes
`list_tools()` and `call_tool(name, args)` for in-process access — we
never go over the network for our own AI's tool use. This is what
keeps the writer's MCP server private (no tunnels, no public
exposure) while still making it usable from cloud models.
"""
import json
from typing import Any, AsyncIterator, List, Optional

from services.mcp_server import mcp as _mcp
from services.dev_tool_call_log import record_tool_call
from services.mcp_call_shim import normalize_call
from .base import NormalisedEvent


# Default ceiling on tool-call rounds per chat turn — stops a
# misbehaving model from looping forever. Normal turns do 0-3 rounds.
# The cap is per-connection (`ApiConnectionProfile.mcp_max_tool_rounds`);
# this default applies only when the field is absent / null.
DEFAULT_MAX_TOOL_ROUNDS = 8
# Sentinel used for the slider's "No limit" position. Still bounded in
# practice by the upstream rate-limit or the writer's cancel.
NO_LIMIT_TOOL_ROUNDS = 10_000


def resolve_tool_round_cap(max_tool_rounds: Optional[int]) -> int:
    """None / absent → default 8. Negative (slider's ∞) → the no-limit
    sentinel. Positive → used as-is."""
    if max_tool_rounds is None:
        return DEFAULT_MAX_TOOL_ROUNDS
    if max_tool_rounds < 0:
        return NO_LIMIT_TOOL_ROUNDS
    return max_tool_rounds


def strip_schema_titles(node):
    """Return a JSON-Schema with redundant `title` annotations removed.

    FastMCP / Pydantic auto-generate a `title` for every argument and for
    every tool's argument object (e.g. `"title": "Entity"` on the `entity`
    arg, `"title": "set_entity_awarenessArguments"` on the schema). The model
    does not need them for tool-calling and server-side validation does not
    use them, so they are pure always-sent-catalogue bloat (~2.3K tokens
    across this surface). Only STRING-valued `title` keys are dropped, so a
    property literally named `title` (whose value is a schema object, e.g.
    `create_scene`'s `title` arg) is preserved."""
    if isinstance(node, dict):
        return {
            k: strip_schema_titles(v)
            for k, v in node.items()
            if not (k == "title" and isinstance(v, str))
        }
    if isinstance(node, list):
        return [strip_schema_titles(v) for v in node]
    return node


_READ_TOOL_PREFIXES = ("get_", "list_", "find_")
_ALWAYS_AVAILABLE_TOOLS = frozenset({"request_mcp_session"})


def _is_no_session_tool(name: str) -> bool:
    """True for tools usable WITHOUT an active control session: every read
    (`get_` / `list_` / `find_`, which includes `get_workflow_guide`,
    `get_tool_help`, `get_project_summary`, `list_workflows`, ...) plus
    `request_mcp_session` (how the model unlocks writes). Everything else
    is a write that gates on `session_manager.state == "active"` and is
    hidden from the catalogue until a session is granted (Track E)."""
    return name.startswith(_READ_TOOL_PREFIXES) or name in _ALWAYS_AVAILABLE_TOOLS


async def list_mcp_tools_as_openai_functions() -> List[dict]:
    """Enumerate every tool registered on our MCP server and convert
    each to the OpenAI Chat Completions `tools[]` entry shape.

    Returns a list ready to splice into the request body. Empty list
    when no tools are registered (the chat will then proceed without
    tools, same as if MCP weren't enabled at all)."""
    try:
        tools = await _mcp.list_tools()
    except Exception:
        return []
    # Track E: on a turn with no ACTIVE control session the write tools
    # cannot fire (they gate on session_manager.state == "active"), so
    # sending them just burns catalogue tokens. Serve reads + the
    # session-request tool only until a session is active; the full
    # surface returns the moment one is granted. Fail OPEN on any error
    # (never hide tools because the session lookup broke).
    try:
        from services.mcp_session import session_manager
        session_active = session_manager.state == "active"
    except Exception:
        session_active = True
    out: List[dict] = []
    for t in tools:
        name = getattr(t, "name", None)
        if not isinstance(name, str) or not name:
            continue
        if not session_active and not _is_no_session_tool(name):
            continue
        # FastMCP's MCPTool exposes the JSON Schema for arguments
        # via `inputSchema`. Default to an empty object schema when
        # missing so the upstream accepts a no-argument call.
        schema = getattr(t, "inputSchema", None) or {"type": "object", "properties": {}}
        out.append({
            "type": "function",
            "function": {
                "name": name,
                "description": getattr(t, "description", "") or "",
                "parameters": strip_schema_titles(schema),
            },
        })
    return out


async def mcp_session_is_active() -> bool:
    """True when a write-enabling MCP control session is active (Track E).

    Fail-OPEN to True on any error, mirroring
    `list_mcp_tools_as_openai_functions` (an error in the session lookup must
    never wrongly report 'inactive'). The adapters compare this across rounds
    so a session GRANTED mid-turn triggers a catalogue rebuild that surfaces
    the write tools on the NEXT round, instead of only after a fresh turn
    rebuilds the frozen per-turn payload (Phase 7.5 P0)."""
    try:
        from services.mcp_session import session_manager
        return session_manager.state == "active"
    except Exception:
        return True


# ── Tolerance-shim support (Phase 7.5) ────────────────────────────────────
# Cached tool metadata for error enrichment: the full registered name set
# (for did-you-mean suggestions on an unknown tool) and each tool's accepted
# argument names (to list on an "extra input" rejection). Populated lazily
# on the first invocation from `_mcp.list_tools()`.
_TOOL_NAME_CACHE: set = set()
_TOOL_ARGS_CACHE: dict = {}


async def _ensure_tool_meta() -> None:
    if _TOOL_NAME_CACHE:
        return
    try:
        tools = await _mcp.list_tools()
    except Exception:
        return
    for t in tools:
        nm = getattr(t, "name", None)
        if not isinstance(nm, str) or not nm:
            continue
        _TOOL_NAME_CACHE.add(nm)
        schema = getattr(t, "inputSchema", None)
        props = schema.get("properties") if isinstance(schema, dict) else None
        _TOOL_ARGS_CACHE[nm] = sorted((props or {}).keys())


# Intent hints steer common misconceptions to the right tool BEFORE the
# fuzzy-name match, which can mislead (e.g. `add_scene_participants` string-
# matches `add_participants`, the RELATIONSHIP tool, not `add_entity_to_scene`).
# Each entry: (all-of-these-keywords-in-the-tool-name, hint).
_INTENT_HINTS = (
    (("scene", "participant"), "to add entities to a scene use add_entity_to_scene(scene, entities=[...])"),
    (("scene", "entit"), "to add entities to a scene use add_entity_to_scene(scene, entities=[...])"),
    (("scene", "location"), "a scene has no location field; add the location as a participant via add_entity_to_scene(scene, entities=[...])"),
)


def _enrich_error(tool: str, message: str) -> str:
    """Turn a bare rejection into a self-correcting one: name the closest
    real tools for an unknown name, or the accepted arguments for an
    'extra input' rejection. No-op when the metadata cache is empty."""
    low = message.lower()
    if "unknown tool" in low or "no tool named" in low:
        tool_low = tool.lower()
        for keywords, hint in _INTENT_HINTS:
            if all(k in tool_low for k in keywords):
                message += f" ({hint})"
                break
        import difflib
        matches = difflib.get_close_matches(tool, sorted(_TOOL_NAME_CACHE), n=3, cutoff=0.4)
        if matches:
            message += f" Did you mean: {', '.join(matches)}? (call get_project_summary for the tool list)"
    elif "extra inputs are not permitted" in low or "extra_forbidden" in low:
        accepted = _TOOL_ARGS_CACHE.get(tool)
        if accepted:
            message += f" Accepted arguments for {tool!r}: {', '.join(accepted)}."
    return message


def _try_json(text: str) -> Any:
    try:
        return json.loads(text)
    except Exception:
        return None


def _assemble_shim_result(note: Optional[str], parts: list) -> str:
    """Combine one or more executed sub-call results into a single tool-result
    string. `parts` is a list of (tool, body_str, is_error). The output stays
    a JSON object whenever a note or a split occurred so the failure heuristic
    (`tool_result_is_error`) still works: an `error` key is present iff a
    sub-call failed. A single, un-remapped call returns its body untouched
    for full backward compatibility."""
    if len(parts) == 1 and note is None:
        return parts[0][1]

    guided = (
        f"{note}. Use the canonical tool/argument name(s) on future calls."
        if note else None
    )
    if len(parts) == 1:
        tool, body, is_error = parts[0]
        parsed = _try_json(body)
        if isinstance(parsed, dict):
            if guided:
                parsed["_note"] = guided
            return json.dumps(parsed)
        env: dict = {"result": parsed if parsed is not None else body}
        if guided:
            env["_note"] = guided
        if is_error:
            env["error"] = body
        return json.dumps(env)

    env = {
        "results": [
            {"tool": tool, "result": _try_json(body) if not is_error else None,
             **({"error": body} if is_error else {})}
            for tool, body, is_error in parts
        ],
    }
    if guided:
        env["_note"] = guided
    failures = [f"{tool}: {body}" for tool, body, is_error in parts if is_error]
    if failures:
        env["error"] = "; ".join(failures)
    return json.dumps(env)


async def invoke_mcp_tool(name: str, arguments: Optional[dict]) -> str:
    """Invoke an MCP tool in-process and return its result as a
    string suitable for use as the `content` of a `role: "tool"`
    message.

    Applies the Phase 7.5 tolerance shim first (`normalize_call`): an
    intuitive-but-non-canonical call is mapped onto the real tool(s) and
    argument shape, and a short `_note` names what was remapped so the model
    converges on the canonical names. A cross-tool argument runs as a second
    call. Failures (tool not found, bridge disconnected, frontend reported
    error, etc.) are caught and returned as a JSON-encoded error envelope
    rather than raised, enriched with a did-you-mean / accepted-arguments
    hint so the model can recover in one step instead of guessing again.
    """
    args = arguments or {}
    if not isinstance(args, dict):
        return json.dumps({"error": "arguments must be a JSON object"})
    await _ensure_tool_meta()
    plan = normalize_call(name, args)
    parts: list = []
    for cname, cargs in plan["calls"]:
        try:
            result = await _mcp.call_tool(cname, cargs)
            body = _serialise_tool_result(result)
            parts.append((cname, body, tool_result_is_error(body)))
        except Exception as e:  # noqa: BLE001
            parts.append((cname, json.dumps({"error": _enrich_error(cname, str(e))}), True))
    return _assemble_shim_result(plan["note"], parts)


def _serialise_tool_result(result: Any) -> str:
    """Normalise FastMCP's `call_tool` return value to a string.

    FastMCP can return either a `dict` (when the tool function
    returns a dict-like value) or a sequence of ContentBlocks (when
    it returns text / image content). We flatten both into a single
    string for the upstream `tool` message body."""
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        try:
            return json.dumps(result)
        except Exception:
            return str(result)
    if isinstance(result, (list, tuple)):
        # ContentBlock sequence. Pull `.text` from each block when
        # present; fall back to repr otherwise.
        parts: List[str] = []
        for item in result:
            text = getattr(item, "text", None)
            if isinstance(text, str):
                parts.append(text)
                continue
            try:
                parts.append(json.dumps(item))
            except Exception:
                parts.append(str(item))
        return "\n".join(parts)
    try:
        return json.dumps(result)
    except Exception:
        return str(result)


# ── Streaming tool-call plumbing (shared across OpenAI-compatible adapters) ──
# These mirror the standard OpenAI streaming `tool_calls` delta shape:
# each delta carries an `index`; the first delta for an index carries
# `id` + `function.name`; subsequent deltas append `function.arguments`
# fragments. We buffer by index, then execute once `finish_reason ==
# "tool_calls"` arrives. Both the OpenRouter adapter and the base
# OpenAI-compatible adapter (LM Studio's `/v1`, Ollama, vLLM, etc.) use
# these so the loop logic lives in exactly one place.

def consume_tool_call_deltas(tool_calls: list, buffers: dict) -> List[NormalisedEvent]:
    """Merge an incoming `tool_calls` delta array into per-call buffers
    (keyed by `index`) and emit a `start` event on first sight of a
    tool's id+name. Argument fragments accumulate silently; they're
    surfaced as the `arguments` phase event once the round finishes
    (see `execute_buffered_tool_calls`)."""
    out: List[NormalisedEvent] = []
    for entry in tool_calls:
        if not isinstance(entry, dict):
            continue
        idx = entry.get("index")
        if idx is None:
            continue
        slot = buffers.setdefault(idx, {
            "id": None,
            "name": None,
            "args_text": "",
            "emitted_start": False,
        })
        if entry.get("id"):
            slot["id"] = entry["id"]
        function = entry.get("function") or {}
        if function.get("name"):
            slot["name"] = function["name"]
        args_piece = function.get("arguments")
        if isinstance(args_piece, str):
            slot["args_text"] += args_piece
        if not slot["emitted_start"] and slot["name"]:
            out.append(NormalisedEvent(
                type="tool_call",
                tool_call_id=slot["id"],
                tool_call_phase="start",
                tool_name=slot["name"],
                tool_provider_type="mcp",
                tool_server_label="narrativenode",
            ))
            slot["emitted_start"] = True
    return out


def try_parse_tool_args(args_text: str) -> Optional[dict]:
    """Parse the accumulated tool-call arguments string into a dict.
    Returns None when the text is empty, not JSON, or not an object —
    the executor falls back to passing `{}` so the tool still runs."""
    if not args_text or not args_text.strip():
        return None
    try:
        parsed = json.loads(args_text)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def tool_result_is_error(output: str) -> bool:
    """Heuristically detect whether a serialised tool result represents
    a failure. The bridge wraps every caught exception as
    `{"error": "..."}`, so an `error` key on a JSON object means the
    call didn't complete. Other shapes count as success."""
    if not output:
        return False
    try:
        parsed = json.loads(output)
    except Exception:
        return False
    if not isinstance(parsed, dict):
        return False
    return "error" in parsed and bool(parsed.get("error"))


async def execute_buffered_tool_calls(
    tool_buffers: dict,
    assistant_tool_calls_out: list,
    tool_result_messages_out: list,
) -> AsyncIterator[NormalisedEvent]:
    """Execute every buffered tool call locally and yield the
    `arguments` + `success`/`failure` NormalisedEvents the chat panel
    renders. Appends the OpenAI-shape assistant `tool_calls` turn and
    one `role:"tool"` result message per call to the two output lists,
    which the caller splices onto its running message list before the
    next round. Local execution means the upstream never reaches our
    MCP server — it only ever sees plain function tools and results."""
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
        # Dev-mode diagnostic (no-op unless launched with --dev): record a
        # failing call, and pair it with whatever the model attempts next.
        record_tool_call(slot.get("name"), parsed_args, failed, output)
        assistant_tool_calls_out.append({
            "id": slot.get("id"),
            "type": "function",
            "function": {
                "name": slot.get("name"),
                "arguments": args_text or "{}",
            },
        })
        tool_result_messages_out.append({
            "role": "tool",
            "tool_call_id": slot.get("id"),
            "content": output,
        })


# ── In-turn tool-result eviction (Phase 7.4 Track D) ──────────────────────
# A tool result is appended to the running message list and then re-sent on
# EVERY subsequent round of the same turn. A large result (a verbose
# get_scene / list_* dump, or a fetched workflow guide) therefore compounds
# with the round count, exactly the way the tool catalogue does. Once the
# model has read a result it rarely needs the full body re-sent every round.
#
# This stubs out OLD, LARGE tool results: the most recent few rounds are left
# untouched (so the model can still act on what it just fetched), and only
# results past that window AND above a size floor are replaced. The stub
# names the tool so the model can re-run it if it genuinely needs the detail
# (truncation-by-reference, never silent loss). Mutates `messages` in place
# and is idempotent (already-stubbed results are skipped).

_ELIDE_STUB_PREFIX = "[elided] "


def elide_aged_tool_results(
    messages: list,
    keep_recent_rounds: int = 3,
    min_elide_chars: int = 1600,
) -> list:
    """Replace old, large `role:"tool"` result bodies with a short
    name-bearing stub so they stop re-sending every round after the model
    has consumed them. A "round" is one assistant tool-call turn plus its
    following tool messages; the last `keep_recent_rounds` rounds are kept
    intact. Only results whose serialised content exceeds `min_elide_chars`
    are touched (small confirmations are cheap to keep)."""
    id_to_name: dict = {}
    round_of: List[int] = []
    cur = -1
    for m in messages:
        if m.get("role") == "assistant" and m.get("tool_calls"):
            cur += 1
            for tc in m.get("tool_calls") or []:
                tid = tc.get("id")
                if tid:
                    id_to_name[tid] = (tc.get("function") or {}).get("name")
        round_of.append(cur)

    cutoff = cur - keep_recent_rounds  # rounds with index <= cutoff are elidable
    if cutoff < 0:
        return messages

    for i, m in enumerate(messages):
        if m.get("role") != "tool" or round_of[i] > cutoff:
            continue
        content = m.get("content")
        if not isinstance(content, str) or content.startswith(_ELIDE_STUB_PREFIX):
            continue
        if len(content) < min_elide_chars:
            continue
        name = id_to_name.get(m.get("tool_call_id")) or "the tool"
        m["content"] = (
            f"{_ELIDE_STUB_PREFIX}Earlier `{name}` result removed to save context. "
            f"Call `{name}` again if you need its full output."
        )
    return messages
