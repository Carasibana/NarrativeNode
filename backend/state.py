"""In-memory story state shared across routers."""
import time
from typing import Optional
from models.story import Story
from models.seeds import SeedsFile

_story: Story = Story()
_seeds: SeedsFile = SeedsFile()
_active_file_path: Optional[str] = None


def get_story() -> Story:
    return _story


def set_story(story: Story) -> None:
    global _story
    _story = story


def reset_story() -> Story:
    global _story, _seeds, _active_file_path
    _story = Story()
    _seeds = SeedsFile()
    _active_file_path = None
    return _story


def get_seeds() -> SeedsFile:
    return _seeds


def set_seeds(seeds: SeedsFile) -> None:
    global _seeds
    _seeds = seeds


def get_active_file_path() -> Optional[str]:
    return _active_file_path


def set_active_file_path(path: Optional[str]) -> None:
    global _active_file_path
    _active_file_path = path


# ── Pending load request (single-instance handoff) ──────────────────────
# When a second instance of run.py detects that NarrativeNode is already
# running, it POSTs the file path here instead of starting its own servers.
# The frontend's focus listener picks it up and routes it through the
# normal unsaved-changes guard before loading.

_pending_load_path: Optional[str] = None


def get_pending_load_path() -> Optional[str]:
    return _pending_load_path


def set_pending_load_path(path: Optional[str]) -> None:
    global _pending_load_path
    _pending_load_path = path


def clear_pending_load_path() -> None:
    global _pending_load_path
    _pending_load_path = None


# ── Frontend heartbeat (single-instance handoff) ────────────────────────
# Each alive browser tab POSTs /project/heartbeat (or equivalently hits
# any endpoint wired to `record_heartbeat`) on a timer. `run.py` queries
# /project/alive before deciding whether to open a second browser tab in
# the handoff path: if the backend has seen a heartbeat recently, a tab
# is alive and the pending-load-request will be picked up by its poll —
# no new tab needed. If no heartbeat for more than the window, there is
# no alive tab and run.py opens the browser so the user sees a reaction.
#
# Using last-seen-time rather than a counter so a crashed tab drops out
# of the "alive" set automatically after one window, without explicit
# cleanup.

_HEARTBEAT_WINDOW_SECONDS = 10.0
_last_heartbeat: float = 0.0


def record_heartbeat() -> None:
    global _last_heartbeat
    _last_heartbeat = time.time()


def seconds_since_heartbeat() -> float:
    if _last_heartbeat == 0.0:
        return float("inf")
    return time.time() - _last_heartbeat


def is_frontend_alive() -> bool:
    return seconds_since_heartbeat() < _HEARTBEAT_WINDOW_SECONDS
