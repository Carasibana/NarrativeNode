"""Phase 3.10 Layer 5 — AI-assisted scene wiring infrastructure.

This module hosts the backend-only helpers for the AI scene wiring
workflow. It does NOT define any new endpoints itself; the router
that orchestrates a refinement run lives in
`backend/routers/scene_wiring.py` (to land in a later commit).

Architecture note: NONE of these helpers trigger model discovery.
Discovery happens via the existing Settings → MCP & API Connections
flow; the result lands in `AiProviderProfile.model_capabilities`
on user_preferences.json. Scene wiring is a READER against that
cache. When the cache doesn't carry a value (existing profile that
hasn't re-discovered yet, provider that doesn't expose the field
via API), the helpers fall back to documented conservative defaults.

Per the planning doc's no-hard-coded-model-table decision, the
fallback is the only knob — there is no per-model lookup table.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, Optional

from models.user_preferences import AiProviderProfile
from models.entity import Entity
from models.knowledge import Knowledge


# Conservative chunk budget used when the model's context window is
# unknown (provider doesn't surface it via discovery, or the
# capability cache hasn't been populated yet). Safely fits any
# modern model including the legacy 16k-class. See
# `docs/planning/Stage 3 - Novelcrafter Integration.md`
# § "Bulk-mode chunking strategy" for the rationale.
DEFAULT_CHUNK_BUDGET_TOKENS = 16_000

# Hard caps on the number of scenes the chunker is allowed to pack
# into a single LLM call, regardless of the available token budget.
# Two reasons we cap:
#   1. Response shape — even on huge-context models the response
#      side struggles to reliably emit one well-formatted CSV line
#      per scene when the count climbs into the dozens. With 100+
#      scenes in a chunk the LLM tends to bail with a global `?*`
#      decline rather than emit 116 strict-format lines.
#   2. Per-scene attribution clarity — when full prose is in play,
#      asking the model to track which entities appear in which of
#      25 separate prose passages in one pass is a lot to ask. Even
#      if the context window comfortably holds it, the answers
#      blend together and accuracy drops.
# So the cap is depth-dependent: tighter in prose mode (each scene
# is a heavy reading workload), looser in description mode (each
# scene is a paragraph at most). Callers pick the right cap by
# passing `max_scenes_per_chunk` to `chunk_scenes_for_refinement`.
MAX_SCENES_PER_CHUNK_DESCRIPTION = 12
MAX_SCENES_PER_CHUNK_PROSE = 5
# Default for callers that don't pass a depth-specific cap. Mirrors
# the description-mode value — the safer assumption is "short text
# per scene" so the cap doesn't accidentally over-constrain.
MAX_SCENES_PER_CHUNK = MAX_SCENES_PER_CHUNK_DESCRIPTION

# Per-chunk TOKEN budget caps (separate from the per-chunk scene-count
# caps above). These exist because the model's full context window is
# the wrong upper bound for "how much scene content should one LLM
# call digest at once". On a 128k-context model, the token-budget
# gate from `context_window - overhead` never fires until you've
# packed in ~100k tokens of scene content — at which point 5 huge
# scenes packed together overwhelm the model's per-scene attribution
# accuracy. The token caps below stay smaller than the context
# window so a chunk flushes early when scene content gets heavy,
# even if the model could technically swallow more.
# A scene whose own body exceeds the cap still gets emitted in a
# chunk by itself (the single-scene-too-big edge case); we just don't
# pack siblings alongside it.
MAX_INPUT_TOKENS_PER_CHUNK_DESCRIPTION = 8_000
MAX_INPUT_TOKENS_PER_CHUNK_PROSE = 12_000


# ── Phase 3.10 Layer 5 — per-run progress slot ─────────────────────────
#
# An in-memory dict, keyed by an opaque `run_id` the orchestrator
# returns to the caller. The /refine endpoint spawns the orchestration
# as a background task and writes per-chunk results into the slot as
# they land; the frontend polls /refine_progress?run_id=... to merge
# them into the modal incrementally. Mirrors the NC-import
# `_NovelcrafterCommitProgress` pattern.
#
# In-process state, no persistence. A server restart loses any
# in-flight run; the frontend's poll sees a 404 and the modal can
# surface "run lost" rather than spin forever.

@dataclass
class _SceneWiringRunProgress:
    """Lifecycle snapshot of one /refine call.

    Fields:
      * `run_id`           — opaque id the caller generated.
      * `chunks_total`     — known once the orchestrator has built
                             the chunk list. 0 until then.
      * `chunks_done`      — chunks the orchestrator has FINISHED
                             (success OR failure).
      * `chunks_failed`    — terminal-error chunks.
      * `scene_results`    — incremental map; new entries land as
                             each chunk parses.
      * `warnings`         — incremental list; new lines appended as
                             chunks land.
      * `done`             — final state flag. When true the run is
                             over (success, fatal error, or
                             cancelled). The frontend should stop
                             polling on the first response with
                             `done=true` AND consume the final
                             payload from that same response.
      * `diff`             — final RefinementDiff dataclass when the
                             run completed successfully. None until
                             then.
      * `error`            — top-level fatal error string when the
                             run died catastrophically (network,
                             adapter init, story payload bad, etc.).
                             None on success and on per-chunk
                             failures (those are tallied in
                             `chunks_failed` + `warnings` instead).
      * `meta`             — small bag of orchestration metadata the
                             endpoint surfaces in its terminal
                             response (scenes_requested, scenes_
                             attempted, scenes_resolved). Populated
                             at done-flip.
    """
    run_id: str
    chunks_total: int = 0
    chunks_done: int = 0
    chunks_failed: int = 0
    scene_results: dict = None      # dict[str, ParsedSceneResult]
    warnings: list = None           # list[str]
    done: bool = False
    diff: object = None             # RefinementDiff once complete
    error: Optional[str] = None
    meta: dict = None
    # Set by `mark_run_cancelled` (POST /refine_cancel). The
    # orchestrator probes this between chunks and the adapter probes
    # it between streamed events; when true, the orchestrator exits
    # early without running further chunks and marks the slot done.
    cancelled: bool = False
    # NN UUIDs of scenes currently being processed by the in-flight
    # chunk. Populated by the orchestrator at chunk-start, drained
    # per-scene as the LLM streams complete lines, and force-cleared
    # at chunk-end (catches lines that never parsed cleanly). The
    # frontend reads this set to render "Refining" + spinning-coin
    # badges on cards whose scenes are in-flight RIGHT NOW, instead
    # of misleadingly showing "no change" for scenes the model
    # hasn't returned a verdict on yet.
    processing_scene_ids: set = None
    # NN UUIDs of scenes selected for this run that haven't been sent
    # to the LLM yet (their chunk is still upstream in the orchestrator
    # loop). Populated up-front when the run starts; a scene moves
    # from queued → processing when its chunk begins, then
    # processing → final-result as the LLM emits its line. The
    # frontend renders a neutral "Queued" badge on these cards so
    # the writer can see they're scheduled rather than missing /
    # un-considered.
    queued_scene_ids: set = None

    def __post_init__(self):
        if self.scene_results is None:
            self.scene_results = {}
        if self.warnings is None:
            self.warnings = []
        if self.meta is None:
            self.meta = {}
        if self.processing_scene_ids is None:
            self.processing_scene_ids = set()
        if self.queued_scene_ids is None:
            self.queued_scene_ids = set()


_RUN_PROGRESS: dict[str, _SceneWiringRunProgress] = {}


def init_run_progress(run_id: str) -> _SceneWiringRunProgress:
    """Create an empty slot for `run_id` and register it. Returns
    the new slot. Subsequent calls with the same run_id overwrite
    (a fresh start) — the endpoint validates that the caller didn't
    accidentally re-use an in-flight run_id."""
    slot = _SceneWiringRunProgress(run_id=run_id)
    _RUN_PROGRESS[run_id] = slot
    return slot


def get_run_progress(run_id: str) -> Optional[_SceneWiringRunProgress]:
    """Read accessor. Returns None when the slot is missing
    (server-restart loss, never created, or cleared after terminal
    poll)."""
    return _RUN_PROGRESS.get(run_id)


def clear_run_progress(run_id: str) -> None:
    """Remove the slot. Called by the frontend's terminal-poll
    bookkeeping (idempotent — calling on a missing slot is a no-op)."""
    _RUN_PROGRESS.pop(run_id, None)


def update_run_progress_chunk(
    run_id: str,
    *,
    chunks_total: int,
    chunks_done: int,
    chunks_failed: int,
    parsed_scene_results: dict,
    new_warnings: list,
    partial_diff_scene_diffs: Optional[list] = None,
) -> None:
    """Per-chunk update. The orchestrator calls this from its
    `on_chunk_complete` hook to push the chunk's parsed results
    into the slot.

    `partial_diff_scene_diffs` (optional): when the orchestrator
    has computed a partial `RefinementDiff` for THIS chunk's scenes
    (against the live project state), pass the chunk's
    `scene_diffs` list here. Each entry is merged into the slot's
    accumulating `diff` so the polling endpoint can ship correct
    per-scene status DURING the run — not just at terminal-poll.
    Without this, mid-run scene cards show `no_change` for every
    scene that already returned a verdict (because `diff` is None
    so the status helper treats it as "returned, no changes
    proposed"). The terminal `mark_run_done` REPLACES the
    accumulated diff with the full-run compute, which is
    authoritative."""
    slot = _RUN_PROGRESS.get(run_id)
    if slot is None:
        return
    slot.chunks_total = chunks_total
    slot.chunks_done = chunks_done
    slot.chunks_failed = chunks_failed
    # Merge new scene_results; first-write wins on duplicates (the
    # chunker shouldn't produce duplicates but defensive).
    for sid, res in parsed_scene_results.items():
        slot.scene_results.setdefault(sid, res)
    slot.warnings.extend(new_warnings)
    # Accumulate per-chunk diff entries on the slot. The polling
    # endpoint ships `slot.diff` mid-run so the modal can paint the
    # correct status per scene as each chunk lands.
    if partial_diff_scene_diffs:
        if slot.diff is None:
            slot.diff = RefinementDiff(
                scene_diffs=[],
                total_additions=0,
                total_removals=0,
                total_pov_changes=0,
                pov_declined_count=0,
                warnings=[],
            )
        # Merge by scene_uuid — newer overrides older (defensive;
        # the chunker shouldn't produce duplicates).
        by_uuid = {sd.scene_uuid: sd for sd in slot.diff.scene_diffs}
        for sd in partial_diff_scene_diffs:
            by_uuid[sd.scene_uuid] = sd
        slot.diff.scene_diffs = list(by_uuid.values())
        # Recompute running totals from the merged set.
        slot.diff.total_additions = sum(
            1 for sd in slot.diff.scene_diffs for c in sd.chip_changes if c.kind == "add"
        )
        slot.diff.total_removals = sum(
            1 for sd in slot.diff.scene_diffs for c in sd.chip_changes if c.kind == "remove"
        )
        slot.diff.total_pov_changes = sum(
            1 for sd in slot.diff.scene_diffs if sd.pov_change is not None
        )


def mark_run_done(
    run_id: str,
    *,
    diff: object,
    meta: dict,
    extra_warnings: Optional[list] = None,
) -> None:
    """Terminal-state write for a successful run. The endpoint's
    background task calls this once `run_scene_wiring` returns and
    the diff has been computed. The frontend's next poll sees
    `done=true` AND the final diff in the same response."""
    slot = _RUN_PROGRESS.get(run_id)
    if slot is None:
        return
    slot.diff = diff
    slot.meta = dict(meta or {})
    if extra_warnings:
        slot.warnings.extend(extra_warnings)
    # Drain the pending-state sets so the modal doesn't paint stale
    # Queued / Refining badges after the run finishes. Any scene
    # whose verdict didn't land (cancelled chunk, parse failure,
    # missing line) ends up in 'not_refined' UX state, which is the
    # correct read.
    slot.queued_scene_ids.clear()
    slot.processing_scene_ids.clear()
    slot.done = True


def mark_run_error(run_id: str, error: str) -> None:
    """Terminal-state write for a fatal run failure (network error,
    bad payload, adapter init failure)."""
    slot = _RUN_PROGRESS.get(run_id)
    if slot is None:
        return
    slot.error = error
    slot.queued_scene_ids.clear()
    slot.processing_scene_ids.clear()
    slot.done = True


def mark_scenes_queued(run_id: str, scene_uuids: list) -> None:
    """Mark scenes selected for this run as queued — scheduled
    but not yet sent to the LLM. Called by the router up-front
    with every scene that will be refined. Each scene transitions
    queued → processing → result-state as the orchestrator works
    through its chunks."""
    slot = _RUN_PROGRESS.get(run_id)
    if slot is None:
        return
    for sid in scene_uuids:
        if sid:
            slot.queued_scene_ids.add(sid)


def mark_scenes_processing(run_id: str, scene_uuids: list) -> None:
    """Mark a set of scene UUIDs as currently in-flight on the LLM.
    Called by the orchestrator at the START of each chunk. Moves
    each scene FROM the queued set TO the processing set so the
    frontend can flip its badge Queued → Refining + spinning coin
    in one observation."""
    slot = _RUN_PROGRESS.get(run_id)
    if slot is None:
        return
    for sid in scene_uuids:
        if sid:
            slot.queued_scene_ids.discard(sid)
            slot.processing_scene_ids.add(sid)


def mark_scene_done_processing(run_id: str, scene_uuid: str) -> None:
    """Drain ONE scene from the processing set. Called per parsed
    response line as the LLM streams output — the moment a
    scene's verdict is fully received and parsed, that scene
    flips off the Refining state and into its actual result
    state (refined / no_change / pov_declined)."""
    slot = _RUN_PROGRESS.get(run_id)
    if slot is None or not scene_uuid:
        return
    slot.processing_scene_ids.discard(scene_uuid)


def mark_chunk_done_processing(run_id: str, scene_uuids: list) -> None:
    """Drain every scene in a chunk from the processing set at
    chunk-end. Catches lines the streaming parser couldn't pick
    out (malformed output, missing newline, LLM bailed mid-list).
    Idempotent — already-drained scenes are no-ops."""
    slot = _RUN_PROGRESS.get(run_id)
    if slot is None:
        return
    for sid in scene_uuids:
        slot.processing_scene_ids.discard(sid)


def update_run_progress_single_scene(
    run_id: str,
    *,
    scene_uuid: str,
    parsed_result: dict,
    partial_diff_entry: Optional[object] = None,
) -> None:
    """Push ONE scene's parsed verdict + its single-scene diff
    entry onto the slot. Called by the orchestrator's per-line
    streaming callback as each scene's response is parsed off the
    LLM stream. Both the modal's `results` map and the
    accumulating `diff.scene_diffs` get the new entry."""
    slot = _RUN_PROGRESS.get(run_id)
    if slot is None or not scene_uuid:
        return
    slot.scene_results.setdefault(scene_uuid, parsed_result)
    if partial_diff_entry is not None:
        if slot.diff is None:
            slot.diff = RefinementDiff(
                scene_diffs=[],
                total_additions=0,
                total_removals=0,
                total_pov_changes=0,
                pov_declined_count=0,
                warnings=[],
            )
        by_uuid = {sd.scene_uuid: sd for sd in slot.diff.scene_diffs}
        by_uuid[partial_diff_entry.scene_uuid] = partial_diff_entry
        slot.diff.scene_diffs = list(by_uuid.values())
        # Recompute totals from the merged set.
        slot.diff.total_additions = sum(
            1 for sd in slot.diff.scene_diffs for c in sd.chip_changes if c.kind == "add"
        )
        slot.diff.total_removals = sum(
            1 for sd in slot.diff.scene_diffs for c in sd.chip_changes if c.kind == "remove"
        )
        slot.diff.total_pov_changes = sum(
            1 for sd in slot.diff.scene_diffs if sd.pov_change is not None
        )


def mark_run_cancelled(run_id: str) -> bool:
    """Flip the cancellation flag on the slot. Called by the
    /refine_cancel endpoint. The orchestrator probes the flag
    between chunks and the adapter probes it between streamed
    events; once tripped, the orchestrator exits early and
    marks the slot done. Idempotent — returns False if there's
    no slot (already finished / cleared / never existed)."""
    slot = _RUN_PROGRESS.get(run_id)
    if slot is None:
        return False
    slot.cancelled = True
    return True


def is_run_cancelled(run_id: str) -> bool:
    """Probe accessor — used by the orchestrator and by the
    adapter's cancellation callback. Returns False on a missing
    slot (defensive: a missing slot looks like 'no cancel signal'
    so we don't accidentally abort a run whose slot was evicted)."""
    slot = _RUN_PROGRESS.get(run_id)
    return bool(slot and slot.cancelled)


@dataclass
class SceneWiringModelCaps:
    """Scene-wiring-relevant snapshot of a model's capability cache.

    Fields:
      * `context_window` — model's input context window in tokens,
        if the provider's discovery surfaced it. `None` means
        unknown; callers should size their chunk budget against
        `chunk_budget_tokens` instead (which falls back to
        `DEFAULT_CHUNK_BUDGET_TOKENS`).
      * `chunk_budget_tokens` — `context_window` when known, else
        the conservative default. Always populated.
      * `supports_thinking` — whether the model can run with
        extended-thinking on. Derived from the cached
        `supports_reasoning` flag. Drives the thinking-toggle
        visibility in the scene-wiring grid modal.
      * `reasoning_options` — when thinking is supported, the
        word-based effort enum the writer can pick from. None when
        the model uses a numeric budget instead or thinking isn't
        supported.
      * `reasoning_default` — the model's declared default
        reasoning value (if any), for the UX-hint surface.
    """
    context_window: Optional[int]
    chunk_budget_tokens: int
    supports_thinking: bool
    reasoning_options: Optional[list[str]]
    reasoning_default: Optional[str]


def get_scene_wiring_model_caps(
    profile: AiProviderProfile,
    model_id: str,
) -> SceneWiringModelCaps:
    """Read the scene-wiring-relevant capability snapshot for the
    given (profile, model) pair out of the discovery cache.

    Pure projection from `profile.model_capabilities[model_id]`. No
    network calls. No state mutation. When the model isn't cached
    (profile hasn't been discovered against, or the cache entry was
    purged), every field comes back at its defensive default and
    the caller behaves as if the writer is using an unknown model
    on a non-exposing provider — i.e. uses the conservative chunk
    budget and hides the thinking toggle.
    """
    cap = profile.model_capabilities.get(model_id)
    if cap is None:
        return SceneWiringModelCaps(
            context_window=None,
            chunk_budget_tokens=DEFAULT_CHUNK_BUDGET_TOKENS,
            supports_thinking=False,
            reasoning_options=None,
            reasoning_default=None,
        )
    ctx = cap.context_window if cap.context_window and cap.context_window > 0 else None
    return SceneWiringModelCaps(
        context_window=ctx,
        chunk_budget_tokens=ctx if ctx is not None else DEFAULT_CHUNK_BUDGET_TOKENS,
        supports_thinking=bool(cap.supports_reasoning),
        reasoning_options=(
            list(cap.reasoning_options)
            if cap.reasoning_options else None
        ),
        reasoning_default=cap.reasoning_default,
    )


# ── Phase 3.10 Layer 5 — Entity catalog builder ─────────────────────────


_CATALOG_PREAMBLE = (
    "Entity catalog (use only these canonical names in your responses):"
)


def _format_entity_row(entity: Entity) -> str:
    """Format one entity for the catalog as `Name` or `Name (aka X, Y)`.
    Reads the entity's origin (baseline) name + aliases — the canonical
    identifiers the LLM must match against prose text and return back
    to us. Chain-resolved per-scene name variations are out of scope
    for v1; the writer would surface them as aliases on the entity's
    origin if they want them in the catalog."""
    name = entity.name or ""
    alias_values = [
        a.value.strip()
        for a in (entity.aliases or [])
        if a.value and a.value.strip()
    ]
    if alias_values:
        return f"{name} (aka {', '.join(alias_values)})"
    return name


def _format_section(label: str, rows: list[str]) -> str:
    """`Label: a, b, c` or `Label: <none>` when the list is empty.
    Closed-set framing per the planning doc: explicit `<none>` rather
    than omitting the section, so the LLM sees that an entity-type
    is empty rather than guessing whether we forgot to ship it."""
    if not rows:
        return f"{label}: <none>"
    return f"{label}: {', '.join(rows)}"


def build_entity_catalog(
    *,
    characters: list[Entity],
    locations: list[Entity],
    items: list[Entity],
    factions: list[Entity],
    customs: list[Entity],
    knowledges: list[Knowledge],  # accepted for caller compatibility but NOT included in the catalog
    default_pov_character_name: Optional[str],
) -> str:
    """Build the planning-doc-shaped catalog string. Pure function —
    no project state lookup, no chain walk, no network. Callers pass
    the entity / knowledge lists they want included.

    Output shape (matching the planning doc § Layer 5 → Entity catalog):

      Entity catalog (use only these canonical names in your responses):
      Characters: Alice (aka Al, A), Bob, Dave (aka Dave the Bold)
      Locations: the forge, the Northrun
      Items: Alice's blade
      Factions: <none>
      Customs: <none>
      Default POV character: Alice

    Empty sections render as `<none>` rather than getting omitted so
    the LLM sees the FULL closed set of entity-types and doesn't
    speculate about whether a missing section means "no such thing"
    vs "we forgot to send it". `Default POV character: <none set>`
    when the writer didn't pick one — the prompt's POV-defensive
    instruction text falls back to a less-asymmetric framing in
    that case (caller's responsibility, not this fn's).

    Knowledges and Relationships are intentionally EXCLUDED from the
    catalog. Knowledge is too abstract to be "present in a scene" —
    it's something a character knows, not something physically
    co-located with them — and prompting the LLM to mark a Knowledge
    present is a false-presence vector. Relationships don't appear
    here either: a relationship is implied by its participants being
    co-present, so a downstream auto-detection pass derives them
    from chip presence rather than the LLM listing them directly."""
    char_rows = [_format_entity_row(c) for c in characters]
    loc_rows = [_format_entity_row(c) for c in locations]
    item_rows = [_format_entity_row(c) for c in items]
    faction_rows = [_format_entity_row(c) for c in factions]
    custom_rows = [_format_entity_row(c) for c in customs]
    # `knowledges` is accepted in the signature so existing call sites
    # don't break, but knowledge rows are NOT rendered into the
    # catalog — see the docstring rationale. The argument is retained
    # rather than removed so callers reading from a Story object can
    # keep their current kwarg call shape.
    _ = knowledges

    lines = [
        _CATALOG_PREAMBLE,
        _format_section("Characters", char_rows),
        _format_section("Locations", loc_rows),
        _format_section("Items", item_rows),
        _format_section("Factions", faction_rows),
        _format_section("Customs", custom_rows),
    ]

    pov_label = (
        (default_pov_character_name or "").strip() or "<none set>"
    )
    lines.append(f"Default POV character: {pov_label}")

    return "\n".join(lines)


# ── Phase 3.10 Layer 5 — Scene-set selector + chunker ───────────────────


# Token-estimation heuristic per the planning doc: `chars / 4`. Used
# both here (to size chunks) and by the token-cost estimator (item 5)
# to surface estimates in the trigger UI. Approximation only —
# real tokenisation varies per provider; the doc framing is
# "rough warning, not an invoice".
_CHARS_PER_TOKEN = 4


def estimate_tokens(text: str) -> int:
    """Cheap `chars / 4` token estimate. Conservative round-up so the
    chunker doesn't pack a chunk that just barely exceeds budget on
    the upstream's real tokenisation."""
    if not text:
        return 0
    return (len(text) + _CHARS_PER_TOKEN - 1) // _CHARS_PER_TOKEN


_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")

def strip_html(html: str) -> str:
    """Cheap HTML-to-plaintext: strip tags, collapse whitespace.
    Used by the router when building prose-mode scene payloads for the
    LLM (TipTap stores prose as HTML; the LLM needs plain text). Not a
    canonical entity-decoder — character entities like `&amp;` are
    left as-is; the LLM tolerates that fine. For a richer renderer
    pass, see `renderers/txt.py:_tiptap_html_to_text`.
    """
    if not html:
        return ""
    return _WS_RE.sub(" ", _HTML_TAG_RE.sub(" ", html)).strip()


@dataclass
class SceneRefinementInput:
    """One scene as the chunker / orchestrator consumes it. The
    refinement workflow needs only these fields, regardless of
    whether the scene came from a fresh NC import session or an
    already-loaded project. Caller adapts the source.

    `scene_id` is the SEQUENTIAL identifier we ship to the LLM
    (e.g. `scene_7`) — NOT the NN UUID. The parser maps back via
    position. NN UUID lives in `nn_uuid` so the apply pass can
    target the right object after the writer confirms a result.

    `body` is the text the LLM sees: either the scene description
    (depth='description') or the scene prose body (depth='prose').
    Caller picks which depending on the writer's depth toggle.
    """
    scene_id: str
    nn_uuid: str
    title: str
    body: str


@dataclass
class SceneChunk:
    """One chunk worth of scenes that fit under the per-call context
    budget. The orchestrator iterates the list and runs one LLM call
    per chunk. `tokens` is the estimated size for diagnostic logging
    and the token-cost estimator."""
    scenes: list[SceneRefinementInput]
    tokens: int


def chunk_scenes_for_refinement(
    scenes: list[SceneRefinementInput],
    *,
    context_window: int,
    system_prompt_size: int,
    catalog_size: int,
    response_reserve: Optional[int] = None,
    max_scenes_per_chunk: int = MAX_SCENES_PER_CHUNK,
    max_input_tokens_per_chunk: Optional[int] = None,
) -> list[SceneChunk]:
    """Pack `scenes` into chunks each fitting under the LLM's per-call
    input budget. Per the planning doc § "Bulk-mode chunking strategy":

      Budget per chunk =
          context_window - system_prompt_size - catalog_size - response_reserve

    `response_reserve` defaults to `200 + 50 * len(scenes_in_chunk)`
    (roughly 200 tokens of preamble + ~50 tokens per scene's CSV-line
    response; matches the planning doc's `~50 per scene` estimate).
    Reserving for the response side keeps the upstream from running
    out of completion budget on a chunk we packed too tightly.

    Greedy first-fit packing in input order. Sequential ordering
    matches the planning doc's "sequential by default" run shape
    so per-chunk results stay in the order the writer expects. Per-
    chunk failure isolation comes from the orchestrator: one bad
    chunk doesn't poison the others because each is parsed
    independently.

    Edge cases:
      * A single scene larger than the budget: emitted in a chunk
        on its own. The LLM will likely truncate the input but we
        still try — and the writer can fall back to per-scene
        mode on shorter prose if that fails.
      * Empty scene list: returns an empty list (no work to do).
    """
    if not scenes:
        return []

    chunks: list[SceneChunk] = []
    current: list[SceneRefinementInput] = []
    current_tokens = 0

    def per_scene_response_reserve(count: int) -> int:
        if response_reserve is not None:
            return response_reserve
        return 200 + 50 * max(1, count)

    def available_budget_for(count_with_this_scene: int) -> int:
        natural = (
            context_window
            - system_prompt_size
            - catalog_size
            - per_scene_response_reserve(count_with_this_scene)
        )
        # If the caller has imposed a smaller per-chunk input-token
        # cap (depth-driven — e.g. 12k for prose, 8k for description)
        # honour it; the natural model-context-derived budget is
        # the upper bound, not the working bound. This keeps a
        # cluster of huge scenes from packing together on a wide-
        # context model where the natural budget wouldn't trip until
        # ~100k of content.
        if max_input_tokens_per_chunk is not None:
            return min(natural, max_input_tokens_per_chunk)
        return natural

    for scene in scenes:
        scene_tokens = estimate_tokens(scene.title) + estimate_tokens(scene.body)
        prospective_count = len(current) + 1
        prospective_tokens = current_tokens + scene_tokens
        # Two flush conditions: (a) we'd exceed the token budget on
        # this addition, or (b) we'd push past the per-chunk scene
        # cap. The cap prevents the chunker from packing tens or
        # hundreds of scenes into a single LLM call on huge-context
        # models — that's what gets the LLM to bail with `?*` rather
        # than emit one strict-format line per scene.
        if current and (
            prospective_tokens > available_budget_for(prospective_count)
            or prospective_count > max_scenes_per_chunk
        ):
            # Flush the current chunk and start fresh with this scene.
            chunks.append(SceneChunk(scenes=current, tokens=current_tokens))
            current = [scene]
            current_tokens = scene_tokens
            continue
        current.append(scene)
        current_tokens = prospective_tokens

    if current:
        chunks.append(SceneChunk(scenes=current, tokens=current_tokens))
    return chunks


# ── Phase 3.10 Layer 5 — Strict-format response parser ─────────────────


import re as _re


# Per-line discard regex from the planning doc § Layer 5 → "Strict
# response format" → Parser bullets. The LLM is supposed to emit:
#
#   scene_<N>, <pov>*, <other_entity>, <other_entity>, ...
#
# but loves to add preamble, code fences, and trailing summary prose.
# This regex matches the structural shape: starts with `scene_<N>,`
# and contains at least one asterisk SOMEWHERE in the rest of the
# line. That's loose enough to allow the planning doc's fallback
# cases (asterisk on a non-first entity, multiple asterisks) to
# still match and reach `_parse_response_line`, which decides the
# POV via the fallback chain. Lines without any asterisk at all are
# discarded (LLM forgot the format entirely) — they're never
# parseable per the strict-format rules.
_RESPONSE_LINE_RE = _re.compile(
    # Match any leading identifier-shaped token (letters / digits /
    # underscores; starts with a letter) followed by the entity list.
    # This is broader than the original `scene_\d+`-only form so the
    # router can hand the LLM more meaningful scene_ids — e.g. the
    # positional codes `A1C2S3` (Act 1, Chapter 2, Scene 3) — and
    # still have those round-trip. The bracketed form `[scene_1]`
    # the LLM sometimes echoes from the user-message delimiter is
    # also tolerated by the optional `\[?` / `\]?` wrappers.
    r"^\s*\[?([A-Za-z][A-Za-z0-9_]*)\]?\s*,\s*(.*\*.*)\s*$",
    flags=_re.IGNORECASE,
)


@dataclass
class ParsedSceneResult:
    """One scene's worth of parsed LLM output. POV semantics:

      * `pov == 'default'`  → LLM says POV is the writer's default;
        no POV change to apply.
      * `pov == <name>`     → LLM says POV is this specific named
        character (must be in the closed catalog).
      * `pov is None`       → LLM emitted `?*` "I don't know"; no POV
        change applied, regex/manual POV preserved per the planning
        doc's defensive framing.

    `entities_present` is the LLM's confidence-filtered list of
    catalog entities it claims are present in the scene. Names are
    canonical (already filtered against the catalog by the parser;
    unknown names dropped + recorded in `warnings`). Diff computation
    against the scene's existing chip set happens later in the apply
    pass — this parser only captures what the LLM said.
    """
    scene_id: str
    pov: Optional[str]
    entities_present: list[str]
    warnings: list[str] = None  # type: ignore[assignment]

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


@dataclass
class ParsedResponse:
    """Aggregate of one LLM chunk's response. `scene_results` keyed by
    `scene_id` (sequential prompt identifier — `scene_7`). `warnings`
    collects chunk-level issues (preamble lines discarded, format
    failures the strip regex couldn't even recognise as candidates,
    etc.); per-scene issues stay on the `ParsedSceneResult.warnings`."""
    scene_results: dict[str, ParsedSceneResult]
    warnings: list[str]


def _parse_response_line(
    line: str,
    *,
    catalog_names_lc: set[str],
    pov_default_token_lc: str = "default",
) -> tuple[Optional[ParsedSceneResult], list[str]]:
    """Parse one LINE that already matched `_RESPONSE_LINE_RE`. Returns
    `(ParsedSceneResult | None, warnings)`. None means the line was
    structurally a candidate but had something fundamentally broken
    (no scene_id, no entities at all) — caller treats as discarded.

    Fallback chain on POV resolution per the planning doc:
      * Asterisk-marked wins. If multiple items are asterisked,
        prefer the FIRST asterisked one + warn.
      * If no asterisk is present, position wins: first item is POV.
      * If position and asterisk pick DIFFERENT entities, prefer
        asterisk + warn (inconsistency).
      * `?*` (or just `?` in the POV slot) → LLM declines POV.
    """
    warnings: list[str] = []
    m = _RESPONSE_LINE_RE.match(line)
    if not m:
        return None, [f"Could not parse line: {line.strip()!r}"]
    scene_id = m.group(1).lower()
    rest_raw = (m.group(2) or "").strip()

    # Split the rest into items, strip whitespace, drop empties.
    all_items_raw = [p.strip() for p in rest_raw.split(",")] if rest_raw else []
    all_items_raw = [p for p in all_items_raw if p]

    # Strip asterisks; remember which positions had them.
    cleaned: list[str] = []
    marked_positions: list[int] = []
    for idx, item in enumerate(all_items_raw):
        if item.endswith("*"):
            marked_positions.append(idx)
            cleaned.append(item[:-1].strip())
        else:
            cleaned.append(item.strip())

    if not cleaned or not cleaned[0]:
        return None, [f"Line had no parseable items: {line.strip()!r}"]

    # POV slot is whichever item is asterisked. Per fallback chain:
    # asterisk-marked wins; if none, position-0 wins; if multiple,
    # the first asterisked wins and we warn on the others.
    if marked_positions:
        pov_idx = marked_positions[0]
        if pov_idx != 0:
            warnings.append(
                f"{scene_id}: asterisk on non-first position {pov_idx}; "
                f"position would have picked '{cleaned[0]}' but "
                f"asterisk picked '{cleaned[pov_idx]}' (asterisk wins)"
            )
        if len(marked_positions) > 1:
            extras = [cleaned[i] for i in marked_positions[1:]]
            warnings.append(
                f"{scene_id}: multiple asterisks; taking first "
                f"('{cleaned[pov_idx]}') and dropping marks on {extras}"
            )
    else:
        # No asterisk at all — position-0 wins per fallback chain.
        # Warn so the writer knows the LLM forgot the format.
        warnings.append(
            f"{scene_id}: no asterisk on any item; "
            f"taking position 0 ('{cleaned[0]}') as POV (position fallback)"
        )
        pov_idx = 0

    pov_raw = cleaned[pov_idx].strip()
    pov_raw_lc = pov_raw.lower()

    # POV resolution:
    pov: Optional[str]
    if pov_raw == "?" or pov_raw_lc == "?":
        # `?*` decline token — LLM says "I don't know".
        pov = None
    elif pov_raw_lc == pov_default_token_lc:
        # `default*` — no POV change to apply.
        pov = "default"
    elif pov_raw_lc in catalog_names_lc:
        # Named character in the catalog — resolve to canonical form
        # by finding the original-case entry (cheap loop; catalogs
        # are small enough that we don't need a casefold-keyed map).
        pov = pov_raw
    else:
        warnings.append(
            f"{scene_id}: POV '{pov_raw}' not in catalog; dropped, "
            f"treating as decline ('?*' equivalent)"
        )
        pov = None

    # Other-entities = every item except the POV index. Filter against
    # the catalog and drop unknowns with a warning.
    others_raw = [cleaned[i] for i in range(len(cleaned)) if i != pov_idx]
    entities_present: list[str] = []
    for name in others_raw:
        if not name:
            continue
        if name.lower() in catalog_names_lc:
            entities_present.append(name)
        else:
            warnings.append(
                f"{scene_id}: non-POV entity '{name}' not in catalog; dropped"
            )

    # POV character IS by definition present in the scene. The LLM
    # often answers only the POV slot when no other entities are in
    # the scene (or when it's being conservative with the present
    # list) — we don't want the diff pass to remove the POV character
    # as a side effect of "not in entities_present". Inject a named
    # POV into entities_present if it isn't already there. `default`
    # and `None` (declined) don't apply — `default` means "no POV
    # change" so we have no name to inject, and `None` means the LLM
    # explicitly declined.
    if pov and pov != "default":
        already_present = any(name.lower() == pov.lower() for name in entities_present)
        if not already_present:
            entities_present.insert(0, pov)

    return ParsedSceneResult(
        scene_id=scene_id,
        pov=pov,
        entities_present=entities_present,
        warnings=warnings,
    ), []


def parse_llm_response(
    raw: str,
    *,
    catalog_names: list[str],
    pov_default_token: str = "default",
) -> ParsedResponse:
    """Parse one LLM chunk's full response text into a `ParsedResponse`.

    `catalog_names` is the closed set of canonical entity names the
    LLM was told it may use. Comparison is case-insensitive but the
    returned POV / entity names preserve the LLM's casing (they
    should match the catalog's casing; if not, that's still
    "canonical enough" for the apply pass to dedupe by case-fold).

    Discards lines that don't match the strict format. Each
    discarded non-empty line gets a `warnings` entry so the writer
    can see what the LLM tried to say. Empty / whitespace lines
    are skipped silently.
    """
    catalog_names_lc = {n.lower() for n in catalog_names if n}
    pov_default_lc = pov_default_token.lower()

    scene_results: dict[str, ParsedSceneResult] = {}
    warnings: list[str] = []

    for raw_line in raw.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        # Strip markdown code fences silently — common LLM tic.
        if line.startswith("```") or line == "~~~":
            continue
        if not _RESPONSE_LINE_RE.match(line):
            warnings.append(f"Discarded non-format line: {line!r}")
            continue
        parsed, line_warnings = _parse_response_line(
            line,
            catalog_names_lc=catalog_names_lc,
            pov_default_token_lc=pov_default_lc,
        )
        warnings.extend(line_warnings)
        if parsed is None:
            continue
        if parsed.scene_id in scene_results:
            warnings.append(
                f"{parsed.scene_id}: duplicate response line; keeping first"
            )
            continue
        scene_results[parsed.scene_id] = parsed

    return ParsedResponse(scene_results=scene_results, warnings=warnings)


# ── Phase 3.10 Layer 5 — Token + cost estimator ────────────────────────


# Per-scene response token allowance per the planning doc § "Token
# estimate" — small structured CSV line per scene. Used to size the
# OUTPUT half of the estimate (not relevant to the chunker's input
# budget; that uses its own response_reserve).
_PER_SCENE_OUTPUT_TOKENS = 50

# Thinking-token allowance the planning doc surfaces as "additional
# thinking-token allowance when the thinking toggle is enabled". The
# real allowance depends on the model and the writer's chosen effort
# level; this is a placeholder midpoint that's "close enough for a
# pre-run estimate" — the prompt's "rough warning, not an invoice"
# framing covers the imprecision.
_PER_SCENE_THINKING_TOKENS = 250


@dataclass
class RefinementCostEstimate:
    """Pre-run estimate shown to the writer next to the Run button.

    `input_tokens` and `output_tokens` come from the `chars / 4`
    heuristic per the planning doc. `cost_usd` is populated when the
    caller provides `(input_per_million, output_per_million)` rates;
    `None` when rates aren't available (the rate-config surface is
    a future polish item; without it the UI shows tokens but no $).
    """
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cost_usd: Optional[float]


def estimate_refinement_cost(
    *,
    chunks: list[SceneChunk],
    system_prompt: str,
    catalog: str,
    use_thinking: bool = False,
    input_rate_per_million: Optional[float] = None,
    output_rate_per_million: Optional[float] = None,
) -> RefinementCostEstimate:
    """Sum the `chars / 4` token estimates across every chunk + the
    `~50 per scene` output allowance + optional thinking allowance.

    Each chunk re-sends the system prompt and the catalog (the
    closed-set framing the LLM needs every time). Scene tokens come
    from the chunker's already-computed totals so we don't double-
    count the `chars / 4` math.

    When `use_thinking=True`, adds `_PER_SCENE_THINKING_TOKENS` per
    scene to the output side — a midpoint placeholder. The UI's
    "rough warning, not an invoice" framing covers the imprecision.

    Cost: `cost_usd = input_tokens / 1_000_000 * input_rate_per_million +
                       output_tokens / 1_000_000 * output_rate_per_million`.
    Returns `cost_usd = None` when either rate is missing (caller's
    UI surfaces tokens-without-dollars in that case)."""
    chunk_count = len(chunks)
    if chunk_count == 0:
        return RefinementCostEstimate(
            input_tokens=0, output_tokens=0, total_tokens=0, cost_usd=None,
        )

    system_tokens = estimate_tokens(system_prompt)
    catalog_tokens = estimate_tokens(catalog)
    scene_input_tokens = sum(c.tokens for c in chunks)
    total_scenes = sum(len(c.scenes) for c in chunks)

    # Each chunk pays the system+catalog overhead once.
    input_tokens = (
        chunk_count * (system_tokens + catalog_tokens)
        + scene_input_tokens
    )
    output_tokens = total_scenes * _PER_SCENE_OUTPUT_TOKENS
    if use_thinking:
        output_tokens += total_scenes * _PER_SCENE_THINKING_TOKENS

    cost_usd: Optional[float] = None
    if input_rate_per_million is not None and output_rate_per_million is not None:
        cost_usd = (
            input_tokens / 1_000_000 * input_rate_per_million
            + output_tokens / 1_000_000 * output_rate_per_million
        )

    return RefinementCostEstimate(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
        cost_usd=cost_usd,
    )


# ── Phase 3.10 Layer 5 — Backend-generated prompts ─────────────────────


# The system prompt is ENTIRELY backend-generated per the planning
# doc's "no writer-typed prompt anywhere" rule. The writer's inputs
# (scope, depth, POV-refinement opt-in, thinking-mode toggle) are
# parameters to the runner, not free-text fields.
_SCENE_WIRING_SYSTEM_PROMPT_BASE = """You are an editor refining a writer's scene placements in their story.

For each scene I send you, identify which entities from the closed catalog are PRESENT in the scene and determine the POV character. You must NEVER invent entities. Only use canonical names from the catalog. The catalog includes aliases in `(aka …)` form — when the prose uses an alias, respond with the canonical name from the catalog.

PRESENT vs MENTIONED — this distinction is critical:
- PRESENT means the entity is physically in the scene, observing, acting, speaking, or being directly perceived AT THIS MOMENT in this scene. A character standing in the room. A location the scene takes place in. An item being held, used, or directly observed. A faction whose members are present.
- MENTIONED means the entity is named, recalled, thought about, discussed, foreshadowed, or compared to — but NOT physically at the scene. Examples: a character thinking about an absent friend; a place the POV remembers visiting; an item from the character's past being discussed; a faction the characters reference but no member of which is here.
- ONLY list entities that are PRESENT. Mentioned-but-absent entities must NOT appear in your response, even when their canonical name appears verbatim in the prose. Naming an entity is not the same as bringing it into the scene.
- When unsure whether an entity is present or merely mentioned, EXCLUDE it. A regex-based pipeline has already flagged every mention; your job is to refine that down to actual presence.

Locations — special rule:
- For LOCATIONS specifically: include EVERY location from the catalog that any character physically occupies at any point during the scene. Scenes can traverse multiple locations (a character walks from the kitchen to the garden; a chase moves through three rooms; a journey passes a city, a river, and a fortress) — list ALL of them when they're in the catalog.
- This is the one place "at this moment" widens to "during this scene". A location the characters pass through, briefly enter, or move to mid-scene IS present for the scene.
- The mentioned-vs-present rule still applies: a location merely talked about or remembered, but never physically entered, is still MENTIONED and stays out.

Confidence rules:
- List only entities you are CONFIDENT are present in the scene. If you are unsure about an entity, leave it out. False positives are worse than missed presences.
- If you genuinely cannot determine the POV from the scene text, answer `?*` (a literal `?` followed by `*`) in the POV slot. This is PREFERRED over a wrong answer. Do NOT guess.

Response format:
- One line per scene, plain text, no preamble, no markdown code fences, no trailing summary.
- Each line: `<scene_id>, <pov>*, <other_entity>, <other_entity>, ...`
- POV is ALWAYS first and ALWAYS followed by an asterisk.
- For declined POV (you cannot tell): `<scene_id>, ?*, ...`
- Remaining entities are comma-separated, no asterisks, canonical names only.
- If only POV is present, line ends after the asterisk.
- Use the scene_id values I provide; respond once per scene I send."""

_SCENE_WIRING_POV_DEFENSIVE_BLOCK = """

POV instructions:
- The writer has set a default POV character. For each scene, decide whether the POV is that default character (answer: `default`) or someone else (answer: that character's canonical name).
- Only return a non-default POV if you have STRONG textual evidence the POV is someone else: inner-thought framing from a different character, first-person narration tagged to a different character, or scene framing that excludes the default character entirely.
- If the evidence is weak or ambiguous, answer `default`.
- If you genuinely cannot tell, answer `?*`. Do NOT guess."""

_SCENE_WIRING_POV_NOPOV_BLOCK = """

POV instructions:
- No default POV character is set for this project.
- For each scene, identify the POV by their canonical name. Answer `?*` if you cannot determine the POV from the scene text."""


def build_system_prompt(*, refine_pov: bool, has_default_pov: bool) -> str:
    """Compose the system prompt the orchestrator sends with every
    chunk. Backend-generated; no writer-typed text anywhere. The POV
    block is selected based on whether POV refinement is opted in
    AND whether the writer set a default POV character — the
    defensive-of-default framing only applies when both are true."""
    if not refine_pov:
        # POV refinement off: still need to instruct the LLM to use
        # `default*` to mean "no POV change". The simpler POV block
        # is sufficient since the apply pass will ignore POV changes.
        return _SCENE_WIRING_SYSTEM_PROMPT_BASE + "\n\nPOV instructions:\n- For each scene, answer `default*` in the POV slot. This run does NOT refine POV assignments."
    if has_default_pov:
        return _SCENE_WIRING_SYSTEM_PROMPT_BASE + _SCENE_WIRING_POV_DEFENSIVE_BLOCK
    return _SCENE_WIRING_SYSTEM_PROMPT_BASE + _SCENE_WIRING_POV_NOPOV_BLOCK


def build_user_message_for_chunk(
    chunk: SceneChunk,
    *,
    catalog: str,
) -> str:
    """Assemble the per-chunk user message: catalog block followed by
    each scene as `[scene_id] Title: <title>\\n<body>`. Caller decides
    whether `body` is the scene description or the full prose
    (depth toggle).
    """
    parts: list[str] = [catalog, ""]
    parts.append("Scenes follow. Reply with ONE line per scene in the strict format described above.")
    parts.append("Use the EXACT scene identifier shown after `---` on each scene's header line (e.g. the `A1C2S3` part) as the leading token of that scene's reply. Do not wrap it in brackets in your response — the `---` brackets in the header are visual delimiters only.")
    parts.append("")
    for scene in chunk.scenes:
        parts.append(f"--- {scene.scene_id} | {scene.title} ---")
        parts.append(scene.body)
        parts.append("")
    return "\n".join(parts).rstrip() + "\n"


# ── Phase 3.10 Layer 5 — Orchestration ─────────────────────────────────


@dataclass
class RefinementRun:
    """Aggregate of one full refinement run across all chunks. Same
    shape as `ParsedResponse` but accumulates per-scene results
    across multiple LLM calls and tracks per-chunk status (so the UI
    can surface partial-failure info if a chunk errored out mid-run
    without poisoning the others — per the planning doc's "per-chunk
    failure isolation"). `chunk_count` / `chunks_run` / `chunks_failed`
    surface chunk-level progress that the apply pass / preview dialog
    can show alongside the aggregated diff."""
    scene_results: dict[str, ParsedSceneResult]
    warnings: list[str]
    chunk_count: int
    chunks_run: int
    chunks_failed: int


async def _collect_chat_response(
    adapter,
    *,
    base_url: str,
    api_key: Optional[str],
    model: str,
    messages,
    system_prompt: str,
    model_capabilities,
    reasoning_level,
    is_cancelled_probe=None,
    on_line=None,
) -> str:
    """Stream a chat call to completion and return the concatenated
    text. Scene wiring isn't streaming back to a user — it's bulk
    extraction; we just need the full response to feed the parser.

    `is_cancelled_probe` is an OPTIONAL sync callable returning a bool;
    when present it's wrapped in an `async` coroutine the adapter
    awaits between events (the adapter contract). The orchestrator
    passes a probe that reads the run's `cancelled` flag from the
    progress slot so a /refine_cancel POST stops the in-flight
    stream as soon as the next event boundary lands. Falls back to
    "never cancelled" when no probe is given (for direct callers
    that don't go through the orchestrator).

    `on_line` is an OPTIONAL sync callable invoked once per
    newline-terminated line as deltas accumulate. The orchestrator
    uses this to parse + push single-scene results to the progress
    slot AS THE LLM STREAMS, so the modal can flip individual scene
    cards from "Refining" → final-status incrementally instead of
    waiting for the whole chunk. Lines that don't match the
    strict-format response regex are still fired (callback decides
    what to do); the callback's exceptions are swallowed so a
    parser hiccup never aborts the stream.
    """
    pieces: list[str] = []
    line_buffer = ""

    # The adapter contract is `is_cancelled` is a COROUTINE the adapter
    # awaits between events (see `LlmAdapter` docstring). Returning a
    # plain bool here would trip "object bool can't be used in 'await'
    # expression" the first time the adapter probes for cancellation.
    async def _probe() -> bool:
        return bool(is_cancelled_probe and is_cancelled_probe())

    async for ev in adapter.stream_chat(
        base_url=base_url,
        api_key=api_key,
        model=model,
        messages=messages,
        system_prompt=system_prompt,
        mcp_server_url=None,  # planning doc: NOT exposed via MCP
        is_cancelled=_probe,
        model_capabilities=model_capabilities,
        capability_sink=None,
        reasoning_level=reasoning_level,
    ):
        if ev.type == "delta" and ev.text:
            pieces.append(ev.text)
            if on_line is not None:
                line_buffer += ev.text
                # Flush every fully-formed line. Trailing partial
                # text (no newline yet) stays in `line_buffer` for
                # the next delta. Callback exceptions are swallowed
                # so a parser hiccup in the orchestrator never aborts
                # the stream — the chunk-end pass still catches the
                # full text via `pieces`.
                while "\n" in line_buffer:
                    line, line_buffer = line_buffer.split("\n", 1)
                    try:
                        on_line(line)
                    except Exception:  # noqa: BLE001
                        pass
        elif ev.type == "error":
            raise RuntimeError(ev.detail or "scene-wiring chat stream errored")
        elif ev.type == "end":
            # Flush any trailing line that didn't have a closing
            # newline — common when the LLM ends without a final
            # \n on its last entry.
            if on_line is not None and line_buffer.strip():
                try:
                    on_line(line_buffer)
                except Exception:  # noqa: BLE001
                    pass
                line_buffer = ""
            break
    return "".join(pieces)


async def run_scene_wiring(
    *,
    adapter,
    profile,
    model: str,
    scenes: list[SceneRefinementInput],
    catalog: str,
    catalog_names: list[str],
    refine_pov: bool,
    has_default_pov: bool,
    use_thinking: bool,
    model_caps: SceneWiringModelCaps,
    on_chunk_complete=None,
    on_chunk_start=None,
    on_line=None,
    max_scenes_per_chunk: int = MAX_SCENES_PER_CHUNK,
    max_input_tokens_per_chunk: Optional[int] = None,
    is_cancelled=None,
) -> RefinementRun:
    """Top-level orchestration for one refinement run. Sequential per
    the planning doc: chunks run in order; each chunk's response is
    parsed independently so a malformed response on chunk K doesn't
    poison K+1 (per "per-chunk failure isolation").

    `on_chunk_complete(idx, total, chunk, parsed)` is invoked after
    each chunk finishes (success or failure). The orchestrator uses
    this to surface progress to the writer via the progress slot
    the endpoint maintains — passed in from the router; the helper
    itself doesn't know about the slot.

    Returns a `RefinementRun` with aggregated per-scene results,
    chunk-level run / failed counts, and warnings (chunk-level +
    per-scene warnings merged).
    """
    system_prompt = build_system_prompt(
        refine_pov=refine_pov, has_default_pov=has_default_pov,
    )
    system_prompt_tokens = estimate_tokens(system_prompt)
    catalog_tokens = estimate_tokens(catalog)

    chunks = chunk_scenes_for_refinement(
        scenes,
        context_window=model_caps.chunk_budget_tokens,
        system_prompt_size=system_prompt_tokens,
        catalog_size=catalog_tokens,
        max_scenes_per_chunk=max_scenes_per_chunk,
        max_input_tokens_per_chunk=max_input_tokens_per_chunk,
    )

    aggregated_results: dict[str, ParsedSceneResult] = {}
    aggregated_warnings: list[str] = []
    chunks_run = 0
    chunks_failed = 0

    reasoning_level = None
    if use_thinking and model_caps.supports_thinking:
        # Pick a sensible default from the model's options. Per the
        # planning doc the writer's chosen effort level is plumbed
        # from the trigger UI; for the orchestrator's MVP we default
        # to the model's declared default OR "medium" if the model
        # didn't declare one.
        reasoning_level = (
            model_caps.reasoning_default
            or ("medium" if model_caps.reasoning_options and "medium" in model_caps.reasoning_options else None)
            or (model_caps.reasoning_options[0] if model_caps.reasoning_options else None)
        )

    # Late import to avoid pulling the chat-message model into this
    # module's load time for callers that only use the helpers.
    from services.llm_adapters.base import ChatMessage

    cancelled_mid_run = False

    for idx, chunk in enumerate(chunks):
        # Cancel-check BEFORE starting a chunk. Drops every remaining
        # chunk from the run — completed chunks above keep their
        # results in `aggregated_results`.
        if is_cancelled and is_cancelled():
            aggregated_warnings.append(
                f"Cancelled before chunk {idx + 1}/{len(chunks)}; "
                f"earlier chunks' results retained."
            )
            cancelled_mid_run = True
            break
        # Chunk-start hook — fires with this chunk's scene UUIDs so
        # the router can move them from queued → processing on the
        # progress slot. Frontend reads the slot and flips badges
        # Queued → Refining + spinning coin.
        if on_chunk_start is not None:
            try:
                on_chunk_start(idx, len(chunks), [s.nn_uuid for s in chunk.scenes])
            except Exception:  # noqa: BLE001
                pass
        user_message = build_user_message_for_chunk(chunk, catalog=catalog)
        messages = [ChatMessage(role="user", content=user_message)]
        chunk_parsed: Optional[ParsedResponse] = None
        try:
            raw = await _collect_chat_response(
                adapter,
                base_url=profile.base_url,
                api_key=profile.api_key,
                model=model,
                messages=messages,
                system_prompt=system_prompt,
                model_capabilities=profile.model_capabilities.get(model),
                reasoning_level=reasoning_level,
                is_cancelled_probe=is_cancelled,
                on_line=on_line,
            )
            # Cancel-check AFTER the chunk's stream returned. The
            # adapter exits its loop as soon as `is_cancelled` flips,
            # so a "raw" we got back after that point is a PARTIAL
            # response — drop it entirely rather than parse half-
            # filled scene lines. Per the writer's rule: only scenes
            # whose FULL information was received before interruption
            # should land in the draft state.
            if is_cancelled and is_cancelled():
                aggregated_warnings.append(
                    f"Cancelled during chunk {idx + 1}/{len(chunks)}; "
                    f"in-flight chunk's partial response discarded."
                )
                cancelled_mid_run = True
                # Still fire the progress callback so the polling
                # endpoint can flip the slot's `done` flag below.
                if on_chunk_complete is not None:
                    on_chunk_complete(idx, len(chunks), chunk, None)
                break
            chunk_parsed = parse_llm_response(raw, catalog_names=catalog_names)
            chunks_run += 1
            # Merge results. Duplicate scene_id across chunks shouldn't
            # happen (chunker guarantees each scene lands in exactly
            # one chunk) but defensive: first wins + warn.
            for scene_id, result in chunk_parsed.scene_results.items():
                if scene_id in aggregated_results:
                    aggregated_warnings.append(
                        f"{scene_id}: appeared in multiple chunks; keeping first result"
                    )
                    continue
                aggregated_results[scene_id] = result
            aggregated_warnings.extend(chunk_parsed.warnings)
        except Exception as exc:  # noqa: BLE001 — chunk isolation per planning doc
            chunks_failed += 1
            aggregated_warnings.append(
                f"Chunk {idx + 1}/{len(chunks)} failed: {type(exc).__name__}: {exc}"
            )

        if on_chunk_complete is not None:
            try:
                on_chunk_complete(idx, len(chunks), chunk, chunk_parsed)
            except Exception:  # noqa: BLE001
                # Progress callback errors must NEVER kill the run.
                pass

    return RefinementRun(
        scene_results=aggregated_results,
        warnings=aggregated_warnings,
        chunk_count=len(chunks),
        chunks_run=chunks_run,
        chunks_failed=chunks_failed,
    )


# ── Phase 3.10 Layer 5 — Apply pass + diff-from-result helper ──────────


# Entity types that appear as scene chips. Knowledges intentionally
# excluded — they have their own existence chain and aren't scene
# chips per `SceneNode.characters / locations / items / factions /
# customs`. LLM-listed knowledges are dropped with a warning.
_SCENE_CHIP_TYPES = ("character", "location", "item", "faction", "custom")


@dataclass
class SceneChipChange:
    """One chip-level mutation to a scene's `EntityRef` list. `kind`
    is `add` or `remove`. `entity_type` selects which list on the
    SceneNode (`characters` / `locations` / `items` / `factions` /
    `customs`). `entity_id` is the canonical NN UUID — pre-resolved
    so the apply pass doesn't have to look it up again."""
    kind: Literal["add", "remove"]  # type: ignore[name-defined]
    entity_type: str
    entity_id: str
    entity_name: str  # for display in the diff preview


@dataclass
class ScenePovChange:
    """POV reassignment for a scene. `pov_entity_id` is the new POV
    character's UUID, or None to clear POV (LLM said `?*` AND there
    was a previous POV the writer might want re-evaluated)."""
    new_pov_entity_id: Optional[str]
    new_pov_entity_name: Optional[str]
    previous_pov_entity_id: Optional[str]


@dataclass
class SceneDiff:
    """All changes the LLM's response implies for one scene. The
    grid-modal preview dialog renders this; Apply All on the writer's
    confirmation feeds it into `apply_refinement_diff`."""
    scene_uuid: str
    scene_title: str
    chip_changes: list[SceneChipChange]
    pov_change: Optional[ScenePovChange]
    warnings: list[str]


@dataclass
class RefinementDiff:
    """Bulk-mode preview shape per the planning doc § "Reversibility":
    `X chips added across N scenes, Y removed, Z POV reassignments`.
    Plus the per-scene diffs so the preview dialog can render each
    one clickably + apply all atomically."""
    scene_diffs: list[SceneDiff]
    total_additions: int
    total_removals: int
    total_pov_changes: int
    pov_declined_count: int
    warnings: list[str]


# Late import inside functions to avoid pulling Story / models at
# module-load time for callers that only use the pure helpers above.


def _build_entity_name_index(story) -> dict[str, tuple[str, str]]:
    """Map case-folded entity name → `(entity_id, entity_type)`.
    `entity_type` is one of `_SCENE_CHIP_TYPES`. Built once per
    diff computation; the LLM's canonical names get looked up here.

    Aliases are ALSO mapped to the same `(entity_id, entity_type)`
    tuple so an LLM reply that uses an alias instead of the canonical
    name still resolves to the right entity. The catalog ships
    aliases in `(aka …)` form, but the LLM doesn't always rewrite an
    alias back to canonical on reply — accepting both forms is the
    less-strict resolution path. Canonical name wins on a collision
    (same casefold mapped from two entities): the canonical entry is
    inserted last so the second .setdefault is a no-op."""
    name_index: dict[str, tuple[str, str]] = {}
    for bucket_name, bucket in (
        ("character", story.entities.characters),
        ("location", story.entities.locations),
        ("item", story.entities.items),
        ("faction", story.entities.factions),
        ("custom", story.entities.customs),
    ):
        for ent in bucket:
            # Aliases first so a canonical name wins any collision.
            for a in (ent.aliases or []):
                if a and getattr(a, "value", None) and a.value.strip():
                    name_index.setdefault(a.value.strip().casefold(), (ent.id, bucket_name))
            if ent.name:
                name_index[ent.name.casefold()] = (ent.id, bucket_name)
    return name_index


def _scene_chip_lists(scene) -> dict[str, list]:
    """Map entity_type → the `EntityRef` list on this scene that
    holds chips of that type. Used by both diff computation (read)
    and apply (mutation)."""
    return {
        "character": scene.characters,
        "location": scene.locations,
        "item": scene.items,
        "faction": scene.factions,
        "custom": scene.customs,
    }


def compute_refinement_diff(
    run: RefinementRun,
    story,
    scene_uuid_by_prompt_id: dict[str, str],
) -> RefinementDiff:
    """Project the LLM-parsed results onto the current scene chip
    state and produce the per-scene mutation list. Pure projection
    — DOES NOT mutate `story`. Apply happens in `apply_refinement_diff`.

    `scene_uuid_by_prompt_id` maps the sequential prompt id
    (`scene_7`) to the NN UUID the orchestrator carried alongside it.
    The router builds this map when assembling `SceneRefinementInput`s
    and passes it through.

    Diff rules:
      * Chip ADD when the LLM lists an entity not already in the
        scene's chip set for its type.
      * Chip REMOVE when the scene's existing chip set contains an
        entity the LLM didn't list. The closed-catalog framing
        means the LLM's omission IS a signal (per planning doc
        "False positives are worse than missed mentions" → if the
        LLM was confident the entity wasn't present, removing
        their chip is correct).
      * Knowledges: drop + warn. Not scene chips in the NN model.
      * POV change: only when `parsed.pov` resolves to a character
        the scene has access to AND it differs from the scene's
        current `pov_entity_id`. `pov is None` (`?*` decline) →
        no POV change applied per the defensive-of-writer framing.
        `pov == 'default'` → no POV change applied (writer's default
        is the floor).
    """
    name_index = _build_entity_name_index(story)
    knowledge_names_lc = {k.name.casefold() for k in story.knowledges if k.name}
    scene_by_uuid = {sc.id: sc for sc in story.scenes}

    # Resolve story-level default POV character (Optional). When the
    # LLM responds `default*` for a scene's POV, we treat the default
    # character as PRESENT at that scene — the same rule the parser
    # applies for a named POV. Without this, a scene where the LLM
    # only marks the default POV would have NO entities listed in
    # `entities_present`, and the diff would propose removing the
    # default character from the scene. The story-level default IS
    # the implicit name behind the `default*` token.
    default_pov_character_id: Optional[str] = getattr(story, "pov_character_id", None)

    diffs: list[SceneDiff] = []
    total_adds = 0
    total_removes = 0
    total_pov = 0
    pov_declined = 0
    aggregate_warnings: list[str] = []

    for prompt_id, parsed in run.scene_results.items():
        scene_uuid = scene_uuid_by_prompt_id.get(prompt_id)
        if not scene_uuid:
            aggregate_warnings.append(
                f"{prompt_id}: no NN UUID mapping (orphan from chunker?); dropped"
            )
            continue
        scene = scene_by_uuid.get(scene_uuid)
        if scene is None:
            aggregate_warnings.append(
                f"{prompt_id} → {scene_uuid}: scene no longer in project; dropped"
            )
            continue
        per_scene_warnings: list[str] = []

        # Resolve LLM-listed names to (entity_id, entity_type) tuples,
        # bucket by type. Drop unknowns + knowledges with warnings.
        wanted_by_type: dict[str, set[str]] = {t: set() for t in _SCENE_CHIP_TYPES}
        for name in parsed.entities_present:
            key = name.casefold()
            hit = name_index.get(key)
            if hit:
                entity_id, entity_type = hit
                wanted_by_type[entity_type].add(entity_id)
                continue
            if key in knowledge_names_lc:
                per_scene_warnings.append(
                    f"LLM listed knowledge '{name}' as present; knowledges aren't scene chips, dropped"
                )
                continue
            per_scene_warnings.append(
                f"LLM listed unknown entity '{name}'; not in catalog, dropped"
            )

        # POV character is by definition present. Three cases:
        #   * Named POV (`Alice*`)   — parser already injected the
        #                              name into entities_present
        #                              upstream; nothing to do here.
        #   * `default*`             — no name to inject at parse
        #                              time; add the story-level
        #                              default character here.
        #   * `?*` decline           — LLM is uncertain about POV.
        #                              We must NOT use that
        #                              uncertainty as cause to remove
        #                              the scene's existing POV
        #                              character: leave whoever holds
        #                              POV right now (scene's own
        #                              `pov_entity_id`, falling back
        #                              to the story-level default
        #                              when the scene has none yet)
        #                              in the wanted set so the diff
        #                              doesn't strip them as "not in
        #                              entities_present".
        if parsed.pov == "default" and default_pov_character_id:
            wanted_by_type["character"].add(default_pov_character_id)
        elif parsed.pov is None:
            # Preserve current POV through a decline.
            effective_pov_id = scene.pov_entity_id or default_pov_character_id
            if effective_pov_id:
                wanted_by_type["character"].add(effective_pov_id)

        # Compute chip diff per type.
        chip_changes: list[SceneChipChange] = []
        chip_lists = _scene_chip_lists(scene)
        for entity_type in _SCENE_CHIP_TYPES:
            wanted = wanted_by_type[entity_type]
            present_ids = {ref.entity_id for ref in chip_lists[entity_type]}
            for to_add in wanted - present_ids:
                # Look up display name for the diff preview.
                name = next(
                    (n for n, (eid, _) in name_index.items() if eid == to_add),
                    to_add,
                )
                # name_index keys are casefolded; pull the canonical
                # entity name instead.
                for bucket in (
                    story.entities.characters, story.entities.locations,
                    story.entities.items, story.entities.factions,
                    story.entities.customs,
                ):
                    for ent in bucket:
                        if ent.id == to_add:
                            name = ent.name
                            break
                chip_changes.append(SceneChipChange(
                    kind="add", entity_type=entity_type,
                    entity_id=to_add, entity_name=name,
                ))
                total_adds += 1
            for to_remove in present_ids - wanted:
                name = to_remove
                for bucket in (
                    story.entities.characters, story.entities.locations,
                    story.entities.items, story.entities.factions,
                    story.entities.customs,
                ):
                    for ent in bucket:
                        if ent.id == to_remove:
                            name = ent.name
                            break
                chip_changes.append(SceneChipChange(
                    kind="remove", entity_type=entity_type,
                    entity_id=to_remove, entity_name=name,
                ))
                total_removes += 1

        # POV change. Only characters can carry POV.
        pov_change: Optional[ScenePovChange] = None
        previous_pov = scene.pov_entity_id
        if parsed.pov is None:
            # `?*` decline — leave POV alone but tally for the
            # "LLM declined POV for N scenes" summary.
            pov_declined += 1
        elif parsed.pov == "default":
            # No POV change applied; default is floor.
            pass
        else:
            hit = name_index.get(parsed.pov.casefold())
            if hit and hit[1] == "character":
                new_pov_id, _ = hit
                if new_pov_id != previous_pov:
                    # Look up display name.
                    new_name = parsed.pov
                    for char in story.entities.characters:
                        if char.id == new_pov_id:
                            new_name = char.name
                            break
                    pov_change = ScenePovChange(
                        new_pov_entity_id=new_pov_id,
                        new_pov_entity_name=new_name,
                        previous_pov_entity_id=previous_pov,
                    )
                    total_pov += 1
            else:
                per_scene_warnings.append(
                    f"LLM POV '{parsed.pov}' doesn't resolve to a character in this project; ignored"
                )

        # Merge per-line warnings the parser produced for this scene.
        per_scene_warnings.extend(parsed.warnings)

        diffs.append(SceneDiff(
            scene_uuid=scene_uuid,
            scene_title=scene.title or "(untitled scene)",
            chip_changes=chip_changes,
            pov_change=pov_change,
            warnings=per_scene_warnings,
        ))

    return RefinementDiff(
        scene_diffs=diffs,
        total_additions=total_adds,
        total_removals=total_removes,
        total_pov_changes=total_pov,
        pov_declined_count=pov_declined,
        warnings=aggregate_warnings,
    )


def _compute_scene_order_ids(story) -> list[str]:
    """Compute the scene-order list the import pipeline uses: chapter
    index in `story.chapters` order first, then `position.x` within
    chapter. Unchaptered scenes sort to the end by their x. Matches
    `_wire_connections` ordering in `import_engine.py` so the chain
    repair below produces wires identical to what import would have
    produced if those chips had been present at import time."""
    from services.chapter_membership import get_chapter_id_for_node
    chapters = list(getattr(story, "chapters", None) or [])
    chapter_index = {ch.id: i for i, ch in enumerate(chapters)}
    x_offset = float(getattr(story, "chapter_x_offset", 10.0) or 10.0)
    def key(sc):
        ch_id = get_chapter_id_for_node(sc, chapters, x_offset=x_offset)
        ch_idx = chapter_index.get(ch_id, len(chapters))
        x = sc.position.x if getattr(sc, "position", None) else 0.0
        return (ch_idx, x)
    return [sc.id for sc in sorted(story.scenes, key=key)]


def _repair_entity_chain(story, entity_id: str, scene_order_ids: list[str]) -> None:
    """Rebuild the chip-chain edges for ONE entity. Drops every
    existing entity-chain connection for the entity, then walks the
    scene order and re-creates the chain SetupNode → first chip-
    bearing scene → next chip-bearing scene → … Idempotent. POV
    (`is_pov_path`) and relationship (`is_relationship`) connections
    are not touched."""
    from models.connection import Connection

    # 1. Strip existing chip-chain edges for this entity. Leaves POV
    #    + relationship edges intact.
    story.connections = [
        c for c in story.connections
        if not (
            getattr(c, "source_entity_id", None) == entity_id
            and not getattr(c, "is_pov_path", False)
            and not getattr(c, "is_relationship", False)
        )
    ]

    # 2. Look up this entity's SetupNode / origin EntityNode. None
    #    when the entity has no origin (shouldn't happen for an
    #    auto-placed import entity but possible if the writer
    #    deleted it; we still chain scenes together in that case).
    setup_node_id: Optional[str] = None
    for n in getattr(story, "entity_nodes", []) or []:
        if (
            getattr(n, "entity_id", None) == entity_id
            and not getattr(n, "is_modifier", False)
        ):
            setup_node_id = n.id
            break

    # 3. Find which scenes currently carry this entity's chip.
    scene_by_id = {sc.id: sc for sc in story.scenes}
    def scene_has_chip(sc) -> bool:
        for bucket in (sc.characters, sc.locations, sc.items, sc.factions, sc.customs):
            for ref in bucket:
                if ref.entity_id == entity_id:
                    return True
        return False

    # 4. Walk scene_order; wire prev_carrier → this for every
    #    chip-bearing scene. First carrier wires from setup_node.
    prev_node_id: Optional[str] = setup_node_id
    for sid in scene_order_ids:
        sc = scene_by_id.get(sid)
        if sc is None or not scene_has_chip(sc):
            continue
        if prev_node_id:
            story.connections.append(Connection(
                source_node_id=prev_node_id,
                target_node_id=sid,
                source_entity_id=entity_id,
                target_handle_id=f"chip-in-{entity_id}",
            ))
        prev_node_id = sid


def apply_refinement_diff(diff: RefinementDiff, story) -> int:
    """Mutate `story` in-place to commit every change in `diff`. The
    grid-modal Apply All button calls this on the result the writer
    has previewed; per-scene auto-apply calls it with a single-scene
    diff. Returns the number of scenes mutated.

    Per-chip-list mutations use the same shape as the existing scene
    mutation actions (push an `EntityRef(entity_id=...)`, filter by
    `entity_id` to remove). No chain-tracked-at-scene change records
    are written by the refinement itself — chips are baseline scene
    membership, not scene-anchored chain events. The same surface
    the writer would use to manually click "Add chip" on a scene.

    Chain repair: after every chip mutation lands, each touched
    entity's entire chip-chain is rebuilt from scratch via
    `_repair_entity_chain`. This is how the import pipeline ends up
    with consistent chains, and re-running it here keeps the chain
    consistent after refinement adds / removes mid-chain chips.
    Without this pass, AI-added chips landed orphaned (no incoming
    chip-chain wire) and AI-removed chips left dangling edges.
    """
    from models.node import EntityRef

    scenes_mutated = 0
    scene_by_uuid = {sc.id: sc for sc in story.scenes}
    affected_entity_ids: set[str] = set()

    for sd in diff.scene_diffs:
        scene = scene_by_uuid.get(sd.scene_uuid)
        if scene is None:
            continue
        # Apply chip changes.
        chip_lists = _scene_chip_lists(scene)
        touched = False
        for change in sd.chip_changes:
            ref_list = chip_lists[change.entity_type]
            if change.kind == "add":
                # Skip if already present (idempotent re-apply).
                if any(r.entity_id == change.entity_id for r in ref_list):
                    continue
                ref_list.append(EntityRef(entity_id=change.entity_id))
                # Append to chip_order if not present.
                if change.entity_id not in scene.chip_order:
                    scene.chip_order.append(change.entity_id)
                touched = True
                affected_entity_ids.add(change.entity_id)
            else:
                # remove
                before = len(ref_list)
                # Mutate in-place to preserve the list reference held
                # in `chip_lists` above (which is the actual scene
                # attribute, not a copy).
                ref_list[:] = [r for r in ref_list if r.entity_id != change.entity_id]
                if len(ref_list) != before:
                    touched = True
                    affected_entity_ids.add(change.entity_id)
                # Strip from chip_order.
                if change.entity_id in scene.chip_order:
                    scene.chip_order = [
                        cid for cid in scene.chip_order
                        if cid != change.entity_id
                    ]
        # Apply POV change.
        if sd.pov_change is not None:
            new_pov = sd.pov_change.new_pov_entity_id
            scene.pov_entity_id = new_pov
            # Mirror the `has_pov` flag on character EntityRefs so the
            # chain-walker / canvas-render layer sees the POV correctly.
            for ref in scene.characters:
                ref.has_pov = (ref.entity_id == new_pov)
            touched = True
        if touched:
            scenes_mutated += 1

    # Chain repair pass — rebuild each affected entity's chip-chain
    # from scratch using the import's scene-order rule (chapter
    # index, then position.x). Drops the now-redundant ad-hoc
    # outgoing-edge strip we used to do per-removal: the rebuild
    # covers it cleanly.
    if affected_entity_ids:
        scene_order_ids = _compute_scene_order_ids(story)
        for eid in affected_entity_ids:
            _repair_entity_chain(story, eid, scene_order_ids)

    return scenes_mutated
