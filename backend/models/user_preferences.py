"""User-level preferences — local-machine defaults that seed new
projects. Stored at `preferences/user_preferences.json` alongside
the app, not inside any `.nnz`. Every field is Optional so the
"no override" case is the same shape as "field omitted" — callers
can distinguish "user has set this to X" from "user has no
preference, use the built-in default".

See `preferences/user_preferences_TEMPLATE.md` for a per-field
writeup that's a bit friendlier for users who hand-edit the JSON.
"""
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .node import TimeDelta


# ── Phase 2.5e — Per-model capability cache ──────────────────────
# Capability info discovered from the upstream `/v1/models`-style
# endpoint, cached locally so the chat panel can gate file-attach UI
# without re-querying on every interaction. One entry per model id;
# the frontend updates the cache whenever the writer runs Discover
# Models. `input_modalities` and `output_modalities` carry the
# OpenRouter-style modality vocabulary (`text`, `image`, `file`,
# `audio`, `video` for input; `text`, `image`, `embeddings`,
# `audio`, `video`, `rerank`, `speech`, `transcription` for output).
# Either array being `None` means the adapter couldn't determine
# the capability — downstream consumers should treat that as "text
# only" rather than assume any extra capability.
class ModelCapabilities(BaseModel):
    model_config = ConfigDict(extra="ignore")

    input_modalities: Optional[List[str]] = None
    output_modalities: Optional[List[str]] = None
    supports_tool_use: Optional[bool] = None
    supports_reasoning: Optional[bool] = None
    # Phase 2.5f — per-model reasoning level catalogue. Exactly one
    # of the two fields below should be populated when reasoning is
    # supported; the other stays None.
    #
    # `reasoning_options` — word-based effort enum (LM Studio,
    # OpenRouter, openai_compatible). Strings in the order they
    # render on the slider; the literal `"off"` value (when present
    # in the model's declared set) is filtered out at UI build time
    # because the reasoning toggle button handles off-state itself.
    # Example LM Studio Gemma 4: ["off", "on"]; OpenRouter unified
    # superset: ["none", "minimal", "low", "medium", "high", "xhigh"];
    # openai_compatible after lazy probe success: ["low", "medium",
    # "high"].
    #
    # `reasoning_budget_range` — numeric budget range for adapters
    # that take a token budget instead of an effort enum (Anthropic
    # extended thinking, when that adapter ships). Shape
    # `{"min": 1024, "max": 65000}` — `max` enforced by the adapter
    # to stay strictly less than the outgoing `max_tokens`.
    reasoning_options: Optional[List[str]] = None
    reasoning_budget_range: Optional[Dict[str, int]] = None
    # Phase 2.5f — model's declared default reasoning value, when
    # the upstream exposes one. Used by the chat panel's
    # model-default hint animation: when the writer switches to a
    # model whose declared default differs from their current
    # chat-panel reasoning state, a brief informational hint
    # surfaces around the reasoning button. The hint NEVER changes
    # state — it just signals "this model suggests X". LM Studio
    # populates this from `capabilities.reasoning.default`. Other
    # adapters generally don't declare a default and leave the
    # field None. Numeric value for adapters that accept a budget
    # (Anthropic when it ships); string for enum adapters.
    reasoning_default: Optional[str] = None
    # Phase 2.5e — runtime-detected support for the OpenAI-spec
    # `type:"file"` content part. None = unknown (try the spec
    # shape first; on HTTP 400 with a content-type error, fall
    # back to inlining text as XML and save False here for next
    # time). True = upstream confirmed to accept the spec shape.
    # False = upstream rejected it; skip straight to the XML
    # inline fallback for text-kind attachments on subsequent
    # sends. Binary kinds (PDF / .docx / .pptx / .xlsx) have no
    # text fallback — a 400 on those surfaces as an error.
    supports_file_content_part: Optional[bool] = None
    # Phase 3.10 Layer 5 — model's input context window in tokens
    # when the provider exposes it via discovery. Populated by the
    # frontend after Discover Models from `DiscoveredModel.context_window`.
    # Stays `None` for providers that don't publish it (Anthropic,
    # OpenAI, generic openai_compatible). Scene-wiring's chunker
    # treats `None` as "unknown, fall back to the conservative 16k
    # default" per the planning doc's no-hard-coded-model-table rule.
    context_window: Optional[int] = None


# ── Phase 2.3c — AI provider profile shapes ──────────────────────
# Saved AI provider connections (LM Studio, Ollama, OpenAI, Anthropic,
# custom OpenAI-compatible endpoints). Profiles are program-level
# (not per-story) and persist in `preferences/user_preferences.json`
# so API credentials carry across every project on the machine.
#
# `api_type` discriminates the request-shape adapter at call time:
#   - "openai_compatible" — generic /v1/chat/completions + /v1/models
#   - "openrouter"        — OpenRouter (OpenAI-compatible chat shape
#                            with MCP tool servers in the `tools`
#                            array + richer /v1/models metadata)
#   - "anthropic"         — Anthropic /v1/messages + /v1/models
#   - "lmstudio_rest_v1"  — LM Studio's REST API v1 (their own
#                            native /api/v1/* surface)
#                            (extra model metadata, MCP integration
#                            toggle, etc.)
#
# `api_key` is OPTIONAL — local endpoints (LM Studio, Ollama) don't
# require auth. When None / empty the connection code MUST skip the
# `Authorization: Bearer …` header entirely instead of sending an
# empty bearer.
#
# `mcp_enabled` toggles whether the adapter wires NarrativeNode's MCP
# server into the upstream's tool-calling channel during chat. The
# adapter only acts on it when its `supports_mcp` class attribute is
# True. Adapters that don't support MCP ignore the flag entirely.
#
# Legacy field `lmstudio_mcp_enabled` is the pre-2.4.x name. New
# saves write `mcp_enabled`; reads accept either and migrate the old
# value into the new field. The legacy field stays accepted via the
# `model_validator` below so saves from earlier versions keep loading
# per the no-cliffs rule.
class AiProviderProfile(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    api_type: Literal["openai_compatible", "openrouter", "anthropic", "lmstudio_rest_v1"]
    base_url: str
    api_key: Optional[str] = None
    selected_models: List[str] = Field(default_factory=list)
    manually_added_models: List[str] = Field(default_factory=list)
    last_used_model: Optional[str] = None
    mcp_enabled: bool = False
    # Per-connection cap on how many tool-call rounds a single chat
    # turn may go through before the adapter cuts the loop short
    # (Phase 3.4f). Overrides the adapter's built-in default
    # (`_MAX_TOOL_ROUNDS = 8` in openrouter.py and friends). Only
    # meaningful when `mcp_enabled=True` AND the adapter advertises
    # `supports_mcp=True`. Sentinel values:
    #   - None  → use the adapter's built-in default (8). Older
    #             profiles load with this and pick up the default.
    #   -   -1  → no limit (let the model issue as many sequential
    #             tool-call rounds as it wants — slider's rightmost
    #             "∞" position).
    #   - 2..N  → use this exact value (UI slider snaps at powers of
    #             2: 2, 4, 8, 16, 32, 64, 128; the backend accepts
    #             any positive integer for forward-compat).
    mcp_max_tool_rounds: Optional[int] = None
    # LM Studio (REST v1) only: cached result of the Test-Connection
    # plugin probe — whether `mcp/narrativenode` is registered in this
    # LM Studio's `mcp.json`. None = not probed yet, True = found,
    # False = probed and not configured. Because LM Studio refuses the
    # remote-MCP path on local/private addresses, the UI keeps the tool
    # toggle disabled on such a connection until a probe confirms the
    # local plugin (True). Reset to None when the base URL / api type
    # changes (a different server needs re-probing). Older profiles load
    # with None and re-probe on the next Test Connection.
    lmstudio_plugin_detected: Optional[bool] = None
    # Cached capability info per model id (Phase 2.5e). Populated by
    # the frontend after every Discover Models run. Lets the chat
    # panel gate file-attach UI on whether the active model supports
    # the file type WITHOUT querying upstream on every interaction.
    # Older profiles load with `{}` default and re-populate on the
    # next Discover Models run.
    model_capabilities: Dict[str, ModelCapabilities] = Field(default_factory=dict)

    @model_validator(mode="before")
    @classmethod
    def _migrate_mcp_flag(cls, data):
        """Legacy `lmstudio_mcp_enabled` → canonical `mcp_enabled`.
        Runs before field validation. When the legacy key is set and
        the canonical key is absent (or null), copy the value over.
        We don't preserve the legacy field on the output side — once
        the migration has run, saves emit only `mcp_enabled`."""
        if isinstance(data, dict):
            legacy = data.get("lmstudio_mcp_enabled")
            if legacy is not None and not data.get("mcp_enabled"):
                data["mcp_enabled"] = bool(legacy)
        return data


# Pointer to a (profile, model) pair that defines the global default
# model picked when a new chat session is created. Profile resolution
# happens against `ai_provider_profiles[].id`; the `model` string is
# matched against that profile's `selected_models` /
# `manually_added_models`. If either side resolves to nothing (profile
# deleted, model unchecked), the chat panel falls back to the
# writer's last-used selection.
class AiDefaultModel(BaseModel):
    model_config = ConfigDict(extra="ignore")

    profile_id: str
    model: str


# ── Phase 2.3e — System prompt templates ─────────────────────────
# Named system-prompt templates. Each saved entry is sent as the
# `system` role message at the start of any chat session using it.
# Empty `prompt` text is technically legal (acts the same as the
# built-in "No system prompt" option) but conventionally the writer
# uses the "No system prompt" affordance instead — the
# `default_system_prompt_id = None` state.
class MockMessage(BaseModel):
    """Phase 2.10a item 4 — one entry in a SystemPrompt's
    Pre-Configured Message History.

    The writer authors a sequence of these to seed the conversation
    with apparent prior turns (per planning doc §4.5: tone / style /
    format seeding via apparent conversational precedent). At send
    time the messages are prepended to the wire payload before the
    writer's actual message; the LLM sees them as legitimate prior
    chat history.

    `body` is plain text for item 4. Marker chips (cue-by-name,
    story-scope, prev/next scene, N-words slices) ship in item 10
    and will migrate `body` to a structured node-array shape; the
    migration carries forward losslessly because plain text is one
    valid `{kind: 'text'}` node in the future shape.
    """
    model_config = ConfigDict(extra="ignore")

    id: str                       # stable for diffing / undo across edits
    role: Literal['user', 'assistant']
    body: str = ''


# ── Phase 2.10b item 7 — SystemPrompt context attachment ────────
# Tier 1 surface-intrinsic defaults (item 7's `SurfaceDefaults`) +
# Tier 2 attached markers (`context_markers`) live as new fields on
# `SystemPrompt`. Both backward-compatible: legacy prompts default
# `context_markers` to `[]` and `surface_defaults` to `None`.
#
# `surface_defaults` carries the prompt's opinion (if any) about
# each Tier 1 affordance on the surface the prompt is selected at.
# Each slot is independently optional:
#   - `None` slot = the prompt has NO opinion; the surface's current
#     state is preserved when the prompt is selected.
#   - `False` / `True` (boolean slots) or a populated `WordCountSlot`
#     (before / after) = the prompt has an explicit opinion; the
#     value is written to the surface's existing state bucket at
#     select-time (item 11).
#
# `WordCountSlot.enabled` carries the prompt's on/off opinion;
# `n` carries the word-count opinion. Both are independently
# overridable per-pill on the surface after select-time.
class WordCountSlot(BaseModel):
    model_config = ConfigDict(extra="ignore")
    enabled: bool = False
    n: int = 50


class SurfaceDefaults(BaseModel):
    """Tier 1 surface-intrinsic settings the prompt has an opinion about.
    Per planning doc §4.4f: every slot independently optional — the
    prompt only carries what it has an opinion about, silent slots
    mean "no opinion, preserve current surface state" at select-time.
    """
    model_config = ConfigDict(extra="ignore")

    scene_context:         Optional[bool]           = None
    host_section_content:  Optional[bool]           = None
    before:                Optional[WordCountSlot]  = None
    after:                 Optional[WordCountSlot]  = None


class SystemPrompt(BaseModel):
    # Tolerate forward-compat keys + accept the loosely-typed
    # `context_markers` payload from older drafts. Marker variants
    # follow `dynamicMarkers.js`'s 17-type union; runtime validation
    # of marker shape is the frontend resolver's responsibility
    # (silent-skip on malformed markers, per planning doc §4.4c) so
    # the Pydantic side accepts opaque dicts and round-trips them
    # verbatim. Field-level `extra="ignore"` keeps strict drop on
    # unrecognised top-level fields.
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    prompt: str
    # True when the prompt was originally installed from the shipped
    # template folder (`preferences/system_prompts_shipped/`) at first
    # launch. Purely informational — the writer can still freely edit,
    # rename, or delete shipped prompts the same as writer-authored
    # ones. The flag persists through edits so the settings tab can
    # show a "Shipped" badge.
    shipped: bool = False
    # Phase 2.11a item 1 — Persona flag. When `True`, this prompt is
    # eligible for use as the voice template in the Character Chat
    # surface (per the Phase 2.11 planning doc's `is_persona field on
    # system prompts` section). The Character Chat surface filters its
    # voice picker to `is_persona=True` only — no escape hatch. The
    # flag also surfaces a read-only Persona Preamble preview block
    # above the prompt body in the editor's Compose tab. Backward-
    # compatible: legacy prompts on disk that don't have this field
    # load with `False` (the default).
    is_persona: bool = False
    # Phase 2.10a item 4 — Pre-Configured Message History. Optional
    # sequence of mock user / assistant turns prepended to the wire
    # payload at chat-send time (per planning doc §4.5). Backward-
    # compatible: legacy prompts on disk that don't have this field
    # load with an empty list. Send-time payload assembly (the wiring
    # that actually injects these into outgoing requests) ships in
    # item 12; until then the messages are stored on disk but inert.
    mock_messages: List[MockMessage] = Field(default_factory=list)
    # Phase 2.10b item 7 — Tier 2 attached markers + Tier 1 surface-
    # intrinsic defaults. Both backward-compatible.
    #
    # `context_markers` is a list of opaque marker dicts matching the
    # ContextMarker discriminated union in `frontend/src/utils/
    # dynamicMarkers.js`. We accept opaque `Dict[str, Any]` on the
    # backend rather than enumerating all 17 variants here so that
    # adding a new marker type in the future doesn't require a
    # backend schema bump — the frontend resolver is the source of
    # truth for what shapes are valid, and the silent-skip contract
    # (planning doc §4.4c) means an unknown shape doesn't crash
    # anything. Legacy prompts on disk that don't have this field
    # load with an empty list.
    context_markers: List[Dict[str, Any]] = Field(default_factory=list)
    # Phase 2.10 Bug 6 — static cue attachments. Cues are program-level
    # static references (they live in `context_cues/` at program root
    # and survive story switches) so they're attached as static cue
    # pill ids, NOT as dynamic markers. `applyPromptOnPick` clears any
    # prior `source: 'prompt' && kind: 'cue'` pins and adds one static
    # cue pin per id in this list on each prompt pick. Manual cue pins
    # survive the clear-and-add. Legacy prompts without this field load
    # with an empty list.
    static_cue_ids: List[str] = Field(default_factory=list)
    # Tier 1 surface-intrinsic opinions per the SurfaceDefaults model
    # above. `None` = the prompt has no opinion about ANY surface
    # affordance (the common case for legacy / shipped prompts);
    # individual slots inside `surface_defaults` may also be `None`
    # to carry partial opinions. At select-time, only explicitly-set
    # slots write to the surface's existing state buckets (item 11).
    surface_defaults: Optional[SurfaceDefaults] = None
    # Phase 2.10a item 2 — category derived from the prompt file's
    # parent folder under `system_prompts/`. `None` means the file
    # lives at the root (uncategorized); any non-None value is the
    # category folder's plain name (e.g. "Writing"). NOT persisted to
    # disk — folder location is the source of truth. The service
    # layer populates this on read; `save_prompt()` excludes it from
    # the JSON write payload so a stray value on input can't desync
    # the file's category from its location.
    category: Optional[str] = None


# ── Phase 2.10a item 9 — per-surface defaults ────────────────────
# Four surfaces share the same slot keys:
#   - chat_panel               — the AI chat sidebar
#   - scene_description_pbh    — the Prompt Block Header on a scene's
#                                 description editor
#   - section_pbh              — the Prompt Block Header on a regular
#                                 Section
#   - ipb                      — the Inline Prompt Block surface
# Each slot is nullable; `None` means "no per-surface override; fall
# back to legacy global default (one-cycle compat) or no pre-selection".
#
# Two parallel structures: one for system prompts (id pointer) and
# one for connection / model pairs. Story-side per-surface overrides
# (the `Story.default_prompt_overrides` field) cover ONLY prompts —
# models are install-local and a story doesn't dictate what model
# the writer must run on this machine.
class PerSurfaceDefaults(BaseModel):
    model_config = ConfigDict(extra="ignore")

    chat_panel:             Optional[str] = None
    scene_description_pbh:  Optional[str] = None
    section_pbh:            Optional[str] = None
    ipb:                    Optional[str] = None
    # Phase 2.11b item 4 — Character Chat surface. The system prompt
    # the writer wants the Setup modal's Persona prompt picker to
    # default to. Must be the id of a Persona-flagged prompt (the
    # picker filters by `is_persona`).
    character_chat:         Optional[str] = None


class PerSurfaceModelDefaults(BaseModel):
    model_config = ConfigDict(extra="ignore")

    chat_panel:             Optional[AiDefaultModel] = None
    scene_description_pbh:  Optional[AiDefaultModel] = None
    section_pbh:            Optional[AiDefaultModel] = None
    ipb:                    Optional[AiDefaultModel] = None
    # Phase 2.11b item 4 — Character Chat surface. The connection /
    # model pair the writer wants the Setup modal's model picker to
    # default to.
    character_chat:         Optional[AiDefaultModel] = None


class UserPreferences(BaseModel):
    # Drop unknown keys at validation. The on-disk file only ever
    # contains the current schema; legacy preference keys removed in
    # past versions stop riding through round-trips.
    model_config = ConfigDict(extra="ignore")

    # Schema version. Bumped when the shape of this file changes in
    # a way a migration helper needs to know about. Mirrors the
    # pattern used in `SeedsFile`.
    version: str = "0.1.14.0"

    # ── Story metadata defaults ──────────────────────────────────
    # Each of these maps 1-to-1 onto a field in `models.story.Story`
    # that `newProject()` reads on creation. None = no override,
    # use whatever the Story model's own default is.
    author_name:                    Optional[str]  = None
    default_tense:                  Optional[str]  = None  # "past" | "present"
    default_pov_type:               Optional[str]  = None  # "1st Person" | ...
    default_language:               Optional[str]  = None
    default_chapter_label:          Optional[str]  = None
    default_act_label:              Optional[str]  = None

    # ── Colour defaults (hex strings like "#7c3aed") ─────────────
    default_accent_color:           Optional[str]  = None
    default_pov_color:              Optional[str]  = None

    # ── Autosave defaults ────────────────────────────────────────
    # None = follow Story defaults (enabled=True, interval=5).
    # Explicit False / specific interval override.
    default_autosave_enabled:          Optional[bool] = None
    default_autosave_interval_minutes: Optional[int]  = None

    # ── Canvas defaults ──────────────────────────────────────────
    # None = use the application built-in (False for snap-to-grid, True for chapter tint).
    snap_to_grid_default:                   Optional[bool] = None
    default_chapter_tint_behind_nodes:      Optional[bool] = None
    # Phase 5.1b — wire-visibility mode the canvas starts in each session
    # (session-only; resets every launch). None = "all". One of:
    # all | pov | selected | pov_selected | hide.
    default_wire_visibility_mode:           Optional[str]  = None

    # ── Story Library (Stage 5) ──────────────────────────────────
    # Master toggle for the project library, ON by default. When False,
    # save / open / add never touch the library index or the cover
    # cache (registration is a no-op), and — Phase 5.5c — the library
    # entry points are hidden, so the app behaves as it did before
    # Stage 5. The Program Settings UI lands in 5.3c; 5.3b already gates
    # registration on it.
    use_project_library:                    bool           = True

    # ── Awareness defaults ───────────────────────────────────────
    # None = follow Story default (True). Sets the seed value of the
    # per-story `awareness_rollover_check_enabled` toggle when a new
    # story is created.
    default_awareness_rollover_check_enabled: Optional[bool] = None

    # ── UI layout preferences ────────────────────────────────────
    # Phase 1.26 — left sidebar (Entity Library + Detail Panel)
    # logical width in px. None = use the built-in default (224).
    # The sidebar's resize-by-drag handle writes this on every drag
    # commit (debounced); the sidebar reads it on mount. The current
    # built-in is also the MINIMUM allowed width — the writer can
    # only drag wider, never narrower than the default.
    left_sidebar_width: Optional[int] = None

    # Phase 2.9a item 10 — default zoom level (percent) for the
    # editor panel's prose area. The footer's session zoom slider
    # starts at this value on editor mount and the reset button
    # reverts to it. Stored as an integer 50-200 in 10% increments;
    # None = use the application built-in (100%). Session-level
    # zoom changes (writer drags the slider) do NOT write back to
    # this preference — only the Program Settings control + a fresh
    # explicit save does. Pure display zoom; does NOT change any
    # document's stored font-size.
    editor_default_zoom_level: Optional[int] = None

    # ── Dev settings ─────────────────────────────────────────────
    # Phase 1.22j — Tidy Wires is hidden by default because the
    # current implementation isn't shippable yet. The Dev Settings
    # tab in the Dev Preview panel exposes a toggle that sets this
    # to True; clearing the toggle removes the field (or sets it
    # to None). Any non-true value = button hidden.
    dev_show_tidy_wires_button: Optional[bool] = None

    # ── Show story library on startup (Phase 5.5c) ───────────────
    # Open the Story Library on app launch (over a fresh blank story).
    # ON by default so new users meet the library; they can turn it off
    # here or from the checkbox in the library's bottom-left corner,
    # both bound to this field. Only meaningful when
    # `use_project_library` is on. Replaces the Phase 1.27
    # `show_welcome_on_startup` field (the welcome content now lives in
    # the library landing): a stale `show_welcome_on_startup` from an
    # older save is simply dropped on load (extra="ignore"), so everyone
    # gets the library on startup once and can opt out after seeing it.
    show_library_on_startup: bool = True

    # ── Phase 5.7 — Disable AI integrations ──────────────────────
    # When True, every AI-related UI surface is hidden: the MCP server
    # control, the AI chat panel and its show/hide button, the
    # "talk to this character" and "add as context" buttons, the
    # editor's AI insert buttons, the MCP / System Prompts settings
    # tabs, and the Novelcrafter AI-refine option. The underlying
    # features are untouched; only their entry points disappear.
    # Turning it on also ends any active MCP session and stops the
    # MCP server; while it is on, the server does not auto-start at
    # launch. Off by default.
    disable_ai_integrations: bool = False

    # ── Deletion confirmation: require typing the object's name ───
    # Program-level (not per-story). When True — the default, and the
    # fallback when a prefs file has no entry for it — the delete
    # confirmation dialog requires the writer to type the object's name
    # before the delete button activates, a guard against accidental
    # deletion. When False the same dialog still appears, but the delete
    # button is enabled immediately with no name to type.
    require_typed_name_to_delete: bool = True

    # ── Phase 1.23 Date / Time Tracking defaults ─────────────────
    # Each field uses the standard Optional[…] / null = use
    # shipped default pattern: when null, new stories get the
    # built-in default; when set, new stories pick up the user's
    # explicit choice. Existing stories keep whatever they were
    # saved with — these defaults only seed new project creation.
    default_time_tracking_enabled: Optional[bool] = None        # null → False
    default_allow_negative_time:   Optional[bool] = None        # null → False
    default_time_format:           Optional[Literal["12h", "24h"]] = None  # null → "12h"
    default_gap_shift_threshold:   Optional[TimeDelta] = None   # null → {unit: 'days', value: 1}
    default_week_start:            Optional[Literal["sunday", "monday"]] = None  # null → "sunday"

    # ── Phase 1.25 export-preset persistence ─────────────────────
    # Cross-project memory of the writer's last "Save as default"
    # in the Export dialog. The dialog reads these fields on open
    # and seeds the preset / format / Customize toggle pane from
    # them. Only the explicit "Save as default" button writes them
    # — they are NOT updated silently on Export click. None on every
    # field = use the application built-in (Native preset, DOCX
    # format, native toggle bundle).
    export_last_preset:        Optional[Literal["native", "shunn", "novelcrafter", "customize"]] = None
    export_last_format:        Optional[Literal["docx", "pdf", "markdown", "html", "txt"]] = None
    # Toggle values the writer last saved while in the Customize
    # preset. Open-shaped dict (toggle name → value) so this stays
    # forward-compatible as new toggles ship — `extra='allow'` on
    # `UserPreferences` covers unknown keys both inbound and
    # outbound. Only meaningful when `export_last_preset` is
    # `"customize"`; ignored otherwise.
    export_customize_toggles:  Optional[dict] = None

    # ── Phase 2.1 MCP server ─────────────────────────────────────
    # Auto-start the static-port (13316) MCP listener at launch.
    # `None` / `False` = listener stays stopped until the user turns
    # it on from the MCP control button popover (or from a future
    # Program Settings toggle). `True` = listener binds during
    # lifespan startup. Phase 2.1 ships with MCP disabled by default,
    # so the seed value is None (false-y).
    #
    # The toggle in the popover is a RUNTIME override only — it does
    # NOT write back to this field. To make a runtime choice
    # persistent, the user changes the Program Settings toggle.
    mcp_auto_start:            Optional[bool] = None

    # ── Phase 2.3c — AI provider profiles ────────────────────────
    # Saved AI provider connections (LM Studio, Ollama, OpenAI,
    # Anthropic, custom OpenAI-compatible endpoints). The chat panel
    # reads from this list to populate its model picker. Empty list
    # = writer has not added any profiles; chat panel is gated until
    # they do.
    ai_provider_profiles:      List[AiProviderProfile] = Field(default_factory=list)
    # Pointer to the writer's default profile when more than one is
    # configured. None = use whichever profile the chat panel picks
    # by some other rule (first in the list, last-used, etc.).
    ai_default_profile_id:     Optional[str] = None
    # Global default (profile, model) pair. New chat sessions seed
    # their model picker from this. None = no default set; chat panel
    # falls back to last-used.
    ai_default_model:          Optional[AiDefaultModel] = None

    # ── Phase 2.3e — System prompts ──────────────────────────────
    # The prompt collection itself lives one-file-per-prompt under
    # `system_prompts/{slug}__{id}.json` (Phase 2.10a moved this out
    # of `preferences/`) so this preferences file stays lean and the
    # chat panel can lazy-load only the default at chat-start time. See
    # `backend/services/system_prompts_service.py` +
    # `backend/routers/system_prompts.py` for the storage layout
    # and REST surface. The only field that lives HERE is the
    # default pointer below.
    #
    # None = "No system prompt" is the default — the chat panel
    # skips the system-role message entirely.
    default_system_prompt_id:   Optional[str] = None

    # ── Phase 2.10a item 9 — per-surface defaults ────────────────
    # Two parallel structures keyed by the four surfaces
    # (`chat_panel` / `scene_description_pbh` / `section_pbh` /
    # `ipb`). Each surface's picker reads its own slot and ★ button
    # writes to its own slot. Legacy `default_system_prompt_id` +
    # `ai_default_model` are mirrored into the `chat_panel` slots on
    # first 2.10+ load via the model_validator below; both legacy
    # fields stay populated for one release cycle so v0.2.9.x and
    # earlier saves keep loading per the no-cliffs rule.
    default_prompts_per_surface: PerSurfaceDefaults = Field(default_factory=PerSurfaceDefaults)
    default_models_per_surface:  PerSurfaceModelDefaults = Field(default_factory=PerSurfaceModelDefaults)

    @model_validator(mode="before")
    @classmethod
    def _seed_per_surface_defaults_from_legacy(cls, data):
        """Phase 2.10a item 9 — first-load migration. When loading a
        pre-2.10 `user_preferences.json` that has no
        `default_prompts_per_surface` / `default_models_per_surface`
        block, seed the new structures' `chat_panel` slot from the
        legacy global fields so the writer's existing defaults keep
        applying to the chat panel without an explicit re-pick.
        Runs before field validation; idempotent — a save that
        already has both structures present (even if empty) is
        passed through untouched.
        """
        if not isinstance(data, dict):
            return data
        prompts_block = data.get("default_prompts_per_surface")
        if prompts_block is None:
            legacy_prompt = data.get("default_system_prompt_id")
            if legacy_prompt:
                data["default_prompts_per_surface"] = {"chat_panel": legacy_prompt}
        models_block = data.get("default_models_per_surface")
        if models_block is None:
            legacy_model = data.get("ai_default_model")
            if isinstance(legacy_model, dict) and legacy_model.get("profile_id") and legacy_model.get("model"):
                data["default_models_per_surface"] = {"chat_panel": legacy_model}
        return data

    # ── Phase 2.4 — Chat auto-scroll ────────────────────────────
    # Magnetic auto-scroll for the AI chat conversation view.
    #   None / True (default) → if the writer is already pinned to
    #                            the bottom of the conversation,
    #                            the panel snaps along as new
    #                            tokens stream in. As soon as they
    #                            scroll up, the panel STOPS
    #                            following (so it doesn't fight
    #                            their reading). Scrolling back
    #                            down re-engages.
    #   False                 → never auto-scroll regardless of
    #                            scroll position. The writer
    #                            controls scrolling explicitly.
    chat_auto_scroll:          Optional[bool] = None

    # ── Phase 2.4 — Chat input keybind ──────────────────────────
    # Tri-state. Controls how the chat panel's input textarea maps
    # Enter / Ctrl+Enter to "send" vs "newline":
    #   None / True  → Enter sends, Shift+Enter / Ctrl+Enter inserts
    #                  newline. (Default — matches every chat app
    #                  most writers will be used to.)
    #   False        → Ctrl+Enter sends, Enter inserts newline. For
    #                  writers who do a lot of multi-line prose
    #                  drafting in the chat input and want Enter to
    #                  behave like a regular textarea.
    chat_send_on_enter:        Optional[bool] = None

    # ── Phase 2.4 — Tool-call chip detail level ─────────────────
    # Controls how much information the inline tool-call chips show
    # under streaming / persisted assistant messages.
    #   None / "name" (default) → chip shows just the tool name and
    #                              status (running / success / failure).
    #                              Clicking does nothing extra.
    #   "full"                   → chip is expandable. Clicking reveals
    #                              the full arguments JSON the model
    #                              sent and the raw text output the
    #                              tool returned, plus the failure
    #                              reason when applicable.
    # Lives in the MCP & API Connections settings tab. Same record
    # is read by every adapter so the writer's preference is global.
    tool_call_detail:          Optional[Literal["name", "full"]] = None

    # ── Phase 2.3a — panel layout default snapshot ──────────────
    # Optional dict snapshot of the writer's preferred panel layout.
    # Written by the "Save current layout as default" button in
    # Program Settings; read on app boot when localStorage has no
    # session layout state yet (first install, or right after the
    # user clicks "Reset layout to default"). Treated as an opaque
    # bag — the frontend owns the schema (editor_zone, chat_zone,
    # editor_open, chat_open, right_zone_orientation,
    # bottom_zone_orientation, right_sidebar_width, chat_panel_width,
    # bottom_zone_height, right_zone_editor_share,
    # bottom_zone_editor_share). `None` means the writer hasn't saved
    # a default and the built-in shipped layout applies.
    default_panel_layout:      Optional[dict] = None
