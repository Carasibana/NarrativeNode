"""Read / write / migrate `preferences/user_preferences.json`.

User preferences are a thin layer of per-machine defaults that seed
new projects. The file lives outside any `.nnz` so preferences don't
travel with projects — edits here only affect projects you create
AFTER the edit; existing projects are untouched.

Scope & lifecycle:

- The blank schema is tracked in the repo at
  `preferences/user_preferences.json` so the file's shape is
  visible on every fresh clone. The user's actual edits are kept
  local (via git's skip-worktree setting) and do not travel back
  to the repo.
- The file is ENTIRELY OPTIONAL. All three of these states mean
  "no preferences configured" and every read returns a blank
  `UserPreferences` (all fields None): (a) file missing entirely,
  (b) file present but zero bytes or only whitespace, (c) file
  present but malformed JSON. Matches the "three states of no
  seeds" semantic used by the default-seeds layer — a broken /
  missing preferences file must never block the app from starting.
- `ensure_user_preferences_file()` is called from the FastAPI
  lifespan at startup. If the file is missing (e.g. the user
  deleted it manually, or a fresh install didn't ship the repo
  copy), it recreates a blank one from the `UserPreferences`
  defaults so the file always exists when the Program Settings
  tab queries for it.
"""
import json
import sys
from pathlib import Path

from models.user_preferences import UserPreferences
from services import ai_provider_profiles_service


# backend/services/user_preferences_service.py → parent.parent.parent = repo root.
_MODULE_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _MODULE_DIR.parent.parent
_USER_PREFS_PATH = _REPO_ROOT / "preferences" / "user_preferences.json"


def get_user_prefs_path() -> Path:
    """Expose the on-disk location for the CLI + tests. Production
    callers go through `read_user_preferences` / `write_user_preferences`
    and don't need the path."""
    return _USER_PREFS_PATH


def ensure_user_preferences_file() -> None:
    """Write a blank `user_preferences.json` to disk if none exists.
    Safe to call repeatedly. Called from the FastAPI lifespan so the
    file is guaranteed to exist by the time the Program Settings tab
    queries it, including after a manual delete. No-op when the
    file is already present — we don't overwrite user content."""
    if _USER_PREFS_PATH.exists():
        return
    try:
        _USER_PREFS_PATH.parent.mkdir(parents=True, exist_ok=True)
        _USER_PREFS_PATH.write_text(
            UserPreferences().model_dump_json(indent=2, exclude={"ai_provider_profiles"}),
            encoding="utf-8",
        )
    except OSError as exc:
        # Fall through silently — the read path tolerates a missing
        # file and returns a blank UserPreferences anyway. We'd rather
        # start cleanly than block startup on a permissions hiccup.
        print(
            f"[user_preferences] could not create {_USER_PREFS_PATH!s}: {exc!r}. "
            f"Continuing with in-memory defaults.",
            file=sys.stderr,
            flush=True,
        )


def read_user_preferences() -> UserPreferences:
    """Read the user preferences. Always returns a well-formed
    `UserPreferences`: the scalar fields come from `user_preferences.json`
    (blank for any missing / empty / malformed case), and
    `ai_provider_profiles` is assembled from the per-file folder under
    `preferences/ai_provider_profiles/` (Phase 4.4a). Reading profiles
    separately means they load even when the JSON itself is blank or
    missing."""
    prefs = _read_prefs_file_only()
    prefs.ai_provider_profiles = ai_provider_profiles_service.read_profiles()
    return prefs


def _read_prefs_file_only() -> UserPreferences:
    """Parse the scalar preferences from `user_preferences.json`. Returns
    a blank `UserPreferences` for any "no usable prefs" condition —
    missing file, zero-byte, whitespace-only, or malformed JSON — logging
    a stderr warning for the malformed case (same fallback pattern as
    `default_seeds`). The `ai_provider_profiles` section is NOT read here
    (it lives in its own folder now; `read_user_preferences` assembles
    it). Any stale section left in the file is dropped before validation,
    so an un-migrated file — possibly carrying a legacy `api_type` the
    current model rejects — still loads cleanly instead of failing the
    whole read."""
    try:
        raw = _USER_PREFS_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return UserPreferences()
    except OSError as exc:
        print(
            f"[user_preferences] could not read {_USER_PREFS_PATH!s}: {exc!r}. "
            f"Treating as no preferences configured.",
            file=sys.stderr,
            flush=True,
        )
        return UserPreferences()

    if not raw.strip():
        return UserPreferences()

    try:
        data = json.loads(raw)
        data.pop("ai_provider_profiles", None)
        return UserPreferences.model_validate(data)
    except Exception as exc:
        print(
            f"[user_preferences] malformed {_USER_PREFS_PATH!s}: {exc!r}. "
            f"Treating as no preferences configured.",
            file=sys.stderr,
            flush=True,
        )
        return UserPreferences()


def write_user_preferences(prefs: UserPreferences) -> None:
    """Write the preferences file. Creates the parent directory if
    missing so a fresh install's first PUT doesn't fail just because
    `preferences/` hasn't been created yet. Always writes (no
    empty-equals-delete semantic like the default-seeds layer) —
    the file is expected to always exist so the Program Settings
    tab can observe 'all nulls' as a valid state."""
    # Split the profile list out to one-file-per under
    # preferences/ai_provider_profiles/ (Phase 4.4a) — a folder sync that
    # writes present profiles and removes deleted / renamed ones. The JSON
    # below omits the `ai_provider_profiles` section entirely.
    ai_provider_profiles_service.write_profiles(prefs.ai_provider_profiles or [])
    _USER_PREFS_PATH.parent.mkdir(parents=True, exist_ok=True)
    _USER_PREFS_PATH.write_text(
        prefs.model_dump_json(indent=2, exclude={"ai_provider_profiles"}),
        encoding="utf-8",
    )
