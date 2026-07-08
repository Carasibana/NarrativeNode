"""MCP server runtime control — Phase 2.1 Phase C1.

Owns the lifecycle of the secondary static-port MCP listener (port
13316). The main MCP server endpoint on the dynamic backend port is
unconditionally mounted by `main.py` and stays available whenever the
backend is running; this controller only governs the OPTIONAL second
listener bound to the stable A1Z26 port that external MCP clients
(Claude Desktop's `mcp-remote` shim, etc.) hardcode.

Why a controller (instead of always-on at lifespan startup):
1. **User opt-in** — Phase 2.1 ships with MCP disabled by default. The
   listener only binds when the user explicitly turns it on, either
   via the `mcp_auto_start` user preference (programmatic default for
   future launches) or via the runtime toggle in the MCP control
   button popover (override for THIS session only, doesn't touch
   the preference).
2. **Mid-session toggle** — the user can flip the listener on/off
   from the popover without restarting NarrativeNode. The controller
   manages the asyncio task + uvicorn shutdown signal so successive
   start/stop calls are idempotent.

Single-instance contract: only one listener task may be running at a
time per controller. `start()` is a no-op when already running.
`stop()` is a no-op when already stopped. State is queried via
`status()` (sync, safe to call from request handlers).

Failure modes surface via the listener task: bind failure (port busy)
is logged and the controller transitions back to `stopped` so the
frontend popover reflects the actual state instead of getting stuck
on a "starting" optimistic state. The recovery story for a busy
port is the same as before C1 — the user fixes the port conflict and
clicks the toggle again.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import uvicorn

# Static port — A1Z26 cipher of "MCP". Same constant as in main.py;
# centralised here so the control endpoints + popover URL pull from
# the same source.
MCP_STATIC_PORT = 13316
MCP_STATIC_HOST = "127.0.0.1"


# ──────────────────────────────────────────────────────────────────────────
# Tool-catalogue auto-regenerate
#
# The stdio wrapper (`backend/scripts/mcp_stdio_launcher.py`, Phase 2.14)
# advertises the full MCP tool catalogue to host apps (Claude Desktop /
# Claude Code) at handshake from a static JSON file. The wrapper boots
# clean even when NarrativeNode isn't running, which is the whole point
# of the wrapper — host apps stop reporting `narrativenode` as unhealthy
# just because NN happens to be offline at host launch time.
#
# Keeping that catalogue current is this file's job:
#   - Hash the source files that affect tool catalogue generation:
#     `services/mcp_server.py` (decorators + signatures) AND every
#     `.py` in `backend/models/` (Pydantic schema generation walks
#     type hints into model classes, so e.g. adding a new value to
#     `Entity.type`'s Literal changes every tool's inputSchema even
#     though `mcp_server.py` itself didn't change).
#   - Stamp that fingerprint into the catalogue file alongside the
#     tools list.
#   - At MCP-listener start, recompute the fingerprint and skip the
#     regenerate work when it matches the stamp.
#
# Gating: regeneration only runs when the MCP listener actually starts.
# Users who never enable MCP (`mcp_auto_start=False` and they don't
# click the toggle) incur zero overhead. When they do enable MCP,
# either at startup or mid-session, this fires.
#
# Cost on the no-change skip path: ~1 ms (measured on a release build:
# 11 files / ~430 KB, SHA-1 + JSON parse + comparison). Cost on the
# regen path: ~2-5 ms total. Both invisible against NN's ~2-5 s overall
# startup.
#
# Documented limitation: if a module OUTSIDE `mcp_server.py` +
# `backend/models/` ever affects tool schemas (we don't expect this
# but it's theoretically possible — e.g. a shared enum imported into
# a tool's signature), the catalogue can go stale. Workaround:
# delete `backend/scripts/mcp_catalogue.json` to force a one-time
# regen.
# ──────────────────────────────────────────────────────────────────────────

_BACKEND_DIR = Path(__file__).resolve().parent.parent
_CATALOGUE_PATH = _BACKEND_DIR / "scripts" / "mcp_catalogue.json"
_MCP_SERVER_SOURCE = _BACKEND_DIR / "services" / "mcp_server.py"
_MODELS_DIR = _BACKEND_DIR / "models"
_FINGERPRINT_KEY = "_source_fingerprint"


def _compute_source_fingerprint() -> str:
    """SHA-1 over the bytes of every Python file that affects the MCP
    tool catalogue. Deterministic file ordering so the same source
    tree always hashes to the same value. Returns the hex digest."""
    h = hashlib.sha1()
    files = [_MCP_SERVER_SOURCE]
    files.extend(sorted(_MODELS_DIR.glob("*.py")))
    for f in files:
        try:
            # Normalise line endings before hashing so the fingerprint is
            # identical regardless of the checkout's line-ending style
            # (core.autocrlf, .gitattributes, etc.). Without this the same
            # source tree hashes differently on a CRLF checkout vs an LF
            # one, so the catalogue regenerates on every machine whose
            # line endings differ from the committer's, surfacing as a
            # phantom local change that blocks `git pull`.
            h.update(f.read_bytes().replace(b"\r\n", b"\n"))
        except OSError:
            # File listed but missing — incorporate that into the hash
            # by mixing in the path, so a deleted-and-restored file
            # still triggers a regen.
            h.update(b"\x00MISSING:")
            h.update(str(f).encode("utf-8"))
            h.update(b"\x00")
    return h.hexdigest()


async def _ensure_catalogue_current() -> None:
    """Compare the live source fingerprint to the one stamped in the
    existing catalogue file. If they match, do nothing. If they
    differ (or the file is missing / corrupt), regenerate from the
    in-process FastMCP instance and write atomically.

    Never raises — any failure is logged to stderr and the listener
    boot continues. A stale catalogue is a UX papercut on the wrapper
    side, not a reason to block the listener.
    """
    try:
        current = _compute_source_fingerprint()
    except Exception as exc:  # noqa: BLE001
        print(f"[mcp] catalogue fingerprint failed: {exc!r}", file=sys.stderr, flush=True)
        return

    stamped: Optional[str] = None
    if _CATALOGUE_PATH.exists():
        try:
            existing = json.loads(_CATALOGUE_PATH.read_text(encoding="utf-8"))
            stamped = existing.get(_FINGERPRINT_KEY)
        except (OSError, json.JSONDecodeError):
            stamped = None  # treat corrupt file as missing → regen

    if stamped == current:
        return  # fast skip path — common case

    try:
        from services import mcp_server as _mcp_server_module
        from services.llm_adapters.mcp_tool_bridge import strip_schema_titles
        tools = await _mcp_server_module.mcp.list_tools()
    except Exception as exc:  # noqa: BLE001
        print(f"[mcp] catalogue regen failed at list_tools(): {exc!r}", file=sys.stderr, flush=True)
        return

    catalogue = {
        _FINGERPRINT_KEY: current,
        "tools": [
            {
                "name": t.name,
                "description": t.description or "",
                "inputSchema": strip_schema_titles(t.inputSchema),
            }
            for t in tools
        ],
    }

    # Atomic write: write to .tmp then rename. Prevents a partial
    # write from leaving a corrupt JSON file that breaks the wrapper.
    tmp_path = _CATALOGUE_PATH.with_suffix(".json.tmp")
    try:
        tmp_path.parent.mkdir(parents=True, exist_ok=True)
        # Force LF so a regeneration produces byte-identical output on
        # every OS (Path.write_text would otherwise translate "\n" to the
        # platform line ending, i.e. CRLF on Windows, reintroducing churn).
        tmp_path.write_text(
            json.dumps(catalogue, indent=2) + "\n", encoding="utf-8", newline="\n"
        )
        os.replace(tmp_path, _CATALOGUE_PATH)
        print(
            f"[mcp] tool catalogue regenerated ({len(catalogue['tools'])} tools, "
            f"fingerprint {current[:12]}...)",
            file=sys.stderr,
            flush=True,
        )
    except OSError as exc:
        print(f"[mcp] catalogue write failed: {exc!r}", file=sys.stderr, flush=True)
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass


def static_url() -> str:
    """The hardcodable URL external MCP clients connect to. Matches
    the path FastMCP mounts at + the trailing slash MCP clients
    require for the streamable-http endpoint."""
    return f"http://{MCP_STATIC_HOST}:{MCP_STATIC_PORT}/mcp/server/"


@dataclass
class McpControlStatus:
    """Snapshot of the controller's state. Returned by `status()` and
    serialised to JSON by the control endpoints."""
    server_running: bool
    port: int
    url: str
    auto_start_pref: bool
    # Phase C2/C3 will populate these. Pre-wired with idle defaults
    # so the frontend store shape doesn't change between phases.
    session_state: str = "idle"
    pending_request_count: int = 0


class McpStaticListener:
    """Lifecycle manager for the static-port secondary MCP listener.

    Holds the uvicorn server instance + the asyncio task that runs it.
    `start(static_app)` accepts the FastAPI sub-app to serve (provided
    by `main.py` once at import time so the controller doesn't need
    to know about app construction) and binds it to the static port.

    Concurrency: all methods are called from the FastAPI event loop —
    the lifespan handler and request handlers both run there. No
    cross-thread coordination is needed.
    """

    def __init__(self) -> None:
        self._app = None
        self._server: Optional[uvicorn.Server] = None
        self._task: Optional[asyncio.Task] = None
        self._running: bool = False
        # The user preference that gates auto-start at lifespan
        # startup. Set by `main.py` from `user_preferences_service`
        # and re-read by `status()` so the popover can show
        # "Auto-start: On / Off — change in Settings".
        self._auto_start_pref: bool = False

    def bind_app(self, static_app) -> None:
        """Hand the controller the FastAPI sub-app it will serve.
        Called once at `main.py` import time. Splitting bind from
        start lets the controller defer the actual listen call until
        the user (or the preference) turns it on."""
        self._app = static_app

    def set_auto_start_pref(self, value: bool) -> None:
        self._auto_start_pref = bool(value)

    def status(self) -> McpControlStatus:
        return McpControlStatus(
            server_running=self._running,
            port=MCP_STATIC_PORT,
            url=static_url(),
            auto_start_pref=self._auto_start_pref,
        )

    async def start(self) -> McpControlStatus:
        """Start the static listener if not already running. Returns
        the current status snapshot (caller serialises). Idempotent."""
        if self._running:
            return self.status()
        if self._app is None:
            raise RuntimeError(
                "McpStaticListener.start() called before bind_app(). "
                "main.py must wire the sub-app before any lifespan hook."
            )

        # Refresh the stdio-wrapper catalogue from the live FastMCP
        # registry. Gated here (not in main.py lifespan) so users who
        # never enable MCP pay zero overhead. Hash-skip on the common
        # no-change path costs ~1 ms; the regen path runs only when
        # mcp_server.py or a backend/models file actually changed
        # since the last write.
        await _ensure_catalogue_current()

        config = uvicorn.Config(
            self._app,
            host=MCP_STATIC_HOST,
            port=MCP_STATIC_PORT,
            log_level="warning",
            lifespan="off",
        )
        server = uvicorn.Server(config)
        # `_running` flips to True BEFORE the task is awaited so a
        # subsequent start() call inside the same event-loop tick
        # sees it (no double-start). If `serve()` fails immediately
        # (port busy), the task body resets `_running` back to False.
        self._server = server
        self._running = True

        async def _serve():
            try:
                await server.serve()
            except BaseException as exc:  # noqa: BLE001
                # Bind failure / unexpected uvicorn exception. Reset
                # state so the frontend popover shows the real status
                # on its next poll. KeyboardInterrupt re-raises so
                # Ctrl+C still propagates to the main event loop.
                if isinstance(exc, KeyboardInterrupt):
                    self._running = False
                    raise
                print(
                    f"[mcp] static port {MCP_STATIC_PORT} listener "
                    f"failed: {exc!r}.",
                    file=sys.stderr,
                    flush=True,
                )
            finally:
                # Always settle to stopped — covers the normal
                # `should_exit` shutdown and the failure paths.
                self._running = False
                self._server = None

        self._task = asyncio.create_task(_serve())
        # Give the task a chance to attempt the bind before returning
        # so failure-on-start surfaces synchronously. Single yield:
        # enough for uvicorn.Server.serve() to fail fast on EADDRINUSE
        # but doesn't materially delay successful starts.
        await asyncio.sleep(0)
        return self.status()

    async def stop(self) -> McpControlStatus:
        """Stop the static listener if running. Returns the current
        status snapshot. Idempotent."""
        if not self._running or self._server is None:
            return self.status()
        self._server.should_exit = True
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except asyncio.TimeoutError:
                self._task.cancel()
            except KeyboardInterrupt:
                raise
            except BaseException:  # noqa: BLE001
                # Any error during shutdown — already logged inside
                # the task body. Swallow so the control endpoint
                # returns the post-stop status rather than 500ing.
                pass
        # The task's `finally` block resets these, but force them
        # here too in case the task was cancelled before reaching it.
        self._running = False
        self._task = None
        self._server = None
        return self.status()


# Module-level singleton. `main.py` calls `bind_app(...)` once at
# import time; the lifespan calls `start()` iff auto-start is enabled;
# the runtime control endpoints in `routers/mcp_control.py` call
# `start()` / `stop()` on user toggle.
mcp_static_listener = McpStaticListener()
