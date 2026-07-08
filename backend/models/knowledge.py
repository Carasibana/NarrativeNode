"""Phase 1.21c — Knowledge and related types.

First-class object type parallel to Relationship, not an Entity subtype.
A Knowledge represents a discrete piece of story information (a secret, a
reveal, a curse, an abstract fact) with a name, description, colour, and
optional avatar, plus awareness tracking for who knows it.

Awareness is chain-tracked via the awareness-as-second-class-object model:
- `Knowledge.awareness` carries the ORIGIN state (who knows at story
  start) AND its own chain history. The wrapper shape
  `{entries?, sources?, history?}` exposes baseline observer levels
  on `entries` and chain mutations on `history` (an
  `AwarenessHistoryEntry` list — see `models/entity.py`). Effective
  awareness at any chain position Y = origin baseline + all history
  entries with `node_id ≤ Y` in story order.

Knowledge ALSO chain-tracks content mutations (name, description, colour
changes at specific scenes), mirroring how attributes can be modified at
chain positions. `history.name_changes` / `description_changes` /
`colour_changes` each carry `node_id` + a `source_event` back-pointer to
the triggering event (if any).
"""

from __future__ import annotations
from typing import Literal, Optional, Union
from pydantic import BaseModel, ConfigDict, Field, field_validator
import uuid

from .entity import (
    AwarenessRef,
    AwarenessWrapper,
    ManualAnchor,
    SourceEventRef,  # lifted to entity.py in v0.2a.2.x; re-exported below
    _normalise_awareness_input,
    _validate_awareness_field,
    _ALIAS_LEVELS,
)
from .tag import KnowledgeTagChange


_foreign_content_ok = ConfigDict(extra="ignore")


# `SourceEventRef` is defined in `entity.py` so that the canonical
# `AwarenessHistoryEntry` (also in `entity.py`) can carry it directly.
# Re-exported here for back-compat with any caller using
# `from .knowledge import SourceEventRef`.
__all__ = ["SourceEventRef"]


# ── KnowledgeHistory change types ──────────────────────────────────────────
#
# Each change type carries its own UUID id (so other refs can point at a
# specific history entry) plus an optional `source_event` back-pointer
# (populated by the attached-Knowledge wiring in Phase 1.21c Step 10+).

class KnowledgeNameChange(BaseModel):
    """Knowledge's display name changed at a chain position. Propagates
    forward from this node until a later change overrides it."""
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_id: str
    new_name: str
    source_event: Optional[SourceEventRef] = None


class KnowledgeDescriptionChange(BaseModel):
    """Knowledge's description text changed at a chain position."""
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_id: str
    new_description: str
    source_event: Optional[SourceEventRef] = None


class KnowledgeColourChange(BaseModel):
    """Knowledge's accent colour changed at a chain position."""
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_id: str
    new_colour: str
    source_event: Optional[SourceEventRef] = None


class KnowledgeExistenceChange(BaseModel):
    """Knowledge "comes into existence" or ceases to exist at a chain
    position. Mirrors `Relationship.history.existence_changes`. The
    earliest `activate` event in story order is the Knowledge's birth
    scene (its scene-born creation point — distinct from a canvas-side
    `<KnowledgeOriginNode>`, which is the off-scene creation anchor for
    pre-story-baseline Knowledges).

    For now the action set is `'activate'`-only (Knowledge "deactivate"
    semantics are unusual narratively; left open for future).
    """
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_id: str
    action: Literal["activate"] = "activate"
    source_event: Optional[SourceEventRef] = None


class KnowledgeProfileImageChange(BaseModel):
    """Knowledge's avatar / profile image changed at a chain position.
    `new_profile_image_ref` carries the new asset reference, or None to
    explicitly clear the image at this point in the chain."""
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_id: str
    new_profile_image_ref: Optional[str] = None
    source_event: Optional[SourceEventRef] = None


class KnowledgeSourceEventChange(BaseModel):
    """Chain-tracked re-binding of the Knowledge's `source_event` back-
    pointer at a chain position. Lets a single Knowledge represent
    different chain-tracked events as the story progresses (e.g. a
    "Bob's Transformation" Knowledge bound to a Scene-5 gender change
    initially, then re-bound to a Scene-12 reversal change via a
    chain entry here).

    `new_source_event` carries the new pointer, or None to explicitly
    clear / decouple at this chain anchor (Knowledge from this anchor
    forward represents no specific triggering event). Each entry is
    informational metadata only — does not gate any awareness or
    content-state walker output. Optional throughout: a Knowledge that
    never re-binds keeps the baseline `Knowledge.source_event` (which
    may itself be null for standalone Knowledges).
    """
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    node_id: str
    new_source_event: Optional[SourceEventRef] = None


class KnowledgeHistory(BaseModel):
    """Per-change-type arrays of Knowledge mutations, each anchored by
    `node_id`. Mirrors the RelationshipHistory pattern — effective state
    at chain position Y = origin values + all history entries with
    `node_id ≤ Y` in story order, applied in story order.
    """
    model_config = _foreign_content_ok
    # Birth / lifecycle events. The earliest `activate` event in story
    # order is the scene-born creation point. Mirrors
    # `RelationshipHistory.existence_changes`.
    existence_changes: list[KnowledgeExistenceChange] = Field(default_factory=list)
    name_changes: list[KnowledgeNameChange] = Field(default_factory=list)
    description_changes: list[KnowledgeDescriptionChange] = Field(default_factory=list)
    colour_changes: list[KnowledgeColourChange] = Field(default_factory=list)
    profile_image_changes: list[KnowledgeProfileImageChange] = Field(default_factory=list)
    # Chain-tracked re-binding of the Knowledge's source_event back-
    # pointer (the chain-tracked event the Knowledge is currently
    # "representing knowledge of"). Optional throughout: a Knowledge
    # that never re-binds keeps Knowledge.source_event from origin.
    source_event_changes: list[KnowledgeSourceEventChange] = Field(default_factory=list)
    # Phase 3.4a — knowledge tag-membership chain events. Each entry
    # carries `node_id` per the KnowledgeHistory pattern.
    tag_changes: list[KnowledgeTagChange] = Field(default_factory=list)


# ── Knowledge ──────────────────────────────────────────────────────────────

class Knowledge(BaseModel):
    """Phase 1.21c — first-class Knowledge object.

    Distinct from Entity (parallel to Relationship). Lightweight schema:
    identity (id / name / description / colour / optional profile_image_ref)
    plus awareness tracking (origin `awareness` dict + chain-tracked
    `history`). No attributes, no relationships, no aliases, no parent_id,
    no category_id, no canvas chip / setup node / modifier node. Created
    standalone via "+ New Knowledge" in the library, or attached to a
    chain-tracked event via the "Track awareness of this change" flow (see
    Step 11 of the implementation plan).
    """
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    description: str = ""
    colour: str = "#888888"
    profile_image_ref: Optional[str] = None
    # Author notes — free-form rich text. Edited via the right-sidebar
    # editor (mirrors the entity Notes affordance). Stored at story-origin
    # only; not chain-tracked (notes are a meta layer for the writer's
    # benefit, not narrative state).
    notes: str = ""
    # Awareness presentation scale — per-Knowledge setting. "full" (default)
    # uses the 4-level alias scale (0 / 1 / 2 / 3) for nuanced knows-
    # something-but-not-everything tracking. "binary" reduces the picker to
    # two levels (0 / 3) for simple yes/no secrets. Stored values are never
    # destructively clamped when the scale switches: any existing level 1
    # or 2 entries remain in the data and are rendered under the "aware"
    # group while in binary mode. Flipping back to "full" restores the
    # original gradation untouched.
    awareness_scale: Literal["binary", "full"] = "full"
    # Awareness dict — 4-level alias-scale per exploration Q5b + 4.6.
    # Value shape unchanged regardless of `awareness_scale`; scale only
    # governs presentation.
    awareness: Optional[Union[dict[str, int], AwarenessWrapper]] = None
    # Back-pointer to the chain-tracked event that CREATED this Knowledge,
    # if any. Populated in Step 10+ when event-attached Knowledge creation
    # flow ships. Standalone knowledges (created via "+ New Knowledge") leave
    # this null.
    source_event: Optional[SourceEventRef] = None
    # Phase 3.4a — baseline Project Tag membership at the knowledge's
    # origin. References `Story.project_tags[*].id`. Chain-tracked via
    # `history.tag_changes`. Empty default so pre-Phase-3.4 saves load
    # cleanly. Tags carry no awareness — that's a deliberate design call
    # because tags are metadata not story data (the awareness pass that
    # aliases and attributes get doesn't apply here).
    tag_ids: list[str] = Field(default_factory=list)
    history: KnowledgeHistory = Field(default_factory=KnowledgeHistory)
    # Manual anchors — scenes the user has explicitly pinned this Knowledge
    # to without (yet) recording any chain-history change there. Mirrors
    # `Relationship.manual_anchors`. The on-canvas Knowledge chip renders
    # at any scene with a manual anchor (or a real history entry); the chip
    # vanishes when both are absent. Manual anchors are typically a
    # transitory affordance — once the user adds a real modifier
    # (awareness change / content change / etc.) at the same scene, the
    # manual anchor is implicitly redundant but is kept around so the chip
    # survives if the modifier is later reverted.
    manual_anchors: list[ManualAnchor] = Field(default_factory=list)

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
