"""Novelcrafter import router — Phase 3.1 (scaffolding).

Two endpoints:

* `POST /api/novelcrafter/preview` — accepts the uploaded `.zip`, runs
  it through `novelcrafter_import_service.build_novelcrafter_preview`,
  returns the preview shape the dialog renders. Phase 3.1 returns the
  zero-count stub shape; Phase 3.2+ fills it in.

* `POST /api/novelcrafter/commit` — Phase 3.1 returns 501 Not Implemented
  because no commit pipeline exists yet. Phase 3.2+ wires this through
  to a project-materialisation routine that always creates a fresh
  NarrativeNode project (never merges into an existing one, per the
  Stage 3 design doc).

Mirrors `entity_import.py` on shape and error mapping (422 for known
bundle-validity failures, 400 for malformed-zip / empty-file).
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from services import novelcrafter_import_service
from services import scene_wiring
from services.import_engine import apply_import_ir_new, estimate_apply_total_units
import state


router = APIRouter(prefix="/novelcrafter", tags=["novelcrafter-import"])


@router.post("/preview")
async def preview_novelcrafter_import(file: UploadFile = File(...)) -> JSONResponse:
    """Build the preview shape for a Novelcrafter export bundle.

    Phase 3.1 returns the zero-count stub; Phase 3.2+ fills the counts
    as their parsers ship.
    """
    name = (file.filename or "").lower()
    if not name.endswith(".zip"):
        raise HTTPException(
            status_code=422,
            detail="Novelcrafter import expects a `.zip` bundle.",
        )

    data = await file.read()
    try:
        preview = novelcrafter_import_service.build_novelcrafter_preview(
            data=data,
            source_filename=file.filename,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return JSONResponse(content=asdict(preview))


@router.post("/commit")
def commit_novelcrafter_import(
    session_id: str = Form(...),
    layout_mode: str = Form("columns"),
    default_pov_character: str = Form(""),
    tense: str = Form(""),
    language: str = Form(""),
    pov_type: str = Form(""),
    auto_place_entities: str = Form("true"),
    items_customs_threshold: str = Form("1"),
    import_snippets: str = Form("false"),
    snippet_ids: str = Form(""),
    import_chats: str = Form("false"),
    chat_ids: str = Form(""),
    # Phase 5.9 — strip leading "Chapter N" / "Act N" prefixes from imported
    # chapter/act titles. Default on; off = titles verbatim.
    clean_chapter_act_titles: str = Form("true"),
    # Phase 3.10 Layer 5 — staged-commit mode. When true, build the
    # Story exactly as today but DO NOT write it to `state.story`,
    # DO NOT import snippets/chats, DO NOT clear the preview session.
    # Stash the built Story on `session.staged_story` and return it
    # to the frontend so the scene-refinement modal can render
    # against it. A follow-up `/commit_staged` POST finalises (with
    # the writer-confirmed refinement diff) or `/commit_cancel`-
    # equivalent abandonment discards the staged work.
    dry_run: str = Form("false"),
) -> JSONResponse:
    """Materialise the previewed import into a fresh NarrativeNode project.

    Phase 3.7N — the commit pipeline. Looks up the stashed preview
    session, runs the Novelcrafter preprocessor to produce an
    `ImportIR`, applies the IR via the shared import engine, replaces
    the active project with the result, clears the session, and
    returns the import-result summary (counts + lossy-paths warnings)
    that the import-result dialog renders.

    `layout_mode` mirrors the template-import knob: `"columns"`
    parks entity-origin nodes in per-type columns left of chapter 1;
    `"first_appearance"` widens chapters to place origins next to
    the scene where each entity first appears.

    Phase 3.7N Layer 2 — Story-level settings the writer supplied in
    the import dialog (because NC's export doesn't carry any of
    them). Empty strings mean "skip". `default_pov_character` is the
    canonical character name as shown in the dialog dropdown; the
    preprocessor case-folds + matches against the imported character
    bucket. Picked character becomes a chip with `has_pov=True` on
    every imported scene. `tense` / `language` / `pov_type` land on
    the matching Story fields.
    """
    session = novelcrafter_import_service.get_preview_session(session_id)
    if session is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Novelcrafter import session `{session_id}` not found. "
                "Sessions expire on server restart; re-upload the bundle "
                "to start a fresh preview."
            ),
        )

    # Phase 3.10 — opt-in flags resolved up front so per-item
    # counts (cues + chats) can be added to the global total before
    # the progress slot is initialised.
    import_snippets_on = (import_snippets or "").strip().lower() not in ("false", "0", "off", "")
    import_chats_on = (import_chats or "").strip().lower() not in ("false", "0", "off", "")
    clean_titles_on = (clean_chapter_act_titles or "").strip().lower() not in ("false", "0", "off", "")

    # Helper: coerce a comma-joined id form param into a set, or
    # None when the writer didn't filter (import all). Empty string
    # → None (all). Stripped tokens, drop empties.
    def _parse_id_filter(raw: str) -> "set[str] | None":
        raw_clean = (raw or "").strip()
        if not raw_clean:
            return None
        ids = {tok.strip() for tok in raw_clean.split(",") if tok.strip()}
        return ids or None

    # Parse snippets + chats EARLY (cheap; just zip reads) so the
    # per-item totals are known before the bar is sized. Re-using
    # the parsed lists in the import phases below. These parsers
    # also ran at preview time inside `build_novelcrafter_preview`,
    # so any malformed-file errors have already surfaced; a clean
    # session here is guaranteed to parse cleanly again.
    accept_snippet_ids = _parse_id_filter(snippet_ids) if import_snippets_on else None
    accept_chat_ids = _parse_id_filter(chat_ids) if import_chats_on else None
    snippets_list = (
        novelcrafter_import_service._parse_snippets(session, accept_ids=accept_snippet_ids)
        if import_snippets_on else []
    )
    chats_list = (
        novelcrafter_import_service._parse_chats(session, accept_ids=accept_chat_ids)
        if import_chats_on else []
    )

    # Slot init happens BEFORE engine apply; total is filled in once
    # the IR is built (see below) and `update_commit_phase` is called
    # with the final unit_total. phase_total stays at 1 because the
    # writer cares about ONE unified progress bar, not internal
    # per-phase splits.
    novelcrafter_import_service.init_commit_progress(
        session_id, phase_total=1,
    )
    # Pre-import in-memory story snapshot so a mid-flight cancel can
    # restore it. Frontend takes its own Zustand snapshot too; this
    # is the backend-side counterpart so `state.get_story()` returns
    # the pre-import shape after a cancel-rollback.
    previous_story = state.get_story()
    previous_active_file_path = state.get_active_file_path()

    def _cancelled_response(snippets_done: int, chats_done: int):
        """Common cancel-rollback path. Deletes any cues + chats
        that landed before the cancel arrived, restores the in-memory
        story, and returns a `{"cancelled": True, ...}` response so
        the modal closes cleanly."""
        cues_deleted, convs_deleted = (
            novelcrafter_import_service.rollback_commit_artifacts(session_id)
        )
        if previous_story is not None:
            state.set_story(previous_story)
        state.set_active_file_path(previous_active_file_path)
        payload = {
            "applied": False,
            "cancelled": True,
            "session_id": session_id,
            "counts": {
                "snippets_imported": snippets_done,
                "chats_imported": chats_done,
                "snippets_deleted_on_cancel": cues_deleted,
                "chats_deleted_on_cancel": convs_deleted,
            },
        }
        novelcrafter_import_service.mark_commit_done(session_id, payload)
        return JSONResponse(content=payload)

    if layout_mode not in ("columns", "first_appearance"):
        layout_mode = "columns"

    story_settings = {
        "default_pov_character": default_pov_character,
        "tense": tense,
        "language": language,
        "pov_type": pov_type,
    }

    # Phase 3.7N Layer 3 — entity placement settings. Defaults are
    # on / threshold=1; the dialog can override either. Form params
    # arrive as strings; coerce.
    auto_place = (auto_place_entities or "").strip().lower() not in ("false", "0", "off", "")
    try:
        items_customs_t = max(1, int(items_customs_threshold))
    except (TypeError, ValueError):
        items_customs_t = 1
    placement_settings = {
        "auto_place_entities": auto_place,
        "items_customs_threshold": items_customs_t,
    }

    # Phase 3.10 — build the IR first (sync, fast) so we know item
    # counts before sizing the progress bar. nc_bundle_to_ir runs
    # the prose walker + the codex parser + entity placement; for
    # a large bundle this is sub-second.
    try:
        result = novelcrafter_import_service.nc_bundle_to_ir(
            session,
            story_settings=story_settings,
            placement_settings=placement_settings,
        )
    except Exception as exc:  # noqa: BLE001 — bubble up as 500 with detail
        novelcrafter_import_service.mark_commit_done(session_id, None)
        raise HTTPException(
            status_code=500,
            detail=f"Novelcrafter import failed during materialisation: {type(exc).__name__}: {exc}",
        ) from exc

    # Total units across the whole import = engine apply events
    # (setup steps + per-item events for each character / scene /
    # relationship / etc.) + per-cue events + per-chat events. Writer
    # cares about TOTAL progress, not phase splits, so the bar
    # advances by exactly one unit per real piece of work.
    engine_total = estimate_apply_total_units(result.ir)
    total_units = engine_total + len(snippets_list) + len(chats_list)
    novelcrafter_import_service.update_commit_phase(
        session_id, "Starting import", 1, unit_total=total_units,
    )

    # Unified counter + per-item progress sink. EVERY event (setup
    # step name, entity name, scene title, cue name, chat name)
    # flows through here. Bar fills by exactly 1/total_units per
    # call so the writer sees REAL per-item rapid-fire progress
    # instead of phase-weighted bumps.
    counter = [0]
    def _on_progress(label: str):
        counter[0] += 1
        novelcrafter_import_service.update_commit_subphase(
            session_id, label, counter[0], total_units,
        )

    try:
        story, summary = apply_import_ir_new(
            result.ir,
            layout_mode=layout_mode,
            progress_callback=_on_progress,
            clean_chapter_act_titles=clean_titles_on,
        )
    except Exception as exc:  # noqa: BLE001
        novelcrafter_import_service.mark_commit_done(session_id, None)
        raise HTTPException(
            status_code=500,
            detail=f"Novelcrafter import failed during materialisation: {type(exc).__name__}: {exc}",
        ) from exc

    if novelcrafter_import_service.is_commit_cancelled(session_id):
        # Cancelled before any disk artifacts were written; nothing
        # to roll back beyond the in-memory previous-story restore
        # (which is a no-op since we haven't called set_story yet).
        return _cancelled_response(0, 0)

    # Phase 3.10 Layer 5 — staged-commit short-circuit. When the
    # writer turned on the AI scene-refinement toggle in the dialog,
    # the frontend POSTs with `dry_run=true`. We've built the full
    # Story but DON'T project it to `state.story`, DON'T run the
    # opt-in snippets/chats import (those land permanently — they
    # belong in the finalise step), and DON'T clear the preview
    # session. The frontend renders the scene-refinement modal
    # against the returned staged story; a follow-up POST to
    # `/commit_staged` applies the writer-confirmed refinement diff
    # and finalises.
    dry_run_on = (dry_run or "").strip().lower() not in ("false", "0", "off", "")
    if dry_run_on:
        session.staged_story = story
        staged_payload = {
            "applied": False,
            "staged": True,
            "session_id": session_id,
            "story": story.model_dump(),
            "counts": result.counts,
            "warnings": result.warnings,
            "engine_summary": summary,
            "story_title": story.title,
        }
        novelcrafter_import_service.mark_commit_done(session_id, staged_payload)
        return JSONResponse(content=staged_payload)

    state.set_story(story)
    state.set_active_file_path(None)

    # Phase 3.8 — opt-in snippet import to the program-level Context
    # Cue Library. snippets_list was parsed up-front so the global
    # total is correct; pass it through with the per-item progress
    # callback so each cue rapid-fires its own bar tick + label.
    snippets_imported = 0
    if import_snippets_on:
        snippets_imported = novelcrafter_import_service._create_imported_cues(
            snippets_list,
            story_title=story.title,
            warnings=result.warnings,
            session_id=session_id,
            progress_callback=_on_progress,
        )
        if novelcrafter_import_service.is_commit_cancelled(session_id):
            return _cancelled_response(snippets_imported, 0)
        if snippets_imported:
            result.warnings.append(
                f"{snippets_imported} snippet(s) imported to the Context Cue "
                f"Library tagged with `{story.title}` and `Imported`. Context "
                f"Cues are program-level — they apply to every project."
            )
    else:
        # ToDo Phase 3.8 spec: the opt-out path explicitly surfaces
        # `0 snippets imported (opt-out)` in the result summary so
        # the writer sees the snippets folder was deliberately skipped.
        result.warnings.append("0 snippets imported (opt-out)")
    result.counts["snippets_imported"] = snippets_imported

    # Phase 3.9 — opt-in chat import to the program-level Conversation
    # threads. Off by default; the dialog checkbox flips it on. Same
    # picker model as snippets: optional `chat_ids` filter constrains
    # which threads actually import. Conversations stamped with
    # `story_id = story.id` so they appear in THIS project's
    # conversation list (not the shared "Untitled" bucket), and
    # tagged with `[story.title, "Imported"]` mirroring the cue
    # tagging scheme.
    # `import_chats_on` was resolved up-front for phase_total.
    chats_imported = 0
    if import_chats_on:
        chats_imported = novelcrafter_import_service._create_imported_conversations(
            chats_list,
            story_id=story.id,
            story_title=story.title,
            warnings=result.warnings,
            session_id=session_id,
            progress_callback=_on_progress,
        )
        if novelcrafter_import_service.is_commit_cancelled(session_id):
            return _cancelled_response(snippets_imported, chats_imported)
        if chats_imported:
            result.warnings.append(
                f"{chats_imported} chat(s) imported to Conversation threads, "
                f"linked to this project via story_id and tagged with "
                f"`{story.title}` and `Imported`. Each thread imports with "
                f"profile/model/system_prompt left empty — pick those when "
                f"resuming a thread for the first time."
            )
    else:
        result.warnings.append("0 chats imported (opt-out)")
    result.counts["chats_imported"] = chats_imported

    novelcrafter_import_service.clear_preview_session(session_id)

    response_payload = {
        "applied": True,
        "session_id": session_id,
        "counts": result.counts,
        "warnings": result.warnings,
        "engine_summary": summary,
        "story_title": story.title,
    }
    # Phase 3.10 — stash the payload on the progress slot so the
    # modal's final poll sees `done=True` AND the full result on the
    # same response, no separate fetch needed. Slot stays in memory
    # for the grace-window poll cycle; the cancel endpoint or a
    # follow-up cleanup pass evicts it.
    novelcrafter_import_service.mark_commit_done(session_id, response_payload)
    return JSONResponse(content=response_payload)


@router.get("/commit_progress")
async def get_commit_progress(session_id: str) -> JSONResponse:
    """Phase 3.10 — modal polls this while a commit is in flight.

    Returns the current progress slot's snapshot. 404 when the slot
    is missing (server restarted mid-import, or a stale session ID).
    The frontend treats 404 as "stop polling, assume done" so the
    modal closes gracefully on backend restart.
    """
    prog = novelcrafter_import_service.get_commit_progress(session_id)
    if prog is None:
        raise HTTPException(
            status_code=404,
            detail=f"No commit-progress slot for session `{session_id}`.",
        )
    return JSONResponse(content={
        "session_id": prog.session_id,
        "phase": prog.phase,
        "phase_index": prog.phase_index,
        "phase_total": prog.phase_total,
        "unit_done": prog.unit_done,
        "unit_total": prog.unit_total,
        "cancelled": prog.cancelled,
        "done": prog.done,
        "result": prog.result,
    })


@router.post("/commit_cancel")
async def cancel_commit(session_id: str = Form(...)) -> JSONResponse:
    """Phase 3.10 — flips the cancel flag on the progress slot.

    The commit handler checks the flag at phase boundaries and
    inside per-item loops; once it sees `cancelled=True` it exits
    early, rolls back any disk artifacts created so far (cues +
    conversations) via `rollback_commit_artifacts`, restores the
    in-memory story to its pre-import snapshot, and marks the slot
    `done`. The frontend's Zustand snapshot revert covers the
    project-state side of the rollback.

    Returns `{accepted: bool}` — `false` when the cancel arrived
    after `done` was set, or for an unknown session.
    """
    accepted = novelcrafter_import_service.mark_commit_cancelled(session_id)
    return JSONResponse(content={"accepted": accepted})


@router.post("/commit_progress_clear")
async def clear_commit_progress_endpoint(session_id: str = Form(...)) -> JSONResponse:
    """Phase 3.10 — frontend calls this once it's processed the
    terminal poll (done=true) so the in-memory slot is evicted.
    No-op if the slot's already gone."""
    novelcrafter_import_service.clear_commit_progress(session_id)
    return JSONResponse(content={"cleared": True})


# ── Phase 3.10 Layer 5 — staged-commit finalise + discard ──────────────────

class CommitStagedRequest(BaseModel):
    """Body shape for `/commit_staged`. The frontend POSTs JSON here
    rather than form-encoding because the optional `scene_diffs`
    payload is structured (mirrors the /scene_wiring/refine response
    diff shape)."""
    session_id: str
    scene_diffs: Optional[List[Dict[str, Any]]] = None  # writer-confirmed
    # subset of /scene_wiring/refine's returned diff; None or empty
    # array = no refinement applied (writer cancelled the refinement
    # but chose to commit the regex-pipeline result anyway).
    # Re-passed snippet/chat import settings — the dry-run /commit
    # held off on these because they're permanent side-effects.
    import_snippets: bool = False
    snippet_ids: Optional[List[str]] = None
    import_chats: bool = False
    chat_ids: Optional[List[str]] = None


@router.post("/commit_staged")
def commit_staged_novelcrafter_import(req: CommitStagedRequest) -> JSONResponse:
    """Phase 3.10 Layer 5 — finalise a staged Novelcrafter commit.

    The first `/commit?dry_run=true` call built the Story but stashed
    it on `session.staged_story` without writing to `state.story`.
    This endpoint:
      1. Looks up the staged Story.
      2. Applies the writer-confirmed scene-refinement diff (if any).
      3. Writes the result to `state.story`.
      4. Runs the opt-in snippets / chats import.
      5. Clears the preview session + the commit-progress slot.
      6. Returns the same `{applied, counts, warnings, ...}` shape
         the non-staged `/commit` path returns.
    """
    session = novelcrafter_import_service.get_preview_session(req.session_id)
    if session is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Novelcrafter import session `{req.session_id}` not found. "
                "Sessions expire on server restart; re-upload the bundle."
            ),
        )
    if session.staged_story is None:
        raise HTTPException(
            status_code=409,
            detail=(
                "No staged story on this session. Call /commit with "
                "`dry_run=true` first before finalising via /commit_staged."
            ),
        )
    story = session.staged_story  # Story

    # Apply the refinement diff in the SAME shape `/scene_wiring/apply`
    # accepts. Reuse `scene_wiring.apply_refinement_diff` so the
    # mutation path is identical to the standalone-modal flow.
    refinement_applied_counts = {
        "scenes_touched": 0,
        "additions":      0,
        "removals":       0,
        "pov_changes":    0,
    }
    if req.scene_diffs:
        try:
            scene_diffs_objs: list[scene_wiring.SceneDiff] = []
            for sd in req.scene_diffs:
                chip_changes_objs = [
                    scene_wiring.SceneChipChange(
                        kind        = c.get("kind", ""),
                        entity_type = c.get("entity_type", ""),
                        entity_id   = c.get("entity_id", ""),
                        entity_name = c.get("entity_name", ""),
                    )
                    for c in sd.get("chip_changes", [])
                ]
                pov_payload = sd.get("pov_change")
                pov_change_obj = None
                if pov_payload:
                    pov_change_obj = scene_wiring.ScenePovChange(
                        new_pov_entity_id      = pov_payload.get("new_pov_entity_id"),
                        new_pov_entity_name    = pov_payload.get("new_pov_entity_name"),
                        previous_pov_entity_id = pov_payload.get("previous_pov_entity_id"),
                    )
                scene_diffs_objs.append(scene_wiring.SceneDiff(
                    scene_uuid   = sd.get("scene_uuid", ""),
                    scene_title  = sd.get("scene_title", ""),
                    chip_changes = chip_changes_objs,
                    pov_change   = pov_change_obj,
                    warnings     = list(sd.get("warnings", [])),
                ))
            diff_obj = scene_wiring.RefinementDiff(
                scene_diffs        = scene_diffs_objs,
                total_additions    = sum(1 for sd in scene_diffs_objs
                                         for c in sd.chip_changes if c.kind == "add"),
                total_removals     = sum(1 for sd in scene_diffs_objs
                                         for c in sd.chip_changes if c.kind == "remove"),
                total_pov_changes  = sum(1 for sd in scene_diffs_objs
                                         if sd.pov_change is not None),
                pov_declined_count = 0,
                warnings           = [],
            )
            scenes_touched = scene_wiring.apply_refinement_diff(diff_obj, story)
            refinement_applied_counts = {
                "scenes_touched": scenes_touched,
                "additions":      diff_obj.total_additions,
                "removals":       diff_obj.total_removals,
                "pov_changes":    diff_obj.total_pov_changes,
            }
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=500,
                detail=f"Refinement apply failed: {type(exc).__name__}: {exc}",
            ) from exc

    # Commit to global state.
    state.set_story(story)
    state.set_active_file_path(None)

    # Opt-in snippet + chat import. Same logic the non-staged /commit
    # runs, just deferred until the writer signed off on refinement.
    counts: dict[str, int] = {}
    warnings: list[str] = []
    snippets_imported = 0
    if req.import_snippets:
        accept_ids = set(req.snippet_ids) if req.snippet_ids else None
        snippets_list = novelcrafter_import_service._parse_snippets(
            session, accept_ids=accept_ids,
        )
        snippets_imported = novelcrafter_import_service._create_imported_cues(
            snippets_list,
            story_title=story.title,
            warnings=warnings,
            session_id=req.session_id,
            progress_callback=None,
        )
        if snippets_imported:
            warnings.append(
                f"{snippets_imported} snippet(s) imported to the Context Cue "
                f"Library tagged with `{story.title}` and `Imported`."
            )
    else:
        warnings.append("0 snippets imported (opt-out)")
    counts["snippets_imported"] = snippets_imported

    chats_imported = 0
    if req.import_chats:
        accept_ids = set(req.chat_ids) if req.chat_ids else None
        chats_list = novelcrafter_import_service._parse_chats(
            session, accept_ids=accept_ids,
        )
        chats_imported = novelcrafter_import_service._create_imported_conversations(
            chats_list,
            story_id=story.id,
            story_title=story.title,
            warnings=warnings,
            session_id=req.session_id,
            progress_callback=None,
        )
        if chats_imported:
            warnings.append(
                f"{chats_imported} chat(s) imported to Conversation threads, "
                f"linked to this project via story_id."
            )
    else:
        warnings.append("0 chats imported (opt-out)")
    counts["chats_imported"] = chats_imported

    # Cleanup.
    novelcrafter_import_service.clear_preview_session(req.session_id)
    novelcrafter_import_service.clear_commit_progress(req.session_id)

    return JSONResponse(content={
        "applied": True,
        "staged_finalised": True,
        "session_id": req.session_id,
        "counts": counts,
        "warnings": warnings,
        "story_title": story.title,
        "refinement_applied": refinement_applied_counts,
    })


@router.post("/commit_staged_discard")
def discard_staged_novelcrafter_import(session_id: str = Form(...)) -> JSONResponse:
    """Phase 3.10 Layer 5 — abandon a staged Novelcrafter commit.

    The writer hit "Cancel import entirely" on the scene-refinement
    modal. Discards the staged story, clears the session + progress
    slot. Project state stays exactly as it was before the writer
    opened the import dialog. Idempotent — calling twice is safe.
    """
    novelcrafter_import_service.clear_preview_session(session_id)
    novelcrafter_import_service.clear_commit_progress(session_id)
    return JSONResponse(content={"discarded": True})

