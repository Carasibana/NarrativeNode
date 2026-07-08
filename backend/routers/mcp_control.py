"""MCP control endpoints — Phase 2.1 Phase C1.

Backs the MCP control button in the toolbar. The button polls
`GET /mcp/control/status` for the current listener state + auto-start
preference and dispatches `POST /mcp/control/server/start` /
`POST /mcp/control/server/stop` when the user flips the runtime
toggle in the popover.

Runtime vs. preference:
- `mcp_auto_start` user preference = the PERSISTENT default that
  decides whether the static-port listener binds at lifespan
  startup. Edited via the Program Settings tab (Phase C, follow-up
  commit). Read-only from this router's perspective.
- POST start/stop = RUNTIME OVERRIDE for the current session. Does
  NOT touch the preference. The next NarrativeNode launch starts
  fresh based on the preference value.

The control surface is intentionally tiny in C1 — start, stop,
status. Phase C2 will add the request-grant endpoints when the
control-session protocol lands.
"""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, HTTPException

from services.mcp_control import mcp_static_listener
from services.mcp_session import session_manager


router = APIRouter(prefix="/mcp/control", tags=["mcp-control"])


def _merged_status() -> dict:
    """The status payload the frontend consumes — listener state +
    session state in one envelope. Both come from independent
    singletons so the merge happens here at the API boundary."""
    listener = asdict(mcp_static_listener.status())
    session = session_manager.status_snapshot()
    listener.update(session)
    return listener


@router.get("/status")
def get_status() -> dict:
    """Current snapshot of the controller state. Polled by the
    toolbar button to drive its visual state (dormant / server-on /
    pending-request / active / review)."""
    return _merged_status()


@router.post("/server/start")
async def start_server() -> dict:
    """Bind the static-port listener for THIS session. Idempotent
    if already running. Does NOT update the auto-start preference."""
    await mcp_static_listener.start()
    return _merged_status()


@router.post("/server/stop")
async def stop_server() -> dict:
    """Unbind the static-port listener. Idempotent if already
    stopped. Does NOT update the auto-start preference; the next
    launch behaves per the preference."""
    await mcp_static_listener.stop()
    return _merged_status()


# ── Pending request control ──────────────────────────────────────


@router.post("/requests/{request_id}/grant")
def grant_request(request_id: str) -> dict:
    """User accepted the MCP control request with the given id.
    Resolves the awaiting `request_mcp_session` MCP tool with
    'granted' and transitions the session manager to 'active'."""
    if not session_manager.grant(request_id):
        raise HTTPException(
            status_code=404,
            detail=f"unknown or already-resolved request: {request_id}",
        )
    return _merged_status()


@router.post("/requests/{request_id}/deny")
def deny_request(request_id: str) -> dict:
    """User declined the MCP control request with the given id.
    Resolves the awaiting tool with 'denied' and stays in whichever
    state is appropriate (idle if no other requests pending,
    requested if there are)."""
    if not session_manager.deny(request_id):
        raise HTTPException(
            status_code=404,
            detail=f"unknown or already-resolved request: {request_id}",
        )
    return _merged_status()


@router.post("/requests/deny_all")
def deny_all_requests() -> dict:
    """Deny every pending request at once. Backs the "Dismiss all"
    button in the popover panel."""
    session_manager.deny_all()
    return _merged_status()


# ── Session lifecycle (review dismissal) ─────────────────────────


@router.post("/session/end")
def end_session_user() -> dict:
    """User force-ended the active session from the toolbar. Behaves
    like the MCP client's `end_mcp_session` tool but with a fixed
    "ended by user" summary so the review view always has something
    to display. No-op if there's no active session in progress."""
    session_manager.force_end_session()
    return _merged_status()


@router.post("/session/dismiss_review")
def dismiss_review() -> dict:
    """User dismissed the post-session review view. Transitions
    'review' → 'idle'. No-op if not currently in review state.
    The end-of-session summary view (Phase C3) calls this when the
    user clicks "Done"."""
    session_manager.dismiss_review()
    return _merged_status()


# ── Destructive-action approval ──────────────────────────────────


@router.post("/destructive/{approval_id}/approve")
def approve_destructive_request(approval_id: str) -> dict:
    """User approved a single destructive operation (e.g. a
    delete_entity call). Resolves the awaiting destructive write
    tool with 'approved' so it proceeds with the operation."""
    if not session_manager.approve_destructive(approval_id):
        raise HTTPException(
            status_code=404,
            detail=f"unknown or already-resolved destructive approval: {approval_id}",
        )
    return _merged_status()


@router.post("/destructive/{approval_id}/deny")
def deny_destructive_request(approval_id: str) -> dict:
    """User denied a single destructive operation. The awaiting
    write tool wakes up with 'denied' and surfaces a clear error
    to the MCP client."""
    if not session_manager.deny_destructive(approval_id):
        raise HTTPException(
            status_code=404,
            detail=f"unknown or already-resolved destructive approval: {approval_id}",
        )
    return _merged_status()


@router.post("/destructive/approve_all")
def approve_all_destructive_requests() -> dict:
    """User clicked "Approve all destructive actions this session"
    on the destructive-approval modal. Sets the session-scoped
    auto-approve flag AND resolves every currently-pending
    destructive approval as 'approved_all' (so any in-flight
    waiters wake up immediately and proceed). The flag stays set
    for the rest of the session and resets on session end."""
    session_manager.approve_all_destructive()
    return _merged_status()
