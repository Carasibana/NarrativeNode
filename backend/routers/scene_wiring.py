"""Phase 3.10 Layer 5 — scene wiring refinement endpoint.

Receives `{profile_id, model, scene_ids, depth, refine_pov, use_thinking}`
from the grid modal, runs the configured AI provider through the
catalog + chunked scenes, returns the aggregated parsed results.

Does NOT apply the results to scenes — that's item #7 (apply pass).
The frontend bulk-mode preview dialog (item #8) shows the diff and
the writer clicks Apply All or Cancel to actually mutate.
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import state
from services import scene_wiring
from services.llm_adapters import get_adapter
from services.user_preferences_service import read_user_preferences
from models.story import Story


def _serialise_diff(diff) -> dict:
    """Project a `RefinementDiff` dataclass into the JSON shape the
    frontend grid modal consumes. Used by both the live polling
    endpoint (to ship the final diff alongside `done=true`) and the
    legacy synchronous response path."""
    if diff is None:
        return None
    return {
        "total_additions":     diff.total_additions,
        "total_removals":      diff.total_removals,
        "total_pov_changes":   diff.total_pov_changes,
        "pov_declined_count":  diff.pov_declined_count,
        "warnings":            diff.warnings,
        "scene_diffs": [
            {
                "scene_uuid":   d.scene_uuid,
                "scene_title":  d.scene_title,
                "chip_changes": [
                    {
                        "kind":        c.kind,
                        "entity_type": c.entity_type,
                        "entity_id":   c.entity_id,
                        "entity_name": c.entity_name,
                    } for c in d.chip_changes
                ],
                "pov_change": (
                    {
                        "new_pov_entity_id":      d.pov_change.new_pov_entity_id,
                        "new_pov_entity_name":    d.pov_change.new_pov_entity_name,
                        "previous_pov_entity_id": d.pov_change.previous_pov_entity_id,
                    } if d.pov_change else None
                ),
                "warnings": d.warnings,
            }
            for d in diff.scene_diffs
        ],
    }


def _serialise_scene_results(scene_results: dict, prompt_id_to_uuid: dict) -> dict:
    """Build the `{scene_uuid: {pov, entities_present, warnings, prompt_id}}`
    map the frontend modal uses, mapping LLM-side prompt ids back to
    NN scene UUIDs via the case-insensitive lookup. Used by both the
    polling endpoint (incremental) and the legacy synchronous path
    (terminal)."""
    out: dict[str, dict] = {}
    for prompt_id, result in scene_results.items():
        scene_uuid = prompt_id_to_uuid.get(prompt_id.lower())
        if not scene_uuid:
            continue
        out[scene_uuid] = {
            "prompt_id": prompt_id,
            "pov": result.pov,
            "entities_present": result.entities_present,
            "warnings": result.warnings,
        }
    return out


router = APIRouter(prefix="/scene_wiring", tags=["scene-wiring"])


class SceneWiringRefineRequest(BaseModel):
    profile_id: str
    model: str
    scene_ids: List[str]
    depth: Literal["description", "prose"] = "description"
    refine_pov: bool = True
    use_thinking: bool = False
    # Phase 3.10 Layer 5 — staged-mode payload from a `/commit?dry_run=true`
    # response. When present, refinement runs against this story
    # instead of `state.story` (which holds the writer's existing
    # project — not the freshly-built NC import being staged).
    staged_story: Optional[Dict[str, Any]] = None


@router.post("/refine")
async def refine_scene_placements(
    req: SceneWiringRefineRequest,
) -> JSONResponse:
    """Run an AI-assisted scene wiring refinement over the given scene
    subset. Reads the currently-loaded story for entity catalog +
    scene text; the project state itself is NOT mutated by this
    endpoint — the result comes back as a parsed diff candidate
    that a follow-up apply call commits (when shipped)."""
    # 1. Resolve provider profile + model from user preferences.
    prefs = read_user_preferences()
    profile = next(
        (p for p in prefs.ai_provider_profiles if p.id == req.profile_id),
        None,
    )
    if profile is None:
        raise HTTPException(
            status_code=404,
            detail=f"AI provider profile `{req.profile_id}` not found.",
        )
    adapter = get_adapter(profile.api_type)
    if adapter is None:
        raise HTTPException(
            status_code=500,
            detail=f"No adapter registered for api_type `{profile.api_type}`.",
        )

    # 2. Capability snapshot (context window + thinking support).
    model_caps = scene_wiring.get_scene_wiring_model_caps(profile, req.model)

    # 3. Resolve the story to refine against.
    #    Staged-mode: NC import's dry_run /commit returned a freshly-
    #    built Story without projecting it to state. Reconstruct from
    #    the posted dict and refine against THAT (state.story still
    #    holds the writer's pre-import project — refining against it
    #    would be wrong).
    #    Standalone-mode: read state.story as usual.
    if req.staged_story is not None:
        try:
            story = Story(**req.staged_story)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=400,
                detail=f"`staged_story` payload could not be reconstructed: {type(exc).__name__}: {exc}",
            ) from exc
    else:
        story = state.get_story()
        if story is None:
            raise HTTPException(
                status_code=400,
                detail="No project is currently loaded.",
            )

    default_pov_name: Optional[str] = None
    if getattr(story, "pov_character_id", None):
        # Look up the character whose UUID matches the story-level default.
        for char in story.entities.characters:
            if char.id == story.pov_character_id:
                default_pov_name = char.name
                break

    catalog = scene_wiring.build_entity_catalog(
        characters=story.entities.characters,
        locations=story.entities.locations,
        items=story.entities.items,
        factions=story.entities.factions,
        customs=story.entities.customs,
        knowledges=story.knowledges,
        default_pov_character_name=default_pov_name,
    )

    # Closed-set canonical names for the parser to validate against.
    catalog_names: list[str] = []
    for bucket in (
        story.entities.characters,
        story.entities.locations,
        story.entities.items,
        story.entities.factions,
        story.entities.customs,
    ):
        for e in bucket:
            if e.name:
                catalog_names.append(e.name)
            # Aliases also count as valid catalog names so the parser
            # doesn't drop an LLM reply that used an alias (e.g.
            # `Carol` for an entity named `Alice` with `Carol` in
            # its aliases). The diff layer's name index maps the
            # alias back to the canonical entity, so accepting either
            # form lands the chip on the correct entity.
            for a in (e.aliases or []):
                v = (getattr(a, "value", None) or "").strip()
                if v:
                    catalog_names.append(v)
    # Knowledges and Relationships intentionally absent from the
    # LLM-allowed name set: knowledges aren't scene chips (too
    # abstract to be "present"), and relationships are derived
    # downstream from chip co-presence rather than direct LLM marks.
    # Mirrors the catalog exclusion in `build_entity_catalog`.
    # `default` and `?` are reserved POV tokens the parser handles
    # explicitly. We don't add them to the catalog_names — the
    # parser short-circuits them BEFORE the catalog lookup.

    # 4. Resolve scene IDs to SceneRefinementInput rows. `depth` picks
    #    which text we send the LLM:
    #      - 'description' → send the scene description only, wrapped
    #        in `<description>...</description>` so the LLM can tell
    #        what kind of text it is.
    #      - 'prose' → send BOTH the description AND the full prose
    #        body (with HTML stripped), each in its own XML wrapper.
    #        The description is useful framing context the prose lacks.
    scene_by_id = {sc.id: sc for sc in story.scenes}
    scenes_to_refine: list[scene_wiring.SceneRefinementInput] = []
    missing_ids: list[str] = []

    # Pre-build chapter and act indices so each scene's label can
    # carry its narrative position (Act N · Ch M · Scene K). Without
    # this, scenes with identical or missing titles (a common case
    # in NC imports — many scenes ship without titles) all read as
    # "(untitled scene)" in the LLM's user message and the LLM has
    # no positional context to ground its placement decisions.
    from services.chapter_membership import get_chapter_id_for_node as _bk_chapter_for_node
    chapters_list = list(getattr(story, "chapters", None) or [])
    chapter_x_offset = float(getattr(story, "chapter_x_offset", 10.0) or 10.0)
    chapter_num_by_id = {ch.id: i + 1 for i, ch in enumerate(chapters_list)}
    # Chapter title field is `title`, not `name` — matches the
    # `Chapter(title, colour, width)` Pydantic shape in models/story.py.
    chapter_name_by_id = {ch.id: (ch.title or "") for ch in chapters_list}
    act_num_by_chapter: dict[str, int] = {}
    for ai, act in enumerate(getattr(story, "acts", None) or []):
        for ch_id in (getattr(act, "chapter_ids", None) or []):
            act_num_by_chapter[ch_id] = ai + 1
    # Sequential scene index within a chapter — assigned in scene-id
    # ORDER (the same order story.scenes is iterated), so the chapter-
    # relative numbering stays stable across runs.
    scene_index_in_chapter: dict[str, int] = {}
    per_chapter_seen: dict[str, int] = {}
    for sc in story.scenes:
        ch_id = _bk_chapter_for_node(sc, chapters_list, x_offset=chapter_x_offset) or "__unchaptered__"
        per_chapter_seen[ch_id] = per_chapter_seen.get(ch_id, 0) + 1
        scene_index_in_chapter[sc.id] = per_chapter_seen[ch_id]

    def _positional_code(scene_obj) -> str:
        """Compact identifier like `A1C2S3` (Act 1, Chapter 2, Scene 3).
        Each component is included only when present; an unchaptered
        scene with no act yields just `S<idx>` against its bucket
        position. Returns an empty string when the scene has no
        positional anchor at all."""
        ch_id = _bk_chapter_for_node(scene_obj, chapters_list, x_offset=chapter_x_offset)
        positional = ""
        if ch_id and ch_id in act_num_by_chapter:
            positional += f"A{act_num_by_chapter[ch_id]}"
        if ch_id and ch_id in chapter_num_by_id:
            positional += f"C{chapter_num_by_id[ch_id]}"
        sc_idx = scene_index_in_chapter.get(scene_obj.id)
        if sc_idx:
            positional += f"S{sc_idx}"
        return positional

    # Two prompt-id aliases per scene: the positional code (`A1C2S3`)
    # that the LLM naturally keys on when it sees something unique in
    # the per-scene label, and the sequential fallback (`scene_N`) for
    # models that prefer to use the explicit ID they were told to use.
    # Both map to the same NN UUID so either form of LLM reply works.
    sequential_for_uuid: dict[str, str] = {}
    positional_for_uuid: dict[str, str] = {}
    for idx, sid in enumerate(req.scene_ids):
        scene = scene_by_id.get(sid)
        if scene is None:
            missing_ids.append(sid)
            continue
        description_text = (scene.description or "").strip()
        if req.depth == "description":
            body = f"<description>\n{description_text}\n</description>"
        else:
            prose_text = scene_wiring.strip_html(scene.main_content or "").strip()
            parts: list[str] = []
            if description_text:
                parts.append(f"<description>\n{description_text}\n</description>")
            parts.append(f"<prose>\n{prose_text}\n</prose>")
            body = "\n".join(parts)
        positional = _positional_code(scene)
        sequential = f"scene_{idx + 1}"
        # Prefer the positional code as the LLM-facing scene_id when
        # one exists — it's more meaningful for the LLM (uniquely
        # identifies the scene's position in the narrative) and
        # downstream lookups are case-insensitive.
        prompt_id = positional or sequential
        sequential_for_uuid[sequential] = scene.id
        if positional:
            positional_for_uuid[positional] = scene.id
        own_title = (scene.title or "").strip() or "(untitled scene)"
        scenes_to_refine.append(
            scene_wiring.SceneRefinementInput(
                scene_id=prompt_id,
                nn_uuid=scene.id,
                title=own_title,
                body=body,
            )
        )

    if not scenes_to_refine:
        raise HTTPException(
            status_code=400,
            detail=(
                "No valid scenes to refine. "
                f"Missing scene ids: {missing_ids!r}"
                if missing_ids else "No scene ids provided."
            ),
        )

    # Build the case-insensitive prompt-id → UUID lookup table once,
    # so both the per-chunk progress writer AND the terminal diff
    # compute use the same map.
    prompt_id_to_uuid: dict[str, str] = {}
    for s in scenes_to_refine:
        prompt_id_to_uuid[s.scene_id.lower()] = s.nn_uuid
    for sequential, uuid_str in sequential_for_uuid.items():
        prompt_id_to_uuid[sequential.lower()] = uuid_str
    for positional, uuid_str in positional_for_uuid.items():
        prompt_id_to_uuid[positional.lower()] = uuid_str

    # 5. Depth-aware per-chunk caps + run-id allocation.
    max_per_chunk = (
        scene_wiring.MAX_SCENES_PER_CHUNK_PROSE
        if req.depth == "prose"
        else scene_wiring.MAX_SCENES_PER_CHUNK_DESCRIPTION
    )
    max_input_tokens = (
        scene_wiring.MAX_INPUT_TOKENS_PER_CHUNK_PROSE
        if req.depth == "prose"
        else scene_wiring.MAX_INPUT_TOKENS_PER_CHUNK_DESCRIPTION
    )

    run_id = uuid.uuid4().hex
    scene_wiring.init_run_progress(run_id)
    # Up-front: every selected scene UUID lands in the queued set so
    # the modal can paint a "Queued" badge on those cards while the
    # orchestrator works through its chunks. The chunk-start hook
    # promotes them queued → processing one chunk at a time, and
    # the per-line hook drains them processing → result-state as
    # each scene's verdict streams in.
    scene_wiring.mark_scenes_queued(
        run_id, [s.nn_uuid for s in scenes_to_refine],
    )

    # Lowercase catalog set for the per-line parser. Pre-computed so
    # the streaming callback doesn't re-derive it per scene.
    catalog_names_lc = {n.lower() for n in catalog_names}

    def _on_chunk_start(idx, total, scene_uuids):
        """Move this chunk's scenes from queued → processing on the
        progress slot. Frontend reads both sets and flips badges
        Queued → Refining + spinning coin in the next poll tick."""
        scene_wiring.mark_scenes_processing(run_id, scene_uuids)

    def _on_line(line: str):
        """Per-line streaming callback fired by `_collect_chat_response`
        every time the LLM emits a newline-terminated line. We parse
        the line, resolve its scene UUID, compute a single-scene
        diff against the live story, and push BOTH the result and
        the diff entry into the slot — then drain the scene from
        the processing set. The polling endpoint serialises the
        accumulating `slot.diff`, so the modal's sceneStatus
        immediately reflects the correct refined / no_change /
        pov_declined state for that one scene instead of waiting
        for the whole chunk to land."""
        parsed_scene, _line_warnings = scene_wiring._parse_response_line(
            line,
            catalog_names_lc=catalog_names_lc,
        )
        if parsed_scene is None:
            return
        scene_uuid = prompt_id_to_uuid.get(parsed_scene.scene_id.lower())
        if not scene_uuid:
            return
        # Build a minimal one-scene RefinementRun so we can reuse the
        # canonical `compute_refinement_diff` rather than duplicate
        # its chip + POV computation here.
        single_run = scene_wiring.RefinementRun(
            scene_results={parsed_scene.scene_id.lower(): parsed_scene},
            warnings=[], chunk_count=1, chunks_run=1, chunks_failed=0,
        )
        single_diff = scene_wiring.compute_refinement_diff(
            single_run, story, prompt_id_to_uuid,
        )
        single_entry = (
            single_diff.scene_diffs[0]
            if single_diff.scene_diffs else None
        )
        scene_wiring.update_run_progress_single_scene(
            run_id,
            scene_uuid=scene_uuid,
            parsed_result={
                "prompt_id":         parsed_scene.scene_id,
                "pov":               parsed_scene.pov,
                "entities_present":  parsed_scene.entities_present,
                "warnings":          parsed_scene.warnings,
            },
            partial_diff_entry=single_entry,
        )
        # That scene's verdict has fully landed → drop it from the
        # processing set. The modal's next poll observes the flip
        # to refined / no_change / pov_declined.
        scene_wiring.mark_scene_done_processing(run_id, scene_uuid)

    # 6. Spawn the orchestration as a background task so the
    # endpoint can return run_id immediately and the frontend can
    # poll /refine_progress for per-chunk results. The background
    # task closes over story / prompt_id_to_uuid / etc. so the
    # final diff compute happens against the right project state.
    def _on_chunk_complete(idx, total, chunk, parsed):
        # parsed is a ParsedResponse (or None on a chunk-level
        # failure isolated by the orchestrator). On a chunk failure
        # we still bump the chunk counts so the modal's progress bar
        # advances; no scene_results land but the chunks_done /
        # chunks_failed counts move.
        # Whatever happened, drain THIS chunk's scenes from the
        # processing set so the modal doesn't keep "Refining" badges
        # on scenes whose line never made it through the per-line
        # streaming parser (LLM bailed mid-list, line lacked a `*`,
        # malformed CSV, etc.). The per-line callback already drains
        # the scenes whose lines parsed cleanly; this catches the
        # rest.
        scene_wiring.mark_chunk_done_processing(
            run_id, [s.nn_uuid for s in chunk.scenes],
        )
        prior = scene_wiring.get_run_progress(run_id)
        prior_failed = prior.chunks_failed if prior else 0
        if parsed is None:
            scene_wiring.update_run_progress_chunk(
                run_id,
                chunks_total=total,
                chunks_done=idx + 1,
                chunks_failed=prior_failed + 1,
                parsed_scene_results={},
                new_warnings=[],
            )
            return
        # Project the parser's prompt-id-keyed scene_results into the
        # UUID-keyed shape the modal consumes. Lowercased on lookup
        # because the prompt_id_to_uuid map is case-insensitive (the
        # LLM may have shifted casing in its reply).
        uuid_keyed_results: dict[str, dict] = {}
        for prompt_id, result in parsed.scene_results.items():
            scene_uuid = prompt_id_to_uuid.get(prompt_id.lower())
            if not scene_uuid:
                continue
            uuid_keyed_results[scene_uuid] = {
                "prompt_id":         prompt_id,
                "pov":               result.pov,
                "entities_present":  result.entities_present,
                "warnings":          result.warnings,
            }
        scene_wiring.update_run_progress_chunk(
            run_id,
            chunks_total=total,
            chunks_done=idx + 1,
            chunks_failed=prior_failed,
            parsed_scene_results=uuid_keyed_results,
            new_warnings=list(parsed.warnings or []),
        )

    # Cancellation probe — the orchestrator passes this through to
    # the adapter so a /refine_cancel POST short-circuits the stream
    # at the next event boundary. Closes over `run_id` so the same
    # probe reads the right slot regardless of when it fires.
    def _is_cancelled() -> bool:
        return scene_wiring.is_run_cancelled(run_id)

    async def _do_run():
        try:
            run = await scene_wiring.run_scene_wiring(
                adapter=adapter,
                profile=profile,
                model=req.model,
                scenes=scenes_to_refine,
                catalog=catalog,
                catalog_names=catalog_names,
                refine_pov=req.refine_pov,
                has_default_pov=default_pov_name is not None,
                use_thinking=req.use_thinking,
                model_caps=model_caps,
                max_scenes_per_chunk=max_per_chunk,
                max_input_tokens_per_chunk=max_input_tokens,
                on_chunk_complete=_on_chunk_complete,
                on_chunk_start=_on_chunk_start,
                on_line=_on_line,
                is_cancelled=_is_cancelled,
            )
            # The orchestrator already merged everything into
            # run.scene_results. Lowercase and project through the
            # diff helper now.
            run.scene_results = {
                sid.lower(): res for sid, res in run.scene_results.items()
            }
            diff = scene_wiring.compute_refinement_diff(run, story, prompt_id_to_uuid)
            scene_wiring.mark_run_done(
                run_id,
                diff=diff,
                meta={
                    "chunk_count":       run.chunk_count,
                    "chunks_run":        run.chunks_run,
                    "chunks_failed":     run.chunks_failed,
                    "scenes_requested":  len(req.scene_ids),
                    "scenes_attempted":  len(scenes_to_refine),
                    "scenes_resolved":   len(_serialise_scene_results(
                        run.scene_results, prompt_id_to_uuid,
                    )),
                },
                extra_warnings=(
                    [f"Unknown scene_ids skipped: {missing_ids!r}"]
                    if missing_ids else None
                ),
            )
        except Exception as exc:  # noqa: BLE001
            scene_wiring.mark_run_error(
                run_id,
                f"Scene wiring refinement failed: {type(exc).__name__}: {exc}",
            )

    asyncio.create_task(_do_run())

    # Return run_id immediately. Frontend polls /refine_progress.
    return JSONResponse(content={
        "run_id":             run_id,
        "scenes_requested":   len(req.scene_ids),
        "scenes_attempted":   len(scenes_to_refine),
    })


@router.get("/refine_progress")
def get_refine_progress(run_id: str) -> JSONResponse:
    """Per-run progress poll. Frontend ticks this every ~500ms while
    a /refine call is in flight and merges incoming `scene_results`
    + the optional terminal `diff` into the modal's local state."""
    slot = scene_wiring.get_run_progress(run_id)
    if slot is None:
        raise HTTPException(
            status_code=404,
            detail=f"No refine-progress slot for run_id `{run_id}`.",
        )
    # `slot.scene_results` is already UUID-keyed in the shape the
    # modal consumes — the orchestrator's on_chunk_complete callback
    # projects each chunk's parsed prompt-id-keyed results through
    # the prompt_id_to_uuid map before writing into the slot. Ship
    # as-is.
    return JSONResponse(content={
        "run_id":               slot.run_id,
        "done":                 slot.done,
        "error":                slot.error,
        "chunks_total":         slot.chunks_total,
        "chunks_done":          slot.chunks_done,
        "chunks_failed":        slot.chunks_failed,
        "scene_results":        dict(slot.scene_results),
        "warnings":             list(slot.warnings),
        "diff":                 _serialise_diff(slot.diff),
        "meta":                 dict(slot.meta or {}),
        # In-flight tracking — the modal renders Queued and Refining
        # badges on cards whose UUIDs land in these sets.
        "queued_scene_ids":     list(slot.queued_scene_ids),
        "processing_scene_ids": list(slot.processing_scene_ids),
    })


@router.post("/refine_progress_clear")
def clear_refine_progress(run_id: str) -> JSONResponse:
    """Frontend calls this once it's processed the terminal poll
    (done=true). Frees the in-memory slot. Idempotent — calling on
    a missing slot is a no-op."""
    scene_wiring.clear_run_progress(run_id)
    return JSONResponse(content={"cleared": True})


@router.post("/refine_cancel")
def cancel_refine(run_id: str) -> JSONResponse:
    """Flip the cancellation flag on the run's progress slot. The
    background task's adapter probe sees the flip at the next
    streamed event boundary; the in-flight chunk's partial response
    is dropped (per the writer's rule: only scenes whose FULL
    information lands before the cancel are retained as draft).
    Returns `{accepted: bool}` — false on a missing / already-done
    slot so the modal can show "couldn't cancel — already finished"
    if the timing's tight."""
    accepted = scene_wiring.mark_run_cancelled(run_id)
    return JSONResponse(content={"accepted": accepted})


# ---------- Apply endpoint ----------------------------------------------------
# The frontend grid modal renders the diff returned by /refine, lets the
# writer accept some/all scene diffs (per-scene Cancel drops a scene from
# the payload), and POSTs the filtered diff payload back here. We
# reconstruct dataclasses + run `apply_refinement_diff`, which mutates the
# scene chips and pov_entity_id in place. The story is saved on the next
# project save in the normal flow (no implicit /story PUT here — the
# writer might also want to undo via Zustand snapshot first).

class ChipChangePayload(BaseModel):
    kind: Literal["add", "remove"]
    entity_type: str
    entity_id: str
    entity_name: str


class PovChangePayload(BaseModel):
    new_pov_entity_id:      Optional[str] = None
    new_pov_entity_name:    Optional[str] = None
    previous_pov_entity_id: Optional[str] = None


class SceneDiffPayload(BaseModel):
    scene_uuid: str
    scene_title: str = ""
    chip_changes: List[ChipChangePayload] = []
    pov_change: Optional[PovChangePayload] = None
    warnings: List[str] = []


class SceneWiringApplyRequest(BaseModel):
    scene_diffs: List[SceneDiffPayload]


@router.post("/apply")
async def apply_refinement(req: SceneWiringApplyRequest) -> JSONResponse:
    """Apply a previously-computed refinement diff to the currently
    loaded story. Mutates SceneNode chip lists + pov_entity_id in
    place. Returns the count of scenes that were actually touched
    (a scene with empty diff is a no-op and not counted).

    The writer is expected to have reviewed the diff in the bulk-
    mode preview dialog before calling this. We trust the payload
    shape but still skip individual chip changes that reference an
    entity_id no longer in the story (entity deleted between
    refine and apply, etc.) — those become warnings rather than
    blocking the whole apply.
    """
    if state.story is None:
        raise HTTPException(
            status_code=404,
            detail="No project is currently loaded.",
        )

    # Reconstruct dataclass shape for apply helper.
    scene_diffs: list[scene_wiring.SceneDiff] = []
    for sd in req.scene_diffs:
        scene_diffs.append(scene_wiring.SceneDiff(
            scene_uuid  = sd.scene_uuid,
            scene_title = sd.scene_title,
            chip_changes = [
                scene_wiring.SceneChipChange(
                    kind        = c.kind,
                    entity_type = c.entity_type,
                    entity_id   = c.entity_id,
                    entity_name = c.entity_name,
                ) for c in sd.chip_changes
            ],
            pov_change = (
                scene_wiring.ScenePovChange(
                    new_pov_entity_id      = sd.pov_change.new_pov_entity_id,
                    new_pov_entity_name    = sd.pov_change.new_pov_entity_name,
                    previous_pov_entity_id = sd.pov_change.previous_pov_entity_id,
                ) if sd.pov_change else None
            ),
            warnings = list(sd.warnings),
        ))

    diff = scene_wiring.RefinementDiff(
        scene_diffs        = scene_diffs,
        total_additions    = sum(
            1 for sd in scene_diffs for c in sd.chip_changes if c.kind == "add"
        ),
        total_removals     = sum(
            1 for sd in scene_diffs for c in sd.chip_changes if c.kind == "remove"
        ),
        total_pov_changes  = sum(1 for sd in scene_diffs if sd.pov_change is not None),
        pov_declined_count = 0,
        warnings           = [],
    )

    try:
        scenes_touched = scene_wiring.apply_refinement_diff(diff, state.story)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=500,
            detail=f"Scene wiring apply failed: {type(exc).__name__}: {exc}",
        ) from exc

    return JSONResponse(content={
        "scenes_touched":   scenes_touched,
        "additions":        diff.total_additions,
        "removals":         diff.total_removals,
        "pov_changes":      diff.total_pov_changes,
    })
