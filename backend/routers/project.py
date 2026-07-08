import asyncio
import logging
import traceback
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from models.story import Story
from models.seeds import SeedsFile
from services import file_service, error_log, library_service
from services.file_service import (
    CorruptSaveError,
    IncompatibleSaveError,
    build_corrupt_detail,
    build_incompatible_detail,
)
import state

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/project", tags=["project"])


# Resolved at import time so each dialog spawn doesn't re-walk the
# filesystem. `__file__` lives at `backend/routers/project.py`; the
# repo's `assets/NN.ico` is two levels up.
_NN_ICON_PATH = Path(__file__).resolve().parents[2] / "assets" / "NN.ico"


def _suggested_save_filename(override_title: Optional[str] = None) -> str:
    """Phase 1.22j — derive a default `.nnz` filename from the current
    story's title. Used by both the `/default-save-path` endpoint
    (frontend SavePathModal pre-fill) and the native Save As dialog's
    `initialfile`.

    Sanitises Windows-illegal characters (`<>:"/\\|?*`), trims
    whitespace, collapses internal whitespace runs to a single space,
    and falls back to `"Untitled"` when the resulting stem is empty
    OR equals the placeholder `"Untitled Story"`. Always appends the
    `.nnz` extension.

    `override_title` lets callers pass the LIVE frontend title (which
    may diverge from the backend's last-synced story state — backend
    state only updates on save / load). When provided and non-empty,
    it takes precedence over `state.get_story().title`."""
    if override_title is not None and override_title.strip():
        title = override_title.strip()
    else:
        story = state.get_story()
        title = (story.title or "").strip() if story is not None else ""
    if not title or title == "Untitled Story":
        return "Untitled.nnz"
    # Drop / replace characters illegal in Windows filenames; keep
    # everything else verbatim including spaces.
    cleaned = "".join(c if c not in '<>:"/\\|?*' else "_" for c in title)
    cleaned = " ".join(cleaned.split()).strip()  # collapse internal whitespace runs
    if not cleaned:
        return "Untitled.nnz"
    return f"{cleaned}.nnz"


def _apply_dialog_icon(root) -> None:
    """Apply the NarrativeNode `.ico` to a hidden tkinter root so the
    spawned filedialog inherits its title-bar icon (Windows shows it
    in the dialog's top-left corner). Best-effort — tkinter raises if
    the path is missing or the file isn't a valid `.ico`, but we
    swallow that since the dialog still works fine with the default
    feather icon as fallback."""
    try:
        if _NN_ICON_PATH.is_file():
            root.iconbitmap(default=str(_NN_ICON_PATH))
    except Exception:
        pass


def _unpack_or_raise(data: bytes) -> tuple[dict, SeedsFile]:
    """Wrap `file_service.unpack_project` so the three load endpoints
    share a single error-translation path: incompatible / corrupt /
    generic each map to a distinct HTTPException shape.

    Returns a `(story_dict, seeds)` tuple — same contract as the
    underlying `file_service.unpack_project`. Callers are expected to
    `state.set_story(...)` and `state.set_seeds(...)` from the
    returned values.

    If you are adding a new save-format error class or changing the
    detail payload shape: the frontend counterpart is
    `handleSaveFormatLoadError` in `frontend/src/store/projectStore.js`,
    and the save-format design lives in
    `backend/services/file_service.py` under `MIN_READER_EPOCHS` (see
    also `docs/save-format-versioning.md`). The import path
    (`routers/entity_import.py → import_preview`) uses the same shared
    error-detail builders — keep all four in sync in the same commit.
    """
    try:
        return file_service.unpack_project(data)
    except IncompatibleSaveError as exc:
        raise HTTPException(status_code=422, detail=build_incompatible_detail(exc))
    except CorruptSaveError as exc:
        raise HTTPException(status_code=400, detail=build_corrupt_detail(exc))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid .nnz file: {exc}")


# ── Save (in-place) ──────────────────────────────────────────────────────────

class SaveRequest(BaseModel):
    file_path: str
    is_autosave: bool = False
    # Optional override for the asset-recovery source. Caller (the
    # frontend) can pass the path to a .nnz it knows the assets came
    # from when the backend's own state has been reset — e.g. when
    # uvicorn --reload wiped `_assets_dir` mid-session, autosave still
    # needs a way to repopulate any missing referenced assets before
    # the save guard refuses to pack. Falls through to the existing
    # active-path / autosave-target heuristics when absent.
    recovery_source_path: Optional[str] = None


@router.post("/save")
async def save_project(req: SaveRequest):
    """Write the current story to the given path on the local filesystem.

    When `is_autosave` is true, the active file path is not updated — the
    main project file stays the active path while the autosave writes to
    a sibling file (e.g. `<name>_autosave.nnz`).
    """
    path = Path(req.file_path)
    if path.suffix.lower() != ".nnz":
        path = path.with_suffix(".nnz")
    try:
        story = state.get_story()
        seeds = state.get_seeds()
        # Recovery source priority:
        #   1. The caller's explicit `recovery_source_path` if given.
        #      Used by the frontend's autosave to thread its own
        #      `activePath` through when the backend has lost its
        #      state (e.g. uvicorn --reload reset `_assets_dir` +
        #      `state.active_file_path` mid-session) — without this
        #      the autosave's recovery falls back to options 2/3
        #      which are both empty in that scenario and the save
        #      guard refuses to pack.
        #   2. The backend's active file path (the .nnz the backend
        #      knows it loaded from, if any).
        #   3. Falling back to the save target itself, because in an
        #      in-place save the target IS the last good copy on disk
        #      — covers the case where the active path was cleared
        #      (e.g. UI load via browser upload) but the user is saving
        #      back over a known-good file.
        recovery_source = None
        if req.recovery_source_path:
            candidate = Path(req.recovery_source_path)
            if candidate.exists():
                recovery_source = candidate
        if recovery_source is None:
            active = state.get_active_file_path()
            if active:
                recovery_source = Path(active)
            elif path.exists():
                recovery_source = path
        data = file_service.pack_project(story, seeds, recovery_source_path=recovery_source)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        if not req.is_autosave:
            state.set_active_file_path(str(path))
        # Phase 5.3b — register with the story library (no-op when the
        # master toggle is off). An autosave records only its recovery
        # path; an explicit save also refreshes recency / meta / cover.
        library_service.register_project(story, str(path), is_autosave=req.is_autosave)
        return {"saved_to": str(path)}
    except file_service.MissingAssetsError as exc:
        # Asset-recovery couldn't fill every reference — actionable for
        # the user (missing asset names listed in `exc.detail`). Log
        # to the user-downloadable error.log AND the server console.
        logger.error("Save failed (MissingAssetsError): %s", exc.detail)
        error_log.log_error(
            "SAVE",
            exc,
            context={"file_path": str(path), "is_autosave": req.is_autosave},
        )
        raise HTTPException(status_code=500, detail=exc.detail)
    except Exception as exc:
        # Catch-all. Without explicit logging, FastAPI's HTTPException
        # path hides the original traceback from the server console, so
        # intermittent save bugs become un-diagnosable after the fact.
        # Dump the full traceback to the uvicorn console AND append a
        # verbose entry to the user-downloadable error.log so the writer
        # can grab it from the in-app banner.
        tb = traceback.format_exc()
        logger.error(
            "Save failed (%s): %s\n%s",
            type(exc).__name__, exc, tb,
        )
        error_log.log_error(
            "SAVE",
            exc,
            context={"file_path": str(path), "is_autosave": req.is_autosave},
        )
        raise HTTPException(
            status_code=500,
            detail=f"Save failed ({type(exc).__name__}): {exc}",
        )


@router.get("/active-path")
async def get_active_path():
    """Return the currently active save path, or null if none is set."""
    return {"active_path": state.get_active_file_path()}


@router.get("/default-save-path")
async def get_default_save_path(suggested_title: Optional[str] = None):
    """Return a suggested default save path based on the story title.
    Phase 1.22j — uses the shared `_suggested_save_filename()` helper
    so the SavePathModal pre-fill matches the native Save As dialog's
    `initialfile` exactly. Falls back to `Untitled.nnz` when the title
    is empty / whitespace / equals the placeholder `"Untitled Story"`.

    `suggested_title` query param lets the frontend pass the LIVE
    title (which may diverge from `state.get_story()` until the next
    save / load round-trips backend state)."""
    default = Path.home() / "Documents" / _suggested_save_filename(suggested_title)
    return {"default_path": str(default)}


# ── Load ─────────────────────────────────────────────────────────────────────

@router.post("/load")
async def load_project(file: UploadFile = File(...)):
    """Accept a .nnz upload (or a legacy .nnplot upload), restore story
    state, and return the story. Loading via the browser does not give
    us the original file path, so the active save path is cleared — the
    user will be prompted on next Save. The browser-upload path cannot
    rename the source file on disk (no filesystem access) — legacy
    `.nnplot` uploads are simply accepted as-is, and the subsequent
    save writes the `.nnz` extension.
    """
    data = await file.read()
    story_dict, seeds = _unpack_or_raise(data)
    story = Story.model_validate(story_dict)
    state.set_story(story)
    state.set_seeds(seeds)
    state.set_active_file_path(None)
    return story


# ── Load from file path on disk ─────────────────────────────────────────────

class LoadPathRequest(BaseModel):
    path: str

@router.post("/load-path")
async def load_project_from_path(req: LoadPathRequest):
    """Load a project file from a path on disk. Used by loadFromRecent
    when the file path is known — this restores binary assets (profile
    images, etc.) that the JSON-only recent restore cannot.

    Accepts both `.nnz` and legacy `.nnplot` files. On a successful load
    from a legacy `.nnplot` path, the file is renamed in place to
    `.nnz` and the active save path is updated to the new name, so
    every subsequent operation on the file uses the current extension.
    """
    file_path = Path(req.path)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found at the specified path")
    data = file_path.read_bytes()
    story_dict, seeds = _unpack_or_raise(data)
    story = Story.model_validate(story_dict)
    state.set_story(story)
    state.set_seeds(seeds)
    # Rename legacy .nnplot → .nnz AFTER a successful validation so a
    # corrupt legacy file doesn't get silently renamed.
    final_path = file_service.upgrade_nnplot_to_nnz(file_path)
    state.set_active_file_path(str(final_path))
    # Phase 5.3b — register the opened project with the story library.
    library_service.register_project(story, str(final_path))
    return story


# ── Native file-open dialog ──────────────────────────────────────────────────

@router.get("/native-open")
async def native_open_project(pick_only: bool = False):
    """Open a native OS file-open dialog, load the selected project file,
    and return {"path": path, "story": story}.  Returns
    {"path": null, "story": null} if the user cancels. When ``pick_only``
    is true the dialog is shown but the file is NOT loaded — only
    {"path": path} is returned (the caller loads it via POST /load-path),
    so a loading overlay never has to cover the native picker. The dialog runs
    in a thread so the async event loop is not blocked; tkinter is
    initialised and destroyed within that thread. Requires tkinter,
    which is included in standard Python on Windows/macOS/Linux.

    The file-type filter accepts both the current `.nnz` extension and
    the legacy `.nnplot` extension (files created before the rename).
    After a successful load, if the selected file was a `.nnplot`, it is
    renamed in place to `.nnz` and the returned path / active save
    path both reflect the new name — so every subsequent operation on
    the file uses the current extension and the user never sees the
    old extension again for that file.
    """
    def _pick():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            _apply_dialog_icon(root)
            root.withdraw()
            root.attributes("-topmost", True)
            chosen = filedialog.askopenfilename(
                title="Open NarrativeNode Project",
                filetypes=[
                    ("NarrativeNode Project", ("*.nnz", "*.nnplot")),
                    ("All files", "*.*"),
                ],
            )
            root.destroy()
            return str(chosen) if chosen else None
        except Exception:
            return None

    chosen = await asyncio.to_thread(_pick)
    if not chosen:
        return {"path": None, "story": None}

    # Picker-only mode: return the chosen path WITHOUT loading the file, so
    # the frontend keeps its "Opening…" overlay OFF while the native dialog
    # is open and only shows it once a path is in hand (loading then happens
    # via POST /load-path). Without this the overlay covers the OS picker.
    if pick_only:
        return {"path": str(chosen), "story": None}

    chosen_path = Path(chosen)
    data = chosen_path.read_bytes()
    story_dict, seeds = _unpack_or_raise(data)

    story = Story.model_validate(story_dict)
    state.set_story(story)
    state.set_seeds(seeds)
    # Rename legacy .nnplot → .nnz AFTER a successful validation so a
    # corrupt legacy file doesn't get silently renamed.
    final_path = file_service.upgrade_nnplot_to_nnz(chosen_path)
    state.set_active_file_path(str(final_path))
    # Phase 5.3b — register the opened project with the story library.
    library_service.register_project(story, str(final_path))
    return {"path": str(final_path), "story": story}


# ── Native file-save-as dialog ────────────────────────────────────────────────

@router.get("/native-save-as")
async def native_save_as(suggested_title: Optional[str] = None):
    """Open a native OS file-save dialog, let the user pick a target path for
    the current project, and return ``{"path": path}``.  Returns
    ``{"path": null}`` if the user cancels.  Does NOT write the file — the
    frontend follow-up call to ``POST /api/project/save`` does the actual
    write.  Split into two steps so the user can still back out between
    picking a path and committing, and so the save pipeline stays identical
    between "typed path" and "native picker" flows.

    Mirrors ``GET /api/project/native-open`` exactly — runs tkinter in a
    thread so the async loop is not blocked, auto-appends `.nnz` when
    missing, and handles cancel / error by returning None. Phase 1.13
    v0.1.13.2.

    Save-as always writes the current `.nnz` extension. Unlike the
    load-open dialog, there is no legacy-extension compatibility on the
    save side — writing a fresh file always uses the current format's
    extension. If the user's current project was loaded from a legacy
    `.nnplot`, it has already been renamed in place to `.nnz` by the
    load path, so by the time Save As runs the current active path is
    already using the new extension.
    """
    def _pick():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            _apply_dialog_icon(root)
            root.withdraw()
            root.attributes("-topmost", True)
            # Pre-fill the initial filename from the currently-active path,
            # if any, so Save As on an already-loaded project pre-populates
            # the dialog with the file's current name.
            current_path = state.get_active_file_path()
            # Phase 1.22j — when there's no active path yet (first save
            # via Save As), pre-populate the filename with the story's
            # title (sanitised) so the user doesn't have to retype it.
            # `suggested_title` query param carries the LIVE frontend
            # title — backend `state.get_story()` only updates on save
            # / load, so a freshly-typed title in the centered top-bar
            # input wouldn't influence the dialog without this. Falls
            # back to Untitled.nnz when title is empty / placeholder.
            # When a path IS already set, keep the current filename so
            # the user is renaming what they have.
            initialfile = Path(current_path).name if current_path else _suggested_save_filename(suggested_title)
            initialdir = str(Path(current_path).parent) if current_path else None
            chosen = filedialog.asksaveasfilename(
                title="Save NarrativeNode Project As",
                defaultextension=".nnz",
                filetypes=[("NarrativeNode Project", "*.nnz"), ("All files", "*.*")],
                initialfile=initialfile,
                **({"initialdir": initialdir} if initialdir else {}),
            )
            root.destroy()
            if not chosen:
                return None
            # Guarantee the `.nnz` extension — on some platforms the
            # native dialog's `defaultextension` kwarg only appends when
            # the user types a name with NO extension, and won't enforce
            # the extension if they type something else. We pin it here
            # so the resulting file is always openable by the load path.
            chosen_path = str(chosen)
            if not chosen_path.lower().endswith(".nnz"):
                chosen_path = chosen_path + ".nnz"
            return chosen_path
        except Exception:
            return None

    chosen = await asyncio.to_thread(_pick)
    return {"path": chosen}


# ── Export ───────────────────────────────────────────────────────────────────

@router.get("/export/nnz")
async def export_nnz():
    """Download a copy of the current project as a .nnz file."""
    story = state.get_story()
    seeds = state.get_seeds()
    active = state.get_active_file_path()
    recovery_source = Path(active) if active else None
    try:
        data = file_service.pack_project(story, seeds, recovery_source_path=recovery_source)
    except file_service.MissingAssetsError as exc:
        logger.error("Export (.nnz) failed (MissingAssetsError): %s", exc.detail)
        error_log.log_error(
            "EXPORT_NNZ",
            exc,
            context={"active_file_path": active},
        )
        raise HTTPException(status_code=500, detail=exc.detail)
    except Exception as exc:
        tb = traceback.format_exc()
        logger.error(
            "Export (.nnz) failed (%s): %s\n%s",
            type(exc).__name__, exc, tb,
        )
        error_log.log_error(
            "EXPORT_NNZ",
            exc,
            context={"active_file_path": active},
        )
        raise HTTPException(
            status_code=500,
            detail=f"Export failed ({type(exc).__name__}): {exc}",
        )
    safe_title = (
        "".join(c if c.isalnum() or c in " _-" else "_" for c in story.title).strip()
        or "narrative"
    )
    filename = f"{safe_title}.nnz"
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Pending load request (single-instance handoff) ──────────────────────────
# When a second launch of NarrativeNode detects the first is already running,
# it POSTs the file path here instead of loading the file directly. The
# backend stashes the path without touching the story. The frontend's focus
# listener picks it up and routes it through the normal unsaved-changes guard
# before calling /load-path to do the actual load. The frontend is always
# in control of when (and whether) the load actually happens.


class PendingLoadRequest(BaseModel):
    path: str


@router.post("/pending-load-request")
async def create_pending_load_request(req: PendingLoadRequest):
    """Stash a file path for the frontend to pick up on its next focus
    event. Does NOT load the file or touch the story — the frontend
    calls /load-path after the user has approved (or cleared unsaved
    changes). Overwrites any previously-pending path; only one pending
    request exists at a time."""
    state.set_pending_load_path(req.path)
    return {"pending": req.path}


@router.get("/pending-load-request")
async def get_pending_load_request():
    """Return the currently-pending file path, or null if nothing is
    pending. The frontend polls this periodically to detect a handoff.

    The poll doubles as a frontend liveness heartbeat — recording the
    timestamp here means `run.py`'s /alive probe knows a tab is alive
    without needing a second dedicated endpoint. See `/alive` below and
    `state.is_frontend_alive()`.
    """
    state.record_heartbeat()
    return {"pending": state.get_pending_load_path()}


@router.get("/alive")
async def alive():
    """Liveness probe for the single-instance handoff path in run.py.

    Returns `{"alive": true}` when the backend has recorded a frontend
    heartbeat within the heartbeat window. When false, run.py knows no
    browser tab is live and falls back to opening a fresh browser tab
    (webbrowser.open). When true, run.py skips the browser call and
    relies on the existing tab's periodic poll to pick up the pending-
    load request — preventing the second-tab race that would silently
    discard the original tab's unsaved work.
    """
    return {"alive": state.is_frontend_alive()}


@router.delete("/pending-load-request")
async def delete_pending_load_request():
    """Clear the pending load request. Called by the frontend after it
    has either loaded the file (user approved) or the user cancelled."""
    state.clear_pending_load_path()
    return {"pending": None}


# Note: `/project/export/html`, `/project/export/markdown`, and
# `/project/export/pdf` are now owned by `routers/export.py` as part
# of Phase 1.12a. The stub `not implemented` placeholders that used to
# live here are gone — the real endpoints use the `export_service`
# pipeline built around `ExportModel`.


# ── Assets ───────────────────────────────────────────────────────────────────

@router.post("/assets/upload")
async def upload_asset(file: UploadFile = File(...)):
    """Upload an asset file. Returns the file_ref for use in file attributes.

    SHA-256 deduplication: if an identical file is already present in the project
    assets directory, the existing file_ref is returned and no duplicate is stored.

    Delegates to `file_service.store_asset_bytes` so this HTTP path and any
    in-process callers (e.g. the MCP profile-image tool) share the same
    dedup + safe-naming invariants.
    """
    content = await file.read()
    file_ref = file_service.store_asset_bytes(content, file.filename or "asset")
    return {"file_ref": file_ref}


@router.get("/assets/{filename}")
async def get_asset(filename: str):
    """Serve an asset file from the currently loaded project."""
    assets_dir = file_service.get_assets_dir()
    if not assets_dir:
        raise HTTPException(status_code=404, detail="No project loaded")
    asset_path = (assets_dir / filename).resolve()
    if not str(asset_path).startswith(str(assets_dir.resolve())):
        raise HTTPException(status_code=400, detail="Invalid filename")
    if not asset_path.exists():
        raise HTTPException(status_code=404, detail="Asset not found")
    return FileResponse(asset_path)


# ── Cover image (Phase 5.2a) ───────────────────────────────────────────────────
# The cover is a top-level `cover.jpg` in the .nnz (NOT an asset). Its
# presence is the cover; absence = none. The working copy lives in
# file_service's cover temp dir, refreshed on every load (and cleared on
# New Project). Setting / clearing the cover is the Story Settings control
# (Phase 5.2b); these read-only endpoints are the serving + status side.

@router.get("/cover")
async def get_cover():
    """Serve the active project's cover image. 404 when no cover is set
    (the frontend falls back to the bundled placeholder)."""
    cover_path = file_service.get_cover_path()
    if cover_path is None:
        raise HTTPException(status_code=404, detail="No cover set")
    return FileResponse(cover_path, media_type="image/jpeg")


@router.get("/cover/status")
async def get_cover_status():
    """Project-state response carrying the derived `has_cover` boolean
    (computed from working-dir presence, never a stored field) so the
    frontend knows whether to show the cover or the placeholder."""
    return {"has_cover": file_service.has_cover()}


@router.put("/cover")
async def set_cover(file: UploadFile = File(...)):
    """Replace the active project's cover image. The Story Settings crop
    flow uploads a cropped JPEG; it lands in the working dir and is
    written to the .nnz root as `cover.jpg` on the next project save.
    Like an entity profile-image upload, this takes effect immediately
    (it is not gated by the Story Settings Save / Cancel) — the frontend
    flips the project's unsaved-changes flag so the user saves it."""
    content = await file.read()
    try:
        file_service.set_cover_bytes(content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"has_cover": True}


@router.delete("/cover")
async def delete_cover():
    """Clear the active project's cover so the next save writes no
    cover.jpg. No-op when there is no cover."""
    file_service.clear_cover()
    return {"has_cover": False}
