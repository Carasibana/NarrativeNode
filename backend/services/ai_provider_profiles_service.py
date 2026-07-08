"""Per-profile storage for AI provider profiles — Phase 4.4a (per-file
layout) + 4.4b (each profile's api_key lives in the OS keychain via
`keychain.py`, never written to the file).

Each AI provider profile (LM Studio, Ollama, OpenAI, Anthropic, custom
OpenAI-compatible endpoints) is stored as its own JSON file under
`preferences/ai_provider_profiles/`, one file per profile, named
`{slug}__{id}.json` — the slug (from the profile's `name`) aids human
browsing of the folder; the stable `id` keeps the file uniquely
identifiable across renames. The JSON content is authoritative; lookups
key on the `id` field, so a hand-renamed file is still found.

This mirrors the Phase 2.10a move of system prompts out of
`user_preferences.json` into a one-file-per folder. The list is read /
written by `user_preferences_service`, which assembles it onto
`UserPreferences.ai_provider_profiles` on read and splits it back out to
files on write — so the `/settings` API shape is unchanged and every
profile consumer is untouched.

Tolerant read, matching the preferences / default-seeds contract: a
missing folder, or a file that is malformed or fails `AiProviderProfile`
validation, is silently skipped (not loaded, not an error) so one bad
file can never block the rest. This is the "its presence drives
detection; an invalid shape is checked and ignored" rule from the
originating feedback.

There is NO in-app migration from the old in-`user_preferences.json`
layout. NarrativeNode hasn't shipped, so the only existing install is
the developer's, converted once by a gitignored one-off tool
(`.Tools/migrate_ai_provider_profiles.py`) — same precedent as the
system-prompts (2.10a) and conversations (2.6) moves. The app only ever
knows this per-file format.
"""
import json
import logging
import re
from pathlib import Path
from typing import List, Optional

from models.user_preferences import AiProviderProfile
from services import keychain


logger = logging.getLogger(__name__)


# backend/services/ai_provider_profiles_service.py → parent.parent.parent = repo root.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_BASE_DIR = _REPO_ROOT / "preferences" / "ai_provider_profiles"


def get_profiles_dir() -> Path:
    """On-disk folder for the profile files. Exposed for the one-off
    migration tool + tests; production callers go through
    `read_profiles` / `write_profiles`."""
    return _BASE_DIR


def _slugify(text: Optional[str]) -> str:
    """Lower-case + non-alphanumeric→dashes + trim, matching the
    `system_prompts/` filename convention. Empty / all-non-alphanumeric
    input falls back to `profile` so the filename is always parseable as
    `{slug}__{id}.json`."""
    if not text:
        return "profile"
    s = re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")
    return s or "profile"


def _ensure_dir() -> None:
    _BASE_DIR.mkdir(parents=True, exist_ok=True)


def _path_for(profile: AiProviderProfile) -> Path:
    return _BASE_DIR / f"{_slugify(profile.name)}__{profile.id}.json"


def _file_id(path: Path) -> Optional[str]:
    """The profile id a file represents: the `id` field of its JSON
    content (authoritative, so a hand-renamed file is still identified),
    falling back to the filename stem after `__`. None if neither yields
    an id — such a file is left untouched by `write_profiles`."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("id"), str) and data["id"]:
            return data["id"]
    except Exception:
        pass
    stem = path.stem
    if "__" in stem:
        return stem.split("__", 1)[1] or None
    return None


def _safe_unlink(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass


def read_profiles() -> List[AiProviderProfile]:
    """Every valid profile in the folder. Missing folder → `[]`. A file
    that won't parse or fails `AiProviderProfile` validation is skipped
    (logged at debug). Duplicate ids → first wins; the rest are skipped
    with a warning and left on disk so no data is lost. Sorted by name
    (case-insensitive) for a stable display order."""
    if not _BASE_DIR.exists():
        return []
    out: List[AiProviderProfile] = []
    seen: set = set()
    for f in sorted(_BASE_DIR.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            profile = AiProviderProfile.model_validate(data)
        except Exception as exc:
            logger.debug("[ai_provider_profiles] skipping %s: %r", f.name, exc)
            continue
        if profile.id in seen:
            logger.warning(
                "[ai_provider_profiles] duplicate id %r at %s; ignoring duplicate "
                "(leaving file on disk so configured data is preserved)",
                profile.id, f.name,
            )
            continue
        seen.add(profile.id)
        # The secret lives in the OS keychain, not the file (Phase 4.4b).
        # Pull it back onto the in-memory profile so request-time code is
        # unchanged. Keep whatever the file carried when the keychain has
        # none — None in the normal case, or a real key only in the
        # no-backend / not-yet-migrated fallback.
        kc_key = keychain.get_key(profile.id)
        if kc_key is not None:
            profile.api_key = kc_key
        out.append(profile)
    out.sort(key=lambda p: (p.name or "").lower())
    return out


def _write_one(profile: AiProviderProfile) -> None:
    """Write one profile to its canonical file, with the secret split into
    the OS keychain (Phase 4.4b). If a key is present we try to store it in
    the keychain and write the file WITHOUT `api_key`; if there's no backend
    the store fails and we fall back to writing the key in the file so it's
    never lost. A blank/absent key clears any stored keychain entry."""
    key = profile.api_key
    in_keychain = False
    if key:
        in_keychain = keychain.set_key(profile.id, key)
    else:
        keychain.delete_key(profile.id)
    exclude = {"api_key"} if in_keychain else None
    _path_for(profile).write_text(
        profile.model_dump_json(indent=2, exclude=exclude), encoding="utf-8"
    )


def write_profiles(profiles: List[AiProviderProfile]) -> None:
    """Sync the folder to exactly `profiles`: write each to its canonical
    `{slug}__{id}.json`, and remove files for ids no longer present
    (deletions) or under a stale filename (renames). Files whose id can't
    be resolved are left untouched — the read path ignores them anyway,
    and deleting an unidentifiable file could destroy something a human
    placed there. Removed profiles also have their keychain entry deleted."""
    _ensure_dir()
    profiles = profiles or []
    keep = {p.id: p for p in profiles}
    for f in list(_BASE_DIR.glob("*.json")):
        fid = _file_id(f)
        if fid is None:
            continue
        if fid not in keep:
            _safe_unlink(f)                       # profile removed
            keychain.delete_key(fid)              # drop its stored secret too
        elif f.name != _path_for(keep[fid]).name:
            _safe_unlink(f)                       # stale filename (rename); rewritten below
    for profile in profiles:
        _write_one(profile)
