"""Story Library read API (Phase 5.5 slice 1).

Read-only endpoints the library view reads from:
  - GET /library          — the story index entries (for listing).
  - GET /library/cover/{uuid} — the cached cover for one entry.

Writes (registration) happen on save / open via `library_service`
(Phase 5.3b); shelf-layout endpoints + library actions (open, add,
hide, remove, rename) arrive as the library view grows.
"""
import asyncio
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from models.library import ShelfLayout
from services import library_service, file_service

router = APIRouter(prefix="/library", tags=["library"])


def _safe_uuid(uuid: str) -> str:
    """Keep only uuid-safe characters so a crafted id can't escape the
    assets dir via path separators / traversal."""
    return "".join(c for c in uuid if c.isalnum() or c == "-")


@router.get("")
@router.get("/")
def list_library():
    """Return the library index entries for the library view. One item
    per story UUID with its cached metadata, paths, flags, and a derived
    `has_cover` (whether a cached cover exists)."""
    index = library_service.read_index()
    assets = library_service.assets_dir()
    entries = []
    for uid, entry in index.entries.items():
        ps = library_service.path_status(entry)
        entries.append({
            "id": uid,
            "title": entry.meta.title,
            "description": getattr(entry.meta, "description", None),
            "tags": entry.meta.tags,
            "series": entry.meta.series,
            "series_number": entry.meta.series_number,
            "accent_color": getattr(entry.meta, "accent_color", None),
            "pinned_default_path": entry.pinned_default_path,
            "last_opened": entry.last_opened,
            "favourite": entry.favourite,
            "hidden": entry.hidden,
            "has_cover": (assets / f"{uid}.jpg").is_file(),
            # Path status (existing paths + resolution), design doc §2.1/§2.2,
            # so a card renders fully (cover, dropdown, missing state) from
            # this one response.
            "paths": ps["paths"],
            "resolved_path": ps["resolved_path"],
            "warning": ps["warning"],
            "missing": ps["missing"],
        })
    return {"entries": entries}


@router.get("/{uuid}/paths")
def get_library_paths(uuid: str):
    """Path status for one entry (Phase 5.5a path resolution): the known
    paths that still exist on disk (most-recent-first, each with its
    last-modified time + autosave tag) plus the resolved Open path and the
    `warning` / `missing` flags. Backs the project card's Open button +
    path dropdown. 404 when the UUID is not in the index."""
    index = library_service.read_index()
    entry = index.entries.get(uuid)
    if entry is None:
        raise HTTPException(status_code=404, detail="Unknown story")
    return library_service.path_status(entry)


@router.get("/cover/{uuid}")
def get_library_cover(uuid: str):
    """Serve the cached cover for a library entry. 404 when there is no
    cached cover (the frontend falls back to the placeholder)."""
    assets = library_service.assets_dir()
    path = (assets / f"{_safe_uuid(uuid)}.jpg").resolve()
    if not str(path).startswith(str(assets.resolve())):
        raise HTTPException(status_code=400, detail="Invalid id")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="No cover")
    return FileResponse(path, media_type="image/jpeg")


@router.get("/layout")
def get_library_layout():
    """The shelf layout (design doc §2.4 / §4): an ordered array of shelves
    (array position = display order). Tolerant read falls back to the
    first-run default (Recents + Favourites) on a missing / malformed file."""
    return library_service.read_layout()


@router.put("/layout")
def put_library_layout(layout: ShelfLayout):
    """Replace the whole shelf layout (add / remove / reorder shelves). The
    frontend sends the full ordered shelves array; a new shelf may omit `id`
    and is assigned one on validation. Returns the persisted layout."""
    library_service.write_layout(layout)
    return library_service.read_layout()


class _FlagBody(BaseModel):
    value: bool


@router.put("/{uuid}/favourite")
def put_favourite(uuid: str, body: _FlagBody):
    """Set / clear the favourite flag (drives the derived Favourites shelf).
    404 when the UUID is not in the index."""
    if not library_service.set_favourite(uuid, body.value):
        raise HTTPException(status_code=404, detail="Unknown story")
    return {"id": uuid, "favourite": body.value}


@router.put("/{uuid}/hidden")
def put_hidden(uuid: str, body: _FlagBody):
    """Set / clear the hidden flag (hidden drops the story from every view
    except the Hidden section, design doc §6). 404 when unknown."""
    if not library_service.set_hidden(uuid, body.value):
        raise HTTPException(status_code=404, detail="Unknown story")
    return {"id": uuid, "hidden": body.value}


@router.delete("/{uuid}")
def remove_from_library(uuid: str):
    """Remove a story from the library (design doc §6): purge its index
    entry + cached cover and strip it from every shelf. The `.nnz` file is
    NOT touched. Idempotent (returns removed=false if it was not present)."""
    removed = library_service.remove_entry(uuid)
    return {"id": uuid, "removed": removed}


@router.post("/cleanup")
def cleanup_library():
    """Phase 5.6a 'Cleanup Library': re-scan every entry's known paths
    against disk, strip the ones that no longer exist, and remove any entry
    left with zero existing paths (entry + cached cover + shelf memberships
    purged, like a manual Remove). The `.nnz` files are never touched.
    Returns {paths_stripped, entries_removed}."""
    return library_service.cleanup_missing()


@router.post("/{uuid}/locate")
async def locate_library_entry(uuid: str):
    """Phase 5.6a 'Locate': open a native file picker so the user can point
    a (missing) entry at its moved / found `.nnz`. The picked file's internal
    story id is verified against the entry: on a MATCH the path is added
    (clearing the missing state); on a MISMATCH nothing changes and a warning
    is returned. The `.nnz` is never modified. Returns one of:
      {located: true, path}            — matched + path added
      {located: false, cancelled: true} — user cancelled the picker
      {located: false, mismatch: true, picked_title} — different story
      {located: false, error}          — file unreadable as a project."""
    if uuid not in library_service.read_index().entries:
        raise HTTPException(status_code=404, detail="Unknown story")

    def _pick():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            chosen = filedialog.askopenfilename(
                title="Locate NarrativeNode Project",
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
        return {"located": False, "cancelled": True}

    try:
        story_dict, _ = file_service.unpack_project(Path(chosen).read_bytes())
    except Exception:
        return {"located": False, "error": "That file could not be read as a NarrativeNode project."}

    if story_dict.get("id") != uuid:
        return {"located": False, "mismatch": True, "picked_title": story_dict.get("title") or "Untitled"}

    library_service.add_path(uuid, chosen)
    return {"located": True, "path": chosen}
