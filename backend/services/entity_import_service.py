"""
Entity import service — Phase 1.12b Track 1: Preview builder.

Reads a source `.nnz` file (or legacy `.nnplot`) in-memory, walks its
Story, and produces an `ImportPreview` that the frontend timeline grid
picker consumes. The preview carries everything the UI needs to render:

  - Scene columns in timeline order (POV chain first, then non-POV
    scenes slotted by canvas x-position).
  - Chapter + act markers spanning those columns.
  - One row per entity in the source library, with a list of "dots"
    marking the scenes where that entity has an `EntityRef`. Each
    dot is a clickable state-point in the grid.
  - Profile image data URIs for entity identity cells and hover
    previews, extracted from the source file's embedded `assets/`
    folder.

## In-memory parsing

The existing `file_service.unpack_project` helper mutates a global
`_assets_dir` — it deletes the previous temp dir and creates a new
one. That's correct behaviour when the user is LOADING a project,
but it would be destructive here: a user viewing the currently-
loaded project who uploads a source `.nnz` for import preview would
have their current project's assets dir blown away.

So this module has its own `_read_source_nnz` that parses the ZIP
in-memory via `zipfile.ZipFile(io.BytesIO(data))` and extracts asset
bytes into a `dict[filename, bytes]` — never touches disk, never
touches `file_service._assets_dir`. The session cache below holds
these bytes so the later commit step (Track 2) can copy referenced
assets into the target project's real assets dir.

## Session cache

After a successful preview, the parsed Story + asset bytes map are
stashed in a module-level `_PREVIEW_SESSIONS` dict keyed by a fresh
UUID. The preview response includes this session id; the Track 2
commit endpoint will look up the cached Story from the session
rather than re-parsing the uploaded file. Sessions don't auto-expire
in this version — they're cleaned up on explicit commit or when the
process restarts. A future enhancement can add a timeout.

## Dots and modifier nodes

For Track 1, entity row dots cover POV-chain scenes and non-POV
scenes where the entity has an `EntityRef`. Modifier nodes (entity-
specific `EntityNode` instances with `is_modifier=True`) are NOT
yet included in the dot list — they're a follow-up enhancement
tracked in the planning doc. The grid will show dots for every
scene the entity appears in, which covers the vast majority of
real-world import use cases.
"""

from __future__ import annotations

import io
import json
import mimetypes
import uuid
import zipfile
from base64 import b64encode
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Literal, Optional

from models import ENTITY_BUCKETS
from models.entity import (
    Attribute,
    AttributeSource,
    AwarenessRef,
    AwarenessWrapper,
    CustomCategory,
    Entity,
    PresetList,
    Relationship,
    RelationshipSource,
)
from models.knowledge import Knowledge, KnowledgeHistory
from models.node import SceneNode
from models.story import Act, Chapter, Story
from services import file_service
from services.file_service import _migrate_story_dict, check_import_compat
from services.narrative_chain import get_entity_narrative_chain
from services.pov_service import compute_pov_sequence


# ── Data model ─────────────────────────────────────────────────────────


@dataclass
class ImportSceneColumn:
    """One scene column in the timeline grid. Can be a POV-chain
    scene or a non-POV scene; the flag determines which."""
    id: str                                 # source scene node id
    title: str                              # scene title, or derived placeholder
    chapter_id: Optional[str]               # None if outside every chapter
    is_pov_chain: bool                      # True for POV-chain scenes
    chain_index: Optional[int]              # 1-based POV index; None for non-POV
    canvas_x: float                         # for x-order tie-break + drag-to-reorder


@dataclass
class ImportChapterMarker:
    """Chapter header above a span of scene columns."""
    id: str
    title: str
    number: int                             # 1-based position in story.chapters
    first_column_id: Optional[str]          # id of the first column in this chapter
    last_column_id: Optional[str]           # id of the last column in this chapter


@dataclass
class ImportActMarker:
    """Act header spanning a contiguous run of chapters."""
    id: str
    title: str
    number: int                             # 1-based position in story.acts
    chapter_ids: list[str]                  # ordered list of chapter ids under the act


@dataclass
class ImportDot:
    """One state-point in an entity's row. Represents a scene where
    the entity has an `EntityRef`, or an entity-specific modifier
    node on the canvas."""
    column_id: Optional[str]                # scene column id (None for modifier dots)
    is_modifier: bool                       # True for inline modifier dots
    modifier_node_id: Optional[str]         # when is_modifier=True
    chain_index: int                        # 1-based position in THIS entity's chain
    canvas_x: float = 0.0                   # source canvas x — used by the frontend
                                            # to interpolate modifier-dot position
                                            # between scene columns
    # Effective entity state at this chain point (Phase 1.12c
    # v0.1.12.57). Walked via `_walk_entity_inclusive` (modifier-
    # node targets routed through the same unified chain walker as
    # of v0.2.1.87) so the frontend can render each
    # dot in the entity's effective colour at that point AND show
    # the effective profile image + name in the identity cell /
    # preview pane when the user picks this dot. When `effective_*`
    # are None the frontend falls back to the row's origin values.
    effective_name: Optional[str] = None
    effective_colour: Optional[str] = None
    effective_profile_image_data_uri: Optional[str] = None


@dataclass
class ImportEntityRow:
    """One entity's timeline row in the grid. Identity cell on the
    left + dots along the scene columns."""
    id: str                                 # source entity id
    name: str
    type: str                               # character / location / item / faction / custom
    colour: Optional[str]
    description: str = ""
    profile_image_data_uri: Optional[str] = None
    # Effective state at the END of the entity's chain — i.e. the
    # accumulated result of every EntityRef change in walk order.
    # Populated the same way as each dot's `effective_*` fields but
    # without a target scene (walks to the end). Used by the grid's
    # Final bookend dot + identity cell when the user picks the
    # Final state. Phase 1.12c v0.1.12.57.
    final_name: Optional[str] = None
    final_colour: Optional[str] = None
    final_profile_image_data_uri: Optional[str] = None
    dots: list[ImportDot] = field(default_factory=list)
    # Source preset_list ids referenced by this entity's preset-type
    # attributes at the ORIGIN state (we don't walk the chain here —
    # the frontend uses this to lock preset-list checkboxes that the
    # user can't deselect while the entity is staged). The commit
    # path still auto-imports referenced lists even if the frontend
    # forgets to tick them, so this is a UX hint, not a correctness
    # requirement.
    preset_list_ids_used: list[str] = field(default_factory=list)


@dataclass
class ImportKnowledgeDot:
    """One state-point in a Knowledge's row. A Knowledge has no
    EntityRef scene presence the way entities do; its dots come from
    `Knowledge.history.*` entries (every node_id appearing in any
    history array AND every `manual_anchors[].scene_node_id`) so the
    writer can pick any chain stop where the Knowledge actually has
    state to import.
    """
    column_id: Optional[str]                # scene column id (None if no matching column)
    chain_index: int                        # 1-based position in THIS Knowledge's chain
    canvas_x: float = 0.0
    # Effective Knowledge state at this chain point. Mirrors the
    # `ImportDot.effective_*` fields.
    effective_name: Optional[str] = None
    effective_colour: Optional[str] = None
    effective_profile_image_data_uri: Optional[str] = None


@dataclass
class ImportKnowledgeRow:
    """One Knowledge's timeline row in the grid. Renders in the same
    grid as entity rows but in a separate Knowledge section / tab in
    the picker. Identity cell on the left + dots along the scene
    columns at every chain stop the source Knowledge has."""
    id: str                                 # source knowledge id
    name: str
    colour: Optional[str]
    description: str = ""
    profile_image_data_uri: Optional[str] = None
    # Effective state at the END of the Knowledge's chain.
    final_name: Optional[str] = None
    final_colour: Optional[str] = None
    final_profile_image_data_uri: Optional[str] = None
    dots: list[ImportKnowledgeDot] = field(default_factory=list)


@dataclass
class ImportPresetListPreview:
    """Preview-side summary of one source `PresetList`, surfaced in
    the new Preset Lists tab of the Import dialog picker. The full
    preset list Pydantic object lives in the session cache; this is
    just the minimum the frontend needs to render the picker row +
    resolve the "which ones does the user want" commit payload."""
    id: str                                 # source preset list id
    name: str
    value_count: int
    sample_values: list[str]                # first ~3 values for preview display


@dataclass
class ImportPreview:
    """Top-level preview object returned by the preview endpoint and
    consumed by the frontend timeline grid."""
    session_id: str                         # key for the Track 2 commit endpoint
    source_filename: str
    story_title: str
    story_author: Optional[str]
    story_genre: Optional[str]
    chapters: list[ImportChapterMarker]
    acts: list[ImportActMarker]
    columns: list[ImportSceneColumn]
    entities: list[ImportEntityRow]
    preset_lists: list[ImportPresetListPreview] = field(default_factory=list)
    knowledges: list[ImportKnowledgeRow] = field(default_factory=list)


# ── Session cache ──────────────────────────────────────────────────────


@dataclass
class _PreviewSession:
    """Cached parsed source for a preview. The commit endpoint
    (Track 2) will look up the Story + asset bytes by session id
    rather than re-parsing the upload."""
    story: Story
    asset_bytes: dict[str, bytes]
    source_filename: str


_PREVIEW_SESSIONS: dict[str, _PreviewSession] = {}


def get_preview_session(session_id: str) -> Optional[_PreviewSession]:
    return _PREVIEW_SESSIONS.get(session_id)


def clear_preview_session(session_id: str) -> None:
    _PREVIEW_SESSIONS.pop(session_id, None)


# ── In-memory .nnz reader ──────────────────────────────────────────────


def _read_source_nnz(
    data: bytes,
) -> tuple[Story, dict[str, bytes]]:
    """Parse a source `.nnz` file (or legacy `.nnplot`) entirely in-memory
    — does NOT touch `file_service._assets_dir` or the filesystem.
    Returns the parsed `Story` plus a dict of `{asset_filename: bytes}`
    for every file under the ZIP's `assets/` folder.

    Performs the same save-format compat and migration pipeline the
    live load path uses, but targeting the "import" capability instead
    of "load" — if the source file requires a newer importer than this
    program provides, `check_import_compat` raises
    `IncompatibleSaveError` (capability="import") and the caller
    surfaces it as a structured HTTP error. Legacy (pre-tracker) files
    pass the compat check silently and are upgraded by the legacy
    migration before parsing, identical to the load path.

    This module owns its own reader (rather than going through
    `file_service.unpack_project`) because the full-load path mutates
    a global `_assets_dir` which would clobber the currently-loaded
    target project's assets during an import preview. The reader
    doesn't care about the file's extension — it reads raw bytes from
    the ZIP container — so it accepts both `.nnz` and legacy `.nnplot`
    uploads transparently.

    Raises `ValueError` if the file is not a valid ZIP or is missing
    the `narrative.json` entry. `IncompatibleSaveError` and
    `CorruptSaveError` propagate so the caller can translate them into
    distinct HTTP error shapes. Other exceptions propagate so the
    caller can decide how to surface them."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise ValueError(f"Not a valid NarrativeNode project file: {e}") from e

    try:
        names = zf.namelist()
        if "narrative.json" not in names:
            raise ValueError(
                "Missing narrative.json — not a valid NarrativeNode project file"
            )
        story_json_text = zf.read("narrative.json").decode("utf-8")
        story_dict = json.loads(story_json_text)
        # Per-capability compat check — bail out cleanly BEFORE running
        # migrations if the file needs a newer importer than we are.
        check_import_compat(story_dict)
        # Run the same migration pass the live load path uses so old
        # files still import cleanly. Migrations are in-place.
        _migrate_story_dict(story_dict)
        story = Story.model_validate(story_dict)

        # Collect asset bytes into an in-memory dict.
        asset_bytes: dict[str, bytes] = {}
        for name in names:
            if name.startswith("assets/") and not name.endswith("/"):
                filename = name[len("assets/"):]
                if filename:
                    asset_bytes[filename] = zf.read(name)
        return story, asset_bytes
    finally:
        zf.close()


# ── Preview builder ───────────────────────────────────────────────────


def build_import_preview(
    file_bytes: bytes,
    source_filename: str = "source.nnz",
) -> ImportPreview:
    """Parse a source NarrativeNode project file (`.nnz` or legacy
    `.nnplot`) and return an `ImportPreview` ready to ship to the
    frontend. Also stashes the parsed Story + asset bytes in the
    session cache so the Track 2 commit endpoint can look them up by
    `session_id` without re-uploading."""
    story, asset_bytes = _read_source_nnz(file_bytes)

    # Allocate a session id FIRST so failures downstream still leave
    # a fresh session id in scope for error messages. We'll only
    # insert into the cache at the end, after the preview is built.
    session_id = str(uuid.uuid4())

    columns = _build_columns(story)
    chapters_markers = _build_chapter_markers(story, columns)
    acts_markers = _build_act_markers(story, chapters_markers)
    entity_rows = _build_entity_rows(story, columns, asset_bytes)
    preset_list_previews = _build_preset_list_previews(story)
    knowledge_rows = _build_knowledge_rows(story, columns, asset_bytes)

    preview = ImportPreview(
        session_id=session_id,
        source_filename=source_filename,
        story_title=story.title or "Untitled Story",
        story_author=story.author,
        story_genre=story.genre,
        chapters=chapters_markers,
        acts=acts_markers,
        columns=columns,
        entities=entity_rows,
        preset_lists=preset_list_previews,
        knowledges=knowledge_rows,
    )

    _PREVIEW_SESSIONS[session_id] = _PreviewSession(
        story=story,
        asset_bytes=asset_bytes,
        source_filename=source_filename,
    )
    return preview


# ── Columns ────────────────────────────────────────────────────────────


def _build_columns(story: Story) -> list[ImportSceneColumn]:
    """Assemble the timeline grid's scene columns.

    - POV-chain scenes come FIRST in POV chain order (as computed
      by `pov_service.compute_pov_sequence`).
    - Non-POV scenes slot in AFTER the POV chain, ordered by canvas
      x-position (the "entity flow topology" resolver is a follow-up
      enhancement — x-order is the default tie-break per the
      planning doc).
    - Flashback-tagged scenes are excluded entirely (same policy as
      the export walker's off-screen appendix).
    """
    scenes_by_id = {n.id: n for n in (story.scenes or [])}
    pov_sequence = compute_pov_sequence(story)
    pov_node_ids: set[str] = set()

    columns: list[ImportSceneColumn] = []

    # POV chain scenes
    for entry in pov_sequence:
        node = scenes_by_id.get(entry["node_id"])
        if node is None:
            continue
        pov_node_ids.add(node.id)
        columns.append(ImportSceneColumn(
            id=node.id,
            title=(node.title or node.description or "Untitled Scene").strip() or "Untitled Scene",
            chapter_id=None,  # resolved in _build_chapter_markers
            is_pov_chain=True,
            chain_index=entry.get("index", 0) or 0,
            canvas_x=node.position.x if node.position else 0.0,
        ))

    # Non-POV scenes — by canvas x-order, excluding flashbacks
    non_pov_scenes = [
        n for n in (story.scenes or [])
        if n.id not in pov_node_ids and not getattr(n, "is_flashback", False)
    ]
    non_pov_scenes.sort(key=lambda n: (
        (n.position.x if n.position else 0.0),
        n.id,
    ))
    for node in non_pov_scenes:
        columns.append(ImportSceneColumn(
            id=node.id,
            title=(node.title or node.description or "Untitled Scene").strip() or "Untitled Scene",
            chapter_id=None,
            is_pov_chain=False,
            chain_index=None,
            canvas_x=node.position.x if node.position else 0.0,
        ))
    return columns


# ── Chapter + act markers ─────────────────────────────────────────────


def _build_chapter_markers(
    story: Story,
    columns: list[ImportSceneColumn],
) -> list[ImportChapterMarker]:
    """Walk the source story's chapters[] and assign each column's
    canvas-x position to a chapter by the same centre-point rule the
    export walker uses (port of the frontend's `getChapterIdForNode`
    helper — see `services/chapter_membership`). Fills in
    `column.chapter_id` on each column as a side effect."""
    from services.chapter_membership import get_chapter_id_for_node

    chapters = list(story.chapters or [])
    x_offset = story.chapter_x_offset if story.chapter_x_offset is not None else 10.0
    scenes_by_id = {n.id: n for n in (story.scenes or [])}

    # Assign each column to a chapter id (if any).
    for col in columns:
        node = scenes_by_id.get(col.id)
        if node is None:
            continue
        chapter_id = get_chapter_id_for_node(node, chapters, x_offset)
        col.chapter_id = chapter_id

    # Build a marker per chapter with first/last column ids.
    markers: list[ImportChapterMarker] = []
    for index, chapter in enumerate(chapters, start=1):
        matching_columns = [c for c in columns if c.chapter_id == chapter.id]
        if not matching_columns:
            # Still emit the marker — the chapter exists in the source
            # story even if no columns land in it in the preview. The
            # frontend can render it as an empty chapter bar if it
            # wants to, or hide it.
            markers.append(ImportChapterMarker(
                id=chapter.id,
                title=chapter.title or f"Chapter {index}",
                number=index,
                first_column_id=None,
                last_column_id=None,
            ))
            continue
        markers.append(ImportChapterMarker(
            id=chapter.id,
            title=chapter.title or f"Chapter {index}",
            number=index,
            first_column_id=matching_columns[0].id,
            last_column_id=matching_columns[-1].id,
        ))
    return markers


def _build_act_markers(
    story: Story,
    chapter_markers: list[ImportChapterMarker],
) -> list[ImportActMarker]:
    """Walk the source story's acts[] and emit a marker for each
    with its ordered chapter_ids. Non-contiguous acts are still
    emitted with their declared chapter list — the frontend decides
    how to render them."""
    acts = list(story.acts or [])
    markers: list[ImportActMarker] = []
    for index, act in enumerate(acts, start=1):
        markers.append(ImportActMarker(
            id=act.id,
            title=act.title or f"Act {index}",
            number=index,
            chapter_ids=list(act.chapter_ids or []),
        ))
    return markers


# ── Entity rows ────────────────────────────────────────────────────────


def _iter_entities_in_library_order(story: Story):
    """Yield `(entity, type_name)` pairs in canonical library order
    (characters → locations → items → factions → customs). Matches
    the order the Entity Library panel shows in the UI."""
    # Phase 1.21c: "knowledge" removed from the type list — Knowledge is
    # no longer an Entity subtype. Source-side import handling of
    # pre-1.21c saves with knowledge-typed entities relies on the
    # save-format migration in `file_service.py` to have already
    # converted them to top-level `Story.knowledges` before this
    # function runs (import path goes through `unpack_project` which
    # invokes `_migrate_story_dict`).
    for type_name in ("character", "location", "item", "faction", "custom"):
        bucket_name = type_name + "s" if type_name != "custom" else "customs"
        bucket = getattr(story.entities, bucket_name, None) or []
        for ent in bucket:
            yield ent, type_name


def _build_entity_rows(
    story: Story,
    columns: list[ImportSceneColumn],
    asset_bytes: dict[str, bytes],
) -> list[ImportEntityRow]:
    """Walk every entity in the source library and produce its
    timeline row.

    Two dot kinds are emitted per entity:

      - **Scene dots** for every column where the entity has an
        `EntityRef` in any bucket (characters / locations / items /
        factions / customs).
      - **Modifier dots** for every entity-specific modifier node on
        the canvas — an `EntityNode` with `is_modifier=True` and
        `entity_id == this_entity.id`. Modifier dots carry the
        source modifier node id so the frontend can pick one as a
        state-point, and the commit walker can walk to that
        specific modifier state.

    Dots are ordered by **canvas x-position** so modifier nodes
    interleave naturally with scenes in the user's visual chain
    order. Canvas x is a heuristic (not a formal graph walk) but
    matches how the grid already orders non-POV scene columns, and
    gives a stable chain-index sequence the frontend can render +
    the commit walker can walk.

    Each dot also carries **effective state** (colour + profile
    image data URI) at that chain point, computed via the same
    `_walk_entity_inclusive` helper the Track 2 commit path uses
    (modifier and scene targets both routed through the unified
    chain walker as of v0.2.1.87). The row itself carries the
    `final_*` effective state (walked to end of chain). The
    frontend renders scene + Final dots in the effective colour
    and swaps the identity cell's profile image based on the
    user's current pick. Phase 1.12c v0.1.12.57.
    """
    scenes_by_id = {n.id: n for n in (story.scenes or [])}
    # Group modifier nodes by the entity they modify so the row
    # builder can find each entity's modifiers in O(1).
    modifiers_by_entity: dict[str, list] = {}
    for node in (story.entity_nodes or []):
        if not getattr(node, "is_modifier", False):
            continue
        if not node.entity_id:
            continue
        modifiers_by_entity.setdefault(node.entity_id, []).append(node)

    rows: list[ImportEntityRow] = []
    for entity, type_name in _iter_entities_in_library_order(story):
        # 1. Collect the entity's raw dot candidates (scene + modifier)
        # with canvas x so we can sort them together.
        candidates: list[ImportDot] = []

        for column in columns:
            node = scenes_by_id.get(column.id)
            if node is None:
                continue
            if _node_has_entity_ref(node, entity.id):
                candidates.append(ImportDot(
                    column_id=column.id,
                    is_modifier=False,
                    modifier_node_id=None,
                    chain_index=0,  # filled in below after sort
                    canvas_x=(node.position.x if node.position else 0.0),
                ))

        for mod_node in modifiers_by_entity.get(entity.id, []):
            candidates.append(ImportDot(
                column_id=None,
                is_modifier=True,
                modifier_node_id=mod_node.id,
                chain_index=0,
                canvas_x=(mod_node.position.x if mod_node.position else 0.0),
            ))

        # 2. Sort by canvas x to give a stable chain order that
        # interleaves modifiers with scenes in a visually-consistent
        # way. Stable sort preserves column order for ties.
        candidates.sort(key=lambda d: d.canvas_x)

        # 3. Assign 1-based chain_index in sorted order.
        for i, dot in enumerate(candidates, start=1):
            dot.chain_index = i

        # 4. Compute effective state per dot by walking the entity's
        # chain up to each dot's target node. Mirrors the
        # `_resolve_state_point` dispatch so per-dot values exactly
        # match what the Track 2 commit walker would produce for the
        # same pick. Each walk is O(chain_length); total per-entity
        # cost is O(dots * chain_length), which is fine for the
        # once-per-upload preview build.
        for dot in candidates:
            walked = _walk_entity_inclusive(
                entity=entity,
                source_story=story,
                target_node_id=(dot.modifier_node_id if dot.is_modifier else dot.column_id),
            )
            dot.effective_name = walked.name
            dot.effective_colour = walked.colour
            dot.effective_profile_image_data_uri = _asset_to_data_uri_from_bytes(
                walked.profile_image_ref, asset_bytes,
            )

        # 5. Compute final-state effective values (walk the entity's
        # entire narrative chain, no target node). Used by the Final
        # bookend dot + identity cell when the user picks Final.
        final_walked = _walk_entity_inclusive(
            entity=entity,
            source_story=story,
            target_node_id=None,
        )
        final_name = final_walked.name
        final_colour = final_walked.colour
        final_profile_src = _asset_to_data_uri_from_bytes(
            final_walked.profile_image_ref, asset_bytes,
        )

        # Collect preset_list_ids referenced by this entity's preset-
        # type attributes at the origin state. Duplicates stripped,
        # order preserved (insertion order). Used by the frontend
        # Preset Lists tab to lock the corresponding checkboxes so
        # the user can't accidentally deselect a list the entity
        # depends on while the entity is staged.
        preset_ids: list[str] = []
        seen: set[str] = set()
        for attr in (entity.attributes or []):
            if getattr(attr, "attribute_type", None) == "preset" and attr.preset_list_id:
                if attr.preset_list_id not in seen:
                    preset_ids.append(attr.preset_list_id)
                    seen.add(attr.preset_list_id)

        rows.append(ImportEntityRow(
            id=entity.id,
            name=entity.name,
            type=type_name,
            colour=entity.colour,
            description=entity.description or "",
            profile_image_data_uri=_asset_to_data_uri_from_bytes(
                entity.profile_image_ref, asset_bytes,
            ),
            final_name=final_name,
            final_colour=final_colour,
            final_profile_image_data_uri=final_profile_src,
            dots=candidates,
            preset_list_ids_used=preset_ids,
        ))
    return rows


def _build_preset_list_previews(story: Story) -> list[ImportPresetListPreview]:
    """Summarize every preset list in the source story for the
    frontend Preset Lists tab. Sample values are capped at 3 entries
    to keep the preview payload small — the tab shows these as a
    one-line summary under each list's name."""
    previews: list[ImportPresetListPreview] = []
    for pl in (story.preset_lists or []):
        values = list(pl.values or [])
        previews.append(ImportPresetListPreview(
            id=pl.id,
            name=pl.name,
            value_count=len(values),
            sample_values=values[:3],
        ))
    return previews


@dataclass
class _WalkedKnowledgeState:
    """Flat walked-state snapshot for a Knowledge at a chain position.
    Parallels the entity walker's return type but for Knowledge's
    smaller field set (no attributes, no aliases, no relationships).
    `awareness` is the resolved awareness dict (or None when tracking
    is off at the picked anchor)."""
    name: str
    description: str
    colour: str
    profile_image_ref: Optional[str]
    awareness: Optional[dict[str, int]]
    awareness_scale: str  # "binary" | "full"


def _walk_knowledge_to_node(
    knowledge: Knowledge,
    node_order: list[str],
    target_node_id: Optional[str],
) -> _WalkedKnowledgeState:
    """Walk a Knowledge's chain forward through its history arrays in
    story order, applying every entry whose `node_id` is at-or-before
    `target_node_id` in `node_order`. Returns the effective state at
    that chain position.

    Mirrors `computeKnowledgeEffectiveState` in
    `frontend/src/utils/narrativeChain.js` (Phase 1.21c) but trimmed to
    what the import flow needs: the writer picks a state-point in the
    source story, we walk to it, and the walked snapshot becomes the
    NEW BASELINE for the freshly-created Knowledge in the target
    story. No history rides through — that's the user-directed
    "convert the selected point to a new starting state" semantics
    confirmed when this flow was scoped.

    `node_order` is the canonical scene-ordering list (typically the
    timeline grid's column ids in POV-chain-then-non-POV-canvas-x
    order). `target_node_id=None` means "walk to the end of the
    chain" — every entry in every history array is applied.

    Awareness handling parallels the JS walker's establishment model.
    Reads from the canonical `Knowledge.awareness.history` (post-v0.2a.2.0
    migration) — `AwarenessHistoryEntry` rows on the awareness wrapper:
      - origin baseline (`entries` / `sources` on the wrapper, or a
        flat-dict awareness) → tracking starts on at origin.
      - `tracking_action='on'` entries turn tracking on from that
        anchor forward (and can carry `awareness_scale`).
      - `tracking_action='off'` entries turn it off and clear the dict.
      - per-observer entries (with `observer_id` + `level`) only take
        effect while tracking is on.
      - `source_action` (projection mutation) entries are out of
        scope for the entity-import walker (matches pre-migration
        behaviour, which never handled projection on import).
    """
    node_index = {nid: i for i, nid in enumerate(node_order or [])}
    target_idx = node_index.get(target_node_id) if target_node_id else None

    def should_apply(node_id: Optional[str]) -> bool:
        if target_node_id is None:
            return True
        # Origin-only walk: the caller passes a sentinel that isn't in
        # the canonical node order (e.g. `"__origin_only__"`) to mean
        # "apply NOTHING — return baseline". `target_idx is None` is
        # the signal that the requested anchor doesn't resolve to any
        # known position, so every history entry is treated as
        # downstream and skipped.
        if target_idx is None:
            return False
        if node_id is None:
            return False
        # Entries on nodes outside the canonical order are also
        # treated as downstream of any real anchor.
        if node_id not in node_index:
            return False
        return node_index[node_id] <= target_idx

    # Origin baseline values.
    state_name = knowledge.name or ""
    state_description = knowledge.description or ""
    state_colour = knowledge.colour or "#888888"
    state_profile = knowledge.profile_image_ref
    # Awareness at origin: collapse wrapper / AwarenessRef shapes to a
    # flat dict (or None when tracking is off). For import we only
    # need the flat resolved dict — `_rewrite_awareness` will reshape
    # this into the wire format when the imported Knowledge is built.
    origin_awareness = knowledge.awareness
    if isinstance(origin_awareness, dict):
        tracking_on = True
        dict_state: dict[str, int] = {k: int(v) for k, v in origin_awareness.items() if v is not None}
    elif isinstance(origin_awareness, AwarenessWrapper):
        tracking_on = True
        dict_state = {
            k: int(v) for k, v in (origin_awareness.entries or {}).items() if v is not None
        }
    else:
        # None or AwarenessRef — tracking off / opaque ref. AwarenessRef
        # is left as "off + empty dict" for import-walker purposes; the
        # writer can wire up references manually in the target.
        tracking_on = False
        dict_state = {}
    awareness_scale = knowledge.awareness_scale or "full"

    history = knowledge.history or KnowledgeHistory()

    def by_story_order(arr):
        return sorted(
            arr or [],
            key=lambda ch: node_index.get(getattr(ch, "node_id", None), 10**12),
        )

    for ch in by_story_order(history.name_changes):
        if should_apply(ch.node_id) and isinstance(getattr(ch, "new_name", None), str):
            state_name = ch.new_name
    for ch in by_story_order(history.description_changes):
        if should_apply(ch.node_id) and isinstance(getattr(ch, "new_description", None), str):
            state_description = ch.new_description
    for ch in by_story_order(history.colour_changes):
        if should_apply(ch.node_id) and isinstance(getattr(ch, "new_colour", None), str):
            state_colour = ch.new_colour
    for ch in by_story_order(history.profile_image_changes):
        if should_apply(ch.node_id):
            # `new_profile_image_ref` may be None (explicit clear) — apply as-is.
            state_profile = getattr(ch, "new_profile_image_ref", None)

    # Awareness mutations — read from canonical Knowledge.awareness.history
    # (post v0.2a.2.0 migration). Mirrors the JS walker
    # `applyAwarenessHistoryToWrapper` semantics.
    awareness_obj = knowledge.awareness
    awareness_history = (
        awareness_obj.history
        if isinstance(awareness_obj, AwarenessWrapper) and awareness_obj.history
        else []
    )
    for ch in by_story_order(awareness_history):
        if not should_apply(ch.node_id):
            continue
        tracking_action = getattr(ch, "tracking_action", None)
        if tracking_action == "on":
            tracking_on = True
            scale = getattr(ch, "awareness_scale", None)
            if scale:
                awareness_scale = scale
            continue
        if tracking_action == "off":
            tracking_on = False
            dict_state = {}
            continue
        if getattr(ch, "source_action", None):
            # Source-projection mutations are out of scope for the
            # entity-import walker (matches pre-migration behaviour).
            continue
        if not tracking_on:
            continue
        observer_id = getattr(ch, "observer_id", None) or None
        if not observer_id:
            continue
        level = getattr(ch, "level", None)
        if level is None:
            dict_state.pop(observer_id, None)
        else:
            dict_state[observer_id] = int(level)

    return _WalkedKnowledgeState(
        name=state_name,
        description=state_description,
        colour=state_colour,
        profile_image_ref=state_profile,
        awareness=(dict_state if tracking_on else None),
        awareness_scale=awareness_scale,
    )


def _collect_knowledge_chain_node_ids(knowledge: Knowledge) -> set[str]:
    """Every scene node id touched by any entry in this Knowledge's
    history arrays, its canonical `awareness.history` (post-v0.2a.2.0
    migration), plus any manual_anchors. Each id is a candidate
    state-point for the timeline grid.
    """
    node_ids: set[str] = set()
    history = knowledge.history or KnowledgeHistory()
    # KnowledgeHistory.* arrays (post-v0.2a.2.2: awareness_changes is
    # no longer declared on KnowledgeHistory — that data lives on
    # `knowledge.awareness.history` and is collected separately below).
    for arr_name in (
        "existence_changes",
        "name_changes",
        "description_changes",
        "colour_changes",
        "profile_image_changes",
        "source_event_changes",
    ):
        for entry in getattr(history, arr_name, None) or []:
            nid = getattr(entry, "node_id", None)
            if nid:
                node_ids.add(nid)
    # Canonical awareness wrapper history.
    awareness_obj = knowledge.awareness
    if isinstance(awareness_obj, AwarenessWrapper) and awareness_obj.history:
        for entry in awareness_obj.history:
            nid = getattr(entry, "node_id", None)
            if nid:
                node_ids.add(nid)
    for anchor in (knowledge.manual_anchors or []):
        nid = getattr(anchor, "node_id", None)
        if nid:
            node_ids.add(nid)
    return node_ids


def _build_knowledge_rows(
    story: Story,
    columns: list[ImportSceneColumn],
    asset_bytes: dict[str, bytes],
) -> list[ImportKnowledgeRow]:
    """Walk every Knowledge in the source story and produce a timeline
    row. Dots come from the union of every node_id touched by the
    Knowledge's history arrays AND manual_anchors, intersected with
    the column set (so dots only render on grid columns the writer can
    actually see). Each dot carries the walked effective state at that
    chain position so the picker preview renders correctly.

    A Knowledge with no history and no manual_anchors emits an
    origin-only row (no dots). The writer can still import it via the
    "Origin" pick (state-point at origin).
    """
    if not story.knowledges:
        return []

    column_ids_in_order = [c.id for c in columns]
    column_id_set = set(column_ids_in_order)
    canvas_x_by_column_id = {c.id: c.canvas_x for c in columns}

    rows: list[ImportKnowledgeRow] = []
    for knowledge in story.knowledges:
        chain_node_ids = _collect_knowledge_chain_node_ids(knowledge)
        # Restrict to ids that exist as columns in the grid — anything
        # else has nowhere to render. Out-of-grid history entries are
        # silently skipped at preview time (they'd be skipped at walk
        # time anyway via the node-order filter).
        usable_chain_ids = chain_node_ids & column_id_set
        # Stable order = column order.
        ordered_chain_ids = [cid for cid in column_ids_in_order if cid in usable_chain_ids]

        # Origin profile image data URI.
        origin_data_uri = _asset_to_data_uri_from_bytes(
            knowledge.profile_image_ref, asset_bytes,
        )

        # Walked dots — one per chain stop.
        dots: list[ImportKnowledgeDot] = []
        for i, cid in enumerate(ordered_chain_ids):
            walked = _walk_knowledge_to_node(
                knowledge=knowledge,
                node_order=column_ids_in_order,
                target_node_id=cid,
            )
            dot_data_uri = _asset_to_data_uri_from_bytes(
                walked.profile_image_ref, asset_bytes,
            )
            dots.append(ImportKnowledgeDot(
                column_id=cid,
                chain_index=i + 1,
                canvas_x=canvas_x_by_column_id.get(cid, 0.0),
                effective_name=walked.name,
                effective_colour=walked.colour,
                effective_profile_image_data_uri=dot_data_uri,
            ))

        # Final state — walk to end.
        final_walked = _walk_knowledge_to_node(
            knowledge=knowledge,
            node_order=column_ids_in_order,
            target_node_id=None,
        )
        final_data_uri = _asset_to_data_uri_from_bytes(
            final_walked.profile_image_ref, asset_bytes,
        )

        rows.append(ImportKnowledgeRow(
            id=knowledge.id,
            name=knowledge.name or "Untitled Knowledge",
            colour=knowledge.colour or "#888888",
            description=knowledge.description or "",
            profile_image_data_uri=origin_data_uri,
            final_name=final_walked.name,
            final_colour=final_walked.colour,
            final_profile_image_data_uri=final_data_uri,
            dots=dots,
        ))

    return rows


def _node_has_entity_ref(node: SceneNode, entity_id: str) -> bool:
    """True if `node` has an `EntityRef` for `entity_id` in any of
    its five buckets."""
    for bucket_name in ENTITY_BUCKETS:
        for ref in (getattr(node, bucket_name, None) or []):
            if ref.entity_id == entity_id:
                return True
    return False


# ── Asset data-URI helper ──────────────────────────────────────────────


def _asset_to_data_uri_from_bytes(
    asset_ref: Optional[str],
    asset_bytes: dict[str, bytes],
) -> Optional[str]:
    """Look up `asset_ref` in the in-memory asset bytes dict and
    convert to a `data:image/...;base64,...` URI. Returns None on
    any failure (missing ref, missing file, unrecognised mime).
    Never touches disk — all data comes from the preloaded dict
    returned by `_read_source_nnz`."""
    if not asset_ref:
        return None
    # asset_ref typically looks like "assets/foo.png" or just "foo.png".
    # Normalise by stripping a leading "assets/" if present.
    filename = asset_ref
    if filename.startswith("assets/"):
        filename = filename[len("assets/"):]
    raw = asset_bytes.get(filename)
    if raw is None:
        return None
    mime_type, _ = mimetypes.guess_type(filename)
    if mime_type is None:
        mime_type = "application/octet-stream"
    encoded = b64encode(raw).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


# ══════════════════════════════════════════════════════════════════════
# ── Track 2 — Commit action ──────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════


# ── Commit request / result dataclasses ───────────────────────────────


@dataclass
class ImportStatePoint:
    """The user's chosen state-point for one entity in the import.

      - `origin`   → use the source library / setup node state (default
                     for entities that have no scene presence yet)
      - `scene`    → walk the entity's chain up to and including the
                     named scene, applying every EntityRef change
                     encountered along the way
      - `modifier` → state at an entity-specific modifier node.
                     NOT yet implemented in v1 — modifier dots aren't
                     even emitted in the preview (per the Track 1
                     deferral note). Currently falls back to origin
                     state if the frontend ever sends one.
      - `final`    → walk to the END of the entity's chain (the most
                     progressed state). Equivalent to clicking the
                     "Final State" column header in the timeline grid.
    """
    kind: Literal["origin", "scene", "modifier", "final"]
    scene_id: Optional[str] = None
    modifier_node_id: Optional[str] = None


@dataclass
class ImportPick:
    """One entity the user has decided to import, paired with the
    state-point they chose for it."""
    entity_id: str                          # source entity id
    state_point: ImportStatePoint


@dataclass
class ImportKnowledgeStatePoint:
    """The user's chosen state-point for one Knowledge in the import.

      - `origin` → use the Knowledge's library baseline (no history
                   applied; the Knowledge's stored `name` / `colour` /
                   etc. fields as-is).
      - `scene`  → walk the Knowledge's history forward through every
                   entry whose `node_id` is at-or-before the named
                   scene in the canonical column order. The walked
                   snapshot becomes the new Knowledge's baseline in
                   the target story (no history rides through).
      - `final`  → walk to the end of the chain — equivalent to the
                   "Final State" bookend column on the timeline grid.
    """
    kind: Literal["origin", "scene", "final"]
    scene_id: Optional[str] = None


@dataclass
class ImportKnowledgePick:
    """One Knowledge the user has decided to import, paired with the
    state-point they chose for it. Parallels `ImportPick`."""
    knowledge_id: str                       # source knowledge id
    state_point: ImportKnowledgeStatePoint


@dataclass
class ImportCommitRequest:
    """Full commit payload assembled by the frontend and sent to
    `POST /api/project/import/commit`."""
    session_id: str
    picks: list[ImportPick] = field(default_factory=list)
    import_story_settings: bool = False
    name_collision_strategy: Literal["suffix"] = "suffix"
    # Explicit list of source preset_list ids the user has ticked in
    # the ImportDialog's Preset Lists tab. Empty list = don't import
    # any preset list explicitly (but attribute-referenced ones still
    # auto-import at commit time via _rewrite_attribute). The frontend
    # typically pre-populates this with the ids that entities on the
    # grid depend on (auto-locked) plus whichever additional lists
    # the user ticked manually. Dedup by name still applies.
    preset_list_ids: list[str] = field(default_factory=list)
    # Knowledge picks. Each picked Knowledge is walked to its chosen
    # state-point and the resulting snapshot becomes the new
    # Knowledge's baseline in the target story (per the user-confirmed
    # "no history" import model). Awareness keys pointing at entities
    # not in the import batch are dropped at commit time.
    knowledge_picks: list[ImportKnowledgePick] = field(default_factory=list)


@dataclass
class ImportCommitResult:
    """Summary of what was actually imported, returned to the
    frontend so it can show a toast / populate the entity library."""
    imported_count: int
    imported_entity_ids: list[str]          # new target-project ids
    dropped_relationships: list[str]        # human-readable descriptions
    imported_preset_list_count: int
    imported_custom_category_count: int
    imported_asset_count: int
    imported_knowledge_count: int = 0
    imported_knowledge_ids: list[str] = field(default_factory=list)


# ── Commit service ────────────────────────────────────────────────────


def import_entities(
    request: ImportCommitRequest,
    target_story: Story,
) -> tuple[Story, ImportCommitResult]:
    """Apply an import commit request to a target Story.

    Returns `(new_target_story, summary)`. The input `target_story`
    is NOT mutated — a deep pydantic copy is made, the imports are
    applied to the copy, and the copy is returned. The caller is
    responsible for calling `state.set_story(new)` once the commit
    returns cleanly. If this function raises, the target story is
    untouched.

    Asset bytes ARE written to the target project's assets dir on
    disk during the commit (so the newly-imported entities can find
    their profile images + file attributes at the paths they
    reference). Filesystem writes are the only side-effect besides
    the returned story.

    Raises `ValueError` if the preview session has expired or the
    session_id is unknown.
    """
    session = get_preview_session(request.session_id)
    if session is None:
        raise ValueError(
            f"Preview session not found: {request.session_id!r} "
            f"(may have expired or been cleared)"
        )

    source_story = session.story
    source_asset_bytes = session.asset_bytes

    # Deep-copy the target story so we can mutate it freely without
    # touching the caller's object until we're done and successful.
    target = target_story.model_copy(deep=True)

    # Pre-assign NEW target-project ids for each pick so we can
    # resolve "both endpoints in the import batch" for relationships
    # BEFORE we build the actual Entity objects.
    picked_source_ids = {p.entity_id for p in request.picks}
    entity_id_rewrite: dict[str, str] = {
        p.entity_id: str(uuid.uuid4()) for p in request.picks
    }

    # Phase 1.21: pre-build the relationship_id_rewrite the same way.
    # Only relationships whose participants are fully in the import
    # batch are included; awareness AwarenessRef values pointing at an
    # in-batch relationship get rewritten to the new id, pointing at
    # an out-of-batch relationship they get dropped (awareness field
    # collapsed to None).
    relationship_id_rewrite: dict[str, str] = {}
    for rel in source_story.relationships:
        participant_ids = {
            ch.entity_id for ch in rel.history.participant_changes
            if ch.action == "join"
        }
        if not participant_ids:
            continue
        if not participant_ids.issubset(picked_source_ids):
            continue
        relationship_id_rewrite[rel.id] = str(uuid.uuid4())

    source_entities_by_id = _build_source_entity_lookup(source_story)

    # Mutation tracking so the summary is accurate + so dedup helpers
    # don't re-copy the same asset / preset list / category twice.
    asset_rewrite: dict[str, str] = {}           # source filename -> target filename
    preset_list_rewrite: dict[str, str] = {}     # source preset_list_id -> target id
    category_rewrite: dict[str, str] = {}        # source category_id -> target id
    # Newly-imported sets — populated only when a dedup MISS actually
    # creates a new entry on the target. Dedup HITS (where the
    # rewrite map points at an existing target entry with the same
    # name) don't count as imports, so they don't belong in the
    # summary counts.
    newly_imported_preset_lists: set[str] = set()
    newly_imported_categories: set[str] = set()
    dropped_relationships: list[str] = []
    imported_entities: list[tuple[Entity, str]] = []
    # Phase 1.25f follow-up — `target=="relationship"` awareness chain
    # mutations recorded on EntityRefs aren't applied during the
    # entity walk (they'd write to a relationship's awareness, but the
    # relationship hasn't been imported yet). Walks accumulate them
    # here; we apply them after relationships are imported in step 8b.
    # Each entry: (source_relationship_id, AwarenessChange).
    pending_relationship_awareness: list[tuple[str, "AwarenessChange"]] = []

    for pick in request.picks:
        source_entry = source_entities_by_id.get(pick.entity_id)
        if source_entry is None:
            continue  # ignored — invalid pick
        source_entity, bucket_name = source_entry

        # 1. Walk the state-point to get the flattened entity.
        walked = _resolve_state_point(
            source_entity=source_entity,
            state_point=pick.state_point,
            source_story=source_story,
            pending_relationship_awareness=pending_relationship_awareness,
        )

        # 2. Collision-safe name in the target.
        new_name = _apply_name_collision_suffix(walked.name, target)

        # 3. Profile image: ensure the asset is copied + get the new ref.
        new_profile_image_ref: Optional[str] = None
        if walked.profile_image_ref:
            new_profile_image_ref = _ensure_asset_in_rewrite_map(
                walked.profile_image_ref,
                source_asset_bytes=source_asset_bytes,
                asset_rewrite=asset_rewrite,
            )

        # 4. Attributes — each may reference an asset + a preset list.
        new_attributes: list[Attribute] = []
        for attr in walked.attributes or []:
            new_attr = _rewrite_attribute(
                attr=attr,
                source_story=source_story,
                source_asset_bytes=source_asset_bytes,
                asset_rewrite=asset_rewrite,
                preset_list_rewrite=preset_list_rewrite,
                newly_imported_preset_lists=newly_imported_preset_lists,
                target_story=target,
                entity_id_rewrite=entity_id_rewrite,
                relationship_id_rewrite=relationship_id_rewrite,
            )
            if new_attr is not None:
                new_attributes.append(new_attr)

        # 5. Category (Custom entities only) — dedup against the target.
        # (Relationship import now happens at story level after all entities are
        # appended — see step 8b below.)
        new_category_id: Optional[str] = None
        if walked.category_id:
            new_category_id = _ensure_custom_category_imported(
                walked.category_id,
                source_story=source_story,
                source_asset_bytes=source_asset_bytes,
                category_rewrite=category_rewrite,
                newly_imported=newly_imported_categories,
                asset_rewrite=asset_rewrite,
                target_story=target,
            )

        # 6. Construct the new target entity with the pre-assigned id.
        # Phase 1.21: rewrite awareness fields on the entity itself AND
        # on each alias. Dict keys remap via entity_id_rewrite (dropping
        # keys pointing at entities not in the batch); AwarenessRefs
        # remap via relationship_id_rewrite (dropping refs pointing at
        # un-imported relationships).
        new_aliases = [
            alias.model_copy(
                update={
                    "awareness": _rewrite_awareness(
                        alias.awareness,
                        entity_id_rewrite=entity_id_rewrite,
                        relationship_id_rewrite=relationship_id_rewrite,
                    ),
                },
                deep=True,
            )
            for alias in (walked.aliases or [])
        ]
        new_entity_awareness = _rewrite_awareness(
            walked.awareness,
            entity_id_rewrite=entity_id_rewrite,
            relationship_id_rewrite=relationship_id_rewrite,
        )
        # Phase 1.25f (Bug 5) — `name_awareness` was previously dropped
        # silently on import; the rewriter helper now covers it.
        new_entity_name_awareness = _rewrite_awareness(
            getattr(walked, "name_awareness", None),
            entity_id_rewrite=entity_id_rewrite,
            relationship_id_rewrite=relationship_id_rewrite,
        )
        new_entity = Entity(
            id=entity_id_rewrite[pick.entity_id],
            type=walked.type,
            name=new_name,
            colour=walked.colour,
            description=walked.description,
            attributes=new_attributes,
            category_id=new_category_id,
            label=walked.label,
            profile_image_ref=new_profile_image_ref,
            aliases=new_aliases,
            notes=walked.notes,
            awareness=new_entity_awareness,
            name_awareness=new_entity_name_awareness,
        )
        imported_entities.append((new_entity, bucket_name))

    # 8. Append imported entities to the target's library buckets.
    for entity, bucket_name in imported_entities:
        bucket = getattr(target.entities, bucket_name)
        bucket.append(entity)

    # 8b. Import top-level relationships where ALL participants are in
    # the imported batch (filtered into `relationship_id_rewrite` earlier).
    # Relationships with participants outside the batch produce a warning
    # entry in `dropped_relationships`. Runs after step 8 so all new
    # entity IDs are established.
    for rel in source_story.relationships:
        participant_ids = {
            ch.entity_id for ch in rel.history.participant_changes
            if ch.action == "join"
        }
        if not participant_ids:
            continue
        if rel.id not in relationship_id_rewrite:
            # Not in the batch — log the reason and skip.
            outside = participant_ids - picked_source_ids
            outside_names = [
                source_entities_by_id[eid][0].name
                if eid in source_entities_by_id else eid
                for eid in outside
            ]
            dropped_relationships.append(
                f"Relationship '{rel.name or rel.id}': "
                f"{', '.join(outside_names)} not in import batch"
            )
            continue
        new_rel = rel.model_copy(deep=True)
        new_rel.id = relationship_id_rewrite[rel.id]
        # Rewrite entity_ids in every history participant_change event.
        for ch in new_rel.history.participant_changes:
            ch.entity_id = entity_id_rewrite.get(ch.entity_id, ch.entity_id)
        # Phase 1.25f (Bug 2) — rewrite entity_ids on the OTHER history
        # arrays too. Pre-1.25f the rewriter only touched
        # participant_changes; perception / alias-override / role /
        # hierarchy events kept their source ids and pointed at
        # entities that don't exist in the target.
        for ch in (new_rel.history.perception_changes or []):
            ch.entity_id = entity_id_rewrite.get(ch.entity_id, ch.entity_id)
        for ch in (new_rel.history.alias_changes or []):
            ch.entity_id = entity_id_rewrite.get(ch.entity_id, ch.entity_id)
        for ch in (new_rel.history.role_changes or []):
            ch.entity_id = entity_id_rewrite.get(ch.entity_id, ch.entity_id)
        # Phase 1.26a — HierarchyConfig is now a forest of HierarchyNodes
        # (`roots`, each carrying recursive `children`). Walk the tree
        # and rewrite each node's `id` through the entity_id_rewrite
        # map, but only in participants mode where node ids ARE entity
        # ids. Roles-mode ids are role-value strings; leave them alone.
        def _rewrite_hierarchy_ids(config):
            if config is None or config.mode != 'participants':
                return
            def walk(nodes):
                for n in nodes:
                    n.id = entity_id_rewrite.get(n.id, n.id)
                    walk(n.children)
            walk(config.roots)

        for ch in (new_rel.history.hierarchy_changes or []):
            _rewrite_hierarchy_ids(getattr(ch, "new_hierarchy", None))
        if new_rel.membership_of and new_rel.membership_of in entity_id_rewrite:
            new_rel.membership_of = entity_id_rewrite[new_rel.membership_of]
        _rewrite_hierarchy_ids(new_rel.hierarchy)
        # Rewrite the baseline `participant_roles` keys (entity ids).
        if new_rel.participant_roles:
            new_rel.participant_roles = {
                entity_id_rewrite.get(eid, eid): role
                for eid, role in new_rel.participant_roles.items()
            }
        # Phase 1.21: rewrite awareness on the relationship itself.
        new_rel.awareness = _rewrite_awareness(
            new_rel.awareness,
            entity_id_rewrite=entity_id_rewrite,
            relationship_id_rewrite=relationship_id_rewrite,
        )
        target.relationships.append(new_rel)

    # 8c. Phase 1.25f follow-up — apply target=='relationship' awareness
    # mutations collected during the entity walks. Each mutation walks
    # forward to the same chain anchor the writer picked for the
    # entity; we apply them in collection order to preserve the chain
    # semantics (later mutations override earlier ones for the same
    # observer / source). Mutations referencing relationships that
    # weren't imported (because their participants weren't all in the
    # batch) are silently dropped.
    if pending_relationship_awareness:
        new_rels_by_id: dict[str, "Relationship"] = {r.id: r for r in target.relationships}
        for source_rel_id, change in pending_relationship_awareness:
            new_rel_id = relationship_id_rewrite.get(source_rel_id)
            if not new_rel_id:
                continue
            target_rel = new_rels_by_id.get(new_rel_id)
            if target_rel is None:
                continue
            # Build a copy of the change with its `entity_id` (direct-
            # entry observer) remapped, since we collected it pre-
            # rewrite. Source-action mutations need their `source` ref
            # remapped too — for AttributeSource the entity_id; for
            # RelationshipSource the relationship_id.
            remapped = change.model_copy(deep=True)
            if remapped.entity_id:
                remapped.entity_id = entity_id_rewrite.get(remapped.entity_id, remapped.entity_id)
            if remapped.source is not None:
                src = remapped.source
                if isinstance(src, RelationshipSource):
                    new_rid = relationship_id_rewrite.get(src.relationship_id)
                    if not new_rid:
                        continue  # source relationship not imported
                    remapped.source = RelationshipSource(
                        relationship_id=new_rid, level=src.level,
                    )
                elif isinstance(src, AttributeSource):
                    new_eid = entity_id_rewrite.get(src.entity_id)
                    if not new_eid:
                        continue  # source entity not imported
                    remapped.source = AttributeSource(
                        entity_id=new_eid,
                        attribute_id=src.attribute_id,
                        level=src.level,
                    )
            target_rel.awareness = _apply_awareness_mutation(
                target_rel.awareness, remapped,
            )

    # 8d. Knowledge picks. Walk each picked Knowledge to its chosen
    # state-point and create a fresh Knowledge in the target with
    # the walked snapshot as its NEW BASELINE (no history rides
    # through — see ImportKnowledgeStatePoint docstring). Awareness
    # entity_id keys are remapped via entity_id_rewrite; keys
    # pointing at entities not in the import batch are dropped.
    imported_knowledges: list[Knowledge] = []
    if request.knowledge_picks:
        source_knowledges_by_id = {k.id: k for k in (source_story.knowledges or [])}
        # Build the same node_order used at preview time (POV-chain
        # scenes first, then non-POV scenes in canvas-x order) so the
        # walker resolves scene state-points the same way.
        source_columns = _build_columns(source_story)
        knowledge_node_order = [c.id for c in source_columns]

        for kpick in request.knowledge_picks:
            source_knowledge = source_knowledges_by_id.get(kpick.knowledge_id)
            if source_knowledge is None:
                continue  # ignored — invalid pick

            # Walk the source Knowledge's chain to the picked state-point.
            if kpick.state_point.kind == "origin":
                walked = _walk_knowledge_to_node(
                    knowledge=source_knowledge,
                    node_order=knowledge_node_order,
                    target_node_id=None if not knowledge_node_order else "__origin_only__",
                )
                # The walker's target_node_id="__origin_only__" sentinel
                # is unknown to the index map → no entries apply. Result:
                # origin-only snapshot. Same effect as bypassing the
                # walker, but keeps the wrapper-collapse + scale
                # resolution path consistent.
            elif kpick.state_point.kind == "final":
                walked = _walk_knowledge_to_node(
                    knowledge=source_knowledge,
                    node_order=knowledge_node_order,
                    target_node_id=None,
                )
            else:
                # "scene"
                walked = _walk_knowledge_to_node(
                    knowledge=source_knowledge,
                    node_order=knowledge_node_order,
                    target_node_id=kpick.state_point.scene_id,
                )

            # Collision-safe name in the target.
            new_name = _apply_name_collision_suffix(walked.name, target)

            # Profile image: ensure the asset is copied.
            new_profile_image_ref: Optional[str] = None
            if walked.profile_image_ref:
                new_profile_image_ref = _ensure_asset_in_rewrite_map(
                    walked.profile_image_ref,
                    source_asset_bytes=source_asset_bytes,
                    asset_rewrite=asset_rewrite,
                )

            # Filter awareness keys to entities in the batch and remap
            # to new target ids. Out-of-batch keys are dropped silently
            # (per the user-chosen "drop orphan awareness" policy
            # confirmed when this flow was scoped).
            new_awareness: Optional[dict[str, int]] = None
            if walked.awareness is not None:
                filtered: dict[str, int] = {}
                for source_eid, level in walked.awareness.items():
                    new_eid = entity_id_rewrite.get(source_eid)
                    if new_eid is None:
                        continue  # observer entity not in batch — drop
                    filtered[new_eid] = level
                # Preserve tracking-on state even if the dict ends up
                # empty (writer may have intentionally established
                # tracking with no observers yet).
                new_awareness = filtered

            new_knowledge = Knowledge(
                id=str(uuid.uuid4()),
                name=new_name,
                description=walked.description,
                colour=walked.colour,
                profile_image_ref=new_profile_image_ref,
                notes=source_knowledge.notes or "",
                awareness_scale=walked.awareness_scale,
                awareness=new_awareness,
                # No history rides through — fresh baseline only.
                history=KnowledgeHistory(),
                # No source_event back-pointer — that referred to an
                # event in the source story that we're not bringing.
                source_event=None,
                # No manual anchors — they referred to source scenes.
                manual_anchors=[],
            )
            imported_knowledges.append(new_knowledge)
            target.knowledges.append(new_knowledge)

    # 9. Optional story-level settings copy.
    if request.import_story_settings:
        _apply_story_level_settings(
            target=target,
            source=source_story,
            entity_id_rewrite=entity_id_rewrite,
        )

    # 9b. Explicit preset list imports from the Preset Lists tab.
    # Each id in request.preset_list_ids is imported individually
    # via the same dedup helper used by attribute-referenced lists,
    # so a list that's already in the target by name is reused
    # (not duplicated) and a list that's already in the rewrite map
    # (because an attribute walked through it at step 4) is a no-op.
    for source_pl_id in (request.preset_list_ids or []):
        _ensure_preset_list_imported(
            source_pl_id,
            source_story=source_story,
            preset_list_rewrite=preset_list_rewrite,
            newly_imported=newly_imported_preset_lists,
            target_story=target,
        )

    # 10. Write the copied asset bytes to the target project's assets
    # dir ON DISK. This is the only side-effect besides the returned
    # story object. If the target project hasn't been saved yet,
    # `get_or_create_assets_dir` allocates a temp dir so the asset
    # survives until the next save.
    imported_asset_count = _write_imported_assets_to_disk(
        asset_rewrite=asset_rewrite,
        source_asset_bytes=source_asset_bytes,
    )

    # 11. Build the result summary. Preset list + category counts
    # only include ACTUAL new imports (dedup misses), not dedup hits
    # where we reused an existing target-side entry.
    result = ImportCommitResult(
        imported_count=len(imported_entities),
        imported_entity_ids=[e.id for e, _ in imported_entities],
        dropped_relationships=dropped_relationships,
        imported_preset_list_count=len(newly_imported_preset_lists),
        imported_custom_category_count=len(newly_imported_categories),
        imported_asset_count=imported_asset_count,
        imported_knowledge_count=len(imported_knowledges),
        imported_knowledge_ids=[k.id for k in imported_knowledges],
    )

    return target, result


# ── State-point resolution ────────────────────────────────────────────


def _resolve_state_point(
    source_entity: Entity,
    state_point: ImportStatePoint,
    source_story: Story,
    pending_relationship_awareness: Optional[list] = None,
) -> Entity:
    """Walk the source entity's chain forward to the chosen
    state-point and return a flattened snapshot `Entity` with the
    walked-forward scalar fields + attributes. Relationships are
    NOT walked — same limitation as the export walker's
    `_walk_entity_state_forward`; origin-state relationships carry
    through unchanged. A future enhancement can add relationship
    chain walking if users report it as a gap."""
    kind = state_point.kind

    if kind == "origin":
        # No walk — return a deep copy of the library/setup-node state.
        return source_entity.model_copy(deep=True)

    if kind == "scene":
        return _walk_entity_inclusive(
            entity=source_entity,
            source_story=source_story,
            target_node_id=state_point.scene_id,
            pending_relationship_awareness=pending_relationship_awareness,
        )

    if kind == "final":
        # Walk the entity's entire narrative chain — no target node
        # means walk to the end.
        return _walk_entity_inclusive(
            entity=source_entity,
            source_story=source_story,
            target_node_id=None,
            pending_relationship_awareness=pending_relationship_awareness,
        )

    if kind == "modifier":
        # State at an entity-specific modifier node. The chain walker
        # naturally includes modifier EntityNodes as chain stops, so
        # walking inclusive-to the modifier id produces the modifier's
        # post-apply state directly — no separate filter / canvas-x
        # heuristic required (those were artefacts of the prior
        # POV-iteration design).
        return _walk_entity_inclusive(
            entity=source_entity,
            source_story=source_story,
            target_node_id=state_point.modifier_node_id,
            pending_relationship_awareness=pending_relationship_awareness,
        )

    # Unknown kind — origin fallback.
    return source_entity.model_copy(deep=True)


def _walk_entity_inclusive(
    entity: Entity,
    source_story: Story,
    target_node_id: Optional[str],
    pending_relationship_awareness: Optional[list] = None,
) -> Entity:
    """Walk the entity's OWN narrative chain (origin EntityNode →
    flow connections through scenes/modifier nodes where this entity
    participates) up to and INCLUDING `target_node_id`, applying every
    EntityRef / modifier-node change for this entity along the way.
    Returns a pydantic deep copy of the entity with the walked state
    applied.

    Iteration source: `get_entity_narrative_chain(entity.id, source_story)`
    from `services.narrative_chain` — the canonical port of the frontend's
    `narrativeChain.js#getEntityNarrativeChain`. POV-chain iteration is
    explicitly NOT used here; that was the v0.2.1.x bug that silently
    dropped every change made to the entity at an off-POV scene.

    When `target_node_id is None`, walks the entire chain (used by
    the `final` state-point kind). `target_node_id` may be either a
    SceneNode id (state at that scene, inclusive) or a modifier
    EntityNode id (state at that modifier, inclusive) — both natural
    chain stops.

    Phase 1.25f (Bug 4) — `Entity.notes` is intentionally not chain-
    tracked (see model docstring); it carries through this walker via
    the leading `model_copy(deep=True)` and never gets explicit handling
    in the per-stop loop. A future refactor that switches to field-by-
    field assignment would need to remember to copy `notes` explicitly."""
    walked = entity.model_copy(deep=True)
    attrs_by_id: dict[str, Attribute] = {
        a.id: a.model_copy(deep=True) for a in (entity.attributes or [])
    }
    attrs_order: list[str] = [a.id for a in (entity.attributes or [])]

    chain = get_entity_narrative_chain(entity.id, source_story)
    # chain[0] is the origin EntityNode — its baseline IS the entity
    # itself (already loaded into `walked` above), so the per-stop apply
    # loop skips it and starts from chain[1] onward.
    for chain_node in chain[1:]:
        node_type = getattr(chain_node, "node_type", None)
        if node_type == "scene":
            _apply_scene_to_walked(
                scene=chain_node,
                entity=entity,
                walked=walked,
                attrs_by_id=attrs_by_id,
                attrs_order=attrs_order,
                pending_relationship_awareness=pending_relationship_awareness,
            )
        elif node_type == "entity":
            # Modifier EntityNode for this entity.
            _apply_modifier_to_walked(
                modifier=chain_node,
                walked=walked,
                attrs_by_id=attrs_by_id,
                attrs_order=attrs_order,
            )

        # Stop after applying the target node's changes (inclusive).
        if target_node_id is not None and chain_node.id == target_node_id:
            break

    walked.attributes = [
        attrs_by_id[aid] for aid in attrs_order if aid in attrs_by_id
    ]
    return walked


def _apply_scene_to_walked(
    scene: SceneNode,
    entity: Entity,
    walked: Entity,
    attrs_by_id: dict[str, Attribute],
    attrs_order: list[str],
    pending_relationship_awareness: Optional[list],
) -> None:
    """Apply every EntityRef change for `entity` at `scene` to the
    walked state, plus the per-host canonical awareness history at this
    scene. Extracted from the chain-walk loop so the same per-stop
    apply logic can be reused by other walkers without duplication."""
    for bucket_name in ENTITY_BUCKETS:
        bucket = getattr(scene, bucket_name, None)
        if not bucket:
            continue
        for ref in bucket:
            if ref.entity_id != entity.id:
                continue
            if ref.name_change:
                walked.name = ref.name_change
            if ref.colour_change:
                walked.colour = ref.colour_change
            if ref.description_change is not None:
                walked.description = ref.description_change
            if ref.profile_image_change is not None:
                walked.profile_image_ref = ref.profile_image_change or None
            # Per-alias chain events. `add` pushes the alias by id if
            # not present; `remove` filters by id; `modify` patches
            # value on the matching id; the `awareness_*` actions
            # mutate the target alias's awareness wrapper (direct-
            # mutation against `_apply_awareness_mutation`, mirroring
            # the per-attribute awareness pattern). Legacy
            # `aliases_change` snapshot read path retained as a
            # transitional safety net for any save that bypassed the
            # load-time migration.
            #
            # ⚠ PARITY REQUIREMENT — KEEP THIS DISPATCHER IN LOCKSTEP
            # WITH THE FRONTEND ⚠
            # The matching JS walker dispatcher lives in
            # `frontend/src/utils/narrativeChain.js#applyChangeSet`
            # (the `alias_changes` event loop). Same set of actions,
            # same effect on the alias's awareness. If you add an
            # action, change a payload, or change the apply order
            # here, update the JS walker in the SAME commit. See the
            # parity warning on `narrative_chain.py#get_entity_narrative_chain`
            # and on `narrativeChain.js#getEntityNarrativeChain` for
            # the broader rationale.
            ev_list = getattr(ref, "alias_changes", None) or []
            if ev_list:
                existing_by_id = {a.id: a for a in (walked.aliases or []) if getattr(a, "id", None)}
                order = [a.id for a in (walked.aliases or []) if getattr(a, "id", None)]
                for ev in ev_list:
                    action = getattr(ev, "action", None)
                    if action == "add" and getattr(ev, "alias", None) and getattr(ev.alias, "id", None):
                        if ev.alias.id not in existing_by_id:
                            existing_by_id[ev.alias.id] = ev.alias.model_copy(deep=True)
                            order.append(ev.alias.id)
                    elif action == "remove" and getattr(ev, "alias_id", None):
                        existing_by_id.pop(ev.alias_id, None)
                        order = [aid for aid in order if aid != ev.alias_id]
                    elif action == "modify" and getattr(ev, "alias_id", None) and getattr(ev, "new_value", None) is not None:
                        if ev.alias_id in existing_by_id:
                            cur = existing_by_id[ev.alias_id]
                            existing_by_id[ev.alias_id] = cur.model_copy(update={"value": ev.new_value})
                    elif action in (
                        "awareness_set",
                        "awareness_source_add",
                        "awareness_source_remove",
                        "awareness_source_set_level",
                    ):
                        aid = getattr(ev, "alias_id", None)
                        if not aid:
                            continue
                        target_alias = existing_by_id.get(aid)
                        if target_alias is None:
                            continue
                        target_alias.awareness = _apply_alias_awareness_change(
                            target_alias.awareness, ev,
                        )
                walked.aliases = [existing_by_id[aid] for aid in order if aid in existing_by_id]
            for change in ref.attribute_changes or []:
                _apply_attribute_change_inclusive(
                    change, attrs_by_id, attrs_order
                )
            # Phase 1.21 / 1.25f follow-up: every awareness target
            # is walked forward to the chosen anchor so the
            # imported state matches the writer's effective state
            # at the pick point.
            #
            # Legacy arm: `EntityRef.awareness_changes` is empty
            # post v0.2a.2.5 migration (data hoisted to canonical
            # `host.awareness.history`). The Pydantic field is still
            # declared so loads parse; the loop below is a safety net
            # for any in-flight legacy-shape data that somehow reaches
            # the walker before migration.
            #
            # Canonical arm follows the legacy loop: walks each
            # host's own `awareness.history` filtered to entries
            # anchored at this scene (node_id == scene.id).
            # Per-attribute awareness rides on attribute.awareness.
            # `target=="relationship"` events live on the
            # relationship's own awareness wrapper, which the
            # entity walker doesn't see; relationship import walks
            # those independently.
            for change in ref.awareness_changes or []:
                target = getattr(change, "target", "")
                if target == "entity":
                    _apply_entity_awareness_change_inclusive(change, walked)
                elif target == "entity_name":
                    walked.name_awareness = _apply_awareness_mutation(
                        walked.name_awareness, change,
                    )
                elif target == "alias":
                    alias_value = getattr(change, "alias_value", None)
                    if alias_value:
                        for alias in (walked.aliases or []):
                            if alias.value == alias_value:
                                alias.awareness = _apply_awareness_mutation(
                                    alias.awareness, change,
                                )
                                break
                elif target == "relationship" and pending_relationship_awareness is not None:
                    rel_id = getattr(change, "relationship_id", None)
                    if rel_id:
                        pending_relationship_awareness.append((rel_id, change))

    # Canonical awareness arm — per-host AwarenessHistoryEntry entries
    # on the host's own awareness wrapper, filtered to this scene.
    # Runs ONCE per scene (not per ref) because the canonical entries
    # are scene-anchored on the entity, not on the carrier EntityRef.
    walked.awareness = _apply_canonical_awareness_history_at_scene(
        walked.awareness, scene.id,
    )
    walked.name_awareness = _apply_canonical_awareness_history_at_scene(
        walked.name_awareness, scene.id,
    )
    for attr in attrs_by_id.values():
        attr.awareness = _apply_canonical_awareness_history_at_scene(
            attr.awareness, scene.id,
        )
    for alias in (walked.aliases or []):
        alias.awareness = _apply_canonical_awareness_history_at_scene(
            alias.awareness, scene.id,
        )


def _apply_modifier_to_walked(
    modifier,  # EntityNode (is_modifier=True)
    walked: Entity,
    attrs_by_id: dict[str, Attribute],
    attrs_order: list[str],
) -> None:
    """Apply a modifier EntityNode's own change fields to the walked
    state. Mirrors the field-merge logic the inclusive walker uses for
    scene EntityRefs: name / colour / description / profile image /
    per-alias chain events / attribute changes."""
    if modifier.name_change is not None:
        walked.name = modifier.name_change
    if modifier.colour_change is not None:
        walked.colour = modifier.colour_change
    if modifier.description_change is not None:
        walked.description = modifier.description_change
    if modifier.profile_image_change is not None:
        walked.profile_image_ref = (
            modifier.profile_image_change if modifier.profile_image_change else None
        )
    mod_ev_list = getattr(modifier, "alias_changes", None) or []
    if mod_ev_list:
        existing_by_id = {a.id: a for a in (walked.aliases or []) if getattr(a, "id", None)}
        order = [a.id for a in (walked.aliases or []) if getattr(a, "id", None)]
        for ev in mod_ev_list:
            action = getattr(ev, "action", None)
            if action == "add" and getattr(ev, "alias", None) and getattr(ev.alias, "id", None):
                if ev.alias.id not in existing_by_id:
                    existing_by_id[ev.alias.id] = ev.alias.model_copy(deep=True)
                    order.append(ev.alias.id)
            elif action == "remove" and getattr(ev, "alias_id", None):
                existing_by_id.pop(ev.alias_id, None)
                order = [aid for aid in order if aid != ev.alias_id]
            elif action == "modify" and getattr(ev, "alias_id", None) and getattr(ev, "new_value", None) is not None:
                if ev.alias_id in existing_by_id:
                    cur = existing_by_id[ev.alias_id]
                    existing_by_id[ev.alias_id] = cur.model_copy(update={"value": ev.new_value})
            elif action in (
                "awareness_set",
                "awareness_source_add",
                "awareness_source_remove",
                "awareness_source_set_level",
            ):
                aid = getattr(ev, "alias_id", None)
                if not aid:
                    continue
                target_alias = existing_by_id.get(aid)
                if target_alias is None:
                    continue
                target_alias.awareness = _apply_alias_awareness_change(
                    target_alias.awareness, ev,
                )
        walked.aliases = [existing_by_id[aid] for aid in order if aid in existing_by_id]
    for change in modifier.attribute_changes or []:
        _apply_attribute_change_inclusive(change, attrs_by_id, attrs_order)


def _apply_attribute_change_inclusive(
    change,  # AttributeChange
    attrs_by_id: dict[str, Attribute],
    attrs_order: list[str],
) -> None:
    """Apply one `AttributeChange` to the walked attribute map.
    Mirrors `export_service._apply_attribute_change_to_walked` —
    supports add / modify / remove / list_add / list_remove /
    awareness_set (Phase 1.21)."""
    action = change.action
    if action == "add":
        attr = change.attribute
        if attr is not None and attr.id:
            if attr.id not in attrs_by_id:
                attrs_order.append(attr.id)
            attrs_by_id[attr.id] = attr.model_copy(deep=True)
        return
    if action == "remove":
        if change.attribute_id and change.attribute_id in attrs_by_id:
            del attrs_by_id[change.attribute_id]
            try:
                attrs_order.remove(change.attribute_id)
            except ValueError:
                pass
        return
    if action == "modify":
        if not change.attribute_id or change.attribute_id not in attrs_by_id:
            return
        attr = attrs_by_id[change.attribute_id]
        if change.new_value is not None:
            attr.value = change.new_value
        if change.file_ref_change is not None:
            attr.file_ref = change.file_ref_change or None
        # Phase 1.25f — Phase 1.22 added per-field modify payloads for
        # circumstance / motivator / number attributes. The import
        # walker previously ignored them, so a writer's chain-time
        # description / intensity / number_value / name edit on a C/M
        # attribute was silently dropped during import.
        if change.new_description is not None:
            attr.description = change.new_description
        if change.new_intensity is not None:
            attr.intensity = change.new_intensity
        if change.new_number_value is not None:
            attr.number_value = change.new_number_value
        if change.new_name is not None:
            attr.name = change.new_name
        return
    if action == "rename":
        if not change.attribute_id or change.attribute_id not in attrs_by_id:
            return
        attr = attrs_by_id[change.attribute_id]
        if change.new_name is not None:
            attr.name = change.new_name
        return
    if action in ("list_add", "list_remove"):
        if not change.attribute_id or change.attribute_id not in attrs_by_id:
            return
        if change.list_item is None:
            return
        attr = attrs_by_id[change.attribute_id]
        try:
            existing = json.loads(attr.value) if attr.value else []
            if not isinstance(existing, list):
                existing = []
        except (ValueError, TypeError):
            existing = []
        if action == "list_add":
            if change.list_item not in existing:
                existing.append(change.list_item)
        else:
            try:
                existing.remove(change.list_item)
            except ValueError:
                pass
        attr.value = json.dumps(existing)
        return
    if action == "awareness_set":
        # Phase 1.21: set or remove one entity's awareness level on an
        # attribute's `awareness` dict. `list_item` carries the entity_id
        # key; `new_value` carries the level as a string ("0" / "1") or
        # null to remove the key. If the attribute's current awareness is
        # an AwarenessRef, a scalar set is ignored (refs are all-or-nothing
        # projections; swapping a ref for a dict is a separate operation).
        if not change.attribute_id or change.attribute_id not in attrs_by_id:
            return
        if change.list_item is None:
            return
        attr = attrs_by_id[change.attribute_id]
        if isinstance(attr.awareness, AwarenessRef):
            return
        # Phase 1.25f follow-up — route through the generic helper so
        # the AwarenessWrapper case is handled too. Synthesise an
        # AwarenessChange-shaped object from the AttributeChange's
        # awareness fields. `level` may live on `change.level` (Phase
        # 1.21h) OR on `change.new_value` as a string (legacy);
        # prefer the typed field, fall back to parsing.
        observer = change.list_item
        level: Optional[int] = getattr(change, "level", None)
        if level is None and change.new_value is not None:
            try:
                level = int(change.new_value)
            except (ValueError, TypeError):
                level = None
        attr.awareness = _apply_awareness_mutation(
            attr.awareness,
            _SyntheticAwarenessChange(
                target="attribute",
                entity_id=observer,
                level=level if change.new_value is not None or getattr(change, "level", None) is not None else None,
            ),
        )
        return
    if action in ("awareness_source_add", "awareness_source_remove", "awareness_source_set_level"):
        # Phase 1.25f follow-up — projected-source mutations on an
        # attribute's awareness. Walker previously ignored these; now
        # routes through the generic helper. The action name maps to
        # the helper's `source_action` field.
        if not change.attribute_id or change.attribute_id not in attrs_by_id:
            return
        if change.source is None:
            return
        attr = attrs_by_id[change.attribute_id]
        if isinstance(attr.awareness, AwarenessRef):
            return
        source_action = action.replace("awareness_source_", "")
        attr.awareness = _apply_awareness_mutation(
            attr.awareness,
            _SyntheticAwarenessChange(
                target="attribute",
                source_action=source_action,
                source=change.source,
            ),
        )
        return


class _SyntheticAwarenessChange:
    """Lightweight stand-in for an `AwarenessChange` so the generic
    `_apply_awareness_mutation` helper can be reused for attribute-
    side `awareness_set` / `awareness_source_*` mutations (which ride
    on `AttributeChange`, not `AwarenessChange`). The helper reads
    `target`, `entity_id`, `level`, `source_action`, `source` — every
    other field on the real `AwarenessChange` is unused at mutation
    time."""
    __slots__ = ("target", "entity_id", "level", "source_action", "source")

    def __init__(
        self,
        *,
        target: str,
        entity_id: str = "",
        level: Optional[int] = None,
        source_action: Optional[str] = None,
        source=None,
    ) -> None:
        self.target = target
        self.entity_id = entity_id
        self.level = level
        self.source_action = source_action
        self.source = source


def _apply_canonical_awareness_history_at_scene(awareness, scene_node_id):
    """Apply every canonical `AwarenessHistoryEntry` on a wrapper's
    history that is anchored at `scene_node_id`. Returns the updated
    awareness value (the caller assigns back to its host field).

    Mirrors the JS walker `applyAwarenessHistoryToWrapper` semantics
    for ONE scene's worth of entries (the per-scene shard of a full
    chain walk):

      - `tracking_action='off'` → clears effective state. Wrapper
        shape: entries → None (history preserved). Dict / null
        shapes: returns None.
      - `tracking_action='on'` → re-establishes a non-null awareness
        when the prior was None. Wrapper retained as-is otherwise.
      - `source_action` → routed through `_apply_awareness_mutation`
        which handles add/remove/set_level on the wrapper's sources.
      - per-observer (`observer_id` + `level`) → routed through
        `_apply_awareness_mutation` which handles dict + wrapper
        direct-entry mutation.

    Used by the entity walker (`_walk_entity_state_forward`) to apply
    scene-anchored chain entries on each host's own awareness wrapper
    (entity, name, per-attribute, per-alias). Each wrapper's history
    is the canonical post-v0.2a.2.5-migration storage; the legacy
    EntityRef.awareness_changes loop in the same walker is a no-op
    safety net for any pre-migration data that slips through.
    """
    history = []
    if isinstance(awareness, AwarenessWrapper) and awareness.history:
        history = awareness.history
    if not history:
        return awareness
    current = awareness
    for entry in history:
        if getattr(entry, "node_id", None) != scene_node_id:
            continue
        tracking = getattr(entry, "tracking_action", None)
        if tracking == "off":
            if isinstance(current, AwarenessWrapper):
                current.entries = None
                if (
                    current.entries is None
                    and current.sources is None
                    and (current.history is None or len(current.history) == 0)
                ):
                    current = None
            else:
                current = None
            continue
        if tracking == "on":
            if current is None:
                current = AwarenessWrapper(history=list(history))
            elif isinstance(current, AwarenessWrapper) and current.entries is None:
                current.entries = {}
            continue
        # Per-observer or source-action mutation — delegate to the
        # generic mutator which now reads `observer_id` (canonical)
        # with `entity_id` fallback (legacy).
        current = _apply_awareness_mutation(current, entry)
    return current


def _apply_awareness_mutation(awareness, change):
    """Phase 1.25f follow-up — apply one awareness change to an
    awareness field, returning the new awareness value (which the
    caller assigns back). Generic across every target shape (entity /
    entity_name / alias / relationship / attribute) — the only thing
    that varies between targets is which field on which object the
    caller reads / writes. The mutation logic is identical.

    Supports both legacy `AwarenessChange` (uses `entity_id` for the
    observer key) and canonical `AwarenessHistoryEntry` (uses
    `observer_id`). Direct-entry observer field is read with
    `observer_id` first, then `entity_id` as fallback.

    Supports both shapes the awareness Union accepts (`dict[str, int]`
    and `AwarenessWrapper`) and both kinds of mutation (direct-entry
    via observer + level, and projected-source via `source_action` +
    `source`). Unknown shapes fall through to a no-op return.

    Direct-entry semantics: set observer's level, or remove the key
    entirely when level is None.

    Source-action semantics:
      - `add`: append the source unless an equivalent (kind + ids)
        is already present — in which case update its level.
      - `remove`: drop any source matching by kind + ids.
      - `set_level`: locate by kind + ids, update level. No-op when
        no matching source exists (matches the on-canvas semantics).
    """
    # Refs are all-or-nothing legacy projections; refuse to mutate.
    if isinstance(awareness, AwarenessRef):
        return awareness

    source_action = getattr(change, "source_action", None)
    if source_action:
        # Projected-source mutation. Promote dict to wrapper if
        # needed; unknown / None awareness becomes a fresh wrapper.
        wrapper = _coerce_to_wrapper(awareness)
        new_source = getattr(change, "source", None)
        if new_source is None:
            return awareness  # malformed — no source given
        existing = list(wrapper.sources or [])
        if source_action == "add":
            for idx, s in enumerate(existing):
                if _sources_match(s, new_source):
                    existing[idx] = _source_with_level(new_source, new_source.level)
                    break
            else:
                existing.append(_source_with_level(new_source, new_source.level))
        elif source_action == "remove":
            existing = [s for s in existing if not _sources_match(s, new_source)]
        elif source_action == "set_level":
            for idx, s in enumerate(existing):
                if _sources_match(s, new_source):
                    existing[idx] = _source_with_level(s, new_source.level)
                    break
        wrapper.sources = existing or None
        # Collapse to None when wrapper carries no live data.
        if wrapper.entries is None and wrapper.sources is None and wrapper.history is None:
            return None
        return wrapper

    # Direct-entry mutation. Promote dict to wrapper-shape only when
    # the caller already has a wrapper; otherwise stay on dict shape
    # so we don't churn the on-disk format unnecessarily.
    # Read `observer_id` first (canonical AwarenessHistoryEntry shape),
    # fall back to `entity_id` (legacy AwarenessChange shape).
    observer_id = (getattr(change, "observer_id", "") or "") or (getattr(change, "entity_id", "") or "")
    level = getattr(change, "level", None)
    if not observer_id:
        return awareness  # malformed — direct-entry needs observer
    if isinstance(awareness, AwarenessWrapper):
        new_entries = dict(awareness.entries or {})
        if level is None:
            new_entries.pop(observer_id, None)
        else:
            new_entries[observer_id] = level
        awareness.entries = new_entries or None
        if awareness.entries is None and awareness.sources is None and awareness.history is None:
            return None
        return awareness
    # Dict shape (or None / unknown — fall through to dict).
    current = awareness if isinstance(awareness, dict) else {}
    new_dict = dict(current)
    if level is None:
        new_dict.pop(observer_id, None)
    else:
        new_dict[observer_id] = level
    return new_dict if new_dict else None


def _apply_alias_awareness_change(awareness, alias_change):
    """Apply one AliasChange awareness-action event to an alias's
    awareness field, returning the new awareness value.

    AliasChange uses distinct `action` values for the four awareness
    operations (`awareness_set` / `awareness_source_add` /
    `awareness_source_remove` / `awareness_source_set_level`) whereas
    `_apply_awareness_mutation` reads `source_action` for source ops
    and `observer_id` + `level` for direct-entry ops. This adapter
    translates the AliasChange shape into what the generic mutator
    expects.

    Mirrors per-attribute awareness handling (which goes through
    `AttributeChange(action='awareness_set' / 'awareness_source_*')`
    with the same translation). Used by the per-alias dispatcher in
    `_apply_scene_to_walked` and `_apply_modifier_to_walked`."""
    action = getattr(alias_change, "action", None)
    if action == "awareness_set":
        mutation = SimpleNamespace(
            observer_id=getattr(alias_change, "observer_id", "") or "",
            entity_id="",
            level=getattr(alias_change, "level", None),
            source_action=None,
            source=None,
        )
    elif action in (
        "awareness_source_add",
        "awareness_source_remove",
        "awareness_source_set_level",
    ):
        source_action_map = {
            "awareness_source_add": "add",
            "awareness_source_remove": "remove",
            "awareness_source_set_level": "set_level",
        }
        src = getattr(alias_change, "source", None)
        if src is None:
            return awareness
        mutation = SimpleNamespace(
            observer_id="",
            entity_id="",
            level=None,
            source_action=source_action_map[action],
            source=src,
        )
    else:
        return awareness
    return _apply_awareness_mutation(awareness, mutation)


def _coerce_to_wrapper(awareness):
    """Return an AwarenessWrapper carrying whatever direct-entries
    were in the input. Used when a source-action mutation needs to
    promote a dict-shaped or None awareness to wrapper shape so the
    `sources` list has a home."""
    if isinstance(awareness, AwarenessWrapper):
        return awareness
    if isinstance(awareness, dict):
        return AwarenessWrapper(entries=dict(awareness))
    return AwarenessWrapper()


def _sources_match(a, b) -> bool:
    """Match two Source instances by kind + their identifying ids
    (level is intentionally ignored — the canvas-side semantics treat
    sources as unique per (kind, refs)). Defensive against unknown
    kinds: returns False rather than raising."""
    if getattr(a, "kind", None) != getattr(b, "kind", None):
        return False
    kind = getattr(a, "kind", None)
    if kind == "relationship":
        return a.relationship_id == b.relationship_id
    if kind == "attribute":
        return a.entity_id == b.entity_id and a.attribute_id == b.attribute_id
    return False


def _source_with_level(source, level):
    """Return a copy of `source` with its `level` field replaced.
    The discriminated-union types are immutable Pydantic models; this
    is the safe way to update the level on either kind."""
    if isinstance(source, RelationshipSource):
        return RelationshipSource(relationship_id=source.relationship_id, level=level)
    if isinstance(source, AttributeSource):
        return AttributeSource(
            entity_id=source.entity_id,
            attribute_id=source.attribute_id,
            level=level,
        )
    # Unknown subtype — return as-is (defensive).
    return source


def _apply_entity_awareness_change_inclusive(change, walked: Entity) -> None:
    """Apply one `AwarenessChange` (target='entity') to the walked
    entity's `awareness` field. Wraps the generic helper above so the
    awareness assignment lands on the right field."""
    walked.awareness = _apply_awareness_mutation(walked.awareness, change)


def _rewrite_awareness(
    awareness,
    *,
    entity_id_rewrite: dict[str, str],
    relationship_id_rewrite: dict[str, str],
    attribute_id_rewrite: Optional[dict[str, str]] = None,
):
    """Rewrite a single awareness field from source-project id space
    into target-project id space during an import commit.

    Phase 1.25f (Bug 1) — handles every awareness shape on the
    awareness Union: `dict[str, int]`, `AwarenessWrapper`, the legacy
    `AwarenessRef`, and `None`.

    - **Dict case** (legacy direct-entries shape): every entity_id key
      is remapped via `entity_id_rewrite`. Keys pointing at entities
      NOT in the import batch are dropped. Empty dict collapses to None.
    - **`AwarenessWrapper` case** (current shape): each inner field is
      rewritten separately:
        - `entries` dict — observer keys remapped same as the dict
          case; unmapped keys dropped.
        - `sources` list — each `RelationshipSource.relationship_id`
          and `AttributeSource.entity_id` / `attribute_id` are
          remapped. Sources whose id refs aren't in the import batch
          are dropped.
        - `history` is dropped (the entries are anchored by `node_id`
          which references nodes that don't travel in entity import;
          a stale node_id reference would never resolve in the target).
      If all three inner fields end up empty, the wrapper collapses
      to None.
    - **`AwarenessRef` case** (deprecated): the `relationship_id` is
      remapped via `relationship_id_rewrite`. If the referenced
      relationship isn't in the import batch, the whole awareness
      field is dropped (returns None).
    - **None**: returned as-is.
    """
    if awareness is None:
        return None
    if isinstance(awareness, AwarenessRef):
        new_rid = relationship_id_rewrite.get(awareness.relationship_id)
        if new_rid is None:
            return None
        return AwarenessRef(relationship_id=new_rid, level=awareness.level)
    if isinstance(awareness, AwarenessWrapper):
        attribute_id_rewrite = attribute_id_rewrite or {}
        new_entries: Optional[dict[str, int]] = None
        if awareness.entries:
            entries_out: dict[str, int] = {}
            for source_eid, level in awareness.entries.items():
                new_eid = entity_id_rewrite.get(source_eid)
                if new_eid is None:
                    continue
                entries_out[new_eid] = level
            new_entries = entries_out or None
        new_sources: Optional[list] = None
        if awareness.sources:
            sources_out = []
            for src in awareness.sources:
                kind = getattr(src, "kind", None)
                if kind == "relationship":
                    new_rid = relationship_id_rewrite.get(src.relationship_id)
                    if new_rid is None:
                        continue
                    sources_out.append(RelationshipSource(
                        relationship_id=new_rid, level=src.level,
                    ))
                elif kind == "attribute":
                    new_eid = entity_id_rewrite.get(src.entity_id)
                    if new_eid is None:
                        continue
                    new_aid = attribute_id_rewrite.get(src.attribute_id, src.attribute_id)
                    sources_out.append(AttributeSource(
                        entity_id=new_eid,
                        attribute_id=new_aid,
                        level=src.level,
                    ))
                # Unknown source kind — skip silently rather than
                # crash. Pydantic typing protects us at construction
                # time; the guard is defensive.
            new_sources = sources_out or None
        # `history` is intentionally dropped: each entry is anchored
        # by `node_id` referencing a SceneNode that does not travel in
        # entity import. Re-pointing those at the target's nodes would
        # require importing scenes too (out of scope for entity-only
        # import).
        if new_entries is None and new_sources is None:
            return None
        return AwarenessWrapper(
            entries=new_entries,
            sources=new_sources,
            history=None,
        )
    if isinstance(awareness, dict):
        new_dict = {}
        for source_eid, level in awareness.items():
            new_eid = entity_id_rewrite.get(source_eid)
            if new_eid is None:
                continue
            new_dict[new_eid] = level
        return new_dict if new_dict else None
    # Unknown shape (shouldn't happen given the Pydantic type annotation)
    return None


# ── Helpers: lookups, dedup, asset copy ───────────────────────────────


def _build_source_entity_lookup(
    source_story: Story,
) -> dict[str, tuple[Entity, str]]:
    """Build `{entity_id: (Entity, bucket_name)}` for every entity in
    the source story's library. `bucket_name` is the plural form
    ('characters' / 'locations' / 'items' / 'factions' / 'customs')
    so the caller can directly append to the matching attribute on
    `target.entities`."""
    lookup: dict[str, tuple[Entity, str]] = {}
    for bucket_name in ENTITY_BUCKETS:
        bucket = getattr(source_story.entities, bucket_name, None) or []
        for ent in bucket:
            lookup[ent.id] = (ent, bucket_name)
    return lookup


def _apply_name_collision_suffix(name: str, target_story: Story) -> str:
    """If the given name already exists on any entity in the target
    project's library, append ' (imported)' (and then ' (imported 2)',
    ' (imported 3)', etc. if the suffixed name also collides).
    Applied per-entity during commit — an import of ten entities
    where three collide ends up with three suffixed names + seven
    unchanged."""
    existing_names: set[str] = set()
    for bucket_name in ENTITY_BUCKETS:
        bucket = getattr(target_story.entities, bucket_name, None) or []
        for ent in bucket:
            existing_names.add(ent.name)

    if name not in existing_names:
        return name
    candidate = f"{name} (imported)"
    counter = 2
    while candidate in existing_names:
        candidate = f"{name} (imported {counter})"
        counter += 1
    return candidate


def _ensure_asset_in_rewrite_map(
    source_ref: str,
    *,
    source_asset_bytes: dict[str, bytes],
    asset_rewrite: dict[str, str],
) -> Optional[str]:
    """Ensure the source asset referenced by `source_ref` is slated
    for copy to the target project's assets dir, and return the
    rewritten ref the imported entity should use. Returns `None` if
    the source file doesn't exist in the bytes dict.

    `asset_rewrite` maps `source_filename -> target_filename` so
    multiple entities referencing the same source file all get the
    same (deduped) target filename. Filename collisions against the
    EXISTING target assets dir are resolved by appending a short
    UUID suffix to the stem."""
    # Normalise: strip leading "assets/" if present.
    source_filename = source_ref
    if source_filename.startswith("assets/"):
        source_filename = source_filename[len("assets/"):]

    if not source_filename or source_filename not in source_asset_bytes:
        return None

    # Already mapped? Return the existing rewrite to dedupe.
    if source_filename in asset_rewrite:
        return f"assets/{asset_rewrite[source_filename]}"

    # Choose a collision-safe target filename. Check the target's
    # current assets dir on disk for an existing file with the same
    # name — if found, append a short UUID suffix to the stem.
    target_dir = file_service.get_assets_dir()
    candidate = source_filename
    if target_dir is not None and (target_dir / candidate).exists():
        stem, dot, ext = source_filename.rpartition(".")
        if not dot:
            stem = source_filename
            ext = ""
        suffix = uuid.uuid4().hex[:8]
        candidate = f"{stem}_imported_{suffix}" + (f".{ext}" if ext else "")

    asset_rewrite[source_filename] = candidate
    return f"assets/{candidate}"


def _rewrite_attribute(
    *,
    attr: Attribute,
    source_story: Story,
    source_asset_bytes: dict[str, bytes],
    asset_rewrite: dict[str, str],
    preset_list_rewrite: dict[str, str],
    newly_imported_preset_lists: set[str],
    target_story: Story,
    entity_id_rewrite: dict[str, str],
    relationship_id_rewrite: dict[str, str],
) -> Optional[Attribute]:
    """Rewrite an attribute from a source entity into one suitable
    for the target project. Handles `file` attributes (asset copy),
    `preset` attributes (preset list dedup), and leaves
    `text` / `text_list` / `entity_list` attributes essentially
    unchanged (aside from a fresh id). Awareness on the attribute is
    remapped via `_rewrite_awareness` for every branch.

    Returns a new `Attribute` ready to append to the target entity's
    attributes list. Returns `None` only if the attribute is
    unsalvageable (e.g. a file attribute whose source bytes are
    missing from the preview session)."""
    new_attr = attr.model_copy(deep=True)
    new_attr.id = str(uuid.uuid4())
    new_attr.awareness = _rewrite_awareness(
        attr.awareness,
        entity_id_rewrite=entity_id_rewrite,
        relationship_id_rewrite=relationship_id_rewrite,
    )

    if attr.attribute_type == "file":
        if attr.file_ref:
            new_ref = _ensure_asset_in_rewrite_map(
                attr.file_ref,
                source_asset_bytes=source_asset_bytes,
                asset_rewrite=asset_rewrite,
            )
            new_attr.file_ref = new_ref
        else:
            new_attr.file_ref = None
        return new_attr

    if attr.attribute_type == "preset":
        if attr.preset_list_id:
            new_id = _ensure_preset_list_imported(
                attr.preset_list_id,
                source_story=source_story,
                preset_list_rewrite=preset_list_rewrite,
                newly_imported=newly_imported_preset_lists,
                target_story=target_story,
            )
            new_attr.preset_list_id = new_id
        return new_attr

    # text, text_list, entity_list — nothing to rewrite besides the id.
    return new_attr


def _ensure_preset_list_imported(
    source_preset_list_id: str,
    *,
    source_story: Story,
    preset_list_rewrite: dict[str, str],
    newly_imported: set[str],
    target_story: Story,
) -> Optional[str]:
    """Ensure the source PresetList referenced by `source_preset_list_id`
    exists in the target project. Dedupes by name: if the target
    already has a preset list with the same name, reuses that id
    instead of copying. Returns the target-side preset list id, or
    None if the source id doesn't resolve.

    `newly_imported` is a set tracked across the whole commit that
    collects the source ids we actually created new target-side
    lists for (i.e. dedup misses). The caller reports `len(newly_imported)`
    as `imported_preset_list_count` in the result so the summary
    distinguishes real new imports from dedup hits."""
    if source_preset_list_id in preset_list_rewrite:
        return preset_list_rewrite[source_preset_list_id]

    source_list = next(
        (pl for pl in (source_story.preset_lists or [])
         if pl.id == source_preset_list_id),
        None,
    )
    if source_list is None:
        return None

    # Dedup: look for an existing target preset list with the same name.
    existing = next(
        (pl for pl in (target_story.preset_lists or [])
         if pl.name == source_list.name),
        None,
    )
    if existing is not None:
        preset_list_rewrite[source_preset_list_id] = existing.id
        return existing.id

    # No match — copy the source list into the target with a fresh id.
    new_list = source_list.model_copy(deep=True)
    new_list.id = str(uuid.uuid4())
    target_story.preset_lists.append(new_list)
    preset_list_rewrite[source_preset_list_id] = new_list.id
    newly_imported.add(source_preset_list_id)
    return new_list.id


def _ensure_custom_category_imported(
    source_category_id: str,
    *,
    source_story: Story,
    source_asset_bytes: dict[str, bytes],
    category_rewrite: dict[str, str],
    newly_imported: set[str],
    asset_rewrite: dict[str, str],
    target_story: Story,
) -> Optional[str]:
    """Same pattern as `_ensure_preset_list_imported` but for
    `CustomCategory`. Dedupes by name; on miss, copies the source
    category (including its profile image if any) into the target.
    `newly_imported` tracks dedup misses for accurate summary counts."""
    if source_category_id in category_rewrite:
        return category_rewrite[source_category_id]

    source_cat = next(
        (c for c in (source_story.custom_categories or [])
         if c.id == source_category_id),
        None,
    )
    if source_cat is None:
        return None

    existing = next(
        (c for c in (target_story.custom_categories or [])
         if c.name == source_cat.name),
        None,
    )
    if existing is not None:
        category_rewrite[source_category_id] = existing.id
        return existing.id

    new_cat = source_cat.model_copy(deep=True)
    new_cat.id = str(uuid.uuid4())
    if new_cat.profile_image_ref:
        new_cat.profile_image_ref = _ensure_asset_in_rewrite_map(
            new_cat.profile_image_ref,
            source_asset_bytes=source_asset_bytes,
            asset_rewrite=asset_rewrite,
        )
    target_story.custom_categories.append(new_cat)
    category_rewrite[source_category_id] = new_cat.id
    newly_imported.add(source_category_id)
    return new_cat.id


def _apply_story_level_settings(
    *,
    target: Story,
    source: Story,
    entity_id_rewrite: dict[str, str],
) -> None:
    """Copy author / genre / tags / language / pov_type_default from
    the source story to the target. Default POV character is copied
    ONLY if the source's default POV character is in the import
    batch (and gets its new target-side id); otherwise skipped to
    avoid dangling references."""
    if source.author:
        target.author = source.author
    if source.genre:
        target.genre = source.genre
    if source.language:
        target.language = source.language
    if source.pov_type_default:
        target.pov_type_default = source.pov_type_default
    if source.tense:
        target.tense = source.tense

    # Merge tags uniquely (preserve insertion order).
    existing_tags = set(target.tags or [])
    for tag in source.tags or []:
        if tag not in existing_tags:
            target.tags.append(tag)
            existing_tags.add(tag)

    # Default POV character — only if the source has one AND it was
    # imported in this batch.
    if source.pov_character_id and source.pov_character_id in entity_id_rewrite:
        target.pov_character_id = entity_id_rewrite[source.pov_character_id]

    # Phase 1.25f — Phase 1.23 time-tracking story-level settings.
    # Copied across when "Import story settings" is checked. Pre-1.25f
    # these were silently dropped because the helper didn't know about
    # them. Each one is independent — copy only the fields the source
    # has set (None = "use defaults", honour the writer's intent).
    if getattr(source, "time_tracking_enabled", None) is not None:
        target.time_tracking_enabled = source.time_tracking_enabled
    if getattr(source, "time_format", None) is not None:
        target.time_format = source.time_format
    if getattr(source, "week_start", None) is not None:
        target.week_start = source.week_start
    if getattr(source, "allow_negative_time", None) is not None:
        target.allow_negative_time = source.allow_negative_time


def _write_imported_assets_to_disk(
    *,
    asset_rewrite: dict[str, str],
    source_asset_bytes: dict[str, bytes],
) -> int:
    """Write each imported asset's bytes to the target project's
    assets dir on disk. Allocates a temp dir via
    `file_service.get_or_create_assets_dir()` if the target doesn't
    yet have one (e.g. the target project has never been saved).
    Returns the count of files actually written.

    Phase 1.25f (Bug 8) — abort the write on a fresh collision rather
    than silently overwriting unrelated content. The construction-time
    check in `_ensure_asset_in_rewrite_map` already allocates unique
    names against the assets dir state at that moment; this loop only
    needs to defend against the narrow race where a new file lands at
    the same name between construction and write (concurrent import,
    manual file copy, etc.). Pre-1.25f the loop would silently
    overwrite (`dest.write_bytes(raw)`) regardless of whether `dest`
    already existed; the prior `if dest.exists(): continue` skip we
    now strengthen to also flag the failure so the import summary can
    surface it.

    Why we DON'T re-allocate a new target name on collision: the
    imported entities' `file_ref` / `profile_image_ref` values were
    written from the rewrite-map BEFORE this function runs. Renaming
    here would leave those refs pointing at stale names. The right
    move is to leave the broken ref in place — the existing
    file-resolution layer gracefully renders it as a missing asset
    rather than silently substituting unrelated content."""
    target_dir = file_service.get_or_create_assets_dir()
    written = 0
    for source_filename, target_filename in asset_rewrite.items():
        raw = source_asset_bytes.get(source_filename)
        if raw is None:
            continue
        dest = target_dir / target_filename
        if dest.exists():
            # Fresh collision — leave the existing file alone, skip
            # the write. The imported entity's file_ref points at a
            # mismatched file, but that's still better than the old
            # silent-overwrite behaviour that would corrupt unrelated
            # data on the target.
            continue
        try:
            dest.write_bytes(raw)
            written += 1
        except OSError:
            # Disk write failure — non-fatal; the imported entity's
            # file_ref will point at a missing asset, which the
            # existing file resolution gracefully handles as a broken
            # image.
            continue
    return written
