"""Program Tags router — Phase 3.4c.

Cross-pool Program Tag endpoints. Program Tags are the per-user /
cross-project flat-string tag system that lives on
``ContextCue.tags`` and ``Conversation.tags``. The strings on the
host objects are case-sensitive on disk; the tag system treats them
as case-insensitive for matching, uniqueness, and recolour purposes.

This router owns:

  - GET /api/program-tags                  → aggregated pool list
                                              with per-tag counts + colour
  - GET /api/program-tags/{name}/color     → single colour lookup
                                              (case-insensitive)
  - PUT /api/program-tags/{name}/color     → set / change colour
  - PUT /api/program-tags/rename           → rename across all hosts
  - DELETE /api/program-tags/{name}        → cascade-strip from all
                                              hosts + remove colour map entry
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services import program_tags_service as svc


router = APIRouter(prefix="/program-tags", tags=["program-tags"])


# ── Response shapes ────────────────────────────────────────────────────


class ProgramTagPoolEntry(BaseModel):
    """One row in the aggregated Program Tag pool list. See
    `program_tags_service.list_program_tag_pool()` for the canonical-
    casing + count semantics."""

    name: str = Field(..., description="Canonical casing for display.")
    color: str = Field(..., description="Hex colour from the map, or default #888888.")
    cue_count: int = Field(..., description="Number of ContextCues carrying this tag (case-insensitive).")
    conversation_count: int = Field(..., description="Number of Conversations carrying this tag (case-insensitive).")
    count: int = Field(..., description="Total: cue_count + conversation_count.")


class ColorResponse(BaseModel):
    """GET /api/program-tags/{name}/color response."""

    name: str
    color: str


class ColorPutBody(BaseModel):
    """PUT /api/program-tags/{name}/color body."""

    color: str


class RenameBody(BaseModel):
    """PUT /api/program-tags/rename body."""

    old_name: str
    new_name: str


class RenameResponse(BaseModel):
    """PUT /api/program-tags/rename response."""

    old_name: str
    new_name: str
    cue_count: int
    conversation_count: int
    total_count: int


class AffectedHost(BaseModel):
    """One row of the DELETE response's `affected_hosts` list."""

    kind: str  # 'cue' | 'conversation'
    id: str
    name: str


class DeleteResponse(BaseModel):
    """DELETE /api/program-tags/{name} response."""

    deleted_name: str
    cue_count: int
    conversation_count: int
    total_count: int
    affected_hosts: list[AffectedHost]


# ── Endpoints ──────────────────────────────────────────────────────────


@router.get("", response_model=list[ProgramTagPoolEntry])
def list_program_tags() -> list[dict]:
    """Return the aggregated Program Tag pool: every distinct tag
    string currently in use across the user's ContextCues +
    Conversations, merged with every colour-map key (so colour-pre-
    set tags surface even before any host references them).

    Case-insensitive de-dup; canonical casing comes from the colour
    map when an entry exists there, otherwise the most-recently-seen
    host casing wins.

    Sort order is not server-applied — the frontend library sorts
    descending by `count` + alphabetical tie-break.
    """
    return svc.list_program_tag_pool()


@router.get("/{name}/color", response_model=ColorResponse)
def get_program_tag_color(name: str) -> ColorResponse:
    """Return the colour for a specific Program Tag (case-insensitive
    lookup). Returns the default `#888888` for tags not in the colour
    map. Strips a leading `#` from `name`."""
    try:
        normalised = svc.normalise_program_tag_name(name)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    color = svc.get_color(normalised)
    return ColorResponse(name=normalised, color=color)


@router.put("/{name}/color", response_model=ColorResponse)
def set_program_tag_color(name: str, body: ColorPutBody) -> ColorResponse:
    """Set the colour for a Program Tag. Creates the colour-map entry
    if it doesn't exist. Case-insensitive lookup: if a colour-map
    entry already exists for a different casing of this name, the
    existing entry's casing is preserved and only the colour value
    changes (matches the project-tag rename-collision-on-same-tag
    behaviour).

    Strips a leading `#` from `name` query param + the colour value
    in the body is stored verbatim (hex validation is the frontend's
    responsibility — the picker only produces hex).
    """
    try:
        normalised = svc.normalise_program_tag_name(name)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not isinstance(body.color, str) or not body.color.strip():
        raise HTTPException(status_code=422, detail="`color` must be a non-empty string.")
    canonical, color = svc.set_color(normalised, body.color.strip())
    return ColorResponse(name=canonical, color=color)


@router.put("/rename", response_model=RenameResponse)
def rename_program_tag(body: RenameBody) -> RenameResponse:
    """Rename a Program Tag across every host that carries it. Walks
    both indexes (cue + conversation) to find affected hosts, rewrites
    each affected host file's `tags: list[str]`, updates the matching
    index entries, moves the colour-map key.

    Strips a leading `#` from both names. Refuses (409) when `new_name`
    case-insensitively collides with a DIFFERENT existing tag.
    Recasing of the same tag (`Magic` → `magic`) succeeds.
    """
    try:
        old_normalised = svc.normalise_program_tag_name(body.old_name)
        new_normalised = svc.normalise_program_tag_name(body.new_name)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    # Collision check, excluding the tag being renamed (so a recasing
    # `Magic` → `magic` for the same tag isn't a collision).
    if old_normalised.casefold() != new_normalised.casefold():
        collision = svc.collision_check(new_normalised, excluding_old=old_normalised)
        if collision is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"A program tag named '{collision}' already exists. "
                    f"Program tag names must be unique (case-insensitive)."
                ),
            )

    cue_count, conv_count, total = svc.rename_program_tag_across_hosts(old_normalised, new_normalised)
    return RenameResponse(
        old_name=old_normalised,
        new_name=new_normalised,
        cue_count=cue_count,
        conversation_count=conv_count,
        total_count=total,
    )


@router.delete("/{name}", response_model=DeleteResponse)
def delete_program_tag(name: str) -> DeleteResponse:
    """Cascade-strip a Program Tag from every host that carries it.
    Walks both indexes, rewrites every affected host file's
    `tags: list[str]` to drop the string, updates index entries.
    Removes the colour-map entry (no-op if absent).

    Returns `{deleted_name, cue_count, conversation_count, total_count,
    affected_hosts: [{kind, id, name}]}` so the confirmation dialog can
    list affected items by name. Strips a leading `#` from `name`."""
    try:
        normalised = svc.normalise_program_tag_name(name)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    cue_count, conv_count, total, affected = svc.delete_program_tag_across_hosts(normalised)
    return DeleteResponse(
        deleted_name=normalised,
        cue_count=cue_count,
        conversation_count=conv_count,
        total_count=total,
        affected_hosts=[AffectedHost(**h) for h in affected],
    )
