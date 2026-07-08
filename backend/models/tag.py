"""First-class Project Tags — Phase 3.4a.

A `Tag` is a project-level definition stored in `Story.project_tags`.
Tag definitions are flat project-level metadata, NOT chain-tracked —
same pattern as `PresetList` and `CustomCategory` definitions. The
tag pool's CRUD operations (create / rename / recolour / delete with
cascade-strip) happen directly on `Story.project_tags` and propagate
to every host that references them.

Tag-on-host **membership** IS chain-tracked on chain-trackable hosts
(Entity / Knowledge / Relationship — each carrying baseline `tag_ids`
at origin + a per-host `tag_changes` list on its chain-mod container).
Baseline-only hosts (PresetList / ReferenceNode) carry just `tag_ids`
with no chain history of their own — their tag set is fixed at the
project level.

Tags carry no awareness. This is a deliberate design call — tags are
metadata (how the writer organises content) not story data (what
characters know about each other), so the awareness pass that aliases
get does not apply here.
"""

from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
import uuid


# Forward-compat: foreign content from later versions is silently
# preserved rather than rejected, matching the rest of the model layer.
_foreign_content_ok = ConfigDict(extra="ignore")


class Tag(BaseModel):
    """A project-level tag definition. Lives in `Story.project_tags`.

    Shape is intentionally minimal: id, name, color. No description,
    no icon, no nested categories. Display layer applies a CSS
    `text-transform: uppercase` so the user's casing is preserved in
    storage while badges render consistently as `[#NAME]`.

    Names enforce **case-insensitive uniqueness** in the project pool:
    creating a `Tag` named "Magic" when "magic" already exists must
    return the existing entry; renaming to a name that collides
    case-insensitively must be refused. The uniqueness constraint is
    enforced in the router layer at write time (see
    `backend/routers/project_tags.py`).

    Leading `#` characters are stripped from the name at write time —
    the badge always injects a `#` at render time, so storing the
    hash in the name would produce `[##NAME]`-style rendering.
    """
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    color: str = "#888888"


class TagChange(BaseModel):
    """A single tag-membership mutation at a scene anchor.

    Mirrors `AliasChange`'s add/remove shape but with two deliberate
    drops compared to alias:

    1. **No `modify` action.** A tag's name and color live on the
       pool entry, not on the host — to rename or recolour a tag,
       edit the pool entry; to change a host's membership, add or
       remove the `tag_id` reference. Names don't drift per-host.

    2. **No awareness actions.** Tags are metadata not story data;
       no per-tag-on-host awareness chain is tracked.

    Used by:
      - `EntityRef.tag_changes` (entity tag changes at scenes)
      - `KnowledgeHistory.tag_changes` (knowledge tag changes)
      - `RelationshipHistory.tag_changes` (relationship tag changes)

    `node_id` is implicit by container position when carried on
    `EntityRef` (the EntityRef itself anchors a scene); explicit
    `node_id` field on `KnowledgeHistory` / `RelationshipHistory`
    entries matches those histories' existing patterns.

    **Same-node opposite-pair cancellation** (enforced at write
    time in the store action, not on read): writing `add@N` when a
    `remove@N` already exists for the same `tag_id` strips both
    entries; same for the reverse. Cross-node entries coexist —
    `add@N, remove@N+1, add@N+2` is a legitimate three-entry chain
    (tagged, removed at later scene, re-tagged at a later scene).
    """
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    action: Literal["add", "remove"]
    tag_id: str


class KnowledgeTagChange(TagChange):
    """Knowledge-specific `TagChange` carrying its own `node_id`.

    Knowledge's history entries are anchored by an explicit `node_id`
    on each entry (since the per-change-type arrays in
    `KnowledgeHistory` don't share a single scene anchor). This
    subclass adds that field while keeping the shared add/remove
    shape from the base `TagChange`.
    """
    node_id: str


class RelationshipTagChange(TagChange):
    """Relationship-specific `TagChange` carrying its own `node_id`.

    Same shape as `KnowledgeTagChange` — relationship history entries
    are anchored by explicit `node_id` per the existing
    `RelationshipHistory` pattern.
    """
    node_id: str
