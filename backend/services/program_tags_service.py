"""Phase 3.4c — Program Tag service.

Program Tags are the per-user / cross-project flat-string tag system
that lives on ``ContextCue.tags`` and ``Conversation.tags``. The
strings themselves are stored on the host objects (cue files +
thread files) and are case-sensitive on disk — but the tag system
treats them as case-insensitive for uniqueness, matching, and
recolour purposes.

This service owns the **cross-pool colour overrides map** that
Phase 3.4c introduces:

    preferences/program_tag_colors.json
    {
      "Magic": "#ec4899",
      "Important": "#f59e0b",
      ...
    }

The map is the single source of truth for Program Tag colour. It
sits in `preferences/` alongside `user_preferences.json` (per-user,
cross-project, gitignored). Tags not present in the map render at
the default colour ``#888888``.

Lookups are case-insensitive: querying ``magic`` finds an entry
keyed ``Magic`` (or vice versa). The stored key preserves the user's
typed casing so the "Edit Tag" modal can display the canonical
form. Writes that would create a case-insensitive duplicate
collapse onto the existing entry — there's one canonical entry per
case-insensitive tag name, never two.

Aggregation (`list_program_tag_pool()`) walks both index files
(`context_cues/index.json` + `conversations/index.json`) to find
every tag string currently in use, merges with the colour-map
entries (so colour-pre-set tags surface even before any host
references them), and returns a deduped per-tag summary.

The host-walking endpoints (rename / delete that iterate the
indexes to find affected hosts) live in the router layer
(`backend/routers/program_tags.py`) and call into this service for
the colour-map and aggregation pieces.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Optional


_MODULE_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _MODULE_DIR.parent.parent
_COLORS_PATH = _REPO_ROOT / "preferences" / "program_tag_colors.json"

DEFAULT_PROGRAM_TAG_COLOR = "#888888"


def get_colors_path() -> Path:
    """Expose the on-disk location for tests + CLI."""
    return _COLORS_PATH


# ── Name normalisation ─────────────────────────────────────────────────


def normalise_program_tag_name(raw: str) -> str:
    """Strip a single leading ``#`` and surrounding whitespace from a
    tag-name input. Casing is preserved. Empty-after-strip raises
    ``ValueError`` — callers should surface 422 to the API. Matches
    the project-tag router's ``_normalise_name`` shape so the rule
    is consistent across both pools."""
    if not isinstance(raw, str):
        raise ValueError("Tag name must be a string.")
    s = raw.strip()
    if s.startswith("#"):
        s = s[1:].strip()
    if not s:
        raise ValueError("Tag name cannot be empty after `#`-strip + trim.")
    return s


# ── Colour map: read / write / atomic ─────────────────────────────────


def _atomic_write_json(path: Path, payload: dict) -> None:
    """Temp-file + rename atomic write. Same pattern as
    ``conversations_service`` and ``context_cues_service``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def read_color_map() -> dict[str, str]:
    """Return the flat `{ name: hex }` map. Missing / malformed file
    returns an empty dict — callers degrade gracefully (badge renders
    at default colour for unknown tags). Logs a stderr warning on
    malformed file to surface drift."""
    try:
        raw = _COLORS_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as exc:
        print(
            f"[program_tag_colors] could not read {_COLORS_PATH!s}: {exc!r}. "
            f"Falling back to empty map.",
            file=sys.stderr,
            flush=True,
        )
        return {}
    if not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(
            f"[program_tag_colors] malformed JSON in {_COLORS_PATH!s}: {exc!r}. "
            f"Falling back to empty map; next write will rewrite the file.",
            file=sys.stderr,
            flush=True,
        )
        return {}
    if not isinstance(parsed, dict):
        return {}
    # Keep only well-formed string-string pairs; silently drop anything else.
    out: dict[str, str] = {}
    for k, v in parsed.items():
        if isinstance(k, str) and isinstance(v, str):
            out[k] = v
    return out


def write_color_map(colors: dict[str, str]) -> None:
    """Persist the full map. Caller is responsible for the dedup /
    canonical-casing rules (see ``set_color`` / ``rename_color_key`` /
    ``remove_color`` for the typed wrappers). Atomic write."""
    _atomic_write_json(_COLORS_PATH, colors)


# ── Case-insensitive lookup helpers ────────────────────────────────────


def _find_canonical_key(colors: dict[str, str], name_ci_fold: str) -> Optional[str]:
    """Return the existing key whose casefold matches ``name_ci_fold``,
    or None if no entry exists. The map is small (one entry per
    distinct tag string across the user's cues + threads), so the
    linear scan is fine — no need for a parallel index."""
    for k in colors:
        if k.casefold() == name_ci_fold:
            return k
    return None


def get_color(name: str) -> str:
    """Return the stored colour for the tag named ``name`` (case-
    insensitive lookup), or ``DEFAULT_PROGRAM_TAG_COLOR`` when absent.

    Strips a leading ``#`` so callers can pass either ``Magic`` or
    ``#Magic``. Returns the default for empty / unparseable input
    rather than raising — the lookup is a render-path call and
    shouldn't crash on edge inputs.
    """
    try:
        normalised = normalise_program_tag_name(name)
    except ValueError:
        return DEFAULT_PROGRAM_TAG_COLOR
    colors = read_color_map()
    key = _find_canonical_key(colors, normalised.casefold())
    if key is None:
        return DEFAULT_PROGRAM_TAG_COLOR
    return colors[key]


def set_color(name: str, color: str) -> tuple[str, str]:
    """Set the colour for ``name``. Returns ``(canonical_name,
    color)`` — the canonical_name is the casing that's now stored on
    disk: the existing entry's casing if there was a case-insensitive
    match, otherwise the freshly-normalised input's casing.

    The colour value is stored verbatim. Validation (hex format, etc.)
    is the router's responsibility.
    """
    normalised = normalise_program_tag_name(name)
    colors = read_color_map()
    existing_key = _find_canonical_key(colors, normalised.casefold())
    if existing_key is not None:
        # Preserve original casing; only the colour changes.
        colors[existing_key] = color
        canonical_name = existing_key
    else:
        colors[normalised] = color
        canonical_name = normalised
    write_color_map(colors)
    return canonical_name, color


def remove_color(name: str) -> bool:
    """Strip the entry whose key matches ``name`` case-insensitively.
    Returns True if an entry was removed, False if no entry was
    present. Used by the DELETE program-tag endpoint as part of its
    cascade — the colour-map entry must go away when the tag itself
    is deleted from all hosts."""
    try:
        normalised = normalise_program_tag_name(name)
    except ValueError:
        return False
    colors = read_color_map()
    key = _find_canonical_key(colors, normalised.casefold())
    if key is None:
        return False
    del colors[key]
    write_color_map(colors)
    return True


# ── Cross-pool aggregation ─────────────────────────────────────────────


def list_program_tag_pool() -> list[dict]:
    """Walk both indexes (`context_cues/index.json` + `conversations/index.json`)
    to find every Program Tag string currently in use, merge with every
    key in the colour map (so colour-pre-set tags surface even before
    any host references them), and return a deduped per-tag summary:

        [
          {
            "name": str,        # canonical casing (see below)
            "color": str,       # from colour map, or DEFAULT_PROGRAM_TAG_COLOR
            "cue_count": int,   # number of cues using this tag (case-insensitive)
            "conversation_count": int,
            "count": int,       # cue_count + conversation_count
          },
          ...
        ]

    **Case-insensitive de-dup** — all strings that fold to the same
    casefold collapse into one entry. The canonical casing is chosen
    in priority order:
      1. The casing stored in the colour map (if a colour-map entry
         exists), because that's the writer's explicit choice.
      2. Otherwise the most-recently-seen casing among the index
         entries (last write wins). Practical effect: as the writer
         tags fresh hosts, the visible casing drifts with their typed
         input — same as the project-tag system's case-preservation
         rule.

    Sort order is not the service's responsibility — callers (the
    library UI) sort descending by count + alphabetical tie-break.
    """
    # Late imports to avoid circular dependency at module import time
    # (these services import models that may transitively import this
    # one once it's used from a router).
    from services import conversations_service, context_cues_service

    colors = read_color_map()

    # Two parallel buckets keyed by the casefolded name. Each entry
    # carries the chosen canonical name + a running count.
    by_fold: dict[str, dict] = {}

    def _bump(name: str, *, cue: bool, conv: bool, prefer_casing: bool = False) -> None:
        """Add (or update) the entry for `name`. `prefer_casing=True`
        is set when this name comes from a write surface where the
        casing should be considered the canonical choice (currently
        only the colour-map key passes this — host strings update
        the canonical casing on a most-recent-wins basis)."""
        if not isinstance(name, str):
            return
        clean = name.strip()
        if not clean:
            return
        fold = clean.casefold()
        existing = by_fold.get(fold)
        if existing is None:
            by_fold[fold] = {
                "name": clean,
                "cue_count": 1 if cue else 0,
                "conversation_count": 1 if conv else 0,
                "canonical_pinned": prefer_casing,
            }
            return
        if cue:
            existing["cue_count"] += 1
        if conv:
            existing["conversation_count"] += 1
        # Update the canonical casing if the new source has higher
        # priority. Colour-map entries pin the casing; host entries
        # otherwise overwrite (most-recent-seen wins) unless a
        # colour-map entry already pinned the canonical name.
        if prefer_casing:
            existing["name"] = clean
            existing["canonical_pinned"] = True
        elif not existing.get("canonical_pinned"):
            existing["name"] = clean

    # Seed from the colour map first so its casings get priority.
    for tag_name in colors.keys():
        _bump(tag_name, cue=False, conv=False, prefer_casing=True)

    # Cue tags
    try:
        for entry in context_cues_service.list_index():
            for raw_tag in (entry.tags or []):
                _bump(raw_tag, cue=True, conv=False)
    except Exception as exc:
        # Aggregation should degrade gracefully — a bad cue index
        # shouldn't crash the whole endpoint.
        print(
            f"[program_tags] failed to aggregate cue tags: {exc!r}. "
            f"Continuing with empty cue contribution.",
            file=sys.stderr,
            flush=True,
        )

    # Conversation tags
    try:
        for entry in conversations_service.list_index():
            for raw_tag in (entry.tags or []):
                _bump(raw_tag, cue=False, conv=True)
    except Exception as exc:
        print(
            f"[program_tags] failed to aggregate conversation tags: {exc!r}. "
            f"Continuing with empty conversation contribution.",
            file=sys.stderr,
            flush=True,
        )

    out: list[dict] = []
    for entry in by_fold.values():
        cue_count = entry["cue_count"]
        conv_count = entry["conversation_count"]
        name = entry["name"]
        # Resolve colour via case-insensitive lookup against the map.
        color_key = _find_canonical_key(colors, name.casefold())
        color = colors[color_key] if color_key is not None else DEFAULT_PROGRAM_TAG_COLOR
        out.append({
            "name": name,
            "color": color,
            "cue_count": cue_count,
            "conversation_count": conv_count,
            "count": cue_count + conv_count,
        })
    return out


# ── Host-walk: rename + cascade-strip across both indexes ──────────────


def _rewrite_tags_on_host_lists(tags: list, *, old_fold: str, new_name: Optional[str]) -> tuple[list, bool]:
    """Build a new tag list with case-insensitive matches of
    `old_fold` rewritten to `new_name` (rename) or stripped entirely
    (delete; `new_name=None`). Returns `(new_list, changed)`.

    Duplicate-collapse: if the rename target already exists in the
    list under any casing, the renamed string folds into the existing
    entry (no doubles). Order is preserved (first occurrence wins).
    """
    if not isinstance(tags, list):
        return [], False
    out: list = []
    changed = False
    seen_after = set()
    for t in tags:
        if not isinstance(t, str):
            out.append(t)
            continue
        if t.casefold() == old_fold:
            changed = True
            if new_name is None:
                continue  # delete
            # Rename: collapse into existing if duplicate
            if new_name.casefold() in seen_after:
                continue
            out.append(new_name)
            seen_after.add(new_name.casefold())
        else:
            # If the rename target already appears here (in any
            # casing), the rewritten "Magic" needs to collapse with
            # the existing "Arcane" entry. Skip this iteration so
            # we don't duplicate.
            if t.casefold() in seen_after:
                changed = True
                continue
            seen_after.add(t.casefold())
            out.append(t)
    return out, changed


def rename_program_tag_across_hosts(old_name: str, new_name: str) -> tuple[int, int, int]:
    """Walk both indexes (cues + conversations), rewrite every host
    file whose `tags: list[str]` contains a case-insensitive match of
    `old_name`, replacing with `new_name`. Updates each host's index
    entry in lockstep via the existing per-host save paths. Updates
    the colour-map key (preserves the colour value).

    Returns `(cue_count, conversation_count, total_count)` —
    affected hosts only counted once each.

    Caller is responsible for:
      - Normalising `old_name` + `new_name` via `normalise_program_tag_name`.
      - Checking for collision: refusing the rename if `new_name`
        case-insensitively matches a DIFFERENT existing tag. (The
        router enforces this.)
    """
    from services import context_cues_service, conversations_service

    old_fold = old_name.casefold()
    cue_count = 0
    conv_count = 0

    # Cues
    for entry in context_cues_service.list_index():
        # Cheap pre-check via the index entry's tags — avoid loading
        # full cue bodies when nothing matches.
        if not any(isinstance(t, str) and t.casefold() == old_fold for t in (entry.tags or [])):
            continue
        cue = context_cues_service.get_cue(entry.id)
        if cue is None:
            continue
        new_tags, changed = _rewrite_tags_on_host_lists(
            list(cue.tags or []), old_fold=old_fold, new_name=new_name,
        )
        if not changed:
            continue
        updated = cue.model_copy(update={"tags": new_tags})
        context_cues_service.update_cue(cue.id, updated)
        cue_count += 1

    # Conversations
    for entry in conversations_service.list_index():
        if not any(isinstance(t, str) and t.casefold() == old_fold for t in (entry.tags or [])):
            continue
        thread = conversations_service.get_conversation(entry.id)
        if thread is None:
            continue
        new_tags, changed = _rewrite_tags_on_host_lists(
            list(thread.tags or []), old_fold=old_fold, new_name=new_name,
        )
        if not changed:
            continue
        thread = thread.model_copy(update={"tags": new_tags})
        conversations_service.save_conversation(thread)
        conv_count += 1

    # Move the colour-map entry over. rename_color_key returns False
    # if there was no entry to move — that's a no-op (the tag just
    # didn't have a custom colour, default fallback continues).
    rename_color_key(old_name, new_name)

    return cue_count, conv_count, cue_count + conv_count


def delete_program_tag_across_hosts(name: str) -> tuple[int, int, int, list[dict]]:
    """Walk both indexes, strip every host's tag list of any
    case-insensitive match of `name`. Removes the colour-map entry
    (no-op if absent). Returns:

        (cue_count, conversation_count, total_count, affected_hosts)

    Where `affected_hosts` is a list of `{kind, id, name}` dicts so
    the cascade-strip confirmation dialog can list the affected
    items by name. `kind` is `"cue"` or `"conversation"`.
    """
    from services import context_cues_service, conversations_service

    target_fold = name.casefold()
    cue_count = 0
    conv_count = 0
    affected: list[dict] = []

    for entry in context_cues_service.list_index():
        if not any(isinstance(t, str) and t.casefold() == target_fold for t in (entry.tags or [])):
            continue
        cue = context_cues_service.get_cue(entry.id)
        if cue is None:
            continue
        new_tags, changed = _rewrite_tags_on_host_lists(
            list(cue.tags or []), old_fold=target_fold, new_name=None,
        )
        if not changed:
            continue
        updated = cue.model_copy(update={"tags": new_tags})
        context_cues_service.update_cue(cue.id, updated)
        cue_count += 1
        affected.append({"kind": "cue", "id": cue.id, "name": cue.name or "(unnamed)"})

    for entry in conversations_service.list_index():
        if not any(isinstance(t, str) and t.casefold() == target_fold for t in (entry.tags or [])):
            continue
        thread = conversations_service.get_conversation(entry.id)
        if thread is None:
            continue
        new_tags, changed = _rewrite_tags_on_host_lists(
            list(thread.tags or []), old_fold=target_fold, new_name=None,
        )
        if not changed:
            continue
        thread = thread.model_copy(update={"tags": new_tags})
        conversations_service.save_conversation(thread)
        conv_count += 1
        affected.append({"kind": "conversation", "id": thread.id, "name": thread.name or "(unnamed)"})

    remove_color(name)
    return cue_count, conv_count, cue_count + conv_count, affected


def collision_check(new_name: str, *, excluding_old: Optional[str] = None) -> Optional[str]:
    """Return the canonical casing of an existing tag that
    case-insensitively matches `new_name`, or None if no collision.

    `excluding_old` lets the rename endpoint ignore the tag being
    renamed when comparing — a recasing (Magic → magic) for the same
    tag isn't a collision. The check considers BOTH the aggregated
    pool (from both indexes) AND colour-map-only entries (so a
    colour-pre-set tag that no host references yet still counts).
    """
    new_fold = new_name.casefold()
    excluding_fold = excluding_old.casefold() if excluding_old else None
    pool = list_program_tag_pool()
    for entry in pool:
        if entry["name"].casefold() == new_fold and entry["name"].casefold() != excluding_fold:
            return entry["name"]
    return None


def rename_color_key(old_name: str, new_name: str) -> bool:
    """Move the colour entry from ``old_name`` → ``new_name`` (case-
    insensitive lookup on the old, ``new_name``'s casing becomes the
    new key). Preserves the existing colour value. Returns True if a
    move happened, False if there was no entry under ``old_name``
    OR if ``new_name`` already exists as a different entry (caller's
    upstream collision check should have caught the latter, so this
    refuses defensively).

    Used by the program-tag rename endpoint after the host-walk
    completes — the colour follows the new name.
    """
    try:
        old_normalised = normalise_program_tag_name(old_name)
        new_normalised = normalise_program_tag_name(new_name)
    except ValueError:
        return False
    if old_normalised.casefold() == new_normalised.casefold():
        # Pure recasing — update the key's casing in place if it
        # exists, no-op otherwise.
        colors = read_color_map()
        existing = _find_canonical_key(colors, old_normalised.casefold())
        if existing is None:
            return False
        if existing == new_normalised:
            return False  # already at this casing
        color = colors.pop(existing)
        colors[new_normalised] = color
        write_color_map(colors)
        return True
    colors = read_color_map()
    old_key = _find_canonical_key(colors, old_normalised.casefold())
    if old_key is None:
        return False
    new_collision = _find_canonical_key(colors, new_normalised.casefold())
    if new_collision is not None and new_collision != old_key:
        return False
    color = colors.pop(old_key)
    colors[new_normalised] = color
    write_color_map(colors)
    return True
