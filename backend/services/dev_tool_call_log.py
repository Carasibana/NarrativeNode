"""
Development diagnostic log for FAILED LLM tool calls.

OFF by default. Enabled only when NarrativeNode is launched in dev mode
(``run.py --dev``), which sets ``NN_DEV_MODE=1`` in the backend process
environment. When on, every tool call the in-app model attempts that
FAILS for any reason (a raised exception, a tool-not-found, or a tool
that returns an ``{"error": ...}`` envelope) is appended to a dated log,
together with whatever tool call the model attempted NEXT.

The purpose is to see what models are TRYING to do that the tool surface
rejects, so the failure patterns can feed back into better tool
descriptions, clearer error responses, or accepting aliases / more
intuitive input shapes we don't yet accept.

File location: ``.References/DevLogs/YYYY-MM-DD.log`` inside the project
folder, resolved relative to this module (the app writes only inside its
own directory, never the user's home folder). ``.References/`` is
gitignored, so these logs never enter version control. The directory is
created on demand the first time anything is logged; if it isn't writable
for any reason, the helpers degrade silently.

One file per calendar day; entries are appended, so a day's failures
accumulate across every dev run that day. Each entry is plain UTF-8 text
(no JSON envelope) meant to be opened in an editor. Format:

    ========================================================================
    [2026-07-01 14:32:07]  FAILED TOOL CALL

    [ERROR] the tool call that failed:
      tool: create_scene
      arguments:
        { ... }
      error: [invalid_field] duration.kind: 'foo' is not a valid kind.

    [NEXT] the tool call the model attempted next:
      tool: create_scene
      arguments:
        { ... }
      outcome: FAILED , [invalid_field] duration.kind: ...

The "next" call is captured across the pending-failure slot below: when a
call fails it is held pending, and the very next tool call (whether in the
same round or the next round of the same turn) is recorded as its "next".
A trailing failure with no following call is flushed at turn end via
``flush_pending_failure`` with an explicit "(none)" marker. It never
raises: a logging failure must never disturb a chat turn.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import threading
from pathlib import Path
from typing import Any, Optional

# backend/services/dev_tool_call_log.py -> parent.parent.parent = repo root
# (same pattern as error_log.py / user_preferences_service.py). The app
# writes only inside its own project folder.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_LOG_DIR = _REPO_ROOT / ".References" / "DevLogs"

# Truncation caps so a huge argument body (e.g. a long main_content) or a
# runaway error string can't flood the log while still leaving enough to
# diagnose what the model was attempting.
_MAX_ARGS_CHARS = 4000
_MAX_ERROR_CHARS = 2000

_lock = threading.Lock()

# The single failure awaiting its "next" tool call. Module-global because
# the in-app chat is a single-user, single-session flow; the lock guards
# against interleaved writes. Shape:
#   {"time": str, "name": str|None, "arguments": Any, "error": str}
_pending: Optional[dict] = None


def is_dev_tool_logging_enabled() -> bool:
    """True only when launched with ``run.py --dev`` (which exports
    ``NN_DEV_MODE=1`` to the backend). Read fresh each call so the check
    is a cheap dict lookup with no import-order assumptions; production
    runs leave the variable unset and every hook below no-ops."""
    return os.environ.get("NN_DEV_MODE") == "1"


def record_tool_call(
    name: Optional[str],
    arguments: Any,
    failed: bool,
    output: Optional[str],
) -> None:
    """Record the outcome of one attempted tool call.

    ``failed`` is True when the call raised or returned an error envelope.
    ``output`` is the serialised tool result (it carries the error message
    on failure). No-op unless dev logging is enabled.

    A failed call is held in the pending slot; the next call recorded
    (success or failure) is written as that failure's "next" tool call and
    the slot clears. A failed "next" also becomes the new pending failure,
    so a retry chain produces one linked entry per failure.
    """
    if not is_dev_tool_logging_enabled():
        return
    try:
        with _lock:
            global _pending
            if _pending is not None:
                next_call = {
                    "name": name,
                    "arguments": arguments,
                    "failed": bool(failed),
                    "error": _extract_error(output) if failed else None,
                }
                _write_entry(_pending, next_call)
                _pending = None
            if failed:
                _pending = {
                    "time": _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "name": name,
                    "arguments": arguments,
                    "error": _extract_error(output),
                }
    except Exception:
        # A diagnostic logger must never break a chat turn.
        pass


def flush_pending_failure() -> None:
    """Write any failure still awaiting a "next" call, marking that no
    further tool call followed. Called when the agentic tool loop ends so
    a trailing failure isn't left dangling (or mis-paired with the first
    call of a later, unrelated turn). No-op unless dev logging is enabled."""
    if not is_dev_tool_logging_enabled():
        return
    try:
        with _lock:
            global _pending
            if _pending is not None:
                _write_entry(_pending, None)
                _pending = None
    except Exception:
        pass


def _ensure_log_dir() -> bool:
    """Create the DevLogs directory if absent. Returns False on any
    OSError so the caller degrades silently."""
    try:
        _LOG_DIR.mkdir(parents=True, exist_ok=True)
        return True
    except OSError:
        return False


def _log_file_for_today() -> Path:
    """Path to the current day's log file (``YYYY-MM-DD.log``)."""
    return _LOG_DIR / f"{_dt.datetime.now().strftime('%Y-%m-%d')}.log"


def _extract_error(output: Optional[str]) -> str:
    """Pull a human-readable error message out of a serialised tool
    result. The bridge wraps failures as ``{"error": "..."}``; fall back
    to the raw output for any other shape. Truncated to keep entries
    readable."""
    if not output:
        return ""
    try:
        parsed = json.loads(output)
        if isinstance(parsed, dict) and parsed.get("error"):
            return _truncate(str(parsed["error"]), _MAX_ERROR_CHARS)
    except Exception:
        pass
    text = output if isinstance(output, str) else str(output)
    return _truncate(text, _MAX_ERROR_CHARS)


def _format_args(arguments: Any) -> str:
    """Pretty-print a call's arguments for the log, truncated so a large
    payload can't flood the file."""
    try:
        text = json.dumps(arguments, ensure_ascii=False, indent=2)
    except Exception:
        text = repr(arguments)
    return _truncate(text, _MAX_ARGS_CHARS)


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f" ...[truncated, {len(text)} chars total]"


def _indent(text: str, spaces: int) -> str:
    pad = " " * spaces
    return "\n".join(pad + line for line in text.splitlines())


def _write_entry(failure: dict, next_call: Optional[dict]) -> None:
    """Append one delimited entry: the failed call, then the next call the
    model attempted (or an explicit "(none)" marker). Runs under ``_lock``."""
    if not _ensure_log_dir():
        return

    lines: list[str] = []
    lines.append("=" * 72)
    lines.append(f"[{failure.get('time', '')}]  FAILED TOOL CALL")
    lines.append("")
    lines.append("[ERROR] the tool call that failed:")
    lines.append(f"  tool: {failure.get('name') or '<unknown>'}")
    lines.append("  arguments:")
    lines.append(_indent(_format_args(failure.get("arguments")), 4))
    lines.append(f"  error: {failure.get('error') or '<no error message>'}")
    lines.append("")
    if next_call is None:
        lines.append("[NEXT] (none , the model made no further tool call this turn)")
    else:
        if next_call.get("failed"):
            outcome = "FAILED , " + (next_call.get("error") or "<no error message>")
        else:
            outcome = "succeeded"
        lines.append("[NEXT] the tool call the model attempted next:")
        lines.append(f"  tool: {next_call.get('name') or '<unknown>'}")
        lines.append("  arguments:")
        lines.append(_indent(_format_args(next_call.get("arguments")), 4))
        lines.append(f"  outcome: {outcome}")
    lines.append("")  # trailing blank between entries
    entry = "\n".join(lines) + "\n"

    try:
        with open(_log_file_for_today(), "a", encoding="utf-8") as f:
            f.write(entry)
    except OSError:
        # Directory was creatable but the write failed (disk full, file
        # locked). Drop the entry rather than disturbing the chat turn.
        pass
