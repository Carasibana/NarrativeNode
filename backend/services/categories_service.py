"""System-prompt category storage — Phase 2.10a items 2 + 3.

Categories materialize as plain-named subfolders under the top-level
`system_prompts/` folder; the folder name IS the category identity.
No per-folder sidecar metadata. Hand-created folders just work — the
writer can drop a folder named `Whatever/` into `system_prompts/`
from the filesystem and it shows up next time the picker refreshes.

This module owns the optional `system_prompts/categories.json` file
that maps category names to custom display colours, plus the
folder-level CRUD operations (create / rename / delete categories).

`categories.json` is:

  - Optional. If absent, every category folder uses the default
    colour. The file is created lazily on first colour write.
  - Flat-shaped: `{ "Writing": "#3b82f6", "Brainstorming": "#f59e0b" }`.
    Name → colour. No nested objects (yet).
  - Tolerant of orphan keys. A key for a folder that no longer exists
    is silently ignored at read time; we never auto-prune so the
    writer doesn't lose a colour they configured by accident.
  - Malformed JSON treated as empty. A bad file never crashes startup
    — the colour map just appears empty until the file is fixed or
    rewritten by the CRUD UI.

Writes go through `set_colour()` / `rename_colour_key()` so the file
shape stays canonical. File never deleted on empty — when all
entries are cleared, the file is left as `{}` rather than removed.

Folder CRUD (`create_category` / `rename_category` / `delete_category`)
validates names up-front: rejects filesystem-illegal characters
(`:` `/` `\\` `<` `>` `|` `?` `*` `"`), rejects empty / whitespace-only
names, and runs a case-insensitive collision check against existing
folders (Windows is case-insensitive on disk; we keep the behaviour
consistent across platforms).
"""
from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path
from typing import Dict, List, Optional

from pydantic import BaseModel


logger = logging.getLogger(__name__)


# Characters that can't appear in a folder name on at least one major
# OS (Windows is the strictest). We reject at the CRUD UI rather than
# silently sanitizing so the writer picks an unambiguous name. `"`
# is included since it's reserved on Windows even though Linux/Mac
# tolerate it.
ILLEGAL_CHARS = set(':/\\<>|?*"')


# Match `system_prompts_service._BASE_DIR` — categories live as
# subfolders of the same top-level folder, and `categories.json`
# lives at its root.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_BASE_DIR = _REPO_ROOT / "system_prompts"
_COLOURS_FILE = _BASE_DIR / "categories.json"

# Default colour for category folders without a `categories.json`
# entry. Zinc neutral matching NarrativeNode's UI palette. Picked up
# by the picker filter UI when an entry is absent.
DEFAULT_COLOUR = "#888888"


class CategoryEntry(BaseModel):
    """One row in the API's category list. `name` is the folder name
    (= category identity); `colour` is the configured colour from
    `categories.json` if any, otherwise `None` and the UI uses
    `DEFAULT_COLOUR`. `prompt_count` is the number of `*.json` files
    directly inside the folder (one level deep, matching the walker)."""
    name: str
    colour: Optional[str] = None
    prompt_count: int = 0


def read_colours() -> Dict[str, str]:
    """Parse `system_prompts/categories.json` into a `{name: colour}`
    map. Returns an empty dict when:
      - The file doesn't exist (no colours configured yet).
      - The file is malformed JSON or not a dict at the top level.
      - Individual entries have non-string values (silently dropped).

    Never raises. The colour map is non-critical state — bad data
    means "no custom colours configured", not "startup is broken".
    """
    if not _COLOURS_FILE.exists():
        return {}
    try:
        data = json.loads(_COLOURS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    result: Dict[str, str] = {}
    for k, v in data.items():
        if isinstance(k, str) and isinstance(v, str):
            result[k] = v
    return result


def list_categories() -> List[CategoryEntry]:
    """Walk `system_prompts/` one level deep and return a list of
    every category folder + its colour (from `categories.json`) + its
    `*.json` prompt count.

    Sorted by name for stable picker rendering. Orphan colour-map
    keys (folder doesn't exist) are silently dropped from the result
    — they stay in `categories.json` so the writer doesn't lose a
    colour they had configured, but they don't appear as "categories"
    in the picker because they have no folder.

    Hand-created folders are first-class — they appear in the listing
    the moment they exist on disk, no registration step required.
    """
    if not _BASE_DIR.exists():
        return []
    colours = read_colours()
    results: List[CategoryEntry] = []
    for child in sorted(_BASE_DIR.iterdir(), key=lambda p: p.name.lower()):
        if not child.is_dir():
            continue
        prompt_count = sum(1 for _ in child.glob("*.json"))
        results.append(CategoryEntry(
            name=child.name,
            colour=colours.get(child.name),
            prompt_count=prompt_count,
        ))
    return results


def _existing_folder_names() -> List[str]:
    """Names of every direct subfolder under `system_prompts/`. Used
    by the case-insensitive collision check at create / rename."""
    if not _BASE_DIR.exists():
        return []
    return [c.name for c in _BASE_DIR.iterdir() if c.is_dir()]


def _validate_category_name(name: str, *, exclude: Optional[str] = None) -> str:
    """Validate a proposed category name. Returns the cleaned name
    (stripped of leading/trailing whitespace).

    Raises `ValueError` with a writer-facing message if:
      - the name is empty or whitespace-only;
      - it contains any character in `ILLEGAL_CHARS`;
      - a case-insensitive match against an existing folder already
        exists (Windows is case-insensitive on disk; we enforce the
        same behaviour cross-platform). `exclude` skips one specific
        name from the collision check — pass the old name when
        validating a rename so the folder doesn't collide with itself.
    """
    if not isinstance(name, str):
        raise ValueError("Category name must be a string")
    cleaned = name.strip()
    if not cleaned:
        raise ValueError("Category name cannot be empty")
    bad = sorted(set(cleaned) & ILLEGAL_CHARS)
    if bad:
        raise ValueError(
            f"Category name cannot contain {' '.join(repr(c) for c in bad)}"
        )
    cleaned_lower = cleaned.lower()
    exclude_lower = exclude.lower() if isinstance(exclude, str) else None
    for existing in _existing_folder_names():
        if exclude_lower is not None and existing.lower() == exclude_lower:
            continue
        if existing.lower() == cleaned_lower:
            raise ValueError(
                f"A category named {existing!r} already exists"
            )
    return cleaned


def _write_colours(colours: Dict[str, str]) -> None:
    """Atomic-ish write of the colour map. Creates `_BASE_DIR` lazily
    if a colour is being set before any category folder exists.
    Never deletes the file on empty — leaves it as `{}` so the on-disk
    state is consistently present once any colour write has happened.
    """
    _BASE_DIR.mkdir(parents=True, exist_ok=True)
    _COLOURS_FILE.write_text(
        json.dumps(colours, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def set_colour(name: str, colour: Optional[str]) -> None:
    """Set or clear the colour for a category. `colour=None` removes
    the entry (folder reverts to the default colour); a hex string
    adds / updates the entry. No-op if the entry is already in the
    requested state (avoids spurious file writes).

    Does NOT validate that the folder exists. Orphan entries are
    tolerated at read time, and writing one before the folder is
    created (e.g. setting a colour as part of a create operation) is
    a legitimate flow.
    """
    colours = read_colours()
    current = colours.get(name)
    if colour is None:
        if name not in colours:
            return
        del colours[name]
    else:
        if current == colour:
            return
        colours[name] = colour
    _write_colours(colours)


def rename_colour_key(old_name: str, new_name: str) -> None:
    """Move a colour entry from `old_name` to `new_name`. No-op when
    the old key doesn't exist; in that case the rename is silently
    treated as 'nothing to migrate' — the new folder simply uses the
    default colour.

    If `new_name` already has an entry, it is overwritten (the rename
    is the source of truth — the new folder's colour binding wins).
    """
    if old_name == new_name:
        return
    colours = read_colours()
    if old_name not in colours:
        return
    colours[new_name] = colours.pop(old_name)
    _write_colours(colours)


def create_category(name: str, colour: Optional[str] = None) -> CategoryEntry:
    """Create a new category subfolder. Validates the name (illegal
    chars, case-insensitive collision); raises `ValueError` on bad
    input. If `colour` is non-None, also writes the entry to
    `categories.json`. Returns the freshly created `CategoryEntry`
    so the caller has the canonical record.
    """
    cleaned = _validate_category_name(name)
    folder = _BASE_DIR / cleaned
    folder.mkdir(parents=True, exist_ok=False)  # exist_ok=False is paranoid;
                                                 # validation already covers it
    if colour is not None:
        set_colour(cleaned, colour)
    return CategoryEntry(name=cleaned, colour=colour, prompt_count=0)


def rename_category(old_name: str, new_name: str) -> CategoryEntry:
    """Rename a category folder. Validates `new_name`; raises
    `ValueError` on bad input or `FileNotFoundError` when the old
    folder doesn't exist. Also renames the matching `categories.json`
    key if one exists, so the colour binding survives the rename.
    Returns the canonical `CategoryEntry` post-rename.
    """
    cleaned = _validate_category_name(new_name, exclude=old_name)
    src = _BASE_DIR / old_name
    if not src.is_dir():
        raise FileNotFoundError(f"Category {old_name!r} does not exist")
    if cleaned == old_name:
        # No-op rename — return the current state without touching disk.
        colours = read_colours()
        prompt_count = sum(1 for _ in src.glob("*.json"))
        return CategoryEntry(name=cleaned, colour=colours.get(cleaned), prompt_count=prompt_count)
    dest = _BASE_DIR / cleaned
    src.rename(dest)
    rename_colour_key(old_name, cleaned)
    colours = read_colours()
    prompt_count = sum(1 for _ in dest.glob("*.json"))
    return CategoryEntry(name=cleaned, colour=colours.get(cleaned), prompt_count=prompt_count)


def delete_category(name: str, *, move_prompts_to_root: bool = True) -> None:
    """Remove a category folder. Two modes:
      - `move_prompts_to_root=True` (default): move every `*.json` file
        inside the folder up to `system_prompts/` root, then remove the
        empty folder. Prompts are preserved as uncategorized.
      - `move_prompts_to_root=False`: delete the folder AND every prompt
        inside it. Use with caution — surfaced as an explicit choice in
        the CRUD UI so the writer can't trigger it accidentally.

    In both modes, the matching `categories.json` entry is removed
    (the folder no longer exists, so the binding is dead).

    Raises `FileNotFoundError` if the folder doesn't exist.
    """
    folder = _BASE_DIR / name
    if not folder.is_dir():
        raise FileNotFoundError(f"Category {name!r} does not exist")
    if move_prompts_to_root:
        for src in list(folder.glob("*.json")):
            dest = _BASE_DIR / src.name
            if dest.exists():
                # Filename collision with a root-level file. Suffix the
                # mover with a short uniquifier so neither file is lost.
                # The walker will resolve actual id collisions at read
                # time via the duplicate-id warning path.
                stem, suffix = src.stem, src.suffix
                dest = _BASE_DIR / f"{stem}__from-{name}{suffix}"
            shutil.move(str(src), str(dest))
    # Remove anything still inside (only relevant if move_prompts_to_root
    # is False, or if there were non-JSON files we ignored above).
    shutil.rmtree(folder)
    # Drop the orphan colour entry — the folder no longer exists.
    set_colour(name, None)
