"""Persona Preamble — Phase 2.11a item 4.

The Persona Preamble is the program-injected identity declaration that
gets prepended to every Persona system prompt at send time (per the
Phase 2.11 planning doc's "System prompt assembly" section). It lives
outside the writer's voice template so heavy template customisation
can't accidentally strip the "be this character" instruction.

Storage scheme:
  * Shipped default: a Python constant defined in this module. Ships
    with the program. Not user-editable on disk.
  * User customisation: a dedicated JSON file at
    `preferences/persona_preamble.json` with shape `{"body": str}`.
    Present <=> the writer has a custom preamble. Absent <=> the
    shipped default is the effective preamble.

The file's presence IS the "customised" signal. There is no nullable-
field semantics ambiguity. Reset = delete the file (atomic).

Load is cached in module-level state. The cache invalidates on save
and on reset; otherwise reads never touch disk.

Corrupt-file handling: if the file exists but JSON is malformed or
`body` is missing / non-string, log a warning and fall back to the
shipped default. Never crash, never half-apply.

Public API:
  - get_effective_preamble()    -> str          (cached)
  - save_preamble(body: str)    -> None
  - reset_preamble()            -> None
  - has_custom_preamble()       -> bool         (cached)
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional


log = logging.getLogger("narrativenode.persona_preamble")


# Shipped default. Single source of truth for the preamble that ships
# with the program. {{character_name}} is the only placeholder supported
# today; the inline-pill editor's input rule treats any `{{name}}`
# pattern as a pill, so additional placeholders can land later without
# a backend schema change. The substitution itself happens client-side
# in the dossier-injection plumbing (Phase 2.11b item 5).
DEFAULT_PERSONA_PREAMBLE: str = (
    "You are {{character_name}}. {{character_name}} IS THE CHARACTER YOU "
    "ARE PLAYING IN THIS CONVERSATION. Every reply must come from "
    "{{character_name}}'s point of view, with their voice, knowledge, "
    "and limitations. Never break character to acknowledge that you "
    "are an AI.\n\n"
    "You and the person you are speaking with are the only "
    "participants in this conversation. Unless otherwise specifically "
    "directed, do not address or call upon any other characters as "
    "if they were present, and do not introduce new characters into "
    "the scene yourself. You may speak about other characters in the "
    "third person — as part of your inner thoughts, observations, or "
    "things you wish to say to them later — but never as if they "
    "could hear you or respond directly in this moment."
)


# Fallback body for the `<character_context>` block when the assembly
# runs with no character selected. NOT preview-only — this is the
# literal string the assembly emits inside the tags whenever a
# character isn't in play (the system-prompt editor's Preview tab has
# no character; future code paths that hit the assembly without a
# character also land here). Settling for a short, factual string
# rather than a verbose explanation so the model can read the state
# cleanly. The full assembly module (Phase 2.11b item 3) imports this
# constant; the editor's Preview tab fetches it via the persona-preamble
# GET endpoint to stay in sync.
CHARACTER_CONTEXT_FALLBACK_NO_CHARACTER: str = "no character selected"


PREAMBLE_FILE_PATH = Path("preferences") / "persona_preamble.json"


# Module-level cache. `_cache_loaded` distinguishes "never read"
# (None body, may need to read) from "loaded, no custom preamble"
# (None body, file is known to be absent).
_cached_body: Optional[str] = None
_cache_loaded: bool = False


def _read_from_disk() -> Optional[str]:
    """Returns the customised body if the file exists and is well-
    formed, else None. None means "use the shipped default"."""
    if not PREAMBLE_FILE_PATH.exists():
        return None
    try:
        data = json.loads(PREAMBLE_FILE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        log.warning(
            "Persona preamble file %s is unreadable / malformed (%s). "
            "Falling back to shipped default.",
            PREAMBLE_FILE_PATH, e,
        )
        return None
    if not isinstance(data, dict):
        log.warning(
            "Persona preamble file %s did not contain a JSON object. "
            "Falling back to shipped default.",
            PREAMBLE_FILE_PATH,
        )
        return None
    body = data.get("body")
    if not isinstance(body, str):
        log.warning(
            "Persona preamble file %s is missing a string `body` field. "
            "Falling back to shipped default.",
            PREAMBLE_FILE_PATH,
        )
        return None
    return body


def _ensure_cache() -> None:
    global _cached_body, _cache_loaded
    if _cache_loaded:
        return
    _cached_body = _read_from_disk()
    _cache_loaded = True


def get_effective_preamble() -> str:
    """Returns the effective preamble text — the custom body if a
    customisation exists, otherwise the shipped default. Cached on
    first read; subsequent calls don't touch disk until the cache is
    invalidated (save / reset)."""
    _ensure_cache()
    return _cached_body if _cached_body is not None else DEFAULT_PERSONA_PREAMBLE


def has_custom_preamble() -> bool:
    """True iff `preferences/persona_preamble.json` exists with a
    well-formed body. Drives the Reset button's enabled state."""
    _ensure_cache()
    return _cached_body is not None


def save_preamble(body: str) -> None:
    """Writes the user's customisation to disk and updates the cache.
    Creates the `preferences/` directory if missing (defensive — the
    rest of the program ensures it exists, but we don't want a fresh-
    install edge case to crash)."""
    global _cached_body, _cache_loaded
    if not isinstance(body, str):
        raise TypeError("Persona preamble body must be a string")
    PREAMBLE_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
    PREAMBLE_FILE_PATH.write_text(
        json.dumps({"body": body}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    _cached_body = body
    _cache_loaded = True


def reset_preamble() -> None:
    """Deletes the customisation file (if present) and clears the
    cache. The next call to `get_effective_preamble()` will return
    the shipped default."""
    global _cached_body, _cache_loaded
    if PREAMBLE_FILE_PATH.exists():
        try:
            PREAMBLE_FILE_PATH.unlink()
        except OSError as e:
            log.warning(
                "Failed to delete persona preamble file %s during reset (%s).",
                PREAMBLE_FILE_PATH, e,
            )
            # Don't propagate — the cache update below still gives the
            # caller the intended "back to default" outcome from the
            # program's perspective. A leftover file will be read on
            # next startup and resurrect the customisation; that's a
            # filesystem-permissions edge case the writer can sort out.
    _cached_body = None
    _cache_loaded = True
