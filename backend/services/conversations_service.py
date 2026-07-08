"""Conversation storage service — Phase 2.6 layout.

Threads are now organised on disk by the story they belong to:

    preferences/conversations/
    ├── untitled/                              # shared "Untitled" bucket
    │   └── {thread-slug}__{thread-id}.json
    ├── {story-slug}--{story-uuid-short}/      # one folder per story
    │   ├── category.json                      # { story_id, name }
    │   └── {thread-slug}__{thread-id}.json
    └── {story-slug}--{story-uuid-short}/
        └── ...

The slug portions of the folder + file names are decorative (human
readability for writers browsing on disk). Canonical identifiers are
the UUIDs: `story_id` on the conversation drives the folder choice,
`thread_id` drives the filename. A `category.json` sidecar inside
each story folder records `{ story_id, name }` so the program can
map folder → story without parsing the folder name.

**Lazy folder creation**: folders are created only on first thread
save against a given story_id. Loading a project doesn't create a
folder — opening a project, browsing canvas, closing without
chatting → no subfolder appears.

**Pre-migration compatibility**: thread files written in the
pre-2.6 flat layout (`preferences/conversations/{id}.json`) are
still readable through `lookup_thread_path` and `walk_all_threads`.
The next save of such a thread routes it into the new per-story
folder and removes the flat file — incremental migration without
needing a bulk script. The bulk script (Phase 2.6h) handles the
remaining untouched threads in one pass.

**Persisted `index.json` perf cache**: a single file at
`conversations/index.json` carries the in-memory thread index so
`list_index()` doesn't walk every thread file on every browser
refresh. The file is loaded lazily on first access and
sanity-checked against the on-disk file count; if it's missing,
malformed, or fails sanity it gets rebuilt by walking
`walk_all_threads()` once. Mutations (create / delete / open /
name change / tags change / story_id stamp) write the index back
atomically via a temp-file + rename pattern. The index is NOT
written on per-message or per-token writes; that staleness is
accepted and self-heals the next time the writer opens the
affected thread.
"""
import json
import os
import re
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, List, Optional, Tuple

from models.conversation import (
    Conversation,
    ConversationIndexEntry,
    ConversationIndexFile,
    ConversationMessage,
)


_BASE_DIR = Path(__file__).resolve().parent.parent.parent / "conversations"

# ── Layout constants ────────────────────────────────────────────────────────

_THREAD_FILE_SUFFIX = ".json"
_THREAD_FILENAME_DELIM = "__"  # boundary between slug and uuid in the filename
_CATEGORY_SIDECAR_NAME = "category.json"
_UNTITLED_FOLDER_NAME = "untitled"
_INDEX_FILENAME = "index.json"
# Tolerance (seconds) for the startup sanity check: when comparing
# an index entry's `updated_at` against the actual file mtime, a
# drift up to this size is acceptable (different timezones, slow
# clocks, etc.). Anything beyond → rebuild from disk.
_INDEX_SANITY_MTIME_TOLERANCE_S = 5.0
# Number of random index entries spot-checked against file mtimes
# at startup. Full N-entry check would be O(N) disk stats; the
# sample is bounded so startup stays cheap on huge libraries.
_INDEX_SANITY_SAMPLE_SIZE = 8
# Soft caps on slug length per the planning doc — never truncate the
# UUID portion. Folder UUID-suffix is 8 chars + "--" delimiter = 10
# chars reserved; thread filename UUID is 36 chars + "__" + ".json" =
# 43 chars reserved. The caps leave plenty of headroom under
# Windows MAX_PATH for the combined path.
_FOLDER_SLUG_SOFT_CAP = 100
_FILE_SLUG_SOFT_CAP = 200

# Soft cap on the preview text the thread index returns per
# entry. Keeps the index response small even when individual
# messages are long.
_PREVIEW_CHAR_LIMIT = 120


# ── Generic helpers ─────────────────────────────────────────────────────────


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _preview(content: str) -> str:
    """Single-line truncated render suitable for the thread browser
    entry. Newlines collapsed to spaces; long content truncated
    with an ellipsis."""
    if not content:
        return ""
    one_line = " ".join(content.split())
    if len(one_line) <= _PREVIEW_CHAR_LIMIT:
        return one_line
    return one_line[: _PREVIEW_CHAR_LIMIT - 1].rstrip() + "…"


def _slugify(text: Optional[str]) -> str:
    """Lower-case, replace non-alphanumeric runs with dashes, trim
    leading / trailing dashes. Empty / None input → empty string.
    Used for the human-readable portion of folder names and thread
    filenames; the canonical UUID portion is what actually identifies
    the object."""
    if not text:
        return ""
    s = str(text).lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s


# ── Folder routing helpers ──────────────────────────────────────────────────


def resolve_story_folder_path(
    story_id: Optional[str],
    story_title: Optional[str],
) -> Path:
    """Canonical folder path for `story_id` given a current title.

    `story_id = None` → the shared `untitled/` folder. Threads with
    no project loaded at creation time, plus threads whose story
    isn't currently loaded, both land here.

    Otherwise: `{slug}--{first-8-of-story-uuid}`. Slug truncated to
    `_FOLDER_SLUG_SOFT_CAP` chars; UUID portion never truncated.
    If the title is empty/None, the slug part is omitted and the
    folder is just the UUID prefix.

    Does NOT create the directory on disk — callers do that lazily
    on first thread save.
    """
    if not story_id:
        return _BASE_DIR / _UNTITLED_FOLDER_NAME
    slug = _slugify(story_title)
    if len(slug) > _FOLDER_SLUG_SOFT_CAP:
        slug = slug[:_FOLDER_SLUG_SOFT_CAP].rstrip("-")
    suffix = story_id[:8]
    name = f"{slug}--{suffix}" if slug else suffix
    return _BASE_DIR / name


def compute_thread_filename(
    thread_id: str,
    thread_name: Optional[str],
) -> str:
    """Canonical filename for a thread: `{slug}__{uuid}.json`.

    Slug from `thread_name`, truncated to `_FILE_SLUG_SOFT_CAP`.
    UUID portion never truncated. Empty slug → omitted (filename is
    just `{uuid}.json`). The delimiter `__` doesn't appear in
    slugified text (single dashes only) or in UUIDs (which use `-`
    at fixed positions and no `_` at all), so parsing the filename
    back into (slug, uuid) is unambiguous.
    """
    slug = _slugify(thread_name)
    if len(slug) > _FILE_SLUG_SOFT_CAP:
        slug = slug[:_FILE_SLUG_SOFT_CAP].rstrip("-")
    if not slug:
        return f"{thread_id}{_THREAD_FILE_SUFFIX}"
    return f"{slug}{_THREAD_FILENAME_DELIM}{thread_id}{_THREAD_FILE_SUFFIX}"


def _read_sidecar(folder: Path) -> Optional[dict]:
    """Read `{folder}/category.json` if it exists. Returns the parsed
    dict, or None on missing / unparseable file."""
    sidecar = folder / _CATEGORY_SIDECAR_NAME
    if not sidecar.exists():
        return None
    try:
        data = json.loads(sidecar.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    return data


def _write_sidecar(folder: Path, story_id: str, name: str) -> None:
    """Write `{folder}/category.json` with `{ story_id, name }`.
    Always overwrites — callers update the name on story rename
    via this same helper."""
    folder.mkdir(parents=True, exist_ok=True)
    sidecar = folder / _CATEGORY_SIDECAR_NAME
    payload = {"story_id": story_id, "name": name or ""}
    sidecar.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _iter_story_folders() -> Iterator[Path]:
    """Every direct subdirectory of `_BASE_DIR`. Yields the special
    `untitled/` folder too when present."""
    if not _BASE_DIR.exists():
        return
    for entry in _BASE_DIR.iterdir():
        if entry.is_dir():
            yield entry


def _find_folder_by_story_id(story_id: Optional[str]) -> Optional[Path]:
    """Look up the existing on-disk folder for `story_id` by scanning
    sidecars. Returns None if no folder for this story_id exists.

    `story_id = None` returns the `untitled/` folder if it exists.

    Used by `lookup_thread_path` (when the caller knows the story id),
    by `save_conversation` (to detect whether the folder needs
    creating + sidecar writing), and by `rename_story_folder` (which
    needs the current folder before moving it).
    """
    if not story_id:
        path = _BASE_DIR / _UNTITLED_FOLDER_NAME
        return path if path.exists() else None
    for folder in _iter_story_folders():
        sidecar = _read_sidecar(folder)
        if sidecar and sidecar.get("story_id") == story_id:
            return folder
    return None


def lookup_thread_path(
    thread_id: str,
    story_id: Optional[str] = None,
) -> Optional[Path]:
    """Find the file on disk for `thread_id`.

    When `story_id` is supplied, the search is narrowed to the
    matching story folder (resolved via sidecar). When omitted, every
    story folder is scanned plus the legacy flat-layout root.

    Matches in two passes per folder:
      1. `*__{thread_id}.json` — the current Phase-2.6 filename
         shape with a slug prefix.
      2. `{thread_id}.json` — the pre-2.6 flat filename. Pre-
         migration thread files written by the old code stay
         readable via this fallback; the next save of any such
         thread routes it into the new layout.
    """
    folders: List[Path] = []
    if story_id is not None:
        target = _find_folder_by_story_id(story_id)
        if target is not None:
            folders.append(target)
    else:
        folders.extend(_iter_story_folders())
        if _BASE_DIR.exists():
            folders.append(_BASE_DIR)  # legacy flat layout

    for folder in folders:
        if not folder.exists():
            continue
        # New-layout filename: `*__{thread_id}.json`
        matches = list(folder.glob(f"*{_THREAD_FILENAME_DELIM}{thread_id}{_THREAD_FILE_SUFFIX}"))
        if matches:
            return matches[0]
        # Legacy flat-layout filename: `{thread_id}.json`
        legacy = folder / f"{thread_id}{_THREAD_FILE_SUFFIX}"
        if legacy.exists():
            return legacy
    return None


def rename_story_folder(story_id: str, new_title: str) -> Optional[Path]:
    """Rename the folder for `story_id` to reflect a new story title.

    Per the planning doc's "rename-existing-only" rule: if no folder
    for this `story_id` exists yet on disk, this is a no-op (the
    folder gets created at the new slug whenever the first thread
    for that story is eventually saved). Returns the new folder
    path on success, None on no-op.

    The UUID-suffix portion of the folder name is preserved; only
    the slug portion changes. The `category.json` sidecar's `name`
    field is updated in the same call so the program's source of
    truth stays consistent.
    """
    current = _find_folder_by_story_id(story_id)
    if current is None:
        return None
    desired = resolve_story_folder_path(story_id, new_title)
    if desired == current:
        # Slug already matches — just refresh the sidecar in case the
        # title's punctuation or casing changed (sidecar carries the
        # original-cased name, not the slug).
        _write_sidecar(current, story_id, new_title or "")
        return current
    # Move the folder, then update the sidecar inside the new
    # location. shutil.move handles cross-filesystem cases that
    # Path.rename can't; on the same filesystem it's a rename.
    desired.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(current), str(desired))
    _write_sidecar(desired, story_id, new_title or "")
    # Sync the persisted index's categories map so the browser's
    # tab strip displays the new title without re-walking the
    # sidecars on disk. Best-effort.
    try:
        _set_index_category(story_id, new_title or "")
    except Exception:
        pass
    return desired


# ── Persisted index (`conversations/index.json`) ────────────────────────────


def _index_path() -> Path:
    return _BASE_DIR / _INDEX_FILENAME


# Module-level in-memory cache. Populated lazily on first access (or
# explicit reload), kept in sync by every write site. Mutations hold
# `_index_lock` so concurrent endpoints serialise their updates.
_index_cache: Optional[ConversationIndexFile] = None
_index_lock = threading.Lock()


def _build_index_entry_from_data(data: dict, file_path: Path) -> Optional[ConversationIndexEntry]:
    """Build one `ConversationIndexEntry` from the parsed contents of
    a thread file. Returns None on validation failure so the caller
    can skip the malformed file rather than abort the whole walk."""
    if not isinstance(data, dict):
        return None
    messages = data.get("messages") or []
    last_preview: Optional[str] = None
    if messages and isinstance(messages, list):
        last = messages[-1] if isinstance(messages[-1], dict) else None
        if last:
            last_preview = _preview(last.get("content") or "")
    try:
        return ConversationIndexEntry(
            id=str(data.get("id") or file_path.stem.rsplit(_THREAD_FILENAME_DELIM, 1)[-1]),
            name=str(data.get("name") or "Untitled"),
            created_at=str(data.get("created_at") or ""),
            updated_at=str(data.get("updated_at") or ""),
            message_count=len(messages) if isinstance(messages, list) else 0,
            last_message_preview=last_preview,
            profile_id=data.get("profile_id"),
            model=data.get("model"),
            pinned_in_browser=bool(data.get("pinned_in_browser") or False),
            story_id=data.get("story_id"),
            story_title=data.get("story_title"),
            tags=list(data.get("tags") or []),
            colour=data.get("colour"),
            # Phase 2.11b — mirror `character_chat is not None` into the
            # index so the thread browser can render the 🎭 badge
            # without loading every thread file.
            is_character_chat=bool(data.get("character_chat") is not None),
            # Phase 2.12 — mirror `two_character_chat is not None` into
            # the index so the thread browser can render the 🎭⇆🎭
            # badge without loading every thread file. Mutually
            # exclusive with `is_character_chat` on a per-row basis.
            is_two_character_chat=bool(data.get("two_character_chat") is not None),
        )
    except Exception:
        return None


def _rebuild_index_from_disk() -> ConversationIndexFile:
    """Walk every thread file on disk + every sidecar, build a fresh
    `ConversationIndexFile`. Used at startup when no index file
    exists, when the index fails its sanity check, and by the
    "Rebuild thread index" recovery action.

    Walks `walk_all_threads()` (which already handles the per-story
    folders + legacy flat root + cross-layout de-duplication) for
    entries, plus `_iter_story_folders()` for the categories map.
    """
    entries: List[ConversationIndexEntry] = []
    for f in walk_all_threads():
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        entry = _build_index_entry_from_data(data, f)
        if entry is not None:
            entries.append(entry)
    # Phase 3.10 — drop categories that no longer have any thread
    # entries. The previous behaviour kept sidecar-derived categories
    # even when the folder had been emptied (e.g. by a cancelled NC
    # import that cleaned up its own threads), which left ghost
    # entries in the thread-browser's category dropdown. Disk truth:
    # if there are zero threads for a story_id, the writer shouldn't
    # see that story_id as a selectable category.
    sids_with_entries = {
        str(e.story_id) for e in entries if e.story_id
    }
    categories: dict = {}
    for folder in _iter_story_folders():
        sidecar = _read_sidecar(folder)
        if sidecar:
            sid = sidecar.get("story_id")
            name = sidecar.get("name") or ""
            if sid and str(sid) in sids_with_entries:
                categories[str(sid)] = str(name)
    return ConversationIndexFile(categories=categories, entries=entries)


def _write_index_atomic(index: ConversationIndexFile) -> None:
    """Persist `index` to `conversations/index.json` via write-temp +
    rename. The rename is atomic at the OS level on every supported
    platform (POSIX rename(), Windows MoveFileEx) so a crash mid-
    write can't leave a half-written index — readers either see the
    prior file or the new file, never a torn one.
    """
    _BASE_DIR.mkdir(parents=True, exist_ok=True)
    target = _index_path()
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(index.model_dump_json(indent=2), encoding="utf-8")
    # Atomic replace. `Path.replace` is `os.replace` under the hood,
    # which overwrites the target on Windows (unlike `Path.rename`).
    tmp.replace(target)


def _load_index_from_disk() -> Optional[ConversationIndexFile]:
    """Read `index.json` if it exists and parses. Returns None on
    missing / unparseable / model-validation failure — caller falls
    back to a rebuild in that case."""
    path = _index_path()
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    try:
        return ConversationIndexFile(**data)
    except Exception:
        return None


def _index_passes_sanity(index: ConversationIndexFile) -> bool:
    """Spot-check the loaded index against the on-disk thread files.

    Two cheap checks per the planning doc:
      1. Entry count vs file count must match (one entry per
         thread file).
      2. For up to `_INDEX_SANITY_SAMPLE_SIZE` random entries,
         verify the corresponding file exists and its mtime is
         within `_INDEX_SANITY_MTIME_TOLERANCE_S` of the entry's
         `updated_at`. Hand-edits / restore-from-backup / external
         tooling that touched the disk would drive these out of
         agreement.

    Returns False on any mismatch → caller falls back to a full
    rebuild via `_rebuild_index_from_disk`.
    """
    on_disk = list(walk_all_threads())
    if len(on_disk) != len(index.entries):
        return False
    if not index.entries:
        return True  # empty index, empty disk, all good

    import random
    sample = random.sample(
        index.entries,
        min(_INDEX_SANITY_SAMPLE_SIZE, len(index.entries)),
    )
    for entry in sample:
        path = lookup_thread_path(entry.id, story_id=entry.story_id)
        if path is None or not path.exists():
            return False
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return False
        # Parse entry.updated_at; if unparseable, accept the sample
        # (the field was hand-edited or pre-dates iso-formatting and
        # we don't want a sanity-check to thrash on it).
        try:
            entry_dt = datetime.strptime(
                entry.updated_at.rstrip("Z"), "%Y-%m-%dT%H:%M:%S.%f",
            ).replace(tzinfo=timezone.utc)
        except Exception:
            continue
        entry_ts = entry_dt.timestamp()
        if abs(mtime - entry_ts) > _INDEX_SANITY_MTIME_TOLERANCE_S:
            return False
    return True


def _ensure_index_loaded() -> ConversationIndexFile:
    """Lazy initialiser for the module-level in-memory cache. First
    call loads from disk, sanity-checks, falls back to a rebuild if
    sanity fails. Subsequent calls return the cached value. Holds
    `_index_lock` so concurrent first-access doesn't double-rebuild.
    """
    global _index_cache
    if _index_cache is not None:
        return _index_cache
    with _index_lock:
        if _index_cache is not None:
            return _index_cache
        loaded = _load_index_from_disk()
        if loaded is None or not _index_passes_sanity(loaded):
            loaded = _rebuild_index_from_disk()
            try:
                _write_index_atomic(loaded)
            except OSError:
                # Disk write failed (permissions, full disk, etc.).
                # The in-memory cache is still good for this session;
                # next launch will rebuild again.
                pass
        _index_cache = loaded
        return _index_cache


def _upsert_index_entry(entry: ConversationIndexEntry) -> None:
    """Add or replace `entry` in the in-memory index and persist.
    Idempotent; safe to call when the entry already matches the
    current state. Locks the cache for the read-modify-write."""
    with _index_lock:
        index = _ensure_index_loaded_unlocked()
        existing_idx = next(
            (i for i, e in enumerate(index.entries) if e.id == entry.id),
            None,
        )
        if existing_idx is None:
            index.entries.append(entry)
        else:
            index.entries[existing_idx] = entry
        try:
            _write_index_atomic(index)
        except OSError:
            pass


def _remove_index_entry(thread_id: str) -> None:
    """Drop the entry for `thread_id` from the in-memory index and
    persist. No-op when the entry isn't present."""
    with _index_lock:
        index = _ensure_index_loaded_unlocked()
        before = len(index.entries)
        index.entries = [e for e in index.entries if e.id != thread_id]
        if len(index.entries) == before:
            return
        try:
            _write_index_atomic(index)
        except OSError:
            pass


def _set_index_category(story_id: str, name: str) -> None:
    """Update the `categories` map entry for `story_id`. Used on
    first-thread-save against a new story, story rename, etc."""
    with _index_lock:
        index = _ensure_index_loaded_unlocked()
        if index.categories.get(story_id) == name:
            return
        index.categories[story_id] = name
        try:
            _write_index_atomic(index)
        except OSError:
            pass


def _ensure_index_loaded_unlocked() -> ConversationIndexFile:
    """Internal helper: like `_ensure_index_loaded` but assumes the
    caller already holds `_index_lock`. Used by the mutation helpers
    above which need to hold the lock across their read-modify-write
    sequence."""
    global _index_cache
    if _index_cache is None:
        loaded = _load_index_from_disk()
        if loaded is None or not _index_passes_sanity(loaded):
            loaded = _rebuild_index_from_disk()
            try:
                _write_index_atomic(loaded)
            except OSError:
                pass
        _index_cache = loaded
    return _index_cache


def rebuild_index() -> ConversationIndexFile:
    """Public recovery entry point: force a full rebuild from disk
    and replace the in-memory cache. Returns the new index. Wired
    to a frontend "Rebuild thread index" button in a sibling commit.
    """
    global _index_cache
    rebuilt = _rebuild_index_from_disk()
    with _index_lock:
        _index_cache = rebuilt
        try:
            _write_index_atomic(rebuilt)
        except OSError:
            pass
    return rebuilt


def walk_all_threads() -> Iterator[Path]:
    """Yield every thread file on disk under `_BASE_DIR`, across
    every per-story folder + the legacy flat root. Used by
    `list_index`, `search_threads`, and (later) the index-rebuild
    recovery action.

    De-duplicates by `thread_id` across the two layouts: if a thread
    exists in both a per-story folder AND at the legacy flat path
    (a transient state during incremental migration), the per-story
    copy wins and the flat copy is suppressed from the yield. This
    keeps `list_index` from showing the same thread twice and
    `search_threads` from double-counting matches.
    """
    if not _BASE_DIR.exists():
        return
    seen_ids: set[str] = set()
    # Per-story folders first — those are the canonical location.
    for folder in _iter_story_folders():
        for f in folder.iterdir():
            if not f.is_file():
                continue
            if f.name == _CATEGORY_SIDECAR_NAME:
                continue
            if not f.name.endswith(_THREAD_FILE_SUFFIX):
                continue
            stem = f.stem  # filename without `.json`
            # Extract the UUID portion of `{slug}__{uuid}` or the
            # bare uuid filename. Track it so the legacy-layout
            # pass below can skip duplicates.
            tid = stem.rsplit(_THREAD_FILENAME_DELIM, 1)[-1]
            if tid:
                seen_ids.add(tid)
            yield f
    # Legacy flat-layout files at the root (pre-2.6)
    for f in _BASE_DIR.iterdir():
        if not f.is_file():
            continue
        if not f.name.endswith(_THREAD_FILE_SUFFIX):
            continue
        stem = f.stem
        # Index.json and any future top-level helper files don't
        # belong to a thread. Skip anything that doesn't parse as a
        # bare uuid filename (the only legitimate flat-layout shape).
        if _THREAD_FILENAME_DELIM in stem:
            continue
        if "index" in stem.lower():
            continue
        # De-dup: a thread that already showed up in a per-story
        # folder shouldn't appear again from the flat root.
        if stem in seen_ids:
            continue
        yield f


# ── Active-story title resolution ───────────────────────────────────────────


def _active_story_title_for(story_id: Optional[str]) -> Optional[str]:
    """Resolve a display title for `story_id` from whichever sources
    we have access to: the loaded story (if its id matches), or the
    existing sidecar for that folder. Returns None when there's no
    match and the caller needs to supply a title itself."""
    if not story_id:
        return None
    try:
        import state  # local import — keeps the service decoupled at module init
        story = state.get_story()
        if story is not None and getattr(story, "id", None) == story_id:
            return getattr(story, "title", None)
    except Exception:
        pass
    existing = _find_folder_by_story_id(story_id)
    if existing is not None:
        sidecar = _read_sidecar(existing)
        if sidecar:
            n = sidecar.get("name")
            if isinstance(n, str) and n:
                return n
    return None


# ── CRUD operations ─────────────────────────────────────────────────────────


def _save_thread_file(
    thread: Conversation,
    story_title: Optional[str],
    *,
    preserve_updated_at: bool = False,
) -> Tuple[Path, Conversation]:
    """Write `thread` to its canonical Phase-2.6 location. Creates
    the per-story folder + sidecar on first save against that
    story. Returns `(new_path, updated_thread)`. The caller is
    responsible for any cleanup of the OLD file location (legacy
    flat layout, stale slug after rename) — see `save_conversation`.

    `preserve_updated_at` (Phase 3.9): when True, skip the
    auto-stamp of `updated_at`. The NC-chat import path uses this
    so the caller-supplied filename-derived timestamp survives the
    save (without it, the import-time `now_iso` would clobber the
    real chat date and the thread browser would show every imported
    thread as "1m ago"). Normal saves keep auto-stamping so the
    index sorts most-recent first.
    """
    folder = resolve_story_folder_path(thread.story_id, story_title)
    # Lazy folder creation — sidecar only written for real story
    # folders. The untitled bucket gets no sidecar (story_id is
    # nil so the file would be meaningless).
    if not folder.exists():
        folder.mkdir(parents=True, exist_ok=True)
        if thread.story_id:
            _write_sidecar(folder, thread.story_id, story_title or "")
    elif thread.story_id and not (folder / _CATEGORY_SIDECAR_NAME).exists():
        # Folder existed (e.g. created in a prior crash window) but
        # the sidecar is missing — write it now so the program's
        # canonical source of truth is restored.
        _write_sidecar(folder, thread.story_id, story_title or "")

    new_filename = compute_thread_filename(thread.id, thread.name)
    new_path = folder / new_filename

    # Stamp `updated_at` so the index sorts most-recent first.
    # Also snapshot the current story title onto the thread when
    # available — used by the browser's character-chat story-mismatch
    # gate to name the owning project without having to look it up
    # via the categories map (which may be stale or missing for
    # foreign-project threads). Phase 2.11b.
    patch = {}
    if not preserve_updated_at:
        patch["updated_at"] = _utcnow_iso()
    if story_title:
        patch["story_title"] = story_title
    if patch:
        thread = thread.model_copy(update=patch)
    new_path.write_text(thread.model_dump_json(indent=2), encoding="utf-8")
    return new_path, thread


def save_conversation(
    thread: Conversation,
    *,
    story_title: Optional[str] = None,
    preserve_updated_at: bool = False,
) -> Conversation:
    """Persist `thread` to disk in the canonical Phase-2.6 layout.

    `story_title` is the human-readable name used to build the
    folder slug + the sidecar `name`. The caller (router) typically
    passes `state.get_story().title` when the loaded story matches
    `thread.story_id`. When omitted, the service resolves a title
    from the loaded story or the existing sidecar; if neither has
    one, the folder gets just the UUID suffix.

    Side effects:
      - Creates the per-story folder + sidecar lazily on first save.
      - Renames the thread file if the slug-portion is now stale
        (writer renamed the thread).
      - Removes any pre-2.6 flat-layout copy of the same thread.
      - Removes the old file when a thread moves between folders
        (e.g. the writer linked it to a different story manually —
        not a current UI feature, but supported as a side effect of
        editing `story_id` directly).
    """
    if story_title is None:
        story_title = _active_story_title_for(thread.story_id)

    # Locate any prior on-disk file for this thread BEFORE writing
    # the new one — we'll clean it up after to keep on-disk identity
    # exactly one file per thread.
    prior_path = lookup_thread_path(thread.id)

    new_path, updated = _save_thread_file(
        thread, story_title, preserve_updated_at=preserve_updated_at,
    )

    if prior_path and prior_path != new_path and prior_path.exists():
        try:
            prior_path.unlink()
        except OSError:
            # Best-effort cleanup; a dangling old file won't
            # corrupt anything (lookup_thread_path returns the
            # first match; new locations sort earlier by virtue of
            # being inside a story folder).
            pass

    # Maintain the persisted index. Upsert the entry so subsequent
    # `list_index()` calls see the current name / tags / preview
    # without re-reading the file. Refresh the categories map when
    # this save introduces a new story_id or updates an existing
    # one's name. Best-effort — index write failures don't fail
    # the save itself (the thread file is already on disk).
    try:
        entry = ConversationIndexEntry(
            id=updated.id,
            name=updated.name,
            created_at=updated.created_at,
            updated_at=updated.updated_at,
            message_count=len(updated.messages),
            last_message_preview=_preview(
                updated.messages[-1].content if updated.messages else ""
            ),
            profile_id=updated.profile_id,
            model=updated.model,
            pinned_in_browser=updated.pinned_in_browser,
            story_id=updated.story_id,
            story_title=updated.story_title,
            tags=list(updated.tags or []),
            colour=updated.colour,
            is_character_chat=updated.character_chat is not None,
            is_two_character_chat=updated.two_character_chat is not None,
        )
        _upsert_index_entry(entry)
        if updated.story_id and story_title:
            _set_index_category(updated.story_id, story_title)
    except Exception:
        pass

    return updated


def delete_conversation(thread_id: str) -> bool:
    """Remove the on-disk file for `thread_id` (whichever folder /
    layout it currently lives in). Returns False when no file was
    found."""
    path = lookup_thread_path(thread_id)
    if path is None or not path.exists():
        return False
    path.unlink()
    # Drop the matching entry from the persisted index too — best-
    # effort, doesn't fail the delete if the index write hiccups.
    try:
        _remove_index_entry(thread_id)
    except Exception:
        pass
    return True


def get_conversation(thread_id: str) -> Optional[Conversation]:
    """Load the full thread for `thread_id` from wherever it lives
    (per-story folder OR legacy flat root). Returns None if no
    file exists or parsing fails."""
    path = lookup_thread_path(thread_id)
    if path is None or not path.exists():
        return None
    try:
        return Conversation(**json.loads(path.read_text(encoding="utf-8")))
    except Exception:
        return None


def append_message(thread_id: str, message: ConversationMessage) -> Optional[Conversation]:
    """Append `message` to the thread's `messages` list and
    persist. Returns the updated `Conversation`, or None if the
    thread doesn't exist. Caller is responsible for assigning the
    `message.id` and `message.timestamp` — we don't backfill them
    server-side so the frontend's optimistic copy and the on-disk
    copy can share identity."""
    thread = get_conversation(thread_id)
    if thread is None:
        return None
    thread.messages.append(message)
    return save_conversation(thread)


def update_message(thread_id: str, message_id: str, patch: dict) -> Optional[Conversation]:
    """Apply `patch` to the message with id `message_id`. Returns
    the updated thread or None if either the thread or the
    message doesn't exist. Only fields that exist on
    `ConversationMessage` are accepted; the message id itself
    isn't editable."""
    thread = get_conversation(thread_id)
    if thread is None:
        return None
    for idx, msg in enumerate(thread.messages):
        if msg.id == message_id:
            data = msg.model_dump()
            for k, v in patch.items():
                if k == "id":
                    continue
                data[k] = v
            try:
                thread.messages[idx] = ConversationMessage(**data)
            except Exception:
                return None
            return save_conversation(thread)
    return None


def delete_message(thread_id: str, message_id: str) -> Optional[Conversation]:
    thread = get_conversation(thread_id)
    if thread is None:
        return None
    before = len(thread.messages)
    thread.messages = [m for m in thread.messages if m.id != message_id]
    if len(thread.messages) == before:
        return None
    return save_conversation(thread)


# ── Index + search ──────────────────────────────────────────────────────────


def list_index() -> List[ConversationIndexEntry]:
    """Lightweight metadata listing for the thread browser. Reads
    from the in-memory `_index_cache` (lazily loaded from
    `conversations/index.json` on first access; rebuilt from disk
    on a sanity-check failure). Returns entries sorted by
    `updated_at` descending so the most recently active threads
    land at the top of the browser.

    O(N) over the cached entry list — no disk I/O in the steady
    state. The cache is kept in sync by every save / delete /
    rename mutation in this module."""
    index = _ensure_index_loaded()
    return sorted(list(index.entries), key=lambda e: e.updated_at, reverse=True)


def list_categories_map() -> dict:
    """Return the persisted `story_id → display_name` map from the
    cached index. Used by the thread browser to label per-story
    tabs without walking the per-folder `category.json` sidecars
    on every render."""
    index = _ensure_index_loaded()
    return dict(index.categories)


def search_threads(query: str, category_id: Optional[str] = None) -> List[dict]:
    """Count case-insensitive substring matches of `query` across
    every message's content in every thread file. Returns
    `[{ id, match_count }, ...]` ordered by `updated_at` descending.

    `category_id` is accepted for back-compat with the conversations
    router but ignored — categories have been replaced by tags in
    Phase 2.6. The router stops passing it once Phase 2.6e finishes
    the thread browser cutover.
    """
    if not query or not query.strip():
        return []
    needle = query.lower()
    _ = category_id  # accepted for back-compat; categories are gone
    hits: List[dict] = []
    for f in walk_all_threads():
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        count = 0
        for msg in (data.get("messages") or []):
            if not isinstance(msg, dict):
                continue
            content = msg.get("content")
            if isinstance(content, str) and content:
                # `str.count` is fast enough at this scale that we
                # don't need a more sophisticated indexer; running
                # over every saved message on every keystroke is
                # already well under a millisecond per thread on a
                # typical machine.
                count += content.lower().count(needle)
        if count > 0:
            hits.append({
                "id": str(data.get("id") or f.stem.split(_THREAD_FILENAME_DELIM)[-1]),
                "match_count": count,
                "updated_at": str(data.get("updated_at") or ""),
            })
    hits.sort(key=lambda h: h.get("updated_at") or "", reverse=True)
    return hits
