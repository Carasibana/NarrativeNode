"""
Verbose error log for diagnosing intermittent backend failures.

Routers that catch user-impacting failures (save, autosave, .nnz
export, generic format export) append a structured entry here so the
writer can download the file from the in-app error banner and send it
back when something goes wrong. Without this, a 500 in production
leaves only a one-line FastAPI log on the user's terminal and no way
to capture it for triage.

File location: ``logs/error.log`` inside the project folder, resolved
relative to this module (the app writes only inside its own directory,
never the user's home folder). The ``logs/`` folder is gitignored and
created on demand the first time anything is logged; if it isn't
writable for any reason, the helpers degrade silently (the in-app
banner still shows the inline detail; only the file-download path is
lost).

No rotation. Per-failure entries are 1-3 KB; the file stays in the
single-digit-KB range for months of normal use because failures are
visible in the banner now (autosave failures included), so the
runaway-failure scenario that would justify a rotation cap doesn't
have a realistic trigger here.

Each entry is plain UTF-8 text, no JSON. Format:

    ================================================================
    [2026-05-22T15:42:01Z]  SAVE
      file_path: ...
      version:   ...
    ExceptionType: human-readable message
    Traceback (most recent call last):
      ...

The structure is deliberately human-readable rather than machine-
parseable; the file is meant to be opened in a text editor, copied
into a Discord message, or attached to an issue. If we ever want a
machine-readable format later, we can write a parallel JSONL file
without breaking this one.
"""

from __future__ import annotations

import datetime as _dt
import platform
import sys
import threading
import traceback
from pathlib import Path
from typing import Any

# The app writes only inside its own project folder, never the user's
# home directory. backend/services/error_log.py -> parent.parent.parent
# = repo root (same pattern as user_preferences_service.py).
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
LOG_DIR = _REPO_ROOT / "logs"
LOG_FILE = LOG_DIR / "error.log"

_lock = threading.Lock()


def get_error_log_path() -> Path:
    """Return the canonical error-log path. Used by the diagnostics
    download endpoint. Returns the path regardless of whether the file
    currently exists — the endpoint handles the missing-file case."""
    return LOG_FILE


def _ensure_log_dir() -> bool:
    """Create the log directory if it doesn't exist. Returns False on
    any OSError so the calling logger can degrade silently."""
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        return True
    except OSError:
        return False


def reset_for_new_session() -> None:
    """Delete the error log at backend startup so it only ever holds the
    CURRENT session's failures. Each backend process run is one session;
    entries from previous sessions are not carried forward (the file was
    append-only before, so it accumulated stale errors across runs).

    The file is recreated on demand by the first `log_error` call, so a
    session with no failures leaves no file at all and the diagnostics
    download endpoint reports "no failures recorded". Degrades silently
    if the file can't be removed (locked, permissions) — a stale entry
    surviving is harmless compared to crashing startup."""
    with _lock:
        try:
            LOG_FILE.unlink(missing_ok=True)
        except OSError:
            pass


def _collect_diagnostics() -> list[tuple[str, str]]:
    """Gather the application + story context that's useful when
    triaging an error report. Every read is defensive — if any one
    field fails to resolve, it falls back to a placeholder string
    rather than raising. We're already on the error path; the
    diagnostics gather must never crash the request a second time.

    Returns a list of (key, value) tuples so the caller renders them
    in declaration order. Values are stringified; counts come from
    `len()` reads on the validated Story model.
    """
    out: list[tuple[str, str]] = []

    # Program version. PROGRAM_VERSION lives in `backend/version.py`
    # and is the canonical build tag. Imported lazily so the module
    # graph stays light at import time.
    try:
        from version import PROGRAM_VERSION
        out.append(("program_version", str(PROGRAM_VERSION)))
    except Exception:
        out.append(("program_version", "<unknown>"))

    # Runtime + platform info — useful when a bug is OS-specific or
    # depends on Python interpreter behaviour (e.g. asyncio nuances
    # between 3.11 / 3.12, Windows path quirks).
    try:
        out.append(("python", sys.version.split()[0]))
    except Exception:
        out.append(("python", "<unknown>"))
    try:
        out.append(("platform", platform.platform()))
    except Exception:
        out.append(("platform", "<unknown>"))

    # Story snapshot — title + counts of the top-level containers.
    # Provides at-a-glance scale of the project that failed (a tiny
    # 5-node story behaves very differently from a 500-node one), and
    # title pins which project the user was on. All reads guarded
    # because `state.get_story()` may return None on a clean launch
    # before any project loaded, and the imports themselves can fail
    # under partial-init scenarios.
    try:
        import state  # type: ignore[import-not-found]
        story = state.get_story()
        if story is not None:
            try:
                out.append(("story_title", str(getattr(story, "title", "") or "")))
            except Exception:
                pass
            try:
                out.append(("scene_nodes", str(len(story.scenes or []))))
            except Exception:
                pass
            try:
                out.append(("setup_nodes", str(len(story.setup_nodes or []))))
            except Exception:
                pass
            try:
                out.append(("connections", str(len(story.connections or []))))
            except Exception:
                pass
            try:
                ents = story.entities
                if ents is not None:
                    total = (
                        len(ents.characters or [])
                        + len(ents.locations or [])
                        + len(ents.items or [])
                        + len(ents.factions or [])
                        + len(ents.customs or [])
                    )
                    out.append(("entities_total", str(total)))
            except Exception:
                pass
            try:
                out.append(("relationships", str(len(story.relationships or []))))
            except Exception:
                pass
            try:
                out.append(("knowledges", str(len(story.knowledges or []))))
            except Exception:
                pass
        try:
            active = state.get_active_file_path()
            out.append(("active_file_path", str(active) if active else "<none>"))
        except Exception:
            pass
    except Exception:
        # `state` not importable or get_story() raised at the call
        # site — skip the story block entirely. The caller's
        # operation-specific context still appears in the entry.
        pass

    return out


def log_error(
    operation: str,
    exc: BaseException,
    context: dict[str, Any] | None = None,
) -> None:
    """Append a verbose entry to the error log.

    `operation` is a short human label like "SAVE" or "EXPORT_NNZ".
    `exc` is the caught exception — its type, message, and full
    traceback are all rendered. `context` is an optional dict of
    request fields the user might find useful (file path, format id,
    etc.); rendered as ``  key: value`` lines under the header.

    A diagnostics block is appended automatically (program version,
    Python / OS, story title + container counts, active file path)
    so each entry stands alone for support — the writer can email /
    paste a single file and you know what they were doing when it
    broke.

    Silently degrades when the log directory can't be created or
    written — the in-app banner still surfaces the inline detail, so
    the user isn't blocked. The catch site logs the raw error to
    stdout/stderr separately via the standard ``logging`` module; this
    function is purely the additive "save to file for download" path.
    """
    if not _ensure_log_dir():
        return

    timestamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    tb = traceback.format_exception(type(exc), exc, exc.__traceback__)
    tb_text = "".join(tb).rstrip()

    lines: list[str] = []
    lines.append("=" * 64)
    lines.append(f"[{timestamp}]  {operation}")
    if context:
        for key, value in context.items():
            try:
                lines.append(f"  {key}: {value}")
            except Exception:
                lines.append(f"  {key}: <unrepresentable>")
    # Application + story diagnostics. Block-prefixed to keep the
    # eye on the actual exception below while still making the
    # context easy to scan when triaging.
    diag = _collect_diagnostics()
    if diag:
        lines.append("  --- diagnostics ---")
        for key, value in diag:
            lines.append(f"  {key}: {value}")
    lines.append(f"{type(exc).__name__}: {exc}")
    lines.append(tb_text)
    lines.append("")  # trailing blank for readability between entries
    entry = "\n".join(lines) + "\n"

    with _lock:
        try:
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(entry)
        except OSError:
            # Log directory was writable on the ensure step but the
            # write failed (disk full, file locked, permissions
            # change). Drop the entry rather than crashing the request
            # — the request's own error response is what matters.
            pass
