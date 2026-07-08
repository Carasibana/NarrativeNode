"""
Export service — Phase 1.12a Track 1.

Walks a `Story` into an `ExportModel`, a pure-data intermediate that the
HTML / Markdown / PDF renderers consume without touching the raw story
model. The model carries no formatting — every renderer reads the same
structure and chooses its own output format.

Shape:

    ExportModel
    ├── title, author, generated_at
    ├── sections[]                # acts and chapters in story order + an
    │   │                           "Unchaptered" synthetic section when
    │   │                           POV-chain scenes sit outside all chapters
    │   ├── kind                   # "act" | "chapter" | "unchaptered"
    │   ├── title, number, colour  # user-visible labels + the auto-numbered
    │   │                           position; both displayed together by the
    │   │                           renderer (matches the TOC panel behaviour)
    │   ├── scenes[]               # POV-chain scenes in this section only
    │   │   ├── title, description
    │   │   ├── main_content_html
    │   │   ├── transition_in_text
    │   │   ├── entity_context_line
    │   │   └── chain_index
    │   └── children[]             # chapters nested under an act
    │                              # (empty for chapter or unchaptered sections)
    ├── offscreen_scenes[]         # scene nodes NOT on the POV chain, in
    │                                canvas-x order; only populated when the
    │                                `include_offscreen_appendix` option is on
    └── entity_sheets[]            # origin-state reference cards for every
                                     entity in the library; only populated
                                     when `include_entity_sheets` is on

The POV chain drives the main narrative order. Non-POV scenes are only
surfaced in the optional appendix, not interwoven. See the Phase 1.12a
planning doc for the full design rationale.
"""

from __future__ import annotations

import base64
import json
import mimetypes
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from models import ENTITY_BUCKETS
from models.entity import Attribute, AwarenessWrapper, Entity
from models.node import EntityRef, SceneNode
from models.story import Act, Chapter, Story
from services import file_service
from services.chapter_membership import get_chapter_id_for_node
from services.narrative_chain import get_entity_narrative_chain
from services.pov_service import compute_pov_sequence


# ── Data model ─────────────────────────────────────────────────────────


@dataclass
class ExportAttribute:
    name: str
    attribute_type: str
    value: str                                  # text / preset / JSON-encoded list
    file_ref_data_uri: Optional[str] = None     # file attributes only
    # For file attributes: which kind of media the file is, so the
    # renderer can branch <img> / <audio> / <video> / skip based on
    # the granular media toggles. None for non-file attributes.
    media_kind: Optional[Literal["image", "audio", "video", "other"]] = None
    # Phase 5.8b — perspective attributes (attribute_type == "perspective")
    # are a special case, like circumstances / motivators: the body text
    # lives in `description` and the first-person view points at another
    # object. `perspective_target` is that object resolved to a display
    # name (entity name, knowledge name, or relationship label); None when
    # the target could not be resolved. Empty / None for every other type.
    description: str = ""
    perspective_target: Optional[str] = None


@dataclass
@dataclass
class ExportRelationshipParticipant:
    """One participant in a relationship as seen on an entity's reference sheet."""
    entity_id: str
    entity_name: str
    entity_type: str               # character | location | item | ...
    entity_colour: Optional[str]
    profile_image_data_uri: Optional[str]
    perception: str                # this participant's own perception text (may be empty)


@dataclass
class ExportEntityRelationship:
    """One relationship on an entity's reference sheet, in the N-party model.

    `display_label` is the resolved human-readable label (user-set name,
    membership label, or participant synthesis). `own_perception` is the
    sheet-owner entity's perception text for this relationship. `other_participants`
    is every participant except the sheet owner."""
    display_label: str
    own_perception: str                         # sheet owner's perception (may be empty)
    other_participants: list[ExportRelationshipParticipant] = field(default_factory=list)
    has_hierarchy: bool = False
    is_membership: bool = False
    # Phase 1.25c — `Relationship.description` baseline (may be
    # overridden by chain `description_changes`). Empty string when the
    # relationship has no description set at origin.
    description: str = ""
    # Phase 1.25c — sheet owner's role at origin (e.g. "parent", "boss",
    # custom strings). Empty when no role recorded.
    own_role: str = ""


@dataclass
class ExportEntitySheet:
    id: str
    name: str
    type: str                                   # character | location | item | faction | custom
    colour: Optional[str]
    description: str
    profile_image_data_uri: Optional[str]
    aliases: list[str] = field(default_factory=list)
    attributes: list[ExportAttribute] = field(default_factory=list)
    relationships: list[ExportEntityRelationship] = field(default_factory=list)
    # Phase 1.25c — author's private notes from `Entity.notes`. Free-
    # form text; not chain-tracked. Empty string when the entity has
    # no notes set. Renderers gate emission on
    # `ExportOptions.include_entity_notes` AND non-empty content.
    notes: str = ""


@dataclass
class ExportKnowledgeChainEntry:
    """Phase 1.25c — one row in a Knowledge sheet's chain history when
    `include_knowledge_chain_history` is on. Represents a single
    mutation drawn from `KnowledgeHistory` and rendered in scene order.

    `kind` matches the change type (one of "existence", "awareness",
    "name", "description", "colour", "profile_image", "source_event").
    `text` is the pre-formatted human-readable summary; renderers
    that emit text (markdown / txt) use it directly. `scene_title` /
    `scene_id` identify the scene the change is anchored to (the
    `node_id` on each KnowledgeHistory entry resolves to a SceneNode
    id today)."""
    kind: Literal[
        "existence", "awareness", "name", "description",
        "colour", "profile_image", "source_event",
    ]
    text: str
    scene_id: Optional[str] = None
    scene_title: Optional[str] = None
    chain_index: int = 0  # 1-based POV-chain position; 0 if scene is off-pov / unknown


@dataclass
class ExportKnowledgeSheet:
    """Phase 1.25c — one Knowledge entry in the post-entity-sheets
    Knowledge appendix. Origin baseline values plus optional chain
    history. Lightweight schema mirrors `Knowledge` itself: identity
    (name / description / colour / profile image) plus the
    source-event back-pointer when set, plus author notes."""
    id: str
    name: str
    description: str
    colour: Optional[str]
    profile_image_data_uri: Optional[str]
    notes: str = ""
    # Source-event back-pointer resolved to a scene title for display.
    # None when the Knowledge has no source_event recorded.
    source_event_scene_id: Optional[str] = None
    source_event_scene_title: Optional[str] = None
    # Chain history rows in scene order. Populated when
    # `include_knowledge_chain_history` is on; empty otherwise.
    chain_history: list[ExportKnowledgeChainEntry] = field(default_factory=list)


@dataclass
class ExportChangeDetail:
    """One specific change recorded on an EntityRef — not a count, the
    actual field/value/item. `category` is used by the renderer to
    filter against the granular-changes toggles (metadata /
    attribute / relationship).

    `text` is the pre-formatted human-readable summary (e.g.
    `'Age → "35"'`). It's the fallback for renderers that emit text
    only (markdown / txt / NovelCrafter variants).

    Phase 1.25c — structured fields below let image-capable
    renderers (HTML / DOCX / PDF) produce subchip-shaped output
    matching the frontend's `<ChangeSubChip>` component:

        [✚ ADDED]  Age : 35
        [⚊ REMOVED] Hat
        [✱ MODIFIED] Mood : "calm" → "anxious"

    Renderers that don't read the structured fields fall back to
    `text` and produce the prior plain output.
    """
    category: Literal["metadata", "attribute", "relationship"]
    text: str                                   # human-readable, e.g. 'Age → "35"'
    # Phase 1.25c — when the change is a profile-image replacement
    # (text "Profile image replaced") the new image is base64-resolved
    # here so renderers that can carry images (HTML, DOCX, PDF) can
    # display the actual new image inline rather than only the
    # placeholder string. None for every other detail kind, and for
    # profile-image clears (where there is no new image to show).
    new_image_data_uri: Optional[str] = None
    # Phase 1.25c — structured subchip data. `action` matches the
    # frontend's ChangeSubChip action discriminator (drives the
    # ✚ / ⚊ / ✱ glyph + colour). `field_name` is the human-readable
    # field the change applies to ("Name", "Description",
    # "Profile image", an attribute's name, "Aliases", etc.).
    # `old_value` / `new_value` are the value transition for
    # `modify`; `new_value` alone for `add`; both None for
    # `remove`. None on any of these signals "use the pre-formatted
    # `text` instead" — renderers that aren't subchip-aware will
    # already be doing that.
    action: Optional[Literal["add", "modify", "remove"]] = None
    field_name: Optional[str] = None
    old_value: Optional[str] = None
    new_value: Optional[str] = None


@dataclass
class ExportSceneEntityChange:
    """Per-entity group of change details recorded at this scene. One
    entry per entity that had ANY modifications on its EntityRef. The
    `details` list carries the actual specifics (renamed to X, Age →
    35, added relationship with Marlowe) rather than counts."""
    entity_id: str                              # source entity id — for anchor linking
    entity_name: str                            # effective name at this scene
    entity_type: str                            # character | location | item | faction | custom
    profile_image_data_uri: Optional[str] = None  # for hover popover
    # Effective colour of the entity at this scene (walks entity chain
    # forward applying any colour_change overrides). Consumed by
    # renderers declaring the `entity_colours` capability when
    # `ExportOptions.use_entity_colours` is on. None when the entity
    # has no colour set (or the walker couldn't resolve it).
    colour: Optional[str] = None
    details: list[ExportChangeDetail] = field(default_factory=list)


@dataclass
class ExportSceneEntityEntry:
    """One entity's presence at a scene. Stores enough for the
    renderer to produce a link to the entity reference sheet AND a
    hover popover showing the entity's profile image."""
    id: str
    name: str                                   # effective name at this scene
    profile_image_data_uri: Optional[str] = None
    # Effective colour of the entity at this scene. Same semantics
    # as ExportSceneEntityChange.colour.
    colour: Optional[str] = None


@dataclass
class ExportSceneEntityGroup:
    """All entities of one bucket (character / location / item /
    faction / custom) present at a scene. `label` is pre-formatted
    with singular/plural handling so the renderer doesn't need to
    care ("Character" vs "Characters")."""
    bucket: Literal["character", "location", "item", "faction", "custom"]
    label: str                                  # "Characters" / "Location" / etc.
    entries: list[ExportSceneEntityEntry] = field(default_factory=list)


@dataclass
class ExportSceneCMRow:
    """Phase 1.22i — one row in a scene's Circumstances & Motivators
    block. The same row dataclass covers all four origins: scene-level
    circumstance, per-entity ongoing circumstance / motivator (chain-
    walked to this scene), and per-entity temporary circumstance /
    motivator (scene-side). Renderers format the row uniformly:

        <prefix>: <name | description preview> [<intensity_label>]
            <description on a follow-up line, when present and distinct from name>

    `prefix` is one of:
      - "Scene Circumstance"     — from `SceneNode.circumstances`
      - "Circumstance"           — chain-walked entity attribute
      - "Motivator"              — chain-walked entity attribute
      - "Temporary Circumstance" — scene-side per-entity temporary
      - "Temporary Motivator"    — scene-side per-entity temporary
    """
    prefix: str
    name: str                                   # may be empty
    description: str                            # may be empty
    intensity_label: Optional[str] = None       # e.g. "Strong (4/5)" or None when unset
    # Phase 1.25c — numeric intensity tier (0..4) alongside the
    # already-formatted label. Renderers that show the intensity
    # badge icon need the numeric level to pick the right SVG;
    # renderers that emit text only continue to use `intensity_label`.
    # None when the underlying record's intensity is unset.
    intensity: Optional[int] = None


@dataclass
class ExportSceneCMGroup:
    """Phase 1.22i — one group of CM rows in the scene's CM block.
    `kind="scene"` is the scene-level group (label = "Scene"); other
    groups are per-entity (label = entity display name + type)."""
    kind: Literal["scene", "entity"]
    entity_id: Optional[str]                    # None when kind == "scene"
    label: str
    entity_type: Optional[str] = None           # character / location / ... ; None for scene group
    rows: list[ExportSceneCMRow] = field(default_factory=list)


@dataclass
class ExportScene:
    id: str                                     # source node id, preserved for anchors
    title: str
    description: str
    main_content_html: str
    transition_in_text: str                     # text on the POV edge leading INTO this scene
    entity_context_groups: list[ExportSceneEntityGroup] = field(default_factory=list)
    chain_index: int = 0                        # 1-based POV-chain position; 0 for off-screen
    pov_entity_name: Optional[str] = None       # the character carrying POV in this scene, resolved from pov_entity_id
    # Phase 1.25b — is this scene on the POV path? Distinct from
    # `chain_index`: in Full mode the main narrative carries every
    # scene (POV + off-screen) so they all get chain_index >= 1, but
    # only the POV-path subset has `is_on_pov_path=True`. Renderers
    # that produce a "writer's working copy" can use this to mark
    # off-screen content visually (sidebar, prefix, italic header,
    # etc.). Default True so legacy callers (`pov_sequence` derived
    # from `compute_pov_sequence`, where every entry IS on the POV
    # path) preserve current behaviour.
    is_on_pov_path: bool = True
    changes: list[ExportSceneEntityChange] = field(default_factory=list)
    # Phase 1.25c — scene-time summary (date / weekday / time-of-day /
    # season / duration / gap). Pre-computed by the frontend
    # (`scenetimeVerbiage.js`) and shipped via
    # `ExportOptionsRequest.pre_computed_scene_times`; the walker
    # passes the entry verbatim into these fields. Empty string when
    # the scene has no time data, the toggle is off, or no precomputed
    # entry was shipped. The two SVG fields are inline `<svg>...</svg>`
    # markup ready to drop into HTML / rasterise to PNG via svglib for
    # PDF / DOCX. Empty string when the scene has no
    # season / time-of-day set or the icon is suppressed.
    scene_time_text: str = ""
    scene_time_season_svg: str = ""
    scene_time_tod_svg: str = ""
    # Phase 1.22i — Circumstances & Motivators block. One scene-level
    # group + one per-entity group per entity carrying any C/M at this
    # scene (ongoing chain-walked or temporary). Empty list when the
    # scene has no C/M data.
    cm_groups: list[ExportSceneCMGroup] = field(default_factory=list)


@dataclass
class ExportSection:
    kind: Literal["act", "chapter", "unchaptered"]
    id: Optional[str]                           # source act/chapter id; None for "unchaptered"
    title: Optional[str]                        # custom title, may be empty
    number: Optional[int]                       # 1-based index in story.acts / story.chapters
    colour: Optional[str]
    label: str                                  # auto-generated "Chapter 3: Foo" or "Act 1"
    scenes: list[ExportScene] = field(default_factory=list)
    children: list["ExportSection"] = field(default_factory=list)  # acts can nest chapters


@dataclass
class ExportOptions:
    """Granular export toggles — one flag per renderable building block.

    The architecture is deliberately flat (~24 booleans) rather than
    nested. Flat is easier to pass over HTTP query params, easier to
    serialise, and preset factories can construct a specific
    configuration with a single kwargs-style call.

    Five named presets are defined as classmethods below:
      - ExportOptions.full()            — everything on
      - ExportOptions.reading_draft()   — pure reader experience
      - ExportOptions.writer_notes()    — author reference, everything
      - ExportOptions.outline()         — planning skeleton, no bodies
      - ExportOptions.minimal_prose()   — just the words

    User-customisable exports use `ExportOptions()` with individual
    overrides. The frontend Export dialog's preset dropdown is
    expected to translate to these factories; its "Customise…" reveal
    exposes the individual flags for manual tweaking.
    """
    # ── Header / story metadata ───────────────────────────────────
    include_author: bool = True
    include_genre: bool = True
    # Phase 5.8b — story description blurb on the title page. On by
    # default for the Native preset; off-able in Customize.
    include_story_description: bool = True
    # Phase 5.8b — embed the story cover image as the first page, before
    # the title page. Only honoured by image-capable formats (html / pdf
    # / docx); markdown / txt ignore it. Skipped when the project has no
    # cover. On by default for the Native preset.
    include_cover_image: bool = True
    # Phase 5.8b — render markdown found in free-form text fields
    # (descriptions, text attribute values, notes, circumstance /
    # motivator / perspective bodies, scene descriptions). html / pdf /
    # docx render it, markdown passes it through unchanged, txt strips the
    # markers. Scene prose (main_content) is already rich text and is not
    # affected. On by default for the Native preset.
    render_markdown_in_text_fields: bool = True
    # Phase 5.8b — a scene-break ornament (centre diamond + fading rules)
    # between consecutive scenes of the same chapter. html / pdf / docx draw
    # the ornament (rasterised for pdf / docx); markdown / txt use "* * *".
    # Never before a chapter's first scene. On by default in Native.
    include_scene_separator: bool = True
    include_tags: bool = True
    include_tense: bool = True
    include_pov_type: bool = True
    include_language: bool = True
    include_default_pov_character: bool = True
    include_generated_timestamp: bool = True
    # (Title is always shown; there's no "hide the title" use case.)

    # ── Structure ─────────────────────────────────────────────────
    include_act_headings: bool = True
    include_chapter_headings: bool = True
    include_unchaptered_heading: bool = True

    # ── Per-scene elements ────────────────────────────────────────
    include_transition_text: bool = True
    include_scene_title: bool = True
    # Phase 3.11 — `include_scene_description` defaults to False so a
    # bare `ExportOptions()` produces a prose-only manuscript. That
    # matches what most writers want when handing the file to NC or
    # to a beta reader. Presets that intentionally include the
    # writer-facing summary text alongside the prose (`outline`,
    # `reading_draft`, `writer_notes`, `full`) set this back to True
    # explicitly. Renderers all honor the flag — markdown,
    # markdown-novelcrafter, docx, docx-novelcrafter, docx-shunn,
    # pdf, pdf-shunn, html, txt; the Shunn variants route via
    # `shunn_walker.walk_shunn`'s `options` param.
    include_scene_description: bool = False
    include_scene_pov_line: bool = True
    include_entity_context_line: bool = True
    include_scene_body: bool = True
    include_scene_changes_block: bool = True
    # Phase 1.22i — Circumstances & Motivators block: scene-level
    # circumstances + per-entity ongoing C/M (chain-walked to this
    # scene) + per-entity temporary C/M. Renders between the scene
    # description and the scene body.
    include_scene_cm_block: bool = True

    # ── Scene changes granularity (only applies if the block is on) ─
    include_metadata_changes: bool = True      # name / colour / description / profile image
    # Phase 1.25c — alias and awareness chain entries on EntityRef.
    # Each surfaces in the Scene Changes block when the toggle is on
    # AND the ref carries the corresponding chain entry.
    include_alias_changes: bool = True
    include_awareness_changes: bool = True
    include_attribute_changes: bool = True     # add / modify / remove / list ops
    include_relationship_changes: bool = True  # add / modify / remove

    # ── Appendices ────────────────────────────────────────────────
    include_offscreen_appendix: bool = False
    include_entity_sheets: bool = False
    # Phase 1.25c — author's "Notes" sub-section on entity reference
    # sheets. Gated on this toggle AND non-empty `Entity.notes` on the
    # entity itself. Default True — Native preset shows notes; writers
    # can turn it off in Customize for shareable exports that should
    # leave private notes behind.
    include_entity_notes: bool = True
    # Phase 1.25c — Knowledge appendix (parallel to entity sheets,
    # rendered after entity sheets). Default True — Native shows
    # Knowledge; writers can turn off in Customize.
    include_knowledge_section: bool = True
    # Phase 1.25c — chain history rows under each Knowledge entry.
    # Default False because chain history is chatty and most readers
    # don't need it; writer opts in.
    include_knowledge_chain_history: bool = False
    # Phase 1.25c — scene-time line on each scene header (date /
    # weekday / time-of-day / season / duration / gap). Default True.
    include_scene_time: bool = True
    # Phase 1.25c — frontend-precomputed scene-time payload, keyed by
    # scene id. Each entry is `{text, season_svg, tod_svg}`; all
    # three values are strings (empty when no data for that scene).
    # The walker copies them verbatim into the `ExportScene`
    # `scene_time_*` fields so renderers don't need to know how the
    # frontend formats time. None preserves legacy behaviour
    # (no scene-time line emitted) for callers that don't supply it.
    pre_computed_scene_times: Optional[dict[str, dict[str, str]]] = None

    # ── Media attribute embedding ─────────────────────────────────
    # When an entity carries a `file`-type attribute (an image,
    # audio clip, or video file), how should the export embed the
    # media itself? Parent toggle cascades over the three kind-
    # specific toggles. Default: parent on, images on, audio + video
    # off — images are cheap and almost always want to travel with
    # the export; audio and video can be large and are opt-in.
    include_media_attributes: bool = True       # parent toggle
    include_media_attribute_images: bool = True
    include_media_attribute_audio: bool = False
    include_media_attribute_video: bool = False

    # ── Build-level toggles (affect what the model builder computes) ─
    # When on, the walker resolves entity profile images (and any
    # file-attribute asset paths) into base64 data URIs at build time
    # so the `ExportModel` arrives at the renderer self-contained.
    # When off, the URI fields are left as None and the renderer must
    # either skip the image or fetch it another way.
    #
    # Which renderers actually consume `profile_image_data_uri` is a
    # per-renderer property — declared via the `embedded_assets`
    # capability tag on `RendererSpec` (see
    # `backend/services/renderers/registry.py`). The previous wording
    # of this comment said "HTML/PDF only", which was descriptive of
    # the state at the time Phase 1.12a Track 1 shipped — NOT
    # prescriptive. New formats (docx / future) that declare
    # `embedded_assets` on their SPEC will also read this field.
    embed_assets: bool = True

    # ── Page size (paginated formats only) ────────────────────────
    # Only meaningful for the page-based renderers (pdf / docx).
    # Text-based renderers (html / markdown / txt) ignore this field.
    # A4  = 210 × 297 mm (default — international standard)
    # letter = 8.5 × 11 in (215.9 × 279.4 mm — US standard)
    page_size: Literal["a4", "letter"] = "a4"

    # ── Per-entity colours ─────────────────────────────────────────
    # When on, renderers that declare the `entity_colours` capability
    # render each entity mention (scene entity context, scene changes
    # block, entity reference sheet heading, etc.) in that entity's
    # own effective colour walked forward through the narrative chain
    # up to the relevant scene. When off (default), entity mentions
    # use the renderer's standard text colour, matching the pre-
    # v0.1.12.13 behaviour. Renderers that don't declare the
    # capability ignore this field unconditionally.
    use_entity_colours: bool = False

    # ── Scope (subset export) — Track 9 ───────────────────────────
    # When non-None, restricts the export to only the scene ids in
    # the list. Chapters and acts with no surviving scenes after
    # filtering are dropped entirely from the section tree. Off-
    # screen appendix respects the same filter (explicit list
    # membership only — no canvas-range heuristic). None = full
    # story export (default, no filtering). Handled inside
    # `build_export_model` — renderers see an already-filtered
    # `ExportModel` and don't need to know scope exists.
    scope_scene_ids: Optional[list[str]] = None

    # ── Entity state boundary — Track 9 ───────────────────────────
    # When "origin" (default), entity reference sheets always render
    # the entity's library / origin state regardless of which scenes
    # are in the exported scope. When "scope", AND a non-empty scope
    # is set, the walker walks each entity's chain forward through
    # the POV sequence up to (but not including) the earliest
    # exported POV-chain scene, applying every `EntityRef` change
    # along the way, and uses the walked-forward state for the
    # reference sheet. Additionally, entity sheets are filtered to
    # only entities that actually appear in at least one exported
    # scope scene. When `scope_scene_ids` is None / empty, this
    # field is ignored entirely because there's no boundary to
    # compute.
    entity_state_boundary: Literal["origin", "scope"] = "origin"

    # ── Legacy / carried-over ─────────────────────────────────────
    entity_context_mode: Literal["off", "minimal", "full"] = "minimal"

    # ── Phase 1.25a — Export preset architecture ──────────────────
    # The writer's chosen preset (NarrativeNode native / Shunn /
    # NovelCrafter / Customize). In 1.25a preset semantics live on
    # the frontend (the dialog applies a per-preset toggle bundle to
    # the local state before POSTing); this field is mirrored on the
    # dataclass for logging and as a hook for future server-side
    # preset enforcement. Default `customize` so existing callers
    # are treated as "honour the toggle values they sent" — current
    # behaviour preserved.
    preset_key: Literal["native", "shunn", "novelcrafter", "customize"] = "customize"
    # Phase 1.25a — Publication vs Full mode.
    export_mode: Literal["publication", "full"] = "full"
    # Phase 1.25b — pre-computed scene order (list of `SceneNode.id`
    # strings, in narrative sequence). When non-None, the walker
    # uses this list as the canonical scene sequence for the main
    # narrative instead of calling `compute_pov_sequence(story)`.
    # Frontend computes the order via Phase 1.19's `storyOrder.js`
    # — Publication mode filters to POV-only scenes; Full mode
    # ships every scene in Story Order. None preserves legacy
    # behaviour (POV-wire chain via `compute_pov_sequence`) for any
    # API caller that doesn't supply an order — current behaviour
    # is preserved for non-dialog callers.
    pre_computed_order: Optional[list[str]] = None
    # Phase 1.25b — set of scene ids that are on the POV path. When
    # `pre_computed_order` includes both POV-path and off-screen
    # scenes (Full mode), this set lets the renderer flag the POV
    # ones — useful for "Native" exports where the writer wants to
    # see at a glance which scenes are reader-facing vs writer-only.
    # In Publication mode this set typically equals
    # `pre_computed_order`. None preserves legacy behaviour
    # (every scene in `pov_sequence` is treated as POV-path).
    pov_path_scene_ids: Optional[list[str]] = None
    # Phase 4.3 — frontend-precomputed scene id → chapter id map.
    # Chapter membership is canvas geometry: single-row resolves a
    # node's chapter by centre-x, multi-row by 2D row band. The backend
    # only carries the single-row resolver (`get_chapter_id_for_node`),
    # so for multi-row exports the frontend resolves membership
    # mode-aware and ships the result here. `_add_chapter_sections`
    # prefers this map when present (a scene absent from it is
    # unchaptered) and falls back to the single-row resolver when None
    # — preserving current behaviour for API callers that don't supply
    # it.
    pre_computed_chapter_ids: Optional[dict[str, str]] = None

    # ──────────────────────────────────────────────────────────────
    # Presets
    # ──────────────────────────────────────────────────────────────

    @classmethod
    def full(cls) -> "ExportOptions":
        """Everything on. Appendices included. The kitchen-sink export."""
        return cls(
            # `include_scene_description` defaults to False on the
            # class (prose-only is the bare-options default per
            # Phase 3.11). Kitchen-sink puts it back on so writers
            # picking "Full" don't lose the writer-facing summary.
            include_scene_description=True,
            include_offscreen_appendix=True,
            include_entity_sheets=True,
        )

    @classmethod
    def reading_draft(cls) -> "ExportOptions":
        """Clean reader experience — act/chapter headings, transitions,
        scene titles + descriptions + POV line + scene body. No entity
        context, no changes block, no appendices. The version you hand
        to a beta reader."""
        return cls(
            include_scene_description=True,
            include_entity_context_line=False,
            include_scene_changes_block=False,
            include_offscreen_appendix=False,
            include_entity_sheets=False,
        )

    @classmethod
    def writer_notes(cls) -> "ExportOptions":
        """Author reference — everything the system tracks, including
        entity sheets and per-scene change logs. The version you keep
        for yourself."""
        return cls(
            include_scene_description=True,
            include_offscreen_appendix=True,
            include_entity_sheets=True,
        )

    @classmethod
    def outline(cls) -> "ExportOptions":
        """Structural skeleton — headings, scene titles, descriptions,
        POV line, entity context line, and the changes block. NO scene
        body prose and NO appendices. Produces a planning / TOC view
        of the whole story in a fraction of the length of the full
        export."""
        return cls(
            include_scene_description=True,
            include_scene_body=False,
            include_offscreen_appendix=False,
            include_entity_sheets=False,
        )

    @classmethod
    def minimal_prose(cls) -> "ExportOptions":
        """Just the words — title, byline, chapter headings, transitions,
        scene title, scene body. No acts, no descriptions, no POV line,
        no entity context, no changes, no appendices."""
        return cls(
            include_tags=False,
            include_tense=False,
            include_pov_type=False,
            include_language=False,
            include_default_pov_character=False,
            include_generated_timestamp=False,
            include_act_headings=False,
            include_unchaptered_heading=False,
            include_scene_description=False,
            include_scene_pov_line=False,
            include_entity_context_line=False,
            include_scene_changes_block=False,
            include_offscreen_appendix=False,
            include_entity_sheets=False,
        )


@dataclass
class ExportModel:
    title: str
    author: Optional[str]
    genre: Optional[str]
    tags: list[str]
    generated_at: datetime
    chapter_label: str                          # user override or default "Chapter"
    act_label: str                              # user override or default "Act"
    # Phase 1.12a v0.1.12.3 — surface story-level narrative metadata.
    # These come from story settings and appear in the document header
    # so a reader immediately knows the tense, POV style, and primary
    # POV character the writer intended.
    tense: Optional[str] = None                 # story.tense — "past" | "present"
    pov_type: Optional[str] = None              # story.pov_type_default — "1st Person" etc.
    language: Optional[str] = None              # story.language — freeform
    default_pov_character_name: Optional[str] = None
    # Phase 5.8b — story.description blurb. Shown on the title page /
    # header when `include_story_description` is on. None / empty string
    # renders nothing.
    description: Optional[str] = None
    # Phase 5.8b — story cover image as a base64 data URI (JPEG). Set
    # when `include_cover_image` is on AND the active project has a cover;
    # None otherwise. Image-capable renderers (html / pdf / docx) emit it
    # as the first page; markdown / txt ignore it.
    cover_image_data_uri: Optional[str] = None
    # Themed colours from story settings — the HTML renderer uses
    # these as CSS custom-property values. Falling back to defaults
    # happens in the renderer so the model stays honest about what
    # the story did or didn't explicitly set.
    accent_color: Optional[str] = None          # story.accent_color
    pov_color: Optional[str] = None             # story.pov_color
    sections: list[ExportSection] = field(default_factory=list)
    offscreen_scenes: list[ExportScene] = field(default_factory=list)
    entity_sheets: list[ExportEntitySheet] = field(default_factory=list)
    # Phase 1.25c — Knowledge appendix (parallel to entity sheets).
    # Populated when `include_knowledge_section` is on. Empty list
    # otherwise; renderers gate emission on
    # `include_knowledge_section AND knowledge_sheets`.
    knowledge_sheets: list[ExportKnowledgeSheet] = field(default_factory=list)


# ── Builder ────────────────────────────────────────────────────────────


def build_export_model(story: Story, options: Optional[ExportOptions] = None) -> ExportModel:
    """Build an `ExportModel` from a `Story`.

    Deterministic and pure (modulo `generated_at` and asset reads from
    disk). Call with the same story + options and get the same structural
    output every time. Asset byte content is only read when the relevant
    option is on, so a no-options build skips all disk I/O.
    """
    options = options or ExportOptions()

    # Pre-compute lookups.
    scenes_by_id = {n.id: n for n in story.scenes}
    chapters = list(story.chapters or [])
    acts = list(story.acts or [])
    x_offset = story.chapter_x_offset if story.chapter_x_offset is not None else 10.0

    # Main narrative order. Phase 1.25b: when `pre_computed_order`
    # is supplied (the dialog's normal path — frontend computes
    # Phase 1.19 Story Order via `storyOrder.js`), use it directly
    # instead of calling the legacy single-source POV-wire walker.
    # The `pre_computed_order` list is scene-id-only; we synthesise
    # the dict shape `pov_sequence` consumers expect by reading
    # each scene's pov_entity_id (or scanning has_pov for legacy
    # saves). When the field is None, fall back to the legacy
    # POV-wire walker so non-dialog API callers preserve current
    # behaviour.
    if options.pre_computed_order is not None:
        pov_sequence = []
        for idx, scene_id in enumerate(options.pre_computed_order, start=1):
            scene = scenes_by_id.get(scene_id)
            if scene is None:
                continue
            pov_entity_id = scene.pov_entity_id
            if pov_entity_id is None:
                for char in scene.characters:
                    if char.has_pov:
                        pov_entity_id = char.entity_id
                        break
            pov_sequence.append({
                "node_id": scene_id,
                "pov_entity_id": pov_entity_id,
                "title": scene.title or scene.description or "Untitled Scene",
                "index": idx,
            })
    else:
        pov_sequence = compute_pov_sequence(story)
    pov_node_ids = {entry["node_id"] for entry in pov_sequence}

    # Phase 1.25b — POV-path membership set. When the request supplies
    # `pov_path_scene_ids` (Full mode dialog flow), use it; otherwise
    # default to "every scene in `pov_sequence` is on the POV path"
    # which preserves legacy behaviour for non-dialog API callers.
    if options.pov_path_scene_ids is not None:
        pov_path_set = set(options.pov_path_scene_ids)
    else:
        pov_path_set = set(pov_node_ids)

    # Entity lookup by id across all buckets (for name resolution in the
    # scene entity-context line and in entity reference sheets).
    entities_by_id: dict[str, tuple[Entity, str]] = {}
    for bucket_name in ENTITY_BUCKETS:
        bucket = getattr(story.entities, bucket_name, None) or []
        for ent in bucket:
            entities_by_id[ent.id] = (ent, bucket_name)

    # Phase 5.8b — knowledge lookup for resolving perspective attribute
    # targets (a perspective can point at a knowledge) on entity sheets.
    knowledges_by_id: dict[str, object] = {k.id: k for k in (story.knowledges or [])}

    # Pre-resolve a profile image data URI for every entity that has
    # one. Used by the scene entity context + changes block for hover
    # popovers, not just the entity reference sheets. When
    # `embed_assets` is off we skip the disk work entirely and every
    # entity's URI stays None (the renderer gracefully omits the
    # hover popover in that case).
    profile_uri_by_entity_id: dict[str, Optional[str]] = {}
    if options.embed_assets:
        for ent_id, (ent, _type) in entities_by_id.items():
            profile_uri_by_entity_id[ent_id] = _asset_to_data_uri(ent.profile_image_ref)
    else:
        for ent_id in entities_by_id:
            profile_uri_by_entity_id[ent_id] = None

    # Build the section tree: chapters (optionally wrapped in acts), plus
    # a synthetic "Unchaptered" section prepended for POV-chain scenes
    # whose centre-x falls outside every chapter column.
    sections = _build_sections(story, chapters, acts, x_offset)

    # Assign each POV-chain scene to its section.
    _assign_scenes_to_sections(
        sections=sections,
        pov_sequence=pov_sequence,
        pov_path_set=pov_path_set,
        scenes_by_id=scenes_by_id,
        story=story,
        chapters=chapters,
        x_offset=x_offset,
        entities_by_id=entities_by_id,
        profile_uri_by_entity_id=profile_uri_by_entity_id,
        options=options,
    )

    # Track 9 — scope filter. When a scope is set, prune the section
    # tree to only keep scenes whose id is in the scope set, and drop
    # any chapter / unchaptered / act section that ends up empty.
    # Renderers see the already-filtered sections and don't need to
    # know scope exists.
    scope_set: Optional[set[str]] = None
    if options.scope_scene_ids is not None:
        scope_set = set(options.scope_scene_ids)
        sections = _filter_sections_by_scope(sections, scope_set)

    # Build the optional off-screen appendix.
    offscreen_scenes: list[ExportScene] = []
    if options.include_offscreen_appendix:
        offscreen = [
            n for n in story.scenes
            if n.id not in pov_node_ids and not n.is_flashback
        ]
        # Phase 1.25c (Bug 10) — sort by Story Order position when the
        # caller shipped `pre_computed_order`. This makes the off-
        # screen appendix order match the writer's intended narrative
        # sequence (the same axis the main story body uses) rather
        # than canvas-x. Falls back to canvas-x for any scenes that
        # the frontend didn't position in Story Order (off-canvas /
        # detached / etc.). Stable secondary sort on `id` for
        # deterministic output.
        story_order_index_by_node: dict[str, int] = {}
        if options.pre_computed_order:
            for idx, sid in enumerate(options.pre_computed_order):
                story_order_index_by_node[sid] = idx
        unknown_index = len(story_order_index_by_node)  # send unknowns to the tail

        def _offscreen_sort_key(n):
            so = story_order_index_by_node.get(n.id)
            if so is not None:
                return (0, so, n.id)
            x = n.position.x if n.position else 0.0
            return (1, x, n.id)

        offscreen.sort(key=_offscreen_sort_key)
        # Track 9 — scope filter applies to offscreen scenes too.
        # Explicit list membership only (no canvas-range heuristic)
        # so the mental model stays simple: "if the user ticked
        # scene X, it's in; otherwise it's out".
        if scope_set is not None:
            offscreen = [n for n in offscreen if n.id in scope_set]
        for n in offscreen:
            offscreen_scenes.append(_build_scene(
                node=n,
                transition_in_text="",
                chain_index=0,
                entities_by_id=entities_by_id,
                profile_uri_by_entity_id=profile_uri_by_entity_id,
                context_mode=options.entity_context_mode,
                source_story=story,
                story_relationships=story.relationships or [],
                pre_computed_scene_times=options.pre_computed_scene_times if options.include_scene_time else None,
                include_alias_changes=options.include_alias_changes,
                include_awareness_changes=options.include_awareness_changes,
            ))

    # Build the optional entity reference sheets. When scope is set
    # and `entity_state_boundary == "scope"`, walk each entity's
    # chain forward through the POV sequence up to (but not
    # including) the earliest exported POV scene, and use the
    # walked-forward state for the sheet. Otherwise use library /
    # origin state (default).
    entity_sheets: list[ExportEntitySheet] = []
    if options.include_entity_sheets:
        use_scope_boundary = (
            scope_set is not None
            and options.entity_state_boundary == "scope"
        )
        boundary_chain_index: Optional[int] = None
        scope_entity_ids: Optional[set[str]] = None
        if use_scope_boundary:
            boundary_chain_index = _compute_boundary_chain_index(
                pov_sequence, scope_set
            )
            scope_entity_ids = _collect_entity_ids_in_scope(
                story, scope_set, scenes_by_id
            )

        for ent, type_name in _iter_entities_in_library_order(story):
            if use_scope_boundary and scope_entity_ids is not None:
                # Filter sheets to only entities that appear in the
                # exported scope — a reader who only gets Chapter 7
                # doesn't want to see a codex entry for a character
                # who first shows up in Chapter 12.
                if ent.id not in scope_entity_ids:
                    continue
            if use_scope_boundary and boundary_chain_index is not None:
                # Walk the entity's chain forward to the boundary,
                # then build the sheet from the walked-forward state.
                # Convert the POV-chain boundary index to the boundary
                # scene id so the (chain-aware) walker can stop at the
                # right scene regardless of which scenes are on POV.
                boundary_scene_id = next(
                    (
                        pe["node_id"]
                        for pe in pov_sequence
                        if (pe.get("index", 0) or 0) == boundary_chain_index
                    ),
                    None,
                )
                walked_entity = _walk_entity_state_forward(
                    entity=ent,
                    source_story=story,
                    boundary_node_id=boundary_scene_id,
                    inclusive=False,  # state JUST BEFORE the earliest exported scene
                )
                entity_sheets.append(_build_entity_sheet(
                    entity=walked_entity,
                    type_name=type_name,
                    embed_assets=options.embed_assets,
                    entities_by_id=entities_by_id,
                    profile_uri_by_entity_id=profile_uri_by_entity_id,
                    story_relationships=story.relationships,
                    knowledges_by_id=knowledges_by_id,
                    chain_boundary_index=boundary_chain_index,
                    pov_sequence=pov_sequence,
                ))
            else:
                entity_sheets.append(_build_entity_sheet(
                    entity=ent,
                    type_name=type_name,
                    embed_assets=options.embed_assets,
                    entities_by_id=entities_by_id,
                    profile_uri_by_entity_id=profile_uri_by_entity_id,
                    story_relationships=story.relationships,
                    knowledges_by_id=knowledges_by_id,
                ))

    # Phase 1.25c — Knowledge appendix. Built only when the toggle is
    # on; chain history rows added only when its sub-toggle is also on.
    knowledge_sheets: list[ExportKnowledgeSheet] = []
    if options.include_knowledge_section:
        for k in (story.knowledges or []):
            knowledge_sheets.append(_build_knowledge_sheet(
                knowledge=k,
                embed_assets=options.embed_assets,
                include_chain_history=options.include_knowledge_chain_history,
                pov_sequence=pov_sequence,
                scenes_by_id=scenes_by_id,
            ))

    # Resolve the default POV character's display name (if set) so the
    # header can show "Primary POV: Alice Kane" instead of a bare UUID.
    default_pov_name: Optional[str] = None
    if story.pov_character_id:
        pov_entry = entities_by_id.get(story.pov_character_id)
        if pov_entry:
            default_pov_name = pov_entry[0].name

    # Phase 5.8b — read the active project's cover image (cover.jpg at the
    # .nnz root, managed by file_service) as a base64 data URI when the
    # toggle is on and a cover exists. Image-capable renderers emit it as
    # the first page; the data URI stays None otherwise. Lazy import keeps
    # the module-load graph free of file_service's main-import cycle.
    cover_image_data_uri: Optional[str] = None
    if options.include_cover_image:
        try:
            from services import file_service
            cover_path = file_service.get_cover_path()
            if cover_path is not None:
                raw = cover_path.read_bytes()
                if raw:
                    cover_image_data_uri = "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")
        except Exception:
            cover_image_data_uri = None

    return ExportModel(
        title=story.title or "Untitled Story",
        author=story.author,
        genre=story.genre,
        tags=list(story.tags or []),
        generated_at=datetime.now(timezone.utc),
        chapter_label=(story.chapter_label or "Chapter"),
        act_label=(story.act_label or "Act"),
        tense=story.tense,
        pov_type=story.pov_type_default,
        language=story.language,
        default_pov_character_name=default_pov_name,
        description=story.description,
        cover_image_data_uri=cover_image_data_uri,
        accent_color=story.accent_color,
        pov_color=story.pov_color,
        sections=sections,
        offscreen_scenes=offscreen_scenes,
        entity_sheets=entity_sheets,
        knowledge_sheets=knowledge_sheets,
    )


# ── Track 9: scope filter + entity state boundary helpers ──────────────


def _filter_sections_by_scope(
    sections: list[ExportSection],
    scope_set: set[str],
) -> list[ExportSection]:
    """Recursively prune a section tree to only keep scenes whose id
    is in `scope_set`. Chapters / unchaptered sections with zero
    surviving scenes are dropped. Acts with zero surviving chapter
    children are dropped. Returns a NEW tree — the input is not
    mutated."""
    out: list[ExportSection] = []
    for section in sections:
        filtered = _filter_single_section_by_scope(section, scope_set)
        if filtered is not None:
            out.append(filtered)
    return out


def _filter_single_section_by_scope(
    section: ExportSection,
    scope_set: set[str],
) -> Optional[ExportSection]:
    """Return a filtered copy of `section` or None if nothing
    survives the filter."""
    if section.kind == "act":
        filtered_children = _filter_sections_by_scope(section.children, scope_set)
        if not filtered_children:
            return None
        return ExportSection(
            kind=section.kind,
            id=section.id,
            title=section.title,
            number=section.number,
            colour=section.colour,
            label=section.label,
            scenes=[],
            children=filtered_children,
        )

    # chapter / unchaptered — filter scenes
    filtered_scenes = [s for s in section.scenes if s.id in scope_set]
    if not filtered_scenes:
        return None
    return ExportSection(
        kind=section.kind,
        id=section.id,
        title=section.title,
        number=section.number,
        colour=section.colour,
        label=section.label,
        scenes=filtered_scenes,
        children=[],
    )


def _compute_boundary_chain_index(
    pov_sequence: list[dict],
    scope_set: set[str],
) -> Optional[int]:
    """Return the minimum 1-based POV chain index among scenes in
    `scope_set`. Returns None if no POV-chain scene is in the scope
    (e.g. the user selected only off-screen scenes) — callers should
    fall back to origin state in that case because there's no
    meaningful boundary to walk to.

    `compute_pov_sequence` stores the 1-based chain index on each
    entry under the key `"index"` (not `"chain_index"`). Using the
    wrong key silently defaults every entry to 0 and the boundary
    comes back as 0, which means no scenes get walked — the bug
    that produced the failing walk-forward tests during v0.1.12.20
    development."""
    lowest: Optional[int] = None
    for entry in pov_sequence:
        if entry["node_id"] not in scope_set:
            continue
        chain_index = entry.get("index", 0) or 0
        if lowest is None or chain_index < lowest:
            lowest = chain_index
    return lowest


def _collect_entity_ids_in_scope(
    story: Story,
    scope_set: set[str],
    scenes_by_id: dict[str, SceneNode],
) -> set[str]:
    """Return the set of entity ids that appear as an `EntityRef` in
    at least one scene in the scope. Used to filter entity reference
    sheets when `entity_state_boundary == "scope"` — a reader who
    only gets a subset of the story shouldn't see a codex entry for
    a character who never appears in that subset."""
    result: set[str] = set()
    for node_id in scope_set:
        node = scenes_by_id.get(node_id)
        if node is None:
            continue
        for bucket_name in ENTITY_BUCKETS:
            for ref in (getattr(node, bucket_name, None) or []):
                result.add(ref.entity_id)
    return result


def _walk_entity_state_forward(
    entity: Entity,
    source_story: Story,
    *,
    boundary_node_id: Optional[str],
    inclusive: bool,
) -> Entity:
    """Walk the entity's OWN narrative chain (origin EntityNode →
    flow connections through scenes/modifiers carrying this entity)
    and apply every `EntityRef` / modifier-node change for this entity
    along the way. Returns a pydantic copy of the entity with the
    walked-forward state — `name`, `colour`, `description`,
    `profile_image_ref`, and `attributes` are updated to reflect the
    state at the boundary.

    Iteration source: `get_entity_narrative_chain(entity.id, source_story)`
    from `services.narrative_chain` — same canonical helper the import
    walker uses. POV-chain iteration was the v0.2.1.x bug that silently
    dropped every change made to the entity at an off-POV scene; this
    walker is now chain-aware in the per-entity sense.

    `boundary_node_id` is a scene id (or modifier node id) at which to
    stop. `inclusive=True` applies that node's changes before breaking
    (used for "state AT this scene"). `inclusive=False` breaks BEFORE
    applying (used for "state JUST BEFORE this scene"). `None` walks
    the entire chain (used when the export covers everything).

    Aliases and awareness are NOT walked here — same narrow scope this
    helper has always carried (the import walker handles them; the
    export walker's alias/awareness gap is a separate bug class to be
    addressed when alias / awareness fields are added to the export
    sheet builder). Relationships are NOT walked either — origin-state
    relationships carry through unchanged, same v1 limitation noted in
    the prior docstring."""
    walked = entity.model_copy(deep=True)

    attrs_by_id: dict[str, Attribute] = {
        a.id: a.model_copy(deep=True) for a in (entity.attributes or [])
    }
    attrs_order: list[str] = [a.id for a in (entity.attributes or [])]

    chain = get_entity_narrative_chain(entity.id, source_story)
    # chain[0] is the origin EntityNode — its baseline IS the entity
    # itself (already copied into `walked` above), so the apply loop
    # skips it and starts from chain[1] onward.
    for chain_node in chain[1:]:
        if not inclusive and boundary_node_id is not None and chain_node.id == boundary_node_id:
            break

        node_type = getattr(chain_node, "node_type", None)
        if node_type == "scene":
            for bucket_name in ENTITY_BUCKETS:
                bucket = getattr(chain_node, bucket_name, None)
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
                        # Empty string is the sentinel for "clear the image".
                        walked.profile_image_ref = ref.profile_image_change or None
                    for change in ref.attribute_changes or []:
                        _apply_attribute_change_to_walked(
                            change, attrs_by_id, attrs_order
                        )
        elif node_type == "entity":
            # Modifier EntityNode for this entity — apply its own
            # change fields (same scalar + attribute scope as the
            # scene path above; aliases / awareness deferred).
            if chain_node.name_change is not None:
                walked.name = chain_node.name_change
            if chain_node.colour_change is not None:
                walked.colour = chain_node.colour_change
            if chain_node.description_change is not None:
                walked.description = chain_node.description_change
            if chain_node.profile_image_change is not None:
                walked.profile_image_ref = (
                    chain_node.profile_image_change if chain_node.profile_image_change else None
                )
            for change in chain_node.attribute_changes or []:
                _apply_attribute_change_to_walked(
                    change, attrs_by_id, attrs_order
                )

        if inclusive and boundary_node_id is not None and chain_node.id == boundary_node_id:
            break

    walked.attributes = [attrs_by_id[aid] for aid in attrs_order if aid in attrs_by_id]
    return walked


def _apply_attribute_change_to_walked(
    change,  # AttributeChange
    attrs_by_id: dict[str, Attribute],
    attrs_order: list[str],
) -> None:
    """Mutate the walked-forward entity's attribute map based on a
    single `AttributeChange` record. Supports `add`, `modify`,
    `remove`, and the list-op variants. Unknown change actions are
    silently ignored."""
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
            # Empty string = clear.
            attr.file_ref = change.file_ref_change or None
        # Phase 1.22 — circumstance / motivator description + intensity,
        # plus number-attribute numeric value modifies. Each is an
        # independent field so the walker applies any non-null one.
        if change.new_description is not None:
            attr.description = change.new_description
        if change.new_intensity is not None:
            attr.intensity = change.new_intensity
        if change.new_number_value is not None:
            attr.number_value = change.new_number_value
        return

    if action == "rename":
        if not change.attribute_id or change.attribute_id not in attrs_by_id:
            return
        if change.new_name is not None:
            attrs_by_id[change.attribute_id].name = change.new_name
        return

    if action in ("list_add", "list_remove"):
        if not change.attribute_id or change.attribute_id not in attrs_by_id:
            return
        if change.list_item is None:
            return
        attr = attrs_by_id[change.attribute_id]
        # text_list / entity_list attributes store their items as a
        # JSON-encoded array in `attr.value`.
        try:
            existing = json.loads(attr.value) if attr.value else []
            if not isinstance(existing, list):
                existing = []
        except (ValueError, TypeError):
            existing = []
        if action == "list_add":
            if change.list_item not in existing:
                existing.append(change.list_item)
        else:  # list_remove
            try:
                existing.remove(change.list_item)
            except ValueError:
                pass
        attr.value = json.dumps(existing)
        return


# ── Section tree construction ──────────────────────────────────────────


def _build_sections(
    story: Story,
    chapters: list[Chapter],
    acts: list[Act],
    x_offset: float,
) -> list[ExportSection]:
    """Walk story.chapters[] in order, wrap runs that belong to the same
    act inside a parent ExportSection with kind='act'. Chapters outside
    any act remain top-level chapter sections. Prepended to all of that
    is a synthetic 'unchaptered' section that scene-assignment will later
    fill with any POV scenes whose centre-x falls outside every chapter.
    """
    chapter_label = story.chapter_label or "Chapter"
    act_label = story.act_label or "Act"

    # Chapter id → act index (for quick lookup during the walk).
    act_index_by_chapter_id: dict[str, int] = {}
    for act_idx, act in enumerate(acts):
        for cid in act.chapter_ids:
            act_index_by_chapter_id[cid] = act_idx

    sections: list[ExportSection] = [
        ExportSection(
            kind="unchaptered",
            id=None,
            title=None,
            number=None,
            colour=None,
            label="Unchaptered",
        )
    ]

    # Build per-chapter ExportSection objects.
    chapter_sections: dict[str, ExportSection] = {}
    for i, chapter in enumerate(chapters):
        label = f"{chapter_label} {i + 1}"
        if chapter.title:
            label = f"{label}: {chapter.title}"
        chapter_sections[chapter.id] = ExportSection(
            kind="chapter",
            id=chapter.id,
            title=chapter.title or None,
            number=i + 1,
            colour=chapter.colour,
            label=label,
        )

    # Walk chapters[] in order, grouping contiguous same-act chapters
    # under a single act wrapper.
    i = 0
    while i < len(chapters):
        chapter = chapters[i]
        act_idx = act_index_by_chapter_id.get(chapter.id)
        if act_idx is None:
            # Unchaptered run — just append the chapter section directly.
            sections.append(chapter_sections[chapter.id])
            i += 1
            continue

        # Start an act wrapper. Consume every following chapter that
        # also belongs to this same act (contiguity is already guaranteed
        # by the store-level `_pruneActContiguity` helper).
        act = acts[act_idx]
        act_label_text = f"{act_label} {act_idx + 1}"
        if act.title:
            act_label_text = f"{act_label_text}: {act.title}"
        act_section = ExportSection(
            kind="act",
            id=act.id,
            title=act.title or None,
            number=act_idx + 1,
            colour=act.colour,
            label=act_label_text,
        )
        while i < len(chapters) and act_index_by_chapter_id.get(chapters[i].id) == act_idx:
            act_section.children.append(chapter_sections[chapters[i].id])
            i += 1
        sections.append(act_section)

    return sections


def _assign_scenes_to_sections(
    *,
    sections: list[ExportSection],
    pov_sequence: list[dict],
    pov_path_set: set[str],
    scenes_by_id: dict[str, SceneNode],
    story: Story,
    chapters: list[Chapter],
    x_offset: float,
    entities_by_id: dict[str, tuple[Entity, str]],
    profile_uri_by_entity_id: dict[str, Optional[str]],
    options: ExportOptions,
) -> None:
    """Assign each POV-chain scene to the correct section by resolving
    its centre-x → chapter id (via `get_chapter_id_for_node`) and then
    finding that chapter's ExportSection in the tree. Scenes with no
    resolvable chapter land in the synthetic 'unchaptered' section.

    Transition text for a scene comes from the POV edge that LANDS on
    it (i.e., the previous POV-chain entry's outgoing connection). The
    first scene in the chain has no incoming POV edge, so its
    `transition_in_text` is empty.
    """
    # Build a flat chapter_id → section lookup that descends into act
    # children so we can drop scenes into nested chapters directly.
    chapter_id_to_section: dict[str, ExportSection] = {}
    unchaptered_section: Optional[ExportSection] = None
    for section in sections:
        if section.kind == "unchaptered":
            unchaptered_section = section
        elif section.kind == "chapter" and section.id is not None:
            chapter_id_to_section[section.id] = section
        elif section.kind == "act":
            for child in section.children:
                if child.kind == "chapter" and child.id is not None:
                    chapter_id_to_section[child.id] = child

    # Map source-node-id → transition text on the POV edge INTO that
    # node. `story.connections` is the source of truth; scan once.
    pov_transition_into: dict[str, str] = {}
    for conn in story.connections:
        if conn.is_pov_path and conn.transition_text:
            pov_transition_into[conn.target_node_id] = conn.transition_text

    for entry in pov_sequence:
        node = scenes_by_id.get(entry["node_id"])
        if node is None:
            continue
        scene = _build_scene(
            node=node,
            transition_in_text=pov_transition_into.get(node.id, ""),
            chain_index=entry["index"],
            is_on_pov_path=node.id in pov_path_set,
            entities_by_id=entities_by_id,
            profile_uri_by_entity_id=profile_uri_by_entity_id,
            context_mode=options.entity_context_mode,
            source_story=story,
            story_relationships=story.relationships or [],
            pre_computed_scene_times=options.pre_computed_scene_times if options.include_scene_time else None,
            include_alias_changes=options.include_alias_changes,
            include_awareness_changes=options.include_awareness_changes,
        )
        # Prefer the frontend's mode-aware membership map when supplied
        # (correct in single- AND multi-row); fall back to the backend's
        # single-row resolver for API callers that don't ship the map.
        if options.pre_computed_chapter_ids is not None:
            chapter_id = options.pre_computed_chapter_ids.get(node.id)
        else:
            chapter_id = get_chapter_id_for_node(node, chapters, x_offset)
        if chapter_id and chapter_id in chapter_id_to_section:
            chapter_id_to_section[chapter_id].scenes.append(scene)
        elif unchaptered_section is not None:
            unchaptered_section.scenes.append(scene)


def _build_scene(
    *,
    node: SceneNode,
    transition_in_text: str,
    chain_index: int,
    is_on_pov_path: bool = True,
    entities_by_id: dict[str, tuple[Entity, str]],
    profile_uri_by_entity_id: dict[str, Optional[str]],
    context_mode: str,
    source_story: Story,
    story_relationships: "list[Relationship]" = (),
    pre_computed_scene_times: Optional[dict[str, dict[str, str]]] = None,
    include_alias_changes: bool = True,
    include_awareness_changes: bool = True,
) -> ExportScene:
    # Phase 1.25c — pull pre-computed scene-time payload by scene id.
    scene_time_entry = (pre_computed_scene_times or {}).get(node.id) or {}
    scene_time_text = scene_time_entry.get("text") or ""
    scene_time_season_svg = scene_time_entry.get("season_svg") or ""
    scene_time_tod_svg = scene_time_entry.get("tod_svg") or ""

    return ExportScene(
        id=node.id,
        title=node.title or "",
        description=node.description or "",
        main_content_html=node.main_content or "",
        transition_in_text=transition_in_text,
        entity_context_groups=_build_entity_context_groups(
            node, entities_by_id, profile_uri_by_entity_id, context_mode
        ),
        chain_index=chain_index,
        is_on_pov_path=is_on_pov_path,
        pov_entity_name=_resolve_pov_entity_name(node, entities_by_id),
        changes=_build_scene_changes(
            node, entities_by_id, profile_uri_by_entity_id,
            story_relationships=story_relationships,
            include_alias_changes=include_alias_changes,
            include_awareness_changes=include_awareness_changes,
        ),
        cm_groups=_build_scene_cm_groups(
            node=node,
            chain_index=chain_index,
            entities_by_id=entities_by_id,
            source_story=source_story,
        ),
        scene_time_text=scene_time_text,
        scene_time_season_svg=scene_time_season_svg,
        scene_time_tod_svg=scene_time_tod_svg,
    )


# ── Phase 1.22i — Circumstances & Motivators block builder ─────────────


_INTENSITY_LABELS = ["Faint", "Mild", "Moderate", "Strong", "Intense"]


def _format_intensity(level: Optional[int]) -> Optional[str]:
    """Format an intensity tier for export. `None` returns `None` (the
    renderer omits the bracket entirely). Otherwise returns
    `"<Label> (<n>/5)"` — e.g. `"Strong (4/5)"`. Out-of-range values
    are clamped to 0..4."""
    if level is None:
        return None
    try:
        lv = int(level)
    except (TypeError, ValueError):
        return None
    lv = max(0, min(4, lv))
    return f"{_INTENSITY_LABELS[lv]} ({lv + 1}/5)"


_BUCKET_TYPE_LABELS = {
    "characters": "character",
    "locations": "location",
    "items": "item",
    "factions": "faction",
    "customs": "custom",
}


def _build_scene_cm_groups(
    *,
    node: SceneNode,
    chain_index: int,
    entities_by_id: dict[str, tuple[Entity, str]],
    source_story: Story,
) -> list[ExportSceneCMGroup]:
    """Build the per-scene Circumstances & Motivators groups.

    Group order:
      1. Scene group (if any `node.circumstances` entries)
      2. Per-entity groups, in canonical bucket order
         (characters → locations → items → factions → customs);
         dedup by entity_id; only entities that produce at least one
         row appear.

    Per-entity group row order:
      - Temporary circumstances (scene-side, chain-aware: scene IS
        their origin so reading directly from
        `node.entity_temporary_circumstances` is canonical)
      - Temporary motivators
      - Ongoing circumstances (chain-walked attribute_type='circumstance')
      - Ongoing motivators (chain-walked attribute_type='motivator')

    The chain walk for ongoing C/M reuses `_walk_entity_state_forward`
    with `boundary_chain_index = chain_index + 1` to include the
    scene's own changes. Off-screen scenes (chain_index == 0) skip
    the chain walk because they aren't part of the POV sequence;
    only their temporaries and scene-level circumstances surface."""
    groups: list[ExportSceneCMGroup] = []

    # Scene-level circumstances.
    scene_rows: list[ExportSceneCMRow] = []
    for c in (node.circumstances or []):
        scene_rows.append(ExportSceneCMRow(
            prefix="Scene Circumstance",
            name=c.name or "",
            description=c.description or "",
            intensity_label=_format_intensity(c.intensity),
            intensity=c.intensity,
        ))
    if scene_rows:
        groups.append(ExportSceneCMGroup(
            kind="scene", entity_id=None, label="Scene", entity_type=None,
            rows=scene_rows,
        ))

    # Group temporaries by entity for fast lookup.
    temps_by_entity: dict[str, list] = {}
    for t in (node.entity_temporary_circumstances or []):
        if not t.entity_id:
            continue
        temps_by_entity.setdefault(t.entity_id, []).append(t)

    # Walk every entity bucket in canonical order. Dedup by entity_id
    # in case the same entity appears in multiple buckets (legacy /
    # exotic case).
    seen: set[str] = set()
    for bucket_name in ENTITY_BUCKETS:
        bucket = getattr(node, bucket_name, None) or []
        type_label = _BUCKET_TYPE_LABELS.get(bucket_name, bucket_name.rstrip("s"))
        for ref in bucket:
            entity_id = ref.entity_id
            if not entity_id or entity_id in seen:
                continue
            seen.add(entity_id)
            ent_entry = entities_by_id.get(entity_id)
            if not ent_entry:
                continue
            entity, _bucket = ent_entry
            display_name = ref.name_change if ref.name_change else (entity.name or "")

            entity_rows: list[ExportSceneCMRow] = []

            # Temporaries first, circumstances before motivators.
            temps = temps_by_entity.get(entity_id, [])
            temp_circs = [t for t in temps if t.attribute_type == "circumstance"]
            temp_mots = [t for t in temps if t.attribute_type == "motivator"]
            for t in temp_circs:
                entity_rows.append(ExportSceneCMRow(
                    prefix="Temporary Circumstance",
                    name=t.name or "",
                    description=t.description or "",
                    intensity_label=_format_intensity(t.intensity),
                    intensity=t.intensity,
                ))
            for t in temp_mots:
                entity_rows.append(ExportSceneCMRow(
                    prefix="Temporary Motivator",
                    name=t.name or "",
                    description=t.description or "",
                    intensity_label=_format_intensity(t.intensity),
                    intensity=t.intensity,
                ))

            # Ongoing C/M: chain-walked to this scene anchor (inclusive
            # — walker stops AFTER applying this scene so its own
            # adds / modifies / removes are reflected). Off-screen
            # scenes (chain_index == 0) aren't on the POV chain and
            # have no chain-walked state — only temporaries surface
            # for those.
            if chain_index > 0:
                walked = _walk_entity_state_forward(
                    entity=entity,
                    source_story=source_story,
                    boundary_node_id=node.id,
                    inclusive=True,
                )
                ongoing_circs = [a for a in (walked.attributes or []) if getattr(a, "attribute_type", None) == "circumstance"]
                ongoing_mots = [a for a in (walked.attributes or []) if getattr(a, "attribute_type", None) == "motivator"]
                for a in ongoing_circs:
                    a_intensity = getattr(a, "intensity", None)
                    entity_rows.append(ExportSceneCMRow(
                        prefix="Circumstance",
                        name=a.name or "",
                        description=getattr(a, "description", "") or "",
                        intensity_label=_format_intensity(a_intensity),
                        intensity=a_intensity,
                    ))
                for a in ongoing_mots:
                    a_intensity = getattr(a, "intensity", None)
                    entity_rows.append(ExportSceneCMRow(
                        prefix="Motivator",
                        name=a.name or "",
                        description=getattr(a, "description", "") or "",
                        intensity_label=_format_intensity(a_intensity),
                        intensity=a_intensity,
                    ))

            if entity_rows:
                groups.append(ExportSceneCMGroup(
                    kind="entity",
                    entity_id=entity_id,
                    label=display_name or "(unnamed)",
                    entity_type=type_label,
                    rows=entity_rows,
                ))

    return groups


def _resolve_pov_entity_name(
    node: SceneNode,
    entities_by_id: dict[str, tuple[Entity, str]],
) -> Optional[str]:
    """Return the effective display name of the character carrying POV
    in this scene, or None if no POV is attached. Checks the explicit
    `pov_entity_id` field first (persisted form), then falls back to
    scanning the scene's character EntityRefs for a `has_pov=True` flag
    (legacy stories before v0.1.9.85). Applies any `name_change` on the
    POV character's ref so the name reflects what the reader sees IN
    this scene, not the origin state.
    """
    pov_id = node.pov_entity_id
    if not pov_id:
        for ref in node.characters:
            if ref.has_pov:
                pov_id = ref.entity_id
                break
    if not pov_id:
        return None
    # Prefer the name_change on the matching character ref if present.
    effective_name: Optional[str] = None
    for ref in node.characters:
        if ref.entity_id == pov_id:
            if ref.name_change:
                effective_name = ref.name_change
            break
    if effective_name:
        return effective_name
    entry = entities_by_id.get(pov_id)
    return entry[0].name if entry else None


def _build_scene_changes(
    node: SceneNode,
    entities_by_id: dict[str, tuple[Entity, str]],
    profile_uri_by_entity_id: dict[str, Optional[str]],
    *,
    story_relationships: "list[Relationship]" = (),
    include_alias_changes: bool = True,
    include_awareness_changes: bool = True,
) -> list[ExportSceneEntityChange]:
    """Walk every EntityRef across every bucket on the scene and emit
    a one-entry-per-entity change block carrying the SPECIFIC details
    of what was modified (field names, new values, partner entity
    names for relationship changes). Entities with no changes recorded
    on their ref are omitted entirely so the block only appears when
    there's actually something to show.

    Phase 1.25c — also walks every `story_relationships[*].history`
    array and emits per-scene relationship-event rows. Events that
    name an `entity_id` (participant join/leave, perception change,
    alias override, role change) are attributed to that entity's
    group; relationship-level events (existence, name, hierarchy,
    description) are attributed to the relationship's first
    participant in story order so they land somewhere readable.
    """
    out: list[ExportSceneEntityChange] = []
    # Phase 1.21c: `node.knowledges` removed — knowledges are no longer
    # entity chips in scenes.
    buckets = [
        ("character", node.characters),
        ("location", node.locations),
        ("item", node.items),
        ("faction", node.factions),
        ("custom", node.customs),
    ]
    # Map entity_id → list of details accumulated so far. Lets the
    # relationship-event pass merge into the same group as the
    # entity-ref-change pass when both fire on the same scene.
    by_entity: dict[str, list[ExportChangeDetail]] = {}
    for type_name, refs in buckets:
        for ref in refs:
            details = _detail_entity_ref_changes(
                ref, entities_by_id,
                scene_id=node.id,
                include_alias_changes=include_alias_changes,
                include_awareness_changes=include_awareness_changes,
            )
            if not details:
                continue
            by_entity.setdefault(ref.entity_id, []).extend(details)

    # Phase 1.25c — relationship-incident events at this scene.
    rel_details_by_entity = _build_relationship_event_details(
        node=node,
        story_relationships=list(story_relationships or []),
        entities_by_id=entities_by_id,
    )
    for ent_id, rel_details in rel_details_by_entity.items():
        by_entity.setdefault(ent_id, []).extend(rel_details)

    # Materialise output. Order matches first-seen entity in scene
    # buckets, then any relationship-only entities tail-appended.
    seen_in_buckets: list[str] = []
    for _, refs in buckets:
        for ref in refs:
            if ref.entity_id in by_entity and ref.entity_id not in seen_in_buckets:
                seen_in_buckets.append(ref.entity_id)
    for ent_id in list(by_entity.keys()):
        if ent_id not in seen_in_buckets:
            seen_in_buckets.append(ent_id)

    for ent_id in seen_in_buckets:
        details = by_entity.get(ent_id) or []
        if not details:
            continue
        # Effective name / colour — prefer the entity's ref on this
        # node when present, otherwise origin.
        entry = entities_by_id.get(ent_id)
        library_name = entry[0].name if entry else ent_id
        library_colour = entry[0].colour if entry else None
        ref_for_entity = _find_ref_in_node(ent_id, node)
        display_name = (ref_for_entity.name_change if ref_for_entity else None) or library_name
        display_colour = (ref_for_entity.colour_change if ref_for_entity else None) or library_colour
        # Bucket type for the entity (default 'character' if unknown,
        # which only happens for an unresolved id).
        type_name = "character"
        if entry:
            bucket_name = entry[1]
            type_name = bucket_name.rstrip("s") if bucket_name != "customs" else "custom"
        out.append(ExportSceneEntityChange(
            entity_id=ent_id,
            entity_name=display_name,
            entity_type=type_name,
            profile_image_data_uri=profile_uri_by_entity_id.get(ent_id),
            colour=display_colour,
            details=details,
        ))
    return out


def _find_ref_in_node(entity_id: str, node: SceneNode) -> Optional["EntityRef"]:
    """Return the `EntityRef` for `entity_id` on this scene, scanning
    every bucket. None when the entity has no chip in this scene."""
    for refs in (node.characters, node.locations, node.items, node.factions, node.customs):
        for ref in refs:
            if ref.entity_id == entity_id:
                return ref
    return None


def _build_relationship_event_details(
    *,
    node: SceneNode,
    story_relationships: list,
    entities_by_id: dict[str, tuple[Entity, str]],
) -> dict[str, list[ExportChangeDetail]]:
    """Phase 1.25c — for each Relationship, find every history event
    whose `node_id` matches this scene; emit one
    `ExportChangeDetail(category='relationship', ...)` per event,
    attributed to the most natural participant entity for the event
    kind.

    Returns: `{entity_id: [details, ...]}` ready to merge into the
    scene-changes by_entity dict.

    Attribution rules:
      - participant join/leave  → ch.entity_id
      - perception change       → ch.entity_id
      - alias override change   → ch.entity_id
      - role change             → ch.entity_id
      - existence change        → first participant (or skip when no participants known)
      - name change             → first participant
      - description change      → first participant
      - hierarchy change        → first participant
    """
    out: dict[str, list[ExportChangeDetail]] = {}

    def _participants_in_order(rel) -> list[str]:
        seen: set[str] = set()
        ids: list[str] = []
        for ch in (rel.history.participant_changes or []):
            if ch.action == "join" and ch.entity_id not in seen:
                seen.add(ch.entity_id)
                ids.append(ch.entity_id)
        return ids

    def _rel_label(rel) -> str:
        try:
            from services.relationship_label import resolve_relationship_label
            name_map = {eid: ent.name for eid, (ent, _) in entities_by_id.items()}
            return resolve_relationship_label(rel, name_map) or "Relationship"
        except Exception:
            return rel.name or "Relationship"

    for rel in story_relationships:
        if not rel or not rel.history:
            continue
        rel_label = _rel_label(rel)
        first_participant: Optional[str] = None
        participants = _participants_in_order(rel)
        if participants:
            first_participant = participants[0]

        # participant_changes — join / leave
        for ch in (rel.history.participant_changes or []):
            if ch.node_id != node.id:
                continue
            other_ids = [p for p in participants if p != ch.entity_id]
            other_label = "; ".join(
                entities_by_id[oid][0].name for oid in other_ids if oid in entities_by_id
            ) or rel_label
            verb = "Joined" if ch.action == "join" else "Left"
            text = f'{verb} relationship "{rel_label}"'
            if other_label and other_label != rel_label:
                text += f" with {other_label}"
            out.setdefault(ch.entity_id, []).append(ExportChangeDetail(
                category="relationship",
                text=text,
                action=("add" if ch.action == "join" else "remove"),
                field_name=f'Relationship: {rel_label}',
            ))

        # perception_changes
        for ch in (rel.history.perception_changes or []):
            if ch.node_id != node.id:
                continue
            preview = _shorten(ch.new_perception or "", 120)
            out.setdefault(ch.entity_id, []).append(ExportChangeDetail(
                category="relationship",
                text=f'Perception of "{rel_label}" → "{preview}"',
                action="modify",
                field_name=f'Perception of {rel_label}',
                new_value=preview if preview else None,
            ))

        # alias_changes — alias override per participant
        for ch in (rel.history.alias_changes or []):
            if ch.node_id != node.id:
                continue
            new_alias = ch.new_alias_override
            if new_alias:
                out.setdefault(ch.entity_id, []).append(ExportChangeDetail(
                    category="relationship",
                    text=f'Alias in "{rel_label}" → "{new_alias}"',
                    action="modify",
                    field_name=f'Alias in {rel_label}',
                    new_value=new_alias,
                ))
            else:
                out.setdefault(ch.entity_id, []).append(ExportChangeDetail(
                    category="relationship",
                    text=f'Alias in "{rel_label}" cleared',
                    action="remove",
                    field_name=f'Alias in {rel_label}',
                ))

        # role_changes
        for ch in (rel.history.role_changes or []):
            if ch.node_id != node.id:
                continue
            new_role = ch.new_role
            if new_role:
                out.setdefault(ch.entity_id, []).append(ExportChangeDetail(
                    category="relationship",
                    text=f'Role in "{rel_label}" → "{new_role}"',
                    action="modify",
                    field_name=f'Role in {rel_label}',
                    new_value=str(new_role),
                ))
            else:
                out.setdefault(ch.entity_id, []).append(ExportChangeDetail(
                    category="relationship",
                    text=f'Role in "{rel_label}" cleared',
                    action="remove",
                    field_name=f'Role in {rel_label}',
                ))

        # awareness chain entries (post v0.2a.2.5 migration) — entries
        # on `rel.awareness.history` are attributed to the OBSERVER
        # entity. Pre-migration these lived on EntityRef.awareness_changes
        # with `target='relationship'`; post-migration they live on the
        # relationship's own awareness wrapper. Per-observer entries
        # only; tracking on/off and source-projection mutations are
        # awareness-layer state changes that don't surface as
        # per-observer rows in the export.
        rel_aware = getattr(rel, "awareness", None)
        if isinstance(rel_aware, AwarenessWrapper) and rel_aware.history:
            for ach in rel_aware.history:
                if getattr(ach, "node_id", None) != node.id:
                    continue
                if getattr(ach, "tracking_action", None) is not None:
                    continue
                src_action = getattr(ach, "source_action", None)
                if src_action:
                    # No clear observer to attribute a source mutation
                    # to; attribute to the first participant for visibility.
                    target_id = first_participant
                    if target_id is None:
                        continue
                    out.setdefault(target_id, []).append(ExportChangeDetail(
                        category="relationship",
                        text=f'Awareness of "{rel_label}": source {src_action}',
                        action="modify",
                        field_name=f'Awareness of {rel_label}',
                        new_value=src_action,
                    ))
                    continue
                observer = getattr(ach, "observer_id", "") or ""
                if not observer:
                    continue
                level = getattr(ach, "level", None)
                if level is None:
                    out.setdefault(observer, []).append(ExportChangeDetail(
                        category="relationship",
                        text=f'Awareness of "{rel_label}" cleared',
                        action="remove",
                        field_name=f'Awareness of {rel_label}',
                    ))
                else:
                    out.setdefault(observer, []).append(ExportChangeDetail(
                        category="relationship",
                        text=f'Awareness of "{rel_label}" → level {level}',
                        action="modify",
                        field_name=f'Awareness of {rel_label}',
                        new_value=f"level {level}",
                    ))

        # Relationship-level events — attribute to first participant.
        if first_participant is None:
            continue

        for ch in (rel.history.existence_changes or []):
            if ch.node_id != node.id:
                continue
            active = getattr(ch, "active", False)
            text = (
                f'Relationship "{rel_label}" activated' if active
                else f'Relationship "{rel_label}" deactivated'
            )
            out.setdefault(first_participant, []).append(ExportChangeDetail(
                category="relationship",
                text=text,
                action=("add" if active else "remove"),
                field_name=f'Relationship: {rel_label}',
            ))

        for ch in (rel.history.name_changes or []):
            if ch.node_id != node.id:
                continue
            new_name = ch.new_name
            text = (
                f'Relationship renamed to "{new_name}"' if new_name
                else f'Relationship name cleared (was "{rel_label}")'
            )
            out.setdefault(first_participant, []).append(ExportChangeDetail(
                category="relationship",
                text=text,
                action="modify",
                field_name=f'Relationship name',
                new_value=new_name or None,
            ))

        for ch in (rel.history.description_changes or []):
            if ch.node_id != node.id:
                continue
            preview = _shorten(ch.new_description or "", 120)
            text = (
                f'Description of "{rel_label}" → "{preview}"' if preview
                else f'Description of "{rel_label}" cleared'
            )
            out.setdefault(first_participant, []).append(ExportChangeDetail(
                category="relationship",
                text=text,
                action=("modify" if preview else "remove"),
                field_name=f'Description of {rel_label}',
                new_value=preview if preview else None,
            ))

        for ch in (rel.history.hierarchy_changes or []):
            if ch.node_id != node.id:
                continue
            new_h = ch.new_hierarchy
            text = (
                f'Hierarchy of "{rel_label}" set' if new_h
                else f'Hierarchy of "{rel_label}" cleared'
            )
            out.setdefault(first_participant, []).append(ExportChangeDetail(
                category="relationship",
                text=text,
                action=("modify" if new_h else "remove"),
                field_name=f'Hierarchy of {rel_label}',
            ))

    return out


def _detail_entity_ref_changes(
    ref: EntityRef,
    entities_by_id: dict[str, tuple[Entity, str]],
    *,
    scene_id: Optional[str] = None,
    include_alias_changes: bool = True,
    include_awareness_changes: bool = True,
) -> list[ExportChangeDetail]:
    """Build the full list of `ExportChangeDetail` entries for one
    EntityRef. Each returned detail is a specific change with its
    category marker so the renderer can filter against the granular
    toggles. Attribute names are resolved from the entity's origin
    `attributes` list; relationship partner names are resolved from
    the entity library via `entities_by_id`."""
    details: list[ExportChangeDetail] = []

    # Metadata-level changes (name / colour / description / profile image).
    # Each detail carries both the pre-formatted `text` (used by
    # text-only renderers) AND the structured `action` / `field_name`
    # / `old_value` / `new_value` fields (used by HTML / DOCX / PDF
    # subchip rendering).
    if ref.name_change is not None:
        details.append(ExportChangeDetail(
            category="metadata",
            text=f'Renamed to "{ref.name_change}"',
            action="modify",
            field_name="Name",
            new_value=ref.name_change,
        ))
    if ref.colour_change is not None:
        details.append(ExportChangeDetail(
            category="metadata",
            text=f'Colour → {ref.colour_change}',
            action="modify",
            field_name="Colour",
            new_value=ref.colour_change,
        ))
    if ref.description_change is not None:
        preview = _shorten(ref.description_change, 120)
        if preview:
            details.append(ExportChangeDetail(
                category="metadata",
                text=f'Description → "{preview}"',
                action="modify",
                field_name="Description",
                new_value=preview,
            ))
        else:
            details.append(ExportChangeDetail(
                category="metadata",
                text='Description cleared',
                action="remove",
                field_name="Description",
            ))
    if ref.profile_image_change is not None:
        if ref.profile_image_change == "":
            details.append(ExportChangeDetail(
                category="metadata",
                text="Profile image cleared",
                action="remove",
                field_name="Profile image",
            ))
        else:
            details.append(ExportChangeDetail(
                category="metadata",
                text="Profile image replaced",
                new_image_data_uri=_asset_to_data_uri(ref.profile_image_change),
                action="modify",
                field_name="Profile image",
            ))

    # Attribute changes — specific field/value per entry. The text
    # form remains the existing multi-fragment string; the structured
    # fields cover the common shapes (add / remove / modify of a
    # single named attribute). Compound modifies (multiple `new_*`
    # fields stacked on one change) and list ops keep their
    # text-only output — subchip rendering for those is deferred
    # until the simpler shapes are in place.
    owner_entry = entities_by_id.get(ref.entity_id)
    owner_attributes = owner_entry[0].attributes if owner_entry else []
    attr_name_by_id: dict[str, str] = {a.id: a.name for a in owner_attributes}
    for change in ref.attribute_changes:
        text = _describe_attribute_change(change, attr_name_by_id, entities_by_id)
        if not text:
            continue
        structured = _structured_attribute_change(change, attr_name_by_id)
        details.append(ExportChangeDetail(
            category="attribute",
            text=text,
            action=structured.get("action"),
            field_name=structured.get("field_name"),
            old_value=structured.get("old_value"),
            new_value=structured.get("new_value"),
        ))

    # 2026-05-17 — alias chain events on `alias_changes`. Each event
    # renders as its own export detail: add → "Alias added: X"; remove
    # → "Alias removed: X" (with the value looked up from the entity
    # baseline + any `add` events in THIS scene). Per-alias awareness
    # events are not rendered here today (per-alias awareness is its
    # own sub-bullet of the aliases bugfix arc). Legacy `aliases_change`
    # snapshot read path retained for transitional saves that
    # bypassed migration. The value-lookup fallback is intentionally
    # coarse — a `remove` event targeting an alias added at an
    # upstream scene (not in baseline, not in this scene's adds)
    # renders as "(unknown)" rather than walking the chain to recover
    # the value. Acceptable for export rendering; the alternative is
    # a full chain walk per scene which costs more than it's worth
    # for export-detail text.
    alias_events = getattr(ref, "alias_changes", None) or []
    if alias_events and include_alias_changes:
        # Build a value lookup keyed by alias_id from the entity's
        # baseline aliases + any `add` events in this scene's events
        # list (so an add+remove in the same scene is renderable).
        host_pair = entities_by_id.get(ref.entity_id)
        host_entity = host_pair[0] if host_pair else None
        value_by_id = {}
        if host_entity:
            for a in (host_entity.aliases or []):
                aid = getattr(a, "id", None)
                if aid:
                    value_by_id[aid] = getattr(a, "value", None)
        for ev in alias_events:
            if getattr(ev, "action", None) == "add" and getattr(ev, "alias", None):
                if getattr(ev.alias, "id", None):
                    value_by_id[ev.alias.id] = ev.alias.value
        for ev in alias_events:
            action = getattr(ev, "action", None)
            if action == "add" and getattr(ev, "alias", None) and getattr(ev.alias, "value", None):
                details.append(ExportChangeDetail(
                    category="metadata",
                    text=f'Alias added: {ev.alias.value}',
                    action="add",
                    field_name="Alias",
                    new_value=ev.alias.value,
                ))
            elif action == "remove" and getattr(ev, "alias_id", None):
                value = value_by_id.get(ev.alias_id, "(unknown)")
                details.append(ExportChangeDetail(
                    category="metadata",
                    text=f'Alias removed: {value}',
                    action="remove",
                    field_name="Alias",
                    old_value=value,
                ))
            elif action == "modify" and getattr(ev, "alias_id", None) and getattr(ev, "new_value", None) is not None:
                old_value = value_by_id.get(ev.alias_id, "(unknown)")
                details.append(ExportChangeDetail(
                    category="metadata",
                    text=f'Alias renamed: {old_value} → {ev.new_value}',
                    action="modify",
                    field_name="Alias",
                    old_value=old_value,
                    new_value=ev.new_value,
                ))
            # awareness_set / awareness_source_* events are not
            # rendered here today; per-alias awareness rendering ships
            # with the per-alias awareness tie sub-bullet.

    # Phase 1.25c (post v0.2a.2.5 migration) — awareness mutations.
    # Reads from the canonical per-host `awareness.history` wrappers
    # on the actual Entity (resolved via `entities_by_id`), filtered to
    # entries anchored at this scene (`node_id == scene_id`).
    # Targets handled inline:
    #   - entity        → entity.awareness.history
    #   - entity_name   → entity.name_awareness.history
    #   - alias         → each alias.awareness.history
    #   - attribute     → each attribute.awareness.history
    # `target=='relationship'` lives on the relationship's own
    # awareness wrapper; that pass runs in `_build_scene_changes`
    # so the entry is attributed to the OBSERVER entity (not the
    # carrier EntityRef this function describes).
    if include_awareness_changes and scene_id:
        entry = entities_by_id.get(ref.entity_id)
        host_entity = entry[0] if entry else None
        if host_entity is not None:
            def _emit_awareness_entries(host, target_label):
                aware = getattr(host, "awareness", None)
                if not isinstance(aware, AwarenessWrapper) or not aware.history:
                    return
                for ach in aware.history:
                    if getattr(ach, "node_id", None) != scene_id:
                        continue
                    if getattr(ach, "tracking_action", None) is not None:
                        continue
                    src_action = getattr(ach, "source_action", None)
                    if src_action:
                        details.append(ExportChangeDetail(
                            category="metadata",
                            text=f"Awareness ({target_label}): source {src_action}",
                            action="modify",
                            field_name=f"Awareness ({target_label})",
                            new_value=src_action,
                        ))
                        continue
                    observer = getattr(ach, "observer_id", "") or ""
                    if not observer:
                        continue
                    observer_entry = entities_by_id.get(observer)
                    observer_name = observer_entry[0].name if observer_entry else observer
                    level = getattr(ach, "level", None)
                    if level is None:
                        details.append(ExportChangeDetail(
                            category="metadata",
                            text=f"Awareness ({target_label}) cleared for {observer_name or '(observer)'}",
                            action="remove",
                            field_name=f"Awareness of {observer_name or 'observer'}",
                        ))
                    else:
                        details.append(ExportChangeDetail(
                            category="metadata",
                            text=f"Awareness ({target_label}) → level {level} for {observer_name or '(observer)'}",
                            action="modify",
                            field_name=f"Awareness of {observer_name or 'observer'}",
                            new_value=f"level {level}",
                        ))
            # Use a stub host with `awareness=...` for fields that aren't
            # named `awareness` on the source object (name_awareness, etc.).
            class _AwareHost:
                def __init__(self, w):
                    self.awareness = w
            _emit_awareness_entries(host_entity, "entity")
            _emit_awareness_entries(_AwareHost(getattr(host_entity, "name_awareness", None)), "entity_name")
            for alias in (getattr(host_entity, "aliases", None) or []):
                _emit_awareness_entries(alias, "alias")
            for attr in (getattr(host_entity, "attributes", None) or []):
                _emit_awareness_entries(attr, "attribute")

    return details


def _structured_attribute_change(change, attr_name_by_id: dict[str, str]) -> dict:
    """Return the subchip-shaped structured fields (action /
    field_name / old_value / new_value) for an AttributeChange.

    Handles the simple shapes (add / remove of a single attribute,
    single-field modify). Compound modifies and list ops return
    `{action: None}` so the renderer falls back to the pre-formatted
    text — subchip rendering for those is deferred.
    """
    action = change.action
    if action == "add":
        attr = change.attribute
        if attr is None:
            return {"action": None}
        new_value = None
        if attr.attribute_type not in ("file", "text_list", "entity_list"):
            preview = _shorten(attr.value or "", 120)
            if preview:
                new_value = preview
        return {
            "action": "add",
            "field_name": attr.name or "(unnamed)",
            "old_value": None,
            "new_value": new_value,
        }
    if action == "remove":
        name = attr_name_by_id.get(change.attribute_id or "", "")
        return {
            "action": "remove",
            "field_name": name or "(attribute)",
        }
    if action == "rename":
        old_name = attr_name_by_id.get(change.attribute_id or "", "")
        new_name = change.new_name or ""
        return {
            "action": "modify",
            "field_name": "Attribute name",
            "old_value": old_name or None,
            "new_value": new_name or None,
        }
    if action == "modify":
        # Single-field modify only — compound modifies (multiple
        # `new_*` populated) fall through to text-only because the
        # structured shape is one field at a time.
        non_null_count = sum(
            1 for v in (
                change.new_value, change.new_description,
                change.new_intensity, change.new_number_value,
                change.new_name, change.file_ref_change,
            ) if v is not None
        )
        if non_null_count != 1:
            return {"action": None}
        name = attr_name_by_id.get(change.attribute_id or "", "")
        if change.new_value is not None:
            preview = _shorten(change.new_value, 120)
            return {
                "action": "modify",
                "field_name": name or "Value",
                "new_value": preview if preview else None,
            }
        if change.new_description is not None:
            preview = _shorten(change.new_description, 120)
            return {
                "action": "modify",
                "field_name": f"{name} description" if name else "Description",
                "new_value": preview if preview else None,
            }
        if change.new_intensity is not None:
            try:
                lv = max(0, min(4, int(change.new_intensity)))
                label = _format_intensity(lv) or f"tier {lv + 1}/5"
            except (TypeError, ValueError):
                label = str(change.new_intensity)
            return {
                "action": "modify",
                "field_name": f"{name} intensity" if name else "Intensity",
                "new_value": label,
            }
        if change.new_number_value is not None:
            return {
                "action": "modify",
                "field_name": name or "Value",
                "new_value": str(change.new_number_value),
            }
        if change.new_name is not None:
            return {
                "action": "modify",
                "field_name": "Name",
                "new_value": change.new_name,
            }
        if change.file_ref_change is not None:
            return {
                "action": "modify" if change.file_ref_change else "remove",
                "field_name": f"{name} file" if name else "File",
            }
    return {"action": None}


def _describe_attribute_change(
    change: "AttributeChange",  # noqa: F821 — forward ref to avoid top-of-file import churn
    attr_name_by_id: dict[str, str],
    entities_by_id: dict[str, tuple[Entity, str]],
) -> str:
    """Render one AttributeChange as a human-readable line.

    Notes on resolution:
    - For 'modify': we can only show the NEW value cleanly. The
      previous value would require walking the entity's chain back
      through prior scenes to compute effective state, which is
      deferred (end-of-chain walking is parked in the plan). For now
      we show the new value on its own.
    - For 'add': the full Attribute is embedded in `change.attribute`,
      so both name and value are available directly.
    - For 'remove': only the attribute_id is present. Look up its
      name in the origin attributes; if the attribute was added
      mid-chain (not in origin), fall back to the raw id.
    - For list ops: `list_item` is the added/removed item. If the
      parent attribute is an `entity_list`, the item is an entity
      UUID — resolve it to a name via entities_by_id.
    """
    action = change.action
    if action == "add":
        if change.attribute is None:
            return ""
        attr = change.attribute
        if attr.attribute_type == "file":
            return f'Added attribute "{attr.name}" (file: {attr.file_ref or "empty"})'
        if attr.attribute_type in ("text_list", "entity_list"):
            return f'Added attribute "{attr.name}" (empty list)'
        if attr.attribute_type == "perspective":
            # Phase 5.8b — show the perspective body so the change block
            # reads meaningfully (its target lives on the entity sheet).
            body = _shorten(getattr(attr, "description", "") or "", 120)
            return f'Added perspective "{attr.name}": {body}' if body else f'Added perspective "{attr.name}"'
        value_preview = _shorten(attr.value or "", 120)
        if value_preview:
            return f'Added attribute "{attr.name}" = "{value_preview}"'
        return f'Added attribute "{attr.name}"'

    if action == "modify":
        name = attr_name_by_id.get(change.attribute_id or "", "")
        label = f'"{name}"' if name else "an attribute"
        # Per-field modify payloads can stack on a single AttributeChange
        # (a multi-field Save commits one change with multiple `new_*`
        # fields populated). Emit one fragment per non-null field and
        # join with " · " so the row carries every detail of the modify.
        fragments: list[str] = []
        if change.file_ref_change is not None:
            fragments.append(
                f"{label} file cleared" if change.file_ref_change == ""
                else f"{label} file replaced"
            )
            label = ""  # subsequent fragments don't repeat the label
        if change.new_value is not None:
            preview = _shorten(change.new_value, 120)
            head = label or "value"
            fragments.append(
                f'{head} → "{preview}"' if preview else f"{head} cleared"
            )
            label = ""
        # Phase 1.22 — circumstance / motivator description + intensity.
        if change.new_description is not None:
            preview = _shorten(change.new_description, 120)
            head = label or "description"
            fragments.append(
                f'{head} description → "{preview}"' if label
                else (f'description → "{preview}"' if preview else "description cleared")
            )
            label = ""
        if change.new_intensity is not None:
            try:
                lv = max(0, min(4, int(change.new_intensity)))
                intensity_text = _format_intensity(lv) or f"tier {lv + 1}/5"
            except (TypeError, ValueError):
                intensity_text = str(change.new_intensity)
            head = label or "intensity"
            fragments.append(
                f"{head} intensity → {intensity_text}" if label
                else f"intensity → {intensity_text}"
            )
            label = ""
        if change.new_number_value is not None:
            head = label or "number value"
            fragments.append(
                f"{head} → {change.new_number_value}" if label
                else f"value → {change.new_number_value}"
            )
            label = ""
        # Phase 1.22 rename rides on the dedicated `rename` action below,
        # but a `modify` may also carry `new_name` if the field is reused
        # by future code. Surface it if set.
        if change.new_name is not None:
            head = label or "name"
            fragments.append(
                f'{head} → "{change.new_name}"' if label
                else f'name → "{change.new_name}"'
            )
            label = ""
        if fragments:
            return " · ".join(fragments)
        return f'"{name}" modified' if name else "an attribute modified"

    if action == "rename":
        name = attr_name_by_id.get(change.attribute_id or "", "")
        old = f'"{name}"' if name else "an attribute"
        new_name = change.new_name or ""
        if new_name:
            return f'{old} renamed to "{new_name}"'
        return f"{old} renamed"

    if action == "remove":
        name = attr_name_by_id.get(change.attribute_id or "", "")
        if name:
            return f'Removed attribute "{name}"'
        return "Removed an attribute"

    if action == "list_add":
        name = attr_name_by_id.get(change.attribute_id or "", "")
        label = f'"{name}"' if name else "a list attribute"
        item = change.list_item or ""
        # Try entity name resolution if the raw id matches a known entity.
        resolved = entities_by_id.get(item)
        if resolved:
            return f'{label}: added {resolved[0].name}'
        return f'{label}: added "{item}"' if item else f'{label}: added an item'

    if action == "list_remove":
        name = attr_name_by_id.get(change.attribute_id or "", "")
        label = f'"{name}"' if name else "a list attribute"
        item = change.list_item or ""
        resolved = entities_by_id.get(item)
        if resolved:
            return f'{label}: removed {resolved[0].name}'
        return f'{label}: removed "{item}"' if item else f'{label}: removed an item'

    return ""




def _shorten(text: str, max_len: int) -> str:
    """Collapse whitespace and truncate to at most `max_len` chars
    with an ellipsis. Used for description / attribute value previews
    in change lines so a paragraph-length value doesn't blow out the
    scene changes block layout."""
    if text is None:
        return ""
    s = " ".join(text.split())
    if len(s) <= max_len:
        return s
    return s[: max_len - 1].rstrip() + "…"


def _build_entity_context_groups(
    node: SceneNode,
    entities_by_id: dict[str, tuple[Entity, str]],
    profile_uri_by_entity_id: dict[str, Optional[str]],
    mode: str,
) -> list[ExportSceneEntityGroup]:
    """Build the per-bucket entity context groups for one scene. Mode:

    - "off": always empty list.
    - "minimal" (default): bucket labels + entity names only.
    - "full": same as minimal for now; placeholder for a richer
      effective-state render (deferred per the Phase 1.12a plan).

    Each bucket is one `ExportSceneEntityGroup` carrying the bucket's
    label (with singular/plural handling) and a list of
    `ExportSceneEntityEntry` items per entity present. Each entry
    carries the entity id and profile image data URI so the renderer
    can link to the entity reference sheet anchor and show a hover
    popover with the profile image.
    """
    if mode == "off":
        return []

    def entries_for(refs: list[EntityRef]) -> list[ExportSceneEntityEntry]:
        out: list[ExportSceneEntityEntry] = []
        for ref in refs:
            ent_entry = entities_by_id.get(ref.entity_id)
            if not ent_entry:
                continue
            ent, _bucket = ent_entry
            # Apply any name_change / colour_change recorded on the
            # ref so the context reflects "current-at-this-scene"
            # rather than origin. Matches the ExportSceneEntityChange
            # pattern — ref override OR library value.
            name = ref.name_change if ref.name_change else ent.name
            colour = ref.colour_change if ref.colour_change else ent.colour
            out.append(ExportSceneEntityEntry(
                id=ref.entity_id,
                name=name,
                profile_image_data_uri=profile_uri_by_entity_id.get(ref.entity_id),
                colour=colour,
            ))
        return out

    # Phase 1.21c: `node.knowledges` removed — knowledges are no longer
    # entity chips in scenes.
    buckets: list[tuple[Literal["character", "location", "item", "faction", "custom"], str, list[EntityRef]]] = [
        ("character", "Characters", node.characters),
        ("location", "Locations", node.locations),
        ("item", "Items", node.items),
        ("faction", "Factions", node.factions),
        ("custom", "Customs", node.customs),
    ]
    groups: list[ExportSceneEntityGroup] = []
    for bucket_kind, plural_label, refs in buckets:
        if not refs:
            continue
        entries = entries_for(refs)
        if not entries:
            continue
        label = plural_label.rstrip("s") if len(entries) == 1 else plural_label
        groups.append(ExportSceneEntityGroup(
            bucket=bucket_kind,
            label=label,
            entries=entries,
        ))
    return groups


# ── Entity reference sheets ────────────────────────────────────────────


def _iter_entities_in_library_order(story: Story):
    """Yield (entity, type_name) pairs in the canonical library order:
    characters → locations → items → factions → customs.
    """
    # Phase 1.21c: "knowledge" removed — Knowledge is no longer an
    # Entity subtype. Entity reference sheet emission doesn't include
    # knowledges; knowledges are surfaced through their own export
    # path (TBD — currently not emitted by any renderer; will be
    # revisited as part of Phase 1.25 Export & Import review).
    for type_name in ("character", "location", "item", "faction", "custom"):
        bucket_attr = type_name + "s" if type_name != "custom" else "customs"
        bucket = getattr(story.entities, bucket_attr, None) or []
        for ent in bucket:
            yield ent, type_name


def _build_knowledge_sheet(
    *,
    knowledge,  # Knowledge — type kept loose to avoid an extra import
    embed_assets: bool,
    include_chain_history: bool,
    pov_sequence: list[SceneNode],
    scenes_by_id: dict[str, SceneNode],
) -> ExportKnowledgeSheet:
    """Phase 1.25c — build one Knowledge appendix entry. Origin
    baseline (name / description / colour / profile image / notes)
    plus optional chain history (scene-ordered list of every
    `KnowledgeHistory.*_changes` event).

    Chain history is a write-time-normalised sequence of mutations,
    each anchored by `node_id`. We resolve `node_id → scene title`
    via `scenes_by_id`, sort the combined event list by
    POV-chain index (with off-pov scenes pushed to the end), and
    return them as `ExportKnowledgeChainEntry` rows."""
    profile_uri = (
        _asset_to_data_uri(knowledge.profile_image_ref)
        if (embed_assets and knowledge.profile_image_ref) else None
    )
    # Source event back-pointer → scene title for display.
    source_scene_id: Optional[str] = None
    source_scene_title: Optional[str] = None
    if knowledge.source_event and knowledge.source_event.node_id:
        node_id = knowledge.source_event.node_id
        source_scene_id = node_id
        scene = scenes_by_id.get(node_id)
        if scene is not None:
            source_scene_title = scene.title or ""

    chain_history: list[ExportKnowledgeChainEntry] = []
    if include_chain_history:
        chain_history = _build_knowledge_chain_history(
            knowledge=knowledge,
            pov_sequence=pov_sequence,
            scenes_by_id=scenes_by_id,
        )

    return ExportKnowledgeSheet(
        id=knowledge.id,
        name=knowledge.name,
        description=knowledge.description or "",
        colour=knowledge.colour,
        profile_image_data_uri=profile_uri,
        notes=knowledge.notes or "",
        source_event_scene_id=source_scene_id,
        source_event_scene_title=source_scene_title,
        chain_history=chain_history,
    )


def _build_knowledge_chain_history(
    *,
    knowledge,
    pov_sequence: list[dict],
    scenes_by_id: dict[str, SceneNode],
) -> list[ExportKnowledgeChainEntry]:
    """Flatten every `KnowledgeHistory.*_changes` array into a single
    scene-ordered list of `ExportKnowledgeChainEntry` rows. Off-POV
    scenes get `chain_index=0` and sort to the end.

    `pov_sequence` is the POV path as a list of dicts (`{"node_id",
    "index", ...}`), the same shape used elsewhere in this module, not
    SceneNode objects."""
    pov_index_by_scene: dict[str, int] = {
        entry["node_id"]: entry.get("index", idx)
        for idx, entry in enumerate(pov_sequence, start=1)
        if entry.get("node_id")
    }
    rows: list[tuple[int, ExportKnowledgeChainEntry]] = []

    history = getattr(knowledge, "history", None)
    if history is None:
        return []

    def _scene_meta(node_id: Optional[str]) -> tuple[Optional[str], Optional[str], int]:
        if not node_id:
            return None, None, 0
        scene = scenes_by_id.get(node_id)
        title = (scene.title if scene else "") or ""
        idx = pov_index_by_scene.get(node_id, 0)
        return node_id, title, idx

    for change in (history.existence_changes or []):
        node_id, title, idx = _scene_meta(getattr(change, "node_id", None))
        verb = "Activated" if getattr(change, "active", False) else "Deactivated"
        rows.append((idx, ExportKnowledgeChainEntry(
            kind="existence",
            text=verb,
            scene_id=node_id, scene_title=title, chain_index=idx,
        )))
    for change in (history.name_changes or []):
        node_id, title, idx = _scene_meta(getattr(change, "node_id", None))
        new_name = getattr(change, "new_name", "") or ""
        rows.append((idx, ExportKnowledgeChainEntry(
            kind="name",
            text=f'Renamed to "{new_name}"',
            scene_id=node_id, scene_title=title, chain_index=idx,
        )))
    for change in (history.description_changes or []):
        node_id, title, idx = _scene_meta(getattr(change, "node_id", None))
        preview = _shorten(getattr(change, "new_description", "") or "", 120)
        rows.append((idx, ExportKnowledgeChainEntry(
            kind="description",
            text=(f'Description → "{preview}"' if preview else "Description cleared"),
            scene_id=node_id, scene_title=title, chain_index=idx,
        )))
    for change in (history.colour_changes or []):
        node_id, title, idx = _scene_meta(getattr(change, "node_id", None))
        new_colour = getattr(change, "new_colour", None)
        rows.append((idx, ExportKnowledgeChainEntry(
            kind="colour",
            text=(f"Colour → {new_colour}" if new_colour else "Colour cleared"),
            scene_id=node_id, scene_title=title, chain_index=idx,
        )))
    for change in (history.profile_image_changes or []):
        node_id, title, idx = _scene_meta(getattr(change, "node_id", None))
        new_ref = getattr(change, "new_profile_image_ref", None)
        rows.append((idx, ExportKnowledgeChainEntry(
            kind="profile_image",
            text=("Profile image replaced" if new_ref else "Profile image cleared"),
            scene_id=node_id, scene_title=title, chain_index=idx,
        )))
    # Awareness chain entries — read from canonical Knowledge.awareness.history
    # (the second-class awareness object's own chain, post v0.2a.2.0
    # migration). Per-observer entries only; tracking on/off events and
    # source-projection mutations are awareness-layer state changes that
    # don't surface as per-observer rows in the export.
    awareness_obj = getattr(knowledge, "awareness", None)
    awareness_history = (
        awareness_obj.history
        if isinstance(awareness_obj, AwarenessWrapper) and awareness_obj.history
        else []
    )
    for entry in awareness_history:
        if getattr(entry, "tracking_action", None) is not None:
            continue
        if getattr(entry, "source_action", None) is not None:
            continue
        observer = getattr(entry, "observer_id", "") or ""
        if not observer:
            continue
        node_id, title, idx = _scene_meta(getattr(entry, "node_id", None))
        new_level = getattr(entry, "level", None)
        rows.append((idx, ExportKnowledgeChainEntry(
            kind="awareness",
            text=f"Awareness for {observer}: level {new_level}",
            scene_id=node_id, scene_title=title, chain_index=idx,
        )))
    for change in (history.source_event_changes or []):
        node_id, title, idx = _scene_meta(getattr(change, "node_id", None))
        new_se = getattr(change, "new_source_event", None)
        rows.append((idx, ExportKnowledgeChainEntry(
            kind="source_event",
            text=("Source event re-bound" if new_se else "Source event cleared"),
            scene_id=node_id, scene_title=title, chain_index=idx,
        )))

    # Off-POV scenes (chain_index=0) sort to the end via large fallback.
    rows.sort(key=lambda pair: (pair[0] if pair[0] > 0 else 10**9))
    return [row for _, row in rows]


def _build_entity_sheet(
    *,
    entity: Entity,
    type_name: str,
    embed_assets: bool,
    entities_by_id: dict[str, tuple[Entity, str]],
    profile_uri_by_entity_id: dict[str, Optional[str]],
    story_relationships: "list[Relationship]",
    knowledges_by_id: Optional[dict] = None,
    chain_boundary_index: Optional[int] = None,
    pov_sequence: Optional[list[dict]] = None,
) -> ExportEntitySheet:
    return ExportEntitySheet(
        id=entity.id,
        name=entity.name,
        type=type_name,
        colour=entity.colour,
        description=entity.description or "",
        profile_image_data_uri=(
            _asset_to_data_uri(entity.profile_image_ref) if (embed_assets and entity.profile_image_ref) else None
        ),
        aliases=[a.value for a in (entity.aliases or [])],
        attributes=[
            _build_attribute(
                a,
                embed_assets=embed_assets,
                entities_by_id=entities_by_id,
                knowledges_by_id=knowledges_by_id or {},
                story_relationships=story_relationships,
            )
            for a in (entity.attributes or [])
        ],
        relationships=_build_sheet_relationships(
            entity=entity,
            story_relationships=story_relationships,
            entities_by_id=entities_by_id,
            profile_uri_by_entity_id=profile_uri_by_entity_id,
            embed_assets=embed_assets,
            chain_boundary_index=chain_boundary_index,
            pov_sequence=pov_sequence,
        ),
        notes=entity.notes or "",
    )


def _build_sheet_relationships(
    *,
    entity: Entity,
    story_relationships: "list[Relationship]",
    entities_by_id: dict[str, tuple[Entity, str]],
    profile_uri_by_entity_id: dict[str, Optional[str]],
    embed_assets: bool,
    chain_boundary_index: Optional[int] = None,
    pov_sequence: Optional[list[dict]] = None,
) -> list[ExportEntityRelationship]:
    """Build one `ExportEntityRelationship` per top-level relationship that
    includes the given entity as a participant. Uses the N-party model:
    each relationship can have any number of participants; `other_participants`
    lists every participant except the sheet owner.

    Phase 1.25c (Bug 7): when `chain_boundary_index` and `pov_sequence`
    are supplied, every chain walk (perception / role / description /
    relationship-name) only considers events whose anchoring node has a
    POV-chain index strictly less than `chain_boundary_index` — matching
    the entity-state-boundary='scope' semantics. Without the boundary
    (None), behaviour is unchanged: latest entry in array order wins."""
    from services.relationship_label import resolve_relationship_label

    entity_name_map = {eid: ent.name for eid, (ent, _) in entities_by_id.items()}

    # Build node_id → POV-chain index map once per sheet so the per-rel
    # filter is O(1) rather than re-scanning pov_sequence each time.
    chain_index_by_node: dict[str, int] = {}
    if pov_sequence:
        for idx, seq_entry in enumerate(pov_sequence):
            nid = seq_entry.get("node_id") if isinstance(seq_entry, dict) else getattr(seq_entry, "id", None)
            if nid is not None:
                chain_index_by_node[nid] = seq_entry.get("index", idx + 1) if isinstance(seq_entry, dict) else (idx + 1)

    def _within_boundary(node_id: Optional[str]) -> bool:
        """True when an event anchored at `node_id` is at-or-before the
        scope boundary (or when no boundary is active)."""
        if chain_boundary_index is None:
            return True
        if not node_id:
            # Events without a node_id (shouldn't normally happen in
            # practice) are treated as in-scope to avoid silently
            # dropping content; they sit at "end of array" per the
            # legacy semantics.
            return True
        idx = chain_index_by_node.get(node_id)
        if idx is None:
            # Off-POV node — exclude from the scope window.
            return False
        return idx < chain_boundary_index

    out: list[ExportEntityRelationship] = []
    for rel in story_relationships:
        # History-only: a participant is any entity that has ever joined
        # within the scope window (boundary-aware). Preserve first-join
        # order so export rendering is stable.
        seen: set[str] = set()
        participant_ids_ordered: list[str] = []
        for ch in rel.history.participant_changes:
            if not _within_boundary(getattr(ch, "node_id", None)):
                continue
            if ch.action == "join" and ch.entity_id not in seen:
                seen.add(ch.entity_id)
                participant_ids_ordered.append(ch.entity_id)

        if entity.id not in seen:
            continue

        display_label = resolve_relationship_label(rel, entity_name_map)

        # Per-entity perception: latest PerceptionChange wins, else the
        # initial_perception recorded on that entity's join event. All
        # walks respect the scope boundary.
        def _latest_perception(eid: str) -> str:
            latest = ""
            for ch in rel.history.participant_changes:
                if not _within_boundary(getattr(ch, "node_id", None)):
                    continue
                if ch.action == "join" and ch.entity_id == eid:
                    latest = ch.initial_perception or ""
            for ch in rel.history.perception_changes:
                if not _within_boundary(getattr(ch, "node_id", None)):
                    continue
                if ch.entity_id == eid:
                    latest = ch.new_perception or ""
            return latest

        own_perception = _latest_perception(entity.id)

        # Phase 1.25c — sheet-owner role at origin. Latest RoleChange
        # wins; fall back to `participant_roles[entity.id]` baseline.
        own_role = ""
        for rch in rel.history.role_changes:
            if not _within_boundary(getattr(rch, "node_id", None)):
                continue
            if rch.entity_id == entity.id and rch.new_role is not None:
                own_role = str(rch.new_role)
        if not own_role:
            baseline_role = (rel.participant_roles or {}).get(entity.id)
            if baseline_role is not None:
                own_role = str(baseline_role)

        # Phase 1.25c — relationship description. Latest non-None
        # `DescriptionChange.new_description` wins; baseline is
        # `rel.description`.
        rel_description = rel.description or ""
        for dch in rel.history.description_changes:
            if not _within_boundary(getattr(dch, "node_id", None)):
                continue
            if dch.new_description is not None:
                rel_description = dch.new_description

        # Build the other-participants list.
        other: list[ExportRelationshipParticipant] = []
        for pid in participant_ids_ordered:
            if pid == entity.id:
                continue
            entry = entities_by_id.get(pid)
            if not entry:
                continue
            other_ent, other_bucket = entry
            other_type = other_bucket.rstrip("s") if other_bucket != "customs" else "custom"
            other.append(ExportRelationshipParticipant(
                entity_id=pid,
                entity_name=other_ent.name,
                entity_type=other_type,
                entity_colour=other_ent.colour,
                profile_image_data_uri=(
                    _asset_to_data_uri(other_ent.profile_image_ref)
                    if (embed_assets and other_ent.profile_image_ref)
                    else profile_uri_by_entity_id.get(pid)
                ),
                perception=_latest_perception(pid),
            ))

        out.append(ExportEntityRelationship(
            display_label=display_label,
            own_perception=own_perception,
            other_participants=other,
            has_hierarchy=rel.hierarchy is not None,
            is_membership=rel.membership_of is not None,
            description=rel_description,
            own_role=own_role,
        ))
    return out


def _resolve_perspective_target_name(
    attr: Attribute,
    *,
    entities_by_id: dict,
    knowledges_by_id: dict,
    story_relationships: list,
) -> Optional[str]:
    """Phase 5.8b — resolve a perspective attribute's target to a display
    name. Targets can be an entity (character / location / item / faction /
    custom), a knowledge, or a relationship. Uses the same maps the rest of
    the entity sheet uses (so name resolution matches the sheet's boundary
    state) and the shared `resolve_relationship_label` helper. Returns None
    when the target is unset or can no longer be resolved."""
    kind = getattr(attr, "perspective_target_kind", None)
    tid = getattr(attr, "perspective_target_id", None)
    if not kind or not tid:
        return None
    if kind == "knowledge":
        k = knowledges_by_id.get(tid)
        return getattr(k, "name", None) if k is not None else None
    if kind == "relationship":
        rel = next((r for r in story_relationships if r.id == tid), None)
        if rel is None:
            return None
        from services.relationship_label import resolve_relationship_label
        name_map = {eid: ent.name for eid, (ent, _t) in entities_by_id.items()}
        return resolve_relationship_label(rel, name_map) or None
    # Entity kinds: character / location / item / faction / custom.
    ent_tuple = entities_by_id.get(tid)
    return ent_tuple[0].name if ent_tuple else None


def _build_attribute(
    attr: Attribute,
    *,
    embed_assets: bool,
    entities_by_id: Optional[dict] = None,
    knowledges_by_id: Optional[dict] = None,
    story_relationships: Optional[list] = None,
) -> ExportAttribute:
    media_kind: Optional[str] = None
    if attr.attribute_type == "file" and attr.file_ref:
        media_kind = _detect_media_kind(attr.file_ref)
    # Phase 1.25c — surface the typed `number_value` for number
    # attributes (export audit Bug 9). Pre-1.25, the export model
    # always populated `value` from `attr.value` which is empty for
    # number attributes; the typed float in `attr.number_value` was
    # silently dropped, so number rows exported as a blank
    # "name: " line. Render-friendly stringification here: integer-
    # valued floats become "5" (no trailing ".0"), other floats keep
    # their natural representation.
    if attr.attribute_type == "number" and attr.number_value is not None:
        nv = attr.number_value
        if nv == int(nv):
            value_str = str(int(nv))
        else:
            value_str = str(nv)
    else:
        value_str = attr.value or ""
    # Phase 5.8b — perspective attributes carry their body in `description`
    # and point at another object; resolve the target to a display name so
    # renderers can show "Perspective on <target>: <body>".
    description = ""
    perspective_target: Optional[str] = None
    if attr.attribute_type == "perspective":
        description = getattr(attr, "description", "") or ""
        perspective_target = _resolve_perspective_target_name(
            attr,
            entities_by_id=entities_by_id or {},
            knowledges_by_id=knowledges_by_id or {},
            story_relationships=story_relationships or [],
        )
    return ExportAttribute(
        name=attr.name,
        attribute_type=attr.attribute_type,
        value=value_str,
        file_ref_data_uri=(
            _asset_to_data_uri(attr.file_ref)
            if (embed_assets and attr.attribute_type == "file" and attr.file_ref)
            else None
        ),
        media_kind=media_kind,  # type: ignore[arg-type]
        description=description,
        perspective_target=perspective_target,
    )


def _detect_media_kind(file_ref: str) -> Literal["image", "audio", "video", "other"]:
    """Classify a file reference into one of four coarse media kinds
    for the renderer's branching (<img> / <audio> / <video> / skip).
    Matches by extension rather than sniffing the asset bytes, since
    extensions are reliable within this codebase's asset pipeline."""
    ext = ""
    # Extract the extension safely — the ref is an `assets/foo.bar`
    # style path, not a full filesystem path, so rsplit on '.' is fine.
    if "." in file_ref:
        ext = file_ref.rsplit(".", 1)[-1].lower()
    if ext in ("png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"):
        return "image"
    if ext in ("mp3", "wav", "ogg", "oga", "m4a", "flac", "opus", "aac"):
        return "audio"
    if ext in ("mp4", "webm", "mov", "m4v", "avi", "mkv", "ogv"):
        return "video"
    return "other"


# ── Asset resolution ───────────────────────────────────────────────────


def _asset_to_data_uri(asset_ref: Optional[str]) -> Optional[str]:
    """Resolve an `assets/…` ZIP path against the currently-loaded
    project's unpacked assets directory and return a base64 data URI.
    Returns None if the asset can't be resolved (missing file, no active
    project, unreadable). Export errors on a single broken asset should
    never crash the whole export — they just drop the image silently.
    """
    if not asset_ref:
        return None
    assets_dir = file_service.get_assets_dir()
    if not assets_dir:
        return None
    # `assets_dir` is the directory that corresponds to the `assets/`
    # prefix inside the ZIP. `asset_ref` arrives as e.g. "assets/foo.png"
    # from the frontend; strip the leading "assets/" for the filesystem
    # lookup.
    rel = asset_ref
    if rel.startswith("assets/") or rel.startswith("assets\\"):
        rel = rel.split("/", 1)[-1].split("\\", 1)[-1]
    candidate = Path(assets_dir) / rel
    if not candidate.is_file():
        return None
    try:
        data = candidate.read_bytes()
    except OSError:
        return None
    mime, _ = mimetypes.guess_type(str(candidate))
    mime = mime or "application/octet-stream"
    encoded = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{encoded}"
