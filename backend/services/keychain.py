"""OS keychain access for AI provider API keys — Phase 4.4b.

Thin, defensive wrapper around the `keyring` library (Windows Credential
Manager / macOS Keychain / Linux Secret Service), so a profile's secret
never sits in a plaintext file on disk.

Each profile is stored under its OWN service name ``NarrativeNode:<id>``
with a constant account name. Giving every profile a distinct service
(rather than one shared ``NarrativeNode`` service with many accounts)
keeps each OS-credential entry in the conventional service-first form
and avoids keyring's compound ``account@service`` naming, which is what
sharing a single service across multiple accounts produces.

Every call is guarded: if no OS backend is available (e.g. headless
Linux with no Secret Service), `is_available()` reports False and the
get/set/delete helpers no-op (or return None) rather than crashing.
Callers fall back to file storage in that case so a key is never lost —
see `ai_provider_profiles_service`.
"""
import logging
from typing import Optional

import keyring
import keyring.errors


logger = logging.getLogger(__name__)

# One service per profile: "NarrativeNode:<profile id>", paired with a
# constant account name. Stable across profile renames (keyed on the id).
_SERVICE_PREFIX = "NarrativeNode"
_ACCOUNT = "api_key"


def _service(profile_id: str) -> str:
    return f"{_SERVICE_PREFIX}:{profile_id}"

# Cached availability so the backend probe runs once per process, not on
# every profile read/write.
_available: Optional[bool] = None


def is_available() -> bool:
    """True when a real OS keychain backend is present. False when keyring
    fell back to its no-op `fail` backend or the probe raised — in which
    case callers keep the key in the profile file instead."""
    global _available
    if _available is not None:
        return _available
    try:
        from keyring.backends.fail import Keyring as _FailKeyring
        _available = not isinstance(keyring.get_keyring(), _FailKeyring)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("[keychain] no usable keyring backend: %r", exc)
        _available = False
    if not _available:
        logger.warning(
            "[keychain] no OS keychain backend available; AI provider API "
            "keys will be kept in their profile files instead."
        )
    return _available


def get_key(profile_id: str) -> Optional[str]:
    """The stored key for a profile id, or None if absent / unavailable."""
    if not is_available():
        return None
    try:
        return keyring.get_password(_service(profile_id), _ACCOUNT)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("[keychain] get failed for %s: %r", profile_id, exc)
        return None


def set_key(profile_id: str, key: str) -> bool:
    """Store a key. Returns True on success, False if it couldn't be stored
    (no backend, or the write raised) so the caller can fall back to file
    storage."""
    if not is_available():
        return False
    try:
        keyring.set_password(_service(profile_id), _ACCOUNT, key)
        return True
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("[keychain] set failed for %s: %r", profile_id, exc)
        return False


def delete_key(profile_id: str) -> None:
    """Remove a profile's key from the store. No-op when absent / unavailable."""
    if not is_available():
        return
    try:
        keyring.delete_password(_service(profile_id), _ACCOUNT)
    except keyring.errors.PasswordDeleteError:
        pass  # nothing stored for this id — already gone
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("[keychain] delete failed for %s: %r", profile_id, exc)
