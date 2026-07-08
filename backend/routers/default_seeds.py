"""Default seeds endpoints — read / write `preferences/default_seeds.json`.

The Default Seeds tab in the Settings panel uses these endpoints to
manage the user-level seeds template that gets copied into new
projects at creation time (Phase 1.14). The file format is identical
to a project's `seeds.json` inside the `.nnz` — same `SeedsFile`
Pydantic model, same `seeds_service` helpers. Round-trip import /
export between project seeds and default seeds works in either
direction because they're the same format.

Scope: machine-local, independent of any project. No coupling to
`story.preset_lists` — there is no project context at this layer.
Bundled preset lists inside the seeds file are the sole source for
preset-type stubs in the Default Seeds editor.

The file is ENTIRELY OPTIONAL. All three of these states are treated
as "no default seeds configured" and the GET returns an empty
`SeedsFile`: (a) file missing entirely, (b) file present but zero
bytes or only whitespace, (c) file present but malformed JSON. This
matches the "three states of no seeds" semantic documented on the
project `.nnz` seeds.json side — default seeds must never block the
Settings panel from loading.

On save, an empty-seeds payload DELETES the file rather than
persisting a hollow shell — same semantic as `pack_project` for the
project-side seeds.
"""
import json
from pathlib import Path
import sys

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from models.seeds import SeedsFile
from services import seeds_service


# `backend/routers/default_seeds.py` → .parent.parent.parent = repo root.
# The default seeds file lives outside the `backend/` package so every
# checkout sees it in the same place regardless of which working
# directory the user launched the backend from.
_MODULE_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _MODULE_DIR.parent.parent
_DEFAULT_SEEDS_PATH = _REPO_ROOT / "preferences" / "default_seeds.json"


router = APIRouter(prefix="/settings/default-seeds", tags=["settings"])


def _read_file() -> SeedsFile:
    """Read `preferences/default_seeds.json`. Returns an empty
    `SeedsFile` for any "no usable seeds" condition: missing file,
    zero-byte file, whitespace-only file, or malformed JSON. Malformed
    content logs a warning to stderr (matching the pack/unpack path's
    fallback behaviour); default seeds aren't allowed to block the
    Settings UI from rendering."""
    try:
        raw = _DEFAULT_SEEDS_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return seeds_service.empty_seeds()
    except OSError as exc:
        print(
            f"[default_seeds] could not read {_DEFAULT_SEEDS_PATH!s}: {exc!r}. "
            f"Treating as no default seeds configured.",
            file=sys.stderr,
            flush=True,
        )
        return seeds_service.empty_seeds()

    if not raw.strip():
        return seeds_service.empty_seeds()

    try:
        return seeds_service.parse_seeds(raw)
    except Exception as exc:
        print(
            f"[default_seeds] malformed {_DEFAULT_SEEDS_PATH!s}: {exc!r}. "
            f"Treating as no default seeds configured.",
            file=sys.stderr,
            flush=True,
        )
        return seeds_service.empty_seeds()


def _write_file(seeds: SeedsFile) -> None:
    """Write `preferences/default_seeds.json`. Creates the parent
    directory if missing so a fresh install's first save doesn't fail
    just because `preferences/` hasn't been created yet.

    An empty seeds payload DELETES the file rather than persisting a
    hollow shell — matches the "no seeds configured = no file"
    semantic used by the project-side `pack_project`. Reload then sees
    a clean absence rather than an empty-but-present file."""
    _DEFAULT_SEEDS_PATH.parent.mkdir(parents=True, exist_ok=True)
    if seeds.is_empty():
        try:
            _DEFAULT_SEEDS_PATH.unlink(missing_ok=True)
        except OSError:
            pass
        return
    _DEFAULT_SEEDS_PATH.write_text(
        seeds_service.serialize_seeds(seeds), encoding="utf-8"
    )


@router.get("", response_model=SeedsFile)
def get_default_seeds():
    """Return the current default seeds template. Always a well-formed
    `SeedsFile` — empty when nothing is configured."""
    return _read_file()


@router.put("", response_model=SeedsFile)
def put_default_seeds(seeds: SeedsFile):
    """Replace the default seeds template with the supplied payload.

    No project preset-list reconciliation here — there is no project
    at this layer. Bundled preset lists stay in `seeds.preset_lists`
    and are the sole source for preset-type stubs in the Default
    Seeds editor. When these seeds are later copied into a new
    project at creation time, the bundled preset lists are promoted
    into that project's `story.preset_lists` by the `newProject()`
    helper (landing in a later commit)."""
    _write_file(seeds)
    return seeds


@router.post("/import")
async def import_default_seeds(
    file: UploadFile = File(...),
    preview: bool = Form(False),
    mode: str = Form("replace"),
    selection: str | None = Form(None),
):
    """Import default seeds from an uploaded `.nnz` / `.json` file.

    Mirrors `POST /project/seeds/import` but writes into the
    default-seeds file (no story context). `selection` shape is
    identical. See that endpoint's docstring for details on
    `preview` / `mode` / `selection` semantics.

    Preset-list conflicts are matched against the CURRENT default
    seeds' `preset_lists` — not any project's preset lists. Default
    seeds are a standalone template.
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

    current = _read_file()

    if preview:
        preview_data = seeds_service.build_import_preview(source, current.preset_lists)
        # Frontend reads this to decide whether to show the
        # destructive "Replace will overwrite your current default
        # seeds" confirm when the user picks Replace.
        preview_data["target_is_empty"] = current.is_empty()
        return preview_data

    summary = seeds_service.merge_import_into_default_seeds(
        source, current, mode, selection=selection_dict,
    )
    _write_file(current)
    return {"applied": True, **summary}


@router.get("/export")
def export_default_seeds():
    """Return the current default seeds as a downloadable `default_seeds.json`.

    Since default seeds are already a standalone SeedsFile on disk
    (no story context, no separate preset-list pool), the export is
    just a straight serialisation of the in-memory file. The bundled
    preset lists inside the file travel with it naturally.
    """
    current = _read_file()
    text = seeds_service.serialize_seeds(current)
    return Response(
        content=text,
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="default_seeds.json"'},
    )
