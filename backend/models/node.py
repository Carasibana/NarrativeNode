from __future__ import annotations
from typing import Any, Literal, Optional, Union
from pydantic import BaseModel, ConfigDict, Field, model_serializer
import uuid

from .entity import Alias, Attribute, Source
from .tag import TagChange


_foreign_content_ok = ConfigDict(extra="ignore")


class Position(BaseModel):
    model_config = _foreign_content_ok
    x: float = 0.0
    y: float = 0.0


class AttributeChange(BaseModel):
    """
    Records a single attribute change at a scene node.
    - action='add':       `attribute` carries the full new Attribute object; other fields unused
    - action='modify':    `attribute_id` identifies the target; `new_value` holds the updated text/preset
                          value and/or `file_ref_change` holds the updated media file reference. null = no
                          change to that field at this node; "" on `file_ref_change` is the sentinel for
                          "clear the file without replacement" (matches the profile_image_change pattern).
    - action='remove':    `attribute_id` identifies the attribute to remove; other fields unused
    - action='list_add':  `attribute_id` identifies a text_list or entity_list attribute; `list_item`
                          holds the single item being added (text string, or entity UUID string)
    - action='list_remove': `attribute_id` identifies a text_list or entity_list attribute; `list_item`
                          holds the single item being removed
    - action='rename':    `attribute_id` identifies the target; `new_name` holds the updated label.
                          Propagates forward from this node — all downstream positions see the new name
                          unless a later rename overrides it again.
    - action='awareness_set': Phase 1.21 — `attribute_id` identifies the target attribute;
                          `list_item` carries the entity_id whose awareness level is being set;
                          `new_value` carries the new level as a string ("0" or "1") — or null to
                          remove the key from the attribute's `awareness` dict entirely. The string-
                          encoded level matches the existing `new_value` typing on this model; the
                          walker decodes it into the integer level when applying.
    - action='awareness_source_add': Phase 1.21g — `attribute_id` identifies the target
                          attribute; `source` carries the projected source object (RelationshipSource
                          or AttributeSource) being added to the attribute's awareness wrapper at
                          this chain position.
    - action='awareness_source_remove': Phase 1.21g — `attribute_id` identifies the target;
                          `source` matches the source being removed (the walker matches by kind +
                          ids, level value is ignored for matching).
    - action='awareness_source_set_level': Phase 1.21g — `attribute_id` identifies the target;
                          `source` matches the source whose level is being changed; the new level
                          rides on `source.level`.
    List changes are stored granularly (one entry per op) so narrative history walks remain deterministic
    and each add/remove is individually attributable to a specific chain position.
    """
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    # Phase 1.21c — stable UUID per change entry. Lets an attached Knowledge
    # (Phase 1.21c Step 10+) reference a specific change by id, survives in-
    # place edits to the change's payload, and backs the cleanup cascade on
    # unmake. Pre-1.21c saves load transparently — `default_factory` fills
    # missing ids on first load; subsequent saves persist them.
    action: Literal[
        "add", "modify", "remove", "list_add", "list_remove", "rename", "awareness_set",
        "awareness_source_add", "awareness_source_remove", "awareness_source_set_level",
    ]
    attribute_id: Optional[str] = None   # for modify / remove / list_add / list_remove / rename / awareness_set / awareness_source_*
    attribute: Optional[Attribute] = None  # for add
    new_value: Optional[str] = None       # for modify (text / preset attribute values)
    file_ref_change: Optional[str] = None  # for modify (media); "" = clear, "assets/…" = replace
    list_item: Optional[str] = None       # for list_add / list_remove / awareness_set — entity_id or list-item string
    new_name: Optional[str] = None        # for rename — updated attribute label
    # Phase 1.22 — per-field modify payloads for circumstance / motivator
    # / number attribute types (and forward-compat for any future type
    # that opts into description / intensity / number_value modifies).
    # A modify event sets exactly one (or more, if the writer commits a
    # multi-field Save in one go) of these to indicate what changed at
    # the chain anchor. The walker applies any non-null `new_*` field.
    # All are optional and additive: pre-1.22 saves load with all of
    # these as `None` and continue to use only `new_value` / `new_name`
    # / `file_ref_change` exactly as today.
    new_description: Optional[str] = None        # for modify of circumstance / motivator description
    new_intensity: Optional[int] = None          # for modify of circumstance / motivator intensity (0-4 or None to clear)
    new_number_value: Optional[float] = None     # for modify of number attribute's numeric value
    # Phase 2.13b — per-field modify payload for the perspective
    # attribute type's target reference. A modify entry against a
    # perspective attribute can rewire its target by setting one or
    # both of these fields. `new_description` (above) handles the
    # description body — perspectives share that field with C / M.
    # Pre-2.13 saves load with both as None (additive); the chain
    # walker treats omitted fields as "no change at this anchor".
    # Explicit null on `new_perspective_target_kind` /
    # `new_perspective_target_id` together at the same modify entry
    # is the explicit "orphan the target" mutation, matching the
    # cascade contract from Phase 2.13a (description body survives
    # with a null target). The 0.2.13.0 load-floor gate from
    # Phase 2.13a already excludes old readers from any save that
    # could contain a perspective, so these fields don't require a
    # separate min_reader_versions bump.
    new_perspective_target_kind: Optional[Literal[
        "character", "location", "item", "faction", "custom",
        "knowledge", "relationship",
    ]] = None
    new_perspective_target_id: Optional[str] = None
    # Phase 1.21h — awareness_set uses an integer level (0..3) on its own
    # field, not the generic `new_value` (which is string-typed for text /
    # preset attribute values). Pre-1.21h saves with `new_value` carrying
    # a string-encoded level continue to load via the walker's read-side
    # fallback.
    level: Optional[int] = None           # for awareness_set: 0 / 1 / 2 / 3 or null (= remove the entry)
    # Phase 1.21g — projected source for awareness_source_* actions.
    source: Optional[Source] = None
    # Phase 1.21c Tier 2 — forward pointer to the Knowledge spawned or
    # most-recently-modified by this change, when applicable. Tier 5
    # populates it via the "Track awareness of this change" affordance.
    # Null on any change not tied to a Knowledge.
    knowledge_id: Optional[str] = None


class AliasChange(BaseModel):
    """Records a single alias change at a scene node.

    Per-alias chain event — replaces the pre-2026-05-17 full-list
    snapshot model (`EntityRef.aliases_change: Optional[list[Alias]]`).
    The snapshot model overwrote the entity's full alias list at each
    scene, which discarded every upstream addition when a later edit
    landed at a downstream scene. The per-element event model
    (mirroring `AttributeChange`) fixes that — each event is
    individually attributable, applies additively, and never silently
    discards an upstream alias.

    Pre-2026 saves with old `aliases_change` snapshots are converted
    to a sequence of synthetic `add` / `remove` events by
    `_migrate_aliases_to_chain_events` in `file_service.py`. The
    walker reads `alias_changes` going forward.

    Action semantics:
    - action='add':     `alias` carries the full new Alias object
                        (including its `id`); other fields unused.
    - action='remove':  `alias_id` identifies the alias to drop from
                        this scene forward. Other fields unused.
    - action='modify':  `alias_id` identifies the target; `new_value`
                        holds the updated alias text. Aliases have
                        only one free-form text field, so 'modify' +
                        'rename' collapse into a single action here
                        (unlike `AttributeChange` which separates them
                        because attributes have name + value as
                        independent fields).
    - action='awareness_set': `alias_id` identifies the target;
                        `observer_id` carries the observer; `level`
                        carries the new level (0/1/2/3 or null to
                        remove the observer's entry from this alias's
                        awareness dict).
    - action='awareness_source_add' / 'awareness_source_remove' /
      'awareness_source_set_level': `alias_id` identifies the target;
                        `source` carries the projected source object
                        being added / removed / level-changed on the
                        alias's awareness wrapper. Mirrors
                        `AttributeChange`'s `awareness_source_*`
                        semantics for per-attribute awareness.
    """
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    action: Literal[
        "add", "remove", "modify",
        "awareness_set",
        "awareness_source_add", "awareness_source_remove", "awareness_source_set_level",
    ]
    alias_id: Optional[str] = None       # for remove / modify / awareness_*
    alias: Optional[Alias] = None        # for add (carries full new Alias, including its id)
    new_value: Optional[str] = None      # for modify (new alias text)
    observer_id: Optional[str] = None    # for awareness_set
    level: Optional[int] = None          # for awareness_set: 0/1/2/3 or null (remove observer's entry)
    source: Optional[Source] = None      # for awareness_source_*
    # Phase 1.21c Tier 2 — forward pointer to a Knowledge spawned or
    # most-recently-modified by this change. Same shape as the
    # equivalent field on `AttributeChange` / `AwarenessChange`.
    knowledge_id: Optional[str] = None


class AwarenessChange(BaseModel):
    """Phase 1.21 — single awareness-level mutation recorded on a scene's
    `EntityRef.awareness_changes`.

    Covers entity-level and relationship-level awareness mutations. Per-
    attribute awareness rides the existing `AttributeChange` with
    `action='awareness_set'`; per-alias awareness rides the existing
    `aliases_change` full-replacement mechanism (Phase 1.18).

    Fields:
      target:          "entity" mutates the chip's entity's `awareness` dict;
                       "relationship" mutates the referenced relationship's
                       `awareness` dict (by id);
                       "entity_name" mutates the chip's entity's `name_awareness` dict.
      relationship_id: required when target == "relationship"; null otherwise.
      entity_id:       (direct-entry mutation) the entity_id whose level is being set
                       in the awareness dict.
      level:           (direct-entry mutation) new level, or None to remove the
                       entity_id key entirely.

      Phase 1.21g — projected source mutations:
      source_action:   "add", "remove", or "set_level". When set, this entry
                       represents a chain-time mutation of the awareness wrapper's
                       `sources` list rather than its direct-entries dict.
      source:          the projected source being added / matched / re-leveled.
                       For "set_level", the new level rides on `source.level`.
                       Direct-entry mutations leave `source_action` and `source` null;
                       source mutations leave `entity_id` empty / level null.
    """
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    # Phase 1.21c — stable UUID (see AttributeChange.id rationale).
    # Phase 1.21e — `entity_name` target added for chain-time mutations to
    # `Entity.name_awareness` (4-level scale on the canonical name). The
    # chip-entity that carries the change is the TARGET (whose canonical
    # name is being learned about); `entity_id` is the OBSERVER who is
    # gaining/losing awareness of that canonical name. Walker writes
    # `chipEntity.name_awareness[entity_id] = level` per the universal
    # awareness convention — same direction as existing `entity` /
    # `relationship` targets.
    target: Literal["entity", "relationship", "entity_name", "alias"]
    relationship_id: Optional[str] = None
    # Required when target == "alias"; the alias's `value` is the
    # discriminator (alias values are unique per entity).
    alias_value: Optional[str] = None
    # Direct-entry mutations leave `entity_id` set and `source_action` null.
    # Source mutations leave `entity_id` as an empty string and set `source_action`.
    entity_id: str = ""
    level: Optional[int] = None
    # Phase 1.21g — projected source mutation fields.
    source_action: Optional[Literal["add", "remove", "set_level"]] = None
    source: Optional[Source] = None
    # Phase 1.21c Tier 2 — forward pointer to a Knowledge spawned or
    # modified by this awareness change. See AttributeChange.knowledge_id.
    knowledge_id: Optional[str] = None


class ReviewFlag(BaseModel):
    """Enriched review flag with upstream/downstream context values."""
    model_config = _foreign_content_ok
    field: str
    fieldLabel: Optional[str] = None
    sourceInputValue: Optional[Any] = None
    previousInherited: Optional[Any] = None
    currentInherited: Optional[Any] = None
    downstreamValue: Optional[Any] = None
    sourceNodeId: Optional[str] = None


class EntityRef(BaseModel):
    model_config = _foreign_content_ok
    entity_id: str
    # First-class change fields — null means no change at this node; value propagates forward
    name_change: Optional[str] = None
    colour_change: Optional[str] = None
    description_change: Optional[str] = None
    profile_image_change: Optional[str] = None  # new asset file_ref, or "" to clear
    # Per-alias chain events (2026-05-17). Replaces the pre-2026 full-list-
    # snapshot semantics that lost upstream additions when downstream
    # edits landed. See `AliasChange` for action shapes. Pre-2026 saves
    # carrying the old `EntityRef.aliases_change: Optional[list[Alias]]`
    # snapshot are converted to a sequence of synthetic `add` events on
    # load by the migration shim `_migrate_aliases_to_chain_events` in
    # `file_service.py`; the legacy field is then null and silently
    # dropped by Pydantic's `extra='ignore'` config.
    alias_changes: list[AliasChange] = Field(default_factory=list)
    attribute_changes: list[AttributeChange] = Field(default_factory=list)
    awareness_changes: list[AwarenessChange] = Field(default_factory=list)  # Phase 1.21 — entity/relationship awareness mutations at this node
    # Phase 3.4a — Project Tag membership chain events at this scene
    # anchor. `node_id` is implicit by container position (the EntityRef
    # itself is anchored to one scene), so individual entries carry
    # just `id`, `action`, `tag_id`. See `TagChange` for the shape and
    # the same-node opposite-pair cancellation rule applied at write
    # time.
    tag_changes: list[TagChange] = Field(default_factory=list)
    has_pov: bool = False  # characters only; true = this character carries POV at this node
    # Phase 1.21c Tier 0 — stable UUIDs for the scalar change fields
    # (`name_change` / `colour_change` / `description_change` /
    # `profile_image_change`). Keys are field names; values are UUID
    # strings. Lazy-filled the first time a scalar field is written;
    # entry removed when the corresponding field is cleared (set to
    # null). Universalises event identity across both array events
    # (which carry their own `id`) and scalar events, so the
    # attached-Knowledge `SourceEventRef` resolves through one
    # `change_id` lookup regardless of event kind. Pre-Tier-0 saves
    # load with an empty dict; the dict self-fills on the next scalar-
    # field write.
    scalar_change_ids: dict[str, str] = Field(default_factory=dict)
    # Phase 1.21c Tier 2 — forward pointers from scalar events to
    # attached Knowledges. Keys are field names (same as
    # `scalar_change_ids`); values are Knowledge ids. Populated by
    # Tier 5's "Track awareness of this change" affordance when the
    # user attaches a Knowledge to a scalar EntityRef event. Mirrors
    # `AttributeChange.knowledge_id` / `AwarenessChange.knowledge_id`
    # but lives off-event because scalar events have no carrier
    # object of their own. Cleanup-cascade detection prefers this
    # forward pointer over scanning all knowledges.
    scalar_change_knowledge_ids: dict[str, str] = Field(default_factory=dict)
    # Downstream review flags — field names that need review because an upstream node
    # also modifies the same field. Computed client-side; non-blocking.
    # Accepts both legacy plain strings and enriched ReviewFlag objects.
    review_fields: list[Union[str, ReviewFlag]] = Field(default_factory=list)


class EntityNode(BaseModel):
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_type: Literal["entity"] = "entity"
    entity_id: Optional[str] = None  # None for blank modifier nodes (assigned when wired)
    position: Position = Field(default_factory=Position)
    width: Optional[float] = None
    height: Optional[float] = None
    # True when this node was explicitly created as a modifier node (not a definition/origin node)
    is_modifier: bool = False
    # Override fields for modifier mode
    name_change: Optional[str] = None
    colour_change: Optional[str] = None
    description_change: Optional[str] = None
    profile_image_change: Optional[str] = None
    # Per-alias chain events on this modifier node. Mirrors
    # `EntityRef.alias_changes` exactly — same model class, same actions.
    # Pre-2026 saves carrying the legacy `aliases_change` snapshot are
    # migrated to events on load (see `_migrate_aliases_to_chain_events`
    # in `file_service.py`); the legacy field is then silently dropped
    # by Pydantic's `extra='ignore'` config.
    alias_changes: list[AliasChange] = Field(default_factory=list)
    attribute_changes: list[AttributeChange] = Field(default_factory=list)
    # Phase 3.4a — Project Tag membership chain events at this modifier
    # node. Mirrors `EntityRef.tag_changes` exactly — same model class,
    # same actions, same same-node opposite-pair cancellation rule.
    tag_changes: list[TagChange] = Field(default_factory=list)
    # Phase 1.21c Tier 0 — stable UUIDs for the modifier scalar change
    # fields. Mirrors `EntityRef.scalar_change_ids`; lazy-filled on
    # first write to a scalar field, removed on null. Modifier-node
    # scalar events are addressed identically to EntityRef scalar
    # events through `SourceEventRef.change_id`.
    scalar_change_ids: dict[str, str] = Field(default_factory=dict)
    # Phase 1.21c Tier 2 — forward pointers from modifier-node scalar
    # events to attached Knowledges. See EntityRef.scalar_change_knowledge_ids.
    scalar_change_knowledge_ids: dict[str, str] = Field(default_factory=dict)
    # Downstream review flags — same as EntityRef.review_fields, for modifier nodes
    review_fields: list[Union[str, ReviewFlag]] = Field(default_factory=list)
    # Phase 1.26 — writer-set manual height for the description block in
    # canvas-px. Mirrors SceneNode.description_height: ABSENT (None) means
    # auto-fit using the renderer's default 3-line cap; PRESENT means the
    # writer dragged the description's bottom-edge handle to override and
    # the value is the chosen px height. Dragging back down to (or below)
    # the auto-fit floor clears this field — it is NOT serialised when
    # null, so older saves without the field round-trip cleanly.
    description_height: Optional[float] = None

    # Phase 1.26 — Per-(entity, kind) manual ordering of circumstance /
    # motivator sub-chips at this anchor. Outer key = entity_id (always
    # the node's own entity_id for an EntityNode, but the field shape
    # is kept symmetric with SceneNode.cm_chip_order so the same store
    # action / sort helper apply to both anchor kinds), inner key =
    # "circumstance" | "motivator", value = ordered list of sub-chip
    # ids. Empty / missing = auto-sort (descending intensity, then
    # UUID); populated = manual mode (each id at its position; new
    # sub-chips not yet in the list fall to the end).
    cm_chip_order: dict[str, dict[str, list[str]]] = Field(default_factory=dict)

    @model_serializer(mode='wrap')
    def _serialize(self, handler):
        # Phase 1.26 — drop `description_height` from the on-disk form
        # when null, matching the SceneNode pattern. Keeps saves clean
        # of redundant fields and lets pre-1.26 saves round-trip
        # without picking up an explicit-null artifact.
        data = handler(self)
        if data.get('description_height') is None:
            data.pop('description_height', None)
        return data


class TimeDelta(BaseModel):
    """Phase 1.23 — relative time delta with writer-chosen display unit.

    Used by:
    - `SceneNode.gap_extension` — the writer's relative offset beyond
      the walker-computed floor (planning doc §5.1). Effective Time
      Since Last Scene = floor + gap_extension, then snap-forward.
    - `SceneNode.last_known_gap` — the most recent walker-computed
      Time Since Last Scene value, persisted so the gap-shift
      threshold check has a baseline across chain rewires (§3.4.1).
    - `Story.gap_shift_threshold` — per-story threshold above which
      a gap shift triggers a notification (§7.4).

    Unit set is intentionally narrow — months / years are excluded
    because between-scene gaps that long are better expressed by
    pinning the next scene's Day directly. Negative `value` is
    accepted by the model and only meaningful when the story's
    `allow_negative_time` toggle is on (time travel, §7.2);
    enforcement of that constraint is at write time in the UI, not
    at the model level.
    """
    model_config = _foreign_content_ok
    unit: Literal["minutes", "hours", "days", "weeks"]
    value: int


class Duration(BaseModel):
    """Phase 1.23 — Scene Duration discriminated union.

    Captures how much in-story time a scene takes. Discriminated by
    `kind`; null/missing reads as Ambiguous. The save reflects
    exactly the carousel stop the writer was on at Save time —
    other stops' in-modal drafts are session-only and not persisted
    (planning doc §4.2). Magnitude without specifics is valid: a
    writer can pick `kind='hours'` with `value=None` to commit to
    "on the order of hours, exact length unspecified" (§4 lead
    callout).

    Per-kind field usage:
    - 'ambiguous'           — no other fields. Same effect as null.
    - 'minutes'             — `value` (Optional float; integer
                              minutes in practice).
    - 'hours'               — `value` (Optional float; integer or
                              decimal hours).
    - 'all_period'          — no other fields. Period is inferred
                              from the scene's start Time of Day at
                              walk time (5-bucket vocabulary, §4.1.1).
    - 'span'                — `end_period` from the 5-bucket set;
                              start half is inferred from the scene's
                              start Time of Day at walk time.
    - 'all_day'             — no other fields.
    - 'days'                — `value` (Optional float; integer days
                              in practice).

    No cross-field validator: per the "never blocking" principle in
    the planning doc, the model preserves whatever shape the writer's
    UI commits. Mismatched fields (e.g. `kind='all_day'` with a
    stray `value`) are tolerated on load and ignored at walk time.
    """
    model_config = _foreign_content_ok
    kind: Literal[
        "ambiguous", "minutes", "hours", "all_period", "span", "all_day", "days",
    ]
    value: Optional[float] = None
    # `end_period` historically held a 5-bucket period name (morning,
    # noon, afternoon, evening, night). v0.1.23.x: relaxed to a free
    # string so the writer can pick at the same Tier-2 label
    # granularity they used to pin the start (e.g. "Sunset",
    # "Late Afternoon"). Pre-existing 5-bucket values continue to
    # load; the front-end Span widget reads either form.
    end_period: Optional[str] = None
    # When `kind == 'all_day'`, this sub-discriminator picks the
    # specific end-point semantics:
    #   - "all_day"             — scene ends when the daytime ends
    #                             (evening period begins, 16:30 same
    #                             day). Variable duration based on
    #                             the scene's start.
    #   - "all_night"           — scene ends at the day cycle's
    #                             midnight boundary (24:00 same day).
    #                             Variable based on start.
    #   - "until_next_evening"  — scene crosses midnight and runs
    #                             into the following day, ending at
    #                             that day's evening start (16:30 of
    #                             day+1, = 2430 minutes from start of
    #                             current chain-day).
    # Legacy save-compat: pre-v0.1.23.23 saves used "until_next_day"
    # for a "ends ~6am next day" semantic that has been retired.
    # Those saves silently load under the new "until_next_evening"
    # semantic, shifting their end-time forward by ~10.5h. Preserving
    # the load path matters more than preserving the old end-time.
    # Pre-existing saves with `kind:'all_day'` and no variant
    # continue to load; the walker treats them as a legacy 24-hour
    # block.
    all_day_variant: Optional[Literal["all_day", "all_night", "until_next_evening", "until_next_day"]] = None


class Circumstance(BaseModel):
    """Phase 1.22 — scene-side circumstance.

    A property of the scene itself (not chain-tracked). Lives on
    `SceneNode.circumstances`; applies to every entity present in the
    scene as part of the unified circumstance pool the writer reads
    when authoring the scene. Same field shape as a circumstance-typed
    `Attribute` (id / optional name / description / optional intensity)
    but kept as its own model so the scene-side system shares no
    machinery with the entity-attribute system (no shared chain-tracking,
    no shared deletion cascade, no shared lookup paths).

    Examples: 'Raining', 'At the bet party', 'Loud and crowded'.
    """
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: Optional[str] = None       # compact label (optional; row falls back to truncated description)
    description: str                 # required, non-empty
    intensity: Optional[int] = None  # 0-4 slider tier or None for unset

    def model_post_init(self, __context):
        # Phase 1.22 (relaxed in v0.1.22.40 to match the entity-side
        # circumstance / motivator rule landed in v0.1.22.17): name and
        # description are each individually optional, but at least one
        # must be non-empty. Lets writers create a scene-level
        # circumstance like just "Raining" with no description, or a
        # description-only entry without bothering with a separate
        # label. Both blank is rejected because the row would have
        # nothing to display.
        has_name = bool(self.name and self.name.strip())
        has_desc = bool(self.description and self.description.strip())
        if not (has_name or has_desc):
            raise ValueError(
                "Circumstance must have at least one of name or description"
            )
        if self.intensity is not None:
            if not isinstance(self.intensity, int) or self.intensity < 0 or self.intensity > 4:
                raise ValueError(
                    f"Circumstance intensity must be None or in {{0,1,2,3,4}}; got {self.intensity!r}"
                )


class EntityTemporaryCM(BaseModel):
    """Phase 1.22h — Temporary circumstance / motivator scoped to a
    specific entity at a specific scene only.

    Lives on `SceneNode.entity_temporary_circumstances` (NOT on the
    entity's chain). Same field shape as a circumstance / motivator
    `Attribute` but kept as its own model so the temporary system
    shares no machinery with the chain-tracking entity-attribute
    system: the chain walker doesn't see these, downstream scenes
    don't inherit them, and there's no chain-history for them.

    A writer adds one via the entity Detail Panel's `+ Add [C/M]
    Temporary` button at a chain anchor (chip / modifier mode only —
    not at origin, where there's no scene to scope to). It applies
    only to the named `entity_id` and only at this scene. To make
    one persist forward, the writer clicks "Make Ongoing" which
    atomically removes the temporary and adds an `action='add'`
    chain entry on the entity's `attribute_changes` at this scene
    with the same payload (so the data becomes chain-tracked from
    this scene forward).

    `attribute_type` is constrained to `circumstance` or `motivator`
    only — temporaries don't apply to text / preset / file / list /
    number attribute types.
    """
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    entity_id: str                                    # which entity this applies to at this scene
    attribute_type: Literal["circumstance", "motivator"]
    name: Optional[str] = None
    description: str = ""
    intensity: Optional[int] = None

    def model_post_init(self, __context):
        # At-least-one-of-name-or-description rule, mirroring the
        # entity-side circumstance / motivator validator (v0.1.22.17)
        # and the scene-side Circumstance validator (v0.1.22.40).
        has_name = bool(self.name and self.name.strip())
        has_desc = bool(self.description and self.description.strip())
        if not (has_name or has_desc):
            raise ValueError(
                f"EntityTemporaryCM must have at least one of name or description"
            )
        if self.intensity is not None:
            if not isinstance(self.intensity, int) or self.intensity < 0 or self.intensity > 4:
                raise ValueError(
                    f"EntityTemporaryCM intensity must be None or in {{0,1,2,3,4}}; got {self.intensity!r}"
                )


class SceneNode(BaseModel):
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_type: Literal["scene"] = "scene"
    title: str = ""         # Short label — shown prominently in the node header
    description: str = ""   # Optional short-form description — shown below entity chips
    # Phase 1.26 — writer-set manual height for the description block
    # in canvas-px. ABSENT (None) means auto-fit using the renderer's
    # default scroll cap; PRESENT means the writer dragged the
    # description's bottom-edge handle to override and the value is
    # the chosen px height. Dragging back down to (or below) the
    # auto-fit floor clears this field — it is NOT serialised when
    # null, so older saves without the field round-trip cleanly and
    # an override that gets removed disappears from the on-disk save
    # rather than persisting as an explicit null.
    description_height: Optional[float] = None
    main_content: str = ""  # TipTap HTML
    position: Position = Field(default_factory=Position)
    width: Optional[float] = None
    height: Optional[float] = None
    characters: list[EntityRef] = Field(default_factory=list)
    locations: list[EntityRef] = Field(default_factory=list)
    items: list[EntityRef] = Field(default_factory=list)
    factions: list[EntityRef] = Field(default_factory=list)
    customs: list[EntityRef] = Field(default_factory=list)
    # Phase 1.21c — `knowledges: list[EntityRef]` removed. Knowledge is
    # no longer an Entity subtype; it has no scene chip. Pre-refactor
    # saves with populated `knowledges` entries load via `extra="allow"`
    # and are scrubbed by `_migrate_knowledge_refactor` in
    # `file_service.py`.
    chip_order: list[str] = Field(default_factory=list)  # ordered entity_ids for display
    # POV chip attachment — entity_id of the character this scene's POV chip is attached to
    pov_entity_id: Optional[str] = None
    # Flashback scene subtype — read-only ghost of a parent scene
    is_flashback: bool = False
    parent_scene_id: Optional[str] = None
    # Phase 1.22 — scene-side circumstances. Parallel system to the
    # entity-attribute machinery: same row shape, separate model, no
    # shared chain-tracking. These apply to every entity in the scene
    # as part of the writer's "what's going on here" digest.
    circumstances: list[Circumstance] = Field(default_factory=list)

    # Phase 1.22h — Temporary circumstances / motivators scoped to a
    # specific entity at THIS scene only. Stored on the scene (not on
    # the entity's chain) so they are scene-local by construction —
    # the chain walker doesn't see them, downstream scenes don't
    # inherit them. Render time joins these with each entity's chain-
    # resolved circumstance / motivator attributes for display. A
    # writer can convert a temporary to an ongoing chain entry via
    # the "Make Ongoing" affordance, which atomically removes the
    # temporary and adds an `action='add'` chain entry to the
    # entity_ref at this scene with the same payload.
    entity_temporary_circumstances: list[EntityTemporaryCM] = Field(default_factory=list)

    # Phase 1.26 — Per-(entity, kind) manual ordering of circumstance /
    # motivator sub-chips at this scene. Outer key = entity_id, inner key =
    # "circumstance" | "motivator", value = ordered list of sub-chip ids
    # (mixing chain-resolved attribute ids and temporary EntityTemporaryCM
    # ids; both are UUIDs and live in disjoint id spaces). Empty / missing
    # = auto-sort mode (descending intensity, then UUID); populated =
    # manual mode (each id in the list takes that position; new sub-chips
    # not yet in the list fall to the end). Mirrors the existing per-scene
    # `chip_order` mechanism that orders entity chips on the scene.
    cm_chip_order: dict[str, dict[str, list[str]]] = Field(default_factory=dict)

    # ── Phase 1.23 — Date / Time Tracking ─────────────────────────
    # A writer-friendly, partial-info time layer using the POV chain
    # as the timeline. Per-scene
    # pinned values (Time of Day / Day / Scene Duration) feed a
    # POV-chain walker that computes a "floor" (earliest possible
    # start) for each downstream scene; a relative `gap_extension`
    # lets the writer extend the gap beyond the floor. Strict-date
    # enforcement (year tracking, real-Gregorian cross-check) is
    # parked for V2 — see `Phase 1.23 - Strict Date Enforcement
    # (V2 Parked).md`.
    #
    # Carousel-tier values: the modal commits exactly ONE tier per
    # group (Time of Day / Day) at Save time; other tiers' draft
    # values are session-only and not persisted. Reading code keys
    # off the `_tier` discriminator and reads ONLY the corresponding
    # leaf field; the others are null on disk.
    time_of_day_tier: Optional[Literal["broad", "labelled", "exact"]] = None
    time_of_day_broad: Optional[Literal["day", "night"]] = None
    time_of_day_labelled: Optional[str] = None  # one of the 12 labelled vocab values
    time_of_day_exact: Optional[str] = None     # 'HH:MM' (24h, internal)

    # The original Phase 1.23 design folded weekday / day-of-month /
    # month into one carousel ("Day"). It split into four independent
    # fields after the v0.1.23.5 design pass: weekday, season, and a
    # date carousel with its own tier discriminator. Each field is
    # pinnable on its own — a scene can carry just a weekday, just a
    # season, both, neither, or all four. They share no cross-coupling
    # and no implied auto-fill (e.g. "March" never auto-suggests
    # "Spring"; the writer's world isn't assumed to be northern-
    # hemisphere Earth).
    # Date carousel: weekday is included as an optional component at
    # every tier (the writer can always pin a weekday on top of the
    # month / month+day they choose). The `date_tier` discriminator
    # tells the reader which leaf fields are populated:
    #   weekday        — `weekday` only.
    #   month_dow      — `weekday` (optional) + `date_month`.
    #   month_day_dow  — `weekday` (optional) + `date_month` + `date_day_of_month`.
    # Season is its own independent field, untouched by the date tier.
    weekday: Optional[int] = None         # 0=Sun ... 6=Sat
    season: Optional[int] = None          # 0=Spring, 1=Summer, 2=Fall, 3=Winter
    date_tier: Optional[Literal["weekday", "month_dow", "month_day_dow"]] = None
    date_month: Optional[int] = None      # 1..12 (1=January ... 12=December)
    date_day_of_month: Optional[int] = None  # 1..31. February allows 29
                                          # explicitly; pinning Feb 29 IS
                                          # the "leap year asserted" claim
                                          # for that scene. The base
                                          # MONTH_DAYS table treats Feb as
                                          # 28 unless a scene explicitly
                                          # picks the 29th.
    date_year: Optional[int] = None       # V2-reserved (strict-date enforcement). Never written or
                                          # displayed in v1; field exists so V2 doesn't need a schema migration.

    scene_duration: Optional[Duration] = None

    # `gap_extension` is the writer's pinned relative offset beyond
    # the floor (planning doc §5.1). Effective Time Since Last Scene
    # = floor + gap_extension (then snap-forward). Survives chain
    # rewires.
    gap_extension: Optional[TimeDelta] = None

    # `last_known_gap` (legacy field name, retained for back-compat)
    # paired with `last_known_floor_minutes` — the persisted baseline
    # for loose-mode notification alerts. The alert metric is the
    # downstream scene's FLOOR (its earliest possible slot in
    # chain-relative minutes), not the gap, because an upstream
    # Time-of-Day pin change can move the floor without changing the
    # gap. Survives disconnect/reconnect from the POV chain so the
    # threshold check always has a baseline. Null on scenes that
    # have never been on the POV chain.
    last_known_gap: Optional[TimeDelta] = None
    last_known_floor_minutes: Optional[int] = None
    # `last_known_effective_minutes` — paired with the floor baseline.
    # Captures the post-snap-forward effective start so detection can
    # fire when the writer's own pin (TOD / weekday / date / leap-year
    # Feb 29) crosses a snap boundary that produces a much larger
    # effective shift than the underlying floor delta. Either delta
    # exceeding the threshold raises an absorbed_shift alert.
    last_known_effective_minutes: Optional[int] = None

    # Loose-mode notification alerts (planning §10.1.1 + §10.1.2).
    # Same shape as EntityRef.review_fields — a list of ReviewFlag
    # entries (or legacy plain strings) that the alerts panel renders
    # as soft, non-blocking review badges. For Time-Since-Last-Scene
    # alerts each entry carries `field='time_since_last_scene'` plus
    # the trigger-specific payload (kind, previousGap, newGap, etc.)
    # in `_foreign_content_ok` extra fields. Sequential cascade rule
    # §3.4.2 means at most one entry of this kind appears at a time
    # per save pass.
    review_fields: list[Union[str, ReviewFlag]] = Field(default_factory=list)

    @model_serializer(mode='wrap')
    def _serialize(self, handler):
        # Phase 1.26 — drop `description_height` from the on-disk
        # form when it's null (the writer hasn't manually overridden
        # the description box's auto-fit height). Keeps saves clean
        # of unnecessary fields and lets pre-1.26 saves round-trip
        # without picking up an explicit-null artifact. Other
        # Optional fields keep the project's existing always-include
        # convention via the default handler.
        data = handler(self)
        if data.get('description_height') is None:
            data.pop('description_height', None)
        return data


class PovOriginNode(BaseModel):
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_type: Literal["pov_origin"] = "pov_origin"
    position: Position = Field(default_factory=Position)
    width: Optional[float] = None
    height: Optional[float] = None


class ReferenceNode(BaseModel):
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_type: Literal["reference"] = "reference"
    sub_type: Literal["note", "media", "concept"]
    title: str = ""
    colour: str = "#40afd0"
    content: str = ""                    # freeform text (note) or TipTap JSON string (note, rich text mode)
    is_rich_text: bool = False           # when True, content holds TipTap JSON; canvas shows rendered preview
    file_ref: Optional[str] = None       # asset path (media sub-type)
    collapsed: bool = False
    opaque: bool = False
    position: Position = Field(default_factory=Position)
    width: Optional[float] = None
    height: Optional[float] = None
    collapsed_width: Optional[float] = None
    collapsed_height: Optional[float] = None
    # Phase 3.4a — baseline-only Project Tag membership. ReferenceNode
    # is a free-floating canvas annotation with no chain history of
    # its own, so its tag set is fixed at the project level. Same
    # `Story.project_tags[*].id` referencing as every other host.
    tag_ids: list[str] = Field(default_factory=list)


class RelationshipOriginNode(BaseModel):
    """Canvas node representing a relationship's origin (chain index 0).

    Auto-created when two entity origin nodes are wired together, or via the
    context menu "Add Relationship" (ToDo #3). One per relationship;
    relationships born inside a scene have no origin node.

    Has an input port accepting wires from entity origin nodes (and entity
    chips in scenes) but NO output port: propagation to scenes is via
    auto-chain (v0.1.18.86 ambient rule) and drag-from-library-to-scene
    (ToDo #2).
    """
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_type: Literal["relationship_origin"] = "relationship_origin"
    relationship_id: str
    position: Position = Field(default_factory=Position)
    width: Optional[float] = None
    height: Optional[float] = None
    # Phase 1.26 — writer-set manual height for the description block in
    # canvas-px. Mirrors SceneNode / EntityNode `description_height`:
    # ABSENT (None) means auto-fit using the renderer's default 3-line cap;
    # PRESENT means the writer dragged the description's bottom-edge handle
    # to override. NOT serialised when null so older saves round-trip cleanly.
    description_height: Optional[float] = None

    @model_serializer(mode='wrap')
    def _serialize(self, handler):
        # Drop `description_height` when null, matching the SceneNode /
        # EntityNode pattern.
        data = handler(self)
        if data.get('description_height') is None:
            data.pop('description_height', None)
        return data


class KnowledgeOriginNode(BaseModel):
    """Phase 1.21c — Canvas node anchoring a Knowledge's creation point.

    Optional, at most one per Knowledge. Knowledges with no origin node
    behave as pre-story baseline. The node's position in the canvas's
    story order anchors the Knowledge's creation point (Step 15 chain
    walker integration).

    Port structure (Step 14 design — see KnowledgeOriginNode.jsx):
      - Output port, no input.
      - Output wires target entity origin nodes / entity chips on scenes
        and grant the target entity awareness of the Knowledge at the
        target's chain position. The connect handler ships in a follow-up.
      - Knowledges aren't "created" by other narrative objects via wires;
        Step 11's attached-Knowledge flow is the event-driven creation
        path for event-spawned knowledges.
    """
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_type: Literal["knowledge_origin"] = "knowledge_origin"
    knowledge_id: str
    position: Position = Field(default_factory=Position)
    width: Optional[float] = None
    height: Optional[float] = None
    # Phase 1.26 — writer-set manual height for the description block in
    # canvas-px. Mirrors SceneNode / EntityNode / RelationshipOriginNode
    # `description_height`: ABSENT (None) means auto-fit using the
    # renderer's default 3-line cap; PRESENT means the writer dragged the
    # description's bottom-edge handle to override. NOT serialised when
    # null so older saves round-trip cleanly.
    description_height: Optional[float] = None

    @model_serializer(mode='wrap')
    def _serialize(self, handler):
        # Drop `description_height` when null, matching the other origin
        # node patterns.
        data = handler(self)
        if data.get('description_height') is None:
            data.pop('description_height', None)
        return data


class GenericGroup(BaseModel):
    """ComfyUI-style freeform group container.

    A user-drawn rectangle on the canvas that visually groups nodes.
    Membership is PURELY GEOMETRIC and DERIVED — a node belongs to the
    group iff its bounding box is fully contained inside the group box.
    No `node_ids[]` list is stored; there is no stale-reference bug class.

    Groups can overlap freely; a node may belong to multiple groups
    simultaneously. Groups have ZERO effect on chapters, export, the
    narrative chain, or any derived state. They are a pure visual /
    organisational aid.
    """
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_type: Literal["generic_group"] = "generic_group"
    title: str = ""
    colour: str = "#71717a"              # zinc-500; user-editable
    position: Position = Field(default_factory=Position)
    width: float = 400.0                 # flow-px
    height: float = 300.0                # flow-px
    # Phase 8.5 — concept-group mode. True = a concept / brainstorming group: its
    # concept ports are available, it participates in the concept graph, and the
    # concept auto-layout may arrange it. False = a plain organisation container:
    # concept ports hidden, excluded from the concept layout. The field DEFAULTS
    # FALSE so a pre-8.5 group (saved before the field existed) loads as a plain
    # organisation group, which is the expected behaviour (nothing shipped with
    # groups exposing concept ports). NEW groups are created with it explicitly
    # True (see the frontend `addGroupNode`). Additive Optional field, no cliff.
    concept_group: bool = False
