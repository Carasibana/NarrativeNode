"""MCP session state machine — Phase 2.1 Phase C1.2.

Manages the user-permission layer that sits on top of the raw MCP
server. An external MCP client (Claude Desktop, mcp-inspect, a script,
etc.) connecting to NarrativeNode can freely call READ tools at any
time. WRITE tools (Phase D) require an active CONTROL SESSION — the
user must have explicitly granted permission for the current
authorial-intent flow.

The state machine:

    idle ──(request_mcp_session)──> requested ──(grant)──> active
                                       │                    │
                                       │ (deny)             │ (end_mcp_session)
                                       │                    ▼
                                       └────> idle      review ──(dismiss)──> idle

States:
  idle      — no client is asking for permission, no session running.
              Write tools are blocked with `session_not_active`.
  requested — at least one pending request awaits user response.
              Modal pops on the FIRST request of a "stop asking"
              window; subsequent requests sit in the popover panel.
  active    — user has granted control. Write tools work. Tool calls
              are logged for the eventual review view.
  review    — `end_mcp_session(summary)` has fired. The user is
              reviewing what changed before clearing back to idle.

Request flow:
  1. MCP client calls `request_mcp_session(purpose)`.
  2. The tool creates a PendingRequest, registers it with the manager,
     and AWAITS the request's future (with timeout, default 300s).
  3. The frontend polls `/mcp/control/status` and sees the pending
     request. It either pops the modal (first request of a window)
     or lights up the badge for the popover panel.
  4. The user clicks Grant or Deny. The frontend POSTs to
     `/mcp/control/requests/{id}/grant` or `.../deny`.
  5. The REST handler resolves the future on the manager.
  6. The awaiting tool wakes up, returns either `granted` or `denied`
     to the MCP client.

Concurrency: all methods run on the FastAPI event loop. PendingRequest
uses `asyncio.Future` for the wait, not a threading primitive.

Single-instance contract: the module exports `session_manager` as a
process singleton.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal, Optional


SessionState = Literal["idle", "requested", "active", "review"]


@dataclass
class PendingRequest:
    """One unresolved request for control. The future is set by
    `grant()` / `deny()` / timeout and is what the awaiting MCP tool
    is blocked on."""
    id: str
    purpose: str
    requested_at: datetime
    future: asyncio.Future
    # When the request was created — fed back to the frontend so it
    # can show a "5s ago" type label and timeout the request after
    # `REQUEST_TIMEOUT_SECONDS` has elapsed.

    def to_public_dict(self) -> dict:
        return {
            "id": self.id,
            "purpose": self.purpose,
            "requested_at": self.requested_at.isoformat(),
        }


@dataclass
class PendingDestructiveApproval:
    """One unresolved destructive-action approval request. The future
    is set by `approve_destructive()` / `deny_destructive()` /
    `approve_all_destructive()` / timeout and is what the awaiting
    write tool is blocked on. Sits alongside `PendingRequest` (which
    is for SESSION grants) — same `asyncio.Future` machinery, but a
    separate queue and a separate UX surface (per-action modal vs
    session-grant modal).

    `tone` controls the modal's visual styling: 'red' (default) for
    data-deletion-style destructive actions (entity / scene / etc.
    deletes that strip references across the project); 'amber' for
    non-deletion destructive actions that rewrite something the user
    has invested in but don't lose data (e.g. `reorganize_canvas`
    overwriting the user's canvas layout — no data lost but the
    layout the user crafted is gone). Both go through the SAME
    approval flow; only the modal colour + copy framing differs."""
    id: str
    action: str           # e.g. "delete"
    object_type: str      # e.g. "entity", "relationship", "scene"
    object_name: str      # human-readable identifier shown in the modal
    detail: str           # one-line consequence summary for the modal body
    requested_at: datetime
    future: asyncio.Future
    tone: str = "red"     # 'red' | 'amber' — see docstring above

    def to_public_dict(self) -> dict:
        return {
            "id": self.id,
            "action": self.action,
            "object_type": self.object_type,
            "object_name": self.object_name,
            "detail": self.detail,
            "requested_at": self.requested_at.isoformat(),
            "tone": self.tone,
        }


@dataclass
class ActiveSession:
    """One in-progress control session. Created when a PendingRequest
    is granted; ends when `end_mcp_session(summary)` fires (transitions
    to review) or the user manually dismisses from the popover."""
    id: str
    purpose: str
    started_at: datetime
    # Phase C2/C3: tool-call log. Each call adds an entry.
    tool_calls: list[dict] = field(default_factory=list)
    # Phase D destructive-action gate: when True, every subsequent
    # destructive call inside this session skips the per-action
    # approval modal and proceeds immediately. Set by the user
    # clicking "Approve all destructive actions this session" on
    # the destructive-approval modal. Resets when the session ends
    # (no carry-over to next session).
    auto_approve_destructive: bool = False

    def to_public_dict(self) -> dict:
        return {
            "id": self.id,
            "purpose": self.purpose,
            "started_at": self.started_at.isoformat(),
            "tool_call_count": len(self.tool_calls),
        }


@dataclass
class ReviewSummary:
    """Post-session summary surfaced in the review view. Populated by
    `end_mcp_session(summary)`."""
    session_id: str
    purpose: str
    summary: str
    started_at: datetime
    ended_at: datetime
    tool_call_count: int

    def to_public_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "purpose": self.purpose,
            "summary": self.summary,
            "started_at": self.started_at.isoformat(),
            "ended_at": self.ended_at.isoformat(),
            "tool_call_count": self.tool_call_count,
        }


# Default seconds an MCP tool will wait for a user response before
# the request auto-times-out. Kept short (30s) because the MCP
# transport layer (Streamable HTTP via mcp-remote etc.) has its own
# tool-call timeout — typically 60s — and a backend wait that
# overshoots the transport ends with the MCP client seeing a
# generic "request timed out" error instead of our cleaner
# `'timeout'` return value. 30s gives the user time to read the
# modal and click while keeping a comfortable buffer under the
# transport timeout. If the user genuinely needs longer (e.g. they
# stepped away), the MCP client retries with the same purpose —
# the pending request stays visible in the toolbar popover until
# the user acts on it manually, so a retry hits the SAME open
# request rather than queuing a duplicate.
#
# NOTE: while the backend's wait timer ends at 30s, the request
# itself does NOT vanish from `session_manager._pending` — it stays
# queued, badge stays lit, popover panel still lists it. Only the
# awaiting MCP tool returns. The user can act on the request at
# their leisure; the next `request_mcp_session(...)` call from the
# AI will be ignored if there's already an identical-purpose
# pending request *and* the future hasn't been resolved.
REQUEST_TIMEOUT_SECONDS = 30.0


class McpSessionManager:
    """The MCP control state machine. See module docstring."""

    def __init__(self) -> None:
        self._state: SessionState = "idle"
        self._pending: dict[str, PendingRequest] = {}
        self._active: Optional[ActiveSession] = None
        self._review: Optional[ReviewSummary] = None
        # Phase D destructive-action gate — separate queue from
        # `_pending` (which is for session grants). Each entry is a
        # PendingDestructiveApproval awaiting Approve / Deny /
        # Approve-All from the user. The queue lives at the manager
        # level (not on ActiveSession) so the frontend status
        # endpoint can surface it at the same point as the rest of
        # the session state.
        self._pending_destructive: dict[str, PendingDestructiveApproval] = {}

    # ── State introspection ──────────────────────────────────────

    @property
    def state(self) -> SessionState:
        return self._state

    @property
    def auto_approve_destructive(self) -> bool:
        """True iff the user has hit "Approve all destructive actions
        this session" in the current active session. Resets to False
        on session end (because `self._active` becomes None)."""
        return bool(self._active and self._active.auto_approve_destructive)

    def status_snapshot(self) -> dict:
        """The shape consumed by `/mcp/control/status` and the frontend
        store. Stays additive — new fields land here without breaking
        existing clients."""
        return {
            "session_state": self._state,
            "pending_request_count": len(self._pending),
            "pending_requests": [r.to_public_dict() for r in self._pending.values()],
            "active_session": self._active.to_public_dict() if self._active else None,
            "review": self._review.to_public_dict() if self._review else None,
            "pending_destructive_count": len(self._pending_destructive),
            "pending_destructive": [d.to_public_dict() for d in self._pending_destructive.values()],
            "auto_approve_destructive": self.auto_approve_destructive,
        }

    # ── Request flow ─────────────────────────────────────────────

    async def request_session(self, purpose: str, *, timeout: float = REQUEST_TIMEOUT_SECONDS) -> str:
        """Wait for the user to grant or deny an MCP control session.
        Called by the `request_mcp_session` MCP tool. Returns one of:
          - "granted"  → caller transitions to active session
          - "denied"   → user explicitly said no
          - "timeout"  → no response within `timeout` seconds; the
                         pending request stays in the toolbar UI so
                         the user can still act on it after the tool
                         returns. The MCP client may retry with the
                         same purpose to re-await the same request.
          - "already_active" → a session is already active, so the write
                         tools already work; proceed, do not re-request.
          - "denied:session_under_review"   → a previous session is
                         awaiting user dismissal.

        Idempotent across retries: if an existing pending request
        carries the same `purpose`, this call hooks ONTO that
        request's future rather than queuing a duplicate. Same for
        the "already granted" race — if a session is currently active
        AND its purpose matches, returns 'granted' immediately
        instead of refusing.

        Timeout semantics: on backend-timeout, the request is left
        in the pending queue (NOT popped). This is the key
        difference vs. an explicit deny: the user can still see the
        request in the popover panel and act on it; a subsequent
        retry from the MCP client picks up where this call left off."""
        # A session is already active. Writes gate on the GLOBAL active
        # state (any active session enables the write tools), so the caller
        # already has write access whether or not this request's purpose
        # matches the one that opened the session. Return an AFFIRMATIVE
        # signal, never a "denied:" string: models read "denied" as "no
        # access" and re-request in a loop (observed in live testing).
        # Purpose-match keeps the canonical "granted"; a non-matching
        # purpose returns "already_active" (a granted-equivalent: proceed
        # with your write tools, do not re-request).
        if self._state == "active":
            if self._active and self._active.purpose == (purpose or ""):
                return "granted"
            return "already_active"
        # A previous session's summary is still on screen (review state)
        # but the user has not dismissed it. Do NOT block the new request
        # on that: the incoming connection matters more than an
        # un-acknowledged summary, and a closed popover can hide the
        # summary so the user never realises a new request is waiting.
        # Supersede the review (clear it back to idle) and fall through to
        # register the request normally, so the user still gets the
        # grant/deny prompt (or an auto-grant when pre-approve connections
        # is on).
        if self._state == "review":
            self._review = None
            self._state = "idle"

        # Idempotent retry: hook onto an existing pending request that
        # carries the same purpose rather than queuing a duplicate.
        # The user sees one request in the popover panel regardless of
        # how many times the MCP client retries.
        existing = next(
            (r for r in self._pending.values() if r.purpose == (purpose or "")),
            None,
        )
        if existing is not None:
            return await self._await_request(existing, timeout)

        request = PendingRequest(
            id=str(uuid.uuid4()),
            purpose=purpose or "",
            requested_at=datetime.now(timezone.utc),
            future=asyncio.get_running_loop().create_future(),
        )
        self._pending[request.id] = request
        # Transition to 'requested' on the first pending request.
        # Subsequent requests don't change the state (still 'requested').
        if self._state == "idle":
            self._state = "requested"
        return await self._await_request(request, timeout)

    async def _await_request(
        self, request: PendingRequest, timeout: float
    ) -> str:
        """Block on a request's future until it resolves or the
        timeout elapses. On timeout, leaves the request in the
        pending queue so the user can still act on it after the
        tool returns and a future retry can hook onto the same
        request. `asyncio.shield` prevents the shared future from
        being cancelled if this caller's wait is cancelled — other
        concurrent awaiters of the same request stay live."""
        try:
            return await asyncio.wait_for(
                asyncio.shield(request.future), timeout=timeout
            )
        except asyncio.TimeoutError:
            # Request stays in self._pending so the user can still
            # see and act on it from the popover. The next retry
            # from the MCP client will hook onto the same request.
            return "timeout"

    def grant(self, request_id: str) -> bool:
        """Resolve a pending request as granted. Transitions the
        manager to `active` with a new ActiveSession. Returns True if
        the request was found and granted, False if the id was unknown
        (e.g. already timed out / superseded). Called by the
        `/mcp/control/requests/{id}/grant` REST handler."""
        request = self._pending.pop(request_id, None)
        if request is None:
            return False
        # Resolve the awaiting tool's future. The MCP tool wakes up
        # and returns "granted" to its caller.
        if not request.future.done():
            request.future.set_result("granted")
        # Transition: spin up the active session.
        self._active = ActiveSession(
            id=str(uuid.uuid4()),
            purpose=request.purpose,
            started_at=datetime.now(timezone.utc),
        )
        self._state = "active"
        # Any OTHER pending requests get denied — there can only be
        # one active session at a time, and the user's grant of THIS
        # request implicitly rejects the others.
        for other in list(self._pending.values()):
            if not other.future.done():
                other.future.set_result("superseded")
            self._pending.pop(other.id, None)
        return True

    def deny(self, request_id: str) -> bool:
        """Resolve a pending request as denied. Returns True if the
        request was found. Does NOT change the manager's state unless
        this was the last pending request, in which case we drop back
        to idle."""
        request = self._pending.pop(request_id, None)
        if request is None:
            return False
        if not request.future.done():
            request.future.set_result("denied")
        self._recompute_state_after_pending_drop()
        return True

    def deny_all(self) -> int:
        """Deny every pending request at once. Returned by the
        manager so the UI can show a "Dismiss all" button in the
        panel. Returns the number of requests that were denied."""
        count = 0
        for request in list(self._pending.values()):
            if self.deny(request.id):
                count += 1
        return count

    # ── Destructive-action approval ──────────────────────────────
    #
    # Sits ON TOP of the session grant. The session grant
    # ("you may write") is a broad permission; per-action
    # destructive approval ("you may delete THIS specific thing")
    # is a finer one that only fires for operations routed through
    # the project's `deleteObject` dispatcher (entity / relationship
    # / scene / connection / attribute / chapter / act / presetList /
    # customCategory). Updates and context-scoped removes / chain
    # leave events stay un-gated because they're chain-recoverable.

    DESTRUCTIVE_TIMEOUT_SECONDS = 60.0

    async def request_destructive_approval(
        self,
        *,
        action: str,
        object_type: str,
        object_name: str,
        detail: str,
        tone: str = "red",
        timeout: float = DESTRUCTIVE_TIMEOUT_SECONDS,
    ) -> str:
        """Block until the user approves or denies a destructive
        operation, OR until `timeout` elapses. Called by
        `_proxy_destructive_tool` on the backend before a destructive
        write tool is dispatched. Returns one of:
          - 'approved' → caller proceeds with the destructive op
          - 'approved_all' → user opted in for all this session;
                             caller proceeds AND every subsequent
                             destructive call this session also
                             returns 'approved_all' immediately
                             without re-prompting
          - 'denied' → user said no; caller raises a clear error to
                       the MCP client
          - 'timeout' → no response within `timeout` seconds; caller
                        treats as denial
          - 'no_session' → no active session is running, so there's
                            no place to ask. Caller should already
                            have failed the session-active gate
                            BEFORE reaching this method, so this is
                            a defensive return rather than an
                            expected path.

        Short-circuits to 'approved_all' immediately if the user has
        already opted in via the "Approve all destructive actions
        this session" button on a previous modal — no new pending
        approval is created in that case."""
        if self._state != "active" or self._active is None:
            return "no_session"
        if self._active.auto_approve_destructive:
            return "approved_all"

        approval = PendingDestructiveApproval(
            id=str(uuid.uuid4()),
            action=action,
            object_type=object_type,
            object_name=object_name or "(unnamed)",
            detail=detail or "",
            requested_at=datetime.now(timezone.utc),
            future=asyncio.get_running_loop().create_future(),
            tone=tone if tone in ("red", "amber") else "red",
        )
        self._pending_destructive[approval.id] = approval
        try:
            return await asyncio.wait_for(
                asyncio.shield(approval.future), timeout=timeout
            )
        except asyncio.TimeoutError:
            # Strip the approval from the queue on timeout — unlike
            # session requests, a stale destructive approval should
            # NOT linger in the popover. The MCP client retries by
            # re-issuing the destructive tool call, which spawns a
            # fresh approval.
            self._pending_destructive.pop(approval.id, None)
            return "timeout"
        finally:
            self._pending_destructive.pop(approval.id, None)

    def approve_destructive(self, approval_id: str) -> bool:
        """Resolve a pending destructive approval as approved.
        Returns True if the id was found, False otherwise."""
        approval = self._pending_destructive.pop(approval_id, None)
        if approval is None:
            return False
        if not approval.future.done():
            approval.future.set_result("approved")
        return True

    def deny_destructive(self, approval_id: str) -> bool:
        """Resolve a pending destructive approval as denied.
        Returns True if the id was found, False otherwise."""
        approval = self._pending_destructive.pop(approval_id, None)
        if approval is None:
            return False
        if not approval.future.done():
            approval.future.set_result("denied")
        return True

    def approve_all_destructive(self) -> bool:
        """User clicked "Approve all destructive actions this
        session" on the destructive-approval modal. Sets the
        session-scoped flag AND resolves every currently-pending
        destructive approval as `'approved_all'` so the AI doesn't
        have to retry them. Returns True if the flag was set
        (active session exists), False otherwise (no-op outside an
        active session)."""
        if self._state != "active" or self._active is None:
            return False
        self._active.auto_approve_destructive = True
        # Drain every pending approval as approved_all so the
        # waiting tools wake up and proceed.
        for approval in list(self._pending_destructive.values()):
            if not approval.future.done():
                approval.future.set_result("approved_all")
            self._pending_destructive.pop(approval.id, None)
        return True

    # ── Tool-call logging ────────────────────────────────────────

    def log_tool_call(self, entry: dict) -> None:
        """Append a tool-call entry to the currently active session's
        `tool_calls` list. No-op when state isn't `'active'` (a tool
        call that isn't inside a session has nothing to log into).

        Called by `mcp_server.py:_proxy_tool` after every successful
        invocation so the toolbar's session badge ticks up in
        near-real-time and the eventual review summary has a full
        ordered list of everything the MCP client did during the
        session.

        `entry` shape is open — Phase D may extend it with diff
        payloads, scene anchors, etc. The dataclass only cares
        about the entries' COUNT (via `len(tool_calls)`) for
        `tool_call_count` in the public dict; consumers that want
        details read the list directly off `_active.tool_calls`."""
        if self._state == "active" and self._active is not None:
            self._active.tool_calls.append(entry)

    # ── End-of-session ───────────────────────────────────────────

    def force_end_session(self) -> bool:
        """User force-ended the active session from the toolbar. Same
        state transition as `end_session(summary)` but the summary is
        a fixed "ended by user" string so the review view always has
        SOMETHING to display rather than an empty box. Returns True
        if there was an active session to end, False otherwise."""
        if self._state != "active" or self._active is None:
            return False
        return self.end_session("(session ended by user from the toolbar)")

    def end_session(self, summary: str) -> bool:
        """End the currently-active session. Transitions to `review`.
        Returns True if there was an active session to end, False
        if called while idle / requested. Called by the
        `end_mcp_session` MCP tool (Phase C2)."""
        if self._state != "active" or self._active is None:
            return False
        self._review = ReviewSummary(
            session_id=self._active.id,
            purpose=self._active.purpose,
            summary=summary or "",
            started_at=self._active.started_at,
            ended_at=datetime.now(timezone.utc),
            tool_call_count=len(self._active.tool_calls),
        )
        self._active = None
        self._state = "review"
        return True

    def dismiss_review(self) -> bool:
        """Clear the review summary and return to idle. Called from
        the frontend after the user dismisses the review view."""
        if self._state != "review":
            return False
        self._review = None
        self._state = "idle"
        return True

    # ── Internals ────────────────────────────────────────────────

    def _recompute_state_after_pending_drop(self) -> None:
        """After a pending request is removed (timeout / deny / etc.),
        if there are no others and we were in `requested`, fall back
        to idle. Never fires when state is `active` / `review` —
        the active session is independent of pending requests."""
        if self._state == "requested" and not self._pending:
            self._state = "idle"


# Module-level singleton — imported wherever the manager is needed.
session_manager = McpSessionManager()
