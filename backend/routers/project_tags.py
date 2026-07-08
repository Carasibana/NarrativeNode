"""Project Tags router — Phase 3.4b.

CRUD for the project-level Tag pool (`Story.project_tags`). Five endpoints:

  - GET    /project-tags            — list every pool entry
  - GET    /project-tags/{tag_id}   — single pool entry by id
  - POST   /project-tags            — create pool entry (or return existing on
                                      case-insensitive name collision)
  - PUT    /project-tags/{tag_id}   — rename and/or recolour
  - DELETE /project-tags/{tag_id}   — cascade-strip references across every
                                      chain-trackable host + every chain-mod
                                      container's tag_changes; return
                                      `{ affected_host_count, affected_hosts: [...] }`

Name normalisation on POST + PUT:

  - Strip a single leading `#` from the input (the badge always re-adds it
    at render time; storing `#magic` would render as `##magic`).
  - Preserve user casing in storage (`Magic` stays `Magic`).
  - Enforce case-insensitive uniqueness across the pool. POST that collides
    with an existing name returns the existing entry (200) rather than 4xx —
    matches the seamless find-or-create semantic used by the frontend
    `TagPicker` and the MCP `tag_host` tool. PUT that would rename to a name
    that collides with a different existing tag returns 409.

DELETE cascade walks every host carrying the tag_id and strips it:
  - `Entity.tag_ids` baseline (all five entity subtypes via `Entities`
    container)
  - `Knowledge.tag_ids` baseline
  - `Relationship.tag_ids` baseline
  - `PresetList.tag_ids` baseline (no chain)
  - `ReferenceNode.tag_ids` baseline (no chain)
  - `EntityRef.tag_changes` on every SceneNode's bucket arrays
  - `EntityNode.tag_changes` on every modifier-mode entity node
  - `KnowledgeHistory.tag_changes` on every Knowledge
  - `RelationshipHistory.tag_changes` on every Relationship

The walker reports which named hosts were affected so the confirmation
dialog can surface the names ("This will strip it from Alice, Bob, and
3 others"). Frontend's `_stripReferencesToTag` primitive mirrors this
shape on the local store for immediate UI response + undo / redo
snapshot capture.
"""

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from models.story import Story
from models.tag import Tag
import state


router = APIRouter(prefix="/project-tags", tags=["project-tags"])


# ── Helpers ────────────────────────────────────────────────────────────


def _normalise_name(raw: str) -> str:
    """Strip a single leading `#`; trim whitespace. Casing is preserved.

    Mirrors `program_tags_service.normalise_program_tag_name` shape so
    the rule stays consistent across both pools (the two functions are
    intentionally kept independent — different error-shape conventions
    per layer — but their behaviour MUST track).
    """
    if not isinstance(raw, str):
        raise HTTPException(status_code=422, detail="`name` must be a string.")
    s = raw.strip()
    if s.startswith("#"):
        s = s[1:].strip()
    if not s:
        raise HTTPException(status_code=422, detail="Tag name cannot be empty after `#`-strip + trim.")
    return s


def _find_by_name_ci(pool: list[Tag], name_ci: str) -> Optional[Tag]:
    """Return the first tag whose name matches `name_ci` case-insensitively,
    or None. Used for the find-or-create-on-POST + refuse-rename-collision
    rules. Caller passes the lowercased target."""
    for t in pool:
        if t.name.casefold() == name_ci:
            return t
    return None


# ── DELETE cascade-strip primitive (backend side) ──────────────────────


class _AffectedHost(BaseModel):
    """One host's worth of cascade-strip impact. Returned per affected
    host so the confirmation dialog can list names + counts."""
    kind: str       # 'entity' | 'knowledge' | 'relationship' | 'preset_list' | 'reference_node'
    id: str
    name: str


def _strip_tag_from_story(story: Story, tag_id: str) -> list[_AffectedHost]:
    """Walk every chain-trackable + baseline-only host's `tag_ids` and
    every chain-mod container's `tag_changes` arrays. Strip every
    occurrence of `tag_id`. Returns the list of affected hosts (one
    entry per host that had at least one reference removed).

    Order matches the cascade-strip primitive on the frontend store's
    `_stripReferencesToTag(tagId)` so the two views stay in sync.
    """
    affected: list[_AffectedHost] = []

    def _strip_list(target: list[str]) -> bool:
        """Strip `tag_id` from a list of strings in place; returns True
        if anything was removed."""
        before = len(target)
        target[:] = [t for t in target if t != tag_id]
        return len(target) < before

    def _strip_changes(changes: list) -> bool:
        """Strip every TagChange entry referencing `tag_id` in place;
        returns True if anything was removed."""
        before = len(changes)
        changes[:] = [c for c in changes if getattr(c, "tag_id", None) != tag_id]
        return len(changes) < before

    # Entities: walk every subtype via the `Entities` container.
    ent_buckets = (
        ("character", story.entities.characters),
        ("location",  story.entities.locations),
        ("item",      story.entities.items),
        ("faction",   story.entities.factions),
        ("custom",    story.entities.customs),
    )
    for _kind, bucket in ent_buckets:
        for e in bucket:
            if _strip_list(e.tag_ids):
                affected.append(_AffectedHost(kind="entity", id=e.id, name=e.name or "(unnamed)"))

    # Knowledges: strip baseline + chain history.
    for k in story.knowledges:
        hit_baseline = _strip_list(k.tag_ids)
        hit_chain = _strip_changes(k.history.tag_changes)
        if hit_baseline or hit_chain:
            affected.append(_AffectedHost(kind="knowledge", id=k.id, name=k.name or "(unnamed)"))

    # Relationships: strip baseline + chain history.
    for r in story.relationships:
        hit_baseline = _strip_list(r.tag_ids)
        hit_chain = _strip_changes(r.history.tag_changes)
        if hit_baseline or hit_chain:
            affected.append(_AffectedHost(kind="relationship", id=r.id, name=r.name or "(unnamed)"))

    # PresetLists: baseline only (no chain).
    for pl in story.preset_lists:
        if _strip_list(pl.tag_ids):
            affected.append(_AffectedHost(kind="preset_list", id=pl.id, name=pl.name or "(unnamed)"))

    # ReferenceNodes: baseline only (no chain).
    for rn in story.reference_nodes:
        if _strip_list(rn.tag_ids):
            # ReferenceNode uses `title` not `name`.
            affected.append(_AffectedHost(kind="reference_node", id=rn.id, name=rn.title or "(untitled)"))

    # SceneNode entity-bucket EntityRefs: strip per-scene tag_changes.
    # Group multiple hits under one scene + entity by tracking which
    # (scene_id, entity_id) pairs we've already noted — but since the
    # cascade dialog is most useful naming the ENTITY (not the
    # scene+entity), we record under the entity if not already there.
    affected_entity_ids = {h.id for h in affected if h.kind == "entity"}
    for scene in story.scenes:
        for bucket_name in ("characters", "locations", "items", "factions", "customs"):
            for ref in getattr(scene, bucket_name, []):
                if not getattr(ref, "tag_changes", None):
                    continue
                hit = _strip_changes(ref.tag_changes)
                if hit and ref.entity_id not in affected_entity_ids:
                    # Look up the entity for the name.
                    name = "(unknown)"
                    for _kind, bucket in ent_buckets:
                        match = next((e for e in bucket if e.id == ref.entity_id), None)
                        if match:
                            name = match.name or "(unnamed)"
                            break
                    affected.append(_AffectedHost(kind="entity", id=ref.entity_id, name=name))
                    affected_entity_ids.add(ref.entity_id)

    # EntityNode (modifier-mode) tag_changes — those carry chain events
    # on canvas modifier nodes. Same de-dup against affected_entity_ids.
    for node in story.entity_nodes:
        if not getattr(node, "tag_changes", None):
            continue
        hit = _strip_changes(node.tag_changes)
        if hit and node.entity_id and node.entity_id not in affected_entity_ids:
            name = "(unknown)"
            for _kind, bucket in ent_buckets:
                match = next((e for e in bucket if e.id == node.entity_id), None)
                if match:
                    name = match.name or "(unnamed)"
                    break
            affected.append(_AffectedHost(kind="entity", id=node.entity_id, name=name))
            affected_entity_ids.add(node.entity_id)

    return affected


# ── Request body models ────────────────────────────────────────────────


class _CreateTagBody(BaseModel):
    name: str
    color: Optional[str] = None  # defaults to Tag's own #888888 default


class _UpdateTagBody(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None


class _DeleteResponse(BaseModel):
    """Wraps the DELETE response so the frontend can render the
    confirmation summary without a second round-trip."""
    deleted_tag_id: str
    affected_host_count: int
    affected_hosts: list[_AffectedHost]


# ── Endpoints ──────────────────────────────────────────────────────────


@router.get("/", response_model=list[Tag])
def list_project_tags():
    """Return every Tag pool entry on the active Story."""
    return state.get_story().project_tags


@router.get("/{tag_id}", response_model=Tag)
def get_project_tag(tag_id: str):
    """Return one pool entry by id, 404 if missing."""
    for t in state.get_story().project_tags:
        if t.id == tag_id:
            return t
    raise HTTPException(status_code=404, detail="Project Tag not found")


@router.post("/", response_model=Tag, status_code=201)
def create_project_tag(body: _CreateTagBody):
    """Create a pool entry, or return the existing one on case-insensitive
    name collision (seamless find-or-create semantic). Strips a leading
    `#` from `name`; preserves casing in storage; default colour is the
    Tag model's own `#888888`."""
    story = state.get_story()
    name = _normalise_name(body.name)
    existing = _find_by_name_ci(story.project_tags, name.casefold())
    if existing is not None:
        # Collision = return existing (no-op create). The caller doesn't
        # need to know whether it was minted fresh or pre-existed.
        return existing
    tag = Tag(name=name, color=body.color or "#888888")
    story.project_tags.append(tag)
    return tag


@router.put("/{tag_id}", response_model=Tag)
def update_project_tag(tag_id: str, body: _UpdateTagBody):
    """Rename and/or recolour a pool entry. PUT with a name that
    collides with a different existing tag (case-insensitive) is
    refused with 409. PUT to a name matching the same tag (e.g.
    casing change `Magic` → `magic`) succeeds — that's a re-casing,
    not a collision."""
    story = state.get_story()
    target_idx = None
    for i, t in enumerate(story.project_tags):
        if t.id == tag_id:
            target_idx = i
            break
    if target_idx is None:
        raise HTTPException(status_code=404, detail="Project Tag not found")

    target = story.project_tags[target_idx]
    new_name = target.name
    new_color = target.color

    if body.name is not None:
        normalised = _normalise_name(body.name)
        collision = _find_by_name_ci(story.project_tags, normalised.casefold())
        if collision is not None and collision.id != tag_id:
            raise HTTPException(
                status_code=409,
                detail=f"A tag named '{collision.name}' already exists. "
                       f"Tag names must be unique (case-insensitive).",
            )
        new_name = normalised
    if body.color is not None:
        new_color = body.color

    updated = Tag(id=target.id, name=new_name, color=new_color)
    story.project_tags[target_idx] = updated
    return updated


@router.delete("/{tag_id}", response_model=_DeleteResponse)
def delete_project_tag(tag_id: str):
    """Cascade-strip the tag from every host that references it, then
    remove it from the pool. Returns `{ deleted_tag_id, affected_host_count,
    affected_hosts: [...] }` so the frontend can render the confirmation
    summary without a second round-trip (the dialog itself is shown
    before the call lands when the user explicitly opts in)."""
    story = state.get_story()
    target_idx = None
    for i, t in enumerate(story.project_tags):
        if t.id == tag_id:
            target_idx = i
            break
    if target_idx is None:
        raise HTTPException(status_code=404, detail="Project Tag not found")

    affected = _strip_tag_from_story(story, tag_id)
    story.project_tags.pop(target_idx)
    return _DeleteResponse(
        deleted_tag_id=tag_id,
        affected_host_count=len(affected),
        affected_hosts=affected,
    )
