"""Phase 2.8 / 3.4c — Context Cues REST endpoints.

Backed by a folder-based per-cue store at ``context_cues/`` (see
``services.context_cues_service``). Phase 3.4c added per-id mutation
endpoints + an index-entries list endpoint alongside the pre-3.4c
bulk-PUT wire contract — the new endpoints power the lazy-load cue
library, the bulk endpoints stay until the frontend migrates in a
later sub-commit.

Endpoint summary (Phase 3.4c):

  - GET    /api/ai-context-cues             → full cue list (pre-3.4c)
  - PUT    /api/ai-context-cues             → bulk replace (pre-3.4c)
  - GET    /api/ai-context-cues/index       → index entries only (NEW)
  - GET    /api/ai-context-cues/layout      → library layout array
  - PUT    /api/ai-context-cues/layout      → save library layout
  - GET    /api/ai-context-cues/{id}        → single full cue (NEW)
  - POST   /api/ai-context-cues             → create one cue (NEW)
  - PUT    /api/ai-context-cues/{id}        → update one cue (NEW)
  - DELETE /api/ai-context-cues/{id}        → delete one cue (NEW)
"""

from __future__ import annotations

from typing import Any, List, Union

from fastapi import APIRouter, HTTPException

from models.context_cue import ContextCue, ContextCueIndexEntry
from services import context_cues_service as svc


router = APIRouter(prefix="/ai-context-cues", tags=["ai-context-cues"])


# ── Pre-3.4c bulk endpoints (back-compat — kept until frontend migrates) ─


@router.get("", response_model=List[ContextCue])
async def list_context_cues() -> List[ContextCue]:
    """Return the full cue list with bodies. Pre-3.4c wire contract;
    kept so the existing frontend keeps working until it migrates to
    `/index` + `/{id}` in a later sub-commit."""
    return svc.list_cues()


@router.put("", response_model=List[ContextCue])
async def save_context_cues(cues: List[ContextCue]) -> List[ContextCue]:
    """Bulk-replace the saved cue list. Pre-3.4c wire contract."""
    return svc.save_cues(cues)


# ── Phase 3.4c: index-entries list endpoint ────────────────────────────


# Note on path ordering: FastAPI matches route patterns in declaration
# order. `/index` and `/layout` must come BEFORE `/{cue_id}` so they
# don't get swallowed by the catch-all id route.


@router.get("/index", response_model=List[ContextCueIndexEntry])
async def list_context_cue_index() -> List[ContextCueIndexEntry]:
    """Phase 3.4c — return the cue index entries in library-layout
    order. Cheap: reads `index.json` directly (rebuilds it from disk
    on first load after the order.json migration). Replaces the
    full-cue list call for cue-library rendering — bodies fetch
    lazily via `GET /{cue_id}` on cue-detail open."""
    return svc.list_index()


# ── Layout endpoints (unchanged shape, now reads from index.json) ──────


@router.get("/layout", response_model=List[Union[str, dict]])
async def get_context_cue_layout() -> List[Union[str, dict]]:
    return svc.get_layout()


@router.put("/layout", response_model=List[Union[str, dict]])
async def put_context_cue_layout(layout: List[Any]) -> List[Union[str, dict]]:
    return svc.save_layout(layout)


# ── Phase 3.4c: per-id mutation endpoints ──────────────────────────────


@router.get("/{cue_id}", response_model=ContextCue)
async def get_context_cue(cue_id: str) -> ContextCue:
    """Phase 3.4c — return one full cue by id. Used by the cue-detail
    / edit surface when the user opens a specific cue. List view
    callers fetch the much cheaper index entries via `/index` and
    only call this endpoint on demand."""
    cue = svc.get_cue(cue_id)
    if cue is None:
        raise HTTPException(status_code=404, detail="Context Cue not found")
    return cue


@router.post("", response_model=ContextCue, status_code=201)
async def create_context_cue(cue: ContextCue) -> ContextCue:
    """Phase 3.4c — create a single cue. Writes the cue file, appends
    the index entry, appends the cue id to the layout. Returns the
    created cue (with `updated_at` stamped). Refuses to overwrite
    an existing cue — use `PUT /{cue_id}` for that."""
    try:
        return svc.create_cue(cue)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.put("/{cue_id}", response_model=ContextCue)
async def update_context_cue(cue_id: str, cue: ContextCue) -> ContextCue:
    """Phase 3.4c — update an existing cue. Rewrites the file
    (renaming if the name slug changed), updates the matching index
    entry, preserves `created_at`. Stamps `updated_at` when content
    (name / body / tags) actually changes; pinned / colour toggles
    don't bump it. Returns the updated cue."""
    updated = svc.update_cue(cue_id, cue)
    if updated is None:
        raise HTTPException(status_code=404, detail="Context Cue not found")
    return updated


@router.delete("/{cue_id}", status_code=204)
async def delete_context_cue(cue_id: str) -> None:
    """Phase 3.4c — delete a single cue. Removes the cue file, strips
    the index entry, strips the cue id from the layout (divider
    entries preserved)."""
    ok = svc.delete_cue(cue_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Context Cue not found")
    return None
