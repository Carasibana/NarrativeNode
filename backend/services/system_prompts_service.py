"""System-prompt storage — Phase 2.10a (top-level `system_prompts/` folder).

Storage layout (post-2.10):

    system_prompts/                            ← top-level, gitignored
      ├── {slug}__{uuid}.json                  ← uncategorized prompts at root
      └── {category-slug}--{short-uuid}/       ← category subfolders (item 2)
          ├── category.json                    ← { id, name, colour }
          └── {slug}__{uuid}.json

This file owns:
  - The top-level `system_prompts/` folder location.
  - The per-file `{slug}__{id}.json` naming convention (slug from
    the prompt's current `name` field; id stays stable across
    renames).
  - Shipped-template install (the Phase 2.4i mechanism, updated for
    the new destination + filename convention).

The pre-2.10 → 2.10 migration is a one-shot dev tool at
`tools/migrate_system_prompts_to_phase_2_10.py` that the developer
runs once manually (NarrativeNode hasn't shipped, so there are no
real users in the wild on the legacy layout to migrate gracefully).
Matches the conversations 2.6 migration precedent.

Category subfolder writes (planning doc §5.1 item 2) are deferred to
sub-phase 2.10a item 2. This module's `_BASE_DIR` flat-glob walk is
the first step.

Filename convention rationale:
  - `{slug}` aids human browsing — when looking at the folder in
    Explorer, you can see what each prompt is from the filename.
  - `{id}` (the prompt's UUID, or the shipped-id slug) keeps the file
    uniquely identifiable regardless of name. Lookups by id scan the
    JSON content of every `*.json` and match on the `id` field, so a
    file named anything (even `whatever.json`) is findable.
  - On rename, the slug becomes stale; the next save writes the
    new canonical name and deletes the old file (whatever it was
    called).

Hand-created files Just Work (lazy-upgrade rules in
`_read_prompt_with_lazy_upgrade()`):
  - Filename is a hint for human browsing; JSON content is
    authoritative. The walker accepts any `*.json` at the root.
  - Missing `id` field on read → walker generates a UUID, writes it
    back into the file, persists. The file now has a stable identity
    for future renames / deletes via the UI.
  - Missing `name` field on read → falls back to the filename:
    strip a trailing `__{id}` suffix if present, otherwise use the
    bare filename minus `.json`.
  - Non-canonical filenames stay as-is on disk until the next UI
    save, which rewrites them to `{slug}__{id}.json` and removes the
    original in the same write.
  - Duplicate `id` across two files → log a warning, use the first
    encountered, leave the second on disk so writer data isn't lost
    to a collision the program detected.
"""
import json
import logging
import re
import shutil
import uuid
from pathlib import Path
from typing import List, Optional

from models.user_preferences import SystemPrompt


logger = logging.getLogger(__name__)


# Repo root (the parent of `backend/`).
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Top-level `system_prompts/` — the post-2.10 destination. Joins
# `conversations/` and `context_cues/` as a peer at the project
# root. Gitignored; per-install state.
_BASE_DIR = _REPO_ROOT / "system_prompts"

# Source folder for shipped templates — tracked in the repo so the
# JSON files travel with the app and a fresh install gets them on
# first launch. Lives alongside `system_prompts/` rather than inside
# it so the install logic can glob the source folder without picking
# up any of the local prompts. Stays under `preferences/` because
# it's an in-repo content source, not per-install state.
_SHIPPED_SRC_DIR = _REPO_ROOT / "preferences" / "system_prompts_shipped"

# Marker file recording the shipped ids that have already been
# installed on this machine. Sits in `preferences/` (outside the
# new top-level `system_prompts/` folder) so the list-prompts glob
# doesn't pick it up and so it stays even if `system_prompts/` is
# wiped by hand (clearing both would re-install all shipped
# templates on next launch, which is the desired escape hatch).
_INSTALLED_MARKER = _REPO_ROOT / "preferences" / "system_prompts_installed.json"


def _slugify(text: Optional[str]) -> str:
    """Lower-case + non-alphanumeric→dashes + trim. Matches the
    convention used by `context_cues/` filenames and the conversations
    2.6 migration. Empty / all-non-alphanumeric input falls back to
    `unnamed` so the filename is always parseable as `{slug}__{id}.json`.
    """
    if not text:
        return "unnamed"
    s = str(text).lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s or "unnamed"


def _ensure_dir() -> None:
    _BASE_DIR.mkdir(parents=True, exist_ok=True)


def _path_for_prompt(prompt: SystemPrompt) -> Path:
    """New 2.10 filename convention: `{slug}__{id}.json` at the root
    of the new top-level `system_prompts/` folder. Slug from current
    name; id keeps the file uniquely identifiable across renames."""
    slug = _slugify(prompt.name)
    return _BASE_DIR / f"{slug}__{prompt.id}.json"


def _iter_prompt_paths() -> List[Path]:
    """Yield every prompt-file path under `system_prompts/`, one level
    deep. Root-level `*.json` files (uncategorized prompts) come first,
    then `*.json` files inside each direct subfolder (categorized
    prompts). The top-level `categories.json` colour-map file is
    explicitly excluded — it's metadata, not a prompt. Nested
    subfolders beyond one level are ignored (matches the §4.1 walker
    rule).

    Returns a list so callers can iterate twice / use len() if needed.
    """
    if not _BASE_DIR.exists():
        return []
    paths: List[Path] = []
    # Root files (uncategorized). Skip `categories.json` — it's the
    # colour map sidecar, not a prompt.
    for f in sorted(_BASE_DIR.glob("*.json")):
        if f.name.lower() == "categories.json":
            continue
        paths.append(f)
    # One level of subfolders (categories). Sort by folder name first,
    # then by filename within each, for stable iteration order.
    for child in sorted(_BASE_DIR.iterdir(), key=lambda p: p.name.lower()):
        if not child.is_dir():
            continue
        for f in sorted(child.glob("*.json")):
            paths.append(f)
    return paths


def _category_of(path: Path) -> Optional[str]:
    """Derive the category name from a prompt file's path. Returns
    `None` when the file lives at the root of `system_prompts/`
    (uncategorized); otherwise the immediate parent folder's name.
    """
    if path.parent == _BASE_DIR:
        return None
    return path.parent.name


def _read_prompt_with_lazy_upgrade(path: Path) -> Optional[SystemPrompt]:
    """Parse a prompt JSON, applying lazy-upgrade rules so hand-created
    files Just Work:
      - Missing `id` field → generate a UUID, write it back into the
        file (preserving everything else), and proceed. The file now
        has a stable identity for future renames / deletes via the UI.
      - Missing `name` field → derive from the filename: strip a
        trailing `__{id}` suffix if present, otherwise use the bare
        filename minus `.json`. Falls back to "Unnamed prompt" if the
        derivation produces an empty string.
      - Other parse / validation failures → return None silently (the
        walker skips them, same as the pre-lazy-upgrade behaviour).

    Sets `prompt.category` from the file's parent folder name (None
    when at the root). Folder location is the source of truth; any
    `category` value previously in the JSON is discarded.

    Non-canonical filenames stay as-is at read time; the next UI save
    rewrites them to `{slug}__{id}.json` and removes the original.
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None

    upgraded = False

    if not data.get("id"):
        data["id"] = str(uuid.uuid4())
        upgraded = True

    if not data.get("name"):
        stem = path.stem  # filename without `.json`
        if "__" in stem:
            stem = stem.split("__", 1)[0]
        data["name"] = stem or "Unnamed prompt"
        upgraded = True

    # Discard any `category` from the file content — folder location
    # is authoritative. We set the right value just below.
    data.pop("category", None)

    try:
        prompt = SystemPrompt(**data)
    except Exception:
        return None

    if upgraded:
        # Best-effort persist of the generated id / fallback name so
        # the file has a stable identity for future operations. Exclude
        # `category` from the write payload — folder location is the
        # source of truth, never duplicated into the JSON.
        try:
            path.write_text(
                prompt.model_dump_json(indent=2, exclude={"category"}),
                encoding="utf-8",
            )
        except Exception:
            pass

    prompt.category = _category_of(path)
    return prompt


def _find_file_for(prompt_id: str) -> Optional[Path]:
    """Locate the file for a prompt by id. Scans the parsed `id` field
    of every `*.json` walked by `_iter_prompt_paths()` (root +
    one-level subfolders), NOT the filename pattern — so a
    hand-created file `whatever.json` with `id: "abc-123"` is findable
    just like a canonical `{slug}__abc-123.json` whether it lives at
    the root or in a category subfolder.

    Returns the first match encountered (the duplicate-id case is
    handled separately in `list_prompts()` with a warning); None when
    no file matches.
    """
    for f in _iter_prompt_paths():
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(data, dict) and data.get("id") == prompt_id:
            return f
    return None


def list_prompts() -> List[SystemPrompt]:
    """Walk `system_prompts/` and return every parsed `SystemPrompt`.
    Walks the root (uncategorized) plus one level of subfolders
    (categorized); deeper nesting is ignored. The top-level
    `categories.json` is excluded by `_iter_prompt_paths()`.

    Each returned prompt's `category` field is populated from its
    file's parent folder name (None when at the root). Lazy-upgrade
    rules from `_read_prompt_with_lazy_upgrade()` apply so hand-
    created files Just Work.

    Duplicate `id` across two files → log a warning and use the first
    encountered; the second file stays on disk untouched so the writer
    doesn't lose data to a collision we detected.
    """
    results: List[SystemPrompt] = []
    seen_ids: set = set()
    for f in _iter_prompt_paths():
        prompt = _read_prompt_with_lazy_upgrade(f)
        if prompt is None:
            continue
        if prompt.id in seen_ids:
            logger.warning(
                "Duplicate system-prompt id %r at %s; ignoring duplicate "
                "(leaving file on disk so writer data is preserved)",
                prompt.id, f.relative_to(_BASE_DIR),
            )
            continue
        seen_ids.add(prompt.id)
        results.append(prompt)
    return results


def get_prompt(prompt_id: str) -> Optional[SystemPrompt]:
    f = _find_file_for(prompt_id)
    if f is None or not f.exists():
        return None
    return _read_prompt_with_lazy_upgrade(f)


def save_prompt(prompt: SystemPrompt) -> SystemPrompt:
    """Write the prompt to disk under the canonical `{slug}__{id}.json`
    filename. Used by both create and update — they're idempotent.

    Preserves the prompt's current category location: if the file is
    found in a category subfolder, the new file is written in the same
    subfolder; if at the root, stays at the root. New prompts (no
    existing file) go to the root. Explicit category-change operations
    are handled by a separate `move_prompt()` action in item 4 — this
    function does not honour the `prompt.category` field on input;
    folder location is the source of truth.

    If the prompt was previously stored under a different filename
    (renamed prompt OR a writer-hand-created file with a non-canonical
    name), the old file is removed before the new one is written, so
    the folder always has exactly one file per id. Returns the
    persisted model with `category` populated from the final location.
    """
    _ensure_dir()
    # Content-based lookup tolerates non-canonical filenames AND
    # locates the prompt in whatever category subfolder it currently
    # lives in.
    existing = _find_file_for(prompt.id)
    parent_dir = existing.parent if existing is not None else _BASE_DIR
    parent_dir.mkdir(parents=True, exist_ok=True)
    new_path = parent_dir / f"{_slugify(prompt.name)}__{prompt.id}.json"
    if existing is not None and existing != new_path:
        try:
            existing.unlink()
        except Exception:
            pass
    # `category` is excluded from the JSON write payload — folder
    # location is the source of truth, never duplicated into the file.
    new_path.write_text(
        prompt.model_dump_json(indent=2, exclude={"category"}),
        encoding="utf-8",
    )
    # Re-attach the resolved category on the returned model so callers
    # see the final location (the prompt could have been a root file
    # before the save and moved nowhere; or it stayed in a category).
    prompt.category = _category_of(new_path)
    return prompt


def delete_prompt(prompt_id: str) -> bool:
    """Remove the prompt's file. Returns True if it existed and was
    deleted; False if no such file. The caller is responsible for
    clearing `default_system_prompt_id` on `UserPreferences` if it
    referenced the deleted id."""
    f = _find_file_for(prompt_id)
    if f is None or not f.exists():
        return False
    f.unlink()
    return True


def move_prompt(prompt_id: str, target_category: Optional[str]) -> Optional[SystemPrompt]:
    """Phase 2.10a item 5 — move a prompt to a different category.

    `target_category=None` moves the file to the root of
    `system_prompts/` (uncategorized); a non-None value moves it into
    the `system_prompts/{target_category}/` subfolder. The folder is
    NOT created on demand here — the caller (typically the CRUD UI)
    is expected to have created it via `categories_service.create_category`
    or to have validated against `list_categories()`. This keeps the
    move action a pure filesystem operation; create-as-side-effect
    semantics would invite typo'd category names silently materializing
    as folders.

    The file is written under the canonical `{slug}__{id}.json`
    filename in the new location. If the prompt was previously under
    a non-canonical filename (hand-created), it gets promoted to
    canonical form in the same move.

    Returns the persisted `SystemPrompt` with `category` populated
    from the new location, or `None` if no file matched `prompt_id`.

    Raises `FileNotFoundError` if `target_category` is non-None but
    the destination folder doesn't exist.
    """
    existing = _find_file_for(prompt_id)
    if existing is None:
        return None
    prompt = _read_prompt_with_lazy_upgrade(existing)
    if prompt is None:
        return None
    # Identify destination dir.
    if target_category is None:
        dest_dir = _BASE_DIR
    else:
        dest_dir = _BASE_DIR / target_category
        if not dest_dir.is_dir():
            raise FileNotFoundError(
                f"Category {target_category!r} does not exist"
            )
    new_path = dest_dir / f"{_slugify(prompt.name)}__{prompt.id}.json"
    # If the file is already at the target path, nothing to do.
    if existing == new_path:
        return prompt
    # Write the canonical content to the new path, then remove the old.
    # Doing it in this order keeps the prompt readable on disk even if
    # one of the steps fails partway.
    new_path.write_text(
        prompt.model_dump_json(indent=2, exclude={"category"}),
        encoding="utf-8",
    )
    try:
        existing.unlink()
    except Exception:
        pass
    prompt.category = _category_of(new_path)
    return prompt


# ── Shipped templates ─────────────────────────────────────────


def _read_installed_marker() -> set:
    """Set of shipped ids already installed on this machine. Missing
    marker file returns an empty set so a fresh install picks up
    every shipped template on first launch."""
    if not _INSTALLED_MARKER.exists():
        return set()
    try:
        data = json.loads(_INSTALLED_MARKER.read_text(encoding="utf-8"))
        ids = data.get("installed_ids") if isinstance(data, dict) else None
        if isinstance(ids, list):
            return {str(x) for x in ids if isinstance(x, str)}
    except Exception:
        # Corrupt marker treated as "nothing installed yet". Worst
        # case the writer gets a re-install of shipped templates they
        # deleted — recoverable by deleting them again. Better than
        # crashing startup over a malformed marker file.
        pass
    return set()


def _write_installed_marker(installed_ids: set) -> None:
    _INSTALLED_MARKER.parent.mkdir(parents=True, exist_ok=True)
    payload = {"installed_ids": sorted(installed_ids)}
    _INSTALLED_MARKER.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _iter_shipped_paths() -> List[Path]:
    """Yield every shipped JSON path under `system_prompts_shipped/`,
    one level deep. Mirrors `_iter_prompt_paths` shape but for the
    shipped source tree. Root-level `*.json` files come first
    (uncategorized shipped templates), then category subfolder files
    in sorted-folder-name order. The `categories.json` sidecar at
    the shipped root is intentionally excluded (no colour
    configuration ships with the templates today; the writer's
    `system_prompts/categories.json` is the only colour source)."""
    out: List[Path] = []
    if not _SHIPPED_SRC_DIR.exists():
        return out
    for p in sorted(_SHIPPED_SRC_DIR.glob("*.json")):
        if p.is_file() and p.name != "categories.json":
            out.append(p)
    for sub in sorted(_SHIPPED_SRC_DIR.iterdir()):
        if not sub.is_dir():
            continue
        for p in sorted(sub.glob("*.json")):
            if p.is_file():
                out.append(p)
    return out


def _shipped_category_of(path: Path) -> Optional[str]:
    """Resolve the shipped category folder name for a shipped source
    path. `None` for root-level files; the parent folder name for
    files inside a category subfolder."""
    if path.parent == _SHIPPED_SRC_DIR:
        return None
    return path.parent.name


def install_shipped_templates() -> List[str]:
    """Copy any shipped template the writer hasn't seen yet from
    `system_prompts_shipped/` into `system_prompts/`. Returns the
    list of ids that were just installed (may be empty).

    Phase 2.10a item 8 — the shipped source tree is now category-
    subfolder shaped (`system_prompts_shipped/<Category>/{slug}.json`)
    rather than flat. The destination tree mirrors that shape: a
    shipped template inside `<Category>/` lands at
    `system_prompts/<Category>/{slug}__{id}.json`; a root-level
    shipped template lands at the root. The category folder is
    created on demand. Root-level shipped templates (no parent
    category folder) are still supported for backward compat with
    pre-2.10 source trees.

    Idempotent: a shipped id present in the marker file is never
    re-installed, even if the writer has since deleted the prompt.
    This is the deliberate escape hatch — the writer can delete a
    shipped prompt and trust it won't keep coming back. To restore,
    they remove the id from the marker (or delete the marker entirely
    to re-install everything).

    Runs at startup from `_lifespan` in `main.py`, AFTER the 2.10
    folder migration. Silent failure on any individual template file
    (corrupt JSON, IO error) so one broken shipped file can't keep
    the others from installing.
    """
    if not _SHIPPED_SRC_DIR.exists():
        return []
    installed = _read_installed_marker()
    starting_count = len(installed)
    newly_installed: List[str] = []
    _ensure_dir()
    for src in _iter_shipped_paths():
        try:
            data = json.loads(src.read_text(encoding="utf-8"))
        except Exception:
            continue
        sid = data.get("id") if isinstance(data, dict) else None
        if not isinstance(sid, str) or not sid:
            continue
        if sid in installed:
            continue
        # If a file already exists for this id under any slug — at
        # the root OR inside any category subfolder — the marker
        # lost it but the writer kept the file. Adopt by adding the
        # id back to the marker; don't overwrite or relocate.
        existing = _find_file_for(sid)
        if existing is not None:
            installed.add(sid)
            continue
        try:
            # Validate before copying so a malformed shipped file
            # doesn't land in the writer's folder.
            prompt = SystemPrompt(**data)
        except Exception:
            continue
        # Mirror the shipped tree's category structure into the
        # writer's `system_prompts/` folder. Category subfolder is
        # created on demand; root-level shipped files keep landing
        # at the root.
        category = _shipped_category_of(src)
        if category:
            dest_dir = _BASE_DIR / category
            dest_dir.mkdir(parents=True, exist_ok=True)
        else:
            dest_dir = _BASE_DIR
        dest = dest_dir / f"{_slugify(prompt.name)}__{prompt.id}.json"
        try:
            shutil.copyfile(src, dest)
        except Exception:
            continue
        installed.add(sid)
        newly_installed.append(sid)
    if len(installed) != starting_count:
        # Persist whenever the marker set grew — covers both fresh
        # installs and the adopt-existing-files branch above. Without
        # this, adoption would happen on every launch until the next
        # actual install happened to write the marker.
        _write_installed_marker(installed)
    return newly_installed
