"""Phase 3.7b -- Unified Import Engine.

Lifted from `template_import_service.py` (where the applier lived
under the `_Applier` name) as part of the Phase 3.7 architecture
pivot: ONE engine, MULTIPLE preprocessors, ONE shared Intermediate
Representation (IR).

Public entry points
-------------------

- ``apply_import_ir_new(ir, layout_mode='columns') -> (Story, summary)``
  Build a fresh Story from the IR.

- ``apply_import_ir_merge(ir, story, layout_mode='columns') -> summary``
  Merge the IR into an existing Story in place.

Public types
------------

- ``ImportIR`` -- the dict shape every preprocessor emits and the
  engine consumes. UUIDs are minted at apply time; the IR is
  name-keyed throughout. Adding a new source format is a parser-only
  change; the IR + engine are reused.

Architecture
------------

Preprocessors live under their own modules and produce an ``ImportIR``:

- ``template_import_service.parse_template`` produces an IR from
  NarrativeNode's markdown template format. *(Shipped.)*
- ``nc_bundle_preprocessor`` will produce an IR from a Novelcrafter
  bundle. *(Phase 3.7N.)*
- Future formats (Scrivener, fresh JSON dumps, etc.) plug in as
  additional preprocessors without touching the engine.

The engine itself is source-agnostic: it doesn't know or care where
the IR came from. Two layout modes (``columns`` and
``first_appearance``) control entity-origin-node placement on the
canvas; both modes work identically across all preprocessors.

Backwards-compat
----------------

The lift renames ``ImportIR`` -> ``ImportIR`` and
``apply_template_*`` -> ``apply_import_ir_*``. No compat shims are
kept under the old names per the project's "retire legacy in
refactor" convention; callers were updated in the same commit. See
``backend/services/test_template_import_regression.py`` for the
behaviour fence that protected this refactor (Phase 3.7a).
"""

from __future__ import annotations

import html
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

from models.entity import (
    Alias,
    Attribute,
    AliasOverrideChange,
    CustomCategory,
    DescriptionChange,
    Entity,
    ExistenceChange,
    HierarchyChange,
    HierarchyConfig,
    HierarchyNode,
    NameChange,
    ParticipantChange,
    ParticipantRole,
    PerceptionChange,
    PresetList,
    Relationship,
    RoleChange,
)
from models.knowledge import (
    Knowledge,
    KnowledgeColourChange,
    KnowledgeDescriptionChange,
    KnowledgeExistenceChange,
    KnowledgeNameChange,
)
from models.entity import AwarenessHistoryEntry, AwarenessWrapper
from models.node import (
    AliasChange,
    AttributeChange as NodeAttributeChange,
    Circumstance,
    Duration,
    EntityNode,
    EntityRef,
    EntityTemporaryCM,
    KnowledgeOriginNode,
    PovOriginNode,
    Position,
    ReferenceNode,
    RelationshipOriginNode,
    SceneNode,
    TimeDelta,
)
from models.story import Act, Chapter, Story
from models.connection import Connection
from models.tag import Tag
from services.title_cleaning import clean_chapter_act_title, has_numbering_prefix

# Phase 5.9 — chapter/act title cleaning only applies when a MAJORITY of a
# group's titles carry a strippable prefix (prefix-numbering is a manuscript-
# wide convention; a stray one or two are left alone). Tunable.
_TITLE_CLEAN_MIN_FRACTION = 0.5


# ── User-pref defaults applied during new-mode apply ────────────────────────
#
# Mirrors `routers/story.py:_PREFS_TO_STORY` for the story-level
# scalar fields a writer can configure under their New-Project
# defaults. Applied during a `_wipe()` so any field not explicitly
# set in the IR's `story` dict inherits the same value the writer
# would get from File -> New. Default seeds (preset-list templates,
# attribute stubs) are intentionally NOT applied here -- the IR
# carries its own preset / attribute content and merging in
# default-seeds bundles on top would produce duplication.
_PREFS_TO_STORY: list[tuple[str, str]] = [
    ("author_name",                              "author"),
    ("default_tense",                            "tense"),
    ("default_pov_type",                         "pov_type_default"),
    ("default_language",                         "language"),
    ("default_chapter_label",                    "chapter_label"),
    ("default_act_label",                        "act_label"),
    ("default_accent_color",                     "accent_color"),
    ("default_pov_color",                        "pov_color"),
    ("default_autosave_enabled",                 "autosave_enabled"),
    ("default_autosave_interval_minutes",        "autosave_interval_minutes"),
    ("default_awareness_rollover_check_enabled", "awareness_rollover_check_enabled"),
    ("default_time_tracking_enabled",            "time_tracking_enabled"),
    ("default_allow_negative_time",              "allow_negative_time"),
    ("default_time_format",                      "time_format"),
    ("default_week_start",                       "week_start"),
    ("default_gap_shift_threshold",              "gap_shift_threshold"),
]


# ── Public types ────────────────────────────────────────────────────────────


@dataclass
class ImportIR:
    """Intermediate Representation produced by every import
    preprocessor and consumed by the engine. Name-keyed throughout;
    UUIDs are minted at apply time.

    `reference_nodes` carries entries that materialise as
    `ReferenceNode` instances on `Story.reference_nodes`. Per-entry
    dict shape:
        - title:         str (required)
        - colour:        str | None  (defaults to `#40afd0` when omitted)
        - content:       str (body text — plain when `is_rich_text`
                         is false, TipTap JSON string when true)
        - is_rich_text:  bool (default false)
        - sub_type:      "note" | "media" (default "note")
        - file_ref:      str | None (asset path; only meaningful for
                         the "media" sub-type)
        - tag_names:     list[str] (Phase 3.7d Gap A; references
                         `project_tags` pool entries by name)
    Reference Nodes have no profile_image_ref field on the model
    (the only image-bearing slot is `file_ref` for the media
    sub-type), so subplot thumbnails from Novelcrafter drop with
    summary per the Stage 3 mapping table.

    `project_tags` (Phase 3.7d Gap A) carries the project-level Tag
    pool entries that hosts reference via `tag_names`. Per-entry
    dict shape:
        - name:  str (case-insensitive unique within the project)
        - color: str | None  (defaults to `#888888`)
    The engine mints fresh UUIDs at apply time and materialises Tag
    objects on `Story.project_tags`. In merge mode, existing pool
    entries are found-or-created by case-folded name.

    Per-host `tag_names: list[str]` (Phase 3.7d Gap A) carries the
    host's tag-membership references by name. Lives on every entity
    dict (`characters` / `locations` / `items` / `factions` /
    `customs`), on every knowledge / relationship / preset_list /
    reference_node dict, and is resolved to `tag_ids` (UUIDs) at
    apply time via the `project_tags` pool. Story-level `story.tags`
    (existing comma-list at project metadata level) is a DIFFERENT
    field — it stays as the `Story.tags` legacy metadata string,
    separate from the pool wiring.

    Per-host `profile_image_ref: str | None` (Phase 3.7d Gap B)
    carries an asset path for the host's profile image (typically
    `assets/<filename>` inside the `.nnz`). Lives on every entity
    dict and every knowledge dict — the two model types that have
    a `profile_image_ref` field since Phase 1.21c. Preprocessor
    extracts the source format's thumbnail bytes into the bundle's
    asset namespace and emits the ref. Engine passes the value
    through verbatim — no resolution, no file I/O. Empty / missing
    field → host's `profile_image_ref` stays `None`. Reference
    Nodes deliberately don't have this slot — the model has no
    profile_image_ref field; its only image-bearing slot is
    `file_ref` for the `'media'` sub-type, which the IR already
    carries via the existing `reference_nodes[].file_ref` field.
    """
    story: dict = field(default_factory=dict)
    project_tags: list[dict] = field(default_factory=list)
    preset_lists: list[dict] = field(default_factory=list)
    custom_categories: list[dict] = field(default_factory=list)
    chapters: list[dict] = field(default_factory=list)
    acts: list[dict] = field(default_factory=list)
    characters: list[dict] = field(default_factory=list)
    locations: list[dict] = field(default_factory=list)
    items: list[dict] = field(default_factory=list)
    factions: list[dict] = field(default_factory=list)
    customs: list[dict] = field(default_factory=list)
    relationships: list[dict] = field(default_factory=list)
    knowledges: list[dict] = field(default_factory=list)
    reference_nodes: list[dict] = field(default_factory=list)
    scenes: list[dict] = field(default_factory=list)


# ── IR-data helpers copied from the parser ─────────────────────────────────
#
# These two helpers parse user-input strings into typed values. They
# live in the parser module too (where the IR is constructed); they
# are duplicated here so the engine remains self-contained -- the
# `apply_*` paths call them when consuming user-pref strings during
# the new-mode wipe, which is a non-IR data source. If a third
# consumer ever needs the same logic, lift these into a shared
# helpers module.


def _parse_hex_colour(raw: str) -> Optional[str]:
    """Parse a `#RRGGBB` (or `#RGB`) colour string. Returns the
    normalised lower-case `#rrggbb` form or ``None`` on miss."""
    if not raw:
        return None
    s = raw.strip().lower()
    if not s.startswith("#"):
        return None
    body = s[1:]
    if len(body) == 3 and all(c in "0123456789abcdef" for c in body):
        return "#" + "".join(c * 2 for c in body)
    if len(body) == 6 and all(c in "0123456789abcdef" for c in body):
        return "#" + body
    return None


def _parse_comma_list(raw: str) -> list[str]:
    """Parse a comma-separated string into trimmed non-empty tokens.
    Quoted tokens preserve their internal commas."""
    if not raw:
        return []
    out: list[str] = []
    cur: list[str] = []
    in_q = False
    quote_char = ""
    for ch in raw:
        if in_q:
            if ch == quote_char:
                in_q = False
            cur.append(ch)
        else:
            if ch in ('"', "'"):
                in_q = True
                quote_char = ch
                cur.append(ch)
            elif ch == ",":
                token = "".join(cur).strip()
                if token:
                    out.append(_strip_quotes(token))
                cur = []
            else:
                cur.append(ch)
    token = "".join(cur).strip()
    if token:
        out.append(_strip_quotes(token))
    return out


def _strip_quotes(s: str) -> str:
    """Strip a single pair of surrounding `"..."` or `'...'` quotes."""
    if len(s) >= 2 and ((s[0] == '"' and s[-1] == '"') or (s[0] == "'" and s[-1] == "'")):
        return s[1:-1]
    return s


# ── Shared time/date data tables ─────────────────────────────────────────
#
# Duplicated from the template parser module because the parser imports
# `ImportIR` from this module, so we can't import these back without a
# circular dependency. Future cleanup: lift these into a dedicated
# `backend/services/import_data.py` shared by both parser and engine.
# For now, the duplication is small and the data is stable.

WEEKDAY_NAMES = {
    "sunday": 0, "monday": 1, "tuesday": 2, "wednesday": 3,
    "thursday": 4, "friday": 5, "saturday": 6,
}

MONTH_NAMES = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
}

SEASON_NAMES = {"spring": 0, "summer": 1, "fall": 2, "autumn": 2, "winter": 3}

LABELLED_TIMES = {
    "dawn", "early morning", "morning", "late morning", "noon",
    "early afternoon", "afternoon", "late afternoon", "evening",
    "night", "late night", "midnight",
}


# ── Apply entry points + _Applier (lifted from template_import_service) ────
# (appended below by the lift commit)
# ── Apply (new + merge) ─────────────────────────────────────────────────────


def apply_import_ir_new(
    ir: ImportIR,
    layout_mode: str = "columns",
    progress_callback=None,
    clean_chapter_act_titles: bool = True,
) -> tuple[Story, dict]:
    """Build a fresh Story from the IR. Returns (story, summary).

    `layout_mode` controls how entity origin nodes are positioned:
      - "columns" (default): per-type columns (Characters → Locations →
        Items → Factions → Customs) parked to the left of chapter 1.
      - "first_appearance": each origin sits to the left of the scene
        where its entity first appears as a chip; chapters widen on the
        left to make room. Entities that never appear as a chip fall
        back to the per-type-columns layout.

    `progress_callback` (Phase 3.10): optional callable invoked
    once per UNIT OF WORK with signature `(label: str)`. A unit is
    either a single setup sub-step (story metadata, project tags,
    wiring connections, etc.) OR one item inside a loop sub-step
    (one character, one scene, one relationship, etc.). The router
    owns the global counter / total; the engine just emits labels.
    This gives the writer rapid-fire visual feedback as individual
    items are processed instead of a coarse "Phase 1 of 3" bar
    that sits at one value while a 170-scene loop chews through.
    Other callers (template import, fixture loads, tests) leave it
    None.
    """
    story = Story(title="Untitled Story")
    summary = _Applier(
        ir, story, mode="new", layout_mode=layout_mode,
        progress_callback=progress_callback,
        clean_chapter_act_titles=clean_chapter_act_titles,
    ).run()
    return story, summary


def apply_import_ir_merge(
    ir: ImportIR, story: Story, layout_mode: str = "columns",
    clean_chapter_act_titles: bool = True,
) -> dict:
    """Merge the IR into an existing Story in place. Returns summary."""
    return _Applier(
        ir, story, mode="merge", layout_mode=layout_mode,
        clean_chapter_act_titles=clean_chapter_act_titles,
    ).run()


# Phase 3.10 — number of setup steps `_Applier.run()` emits once each.
# Loop steps don't count here; they contribute one event per item.
# Keep in sync with the step list inside `run()`.
_APPLY_SETUP_STEP_COUNT = 15


def estimate_apply_total_units(ir: ImportIR) -> int:
    """Return how many progress events `apply_import_ir_new` will
    emit for the given IR. Router uses this to size the progress
    bar's `unit_total` BEFORE kicking off the apply, so each event
    corresponds to a known fraction of the bar instead of the bar
    being sized retroactively (which would jump backward visually
    when later phases learn their item counts)."""
    return (
        _APPLY_SETUP_STEP_COUNT
        + len(ir.characters) + len(ir.locations) + len(ir.items)
        + len(ir.factions) + len(ir.customs)
        + len(ir.relationships)
        + len(ir.knowledges)
        + len(ir.reference_nodes)
        + len(ir.scenes)
    )


class _Applier:
    def __init__(
        self, ir: ImportIR, story: Story, mode: str,
        layout_mode: str = "columns",
        progress_callback=None,
        clean_chapter_act_titles: bool = True,
    ):
        self.ir = ir
        self.story = story
        self.mode = mode
        # Phase 5.9 — strip leading "Chapter N" / "Act N" prefixes from
        # imported chapter/act titles. Default on; off = titles verbatim.
        self.clean_chapter_act_titles = clean_chapter_act_titles
        # Phase 3.10 — see `apply_import_ir_new` docstring. Called
        # once per top-level sub-step in `run()` so the NC import
        # modal's bar moves forward in real chunks, not as decorative
        # animation. None when caller didn't pass one (template
        # import, tests, etc.).
        self._progress_callback = progress_callback
        # `layout_mode` controls origin-node placement on the canvas:
        #   "columns"          — per-type columns left of chapter 1.
        #   "first_appearance" — origins land in the chapter of the
        #                        scene where the entity first appears
        #                        as a chip; chapters widen on the left
        #                        to accommodate. Entities that never
        #                        appear as a chip fall back to columns.
        self.layout_mode = layout_mode if layout_mode in ("columns", "first_appearance") else "columns"
        # name → uuid maps populated as objects are created
        self.entity_id: dict[str, str] = {}
        self.relationship_id: dict[str, str] = {}
        self.knowledge_id: dict[str, str] = {}
        self.preset_list_id: dict[str, str] = {}
        self.custom_category_id: dict[str, str] = {}
        self.chapter_id: dict[str, str] = {}
        self.scene_id: dict[str, str] = {}
        # Phase 3.7d Gap A: Project Tags pool — name (verbatim) →
        # tag uuid. Filled by `_apply_project_tags` which runs before
        # every host-apply pass so `_resolve_tag_names` works during
        # entity / knowledge / relationship / preset_list /
        # reference_node materialisation. Lookup uses case-folded
        # match against `_project_tag_id_casefold` so the IR can use
        # either canonical or display casing in host `tag_names[]`.
        self.project_tag_id: dict[str, str] = {}
        self._project_tag_id_casefold: dict[str, str] = {}
        # For attribute lookups by (entity_name, attr_name) → attribute_id
        self.attribute_id: dict[tuple[str, str], str] = {}
        # Existing-name index for merge-mode collision detection
        self.existing_names: dict[str, set[str]] = {}

    # ── public ──

    # Phase 3.10 — steps that emit one progress event PER ITEM
    # inside their body (as opposed to "setup" steps that emit one
    # event at start). Kept in sync with `run()`. Router uses this
    # to size the bar's `unit_total` correctly.
    LOOP_STEP_LABELS = frozenset({
        "Entities", "Relationships", "Knowledges",
        "Reference nodes", "Scenes",
    })

    def _step(self, label: str) -> None:
        """Emit one unit-of-work progress event. Setup steps call
        this once with their step name; loop steps call this once
        per item with the item's name. The router-supplied callback
        owns the global counter against the pre-computed total."""
        if self._progress_callback:
            self._progress_callback(label)

    def run(self) -> dict:
        # Phase 3.10 — steps list drives the progress callback so
        # the modal shows REAL per-item progress (one event per
        # entity, scene, relationship, etc.) instead of a phase-
        # weighted bar that sits on one value while a 170-scene
        # loop chews through.
        # "Starting new project" framing (not "wiping") — the
        # currently-open project's save FILE is untouched on disk;
        # this step just creates the fresh in-memory Story that the
        # imported content lands into. The previous open project's
        # in-memory state is discarded, but if it was saved its
        # `.nnz` file is still there for the writer to reopen.
        init_step = (
            "Starting new project" if self.mode == "new"
            else "Indexing existing project",
            self._wipe if self.mode == "new" else self._index_existing,
        )
        steps = [
            init_step,
            ("Story metadata", self._apply_story_meta),
            # Project Tags pool must materialise before any host-apply
            # pass so each host's `tag_names[]` can resolve to fresh
            # Tag UUIDs (or to existing pool entries in merge mode).
            # Phase 3.7d Gap A.
            ("Project tags", self._apply_project_tags),
            ("Preset lists", self._apply_preset_lists),
            ("Custom categories", self._apply_custom_categories),
            ("Chapters & acts", self._apply_chapters_acts),
            ("Entities", self._apply_entities),
            # Resolve cross-entity references that couldn't be wired
            # during `_apply_entities` because the target wasn't yet
            # in the `self.entity_id` map (forward references):
            # location parents + entity_list attribute items.
            ("Cross-entity references", self._resolve_deferred_entity_refs),
            ("Relationships", self._apply_relationships_origin),
            ("Knowledges", self._apply_knowledges_origin),
            ("Reference nodes", self._apply_reference_nodes),
            ("Entity origin nodes", self._create_entity_origin_nodes),
            ("POV setup", self._ensure_pov_origin_node),
            ("Scenes", self._apply_scenes),
            # Wire flashback child scenes to declared parents (which
            # can appear before OR after the flashback in the file).
            ("Wiring flashbacks", self._wire_flashback_parents),
            # Knowledges without a scene-born `activate` event get a
            # KnowledgeOriginNode (off-canvas left of chapter 1) so
            # the chain walker has somewhere to anchor them.
            ("Knowledge origin nodes", self._create_knowledge_origin_nodes),
            # Same model rule for relationships: every relationship
            # needs an origin anchor AND each declared participant
            # needs a `join` event at that anchor.
            (
                "Relationship origin nodes",
                self._create_relationship_origin_nodes_and_joins,
            ),
            # In first-appearance layout mode, origins land in
            # per-type sub-columns to the LEFT of the scene where
            # each entity first appears as a chip.
            ("Placing origin nodes", self._place_first_appearance_origins),
            # Park the POV origin node just left of the first scene.
            ("Placing POV origin", self._position_pov_origin_node),
            ("Wiring connections", self._wire_connections),
        ]
        for label, fn in steps:
            if label not in self.LOOP_STEP_LABELS:
                # Setup step: emit ONE event at start so the bar
                # ticks forward and the label tells the writer what
                # we're doing. Loop steps skip this — they emit one
                # event per item inside fn() instead.
                self._step(label)
            fn()

        return {
            "mode": self.mode,
            "entities": sum(len(self.story.entities.__dict__[k])
                            for k in ("characters", "locations", "items", "factions", "customs")),
            "relationships": len(self.story.relationships),
            "knowledges": len(self.story.knowledges),
            "scenes": len(self.story.scenes),
        }

    def _wipe(self) -> None:
        s = self.story
        s.title = "Untitled Story"
        s.entities.characters = []
        s.entities.locations = []
        s.entities.items = []
        s.entities.factions = []
        s.entities.customs = []
        s.custom_categories = []
        s.preset_lists = []
        s.chapters = []
        s.acts = []
        s.scenes = []
        s.entity_nodes = []
        s.connections = []
        s.relationships = []
        s.knowledges = []
        s.relationship_origin_nodes = []
        s.knowledge_origin_nodes = []
        s.reference_nodes = []
        s.groups = []
        s.pov_origin_node = None
        # Seed the wiped story with the user's New-Project defaults so
        # any story-level field NOT explicitly set in the template
        # (accent_color, pov_color, time_format, week_start, autosave,
        # etc.) inherits whatever the writer would get from File → New.
        # Subsequent _apply_story_meta() overrides these where the
        # template provides a value. Local import to keep service-layer
        # imports light.
        from services import user_preferences_service
        prefs = user_preferences_service.read_user_preferences()
        for prefs_field, story_field in _PREFS_TO_STORY:
            value = getattr(prefs, prefs_field, None)
            if value is not None:
                setattr(s, story_field, value)

    def _index_existing(self) -> None:
        s = self.story
        self.existing_names = {
            "entity": {e.name for e in (s.entities.characters + s.entities.locations
                                        + s.entities.items + s.entities.factions
                                        + s.entities.customs)},
            "relationship": {r.name for r in s.relationships if r.name},
            "knowledge": {k.name for k in s.knowledges},
            "preset_list": {p.name for p in s.preset_lists},
            "custom_category": {c.name for c in s.custom_categories},
            "chapter": {c.title for c in s.chapters},
            "act": {a.title for a in s.acts},
            "scene": {sc.title for sc in s.scenes},
            "reference_node": {r.title for r in s.reference_nodes if r.title},
        }

    def _dedupe(self, kind: str, name: str) -> str:
        # Blank / unnamed titles never collide (NarrativeNode auto-numbers them
        # by position), so they skip dedup in every mode — otherwise a batch of
        # blanked "Chapter 26" titles would become "", " (2)", " (3)"…
        if self.mode != "merge" or not (name and name.strip()):
            return name
        existing = self.existing_names.setdefault(kind, set())
        if name not in existing:
            existing.add(name)
            return name
        n = 2
        while f"{name} ({n})" in existing:
            n += 1
        new_name = f"{name} ({n})"
        existing.add(new_name)
        return new_name

    # ── Story meta ──

    def _apply_story_meta(self) -> None:
        m = self.ir.story
        if not m:
            return
        if self.mode == "new":
            self.story.title = m.get("title") or "Untitled Story"
            for src, dst in [
                ("author", "author"), ("genre", "genre"), ("tense", "tense"),
                ("language", "language"), ("pov_default", "pov_type_default"),
                ("chapter_label", "chapter_label"), ("act_label", "act_label"),
            ]:
                if m.get(src):
                    setattr(self.story, dst, m[src].strip())
            # Story-level UI colours: not advertised in the template asset
            # any longer (those are program-presentation settings, not
            # narrative content) but still accepted on the import side so
            # any in-the-wild template that includes them still applies
            # cleanly.
            for src, dst in [("accent_colour", "accent_color"), ("accent_color", "accent_color"),
                             ("pov_colour", "pov_color"), ("pov_color", "pov_color")]:
                if m.get(src):
                    setattr(self.story, dst, _parse_hex_colour(m[src]))
            tags = _parse_comma_list(m.get("tags", ""))
            if tags:
                self.story.tags = tags
            tt = (m.get("time_tracking") or "").strip().lower()
            if tt in ("on", "true", "yes"):
                self.story.time_tracking_enabled = True
            elif tt in ("off", "false", "no"):
                self.story.time_tracking_enabled = False
            tf = (m.get("time_format") or "").strip().lower()
            if tf in ("12h", "24h"):
                self.story.time_format = tf
            ws = (m.get("week_start") or "").strip().lower()
            if ws in ("sunday", "monday"):
                self.story.week_start = ws
            ant = (m.get("allow_negative_time") or "").strip().lower()
            if ant in ("true", "yes", "on"):
                self.story.allow_negative_time = True

    # ── Preset Lists / Custom Categories ──

    def _apply_preset_lists(self) -> None:
        for pl in self.ir.preset_lists:
            if self.mode == "merge":
                existing = next((p for p in self.story.preset_lists if p.name == pl["name"]), None)
                if existing:
                    for v in pl["values"]:
                        if v not in existing.values:
                            existing.values.append(v)
                    self.preset_list_id[pl["name"]] = existing.id
                    continue
            new = PresetList(
                name=pl["name"],
                values=list(pl["values"]),
                # Phase 3.7d Gap A — PresetList tag_ids are baseline-
                # only (no chain history on the model).
                tag_ids=self._resolve_tag_names(pl.get("tag_names", [])),
            )
            self.story.preset_lists.append(new)
            self.preset_list_id[pl["name"]] = new.id

    def _apply_custom_categories(self) -> None:
        for c in self.ir.custom_categories:
            new_name = self._dedupe("custom_category", c["name"])
            cat = CustomCategory(name=new_name, description=c.get("description", ""),
                                  colour=c.get("colour") or "#888888")
            self.story.custom_categories.append(cat)
            self.custom_category_id[c["name"]] = cat.id

    # ── Project Tags (Phase 3.7d Gap A) ──

    def _apply_project_tags(self) -> None:
        """Materialise `ir.project_tags` pool entries onto
        `Story.project_tags` and build the name → uuid lookup that
        every host-apply pass uses to resolve `tag_names[]`.

        Entry shape (see `ImportIR` docstring):
            name:  str (required; case-insensitive unique per project)
            color: str | None (defaults to "#888888")

        Merge-mode behaviour: existing pool entries with a
        case-folded-name match are reused (find-or-create) so the
        writer's existing tags aren't duplicated when merging an IR
        that re-declares them. New-mode (after `_wipe`) starts from
        an empty pool.

        Empty / whitespace-only names are skipped silently — the
        preprocessor's job is to dedupe and strip; the engine is the
        last line of defence rather than the validator.
        """
        # In merge mode, seed the lookup tables with pre-existing
        # pool entries so subsequent host `tag_names[]` references
        # can resolve against them.
        if self.mode == "merge":
            for existing in self.story.project_tags:
                self.project_tag_id[existing.name] = existing.id
                self._project_tag_id_casefold[existing.name.casefold()] = existing.id

        for ir_pt in self.ir.project_tags:
            raw_name = ir_pt.get("name", "")
            name = raw_name.strip().lstrip("#").strip() if isinstance(raw_name, str) else ""
            if not name:
                continue
            cf = name.casefold()
            # Find-or-create against case-folded name (matches the
            # router-layer uniqueness rule documented at
            # routers/project_tags.py:61-86).
            if cf in self._project_tag_id_casefold:
                self.project_tag_id[name] = self._project_tag_id_casefold[cf]
                continue
            color = ir_pt.get("color") or "#888888"
            tag = Tag(name=name, color=color)
            self.story.project_tags.append(tag)
            self.project_tag_id[name] = tag.id
            self._project_tag_id_casefold[cf] = tag.id

    def _resolve_tag_names(self, tag_names) -> list[str]:
        """Translate a host dict's `tag_names[]` (list of strings) to
        a deduped list of pool tag UUIDs. Unknown names skip with no
        error — the preprocessor should ensure every host-tag reference
        has a matching pool entry, and silent skip beats blowing up the
        whole import for a typo.

        Case-folded resolution so the IR can carry whatever casing
        the source format used; the pool's canonical casing (the
        first-seen / first-created entry's display name) wins.
        """
        if not tag_names:
            return []
        out: list[str] = []
        seen: set[str] = set()
        for n in tag_names:
            if not isinstance(n, str):
                continue
            cf = n.strip().lstrip("#").strip().casefold()
            if not cf:
                continue
            tag_id = self._project_tag_id_casefold.get(cf)
            if tag_id and tag_id not in seen:
                out.append(tag_id)
                seen.add(tag_id)
        return out

    # ── Chapters / Acts ──

    def _resolve_titles(self, titles: list[str]) -> list[str]:
        """Phase 5.9 — decide whether to clean a GROUP of chapter or act
        titles, then return the per-title result. Prefix-numbering is a
        manuscript-wide convention, so cleaning is applied only when a
        majority of the group's titles actually carry a strippable prefix; a
        stray one or two (e.g. a real title that merely looks like "Chapter
        Eleven Bankruptcy") is left alone. Off-toggle = verbatim."""
        if not self.clean_chapter_act_titles:
            return [t or "" for t in titles]
        present = [t for t in titles if t and t.strip()]
        if not present:
            return [t or "" for t in titles]
        # Count titles that CARRY a numbering prefix (incl. bare "Chapter 26",
        # which can't be stripped but is still evidence of the convention) —
        # not titles that would change.
        prefixed = sum(1 for t in present if has_numbering_prefix(t))
        if prefixed / len(present) >= _TITLE_CLEAN_MIN_FRACTION:
            # blank_pure_prefix: a bare "Chapter 26" becomes an unnamed chapter
            # (auto-numbered by position) instead of a stale stored name.
            return [clean_chapter_act_title(t, blank_pure_prefix=True) for t in titles]
        return [t or "" for t in titles]

    def _apply_chapters_acts(self) -> None:
        # Clean BEFORE dedupe so collision suffixes apply to the cleaned name;
        # the chapter_id map key stays the ORIGINAL IR title so act -> chapter
        # references still resolve. Clean/skip is decided per group.
        ch_titles = self._resolve_titles([c["title"] for c in self.ir.chapters])
        for c, resolved in zip(self.ir.chapters, ch_titles):
            new_title = self._dedupe("chapter", resolved)
            ch = Chapter(title=new_title, colour=c.get("colour"), width=c.get("width", 540.0))
            self.story.chapters.append(ch)
            self.chapter_id[c["title"]] = ch.id
        ac_titles = self._resolve_titles([a["title"] for a in self.ir.acts])
        for a, resolved in zip(self.ir.acts, ac_titles):
            new_title = self._dedupe("act", resolved)
            cids = [self.chapter_id[ch] for ch in a["chapters"] if ch in self.chapter_id]
            self.story.acts.append(Act(title=new_title, colour=a.get("colour"), chapter_ids=cids))

    # ── Entities ──

    def _apply_entities(self) -> None:
        # Phase 3.10 — emit one progress event per entity with the
        # entity's display name so the modal shows "Character: Alice",
        # "Location: The Obsidian Citadel", etc. as each one lands.
        # IR entities are dicts (see `_create_entity` signature).
        for ent in self.ir.characters:
            self._step(f"Character: {ent['name']}")
            self._create_entity(ent, "character", self.story.entities.characters)
        for ent in self.ir.locations:
            self._step(f"Location: {ent['name']}")
            self._create_entity(ent, "location", self.story.entities.locations)
        for ent in self.ir.items:
            self._step(f"Item: {ent['name']}")
            self._create_entity(ent, "item", self.story.entities.items)
        for ent in self.ir.factions:
            self._step(f"Faction: {ent['name']}")
            self._create_entity(ent, "faction", self.story.entities.factions)
        for ent in self.ir.customs:
            self._step(f"Custom: {ent['name']}")
            self._create_entity(ent, "custom", self.story.entities.customs)

    def _resolve_deferred_entity_refs(self) -> None:
        """Resolve cross-entity name references that need the full
        `self.entity_id` map to be populated before they can be
        wired. Two distinct cases:

        1. **Location parent_id** — `_create_entity` sets `parent_id`
           best-effort if the parent already exists in `self.entity_id`
           at creation time. Templates that declare children before
           parents (or interleave them with non-location entities) need
           this post-pass. We walk every location IR entry and patch
           the corresponding Entity's `parent_id`.

        2. **`entity_list` attribute items** — `_build_attribute`
           resolves entity names to ids via `self.entity_id`, but at
           build time only the entities encountered so far in
           declaration order are in the map. Forward references (e.g.
           Alice declared first with `entity_list: Allies = [Bob]`,
           Bob declared after) produce an empty resolved list and
           store `value: "[]"`. This pass re-resolves every
           `entity_list` attribute against the now-complete map.
        """
        import json

        # Build lookup: entity_id → Entity object across every bucket.
        ents_by_id: dict[str, Entity] = {}
        for bucket_name in self._TYPED_BUCKET_KEYS:
            bucket = getattr(self.story.entities, bucket_name, None) or []
            for e in bucket:
                ents_by_id[e.id] = e

        # 1. Location parent_id resolution.
        for ir_loc in self.ir.locations:
            parent_name = ir_loc.get("parent")
            if not parent_name:
                continue
            loc_id = self.entity_id.get(ir_loc["name"])
            if not loc_id:
                continue
            loc = ents_by_id.get(loc_id)
            if loc is None:
                continue
            parent_id = self.entity_id.get(parent_name)
            if not parent_id or parent_id == loc_id:
                continue  # unresolved or self-reference — leave parent unset
            loc.parent_id = parent_id

        # 2. entity_list attribute re-resolution.
        # Walk every entity in every bucket; for each `entity_list`
        # attribute, locate the corresponding IR attribute (by entity
        # name + attribute name) and re-resolve its items against the
        # final `self.entity_id` map.
        # Build IR lookup keyed by (entity name → IR attributes list).
        ir_attrs_by_entity_name: dict[str, list[dict]] = {}
        for ir_ent in (
            *self.ir.characters, *self.ir.locations, *self.ir.items,
            *self.ir.factions, *self.ir.customs,
        ):
            ir_attrs_by_entity_name[ir_ent["name"]] = ir_ent.get("attributes") or []

        # Reverse map: entity_id → its IR name (so we can find its
        # original IR attribute declarations even after rename-dedupe).
        entity_id_to_ir_name: dict[str, str] = {
            ir_name: eid for ir_name, eid in self.entity_id.items()
        }
        # The map above goes ir_name → eid; we need the reverse.
        ir_name_by_id: dict[str, str] = {
            eid: ir_name for ir_name, eid in entity_id_to_ir_name.items()
        }

        for ent_id, ent in ents_by_id.items():
            ir_name = ir_name_by_id.get(ent_id)
            if not ir_name:
                continue
            ir_attrs = ir_attrs_by_entity_name.get(ir_name) or []
            ir_attrs_by_name = {a["name"]: a for a in ir_attrs}
            for attr in ent.attributes or []:
                if attr.attribute_type != "entity_list":
                    continue
                ir_attr = ir_attrs_by_name.get(attr.name)
                if not ir_attr:
                    continue
                items = list(ir_attr.get("items") or [])
                resolved = [self.entity_id[n] for n in items if n in self.entity_id]
                attr.value = json.dumps(resolved)

    def _create_entity(self, ir_ent: dict, etype: str, target_list: list) -> None:
        new_name = self._dedupe("entity", ir_ent["name"])
        attrs = []
        for ir_attr in ir_ent.get("attributes", []):
            attr = self._build_attribute(ir_attr, ir_ent["name"])
            if attr is not None:
                attrs.append(attr)
                self.attribute_id[(ir_ent["name"], ir_attr["name"])] = attr.id
        kwargs: dict[str, Any] = {
            "type": etype,
            "name": new_name,
            "colour": ir_ent.get("colour") or "#888888",
            "description": ir_ent.get("description", ""),
            "notes": ir_ent.get("notes", ""),
            "attributes": attrs,
            "aliases": [Alias(value=v) for v in ir_ent.get("aliases", [])],
            "awareness_scale": ir_ent.get("awareness_scale", "binary"),
            # Phase 3.7d Gap A — baseline tag_ids at the entity's
            # origin. The chain-aware path because this is the
            # Entity's first-creation point; the chain explicitly
            # does not record changes at origin.
            "tag_ids": self._resolve_tag_names(ir_ent.get("tag_names", [])),
            # Phase 3.7d Gap B — baseline profile image at origin.
            # Same chain-aware rationale as tag_ids above. Empty /
            # missing IR field leaves the field as `None`.
            "profile_image_ref": ir_ent.get("profile_image_ref") or None,
        }
        if etype == "custom":
            cat_name = ir_ent.get("category", "")
            if cat_name and cat_name in self.custom_category_id:
                kwargs["category_id"] = self.custom_category_id[cat_name]
            if ir_ent.get("label"):
                kwargs["label"] = ir_ent["label"]
        # Location parent — best-effort during creation. If the
        # parent appears later in the template, `_resolve_deferred_entity_refs`
        # below patches the parent_id in a post-pass once the full
        # entity_id map is populated.
        if etype == "location" and ir_ent.get("parent"):
            pname = ir_ent["parent"]
            if pname in self.entity_id:
                kwargs["parent_id"] = self.entity_id[pname]
        ent = Entity(**kwargs)
        target_list.append(ent)
        self.entity_id[ir_ent["name"]] = ent.id

    def _build_attribute(self, ir_attr: dict, owner_name: str) -> Optional[Attribute]:
        atype = ir_attr["type"]
        kwargs: dict[str, Any] = {
            "name": ir_attr.get("name", ""),
            "attribute_type": atype,
            "value": ir_attr.get("value", ""),
        }
        if atype == "preset":
            pn = ir_attr.get("preset_list_name")
            if pn and pn in self.preset_list_id:
                kwargs["preset_list_id"] = self.preset_list_id[pn]
                kwargs["preset_list_name"] = pn
        elif atype == "number":
            kwargs["number_value"] = ir_attr.get("number_value", 0.0)
        elif atype in ("text_list", "entity_list"):
            import json
            items = list(ir_attr.get("items", []))
            if atype == "entity_list":
                # resolve names → ids; skip unresolvable
                items = [self.entity_id[n] for n in items if n in self.entity_id]
            kwargs["value"] = json.dumps(items)
        elif atype in ("circumstance", "motivator"):
            kwargs["description"] = ir_attr.get("description", "")
            kwargs["value"] = ""
            if ir_attr.get("intensity") is not None:
                kwargs["intensity"] = ir_attr["intensity"]
        elif atype == "file":
            kwargs["file_ref"] = None
        try:
            return Attribute(**kwargs)
        except Exception:
            return None

    # ── Relationships (origin) ──

    def _compile_hierarchy_config(self, h: dict) -> Optional[HierarchyConfig]:
        """Build a HierarchyConfig from parsed hierarchy template data.

        Supported shapes (mode + tree is the richer canonical form;
        root + order is the legacy flat shorthand kept for backward
        compatibility):

          mode: <participants | roles>      (optional, default 'participants')
          tree:                              (optional, nested-bullet form)
            - <root1>
              - <child>
                - <grandchild>
              - <child>
            - <root2>
          root:  <name>                      (legacy flat form — single root)
          order: <comma-separated names>     (legacy flat form — descendants)

        For mode='participants', tree-node names are resolved through
        ``self.entity_id`` (entity-name → entity-id). Names that don't
        resolve are dropped silently. For mode='roles', node names are
        role-value strings used as IDs directly (no entity lookup).
        """
        if not h:
            return None
        mode = (h.get("mode") or "participants").strip().lower()
        if mode not in ("participants", "roles"):
            mode = "participants"

        def build_node(item: dict) -> Optional[HierarchyNode]:
            name = (item.get("name") or "").strip()
            if not name:
                return None
            if mode == "participants":
                nid = self.entity_id.get(name)
                if not nid:
                    return None
            else:
                nid = name
            kids: list[HierarchyNode] = []
            for c in item.get("children", []) or []:
                cn = build_node(c)
                if cn:
                    kids.append(cn)
            return HierarchyNode(id=nid, children=kids)

        roots: list[HierarchyNode] = []
        tree = h.get("tree")
        if tree:
            for item in tree:
                n = build_node(item)
                if n:
                    roots.append(n)
        elif h.get("root") and h.get("order"):
            # Legacy flat shorthand → single-root participants tree.
            if mode != "participants":
                return None
            root_id = self.entity_id.get(h["root"])
            if not root_id:
                return None
            order_ids = [self.entity_id[n] for n in h["order"] if n in self.entity_id]
            children = [HierarchyNode(id=eid) for eid in order_ids if eid != root_id]
            roots = [HierarchyNode(id=root_id, children=children)]

        if not roots:
            return None
        return HierarchyConfig(enabled=True, mode=mode, roots=roots)

    def _apply_relationships_origin(self) -> None:
        for ir_rel in self.ir.relationships:
            self._step(f"Relationship: {ir_rel['name']}")
            new_name = self._dedupe("relationship", ir_rel["name"])
            participant_roles: dict[str, ParticipantRole] = {}
            for p in ir_rel["participants"]:
                eid = self.entity_id.get(p["name"])
                if not eid:
                    continue
                if p.get("role"):
                    participant_roles[eid] = ParticipantRole(value=p["role"])
            hierarchy = None
            h = ir_rel.get("hierarchy")
            if h:
                hierarchy = self._compile_hierarchy_config(h)
            membership_of = None
            if ir_rel.get("membership_of") and ir_rel["membership_of"] in self.entity_id:
                membership_of = self.entity_id[ir_rel["membership_of"]]
            rel = Relationship(
                name=new_name,
                description=ir_rel.get("description", ""),
                participant_roles=participant_roles,
                hierarchy=hierarchy,
                membership_of=membership_of,
                awareness_scale=ir_rel.get("awareness_scale", "binary"),
                # Phase 3.7d Gap A — baseline tag_ids at the
                # Relationship's origin (its establishment point).
                tag_ids=self._resolve_tag_names(ir_rel.get("tag_names", [])),
            )
            self.story.relationships.append(rel)
            self.relationship_id[ir_rel["name"]] = rel.id

    # ── Knowledge (origin) ──

    def _apply_knowledges_origin(self) -> None:
        for ir_kn in self.ir.knowledges:
            self._step(f"Knowledge: {ir_kn['name']}")
            new_name = self._dedupe("knowledge", ir_kn["name"])
            awareness: dict[str, int] = {}
            for a in ir_kn.get("awareness", []):
                eid = self.entity_id.get(a["observer"])
                if eid:
                    awareness[eid] = a["level"]
            kn = Knowledge(
                name=new_name,
                description=ir_kn.get("description", ""),
                colour=ir_kn.get("colour") or "#888888",
                notes=ir_kn.get("notes", ""),
                awareness_scale=ir_kn.get("awareness_scale", "full"),
                awareness=awareness if awareness else None,
                # Phase 3.7d Gap A — baseline tag_ids at the
                # Knowledge's source-event origin.
                tag_ids=self._resolve_tag_names(ir_kn.get("tag_names", [])),
                # Phase 3.7d Gap B — baseline profile image at the
                # Knowledge's origin. Same chain-aware rationale as
                # tag_ids above.
                profile_image_ref=ir_kn.get("profile_image_ref") or None,
            )
            self.story.knowledges.append(kn)
            self.knowledge_id[ir_kn["name"]] = kn.id

    # ── Reference Nodes (Phase 3.7d Gap C) ──

    # Deterministic placement constants for Reference Nodes. Parked in
    # a dedicated column to the LEFT of the per-type entity-origin
    # columns (which themselves sit left of chapter 1). Stacked
    # vertically with a fixed step so multiple Reference Nodes don't
    # overlap. Deliberate plain constants (no random / no time-based)
    # so the regression-snapshot positions are reproducible.
    _REF_NODE_COLUMN_X        = -1400.0
    _REF_NODE_FIRST_Y         = 100.0
    _REF_NODE_VERTICAL_STEP   = 240.0
    _REF_NODE_DEFAULT_COLOUR  = "#40afd0"
    _REF_NODE_DEFAULT_WIDTH   = 360.0
    _REF_NODE_DEFAULT_HEIGHT  = 200.0

    def _apply_reference_nodes(self) -> None:
        """Materialise `ir.reference_nodes` into `Story.reference_nodes`.

        Entry shape (see `ImportIR` docstring):
            title, colour, content, is_rich_text, sub_type, file_ref

        Sub-type defaults to `'note'`; `colour` falls back to the
        canonical Reference-Node tint `#40afd0`. Title collisions
        with existing nodes (merge mode) go through the same dedupe
        helper used by entities / relationships / knowledges so the
        writer's library stays readable.

        Positions are picked by this method (no per-entry `position`
        field on the IR yet); the preprocessor's job is to specify
        WHAT lands, not WHERE. Cluster columned left-of-everything-else
        with stable vertical stacking — keeps the canvas tidy and the
        regression-snapshot reproducible.
        """
        for index, ir_rn in enumerate(self.ir.reference_nodes):
            raw_title = ir_rn.get("title", "")
            self._step(f"Reference node: {raw_title or '(untitled)'}")
            new_title = self._dedupe("reference_node", raw_title) if raw_title else ""
            sub_type = ir_rn.get("sub_type") or "note"
            if sub_type not in ("note", "media", "concept"):
                # Unknown sub-type: coerce to 'note' so the model
                # validator doesn't reject the import wholesale.
                sub_type = "note"
            rn = ReferenceNode(
                sub_type=sub_type,
                title=new_title,
                colour=ir_rn.get("colour") or self._REF_NODE_DEFAULT_COLOUR,
                content=ir_rn.get("content", ""),
                is_rich_text=bool(ir_rn.get("is_rich_text", False)),
                file_ref=ir_rn.get("file_ref"),
                position=Position(
                    x=self._REF_NODE_COLUMN_X,
                    y=self._REF_NODE_FIRST_Y + index * self._REF_NODE_VERTICAL_STEP,
                ),
                width=self._REF_NODE_DEFAULT_WIDTH,
                height=self._REF_NODE_DEFAULT_HEIGHT,
                # Phase 3.7d Gap A — Reference Node tag_ids are
                # baseline-only (no chain history on the model;
                # "free-floating canvas annotation").
                tag_ids=self._resolve_tag_names(ir_rn.get("tag_names", [])),
            )
            self.story.reference_nodes.append(rn)

    # ── Scenes ──

    # Origin-layout constants. Shared between the per-type-columns
    # layout (left of chapter 1) and the per-scene sub-columns layout
    # (left of each scene where an entity first appears as a chip).
    _ORIGIN_COLUMN_WIDTH = 320.0
    _ORIGIN_NODE_WIDTH_EST = 220.0
    # The POV origin node lives in its OWN slot between the pre-chapter
    # columns and chapter 1, so it never overlaps an entity origin
    # column regardless of which layout mode is in use.
    #     [ pre-chapter cols ][ GAP_TO_POV ][ POV col ][ GAP_TO_CHAPTER ][ chapter 1 ]
    # The POV node itself is 48 × 24 px (see PovOriginNode.jsx); the
    # column is just wide enough to give it a small breathing margin.
    _POV_COL_WIDTH         = 60.0
    _POV_NODE_WIDTH_EST    = 48.0
    _POV_GAP_TO_CHAPTER    = 30.0   # POV col right edge → chapter 1 left edge
    _POV_GAP_TO_PRE_CHAPTER = 20.0  # pre-chapter right edge → POV col left edge
    # Total buffer between the rightmost pre-chapter column and chapter 1.
    _ORIGIN_PRE_CHAPTER_BUFFER = (
        _POV_GAP_TO_CHAPTER + _POV_COL_WIDTH + _POV_GAP_TO_PRE_CHAPTER  # 240 px
    )
    _ORIGIN_SUBCOL_WIDTH = 280.0          # per-scene sub-column width (slightly tighter than pre-chapter columns)
    _ORIGIN_SUBCOL_GAP = 40.0             # gap between rightmost sub-column and the scene
    _ORIGIN_Y_STEP = 220.0
    _SCENE_Y_DEFAULT = 600.0  # default y-position used by _apply_scenes
    _TYPED_BUCKET_KEYS = ("characters", "locations", "items", "factions", "customs")

    def _compute_first_appearance_layout(self) -> dict:
        """Build a map from entity_id to (ir_scene_idx, type_idx) for
        the first scene where each entity appears as a chip. Used by
        first-appearance origin layout to position origin nodes inside
        their scene's chapter rather than to the left of chapter 1.

        Returns a dict with:
            "first_scene_for_entity": {entity_id: ir_scene_idx}
            "entities_at_scene":      {ir_scene_idx: list[(type_idx, entity_id)]}
            "unreferenced_entities":  {type_key: list[Entity]}
        """
        first_scene_for_entity: dict[str, int] = {}
        entities_at_scene: dict[int, list[tuple[int, str]]] = {}
        # Walk IR scenes in declaration order — that's the canvas
        # left-to-right order within chapters, so "first appearance"
        # = earliest IR scene whose chip-list contains the entity.
        for sc_idx, ir_sc in enumerate(self.ir.scenes):
            for type_idx, key in enumerate(self._TYPED_BUCKET_KEYS):
                for nm in ir_sc.get(key, []) or []:
                    eid = self.entity_id.get(nm)
                    if not eid or eid in first_scene_for_entity:
                        continue
                    first_scene_for_entity[eid] = sc_idx
                    entities_at_scene.setdefault(sc_idx, []).append((type_idx, eid))
        # Unreferenced = entities never appearing as a chip in any scene.
        unreferenced: dict[str, list] = {k: [] for k in self._TYPED_BUCKET_KEYS}
        for key in self._TYPED_BUCKET_KEYS:
            for ent in getattr(self.story.entities, key):
                if ent.id not in first_scene_for_entity:
                    unreferenced[key].append(ent)
        return {
            "first_scene_for_entity": first_scene_for_entity,
            "entities_at_scene": entities_at_scene,
            "unreferenced_entities": unreferenced,
        }

    def _scene_sub_column_padding(self, ir_scene_idx: int) -> float:
        """Return the px the chapter must reserve to the LEFT of the
        scene at `ir_scene_idx` to fit its first-appearance origin
        sub-columns. Zero when there are no first-appearing origins
        at that scene (or in columns mode)."""
        if not self._first_appearance_layout:
            return 0.0
        entries = self._first_appearance_layout["entities_at_scene"].get(ir_scene_idx, [])
        if not entries:
            return 0.0
        type_indices_present = {ti for (ti, _) in entries}
        n_subcols = len(type_indices_present)
        return n_subcols * self._ORIGIN_SUBCOL_WIDTH + self._ORIGIN_SUBCOL_GAP

    def _create_entity_origin_nodes(self) -> None:
        # Compute first-appearance map up front when in first_appearance
        # layout mode — both _apply_scenes (for chapter widening +
        # scene placement) and _place_first_appearance_origins (for
        # origin-node positions, called after scenes are laid out)
        # consume it.
        if self.layout_mode == "first_appearance":
            self._first_appearance_layout = self._compute_first_appearance_layout()
            # Place ONLY entities that don't appear as chips in any
            # scene into the per-type-columns layout left of chapter 1.
            # First-appearance entities get placed by
            # _place_first_appearance_origins after _apply_scenes.
            buckets = [
                self._first_appearance_layout["unreferenced_entities"][k]
                for k in self._TYPED_BUCKET_KEYS
            ]
        else:
            self._first_appearance_layout = None
            # All entities in per-type-columns left of chapter 1.
            buckets = [
                getattr(self.story.entities, k) for k in self._TYPED_BUCKET_KEYS
            ]
        self._place_pre_chapter_columns(buckets)
        self._refresh_entity_origin_node_index()

    def _place_pre_chapter_columns(self, typed_buckets: list[list]) -> None:
        # Lay out origin nodes in PER-TYPE columns to the left of the
        # first chapter. Order: Characters, Locations, Items, Factions,
        # Customs (matches the entity-bucket order). Empty buckets
        # don't reserve a column. Within each column entities stack
        # top-to-bottom in declaration order. The top row aligns with
        # the scene-node y so the columns visually line up with the
        # chapter row instead of floating high above it.
        Y_START = self._SCENE_Y_DEFAULT
        populated = [b for b in typed_buckets if b]
        if not populated:
            return
        right_edge_x = self.story.chapter_x_offset - self._ORIGIN_PRE_CHAPTER_BUFFER
        n_cols = len(populated)
        leftmost_left_x = right_edge_x - n_cols * self._ORIGIN_COLUMN_WIDTH
        for col_idx, bucket in enumerate(populated):
            col_left = leftmost_left_x + col_idx * self._ORIGIN_COLUMN_WIDTH
            entity_x = col_left + (self._ORIGIN_COLUMN_WIDTH - self._ORIGIN_NODE_WIDTH_EST) / 2
            for ent_idx, ent in enumerate(bucket):
                y = Y_START + ent_idx * self._ORIGIN_Y_STEP
                node = EntityNode(entity_id=ent.id, position=Position(x=entity_x, y=y))
                self.story.entity_nodes.append(node)

    def _refresh_entity_origin_node_index(self) -> None:
        """Track latest origin node per entity (for the wiring step)."""
        self._entity_origin_node: dict[str, str] = {}
        for n in self.story.entity_nodes:
            if n.entity_id and not n.is_modifier:
                self._entity_origin_node[n.entity_id] = n.id

    def _place_first_appearance_origins(self) -> None:
        """Place origin nodes in per-type sub-columns to the LEFT of
        the scene where each entity first appears as a chip. Called
        after _apply_scenes has populated `self._scene_x_by_ir_idx`
        with each scene's left-edge x in flow space. Origins of the
        same type at the same scene stack vertically; types stack as
        side-by-side narrow sub-columns matching the bucket order.
        """
        if not self._first_appearance_layout:
            return
        entities_at_scene = self._first_appearance_layout["entities_at_scene"]
        if not entities_at_scene:
            return
        # Build name → entity lookup once.
        ent_by_id: dict[str, object] = {}
        for k in self._TYPED_BUCKET_KEYS:
            for ent in getattr(self.story.entities, k):
                ent_by_id[ent.id] = ent
        # Per-scene placement.
        for ir_idx, entries in entities_at_scene.items():
            scene_left = self._scene_x_by_ir_idx.get(ir_idx)
            if scene_left is None:
                continue
            # Group entries by type_idx so we know which sub-columns
            # are populated and in what order.
            by_type: dict[int, list[str]] = {}
            for (type_idx, eid) in entries:
                by_type.setdefault(type_idx, []).append(eid)
            populated_types = sorted(by_type.keys())
            # Right-most sub-column ends `_ORIGIN_SUBCOL_GAP` left of
            # the scene. Sub-columns laid out left-to-right by type.
            right_edge_x = scene_left - self._ORIGIN_SUBCOL_GAP
            n_subcols = len(populated_types)
            leftmost_left_x = right_edge_x - n_subcols * self._ORIGIN_SUBCOL_WIDTH
            scene_y = self._scene_y_by_ir_idx.get(ir_idx, 600.0)
            for col_pos, type_idx in enumerate(populated_types):
                col_left = leftmost_left_x + col_pos * self._ORIGIN_SUBCOL_WIDTH
                entity_x = col_left + (self._ORIGIN_SUBCOL_WIDTH - self._ORIGIN_NODE_WIDTH_EST) / 2
                for ent_pos, eid in enumerate(by_type[type_idx]):
                    if eid not in ent_by_id:
                        continue
                    y = scene_y + ent_pos * self._ORIGIN_Y_STEP
                    node = EntityNode(entity_id=eid, position=Position(x=entity_x, y=y))
                    self.story.entity_nodes.append(node)
        # Refresh the latest-origin-per-entity index after appending.
        self._refresh_entity_origin_node_index()

    def _apply_scenes(self) -> None:
        # Chapter membership in NarrativeNode is GEOMETRIC — derived
        # from the scene's center-x against the chapter columns'
        # cumulative widths (see frontend/src/utils/chapterMembership.js).
        # Each scene must place inside its declared chapter's column
        # or it will read as "no chapter" in the canvas / Table of
        # Contents / export pipeline.
        #
        # Strategy: pre-resize each chapter's column to comfortably
        # fit the number of scenes assigned to it, then lay scenes
        # out inside those columns. Chapter widths are a user-adjustable
        # display setting — widening on import is in line with how a
        # writer would arrange the canvas by hand.

        SCENE_WIDTH = 400.0
        SCENE_HEIGHT = 320.0
        SCENE_GAP = 60.0
        CHAPTER_INSET = 40.0
        DEFAULT_CHAPTER_WIDTH = 540.0

        chapter_id_by_title = {ch.title: ch.id for ch in self.story.chapters}
        for ir_title, new_id in self.chapter_id.items():
            chapter_id_by_title.setdefault(ir_title, new_id)

        # Count scenes per chapter from the IR + collect each chapter's
        # ordered IR-scene indices so chapter widening can factor in
        # per-scene origin sub-column paddings (first-appearance mode).
        scene_count_in: dict[str, int] = {}
        chapter_scene_ir_indices: dict[str, list[int]] = {}
        unbound_ir_indices: list[int] = []
        for ir_idx, ir_sc in enumerate(self.ir.scenes):
            cid = chapter_id_by_title.get(ir_sc.get("chapter") or "")
            if cid:
                scene_count_in[cid] = scene_count_in.get(cid, 0) + 1
                chapter_scene_ir_indices.setdefault(cid, []).append(ir_idx)
            else:
                unbound_ir_indices.append(ir_idx)

        # Per-scene left padding. In first-appearance mode this is the
        # space the chapter must reserve to the left of the scene to
        # fit its origin sub-columns; in columns mode it's always 0.
        scene_left_pad: dict[int, float] = {
            ir_idx: self._scene_sub_column_padding(ir_idx)
            for ir_idx in range(len(self.ir.scenes))
        }

        # Resize each chapter column to fit its scenes plus the
        # per-scene origin sub-column paddings.
        for ch in self.story.chapters:
            n = scene_count_in.get(ch.id, 0)
            if n <= 0:
                ch.width = max(ch.width, DEFAULT_CHAPTER_WIDTH)
                continue
            ir_indices = chapter_scene_ir_indices.get(ch.id, [])
            total_pad = sum(scene_left_pad.get(i, 0.0) for i in ir_indices)
            if n == 1:
                # Single-scene chapter: width = inset*2 + scene + its
                # left-padding (so the scene + origins fit centred /
                # right-aligned within the column).
                required = 2 * CHAPTER_INSET + total_pad + SCENE_WIDTH
                ch.width = max(ch.width, required, DEFAULT_CHAPTER_WIDTH)
            else:
                required = (
                    2 * CHAPTER_INSET
                    + total_pad
                    + n * SCENE_WIDTH
                    + (n - 1) * SCENE_GAP
                )
                ch.width = max(ch.width, required)

        # Recompute chapter column ranges with the (possibly widened)
        # widths.
        x_offset = self.story.chapter_x_offset
        chapter_left: dict[str, float] = {}
        chapter_right: dict[str, float] = {}
        running = x_offset
        for ch in self.story.chapters:
            chapter_left[ch.id] = running
            running += ch.width
            chapter_right[ch.id] = running
        last_right = running

        # Track the running cursor inside each chapter so per-scene
        # left-pad insets compose correctly across multiple scenes.
        chapter_cursor: dict[str, float] = {
            cid: chapter_left[cid] + CHAPTER_INSET for cid in chapter_left
        }
        scene_idx_in: dict[str, int] = {}
        unbound_offset = 0.0
        y = self._SCENE_Y_DEFAULT
        # ir-scene-idx → (left x, top y) so _place_first_appearance_origins
        # can position origins to the left of each scene after this loop.
        self._scene_x_by_ir_idx: dict[int, float] = {}
        self._scene_y_by_ir_idx: dict[int, float] = {}
        self._last_scene_for_entity: dict[str, str] = {}
        self._scene_pov: dict[str, str] = {}
        self._scene_order: list[str] = []

        for ir_idx, ir_sc in enumerate(self.ir.scenes):
            self._step(f"Scene: {ir_sc.get('title') or '(untitled scene)'}")
            cid = chapter_id_by_title.get(ir_sc.get("chapter") or "")
            left_pad = scene_left_pad.get(ir_idx, 0.0)
            if cid and cid in chapter_left:
                count = scene_count_in.get(cid, 1)
                idx = scene_idx_in.get(cid, 0)
                left = chapter_left[cid]
                right = chapter_right[cid]
                if count == 1 and left_pad <= 0:
                    width = right - left
                    cx = left + width / 2.0
                    x = cx - SCENE_WIDTH / 2.0
                else:
                    # Compose left-to-right: cursor + this-scene's
                    # left-padding lands the scene's left edge.
                    x = chapter_cursor[cid] + left_pad
                    chapter_cursor[cid] = x + SCENE_WIDTH + SCENE_GAP
                scene_idx_in[cid] = idx + 1
            else:
                # Null / unknown chapter — place past the last column
                # with a stagger so the writer can find them.
                x = last_right + 80.0 + unbound_offset + left_pad
                unbound_offset += SCENE_WIDTH + SCENE_GAP + left_pad

            sc = self._build_scene(ir_sc, x, y)
            sc.width = SCENE_WIDTH
            sc.height = SCENE_HEIGHT
            self.story.scenes.append(sc)
            self.scene_id[ir_sc["title"]] = sc.id
            self._scene_order.append(sc.id)
            self._scene_x_by_ir_idx[ir_idx] = x
            self._scene_y_by_ir_idx[ir_idx] = y
            # Flashback scenes inherit chips + chain state from their
            # parent at render time — applying chain-tracked changes
            # to them is meaningless, so skip the change-bullet pass.
            # The applier will surface the writer's chain narrative
            # via the parent scene's changes instead.
            if sc.is_flashback:
                continue
            for change in ir_sc.get("changes", []):
                self._apply_change(sc, ir_sc, change)

    def _build_scene(self, ir_sc: dict, x: float, y: float) -> SceneNode:
        title = self._dedupe("scene", ir_sc["title"])
        sc = SceneNode(
            title=title,
            description=ir_sc.get("description", ""),
            main_content=_markdown_to_tiptap_html(ir_sc.get("content", "")),
            position=Position(x=x, y=y),
        )

        # Flashback child scenes inherit chip lists + POV from their
        # parent at render time, so the IR's chip + POV fields are
        # intentionally ignored here (the spec also tells writers not
        # to declare them on a flashback). The `parent_scene_id` is
        # wired up later in `_wire_flashback_parents` once every scene
        # in the IR has an id assigned, because the parent may be
        # declared after the flashback in the file.
        is_flashback = bool(ir_sc.get("flashback_of"))
        if is_flashback:
            sc.is_flashback = True
            # Still apply scene-level time fields + circumstances +
            # the scene's own description / content so the flashback
            # carries its own author commentary. Skip chips, POV, and
            # change-records — those are inherited / not meaningful.
            self._apply_time_fields(sc, ir_sc)
            for c in ir_sc.get("circumstances", []):
                try:
                    sc.circumstances.append(Circumstance(
                        name=c.get("name") or None,
                        description=c.get("description", ""),
                        intensity=c.get("intensity"),
                    ))
                except Exception:
                    pass
            return sc

        def add_chips(names: list[str], target: list, etype: str) -> None:
            for nm in names:
                eid = self.entity_id.get(nm)
                if eid:
                    target.append(EntityRef(entity_id=eid))

        add_chips(ir_sc.get("characters", []), sc.characters, "character")
        add_chips(ir_sc.get("locations", []), sc.locations, "location")
        add_chips(ir_sc.get("items", []), sc.items, "item")
        add_chips(ir_sc.get("factions", []), sc.factions, "faction")
        add_chips(ir_sc.get("customs", []), sc.customs, "custom")

        # POV
        if ir_sc.get("pov"):
            pov_eid = self.entity_id.get(ir_sc["pov"])
            if pov_eid:
                for ref in sc.characters:
                    if ref.entity_id == pov_eid:
                        ref.has_pov = True
                        sc.pov_entity_id = pov_eid
                        self._scene_pov[sc.id] = pov_eid
                        break

        # Time fields
        self._apply_time_fields(sc, ir_sc)

        # Scene-level circumstances
        for c in ir_sc.get("circumstances", []):
            try:
                sc.circumstances.append(Circumstance(
                    name=c.get("name") or None,
                    description=c.get("description", ""),
                    intensity=c.get("intensity"),
                ))
            except Exception:
                pass
        return sc

    def _wire_flashback_parents(self) -> None:
        """Resolve every flashback scene's `flashback_of: <parent
        title>` reference into a real `parent_scene_id` link + a
        broadcast-style transition wire from parent to flashback.

        Runs after `_apply_scenes` so every scene has a final id
        assigned via `self.scene_id`. Parents declared either before
        or after the flashback in the file resolve cleanly.

        Validation (each invalid case leaves the flashback orphaned —
        the existing `flashback_no_parent` runtime alert in
        `frontend/src/hooks/useAlerts.js` surfaces orphans for the
        writer to resolve on the canvas, so no synchronous warn is
        threaded through the applier):
          - Parent title must resolve to a scene declared in this
            template.
          - Flashback-of-flashback is rejected (mirrors the canvas
            `addConnection` guard).
          - Self-reference is rejected.
        """
        # Quick lookup: scene id → SceneNode.
        sc_by_id: dict[str, SceneNode] = {sc.id: sc for sc in self.story.scenes}

        for ir_sc in self.ir.scenes:
            parent_title = ir_sc.get("flashback_of")
            if not parent_title:
                continue
            flashback_title = ir_sc["title"]
            flashback_id = self.scene_id.get(flashback_title)
            parent_id = self.scene_id.get(parent_title)
            if not flashback_id or not parent_id:
                continue
            if parent_id == flashback_id:
                continue
            parent_sc = sc_by_id.get(parent_id)
            flashback_sc = sc_by_id.get(flashback_id)
            if parent_sc is None or flashback_sc is None:
                continue
            if parent_sc.is_flashback:
                continue
            # Link the flashback to its parent. Mirrors the canvas
            # broadcast-wire handler's effect (set parent_scene_id +
            # create the visual transition wire) so the imported
            # state is indistinguishable from a writer-drawn
            # flashback.
            flashback_sc.parent_scene_id = parent_id
            self.story.connections.append(Connection(
                source_node_id=parent_id,
                target_node_id=flashback_id,
            ))

    def _create_relationship_origin_nodes_and_joins(self) -> None:
        """For each relationship: ensure it has (a) a single origin
        anchor and (b) a `participant_changes: join` event at that
        anchor for every entity declared in the template's
        `participants:` block, AND (c) the relationship wires going
        from each participant's origin EntityNode to the anchor (so
        the canvas mirrors what `_syncOriginWireForRel` would produce
        for a writer-drawn relationship).

        Three anchor cases, mirroring the canvas convention:
          1. **Scene-born** — at least one `existence_changes: activate`
             event exists. The scene with that event is the anchor;
             no origin wires are created (scene-level wires are
             creation gestures only, per the design).
          2. **Faction membership** — `rel.membership_of` is set. The
             anchor is the faction's origin EntityNode (NOT a separate
             RelationshipOriginNode). Wires use
             `target_handle_id = rel-in-<rel.id>` so they land on the
             faction node's membership chip. See
             projectStore.js:10079-10082 for the canonical shape.
          3. **Regular pre-story baseline** — neither scene-born nor
             a membership rel. A `RelationshipOriginNode` is auto-
             created off-canvas-left, and origin wires connect each
             participant's origin EntityNode to it.

        Runs after `_apply_scenes` AND
        `_create_entity_origin_nodes` so the
        `self._entity_origin_node[entity_id] → node_id` index is
        populated and any scene-anchored `activate` events recorded
        in `_apply_change` are already on each relationship's history.
        Idempotent: re-applies harmlessly if some join events were
        already emitted by other code paths.
        """
        # IR-name → IR-rel dict so we can re-read the declared
        # participants list (which the existing `_apply_relationships_origin`
        # only used for `participant_roles` baseline, not for
        # synthesising join events).
        ir_rel_by_name: dict[str, dict] = {r["name"]: r for r in self.ir.relationships}

        # Off-canvas-left column for relationship-origin nodes,
        # separated from the knowledge-origin column so they don't
        # collide. Each origin node is stacked vertically. Writer can
        # drag them anywhere post-import.
        REL_COL_X = -900.0
        Y_START = self._SCENE_Y_DEFAULT
        Y_STEP = 200.0

        existing_anchor_rel_ids = {
            n.relationship_id for n in self.story.relationship_origin_nodes
        }
        y_cursor = Y_START

        for rel in self.story.relationships:
            # Find IR entry by the relationship's ORIGINAL declared
            # name (pre-dedupe).
            ir_name = None
            for nm, rid in self.relationship_id.items():
                if rid == rel.id:
                    ir_name = nm
                    break
            ir_rel = ir_rel_by_name.get(ir_name) if ir_name else None

            # Determine the anchor node id + whether origin wires
            # should be emitted.
            activate_events = [
                c for c in (rel.history.existence_changes or [])
                if getattr(c, "action", None) == "activate"
            ]
            anchor_node_id: Optional[str] = None
            anchor_is_scene = False
            wire_target_handle: Optional[str] = None

            if activate_events:
                # Scene-born: anchor at the earliest activating scene.
                # No persistent origin wires for scene-born rels
                # (creation gesture only).
                anchor_node_id = activate_events[0].node_id
                anchor_is_scene = True
            elif rel.membership_of:
                # Faction membership: anchor is the faction's origin
                # EntityNode. Wires land on the rel-in-<rel.id>
                # handle (faction-membership chip).
                anchor_node_id = self._entity_origin_node.get(rel.membership_of)
                wire_target_handle = f"rel-in-{rel.id}"
            else:
                # Pre-story regular relationship: auto-create
                # RelationshipOriginNode if one isn't already present.
                if rel.id in existing_anchor_rel_ids:
                    anchor_node_id = next(
                        n.id for n in self.story.relationship_origin_nodes
                        if n.relationship_id == rel.id
                    )
                else:
                    origin_node = RelationshipOriginNode(
                        relationship_id=rel.id,
                        position=Position(x=REL_COL_X, y=y_cursor),
                    )
                    self.story.relationship_origin_nodes.append(origin_node)
                    anchor_node_id = origin_node.id
                    y_cursor += Y_STEP

            if not anchor_node_id or not ir_rel:
                continue

            # Emit join events.
            joined_ids = {
                pc.entity_id for pc in (rel.history.participant_changes or [])
                if pc.action == "join"
            }
            participant_eids: list[str] = []
            for p in ir_rel.get("participants") or []:
                eid = self.entity_id.get(p.get("name", ""))
                if not eid:
                    continue
                participant_eids.append(eid)
                if eid in joined_ids:
                    continue
                rel.history.participant_changes.append(ParticipantChange(
                    node_id=anchor_node_id,
                    action="join",
                    entity_id=eid,
                    initial_perception=(p.get("perception") or ""),
                ))

            # Emit relationship wires from each participant's origin
            # EntityNode to the anchor. Scene-born relationships
            # don't get persistent origin wires (per the canvas
            # convention).
            if anchor_is_scene:
                continue
            for eid in participant_eids:
                ent_origin_id = self._entity_origin_node.get(eid)
                if not ent_origin_id:
                    continue
                # Skip if a wire already connects this entity origin
                # to the anchor for this relationship (idempotency).
                already_wired = any(
                    c.source_node_id == ent_origin_id
                    and c.target_node_id == anchor_node_id
                    and c.relationship_id == rel.id
                    for c in self.story.connections
                )
                if already_wired:
                    continue
                self.story.connections.append(Connection(
                    source_node_id=ent_origin_id,
                    target_node_id=anchor_node_id,
                    source_entity_id=eid,
                    is_relationship=True,
                    relationship_id=rel.id,
                    target_handle_id=wire_target_handle,
                ))

    def _create_knowledge_origin_nodes(self) -> None:
        """For each knowledge that has no scene-born `activate`
        event in its history, create a `KnowledgeOriginNode` anchored
        off-canvas to the left of the canvas's chapter strip. The
        node represents the knowledge's pre-story-baseline creation
        point — every knowledge must have a single origin, either a
        scene-born event (the scene is the anchor) or this off-canvas
        node.

        Position: stacked vertically in a column to the left of the
        canvas's left edge so they don't overlap the entity-origin
        columns or chapter strip. Writer can drag them anywhere
        post-import; the relative ordering preserves declaration
        order from the template.
        """
        # Column origin: well to the left of the canvas content. Both
        # entity origin nodes (placed by `_create_entity_origin_nodes`
        # / `_place_first_appearance_origins`) and the chapter strip
        # sit at positive x by default; -1200 keeps the knowledge
        # origin column safely off-canvas-left so it doesn't collide.
        KNOWLEDGE_COL_X = -1200.0
        KNOWLEDGE_Y_START = self._SCENE_Y_DEFAULT
        KNOWLEDGE_Y_STEP = 200.0

        # Build a lookup of which knowledges already have an existing
        # KnowledgeOriginNode (in case _wipe() didn't clear them for
        # some reason, or a future merge mode populates them upstream)
        # so we don't double-anchor.
        existing_anchor_knowledge_ids = {
            n.knowledge_id for n in self.story.knowledge_origin_nodes
        }

        y_cursor = KNOWLEDGE_Y_START
        for kn in self.story.knowledges:
            if kn.id in existing_anchor_knowledge_ids:
                continue
            existence_changes = (kn.history.existence_changes or []) if kn.history else []
            has_activate = any(
                getattr(c, "action", None) == "activate" for c in existence_changes
            )
            if has_activate:
                # Scene-born — the scene with the `activate` event is
                # the anchor; no separate origin node needed.
                continue
            self.story.knowledge_origin_nodes.append(KnowledgeOriginNode(
                knowledge_id=kn.id,
                position=Position(x=KNOWLEDGE_COL_X, y=y_cursor),
            ))
            y_cursor += KNOWLEDGE_Y_STEP

    def _apply_time_fields(self, sc: SceneNode, ir_sc: dict) -> None:
        tod = (ir_sc.get("time_of_day") or "").strip()
        if tod:
            tl = tod.lower()
            if tl in ("day", "night"):
                sc.time_of_day_tier = "broad"
                sc.time_of_day_broad = tl
            elif re.match(r'^\d{1,2}:\d{2}$', tod):
                sc.time_of_day_tier = "exact"
                sc.time_of_day_exact = tod
            elif tl in LABELLED_TIMES:
                sc.time_of_day_tier = "labelled"
                sc.time_of_day_labelled = tl
        wd = (ir_sc.get("weekday") or "").strip().lower()
        if wd in WEEKDAY_NAMES:
            sc.weekday = WEEKDAY_NAMES[wd]
        season = (ir_sc.get("season") or "").strip().lower()
        if season in SEASON_NAMES:
            sc.season = SEASON_NAMES[season]
        date = (ir_sc.get("date") or "").strip()
        if date:
            self._apply_date_field(sc, date)
        dur = (ir_sc.get("duration") or "").strip()
        if dur:
            d = _parse_duration(dur)
            if d is not None:
                sc.scene_duration = d
        gap = (ir_sc.get("gap") or "").strip()
        if gap:
            td = _parse_timedelta(gap)
            if td is not None:
                sc.gap_extension = td

    def _apply_date_field(self, sc: SceneNode, date: str) -> None:
        # `Monday` → tier=weekday
        s = date.strip()
        if s.lower() in WEEKDAY_NAMES:
            sc.date_tier = "weekday"
            sc.weekday = WEEKDAY_NAMES[s.lower()]
            return
        m = re.match(r'^([A-Za-z]+)(?:\s+(\d{1,2}))?$', s)
        if m:
            mname = m.group(1).lower()
            day = int(m.group(2)) if m.group(2) else None
            if mname in MONTH_NAMES:
                sc.date_month = MONTH_NAMES[mname]
                if day is not None:
                    sc.date_tier = "month_day_dow"
                    sc.date_day_of_month = day
                else:
                    sc.date_tier = "month_dow"

    # ── Change application ──

    def _apply_change(self, sc: SceneNode, ir_sc: dict, change: dict) -> None:
        kind = change.get("kind")
        if kind == "entity_rename":
            ref = self._find_or_create_chip(sc, change["subject"])
            if ref:
                ref.name_change = change["new_name"]
        elif kind == "entity_change_description":
            ref = self._find_or_create_chip(sc, change["subject"])
            if ref:
                ref.description_change = change["new_description"]
        elif kind == "entity_change_colour":
            ref = self._find_or_create_chip(sc, change["subject"])
            if ref:
                ref.colour_change = change["new_colour"]
        elif kind == "entity_add_alias":
            ref = self._find_or_create_chip(sc, change["subject"])
            if ref:
                # 2026-05-17 — append an `add` chain event on the per-alias
                # `alias_changes` list. The walker handles dedupe by id,
                # so re-importing the same template at the same scene is
                # idempotent (each import generates a fresh UUID but the
                # alias VALUE is the writer's intent; runtime dedupe is by
                # id so duplicates of the same value across separate
                # imports could occur — acceptable for template import).
                new_alias = Alias(id=str(uuid.uuid4()), value=change["alias_value"])
                ref.alias_changes = list(ref.alias_changes or []) + [
                    AliasChange(action="add", alias=new_alias)
                ]
        elif kind == "entity_replace_aliases":
            ref = self._find_or_create_chip(sc, change["subject"])
            if ref:
                # 2026-05-17 — the template's `replace aliases with [...]`
                # directive is the inherently-buggy semantic the
                # v0.2.1.76 data-model fix moved away from (full-list
                # replacement that discards upstream changes). For
                # template import we honour the writer's INTENT (the
                # listed aliases should appear at this scene) by
                # emitting one `add` event per listed value. Upstream
                # aliases NOT in the listed values are NOT removed —
                # the template's "replace" semantic effectively becomes
                # "add all of these". Matches the migration shim's
                # additive-only policy in `_migrate_aliases_to_chain_events`
                # in `file_service.py`. Writers wanting to ACTUALLY
                # remove an upstream alias at this scene should use the
                # forthcoming `remove alias "X"` template directive
                # (not yet shipped) or edit in the UI.
                events = []
                for v in change["aliases"]:
                    new_alias = Alias(id=str(uuid.uuid4()), value=v)
                    events.append(AliasChange(action="add", alias=new_alias))
                ref.alias_changes = list(ref.alias_changes or []) + events
        elif kind == "entity_attribute":
            self._apply_attribute_change(sc, change)
        elif kind == "entity_temporary_cm":
            self._apply_entity_temporary_cm(sc, change)
        elif kind == "entity_awareness":
            self._apply_entity_awareness_change(sc, change)
        elif kind == "relationship_activate":
            self._append_existence_change(change["subject"], sc.id, "activate")
        elif kind == "relationship_deactivate":
            self._append_existence_change(change["subject"], sc.id, "deactivate")
        elif kind == "relationship_join":
            self._append_participant_change(change["subject"], sc.id, "join", change["entity"], change.get("role", ""))
        elif kind == "relationship_leave":
            self._append_participant_change(change["subject"], sc.id, "leave", change["entity"], "")
        elif kind == "relationship_perception":
            self._append_perception_change(change["subject"], sc.id, change["observer"], change["new_perception"])
        elif kind == "relationship_alias_override":
            self._append_alias_override(change["subject"], sc.id, change["entity"], change.get("new_alias"))
        elif kind == "relationship_role":
            self._append_role_change(change["subject"], sc.id, change["entity"], change.get("new_role"))
        elif kind == "relationship_rename":
            self._append_rel_name_change(change["subject"], sc.id, change["new_name"])
        elif kind == "relationship_change_description":
            self._append_rel_description_change(change["subject"], sc.id, change["new_description"])
        elif kind == "relationship_set_hierarchy":
            self._append_hierarchy_change(change["subject"], sc.id, change.get("root"), change.get("order", []))
        elif kind == "relationship_clear_hierarchy":
            self._append_hierarchy_clear(change["subject"], sc.id)
        elif kind == "knowledge_activate":
            self._append_knowledge_existence(change["subject"], sc.id)
        elif kind == "knowledge_rename":
            self._append_knowledge_rename(change["subject"], sc.id, change["new_name"])
        elif kind == "knowledge_change_description":
            self._append_knowledge_description(change["subject"], sc.id, change["new_description"])
        elif kind == "knowledge_change_colour":
            self._append_knowledge_colour(change["subject"], sc.id, change["new_colour"])
        elif kind == "knowledge_observer_gains":
            self._append_knowledge_observer(change["subject"], sc.id, change["observer"], change["level"])
        elif kind == "knowledge_observer_loses":
            self._append_knowledge_observer(change["subject"], sc.id, change["observer"], 0)
        elif kind == "knowledge_tracking":
            action = change.get("action", "on")
            if action == "on":
                self._append_knowledge_tracking(change["subject"], sc.id, "on", change.get("scale", "full"))
            else:
                self._append_knowledge_tracking(change["subject"], sc.id, "off", None)

    def _find_or_create_chip(self, sc: SceneNode, entity_name: str) -> Optional[EntityRef]:
        eid = self.entity_id.get(entity_name)
        if not eid:
            return None
        ent = self._lookup_entity(entity_name)
        if not ent:
            return None
        # Find existing chip in the right list
        target = self._chip_list_for_type(sc, ent.type)
        for ref in target:
            if ref.entity_id == eid:
                return ref
        new_ref = EntityRef(entity_id=eid)
        target.append(new_ref)
        return new_ref

    def _chip_list_for_type(self, sc: SceneNode, etype: str) -> list:
        return {
            "character": sc.characters,
            "location": sc.locations,
            "item": sc.items,
            "faction": sc.factions,
            "custom": sc.customs,
        }[etype]

    def _lookup_entity(self, name: str) -> Optional[Entity]:
        eid = self.entity_id.get(name)
        if not eid:
            return None
        for bucket in (self.story.entities.characters, self.story.entities.locations,
                       self.story.entities.items, self.story.entities.factions,
                       self.story.entities.customs):
            for e in bucket:
                if e.id == eid:
                    return e
        return None

    def _apply_entity_temporary_cm(self, sc: SceneNode, change: dict) -> None:
        """Scene-scoped temporary circumstance / motivator on a single
        entity. Lives on `SceneNode.entity_temporary_circumstances` —
        NOT chain-tracked, does not propagate forward, does not
        compound across the chain. Use this for transient feelings
        (flustered, mortified, dizzy) that belong to this scene only.
        """
        eid = self.entity_id.get(change["subject"])
        if not eid:
            return
        try:
            sc.entity_temporary_circumstances.append(EntityTemporaryCM(
                entity_id=eid,
                attribute_type=change["attribute_type"],
                name=change.get("name") or None,
                description=change.get("description", ""),
                intensity=change.get("intensity"),
            ))
        except Exception:
            pass

    def _apply_attribute_change(self, sc: SceneNode, change: dict) -> None:
        ref = self._find_or_create_chip(sc, change["subject"])
        if not ref:
            return
        op = change["op"]
        if op == "add":
            ir_attr = change["attribute"]
            attr = self._build_attribute(ir_attr, change["subject"])
            if attr is None:
                return
            self.attribute_id[(change["subject"], ir_attr["name"])] = attr.id
            ref.attribute_changes.append(NodeAttributeChange(action="add", attribute=attr))
        elif op in ("modify", "rename", "remove", "list_add", "list_remove"):
            attr_id = self.attribute_id.get((change["subject"], change["attribute_name"]))
            if not attr_id:
                # might be added-at-scene; allow lookup by attribute name on chain.
                # For v1, only resolve from entity origin.
                return
            ac = NodeAttributeChange(action="remove" if op == "remove" else op,
                                     attribute_id=attr_id)
            if op == "rename":
                ac.action = "rename"
                ac.new_name = change.get("new_name")
            elif op == "modify":
                f = change.get("field")
                if f == "value":
                    ac.action = "modify"
                    ac.new_value = change.get("new_value")
                elif f == "intensity":
                    ac.action = "modify"
                    ac.new_intensity = change.get("new_intensity")
                elif f == "description":
                    ac.action = "modify"
                    ac.new_description = change.get("new_description")
                elif f == "number":
                    ac.action = "modify"
                    ac.new_number_value = change.get("new_number_value")
            elif op == "list_add":
                ac.action = "list_add"
                ac.list_item = change.get("list_item")
            elif op == "list_remove":
                ac.action = "list_remove"
                ac.list_item = change.get("list_item")
            ref.attribute_changes.append(ac)

    def _apply_entity_awareness_change(self, sc: SceneNode, change: dict) -> None:
        # subject is the OBSERVER (per spec writer-language: "<Observer> gains awareness of <target>").
        # Post v0.2a.2.5 migration, chain awareness lives on the TARGET
        # host's own `awareness.history` list (canonical AwarenessHistoryEntry),
        # not on the carrier EntityRef. We still call _find_or_create_chip
        # so the entity's presence in this scene is registered, but the
        # awareness write goes to the target host directly.
        observer_name = change["subject"]
        observer_id = self.entity_id.get(observer_name)
        if not observer_id:
            return
        target = change["target"]
        action = change["action"]
        level = target.get("level")
        if action == "loses":
            level_val = 0 if level is None else level
        else:
            level_val = 3 if level is None else level

        target_kind = target["kind"]
        if target_kind in ("entity", "entity_name", "alias"):
            chip_entity_name = target["entity"]
            chip = self._find_or_create_chip(sc, chip_entity_name)
            if not chip:
                return
            target_entity = self._lookup_entity(chip_entity_name)
            if not target_entity:
                return
            if target_kind == "entity":
                wrapper = self._ensure_awareness_wrapper_on(target_entity, "awareness")
                wrapper.history.append(AwarenessHistoryEntry(
                    node_id=sc.id, observer_id=observer_id, level=level_val,
                ))
            elif target_kind == "entity_name":
                wrapper = self._ensure_awareness_wrapper_on(target_entity, "name_awareness")
                wrapper.history.append(AwarenessHistoryEntry(
                    node_id=sc.id, observer_id=observer_id, level=level_val,
                ))
            else:  # target_kind == "alias"
                alias_value = target["alias_value"]
                alias = next(
                    (a for a in (target_entity.aliases or []) if a.value == alias_value),
                    None,
                )
                if alias is None:
                    return
                wrapper = self._ensure_awareness_wrapper_on(alias, "awareness")
                wrapper.history.append(AwarenessHistoryEntry(
                    node_id=sc.id, observer_id=observer_id, level=level_val,
                ))
        elif target_kind == "relationship":
            rel_name = target["name"]
            rel = self._get_rel(rel_name)
            if not rel:
                return
            wrapper = self._ensure_awareness_wrapper_on(rel, "awareness")
            wrapper.history.append(AwarenessHistoryEntry(
                node_id=sc.id, observer_id=observer_id, level=level_val,
            ))
        elif target_kind == "attribute":
            owner_name = target["entity"]
            attr_name = target["attribute_name"]
            attr_id = self.attribute_id.get((owner_name, attr_name))
            if not attr_id:
                return
            owner = self._lookup_entity(owner_name)
            if not owner:
                return
            attr = next(
                (a for a in (owner.attributes or []) if a.id == attr_id),
                None,
            )
            if attr is None:
                return
            # Ensure presence in this scene (chip carries the entity into
            # the bucket so other lookups find it; awareness data itself
            # rides on attr.awareness.history).
            self._find_or_create_chip(sc, owner_name)
            wrapper = self._ensure_awareness_wrapper_on(attr, "awareness")
            wrapper.history.append(AwarenessHistoryEntry(
                node_id=sc.id, observer_id=observer_id, level=level_val,
            ))
        elif target_kind == "knowledge":
            kn_name = target["name"]
            self._append_knowledge_observer(kn_name, sc.id, observer_name, level_val)

    # Relationship history mutations
    def _get_rel(self, name: str) -> Optional[Relationship]:
        rid = self.relationship_id.get(name)
        if not rid:
            return None
        return next((r for r in self.story.relationships if r.id == rid), None)

    def _append_existence_change(self, rel_name: str, node_id: str, action: str) -> None:
        rel = self._get_rel(rel_name)
        if rel:
            rel.history.existence_changes.append(ExistenceChange(node_id=node_id, action=action))

    def _append_participant_change(self, rel_name: str, node_id: str, action: str,
                                    entity_name: str, role: str) -> None:
        rel = self._get_rel(rel_name)
        if not rel:
            return
        eid = self.entity_id.get(entity_name)
        if not eid:
            return
        pc = ParticipantChange(node_id=node_id, action=action, entity_id=eid)
        rel.history.participant_changes.append(pc)
        if role and action == "join":
            rel.participant_roles[eid] = ParticipantRole(value=role)

    def _append_perception_change(self, rel_name: str, node_id: str,
                                   observer_name: str, new_perception: str) -> None:
        rel = self._get_rel(rel_name)
        if not rel:
            return
        oid = self.entity_id.get(observer_name)
        if not oid:
            return
        rel.history.perception_changes.append(PerceptionChange(
            node_id=node_id, entity_id=oid, new_perception=new_perception,
        ))

    def _append_alias_override(self, rel_name: str, node_id: str, entity_name: str, new_alias: Optional[str]) -> None:
        rel = self._get_rel(rel_name)
        if not rel:
            return
        eid = self.entity_id.get(entity_name)
        if not eid:
            return
        rel.history.alias_changes.append(AliasOverrideChange(
            node_id=node_id, entity_id=eid, new_alias_override=new_alias,
        ))

    def _append_role_change(self, rel_name: str, node_id: str, entity_name: str, new_role: Optional[str]) -> None:
        rel = self._get_rel(rel_name)
        if not rel:
            return
        eid = self.entity_id.get(entity_name)
        if not eid:
            return
        role_obj = ParticipantRole(value=new_role) if new_role else None
        rel.history.role_changes.append(RoleChange(
            node_id=node_id, entity_id=eid, new_role=role_obj,
        ))

    def _append_rel_name_change(self, rel_name: str, node_id: str, new_name: str) -> None:
        rel = self._get_rel(rel_name)
        if rel:
            rel.history.name_changes.append(NameChange(node_id=node_id, new_name=new_name))

    def _append_rel_description_change(self, rel_name: str, node_id: str, new_description: str) -> None:
        rel = self._get_rel(rel_name)
        if rel:
            rel.history.description_changes.append(DescriptionChange(
                node_id=node_id, new_description=new_description,
            ))

    def _append_hierarchy_change(self, rel_name: str, node_id: str, root: Optional[str], order: list[str]) -> None:
        rel = self._get_rel(rel_name)
        if not rel:
            return
        if not root:
            return
        cfg = self._compile_hierarchy_config({"mode": "participants", "root": root, "order": order})
        if not cfg:
            return
        rel.history.hierarchy_changes.append(HierarchyChange(node_id=node_id, new_hierarchy=cfg))

    def _append_hierarchy_clear(self, rel_name: str, node_id: str) -> None:
        rel = self._get_rel(rel_name)
        if rel:
            rel.history.hierarchy_changes.append(HierarchyChange(node_id=node_id, new_hierarchy=None))

    # Knowledge history mutations
    def _get_kn(self, name: str) -> Optional[Knowledge]:
        kid = self.knowledge_id.get(name)
        if not kid:
            return None
        return next((k for k in self.story.knowledges if k.id == kid), None)

    def _append_knowledge_existence(self, kn_name: str, node_id: str) -> None:
        kn = self._get_kn(kn_name)
        if kn:
            kn.history.existence_changes.append(KnowledgeExistenceChange(node_id=node_id))

    def _append_knowledge_rename(self, kn_name: str, node_id: str, new_name: str) -> None:
        kn = self._get_kn(kn_name)
        if kn:
            kn.history.name_changes.append(KnowledgeNameChange(node_id=node_id, new_name=new_name))

    def _append_knowledge_description(self, kn_name: str, node_id: str, new_description: str) -> None:
        kn = self._get_kn(kn_name)
        if kn:
            kn.history.description_changes.append(KnowledgeDescriptionChange(
                node_id=node_id, new_description=new_description,
            ))

    def _append_knowledge_colour(self, kn_name: str, node_id: str, new_colour: str) -> None:
        kn = self._get_kn(kn_name)
        if kn:
            kn.history.colour_changes.append(KnowledgeColourChange(node_id=node_id, new_colour=new_colour))

    @staticmethod
    def _ensure_knowledge_awareness_wrapper(kn: Knowledge) -> AwarenessWrapper:
        """Promote `kn.awareness` to a wrapper so chain entries can be
        appended to `kn.awareness.history`. Convenience wrapper around
        `_ensure_awareness_wrapper_on(kn, 'awareness')`."""
        return _Applier._ensure_awareness_wrapper_on(kn, "awareness")

    @staticmethod
    def _ensure_awareness_wrapper_on(host, field_name: str) -> AwarenessWrapper:
        """Generic awareness-wrapper promoter for any host (Entity,
        Attribute, Alias, Relationship, Knowledge) and any awareness-
        bearing field on it (`awareness`, `name_awareness`).

        Three input shapes per the awareness model:
          - `None`              -> wrap as an empty wrapper with an empty history.
          - flat-dict baseline  -> wrap, moving the dict into `entries`.
          - wrapper             -> ensure `history` is initialised, return as-is.
        Pre-existing baseline content (entries / sources) is preserved —
        these helpers only ever append to history, never touch baseline
        observer levels.
        """
        aware = getattr(host, field_name, None)
        if isinstance(aware, AwarenessWrapper):
            if aware.history is None:
                aware.history = []
            return aware
        if isinstance(aware, dict):
            wrapper = AwarenessWrapper(entries=dict(aware), history=[])
            setattr(host, field_name, wrapper)
            return wrapper
        wrapper = AwarenessWrapper(history=[])
        setattr(host, field_name, wrapper)
        return wrapper

    def _append_knowledge_observer(self, kn_name: str, node_id: str, observer_name: str, level: int) -> None:
        kn = self._get_kn(kn_name)
        if not kn:
            return
        oid = self.entity_id.get(observer_name)
        if not oid:
            return
        wrapper = self._ensure_knowledge_awareness_wrapper(kn)
        wrapper.history.append(AwarenessHistoryEntry(
            node_id=node_id, observer_id=oid, level=level,
        ))

    def _append_knowledge_tracking(self, kn_name: str, node_id: str, action: str, scale: Optional[str]) -> None:
        kn = self._get_kn(kn_name)
        if not kn:
            return
        if action not in ("on", "off"):
            return
        wrapper = self._ensure_knowledge_awareness_wrapper(kn)
        wrapper.history.append(AwarenessHistoryEntry(
            node_id=node_id,
            tracking_action=action,
            awareness_scale=scale if action == "on" else None,
        ))

    # ── Wiring ──

    def _ensure_pov_origin_node(self) -> None:
        """Spawn a POV Origin node if the story doesn't already carry
        one. Mirrors the frontend's `ensurePovOriginNode` helper —
        every project has exactly one, and the POV chain starts here.
        The position is a placeholder; `_position_pov_origin_node`
        runs after `_apply_scenes` and snaps it to the left of the
        first scene so the POV wire is short."""
        if self.story.pov_origin_node is not None:
            return
        self.story.pov_origin_node = PovOriginNode(position=Position(x=50.0, y=120.0))

    def _position_pov_origin_node(self) -> None:
        """Park the POV Origin Node in its dedicated column between
        the pre-chapter origin columns and chapter 1 — left enough
        to keep the POV chain near scene 1, but isolated in its own
        slot so it never overlaps an entity origin column. The slot
        is reserved by `_ORIGIN_PRE_CHAPTER_BUFFER`, which factors in
        the POV column width + gaps. No-op if there are no scenes
        (POV origin keeps its placeholder position).
        """
        pov = self.story.pov_origin_node
        if pov is None:
            return
        if not getattr(self, "_scene_x_by_ir_idx", None):
            return
        first_scene_y = self._scene_y_by_ir_idx.get(0, self._SCENE_Y_DEFAULT)
        # POV column spans:
        #   right_edge = chapter_x_offset - GAP_TO_CHAPTER
        #   left_edge  = right_edge - POV_COL_WIDTH
        # POV node centred horizontally inside the column.
        right_edge = self.story.chapter_x_offset - self._POV_GAP_TO_CHAPTER
        left_edge = right_edge - self._POV_COL_WIDTH
        pov_x = left_edge + (self._POV_COL_WIDTH - self._POV_NODE_WIDTH_EST) / 2
        pov.position = Position(x=pov_x, y=first_scene_y)

    def _wire_connections(self) -> None:
        # The Connection objects produced here mirror exactly what the
        # canvas's normal `onConnect` handler writes when a writer drags
        # a wire by hand. See projectStore.js around lines 4959 (POV)
        # and 5229 (chip → chip narrative-flow). Do not invent extra
        # fields here — anything beyond the canonical shape diverges
        # from manual wiring and risks downstream behaviour drift.
        #
        # Canonical shapes:
        #   POV path           → source_node_id, target_node_id,
        #                         is_pov_path=True, target_handle_id='pov-in'
        #   Chip → chip wire   → source_node_id, target_node_id,
        #                         source_entity_id, is_pov_path=False,
        #                         target_handle_id='chip-in-<entity>'
        #
        # Scenes whose POV character does NOT match the previous scene's
        # POV character are intentionally NOT auto-wired together.
        # That mirrors hand-drawn wiring: a writer who switches POV
        # mid-story leaves the chains separate (or wires them how they
        # see fit).

        # POV path: starts at the POV Origin Node and threads through
        # every scene in template (narrative) order. The chain itself
        # does not care which character carries the POV at each scene
        # — that is recorded on the per-scene `EntityRef.has_pov` flag.
        # The chain just defines the sequence. POV-character switches
        # mid-story remain a continuous chain (same as hand-wired).
        pov_origin = self.story.pov_origin_node
        prev_node_id: Optional[str] = pov_origin.id if pov_origin else None
        for sid in self._scene_order:
            if prev_node_id is None:
                prev_node_id = sid
                continue
            self.story.connections.append(Connection(
                source_node_id=prev_node_id, target_node_id=sid,
                is_pov_path=True,
                target_handle_id="pov-in",
            ))
            prev_node_id = sid

        # Per-entity narrative-flow: chip-out (entity_id) → chip-in-<entity_id>
        # from the entity's previous appearance (or its origin EntityNode)
        # to the current scene.
        last_for_entity: dict[str, str] = {}  # entity_id → last node_id (scene or origin)
        for n in self.story.entity_nodes:
            if n.entity_id and not n.is_modifier:
                last_for_entity[n.entity_id] = n.id

        for sid in self._scene_order:
            sc = next(s for s in self.story.scenes if s.id == sid)
            for bucket in (sc.characters, sc.locations, sc.items, sc.factions, sc.customs):
                for ref in bucket:
                    src = last_for_entity.get(ref.entity_id)
                    if src and src != sid:
                        self.story.connections.append(Connection(
                            source_node_id=src, target_node_id=sid,
                            source_entity_id=ref.entity_id,
                            target_handle_id=f"chip-in-{ref.entity_id}",
                        ))
                    last_for_entity[ref.entity_id] = sid


# ── helpers (top-level) ────────────────────────────────────────────────────


def _markdown_to_tiptap_html(md: str) -> str:
    """Minimal markdown → HTML for the TipTap main_content. Handles
    paragraphs (blank-line separated), `_italic_`, `**bold**`, basic
    inline conversion. Not a full markdown renderer — TipTap is happy
    with plain `<p>` paragraphs and the writer can polish post-import."""
    if not md:
        return ""
    paragraphs = re.split(r'\n\s*\n', md.strip())
    out = []
    for p in paragraphs:
        p = html.escape(p)
        p = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', p)
        p = re.sub(r'\b_([^_\n]+)_\b', r'<em>\1</em>', p)
        p = p.replace("\n", "<br>")
        out.append(f"<p>{p}</p>")
    return "".join(out)


_TIME_TD_RE = re.compile(r'^\s*(-?\d+)\s+(minutes?|hours?|days?|weeks?)\s*$', re.IGNORECASE)


def _parse_timedelta(s: str) -> Optional[TimeDelta]:
    m = _TIME_TD_RE.match(s.strip())
    if not m:
        return None
    n = int(m.group(1))
    unit = m.group(2).lower().rstrip("s")
    unit_map = {"minute": "minutes", "hour": "hours", "day": "days", "week": "weeks"}
    return TimeDelta(unit=unit_map[unit], value=n)


def _parse_duration(s: str) -> Optional[Duration]:
    s_low = s.strip().lower()
    if s_low == "ambiguous":
        return Duration(kind="ambiguous")
    if s_low in ("all day",):
        return Duration(kind="all_day", all_day_variant="all_day")
    if s_low == "all night":
        return Duration(kind="all_day", all_day_variant="all_night")
    if s_low == "until next evening":
        return Duration(kind="all_day", all_day_variant="until_next_evening")
    m = re.match(r'^(\d+(?:\.\d+)?)\s+(minutes?|hours?|days?)\s*$', s_low)
    if m:
        v = float(m.group(1))
        unit = m.group(2).rstrip("s")
        kind_map = {"minute": "minutes", "hour": "hours", "day": "days"}
        return Duration(kind=kind_map[unit], value=v)
    m = re.match(r'^all\s+(morning|afternoon|evening|night|noon)\s*$', s_low)
    if m:
        return Duration(kind="all_period")
    m = re.match(r'^(.+?)\s+to\s+(.+?)\s*$', s_low)
    if m:
        return Duration(kind="span", end_period=m.group(2).strip())
    return None
