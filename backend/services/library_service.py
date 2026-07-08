"""Story Library data layer (Phase 5.3a).

Owns the git-ignored repo-root `library/` folder and the tolerant I/O
for its `index.json` story index. Mirrors the folder-resolution +
atomic-write + tolerant-read shape `conversations_service` already uses.

`library/` holds ONLY the library's own data (it is NOT a project save
location — the user's `.nnz` files are never stored here):
  - `index.json`         — the story index (`LibraryIndexFile`).
  - `layout.json`        — the shelf layout (Phase 5.4; not modelled here yet).
  - `assets/<uuid>.jpg`  — cached cover copies (byte copies of `cover.jpg`).

Phase 5.3b adds `register_project` (upsert the index entry + byte-copy the
cover into the cache, on save / path-based open), gated on the
`use_project_library` master toggle (its Program Settings UI lands in
5.3c). Path resolution + "Add to library" land with the library view in
Phase 5.5.
"""
from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

from models.library import (
    LibraryEntry,
    LibraryIndexFile,
    LibraryMetaSnapshot,
    LibraryPathEntry,
    Shelf,
    ShelfLayout,
)


# Repo-root `library/`, sibling to `preferences/`, `conversations/`,
# `backend/`, `frontend/`. `__file__` is backend/services/library_service.py
# → three parents up is the repo root.
_BASE_DIR = Path(__file__).resolve().parent.parent.parent / "library"
_INDEX_FILENAME = "index.json"
_LAYOUT_FILENAME = "layout.json"
_ASSETS_DIRNAME = "assets"


def library_dir() -> Path:
    """The `library/` folder path. Not created here — callers that write
    (the index writer, a save into the folder) create it as needed."""
    return _BASE_DIR


def assets_dir() -> Path:
    """The `library/assets/` folder holding cached cover thumbnails."""
    return _BASE_DIR / _ASSETS_DIRNAME


def _index_path() -> Path:
    return _BASE_DIR / _INDEX_FILENAME


def read_index() -> LibraryIndexFile:
    """Read `index.json` tolerantly. A missing, unreadable, or malformed
    file returns an empty index rather than raising — the library is a
    rebuildable view layer (registration re-populates it on save / open),
    so a bad file must never block the app. A parse failure is logged to
    stderr to match the other load-path fallbacks."""
    path = _index_path()
    if not path.exists():
        return LibraryIndexFile()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(
            f"[library] unreadable {path.name} ({exc!r}); starting with an empty index.",
            file=sys.stderr,
            flush=True,
        )
        return LibraryIndexFile()
    try:
        return LibraryIndexFile.model_validate(data)
    except Exception as exc:
        print(
            f"[library] malformed {path.name} ({exc!r}); starting with an empty index.",
            file=sys.stderr,
            flush=True,
        )
        return LibraryIndexFile()


def write_index(index: LibraryIndexFile) -> None:
    """Persist the index via write-temp + atomic replace, so a crash
    mid-write can never leave a torn `index.json` (readers see either the
    prior file or the new one). Creates `library/` on first write."""
    _BASE_DIR.mkdir(parents=True, exist_ok=True)
    target = _index_path()
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(index.model_dump_json(indent=2), encoding="utf-8")
    tmp.replace(target)


# ── Registration (Phase 5.3b) ──────────────────────────────────────────

def _meta_snapshot(story) -> LibraryMetaSnapshot:
    """Cache the story's view-driving metadata from the in-memory story."""
    return LibraryMetaSnapshot(
        title=getattr(story, "title", "") or "",
        description=getattr(story, "description", None) or None,
        tags=list(getattr(story, "tags", None) or []),
        series=getattr(story, "series", None),
        series_number=getattr(story, "series_number", None),
        accent_color=getattr(story, "accent_color", None),
    )


def _refresh_cover_cache(story_id: str) -> None:
    """Byte-copy the active project's working `cover.jpg` to
    `library/assets/<id>.jpg` — NO re-encode, NO resize. The cover is
    already a <=1024x1536 q92 JPG from its single save-time conversion, so
    a second encode would be a needless quality drop. If the project has
    no cover, remove any stale cache file."""
    from services import file_service  # lazy: file_service imports main
    dest = assets_dir() / f"{story_id}.jpg"
    cover = file_service.get_cover_path()
    if cover is not None:
        assets_dir().mkdir(parents=True, exist_ok=True)
        shutil.copyfile(cover, dest)
    else:
        dest.unlink(missing_ok=True)


def register_project(story, file_path, *, is_autosave: bool = False) -> None:
    """Upsert the library index entry for `story` saved / opened at
    `file_path`. No-op when the `use_project_library` master toggle is off
    (Phase 5.3c), or when there is no story id / path.

    - Always: record / promote the used path (drop any existing record
      for that path, prepend it as most-recent, carrying its autosave tag).
    - Explicit save / open (NOT autosave): also bump `last_opened`, refresh
      the cached metadata snapshot, and byte-copy the cover into the cache.
    - Autosave (`is_autosave=True`): record only the (autosave-tagged) path
      for recovery — it must NOT reorder Recents or churn the snapshot /
      cover, since it's a background write, not a user open.

    Registration is convenience bookkeeping: any failure is swallowed
    (logged) so it can never turn a successful save / open into a failure.
    """
    try:
        from services import user_preferences_service  # lazy import
        prefs = user_preferences_service.read_user_preferences()
        if not getattr(prefs, "use_project_library", True):
            return
        story_id = getattr(story, "id", None)
        if not story_id or not file_path:
            return

        norm_path = str(Path(file_path))
        now = time.time()

        index = read_index()
        entry = index.entries.get(story_id) or LibraryEntry()
        kept = [p for p in entry.paths if p.path != norm_path]
        entry.paths = [LibraryPathEntry(path=norm_path, last_accessed=now, is_autosave=is_autosave)] + kept
        if not is_autosave:
            entry.last_opened = now
            entry.meta = _meta_snapshot(story)
        index.entries[story_id] = entry
        write_index(index)

        if not is_autosave:
            _refresh_cover_cache(story_id)
    except Exception as exc:
        print(f"[library] registration skipped ({exc!r}).", file=sys.stderr, flush=True)


# ── Shelf layout (Phase 5.4a) ───────────────────────────────────────────

def _layout_path() -> Path:
    return _BASE_DIR / _LAYOUT_FILENAME


def default_layout() -> ShelfLayout:
    """First-run library layout: a Recents row + an (initially empty)
    Favourites row (design doc §5 / §8.3)."""
    return ShelfLayout(shelves=[
        Shelf(type="recents", count=10),
        Shelf(type="favourites"),
    ])


def read_layout() -> ShelfLayout:
    """Read `layout.json` tolerantly. Missing / unreadable / malformed
    falls back to the first-run default (Recents + Favourites) rather
    than raising — the layout is user-curated but must never block the
    app; a corrupt file rebuilds to the default."""
    path = _layout_path()
    if not path.exists():
        return default_layout()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(
            f"[library] unreadable {path.name} ({exc!r}); using the default layout.",
            file=sys.stderr,
            flush=True,
        )
        return default_layout()
    try:
        return ShelfLayout.model_validate(data)
    except Exception as exc:
        print(
            f"[library] malformed {path.name} ({exc!r}); using the default layout.",
            file=sys.stderr,
            flush=True,
        )
        return default_layout()


def write_layout(layout: ShelfLayout) -> None:
    """Persist the shelf layout via write-temp + atomic replace (same
    shape as `write_index`). Creates `library/` on first write."""
    _BASE_DIR.mkdir(parents=True, exist_ok=True)
    target = _layout_path()
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(layout.model_dump_json(indent=2), encoding="utf-8")
    tmp.replace(target)


def reconcile_order(order_list: list[str], members: list[str]) -> list[str]:
    """Normalize a manual-order sort hint (a Tag / Favourites shelf's
    `order`) to exactly the current member set, preserving manual order:

      - keep listed UUIDs that are still members, in their listed order,
      - append current members not yet listed, in `members` order (the
        caller pre-sorts `members` — e.g. by `last_opened` — for the
        tie-break),
      - drop listed UUIDs that are no longer members.

    Pure + idempotent. Applied at write time (favourite / tag-add appends,
    unfavourite / tag-remove drops) and defensively on read. Design doc §2.4.
    """
    member_set = set(members)
    kept = [u for u in order_list if u in member_set]
    kept_set = set(kept)
    appended = [u for u in members if u not in kept_set]
    return kept + appended


def favourite_member_ids(index: LibraryIndexFile) -> list[str]:
    """Derived Favourites-shelf membership: the UUIDs of index entries
    flagged `favourite`. Hidden-state exclusion is applied uniformly at
    render time (a cross-shelf view filter), not here."""
    return [uid for uid, entry in index.entries.items() if getattr(entry, "favourite", False)]


# ── Path resolution + autosave handling (Phase 5.5a) ─────────────────────

def _path_exists(path: str) -> bool:
    """True when `path` points at an existing file. Tolerant: any OS error
    (permission, bad drive letter, network drive timeout) is treated as
    'does not exist' so a flaky path can never raise into a library read."""
    try:
        return Path(path).is_file()
    except Exception:
        return False


def _resolve_from(pinned_default_path, ordered_paths):
    """Pure path picker (NO filesystem access, so it's unit-testable).

    `ordered_paths` is the entry's paths most-recent-first, each a dict
    `{path, is_autosave, exists}`. Returns `{resolved_path, warning,
    missing}` (design doc §2.2):

      - resolved_path: the path Open should use. Preference order is the
        pinned default (if set), then each most-recent NON-autosave path;
        the first that exists wins. Autosaves are NEVER auto-selected
        (offered only as a labelled recovery option in the dropdown), so
        they never become the resolved path. None when no non-autosave
        path exists (Open then shows the picker).
      - warning: the resolved path is a FALLBACK — the top preference (the
        pinned default, else the most-recent non-autosave) was missing, so
        a lower path was used. Drives the card's warning marker.
      - missing: NONE of the entry's paths exist at all (incl. autosaves);
        the entry is fully unopenable (greyed 'File not found' card, §2.1).
    """
    preferred = []
    if pinned_default_path:
        preferred.append(pinned_default_path)
    for p in ordered_paths:
        if p.get("is_autosave"):
            continue
        if p["path"] == pinned_default_path:
            continue
        preferred.append(p["path"])
    exists_map = {p["path"]: bool(p.get("exists")) for p in ordered_paths}
    resolved = next((c for c in preferred if exists_map.get(c)), None)
    warning = resolved is not None and bool(preferred) and resolved != preferred[0]
    missing = not any(p.get("exists") for p in ordered_paths)
    return {"resolved_path": resolved, "warning": warning, "missing": missing}


def path_status(entry) -> dict:
    """Existence + resolution for one library entry's paths — the backing
    for a project card's Open button + path dropdown (design doc §2.2).

    Does the real filesystem checks (existence + last-modified), then
    delegates the choice to the pure `_resolve_from`. Returns:
      - paths: the entry's EXISTING paths, most-recent-first, each
        `{path, last_modified, is_autosave}` (the dropdown list).
      - resolved_path / warning / missing: see `_resolve_from`.
    """
    ordered = []
    existing = []
    for p in entry.paths:
        exists = _path_exists(p.path)
        ordered.append({"path": p.path, "is_autosave": p.is_autosave, "exists": exists})
        if exists:
            try:
                mtime = Path(p.path).stat().st_mtime
            except Exception:
                mtime = None
            existing.append({"path": p.path, "last_modified": mtime, "is_autosave": p.is_autosave})
    result = _resolve_from(entry.pinned_default_path, ordered)
    result["paths"] = existing
    return result


# ── Library actions (Phase 5.5b) ────────────────────────────────────────

def set_favourite(story_id: str, value: bool) -> bool:
    """Set the favourite flag on a library entry (the Favourites shelf
    membership is derived from this flag). Returns False when there is no
    such entry."""
    index = read_index()
    entry = index.entries.get(story_id)
    if entry is None:
        return False
    entry.favourite = bool(value)
    write_index(index)
    return True


def set_hidden(story_id: str, value: bool) -> bool:
    """Set the hidden flag on a library entry (hidden drops the story from
    every view except the Hidden section, design doc §6). Reversible.
    Returns False when there is no such entry."""
    index = read_index()
    entry = index.entries.get(story_id)
    if entry is None:
        return False
    entry.hidden = bool(value)
    write_index(index)
    return True


def add_path(story_id: str, path: str) -> bool:
    """Add a known on-disk path to an existing entry (Phase 5.6a 'Locate' —
    the user pointed the entry at a moved / found `.nnz`). Inserts the path
    as the freshest non-autosave path if absent, else just refreshes its
    timestamp so it resolves first. Returns False when there is no such
    entry. The caller is responsible for confirming the picked file's story
    id matches `story_id` before calling this."""
    import time
    from models.library import LibraryPathEntry
    index = read_index()
    entry = index.entries.get(story_id)
    if entry is None:
        return False
    existing = next((p for p in entry.paths if p.path == path), None)
    if existing is not None:
        existing.last_accessed = time.time()
    else:
        entry.paths.insert(0, LibraryPathEntry(path=path, last_accessed=time.time(), is_autosave=False))
    write_index(index)
    return True


def remove_entry(story_id: str) -> bool:
    """Remove a story from the library (design doc §6 'Remove from
    library'): purge its index entry + cached cover, and strip its id from
    every shelf's membership / order in the layout. The `.nnz` file is NOT
    touched. Idempotent — stale layout refs / a leftover cover are cleaned
    even if the index entry is already gone. Returns True if an index entry
    was actually removed."""
    index = read_index()
    removed = story_id in index.entries
    if removed:
        del index.entries[story_id]
        write_index(index)

    # Cached cover copy.
    try:
        (assets_dir() / f"{story_id}.jpg").unlink(missing_ok=True)
    except Exception:
        pass

    # Strip from every shelf's explicit membership + manual-order hints.
    try:
        layout = read_layout()
        changed = False
        for shelf in layout.shelves:
            if story_id in shelf.story_ids:
                shelf.story_ids = [s for s in shelf.story_ids if s != story_id]
                changed = True
            if story_id in shelf.order:
                shelf.order = [s for s in shelf.order if s != story_id]
                changed = True
        if changed:
            write_layout(layout)
    except Exception:
        pass

    return removed


def cleanup_missing() -> dict:
    """Phase 5.6a 'Cleanup Library': re-check every entry's known paths
    against disk (a fresh existence scan, not the cached missing-state),
    strip every path that no longer exists, and remove any entry left with
    zero existing paths (its index entry + cached cover + shelf memberships
    purged, exactly like a manual Remove). The `.nnz` files are never
    touched. Returns {paths_stripped, entries_removed}."""
    index = read_index()
    paths_stripped = 0
    zero_path_ids = []
    for uid, entry in index.entries.items():
        kept = [p for p in entry.paths if Path(p.path).exists()]
        paths_stripped += len(entry.paths) - len(kept)
        entry.paths = kept
        # A pinned default that no longer exists on disk is cleared.
        if entry.pinned_default_path and not any(p.path == entry.pinned_default_path for p in kept):
            entry.pinned_default_path = None
        if not kept:
            zero_path_ids.append(uid)
    write_index(index)
    # Zero-path entries are removed exactly like a manual Remove (entry +
    # cached cover + shelf memberships); the .nnz files are already gone.
    for uid in zero_path_ids:
        remove_entry(uid)
    return {"paths_stripped": paths_stripped, "entries_removed": len(zero_path_ids)}
