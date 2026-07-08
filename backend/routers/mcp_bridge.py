"""WebSocket bridge between the FastAPI backend and the running frontend.

The MCP server (planned, Phase B+) does not own state. The frontend's
Zustand store does. This bridge lets the backend forward tool invocations
to whichever frontend tab is currently connected, where the existing
chain-aware actions handle them and return a result. Single source of
truth, no duplicate chain-aware logic, no GUI/MCP state-sync problem.

Phase A scope (this module):
- WebSocket endpoint at `/mcp/bridge` (also `/api/mcp/bridge` per the
  master `/api`-prefix mount in `main.py`).
- Connection manager — singleton, newest-wins on multi-tab connect (the
  superseded older connection receives a `superseded` message and is
  closed; pending tool invocations on it reject).
- Request/response correlation via `requestId`.
- Heartbeat ping/pong (5s interval, 15s detection threshold).
- Smoke-test endpoint `POST /mcp/bridge/smoke-test` that pushes a no-op
  `__noop__` tool over the bridge and returns the round-trip result.
- `GET /mcp/bridge/status` — connection introspection (whether a client
  is connected, last heartbeat timestamp).

Phase B+ adds:
- The MCP server itself (separate module), which calls
  `bridge.invoke_tool(name, args)` for each Claude-driven tool call.
- MCP Control state-machine integration: the bridge will start observing
  `session_state` messages from the frontend so the MCP server knows
  whether to refuse write tools (when the user has not yet granted
  control) or proceed (when ACTIVE).
"""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect


# ── Tunables ─────────────────────────────────────────────────────────────
# Tunables are module-level constants rather than env vars so the values
# are visible in code review and grep-able. Adjust here if real-world
# usage shows the defaults are wrong.

_HEARTBEAT_INTERVAL_S = 5.0      # ping cadence
_HEARTBEAT_TIMEOUT_S = 15.0      # silence threshold before declaring dead
_DEFAULT_INVOKE_TIMEOUT_S = 30.0 # per-tool wait — Phase B/D may override

router = APIRouter(prefix="/mcp", tags=["mcp"])


class BridgeManager:
    """Singleton coordinator for the bridge's single active client.

    Phase A enforces newest-wins for multi-tab: a second tab connecting
    supersedes the first. The superseded tab gets a `superseded` message
    so its UI can show "another session is active" before the close.
    Pending invocations on the superseded socket reject with
    `ConnectionError`.

    Public API used by callers:
      - `invoke_tool(tool, args, timeout=...)` — backend → frontend tool
        call. Awaitable; returns the frontend's `tool_result` envelope.
      - `is_connected` — read-only property for status reporting.
      - `last_pong_ts` — read-only, monotonic seconds; None until first
        pong arrives.

    The WebSocket lifecycle (connect / receive_loop / disconnect) is
    driven by the FastAPI route handler below; the manager just
    bookkeeps state.
    """

    def __init__(self) -> None:
        self._ws: Optional[WebSocket] = None
        self._pending: dict[str, asyncio.Future[dict]] = {}
        self._heartbeat_task: Optional[asyncio.Task[None]] = None
        self._last_pong_ts: Optional[float] = None
        self._send_lock = asyncio.Lock()  # `WebSocket.send_*` is not concurrency-safe

    # ── Connection lifecycle ────────────────────────────────────────────

    async def connect(self, ws: WebSocket) -> None:
        """Accept a new WebSocket connection.

        Multi-tab policy:
          - No prior client → just accept.
          - Prior client + no active MCP session → supersede the old
            client (newest-wins). The superseded tab gets a `superseded`
            message before close so its UI can react.
          - Prior client + ACTIVE MCP session → REJECT the new client
            so the running session in the existing tab doesn't lose
            its bridge mid-flow. The new tab gets a `rejected` message
            with `reason='session_active_in_other_tab'` before close
            so its UI can show a cross-tab lockout modal; the existing
            tab keeps the bridge and the running session untouched.
            Once the session ends (back to idle / review), newest-wins
            applies again.

        Starts the heartbeat task on accept."""
        # Local import to avoid the import cycle that would form if this
        # module were imported at module-import time from mcp_session's
        # side. session_manager itself doesn't depend on the bridge.
        from services.mcp_session import session_manager

        previous = self._ws

        if previous is not None and previous is not ws:
            if session_manager.state == "active":
                # First-wins-during-active-session: keep the existing
                # bridge holder, reject the newcomer. Send a `rejected`
                # message AND use a distinct custom close code so the
                # frontend can detect the rejection even if the close
                # event somehow fires before the message dispatch
                # handler runs (belt-and-suspenders for edge timing
                # cases — websocket protocol guarantees message order
                # but browser event timing is fuzzier).
                await ws.accept()
                try:
                    await ws.send_json({
                        "type": "rejected",
                        "reason": "session_active_in_other_tab",
                        "message": (
                            "An MCP session is active in another browser "
                            "tab or window. This tab cannot drive the "
                            "canvas while the session is in flight."
                        ),
                    })
                except Exception:
                    pass
                try:
                    # Custom application close code (4000-4999 range
                    # reserved for app use per RFC 6455). Frontend close
                    # handler checks for 4001 → treat as rejected even
                    # without the message.
                    await ws.close(code=4001)
                except Exception:
                    pass
                return

            # No active session — newest-wins (existing behaviour).
            await ws.accept()
            # Notify the old client and close it. Best-effort: if the old
            # socket is already broken we just move on.
            try:
                await previous.send_json({
                    "type": "superseded",
                    "reason": "another tab connected",
                })
            except Exception:
                pass
            try:
                await previous.close(code=1000)
            except Exception:
                pass
            # Reject pending invocations on the superseded socket.
            self._cancel_pending("superseded")
        else:
            await ws.accept()

        self._ws = ws
        self._last_pong_ts = time.monotonic()  # treat connect as a pong

        # Replace any prior heartbeat task (defensive — should be None).
        if self._heartbeat_task is not None and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def disconnect(self, ws: WebSocket) -> None:
        """Tear down the connection if `ws` is the current client.
        Idempotent — calling with a stale ws is a no-op."""
        if self._ws is not ws:
            return
        self._ws = None
        if self._heartbeat_task is not None and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
        self._heartbeat_task = None
        self._cancel_pending("disconnected")

    def _cancel_pending(self, reason: str) -> None:
        """Resolve every pending future with a ConnectionError so awaiting
        callers don't hang."""
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(ConnectionError(reason))
        self._pending.clear()

    # ── Inbound message dispatch ────────────────────────────────────────

    async def handle_message(self, msg: dict) -> None:
        """Route one inbound JSON message from the frontend. Called by
        the route handler's receive loop. Unknown / malformed messages
        are dropped silently — Phase B+ may add structured logging."""
        msg_type = msg.get("type")
        if msg_type == "tool_result":
            request_id = msg.get("requestId")
            future = self._pending.get(request_id) if isinstance(request_id, str) else None
            if future is not None and not future.done():
                # Forward the whole envelope so the caller can inspect
                # `ok`, `result`, `error`, and Phase B/D's `scoped`.
                future.set_result(msg)
        elif msg_type == "pong":
            self._last_pong_ts = time.monotonic()
        elif msg_type == "session_state":
            # Phase C wires this up; Phase A just acknowledges receipt.
            pass
        # Any other type — silently ignore. Forward-compat for future
        # message kinds the frontend may add.

    # ── Outbound tool invocation ────────────────────────────────────────

    async def invoke_tool(
        self,
        tool: str,
        args: Optional[dict] = None,
        *,
        timeout: float = _DEFAULT_INVOKE_TIMEOUT_S,
    ) -> dict:
        """Push one tool invocation over the bridge and await the
        frontend's `tool_result` envelope. Raises:
          - `ConnectionError("no client")` — no client is connected.
          - `ConnectionError("superseded" | "disconnected")` — connection
             dropped while the call was in flight.
          - `asyncio.TimeoutError` — frontend did not respond within
            `timeout` seconds.
        """
        if self._ws is None:
            raise ConnectionError("no client")

        request_id = str(uuid.uuid4())
        future: asyncio.Future[dict] = asyncio.get_event_loop().create_future()
        self._pending[request_id] = future

        envelope = {
            "type": "tool_invoke",
            "requestId": request_id,
            "tool": tool,
            "args": args or {},
        }

        try:
            async with self._send_lock:
                await self._ws.send_json(envelope)
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            # Whether resolved, errored, or timed out — drop the entry so
            # the dict doesn't grow unbounded under load.
            self._pending.pop(request_id, None)

    # ── Heartbeat ───────────────────────────────────────────────────────

    async def _heartbeat_loop(self) -> None:
        """Send a `ping` every `_HEARTBEAT_INTERVAL_S`. If no `pong` has
        arrived for `_HEARTBEAT_TIMEOUT_S`, declare the connection dead
        and tear it down. This catches half-open connections that
        `WebSocketDisconnect` would otherwise miss (network interruption
        without TCP RST)."""
        try:
            while self._ws is not None:
                ws = self._ws
                # Detection: silence > timeout → close.
                if (
                    self._last_pong_ts is not None
                    and time.monotonic() - self._last_pong_ts > _HEARTBEAT_TIMEOUT_S
                ):
                    try:
                        await ws.close(code=1011)  # internal error / heartbeat lost
                    except Exception:
                        pass
                    await self.disconnect(ws)
                    return

                try:
                    async with self._send_lock:
                        await ws.send_json({"type": "ping", "ts": time.monotonic()})
                except Exception:
                    # Send failed — connection is gone; the receive loop
                    # will catch the disconnect and call `disconnect()`.
                    return

                await asyncio.sleep(_HEARTBEAT_INTERVAL_S)
        except asyncio.CancelledError:
            return

    # ── Status introspection ────────────────────────────────────────────

    @property
    def is_connected(self) -> bool:
        return self._ws is not None

    @property
    def last_pong_ts(self) -> Optional[float]:
        return self._last_pong_ts


# Module-level singleton. Backend code that needs to call into the
# frontend imports this directly: `from routers.mcp_bridge import bridge`.
bridge = BridgeManager()


# ── HTTP + WebSocket routes ──────────────────────────────────────────────


@router.websocket("/bridge")
async def bridge_websocket(ws: WebSocket) -> None:
    """The frontend connects here on app start. Long-lived; one client
    at a time (newest wins). Receives an unbounded stream of JSON
    messages; routes each through the bridge manager."""
    await bridge.connect(ws)
    try:
        while True:
            msg = await ws.receive_json()
            await bridge.handle_message(msg)
    except WebSocketDisconnect:
        pass
    except Exception:
        # Any unexpected error tears down this connection but lets the
        # bridge accept new clients. Logging is intentionally minimal —
        # add structured logging in Phase B once we have something
        # interesting to record.
        pass
    finally:
        await bridge.disconnect(ws)


@router.get("/bridge/status")
def bridge_status() -> dict:
    """Connection introspection — used by tests, dev tooling, and
    eventually a connection-status indicator in the GUI."""
    last_pong = bridge.last_pong_ts
    silence_s = (time.monotonic() - last_pong) if last_pong is not None else None
    return {
        "connected": bridge.is_connected,
        "last_pong_ts": last_pong,
        "silence_s": silence_s,
        "heartbeat_interval_s": _HEARTBEAT_INTERVAL_S,
        "heartbeat_timeout_s": _HEARTBEAT_TIMEOUT_S,
    }


@router.post("/bridge/smoke-test")
async def bridge_smoke_test() -> dict:
    """Push a `__noop__` tool over the bridge and return the round-trip
    envelope. Validates that:
      - A frontend client is connected.
      - The bridge can serialise + send an outbound message.
      - The frontend's dispatcher receives + routes the message.
      - The dispatcher's response correlates correctly via `requestId`.
      - The result envelope round-trips back to this caller.

    The frontend is expected to handle `__noop__` by responding with
    `{ ok: true, result: { noop: true } }` (no state mutation, no
    side-effects). Any other response shape is reported as-is so a
    misbehaving dispatcher can be debugged.
    """
    try:
        envelope = await bridge.invoke_tool("__noop__", {}, timeout=10.0)
        return {"ok": True, "round_trip": envelope}
    except ConnectionError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="frontend did not respond within 10s")
