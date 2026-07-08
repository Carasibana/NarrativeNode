"""Phase 2.8 / 3.4c — Context Cues storage.

Folder-based layout at repo root:

    context_cues/
    ├── index.json                              # `{version, order, entries}` perf cache (Phase 3.4c)
    ├── {slug}__{cue-id}.json                   # one file per cue
    ├── {slug}__{cue-id}.json
    └── ...

Each cue file contains the bare ``ContextCue`` shape (no envelope), so
the file IS the cue. ``index.json`` (Phase 3.4c — replaces the
pre-3.4c ``order.json``) carries:

    - ``order``: the writer's chosen library layout (cue-id strings
      interleaved with ``{type:'divider', id, title}`` objects).
    - ``entries``: a per-cue metadata cache mirroring the
      ``conversations/index.json`` shape — id / name / tags /
      favourite / preview (first 140 chars of body) / updated_at /
      created_at / colour. Drives the cue-library list view without
      having to load every cue file.

The folder is gitignored (per-install state) and never written into
the ``.nnz`` archive. Cues are program-level and carry across every
project the writer opens.

**Pre-3.4c ``order.json`` migration.** On first load after Phase 3.4c
ships, if ``index.json`` is absent but ``order.json`` exists, the
service reads the order, walks every cue file once to build entries,
writes ``index.json`` atomically, then deletes ``order.json``.
Subsequent loads use ``index.json`` directly. The one-time migration
runs lazily — first read triggers it.

**Sanity-check + rebuild on load.** If ``index.json`` is missing /
malformed / its entry count disagrees with the on-disk cue file
count, the service rebuilds it by walking the cue files. Mirrors the
self-healing pattern in ``conversations_service``.

**Mutation hooks.** Every cue mutation (create / update / delete /
rename / tag add-remove / body edit / reorder) writes through the
index via atomic temp+rename. Per-id mutation functions
(``create_cue``, ``update_cue``, ``delete_cue``) replace the pre-3.4c
"PUT the whole list" pattern for new callers; ``save_cues`` (bulk)
stays as a back-compat alias so the pre-3.4c wire contract keeps
working until frontend migrates in a later sub-commit.

**No backwards compatibility shim** for the pre-Phase-2.8 single-
file format (``preferences/ai_context_cues.json``). That layout never
saw real-world use — the user confirmed only an empty test stub
existed locally, and we're not maintaining a load path for it. Any
old file simply sits unread; the next save writes to the new layout.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, List, Optional, Union

from models.context_cue import ContextCue, ContextCueIndexEntry


# A single entry in the cue library layout. Either a cue-id string
# (the cue with that id renders at this position) or a divider
# object `{ "type": "divider", "id": str, "title": str }`. The
# layout is the manual-order source for the cue library — it
# survives sort-mode switching in the UI (alpha / recent sorts
# only affect the rendered display, the underlying layout array
# is never mutated by sort changes).
LayoutEntry = Union[str, dict]


def _now_ms() -> int:
    """Current Unix-ms timestamp — drives `updated_at` stamping when
    a cue's content changes on save."""
    return int(time.time() * 1000)


_BASE_DIR = Path(__file__).resolve().parent.parent.parent / "context_cues"
_INDEX_FILENAME = "index.json"
_LEGACY_ORDER_FILENAME = "order.json"  # pre-3.4c — migrated away on first load
_CUE_FILE_SUFFIX = ".json"
_CUE_FILENAME_DELIM = "__"
_FILE_SLUG_SOFT_CAP = 64

# Preview field on `ContextCueIndexEntry`: first N characters of the
# cue's body, used by the library row when full bodies aren't loaded.
# Matches the conversations preview length convention.
_PREVIEW_MAX_CHARS = 140


def _ensure_dir() -> None:
    _BASE_DIR.mkdir(parents=True, exist_ok=True)


def _slugify(text: Optional[str]) -> str:
    """Lower-case, replace non-alphanumeric runs with dashes, trim
    leading / trailing dashes. Empty / None → empty string."""
    if not text:
        return ""
    s = str(text).lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s


def _cue_filename(cue: ContextCue) -> str:
    """Canonical filename for a cue: `{slug}__{uuid}.json`. Slug
    derived from the cue's name; UUID portion is the cue's id. Empty
    slug → filename is just `{uuid}.json`."""
    slug = _slugify(cue.name)
    if len(slug) > _FILE_SLUG_SOFT_CAP:
        slug = slug[:_FILE_SLUG_SOFT_CAP].rstrip("-")
    if not slug:
        return f"{cue.id}{_CUE_FILE_SUFFIX}"
    return f"{slug}{_CUE_FILENAME_DELIM}{cue.id}{_CUE_FILE_SUFFIX}"


def _parse_cue_filename(name: str) -> Optional[str]:
    """Return the cue id portion of a filename, or None if the name
    doesn't match the canonical pattern. Tolerates both
    `{slug}__{uuid}.json` and bare `{uuid}.json` shapes."""
    if not name.endswith(_CUE_FILE_SUFFIX):
        return None
    stem = name[: -len(_CUE_FILE_SUFFIX)]
    if _CUE_FILENAME_DELIM in stem:
        _, _, uuid_part = stem.rpartition(_CUE_FILENAME_DELIM)
        return uuid_part or None
    return stem or None


def _scan_cue_files() -> dict[str, Path]:
    """Walk the folder, return `{cue_id: file_path}` for every valid
    cue file. The index sidecar (and legacy order sidecar) are skipped."""
    out: dict[str, Path] = {}
    if not _BASE_DIR.exists():
        return out
    for entry in _BASE_DIR.iterdir():
        if not entry.is_file():
            continue
        if entry.name == _INDEX_FILENAME or entry.name == _LEGACY_ORDER_FILENAME:
            continue
        cue_id = _parse_cue_filename(entry.name)
        if cue_id:
            out[cue_id] = entry
    return out


def _read_cue_file(path: Path) -> Optional[ContextCue]:
    """Parse one cue file. Returns None on malformed JSON / shape
    mismatch — callers degrade gracefully (skip the file)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return ContextCue(**data)
    except Exception:
        return None


def _body_preview(body: str) -> str:
    """Build the index entry's preview string from a full cue body.
    The body field is TipTap HTML, so we strip tags before truncating
    so the preview is readable plain text. Mirrors the conversations
    `_preview()` helper shape."""
    if not body:
        return ""
    # Strip HTML tags conservatively — no parser, just a regex pass.
    stripped = re.sub(r"<[^>]+>", " ", body)
    # Collapse whitespace runs.
    stripped = re.sub(r"\s+", " ", stripped).strip()
    if len(stripped) > _PREVIEW_MAX_CHARS:
        return stripped[:_PREVIEW_MAX_CHARS - 1].rstrip() + "…"
    return stripped


def _build_entry_from_cue(cue: ContextCue, *, created_at: Optional[int] = None) -> ContextCueIndexEntry:
    """Project a full ContextCue into its index entry shape. The
    `created_at` argument carries over an existing entry's value when
    rebuilding — when not supplied, we initialise to `cue.updated_at`
    (the cue's earliest known timestamp) or `_now_ms()` as a last
    resort."""
    preview = _body_preview(cue.body or "")
    return ContextCueIndexEntry(
        id=cue.id,
        name=cue.name,
        tags=list(cue.tags or []),
        favourite=bool(cue.pinned),
        preview=preview,
        updated_at=cue.updated_at,
        created_at=created_at if created_at is not None else (cue.updated_at if cue.updated_at is not None else _now_ms()),
        colour=cue.colour,
    )


# ── Layout entry normalisation ─────────────────────────────────────────


def _normalise_layout_entry(entry: Any) -> Optional[LayoutEntry]:
    """Validate an incoming layout entry. Returns the normalised
    entry (string id or divider dict with `type` / `id` / `title`),
    or None for malformed input."""
    if isinstance(entry, str):
        return entry
    if isinstance(entry, dict) and entry.get("type") == "divider":
        eid = entry.get("id")
        if not isinstance(eid, str) or not eid:
            return None
        title = entry.get("title", "")
        if not isinstance(title, str):
            title = ""
        return {"type": "divider", "id": eid, "title": title}
    return None


def _layout_cue_ids(layout: List[LayoutEntry]) -> List[str]:
    """Cue-id-only filter over a layout array."""
    return [x for x in layout if isinstance(x, str)]


# ── Index file: load / save / atomic write ─────────────────────────────


def _index_path() -> Path:
    return _BASE_DIR / _INDEX_FILENAME


def _legacy_order_path() -> Path:
    return _BASE_DIR / _LEGACY_ORDER_FILENAME


def _atomic_write_json(path: Path, payload: dict) -> None:
    """Temp-file + rename for atomic write. Matches the conversations
    service's pattern to avoid partial-write corruption."""
    _ensure_dir()
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _save_index(layout: List[LayoutEntry], entries: List[ContextCueIndexEntry]) -> None:
    """Persist the index file. Caller is responsible for assembling a
    consistent (layout, entries) pair (every entry's id should appear
    in layout, modulo entries-out-of-layout fallback handling)."""
    payload = {
        "version": "0.3.4.9",
        "order": [
            x if isinstance(x, str) else {"type": "divider", "id": x["id"], "title": x.get("title", "")}
            for x in layout
        ],
        "entries": [e.model_dump() for e in entries],
    }
    _atomic_write_json(_index_path(), payload)


def _parse_index_file() -> Optional[dict]:
    """Parse the existing index file. Returns None when the file is
    missing or malformed — caller triggers a rebuild from the cue
    files."""
    path = _index_path()
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    order = data.get("order")
    entries = data.get("entries")
    if not isinstance(order, list) or not isinstance(entries, list):
        return None
    return data


def _parse_legacy_order_file() -> List[LayoutEntry]:
    """Parse the pre-3.4c `order.json` file for the migration shim.
    Returns the order array (mixed cue ids + divider objects), or []
    on missing / malformed."""
    path = _legacy_order_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    raw = data.get("order") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        return []
    out: List[LayoutEntry] = []
    for entry in raw:
        normalised = _normalise_layout_entry(entry)
        if normalised is not None:
            out.append(normalised)
    return out


def _build_index_from_disk(seed_layout: Optional[List[LayoutEntry]] = None) -> tuple[List[LayoutEntry], List[ContextCueIndexEntry]]:
    """Walk every cue file on disk, build a (layout, entries) pair.

    `seed_layout` (when provided) seeds the order from a legacy
    `order.json` or a stale `index.json.order` so divider positions /
    manual ordering survives the rebuild. Cue ids in the seed that no
    longer have a cue file are dropped. Cue ids found on disk but not
    in the seed are appended at the end. Divider entries from the seed
    are preserved verbatim.
    """
    files = _scan_cue_files()
    entries: List[ContextCueIndexEntry] = []
    cue_by_id: dict[str, ContextCue] = {}
    for cue_id, path in files.items():
        cue = _read_cue_file(path)
        if cue is None:
            continue
        # Trust the file's `id` field over the filename's id portion
        # (filename is decorative, field is canonical).
        cue_by_id[cue.id] = cue
        entries.append(_build_entry_from_cue(cue))

    # Build a layout: respect `seed_layout` order for known cues,
    # then append any cues whose id wasn't in the seed.
    layout: List[LayoutEntry] = []
    placed: set[str] = set()
    if seed_layout:
        for entry in seed_layout:
            if isinstance(entry, str):
                if entry in cue_by_id and entry not in placed:
                    layout.append(entry)
                    placed.add(entry)
            else:
                # Divider — preserve verbatim.
                layout.append(entry)
    for cue_id in cue_by_id.keys():
        if cue_id not in placed:
            layout.append(cue_id)
            placed.add(cue_id)
    return layout, entries


def _load_index_with_migration() -> tuple[List[LayoutEntry], List[ContextCueIndexEntry]]:
    """Single read-side entry point. Resolves to a (layout, entries)
    pair via one of three paths:

      1. `index.json` exists + parses cleanly + sanity check passes →
         use it directly.
      2. `index.json` is missing / malformed / fails sanity → rebuild
         from disk (using stale index.order as a seed if it parsed).
         If we just rebuilt because `index.json` was MISSING and the
         legacy `order.json` exists, read its layout for the seed
         and DELETE it after the new index is written. Subsequent
         loads stay on path (1).
      3. `index.json` missing AND no legacy `order.json` AND no cue
         files → empty pair.

    Persists the rebuilt index on paths (2) when a rebuild actually
    occurred, so the heal is one-shot rather than every-load.
    """
    parsed = _parse_index_file()
    files = _scan_cue_files()

    if parsed is not None:
        # Sanity-check: entry count should match the on-disk cue file
        # count. Mismatch means hand-dropped or hand-removed cue
        # files since the last save — rebuild from disk while
        # preserving the persisted layout's divider positions.
        on_disk_entry_count = len(files)
        parsed_entry_count = len(parsed["entries"])
        if parsed_entry_count == on_disk_entry_count:
            # Clean path — return parsed.
            layout: List[LayoutEntry] = []
            for raw in parsed["order"]:
                normalised = _normalise_layout_entry(raw)
                if normalised is not None:
                    layout.append(normalised)
            entries = [ContextCueIndexEntry(**e) for e in parsed["entries"]]
            return layout, entries
        # Stale — fall through to rebuild, seeded from the stale layout.
        seed = []
        for raw in parsed["order"]:
            normalised = _normalise_layout_entry(raw)
            if normalised is not None:
                seed.append(normalised)
        layout, entries = _build_index_from_disk(seed_layout=seed)
        _save_index(layout, entries)
        return layout, entries

    # No index file. If `order.json` is sitting around, this is the
    # one-time migration path — seed from it, build the index, then
    # delete `order.json`.
    legacy_path = _legacy_order_path()
    if legacy_path.exists():
        seed = _parse_legacy_order_file()
        layout, entries = _build_index_from_disk(seed_layout=seed)
        _save_index(layout, entries)
        try:
            legacy_path.unlink()
        except Exception:
            pass
        return layout, entries

    # No index, no legacy order — fresh walk (possibly empty).
    if not files:
        return [], []
    layout, entries = _build_index_from_disk()
    _save_index(layout, entries)
    return layout, entries


# ── Public read API ────────────────────────────────────────────────────


def list_index() -> List[ContextCueIndexEntry]:
    """Return the cue index entries in library-layout order. Cheap —
    reads `index.json` directly (rebuilds it from disk if missing or
    stale; one-time op). Drives the cue-library list view.

    Entries are returned in the order their cue-ids appear in
    `layout`, with any entries whose id isn't in the layout appended
    at the end (defensive — `_build_index_from_disk` keeps things
    consistent, but a hand-edited index could surface them).
    """
    layout, entries = _load_index_with_migration()
    by_id = {e.id: e for e in entries}
    ordered: List[ContextCueIndexEntry] = []
    seen: set[str] = set()
    for entry in layout:
        if isinstance(entry, str):
            row = by_id.get(entry)
            if row:
                ordered.append(row)
                seen.add(entry)
    for cue_id, row in by_id.items():
        if cue_id not in seen:
            ordered.append(row)
    return ordered


def get_layout() -> List[LayoutEntry]:
    """Return the full library layout (cue IDs + divider entries)."""
    layout, _entries = _load_index_with_migration()
    return layout


def get_cue(cue_id: str) -> Optional[ContextCue]:
    """Return one full cue by id, or None if missing / malformed."""
    files = _scan_cue_files()
    path = files.get(cue_id)
    if path is None:
        return None
    return _read_cue_file(path)


def list_cues() -> List[ContextCue]:
    """Return the current saved cue list in writer-chosen order. Used
    by the pre-3.4c bulk-PUT contract and any callers that need full
    bodies in one go. New code should prefer `list_index()` +
    `get_cue(id)` for lazy body loading.

    Cues whose file is malformed are silently skipped; cues present on
    disk but missing from the index layout append at the end."""
    layout, _entries = _load_index_with_migration()
    files = _scan_cue_files()
    cues_by_id: dict[str, ContextCue] = {}
    for cue_id, path in files.items():
        cue = _read_cue_file(path)
        if cue is None:
            continue
        if cue.id != cue_id:
            cue_id = cue.id
        cues_by_id[cue_id] = cue

    order = _layout_cue_ids(layout)
    out: List[ContextCue] = []
    used: set[str] = set()
    for cue_id in order:
        cue = cues_by_id.get(cue_id)
        if cue:
            out.append(cue)
            used.add(cue_id)
    for cue_id, cue in cues_by_id.items():
        if cue_id not in used:
            out.append(cue)
    return out


# ── Public per-id mutation API (Phase 3.4c) ────────────────────────────


def create_cue(cue: ContextCue) -> ContextCue:
    """Add a single cue. Writes the cue file, appends the index entry,
    appends the cue id to the layout. Atomic temp+rename on the index
    write. Returns the (possibly timestamp-stamped) cue."""
    _ensure_dir()
    layout, entries = _load_index_with_migration()
    # Force a fresh id if absent (shouldn't normally happen — clients
    # supply an id — but defends against junk inputs).
    if not cue.id:
        cue = cue.model_copy(update={"id": str(uuid.uuid4())})
    # Refuse to overwrite an existing cue via create — caller should
    # use update_cue for that.
    if cue.id in {e.id for e in entries}:
        raise ValueError(f"Cue with id={cue.id!r} already exists; use update_cue.")
    now_ms = _now_ms()
    if cue.updated_at is None:
        cue = cue.model_copy(update={"updated_at": now_ms})
    new_path = _BASE_DIR / _cue_filename(cue)
    new_path.write_text(cue.model_dump_json(indent=2), encoding="utf-8")
    new_entry = _build_entry_from_cue(cue, created_at=cue.updated_at)
    entries.append(new_entry)
    if cue.id not in {e for e in layout if isinstance(e, str)}:
        layout.append(cue.id)
    _save_index(layout, entries)
    return cue


def update_cue(cue_id: str, cue: ContextCue) -> Optional[ContextCue]:
    """Update an existing cue. Rewrites the cue file (renaming if the
    name slug changed), updates the matching index entry, preserves
    the entry's `created_at`. Stamps `updated_at` if the cue's content
    changed (name / body / tags). Returns the updated cue, or None if
    the id wasn't found."""
    _ensure_dir()
    layout, entries = _load_index_with_migration()
    files = _scan_cue_files()
    if cue_id not in files:
        return None
    if cue.id != cue_id:
        # Reject id mismatch — the cue's id is the canonical identifier.
        cue = cue.model_copy(update={"id": cue_id})
    prior = _read_cue_file(files[cue_id])
    now_ms = _now_ms()
    if prior is not None:
        content_changed = (
            prior.name != cue.name
            or prior.body != cue.body
            or list(prior.tags or []) != list(cue.tags or [])
        )
        if content_changed:
            cue = cue.model_copy(update={"updated_at": now_ms})
        else:
            cue = cue.model_copy(update={"updated_at": prior.updated_at})
    elif cue.updated_at is None:
        cue = cue.model_copy(update={"updated_at": now_ms})
    new_path = _BASE_DIR / _cue_filename(cue)
    old_path = files.get(cue_id)
    if old_path and old_path != new_path:
        try:
            old_path.unlink()
        except Exception:
            pass
    new_path.write_text(cue.model_dump_json(indent=2), encoding="utf-8")
    # Update the matching entry; preserve created_at.
    prior_entry = next((e for e in entries if e.id == cue_id), None)
    created_at = prior_entry.created_at if prior_entry and prior_entry.created_at is not None else None
    new_entry = _build_entry_from_cue(cue, created_at=created_at)
    entries = [new_entry if e.id == cue_id else e for e in entries]
    _save_index(layout, entries)
    return cue


def delete_cue(cue_id: str) -> bool:
    """Remove a cue. Deletes the cue file, strips the index entry,
    strips the cue id from the layout (divider entries preserved).
    Returns True on success, False if the cue id wasn't found."""
    _ensure_dir()
    layout, entries = _load_index_with_migration()
    files = _scan_cue_files()
    if cue_id not in files and not any(e.id == cue_id for e in entries):
        return False
    path = files.get(cue_id)
    if path is not None:
        try:
            path.unlink()
        except Exception:
            pass
    entries = [e for e in entries if e.id != cue_id]
    layout = [
        x for x in layout
        if not (isinstance(x, str) and x == cue_id)
    ]
    _save_index(layout, entries)
    return True


# ── Public bulk API (back-compat for pre-3.4c wire contract) ───────────


def save_cues(cues: List[ContextCue]) -> List[ContextCue]:
    """Bulk-replace the saved cue list. Pre-3.4c wire contract — kept
    so the existing frontend keeps working until it migrates to the
    per-id endpoints in a later sub-commit.

    Writes one file per cue, removes files for cues no longer in the
    list, then writes the index sidecar. Stamps ``updated_at`` on cues
    whose content actually changed (name / body / tags) — toggling
    ``pinned``, changing ``colour``, or reordering does NOT bump the
    timestamp."""
    _ensure_dir()
    layout, prior_entries = _load_index_with_migration()
    prior_by_id = {e.id: e for e in prior_entries}
    existing = _scan_cue_files()

    incoming_ids = {c.id for c in cues}

    # Load existing on-disk content so we can detect actual changes.
    prior_cues_by_id: dict[str, ContextCue] = {}
    for cue_id, path in existing.items():
        cue = _read_cue_file(path)
        if cue is not None:
            prior_cues_by_id[cue_id] = cue

    # Remove files for cues no longer in the list.
    for cue_id, path in existing.items():
        if cue_id not in incoming_ids:
            try:
                path.unlink()
            except Exception:
                pass

    # Stamp updated_at where appropriate, then write each cue + build
    # the new entries.
    now_ms = _now_ms()
    finalized: List[ContextCue] = []
    new_entries: List[ContextCueIndexEntry] = []
    for cue in cues:
        prev = prior_cues_by_id.get(cue.id)
        if prev is None:
            if cue.updated_at is None:
                cue = cue.model_copy(update={"updated_at": now_ms})
        else:
            content_changed = (
                prev.name != cue.name
                or prev.body != cue.body
                or list(prev.tags or []) != list(cue.tags or [])
            )
            if content_changed:
                cue = cue.model_copy(update={"updated_at": now_ms})
            else:
                cue = cue.model_copy(update={"updated_at": prev.updated_at})

        new_path = _BASE_DIR / _cue_filename(cue)
        old_path = existing.get(cue.id)
        if old_path and old_path != new_path:
            try:
                old_path.unlink()
            except Exception:
                pass
        new_path.write_text(cue.model_dump_json(indent=2), encoding="utf-8")
        finalized.append(cue)
        prior_entry = prior_by_id.get(cue.id)
        created_at = prior_entry.created_at if prior_entry and prior_entry.created_at is not None else None
        new_entries.append(_build_entry_from_cue(cue, created_at=created_at))

    # Rebuild the layout's cue-slots from the new cue order while
    # preserving any existing divider entries' relative positions.
    new_cue_ids = [c.id for c in finalized]
    new_cue_id_set = set(new_cue_ids)
    next_cue_iter = iter(new_cue_ids)
    next_layout: List[LayoutEntry] = []
    placed_cue_ids: set[str] = set()
    for entry in layout:
        if isinstance(entry, str):
            try:
                cid = next(next_cue_iter)
            except StopIteration:
                continue
            if cid in new_cue_id_set:
                next_layout.append(cid)
                placed_cue_ids.add(cid)
        else:
            next_layout.append(entry)
    for cid in new_cue_ids:
        if cid not in placed_cue_ids:
            next_layout.append(cid)
    _save_index(next_layout, new_entries)
    return finalized


def save_layout(layout: List[Any]) -> List[LayoutEntry]:
    """Replace the layout (cue-id positions + divider entries) without
    touching cue file contents or the entries cache. Cue ids in the
    input that don't resolve to existing cue files are dropped;
    files-on-disk that aren't referenced get appended at the end so
    a stale client can't accidentally orphan them."""
    _ensure_dir()
    existing_layout, entries = _load_index_with_migration()
    valid_cue_ids = {e.id for e in entries}
    cleaned: List[LayoutEntry] = []
    seen_divider_ids: set[str] = set()
    seen_cue_ids: set[str] = set()
    for entry in layout:
        normalised = _normalise_layout_entry(entry)
        if normalised is None:
            continue
        if isinstance(normalised, str):
            if normalised in valid_cue_ids and normalised not in seen_cue_ids:
                cleaned.append(normalised)
                seen_cue_ids.add(normalised)
        else:
            did = normalised["id"]
            if did in seen_divider_ids:
                continue
            seen_divider_ids.add(did)
            cleaned.append(normalised)
    for cid in valid_cue_ids:
        if cid not in seen_cue_ids:
            cleaned.append(cid)
    _save_index(cleaned, entries)
    return cleaned
