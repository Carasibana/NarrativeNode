"""Conversation persistence models — Phase 2.4h.

A conversation (a.k.a. "thread") is a single chat session: the
writer, an AI provider connection, a model, an optional system
prompt, and the ordered list of messages exchanged so far. One
JSON file per thread lives at
`preferences/conversations/{thread-id}.json` (gitignored — each
install's threads stay local until the writer opts into the
in-`.nnz` storage option, deferred).

The frontend reads the file via:
  * `GET /api/conversations`            → lightweight index (no
                                          full messages — keeps the
                                          thread browser fast even
                                          with hundreds of saved
                                          threads).
  * `GET /api/conversations/{id}`       → full Conversation.

Writes happen per message append / edit / delete via
`POST/PUT/DELETE /api/conversations/{id}/messages/...` so the
on-disk copy is crash-safe — a page refresh never loses
conversation data.
"""
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .user_preferences import AiDefaultModel


class ToolCallRecord(BaseModel):
    """One tool invocation made by the assistant during a single
    message. Captured live from the LM Studio `tool_call.*` SSE
    events and persisted on the message so the writer can audit
    what the AI actually called even after a refresh / restart.

    `status` reflects the terminal state of the call:
      'running'  → the call was opened but the stream ended before
                   a success/failure event arrived (cancelled or
                   crashed mid-call).
      'success'  → the tool returned. `output` carries the result.
      'failure'  → the tool rejected the call. `error_reason` /
                   `error_type` describe why.

    `provider_type` distinguishes between LM Studio's `ephemeral_mcp`
    (our default — the NarrativeNode MCP server is exposed this way)
    and `plugin` (locally configured MCP plugins in LM Studio).
    Other adapters can map their own provider notions onto these
    two values or add new ones later.
    """
    model_config = ConfigDict(extra="ignore")

    id: str
    tool: str
    status: Literal["running", "success", "failure"] = "running"
    provider_type: Optional[str] = None
    server_label: Optional[str] = None
    plugin_id: Optional[str] = None
    arguments: Optional[Dict[str, Any]] = None
    output: Optional[str] = None
    error_reason: Optional[str] = None
    error_type: Optional[str] = None


class SystemContextBlock(BaseModel):
    """One unit of context tracked inside a `system_context` message
    (Phase 2.5d chat-context-history).

    A `system_context` message bundles one or more of these blocks,
    each representing a per-part lifecycle event for the chat's
    context set:
      - `scene_full` / `pinned_full`     — full block content for a
        part that has been added or wholesale replaced.
      - `scene_diff` / `pinned_diff`     — content shifted for an
        existing part; renders the affected sub-block at its new
        state.
      - `scene_removed` / `pinned_removed` — the part is no longer
        in the active context set; rendered as a short one-liner
        marker in the wire.

    For pinned-* blocks, `item_kind` (the pin's kind — `entity` /
    `knowledge` / `relationship` / `scene` / `cue` / `toc` / `section`
    / `concept` / …) and `item_id` identify which item the block
    refers to. For scene-* blocks both are unset (there's only ever
    one scene part).

    `content` carries the rendered text for `*_full` and `*_diff`
    kinds and is empty / unused for `*_removed` (which renders
    its own marker text in the wire builder).
    """
    model_config = ConfigDict(extra="ignore")

    kind: Literal[
        "scene_full",
        "scene_diff",
        "scene_removed",
        "scene_switch",
        "pinned_full",
        "pinned_diff",
        "pinned_removed",
    ]
    # A plain str, NOT a restrictive Literal: `item_kind` mirrors the frontend
    # pin's kind, and new pin kinds (cue / toc / section / concept / …) must
    # never trip a save-load validation cliff. Loosened from the old
    # entity/knowledge/relationship/scene Literal, which rejected every other
    # valid kind (crashing on load of a conversation that pinned e.g. a concept).
    item_kind: Optional[str] = None
    item_id: Optional[str] = None
    content: Optional[str] = None
    # Phase 2.5d — scene identity for scene_* blocks. Used by the
    # diff computer to distinguish "same scene, content edited"
    # (emit scene_diff) from "writer switched to a different scene"
    # (emit scene_removed + scene_full so the wire reads as a clean
    # transition rather than a confusing all-fields-changed diff).
    # Older saves load with None; the diff computer falls back to
    # title comparison when the field is missing.
    scene_id: Optional[str] = None


class StoredAttachment(BaseModel):
    """Phase 2.5e — one file attached to a `ConversationMessage`.

    Persisted alongside the message so the bubble can render its
    thumbnail / chip on reload. Only images carry their bytes
    forward (as a `data:` URL inlined into the JSON, since these
    are already post-resize per the 1568 px long-edge cap the
    frontend encoder applies — typically a few hundred KB at
    most). Text and file (PDF) kinds persist metadata only: the
    text body was inlined into the model's wire view at send time
    and isn't needed for replay; the PDF likewise rode the wire
    once and doesn't need to be re-rendered in the bubble.

    `size` is the post-encoding byte count for images (the wire
    payload size) and the original picked-file size for text /
    file kinds — so the chip subtitle reflects what's meaningful
    for each."""
    model_config = ConfigDict(extra="ignore")

    kind: Literal["text", "image", "file"]
    name: str
    mime_type: str
    size: int = 0
    # Populated for `kind == 'image'` only — a `data:<mime>;base64,...`
    # URL ready for `<img src=>`. Empty / None for text and file
    # kinds (their content lives in other fields per kind).
    data_url: Optional[str] = None
    # Populated for `kind == 'text'` only — the decoded UTF-8 content
    # of the text file as the writer attached it. Used by the bubble
    # pill's click handler to open the file in the editor panel in
    # read-only mode. None for image / file kinds. Older messages
    # written before this field shipped load with None and the
    # bubble pill renders non-clickable.
    text_content: Optional[str] = None
    # Phase 2.5e — assistant-image use. When a model returns an
    # image in its response, `data_url` holds the LOCAL copy
    # (always a data URL, downloaded server-side if the upstream
    # emitted a hosted URL) and `wire_url` holds the ORIGINAL URL
    # the upstream gave us. The wire builder for subsequent turns
    # forwards `wire_url` back to the model verbatim — preserving
    # hosted-URL references where the model returned hosted URLs
    # and data URLs where it returned data URLs. None for user-
    # uploaded attachments (no upstream wire shape to preserve).
    wire_url: Optional[str] = None


class ConversationMessage(BaseModel):
    """One turn in the conversation. `role` matches what the LLM
    adapter consumes; `timestamp` is ISO 8601 in UTC. `pinned` and
    `collapsed` are per-message UI state persisted alongside the
    content so the writer's annotations survive reloads.

    `render_mode` is the writer's per-message override for the
    markdown vs raw toggle:
      None        → inherit from the conversation's `render_mode`.
      'rendered'  → force markdown rendering on this message.
      'raw'       → force plain-text on this message (so AI output
                    with tags / fenced code blocks shows verbatim).

    `tool_calls` records the MCP / plugin tool invocations the
    assistant made while producing this message — empty for user
    messages and for assistant messages produced without any tool
    use. Migrated to `[]` on load for older saves that pre-date
    the field.

    `role='system_context'` is a Phase 2.5d new role that carries
    chat-context-history blocks inline in the conversation. The
    `blocks` field bundles the per-part events emitted at this
    point in the conversation; the standard `content` is empty
    for these messages (the renderer assembles wire text from
    the blocks instead). The chat panel hides these messages from
    its inline render; the "View attached context" popover and
    the wire builder consume them.
    """
    model_config = ConfigDict(extra="ignore")

    id: str
    role: Literal["user", "assistant", "system", "system_context"]
    content: str
    timestamp: str
    pinned: bool = False
    # Phase 2.5d sticky favourite — when both `pinned` AND
    # `context_sticky` are True, the wire builder always includes
    # this message regardless of the rolling-window cap. Defaults
    # to False so older saves load with all messages sticky-off.
    # Clearing `pinned` should also clear `context_sticky` (handled
    # client-side); the field is meaningless when `pinned` is False.
    context_sticky: bool = False
    collapsed: bool = False
    render_mode: Optional[Literal["rendered", "raw"]] = None
    tool_calls: List[ToolCallRecord] = Field(default_factory=list)
    # Phase 2.5d — system_context block payload (chat-context-history
    # tracking). Populated only when `role == 'system_context'`;
    # empty list for every other role. Stored as part of the
    # message so the per-anchor context that was in force at this
    # point in the conversation survives reload and can be
    # reconstructed by the wire builder and the View Attached
    # Context popover.
    blocks: List[SystemContextBlock] = Field(default_factory=list)
    # Phase 2.5e — file attachments that rode with this user turn.
    # Populated on user messages that had attached files at send
    # time; empty for everything else. Images carry a `data_url`
    # for the bubble thumbnail; text + file kinds persist metadata
    # only (their content was inlined into the model's wire view).
    attachments: List[StoredAttachment] = Field(default_factory=list)
    # Phase 2.5f — assistant chain-of-thought / "thinking" text.
    # Populated on assistant messages when the upstream model
    # emitted reasoning during the turn; empty for everything
    # else. The bubble's disclosure widget renders this in a
    # collapsed accordion below the main content. `token_count`
    # and `duration_ms` are footer metadata for the widget; both
    # remain None for adapters that don't report them (currently
    # only LM Studio supplies the token count, only LM Studio +
    # OpenRouter supply duration). Older saves load with empty /
    # None values; the disclosure widget hides itself in that case.
    #
    # CRITICAL: these fields are display-only. They are NEVER
    # included in the `messages[]` array forwarded to the model on
    # subsequent turns — chain-of-thought is per-turn and re-feeding
    # it would both balloon prompt token count and confuse models
    # that expect their own reasoning to be theirs alone.
    reasoning_text: str = ""
    reasoning_token_count: Optional[int] = None
    reasoning_duration_ms: Optional[int] = None
    # Phase 2.5 follow-up — edit timestamp. ISO 8601 UTC, set the
    # first time the message's `content` is mutated after the
    # original send (any later edit overwrites this with the most
    # recent edit time). None means the message has never been
    # edited. The bubble header annotates "<Edited DTS>" beside the
    # role label when this is set. Older saves (pre-edit-tracking)
    # load with None — `extra="ignore"` already permits the
    # missing field; no migration needed.
    edited_at: Optional[str] = None
    # Phase 2.11b item 12 — per-turn anchor snapshot for character
    # chats. Stamped on every user / assistant message in a thread
    # whose `Conversation.character_chat` is non-null; left null
    # everywhere else (regular threads carry no anchor at all).
    # `anchor_dossier_hash` is a deterministic digest of the
    # `character_chat.anchor_spec` AT THE TIME this message was sent
    # — when two consecutive messages have different hashes, the
    # message list renders an informational re-anchor divider between
    # them so the writer can see where the lens shifted mid-thread.
    # `anchor_label` is the writer-visible span text (single → scene
    # title / "origin" / "modifier", range → "<start> to <end>", multi
    # → "<N> anchors", dynamic → "current scene") captured at send
    # time so the divider doesn't have to re-resolve the label
    # against current project state (which may have drifted).
    # Optional / default null — no save-format cliff; older messages
    # load with both fields null.
    anchor_dossier_hash: Optional[str] = None
    anchor_label: Optional[str] = None
    # Phase 2.12 — per-character anchor snapshot for two-character
    # chats. The single-character `anchor_dossier_hash` + `anchor_label`
    # above carry the SPEAKER's anchor at send time; the dicts below
    # capture the FULL state of both characters' anchors at this
    # message, keyed by `character_id`. The re-anchor divider in the
    # message list compares these dicts across consecutive messages
    # to detect which character (if any) had their anchor changed,
    # so the divider's caption can name which character was
    # re-anchored. Stamped on every persisted message in a two-
    # character thread; null on regular + single-character chats.
    # Optional / default null — older messages load with both fields
    # null; no save-format cliff.
    two_char_anchor_hashes: Optional[Dict[str, str]] = None
    two_char_anchor_labels: Optional[Dict[str, str]] = None
    # Phase 2.12 — per-message speaker attribution for two-character
    # chats. Stamped on every persisted message in a thread whose
    # `Conversation.two_character_chat` is non-null; left null
    # everywhere else (regular threads and single-character chats
    # don't carry one). Identifies which Character spoke this turn
    # via their `entity_id`. The two-character send path uses this
    # to label each prior message in the outgoing wire payload —
    # bubbles spoken by the current-turn speaker become `role:
    # 'assistant'`, bubbles spoken by the OTHER character become
    # `role: 'user'`. UI position of each bubble is also driven by
    # this field (Character 1's entity_id = assistant slot left,
    # Character 2's entity_id = user slot right; fixed regardless
    # of which character is up this turn).
    # Optional / default null — no save-format cliff; older messages
    # load unchanged and the wire-builder ignores the field when it's
    # null (regular and single-character chats keep using the existing
    # `role` field as the source of truth).
    speaker_character_id: Optional[str] = None


# ── Phase 2.11b — Character Chat metadata ─────────────────────────


class CharacterChatAnchorRange(BaseModel):
    """A range pin's anchor span: start and end chain points + the
    members locked in at selection time. `members` lets a later chain
    reorder detect when the original scene set is no longer contiguous
    and auto-split this pin into the necessary mix of range / single-
    anchor pins on next open (same shape `pinnedContextMerge.js`'s
    `reconcileRangePinsAgainstChain` already uses for chat-panel
    pinned-context entries)."""
    model_config = ConfigDict(extra="ignore")

    start_node_id: str
    end_node_id: str
    members: List[str] = Field(default_factory=list)


class CharacterChatAnchorPin(BaseModel):
    """One anchor pin in the character chat's `anchor_spec`. Matches
    the pin shapes `ChainRangeSelector` produces:
      - single   → `anchor_node_id` set, `anchor_range` null
      - range    → `anchor_range` set, `anchor_node_id` null
      - dynamic  → both null (the pin tracks the active scene at
                   send time)
    Multi-mode at the selector expands into multiple pins of the above
    shapes inside the `anchor_spec` list — one range per contiguous
    run, one single per isolated point."""
    model_config = ConfigDict(extra="ignore")

    anchor_node_id: Optional[str] = None
    anchor_range: Optional[CharacterChatAnchorRange] = None


class CharacterChatTempCM(BaseModel):
    """Phase 2.11b — conversation-scoped temporary circumstance / motivator
    captured in the Character Chat Setup modal. Shape mirrors the in-program
    Circumstance / Motivator attribute form (`name` / `description` /
    `intensity`) so the Setup modal can reuse `CircumstanceMotivatorForm`
    instead of plain textareas. At least one of `name` / `description`
    must be non-empty for the form to validate, but we don't enforce that
    here — the modal does. `intensity` is the same 0..4 ladder the
    `IntensitySlider` produces (null = unset)."""
    model_config = ConfigDict(extra="ignore")

    name: Optional[str] = None
    description: Optional[str] = None
    intensity: Optional[int] = None


def _coerce_temp_cm(v: Any) -> Any:
    """Lift legacy plaintext temp_circumstance / temp_motivator values
    (Optional[str] in v0.2.11.12..v0.2.11.15) into the new structured
    shape so already-saved conversation threads continue to load. A bare
    string becomes `{name: None, description: <str>, intensity: None}`.
    No-op for None / dict-shaped values — Pydantic handles the dict
    case via the normal `CharacterChatTempCM` constructor."""
    if isinstance(v, str):
        return {"name": None, "description": v, "intensity": None}
    return v


class CharacterChatMeta(BaseModel):
    """Phase 2.11b — metadata block on a `Conversation` that marks
    the thread as a character chat and carries the configuration the
    Setup modal captured at thread-open time. Drives header rendering,
    assistant-bubble styling, and dossier rebuild on every send.

    Temp fields (`temp_circumstance`, `temp_motivator`,
    `custom_instructions`) are conversation-scoped only — never
    persisted to the entity on the chain or to the Persona system
    prompt on disk. They feed straight into the assembly function
    (`frontend/src/utils/assembleCharacterChatSystemMessage.js`),
    where temp_circumstance / temp_motivator land inside the
    `<character_context>` block and custom_instructions renders as
    its own `<custom_instructions>` section (only when non-empty).

    `anchor_spec` is the list of pin shapes the writer locked in at
    Setup time:
      - `[]`                       → dynamic (no anchored pins; falls
                                      back to the chat's active scene)
      - one pin with `anchor_node_id`  → single
      - one pin with `anchor_range`    → range
      - multiple pins                  → multi (each pin is its own
                                                range / single segment)

    `anchor_dossier_hash` is a change-detection token for the
    re-anchor divider in the message list — when the writer re-anchors
    mid-conversation and the hash changes, the renderer inserts an
    informational divider so the writer can see where the lens shifted.

    Adding this block to a `Conversation` is the ONLY signal that
    distinguishes a character-chat thread from a regular chat thread.
    Header / bubble / send-path code branches on `character_chat is
    not None` to apply the character-mode treatments documented in
    the planning doc."""
    model_config = ConfigDict(extra="ignore")

    character_id: str
    anchor_spec: List[CharacterChatAnchorPin] = Field(default_factory=list)
    system_prompt_id: str
    model_id_override: Optional[AiDefaultModel] = None
    # Phase 2.12g+ — lists of conversation-scoped C/Ms. Each is
    # rendered separately into the `<character_context>` block at
    # send time. Default empty so existing UI / wire paths that
    # iterate continue to work without conditional guards.
    temp_circumstances: List[CharacterChatTempCM] = Field(default_factory=list)
    temp_motivators: List[CharacterChatTempCM] = Field(default_factory=list)
    custom_instructions: Optional[str] = None
    anchor_dossier_hash: Optional[str] = None

    @field_validator("temp_circumstances", "temp_motivators", mode="before")
    @classmethod
    def _coerce_temp_cm_list(cls, v: Any) -> Any:
        """Coerce each list entry's legacy plaintext shape into the
        structured shape, AND tolerate the legacy singular value (a
        single dict or string from v0.2.11.12..v0.2.12.14) by lifting
        it into a single-item list. Combines with `_migrate_singular`
        below to handle every prior on-disk shape — no save-format
        cliff per the v0.1.25.0+ rule."""
        if v is None:
            return []
        if isinstance(v, list):
            return [_coerce_temp_cm(item) for item in v]
        # Legacy singular value (string OR dict) — lift to single-item list.
        return [_coerce_temp_cm(v)]

    @model_validator(mode="before")
    @classmethod
    def _migrate_singular_temp_cm(cls, data: Any) -> Any:
        """Migrate legacy singular `temp_circumstance` / `temp_motivator`
        fields (Optional[CharacterChatTempCM] in v0.2.11.16..v0.2.12.14)
        into the new plural list fields. Pre-v0.2.11.16 plaintext
        singular values flow through `_coerce_temp_cm_list` above.
        No-op for already-migrated data shapes that carry the plural
        fields directly."""
        if not isinstance(data, dict):
            return data
        if "temp_circumstance" in data and "temp_circumstances" not in data:
            v = data.pop("temp_circumstance")
            data["temp_circumstances"] = [v] if v is not None else []
        elif "temp_circumstance" in data:
            data.pop("temp_circumstance", None)
        if "temp_motivator" in data and "temp_motivators" not in data:
            v = data.pop("temp_motivator")
            data["temp_motivators"] = [v] if v is not None else []
        elif "temp_motivator" in data:
            data.pop("temp_motivator", None)
        return data


# ── Phase 2.12 — Two-Character Chat metadata ──────────────────────


class TwoCharacterChatMeta(BaseModel):
    """Phase 2.12 — metadata block on a `Conversation` that marks the
    thread as a two-character chat (two of the writer's characters
    conversing with each other through the AI, each in their own
    chain-resolved persona, alternating turns).

    `characters` is exactly two `CharacterChatMeta` entries. The first
    (`characters[0]`) is Character 1 — assistant-side speaker in the
    UI (always renders on the left); the second (`characters[1]`) is
    Character 2 — user-side speaker (always renders on the right).
    Reuses the `CharacterChatMeta` shape verbatim so each character
    carries its own anchor_spec, persona prompt, model override, temp
    fields, custom instructions, and anchor_dossier_hash. Per-character
    independence means each can resolve at a different chain anchor
    and ride a different model.

    `next_turn_index` is a 0-or-1 pointer that single-button manual
    mode and auto-send mode use to decide which character takes the
    next turn under strict alternation. Toggles 0↔1 after each
    completed turn. Dual-button manual mode ignores this field — the
    writer picks per-click via the two `[Send to <Char>]` buttons.
    The field persists on the thread so reload picks up alternation
    where it left off.

    `composer_mode` is the writer's chosen manual mode — `'single'`
    (one Send button, strict alternation per `next_turn_index`) or
    `'dual'` (two Send buttons, writer picks per click; allows
    consecutive turns by the same character). Persists per-thread.
    Auto-send is session-only and not stored here — it's a transient
    overlay that reverts to the saved manual mode when stopped.

    UI position of each persisted message is driven by
    `ConversationMessage.speaker_character_id`, NOT by wire-role
    label. The wire-builder synthesises the appropriate `role` per
    outgoing turn — bubbles spoken by the current speaker get
    `role: 'assistant'`, bubbles spoken by the OTHER character get
    `role: 'user'`. The UI position never flips with the turn; only
    the wire payload reshuffles roles.

    Mutual exclusion: at most one of `Conversation.character_chat`
    and `Conversation.two_character_chat` is non-null on any thread.
    Code that branches on chat kind reads `two_character_chat` first,
    then falls through to `character_chat`, then defaults to regular
    chat. Setting both is a bug; the model doesn't enforce mutual
    exclusion at the type level (Pydantic optional / optional doesn't
    express that), but the thread-creation paths must guarantee it.

    Optional / default null on the parent `Conversation` — existing
    saves load unchanged. No save-format cliff under the v0.1.25.0+
    rule."""
    model_config = ConfigDict(extra="ignore")

    characters: List[CharacterChatMeta]
    next_turn_index: int = 0
    composer_mode: Literal["single", "dual"] = "single"

    @field_validator("characters")
    @classmethod
    def _validate_two_characters(cls, v: List[CharacterChatMeta]) -> List[CharacterChatMeta]:
        if len(v) != 2:
            raise ValueError(
                f"TwoCharacterChatMeta.characters must hold exactly 2 entries (got {len(v)})"
            )
        return v

    @field_validator("next_turn_index")
    @classmethod
    def _validate_turn_index(cls, v: int) -> int:
        if v not in (0, 1):
            raise ValueError(
                f"TwoCharacterChatMeta.next_turn_index must be 0 or 1 (got {v})"
            )
        return v


class Conversation(BaseModel):
    """A saved chat thread. `profile_id` / `model` /
    `system_prompt_id` are the connection metadata in force WHEN
    THE THREAD WAS CREATED — they're not necessarily the active
    selections right now. Switching to a different connection or
    model mid-thread is allowed; we just record the new values on
    the next message append (deferred polish — for the first cut
    we keep the original metadata stable for the lifetime of the
    thread)."""
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    created_at: str
    updated_at: str
    profile_id: Optional[str] = None
    model: Optional[str] = None
    system_prompt_id: Optional[str] = None
    # Conversation-level markdown rendering default. Applies to
    # every message in the thread unless overridden per-message via
    # `ConversationMessage.render_mode`. None = 'rendered' (the
    # default). Switching the conversation default re-themes every
    # un-overridden message at once.
    render_mode: Optional[Literal["rendered", "raw"]] = None
    # Phase 2.4f — thread browser metadata.
    # `pinned_in_browser` keeps the thread at the top of whatever
    # tab it appears in. Distinct from `ConversationMessage.pinned`
    # (per-message Favourite); naming spells out the scope so the
    # two never get conflated. Defaults to False on older saves.
    pinned_in_browser: bool = False
    # Phase 2.6 — story linkage + tagging.
    # `story_id` is the UUID of the story this thread belongs to.
    # Immutable from creation: stamped to `state.get_story().id` on
    # first save and never changed by program code thereafter. Story
    # renames don't touch it (only `story.title` changes). None = the
    # thread was created with no project loaded — those land in the
    # shared "Untitled" bucket.
    # `tags` is a free-form list of tag strings. No central
    # registry; the known-tags list is derived live by walking the
    # in-memory index. Lower-cased for matching, displayed with
    # original casing. The cycling cloud filter
    # (`OFF → AND → OR → NOT → OFF`) reads this field via
    # `utils/tagFilter.js:matchesTagFilter`.
    # `category_id` (pre-Phase-2.6) is removed — no in-program
    # back-compat. The `tools/` migration script (Phase 2.6h)
    # converts legacy `category_id` values to tag strings before
    # the new code runs. Pre-migration thread files load with the
    # field discarded via `extra="ignore"`.
    story_id: Optional[str] = None
    # Phase 2.11b — snapshot of the owning story's title at the most
    # recent save of this thread. Lives alongside `story_id` so the
    # thread browser can show a meaningful name in cross-story
    # surfaces (e.g. the character-chat story-mismatch gate "load
    # 'X' first") without having to inspect the matching project
    # file. Updated on every save (NOT immutable like `story_id`) so
    # writer-side renames of the project propagate to the snapshot on
    # next thread save. The `categories` map in the conversations
    # index file (`Conversation.story_id → story_title`) remains the
    # primary lookup table for browser-side titles; this field is the
    # robust fallback for threads whose owning story isn't in the
    # local categories map yet (e.g. the writer just imported a
    # foreign-project thread, or the categories map was rebuilt from
    # disk without that story's per-folder sidecar yet visible).
    story_title: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    # Phase 2.8 — writer-chosen hex tint for the thread browser row.
    # None = use the default zinc/accent chrome. Stored as
    # ``#rrggbb`` (lower-cased) by the colour picker. Treated as a
    # presentation field, like `pinned_in_browser` — toggling it
    # does NOT bump `updated_at` (handled in the conversations
    # service if/when timestamp logic gates on content change).
    colour: Optional[str] = None
    # Phase 2.11b — character chat metadata. When non-null, this
    # thread is a character chat (writer talking to one of their
    # characters as that character at a chosen anchor). When null,
    # the thread is a regular chat. See `CharacterChatMeta` above
    # for the field shape and semantics. Optional / default null —
    # existing conversation JSON files load unchanged. No save-format
    # cliff under the v0.1.25.0+ rule.
    character_chat: Optional[CharacterChatMeta] = None
    # Phase 2.12 — two-character chat metadata. When non-null, this
    # thread is a two-character chat (two characters from the same
    # story converse with each other through the AI, alternating
    # turns). When null, this field is silent and `character_chat`
    # or neither drives chat kind. See `TwoCharacterChatMeta` above
    # for the field shape and semantics.
    #
    # Mutual exclusion with `character_chat`: at most one of the two
    # is non-null on any thread. The field is independent of
    # `character_chat` — the thread-creation paths guarantee mutual
    # exclusion, and chat-kind readers branch on `two_character_chat
    # is not None` first.
    #
    # Optional / default null — existing conversation JSON files load
    # unchanged. No save-format cliff under the v0.1.25.0+ rule.
    two_character_chat: Optional[TwoCharacterChatMeta] = None
    messages: List[ConversationMessage] = Field(default_factory=list)


class ConversationIndexEntry(BaseModel):
    """Lightweight metadata for the thread browser — never carries
    the full `messages` array so the list endpoint stays cheap
    even with hundreds of saved threads. `last_message_preview` is
    a single-line truncated render of the most recent message's
    content (~120 chars)."""
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    created_at: str
    updated_at: str
    message_count: int
    last_message_preview: Optional[str] = None
    profile_id: Optional[str] = None
    model: Optional[str] = None
    # Phase 2.4f — surfaced here so the browser can sort + tab-filter
    # without having to fetch every full thread. Defaults match
    # `Conversation` so older saves render correctly.
    pinned_in_browser: bool = False
    # Phase 2.6 — story linkage + tagging mirrored from the
    # `Conversation` model so the browser can group + filter without
    # walking thread files. See the `Conversation` field docs above
    # for semantics. `category_id` removed (no in-program back-compat;
    # 2.6h migration converts legacy values to tag strings).
    story_id: Optional[str] = None
    # Phase 2.11b — story title snapshot mirrored from `Conversation.story_title`
    # so the thread browser can display the owning-story name on rows
    # for threads from other projects (e.g. the character-chat
    # story-mismatch gate) without having to load the full thread file.
    story_title: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    # Phase 2.8 — writer-chosen hex tint mirrored from `Conversation`
    # so the thread browser can render row colours without fetching
    # full thread files. See `Conversation.colour` for semantics.
    colour: Optional[str] = None
    # Phase 2.11b — character-chat marker. Cheap browser-visible flag
    # derived from `Conversation.character_chat is not None`, lifted
    # into the index so the thread browser can render the 🎭 badge
    # without loading every thread file. The flag is the ONLY visual
    # signal distinguishing character chats from regular threads in
    # the list — they sort by the same rules, group under the same
    # story_id, and stay taggable the same way. Defaults to `False`
    # so older index entries / pre-2.11b saves render correctly.
    is_character_chat: bool = False
    # Phase 2.12 — two-character-chat marker. Cheap browser-visible
    # flag derived from `Conversation.two_character_chat is not None`,
    # lifted into the index so the thread browser can render the
    # 🎭⇆🎭 badge without loading every thread file. Mirrors the
    # `is_character_chat` pattern exactly. Mutually exclusive with
    # `is_character_chat` on a per-row basis (a thread is regular,
    # character-chat, OR two-character-chat — never two of the
    # three). Defaults to `False` so older index entries load
    # correctly.
    is_two_character_chat: bool = False


class ConversationIndexFile(BaseModel):
    """Top-level shape of the persisted `conversations/index.json`
    introduced in Phase 2.6. The file is a perf cache that lets the
    thread browser + tag cloud + tab strip run off in-memory data
    without re-walking every thread file on every browser refresh
    (the old `list_index()` was already expensive at scale and gets
    worse with `tags` + `story_id` added).

    Shape:

        {
          "version": "0.2.6.0",
          "categories": { "<story_id>": "<story_title>", ... },
          "entries": [ <ConversationIndexEntry>, ... ]
        }

    `categories` maps the story-id (`Conversation.story_id`) of every
    story that has at least one thread to that story's current title.
    Updated when a story is renamed AND when threads are saved for
    a story whose id isn't in the map yet. The "Untitled" pseudo-
    story uses the empty-string / `null` key — threads with no
    `story_id` group there.

    `entries` carries the per-thread index rows. Order is irrelevant
    here — the frontend re-sorts by `pinned_in_browser` + `updated_at`
    inside each render group.

    Write discipline (planning doc § Persisted index): index gets
    written on thread create / delete / open / name change / tags
    change / `story_id` add. NOT on per-message or per-token writes
    — staleness is accepted and self-heals on next thread open."""
    model_config = ConfigDict(extra="ignore")

    version: str = "0.2.6.0"
    categories: Dict[str, str] = Field(default_factory=dict)
    entries: List[ConversationIndexEntry] = Field(default_factory=list)
