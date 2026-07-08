from __future__ import annotations
from typing import Literal, Optional
from pydantic import BaseModel, ConfigDict, Field, model_validator
import uuid

from .entity import Entity, CustomCategory, PresetList, Relationship
from .knowledge import Knowledge
from .node import EntityNode, SceneNode, PovOriginNode, ReferenceNode, GenericGroup, RelationshipOriginNode, KnowledgeOriginNode, TimeDelta
from .connection import Connection
from .tag import Tag


# Schema-only persistence rule: every model that makes up the save
# structure uses Pydantic's extra='ignore' so unknown JSON keys are
# DROPPED at validation. The model only holds what the current schema
# declares; the save dump only emits what the model holds. Result:
# legacy keys removed from the schema in past releases stop riding
# through round-trips, and new saves always reflect exactly the current
# canonical shape. If a future post-release schema change ever requires
# converting old field shapes into a new shape, the conversion goes in
# a `@model_validator(mode='before')` on the affected model that
# transforms the old keys into the new ones; the legacy keys never
# reach extras because they're recognised and rewritten before
# validation. Pre-cliff incompatible saves are rejected up front by
# `file_service._check_pre_cliff`, not handled here.
_foreign_content_ok = ConfigDict(extra="ignore")


class LibraryDivider(BaseModel):
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    title: str = ""


class LibraryLayout(BaseModel):
    """Per-type ordered list of entity IDs and divider objects for the library panel."""
    model_config = _foreign_content_ok
    characters: list = Field(default_factory=list)  # mix of str (entity id) and LibraryDivider
    locations: list = Field(default_factory=list)
    items: list = Field(default_factory=list)
    factions: list = Field(default_factory=list)
    customs: list = Field(default_factory=list)
    knowledges: list = Field(default_factory=list)
    # Phase 2.8 — writer-controlled order for the remaining library
    # sections that previously displayed in natural insertion order.
    # Same shape as the entity buckets: a mix of str (object id) and
    # LibraryDivider objects. Empty list (default) means "use natural
    # store order" so older saves keep their existing display.
    relationships: list = Field(default_factory=list)
    preset_lists: list = Field(default_factory=list)
    reference_nodes: list = Field(default_factory=list)


class Entities(BaseModel):
    model_config = _foreign_content_ok
    characters: list[Entity] = Field(default_factory=list)
    locations: list[Entity] = Field(default_factory=list)
    items: list[Entity] = Field(default_factory=list)
    factions: list[Entity] = Field(default_factory=list)
    customs: list[Entity] = Field(default_factory=list)
    # Phase 1.21c — `knowledges: list[Entity]` removed. Knowledge is now
    # a first-class type on `Story.knowledges` (not an Entity subtype).
    # Old bucket data is migrated by `_migrate_knowledge_refactor` in
    # `file_service.py`, which runs pre-validation (see `unpack_project`
    # ordering: migrations execute on the raw dict before `Story.model_validate`).
    # By the time Pydantic's `extra="ignore"` config sees the dict the
    # legacy `entities.knowledges` key is already gone — its contents have
    # been moved to `Story.knowledges`. No data loss on pre-refactor saves.


class Chapter(BaseModel):
    """One chapter column in the Phase 1.11 column-division view.

    The column's left edge is NOT stored — it is derived from the cumulative
    sum of preceding chapters' widths in `Story.chapters` order. This means
    reorder / insert / delete all work by rewriting the chapters array and
    letting the overlay re-derive positions on render.
    """
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    title: str = ""
    colour: Optional[str] = None   # null = default chapter tint
    width: float = 540.0           # canvas-px column width (~2.45x default scene node width; snapped to the 20 flow-px dot grid)
    # Phase 4.3 multi-row — the chapter's vertical content-top in canonical
    # (single-row) space: the y of its highest member node, captured on each
    # switch INTO multi-row. Multi-row measures member nodes' vertical offset
    # from this (plus a small header buffer) so a chapter's top node sits just
    # under its row header with no inherited gap, and no offset is negative
    # (so nothing wraps into the row above). None = legacy / never-wrapped =>
    # offsets fall back to canvas y=0 (today's behaviour). Additive, optional.
    content_origin_y: Optional[float] = None


class Act(BaseModel):
    """An act spans a contiguous run of chapters in `Story.chapters` order.

    `chapter_ids` MUST be a contiguous run. Reorder / delete of any chapter
    in the run rewrites this list to preserve contiguity; if the act ends up
    spanning zero chapters after a deletion it is dropped entirely.
    """
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    title: str = ""
    colour: Optional[str] = None   # null = default act tint
    chapter_ids: list[str] = Field(default_factory=list)


class ChapterRow(BaseModel):
    """Phase 4.3 — one row in the multi-row canvas layout.

    A row groups a contiguous run of chapters (its columns, left-to-right)
    and carries a row HEIGHT for the multi-row view. `chapter_rows` on the
    Story is an ADDITIVE grouping overlay on `Story.chapters[]`: the
    row-major flattening of `chapter_rows[*].chapter_ids` is identical to
    `chapters[]` order, kept in sync on every mutation (the same contract
    `Act.chapter_ids` maintains for contiguity). Rows only affect the
    multi-row VIEW; `chapters[]` stays the canonical chapter order, so
    `computeStoryOrder` and every other `chapters[]` consumer are
    unchanged. `chapter_rows == None` ⇒ rows mode never used ⇒ single-row
    behaviour, identical to pre-4.3.
    """
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    chapter_ids: list[str] = Field(default_factory=list)  # the row's columns, left-to-right
    height: float = 600.0  # canvas-px row-band height; user-draggable in multi-row mode
    # Phase 4.3 multi-row — True once the user has dragged this row TALLER than
    # its content-fit minimum: the height is then "user-set" and survives
    # content changes (clamped to >= content-fit). False = auto-fit: the row
    # tracks its tallest chapter's content, growing AND shrinking. Dragging a
    # user-set row back down to its content-fit minimum clears this to False.
    # Additive, default False => legacy rows behave as auto-fit.
    height_user_set: bool = False


# ── Phase 2.10a item 9 — Story-side per-surface prompt overrides ─
# Story-scoped overrides for the four per-surface system-prompt
# defaults. Each slot is OPTIONAL; a `None` slot means "fall back
# to the system-wide per-surface default (or its legacy global
# fallback) for this surface". Models are deliberately NOT mirrored
# on the story side — story-side overrides cover prompts only,
# since models are install-local and a story doesn't dictate what
# model the writer must run on this machine.
class DefaultPromptOverrides(BaseModel):
    model_config = _foreign_content_ok

    chat_panel:             Optional[str] = None
    scene_description_pbh:  Optional[str] = None
    section_pbh:            Optional[str] = None
    ipb:                    Optional[str] = None


class Story(BaseModel):
    model_config = _foreign_content_ok
    # Save format version fields. NarrativeNode reuses its program
    # version (PROGRAM_VERSION in backend/main.py) as the save format
    # identifier — `save_format_version` holds the PROGRAM_VERSION of
    # the build that wrote the file, and `min_reader_versions` holds a
    # per-capability dict of minimum PROGRAM_VERSION floors. Current
    # capabilities are "load" (full project open) and "import" (entity
    # import flow) — each tracked independently in MIN_READER_EPOCHS
    # in backend/services/file_service.py so their floors can diverge
    # over time as breaking changes land that affect one path but not
    # the other.
    #
    # These defaults are placeholders: `pack_project` always overwrites
    # `save_format_version` with PROGRAM_VERSION on save, and bumps
    # each capability's floor in `min_reader_versions` up to its
    # MIN_READER_EPOCHS value when the story's current floor is lower.
    # They only become visible if a story is serialised without going
    # through `pack_project` (which does not happen in normal flows).
    #
    # See docs/save-format-versioning.md for the full scheme.
    save_format_version: str = "0.0.0.0"
    min_reader_versions: dict[str, str] = Field(
        default_factory=lambda: {"load": "0.0.0.0", "import": "0.0.0.0"}
    )
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    title: str = "Untitled Story"
    # Optional free-form story summary / blurb. Used as AI context
    # via the `story_description` dynamic pill (Phase 3.11c) and,
    # later, as the body text on the Stage 5.1 story library card.
    # Defaults to empty string so pre-existing saves load without
    # any migration shim work (the v0.1.25.0+ save-format rule is
    # satisfied by Pydantic's default-value handling on absent
    # fields).
    description: str = ""
    author: Optional[str] = None
    pov_character_id: Optional[str] = None
    tense: Optional[str] = None          # "past" | "present"
    language: Optional[str] = None       # freeform, for AI context
    pov_type_default: Optional[str] = None  # "1st Person" | "2nd Person" | "3rd Person" | etc.
    genre: Optional[str] = None          # freeform, for AI context
    tags: list[str] = Field(default_factory=list)
    # ── Phase 5.2a — Story Library series grouping ──────────────────
    # The series this story belongs to, e.g. "Tidewatch Saga"; null /
    # empty = standalone. Drives the library's Series shelves.
    series: Optional[str] = None
    # Position within the series. Decimal so prequels / interquels slot
    # in (0.5, 2.5). Semantically ignored when `series` is unset. Both
    # fields are Optional-with-default so saves written before this
    # phase load untouched — the no-cliffs save rule explicitly permits
    # adding Optional fields with defaults, so no migration shim is
    # needed (see docs/save-format-versioning.md).
    series_number: Optional[float] = None
    accent_color: Optional[str] = None   # UI accent colour; null = default purple (#7c3aed)
    pov_color: Optional[str] = None      # POV system colour; null = default gold (#eab308)
    autosave_enabled: bool = True
    autosave_interval_minutes: int = 5
    # Per-story toggle for the awareness-rollover modal. When True, any
    # chain-anchor commit to a value whose awareness layer has tracking
    # on (with at least one observer in the resolved entries) opens the
    # rollover modal so the writer can adjust observer levels for the
    # value transition. When False, the modal is fully suppressed —
    # tracking data still walks normally, only the prompt is gone.
    # New stories inherit this from the program-level default at story
    # creation; the writer can override per-story without touching the
    # global preference.
    awareness_rollover_check_enabled: bool = True
    # Override for the "Chapter" term in the ChapterColumnsOverlay header.
    # null or empty = use the default "Chapter". Lets users writing in formats
    # other than prose (screenplays, episodes, sections, etc.) customise the
    # auto-numbered label to match their domain.
    chapter_label: Optional[str] = None
    # Override for the "Act" term in the ChapterColumnsOverlay act row, same
    # pattern as chapter_label. Default "Act". Acts are still optional per
    # project, but when present the auto-numbered label uses this term.
    act_label: Optional[str] = None
    entities: Entities = Field(default_factory=Entities)
    custom_categories: list[CustomCategory] = Field(default_factory=list)
    preset_lists: list[PresetList] = Field(default_factory=list)
    # Phase 3.4a — project-level Tag pool. Flat collection of
    # `{id, name, color}` definitions; pool itself is NOT chain-tracked
    # (rename/recolour/delete are direct mutations on this list that
    # propagate to every host referencing the tag). Tag-on-host
    # MEMBERSHIP is chain-tracked separately on each host. Empty
    # default so pre-Phase-3.4 saves load cleanly.
    project_tags: list[Tag] = Field(default_factory=list)
    chapters: list[Chapter] = Field(default_factory=list)
    acts: list[Act] = Field(default_factory=list)
    # Phase 4.3 — multi-row canvas layout. `chapter_rows` is an additive
    # grouping overlay on `chapters[]` (see ChapterRow). `None` = rows
    # mode never used ⇒ single-row, identical to pre-4.3. The
    # `_repair_chapter_rows` validator below keeps a present-but-stale
    # `chapter_rows` consistent with `chapters[]` (never rejects).
    # `canvas_layout_mode` is the active VIEW mode; 'single' (default)
    # ⇒ old saves open in today's view. Per-story state, no program
    # default.
    chapter_rows: Optional[list[ChapterRow]] = None
    canvas_layout_mode: Literal['single', 'multi'] = 'single'
    # Phase 4.3 — whether the per-row acts header is EXPANDED in the
    # multi-row view (mirrors the single-row acts row, collapsed by
    # default). Additive, default False ⇒ collapsed ⇒ the multi-row layout
    # is byte-identical to pre-acts and old saves load unchanged. This is
    # ALSO the geometry marker: multi-row node positions are stored anchored
    # to a one-header-row allowance when False, two-header-rows when True, so
    # the frontend re-anchors on load if the active view differs (and on the
    # expand/collapse toggle). Forward-compatible: an older reader ignores it.
    multirow_acts_expanded: bool = False
    # Flow-space x where the first chapter's left edge sits. Default 10 to
    # align chapter borders with the canvas dot-grid (React Flow's dots at
    # gap=20 land at flow x ≈ -10.5 + 20n, so chapter edges at 10, 550, 1090,
    # ... sit on dot centres). Can go negative when the user drags the
    # first chapter's left edge leftward past x=0.
    chapter_x_offset: float = 10.0
    # Z-order for chapter column tint bands on the canvas. True (default) =
    # bands sit BEHIND scene/entity nodes, so nodes render opaque on top of
    # the colour. False = bands render OVER nodes as a subtle wash (the old
    # Phase 1.11 behaviour). Only affects the canvas-area tint bands — the
    # chapter / act header rows at the top of the canvas are unaffected.
    chapter_tint_behind_nodes: bool = True
    entity_nodes: list[EntityNode] = Field(default_factory=list)
    scenes: list[SceneNode] = Field(default_factory=list)
    connections: list[Connection] = Field(default_factory=list)
    reference_nodes: list[ReferenceNode] = Field(default_factory=list)
    pov_origin_node: Optional[PovOriginNode] = None
    # Phase 1.18: relationship origin nodes. One per relationship that has a
    # declared chain-index-0 origin on the canvas (created when two entity
    # origin nodes are wired together, or via "Add Relationship" context
    # menu). Relationships born inside a scene have no entry here.
    relationship_origin_nodes: list[RelationshipOriginNode] = Field(default_factory=list)
    # Phase 1.21c Step 14: Knowledge origin nodes. One per Knowledge that
    # has a declared creation-point anchor on the canvas. Optional —
    # Knowledges with no entry here behave as pre-story baseline (the
    # default for any Knowledge created before Step 14 shipped).
    knowledge_origin_nodes: list[KnowledgeOriginNode] = Field(default_factory=list)
    # Phase 1.11 Track I — ComfyUI-style freeform group containers. Purely
    # geometric derived membership (see GenericGroup docstring); zero effect
    # on chapters, export, or narrative chain.
    groups: list[GenericGroup] = Field(default_factory=list)
    relationships: list[Relationship] = Field(default_factory=list)
    # Phase 1.21c — first-class Knowledge object type. Parallel to
    # `relationships`, not nested under `entities`. See
    # `backend/models/knowledge.py` and the Phase 1.21c exploration doc.
    knowledges: list[Knowledge] = Field(default_factory=list)
    library_layout: LibraryLayout = Field(default_factory=LibraryLayout)

    # ── Phase 2.10a item 9 — Story-side per-surface prompt overrides
    # Optional story-scoped overrides for the four per-surface system
    # prompt defaults. The Pydantic default is `None`, NOT an empty
    # `DefaultPromptOverrides()`. This is deliberate: when the writer
    # has set NO overrides on this story, the field is omitted from
    # `narrative.json` entirely so `.nnz` files for stories without
    # overrides stay clean. Saves with at least one slot set emit the
    # field; saves with no slots set drop it via `pack_project`'s
    # `exclude_none=True` flag (already in place for similar
    # opt-in-only metadata). Resolution chain at picker-open time:
    # story override → system-wide per-surface default →
    # legacy global → no pre-selection. See Phase 2.10a item 13 for
    # the picker auto-select wiring.
    default_prompt_overrides: Optional[DefaultPromptOverrides] = None

    # ── Phase 1.23 — Date / Time Tracking per-story settings ────────
    # The master toggle gates the visibility of the other three
    # settings + the entire time UI surface. Time data on individual
    # scenes (SceneNode time fields) persists on disk regardless of
    # this toggle so the data round-trips through off/on cycles
    # without loss.
    time_tracking_enabled: bool = False
    # Allow Negative Time / time travel — when true, the writer can
    # pin gaps below the floor; affected scenes get a prominent
    # time-travelling flag instead of a blocked input.
    allow_negative_time: bool = False
    # Display format for tier-3 exact-clock values. Internal storage
    # is always 24h regardless of display setting.
    time_format: Literal["12h", "24h"] = "12h"
    # Gap-shift alert threshold — when the walker recomputes a
    # scene's Time Since Last Scene gap and the new value differs
    # from the scene's saved `last_known_gap` by more than this
    # amount, a notification fires. Below the threshold, the change
    # is absorbed silently.
    gap_shift_threshold: TimeDelta = Field(default_factory=lambda: TimeDelta(unit="days", value=1))
    # Week-start convention for the Day-of-week button row (purely a
    # display-order setting; storage is always Sun=0..Sat=6 regardless).
    week_start: Literal["sunday", "monday"] = "sunday"
    # Deliberately no `viewport` field. The frontend always runs `fitView`
    # after a load (see Canvas.jsx `_pendingFitView` handling), so
    # persisting pan/zoom state served no purpose and is one less thing
    # to keep in sync. Old project files that still include a `viewport`
    # key load cleanly because Pydantic ignores extra fields by default.

    @model_validator(mode='after')
    def _repair_chapter_rows(self):
        """Phase 4.3 — keep a present `chapter_rows` consistent with
        `chapters[]` (the canonical chapter order). NEVER rejects
        (migrations transform, per the save-format hard rule). No-op when
        `chapter_rows is None` (single-row; the common case).

        Invariant restored: the row-major flattening of
        `chapter_rows[*].chapter_ids` equals `chapters[]` order. The
        frontend maintains this on every mutation; this validator is the
        safety net for a stale / corrupt `chapter_rows` — e.g. chapters
        added, removed, or reordered by a path that didn't update the
        rows. Repair preserves the row STRUCTURE (row count + per-row
        sizes + each row's id/height) and refills it from `chapters[]` in
        canonical order, so the flattening is correct afterwards.

        Empty rows are PRESERVED (Phase 4.3 settled decision): a row may
        legitimately be empty (the user added it, or moved/deleted its
        last chapter) and is removed only via the explicit delete-row
        control, never auto-dropped here. Empty rows contribute nothing
        to the flattening, so they never violate the canonical-order
        invariant.
        """
        rows = self.chapter_rows
        if rows is None:
            return self
        canonical = [c.id for c in self.chapters]
        valid = set(canonical)
        # Drop deleted-chapter ids from each row, preserving structure.
        kept_per_row = [[cid for cid in row.chapter_ids if cid in valid] for row in rows]
        flat = [cid for kept in kept_per_row for cid in kept]

        if flat == canonical:
            # Already consistent (modulo dropped deletions). Write back the
            # filtered ids in place; KEEP every row, including any that
            # emptied (empty rows are a valid, user-managed state).
            for row, kept in zip(rows, kept_per_row):
                row.chapter_ids = kept
            self.chapter_rows = rows
            return self

        # Inconsistent → rebuild. Preserve the row count + sizes (by kept
        # count) and each row's id/height, refilling from canonical order
        # so the flattening matches `chapters[]`. Rows that were empty stay
        # empty (size 0); the LAST row absorbs any remainder (chapters
        # added since the rows were written).
        sizes = [len(kept) for kept in kept_per_row]
        cursor = 0
        n = len(canonical)
        for i, row in enumerate(rows):
            take = (n - cursor) if i == len(rows) - 1 else sizes[i]
            slice_ids = canonical[cursor:cursor + take]
            cursor += len(slice_ids)
            row.chapter_ids = slice_ids
        # Any leftover (e.g. every row had size 0) lands in the last row,
        # or a fresh row if there were none at all.
        if cursor < n:
            remainder = canonical[cursor:]
            if rows:
                rows[-1].chapter_ids = rows[-1].chapter_ids + remainder
            else:
                rows.append(ChapterRow(chapter_ids=list(remainder)))
        self.chapter_rows = rows
        return self
