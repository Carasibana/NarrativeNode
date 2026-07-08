"""Seeds CRUD + import / export endpoints.

All routes sit under `/project/seeds` because the underlying data is
per-project (the current project's `state.get_seeds()`), not user-level.
User-level defaults that seed new projects live under `/settings` in a
later commit.

The endpoints in this module:

- `GET /project/seeds`       — return the current seeds (always, even if empty)
- `PUT /project/seeds`       — replace the current seeds with the payload
- `POST /project/seeds/import` — import seeds from an uploaded `.nnz` or
                                 `seeds.json`; supports preview mode
- `GET /project/seeds/export` — download the current seeds as a
                                 standalone `seeds.json` file, with
                                 bundled preset lists for portability
"""
import json

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from models.entity import PresetList
from models.seeds import SeedsFile
from services import seeds_service
import state


class SeedsSaveResponse(BaseModel):
    """Response body for `PUT /project/seeds`. Includes the updated
    project-level preset list pool alongside the saved seeds so the
    frontend can refresh its `entitiesStore.presetLists` without a
    separate round-trip. The PUT may have promoted bundled preset
    lists from the seeds into the project; the frontend needs to know.
    """
    seeds: SeedsFile
    project_preset_lists: list[PresetList]


router = APIRouter(prefix="/project/seeds", tags=["seeds"])


@router.get("", response_model=SeedsFile)
def get_seeds():
    """Return the current project's seeds. Returns an empty `SeedsFile`
    (all per-type buckets empty, `preset_lists` empty) when none are
    configured — the frontend can render its Seeded Attributes tab
    uniformly without a null-check."""
    return state.get_seeds()


@router.put("", response_model=SeedsSaveResponse)
def put_seeds(seeds: SeedsFile):
    """Save the current project's seeds, bidirectionally reconciling
    the bundled preset lists with the project's own preset list pool.

    The Story Seeds tab treats the bundled preset lists section as a
    direct editor of the project's `story.preset_lists` — edits in
    the seeds editor need to flow through to the project pool (so
    Entity Library sees them + so preset-type stubs resolve at entity
    creation), and project preset lists referenced by stubs need to
    auto-bundle into the seeds (so the saved seeds file is self-
    contained for export into another project later).

    Reconciliation steps (in order):

    1. `state.set_seeds(seeds)` stores the user's payload verbatim.
    2. `sync_bundled_preset_lists_to_project` mutates the project's
       pool: each bundled entry creates or OVERWRITES (by name) the
       matching project preset list. Removes are NOT propagated —
       users manage project-level deletions via Entity Library.
    3. `auto_bundle_referenced_project_lists` adds any project preset
       list referenced by a stub but missing from the bundled section
       into `seeds.preset_lists` (copied by name + values from the
       project pool). Guarantees the saved seeds are self-contained.

    Preset-list references by name from stubs are not validated —
    the user may be editing a stub that references a preset list
    they haven't created yet. Orphans surface at entity-creation
    time via `apply_seeds_to_entity` (stderr warning + attribute
    with `preset_list_id = null`).

    Response includes the full updated project-level preset list pool
    so the frontend can refresh its `entitiesStore.presetLists` in
    one round-trip — no separate call needed.
    """
    state.set_seeds(seeds)
    story = state.get_story()
    seeds_service.sync_bundled_preset_lists_to_project(seeds, story)
    seeds_service.auto_bundle_referenced_project_lists(seeds, story)
    return SeedsSaveResponse(
        seeds=seeds,
        project_preset_lists=story.preset_lists,
    )


@router.post("/import")
async def import_seeds(
    file: UploadFile = File(...),
    preview: bool = Form(False),
    mode: str = Form("replace"),
    selection: str | None = Form(None),
):
    """Import seeds from an uploaded file.

    The upload may be either a `.nnz` archive (we extract its
    `seeds.json`) or a standalone `seeds.json` file.

    Params are multipart form fields (not query params) so a JSON
    `selection` payload can ride alongside the file in a single
    request. `selection` — when provided — is a JSON-stringified
    dict of the shape:

        {
          "stubs": {"character": [0, 2], "location": [], ...},
          "preset_lists": [0, 3]
        }

    Any stub or preset-list whose index is NOT listed is excluded
    from the import. When `selection` is omitted the full source
    imports without filtering — same as the pre-granular-UI
    behaviour.

    When `preview=true`, the endpoint returns a structured preview
    without mutating any state; `selection` is ignored here since the
    preview enumerates every item for the UI to build its checkbox
    list from.

    When `preview=false` (default), the import is applied to the
    current project:

    - Preset lists are matched by name against `story.preset_lists`.
      `"identical"` → reused, `"new"` → created with a fresh UUID,
      `"conflict"` → skipped with a warning.
    - Stubs merge according to `mode`: `replace` overwrites current
      stubs with the (filtered) imported set, `append` adds them on
      top.

    Returns a summary describing what changed.
    """
    if mode not in ("replace", "append"):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid mode {mode!r}; must be 'replace' or 'append'.",
        )
    selection_dict = None
    if selection:
        try:
            selection_dict = json.loads(selection)
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid selection JSON: {exc}",
            )

    data = await file.read()
    filename = file.filename or "(uploaded file)"
    try:
        source = seeds_service.parse_source_seeds(data, filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Could not read seeds from {filename!r}: {exc}",
        )

    story = state.get_story()

    if preview:
        preview_data = seeds_service.build_import_preview(source, story.preset_lists)
        # Frontend reads this to decide whether to show the
        # destructive "Replace will overwrite your current seeds"
        # confirm dialog when the user picks Replace.
        preview_data["target_is_empty"] = state.get_seeds().is_empty()
        return preview_data

    current = state.get_seeds()
    summary = seeds_service.merge_import_into_project(
        source, story, current, mode, selection=selection_dict,
    )
    state.set_seeds(current)
    return {"applied": True, **summary}


@router.get("/export")
def export_seeds():
    """Return the current project's seeds as a downloadable `seeds.json`.

    The exported file bundles every preset list that is referenced by a
    preset-type stub, so the file is round-trip-safe: importing it into
    a fresh project recreates those preset lists and the stubs resolve
    cleanly on the first entity creation after the import.

    Preset lists NOT referenced by any stub are deliberately omitted.
    See `seeds_service.build_export_bundle` for rationale.
    """
    current = state.get_seeds()
    story = state.get_story()
    bundle = seeds_service.build_export_bundle(current, story)
    text = seeds_service.serialize_seeds(bundle)
    return Response(
        content=text,
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="seeds.json"'},
    )
