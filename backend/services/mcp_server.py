"""MCP server scaffold — Phase 2.1 Phase B.

External MCP-aware clients (Claude Desktop, mcp inspect, scripts using
the MCP SDK, etc.) connect here to invoke NarrativeNode tools. Each
tool is a thin proxy that forwards the call over the WebSocket bridge
in `routers/mcp_bridge.py` to the running frontend, where the
frontend's Zustand store + scene resolvers actually do the work and
return a result.

This module contains NO scene-resolution logic. The whole point of
the WebSocket-bridge architecture is that the scene-resolution logic
stays in one place — the frontend. The MCP server is a remote-control
adapter, not a state owner.

Mounted on the FastAPI app at `/mcp/server` (and `/api/mcp/server` per
the master `/api`-prefix mount in `main.py`). MCP-aware clients are
configured to connect to that URL.

Phase B scope (this module):
- FastMCP server instance.
- `_proxy_tool()` helper — forwards an MCP tool call over the bridge,
  surfaces failures as RuntimeError with meaningful messages.
- Wave 1 read tools (~12), each a thin wrapper that calls
  `_proxy_tool(...)` with the matching tool name. The tool name in the
  MCP catalogue and the name passed over the bridge are kept identical
  so the routing is one lookup.

Reference args (`entity`, `relationship`, `scene`) accept EITHER a
UUID OR an exact case-insensitive name/title/alias — the frontend
resolves them via shared helpers and returns an "ambiguous" / "not
found" error if the reference doesn't pin to exactly one object. Use
`find_by_name` for substring discovery.

Phase D adds:
- Wave 2 write tools — same proxy pattern, but per-tool docstrings
  describe authorial-intent semantics (when to call, what gets changed).
- `end_mcp_session(summary, category?)` tool wired to transition the
  frontend's MCP Control state machine to REVIEW.

Phase C / D adds:
- MCP Control state-machine integration: write tools may receive
  `session_state`-aware error envelopes (e.g. "MCP session not
  active — call X first" or "MCP write blocked, user has not granted
  control") that surface as MCP errors rather than tool results.
"""

from __future__ import annotations

import asyncio
from typing import Annotated, Any, Literal, Optional, Union, get_args

from mcp.server.fastmcp import FastMCP

# Strict-arg enforcement at the MCP boundary. By default the per-tool
# Pydantic argument model FastMCP auto-generates uses Pydantic's
# `extra='ignore'` policy, which means unknown kwargs (e.g. an AI client
# calling `set_pov(scene=X, entity=Y)` instead of the correct
# `character=Y`) are silently DROPPED and the tool runs without them.
# When the missing-because-dropped kwarg had a default of None, the
# tool then takes its "no value passed" code path and returns a
# success-shaped response that masks the user error — typical mode is
# silent no-op. The blind-agent rom-com smoke test (2026-05-17) caught
# this on `set_pov` / `set_participant_alias` / `create_chapter`; the
# pattern was indistinguishable from a real success without doing a
# follow-up read to check.
#
# Mutating `ArgModelBase.model_config` HERE — before `FastMCP(...)` is
# instantiated and before any `@mcp.tool(...)` decorators fire — adds
# `extra='forbid'` to the inherited config of every per-tool arg
# model. Pydantic's `extra='forbid'` causes a clean validation error
# at the tool boundary listing exactly which arg names weren't
# recognised, which is the feedback an AI client (or human reading
# the error) actually needs. No tool docstrings or signatures need
# to change; per-tool model_config inheritance carries the
# strictness through every existing and future decorator.
from mcp.server.fastmcp.utilities.func_metadata import ArgModelBase
from pydantic import ConfigDict as _ConfigDict
ArgModelBase.model_config = _ConfigDict(arbitrary_types_allowed=True, extra='forbid')

from pydantic import BeforeValidator

from routers.mcp_bridge import bridge
from services.mcp_session import session_manager


# Case-insensitive Literal helper. The Literal canonical forms in this
# module are all lowercase (entity types, attribute types, etc.); AI
# clients building tool calls from natural English often Title-Case
# their inputs (e.g. `type="Character"` instead of `type="character"`).
# Without this normaliser those calls fail at the Pydantic gate with
# a "not a valid value for Literal[...]" error. Lowercasing the input
# before Literal validation accepts any casing and stores the canonical
# lowercase form downstream. Applied to the named type aliases below
# via `Annotated[Literal[...], BeforeValidator(_ci_str)]`.
def _ci_str(v):
    return v.strip().lower() if isinstance(v, str) else v


# Entity-type literal used by `list_entities` for clear argument-schema
# hints to MCP clients. Matches the frontend's `_ENTITY_TYPES` array
# in `mcpTools.js`. Accepts case-insensitive input via the wrapper above.
EntityType = Annotated[
    Literal["character", "location", "item", "faction", "custom"],
    BeforeValidator(_ci_str),
]

# Extended type literal used by `find_by_name` — entity types plus
# 'scene' / 'relationship' / 'knowledge' / 'chapter' / 'act' for
# cross-object discovery. Matches the frontend's `_LOOKUP_TYPES` array.
LookupType = Annotated[
    Literal[
        "character", "location", "item", "faction", "custom",
        "scene", "relationship", "knowledge", "chapter", "act",
    ],
    BeforeValidator(_ci_str),
]


# Case-insensitive aliases for the small inline enum args used by
# several relationship / awareness write tools (`awareness_scale`,
# `status`) plus the story-seed attribute-type literal. Defined HERE
# at the top of the module so they're in scope for every `@mcp.tool`
# decorator's get_type_hints() resolution pass — under
# `from __future__ import annotations` those evals happen at
# decoration time, so a forward reference would NameError.
AwarenessScale = Annotated[
    Literal["binary", "full"],
    BeforeValidator(_ci_str),
]
RelationshipStatus = Annotated[
    Literal["active", "ended"],
    BeforeValidator(_ci_str),
]
SeedAttributeTypeLiteral = Annotated[
    Literal[
        "text", "file", "preset", "entity_list", "text_list",
        "circumstance", "motivator", "number",
    ],
    BeforeValidator(_ci_str),
]
# Strict story-level enum settings (used by `update_story`). Case-insensitive
# so a Title-Cased input still validates; the canonical stored form is
# lowercase, matching the Story model's `Literal` fields.
StoryTimeFormat = Annotated[Literal["12h", "24h"], BeforeValidator(_ci_str)]
StoryWeekStart = Annotated[Literal["sunday", "monday"], BeforeValidator(_ci_str)]
# `set_entity_awareness` aspect: which awareness surface to set — the entity's
# EXISTENCE (does the observer know the entity exists?) or its canonical NAME
# (does the observer know what the entity is called?). Two distinct fields on
# the entity (`awareness` vs `name_awareness`).
AwarenessAspect = Annotated[Literal["existence", "name"], BeforeValidator(_ci_str)]


# ── Server instance ────────────────────────────────────────────────────
#
# `FastMCP("NarrativeNode")` creates a server with that display name —
# the name external clients see when they list available servers. The
# server's tool catalogue is populated by the `@mcp.tool(...)` decorators
# below; each registers a tool that proxies through `_proxy_tool`.

# `streamable_http_path='/'` makes the FastMCP sub-app expose the MCP
# endpoint at the root of its own URL space rather than at `/mcp`.
# Combined with the mount path `/mcp/server` in main.py, the full URL
# external clients use is `/mcp/server` (or `/api/mcp/server` in dev),
# which keeps the conventional MCP-server URL shape clean.
mcp = FastMCP("NarrativeNode", streamable_http_path="/")


# ── Option F shared docstring tail (track_as_knowledge) ──────────────
# Module-level so tool decorators throughout this file can reference it
# (each tool's `description=(... + _TRACK_AS_KNOWLEDGE_DOC_TAIL)`).


def _help_pointer(topic: str, covers: str) -> str:
    """Terse pointer that replaces a verbose shared doc-tail in a tool
    description (Phase 7.4 Track A). The full reference is served on demand
    by the `get_tool_help` tool, so it ships ONCE there instead of being
    duplicated into every relevant tool's always-sent description."""
    return f"\n\nFor the full {covers}, call `get_tool_help('{topic}')`."


_INTENSITY_DOC_TAIL = (
    "\n\n"
    "── `intensity` levels ──\n\n"
    "Pass a name string (case-insensitive). Five levels of escalating "
    "weight, plus an unset state:\n"
    "  - `null` / omitted — 0/5 — no level pinned. The circumstance / "
    "motivator is present but un-quantified; the renderer shows a "
    "placeholder dashed badge. Use when you haven't committed to a "
    "level yet OR the relative weight genuinely doesn't matter to the "
    "narrative.\n"
    "  - `'Faint'`    — 1/5 — Background hum. Present but barely "
    "shaping behaviour. A quiet sigh, a hesitation, a moment of "
    "distraction.\n"
    "  - `'Mild'`     — 2/5 — Noticeable but manageable. Surfaces in "
    "pacing, word choice, small physical tells; the character keeps "
    "going with friction.\n"
    "  - `'Moderate'` — 3/5 — Actively shaping behaviour. Influences "
    "the scene's decisions; the character makes different choices "
    "than they would without it.\n"
    "  - `'Strong'`   — 4/5 — Dominates. The character is fighting it "
    "or surrendering to it; most lines of dialogue and most actions "
    "trace back to this state.\n"
    "  - `'Intense'`  — 5/5 — Overwhelming. The character may act "
    "against their own interests, fail at routine tasks, or do "
    "something they would normally never do. This is the scene's "
    "emotional centre.\n\n"
    "Pass `null` to clear an existing intensity back to unset. Reads "
    "(`get_scene`, `get_entity`, etc.) always return the canonical "
    "name string."
)


_TRACK_AS_KNOWLEDGE_DOC_TAIL = (
    "\n\n"
    "── `track_as_knowledge` (optional) ──\n\n"
    "When set, the chain event this tool records is bound to a "
    "Knowledge so the AI / UI can navigate from the Knowledge back to "
    "the triggering change. Two shapes:\n"
    "  - object `{ name, description?, colour?, awareness_scale? }` — "
    "creates a NEW Knowledge whose `source_event` baseline points at "
    "this change. `name` is required.\n"
    "  - string (existing Knowledge UUID or exact name) — appends a "
    "`source_event_changes` rebind entry on that Knowledge at the "
    "trigger scene, so from this scene forward the Knowledge "
    "represents this change.\n"
    "Constraints: requires a scene anchor (`at=<scene>`) — origin-path "
    "writes are baseline, not chain events, and reject cleanly. When "
    "the tool can record multiple chain entries in one call (e.g. "
    "`update_entity` setting both name and description), "
    "`track_as_knowledge` requires the call to record exactly ONE; "
    "multi-field calls error and ask you to split. Return shape gains "
    "`tracking_knowledge_id` on success."
)


# ── Bridge proxy helper ────────────────────────────────────────────────


def _format_bridge_connection_error(name: str, exc: ConnectionError) -> RuntimeError:
    """Map a bridge `ConnectionError` to a RuntimeError with the right
    error code so MCP clients can distinguish PRE-SEND failures (the
    bridge had no connection — call definitely didn't run) from
    POST-SEND failures (call was dispatched, connection dropped before
    the response arrived — call MAY OR MAY NOT have landed).

    Bridge contract (`routers/mcp_bridge.py:invoke_tool`):
      - `ConnectionError("no client")` — pre-send: `self._ws is None`
        at call time. The frontend never received the invocation, so
        the call definitely didn't run.
      - `ConnectionError("superseded" | "disconnected")` — post-send:
        invocation was sent, the future was put in `_pending`, then
        the websocket dropped (`_cancel_pending` rejects every
        in-flight future with this exception). From the server's
        view, we have NO way to know whether the frontend received
        the envelope, applied the write, and was about to reply when
        the socket dropped — OR never received it at all. The safe
        framing is `unknown_outcome` so the client re-fetches (via
        `list_scenes` / `find_by_name` / etc.) to determine state
        BEFORE retrying. Blind retry on a post-send disconnect
        creates duplicate scenes / entities. Surfaced 2026-05-18 in
        the blind-agent edit test: agent's first `create_scene`
        returned `disconnected` but the scene was actually created;
        retry produced a duplicate.
    """
    reason = str(exc) or "unknown"
    if reason == "no client":
        return RuntimeError(
            f"[bridge_not_connected] NarrativeNode is not running or no "
            f"client is connected. The {name!r} call was NOT dispatched; "
            f"safe to retry once a client connects."
        )
    # Post-send disconnect (superseded / disconnected / anything else).
    return RuntimeError(
        f"[unknown_outcome] Bridge connection dropped after the {name!r} "
        f"call was dispatched ({reason}). The call MAY have landed on the "
        f"frontend before the connection dropped — DO NOT blindly retry. "
        f"Re-fetch the project state first (via list_scenes / list_entities / "
        f"find_by_name / get_entity / etc. depending on what the call would "
        f"have created or modified) to determine whether the change actually "
        f"applied. Only retry if the re-fetch confirms the change is absent."
    )


# Tool -> get_tool_help topic. When a call to one of these tools errors,
# `_proxy_tool` appends a pointer to the topic so a client that malformed
# the call can fetch the full reference (accepted values, object shapes,
# examples) and correct it. Only tools whose reference detail actually
# lives behind `get_tool_help` are listed; read tools are omitted on
# purpose (a read error is usually a bad ref, which the return-shape
# reference does not help resolve).
_ERROR_HELP_TOPIC = {
    "create_scene": "scene_fields",
    "update_scene": "scene_fields",
    "set_entity_awareness": "awareness",
    "set_attribute_awareness": "awareness",
    "set_alias_awareness": "awareness",
    "set_relationship_awareness": "awareness",
    "set_knowledge_awareness": "awareness",
    "add_circumstances": "circumstances",
    "update_circumstance": "circumstances",
    "add_motivators": "motivators",
    "update_motivator": "motivators",
}


async def _proxy_tool(
    name: str,
    args: Optional[dict[str, Any]] = None,
    *,
    timeout: float = 30.0,
) -> Any:
    """Forward an MCP tool call over the WebSocket bridge to the
    running frontend, returning the result envelope's `result` field.

    Failure surfaces:
      - Pre-send (`bridge_not_connected`) — no client connected at the
        moment the call was attempted. The frontend never received the
        invocation; the call definitely didn't run; safe to retry once
        a client connects.
      - Post-send disconnect (`unknown_outcome`) — call was dispatched
        to the frontend, but the websocket dropped before a response
        arrived. The call MAY OR MAY NOT have landed. The error
        message tells the client to re-fetch state BEFORE retrying;
        blind retry duplicates writes.
      - Frontend doesn't respond within `timeout` seconds → RuntimeError.
      - Frontend dispatcher returns `{ ok: false, error: {...} }` →
        RuntimeError carrying the error message from the envelope.
        Common error codes: `tool_not_implemented`,
        `tool_execution_error`, and Phase C/D's `session_declined` /
        `another_session_active`.

    Tool implementations in this module call `_proxy_tool(name, args)`
    and return the result; FastMCP serialises the return value as the
    MCP tool's response.
    """
    try:
        envelope = await bridge.invoke_tool(name, args or {}, timeout=timeout)
    except ConnectionError as exc:
        raise _format_bridge_connection_error(name, exc)
    except asyncio.TimeoutError:
        raise RuntimeError(
            f"[unknown_outcome] NarrativeNode frontend did not respond to "
            f"{name!r} within {timeout}s. The call MAY have landed and "
            f"started executing before the timeout — same recovery as a "
            f"post-send disconnect: re-fetch state before retrying. Blind "
            f"retry can duplicate writes."
        )
    if not envelope.get("ok"):
        err = envelope.get("error") or {}
        msg = err.get("message") or f"[tool_execution_error] tool {name!r} failed"
        code = err.get("code")
        if code:
            msg = f"[{code}] {msg}"
        topic = _ERROR_HELP_TOPIC.get(name)
        if topic:
            msg += (
                f" (for the full {name!r} reference , accepted values, "
                f"object shapes, examples , call get_tool_help('{topic}'))"
            )
        raise RuntimeError(msg)
    # Log the call into the active session if one is in flight. The
    # session manager's `log_tool_call` is a no-op when state isn't
    # 'active', so we can call it unconditionally without state
    # checking here. The session badge in the toolbar reads the
    # resulting tool_call_count to keep the user informed about
    # how much work the MCP client has done in the current session.
    session_manager.log_tool_call({"name": name, "args": args or {}})
    return envelope.get("result")


async def _proxy_write_tool(
    name: str,
    args: Optional[dict[str, Any]] = None,
    *,
    timeout: float = 30.0,
) -> Any:
    """Forward a WRITE MCP tool call over the bridge — but ONLY when an
    MCP control session is active. Phase D's authorial-intent tools
    (`create_entity`, `delete_entity`, `set_entity_change_at_scene`,
    etc.) all route through this wrapper rather than `_proxy_tool`
    directly so the gate is uniformly enforced and the failure shape
    is consistent.

    When the session manager is NOT in `'active'` state, raises
    RuntimeError with code `session_not_active` and a recovery hint
    pointing the MCP client at `request_mcp_session(purpose)`. The
    bridge isn't even contacted in that case — the gate is a hard
    rejection at the MCP server layer.

    When a session IS active, delegates to `_proxy_tool` which
    forwards to the frontend, dispatches to the registered Zustand-
    action handler, and (via the existing log call inside
    `_proxy_tool`) bumps the active session's tool-call count for
    the toolbar badge."""
    if session_manager.state != "active":
        raise RuntimeError(
            f"[session_not_active] Write tool {name!r} requires an "
            f"active MCP control session. Call "
            f"request_mcp_session(purpose=...) first to ask the user "
            f"for permission. Current session state: "
            f"{session_manager.state!r}."
        )
    return await _proxy_tool(name, args, timeout=timeout)


async def _proxy_destructive_tool(
    name: str,
    args: Optional[dict[str, Any]] = None,
    *,
    action: str,
    object_type: str,
    object_name: str,
    detail: str,
    tone: str = "red",
    timeout: float = 30.0,
) -> Any:
    """Forward a DESTRUCTIVE MCP tool call after BOTH gates pass:
      1. Session must be active (same gate as `_proxy_write_tool`).
      2. The user must approve THIS specific destructive operation
         via the destructive-approval modal — OR have previously
         opted in via "Approve all destructive actions this
         session" on a prior modal.

    The approval flow runs through `session_manager.request_destructive_approval(...)`
    which blocks on an `asyncio.Future` until the user clicks
    Approve / Deny / Approve-all OR the timeout elapses. The
    waiting time is bounded by `DESTRUCTIVE_TIMEOUT_SECONDS` (60s
    by default — longer than session-grant requests because the
    user typically wants more time to consider an irreversible
    delete).

    Args fed into the modal:
      - action: short verb ("delete", "remove", etc.) shown in the
        modal title.
      - object_type: human-readable type ("character", "scene",
        etc.) shown in the modal title.
      - object_name: identifier the user can recognise (the
        entity / scene / relationship name). Falls back to
        "(unnamed)" inside the manager when the name is empty.
      - detail: one-line consequence summary shown in the modal
        body (e.g. "Removes the entity, its origin EntityNode, and
        strips all references to it across the project").

    Returns the same result envelope as `_proxy_tool` on success.
    Raises RuntimeError with the appropriate code on rejection:
      - `[session_not_active]` — gate 1 failed.
      - `[destructive_denied]` — user clicked Deny.
      - `[destructive_timeout]` — no response within
        DESTRUCTIVE_TIMEOUT_SECONDS.
    """
    if session_manager.state != "active":
        raise RuntimeError(
            f"[session_not_active] Destructive tool {name!r} requires "
            f"an active MCP control session. Call "
            f"request_mcp_session(purpose=...) first."
        )
    decision = await session_manager.request_destructive_approval(
        action=action,
        object_type=object_type,
        object_name=object_name,
        detail=detail,
        tone=tone,
    )
    if decision in ("approved", "approved_all"):
        return await _proxy_tool(name, args, timeout=timeout)
    if decision == "denied":
        raise RuntimeError(
            f"[destructive_denied] User declined the {action} "
            f"of {object_type} {object_name!r}. The MCP client "
            f"should not retry this exact operation without "
            f"first reconsidering whether it's appropriate."
        )
    if decision == "timeout":
        raise RuntimeError(
            f"[destructive_timeout] No user response to the {action} "
            f"approval request for {object_type} {object_name!r} "
            f"within "
            f"{int(session_manager.DESTRUCTIVE_TIMEOUT_SECONDS)}s. "
            f"Treated as a denial. The MCP client may retry."
        )
    # Defensive: 'no_session' shouldn't happen because we already
    # checked state above, but if a race occurred during the await,
    # surface a clean error rather than proceeding.
    raise RuntimeError(
        f"[destructive_no_session] Destructive approval failed: "
        f"session was not active at the moment of approval "
        f"({decision!r})."
    )


# ── Wave 1 read tools ──────────────────────────────────────────────────
#
# Each tool's MCP-catalogue name and the bridge-side dispatch name are
# the same string (the `name=...` arg below matches the bridge call's
# first arg). Tool descriptions are written for the MCP client (often
# an AI) to read; they should be specific about what data comes back
# and when to use the tool.


@mcp.tool(
    name="get_project_summary",
    description=(
        "Return a high-level summary of the currently-open NarrativeNode "
        "project: the story title, the story description (empty string "
        "when unset), an `is_empty` boolean (true when every count is "
        "zero — useful for branching on 'fresh project' vs 'loaded "
        "project'), counts of characters, locations, items, factions, "
        "customs, knowledges, relationships, and scenes, and a "
        "`story_seeds` dict.\n\n"
        "── Orienting on this MCP surface ──\n\n"
        "NarrativeNode is a CHAIN-OF-HISTORY model. Every change to an "
        "entity / relationship / knowledge / attribute / alias / "
        "awareness lands EITHER at the object's origin (its baseline) "
        "OR at a specific scene (a chain-time change that propagates "
        "forward from that scene). The update tools take an `at` arg "
        "that controls which: `at` omitted / null / 'origin' → baseline "
        "write; `at=<scene UUID or title>` → scene-anchored chain write. "
        "The read tools take the SAME `at` arg to get the scene-resolved "
        "state. Once that's clicked, the rest of the surface follows the "
        "same shape consistently.\n\n"
        "Writes require an active MCP session. Call "
        "`request_mcp_session(purpose=...)` to ask the user for "
        "permission before any write tool — read tools work without a "
        "session. When you're done writing, call `end_mcp_session(summary"
        "=...)` so the user sees a review summary of what changed.\n\n"
        "── Workflow guides ──\n\n"
        "The available workflow-guide names are returned in the "
        "`workflows` field of this call's result, so you do NOT need a "
        "separate `list_workflows()` round. The guides (plot planning, "
        "world setup, prose writing, knowledge tracking, etc.) describe "
        "the expected cadence of tool calls and when to use "
        "origin-baseline vs scene-anchored writes; fetch one with "
        "`get_workflow_guide(name=...)` if you want that depth before a "
        "complex task. Optional, not a required first step.\n\n"
        "── `story_seeds` field ──\n\n"
        "Exposes the per-entity-type attribute templates that "
        "NarrativeNode auto-attaches to NEWLY-CREATED entities of that "
        "type. Shape: `{ <type>: [{ name, attribute_type, default_value?, "
        "preset_list_name? }, ...] }` per type that has any seeds; types "
        "with no seeds are omitted. Surfaced here so an MCP client knows "
        "up front (e.g.) 'every character I create with "
        "create_entity(type=\"character\") will automatically have a "
        "Gender preset attribute attached'. Empty dict on a project that "
        "doesn't use seeds.\n\n"
        "Seeds apply ONLY to entities created AFTER the seed exists. "
        "Adding a seed via `add_story_seed` does NOT retroactively "
        "populate existing entities — they keep whatever attributes "
        "they already had at creation time.\n\n"
        "Use this as the first call when starting work on a project to "
        "get a sense of its scope before reaching for more detailed "
        "tools.\n\n"
        "EFFICIENCY: when several operations are INDEPENDENT (creating "
        "multiple entities, or issuing several reads), emit them as "
        "PARALLEL tool calls in ONE turn rather than one per turn , the "
        "agent loop executes every tool call you return in a turn. "
        "Reserve one-call-per-turn for genuinely DEPENDENT steps "
        "(create a scene, THEN add entities to it, THEN set its POV)."
    ),
)
async def get_project_summary() -> dict:
    # Frontend computes counts + is_empty + title. Backend appends
    # the story_seeds projection from `state.get_seeds()` so the AI
    # sees the per-type auto-attached attribute templates up front
    # — surfaced where the AI is already orienting, not later mid-flow.
    # Local import to keep mcp_server's import-time graph clean.
    from state import get_seeds as _state_get_seeds, set_seeds as _state_set_seeds
    summary = await _proxy_tool("get_project_summary", {})
    seeds_file = _state_get_seeds()
    seeds_by_type = {}
    # SeedsByType has one list per entity type (knowledge is vestigial
    # per the model docstring — skip it). Project each populated bucket
    # as a list of stub dicts.
    for type_name in ("character", "location", "item", "faction", "custom"):
        stubs = getattr(seeds_file.seeds, type_name, None) or []
        if not stubs:
            continue
        seeds_by_type[type_name] = [
            {
                "name": stub.name,
                "attribute_type": stub.attribute_type,
                **({"default_value": stub.default_value} if stub.default_value is not None else {}),
                **({"preset_list_name": stub.preset_list_name} if stub.preset_list_name else {}),
            }
            for stub in stubs
        ]
    summary["story_seeds"] = seeds_by_type
    # Fold the workflow-guide names into orientation so the client doesn't
    # need a separate list_workflows round (Phase 7.4 Track A ceremony trim).
    try:
        _wf_dir = _workflows_dir()
        summary["workflows"] = (
            sorted(p.stem for p in _wf_dir.glob("*.md")) if _wf_dir.is_dir() else []
        )
    except Exception:
        summary["workflows"] = []
    return summary


@mcp.tool(
    name="update_story",
    description=(
        "Set one or more story-level settings (the singleton Story). Pass "
        "only the fields you want to change; at least one is required. For a "
        "clearable text field, pass an empty string to clear it. Read the "
        "current values with `get_story`.\n\n"
        "Metadata: `title`, `description` (blurb), `author`, `genre`, "
        "`tense` ('past'/'present'), `language`, `pov_type_default` "
        "(e.g. '1st Person'/'2nd Person'/'3rd Person'), `pov_character_id` "
        "(the story's default POV character, by name or id).\n"
        "Series: `series` (name), `series_number` (float; slots prequels "
        "at 0.5). `tags` (list of story-library tag strings).\n"
        "Presentation: `accent_color`, `pov_color` (hex), `chapter_label` / "
        "`act_label` (override the 'Chapter'/'Act' terms), "
        "`chapter_tint_behind_nodes` (bool).\n"
        "Time tracking: `time_tracking_enabled` (bool), `allow_negative_time` "
        "(bool), `time_format` ('12h'/'24h'), `week_start` "
        "('sunday'/'monday').\n\n"
        "Returns the saved Story-level shape. Requires an active MCP "
        "session. Non-destructive."
    ),
)
async def update_story(
    title: Optional[str] = None,
    description: Optional[str] = None,
    author: Optional[str] = None,
    genre: Optional[str] = None,
    tense: Optional[str] = None,
    language: Optional[str] = None,
    pov_type_default: Optional[str] = None,
    pov_character_id: Optional[str] = None,
    series: Optional[str] = None,
    series_number: Optional[float] = None,
    tags: Optional[list[str]] = None,
    accent_color: Optional[str] = None,
    pov_color: Optional[str] = None,
    chapter_label: Optional[str] = None,
    act_label: Optional[str] = None,
    chapter_tint_behind_nodes: Optional[bool] = None,
    time_tracking_enabled: Optional[bool] = None,
    allow_negative_time: Optional[bool] = None,
    time_format: Optional[StoryTimeFormat] = None,
    week_start: Optional[StoryWeekStart] = None,
) -> dict:
    # Only forward fields the caller actually passed; a None means "leave
    # unchanged" (to clear a clearable text field, pass an empty string,
    # which the frontend handler normalises to null). Story settings are
    # singleton fields (no chain), so they route straight through
    # `updateStorySettings` — the same store action the Settings panel uses.
    _candidates = {
        "title": title, "description": description, "author": author,
        "genre": genre, "tense": tense, "language": language,
        "pov_type_default": pov_type_default, "pov_character_id": pov_character_id,
        "series": series, "series_number": series_number, "tags": tags,
        "accent_color": accent_color, "pov_color": pov_color,
        "chapter_label": chapter_label, "act_label": act_label,
        "chapter_tint_behind_nodes": chapter_tint_behind_nodes,
        "time_tracking_enabled": time_tracking_enabled,
        "allow_negative_time": allow_negative_time,
        "time_format": time_format, "week_start": week_start,
    }
    args: dict[str, Any] = {k: v for k, v in _candidates.items() if v is not None}
    if not args:
        raise ValueError(
            "update_story: pass at least one field to set (e.g. title, "
            "description, author, genre, tense, pov_character_id, ...)."
        )
    return await _proxy_write_tool("update_story", args)


@mcp.tool(
    name="get_story",
    description=(
        "Return the full story-level metadata shape. Story is a "
        "singleton per project — no `at` arg, no ref-by-uuid-or-name. "
        "Use when you want every Story-level field the writer can "
        "configure via the Story Settings panel, without the project "
        "counts / seeds that `get_project_summary` bundles for "
        "orientation.\n\n"
        "Returns: `{ title, description, author, tense, language, "
        "pov_type_default, pov_character_id, genre, tags, accent_color }`. "
        "Strings are empty-string when unset; tags is `[]` when empty; "
        "pov_character_id is null when no story-level default POV "
        "character is set (it's a UUID; resolve to the character via "
        "`get_entity(pov_character_id)` if you need its current name).\n\n"
        "No session required. Companion writer: `update_story`."
    ),
)
async def get_story() -> dict:
    return await _proxy_tool("get_story", {})


@mcp.tool(
    name="get_story_description",
    description=(
        "Return ONLY the story's description / blurb field. Focused "
        "single-field read — use when the AI wants the 'what is this "
        "story about' framing without any other Story-level metadata "
        "or project counts.\n\n"
        "Returns `{ description }`. Always present; empty string when "
        "the writer hasn't set one. No session required.\n\n"
        "Companion: `update_story(description=...)` to write. Read "
        "alternatives: `get_story` (full Story shape including "
        "description), `get_project_summary` (counts + title + "
        "description for orientation), or `get_scene_context` (also "
        "carries the description alongside scene-specific context)."
    ),
)
async def get_story_description() -> dict:
    return await _proxy_tool("get_story_description", {})


@mcp.tool(
    name="list_entities",
    description=(
        "List all entities in the project, OPTIONALLY filtered to one "
        "type via the `type` arg (`character` | `location` | `item` | "
        "`faction` | `custom`). Returns lightweight metadata per "
        "entity (id, name, colour, origin_node_id) grouped by type — no "
        "descriptions, attributes, or aliases. `origin_node_id` is the "
        "entity's canvas origin node (null if not on the canvas); pass it "
        "to `add_to_group` to file the entity under a group.\n\n"
        "Use this for orientation; follow up with `get_entity` (with "
        "optional `at` arg for scene-resolved details) on a specific "
        "entity. Pass `type=<one of the five>` when you only want one "
        "category back — useful when enumerating just locations / "
        "items / etc. before adding more of that kind."
    ),
)
async def list_entities(type: Optional[EntityType] = None) -> dict:
    args: dict[str, Any] = {}
    if type is not None:
        args["type"] = type
    return await _proxy_tool("list_entities", args)


@mcp.tool(
    name="get_entity",
    description=(
        "Entity types: character, location, item, faction, custom.\n\n"
        "Return the state of one entity at the requested scene "
        "anchor. The `entity` arg accepts EITHER a UUID OR an exact "
        "(case-insensitive) name or alias of any of those types — "
        "if more than one entity matches the reference EXACTLY (i.e. "
        "two entities share the same literal name, or the reference "
        "is an exact alias on multiple entities), the tool returns "
        "an 'ambiguous' error listing the candidates so you can "
        "retry with the UUID. Substring overlap does NOT count as "
        "ambiguity: passing `entity='Wren'` resolves cleanly to the "
        "one entity literally named or aliased `'Wren'`, even if "
        "other entities have names like `'Mira Wren'` or `'Elias "
        "Wren'`. For substring-style discovery use the dedicated "
        "`find_by_name` tool. The `at` arg controls WHICH version "
        "of the entity you get back:\n"
        "  - omitted / null / 'origin' → ORIGIN-BASELINE state. The "
        "values the entity has 'always had'. Use this when the AI "
        "needs the canonical baseline (e.g. the entity card in the "
        "library).\n"
        "  - scene UUID or exact (case-insensitive) title → "
        "SCENE-RESOLVED state. The values the entity has AT that "
        "scene, after applying every change recorded along the chain "
        "from origin to that scene (name / description / colour / "
        "profile image / alias edits / attribute changes).\n\n"
        "Returns: name, colour, description, profile_image_ref, "
        "notes, aliases (as plain strings), and three SEPARATE "
        "grouped buckets: `attributes` (text / file / preset / "
        "number / text_list / entity_list types), `circumstances` "
        "(circumstance-typed attributes — situational states), and "
        "`motivators` (motivator-typed attributes — inner drives). "
        "Each bucket is always present in the response, even when "
        "empty, so the client can rely on the three keys existing. "
        "For locations also returns `parent_id` when set; for customs "
        "also returns `category_id` when set. Both paths return "
        "`origin_node_id` — the entity's canvas origin node (null if not "
        "on the canvas); pass it to `add_to_group` to file the entity "
        "under a group. The scene path "
        "additionally returns `scene_id`, `scene_title`, and "
        "`chain_resolution` (see below); the origin path returns "
        "`scene_id: null` and `chain_resolution: null`. Names can "
        "change scene-to-scene, so use the scene path whenever "
        "asking 'what does this entity look like AT this point in "
        "the story'.\n\n"
        "The scene path also returns a `chain_resolution` introspection "
        "block (`reached_via`, `from_origin_baseline`, "
        "`chain_entries_applied`, `chain_entries_not_on_path`, ...) that "
        "reveals whether the resolved values reflect walked chain "
        "entries or fell through to baseline , the key diagnostic for a "
        "broken / origin-direct upstream wire (`chain_entries_not_on_path "
        "> 0` is the smoking gun). Full field breakdown + how to read the "
        "signals: `get_tool_help('get_entity')`."
    ),
)
async def get_entity(entity: str, at: Optional[str] = None) -> dict:
    args: dict[str, Any] = {"entity": entity}
    if at is not None: args["at"] = at
    return await _proxy_tool("get_entity", args)


@mcp.tool(
    name="get_entity_chain_history",
    description=(
        "Return EVERY scene-anchored change recorded on an entity, "
        "in story order. This is the 'what has happened to this "
        "entity, and where' view — surfaces every name / colour / "
        "description / profile-image / aliases / attribute / "
        "awareness change along the chain, anchored to the scene "
        "each one was recorded at.\n\n"
        "Use this for:\n"
        "  - Sanity-checking your writes ('did I forget to record "
        "the chain entry I meant to?').\n"
        "  - Understanding when a circumstance or motivator first "
        "appeared (the `kind: 'attribute', action: 'add'` entries "
        "carry `attribute_type` so you can filter to "
        "circumstances / motivators specifically).\n"
        "  - Auditing chain history at a glance instead of walking "
        "`get_entity(at=<each scene>)` N times.\n\n"
        "Args:\n"
        "  entity — required, UUID or exact (case-insensitive) name "
        "/ alias of the entity to inspect.\n"
        "  scenes — optional list of scene UUIDs / titles. When "
        "passed, the `history[]` output is restricted to changes "
        "that landed at one of the named scenes. Lifecycle "
        "summaries still aggregate over the full chain (they have "
        "to, to compute correct add_at / last_modified_at status), "
        "but the change-by-change view scopes to the subset you "
        "asked about. Use when you want to spot-check a few story "
        "beats without paging through every change.\n\n"
        "Returns `{ entity_id, entity_type, origin_name, origin, "
        "history: [{ scene_id, scene_title, pov_index, changes: [...] "
        "}, ...], circumstance_lifecycle: [...], motivator_lifecycle: "
        "[...] }`. `history[].changes[]` entries carry a `kind` "
        "discriminator (name / colour / description / profile_image / "
        "aliases / attribute / attribute_awareness / awareness) + "
        "per-kind fields; scenes with no recorded change are omitted. "
        "The two lifecycle buckets directly answer 'is any circumstance "
        "/ motivator stale?' (add-at / last-modified / removed / status "
        "per item, story-ordered). Full field-by-field shape of the "
        "change kinds and the lifecycle entries: "
        "`get_tool_help('get_entity_chain_history')`.\n\n"
        "No session required."
    ),
)
async def get_entity_chain_history(
    entity: str,
    scenes: Optional[list[str]] = None,
) -> dict:
    args: dict[str, Any] = {"entity": entity}
    if scenes is not None: args["scenes"] = scenes
    return await _proxy_tool("get_entity_chain_history", args)


@mcp.tool(
    name="get_knowledge_awareness_history",
    description=(
        "Return EVERY awareness event recorded on a Knowledge, in "
        "story order. Mirrors `get_entity_chain_history`'s shape "
        "but scoped to the awareness layer: who learned / forgot / "
        "had their awareness changed at which scene.\n\n"
        "Use this when you want to audit the full propagation of "
        "who-knows-what-when across the chain — useful for "
        "verifying a dramatic-irony setup, spotting forgotten "
        "observers, or scanning when each character's awareness "
        "of a secret changed without fanning out "
        "`get_knowledge(at=<each scene>)` calls.\n\n"
        "Args:\n"
        "  knowledge — required, UUID or exact (case-insensitive) "
        "name of the Knowledge to inspect.\n"
        "  scenes — optional list of scene UUIDs / titles. When "
        "passed, only events landing at one of the named scenes "
        "are returned.\n\n"
        "Returns `{ knowledge_id, knowledge_name, awareness_scale, "
        "events: [...] }`. Each event carries a `kind` discriminator "
        "(`baseline_set` / `observer_set` / `tracking_on` / "
        "`tracking_off` / `source_change`) + per-kind fields, plus "
        "`scene_id` / `scene_title` / `pov_index`, sorted by story "
        "order. Full per-kind field breakdown: "
        "`get_tool_help('get_knowledge_awareness_history')`. No session "
        "required."
    ),
)
async def get_knowledge_awareness_history(
    knowledge: str,
    scenes: Optional[list[str]] = None,
) -> dict:
    args: dict[str, Any] = {"knowledge": knowledge}
    if scenes is not None: args["scenes"] = scenes
    return await _proxy_tool("get_knowledge_awareness_history", args)


@mcp.tool(
    name="list_scenes",
    description=(
        "List every scene in the project, ordered by the POV path. "
        "Returns `{ scenes: [...] }`. Default (lean) per-entry shape: "
        "`{ id, title, summary, pov_index, on_pov_path, chapter_id, "
        "chapter_title }`. `pov_index` is the 1-based position of the "
        "scene on the POV path; off-POV scenes have `pov_index: null` "
        "and `on_pov_path: false`. POV-path scenes sort before off-POV "
        "scenes.\n\n"
        "Pass `verbose=true` to ADDITIONALLY include the same heavy "
        "fields `get_scene` returns per entry — `pov_entity_id`, "
        "`is_flashback`, `participants_by_type` (every entity present "
        "at the scene, names walked to this scene), `circumstances` "
        "(scene-level), and the full `time` block (pinned + walker-"
        "derived chain-position info). Use when orienting on an "
        "existing project so you don't need a per-scene `get_scene` "
        "call to see who's in each scene; lean default avoids the "
        "chain-walk cost per scene when you only need ids / titles. "
        "Main_content prose is NEVER included even with verbose=true "
        "(use `get_scene` for that)."
    ),
)
async def list_scenes(verbose: Optional[bool] = None) -> dict:
    args: dict[str, Any] = {}
    if verbose is not None: args["verbose"] = verbose
    return await _proxy_tool("list_scenes", args)


@mcp.tool(
    name="find_by_name",
    description=(
        "Searchable types: character, location, item, faction, custom, "
        "scene, relationship, knowledge, chapter, act.\n\n"
        "Case-insensitive SUBSTRING search across the project for "
        "objects whose name/title/alias contains the query. Searches "
        "entity names + aliases, scene titles, relationship names, "
        "knowledge names, chapter titles, and act titles. "
        "Returns `{ matches: [...] }` where each match is "
        "`{ id, type, name, matched_via, matched_value }`. `type` is "
        "one of the searchable types above; `matched_via` is "
        "'name' | 'alias' | 'title'. "
        "Useful for (a) discovery — what's in this project that's "
        "named like X — and (b) disambiguating an 'ambiguous reference' "
        "error returned by another tool. Optionally filter to one type."
    ),
)
async def find_by_name(name: str, type: Optional[LookupType] = None) -> dict:
    args: dict[str, Any] = {"name": name}
    if type is not None:
        args["type"] = type
    return await _proxy_tool("find_by_name", args)


@mcp.tool(
    name="list_relationships",
    description=(
        "List every relationship in the project. Returns "
        "`{ relationships: [...] }` where each entry is "
        "`{ id, name, participant_ids_ever, membership_of }`. "
        "`participant_ids_ever` is the union of every entity that "
        "has joined the relationship at any point in its history — "
        "NOT the current member list (use "
        "`get_relationship(rel, at=<scene>)` for scene-resolved "
        "members). "
        "`name` is null when the writer hasn't set an explicit label; "
        "unnamed relationships are referenceable only by UUID. "
        "`membership_of` is set on relationships that represent a "
        "canonical membership / containment record for an entity "
        "(e.g. faction membership)."
    ),
)
async def list_relationships() -> dict:
    return await _proxy_tool("list_relationships", {})


@mcp.tool(
    name="get_relationship",
    description=(
        "Return the state of one relationship at the requested scene "
        "anchor. The `relationship` arg accepts EITHER a UUID OR an "
        "exact (case-insensitive) name — unnamed relationships are "
        "UUID-only. The `at` arg controls WHICH version of the "
        "relationship you get back:\n"
        "  - omitted / null / 'origin' → ORIGIN-BASELINE state "
        "(name, description, membership_of, participant_roles keyed by "
        "entity_id, hierarchy, awareness_scale, origin_node_id + "
        "`origin_kind` 'scene' / 'standalone').\n"
        "  - scene UUID or exact title → SCENE-RESOLVED state at that "
        "scene: `is_active`, scene-resolved name / description / "
        "hierarchy / membership_of, and `participants` as a merged "
        "array of `{ entity_id, perception, alias_override, role }`.\n"
        "Full field-by-field shape of both branches (origin-location "
        "discrimination, the walked history kinds): "
        "`get_tool_help('get_relationship')`."
    ),
)
async def get_relationship(
    relationship: str, at: Optional[str] = None
) -> dict:
    args: dict[str, Any] = {"relationship": relationship}
    if at is not None: args["at"] = at
    return await _proxy_tool("get_relationship", args)


# ── Session control ────────────────────────────────────────────────────
#
# `request_mcp_session` is the user-permission gate that MCP clients
# must pass through before they can call WRITE tools (Phase D). Read
# tools above can be called any time the server is reachable; write
# tools will check `session_manager.state == 'active'` before
# accepting the request and return a `session_not_active` error
# envelope otherwise.
#
# This tool does NOT proxy through the WebSocket bridge — it operates
# entirely on the backend session manager. The frontend polls the
# control status endpoint to see pending requests and posts grant/deny
# back to the manager via `/mcp/control/requests/{id}/grant` (or
# /deny). When the manager resolves the request's future, this tool
# wakes up and returns the user's decision to the caller.


@mcp.tool(
    name="request_mcp_session",
    description=(
        "Ask the user for permission to start an authoring session in "
        "NarrativeNode. Call this BEFORE any write tool. The write "
        "tools (create / update / add / set / remove / delete / etc.) "
        "are NOT listed in the tool catalogue until a session is "
        "active; once granted they become available on your NEXT step "
        "(the catalogue refreshes after the grant), so call this first "
        "whenever you intend to modify the project, then use the write "
        "tools on the following step. The tool "
        "blocks until the user grants or denies the request (5-minute "
        "timeout). Pass a short `purpose` describing what you intend "
        "to do in this session — the user sees it on the request UI "
        "and uses it to decide whether to grant control. "
        "Returns one of: "
        "  'granted'  → session is now active; the write tools appear on "
        "your next step, call them then. "
        "  'already_active' → a session is already active and you ALREADY "
        "have write access; just proceed with the write tools (do NOT "
        "re-request). "
        "  'denied'   → the user explicitly declined. "
        "  'timeout'  → no response within 5 minutes. "
        "  'superseded' → another concurrent request was granted "
        "instead (only one active session at a time)."
    ),
)
async def request_mcp_session(
    purpose: Optional[str] = None,
    reason: Optional[str] = None,
) -> str:
    # `reason` is accepted at the schema layer only so we can surface
    # a clear "use `purpose` instead" error instead of the generic
    # extra-args rejection. Surfaced 2026-05-18: agents naturally
    # guess `reason=...` for this tool; making the guess fail with
    # a pointer rather than a cryptic schema error saves one round-
    # trip per fresh-agent setup.
    if reason and not purpose:
        raise RuntimeError(
            "[wrong_argument_name] `reason` is not the right argument "
            "name — pass `purpose=...` instead. Example: "
            "request_mcp_session(purpose='Adding 3 new scenes to "
            "chapter 2')."
        )
    if not purpose:
        raise RuntimeError(
            "[missing_argument] request_mcp_session requires "
            "`purpose=<str>` — a short description of what you intend "
            "to do in the session, shown to the user when they "
            "decide whether to grant access."
        )
    return await session_manager.request_session(purpose)


@mcp.tool(
    name="end_mcp_session",
    description=(
        "End the current MCP session and surface a summary for the "
        "user to review. Call this once you've finished the work you "
        "asked permission for via `request_mcp_session`. "
        "REQUIRED arg: `summary` (string) — describes what changed "
        "in this session in plain language. The user reads it in the "
        "review view alongside the session's tool-call log before "
        "dismissing back to idle. Example: "
        "`end_mcp_session(summary=\"Built out the 18-scene first "
        "act: created 5 characters, 3 locations, the rivalry "
        "relationship, and the inheritance Knowledge.\")`. "
        "Returns: "
        "  'ended'        → session closed, user is now reviewing. "
        "  'no_session'   → no active session was in progress; "
        "                   nothing to end (safe to ignore)."
    ),
)
async def end_mcp_session(summary: str) -> str:
    ok = session_manager.end_session(summary or "")
    return "ended" if ok else "no_session"


@mcp.tool(
    name="list_knowledges",
    description=(
        "List every Knowledge in the project. Returns "
        "`{ knowledges: [...] }` where each entry is "
        "`{ id, name, colour, awareness_scale, source_event }`. "
        "Knowledge is a first-class story object distinct from "
        "Entity/Relationship — used to track what facts or secrets "
        "exist in the narrative and who is aware of them. "
        "`source_event` is set on knowledges created via the 'Track "
        "awareness of this change' flow on another object's chain "
        "event; standalone knowledges (created via '+ New Knowledge') "
        "leave it null. `awareness_scale` is either 'binary' (yes/no) "
        "or 'full' (4-level alias scale)."
    ),
)
async def list_knowledges() -> dict:
    return await _proxy_tool("list_knowledges", {})


@mcp.tool(
    name="get_knowledge",
    description=(
        "Return the state of one knowledge at the requested scene "
        "anchor. The `knowledge` arg accepts EITHER a UUID OR an "
        "exact (case-insensitive) name — ambiguous names return a "
        "clarification error listing the candidates. The `at` arg "
        "controls WHICH version of the knowledge you get back:\n"
        "  - omitted / null / 'origin' → ORIGIN-BASELINE state "
        "(name, description, colour, profile_image_ref, notes, "
        "awareness_scale, awareness as a flat `{entity_id: level}` "
        "dict, source_event, manual_anchor_node_ids, origin_node_id + "
        "`origin_kind` 'scene' / 'standalone').\n"
        "  - scene UUID or exact title → SCENE-RESOLVED state at that "
        "scene: same shape with chain-walked values plus `scene_id`, "
        "`scene_title`, and `not_yet_exists` (true when `scene` is "
        "before the knowledge's creation anchor , everything else "
        "returns pre-creation defaults).\n"
        "Full field-by-field shape of both branches: "
        "`get_tool_help('get_knowledge')`."
    ),
)
async def get_knowledge(
    knowledge: str, at: Optional[str] = None
) -> dict:
    args: dict[str, Any] = {"knowledge": knowledge}
    if at is not None: args["at"] = at
    return await _proxy_tool("get_knowledge", args)


@mcp.tool(
    name="get_scene",
    description=(
        "Return the full state of one scene. The `scene` arg accepts "
        "EITHER a UUID OR an exact (case-insensitive) title.\n\n"
        "Returns: id, title, description, main_content (TipTap HTML "
        "body), position, chapter_id, chapter_title, pov_index, "
        "on_pov_path, is_flashback, parent_scene_id, pov_entity_id, "
        "participants_by_type, circumstances, and a `time` block "
        "with only the fields the writer has pinned.\n\n"
        "`participants_by_type` is keyed by entity type plural "
        "('characters' / 'locations' / 'items' / 'factions' / "
        "'customs') and each entry is `{ entity_id, name, colour, "
        "has_pov }` with name/colour walked to this scene. Follow up "
        "with `get_entity(entity, at=<this scene>)` for the full "
        "scene-resolved entity shape on any participant.\n\n"
        "`circumstances` entries are `{ id, name, description, "
        "intensity }` where intensity is the canonical name string "
        "('Faint' / 'Mild' / 'Moderate' / 'Strong' / 'Intense', or "
        "null).\n\n"
        "The `time` block includes only the axes the writer pinned "
        "(`time_of_day`, `weekday`, `season`, `date`, `scene_duration`, "
        "`gap_extension`) as human-readable strings, plus a "
        "walker-computed `derived` chain-position block on POV-chain "
        "scenes (effective start, gap-to-prior-scene phrasing, "
        "snap-forward flag).\n\n"
        "Pass `verbose=true` for a FULL composite snapshot in ONE call "
        "(prose / scene-review work): adds `participants` (full "
        "chain-resolved entity shapes with grouped attributes / "
        "circumstances / motivators, aliases, and provenance), "
        "`entity_temporary_circumstances`, `relationships`, and "
        "`knowledges` (each with the cumulative awareness map). Use the "
        "lean default for metadata-only / quick iteration. Full "
        "field-by-field shape of the `time` block and the verbose "
        "fields: `get_tool_help('get_scene')`."
    ),
)
async def get_scene(
    scene: str,
    verbose: Optional[bool] = None,
) -> dict:
    args: dict[str, Any] = {"scene": scene}
    if verbose is not None: args["verbose"] = verbose
    return await _proxy_tool("get_scene", args)


@mcp.tool(
    name="get_scene_context",
    description=(
        "Return the neighbouring scenes of one scene plus the story-"
        "level blurb. The `scene` arg accepts EITHER a UUID OR an exact "
        "(case-insensitive) title. Returns: id, title, story_description "
        "(empty string when unset — convenient framing the AI can read "
        "without a separate get_story call), pov_index, on_pov_path, "
        "chapter_id, chapter_title, pov_prev, pov_next, predecessors, "
        "successors. `pov_prev` / `pov_next` are the neighbouring "
        "POV-path scenes (null when the scene is off-POV or at an end). "
        "`predecessors` / `successors` are arrays of `{ id, title }` "
        "for every scene with a connection wire targeting / originating "
        "from this scene respectively. Useful for walking the story "
        "graph one scene at a time, or for understanding the local "
        "structure around a specific point."
    ),
)
async def get_scene_context(scene: str) -> dict:
    return await _proxy_tool("get_scene_context", {"scene": scene})


# ── Phase D — Wave 2 write tools ───────────────────────────────────────
#
# Write tools differ from read tools in two ways:
#
#   1. They route through `_proxy_write_tool(...)` instead of
#      `_proxy_tool(...)`. The wrapper checks
#      `session_manager.state == 'active'` and raises with a
#      `session_not_active` code if the AI hasn't first obtained
#      permission via `request_mcp_session(purpose)`. Reads are
#      always free; writes require explicit user grant.
#   2. Their docstrings spell out the scene semantics: which
#      operations write at ORIGIN (baseline) vs which record a
#      change at a specific scene. The MCP client (often an AI)
#      reads these to know when to use each tool.
#
# Each write tool maps 1:1 to an existing Zustand action on the
# frontend. The frontend handler in `mcpTools.js` is a thin wrapper
# that validates inputs, calls the action, and returns a clean
# id-bearing response so the AI can chain subsequent calls.


@mcp.tool(
    name="create_entity",
    description=(
        "Create a new entity at its ORIGIN. The entity's baseline "
        "(`name`, `colour`, `description`) is set to the values you "
        "pass; an entity origin EntityNode is automatically placed on "
        "the canvas. Optionally bulk-add starting attributes, aliases, "
        "circumstances, and motivators in the SAME call so a full "
        "origin setup lands in one round-trip instead of N follow-up "
        "calls.\n\n"
        "Args:\n"
        "  type — required, one of 'character' | 'location' | 'item' "
        "| 'faction' | 'custom'.\n"
        "  name — required, the canonical entity name.\n"
        "  description — optional baseline description text.\n"
        "  colour — optional hex string like '#aabbcc'; if omitted, a "
        "type-default colour is assigned.\n"
        "  category — REQUIRED for 'custom' entities. Accepts the "
        "category's UUID or exact (case-insensitive) name. Call "
        "`create_custom_category(name=...)` first to mint a new one "
        "if needed.\n"
        "  parent — optional for 'location' entities (sets the "
        "location hierarchy parent). Accepts a location entity's UUID "
        "or exact (case-insensitive) name/alias; resolver rejects "
        "non-location entities or missing refs.\n"
        "  attributes — optional list of starting attribute objects. "
        "Each item carries the same per-attribute fields `add_attribute` "
        "takes: `{name, attribute_type, value? / number_value? / "
        "file_ref? / preset_list? / values? / description? / "
        "intensity?}`. Pre-validated upfront — if any item is "
        "malformed the whole call errors with `attributes[N]: ...` "
        "attribution and the entity is NOT created.\n"
        "  aliases — optional list of alias objects `{value: <string>}` "
        "(same per-item-object shape as `attributes`). Bare strings "
        "are accepted as shorthand and auto-promoted "
        "(aliases=['Marc'] ≡ aliases=[{value: 'Marc'}]). Each becomes "
        "an Alias on the entity's baseline. Duplicates within the "
        "batch rejected.\n"
        "  circumstances — optional list of baseline circumstance "
        "objects. Each item: `{name, description?, intensity?}`. "
        "Lands at origin as persistent (chain-tracked from the "
        "entity's introduction forward). Same per-item validation + "
        "atomicity as `attributes`.\n"
        "  motivators — optional list of baseline motivator objects. "
        "Same per-item shape as `circumstances`. Lands at origin as "
        "persistent motivators (chain-tracked). Character-only in "
        "spirit, but the tool accepts them on any entity type (the "
        "data model doesn't restrict).\n\n"
        "All four batches (attributes / aliases / circumstances / "
        "motivators) share a single name pool — a name used in one "
        "batch cannot be reused in another on the same call.\n\n"
        "This writes the entity's BASELINE only (origin). To change "
        "any field at a specific scene downstream of the origin, use "
        "`update_entity(at=<scene>)` / `update_attributes(at=<scene>)`. "
        "Returns `{ id, type, name, entity_node_id }` plus separate "
        "`attributes` / `circumstances` / `motivators` / `aliases` "
        "lists echoing what landed in each bucket (omitted when the "
        "corresponding batch was empty). Requires an active MCP "
        "session."
        + _help_pointer("intensity", "intensity scale and accepted values")
    ),
)
async def create_entity(
    type: EntityType,
    name: str,
    description: Optional[str] = None,
    colour: Optional[str] = None,
    category: Optional[str] = None,
    parent: Optional[str] = None,
    attributes: Optional[list[dict]] = None,
    # Polymorphic per-item: bare strings OR `{value: <string>}` objects.
    # Typed as `list` so Pydantic doesn't reject the object form at the
    # MCP boundary; the frontend handler does per-item validation +
    # shape-coercion (mcpTools.js create_entity).
    aliases: Optional[list] = None,
    circumstances: Optional[list[dict]] = None,
    motivators: Optional[list[dict]] = None,
) -> dict:
    args: dict[str, Any] = {"type": type, "name": name}
    if description is not None: args["description"] = description
    if colour is not None: args["colour"] = colour
    if category is not None: args["category"] = category
    if parent is not None: args["parent"] = parent
    if attributes is not None: args["attributes"] = attributes
    if aliases is not None: args["aliases"] = aliases
    if circumstances is not None: args["circumstances"] = circumstances
    if motivators is not None: args["motivators"] = motivators
    return await _proxy_write_tool("create_entity", args)


@mcp.tool(
    name="update_entity",
    description=(
        "Entity types: character / location / item / faction / custom.\n\n"
        "Update an entity's fields, EITHER at the entity's origin "
        "(baseline) OR at a specific scene (chain-time change). `entity` "
        "accepts UUID or exact (case-insensitive) name / alias. Pass "
        "only the fields you want to change.\n\n"
        "`at` arg:\n"
        "  - omitted / null / 'origin' → BASELINE write. 'This is what "
        "the entity has always been.'\n"
        "  - scene UUID or exact title → records a change at that "
        "scene that propagates forward. Auto-adds the entity to the "
        "scene if not already present.\n\n"
        "Fields at ORIGIN: name, description, colour, profile_image_ref "
        "(empty string clears), notes, awareness_scale ('binary' or "
        "'full' — the entity-existence awareness precision, a whole-entity "
        "setting), aliases (full-list replacement, array of strings), "
        "parent (locations only — UUID or name of a location entity), "
        "category (custom only — UUID or name of a custom category).\n\n"
        "Fields AT A SCENE: name, description, colour, profile_image_ref, "
        "aliases. NOT settable at scene: notes, awareness_scale, parent, "
        "category, attributes (use the attribute tools).\n\n"
        "Returns the entity at the resolved anchor (origin or scene). "
        "Requires an active MCP session. Non-destructive."
        + _help_pointer("knowledge_tracking", "knowledge-tracking arg (tie this change to a Knowledge object)")
    ),
)
async def update_entity(
    entity: str,
    name: Optional[str] = None,
    description: Optional[str] = None,
    colour: Optional[str] = None,
    profile_image_ref: Optional[str] = None,
    notes: Optional[str] = None,
    awareness_scale: Optional[AwarenessScale] = None,
    # Polymorphic per-item: bare strings OR `{value: <string>}` objects.
    # Typed as `list` so Pydantic doesn't reject the object form at the
    # MCP boundary; the frontend handler (mcpTools.js update_entity)
    # auto-promotes bare strings via `_normaliseAliasesInput`.
    aliases: Optional[list] = None,
    parent: Optional[str] = None,
    category: Optional[str] = None,
    at: Optional[str] = None,
    track_as_knowledge: Optional[Any] = None,
) -> dict:
    args: dict[str, Any] = {"entity": entity}
    if name is not None: args["name"] = name
    if description is not None: args["description"] = description
    if colour is not None: args["colour"] = colour
    if profile_image_ref is not None: args["profile_image_ref"] = profile_image_ref
    if notes is not None: args["notes"] = notes
    if awareness_scale is not None: args["awareness_scale"] = awareness_scale
    if aliases is not None: args["aliases"] = aliases
    if parent is not None: args["parent"] = parent
    if category is not None: args["category"] = category
    if at is not None: args["at"] = at
    if track_as_knowledge is not None: args["track_as_knowledge"] = track_as_knowledge
    return await _proxy_write_tool("update_entity", args)


@mcp.tool(
    name="set_entity_profile_image",
    description=(
        "Entity types: character / location / item / faction / custom.\n\n"
        "Set an entity's profile / avatar image from raw image bytes. "
        "The MCP client passes the image as a base64-encoded string "
        "(optionally with a `data:image/...;base64,` prefix); the server "
        "decodes, preprocesses, saves the spec-compliant version to the "
        "project's assets directory, and sets the entity's "
        "`profile_image_ref` to point at it.\n\n"
        "Image preprocessing (server-side, identical to the writer-facing "
        "UI):\n"
        "  1. Crop to the largest CENTRED SQUARE the image contains. "
        "The full image stays visible inside the square — we trim equal "
        "slices off the long edge. No zoom-in / focus-region behaviour.\n"
        "  2. Resize the square to 256x256 (Lanczos resampling).\n"
        "  3. Encode as JPEG at quality 90.\n"
        "  4. EXIF metadata strips out as a side-effect of the re-encode.\n\n"
        "A SQUARE source image is preferred — non-square images will be "
        "cropped to the largest centred square as described above. Only "
        "the post-processed 256x256 JPEG ever lands in the project; the "
        "bytes you pass never touch disk in their original form.\n\n"
        "`entity` accepts a UUID OR an exact (case-insensitive) name / "
        "alias (same resolver as the other entity tools).\n\n"
        "`at` arg:\n"
        "  - omitted / null / 'origin' → sets the BASELINE profile image "
        "the entity has 'always had'.\n"
        "  - scene UUID or exact title → records the profile-image change "
        "at that scene, propagating forward as a chain modifier. Auto-"
        "adds the entity to the scene if not already present.\n\n"
        "Returns the entity at the resolved anchor. Requires an active "
        "MCP session. Non-destructive."
    ),
)
async def set_entity_profile_image(
    entity: str,
    image_base64: str,
    at: Optional[str] = None,
) -> dict:
    # Preprocess on the backend before forwarding to the existing
    # `update_entity` pipeline. The preprocessor enforces the
    # 256x256 JPEG-q90 contract so the AI can't sneak a non-spec
    # image past the wire; the post-processed bytes then route
    # through `store_asset_bytes` (same dedup + safe-naming as
    # the writer-facing `/assets/upload` endpoint) and the new
    # asset's `file_ref` rides forward to `update_entity` as a
    # plain `profile_image_ref` value. Per-anchor handling (origin
    # vs scene) is delegated to the existing tool — this wrapper
    # is purely the preprocess+upload step.
    import uuid as _uuid
    from services.profile_image_processor import preprocess_profile_image_from_base64
    from services import file_service

    try:
        jpeg_bytes = preprocess_profile_image_from_base64(image_base64)
    except ValueError as e:
        raise RuntimeError(f"[invalid_image] {e}")
    filename = f"profile_{_uuid.uuid4()}.jpg"
    file_ref = file_service.store_asset_bytes(jpeg_bytes, filename)
    args: dict[str, Any] = {"entity": entity, "profile_image_ref": file_ref}
    if at is not None: args["at"] = at
    return await _proxy_write_tool("update_entity", args)


@mcp.tool(
    name="delete_entity",
    description=(
        "Entity types: character, location, item, faction, custom.\n\n"
        "Delete an entity from the project. The `entity` arg accepts "
        "EITHER a UUID OR an exact (case-insensitive) name or alias "
        "of any of those types (same resolver as the read tools). "
        "DESTRUCTIVE — this routes through the project's deleteObject "
        "dispatcher and CANNOT be undone via the MCP API. The entity, "
        "its origin EntityNode, every modifier EntityNode that "
        "references it, every appearance in every scene that uses "
        "it, and every reference to its id across attribute / "
        "relationship / knowledge / chapter membership data are all "
        "stripped in one transaction. Use only when the user has "
        "explicitly asked you to remove an entity, not as a 'redo' "
        "shortcut for a misnamed entity (use a future "
        "`update_entity_at_origin` for renames). "
        "Requires both an active MCP session AND a per-action "
        "approval from the user. The approval modal pops in the "
        "user's UI showing the entity's name + the consequences "
        "above, with three options: Approve / Deny / Approve all "
        "destructive actions this session. The 'Approve all' choice "
        "is session-scoped and resets when the session ends. "
        "Returns `{ id, type, name }` of the deleted entity on "
        "success. Errors: `[session_not_active]`, "
        "`[destructive_denied]`, `[destructive_timeout]`, or the "
        "frontend resolver's ambiguous-name / not-found errors."
    ),
)
async def delete_entity(entity: str) -> dict:
    # Resolve the entity reference on the FRONTEND side via the
    # bridge — that's the same resolver path the read tools use, so
    # name/alias matching stays consistent. The frontend handler
    # also reads the resolved entity's name + type so the
    # destructive-approval modal can show meaningful text. The
    # backend wrapper is responsible only for the gating, NOT for
    # resolving the reference. This means the backend's modal text
    # is generic until the frontend handler runs — but that's fine,
    # the frontend resolves + dispatches the modal in one shot.
    return await _proxy_destructive_tool(
        "delete_entity",
        {"entity": entity},
        action="delete",
        object_type="entity",
        object_name=entity,  # raw reference; frontend can resolve to display name later
        detail=(
            "Removes the entity, its origin EntityNode, every "
            "modifier EntityNode that references it, its appearance "
            "in every scene that uses it, and every reference to its "
            "id across the project. Cannot be undone via MCP."
        ),
    )


# Attribute type literal used by `add_attribute` so MCP clients see
# the valid options upfront. Mirrors the backend's
# `Attribute.attribute_type` Literal.
AttributeType = Annotated[
    Literal[
        "text", "file", "preset", "number",
        "text_list", "entity_list",
        "circumstance", "motivator",
    ],
    BeforeValidator(_ci_str),
]


# Singular `add_attribute` tool retired in v0.2.1.156 — `add_attributes`
# is the canonical add tool (pass a one-element list for the single
# case). Per-attribute fields live inside each list item.


@mcp.tool(
    name="add_attributes",
    description=(
        "Add one or more attributes to an entity in one call. Each "
        "per-attribute field set lives inside an item of the "
        "`attributes` list. Pass a one-element list `[{...}]` for "
        "the single-attribute case — this is the only `add` tool for "
        "attributes; there is no singular variant.\n\n"
        "Args:\n"
        "  entity — required, UUID or exact name/alias of the target "
        "entity (any type).\n"
        "  attributes — required, non-empty list of attribute objects. "
        "Each item carries the SAME per-attribute fields `add_attribute` "
        "accepts: `{ name, attribute_type, value? / number_value? / "
        "file_ref? / preset_list? / values? / description? / "
        "intensity? }`. Pre-validated upfront — if any item is "
        "malformed the whole batch errors with `attributes[N]: ...` "
        "attribution and NO writes have landed (atomic). Duplicate "
        "names within the batch also reject.\n"
        "  at — optional. Same semantics as `add_attribute`: omit / "
        "null / 'origin' = adds to BASELINE; scene UUID or exact "
        "title = records each attribute's addition AT that scene "
        "(one chain entry per item).\n"
        "  track_as_knowledge — optional. Same single-anchor rule as "
        "`add_attribute`: requires the batch to produce EXACTLY ONE "
        "chain entry (i.e. exactly one item). Multi-item batches with "
        "`track_as_knowledge` reject with a 'split into separate calls' "
        "error.\n\n"
        "Returns `{ entity_id, attributes: [...] }` on origin path; "
        "scene path additionally carries `scene_id`, `scene_title`, "
        "`chain_actions: ['add', 'add', ...]`. Requires an active MCP "
        "session. Non-destructive."
    ),
)
async def add_attributes(
    entity: str,
    attributes: list[dict],
    at: Optional[str] = None,
    track_as_knowledge: Optional[Any] = None,
) -> dict:
    args: dict[str, Any] = {"entity": entity, "attributes": attributes}
    if at is not None: args["at"] = at
    if track_as_knowledge is not None: args["track_as_knowledge"] = track_as_knowledge
    return await _proxy_write_tool("add_attributes", args)


# Singular `update_attribute` retired in v0.2.1.158 — `update_attributes`
# is the canonical update tool (pass a one-element list for the single case).


@mcp.tool(
    name="update_attributes",
    description=(
        "Update one or more attribute values on a single entity in "
        "one call. Each item in `updates` references one existing "
        "attribute by UUID or exact (case-insensitive) name and "
        "supplies the field(s) to change. Pass a one-element list "
        "`[{...}]` for the single-attribute case — this is the only "
        "`update` tool for attributes; there is no singular variant.\n\n"
        "Args:\n"
        "  entity — required, UUID or exact name/alias of the target "
        "entity (any type).\n"
        "  updates — required, non-empty list of update objects. Each "
        "item shape: `{ attribute: <ref>, name? / value? / "
        "number_value? / file_ref? / description? / intensity? / "
        "values? / preset_list? }`. `attribute` is required; supply "
        "AT LEAST ONE field-to-change. Pre-validated upfront — if "
        "item 3 has a bad field-type combo or references a missing "
        "attribute the whole batch errors with `updates[3]: ...` "
        "attribution and NO writes have landed (atomic).\n"
        "  at — optional. Same semantics as `update_attribute`: omit "
        "/ null / 'origin' = updates BASELINE values; scene UUID or "
        "exact title = records each update as chain entries AT that "
        "scene. NOT supported at scene: `preset_list` reassignment "
        "(origin-only).\n"
        "  track_as_knowledge — optional. Same single-anchor rule as "
        "`update_attribute`: requires the batch to produce EXACTLY "
        "ONE chain entry across all items. Multi-entry batches reject "
        "with a 'split into separate calls' error.\n\n"
        "If two items target the same attribute, the second wins "
        "(last-write-wins on origin path; multiple chain entries "
        "land in order on scene path).\n\n"
        "Returns `{ entity_id, updates: [...] }` on origin path; "
        "scene path additionally carries `scene_id`, `scene_title`, "
        "and each update echoes `chain_actions: [...]` listing the "
        "entry kinds emitted for that attribute (`rename`, `modify`, "
        "`list_add`, `list_remove`). Requires an active MCP session. "
        "Non-destructive."
    ),
)
async def update_attributes(
    entity: str,
    updates: list[dict],
    at: Optional[str] = None,
    track_as_knowledge: Optional[Any] = None,
) -> dict:
    args: dict[str, Any] = {"entity": entity, "updates": updates}
    if at is not None: args["at"] = at
    if track_as_knowledge is not None: args["track_as_knowledge"] = track_as_knowledge
    return await _proxy_write_tool("update_attributes", args)


@mcp.tool(
    name="remove_attributes",
    description=(
        "Entity types: character, location, item, faction, custom.\n\n"
        "Remove one or more attributes from an entity in one call. "
        "Pass a one-element list for the single-attribute case — "
        "this is the only `remove` tool for attributes; there is no "
        "singular variant.\n\n"
        "Args:\n"
        "  entity — required, UUID or exact name/alias.\n"
        "  attributes — required, non-empty list of attribute "
        "references (UUID or exact name). Pre-validated upfront — "
        "if item N is malformed or references a missing attribute "
        "the whole batch errors with `attributes[N]: ...` "
        "attribution and NO writes have landed (atomic).\n"
        "  at — optional anchor:\n"
        "    • omitted / null / 'origin' → removes from the entity's "
        "BASELINE. DESTRUCTIVE — every listed attribute is erased "
        "from the project; every change to it that lived on any "
        "scene is also stripped. Requires an active session AND a "
        "per-action destructive approval from the user (one modal "
        "for the whole batch).\n"
        "    • scene UUID or exact title → records each attribute's "
        "removal AT that scene. NON-destructive — the attributes "
        "survive at baseline and at scenes before this scene; only "
        "this scene and scenes downstream show them as removed. "
        "Per the DELETE-vs-REMOVE distinction this is REMOVE, "
        "NOT DELETE — no destructive-approval modal fires.\n"
        "  track_as_knowledge — optional. Single-anchor rule: "
        "requires the batch to produce EXACTLY ONE chain entry "
        "(i.e. exactly one attribute on the scene path). Multi-item "
        "batches with track_as_knowledge reject cleanly.\n\n"
        "Returns `{ entity_id, attributes: [{id, name, type}, ...] }` "
        "on origin path; scene path additionally carries `scene_id`, "
        "`scene_title`, `chain_actions: ['remove', ...]`. Errors: "
        "`[session_not_active]`, `[destructive_denied]`, "
        "`[destructive_timeout]` (origin path only)."
        + _help_pointer("knowledge_tracking", "knowledge-tracking arg (tie this change to a Knowledge object)")
    ),
)
async def remove_attributes(
    entity: str,
    attributes: list[str],
    at: Optional[str] = None,
    track_as_knowledge: Optional[Any] = None,
) -> dict:
    args: dict[str, Any] = {"entity": entity, "attributes": attributes}
    if at is not None: args["at"] = at
    if track_as_knowledge is not None: args["track_as_knowledge"] = track_as_knowledge

    # Branch on anchor for the gate selection. Origin removal IS
    # destructive (each listed attribute ceases to exist + its chain
    # entries are stripped); scene removal is a chain event (objects
    # survive, only their presence-at-or-past-this-scene is affected).
    is_origin = at is None or at == "" or (isinstance(at, str) and at.lower() == "origin")
    if is_origin:
        count = len(attributes) if isinstance(attributes, list) else 1
        return await _proxy_destructive_tool(
            "remove_attributes",
            args,
            action="delete",
            object_type=f"attribute{'s' if count != 1 else ''}",
            object_name=(
                attributes[0] if count == 1 and isinstance(attributes, list)
                else f"{count} attributes"
            ),
            detail=(
                "Removes the listed attribute(s) from the entity's "
                "baseline. Each attribute's id becomes invalid; every "
                "change that referenced it across the project is "
                "stripped."
            ),
        )
    return await _proxy_write_tool("remove_attributes", args)


# ── Circumstance tools (audit verdict — shipped v0.2.1.117) ──────────
#
# Goal-level tools for circumstance / situational-state writes.
# Polymorphic `target` arg accepting EITHER an entity reference OR a
# scene reference. The resolver tries scene first, then entity, raising
# a clear error when neither matches. Routing:
#   - target=scene                       → SceneNode.circumstances[]
#                                          (scene's own property; NOT
#                                          chain-tracked; rejects
#                                          is_temporary / at / track_as_knowledge)
#   - target=entity + is_temporary=true  → EntityTemporaryCM on the
#                                          at-scene (scoped to one
#                                          entity at one scene; NOT
#                                          chain-tracked; requires at)
#   - target=entity + at=<scene>         → scene-anchored circumstance-
#                                          typed AttributeChange on the
#                                          entity's chip (chain event;
#                                          supports track_as_knowledge)
#   - target=entity (no at)              → entity baseline attribute
#                                          (origin write; no chain event)


_CIRCUMSTANCE_DOC_TAIL = (
    "\n\n"
    "── Target polymorphism ──\n\n"
    "The `target` arg accepts EITHER a scene UUID / title OR an entity "
    "UUID / name / alias. The resolver tries scene first then entity, "
    "raising a clear error when neither matches. Pass a UUID when a "
    "name overlaps between scenes and entities (rare).\n"
    "  - target=scene → operates on the scene's own `circumstances` "
    "list (a scene-level property; NOT chain-tracked; applies to every "
    "entity present in the scene). `is_temporary` and `at` are invalid "
    "for scene targets and reject cleanly.\n"
    "  - target=entity + `is_temporary=true` → operates on the scene's "
    "`entity_temporary_circumstances` list, scoped to just this entity "
    "at the named scene only (NOT chain-tracked; downstream scenes "
    "don't inherit). Requires `at=<scene>`.\n"
    "  - target=entity (no `is_temporary`) → operates on the entity's "
    "circumstance-typed attribute chain. `at=origin` (or omitted) writes "
    "the entity's baseline; `at=<scene>` records a chain event on the "
    "entity's chip at that scene (supports `track_as_knowledge` per "
    "Option F)."
)


# Singular `add_circumstance` retired in v0.2.1.156 — `add_circumstances`
# is the canonical add tool (pass a one-element list for the single case).


@mcp.tool(
    name="add_circumstances",
    description=(
        "Add one or more circumstances in one call. A circumstance is an "
        "EXTERNAL / situational state happening TO the entity (gender "
        "swapped, drunk, injured, soaked, hunted). For an INTERNAL drive "
        "/ goal / want pushing them from within (wants revenge, needs to "
        "protect the child, craving a fix), use `add_motivators` instead. "
        "All items in the "
        "batch share the same `target` + `at` + `is_temporary`, so they "
        "all land in the same scope. Pass a one-element list `[{...}]` "
        "for the single-circumstance case (there is no singular "
        "variant).\n\n"
        "Args:\n"
        "  target — required, a scene OR entity reference (the resolver "
        "tries scene first, then entity; pass a UUID to disambiguate a "
        "name shared between a scene and an entity).\n"
        "  circumstances — required, non-empty list of "
        "`{ name?, description?, intensity? }` (at least one of name / "
        "description non-empty per item). Pre-validated upfront: a bad "
        "item N errors with `circumstances[N]: ...` and NO writes land.\n"
        "  at — entity-target only. `at=<scene>` records a chain event "
        "that PROPAGATES FORWARD to every later scene — use for durable "
        "states (cursed, exiled, heartbroken). Omit / `at=origin` writes "
        "the entity's baseline.\n"
        "  is_temporary — entity-target only, requires `at`. Set `true` "
        "for a ONE-SCENE mood or reaction (drunk, panicked, soaked): it "
        "is scoped to just this entity at this scene and auto-expires at "
        "the scene boundary, so later scenes do NOT inherit it and no "
        "cleanup is needed. Prefer this for in-the-moment states; omit it "
        "only when the state should genuinely persist forward.\n"
        "  track_as_knowledge — requires the batch to produce exactly ONE "
        "chain entry; multi-item batches with it reject cleanly.\n\n"
        "Returns `{ target_kind, circumstances: [...] }`; entity-target "
        "paths additionally carry `entity_id` / `entity_type` / `scope`. "
        "Requires an active MCP session. Non-destructive."
        + _help_pointer("intensity", "intensity scale and accepted values")
    ),
)
async def add_circumstances(
    target: str,
    circumstances: list[dict],
    is_temporary: Optional[bool] = None,
    at: Optional[str] = None,
    track_as_knowledge: Optional[Any] = None,
) -> dict:
    args: dict[str, Any] = {"target": target, "circumstances": circumstances}
    if is_temporary is not None: args["is_temporary"] = is_temporary
    if at is not None: args["at"] = at
    if track_as_knowledge is not None: args["track_as_knowledge"] = track_as_knowledge
    return await _proxy_write_tool("add_circumstances", args)


@mcp.tool(
    name="update_circumstance",
    description=(
        "Update an existing circumstance's name / description / intensity. "
        "Pass only the fields you want to change. The `circumstance` arg "
        "accepts the UUID or the exact (case-insensitive) name of an "
        "existing entry in the target bucket.\n\n"
        "Args:\n"
        "  target       — required, scene or entity reference.\n"
        "  circumstance — required, UUID or exact name of an existing "
        "circumstance in the target bucket.\n"
        "  name         — optional new label (pass empty/null to clear).\n"
        "  description  — optional new body text.\n"
        "  intensity    — optional new intensity, or null to clear.\n"
        "  is_temporary — entity-target only; set true to operate on "
        "the EntityTemporaryCM bucket instead of the persistent "
        "attribute bucket. Requires `at=<scene>`.\n"
        "  at           — entity-target only; scene anchor.\n\n"
        "Returns the updated circumstance with `scope` indicating which "
        "bucket. Requires an active MCP session. Non-destructive."
        + _help_pointer("circumstances", "circumstances reference")
        + _help_pointer("intensity", "intensity scale and accepted values")
        + _help_pointer("knowledge_tracking", "knowledge-tracking arg (tie this change to a Knowledge object)")
    ),
)
async def update_circumstance(
    target: Optional[str] = None,
    circumstance: Optional[str] = None,
    name: Optional[str] = None,
    description: Optional[str] = None,
    intensity: Optional[Any] = None,
    is_temporary: Optional[bool] = None,
    at: Optional[str] = None,
    track_as_knowledge: Optional[Any] = None,
    entity: Optional[str] = None,
) -> dict:
    # Accept `entity` at the schema layer only so we can surface a
    # clear "use `target` instead" error instead of the generic
    # extra-args rejection. `target` is the canonical arg name across
    # the circumstance family (covers scene-level circumstances too,
    # which `entity` wouldn't fit). Surfaced 2026-05-18: agents
    # naturally reach for `entity=` when the target IS an entity.
    if entity and not target:
        raise RuntimeError(
            "[wrong_argument_name] `entity` is not the right argument "
            "name for update_circumstance — pass `target=...` instead "
            "(the same arg accepts scene or entity references, hence "
            "the more general name). Example: "
            "update_circumstance(target='Alex', circumstance='Anxious', "
            "intensity='Strong', at='<scene>')."
        )
    if not target:
        raise RuntimeError(
            "[missing_argument] update_circumstance requires "
            "`target=<scene or entity reference>`."
        )
    if not circumstance:
        raise RuntimeError(
            "[missing_argument] update_circumstance requires "
            "`circumstance=<UUID or exact name>`."
        )
    args: dict[str, Any] = {"target": target, "circumstance": circumstance}
    if name is not None: args["name"] = name
    if description is not None: args["description"] = description
    if intensity is not None: args["intensity"] = intensity
    if is_temporary is not None: args["is_temporary"] = is_temporary
    if at is not None: args["at"] = at
    if track_as_knowledge is not None: args["track_as_knowledge"] = track_as_knowledge
    return await _proxy_write_tool("update_circumstance", args)


@mcp.tool(
    name="remove_circumstances",
    description=(
        "Remove one or more circumstances from their target bucket in "
        "one call. Pass a one-element list for the single-circumstance "
        "case — this is the only `remove` tool for circumstances; "
        "there is no singular variant.\n\n"
        "Args:\n"
        "  target — required, scene or entity reference (same "
        "polymorphism as `add_circumstances`).\n"
        "  circumstances — required, non-empty list of circumstance "
        "references (UUID or exact name). Pre-validated upfront with "
        "`circumstances[N]: ...` attribution on bad refs.\n"
        "  is_temporary — entity-target only; set true to remove from "
        "the EntityTemporaryCM bucket. Requires `at=<scene>`. All "
        "items in the batch share the same flag.\n"
        "  at — entity-target only; scene anchor.\n"
        "  track_as_knowledge — optional; entity-target persistent "
        "path only. Single-anchor rule: requires the batch to produce "
        "exactly ONE chain entry; multi-item batches with "
        "track_as_knowledge reject cleanly.\n\n"
        "On the persistent entity path (`target=entity` without "
        "`is_temporary`), this routes through `remove_attributes` — "
        "origin removal is DESTRUCTIVE (deletes attribute baselines + "
        "strips downstream chain entries, triggers the destructive-"
        "approval modal — one modal for the whole batch); scene "
        "removal is REMOVE (records `action='remove'` chain entries, "
        "scene-scoped, non-destructive). Scene-target and temporary "
        "removes are always non-destructive scoped writes.\n\n"
        "Returns `{ target_kind, circumstances: [...], ... }`. "
        "Requires an active MCP session."
        + _help_pointer("circumstances", "circumstances reference")
        + _help_pointer("knowledge_tracking", "knowledge-tracking arg (tie this change to a Knowledge object)")
    ),
)
async def remove_circumstances(
    target: str,
    circumstances: list[str],
    is_temporary: Optional[bool] = None,
    at: Optional[str] = None,
    track_as_knowledge: Optional[Any] = None,
) -> dict:
    args: dict[str, Any] = {"target": target, "circumstances": circumstances}
    if is_temporary is not None: args["is_temporary"] = is_temporary
    if at is not None: args["at"] = at
    if track_as_knowledge is not None: args["track_as_knowledge"] = track_as_knowledge

    # Branch on path for the gate selection. Only the entity-target +
    # non-temporary + origin path is destructive (routes through
    # remove_attributes origin, which strips attribute baselines).
    is_origin = at is None or at == "" or (isinstance(at, str) and at.lower() == "origin")
    is_temp = bool(is_temporary)
    if is_origin and not is_temp:
        count = len(circumstances) if isinstance(circumstances, list) else 1
        return await _proxy_destructive_tool(
            "remove_circumstances",
            args,
            action="delete",
            object_type=f"circumstance{'s' if count != 1 else ''}",
            object_name=(
                circumstances[0] if count == 1 and isinstance(circumstances, list)
                else f"{count} circumstances"
            ),
            detail=(
                "Removes one or more circumstances from their target. "
                "For entity targets at origin (no `at`, not temporary), "
                "this is a DELETE on each attribute baseline — every "
                "chain entry downstream that referenced an attribute id "
                "is also stripped. Scene-target removes and temporary "
                "removes go through the non-destructive path."
            ),
        )
    return await _proxy_write_tool("remove_circumstances", args)


# ── Motivator tools (audit verdict — shipped v0.2.1.118) ─────────────
#
# Same architecture as circumstance tools but entity-only (motivators
# don't live on scenes per the data model). Three routing paths:
#   - entity (no at)               → entity baseline attribute_type=
#                                    'motivator' via canonical updateEntity.
#   - entity + at=<scene>          → scene-anchored AttributeChange on
#                                    the entity's chip (chain event;
#                                    supports track_as_knowledge per F).
#   - entity + is_temporary=true   → EntityTemporaryCM with
#                                    attribute_type='motivator', scoped
#                                    to one entity at one scene only
#                                    (NOT chain-tracked; requires at).


_MOTIVATOR_DOC_TAIL = (
    "\n\n"
    "── Entity-only ──\n\n"
    "Motivators don't live on scenes per the data model — they're "
    "always attached to an entity (representing the entity's internal "
    "drives / goals). Three routing paths based on `at` and "
    "`is_temporary`:\n"
    "  - entity (no `at`) → operates on the entity's baseline "
    "motivator-typed attribute via canonical updateEntity (origin write).\n"
    "  - entity + `at=<scene>` → records a chain event on the entity's "
    "chip at that scene; downstream scenes inherit. Supports "
    "`track_as_knowledge` per Option F.\n"
    "  - entity + `is_temporary=true` → operates on the scene's "
    "`entity_temporary_circumstances` list with attribute_type='motivator', "
    "scoped to just this entity at the named scene only (NOT "
    "chain-tracked; downstream scenes don't inherit). Requires "
    "`at=<scene>`."
)


# Singular `add_motivator` retired in v0.2.1.156 — `add_motivators` is
# the canonical add tool (pass a one-element list for the single case).


@mcp.tool(
    name="add_motivators",
    description=(
        "Add one or more motivators on a single entity in one call. "
        "A motivator is an INTERNAL drive / goal / want pushing the "
        "entity from within (wants revenge, needs to protect the child, "
        "craving a fix, determined to escape). For an EXTERNAL / "
        "situational state happening TO them (gender swapped, drunk, "
        "injured, hunted), use `add_circumstances` instead. "
        "Motivators are entity-only (no scene-level form — they are "
        "inner drives, not environmental state). All items in the batch "
        "share the same `at` + `is_temporary` + `track_as_knowledge`. "
        "Pass a one-element list `[{...}]` for the single-motivator case "
        "(there is no singular variant).\n\n"
        "Args:\n"
        "  entity — required, UUID or exact name/alias of the target "
        "entity.\n"
        "  motivators — required, non-empty list of "
        "`{ name?, description?, intensity? }` (at least one of name / "
        "description non-empty per item). Pre-validated upfront: a bad "
        "item N errors with `motivators[N]: ...` and NO writes land.\n"
        "  at — `at=<scene>` records a chain event that PROPAGATES "
        "FORWARD to every later scene — use for durable drives (sworn "
        "revenge, protect the child). Omit / `at=origin` writes the "
        "entity's baseline.\n"
        "  is_temporary — requires `at`. Set `true` for a ONE-SCENE "
        "drive or urge (wants to flee this room, craving right now): it "
        "is scoped to just this entity at this scene and auto-expires at "
        "the scene boundary, so later scenes do NOT inherit it and no "
        "cleanup is needed. Prefer this for in-the-moment drives; omit it "
        "only when the drive should genuinely persist forward.\n"
        "  track_as_knowledge — requires the batch to produce exactly ONE "
        "chain entry; multi-item batches with it reject cleanly.\n\n"
        "Returns `{ entity_id, entity_type, scope, motivators: [...] }`; "
        "scene-path returns additionally carry `scene_id` / "
        "`scene_title`. Requires an active MCP session. Non-destructive."
        + _help_pointer("intensity", "intensity scale and accepted values")
    ),
)
async def add_motivators(
    entity: str,
    motivators: list[dict],
    is_temporary: Optional[bool] = None,
    at: Optional[str] = None,
    track_as_knowledge: Optional[Any] = None,
) -> dict:
    args: dict[str, Any] = {"entity": entity, "motivators": motivators}
    if is_temporary is not None: args["is_temporary"] = is_temporary
    if at is not None: args["at"] = at
    if track_as_knowledge is not None: args["track_as_knowledge"] = track_as_knowledge
    return await _proxy_write_tool("add_motivators", args)


@mcp.tool(
    name="update_motivator",
    description=(
        "Update an existing motivator's name / description / intensity. "
        "Pass only the fields you want to change. The `motivator` arg "
        "accepts the UUID or the exact (case-insensitive) name of an "
        "existing entry on the entity (in the bucket implied by `at` + "
        "`is_temporary`).\n\n"
        "Args:\n"
        "  entity       — required, entity reference.\n"
        "  motivator    — required, UUID or exact name.\n"
        "  name         — optional new label (pass empty/null to clear).\n"
        "  description  — optional new body text.\n"
        "  intensity    — optional new intensity, or null to clear.\n"
        "  is_temporary — set true to operate on the EntityTemporaryCM "
        "bucket instead of the persistent attribute bucket. Requires "
        "`at=<scene>`.\n"
        "  at           — scene anchor.\n\n"
        "Returns the updated motivator with `scope` indicating which "
        "bucket. Requires an active MCP session. Non-destructive."
        + _help_pointer("motivators", "motivators reference")
        + _help_pointer("intensity", "intensity scale and accepted values")
        + _help_pointer("knowledge_tracking", "knowledge-tracking arg (tie this change to a Knowledge object)")
    ),
)
async def update_motivator(
    entity: str,
    motivator: str,
    name: Optional[str] = None,
    description: Optional[str] = None,
    intensity: Optional[Any] = None,
    is_temporary: Optional[bool] = None,
    at: Optional[str] = None,
    track_as_knowledge: Optional[Any] = None,
) -> dict:
    args: dict[str, Any] = {"entity": entity, "motivator": motivator}
    if name is not None: args["name"] = name
    if description is not None: args["description"] = description
    if intensity is not None: args["intensity"] = intensity
    if is_temporary is not None: args["is_temporary"] = is_temporary
    if at is not None: args["at"] = at
    if track_as_knowledge is not None: args["track_as_knowledge"] = track_as_knowledge
    return await _proxy_write_tool("update_motivator", args)


@mcp.tool(
    name="remove_motivators",
    description=(
        "Remove one or more motivators from their bucket on the "
        "entity in one call. Pass a one-element list for the single-"
        "motivator case — this is the only `remove` tool for "
        "motivators; there is no singular variant.\n\n"
        "Args:\n"
        "  entity — required, entity reference.\n"
        "  motivators — required, non-empty list of motivator "
        "references (UUID or exact name). Pre-validated upfront with "
        "`motivators[N]: ...` attribution on bad refs.\n"
        "  is_temporary — set true to remove from the "
        "EntityTemporaryCM bucket. Requires `at=<scene>`. All items "
        "in the batch share the same flag.\n"
        "  at — scene anchor.\n"
        "  track_as_knowledge — optional; persistent path only. "
        "Single-anchor rule: requires the batch to produce exactly "
        "ONE chain entry; multi-item batches with track_as_knowledge "
        "reject cleanly.\n\n"
        "On the persistent path (no `is_temporary`), this routes "
        "through `remove_attributes` — origin removal is DESTRUCTIVE "
        "(deletes attribute baselines + strips downstream chain "
        "entries, triggers the destructive-approval modal — one modal "
        "for the whole batch); scene removal is REMOVE (records "
        "`action='remove'` chain entries, scene-scoped, non-"
        "destructive). Temporary removes are always non-destructive "
        "scoped writes.\n\n"
        "Returns `{ entity_id, motivators: [...], ... }`. Requires an "
        "active MCP session."
        + _help_pointer("motivators", "motivators reference")
        + _help_pointer("knowledge_tracking", "knowledge-tracking arg (tie this change to a Knowledge object)")
    ),
)
async def remove_motivators(
    entity: str,
    motivators: list[str],
    is_temporary: Optional[bool] = None,
    at: Optional[str] = None,
    track_as_knowledge: Optional[Any] = None,
) -> dict:
    args: dict[str, Any] = {"entity": entity, "motivators": motivators}
    if is_temporary is not None: args["is_temporary"] = is_temporary
    if at is not None: args["at"] = at
    if track_as_knowledge is not None: args["track_as_knowledge"] = track_as_knowledge

    # Branch on path for the gate selection — only the persistent
    # origin path (no `is_temporary`, no `at`) is destructive.
    is_origin = at is None or at == "" or (isinstance(at, str) and at.lower() == "origin")
    is_temp = bool(is_temporary)
    if is_origin and not is_temp:
        count = len(motivators) if isinstance(motivators, list) else 1
        return await _proxy_destructive_tool(
            "remove_motivators",
            args,
            action="delete",
            object_type=f"motivator{'s' if count != 1 else ''}",
            object_name=(
                motivators[0] if count == 1 and isinstance(motivators, list)
                else f"{count} motivators"
            ),
            detail=(
                "Removes one or more motivators from the entity's "
                "baseline. DELETE on each attribute baseline — every "
                "chain entry downstream that referenced an attribute "
                "id is also stripped. Scene-anchored and temporary "
                "removes go through the non-destructive path."
            ),
        )
    return await _proxy_write_tool("remove_motivators", args)


# ── Perspective tools (Phase 2.13e — shipped v0.2.13.9) ──────────────
#
# Entity-only batch add / single update / batch remove for the
# `perspective` attribute type. A perspective records what one entity
# thinks / feels / believes about another object (5 entity kinds +
# knowledge + relationship). No is_temporary — perspectives aren't
# scene-scoped in v1. Two routing paths:
#   - entity (no at)         → entity baseline attribute_type=
#                              'perspective' via canonical updateEntity.
#   - entity + at=<scene>    → chain-event write at the scene anchor.
#
# Singular `add_perspective` deliberately omitted — `add_perspectives`
# is the only add tool (pass a one-element list for the single case).
# Mirrors the consolidated tool surface used by attributes /
# circumstances / motivators / aliases.


@mcp.tool(
    name="add_perspectives",
    description=(
        "Entity types: character, location, item, faction, custom.\n\n"
        "Add one or more perspectives on an entity in one call. A "
        "perspective records what this entity thinks / feels / believes "
        "about another object — character, location, item, faction, "
        "custom entity, knowledge, or relationship. Pass a one-element "
        "list `[{...}]` for the single-perspective case — this is the "
        "only `add` tool for perspectives; there is no singular variant.\n\n"
        "Args:\n"
        "  entity — required, entity reference (UUID or exact name) "
        "of the perspective's HOST (the entity whose perspective this "
        "is).\n"
        "  perspectives — required, non-empty list of perspective "
        "objects. Each item: `{ name?, description, target: { kind, "
        "ref } }`. `description` is required (the perspective body — "
        "what the host thinks/feels/believes). `target.kind` is one of "
        "character|location|item|faction|custom|knowledge|relationship. "
        "`target.ref` is a UUID or exact name of the target object. "
        "`name` is optional (perspectives usually have no name — the "
        "target IS the identity).\n"
        "  at — optional scene anchor. Omit / 'origin' writes to the "
        "host's entity baseline; pass a scene reference to record the "
        "perspective as a chain-event 'add' at that scene.\n"
        "  track_as_knowledge — optional; scene-anchor path only. "
        "Anchors a Knowledge to the new chain entry. Single-anchor "
        "rule: requires exactly ONE chain entry per call; multi-item "
        "batches with `track_as_knowledge` reject cleanly.\n\n"
        "Returns `{ entity_id, entity_type, scope, perspectives: [...] }`. "
        "Requires an active MCP session. Non-destructive."
    ),
)
async def add_perspectives(
    entity: str,
    perspectives: list[dict],
    at: Optional[str] = None,
    track_as_knowledge: Optional[Any] = None,
) -> dict:
    args: dict[str, Any] = {"entity": entity, "perspectives": perspectives}
    if at is not None: args["at"] = at
    if track_as_knowledge is not None: args["track_as_knowledge"] = track_as_knowledge
    return await _proxy_write_tool("add_perspectives", args)


@mcp.tool(
    name="update_perspective",
    description=(
        "Entity types: character, location, item, faction, custom.\n\n"
        "Update an existing perspective's name / description / target. "
        "Pass only the fields you want to change. At least one of "
        "`name` / `description` / `target` must be present.\n\n"
        "Args:\n"
        "  entity — required, entity reference (the host whose "
        "perspective is being edited).\n"
        "  perspective — required, reference to the perspective in "
        "the host's perspective list. Accepts: UUID; the perspective's "
        "own `name` (if set); the TARGET'S exact name (so the AI can "
        "say `update_perspective(entity='Alice', perspective='Bob', ...)` "
        "to edit Alice's perspective on Bob). Falls through the three "
        "passes in that order; ambiguous matches reject cleanly with a "
        "request for a UUID.\n"
        "  name — optional new perspective name.\n"
        "  description — optional new description body.\n"
        "  target — optional new target. Either `{ kind, ref }` to "
        "rewire to a different object, or explicit `null` to orphan "
        "the target (matches the cascade contract — description "
        "survives, target goes to null).\n"
        "  at — optional scene anchor. Omit / 'origin' mutates the "
        "baseline; pass a scene reference to write a modify chain "
        "entry at that scene.\n"
        "  track_as_knowledge — optional; scene-anchor path only.\n\n"
        "Returns the updated perspective. Requires an active MCP "
        "session. Non-destructive."
    ),
)
async def update_perspective(
    entity: str,
    perspective: str,
    name: Optional[str] = None,
    description: Optional[str] = None,
    target: Optional[Any] = None,
    at: Optional[str] = None,
    track_as_knowledge: Optional[Any] = None,
) -> dict:
    args: dict[str, Any] = {"entity": entity, "perspective": perspective}
    if name is not None: args["name"] = name
    if description is not None: args["description"] = description
    # `target` accepts explicit None as the "orphan" signal; only skip
    # if the caller omitted the kwarg entirely. FastMCP defaults
    # `Optional[Any] = None` so we can't distinguish "passed null" from
    # "didn't pass" without a sentinel. Practically: agents that want
    # to orphan a perspective should call `remove_perspectives` or
    # pass a fresh target instead — orphaning via this path is a rare
    # corner case. If callers report needing explicit null-orphan
    # support, add a sentinel here.
    if target is not None: args["target"] = target
    if at is not None: args["at"] = at
    if track_as_knowledge is not None: args["track_as_knowledge"] = track_as_knowledge
    return await _proxy_write_tool("update_perspective", args)


@mcp.tool(
    name="remove_perspectives",
    description=(
        "Entity types: character, location, item, faction, custom.\n\n"
        "Remove one or more perspectives from a host entity in one "
        "call. Pass a one-element list for the single-perspective "
        "case — this is the only `remove` tool for perspectives; "
        "there is no singular variant.\n\n"
        "Args:\n"
        "  entity — required, entity reference (host of the perspectives).\n"
        "  perspectives — required, non-empty list of perspective "
        "references (UUID, perspective name, or target name — same "
        "resolution order as `update_perspective`). Pre-validated "
        "upfront with `perspectives[N]: ...` attribution on bad refs.\n"
        "  at — optional scene anchor. Omit / 'origin' deletes from "
        "the baseline (DESTRUCTIVE — also strips downstream chain "
        "entries that referenced the attribute); pass a scene "
        "reference to record a scene-scoped chain remove (non-"
        "destructive).\n"
        "  track_as_knowledge — optional; scene-anchor path only.\n\n"
        "On the entity-baseline path (no `at`), this routes through "
        "`remove_attributes` origin — DESTRUCTIVE (deletes attribute "
        "baselines + strips downstream chain entries, triggers the "
        "destructive-approval modal). Scene removal is REMOVE "
        "(non-destructive).\n\n"
        "Returns `{ entity_id, entity_type, scope, perspectives: [...], "
        "... }`. Requires an active MCP session."
    ),
)
async def remove_perspectives(
    entity: str,
    perspectives: list[str],
    at: Optional[str] = None,
    track_as_knowledge: Optional[Any] = None,
) -> dict:
    args: dict[str, Any] = {"entity": entity, "perspectives": perspectives}
    if at is not None: args["at"] = at
    if track_as_knowledge is not None: args["track_as_knowledge"] = track_as_knowledge

    # Branch on path for the gate selection — only the entity-baseline
    # path (no `at`) is destructive.
    is_origin = at is None or at == "" or (isinstance(at, str) and at.lower() == "origin")
    if is_origin:
        count = len(perspectives) if isinstance(perspectives, list) else 1
        return await _proxy_destructive_tool(
            "remove_perspectives",
            args,
            action="delete",
            object_type=f"perspective{'s' if count != 1 else ''}",
            object_name=(
                perspectives[0] if count == 1 and isinstance(perspectives, list)
                else f"{count} perspectives"
            ),
            detail=(
                "Removes one or more perspectives from the host "
                "entity's baseline. DELETE on each attribute baseline — "
                "every chain entry downstream that referenced an "
                "attribute id is also stripped. Scene-anchored removes "
                "go through the non-destructive path."
            ),
        )
    return await _proxy_write_tool("remove_perspectives", args)


# ── Alias write tools ────────────────────────────────────────────────
#
# Per-alias goal-level tools. Shipped 2026-05-17 as the final commit
# of the aliases bugfix arc; the underlying per-event AliasChange
# chain mechanism has been working since v0.2.1.76 and is reachable
# from MCP via `update_entity(at=<scene>, aliases=[full-list])` since
# v0.2.1.90. These tools expose the per-event ops directly so a
# caller can add / rename / remove a single alias without naming
# every other alias on the entity (the full-list path requires it).


# Singular `add_alias` retired in v0.2.1.156 — `add_aliases` is the
# canonical add tool (pass a one-element list for the single case).


@mcp.tool(
    name="add_aliases",
    description=(
        "Entity types: character, location, item, faction, custom.\n\n"
        "Bulk-add one or more aliases on an entity in one call. Each "
        "item in `aliases` is an object `{value: <string>}` (mirrors "
        "the per-item object shape used by `add_attributes`). Bare "
        "strings are accepted as shorthand and auto-promoted.\n\n"
        "Args:\n"
        "  entity — required, entity reference (UUID or exact name/alias).\n"
        "  aliases — required, non-empty list of alias objects "
        "`{value: <string>}`. For a single alias pass a one-element "
        "list: aliases=[{value: 'Marc'}]. Bare strings "
        "(aliases=['Marc']) are accepted as shorthand and auto-"
        "promoted to {value}. Pre-validated upfront — empty values, "
        "within-batch duplicates, and existing-value collisions all "
        "rejected with `aliases[N]: ...` attribution before any "
        "write commits.\n"
        "  at — optional anchor:\n"
        "    • omitted / null / 'origin' → adds to the entity's "
        "BASELINE alias list. Use for 'this entity has always been "
        "known as X / Y / Z'. Atomic via one updateEntity call.\n"
        "    • scene UUID or exact (case-insensitive) title → records "
        "one `action='add'` AliasChange per item on the entity's chip "
        "at that scene. Auto-adds the entity to the scene (with D2 "
        "auto-wire) if not already present. Aliases appear on the "
        "entity from this scene forward. Atomic via one "
        "_appendAliasChainEntries call (commits the full list).\n"
        "  track_as_knowledge — optional. Same single-anchor rule as "
        "the attribute batch tools: requires the batch to produce "
        "EXACTLY ONE chain entry (i.e. exactly one alias). Multi-"
        "item batches with track_as_knowledge reject cleanly.\n\n"
        "Returns `{ entity_id, aliases: [{id, value}, ...] }` on "
        "origin path; scene path additionally carries `scene_id`, "
        "`scene_title`, `chain_actions: ['add', 'add', ...]`. "
        "Requires an active MCP session. Non-destructive."
    ),
)
async def add_aliases(
    entity: str,
    # Polymorphic per-item: bare strings OR `{value: <string>}` objects.
    # Typed as `list[Any]` so Pydantic doesn't reject the object form
    # at the MCP boundary; the frontend handler does the per-item
    # validation and shape-coercion (mcpTools.js).
    aliases: list[Any],
    at: Optional[str] = None,
    track_as_knowledge: Optional[Any] = None,
) -> dict:
    args: dict[str, Any] = {"entity": entity, "aliases": aliases}
    if at is not None: args["at"] = at
    if track_as_knowledge is not None: args["track_as_knowledge"] = track_as_knowledge
    return await _proxy_write_tool("add_aliases", args)


@mcp.tool(
    name="update_alias",
    description=(
        "Entity types: character, location, item, faction, custom.\n\n"
        "Rename an existing alias on an entity. The `entity` arg "
        "accepts UUID or exact name/alias of any of those types; the "
        "`alias` arg accepts the alias's UUID or its exact (case-"
        "insensitive) value.\n\n"
        "Args:\n"
        "  entity    — required, entity reference.\n"
        "  alias     — required, alias UUID or exact value.\n"
        "  new_value — required, new alias text (non-empty after trim).\n"
        "  at        — optional anchor:\n"
        "    • omitted / null / 'origin' → updates BASELINE value of "
        "the matching alias on `entity.aliases[]`.\n"
        "    • scene UUID or exact title → records an `action='modify'` "
        "AliasChange on the entity's chip at that scene; the rename "
        "applies from this scene forward. Auto-adds the entity to the "
        "scene (with D2 auto-wire) if not already present. Resolves "
        "the `alias` arg against the scene-resolved alias list (so "
        "chain-added aliases can also be renamed).\n\n"
        "Duplicate-value check: the new value must not collide with "
        "any OTHER alias on the entity (at baseline for the origin "
        "path, at the scene's effective state for the scene path).\n\n"
        "Returns `{ entity_id, alias_id, old_value, value }` (plus "
        "`scene_id` / `scene_title` / `chain_action: 'modify'` on the "
        "scene path). Requires an active MCP session. Non-destructive."
    ),
)
async def update_alias(
    entity: str,
    alias: str,
    new_value: str,
    at: Optional[str] = None,
) -> dict:
    args: dict[str, Any] = {
        "entity": entity, "alias": alias, "new_value": new_value,
    }
    if at is not None: args["at"] = at
    return await _proxy_write_tool("update_alias", args)


@mcp.tool(
    name="remove_aliases",
    description=(
        "Entity types: character, location, item, faction, custom.\n\n"
        "Remove one or more aliases from an entity in one call. Pass "
        "a one-element list for the single-alias case — this is the "
        "only `remove` tool for aliases; there is no singular variant.\n\n"
        "Args:\n"
        "  entity — required, entity reference (UUID or exact name/alias).\n"
        "  aliases — required, non-empty list of alias references. Each "
        "item is a string: alias UUID OR exact (case-insensitive) value. "
        "Pre-validated upfront with `aliases[N]: ...` attribution on bad "
        "refs; no writes land if any item is bad.\n"
        "  at — optional anchor:\n"
        "    • omitted / null / 'origin' → removes from the entity's "
        "BASELINE alias list. Filter operation, NOT destructive — no "
        "approval modal fires (aliases are not first-class chain "
        "objects with attached Knowledges or origin nodes). Any "
        "downstream chain events targeting a removed alias's id "
        "become dangling — the walker tolerates them defensively.\n"
        "    • scene UUID or exact title → records one `action='remove'` "
        "AliasChange per item on the entity's chip at that scene. "
        "NON-destructive — aliases survive at baseline and at scenes "
        "before this scene; only this scene and scenes downstream "
        "show them as removed. Per the DELETE-vs-REMOVE distinction this "
        "is REMOVE (context-scoped), NOT DELETE.\n\n"
        "Returns `{ entity_id, aliases: [{id, value}, ...] }` on "
        "origin path; scene path additionally carries `scene_id`, "
        "`scene_title`, `chain_actions: ['remove', ...]`. Requires an "
        "active MCP session."
    ),
)
async def remove_aliases(
    entity: str,
    aliases: list[str],
    at: Optional[str] = None,
) -> dict:
    args: dict[str, Any] = {"entity": entity, "aliases": aliases}
    if at is not None: args["at"] = at
    return await _proxy_write_tool("remove_aliases", args)


# ── Scene write tools ─────────────────────────────────────────────────


# Shared `main_content` arg description for create_scene / update_scene.
# NN's scene editor is TipTap-based with a known extension set; this
# spells out the supported HTML subset so MCP clients aren't guessing.
_MAIN_CONTENT_DOC = (
    "The scene's main content, typically the prose of the scene. "
    "TipTap-compatible HTML. Supported tags / styles: `<p>` "
    "paragraphs, `<h1>`–`<h6>` headings, `<strong>` / `<em>` / `<u>` "
    "/ `<s>` (bold / italic / underline / strikethrough), `<ul>` / "
    "`<ol>` / `<li>` lists, `<blockquote>`, `<code>` / `<pre><code>` "
    "(inline / block code), `<mark>` highlights (with optional "
    "`style=\"background-color: ...\"`), `<span style=\"color: ...; "
    "font-size: ...; font-family: ...\">` for text styling, `<br>` "
    "line breaks. NOT supported: `<a>` links, `<img>` images, "
    "scripts, arbitrary attributes — unsupported tags and attributes "
    "are dropped on load by TipTap's parser. Empty string clears the "
    "content."
)


_D3D4_SCENE_DOC_TAIL = (
    "\n\n"
    "── Structural args (chapter / POV / off-screen) ──\n\n"
    "  - `chapter` — chapter UUID or exact (case-insensitive) title to "
    "ASSIGN the scene to that chapter (positions it within the "
    "chapter's canvas x-range — chapter membership is derived from "
    "x-position, not a per-scene field). Errors cleanly if the named "
    "chapter doesn't exist; call `create_chapter` first if needed. "
    "Pass `chapter=null` (or empty string) to CLEAR chapter membership "
    "— the scene is moved past the rightmost chapter's right edge with "
    "an 80 px buffer so it lives in off-chapter territory at the right "
    "end of the canvas. Subsequent `create_chapter` calls preserve its "
    "off-chapter status by shifting it further right.\n"
    "  - `pov_character` — character UUID or exact name/alias. Sets "
    "the scene's POV character (auto-adds them to the scene with "
    "automatic upstream wiring if not already a participant). "
    "Passing `null` / `''` clears POV (strips POV wires + clears "
    "`pov_entity_id`). Non-characters error cleanly.\n"
    "  - `pov_after` / `pov_before` — scene UUID or exact title. "
    "Inserts this scene into the POV chain after / before the named "
    "reference scene. Existing POV wires to/from this scene are "
    "stripped first, so re-positions are clean. Requires a POV "
    "character on the scene (either passed in the same call or "
    "already set). Cycle-safeguarded. CANVAS PLACEMENT: the new "
    "scene also lands SPATIALLY between the reference scene and its "
    "neighbour on the canvas — with the chapter widening (and "
    "downstream scenes cascade-shifting right) to make room if "
    "needed. When `chapter` isn't explicitly passed, the new scene's "
    "chapter is inferred from the reference scene's chapter. When "
    "BOTH `chapter` and `pov_after`/`pov_before` are passed AND they "
    "disagree, the explicit chapter wins for placement and the POV "
    "wire is created as directed — the existing `pov_chapter_order` "
    "workflow alert will fire when the chain crosses chapters in the "
    "wrong direction, surfacing the conflict to the writer.\n"
    "  - `off_screen` — bool. When true, removes the scene from the "
    "POV chain entirely (alias for clearing `pov_character`). To "
    "re-attach later, pass `pov_character` alongside `pov_after` / "
    "`pov_before` in one call.\n\n"
    "Default POV placement: when `pov_character` is set without an "
    "explicit `pov_after` / `pov_before` / `off_screen`, the scene "
    "appends to the current POV chain tail iff it's not already on "
    "the chain.\n\n"
    "Mutual exclusion: at most one of `pov_after`, `pov_before`, "
    "`off_screen=true` per call.\n\n"
    "── Time pin args ──\n\n"
    "  - `time_of_day` — string. Three tier forms accepted; resolver "
    "picks the tier from the shape:\n"
    "    • 'day' | 'night' (broad)\n"
    "    • One of 15 labelled vocab values (case-insensitive): "
    "Pre-Dawn, Dawn, Sunrise, Early Morning, Morning, Late Morning, "
    "Noon, Afternoon, Late Afternoon, Sunset, Evening, Dusk, "
    "Early Night, Night, Late Night / Midnight (send 'Late Night' or "
    "'Midnight')\n"
    "    • 'HH:MM' (24-hour, 00:00 to 23:59) — exact tier\n"
    "    null/empty clears all three tier fields.\n"
    "  - `weekday` — int 0-6 (0=Sunday..6=Saturday) or case-insensitive "
    "day name (Sunday..Saturday). null clears.\n"
    "  - `season` — int 0-5 OR case-insensitive name. Temperate set: "
    "0=Spring, 1=Summer, 2=Fall, 3=Winter (alias 'autumn' = Fall). "
    "Tropical set: 4=Wet, 5=Dry. Pick whichever cluster fits the "
    "story's setting — the modal renders both with a visual divider "
    "between them. null clears. Returns the canonical name string "
    "('Spring' / 'Summer' / 'Fall' / 'Winter' / 'Wet' / 'Dry').\n"
    "  - `date` — object `{ month?, day? }`. month accepts int 1-12 or "
    "case-insensitive name (January..December); day accepts int 1-31 "
    "(requires month). null / {} / undefined clears both date fields. "
    "Internally splits into `date_tier` + `date_month` + "
    "`date_day_of_month`. NOTE: weekday is its own top-level arg, not "
    "part of the date object.\n"
    "    Examples:\n"
    "      • `{ \"month\": \"June\" }` — month only (date_tier='month')\n"
    "      • `{ \"month\": 6, \"day\": 15 }` — month + day\n"
    "      • `{ \"month\": \"December\", \"day\": 25 }` — month + day\n"
    "  - `duration` — object describing the scene's in-story duration. "
    "Discriminated by `kind`:\n"
    "    • `{ kind: 'ambiguous' }` (or null) — unspecified\n"
    "    • `{ kind: 'minutes' | 'hours' | 'days', value?: number }` — "
    "numeric duration; value optional ('on the order of X')\n"
    "    • `{ kind: 'span', end_period: string }` — span ending at the "
    "named period\n"
    "    • `{ kind: 'all_day', all_day_variant?: string }` — single day\n"
    "    • `{ kind: 'all_period', period: string }` — entire labelled "
    "period (e.g. 'morning', 'afternoon')\n"
    "    Examples:\n"
    "      • `{ \"kind\": \"minutes\", \"value\": 30 }` — about 30 minutes\n"
    "      • `{ \"kind\": \"hours\", \"value\": 2 }` — about 2 hours\n"
    "      • `{ \"kind\": \"days\", \"value\": 3 }` — about 3 days\n"
    "      • `{ \"kind\": \"hours\" }` — \"hours\" (no specific count)\n"
    "      • `{ \"kind\": \"span\", \"end_period\": \"Sunset\" }` — runs "
    "until sunset\n"
    "      • `{ \"kind\": \"all_day\" }` — all day\n"
    "      • `{ \"kind\": \"all_period\", \"period\": \"morning\" }` — all "
    "morning\n"
    "      • `{ \"kind\": \"ambiguous\" }` — unspecified\n"
    "  - `gap` — TimeDelta `{ unit, value }`. unit one of 'minutes' / "
    "'hours' / 'days' / 'weeks'; value an integer. Writes to "
    "`gap_extension` — the writer's pinned relative offset added to "
    "the walker-computed Time-Since-Last-Scene floor. null clears.\n"
    "    Examples:\n"
    "      • `{ \"unit\": \"minutes\", \"value\": 15 }` — 15 minutes later\n"
    "      • `{ \"unit\": \"hours\", \"value\": 6 }` — 6 hours later\n"
    "      • `{ \"unit\": \"days\", \"value\": 3 }` — 3 days later\n"
    "      • `{ \"unit\": \"weeks\", \"value\": 2 }` — 2 weeks later\n"
    "  - `clear_pins` — list of pin names to explicitly clear. Use this "
    "when you want to unset one or more time pins (the JSON-null path "
    "for object-typed args is ambiguous over the MCP bridge — `clear_pins` "
    "is the explicit clearing surface). Accepted values: "
    "'time_of_day', 'weekday', 'season', 'date', 'duration', 'gap'. "
    "Combine freely with the set-args in the same call — clears apply "
    "first, then any set-arg in the same call overrides."
)


@mcp.tool(
    name="create_scene",
    description=(
        "Create a new scene node on the canvas. The scene starts "
        "with no participants, no POV, and no chapter membership. "
        "All metadata fields are optional — pass whatever you have "
        "and edit later via `update_scene`.\n\n"
        "Scene titles are UNIQUE within a project — passing a `title` "
        "that already belongs to another scene is rejected upfront so "
        "name-based references (e.g. `add_entity_to_scene(scene=...)`, "
        "`at=<title>` chain-write args) always resolve unambiguously. "
        "If the rejection error reports an existing id, use "
        "`update_scene(scene=<id>, ...)` to modify that scene, or pass "
        "a different `title` for the new one. Untitled scenes are "
        "fine — the uniqueness check skips empty / whitespace titles.\n\n"
        "Args (all optional except none):\n"
        "  - `title` — short label shown on the scene node header\n"
        "  - `description` — short summary text shown beneath the "
        "node title (read tools surface this as `summary`)\n"
        "  - `main_content` — the scene's prose as TipTap HTML "
        "(`<p>`, `<h1>`-`<h6>`, `<strong>`/`<em>`/`<u>`/`<s>`, lists, "
        "`<blockquote>`, `<code>`, `<mark>`, `<span style>`; NOT links "
        "or images). Empty string clears. Full tag whitelist: "
        "`get_tool_help('scene_fields')`.\n"
        "  - `is_flashback` — bool; when true, marks the scene as a "
        "flashback (appears in a distinct visual style, can carry a "
        "`parent_scene_id` link to the scene it's a flashback of)\n"
        "  - `parent_scene_id` — UUID of the parent scene if this is "
        "a flashback (only meaningful when `is_flashback=true`)\n"
        "  - `chapter`, `pov_character`, `pov_after`/`pov_before`, "
        "`off_screen` — structural / POV-chain placement args.\n"
        "  - `time_of_day` — string; broad ('day'/'night'), one of 15 "
        "labelled vocab values ('Morning', 'Late Afternoon', etc), or "
        "'HH:MM'.\n"
        "  - `weekday`, `season` — int or case-insensitive name.\n"
        "  - `date` — OBJECT `{ month?, day? }` (NOT a string). "
        "Example: `{\"month\": \"June\", \"day\": 15}`.\n"
        "  - `duration` — OBJECT discriminated by `kind` (NOT a string). "
        "Example: `{\"kind\": \"hours\", \"value\": 2}`; kind ∈ "
        "{ ambiguous, minutes, hours, days, span, all_day, all_period }.\n"
        "  - `gap` — OBJECT `{ unit, value }` (NOT a string). "
        "Example: `{\"unit\": \"days\", \"value\": 3}`. unit ∈ "
        "{ minutes, hours, days, weeks }, value is an integer.\n"
        "  - `clear_pins` — list of pin-name strings to clear.\n"
        "  Full placement semantics, the 15-value time-of-day vocab, the "
        "object schemas + more examples: `get_tool_help('scene_fields')`.\n\n"
        "Position is auto-assigned (viewport centre or random "
        "in-view fallback) — the AI doesn't need to pick canvas "
        "coordinates.\n\n"
        "Returns `{ id, title }` for the new scene plus any "
        "enhancement-arg fields actually applied (chapter_id / "
        "chapter_title / pov_entity_id / pov_placement / "
        "pov_placement_ref / pov_placement_tail). When the new scene "
        "lands on the POV chain, the return also carries `time: "
        "{ derived: { ... } }` (same shape as `get_scene.time."
        "derived`) so the AI sees the resulting chain-position "
        "context — gap to prior scene with time-modal phrasing, "
        "effective start slot, snap_forward flag. Requires an active "
        "MCP session. Non-destructive."
    ),
)
async def create_scene(
    title: Optional[str] = None,
    description: Optional[str] = None,
    main_content: Optional[str] = None,
    is_flashback: Optional[bool] = None,
    parent_scene_id: Optional[str] = None,
    chapter: Optional[str] = None,
    pov_character: Optional[str] = None,
    pov_after: Optional[str] = None,
    pov_before: Optional[str] = None,
    off_screen: Optional[bool] = None,
    time_of_day: Optional[str] = None,
    weekday: Optional[Union[int, str]] = None,
    season: Optional[Union[int, str]] = None,
    date: Optional[dict] = None,
    duration: Optional[dict] = None,
    gap: Optional[dict] = None,
    clear_pins: Optional[list[str]] = None,
) -> dict:
    args: dict[str, Any] = {}
    if title is not None: args["title"] = title
    if description is not None: args["description"] = description
    if main_content is not None: args["main_content"] = main_content
    if is_flashback is not None: args["is_flashback"] = is_flashback
    if parent_scene_id is not None: args["parent_scene_id"] = parent_scene_id
    if chapter is not None: args["chapter"] = chapter
    if pov_character is not None: args["pov_character"] = pov_character
    if pov_after is not None: args["pov_after"] = pov_after
    if pov_before is not None: args["pov_before"] = pov_before
    if off_screen is not None: args["off_screen"] = off_screen
    if time_of_day is not None: args["time_of_day"] = time_of_day
    if weekday is not None: args["weekday"] = weekday
    if season is not None: args["season"] = season
    if date is not None: args["date"] = date
    if duration is not None: args["duration"] = duration
    if gap is not None: args["gap"] = gap
    if clear_pins is not None: args["clear_pins"] = clear_pins
    return await _proxy_write_tool("create_scene", args)


@mcp.tool(
    name="update_scene",
    description=(
        "Update an existing scene's metadata. The `scene` arg "
        "accepts UUID or exact (case-insensitive) title. Pass only "
        "the fields you want to change — every other field is "
        "preserved.\n\n"
        "Scene titles are UNIQUE within a project — renaming a scene "
        "to a `title` that already belongs to another scene is "
        "rejected upfront. Re-using the scene's own current title is "
        "a no-op (not a collision).\n\n"
        "Updateable fields (all optional):\n"
        "  - `title` — scene title\n"
        "  - `description` — short summary text\n"
        "  - `main_content` — TipTap HTML (tag whitelist via "
        "`get_tool_help('scene_fields')`); empty string clears. "
        "Overwrites the scene's existing content entirely (not a "
        "diff / append).\n"
        "  - `is_flashback` — bool flag\n"
        "  - `parent_scene_id` — UUID of the parent scene for "
        "flashback links\n\n"
        "  - `chapter`, `pov_character` / `pov_after` / `pov_before` / "
        "`off_screen` (POV-chain placement), plus the time-pin args "
        "(`time_of_day`, `weekday`, `season`, `date`, `duration`, "
        "`gap`, `clear_pins`) — same shapes as create_scene; full "
        "reference via `get_tool_help('scene_fields')`.\n\n"
        "NOT updateable here: scene id (immutable) and scene "
        "participants (use `add_entity_to_scene` / "
        "`remove_entity_from_scene`).\n\n"
        "Returns the updated scene's projected shape plus any "
        "enhancement-arg fields actually applied. When the scene is "
        "on the POV chain after the update, the return also carries "
        "`time: { derived: { ... } }` (same shape as `get_scene.time."
        "derived`) so the AI sees the resulting chain-position "
        "context — gap to prior scene with time-modal phrasing, "
        "effective start slot, snap_forward flag. Useful for "
        "verifying that a time-pin / POV-placement change landed "
        "where expected without a follow-up get_scene call. Requires "
        "an active MCP session. Non-destructive."
    ),
)
async def update_scene(
    scene: str,
    title: Optional[str] = None,
    description: Optional[str] = None,
    main_content: Optional[str] = None,
    is_flashback: Optional[bool] = None,
    parent_scene_id: Optional[str] = None,
    chapter: Optional[str] = None,
    pov_character: Optional[str] = None,
    pov_after: Optional[str] = None,
    pov_before: Optional[str] = None,
    off_screen: Optional[bool] = None,
    time_of_day: Optional[str] = None,
    weekday: Optional[Union[int, str]] = None,
    season: Optional[Union[int, str]] = None,
    date: Optional[dict] = None,
    duration: Optional[dict] = None,
    gap: Optional[dict] = None,
    clear_pins: Optional[list[str]] = None,
) -> dict:
    args: dict[str, Any] = {"scene": scene}
    if title is not None: args["title"] = title
    if description is not None: args["description"] = description
    if main_content is not None: args["main_content"] = main_content
    if is_flashback is not None: args["is_flashback"] = is_flashback
    if parent_scene_id is not None: args["parent_scene_id"] = parent_scene_id
    if chapter is not None: args["chapter"] = chapter
    if pov_character is not None: args["pov_character"] = pov_character
    if pov_after is not None: args["pov_after"] = pov_after
    if pov_before is not None: args["pov_before"] = pov_before
    if off_screen is not None: args["off_screen"] = off_screen
    if time_of_day is not None: args["time_of_day"] = time_of_day
    if weekday is not None: args["weekday"] = weekday
    if season is not None: args["season"] = season
    if date is not None: args["date"] = date
    if duration is not None: args["duration"] = duration
    if gap is not None: args["gap"] = gap
    if clear_pins is not None: args["clear_pins"] = clear_pins
    return await _proxy_write_tool("update_scene", args)


@mcp.tool(
    name="delete_scene",
    description=(
        "Delete a scene from the project. The `scene` arg accepts "
        "UUID or exact (case-insensitive) title.\n\n"
        "DESTRUCTIVE — this routes through the project's "
        "deleteObject('node', sceneId) dispatcher and CANNOT be "
        "undone via the MCP API. Removes the scene node, every "
        "entity participation on it (entity baselines and their "
        "origin EntityNodes survive — only the scene-anchored "
        "presence at this scene goes away), every connection wire "
        "to/from this scene, every scene-anchored change recorded "
        "at this scene (downstream resolves no longer see them), "
        "and chapter membership.\n\n"
        "Use only when the user has explicitly asked you to remove a "
        "scene, not as a 'redo' shortcut for a misnamed scene (use "
        "`update_scene` for renames).\n\n"
        "Requires both an active MCP session AND a per-action "
        "approval from the user (modal pops with three options). "
        "Returns `{ id, title }` of the deleted scene on success."
    ),
)
async def delete_scene(scene: str) -> dict:
    return await _proxy_destructive_tool(
        "delete_scene",
        {"scene": scene},
        action="delete",
        object_type="scene",
        object_name=scene,
        detail=(
            "Removes the scene node, every entity participation "
            "anchored on it, every connection wire to/from it, every "
            "scene-anchored change recorded at this scene, and "
            "chapter membership. Entity baselines and their origin "
            "nodes survive — only the scene-anchored material on "
            "THIS scene is stripped. Cannot be undone via MCP."
        ),
    )


# ── POV + entity-presence tools ──────────────────────────────────────


@mcp.tool(
    name="set_pov",
    description=(
        "Set or clear the POV-carrying character at a scene, AND "
        "ensure the scene is on the POV chain. Both args accept UUID "
        "or exact name/title. The `character` arg is optional — omit "
        "it (or pass null) to CLEAR POV from the scene entirely (also "
        "strips POV wires to/from this scene). When set, only one "
        "character can carry POV per scene at a time; setting a new "
        "one replaces any previous POV attachment.\n\n"
        "── POV CHAIN MODEL ──\n\n"
        "NarrativeNode tracks scenes along a POV chain — a linear "
        "ordered sequence of scenes, walked forward from a POV Origin "
        "Node via POV-typed wires. A scene is `on_pov_path` only if a "
        "POV wire reaches it from the origin. Setting `pov_entity_id` "
        "by itself is NOT enough — the wire is what puts the scene on "
        "the chain.\n\n"
        "This tool handles both: setting `pov_entity_id` AND "
        "appending the scene to the POV chain tail if it isn't "
        "already on the chain (idempotent — re-calling on a scene "
        "already on the chain doesn't re-wire). For non-default "
        "placement (insert before / after another scene, or off-"
        "screen), use `update_scene` with `pov_after` / `pov_before` "
        "/ `off_screen` — set_pov keeps its narrow scope of set + "
        "default-append.\n\n"
        "Args:\n"
        "  - `scene` — required, the target scene\n"
        "  - `character` — optional; UUID or exact name/alias of a "
        "CHARACTER entity (other types rejected). When omitted or "
        "null, clears POV from the scene (off-chain).\n\n"
        "If the character isn't already in the scene, this tool "
        "AUTO-ADDS them first (same skip-upstream-confirm behaviour "
        "as update_entity's scene path).\n\n"
        "Returns `{ scene_id, pov_entity_id }` reflecting the "
        "post-update state. When the scene was newly added to the "
        "POV chain on this call, the return also carries "
        "`pov_placement: 'append'` and `pov_placement_tail` (the id "
        "of the chain tail the scene attached to, or null when the "
        "scene became the chain's first member). When the scene is "
        "on the POV chain after the call (POV set, not cleared), the "
        "return additionally carries `time: { derived: { ... } }` "
        "(same shape as `get_scene.time.derived`) so the AI sees the "
        "resulting chain-position context — gap to prior scene with "
        "time-modal phrasing ('3 hours later' / 'the next day' / "
        "'right after'), effective start slot, snap_forward flag. "
        "Clearing POV (character=null) takes the scene off-chain "
        "and omits the time block. Requires an active MCP session. "
        "Non-destructive."
    ),
)
async def set_pov(scene: str, character: Optional[str] = None) -> dict:
    args: dict[str, Any] = {"scene": scene}
    if character is not None: args["character"] = character
    return await _proxy_write_tool("set_pov", args)


@mcp.tool(
    name="add_entity_to_scene",
    description=(
        "Add one or more entities to a scene as participants, WITHOUT "
        "recording any scene-anchored changes. Use this when entities "
        "should be marked as 'present' at the scene without further "
        "modification. Idempotent per entity — if an entity is already "
        "in the scene, that item is a no-op (and `already_in_scene: "
        "true` is returned for it).\n\n"
        "Auto-wiring: each fresh chip is wired into its entity's "
        "narrative chain automatically — from the entity's most recent "
        "prior appearance (if any), or from the entity's origin "
        "EntityNode if this is the entity's first appearance. Cycle-"
        "safeguarded: if wiring would form a loop in the entity's "
        "chain (rare), the tool errors with a suggested correction. "
        "Ambiguous upstream (multiple equidistant candidates) errors "
        "cleanly AND rolls the chip back so the scene returns to its "
        "pre-call state — no orphan chips. Recover from the ambiguous "
        "case by retrying with the per-item `predecessor` field "
        "naming the upstream scene explicitly (see below).\n\n"
        "If you also want to record a scene-anchored change at the "
        "same time (e.g. name / colour / description change at this "
        "scene for one of these entities), use `update_entity(entity, "
        "..., at=<scene>)` instead — that tool adds the entity to the "
        "scene AND records the change in one call (auto-wire runs "
        "there too).\n\n"
        "Args:\n"
        "  scene — required, UUID or exact title of the target scene.\n"
        "  entities — required, non-empty list of entity references. "
        "Each item is EITHER a bare string (UUID OR exact case-"
        "insensitive name / alias) OR an object "
        "`{ entity: <ref>, predecessor?: <scene ref> }` where "
        "`predecessor` explicitly names the prior scene the auto-"
        "wire should chain from. Use the object form when an earlier "
        "call errored with 'auto-wire upstream search ambiguous' — "
        "the predecessor short-circuits the ambiguous search. The "
        "named predecessor must already have a chip for this entity. "
        "For a single entity pass a one-element list: "
        "`entities=['Mira']` or "
        "`entities=[{entity:'Mira', predecessor:'Scene 3'}]`. All "
        "refs pre-resolved upfront — a bad ref errors with "
        "`entities[N]: ...` attribution before ANY chips are added.\n\n"
        "Returns `{ scene_id, entities: [ { entity_id, "
        "already_in_scene: bool, auto_wired?: { source_node_id, "
        "from_origin: bool, from_predecessor?: bool } }, ... ] }` — "
        "one entry per input ref in order. `auto_wired` is omitted "
        "for items where the entity was already in the scene; "
        "`from_predecessor` is set when the wire was routed through "
        "an explicit `predecessor` arg. Per-item rollback on auto-"
        "wire failure: items before the failing one stay added; the "
        "failing item's chip is rolled back; the error message names "
        "the recovery path. Requires an active MCP session. Non-"
        "destructive."
    ),
)
async def add_entity_to_scene(
    scene: str,
    entities: list[Any],
) -> dict:
    return await _proxy_write_tool(
        "add_entity_to_scene",
        {"scene": scene, "entities": entities},
    )


@mcp.tool(
    name="populate_scene",
    description=(
        "Compound setup: create a scene AND add its participants AND set "
        "its POV in ONE call, instead of a create_scene + N add_entity_to_"
        "scene + set_pov sequence. Use it when you know the scene's cast "
        "up front (the common case when drafting a new scene) , it "
        "collapses a whole dependent sequence into a single tool call.\n\n"
        "Best-effort, NOT all-or-nothing: the scene is created first, then "
        "each entity is added on its OWN. Everything that succeeds is "
        "kept; anything that fails is reported per-item with that "
        "operation's specific error (a misspelled / non-existent / "
        "ambiguous entity name, a wiring ambiguity, etc.), so you re-issue "
        "ONLY the failed items rather than redoing the whole scene. A bad "
        "entity reference does NOT discard the scene or the entities that "
        "did land.\n\n"
        "Args:\n"
        "  title / description / main_content — the scene fields (same as "
        "`create_scene`; `main_content` is TipTap HTML, usually left empty "
        "at plot-planning time).\n"
        "  entities — list of entity references (UUID or exact name), any "
        "type (characters / locations / items / factions / customs); each "
        "is added + auto-wired independently.\n"
        "  pov_character — character UUID or exact name to set as POV "
        "(added + wired automatically; must be a character). Passed into "
        "the create step, so an invalid POV fails scene creation as a "
        "whole (a single value you can correct and retry).\n"
        "  pov_after / pov_before / chapter — POV-chain placement and "
        "chapter assignment, same semantics as `create_scene`.\n\n"
        "Returns `{ scene, pov, added: [refs], failed: [{ entity, error }] }`: "
        "`scene` is the created scene, `added` the entities that landed, "
        "`failed` each entity that errored paired with its message. If "
        "scene creation itself fails, that specific error is raised "
        "directly (there is nothing to populate). Requires an active MCP "
        "session."
    ),
)
async def populate_scene(
    title: Optional[str] = None,
    description: Optional[str] = None,
    main_content: Optional[str] = None,
    entities: Optional[list[Any]] = None,
    pov_character: Optional[str] = None,
    pov_after: Optional[str] = None,
    pov_before: Optional[str] = None,
    chapter: Optional[str] = None,
) -> dict:
    # Step 1: create the scene (with POV + placement). A failure here is
    # fatal to the whole op (there is no scene to populate), so let the
    # specific create_scene error propagate to the caller.
    scene_result = await create_scene(
        title=title,
        description=description,
        main_content=main_content,
        pov_character=pov_character,
        pov_after=pov_after,
        pov_before=pov_before,
        chapter=chapter,
    )
    # Resolve a stable scene ref for the participant adds. Scene titles are
    # unique, so `title` is a reliable ref; prefer an id from the result
    # when present (covers a title-less scene).
    scene_ref = None
    if isinstance(scene_result, dict):
        scene_ref = (
            scene_result.get("id")
            or scene_result.get("scene_id")
            or scene_result.get("node_id")
        )
        inner = scene_result.get("scene")
        if not scene_ref and isinstance(inner, dict):
            scene_ref = inner.get("id") or inner.get("node_id")
    scene_ref = scene_ref or title

    # Step 2: add each participant INDEPENDENTLY so one bad reference does
    # not sink the rest. Keep successes, collect per-item failures with the
    # sub-tool's own error string.
    added: list[Any] = []
    failed: list[dict] = []
    for ent in (entities or []):
        if scene_ref is None:
            failed.append({
                "entity": ent,
                "error": "[no_scene_ref] scene created but no id/title was "
                         "available to add participants to; add them with "
                         "add_entity_to_scene once you have the scene id.",
            })
            continue
        try:
            await add_entity_to_scene(scene=scene_ref, entities=[ent])
            added.append(ent)
        except Exception as exc:  # noqa: BLE001
            failed.append({"entity": ent, "error": str(exc)})

    return {
        "scene": scene_result,
        "pov": pov_character,
        "added": added,
        "failed": failed,
    }


@mcp.tool(
    name="remove_entity_from_scene",
    description=(
        "Remove an entity from a scene. Both args accept UUID or "
        "exact name/title.\n\n"
        "REMOVE not DELETE — the entity itself survives intact "
        "(baseline + origin node + presence in every OTHER scene "
        "stay). Only the entity's presence at THIS one scene goes "
        "away, along with any scene-anchored changes recorded for "
        "this entity at this scene (name / colour / description "
        "changes, attribute add/modify/remove, etc., for this scene "
        "only) and any temporary circumstances / motivators attached "
        "to the entity at this scene. POV attachment to this entity "
        "on this scene is also cleared.\n\n"
        "Auto-stitch: if this scene was a mid-"
        "chain stop for the entity (had both an incoming flow wire "
        "from a prior appearance AND an outgoing flow wire to a "
        "subsequent appearance), the entity's chain is automatically "
        "stitched forward — a new wire from the upstream source "
        "directly to the downstream target replaces the removed "
        "two-wire segment. Single-side scenarios (only incoming OR "
        "only outgoing) leave the surviving end as a chain terminus, "
        "no stitch needed. Cycle-safeguarded: if stitching would form "
        "a loop, the tool errors with a clear message (the chip has "
        "already been removed at that point; re-wire manually if a "
        "different stitch is wanted).\n\n"
        "Per the project's DELETE-vs-REMOVE distinction, this is a "
        "context-scoped REMOVE (the entity remains a first-class "
        "object), NOT a DELETE — so no destructive-approval modal "
        "fires. Use `delete_entity` to remove the entity from the "
        "entire project.\n\n"
        "Returns `{ scene_id, entity_id }`. Errors if the entity "
        "is not currently in the scene. Requires an active MCP "
        "session."
    ),
)
async def remove_entity_from_scene(scene: str, entity: str) -> dict:
    return await _proxy_write_tool(
        "remove_entity_from_scene",
        {"scene": scene, "entity": entity},
    )


# ── Relationship write tools ─────────────────────────────────────────


@mcp.tool(
    name="create_relationship",
    description=(
        "Create a new relationship. The optional `scene` arg "
        "controls where the relationship's origin lives:\n\n"
        "  - If `scene` is provided (UUID or exact title), the "
        "relationship's origin anchors at that scene; from there "
        "forward it is 'alive' on the timeline.\n"
        "  - If `scene` is omitted, a fresh relationship origin "
        "node is placed on the canvas and the relationship anchors "
        "there (no scene attachment).\n\n"
        "Faction-membership relationships are NOT created with this "
        "tool — they are auto-created as a side effect of "
        "`create_entity(type='faction')`.\n\n"
        "Args:\n"
        "  - `scene` — optional (UUID or exact title); see above.\n"
        "  - `name` — optional human-readable label. Unnamed "
        "relationships are still valid; the UI falls back to a "
        "participant-list label.\n"
        "  - `description` — optional baseline description.\n"
        "  - `participants` — optional array. Each item is EITHER an "
        "entity reference (UUID or exact name/alias) OR an object "
        "`{ entity, role? }` (use `entity` for the ref; an inline "
        "`role` sets that participant's role). When `scene` is given, "
        "each participant gets a `join` entry at that scene; otherwise "
        "participants are baseline.\n"
        "  - `roles` — optional object mapping a participant's entity "
        "reference (same refs as in `participants`) to a role string. "
        "Alternative to an inline `role` on a participant object.\n"
        "  - `hierarchy` — optional. Omit / null for a flat "
        "relationship (the common case). A structured hierarchy is a "
        "config object set up in the app, not a string; roles go in "
        "`roles` / per-participant `role`, not here.\n"
        "  - `awareness_scale` — optional, one of 'binary' (yes/no) "
        "or 'full' (4-level alias scale). Defaults to 'binary'.\n"
        "  - `force` — optional bool. A new relationship whose "
        "participant set EXACTLY matches an existing relationship's is "
        "REJECTED by default (the near-always-correct move is to update "
        "the existing one, not duplicate it). Pass `force=true` only to "
        "deliberately create a second, distinct relationship between the "
        "same participants.\n\n"
        "To CHANGE an existing relationship at a later scene (roles, "
        "status, participants, name, hierarchy, description) use "
        "`update_relationship` / `add_participants` / `set_participant` "
        "with `at=<scene>` — a chain change on the SAME relationship. Do "
        "NOT create a second relationship for the same participants; that "
        "is rejected unless you pass `force=true`.\n\n"
        "Returns `{ id, name, scene_id, origin_node_id, "
        "participant_ids }` for the new relationship. "
        "Requires an active MCP session. Non-destructive."
    ),
)
async def create_relationship(
    scene: Optional[str] = None,
    name: Optional[str] = None,
    description: Optional[str] = None,
    # `participants` items are entity-ref strings OR `{entity, role?}` objects,
    # and `hierarchy` may arrive as a string the frontend maps — typed loosely
    # so the MCP gate doesn't reject the intuitive shapes the model builds.
    participants: Optional[list] = None,
    roles: Optional[dict] = None,
    hierarchy: Optional[Any] = None,
    awareness_scale: Optional[AwarenessScale] = None,
    force: Optional[bool] = None,
) -> dict:
    args: dict[str, Any] = {}
    if scene is not None: args["scene"] = scene
    if name is not None: args["name"] = name
    if description is not None: args["description"] = description
    if participants is not None: args["participants"] = participants
    if roles is not None: args["roles"] = roles
    if hierarchy is not None: args["hierarchy"] = hierarchy
    if awareness_scale is not None: args["awareness_scale"] = awareness_scale
    if force is not None: args["force"] = force
    return await _proxy_write_tool("create_relationship", args)


@mcp.tool(
    name="delete_relationship",
    description=(
        "Delete a relationship from the project. The "
        "`relationship` arg accepts UUID or exact (case-insensitive) "
        "name.\n\n"
        "DESTRUCTIVE — routes through deleteObject('relationship', "
        "id). The relationship object, all its history (existence / "
        "participant / perception / alias / role / hierarchy / name "
        "/ description changes), every relationship indicator on "
        "every scene, and any wires associated with the relationship "
        "are stripped. Cannot be undone via MCP. Use only when the "
        "user has explicitly asked to remove the relationship.\n\n"
        "Requires both an active MCP session AND a per-action "
        "destructive approval from the user. Returns "
        "`{ id, name }` of the deleted relationship on success."
    ),
)
async def delete_relationship(relationship: str) -> dict:
    return await _proxy_destructive_tool(
        "delete_relationship",
        {"relationship": relationship},
        action="delete",
        object_type="relationship",
        object_name=relationship,
        detail=(
            "Removes the relationship object, all its scene-anchored history "
            "(participant joins/leaves, perceptions, aliases, roles, "
            "hierarchy, name, description, existence changes), every "
            "indicator on every scene, and any associated wires. "
            "Cannot be undone via MCP."
        ),
    )


@mcp.tool(
    name="update_relationship",
    description=(
        "Update a relationship's fields, EITHER at the relationship's "
        "origin (baseline) OR at a specific scene (chain change). "
        "`relationship` accepts UUID or exact (case-insensitive) name. "
        "Pass only the fields you want to change.\n\n"
        "`at` arg:\n"
        "  - omitted / null / 'origin' → BASELINE write.\n"
        "  - scene UUID or exact title → records a change at that "
        "scene that propagates forward.\n\n"
        "Fields at ORIGIN: name, description, hierarchy, membership_of, "
        "awareness_scale.\n\n"
        "Fields AT A SCENE: name, description, hierarchy, `status`. "
        "NOT at scene: membership_of, awareness_scale.\n\n"
        "`status` (scene path only): 'active' / 'ended'. Marks the "
        "relationship as ended at a specific scene without deleting "
        "it (matches the scene's 'End relationship here' button) or "
        "brings it back at a later scene. Same-scene pair-cancel: "
        "writing 'active' at a scene where 'ended' already exists "
        "STRIPS the ended event (revert), and vice versa. Same-value "
        "duplicate at the same scene is a no-op.\n\n"
        "For per-participant scalars (perception, role, alias-override), "
        "use the dedicated participant scalar tools.\n\n"
        "Returns the relationship at the resolved anchor. Requires an "
        "active MCP session. Non-destructive."
        + _help_pointer("knowledge_tracking", "knowledge-tracking arg (tie this change to a Knowledge object)")
    ),
)
async def update_relationship(
    relationship: str,
    name: Optional[str] = None,
    description: Optional[str] = None,
    hierarchy: Optional[str] = None,
    membership_of: Optional[str] = None,
    awareness_scale: Optional[AwarenessScale] = None,
    status: Optional[RelationshipStatus] = None,
    at: Optional[str] = None,
    track_as_knowledge: Optional[Any] = None,
) -> dict:
    args: dict[str, Any] = {"relationship": relationship}
    if name is not None: args["name"] = name
    if description is not None: args["description"] = description
    if hierarchy is not None: args["hierarchy"] = hierarchy
    if membership_of is not None: args["membership_of"] = membership_of
    if awareness_scale is not None: args["awareness_scale"] = awareness_scale
    if status is not None: args["status"] = status
    if at is not None: args["at"] = at
    if track_as_knowledge is not None: args["track_as_knowledge"] = track_as_knowledge
    return await _proxy_write_tool("update_relationship", args)


# Singular `add_participant` retired in v0.2.1.156 — `add_participants`
# is the canonical add tool (pass a one-element list for the single case).


@mcp.tool(
    name="add_participants",
    description=(
        "Add one or more participants to a relationship in one call, "
        "EITHER at the relationship's origin (baseline join) OR at a "
        "specific scene (scene-anchored join). All items in the batch "
        "share the same `at` + `track_as_knowledge`. Pass a one-element "
        "list `[{entity: '...'}]` for the single-participant case — "
        "this is the only `add` tool for participants; there is no "
        "singular variant.\n\n"
        "Args:\n"
        "  relationship — required, UUID or exact name of the target "
        "relationship.\n"
        "  participants — required, non-empty list of "
        "`{ entity, role? }` objects. `entity` is a UUID or exact "
        "name/alias; `role` is an optional string label (applied to "
        "baseline `participant_roles`). Pre-validated upfront — bad "
        "ref or item shape errors with `participants[N]: ...` "
        "attribution before any join entries land.\n"
        "  at — optional anchor (see below). Applies to every item.\n"
        "  track_as_knowledge — optional. Single-anchor rule: "
        "requires the batch to produce EXACTLY ONE chain entry "
        "(i.e. exactly one participant). Multi-item batches with "
        "track_as_knowledge reject cleanly.\n\n"
        "`at` semantics:\n"
        "  - omitted / null / 'origin' → BASELINE joins. Records "
        "`join@<origin>` entries at the relationship's origin node. "
        "The participants are treated as having always been part of "
        "the relationship from its inception.\n"
        "  - scene UUID or exact title → SCENE-anchored joins. "
        "Records `join@<scene>` entries. The scene resolver reads "
        "this as 'the entities joined the relationship from this "
        "scene forward'.\n\n"
        "Same-node opposite pair cancellation: if a `leave` event "
        "already exists at the same node for one of these entities, "
        "the join+leave pair cancels for that entity (per the "
        "normalised-history invariant). Idempotent: a "
        "duplicate join at the same node is a no-op.\n\n"
        "Returns `{ relationship_id, scene_id?, origin_node_id, "
        "participants: [{entity_id}], participant_ids_ever }`. "
        "Requires an active MCP session. Non-destructive."
        + _help_pointer("knowledge_tracking", "knowledge-tracking arg (tie this change to a Knowledge object)")
    ),
)
async def add_participants(
    relationship: str,
    participants: list[dict],
    at: Optional[str] = None,
    track_as_knowledge: Optional[Any] = None,
) -> dict:
    args: dict[str, Any] = {
        "relationship": relationship,
        "participants": participants,
    }
    if at is not None: args["at"] = at
    if track_as_knowledge is not None: args["track_as_knowledge"] = track_as_knowledge
    return await _proxy_write_tool("add_participants", args)


@mcp.tool(
    name="remove_participants",
    description=(
        "Remove one or more participants from a relationship in one "
        "call. Pass a one-element list for the single-participant "
        "case — this is the only `remove` tool for participants; "
        "there is no singular variant. All items share the batch-"
        "level `at` + `track_as_knowledge`.\n\n"
        "Args:\n"
        "  relationship — required, UUID or exact name.\n"
        "  participants — required, non-empty list of entity refs "
        "(UUID or exact name/alias). Pre-resolved upfront with "
        "`participants[N]: ...` attribution on bad refs.\n"
        "  at — optional anchor:\n"
        "    • omitted / null / 'origin' → BASELINE removals. Strips "
        "each participant's `join@<origin>` entry; if an entity has "
        "no remaining joins anywhere, also drops its "
        "`participant_roles` entry (mirror-strip rule).\n"
        "    • scene UUID or exact title → SCENE-anchored leaves. "
        "Records `leave@<scene>` entries.\n"
        "  track_as_knowledge — optional. Single-anchor rule: "
        "requires the batch to produce exactly ONE chain entry; "
        "multi-item batches with track_as_knowledge reject cleanly.\n\n"
        "Per the DELETE-vs-REMOVE distinction, this is "
        "REMOVE (context-scoped) NOT DELETE — entities and the "
        "relationship survive; only memberships are affected. NO "
        "destructive-approval modal fires.\n\n"
        "Same-node opposite pair cancellation applies per item: if "
        "a `join` event already exists at the same node, BOTH "
        "entries are stripped. If the relationship's effective "
        "participant count drops to zero mid-batch, the relationship "
        "cascades through `deleteObject('relationship', id)`; "
        "remaining items in the batch report as `skipped` with the "
        "cascade reason. Response carries `cascaded: true` + "
        "`cascade_after_index` when this happens.\n\n"
        "Returns `{ relationship_id, participants: [...], cascaded, "
        "... }`. Requires an active MCP session."
        + _help_pointer("knowledge_tracking", "knowledge-tracking arg (tie this change to a Knowledge object)")
    ),
)
async def remove_participants(
    relationship: str,
    participants: list[str],
    at: Optional[str] = None,
    track_as_knowledge: Optional[Any] = None,
) -> dict:
    args: dict[str, Any] = {
        "relationship": relationship,
        "participants": participants,
    }
    if at is not None: args["at"] = at
    if track_as_knowledge is not None: args["track_as_knowledge"] = track_as_knowledge
    return await _proxy_write_tool("remove_participants", args)


@mcp.tool(
    name="set_participant",
    description=(
        "Set one or more of a participant's per-relationship fields "
        "(role / perception / alias_override) in a single call. Pass "
        "whichever field(s) you want to change; omitted fields are "
        "untouched.\n\n"
        "Replaces the three retired singulars `set_participant_role` "
        "/ `set_participant_perception` / `set_participant_alias` — "
        "this one consolidated tool covers all three.\n\n"
        "Per-field semantics:\n"
        "  - `role` — string label (e.g. 'Husband', 'Lieutenant', "
        "'Member'). Pass empty string or `null` to clear. Origin "
        "writes go to the relationship's baseline `participant_roles` "
        "map; scene writes record a `role_changes` entry at (entity, "
        "scene) with per-entity-per-scene upsert.\n"
        "  - `perception` — the participant's own subjective view of "
        "the relationship (e.g. 'sees this as a friendship' vs 'sees "
        "this as a transactional alliance'). Pass empty string to "
        "clear. Origin writes update `initial_perception` on EVERY "
        "join entry for this entity (requires the entity to be a "
        "participant — use `add_participants` first). Scene writes "
        "record a `perception_changes` entry at (entity, scene) with "
        "per-entity-per-scene upsert.\n"
        "  - `alias_override` — a relationship-scoped name the "
        "participant goes by INSIDE this relationship (e.g. 'Husband' "
        "to his wife). Pass empty string or null to clear (falls back "
        "to canonical name). Origin writes update "
        "`initial_alias_override` on every join entry; scene writes "
        "record an `alias_changes` entry with per-entity-per-scene "
        "upsert.\n\n"
        "`at` semantics:\n"
        "  - omitted / null / 'origin' → BASELINE writes (one per "
        "supplied field).\n"
        "  - scene UUID or exact title → SCENE-anchored chain entries "
        "(one per supplied field).\n\n"
        "Args:\n"
        "  relationship — required, UUID or exact name.\n"
        "  entity — required, the participant (UUID or exact name/alias).\n"
        "  role — optional, see above.\n"
        "  perception — optional, see above.\n"
        "  alias_override — optional, see above.\n"
        "  at — optional anchor.\n"
        "  track_as_knowledge — optional. Single-anchor rule: "
        "requires exactly ONE chain entry per call (i.e. exactly one "
        "supplied field at a scene anchor). Multi-field calls with "
        "track_as_knowledge reject cleanly.\n\n"
        "At least one of role / perception / alias_override is "
        "required. Returns `{ relationship_id, entity_id, scene_id?, "
        "origin_node_id, role?, perception?, alias_override?, "
        "tracking_knowledge_id? }` — the response echoes back only "
        "the fields you supplied. Requires an active MCP session. "
        "Non-destructive."
        + _help_pointer("knowledge_tracking", "knowledge-tracking arg (tie this change to a Knowledge object)")
    ),
)
async def set_participant(
    relationship: str,
    entity: str,
    role: Optional[str] = None,
    perception: Optional[str] = None,
    alias_override: Optional[str] = None,
    at: Optional[str] = None,
    track_as_knowledge: Optional[Any] = None,
) -> dict:
    args: dict[str, Any] = {
        "relationship": relationship,
        "entity": entity,
    }
    # Pass through "field present" intent. Use a sentinel-aware approach:
    # if the caller didn't supply the kwarg, FastMCP doesn't pass it
    # (so it stays None here); supplied None / empty string should
    # forward as the explicit clear signal. To distinguish "omitted"
    # from "explicit None", we forward only when the kwarg is not the
    # default — which we approximate by forwarding when the value is
    # not None OR when it's None but the caller meant clear (we can't
    # tell from the signature alone). Pragmatic compromise: forward
    # only non-None values; callers wanting to CLEAR should pass empty
    # string "" instead of null, which forwards through as ''.
    if role is not None: args["role"] = role
    if perception is not None: args["perception"] = perception
    if alias_override is not None: args["alias_override"] = alias_override
    if at is not None: args["at"] = at
    if track_as_knowledge is not None: args["track_as_knowledge"] = track_as_knowledge
    return await _proxy_write_tool("set_participant", args)


# ── Awareness setters for non-Knowledge hosts (audit verdict) ────────
#
# Four goal-level tools exposing awareness writes for the four host
# kinds that previously had no MCP affordance (only Knowledge awareness
# was reachable via setKnowledgeAwarenessOrigin / setKnowledgeAwarenessAtNode
# store actions). Each tool wraps the canonical `commitAwarenessAtAnchor`
# store action — the same path the awareness panel UIs use.


_AWARENESS_DOC_TAIL = (
    "\n\n"
    "── Awareness model ──\n\n"
    "Awareness is a chain-tracked second-class object attached to its "
    "host (entity / attribute / alias / relationship / knowledge). Each "
    "entry maps an observer entity to a level. The host's "
    "`awareness_scale` setting decides the granularity: 'full' uses all "
    "four levels (Unaware / Nominally / Partially / Fully); 'binary' "
    "uses just two endpoints (Unaware / Fully, also accepted as 'Aware').\n\n"
    "`level` accepts (case-insensitive):\n"
    "  - String names (preferred form, matches the UI labels): "
    "'Fully' / 'Fully Aware' / 'Aware', 'Partially' / 'Partially "
    "Aware', 'Nominally' / 'Nominally Aware', or 'Unaware'.\n"
    "  - Integers 0-3 (raw form): 0=Unaware, 1=Nominally, 2=Partially, "
    "3=Fully. Binary scale uses {0, 3} only — 1 and 2 on a binary "
    "target are coerced or rejected downstream.\n"
    "  - `null` to clear the observer's entry (remove them from the "
    "awareness wrapper).\n\n"
    "`at` controls the anchor:\n"
    "  - omitted / null / 'origin' → BASELINE write. The observer's "
    "level is set on the host's baseline awareness wrapper.\n"
    "  - scene UUID / title → SCENE-ANCHORED chain write. Appends a "
    "history entry to the awareness object's own chain (separate from "
    "the host's chain). The walker resolves the observer's level at a "
    "given scene by reading the last entry on or before that scene.\n\n"
    "── `sources` arg: group projections ──\n\n"
    "Alongside `entries` (per-observer direct pins), each setter "
    "accepts an optional `sources` list that mutates awareness "
    "PROJECTIONS from a relationship. A projection says \"every member "
    "of <relationship>, resolved at the chain anchor, inherits this "
    "level on this target.\" The chain walker resolves membership "
    "at read time, so new members joining the relationship automatically "
    "inherit at downstream anchors, and members leaving stop inheriting. "
    "Direct entries always override projections for the same observer.\n\n"
    "The canonical use case is faction-style group awareness: every "
    "faction has an auto-created \"<Faction Name> Members\" "
    "relationship; passing that as a source projects one level to "
    "every current member in one call. Per-item shape: "
    "`{ action, source_kind?, source, level?, at? }` where action is "
    "'add' | 'remove' | 'set_level', source_kind defaults to "
    "'relationship' (the only kind exposed via MCP), source is a "
    "relationship UUID or name, level is required for add / set_level "
    "and uses the same format as entries[].level, and at uses the "
    "same anchor semantics as entries[].at. Setters with per-target "
    "context (attribute / alias) require the matching context field "
    "on each source item (e.g. `{ attribute, action, source, level, "
    "at }` on set_attribute_awareness).\n\n"
    "Pass `entries`, `sources`, or both. At least one must be non-"
    "empty.\n\n"
    "Returns include `level` (the int 0-3 that was committed) and "
    "`level_name` (the self-describing label — e.g. `2` → `\"Partially "
    "Aware\"`) so the response is readable without remembering the "
    "int mapping. Plus host-specific identifiers and `scene_id` on "
    "scene-anchored writes. The response carries both `entries: [...]` "
    "and `sources: [...]` arrays (each empty when the corresponding "
    "input arg was empty)."
)


@mcp.tool(
    name="set_entity_awareness",
    description=(
        "Set one or more observers' awareness levels of an entity. Pass a "
        "one-element list for the single-target case — this is the only "
        "`set_entity_awareness` tool; there is no singular variant.\n\n"
        "`aspect` (optional, default 'existence') selects WHICH awareness "
        "surface is set:\n"
        "  - 'existence' — does each observer know the entity exists / has "
        "met them.\n"
        "  - 'name' — does each observer know the entity's canonical name "
        "(distinct from existence: an observer can know someone exists "
        "without knowing their real name).\n\n"
        "Args:\n"
        "  entity   — required, the entity being observed (shared "
        "across every entry in the batch).\n"
        "  entries  — required, non-empty list of "
        "`{ observer, level, at? }` objects. Per-item validation "
        "upfront — bad observer / level / scene ref errors with "
        "`entries[N].<field>: ...` attribution and NO writes have "
        "landed.\n\n"
        "Returns `{ target_kind, entity_id, entries: [...] }` "
        "with one result entry per input entry. Requires an active "
        "MCP session. Non-destructive."
        + _help_pointer("awareness", "awareness model (observer levels, group projection via `sources`, anchor semantics)")
    ),
)
async def set_entity_awareness(
    entity: str,
    entries: list[dict] | None = None,
    sources: list[dict] | None = None,
    aspect: Optional[AwarenessAspect] = None,
) -> dict:
    payload: dict[str, Any] = {"entity": entity}
    if entries is not None: payload["entries"] = entries
    if sources is not None: payload["sources"] = sources
    if aspect is not None: payload["aspect"] = aspect
    return await _proxy_write_tool(
        "set_entity_awareness",
        payload,
    )


@mcp.tool(
    name="set_attribute_awareness",
    description=(
        "Set one or more observers' awareness levels of one or more "
        "attributes on an entity. Pass a one-element list for the "
        "single-target case — this is the only `set_attribute_awareness` "
        "tool; there is no singular variant.\n\n"
        "Args:\n"
        "  entity   — required, the entity owning the attribute(s) "
        "(shared across every entry in the batch).\n"
        "  entries  — required, non-empty list of "
        "`{ attribute, observer, level, at? }` objects. `attribute` "
        "is a UUID or exact name resolved against the scene-resolved "
        "list when `at` is a scene, against baseline otherwise. "
        "Different entries can name different attributes / observers / "
        "scenes — they only share the entity. Per-item validation "
        "upfront.\n\n"
        "Returns `{ target_kind: 'attribute', entity_id, entries: [...] }` "
        "with one result entry per input entry. Requires an active "
        "MCP session. Non-destructive."
        + _help_pointer("awareness", "awareness model (observer levels, group projection via `sources`, anchor semantics)")
    ),
)
async def set_attribute_awareness(
    entity: str,
    entries: list[dict] | None = None,
    sources: list[dict] | None = None,
) -> dict:
    payload: dict[str, Any] = {"entity": entity}
    if entries is not None: payload["entries"] = entries
    if sources is not None: payload["sources"] = sources
    return await _proxy_write_tool(
        "set_attribute_awareness",
        payload,
    )


@mcp.tool(
    name="set_alias_awareness",
    description=(
        "Set one or more observers' awareness levels of one or more "
        "aliases on an entity. Pass a one-element list for the "
        "single-target case — this is the only `set_alias_awareness` "
        "tool; there is no singular variant.\n\n"
        "Args:\n"
        "  entity   — required, the entity owning the alias(es) "
        "(shared across every entry in the batch).\n"
        "  entries  — required, non-empty list of "
        "`{ alias, observer, level, at? }` objects. `alias` is a UUID "
        "or exact value resolved against the scene-resolved list when "
        "`at` is a scene, against baseline otherwise. Per-item "
        "validation upfront.\n\n"
        "Returns `{ target_kind: 'alias', entity_id, entries: [...] }` "
        "with one result entry per input entry. Requires an active "
        "MCP session. Non-destructive."
        + _help_pointer("awareness", "awareness model (observer levels, group projection via `sources`, anchor semantics)")
    ),
)
async def set_alias_awareness(
    entity: str,
    entries: list[dict] | None = None,
    sources: list[dict] | None = None,
) -> dict:
    payload: dict[str, Any] = {"entity": entity}
    if entries is not None: payload["entries"] = entries
    if sources is not None: payload["sources"] = sources
    return await _proxy_write_tool(
        "set_alias_awareness",
        payload,
    )


@mcp.tool(
    name="set_relationship_awareness",
    description=(
        "Set one or more observers' awareness levels of a relationship "
        "(whether each observer knows the relationship exists / knows "
        "its membership). Pass a one-element list for the single-target "
        "case — this is the only `set_relationship_awareness` tool; "
        "there is no singular variant.\n\n"
        "Awareness lives on the relationship's own history list (one "
        "of the awareness-as-second-class-object hosts) — origin "
        "writes land on the relationship's baseline `awareness` field; "
        "scene writes append a chain entry to the relationship's "
        "`awareness.history[]`. No participant-chip dependency.\n\n"
        "Args:\n"
        "  relationship — required, shared across every entry in the batch.\n"
        "  entries      — required, non-empty list of "
        "`{ observer, level, at? }` objects. Per-item validation upfront.\n\n"
        "Returns `{ target_kind: 'relationship', relationship_id, "
        "entries: [...] }` with one result entry per input entry. "
        "Requires an active MCP session. Non-destructive."
        + _help_pointer("awareness", "awareness model (observer levels, group projection via `sources`, anchor semantics)")
    ),
)
async def set_relationship_awareness(
    relationship: str,
    entries: list[dict] | None = None,
    sources: list[dict] | None = None,
) -> dict:
    payload: dict[str, Any] = {"relationship": relationship}
    if entries is not None: payload["entries"] = entries
    if sources is not None: payload["sources"] = sources
    return await _proxy_write_tool(
        "set_relationship_awareness",
        payload,
    )


# ── Canvas layout tool ───────────────────────────────────────────────


@mcp.tool(
    name="reorganize_canvas",
    description=(
        "Reorganize the entire canvas layout. Call this when the AI has "
        "created or rearranged enough nodes that the layout is messy and "
        "needs a clean pass.\n\n"
        "Repositioned:\n"
        "  - Scenes — packed left-to-right inside their CURRENT chapter "
        "in story order. Off-chapter scenes land past the rightmost "
        "chapter.\n"
        "  - Entity origin nodes — placed in sub-columns LEFT of each "
        "entity's first-appearance scene, grouped by type. Unreferenced "
        "entities land in per-type columns left of Chapter 1.\n"
        "  - Chapters — widened as needed; downstream nodes slide right "
        "to preserve every scene's chapter membership.\n\n"
        "NOT touched: chapter order, per-scene chapter membership, "
        "modifier EntityNodes / non-origin nodes, wires.\n\n"
        "Layout-changing operation — rewrites the user's manual canvas "
        "arrangement. Routes through the destructive-approval modal "
        "with an AMBER tone (no data deleted, but the user's layout is "
        "gone). Per-call approval; no 'approve all' option. Undo is "
        "the canvas Undo button, NOT the MCP API.\n\n"
        "Requires an active MCP session. Returns `{ status: 'applied' }` "
        "on approval; raises on denial / timeout."
    ),
)
async def reorganize_canvas() -> dict:
    return await _proxy_destructive_tool(
        "reorganize_canvas",
        {},
        action="reorganize",
        object_type="canvas layout",
        object_name="(entire project)",
        detail=(
            "Repositions every scene + entity-origin node on the canvas. "
            "Scenes pack left-to-right inside their current chapter "
            "in overall story order; entity origins are placed in "
            "sub-columns left of their first-appearance scene; chapters "
            "widen as needed to fit. Wires, chapter order, and scene-to-"
            "chapter assignments are preserved. No data is lost — but "
            "the manual canvas layout you arranged is replaced. Use "
            "canvas Undo if you change your mind after approving."
        ),
        tone="amber",
    )


# ── Knowledge write tools ────────────────────────────────────────────


@mcp.tool(
    name="create_knowledge",
    description=(
        "Create a new Knowledge object. Knowledge is a first-class "
        "story object distinct from Entity / Relationship — used to "
        "track facts or secrets that exist in the narrative and who "
        "is aware of them.\n\n"
        "Args:\n"
        "  - `name` — required. Human-readable label.\n"
        "  - `description` — optional baseline description text.\n"
        "  - `colour` — optional hex string (defaults to "
        "`#888888`).\n"
        "  - `profile_image_ref` — optional asset path inside the "
        ".nnz archive.\n"
        "  - `notes` — optional free-form author notes (not "
        "scene-tracked).\n"
        "  - `awareness_scale` — optional, one of 'binary' (yes/no) "
        "or 'full' (4-level alias scale 0/1/2/3). Default 'full'.\n"
        "  - `scene` — optional scene UUID/title. When provided, "
        "the knowledge's chain birth is recorded at this scene "
        "(`existence_changes: activate@scene`); the scene resolver "
        "treats the knowledge as 'not yet exists' for any read "
        "before this scene. When omitted, the knowledge is "
        "standalone (no chain birth event; user can pin manual "
        "anchors later).\n\n"
        "Returns `{ id, name }` for the new knowledge. Requires "
        "an active MCP session. Non-destructive."
    ),
)
async def create_knowledge(
    name: str,
    description: Optional[str] = None,
    colour: Optional[str] = None,
    profile_image_ref: Optional[str] = None,
    notes: Optional[str] = None,
    awareness_scale: Optional[AwarenessScale] = None,
    scene: Optional[str] = None,
) -> dict:
    args: dict[str, Any] = {"name": name}
    if description is not None: args["description"] = description
    if colour is not None: args["colour"] = colour
    if profile_image_ref is not None: args["profile_image_ref"] = profile_image_ref
    if notes is not None: args["notes"] = notes
    if awareness_scale is not None: args["awareness_scale"] = awareness_scale
    if scene is not None: args["scene"] = scene
    return await _proxy_write_tool("create_knowledge", args)


@mcp.tool(
    name="create_concept",
    description=(
        "Create a concept (brainstorming) node on the canvas's concept "
        "layer. Concept nodes are free-form idea cards that sit OFF the "
        "narrative chain, used to sketch ideas and connect them with "
        "concept wires. You do NOT position it: the concept auto-layout "
        "places it in the concept region (above the rest of the canvas) "
        "and later arranges it relative to the concept wires you draw.\n\n"
        "Args:\n"
        "  - `title` — optional short label for the concept card.\n"
        "  - `body` — optional card body. Accepts EITHER plain text OR "
        "rich text as HTML (`<p>`, `<strong>`/`<em>`/`<u>`/`<s>`, "
        "`<h1>`-`<h6>`, lists, `<blockquote>`, `<mark>`, `<span "
        "style>`). HTML is stored + rendered as rich text; plain text "
        "stays plain. Pick whichever fits — no need to wrap plain notes "
        "in tags.\n"
        "  - `colour` — optional hex string (defaults to the concept "
        "lime).\n"
        "  - `tags` — optional list of existing project-tag references "
        "(UUID or exact name); call create_tag first to mint a new one.\n"
        "  - `chapter` — optional chapter (name or UUID) to place this "
        "concept INSIDE that chapter, in a band above its scenes, where the "
        "layout keeps it. OMIT it (the default) to leave the concept in the "
        "off-to-the-side concept layer with no chapter.\n\n"
        "Returns `{ id, title, chapter }` for the new concept node. Requires "
        "an active MCP session. Non-destructive."
    ),
)
async def create_concept(
    title: Optional[str] = None,
    body: Optional[str] = None,
    colour: Optional[str] = None,
    tags: Optional[list[str]] = None,
    chapter: Optional[str] = None,
) -> dict:
    args: dict[str, Any] = {}
    if title is not None: args["title"] = title
    if body is not None: args["body"] = body
    if colour is not None: args["colour"] = colour
    if tags is not None: args["tags"] = tags
    if chapter is not None: args["chapter"] = chapter
    return await _proxy_write_tool("create_concept", args)


@mcp.tool(
    name="list_concepts",
    description=(
        "List every concept (brainstorming) node on the canvas. Returns "
        "`{ concepts: [{ id, title, colour, is_rich_text, chapter, groups }] }` "
        "where `chapter` is the chapter title the concept sits in (null when "
        "off-chapter) and `groups` is the group(s) that geometrically contain "
        "it (`[{ id, title, mode }]`). Use it to discover concepts before "
        "reading, updating, deleting, or wiring them. Non-destructive; no "
        "session required."
    ),
)
async def list_concepts() -> dict:
    return await _proxy_tool("list_concepts", {})


@mcp.tool(
    name="get_concept",
    description=(
        "Return one concept node's full state: `{ id, title, body, "
        "is_rich_text, colour, tags, chapter, groups }`. `body` is plain text "
        "for a plain concept, or rendered HTML for a rich-text one. `chapter` "
        "is the chapter title the concept sits in (null when off-chapter); "
        "`groups` is the group(s) that geometrically contain it "
        "(`[{ id, title, mode }]`). The `concept` arg accepts a UUID OR the "
        "exact (case-insensitive) title. Non-destructive."
    ),
)
async def get_concept(concept: str) -> dict:
    return await _proxy_tool("get_concept", {"concept": concept})


@mcp.tool(
    name="update_concept",
    description=(
        "Update a concept node's title, body, colour, and/or tags. The "
        "`concept` arg accepts a UUID or exact title. Pass only the fields "
        "you want to change:\n"
        "  - `title` — new label.\n"
        "  - `body` — new body; plain text OR HTML (HTML becomes rich "
        "text, plain stays plain), same as `create_concept`.\n"
        "  - `colour` — new hex string.\n"
        "  - `tags` — REPLACES the tag set with these existing project-tag "
        "references (UUID or exact name).\n"
        "  - `chapter` — move the concept INTO a chapter (name or UUID), "
        "into a band above that chapter's scenes; or pass `\"none\"` to move "
        "it back OFF-chapter to the side concept layer. Omit to leave its "
        "placement unchanged.\n\n"
        "Returns `{ id, title, updated }` (the list of fields changed). "
        "Requires an active MCP session. Non-destructive."
    ),
)
async def update_concept(
    concept: str,
    title: Optional[str] = None,
    body: Optional[str] = None,
    colour: Optional[str] = None,
    tags: Optional[list[str]] = None,
    chapter: Optional[str] = None,
) -> dict:
    args: dict[str, Any] = {"concept": concept}
    if title is not None: args["title"] = title
    if body is not None: args["body"] = body
    if colour is not None: args["colour"] = colour
    if tags is not None: args["tags"] = tags
    if chapter is not None: args["chapter"] = chapter
    return await _proxy_write_tool("update_concept", args)


@mcp.tool(
    name="delete_concept",
    description=(
        "Delete a concept node from the canvas. The `concept` arg accepts "
        "a UUID or exact title. Also removes any concept wires touching "
        "it. Returns `{ deleted, id, title }`. Requires an active MCP "
        "session. DESTRUCTIVE."
    ),
)
async def delete_concept(concept: str) -> dict:
    return await _proxy_write_tool("delete_concept", {"concept": concept})


@mcp.tool(
    name="wire_concepts",
    description=(
        "Draw a concept wire between two concept-layer bodies. Concept "
        "wiring is a closed world: it connects concepts / concept-mode "
        "groups only (never narrative nodes). Each of `a` and `b` accepts "
        "a concept card OR a concept-mode group (a group whose ports are "
        "on), given by UUID or exact (case-insensitive) title; call "
        "`list_concepts` to discover cards. Wiring a group attaches the "
        "wire to the group as a whole, and the auto-layout keeps the "
        "group and its members together. Organisation groups (ports off) "
        "cannot be wired. You name the two ends; the app picks the facing "
        "ports and draws the wire. Idempotent — wiring the same two "
        "bodies again returns the existing wire. Returns "
        "`{ wired, edge_id, a, b }`. Requires an active MCP session."
    ),
)
async def wire_concepts(a: str, b: str) -> dict:
    return await _proxy_write_tool("wire_concepts", {"a": a, "b": b})


@mcp.tool(
    name="unwire_concepts",
    description=(
        "Remove the concept wire(s) between two concept-layer bodies. "
        "Each of `a` and `b` accepts a concept card OR a concept-mode "
        "group, by UUID or exact title. Returns "
        "`{ unwired, removed_count, a, b }`. Requires an active MCP "
        "session."
    ),
)
async def unwire_concepts(a: str, b: str) -> dict:
    return await _proxy_write_tool("unwire_concepts", {"a": a, "b": b})


@mcp.tool(
    name="tidy_concepts",
    description=(
        "Re-arrange the concept layer into a readable, wire-driven layout: "
        "wired concepts pulled together, a hub centred with its spokes "
        "around it, separate clusters pushed apart, nothing overlapping. "
        "You do NOT position concepts yourself — this is the app's job, and "
        "`wire_concepts` / `unwire_concepts` already run it automatically on "
        "every wire so the map stays sensible as you build. Call this only "
        "for an explicit re-tidy. `scope`:\n"
        "  - `session` (default) — only the concept nodes / groups THIS "
        "session created; user-placed concepts are never moved (but a "
        "session node wired to one is drawn toward it).\n"
        "  - `region` — every concept node / group sitting in the concept "
        "band (a broader clean-up that still leaves scattered user concepts "
        "alone).\n"
        "  - `all` — a full reflow of EVERY concept node / group, including "
        "user-placed ones; use only when the user explicitly asks to "
        "re-lay-out the whole concept map.\n"
        "Returns `{ tidied, moved, scope }`. Requires an active MCP session."
    ),
)
async def tidy_concepts(scope: Optional[str] = None) -> dict:
    args: dict[str, Any] = {}
    if scope is not None:
        args["scope"] = scope
    return await _proxy_write_tool("tidy_concepts", args)


@mcp.tool(
    name="create_group",
    description=(
        "Create a group container on the canvas. A group's membership is "
        "geometric: a node belongs to the group when it sits inside the "
        "group's box. `mode` picks the kind:\n"
        "  - `concept` (default) — a concept group: concept ports are ON, "
        "so it lives in the brainstorming / concept layer.\n"
        "  - `organization` — a plain organisation container: ports OFF, "
        "for tidying narrative nodes.\n"
        "Optional `title` (the header label) and `colour` (hex string). You "
        "do NOT position it — by default the app packs it into the "
        "off-to-the-side concept region. Pass `chapter` (name or UUID) to "
        "place the group INSIDE that chapter instead (in a band above its "
        "scenes). Returns `{ id, title, mode, chapter }`. Use `add_to_group` "
        "to move nodes into it, or `update_group` to rename / recolour / "
        "reassign its chapter later. Requires an active MCP session. "
        "Non-destructive."
    ),
)
async def create_group(
    mode: Optional[str] = None,
    title: Optional[str] = None,
    colour: Optional[str] = None,
    chapter: Optional[str] = None,
) -> dict:
    args: dict[str, Any] = {}
    if mode is not None: args["mode"] = mode
    if title is not None: args["title"] = title
    if colour is not None: args["colour"] = colour
    if chapter is not None: args["chapter"] = chapter
    return await _proxy_write_tool("create_group", args)


@mcp.tool(
    name="add_to_group",
    description=(
        "Place a node inside a group so it becomes a member. Membership is "
        "geometric, so this moves the node into the group's interior and "
        "grows the group to fit. `group` accepts a group UUID or its exact "
        "(case-insensitive) title. `node` accepts:\n"
        "  - any node's UUID;\n"
        "  - a concept's exact title;\n"
        "  - an entity name / alias, or an entity's library UUID, which "
        "maps to that entity's canvas ORIGIN node (character, location, "
        "item, faction, custom). Use `get_entity`'s `origin_node_id` if "
        "you'd rather pass the node id directly.\n"
        "Returns `{ added, node, group }`. Requires an active MCP session. "
        "Non-destructive."
    ),
)
async def add_to_group(group: str, node: str) -> dict:
    return await _proxy_write_tool("add_to_group", {"group": group, "node": node})


@mcp.tool(
    name="update_group",
    description=(
        "Modify an existing group. `group` accepts a group UUID or its exact "
        "(case-insensitive) title. Pass only the fields you want to change:\n"
        "  - `title` — new header label.\n"
        "  - `colour` — new hex string.\n"
        "  - `chapter` — move the WHOLE group (its box AND every node inside "
        "it, together) INTO a chapter (name or UUID), in a band above that "
        "chapter's scenes; or pass `\"none\"` to move it back OFF-chapter to "
        "the side. Contents always travel with the group, so membership "
        "holds.\n\n"
        "Returns `{ id, title, updated }` (the list of fields changed). "
        "Requires an active MCP session. Non-destructive."
    ),
)
async def update_group(
    group: str,
    title: Optional[str] = None,
    colour: Optional[str] = None,
    chapter: Optional[str] = None,
) -> dict:
    args: dict[str, Any] = {"group": group}
    if title is not None: args["title"] = title
    if colour is not None: args["colour"] = colour
    if chapter is not None: args["chapter"] = chapter
    return await _proxy_write_tool("update_group", args)


@mcp.tool(
    name="list_groups",
    description=(
        "List every group container on the canvas. Returns "
        "`{ groups: [{ id, title, mode, member_count }] }` where `mode` is "
        "`concept` or `organization` and `member_count` is how many nodes "
        "geometrically sit inside the group. Use it to discover groups before "
        "adding to / updating / deleting them. Non-destructive; no session "
        "required."
    ),
)
async def list_groups() -> dict:
    return await _proxy_tool("list_groups", {})


@mcp.tool(
    name="list_group_members",
    description=(
        "List the CONTENTS of one group: every node that geometrically sits "
        "inside it. The `group` arg accepts a group UUID or its exact "
        "(case-insensitive) title. Returns "
        "`{ id, title, mode, members: [{ id, kind, title }] }` where `kind` is a "
        "plain label (`scene`, `concept`, `note`, `media`, the entity's own type "
        "such as `character`/`location`, or `concept group`/`organization group` "
        "for a nested group) and `title` is the node's human name (an entity node "
        "shows the entity's name). `list_groups` gives only a member COUNT; use "
        "this to see WHICH nodes are inside, e.g. to find narrative nodes a box "
        "unintentionally encloses. Non-destructive; no session required."
    ),
)
async def list_group_members(group: str) -> dict:
    return await _proxy_tool("list_group_members", {"group": group})


@mcp.tool(
    name="get_chapter_membership",
    description=(
        "Bidirectional chapter membership, one read for both directions. The "
        "`ref` arg accepts a UUID or an exact (case-insensitive) name for EITHER "
        "a chapter or a node of any type:\n"
        "  - ref is a NODE (scene, entity, concept, note, media, group, ...) → "
        "returns the chapter that node sits in, or `chapter: null` when it is "
        "off-chapter (outside every chapter column).\n"
        "  - ref is a CHAPTER (exact title, UUID, or the placeholder display "
        "name 'Chapter 1', 'Chapter 2', ...) → returns every node that sits in "
        "that chapter, each as `{ id, kind, title }` (same `kind` labels as "
        "list_group_members).\n\n"
        "Membership is geometric and layout-aware — it gives the right answer in "
        "both single-row and multi-row layouts, the same rule the canvas and "
        "table of contents use. A name that matches BOTH a chapter and a node is "
        "ambiguous and asks for the UUID. Returns "
        "`{ query, resolved: 'node'|'chapter', ... }`. Complements "
        "list_group_members (which lists a GROUP's contents) on the chapter axis. "
        "Non-destructive; no session required."
    ),
)
async def get_chapter_membership(ref: str) -> dict:
    return await _proxy_tool("get_chapter_membership", {"ref": ref})


@mcp.tool(
    name="delete_group",
    description=(
        "Delete a group container. The `group` arg accepts a group UUID or its "
        "exact (case-insensitive) title. This deletes ONLY the group box — its "
        "members are separate canvas nodes (membership is geometric) and stay "
        "put, just ungrouped; any concept wires touching the group are removed. "
        "Returns `{ deleted, id, title }`. Requires an active MCP session. "
        "DESTRUCTIVE."
    ),
)
async def delete_group(group: str) -> dict:
    return await _proxy_write_tool("delete_group", {"group": group})


@mcp.tool(
    name="convert_entity",
    description=(
        "Convert an entity from one type to another, KEEPING ITS ID (a "
        "MOVE, not a delete: every reference to the entity stays valid). "
        "`entity` accepts a UUID or exact name/alias. `to_type` is the "
        "target: character | location | item | faction | custom. The "
        "type-gated choices the GUI's convert dialog collects are optional "
        "params; omit them to take the same defaults:\n"
        "  - `category` — REQUIRED when `to_type='custom'`: an existing "
        "custom category (UUID or exact name).\n"
        "  - `location_children` — when converting a LOCATION away: "
        "'reparent' (default, lift children to the grandparent) or 'clear'.\n"
        "  - `faction_members` — when converting TO faction: 'create' "
        "(default, a fresh Members relationship), 'adopt', or 'copy' an "
        "existing relationship (needs `faction_source`).\n"
        "  - `faction_source` — the relationship (UUID or name) to "
        "adopt/copy as the Members relationship.\n"
        "  - `faction_leave` — when converting a FACTION away: 'convert' "
        "(default, demote its Members relationship to a normal one) or "
        "'delete'.\n"
        "Returns `{ id, name, from_type, to_type }`. Requires an active "
        "MCP session."
    ),
)
async def convert_entity(
    entity: str,
    to_type: str,
    category: Optional[str] = None,
    location_children: Optional[str] = None,
    faction_members: Optional[str] = None,
    faction_source: Optional[str] = None,
    faction_leave: Optional[str] = None,
) -> dict:
    args: dict[str, Any] = {"entity": entity, "to_type": to_type}
    if category is not None: args["category"] = category
    if location_children is not None: args["location_children"] = location_children
    if faction_members is not None: args["faction_members"] = faction_members
    if faction_source is not None: args["faction_source"] = faction_source
    if faction_leave is not None: args["faction_leave"] = faction_leave
    return await _proxy_write_tool("convert_entity", args)


@mcp.tool(
    name="convert_knowledge",
    description=(
        "Convert a Knowledge into an entity, KEEPING ITS ID (a MOVE, not a "
        "delete). `knowledge` accepts a UUID or exact name. `to_type` is "
        "the target entity type: character | location | item | faction | "
        "custom. Optional params (omit for the defaults):\n"
        "  - `population` — how the new entity is placed into the scenes "
        "where the Knowledge was known: 'auto' (default), 'orphaned', or "
        "'origin'.\n"
        "  - `category` — REQUIRED when `to_type='custom'`: an existing "
        "custom category (UUID or exact name).\n"
        "  - `faction_members` / `faction_source` — when `to_type='faction'`: "
        "'create' (default) a fresh Members relationship, or 'adopt'/'copy' "
        "an existing relationship named by `faction_source`.\n"
        "Returns `{ id, name, from, to_type }`. Requires an active MCP "
        "session."
    ),
)
async def convert_knowledge(
    knowledge: str,
    to_type: str,
    population: Optional[str] = None,
    category: Optional[str] = None,
    faction_members: Optional[str] = None,
    faction_source: Optional[str] = None,
) -> dict:
    args: dict[str, Any] = {"knowledge": knowledge, "to_type": to_type}
    if population is not None: args["population"] = population
    if category is not None: args["category"] = category
    if faction_members is not None: args["faction_members"] = faction_members
    if faction_source is not None: args["faction_source"] = faction_source
    return await _proxy_write_tool("convert_knowledge", args)


@mcp.tool(
    name="convert_reference",
    description=(
        "Convert a reference node between a plain NOTE and a CONCEPT "
        "(brainstorming) node. `reference` accepts a reference-node UUID, "
        "or the exact title of a note OR a concept. `to` is 'note' or 'concept'. "
        "Converting concept -> note strips the node's concept wires (a note "
        "has no concept ports). Media reference nodes are not convertible "
        "this way. Returns `{ id, from, to }`. Requires an active MCP "
        "session."
    ),
)
async def convert_reference(reference: str, to: str) -> dict:
    return await _proxy_write_tool("convert_reference", {"reference": reference, "to": to})


@mcp.tool(
    name="delete_knowledge",
    description=(
        "Delete a Knowledge from the project. The `knowledge` arg "
        "accepts UUID or exact (case-insensitive) name.\n\n"
        "DESTRUCTIVE — routes through deleteObject('knowledge', id). "
        "The knowledge object, all its scene-anchored history (existence / "
        "name / description / colour / profile-image / awareness "
        "changes), and every reference to its id across the project "
        "are stripped. Cannot be undone via MCP.\n\n"
        "Requires both an active MCP session AND a per-action "
        "destructive approval from the user. Returns "
        "`{ id, name }` on success."
    ),
)
async def delete_knowledge(knowledge: str) -> dict:
    return await _proxy_destructive_tool(
        "delete_knowledge",
        {"knowledge": knowledge},
        action="delete",
        object_type="knowledge",
        object_name=knowledge,
        detail=(
            "Removes the Knowledge object, its full scene-anchored history "
            "(name/description/colour/profile-image/awareness/"
            "existence changes), and all references to its id "
            "across the project. Cannot be undone via MCP."
        ),
    )


@mcp.tool(
    name="update_knowledge",
    description=(
        "Update a Knowledge's fields, EITHER at the "
        "knowledge's origin (baseline) OR at a specific scene "
        "(change). The `knowledge` arg accepts UUID or exact "
        "(case-insensitive) name. The `at` arg controls the anchor:\n"
        "  - omitted / null / 'origin' → BASELINE write.\n"
        "  - scene UUID or exact title → records a change on "
        "the knowledge at that scene.\n\n"
        "Pass only the fields you want to change.\n\n"
        "Fields valid AT ORIGIN (writing baseline):\n"
        "  name, description, colour, profile_image_ref (empty "
        "string clears it), notes, awareness_scale.\n\n"
        "Fields valid AT A SCENE:\n"
        "  name (records `name_changes`), description (records "
        "`description_changes`), colour (records `colour_changes`), "
        "profile_image_ref (records `profile_image_changes`). NOT "
        "settable at scene: notes (set on baseline only), "
        "awareness_scale (origin only).\n\n"
        "Returns the projected updated knowledge. Requires an "
        "active MCP session. Non-destructive."
    ),
)
async def update_knowledge(
    knowledge: str,
    name: Optional[str] = None,
    description: Optional[str] = None,
    colour: Optional[str] = None,
    profile_image_ref: Optional[str] = None,
    notes: Optional[str] = None,
    awareness_scale: Optional[AwarenessScale] = None,
    at: Optional[str] = None,
) -> dict:
    args: dict[str, Any] = {"knowledge": knowledge}
    if name is not None: args["name"] = name
    if description is not None: args["description"] = description
    if colour is not None: args["colour"] = colour
    if profile_image_ref is not None: args["profile_image_ref"] = profile_image_ref
    if notes is not None: args["notes"] = notes
    if awareness_scale is not None: args["awareness_scale"] = awareness_scale
    if at is not None: args["at"] = at
    return await _proxy_write_tool("update_knowledge", args)


@mcp.tool(
    name="set_knowledge_profile_image",
    description=(
        "Set a Knowledge's profile / avatar image from raw image bytes. "
        "The MCP client passes the image as a base64-encoded string "
        "(optionally with a `data:image/...;base64,` prefix); the server "
        "decodes, preprocesses, saves the spec-compliant version to the "
        "project's assets directory, and sets the Knowledge's "
        "`profile_image_ref` to point at it.\n\n"
        "Image preprocessing (server-side, identical to the writer-facing "
        "UI):\n"
        "  1. Crop to the largest CENTRED SQUARE the image contains. "
        "The full image stays visible inside the square — we trim equal "
        "slices off the long edge. No zoom-in / focus-region behaviour.\n"
        "  2. Resize the square to 256x256 (Lanczos resampling).\n"
        "  3. Encode as JPEG at quality 90.\n"
        "  4. EXIF metadata strips out as a side-effect of the re-encode.\n\n"
        "A SQUARE source image is preferred — non-square images will be "
        "cropped to the largest centred square as described above. Only "
        "the post-processed 256x256 JPEG ever lands in the project; the "
        "bytes you pass never touch disk in their original form.\n\n"
        "`knowledge` accepts a UUID OR an exact (case-insensitive) name.\n\n"
        "`at` arg:\n"
        "  - omitted / null / 'origin' → sets the BASELINE profile image "
        "the Knowledge has 'always had'.\n"
        "  - scene UUID or exact title → records the profile-image change "
        "at that scene, propagating forward as a chain modifier.\n\n"
        "Returns the Knowledge at the resolved anchor. Requires an active "
        "MCP session. Non-destructive."
    ),
)
async def set_knowledge_profile_image(
    knowledge: str,
    image_base64: str,
    at: Optional[str] = None,
) -> dict:
    import uuid as _uuid
    from services.profile_image_processor import preprocess_profile_image_from_base64
    from services import file_service

    try:
        jpeg_bytes = preprocess_profile_image_from_base64(image_base64)
    except ValueError as e:
        raise RuntimeError(f"[invalid_image] {e}")
    filename = f"profile_{_uuid.uuid4()}.jpg"
    file_ref = file_service.store_asset_bytes(jpeg_bytes, filename)
    args: dict[str, Any] = {"knowledge": knowledge, "profile_image_ref": file_ref}
    if at is not None: args["at"] = at
    return await _proxy_write_tool("update_knowledge", args)


@mcp.tool(
    name="set_knowledge_awareness",
    description=(
        "Set one or more observers' awareness levels of a Knowledge. "
        "Pass `entries=[...]` for per-observer direct pins, "
        "`sources=[...]` for group projections from a relationship, "
        "or both — at least one required.\n\n"
        "Per-item shapes:\n"
        "  entries item: `{ observer, level, at? }`\n"
        "  sources item: `{ action, source_kind?, source, level?, "
        "at? }` where action is 'add' | 'remove' | 'set_level' and "
        "source is a relationship UUID or exact name.\n\n"
        "Args:\n"
        "  knowledge — required, UUID or exact name (shared across "
        "the batch).\n"
        "  entries   — optional, list of per-observer direct-pin "
        "entries.\n"
        "  sources   — optional, list of group-projection mutations "
        "from a relationship. Membership resolves at the chain "
        "anchor; new members joining a faction-style group later "
        "automatically inherit the projected level. Direct entries "
        "override projections for the same observer.\n\n"
        "Per-item validation upfront — bad fields on item N error "
        "with `entries[N].<field>: ...` or `sources[N].<field>: ...` "
        "attribution; NO writes have landed.\n\n"
        "Returns `{ knowledge_id, entries: [...], sources: [...] }` "
        "with one result entry per input item. Requires an active "
        "MCP session. Non-destructive."
        + _help_pointer("awareness", "awareness model (observer levels, group projection via `sources`, anchor semantics)")
    ),
)
async def set_knowledge_awareness(
    knowledge: str,
    entries: list[dict] | None = None,
    sources: list[dict] | None = None,
) -> dict:
    payload: dict[str, Any] = {"knowledge": knowledge}
    if entries is not None: payload["entries"] = entries
    if sources is not None: payload["sources"] = sources
    return await _proxy_write_tool(
        "set_knowledge_awareness",
        payload,
    )


# ── Chapter / act CRUD + reads ──────────────────────────────────────────
#
# Phase 2.1 audit deliverable. Chapters and acts are first-class writer
# objects organising the canvas top header strip. Pre-this-cluster the
# AI could REFERENCE existing chapters via `update_scene(chapter=...)`
# but couldn't mint new ones; this cluster closes the gap.
#
# Design choices (settled with the user, mirrored on the frontend
# handlers — see the `Wave 2: chapter / act CRUD + reads` block in
# `mcpTools.js` for the implementation rationale):
#
#   - `update_chapter` does NOT take an `act` arg. Act membership is
#     acts-own-chapters (`act.chapter_ids[]` with a contiguity
#     invariant); membership changes go through `update_act(chapters=
#     [...])` so the AI sets the full chapter span explicitly and the
#     server validates contiguity in one place.
#
#   - `create_act` requires a non-empty `chapters` list — acts cannot
#     exist without chapters per the model. `update_act(chapters=[])`
#     errors with a "use delete_act" hint rather than cascading to
#     auto-deletion.
#
#   - Chapter width is NOT exposed. Widths are UI layout, not narrative
#     goals; `reorganize_canvas` handles widening when scenes pack into
#     a chapter.


@mcp.tool(
    name="list_chapters",
    description=(
        "List every chapter in the project in canvas (left-to-right) "
        "order. Returns `{ chapters: [...] }` where each entry is "
        "`{ id, title, display_title, colour, index, width, act_id, "
        "act_title }`. `title` may be empty (unnamed chapter); "
        "`display_title` falls back to the UI's placeholder "
        "`\"Chapter N\"` for unnamed chapters so the AI can refer to "
        "them by the same label the writer sees. `act_id` / "
        "`act_title` are null when the chapter isn't part of any act. "
        "Read-only — does NOT require an active MCP session."
    ),
)
async def list_chapters() -> dict:
    return await _proxy_tool("list_chapters", {})


@mcp.tool(
    name="get_chapter",
    description=(
        "Fetch one chapter's full state. The `chapter` arg accepts "
        "EITHER a UUID OR an exact (case-insensitive) title, OR the "
        "UI placeholder `\"Chapter N\"` for unnamed chapters. Returns "
        "the same shape `list_chapters` produces per entry. Read-only "
        "— does NOT require an active MCP session."
    ),
)
async def get_chapter(chapter: str) -> dict:
    return await _proxy_tool("get_chapter", {"chapter": chapter})


@mcp.tool(
    name="create_chapter",
    description=(
        "Create a new chapter. `title` is optional — omit to leave the "
        "chapter unnamed (UI will display it as `\"Chapter N\"`). New "
        "chapters get a default canvas width and no colour.\n\n"
        "Insertion position (optional, mutually exclusive):\n"
        "  - Both `before` and `after` omitted → APPEND to the end of "
        "the chapter strip (default).\n"
        "  - `before=<chapter ref>` → INSERT immediately before the "
        "named chapter. Every downstream chapter renumbers; every "
        "node on the canvas (scenes, modifier nodes, entity / "
        "relationship / knowledge origins, reference nodes) whose "
        "centre-x is at or past the insertion point shifts right by "
        "the new chapter's width so it stays inside its original "
        "chapter. Any act whose span strictly straddles the insertion "
        "point grows by one to include the new chapter (preserves act "
        "contiguity); acts entirely before or entirely after the "
        "insertion are unaffected.\n"
        "  - `after=<chapter ref>` → INSERT immediately after the "
        "named chapter. Same shift / act-membership semantics.\n"
        "  - Passing both → error.\n\n"
        "Use the insertion args when you need a chapter to slot in "
        "between existing ones without forcing manual renumbering or "
        "scene re-dragging. Both `before` and `after` accept UUID, "
        "exact (case-insensitive) title, or the `\"Chapter N\"` "
        "placeholder for unnamed chapters.\n\n"
        "Returns the new chapter's projection (same shape as "
        "`get_chapter`). Requires an active MCP session. Non-destructive."
    ),
)
async def create_chapter(
    title: Optional[str] = None,
    before: Optional[str] = None,
    after: Optional[str] = None,
) -> dict:
    args: dict[str, Any] = {}
    if title is not None: args["title"] = title
    if before is not None: args["before"] = before
    if after is not None: args["after"] = after
    return await _proxy_write_tool("create_chapter", args)


@mcp.tool(
    name="update_chapter",
    description=(
        "Update a chapter's title and/or colour. Pass at least one of "
        "the two — calling with no editable fields errors. The "
        "`chapter` arg accepts UUID / exact title / `\"Chapter N\"` "
        "placeholder. When both title and colour are passed they're "
        "applied atomically (one undo step). Empty-string title is "
        "valid and reverts the chapter's header to the auto-numbered "
        "placeholder.\n\n"
        "NOTE: act membership is NOT settable here — use "
        "`update_act(act, chapters=[...])` to change which chapters an "
        "act spans. The model is acts-own-chapters with a contiguity "
        "invariant; setting membership via the act is the single "
        "validation point for that invariant.\n\n"
        "Width is also NOT settable — chapter widths are UI layout, "
        "not narrative goals; use `reorganize_canvas` to widen "
        "chapters that need more room for their scenes.\n\n"
        "Returns the updated chapter projection. Requires an active "
        "MCP session. Non-destructive."
    ),
)
async def update_chapter(
    chapter: str,
    title: Optional[str] = None,
    colour: Optional[str] = None,
) -> dict:
    args: dict[str, Any] = {"chapter": chapter}
    # Pass-through that distinguishes "field omitted" from "field
    # passed as null" so the frontend's hasOwnProperty checks see the
    # right shape — null is a valid value (clears the colour) so we
    # forward it verbatim when provided.
    if title is not None: args["title"] = title
    if colour is not None: args["colour"] = colour
    return await _proxy_write_tool("update_chapter", args)


@mcp.tool(
    name="delete_chapter",
    description=(
        "Delete a chapter from the project. DESTRUCTIVE — routes "
        "through the project's chapter-delete path and CANNOT be "
        "undone via the MCP API. Any act whose chapter range "
        "included this chapter is rewritten so its remaining "
        "`chapter_ids` stay contiguous (the existing pruning rule "
        "the UI uses); acts left with zero chapters are dropped "
        "entirely. Scenes that were inside the deleted column's "
        "x-range automatically re-resolve to whichever adjacent "
        "chapter their canvas position now matches — scene data is "
        "not mutated since chapter membership is derived from "
        "x-position.\n\n"
        "The `chapter` arg accepts UUID / exact title / `\"Chapter "
        "N\"` placeholder. Requires both an active MCP session AND "
        "a per-action approval from the user. Returns "
        "`{ id, title, display_title }` of the deleted chapter on "
        "success. Errors: `[session_not_active]`, "
        "`[destructive_denied]`, `[destructive_timeout]`, or the "
        "frontend resolver's ambiguous / not-found errors."
    ),
)
async def delete_chapter(chapter: str) -> dict:
    return await _proxy_destructive_tool(
        "delete_chapter",
        {"chapter": chapter},
        action="delete",
        object_type="chapter",
        object_name=chapter,
        detail=(
            "Removes the chapter from the canvas top header strip. "
            "Any act whose range included this chapter is rewritten "
            "to skip it (acts left with zero chapters are dropped). "
            "Scenes inside the deleted column's x-range re-resolve "
            "to an adjacent chapter automatically; scene data isn't "
            "mutated. Cannot be undone via MCP."
        ),
    )


@mcp.tool(
    name="list_acts",
    description=(
        "List every act in the project. Returns `{ acts: [...] }` where "
        "each entry is `{ id, title, display_title, colour, "
        "chapter_ids, chapter_titles }`. `chapter_ids` is the act's "
        "contiguous span in canvas (left-to-right) order; "
        "`chapter_titles` mirrors it with each chapter's display title "
        "(falling back to `\"Chapter N\"` for unnamed chapters). "
        "`title` may be empty; `display_title` falls back to "
        "`\"Untitled act\"`. Read-only — does NOT require an active "
        "MCP session."
    ),
)
async def list_acts() -> dict:
    return await _proxy_tool("list_acts", {})


@mcp.tool(
    name="get_act",
    description=(
        "Fetch one act's full state. The `act` arg accepts EITHER a "
        "UUID OR an exact (case-insensitive) title. Unnamed acts "
        "have no matchable display name — reference them by UUID. "
        "Returns the same shape `list_acts` produces per entry. "
        "Read-only — does NOT require an active MCP session."
    ),
)
async def get_act(act: str) -> dict:
    return await _proxy_tool("get_act", {"act": act})


@mcp.tool(
    name="create_act",
    description=(
        "Create a new act spanning a contiguous run of chapters. "
        "`chapters` is REQUIRED — pass an array of chapter "
        "references (UUID / exact title / `\"Chapter N\"` "
        "placeholder, each); the resolved chapters must form a "
        "contiguous run in canvas order (acts span one contiguous "
        "range per the data model). The list MAY be passed in any "
        "order; the server sorts by canvas order before validating "
        "contiguity. `title` and `colour` are optional. Returns "
        "the new act's projection (same shape as `get_act`). "
        "Requires an active MCP session. Non-destructive."
    ),
)
async def create_act(
    chapters: list[str],
    title: Optional[str] = None,
    colour: Optional[str] = None,
) -> dict:
    args: dict[str, Any] = {"chapters": chapters}
    if title is not None: args["title"] = title
    if colour is not None: args["colour"] = colour
    return await _proxy_write_tool("create_act", args)


@mcp.tool(
    name="update_act",
    description=(
        "Update an act's title, colour, and/or chapter span. Pass "
        "at least one of the three. The `act` arg accepts UUID or "
        "exact (case-insensitive) title; unnamed acts are "
        "UUID-only.\n\n"
        "`chapters` (optional): array of chapter references "
        "replacing the act's current chapter span. Must resolve to "
        "a contiguous run in canvas order (same validation as "
        "`create_act`). May be passed in any order; the server "
        "sorts. Passing an EMPTY array errors with a 'use "
        "delete_act' hint rather than cascading to act deletion — "
        "use `delete_act` explicitly to remove an act.\n\n"
        "`title` / `colour`: applied atomically (single undo step) "
        "when both are passed together. Empty-string title is "
        "valid and reverts the act to the `\"Untitled act\"` "
        "display.\n\n"
        "Returns the updated act projection. Requires an active "
        "MCP session. Non-destructive."
    ),
)
async def update_act(
    act: str,
    title: Optional[str] = None,
    colour: Optional[str] = None,
    chapters: Optional[list[str]] = None,
) -> dict:
    args: dict[str, Any] = {"act": act}
    if title is not None: args["title"] = title
    if colour is not None: args["colour"] = colour
    if chapters is not None: args["chapters"] = chapters
    return await _proxy_write_tool("update_act", args)


@mcp.tool(
    name="delete_act",
    description=(
        "Delete an act from the project. DESTRUCTIVE — routes "
        "through the project's act-delete path and CANNOT be "
        "undone via the MCP API. Chapters themselves are NOT "
        "affected; only the act's grouping is removed.\n\n"
        "The `act` arg accepts UUID or exact title (unnamed acts "
        "are UUID-only). Requires both an active MCP session AND a "
        "per-action approval from the user. Returns "
        "`{ id, title, display_title }` of the deleted act on "
        "success. Errors: `[session_not_active]`, "
        "`[destructive_denied]`, `[destructive_timeout]`, or the "
        "frontend resolver's ambiguous / not-found errors."
    ),
)
async def delete_act(act: str) -> dict:
    return await _proxy_destructive_tool(
        "delete_act",
        {"act": act},
        action="delete",
        object_type="act",
        object_name=act,
        detail=(
            "Removes the act from the canvas top header strip. "
            "The chapters the act spanned are not affected — only "
            "their grouping under this act is removed. Cannot be "
            "undone via MCP."
        ),
    )


# ── Preset list CRUD + reads ────────────────────────────────────────────
#
# Preset lists are story-level named value-sets (e.g. a "Genders" list
# of ["Female", "Male", "Other"]) that preset-type attributes pick
# from. Story seeds reference them by name when seeding preset-type
# attributes onto newly-created entities. Tools route through the
# frontend's canonical entitiesStore actions so cross-reference
# housekeeping (orphan re-link on create, ref-stripping on delete)
# stays consistent with the UI flow.


@mcp.tool(
    name="list_preset_lists",
    description=(
        "List every preset list in the project. Returns "
        "`{ preset_lists: [...] }` where each entry is "
        "`{ id, name, values }`. Use this for orientation before "
        "referencing a preset list by name in a seed, an attribute, "
        "or anywhere else the MCP surface accepts a `preset_list` "
        "arg. Read-only — does NOT require an active MCP session."
    ),
)
async def list_preset_lists() -> dict:
    return await _proxy_tool("list_preset_lists", {})


@mcp.tool(
    name="get_preset_list",
    description=(
        "Fetch one preset list's full state. The `preset_list` arg "
        "accepts EITHER a UUID OR an exact (case-insensitive) name. "
        "Returns the same shape `list_preset_lists` produces per "
        "entry. Read-only — does NOT require an active MCP session."
    ),
)
async def get_preset_list(preset_list: str) -> dict:
    return await _proxy_tool("get_preset_list", {"preset_list": preset_list})


@mcp.tool(
    name="create_preset_list",
    description=(
        "Create a new preset list. `name` is required and must be "
        "unique within the project (case-insensitive — names are the "
        "stable identifier preset attributes and story seeds use to "
        "reference lists). `values` is optional; defaults to an empty "
        "list (preset-type attributes referencing the list will offer "
        "no options until values are added via `update_preset_list`). "
        "Returns the new preset list's projection. Requires an active "
        "MCP session. Non-destructive."
    ),
)
async def create_preset_list(
    name: str,
    values: Optional[list[str]] = None,
) -> dict:
    args: dict[str, Any] = {"name": name}
    if values is not None: args["values"] = values
    return await _proxy_write_tool("create_preset_list", args)


@mcp.tool(
    name="update_preset_list",
    description=(
        "Update a preset list's name and/or values. Pass at least one "
        "of the two — calling with no editable fields errors. The "
        "`preset_list` arg accepts UUID or exact (case-insensitive) "
        "name. Renames are rejected when another list already uses "
        "the new name (preset attributes + seeds reference lists by "
        "name, so duplicates would make those references ambiguous). "
        "Passing `values` REPLACES the list's values entirely (not a "
        "diff / append) — pass the full intended set. Returns the "
        "updated preset list's projection. Requires an active MCP "
        "session. Non-destructive."
    ),
)
async def update_preset_list(
    preset_list: str,
    name: Optional[str] = None,
    values: Optional[list[str]] = None,
) -> dict:
    args: dict[str, Any] = {"preset_list": preset_list}
    if name is not None: args["name"] = name
    if values is not None: args["values"] = values
    return await _proxy_write_tool("update_preset_list", args)


@mcp.tool(
    name="delete_preset_list",
    description=(
        "Delete a preset list. DESTRUCTIVE — routes through the "
        "project's preset-list-delete path and CANNOT be undone via "
        "the MCP API. Side effects: every entity attribute and "
        "relationship participant role that referenced this list by "
        "id has its `preset_list_id` cleared (the last-selected "
        "value is preserved as free-form text per the standard UI "
        "delete flow). Existing seed stubs that reference the list "
        "by name are NOT touched — they keep the orphan name "
        "reference and will produce orphan attributes at entity-"
        "creation time until the seed is updated or the list is "
        "re-created with the same name.\n\n"
        "The `preset_list` arg accepts UUID or exact (case-"
        "insensitive) name. Requires both an active MCP session AND "
        "a per-action approval from the user. Returns "
        "`{ id, name }` of the deleted preset list on success."
    ),
)
async def delete_preset_list(preset_list: str) -> dict:
    return await _proxy_destructive_tool(
        "delete_preset_list",
        {"preset_list": preset_list},
        action="delete",
        object_type="preset_list",
        object_name=preset_list,
        detail=(
            "Removes the preset list from the project. Every entity "
            "attribute and relationship participant role referencing "
            "this list by id has its `preset_list_id` cleared (last "
            "value preserved as free-form text). Seed stubs that "
            "name-reference the list are not touched. Cannot be "
            "undone via MCP."
        ),
    )


# ── Project Tag reads (Phase 3.4g Line 1) ───────────────────────────────
#
# Read-side surface for the single-pool tag system. Project Tags are
# flat pool entries `{ id, name, color }` stored at the story level
# (`Story.project_tags`); host attach / detach lives on each
# chain-trackable host's `tag_ids` baseline + `tag_changes` chain
# history (Phase 3.4a). Program Tags (per-host string lists on
# Context Cues + Conversations) are NOT exposed via MCP — the MCP
# client sees one tag system, named simply "tag".


@mcp.tool(
    name="list_tags",
    description=(
        "List every tag in the project's tag pool. Returns "
        "`{ tags: [...] }` where each entry is `{ id, name, color }`. "
        "Use this for orientation before referencing a tag by name "
        "anywhere else the MCP surface accepts a `tag` arg, OR before "
        "calling `add_tags` / `remove_tags` to attach existing pool "
        "entries to hosts. Read-only — does NOT require an active "
        "MCP session."
    ),
)
async def list_tags() -> dict:
    return await _proxy_tool("list_tags", {})


@mcp.tool(
    name="get_tag",
    description=(
        "Fetch one tag's full state. The `tag` arg accepts EITHER a "
        "UUID OR an exact (case-insensitive) name. A leading `#` on "
        "the name is stripped before lookup so `#magic` and `magic` "
        "resolve identically. Returns the same shape `list_tags` "
        "produces per entry. Read-only — does NOT require an active "
        "MCP session."
    ),
)
async def get_tag(tag: str) -> dict:
    return await _proxy_tool("get_tag", {"tag": tag})


# ── Project Tag pool CRUD (Phase 3.4g Line 2) ───────────────────────────


@mcp.tool(
    name="create_tag",
    description=(
        "Mint a new tag in the project's tag pool, with optional batch "
        "origin-attach to one or more chain-trackable hosts.\n\n"
        "Args:\n"
        "  name — required. Tag name. A leading `#` is stripped at "
        "write time. Case-insensitive uniqueness: if a tag with this "
        "name (case-insensitive) already exists, the EXISTING entry "
        "is returned and `created: false` is set in the response — "
        "the call is a find-or-create, never an error on collision.\n"
        "  color — optional hex string. Defaults to '#888888' (NN's "
        "neutral) when omitted.\n"
        "  attach_to — optional list of host references. **Omitted or "
        "empty list = no attach** (just mints / finds the pool entry). "
        "**Non-empty = batch-attaches the tag at EACH host's ORIGIN** "
        "(baseline `tag_ids` write, never a chain event — for "
        "chain-anchor attaches use `add_tags(host, [tag], at=<scene>)` "
        "after this call). Per-item polymorphic: bare string (UUID or "
        "exact case-insensitive name, resolved across "
        "character / location / item / faction / custom / knowledge / "
        "relationship / referenceNode pools, errors on ambiguity) OR "
        "`{ kind, ref }` for explicit disambiguation. Pre-validated "
        "upfront — bad host refs reject the whole call before any "
        "write lands. Idempotent on per-host already-attached "
        "(returns `already_attached: true` for that host without "
        "writing).\n\n"
        "Returns `{ tag: { id, name, color, created } }`. When "
        "`attach_to` was supplied, ALSO returns "
        "`attached_to: [{ host_id, host_kind, host_name, "
        "already_attached }, ...]` in matching order. Requires an "
        "active MCP session."
    ),
)
async def create_tag(
    name: str,
    color: Optional[str] = None,
    attach_to: Optional[list[Any]] = None,
) -> dict:
    args: dict[str, Any] = {"name": name}
    if color is not None: args["color"] = color
    if attach_to is not None: args["attach_to"] = attach_to
    return await _proxy_write_tool("create_tag", args)


@mcp.tool(
    name="update_tag",
    description=(
        "Rename and/or recolour a tag pool entry. At least one of "
        "`name` / `color` is required.\n\n"
        "Args:\n"
        "  tag — required. UUID OR exact (case-insensitive) name of "
        "the pool entry to update. A leading `#` on a name ref is "
        "stripped before lookup.\n"
        "  name — optional new name. Stripped of leading `#` and "
        "trimmed. Case-insensitive uniqueness checked against OTHER "
        "pool entries — rejecting with a clear message if the new "
        "name collides.\n"
        "  color — optional new hex string.\n\n"
        "Propagation is by id reference: every host carrying this tag "
        "id continues to do so; the new name / colour surfaces on "
        "every render without any host walk. Returns "
        "`{ id, name, color, affected_host_count }` where the count "
        "is the distinct-host count across baseline `tag_ids` + every "
        "chain `tag_changes.add` event referencing this tag id. "
        "Requires an active MCP session."
    ),
)
async def update_tag(
    tag: str,
    name: Optional[str] = None,
    color: Optional[str] = None,
) -> dict:
    args: dict[str, Any] = {"tag": tag}
    if name is not None: args["name"] = name
    if color is not None: args["color"] = color
    return await _proxy_write_tool("update_tag", args)


@mcp.tool(
    name="delete_tag",
    description=(
        "Delete a tag pool entry AND cascade-strip every reference "
        "from every host (baseline `tag_ids` lists + every "
        "`tag_changes.add` chain event referencing this tag id). "
        "DESTRUCTIVE — requires an active MCP session AND user "
        "approval via the destructive-action gate.\n\n"
        "Args:\n"
        "  tag — required. UUID OR exact (case-insensitive) name of "
        "the pool entry to delete. A leading `#` on a name ref is "
        "stripped before lookup.\n\n"
        "Returns `{ id, name, affected_host_count, affected_hosts }` "
        "where `affected_hosts` is a sample list of "
        "`{ kind, id, name }` for up to the first 10 hosts that "
        "carried this tag. When the total exceeds 10, "
        "`affected_hosts_truncated: true` and "
        "`affected_hosts_total: <count>` are also set so the MCP "
        "client knows the sample is partial. Cannot be undone via MCP."
    ),
)
async def delete_tag(tag: str) -> dict:
    return await _proxy_destructive_tool(
        "delete_tag",
        {"tag": tag},
        action="delete",
        object_type="tag",
        object_name=tag,
        detail=(
            "Removes the tag from the project pool AND strips every "
            "reference from every host — baseline tag_ids lists on "
            "entities / knowledge / relationships / reference nodes / "
            "preset lists, plus every tag_changes chain event "
            "referencing the tag id on EntityRefs / modifier "
            "EntityNodes / knowledge history / relationship history. "
            "Cannot be undone via MCP."
        ),
    )


# ── Project Tag host attach / detach (Phase 3.4g Line 3) ────────────────


@mcp.tool(
    name="add_tags",
    description=(
        "Batch-attach one or more tags to a single host (entity / "
        "knowledge / relationship / reference node) in one call. "
        "Mirrors the alias `add_aliases` shape.\n\n"
        "Args:\n"
        "  host — required. Reference to the target host. UUID "
        "resolves directly across all chain-trackable host pools. "
        "Bare names resolve case-insensitively across pools; "
        "ambiguous matches error with attribution.\n"
        "  tags — required, non-empty list. Per-item polymorphic:\n"
        "    • bare string → tag name; `#`-stripped, case-"
        "insensitive find-or-create against the pool. Mints a new "
        "pool entry with default colour '#888888' on no match.\n"
        "    • `{id: <uuid>}` → existing pool entry by id.\n"
        "    • `{name, color?}` → find-or-create by name with an "
        "explicit colour when minting (ignored when the name "
        "resolves to an existing entry — the existing colour is "
        "preserved).\n"
        "  at — optional anchor:\n"
        "    • omitted / null / 'origin' → BASELINE write on the "
        "host's `tag_ids`. For Reference Nodes this is the only "
        "supported path (baseline-only, no chain history).\n"
        "    • scene UUID or exact (case-insensitive) title → "
        "records an `action='add'` chain event on the host's chain "
        "carrier. For entity hosts: auto-adds the entity chip to "
        "the scene with D2 auto-wire if not already present (same "
        "pattern as `add_aliases`). For Knowledge / Relationship: "
        "the chain event lives on the host's own history.\n\n"
        "Pre-validation upfront — empty names, within-batch "
        "duplicates, bad refs all rejected with `tags[N]: ...` "
        "attribution BEFORE any pool mint OR host write commits. "
        "Idempotent on already-attached: per-tag "
        "`already_attached: true` in the return without writing.\n\n"
        "**No `track_as_knowledge` arg** — tags are metadata, not "
        "story facts.\n\n"
        "Returns `{ host_id, host_kind, host_name, tags: [{ id, "
        "name, color, created, already_attached }, ...] }` on "
        "origin path. Scene path additionally carries `scene_id`, "
        "`scene_title`, `chain_actions: ['add' | 'noop', ...]`. "
        "Requires an active MCP session."
    ),
)
async def add_tags(
    host: str,
    tags: list[Any],
    at: Optional[str] = None,
) -> dict:
    args: dict[str, Any] = {"host": host, "tags": tags}
    if at is not None: args["at"] = at
    return await _proxy_write_tool("add_tags", args)


@mcp.tool(
    name="remove_tags",
    description=(
        "Batch-detach one or more tags from a single host. Mirror of "
        "`add_tags`. Same `host` + `tags[]` polymorphism, same `at?` "
        "routing.\n\n"
        "Args:\n"
        "  host — required, same shape as `add_tags`.\n"
        "  tags — required, non-empty list. **Strict resolution** — "
        "unknown names (no pool entry) reject with `tags[N]: ...` "
        "attribution. There is no find-or-create on the remove side; "
        "you can't detach a tag that doesn't exist.\n"
        "  at — optional anchor; same routing as `add_tags`. For "
        "Reference Nodes `at` MUST be omitted (baseline-only).\n\n"
        "Idempotent on was-not-attached: per-tag `was_attached: "
        "false` in the return without writing. Idempotent on the "
        "remove side via the chain-event pair-cancel rule too — "
        "writing `remove@N` against an existing `add@N` for the "
        "same tag strips both events.\n\n"
        "**Auto-cleanup of orphaned tags**: when a detach drops a "
        "tag's host count from `>0` to `0`, the pool entry is "
        "silently deleted (per-tag `pool_deleted: true` set in the "
        "return). No popup, no confirmation. Re-attaching the same "
        "name later mints a NEW pool entry with a new id; prior "
        "chain events referencing the deleted id become dangling "
        "and the walker tolerates them defensively. Pool cleanup "
        "is permanent — undo via MCP is not available.\n\n"
        "Returns `{ host_id, host_kind, host_name, tags: [{ id, "
        "name, color, was_attached, pool_deleted? }, ...] }`. Scene "
        "path additionally carries `scene_id`, `scene_title`, "
        "`chain_actions: ['remove' | 'noop', ...]`. Requires an "
        "active MCP session."
    ),
)
async def remove_tags(
    host: str,
    tags: list[Any],
    at: Optional[str] = None,
) -> dict:
    args: dict[str, Any] = {"host": host, "tags": tags}
    if at is not None: args["at"] = at
    return await _proxy_write_tool("remove_tags", args)


# ── Custom category CRUD + reads ────────────────────────────────────────
#
# Custom categories are fungible templates that Custom entities belong
# to (e.g. a "Goblins" category for multiple goblin instances). Story-
# level configuration, not chain-tracked. Required by `create_entity`
# when `type='custom'` — pre-this-cluster the MCP surface could
# REFERENCE existing categories but couldn't mint new ones, leaving
# Custom entities unreachable from MCP. Tools route through the
# frontend's canonical entitiesStore actions so cross-reference
# housekeeping (ref-stripping on delete) stays in lockstep with the
# UI flow.


@mcp.tool(
    name="list_alerts",
    description=(
        "Return the same workflow alerts the writer sees in the sidebar "
        "Alerts panel. Lets an AI agent discover what needs cleanup in "
        "the project (uninstantiated entities, orphaned perspectives, "
        "POV chain gaps, awareness contradictions, etc.) without having "
        "to walk the project itself.\n\n"
        "Args:\n"
        "  type — optional alert-type filter (string). Returns only "
        "alerts whose `type` field equals this value. Omit to get the "
        "full set. Common types: 'uninstantiated', 'knowledge_uninstantiated', "
        "'orphaned', 'review', 'pov_no_origin', 'pov_no_character', "
        "'pov_disconnected', 'pov_chapter_order', 'flashback_no_parent', "
        "'uncategorized_custom', 'orphaned_perspective_target', "
        "'relationship_solo', 'relationship_downstream_overlap', "
        "'awareness_membership_change', "
        "'awareness_alias_entity_inconsistency'.\n\n"
        "Returns `{ count, total, type_filter, alerts: [...] }`. Each "
        "alert carries an `id`, a `type`, and type-specific payload "
        "fields (entity id / name, node id, perspective id + "
        "description, etc.) that identify the host object the writer "
        "would land on by clicking the alert. Read-only — does NOT "
        "require an active MCP session.\n\n"
        "Use this to triage a project before authoring: call "
        "list_alerts() with no filter, scan the result, then drill in "
        "with `get_entity(at=...)` / `get_knowledge(at=...)` / "
        "`get_relationship(at=...)` on the offending objects to "
        "investigate or fix. The Alerts panel updates derive from the "
        "same computation — there is no drift between what the writer "
        "sees and what this tool returns."
    ),
)
async def list_alerts(type: Optional[str] = None) -> dict:
    args: dict[str, Any] = {}
    if type is not None: args["type"] = type
    return await _proxy_tool("list_alerts", args)


@mcp.tool(
    name="list_custom_categories",
    description=(
        "List every custom category in the project. Returns "
        "`{ custom_categories: [...] }` where each entry is "
        "`{ id, name, description }`. Use this for orientation before "
        "referencing a category by name in `create_entity(type='custom', "
        "category=...)`. Read-only — does NOT require an active MCP "
        "session."
    ),
)
async def list_custom_categories() -> dict:
    return await _proxy_tool("list_custom_categories", {})


@mcp.tool(
    name="get_custom_category",
    description=(
        "Fetch one custom category's full state. The `custom_category` "
        "arg accepts EITHER a UUID OR an exact (case-insensitive) name. "
        "Returns the same shape `list_custom_categories` produces per "
        "entry. Read-only — does NOT require an active MCP session."
    ),
)
async def get_custom_category(custom_category: str) -> dict:
    return await _proxy_tool("get_custom_category", {"custom_category": custom_category})


@mcp.tool(
    name="create_custom_category",
    description=(
        "Create a new custom category. `name` is required and must be "
        "unique within the project (case-insensitive — names are the "
        "stable identifier `create_entity` uses when picking a "
        "category). Optional: `description`, `colour` (hex, e.g. "
        "'#4488cc'; the category's display tint), `profile_image_ref` "
        "(an asset ref for the category avatar). Returns the new "
        "category's projection. Requires an active MCP session. "
        "Non-destructive."
    ),
)
async def create_custom_category(
    name: str,
    description: Optional[str] = None,
    colour: Optional[str] = None,
    profile_image_ref: Optional[str] = None,
) -> dict:
    args: dict[str, Any] = {"name": name}
    if description is not None: args["description"] = description
    if colour is not None: args["colour"] = colour
    if profile_image_ref is not None: args["profile_image_ref"] = profile_image_ref
    return await _proxy_write_tool("create_custom_category", args)


@mcp.tool(
    name="update_custom_category",
    description=(
        "Update a custom category's name, description, colour, and/or "
        "profile image. Pass at least one editable field — calling with "
        "none errors. The `custom_category` arg accepts UUID or exact "
        "(case-insensitive) name. Renames are rejected when another "
        "category already uses the new name (Custom entities + "
        "`create_entity` reference categories by name; duplicates would "
        "make those references ambiguous). `colour` is a hex string; "
        "`profile_image_ref` is an asset ref (empty string clears it). "
        "Returns the updated category's projection. Requires an active "
        "MCP session. Non-destructive."
    ),
)
async def update_custom_category(
    custom_category: str,
    name: Optional[str] = None,
    description: Optional[str] = None,
    colour: Optional[str] = None,
    profile_image_ref: Optional[str] = None,
) -> dict:
    args: dict[str, Any] = {"custom_category": custom_category}
    if name is not None: args["name"] = name
    if description is not None: args["description"] = description
    if colour is not None: args["colour"] = colour
    if profile_image_ref is not None: args["profile_image_ref"] = profile_image_ref
    return await _proxy_write_tool("update_custom_category", args)


@mcp.tool(
    name="delete_custom_category",
    description=(
        "Delete a custom category. DESTRUCTIVE — routes through the "
        "project's custom-category-delete path and CANNOT be undone "
        "via the MCP API. Side effect: any Custom entity whose "
        "`category_id` pointed at this category has that field "
        "cleared (the entity itself survives as an uncategorised "
        "custom — still valid, just no longer typed by this template). "
        "The `custom_category` arg accepts UUID or exact (case-"
        "insensitive) name. Requires both an active MCP session AND "
        "a per-action approval from the user. Returns `{ id, name }` "
        "of the deleted category on success."
    ),
)
async def delete_custom_category(custom_category: str) -> dict:
    return await _proxy_destructive_tool(
        "delete_custom_category",
        {"custom_category": custom_category},
        action="delete",
        object_type="custom_category",
        object_name=custom_category,
        detail=(
            "Removes the custom category from the project. Any Custom "
            "entity whose category_id pointed at this category has "
            "that field cleared (entity survives as uncategorised). "
            "Cannot be undone via MCP."
        ),
    )


# ── Story seed CRUD + reads ─────────────────────────────────────────────
#
# Story seeds are per-entity-type attribute templates that auto-attach
# to newly-created entities of that type (e.g. a "Gender" preset
# attribute on every new character). They're story-level configuration
# (not chain-tracked) — adding / removing a seed only affects FUTURE
# entity creations, not entities that already exist with seeded
# attributes.
#
# Implementation is backend-only — seeds aren't held in any frontend
# state, so there's no frontend store action to route through. Each
# tool reads / writes `state.get_seeds()` / `state.set_seeds()`
# directly, then bumps the session tool-call counter to keep the
# toolbar badge accurate.
#
# Seeds reference preset lists by NAME (not UUID) per the model — so
# the seed file is portable across projects. The MCP tools don't
# validate that the referenced preset list exists; an orphan reference
# is tolerated by the apply path (orphan-warns at stderr + creates
# an attribute with `preset_list_id = null`). The AI can fix this by
# either (a) creating the missing preset list via `create_preset_list`
# OR (b) updating the seed to reference an existing list OR (c)
# changing the seed's `attribute_type` to a non-preset type.


# SeedAttributeTypeLiteral, AwarenessScale, and RelationshipStatus
# definitions moved to the top of this module alongside EntityType /
# LookupType / AttributeType so they're in scope when any earlier-defined
# @mcp.tool decorator's get_type_hints() evaluates an annotation that
# references them. Keeping them at the bottom would NameError at
# decoration time under `from __future__ import annotations`.


def _require_active_mcp_session(tool_name: str) -> None:
    """Mirror of `_proxy_write_tool`'s session gate for backend-only
    tools that don't proxy through the bridge. Raises the same
    `[session_not_active]` RuntimeError shape so MCP clients see a
    consistent error envelope regardless of which write path they
    hit. Call at the top of every backend-only write tool."""
    if session_manager.state != "active":
        raise RuntimeError(
            f"[session_not_active] Write tool {tool_name!r} requires an "
            f"active MCP control session. Call "
            f"request_mcp_session(purpose=...) first to ask the user "
            f"for permission. Current session state: "
            f"{session_manager.state!r}."
        )


def _project_seed_stub(stub) -> dict:
    """Project a SeedStub for MCP return shapes. Mirrors the inline
    projection in `get_project_summary.story_seeds` so the seed CRUD
    tools and the project summary return identical per-stub shapes."""
    out: dict[str, Any] = {
        "name": stub.name,
        "attribute_type": stub.attribute_type,
    }
    if stub.default_value is not None:
        out["default_value"] = stub.default_value
    if stub.preset_list_name:
        out["preset_list_name"] = stub.preset_list_name
    return out


@mcp.tool(
    name="list_story_seeds",
    description=(
        "List the project's story seeds — the per-entity-type attribute "
        "templates that auto-attach to newly-created entities of that "
        "type. Optional `entity_type` arg filters to one type "
        "(character / location / item / faction / custom).\n\n"
        "Returns a dict keyed by entity type, each value an array of "
        "`{ name, attribute_type, default_value?, preset_list_name? }` "
        "stubs. Empty arrays for types with no seeds. Read-only — "
        "does NOT require an active MCP session."
    ),
)
async def list_story_seeds(
    entity_type: Optional[EntityType] = None,
) -> dict:
    from state import get_seeds as _state_get_seeds, set_seeds as _state_set_seeds
    seeds_file = _state_get_seeds()
    # EntityType is Annotated[Literal[...], BeforeValidator], so its raw
    # values are two get_args deep (unwrap the Annotated, then the Literal).
    # A prior `list(EntityType.__args__)` grabbed the Literal alias itself as
    # a "type" and crashed getattr below with '_LiteralGenericAlias'.
    types = [entity_type] if entity_type else list(get_args(get_args(EntityType)[0]))
    out: dict[str, list] = {}
    for t in types:
        stubs = getattr(seeds_file.seeds, t, None) or []
        out[t] = [_project_seed_stub(s) for s in stubs]
    return out


@mcp.tool(
    name="add_story_seed",
    description=(
        "Add a new attribute-template stub to the story seeds for one "
        "entity type. Every entity subsequently created of that type "
        "will automatically have an attribute generated from this "
        "stub.\n\n"
        "Args:\n"
        "  - `entity_type` (required): character / location / item / "
        "faction / custom.\n"
        "  - `name` (required): the attribute's display name. Must be "
        "unique within this entity type's seed list (case-insensitive).\n"
        "  - `attribute_type` (required): one of text / file / preset "
        "/ entity_list / text_list / circumstance / motivator / number.\n"
        "  - `default_value` (optional): initial value for the seeded "
        "attribute. Type-dependent meaning (e.g. the default string "
        "for `text`, the default selected value for `preset`).\n"
        "  - `preset_list` (optional, REQUIRED when "
        "attribute_type='preset'): name of the preset list the seeded "
        "attribute will reference. Name-based per the model (seeds are "
        "portable across projects); orphan references are tolerated "
        "(orphan-warn at entity-creation time) but the AI is expected "
        "to call `create_preset_list` first if needed.\n\n"
        "Affects only FUTURE entity creations — existing entities are "
        "not modified. Returns the new seed stub's projection. "
        "Requires an active MCP session. Non-destructive."
    ),
)
async def add_story_seed(
    entity_type: EntityType,
    name: str,
    attribute_type: SeedAttributeTypeLiteral,
    default_value: Optional[str] = None,
    preset_list: Optional[str] = None,
) -> dict:
    _require_active_mcp_session("add_story_seed")
    from state import get_seeds as _state_get_seeds, set_seeds as _state_set_seeds
    from models.seeds import SeedStub
    if attribute_type == "preset" and not preset_list:
        raise RuntimeError(
            "preset_list is required when attribute_type='preset' "
            "(seeded preset attributes need a list to pick from). "
            "Pass the preset list's name."
        )
    seeds_file = _state_get_seeds()
    stubs = list(getattr(seeds_file.seeds, entity_type) or [])
    name_lower = name.strip().lower()
    if not name_lower:
        raise RuntimeError("[empty_value] `name` cannot be empty.")
    if any((s.name or "").lower() == name_lower for s in stubs):
        raise RuntimeError(
            f"a seed with name {name!r} already exists for "
            f"entity_type={entity_type!r}. Names are case-insensitive "
            f"within a type; pick a unique name or call "
            f"update_story_seed to modify the existing one."
        )
    new_stub = SeedStub(
        name=name.strip(),
        attribute_type=attribute_type,
        default_value=default_value,
        preset_list_name=preset_list or None,
    )
    stubs.append(new_stub)
    setattr(seeds_file.seeds, entity_type, stubs)
    _state_set_seeds(seeds_file)
    session_manager.log_tool_call({"name": "add_story_seed", "args": {
        "entity_type": entity_type, "name": name,
    }})
    return _project_seed_stub(new_stub)


@mcp.tool(
    name="update_story_seed",
    description=(
        "Update an existing story seed stub. Pass at least one "
        "editable field (`new_name` / `attribute_type` / "
        "`default_value` / `preset_list`) — calling with only the "
        "identity args errors.\n\n"
        "Args:\n"
        "  - `entity_type` (required): character / location / item / "
        "faction / custom.\n"
        "  - `seed` (required): the existing seed's name (case-"
        "insensitive) within the entity type's seed list.\n"
        "  - `new_name` (optional): rename the seed. Must be unique "
        "within the entity type.\n"
        "  - `attribute_type` (optional): change the attribute type. "
        "When changing TO 'preset', `preset_list` becomes required. "
        "When changing AWAY FROM 'preset', the existing "
        "preset_list_name is cleared automatically.\n"
        "  - `default_value` (optional): change the default value. "
        "Pass empty string to clear.\n"
        "  - `preset_list` (optional): change the preset list "
        "reference. Pass empty string to clear (only valid when "
        "attribute_type is not 'preset').\n\n"
        "Affects only FUTURE entity creations. Returns the updated "
        "stub projection. Requires an active MCP session. Non-"
        "destructive."
    ),
)
async def update_story_seed(
    entity_type: EntityType,
    seed: str,
    new_name: Optional[str] = None,
    attribute_type: Optional[SeedAttributeTypeLiteral] = None,
    default_value: Optional[str] = None,
    preset_list: Optional[str] = None,
) -> dict:
    _require_active_mcp_session("update_story_seed")
    if (
        new_name is None
        and attribute_type is None
        and default_value is None
        and preset_list is None
    ):
        raise RuntimeError(
            "update_story_seed requires at least one of: new_name, "
            "attribute_type, default_value, preset_list."
        )
    from state import get_seeds as _state_get_seeds, set_seeds as _state_set_seeds
    from models.seeds import SeedStub
    seeds_file = _state_get_seeds()
    stubs = list(getattr(seeds_file.seeds, entity_type) or [])
    seed_lower = seed.strip().lower()
    idx = next(
        (i for i, s in enumerate(stubs) if (s.name or "").lower() == seed_lower),
        -1,
    )
    if idx < 0:
        raise RuntimeError(
            f"seed {seed!r} not found for entity_type={entity_type!r}. "
            f"Call list_story_seeds to see what's there."
        )
    existing = stubs[idx]
    # Build the updated stub field by field. Defaulting unchanged
    # fields lets the AI pass partial updates without re-stating
    # everything.
    next_name = existing.name
    if new_name is not None:
        next_name_clean = new_name.strip()
        if not next_name_clean:
            raise RuntimeError("[empty_value] `new_name` cannot be empty.")
        next_name_lower = next_name_clean.lower()
        if any(
            (s.name or "").lower() == next_name_lower
            for i, s in enumerate(stubs) if i != idx
        ):
            raise RuntimeError(
                f"a seed with name {new_name!r} already exists for "
                f"entity_type={entity_type!r}. Pick a unique name."
            )
        next_name = next_name_clean
    next_attribute_type = attribute_type or existing.attribute_type
    next_default_value = (
        existing.default_value
        if default_value is None
        else (default_value or None)  # empty string clears
    )
    # preset_list_name handling:
    #   - attribute_type='preset' → required. If `preset_list` passed,
    #     use it; else carry forward existing (which must be non-None
    #     since the existing stub was valid).
    #   - other types → clear automatically (don't carry forward).
    if next_attribute_type == "preset":
        if preset_list is None:
            next_preset_list_name = existing.preset_list_name
        else:
            next_preset_list_name = preset_list or None
        if not next_preset_list_name:
            raise RuntimeError(
                "preset_list is required when attribute_type='preset'."
            )
    else:
        next_preset_list_name = None
    next_stub = SeedStub(
        name=next_name,
        attribute_type=next_attribute_type,
        default_value=next_default_value,
        preset_list_name=next_preset_list_name,
    )
    stubs[idx] = next_stub
    setattr(seeds_file.seeds, entity_type, stubs)
    _state_set_seeds(seeds_file)
    session_manager.log_tool_call({"name": "update_story_seed", "args": {
        "entity_type": entity_type, "seed": seed,
    }})
    return _project_seed_stub(next_stub)


@mcp.tool(
    name="remove_story_seed",
    description=(
        "Remove a story seed stub from one entity type's seed list. "
        "Affects only FUTURE entity creations — entities that "
        "already have a seeded attribute from this stub keep it (the "
        "attribute is just an ordinary attribute on those entities "
        "and can be edited / removed individually via the attribute "
        "tools).\n\n"
        "Args:\n"
        "  - `entity_type` (required): character / location / item / "
        "faction / custom.\n"
        "  - `seed` (required): the existing seed's name (case-"
        "insensitive) within the entity type's seed list.\n\n"
        "Returns `{ entity_type, name }` of the removed stub. Not "
        "routed through the destructive-approval modal — removing a "
        "seed is a config change with no scene-wide cascade. "
        "Requires an active MCP session."
    ),
)
async def remove_story_seed(
    entity_type: EntityType,
    seed: str,
) -> dict:
    _require_active_mcp_session("remove_story_seed")
    from state import get_seeds as _state_get_seeds, set_seeds as _state_set_seeds
    seeds_file = _state_get_seeds()
    stubs = list(getattr(seeds_file.seeds, entity_type) or [])
    seed_lower = seed.strip().lower()
    idx = next(
        (i for i, s in enumerate(stubs) if (s.name or "").lower() == seed_lower),
        -1,
    )
    if idx < 0:
        raise RuntimeError(
            f"seed {seed!r} not found for entity_type={entity_type!r}. "
            f"Call list_story_seeds to see what's there."
        )
    removed = stubs.pop(idx)
    setattr(seeds_file.seeds, entity_type, stubs)
    _state_set_seeds(seeds_file)
    session_manager.log_tool_call({"name": "remove_story_seed", "args": {
        "entity_type": entity_type, "seed": seed,
    }})
    return {"entity_type": entity_type, "name": removed.name}


# ── Workflow guides ───────────────────────────────────────────────────
#
# Workflow guides live as Markdown files under
# `backend/services/mcp_workflows/`. Each file is a self-contained
# "how to use the MCP surface for <X>" reference written for an AI
# client (or curious human) to read on demand. The tools below let an
# MCP client discover and fetch them without needing to know they're
# on disk — surfaced as plain MCP read tools (no session required).
#
# Adding a new guide: drop a new `<name>.md` file into the directory.
# First H1 line + first paragraph after it become the summary in
# `list_workflows()`. No code change needed.


from pathlib import Path as _WorkflowPath


def _workflows_dir() -> _WorkflowPath:
    # Resolve relative to THIS module so it works regardless of CWD.
    return _WorkflowPath(__file__).resolve().parent / "mcp_workflows"


def _parse_workflow_summary(text: str) -> str:
    # First H1 title + first non-empty paragraph after it. Strips the
    # leading "# " from the title and stops the summary at the first
    # blank line after the paragraph begins. Returns a short blurb
    # suitable for a tool-catalogue listing.
    lines = text.splitlines()
    summary_parts: list[str] = []
    in_paragraph = False
    seen_h1 = False
    for raw in lines:
        line = raw.strip()
        if not seen_h1:
            if line.startswith("# "):
                seen_h1 = True
            continue
        if not in_paragraph:
            if not line:
                continue
            if line.startswith("#") or line.startswith("---"):
                # No paragraph before next heading / hr — bail out.
                break
            in_paragraph = True
            summary_parts.append(line)
        else:
            if not line:
                break
            if line.startswith("#") or line.startswith("---"):
                break
            summary_parts.append(line)
    return " ".join(summary_parts).strip()


@mcp.tool(
    name="list_workflows",
    description=(
        "List the workflow guides available on this MCP server. Each "
        "guide is a self-contained reference for how to use the MCP "
        "surface to accomplish a specific authoring task (e.g. "
        "'plot planning', 'world setup', 'prose writing', "
        "'knowledge tracking'). The guides are written for an MCP "
        "client to read on demand.\n\n"
        "Returns `{ workflows: [{ name, summary }, ...] }`. Use "
        "`name` as the argument to `get_workflow_guide(name=...)` to "
        "fetch the full guide content.\n\n"
        "This is the recommended way to orient before doing serious "
        "authoring work — the guides describe the expected cadence of "
        "tool calls, when to use origin-baseline vs scene-anchored "
        "writes, and patterns the surface assumes the client knows. "
        "No session required."
    ),
)
async def list_workflows() -> dict:
    directory = _workflows_dir()
    if not directory.is_dir():
        return {"workflows": []}
    workflows: list[dict] = []
    for path in sorted(directory.glob("*.md")):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        summary = _parse_workflow_summary(text)
        workflows.append({
            "name": path.stem,
            "summary": summary,
        })
    return {"workflows": workflows}


@mcp.tool(
    name="get_workflow_guide",
    description=(
        "Fetch the full Markdown content of a named workflow guide. "
        "Call `list_workflows()` first to discover what's available.\n\n"
        "Args (pass either):\n"
        "  - `name`: the guide name as returned by `list_workflows()` "
        "(filename without the `.md` extension).\n"
        "  - `workflow`: alias for `name` (since 'workflow' is a more "
        "natural guess for clients).\n\n"
        "Returns `{ name, content }` on success. Raises a clean error "
        "listing the available guide names if `name` doesn't match. "
        "No session required."
    ),
)
async def get_workflow_guide(
    name: Optional[str] = None,
    workflow: Optional[str] = None,
) -> dict:
    # Accept `workflow` as an alias for `name` — surfaced 2026-05-18
    # in the blind-agent rom-com test (v2): the agent's natural guess
    # was `workflow=...`, which failed three times in parallel before
    # they figured out the real arg name. The list response uses
    # `name` as the key so name is the canonical, but accepting both
    # is cheap.
    chosen = name if (name and name.strip()) else workflow
    if not chosen:
        raise RuntimeError(
            "[missing_argument] get_workflow_guide requires either "
            "`name` or `workflow` (alias) — pass one of them, e.g. "
            "`get_workflow_guide(name='plot_planning')`. Call "
            "`list_workflows()` to see available names."
        )
    directory = _workflows_dir()
    safe_name = chosen.strip()
    if not safe_name or "/" in safe_name or "\\" in safe_name or safe_name.startswith("."):
        raise RuntimeError(
            f"[invalid_workflow_name] {name!r} is not a valid workflow "
            f"name. Call list_workflows() to see available names."
        )
    path = directory / f"{safe_name}.md"
    if not path.is_file():
        available = sorted(p.stem for p in directory.glob("*.md")) if directory.is_dir() else []
        raise RuntimeError(
            f"[workflow_not_found] No workflow guide named {safe_name!r}. "
            f"Available: {available}."
        )
    try:
        content = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(
            f"[workflow_read_failed] Could not read workflow {safe_name!r}: {exc}"
        )
    return {"name": safe_name, "content": content}


# ── Per-topic tool help (Phase 7.4 Track A) ───────────────────────────────
# The shared conceptual doc-tails (awareness model, knowledge-tracking arg,
# intensity scale, circumstances, motivators) used to be concatenated into
# every relevant tool's description, shipping the same text 2-10x in the
# always-sent catalogue. They now live here ONCE and are served on demand;
# each tool description carries a one-line pointer instead.
_TOOL_HELP_TOPICS = {
    "awareness": _AWARENESS_DOC_TAIL.strip(),
    "knowledge_tracking": _TRACK_AS_KNOWLEDGE_DOC_TAIL.strip(),
    "intensity": _INTENSITY_DOC_TAIL.strip(),
    "circumstances": _CIRCUMSTANCE_DOC_TAIL.strip(),
    "motivators": _MOTIVATOR_DOC_TAIL.strip(),
    "scene_fields": (
        "Full reference for the create_scene / update_scene fields.\n\n"
        "── main_content ──\n\n" + _MAIN_CONTENT_DOC + "\n"
        + _D3D4_SCENE_DOC_TAIL
    ).strip(),
    "get_scene": (
        "Full field-by-field return shape of get_scene.\n\n"
        "── `time` block shape ──\n\n"
        "Only includes the axes the writer has pinned. Every value is "
        "a human-readable string the AI can read or echo back on a "
        "subsequent write, never a bare int.\n"
        "  - `time_of_day` , single string. Broad pins: 'day' / "
        "'night'. Labelled pins: one of the 15 canonical labels "
        "(Pre-Dawn..Midnight). Exact pins: 'HH:MM' (24-hour).\n"
        "  - `weekday` , full English day name ('Tuesday').\n"
        "  - `season` , 'Spring' / 'Summer' / 'Fall' / 'Winter'.\n"
        "  - `date` , `{ month: 'October', day: 17 }`. `day` is "
        "absent when only the month is pinned.\n"
        "  - `scene_duration` , same shape the write tools accept "
        "(`{ kind, value?, end_period?, all_day_variant? }`) plus a "
        "`display` field with the time-modal phrasing (e.g. "
        "'30 minutes', 'about 2 hours', 'all morning').\n"
        "  - `gap_extension` , `{ unit, value, display }` matching "
        "the same convention.\n"
        "  - `derived` , walker-computed chain-position info: "
        "`effective_start_minutes` (chain-relative minute count from "
        "the chain origin), `effective_start_display` "
        "('Day 6 . Late Morning'), `floor_minutes` (earliest possible "
        "start before gap_extension applied), and (when not the first "
        "scene on the chain) `time_since_prior_scene: { minutes, "
        "display, prior_scene_id, prior_scene_title }` with the gap "
        "phrased the same way the chip's leading segment and the Time "
        "Modal show the writer ('3 hours later' / 'the next day' / "
        "'right after'). `snap_forward: true` appears when the "
        "writer's pin forced the floor past midnight to honour the "
        "label; `snap_reason` (string) explains which pin caused it. "
        "The `derived` block is OMITTED entirely for off-POV-chain "
        "scenes , the walker only produces output for scenes on the "
        "POV path.\n\n"
        "── `verbose=true` mode (FULL SCENE COMPOSITE READ) ──\n\n"
        "Pass `verbose=true` to add a complete composite snapshot of "
        "the scene's narrative state in ONE call. Adds four sibling "
        "fields:\n"
        "  - `participants`: array of full chain-resolved entity "
        "shapes (same as `get_entity(entity, at=<this scene>)` per "
        "participant) including grouped `attributes` / "
        "`circumstances` / `motivators`, chain-walked name + colour, "
        "aliases, and the `chain_resolution` provenance block. "
        "`has_pov` flag carried through per entry.\n"
        "  - `entity_temporary_circumstances`: array of per-entity "
        "TEMPORARY circumstances scoped to this scene (one-off "
        "states that apply only here, distinct from chain-tracked "
        "entity circumstances on the per-entity chain). Each entry "
        "carries the owner's id + name + type.\n"
        "  - `relationships`: array of scene-resolved relationships "
        "where any participant is present at this scene (same shape "
        "as `get_relationship(rel, at=<this scene>)` per "
        "relationship).\n"
        "  - `knowledges`: array of scene-resolved knowledges (same "
        "shape as `get_knowledge(kw, at=<this scene>)` per "
        "knowledge), each carrying the CUMULATIVE awareness map at "
        "this scene (who knows what), so the dramatic-irony state "
        "is visible in one read."
    ).strip(),
    "get_entity": (
        "get_entity `chain_resolution` block (scene path only) , "
        "introspection on HOW the scene-resolved state was computed, "
        "i.e. whether the values reflect walked chain entries or just "
        "fell through to the entity's baseline.\n\n"
        "Shape: `{ reached_via: 'chain' | 'orphan', "
        "walked_through_count: int, chain_entries_applied: int, "
        "from_origin_baseline: bool, chain_entries_not_on_path: int, "
        "chain_entries_not_on_path_scenes?: [scene_id, ...] }`.\n\n"
        "Key signals:\n"
        "  - `from_origin_baseline: true` means NO chain entries were "
        "applied , the resolved state equals the entity's baseline at "
        "origin. Correct for early scenes where nothing has changed "
        "yet; suspicious when the entity has changes recorded elsewhere "
        "in the chain that the walk did not reach.\n"
        "  - `chain_entries_not_on_path > 0` is the smoking gun for a "
        "broken / origin-direct upstream wire , the entity has "
        "scene-anchored changes elsewhere in the project that this "
        "entity's wire path to the anchor does not reach. It means "
        "'these exist but are not on this entity's path', NOT 'the "
        "resolver chose to skip them'. The "
        "`chain_entries_not_on_path_scenes` list names the affected "
        "scene ids so you can either (a) fix the upstream wire, or "
        "(b) target one of those scenes directly with the `at` arg to "
        "access the intended chain entry."
    ).strip(),
    "get_entity_chain_history": (
        "get_entity_chain_history return shape , the full change-kind "
        "and lifecycle detail.\n\n"
        "Returns `{ entity_id, entity_type, origin_name, origin, "
        "history: [{ scene_id, scene_title, pov_index, changes: [...] "
        "}, ...], circumstance_lifecycle: [...], motivator_lifecycle: "
        "[...] }`. The `origin` field is the same shape "
        "`get_entity(entity)` returns (the baseline state). Each "
        "`history[i].changes[]` entry has a `kind` discriminator "
        "('name' / 'colour' / 'description' / 'profile_image' / "
        "'aliases' / 'attribute' / 'attribute_awareness' / 'awareness') "
        "and the relevant per-kind fields (e.g. `new_value` for scalar "
        "changes, `attribute` + `attribute_type` for attribute adds, "
        "`action` for modify / remove variants, `observer_id` / `level` "
        "for awareness mutations). Scenes where the entity is present "
        "but no chain change was recorded are OMITTED , this is a "
        "change history, not a presence list.\n\n"
        "── Lifecycle summaries ──\n\n"
        "The `circumstance_lifecycle` and `motivator_lifecycle` buckets "
        "answer 'is any of this stale?' without re-deriving from the "
        "flat change list. Each entry is `{ name, attribute_type, "
        "attribute_id, added_at: { origin?, scene_id?, scene_title?, "
        "pov_index? }, last_modified_at, removed_at, last_intensity, "
        "status: 'active' | 'removed' }`. Origin-baseline items have "
        "`added_at: { origin: true, ... }`; chain-added items have "
        "`added_at` carrying the scene where the add event lives. "
        "`status: 'active'` = still in effect at the last chain entry; "
        "`status: 'removed'` = a remove event has fired. Sorted by "
        "add-at story order (origin-baseline first, then chain-added). "
        "Use to scan for circumstances / motivators added early that "
        "never got updated / removed (the most common staleness pattern "
        "in long edits)."
    ).strip(),
    "get_relationship": (
        "get_relationship return shape by `at` branch.\n\n"
        "ORIGIN-BASELINE (at omitted / null / 'origin'): the "
        "relationship's baseline fields, regardless of where its origin "
        "physically lives (a scene OR a dedicated relationship origin "
        "node on the canvas; both creation patterns are supported). "
        "Returns: name, description, membership_of, participant_roles "
        "(keyed by entity_id), hierarchy, awareness_scale, "
        "participant_ids_ever (convenience), origin_node_id (the node "
        "where the relationship was created , either a scene id when "
        "scene-anchored OR a RelationshipOriginNode id otherwise), "
        "`origin_kind` ('scene' when origin_node_id resolves to a "
        "SceneNode, 'standalone' otherwise , discriminates the origin "
        "location without inspecting node types), and `scene_id: "
        "null`.\n\n"
        "SCENE-RESOLVED (at = scene UUID or exact title): walks the "
        "relationship's history (existence, participant join/leave, "
        "perception, alias-override, role, hierarchy, name, description "
        "changes) up to and including the named scene. Returns "
        "`is_active`, scene-resolved `name` / `description` / "
        "`hierarchy` / `membership_of`, plus `participants` as a single "
        "merged array of `{ entity_id, perception, alias_override, role "
        "}` per current participant (role inlined for convenience). Also "
        "returns `scene_id`, `scene_title`, `origin_node_id`, and "
        "`origin_kind` for context."
    ).strip(),
    "get_knowledge": (
        "get_knowledge return shape by `at` branch.\n\n"
        "ORIGIN-BASELINE (at omitted / null / 'origin'): the "
        "knowledge's baseline fields, regardless of where its origin "
        "physically lives (a scene if created from a scene-tracked "
        "event OR a dedicated KnowledgeOriginNode if standalone; both "
        "supported). Returns: name, description, colour, "
        "profile_image_ref, notes, awareness_scale, awareness (flat "
        "`{entity_id: level}` dict), source_event, "
        "manual_anchor_node_ids, origin_node_id (the scene id when "
        "scene-anchored, the KnowledgeOriginNode id otherwise, or null "
        "for fully standalone knowledges with no canvas node), "
        "`origin_kind` ('scene' when origin_node_id resolves to a "
        "SceneNode, 'standalone' otherwise), and `scene_id: null`.\n\n"
        "SCENE-RESOLVED (at = scene UUID or exact title): walks the "
        "knowledge's history (name / description / colour / profile "
        "image / awareness changes plus creation-point gating) up to "
        "and including the named scene. Returns the same shape as the "
        "origin path with the walked values plus `scene_id`, "
        "`scene_title`, and `not_yet_exists` (true when the knowledge "
        "has a creation anchor and `scene` is strictly before it , the "
        "knowledge had not been established yet at that point; in that "
        "case all other fields return their pre-creation null/empty "
        "defaults). `origin_kind` is also surfaced on the scene path."
    ).strip(),
    "get_knowledge_awareness_history": (
        "get_knowledge_awareness_history , per-kind field breakdown of "
        "the `events[]` array.\n\n"
        "Each event entry has a `kind` discriminator and per-kind "
        "fields:\n"
        "  - `kind: 'baseline_set'` , observer awareness set at the "
        "Knowledge's origin (one event per baseline observer). Carries "
        "`observer_id` + `observer_name` + `level` + `level_name`.\n"
        "  - `kind: 'observer_set'` , per-scene observer awareness "
        "change. Carries `observer_id`, `observer_name`, `level` (or "
        "null when clearing), `level_name`.\n"
        "  - `kind: 'tracking_on'` / `'tracking_off'` , awareness "
        "tracking enabled / disabled at this scene.\n"
        "  - `kind: 'source_change'` , propagation-source mutation "
        "(carries `action` + `source` payload).\n"
        "Every entry also carries `scene_id` + `scene_title` + "
        "`pov_index` (null for off-POV-chain scenes). Sorted by story "
        "order."
    ).strip(),
}


@mcp.tool(
    name="get_tool_help",
    description=(
        "Return the full reference for a help topic. Tool descriptions carry "
        "a terse summary plus a pointer to a topic here for the deep detail "
        "(the awareness model, the knowledge-tracking arg, intensity levels, "
        "etc.). Call this when a pointer names a topic you need the full "
        "reference for before constructing a call. Arg: `topic` (one of: "
        + ", ".join(repr(k) for k in _TOOL_HELP_TOPICS)
        + "). Returns `{ topic, content }`. No session required."
    ),
)
async def get_tool_help(topic: Optional[str] = None) -> dict:
    chosen = (topic or "").strip()
    if chosen not in _TOOL_HELP_TOPICS:
        raise RuntimeError(
            f"[unknown_topic] No help topic {chosen!r}. Available topics: "
            f"{sorted(_TOOL_HELP_TOPICS)}."
        )
    return {"topic": chosen, "content": _TOOL_HELP_TOPICS[chosen]}
