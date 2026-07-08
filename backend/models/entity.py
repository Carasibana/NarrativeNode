from __future__ import annotations
from typing import Annotated, Any, Literal, Optional, Union
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_serializer, model_validator
import uuid

from .tag import RelationshipTagChange


_foreign_content_ok = ConfigDict(extra="ignore")


# ── Awareness model (Phase 1.21 / 1.21g) ─────────────────────────────────────
#
# Every awareness-carrying surface (Entity, Attribute, Relationship, Alias,
# Knowledge) carries an `awareness` field that may take one of three on-disk
# shapes — none of which are deprecated:
#
#   null                                # tracking off
#   { entity_id: level, ... }           # direct entries only (flat dict)
#   { entries?: dict, sources?: array } # mixed; only emitted when projections present
#
# The wrapper shape (Phase 1.21g) is used only when at least one projected
# source is present. Pure-direct-entries awareness continues to serialise as
# the flat dict shape used since Phase 1.21. A projected source is one of:
#   { kind: 'relationship', relationship_id, level }
#   { kind: 'attribute',    entity_id, attribute_id, level }
# Each projects every member of the referenced collection (at the current
# chain position) to the source's level. Resolution rule: direct entries
# always win; among projections only, the highest level wins.
#
# Per-surface level scales:
#   - Entity / Attribute / Relationship: {0, 3}
#       0 = explicitly unaware
#       3 = aware
#   - Alias / canonical-name / Knowledge: {0, 1, 2, 3}
#       0 = explicitly doesn't know
#       1 = knows the name at face value (no link to anyone)
#       2 = knows it's a pseudonym / label, but not whose
#       3 = knows the linkage to the parent entity
#   - key absent = unspecified (no assertion either way)
#
# Validators reject out-of-range levels per the target surface. Defined once
# here; re-used as a field_validator on every surface below.


# ── Source kinds (Phase 1.21g) ──────────────────────────────────────────────
# Discriminated by `kind`; Pydantic's discriminated-union resolution picks
# the right variant when parsing.

class RelationshipSource(BaseModel):
    """Projects every active participant of a relationship at the current
    chain position to a single specified level."""
    model_config = _foreign_content_ok
    kind: Literal['relationship'] = 'relationship'
    relationship_id: str
    level: int


class AttributeSource(BaseModel):
    """Projects every entity in an entity-list attribute (at the current
    chain position) to a single specified level. The referenced attribute
    must be of `attribute_type='entity_list'` on the named entity."""
    model_config = _foreign_content_ok
    kind: Literal['attribute'] = 'attribute'
    entity_id: str
    attribute_id: str
    level: int


Source = Annotated[
    Union[RelationshipSource, AttributeSource],
    Field(discriminator='kind'),
]


class SourceEventRef(BaseModel):
    """Back-pointer to the chain-tracked event that created or modified
    this entry's host (Knowledge or a Knowledge history entry, or any
    other awareness history entry carrying a Knowledge-attachment
    back-pointer). Used for:
      - navigation (jump from the host / mutation row to the triggering
        event on canvas),
      - cleanup cascade on unmake (detect when the specific event entry
        is deleted from its parent list, cascade to the host or the
        specific history entry),
      - "most recently modified by" at any chain position Y = latest
        history entry with node_id <= Y, return its source_event.

    Phase 1.21c Tier 0 universalisation: every event of every kind is
    identified by a single stable UUID (`change_id`). Array-based events
    carry their UUID directly on the change-entry object; EntityRef scalar
    events carry theirs in `EntityRef.scalar_change_ids[field_name]`. No
    composite-key branch — both kinds resolve through the same lookup.

    Carrier-context fields (`entity_id`, `relationship_id`, `attribute_id`,
    `node_id`, `field`) are optional metadata aiding lookup / navigation /
    "most recently modified by" rendering. They are NOT used for event
    identity — the UUID is.

    Lifted from `knowledge.py` to `entity.py` in v0.2a.2.x when the
    canonical `AwarenessHistoryEntry` gained a `source_event` slot.
    `knowledge.py` re-exports the class for back-compat with existing
    `from .knowledge import SourceEventRef` callers.
    """
    model_config = _foreign_content_ok
    event_type: Literal[
        "attribute_change",
        "relationship_existence_change",
        "relationship_participant_change",
        "relationship_perception_change",
        "relationship_alias_change",
        "relationship_role_change",
        "relationship_hierarchy_change",
        "relationship_name_change",
        "awareness_change",
        "entity_ref_scalar",
        # Baseline value at an entity's origin (no chain change record;
        # the value IS the entity's pre-story state). `change_id` carries
        # the Attribute UUID for attribute baselines, or a synthetic
        # `${entity_id}:${field}` sentinel for entity scalar baselines
        # (name / colour / description / profile_image). `node_id`
        # carries the entity's origin node id for navigation.
        "entity_baseline",
    ]
    change_id: str
    node_id: str
    # Carrier-context metadata (optional; aids lookup / navigation):
    entity_id: Optional[str] = None
    relationship_id: Optional[str] = None
    attribute_id: Optional[str] = None
    field: Optional[str] = None  # only set for entity_ref_scalar events


class AwarenessHistoryEntry(BaseModel):
    """One chain mutation on an awareness object's own history list.

    Awareness is a second-class object attached to a host (Entity /
    Attribute / Alias / Relationship / Knowledge) and has its OWN chain
    of history independent of the host's chain. Each entry on the
    history list records one mutation: at this `node_id`, this
    `observer_id`'s level was set to `level` (or the observer key was
    stripped if `level is None`). For source mutations (projection
    add / remove / set_level) the entry leaves `observer_id` empty and
    `level` null, instead populating `source_action` + `source`.
    """
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_id: str
    observer_id: str = ""           # direct entry — empty when source mutation OR tracking event
    level: Optional[int] = None     # direct entry — null when source mutation OR explicit "remove key" OR tracking event
    source_action: Optional[Literal["add", "remove", "set_level"]] = None
    source: Optional[Source] = None
    # Chain-tracked tracking on/off event. When present, observer_id and
    # level are empty and this entry flips the awareness layer's tracked
    # state from this node forward. Walker reads the most-recent
    # tracking_action up to an anchor; if `off`, the layer resolves to
    # null at that anchor regardless of any data underneath.
    tracking_action: Optional[Literal["on", "off"]] = None
    # Per-anchor awareness scale ('binary' = {0, 3} or 'full' = {0, 1, 2, 3}),
    # carried on `tracking_action: 'on'` establishment events. Mirrors the
    # legacy `KnowledgeAwarenessChange.awareness_scale` field that the
    # pre-migration shape used. Walker resolves the latest applicable
    # tracking-on scale up to the anchor; baseline `Knowledge.awareness_scale`
    # is the fallback when no chain entry sets one. Ignored on
    # `tracking_action: 'off'` and on non-tracking entries.
    awareness_scale: Optional[Literal["binary", "full"]] = None
    # Knowledge-attachment back-pointer (Phase 1.21c Tier 2). Lifted from
    # the legacy `KnowledgeAwarenessChange.source_event` field during the
    # v0.2a.2.x migration so the canonical awareness history can carry the
    # same Knowledge-attachment cascade behaviour as the legacy shape.
    # Null when this entry was not spawned by an attached event.
    source_event: Optional[SourceEventRef] = None
    # Phase 1.21c Tier 2 — forward pointer to the Knowledge spawned or
    # most-recently-modified by this awareness change. Mirrors the canonical
    # forward-pointer pattern on every other change-record class
    # (`AttributeChange.knowledge_id`, `ParticipantChange.knowledge_id`,
    # `PerceptionChange.knowledge_id`, etc.). Cleanup-cascade detection
    # prefers this forward pointer over scanning all knowledges. Lifted
    # from the legacy `AwarenessChange.knowledge_id` field by the
    # v0.2a.2.x migration. Null on any change not tied to a Knowledge.
    knowledge_id: Optional[str] = None
    # Per-entry downstream-review state (Phase 1.21h). Stamped by the
    # awareness-flag pipeline when an upstream awareness write makes this
    # entry's value redundant (matches the new inherited level) or
    # divergent (worth a second look). Shape mirrors the EntityRef-side
    # enriched flag `{ previousInherited, currentInherited, downstreamValue,
    # redundant?, sourceNodeId }` so AlertsPanel renders both via the same
    # template. Cleared on dismiss (sub-chip `−` button or alert
    # checkmark). Lifted from legacy `KnowledgeAwarenessChange.review_flag`
    # during the v0.2a.2.x migration.
    review_flag: Optional[dict] = None


class AwarenessWrapper(BaseModel):
    """Mixed-list awareness shape — direct entries + projected sources +
    the awareness's own chain of history.

    Three optional inner fields:
      - `entries` — baseline direct-entry dict (the per-observer levels
        at the awareness's origin / library row).
      - `sources` — baseline projected sources.
      - `history` — the awareness's OWN chain of mutations. Independent
        of the host's chain. Walker resolves effective state at any
        anchor by combining `entries` + `sources` + history applied in
        story order up to the anchor.

    Serialisation omits whichever field is null so the on-disk shape
    matches the design intent.
    """
    model_config = _foreign_content_ok
    entries: Optional[dict[str, int]] = None
    sources: Optional[list[Source]] = None
    history: Optional[list[AwarenessHistoryEntry]] = None

    @model_serializer
    def _serialize(self):
        out = {}
        if self.entries is not None:
            out['entries'] = self.entries
        if self.sources is not None:
            out['sources'] = [s.model_dump() for s in self.sources]
        if self.history is not None:
            out['history'] = [h.model_dump() for h in self.history]
        return out


# Legacy single-relationship-ref shape kept for re-export compatibility.
# No new model field is typed against `AwarenessRef`; the `mode='before'`
# normaliser below recognises the old shape on input and converts it.
class AwarenessRef(BaseModel):
    """DEPRECATED — pre-1.21g placeholder shape `{relationship_id, level}`.

    Never used by any shipped UI write path (the toggle was always
    disabled-placeholder), so no real save carries this shape. The class
    is retained so existing imports of `AwarenessRef` keep resolving;
    the `mode='before'` field validator on each surface's awareness
    field detects the shape and converts it to the wrapper form
    `{ sources: [{ kind: 'relationship', ... }] }` on load.
    """
    model_config = _foreign_content_ok
    relationship_id: str
    level: int


_AwarenessValue = Union[dict[str, int], AwarenessWrapper]


def _normalise_awareness_input(value):
    """Pre-validator — converts the legacy single-AwarenessRef shape
    `{relationship_id, level}` into the new wrapper. All other shapes
    pass through untouched."""
    if value is None:
        return None
    if isinstance(value, dict):
        keys = set(value.keys())
        if keys == {'relationship_id', 'level'}:
            return {
                'sources': [{
                    'kind': 'relationship',
                    'relationship_id': value['relationship_id'],
                    'level': value['level'],
                }]
            }
    return value


def _validate_awareness_field(value, *, allowed_levels: tuple[int, ...]):
    """Shared field_validator body for `awareness` across surfaces.

    Enforces that every level (entry values + each projected source's
    level) is within the per-surface allowed range. Handles both the
    flat-dict shape and the wrapper shape; null is pre-filtered by the
    caller.
    """
    if isinstance(value, dict):
        for entity_id, level in value.items():
            if not isinstance(level, int) or level not in allowed_levels:
                raise ValueError(
                    f"Awareness level {level!r} for entity {entity_id!r} is not in "
                    f"allowed levels {allowed_levels} for this surface"
                )
        return value
    if isinstance(value, AwarenessWrapper):
        if value.entries is not None:
            for entity_id, level in value.entries.items():
                if not isinstance(level, int) or level not in allowed_levels:
                    raise ValueError(
                        f"Awareness level {level!r} for entity {entity_id!r} is not in "
                        f"allowed levels {allowed_levels} for this surface"
                    )
        if value.sources is not None:
            for src in value.sources:
                if src.level not in allowed_levels:
                    raise ValueError(
                        f"Projected source level {src.level!r} (kind={src.kind!r}) is not in "
                        f"allowed levels {allowed_levels} for this surface"
                    )
        if value.history is not None:
            for h in value.history:
                if h.source_action is not None:
                    if h.source is not None and h.source.level not in allowed_levels:
                        raise ValueError(
                            f"Awareness history source-mutation level {h.source.level!r} "
                            f"(kind={h.source.kind!r}) is not in allowed levels {allowed_levels} for this surface"
                        )
                else:
                    if h.level is not None and h.level not in allowed_levels:
                        raise ValueError(
                            f"Awareness history level {h.level!r} for observer {h.observer_id!r} "
                            f"is not in allowed levels {allowed_levels} for this surface"
                        )
        return value
    raise ValueError(f"Unexpected awareness value shape: {type(value).__name__}")


_BINARY_LEVELS: tuple[int, ...] = (0, 3)
_ALIAS_LEVELS: tuple[int, ...] = (0, 1, 2, 3)


class Attribute(BaseModel):
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    # "text"  — free-form string in `value`
    # "file"  — media reference (image/audio/video) in `file_ref`; user-facing label is "Media"
    # "preset" — selection from a PresetList, stored as the chosen string in `value`
    # "text_list"   — JSON-encoded list[str] in `value` (e.g. '["Ames","The Shadow"]'); purely text
    # "entity_list" — JSON-encoded list[str] of entity UUIDs in `value`; not type-restricted
    # "number" — numeric scalar in `number_value` (float). `value` ignored.
    # "circumstance" — Phase 1.22 — situational state. Body in `description`,
    #                  optional 0-4 `intensity`. `value` / `file_ref` /
    #                  `preset_list_id` ignored. Name optional (the row
    #                  falls back to the description if no name is set).
    # "motivator" — Phase 1.22 — internal drive. Same shape as circumstance
    #                  but `name` is required.
    # "perspective" — Phase 2.13 — host entity's first-person view on
    #                  another object (character / location / item /
    #                  faction / custom / knowledge / relationship).
    #                  Body in `description`; target in
    #                  `perspective_target_kind` + `perspective_target_id`.
    #                  No intensity, no awareness — perspectives are
    #                  first-person-only in v1. `value` / `file_ref` /
    #                  `preset_list_id` ignored. Name optional.
    attribute_type: Literal[
        "text", "file", "preset", "text_list", "entity_list",
        "number", "circumstance", "motivator", "perspective",
    ] = "text"
    value: str = ""
    file_ref: Optional[str] = None        # relative path inside ZIP assets/
    preset_list_id: Optional[str] = None  # for preset type
    preset_list_name: Optional[str] = None  # stored so orphaned attributes can be re-linked by name
    # Phase 1.22 — circumstance / motivator body text. Multi-line
    # description displayed when the row is expanded. Required (non-empty)
    # for circumstance and motivator types; ignored otherwise.
    description: str = ""
    # Phase 1.22 — circumstance / motivator severity / intensity slider.
    # 5-tier ladder: 0 = Faint, 1 = Mild, 2 = Moderate, 3 = Strong,
    # 4 = Intense. `None` means slider unset (no intensity specified —
    # valid state, the row simply renders no intensity badge). Only
    # circumstance and motivator types currently use this field; the
    # field is present on every Attribute for forward-compat (e.g. a
    # future text type could opt into intensity without a model change).
    intensity: Optional[int] = None
    # Phase 1.22 — number type's typed scalar value. Float; not NaN, not
    # Infinity (validator). Only the `number` attribute type uses this
    # field; other types ignore it.
    number_value: Optional[float] = None
    # Phase 2.13 — perspective type's target reference. Identifies the
    # object the host entity holds this perspective ON.
    # `perspective_target_kind` is one of: 'character', 'location',
    # 'item', 'faction', 'custom', 'knowledge', 'relationship'.
    # `perspective_target_id` is the target object's uuid. Both null on
    # non-perspective types AND on orphaned-target perspectives (when
    # the target was deleted — the entry survives, surfaced as
    # "(deleted target)" in the UI; deletion cascade fires an alert
    # on the host). No nested sub-model — inline keeps the chain-walker
    # payload shape uniform.
    perspective_target_kind: Optional[Literal[
        "character", "location", "item", "faction", "custom",
        "knowledge", "relationship",
    ]] = None
    perspective_target_id: Optional[str] = None
    # Phase 1.21g — per-attribute awareness scale toggle. Mirrors the
    # Knowledge convention (`'binary' | 'full'`). `'binary'` uses the
    # 2-level {0, 3} scale (default, back-compat); `'full'` opens the
    # full 4-level alias scale {0, 1, 2, 3} for partial-knowledge
    # tracking (e.g. the observer knows the attribute exists but not
    # its value). User-toggled via the Precision control in the
    # AttributesAwarenessPanel.
    awareness_scale: Literal["binary", "full"] = "binary"
    awareness: Optional[_AwarenessValue] = None

    @field_validator("awareness", mode='before')
    @classmethod
    def _normalise_awareness(cls, v):
        return _normalise_awareness_input(v)

    @field_validator("intensity")
    @classmethod
    def _check_intensity(cls, v):
        # Phase 1.22 — intensity is `None` (unset) or a 5-tier integer.
        if v is None:
            return v
        if not isinstance(v, int) or v < 0 or v > 4:
            raise ValueError(f"intensity must be None or in {{0,1,2,3,4}}; got {v!r}")
        return v

    @field_validator("number_value")
    @classmethod
    def _check_number_value(cls, v):
        # Phase 1.22 — finite float (no NaN, no Infinity).
        if v is None:
            return v
        try:
            f = float(v)
        except (TypeError, ValueError):
            raise ValueError(f"number_value must be a finite float; got {v!r}")
        if f != f or f in (float("inf"), float("-inf")):
            raise ValueError(f"number_value must be finite (not NaN/Infinity); got {v!r}")
        return f

    @model_validator(mode='after')
    def _check_awareness(self):
        if self.awareness is None:
            return self
        # Phase 1.21h Fix #4 — `awareness_scale` is a presentation
        # meta-flag (binary vs full), not a data-validation gate. The
        # awareness data on disk always permits the full alias-level
        # set {0, 1, 2, 3}; the picker's level chooser collapses to
        # {0, 3} when binary and the badge / sub-chip render paths
        # collapse non-zero stored levels onto the level-3 glyph for
        # display. Flipping binary → full reveals any pre-existing
        # 1 / 2 entries unchanged.
        _validate_awareness_field(self.awareness, allowed_levels=_ALIAS_LEVELS)
        return self

    @model_validator(mode='after')
    def _check_phase_1_22_required_fields(self):
        # Phase 1.22 — per-type required-field validation. Both
        # circumstance and motivator are symmetric: name and
        # description are each individually optional, but AT LEAST
        # ONE of the two must be non-empty (e.g. "Pregnant" with no
        # description is valid; an empty description-only entry is
        # also valid; both blank is rejected because the row would
        # have nothing to display). When name is blank, display
        # falls back to the first N chars of the description; when
        # description is blank, display uses the name verbatim.
        #   number       : non-empty `name` AND a finite `number_value`.
        # Existing types are unaffected.
        if self.attribute_type in ("motivator", "circumstance"):
            has_name = bool(self.name and self.name.strip())
            has_desc = bool(self.description and self.description.strip())
            if not (has_name or has_desc):
                raise ValueError(
                    f"{self.attribute_type} attribute must have at least one of name or description"
                )
        elif self.attribute_type == "number":
            if not (self.name and self.name.strip()):
                raise ValueError("number attribute must have a non-empty name")
            if self.number_value is None:
                raise ValueError("number attribute must carry a finite number_value")
        return self


class PresetList(BaseModel):
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    values: list[str] = Field(default_factory=list)
    # Phase 3.4a — baseline-only Project Tag membership. PresetList
    # has no chain history of its own (it's a project-level static
    # structure like CustomCategory), so its tag set is fixed. Same
    # `Story.project_tags[*].id` referencing as every other host.
    tag_ids: list[str] = Field(default_factory=list)


class CustomCategory(BaseModel):
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    description: str = ""
    colour: str = "#888888"
    profile_image_ref: Optional[str] = None


class Alias(BaseModel):
    """A named alternative for an entity. The `awareness` field uses the
    4-level alias scale (see `_ALIAS_LEVELS` / Phase 1.21 plan §0).

    The `id` field (added 2026-05-17) gives each alias a stable UUID
    so per-alias chain events (`AliasChange.alias_id`) can target a
    specific alias without string-matching on the value. Pre-2026
    saves load with `id` missing; the `default_factory` synthesises
    a fresh UUID at load time. The same UUID is then persisted by the
    migration that converts old full-list `EntityRef.aliases_change`
    snapshots into per-alias `alias_changes` events (see
    `_migrate_aliases_to_chain_events` in `file_service.py`)."""
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    value: str
    awareness: Optional[_AwarenessValue] = None  # Phase 1.21 — 4-level {0, 1, 2, 3} scale

    @field_validator("awareness", mode='before')
    @classmethod
    def _normalise_awareness(cls, v):
        return _normalise_awareness_input(v)

    @field_validator("awareness")
    @classmethod
    def _check_awareness(cls, v):
        if v is None:
            return v
        return _validate_awareness_field(v, allowed_levels=_ALIAS_LEVELS)


# ── Relationship model (N-party, top-level) ─────────────────────────────────

class ParticipantRole(BaseModel):
    """Optional label describing a participant's role in a relationship."""
    model_config = _foreign_content_ok
    value: str
    preset_list_id: Optional[str] = None  # if set, value is sourced from this preset


class HierarchyNode(BaseModel):
    """A single node in a relationship-hierarchy tree.

    `id` is either a participant entity_id (when `HierarchyConfig.mode ==
    'participants'`) or a unique role-value string (when `mode == 'roles'`).
    `children` is the recursive nesting; the list is ordered."""
    model_config = _foreign_content_ok
    id: str
    children: list["HierarchyNode"] = Field(default_factory=list)


class HierarchyConfig(BaseModel):
    """Per-relationship hierarchy state.

    `enabled` toggles the hierarchy on/off without losing the tree shape — the
    UI hides the tree when False, but `roots` is preserved so toggling back
    on restores the user's previous arrangement.

    `mode` selects between two views of the same tree:
      - 'participants' — node ids are participant entity_ids; the tree
        encodes a parent/child structure between participants in this
        relationship.
      - 'roles' — node ids are unique role-value strings drawn from
        `Relationship.participant_roles`; the tree encodes a parent/child
        structure between roles, and each role node displays its
        participant members inline in the UI. Participants whose role is
        unset live in a synthetic Unassigned pool (UI-only; not stored as
        a tree node).

    `roots` is a forest — multiple top-level siblings allowed.

    Hierarchy data lives ON the relationship (this model). Same entity can
    occupy different positions in different relationships' hierarchies.
    Entities themselves carry no per-relationship hierarchy state."""
    model_config = _foreign_content_ok
    enabled: bool = False
    mode: Literal["participants", "roles"] = "participants"
    roots: list[HierarchyNode] = Field(default_factory=list)


# ── Relationship history change types ────────────────────────────────────────
# These types live alongside Relationship (not in node.py) to avoid a
# circular import: node.py already imports from entity.py, and
# Relationship.history requires RelationshipHistory.

# Phase 1.21c — each change class below carries a stable UUID id. Lets an
# attached Knowledge (Phase 1.21c Step 10+) reference a specific change by
# id, survives in-place edits to the change's payload, and backs the
# cleanup cascade on unmake. Pre-1.21c saves load transparently —
# `default_factory` fills missing ids on first load; subsequent saves
# persist them.

class ExistenceChange(BaseModel):
    """Relationship activated or deactivated at a given plot point node."""
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_id: str
    action: Literal["activate", "deactivate"]
    # Phase 1.21c Tier 2 — forward pointer to a Knowledge spawned or
    # modified by this event. Null when not Knowledge-attached.
    knowledge_id: Optional[str] = None


class ParticipantChange(BaseModel):
    """A participant joining or leaving the relationship at a given node."""
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_id: str
    action: Literal["join", "leave"]
    entity_id: str
    initial_perception: str = ""               # only used when action == "join"
    initial_alias_override: Optional[str] = None  # only used when action == "join"
    # Phase 1.21c Tier 2 — forward pointer to a Knowledge spawned or
    # modified by this event.
    knowledge_id: Optional[str] = None


class PerceptionChange(BaseModel):
    """One participant's perception text updated at a given node."""
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_id: str
    entity_id: str
    new_perception: str
    # Phase 1.21c Tier 2 — forward pointer to a Knowledge spawned or
    # modified by this event.
    knowledge_id: Optional[str] = None


class AliasOverrideChange(BaseModel):
    """Which alias a participant uses in this relationship, updated at a node."""
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_id: str
    entity_id: str
    new_alias_override: Optional[str]  # null clears the override
    # Phase 1.21c Tier 2 — forward pointer to a Knowledge spawned or
    # modified by this event.
    knowledge_id: Optional[str] = None


class RoleChange(BaseModel):
    """A participant's role in the relationship updated at a node."""
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_id: str
    entity_id: str
    new_role: Optional[ParticipantRole]  # null clears the role
    # Phase 1.21c Tier 2 — forward pointer to a Knowledge spawned or
    # modified by this event.
    knowledge_id: Optional[str] = None


class HierarchyChange(BaseModel):
    """The relationship's hierarchy element set or cleared at a node."""
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_id: str
    new_hierarchy: Optional[HierarchyConfig]  # null clears the hierarchy element
    # Phase 1.21c Tier 2 — forward pointer to a Knowledge spawned or
    # modified by this event.
    knowledge_id: Optional[str] = None


class NameChange(BaseModel):
    """The relationship's display name changed at a node. Propagates forward only."""
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_id: str
    new_name: Optional[str] = None  # null reverts to no custom name
    # Phase 1.21c Tier 2 — forward pointer to a Knowledge spawned or
    # modified by this event.
    knowledge_id: Optional[str] = None


class DescriptionChange(BaseModel):
    """The relationship's description changed at a node. Propagates forward only.
    Mirrors `NameChange`; awareness rollover treats description edits as
    awareness-trackable content the same way name edits are."""
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_id: str
    new_description: Optional[str] = None  # null clears any prior chain-time description
    knowledge_id: Optional[str] = None


class ManualAnchor(BaseModel):
    """The relationship was intentionally placed at a scene by the user (e.g.
    dragged from the Library onto that scene) but carries no state mutation
    there. Mirrors the 'ambient' concept — the chip renders at this scene —
    but is driven by explicit user action rather than the auto-derived
    "all participants present" rule. Used when the user wants to access the
    relationship at a scene where it isn't ambient so they can record actual
    changes there."""
    model_config = _foreign_content_ok
    node_id: str


class RelationshipHistory(BaseModel):
    """Per-relationship chain-of-history. Replaces the old two-place split
    between Entity.relationships (origin) and EntityRef.relationship_changes
    (mid-chain). All changes to a relationship's existence, participants,
    perceptions, aliases, roles, hierarchy, and name live here in one timeline."""
    model_config = _foreign_content_ok
    existence_changes: list[ExistenceChange] = Field(default_factory=list)
    participant_changes: list[ParticipantChange] = Field(default_factory=list)
    perception_changes: list[PerceptionChange] = Field(default_factory=list)
    alias_changes: list[AliasOverrideChange] = Field(default_factory=list)
    role_changes: list[RoleChange] = Field(default_factory=list)
    hierarchy_changes: list[HierarchyChange] = Field(default_factory=list)
    name_changes: list[NameChange] = Field(default_factory=list)
    description_changes: list[DescriptionChange] = Field(default_factory=list)
    # Phase 3.4a — relationship tag-membership chain events. Each entry
    # carries `node_id` per the existing RelationshipHistory pattern.
    tag_changes: list[RelationshipTagChange] = Field(default_factory=list)
    manual_anchors: list[ManualAnchor] = Field(default_factory=list)


class Relationship(BaseModel):
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: Optional[str] = None                                  # user-set label; falls back to resolver
    description: str = ""                                       # in-universe descriptive content; chain-tracked via history.description_changes
    participant_roles: dict[str, ParticipantRole] = Field(default_factory=dict)  # keyed by entity_id
    hierarchy: Optional[HierarchyConfig] = None                 # presence = structural ordering
    membership_of: Optional[str] = None                         # entity_id this is the canonical membership/structure record for
    history: RelationshipHistory = Field(default_factory=RelationshipHistory)
    # Phase 3.4a — baseline Project Tag membership at the relationship's
    # origin (its `creation_anchor_node_id` or the chain-equivalent
    # baseline). Chain-tracked via `history.tag_changes`. Empty
    # default so pre-Phase-3.4 saves load cleanly.
    tag_ids: list[str] = Field(default_factory=list)
    awareness: Optional[_AwarenessValue] = None                 # Phase 1.21 — binary {0, 3} scale
    # Phase 1.21h — explicit creation-anchor node id. Records the canvas
    # node where this relationship came into existence so anchor-aware
    # setters (setRelationshipName, setRelationshipHierarchy,
    # setParticipantRole, etc.) can route baseline-vs-chain-entry writes
    # without inferring the creation node from a heuristic over
    # participant joins. Pre-1.21h saves load with this field absent
    # and fall back to the historical heuristic via the
    # `getRelationshipCreationNodeId` helper.
    creation_anchor_node_id: Optional[str] = None
    # Per-relationship awareness scale (parallel to Entity.awareness_scale).
    # Governs the picker's level set: binary = {0, 3}; full = {0, 1, 2, 3}.
    # Optional; pre-existing saves load absent and treat as `binary`.
    awareness_scale: Literal["binary", "full"] = "binary"

    @field_validator("awareness", mode='before')
    @classmethod
    def _normalise_awareness(cls, v):
        return _normalise_awareness_input(v)

    @field_validator("awareness")
    @classmethod
    def _check_awareness(cls, v):
        if v is None:
            return v
        return _validate_awareness_field(v, allowed_levels=_ALIAS_LEVELS)

    @model_validator(mode='before')
    @classmethod
    def _drop_blank_hierarchy(cls, data):
        # Phase 1.26a — if a save's `hierarchy` field arrives as a dict
        # that's effectively empty (no `enabled`, no `roots` items),
        # treat it as None. Covers both the post-`extra="ignore"` load of
        # the broken pre-1.26a `{root_entity_id, ordering}` shape (which
        # strips to an all-default HierarchyConfig) AND any other
        # round-trip path that produced a default-equivalent config.
        # Keeps "no hierarchy defined" distinct from "user has touched
        # the hierarchy and toggled it off, retaining the tree" (the
        # latter has either `enabled=True` or non-empty `roots`).
        if isinstance(data, dict):
            h = data.get('hierarchy')
            if isinstance(h, dict):
                enabled = bool(h.get('enabled'))
                roots = h.get('roots') or []
                if not enabled and not roots:
                    data['hierarchy'] = None
        return data

    @model_serializer(mode='wrap')
    def _serialize(self, handler):
        # Phase 1.26a — drop the `hierarchy` key from the on-disk form
        # when it's None. A relationship with no defined hierarchy
        # doesn't carry the field at all; round-trips remain quiet
        # under the legacy-save-normalisation rule.
        out = handler(self)
        if out.get('hierarchy') is None:
            out.pop('hierarchy', None)
        return out


class Entity(BaseModel):
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    type: Literal["character", "location", "item", "faction", "custom"]
    name: str
    colour: str = "#888888"
    description: str = ""
    attributes: list[Attribute] = Field(default_factory=list)
    # Phase 4.2 — user-chosen DISPLAY order for this entity's attributes,
    # as a list of attribute ids. PRESENTATION property, NOT chain-
    # tracked: order does not vary along the chain, so there are no
    # per-scene orders and no chain entries for reordering. The detail
    # view sorts the position's effective attribute set by index in this
    # list, skips any id not present at that position, and appends any
    # present-but-unordered attribute (e.g. a freshly chain-added one)
    # at the end.
    #
    # OPTIONAL — only persisted when the user actually deviates from the
    # default array order. `None` (the default) means "no custom order;
    # render in `attributes[]` array order"; the frontend only ever
    # writes a populated list here on a drag-reorder and never stamps
    # the current array order onto an untouched entity. `None` / absent /
    # empty all fall back to array order, so a pre-Phase-4.2 save loads
    # and renders identically — additive, no save-format cliff, no
    # migration transform needed.
    attribute_order: Optional[list[str]] = None
    # Location-hierarchy parent (id of another location entity). Active
    # field used by the frontend's HierarchyTreeView and the
    # `setHierarchyParent` action. The CHANGELOG entry for v0.1.18.0
    # noted `Entity.parent_id` as removed; that was inaccurate — the
    # field continued in active use but fell off the typed model and
    # rode through saves as `extra="allow"` foreign content. Restored
    # here as a typed field so the schema matches the program's actual
    # behaviour. Null on non-location entities and on roots.
    parent_id: Optional[str] = None
    category_id: Optional[str] = None  # for custom type
    # Note: the `label` field (custom-only distinguishing label) was
    # retired in v0.2.12.18. It lives on in legacy saves and is
    # migrated into `name` by `_migrate_legacy_custom_label` below.
    # No new code should reference `label`; canonical name is `name`.
    profile_image_ref: Optional[str] = None  # relative ZIP path e.g. "assets/profile_abc.jpg"
    aliases: list[Alias] = Field(default_factory=list)  # alternative names; chain-tracked via EntityRef.aliases_change
    # Phase 3.4a — baseline Project Tag membership at the entity's
    # origin. References `Story.project_tags[*].id`. Chain-tracked via
    # `EntityRef.tag_changes` at scene anchors. Empty default so
    # pre-Phase-3.4 saves load cleanly. Tags carry no awareness.
    tag_ids: list[str] = Field(default_factory=list)
    notes: str = ""  # author's private notes; not chain-tracked
    # Phase 1.21 — binary {0, 3} scale tracking knowledge of the entity's
    # EXISTENCE ("does X know Bob is a being in the world?"). Distinct from
    # `name_awareness` below — an observer can know the entity exists
    # without knowing the canonical name, OR vice versa.
    awareness: Optional[_AwarenessValue] = None
    # Per-entity awareness scale (parallel to per-attribute
    # `Attribute.awareness_scale`). Governs the entity-existence picker's
    # level set: `binary` = {0, 3}, `full` = {0, 1, 2, 3}. Optional;
    # pre-existing saves load absent and treat as `binary`.
    awareness_scale: Literal["binary", "full"] = "binary"
    # Phase 1.21e — 4-level alias-scale tracking awareness of the
    # entity's CANONICAL NAME ("does X know that this entity is called
    # 'Alice'?"). Same scale as Alias.awareness:
    #   0 — explicitly doesn't know the name
    #   1 — knows the name at face value (heard "Alice" but doesn't link it to anyone)
    #   2 — knows "Alice" is a label for some entity, but doesn't know which
    #   3 — knows "Alice" is THIS entity
    # Worked example justifying the new field: Bob has the canonical name
    # "Alice" + alias "Alicia". An observer can be at
    # `Alias.awareness['Alicia'][bob] = 3` (knows "Alicia" is the entity's
    # alias) AND `Entity.name_awareness[bob] = 0` (explicitly doesn't
    # know the canonical name "Alice"). The pre-Phase-1.21e model
    # couldn't express this distinction.
    name_awareness: Optional[_AwarenessValue] = None

    @model_validator(mode='before')
    @classmethod
    def _migrate_legacy_custom_label(cls, data: Any) -> Any:
        """Retire the legacy `label` field (custom-type-only writer
        identifier) by lifting its value into `name` on load. Saves
        from v0.2.12.17 and earlier carry `label` alongside `name`;
        display surfaces preferred `label || name` so an origin
        rename of `name` left the stale `label` showing in the canvas
        + library. Retired in v0.2.12.18 — single source of truth is
        now `name`.

        Migration rules:
          * `label` present and non-empty:
              - and differs from `name`  → lift into `name` (the
                                            writer's most recent
                                            label override wins; the
                                            original create-time
                                            `name` was auto-derived
                                            from the category).
              - and equals `name`         → no-op (already in sync).
          * `label` absent / null / ''   → no-op (non-custom or never
                                            set).
        The `label` key is stripped from the dict on the way out;
        `extra='ignore'` then drops any residual. No save cliff."""
        if not isinstance(data, dict):
            return data
        legacy_label = data.pop("label", None)
        if legacy_label and isinstance(legacy_label, str) and legacy_label.strip():
            current_name = data.get("name", "") or ""
            if legacy_label != current_name:
                data["name"] = legacy_label
        return data

    @field_validator("awareness", mode='before')
    @classmethod
    def _normalise_awareness(cls, v):
        return _normalise_awareness_input(v)

    @field_validator("name_awareness", mode='before')
    @classmethod
    def _normalise_name_awareness(cls, v):
        return _normalise_awareness_input(v)

    @field_validator("awareness")
    @classmethod
    def _check_awareness(cls, v):
        if v is None:
            return v
        # Allow any of the four levels regardless of the entity's
        # current `awareness_scale` selection — the per-entity scale is
        # a presentation-layer choice (picker level set, badge styling)
        # rather than a storage constraint. A `full`-scale entity that
        # later switches to `binary` retains any level-1 / level-2
        # entries already on file; the picker collapses them visually
        # but the data is preserved.
        return _validate_awareness_field(v, allowed_levels=_ALIAS_LEVELS)

    @field_validator("name_awareness")
    @classmethod
    def _check_name_awareness(cls, v):
        if v is None:
            return v
        return _validate_awareness_field(v, allowed_levels=_ALIAS_LEVELS)
