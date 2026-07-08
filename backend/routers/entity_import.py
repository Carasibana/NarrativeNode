"""
Entity import router — Phase 1.12b Tracks 1 / 2 / 5.

Three endpoints:

    POST /api/project/import/preview
        Accepts a multipart file upload of a source `.nnz` file
        (or legacy `.nnplot`),
        parses it in-memory (without touching the currently-loaded
        project's assets dir), and returns an `ImportPreview` that
        the frontend timeline grid picker consumes. The preview
        carries a `session_id` the frontend must round-trip to the
        commit endpoint so the parsed Story can be re-used.

    POST /api/project/import/entity_state
        Accepts a `session_id` + `entity_id` + `state_point` JSON
        body and returns the source entity walked to that state
        point — name / colour / description / profile image /
        attributes / relationships all resolved to the picked
        position. Used by the Track 5 state preview pane to show
        what the user will actually import when they click a dot
        on the timeline grid. Read-only; never mutates the target
        story or the session cache.

    POST /api/project/import/commit
        Accepts an `ImportCommitRequest` JSON body referencing a
        previously-returned `session_id` + the user's picks. Applies
        the commit to the currently-loaded target story via
        `services.state`, writes imported asset bytes to the target
        project's assets dir, and returns the updated story + a
        summary of what was imported.

Separate router file, same pattern as `routers/export.py`. Wired
into `main.py` alongside the other routers.
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Literal, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import state
from services.entity_import_service import (
    ImportCommitRequest,
    ImportKnowledgePick,
    ImportKnowledgeStatePoint,
    ImportPick,
    ImportStatePoint,
    _build_columns,
    _build_source_entity_lookup,
    _resolve_state_point,
    _walk_knowledge_to_node,
    build_import_preview,
    clear_preview_session,
    get_preview_session,
    import_entities,
)
from services.file_service import (
    CorruptSaveError,
    IncompatibleSaveError,
    build_corrupt_detail,
    build_incompatible_detail,
)


router = APIRouter(prefix="/project/import", tags=["import"])


# ── Pydantic request shape for /commit ──────────────────────────────


class _ImportStatePointBody(BaseModel):
    kind: Literal["origin", "scene", "modifier", "final"]
    scene_id: Optional[str] = None
    modifier_node_id: Optional[str] = None


class _ImportPickBody(BaseModel):
    entity_id: str
    state_point: _ImportStatePointBody


class _ImportKnowledgeStatePointBody(BaseModel):
    kind: Literal["origin", "scene", "final"]
    scene_id: Optional[str] = None


class _ImportKnowledgePickBody(BaseModel):
    knowledge_id: str
    state_point: _ImportKnowledgeStatePointBody


class _ImportCommitBody(BaseModel):
    session_id: str
    picks: list[_ImportPickBody] = Field(default_factory=list)
    import_story_settings: bool = False
    name_collision_strategy: Literal["suffix"] = "suffix"
    # Explicit list of source preset_list ids the user picked in the
    # Preset Lists tab of the Import dialog. Attribute-referenced
    # lists still auto-import even when omitted from this list.
    preset_list_ids: list[str] = Field(default_factory=list)
    # Knowledge picks from the Knowledge tab. Each picked Knowledge is
    # walked to its chosen state-point and the walked snapshot becomes
    # the new Knowledge's baseline in the target story (no history
    # rides through).
    knowledge_picks: list[_ImportKnowledgePickBody] = Field(default_factory=list)


class _ImportEntityStateBody(BaseModel):
    """Request body for the Track 5 state preview endpoint."""
    session_id: str
    entity_id: str
    state_point: _ImportStatePointBody


class _ImportKnowledgeStateBody(BaseModel):
    """Request body for the Knowledge state preview endpoint —
    parallels `_ImportEntityStateBody` but for Knowledge."""
    session_id: str
    knowledge_id: str
    state_point: _ImportKnowledgeStatePointBody


def _to_service_request(body: _ImportCommitBody) -> ImportCommitRequest:
    """Convert the Pydantic HTTP body into the service-layer
    `ImportCommitRequest` dataclass. Kept separate so the HTTP
    layer doesn't leak into the service module's type
    signatures."""
    return ImportCommitRequest(
        session_id=body.session_id,
        picks=[
            ImportPick(
                entity_id=p.entity_id,
                state_point=ImportStatePoint(
                    kind=p.state_point.kind,
                    scene_id=p.state_point.scene_id,
                    modifier_node_id=p.state_point.modifier_node_id,
                ),
            )
            for p in body.picks
        ],
        import_story_settings=body.import_story_settings,
        name_collision_strategy=body.name_collision_strategy,
        preset_list_ids=body.preset_list_ids,
        knowledge_picks=[
            ImportKnowledgePick(
                knowledge_id=kp.knowledge_id,
                state_point=ImportKnowledgeStatePoint(
                    kind=kp.state_point.kind,
                    scene_id=kp.state_point.scene_id,
                ),
            )
            for kp in body.knowledge_picks
        ],
    )


# ── Endpoints ─────────────────────────────────────────────────────────


@router.post("/preview")
async def import_preview(file: UploadFile = File(...)) -> JSONResponse:
    """Accept a multipart `.nnz` file upload (or legacy `.nnplot`) and
    return an `ImportPreview` JSON document.

    Save-format errors use the same structured HTTP shapes as the
    load endpoints in `routers/project.py`: `IncompatibleSaveError`
    (422) carries a capability field set to `"import"` so the
    frontend dialog can phrase itself correctly, and
    `CorruptSaveError` (400) carries the corrupt-metadata detail.
    Plain `ValueError` from `_read_source_nnz` (bad zip, missing
    narrative.json, unreadable JSON) surfaces as a 400 with the raw
    message. Unexpected exceptions propagate as 500 so the user sees
    a traceback in the server logs and a generic error in the
    frontend toast."""
    name = (file.filename or "").lower()
    if not (name.endswith(".nnz") or name.endswith(".nnplot")):
        raise HTTPException(
            status_code=400,
            detail="Uploaded file must have a .nnz extension (or legacy .nnplot).",
        )
    data = await file.read()
    if not data:
        raise HTTPException(
            status_code=400,
            detail="Uploaded file is empty.",
        )
    try:
        preview = build_import_preview(data, source_filename=file.filename)
    except IncompatibleSaveError as exc:
        raise HTTPException(
            status_code=422,
            detail=build_incompatible_detail(exc),
        ) from exc
    except CorruptSaveError as exc:
        raise HTTPException(
            status_code=400,
            detail=build_corrupt_detail(exc),
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Convert the dataclass tree to a plain dict for JSON serialisation.
    # `dataclasses.asdict` handles the nested structure cleanly; it
    # deep-copies lists/dicts along the way, which is fine for a
    # response payload.
    return JSONResponse(content=asdict(preview))


@router.post("/entity_state")
def import_entity_state(body: _ImportEntityStateBody) -> JSONResponse:
    """Walk a source entity to a specific state-point and return it
    as JSON. Read-only — never mutates the target story or the
    session cache. Used by the Track 5 state preview pane to show
    what the user will actually import when they click a dot on
    the timeline grid.

    Raises 400 on unknown session_id (expired, or server restarted)
    or unknown entity_id. Unexpected exceptions propagate as 500.
    """
    session = get_preview_session(body.session_id)
    if session is None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Preview session not found: {body.session_id!r} "
                "(may have expired or been cleared)"
            ),
        )

    source_story = session.story
    source_entities_by_id = _build_source_entity_lookup(source_story)
    source_entry = source_entities_by_id.get(body.entity_id)
    if source_entry is None:
        raise HTTPException(
            status_code=400,
            detail=f"Entity {body.entity_id!r} not found in preview session.",
        )
    source_entity, _bucket = source_entry

    state_point = ImportStatePoint(
        kind=body.state_point.kind,
        scene_id=body.state_point.scene_id,
        modifier_node_id=body.state_point.modifier_node_id,
    )

    try:
        walked = _resolve_state_point(
            source_entity=source_entity,
            state_point=state_point,
            source_story=source_story,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Serialise via pydantic `model_dump(mode='json')` so nested
    # models (Attribute, Relationship, etc.) flatten cleanly.
    return JSONResponse(content={"entity": walked.model_dump(mode="json")})


@router.post("/knowledge_state")
def import_knowledge_state(body: _ImportKnowledgeStateBody) -> JSONResponse:
    """Walk a source Knowledge to a specific state-point and return its
    walked snapshot as JSON. Parallels `/entity_state` but for the
    Knowledge tab of the timeline grid. Read-only — never mutates the
    target story or the session cache.

    The returned `knowledge` object carries only the walked content
    fields (`name`, `description`, `colour`, `profile_image_ref`,
    `awareness`, `awareness_scale`); history is intentionally omitted
    because the import flow does NOT bring history through — only the
    walked snapshot becomes the new baseline. Awareness keys are kept
    as the SOURCE entity ids (rewriting to target ids happens at
    commit time, since the entity-import batch isn't known here).
    """
    session = get_preview_session(body.session_id)
    if session is None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Preview session not found: {body.session_id!r} "
                "(may have expired or been cleared)"
            ),
        )

    source_story = session.story
    knowledge = next(
        (k for k in (source_story.knowledges or []) if k.id == body.knowledge_id),
        None,
    )
    if knowledge is None:
        raise HTTPException(
            status_code=400,
            detail=f"Knowledge {body.knowledge_id!r} not found in preview session.",
        )

    # Build the same node_order used by the preview-row builder so
    # scene state-points resolve identically.
    source_columns = _build_columns(source_story)
    knowledge_node_order = [c.id for c in source_columns]

    if body.state_point.kind == "origin":
        target_node_id = "__origin_only__"  # sentinel — unknown to the index
    elif body.state_point.kind == "final":
        target_node_id = None
    else:
        target_node_id = body.state_point.scene_id

    walked = _walk_knowledge_to_node(
        knowledge=knowledge,
        node_order=knowledge_node_order,
        target_node_id=target_node_id,
    )

    return JSONResponse(content={
        "knowledge": {
            "id": knowledge.id,
            "name": walked.name,
            "description": walked.description,
            "colour": walked.colour,
            "profile_image_ref": walked.profile_image_ref,
            "awareness": walked.awareness,
            "awareness_scale": walked.awareness_scale,
        },
    })


@router.post("/commit")
def import_commit(body: _ImportCommitBody) -> JSONResponse:
    """Apply an import commit request against the currently-loaded
    target story. Returns the updated story + a summary of what was
    imported. The session cache is cleared on successful commit.

    Raises 400 if the session_id is unknown (likely expired or the
    server restarted); raises 404 if there's no currently-loaded
    target story to import into; unexpected exceptions propagate
    as 500."""
    if not body.picks and not body.knowledge_picks and not body.preset_list_ids:
        raise HTTPException(
            status_code=400,
            detail="No picks — nothing to import.",
        )

    target_story = state.get_story()
    if target_story is None:
        raise HTTPException(
            status_code=404,
            detail="No target story loaded.",
        )

    service_request = _to_service_request(body)
    try:
        new_story, result = import_entities(service_request, target_story)
    except ValueError as exc:
        # Expired / unknown preview session, or other recoverable error.
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Commit the new story into the shared state so subsequent GETs
    # see the imported entities.
    state.set_story(new_story)

    # Clear the preview session — the frontend should upload a fresh
    # file if the user wants to import more. Keeps the session cache
    # from growing unbounded.
    clear_preview_session(body.session_id)

    return JSONResponse(content={
        "result": asdict(result),
        "story": new_story.model_dump(mode="json"),
    })
