"""Story Library index models (Phase 5.3a).

The library is a registry of references over the user's `.nnz` files,
split into two git-ignored files under the repo-root `library/` folder
(see `services/library_service.py`):

  - `index.json`  — the story index modelled here: one `LibraryEntry`
    per story UUID holding ONLY per-story state (paths, flags, a cached
    metadata snapshot). It carries NO shelf membership — that is
    shelf-centric and lives in `layout.json` (modelled in Phase 5.4).
  - `layout.json` — the shelf layout (Phase 5.4).

These are LOCAL app-data files (like `user_preferences.json` /
`conversations/index.json`), NOT distributed `.nnz` saves, so the
no-save-cliffs rule does not apply: a malformed index is tolerantly
repaired / rebuilt rather than migrated. `extra="ignore"` keeps a
forward-written field from a newer build from breaking an older read.

See the Phase 5.1 design doc §2.4 / §8.17–19 for the settled model.
"""
from __future__ import annotations
from typing import Literal, Optional
from pydantic import BaseModel, ConfigDict, Field
import uuid


_local_config = ConfigDict(extra="ignore")


class LibraryPathEntry(BaseModel):
    """One on-disk location a story's `.nnz` is known to live at.

    `last_accessed` (epoch seconds) sorts the list most-recent-first;
    `is_autosave` tags an autosave-origin path so resolution never
    treats it as most-recent / default / auto-selected (§2.2)."""
    model_config = _local_config

    path: str
    last_accessed: float = 0.0
    is_autosave: bool = False


class LibraryMetaSnapshot(BaseModel):
    """Cached snapshot of a story's view-driving metadata, refreshed on
    every save / open so the library renders cards without opening each
    `.nnz` (§2.3). The `.nnz` is always the source of truth."""
    model_config = _local_config

    title: str = ""
    description: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    series: Optional[str] = None
    series_number: Optional[float] = None
    accent_color: Optional[str] = None   # story UI accent colour (hex); null = default


class LibraryEntry(BaseModel):
    """One library entry, keyed by story UUID in `LibraryIndexFile.entries`.

    Holds ONLY per-story state. Deliberately carries NO shelf membership
    and NO per-shelf order — membership is shelf-centric (owned by the
    shelf layout in Phase 5.4). The `favourite` flag here drives the
    derived Favourites shelf; `hidden` drops the story from every view
    except the Hidden section."""
    model_config = _local_config

    paths: list[LibraryPathEntry] = Field(default_factory=list)
    pinned_default_path: Optional[str] = None
    last_opened: Optional[float] = None
    hidden: bool = False
    favourite: bool = False
    meta: LibraryMetaSnapshot = Field(default_factory=LibraryMetaSnapshot)


class LibraryIndexFile(BaseModel):
    """The whole `index.json`: a map of story UUID -> `LibraryEntry`.

    `version` is a forward-looking schema marker for the local file
    (not the `.nnz` save-format version). Tolerant read (see
    `library_service.read_index`) falls back to an empty index rather
    than raising on a malformed file."""
    model_config = _local_config

    version: int = 1
    entries: dict[str, LibraryEntry] = Field(default_factory=dict)


# ── Shelf layout (`layout.json`, Phase 5.4a) ────────────────────────────

class Shelf(BaseModel):
    """One shelf in the library layout. A flat shape with per-type fields;
    `type` says which are meaningful. Membership is shelf-centric (design
    doc §2.4):
      - `recents`    -> `count` (the N most-recently-opened; rule-ordered).
      - `series`     -> `series` (members + order derived by series_number).
      - `tag`        -> `tag` (members = stories carrying it, normalized)
                        + `order` (manual sort hint over the matched set).
      - `favourites` -> `order` (members = entries with favourite == true;
                        order is a manual sort hint).
      - `custom`     -> `story_ids` (the list IS the membership AND order).
      - `all`        -> no data (every non-hidden story).
    """
    model_config = _local_config

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    type: Literal["recents", "series", "tag", "favourites", "custom", "all"]
    title: Optional[str] = None
    # Per-type data — only the field(s) for `type` are meaningful:
    count: Optional[int] = None                          # recents
    series: Optional[str] = None                         # series
    tag: Optional[str] = None                            # tag
    order: list[str] = Field(default_factory=list)       # tag / favourites manual sort hint
    story_ids: list[str] = Field(default_factory=list)   # custom membership + order


class ShelfLayout(BaseModel):
    """The whole `layout.json`: an **ordered** array of shelves (array
    position = display order; reorder = move the element). `version` is a
    local-file schema marker. Tolerant read (see
    `library_service.read_layout`) falls back to the first-run default
    (Recents + Favourites) rather than raising on a malformed file."""
    model_config = _local_config

    version: int = 1
    shelves: list[Shelf] = Field(default_factory=list)
