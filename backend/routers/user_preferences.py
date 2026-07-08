"""GET / PUT `/settings` — user-level preferences.

Sits alongside `routers/default_seeds.py` (which owns
`/settings/default-seeds`) and any future `routers/file_association.py`
(planned for `/settings/file-association`). Three distinct routers
share the `/settings` prefix, one concern each.

This router owns JUST the root `/settings` path — the top-level
user_preferences.json file. The default-seeds sub-path belongs to
its own router and is independent.

The file is entirely optional per the service-level contract. A
GET on a brand-new install with no file yet returns a blank
`UserPreferences` (all fields null) — not a 404. A PUT always
replaces the file contents with the supplied payload.
"""
from fastapi import APIRouter

from models.user_preferences import UserPreferences
from services import user_preferences_service
from services.llm_adapters import get_adapter


router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("", response_model=UserPreferences)
def get_user_preferences():
    """Return the current user preferences. Always a well-formed
    `UserPreferences` — blank (all nulls) when nothing is
    configured, a missing file, or a malformed file."""
    return user_preferences_service.read_user_preferences()


@router.put("", response_model=UserPreferences)
def put_user_preferences(prefs: UserPreferences):
    """Replace the user preferences file with the supplied payload.
    No merging — the PUT is a full replacement. The frontend is
    expected to PUT the full shape (with unset fields as null)
    every time.

    Before persisting, each AI provider profile's `base_url` is
    normalised via its adapter's `normalise_base_url()` — the writer
    may have pasted a URL that includes a documented path suffix
    (e.g. `https://openrouter.ai/api/v1/chat/completions`) that the
    adapter would otherwise duplicate when it appends its own path.
    The frontend compares the returned profiles to what it sent to
    decide whether to surface a brief inline note ("we trimmed your
    URL because adapters append the path themselves").
    """
    if prefs.ai_provider_profiles:
        normalised_profiles = []
        for profile in prefs.ai_provider_profiles:
            adapter = get_adapter(profile.api_type)
            if adapter is not None and profile.base_url:
                fixed = adapter.normalise_base_url(profile.base_url)
                if fixed != profile.base_url:
                    profile = profile.model_copy(update={"base_url": fixed})
            normalised_profiles.append(profile)
        prefs = prefs.model_copy(update={"ai_provider_profiles": normalised_profiles})
    user_preferences_service.write_user_preferences(prefs)
    return prefs
