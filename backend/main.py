from contextlib import asynccontextmanager
from pathlib import Path
import logging
import os
import sys

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles


# Static MCP listener port — A1Z26 cipher of "MCP": M(13) C(3) P(16)
# concatenated = 13316. Chosen for stability so MCP clients (Claude
# Desktop, mcp inspect, etc.) can hardcode this URL once without
# worrying about NarrativeNode's main backend port shifting across
# launches due to the dynamic-port fallback in run.py. The main
# backend STILL runs on its dynamic port and exposes the MCP server
# there too; 13316 is an additional convenience listener that
# exposes ONLY the MCP routes (not the full API).
#
# Phase 2.1 Phase C1 — the listener is no longer started
# unconditionally at lifespan startup. The lifecycle is owned by
# `services/mcp_control.py:mcp_static_listener` and gated by the
# `mcp_auto_start` user preference + the runtime MCP control button
# in the toolbar. The constant is re-exported here for back-compat
# with any external caller that may have imported it.
from services.mcp_control import MCP_STATIC_PORT  # noqa: F401, E402  pylint: disable=wrong-import-position

# ──────────────────────────────────────────────────────────────────────────
# Program version — defined in version.py so that bumping it does not
# trigger a uvicorn reload during development (version.py is excluded
# from the watchfiles watch list in run.py). Imported here and re-exported
# so backend services that do `from main import PROGRAM_VERSION` continue
# to work unchanged. Must be imported BEFORE `from routers import ...`
# so transitive service imports see the binding on first access.
# ──────────────────────────────────────────────────────────────────────────
from version import PROGRAM_VERSION

from routers import project, entities, nodes, connections, story, custom_categories, preset_lists, project_tags, program_tags, export, entity_import, novelcrafter_import, seeds, default_seeds, user_preferences, file_association, relationships, knowledges, template_import, mcp_bridge, mcp_control, ai_models, ai_chat, system_prompts, system_prompt_categories, conversations, diagnostics, ai_context_cues, persona_preamble, scene_wiring, library, character_card


def _apply_startup_load_file() -> bool:
    """Read `NN_LOAD_FILE` from the environment and load the named project
    file into the backend's in-memory state before the server starts
    accepting requests. Called from the FastAPI lifespan handler below.

    Set by `run.py` when the user passes a project file path on the
    command line (`python run.py path\\to\\project.nnz`). When the env
    var is unset, this is a no-op and the server starts with whatever
    default empty state `state.get_story()` returns.

    On any failure — file missing, corrupt, save-format incompatible,
    migration error — this logs a clear message to stderr and continues
    with the default empty state. The server must never fail to start
    because of a bad `NN_LOAD_FILE` value; the user will see an empty
    project and can investigate the server log.

    Successful legacy `.nnplot` loads are renamed in place on disk via
    `file_service.upgrade_nnplot_to_nnz` so the active path + filename
    the user sees from this point forward uses the current extension.

    Returns True iff a file was loaded successfully. The caller uses
    this to decide whether to apply user-preference + default-seed
    defaults to the otherwise-empty startup state.
    """
    raw = os.environ.get("NN_LOAD_FILE")
    if not raw:
        return False

    # Imports are deliberately local so the module-level import chain
    # stays light (and avoids re-triggering the lifespan when uvicorn's
    # reload worker spawns a new process). Everything these functions
    # touch has already finished its own module initialisation by the
    # time the lifespan hook runs.
    from models.story import Story
    from services import file_service
    import state

    file_path = Path(raw)
    try:
        data = file_path.read_bytes()
        story_dict, seeds = file_service.unpack_project(data)
        loaded_story = Story.model_validate(story_dict)
        state.set_story(loaded_story)
        state.set_seeds(seeds)
        final_path = file_service.upgrade_nnplot_to_nnz(file_path)
        state.set_active_file_path(str(final_path))
        print(f"[NN_LOAD_FILE] loaded {final_path}", file=sys.stderr, flush=True)
        return True
    except FileNotFoundError:
        print(
            f"[NN_LOAD_FILE] file not found: {file_path!r}; "
            f"starting with empty state.",
            file=sys.stderr,
            flush=True,
        )
    except file_service.IncompatibleSaveError as exc:
        print(
            f"[NN_LOAD_FILE] incompatible save: {file_path!r} was written "
            f"by NarrativeNode {exc.file_version} and needs at least "
            f"version {exc.min_required} to load; this program is "
            f"{PROGRAM_VERSION}. Starting with empty state.",
            file=sys.stderr,
            flush=True,
        )
    except file_service.CorruptSaveError as exc:
        print(
            f"[NN_LOAD_FILE] corrupt save metadata in {file_path!r}: "
            f"{exc.detail}. Starting with empty state.",
            file=sys.stderr,
            flush=True,
        )
    except Exception as exc:
        print(
            f"[NN_LOAD_FILE] failed to load {file_path!r}: {exc!r}. "
            f"Starting with empty state.",
            file=sys.stderr,
            flush=True,
        )
    return False


@asynccontextmanager
async def _lifespan(app_instance: FastAPI):
    """FastAPI lifespan that runs startup hooks before the server
    starts accepting requests. Nothing to clean up on shutdown —
    state is process-scoped.

    Hooks (idempotent, any order):
    - Error log reset (delete so it only holds THIS session's failures;
      it was append-only before and accumulated stale cross-session errors).
    - `user_preferences.json` ensure-exists (recreates a blank file
      from the shipped schema if the user deleted theirs).
    - `NN_LOAD_FILE` project auto-load.
    - If no file was loaded, apply user preferences + default seeds
      to the startup-empty Story so the project the program opens
      with reflects the same defaults `/story/reset` would apply.
    - MCP server (Phase 2.1 Phase B) — start the FastMCP streamable
      session manager. FastMCP's mounted sub-app refuses requests
      with `RuntimeError("Task group is not initialized")` unless
      its session_manager is running inside an async context.
    """
    from services import user_preferences_service, system_prompts_service, error_log
    from services.mcp_server import mcp as mcp_server
    from services.mcp_control import mcp_static_listener
    # Start each session with a fresh error log so a downloaded log only
    # ever shows THIS run's failures, not stale entries from past sessions.
    error_log.reset_for_new_session()
    user_preferences_service.ensure_user_preferences_file()
    # Install any shipped system-prompt templates the writer hasn't
    # seen yet. Idempotent; safe to call on every launch.
    system_prompts_service.install_shipped_templates()
    loaded = _apply_startup_load_file()
    if not loaded:
        import state
        from routers.story import apply_user_defaults_to_fresh_story
        apply_user_defaults_to_fresh_story(state.get_story())

    # Read the auto-start preference and seed it into the controller.
    # The controller exposes it via `status()` so the frontend popover
    # can show "Auto-start: On / Off — change in Settings". The
    # PREFERENCE is the persistent default; the popover toggle is a
    # runtime override that does NOT touch the preference.
    prefs = user_preferences_service.read_user_preferences()
    auto_start = bool(getattr(prefs, "mcp_auto_start", False) or False)
    # Phase 5.7 — when AI integrations are disabled, the MCP server must
    # not auto-start at launch (a persisted "disabled" state should keep
    # the server off, matching the runtime teardown).
    if bool(getattr(prefs, "disable_ai_integrations", False) or False):
        auto_start = False
    mcp_static_listener.set_auto_start_pref(auto_start)
    mcp_static_listener.bind_app(_mcp_static_app)

    async with mcp_server.session_manager.run():
        # Phase C1 — only bind the static-port listener at lifespan
        # startup when the user has set `mcp_auto_start = True`. The
        # main `/mcp/server` mount on the dynamic backend port stays
        # up either way; the static listener is the OPTIONAL secondary
        # listener for clients hardcoding port 13316.
        if auto_start:
            await mcp_static_listener.start()
        try:
            yield
        finally:
            await mcp_static_listener.stop()


class _SuppressPollingPaths(logging.Filter):
    _SUPPRESSED = {"/project/pending-load-request"}

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3:
            path = str(args[2]).split("?")[0]
            if path in self._SUPPRESSED:
                return False
        return True


logging.getLogger("uvicorn.access").addFilter(_SuppressPollingPaths())

app = FastAPI(title="NarrativeNode API", version=PROGRAM_VERSION, lifespan=_lifespan)


def _dev_cors_origins() -> list[str]:
    """Build the CORS allow-list for the Vite dev server's frontend origin.

    The frontend port is picked dynamically by `run.py` at startup and
    handed to this process through the `NN_FRONTEND_PORT` env var. When
    the var is set, we allow just that origin (strict — only the exact
    port this run is using). When it isn't set (e.g. uvicorn launched
    standalone without run.py, or in prod where there is no separate
    frontend process at all), we return an empty list and no dev
    origins are allow-listed.

    Both `localhost` and `127.0.0.1` are included because browsers
    treat them as different origins for CORS purposes and users may
    open either one.
    """
    port = os.environ.get("NN_FRONTEND_PORT")
    if not port or not port.isdigit():
        return []
    return [
        f"http://localhost:{port}",
        f"http://127.0.0.1:{port}",
    ]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_dev_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# NOTE: an MCP-session REST gate middleware lived here briefly in
# v0.2.1.131 as a defence-in-depth layer (intent: block stale-tab REST
# writes from firing concurrent edits during an active MCP session).
# It was REMOVED in v0.2.1.133 because it broke the entire MCP write
# surface — the frontend's MCP tool handlers route most writes through
# canonical store actions in `projectStore.js` / `entitiesStore.js`,
# many of which persist entities / relationships / knowledges /
# preset_lists / custom_categories to the backend via direct
# `axios.post|put|delete('/api/...')` calls. Those legitimate
# MCP-driven REST writes were being blocked by the gate (returned 423
# Locked), making `create_entity` / `create_relationship` /
# `create_knowledge` and friends unusable mid-session.
#
# The cross-tab lockout modal (v0.2.1.131 + v0.2.1.132 broadening)
# remains the primary defence: any tab that isn't the bridge holder
# during an active session shows a full-window blocking modal that
# disables UI interaction entirely. The remaining edge case the REST
# gate was supposed to cover (devtools-driven writes from a stale tab)
# is genuinely fringe and not worth breaking the main MCP flow over.
#
# If a future iteration wants this back, it needs a way to distinguish
# the legitimate MCP-driven REST calls (which originate from the
# bridge holder tab as a side-effect of MCP tool execution) from
# rogue cross-tab writes. That probably means tagging axios requests
# with a per-tab identity header AND having the bridge tell the
# backend which tab id currently holds the bridge — sketched but not
# implemented as it isn't blocking anything today.

# All routers are registered TWICE: once at the bare prefix (for the
# Vite dev-server proxy, which strips `/api` before forwarding) and
# once under `/api` (for the production build, which is served by
# this same FastAPI process and has no proxy stripping the prefix).
# Without the `/api` mount, every frontend `/api/health` etc. request
# in production mode falls through to the StaticFiles mount at `/`
# and 404s — see the "Failed to connect to backend" symptom in
# v0.1.27.1.
_API_ROUTERS = [
    project.router,
    entities.router,
    custom_categories.router,
    preset_lists.router,
    project_tags.router,
    program_tags.router,
    nodes.router,
    connections.router,
    story.router,
    export.router,
    entity_import.router,
    novelcrafter_import.router,
    seeds.router,
    default_seeds.router,
    user_preferences.router,
    file_association.router,
    relationships.router,
    knowledges.router,
    template_import.router,
    mcp_bridge.router,
    mcp_control.router,
    ai_models.router,
    ai_chat.router,
    system_prompts.router,
    system_prompt_categories.router,
    persona_preamble.router,
    conversations.router,
    diagnostics.router,
    ai_context_cues.router,
    scene_wiring.router,
    library.router,
    character_card.router,
]
for _r in _API_ROUTERS:
    app.include_router(_r)                  # bare — `/story/...` etc.
    app.include_router(_r, prefix="/api")   # prefixed — `/api/story/...` etc.


# Phase 2.1 Phase B — MCP server. External MCP-aware clients (Claude
# Desktop, mcp inspect, scripts using the MCP SDK) connect at
# `/mcp/server` (or `/api/mcp/server`) using the Streamable HTTP
# transport. Each tool is a thin proxy that forwards the call over
# the WebSocket bridge in routers/mcp_bridge.py to the running
# frontend, where the existing chain-aware Zustand actions handle
# the call. The MCP server itself contains NO chain-aware logic.
#
# Mounted as a Starlette sub-app (FastMCP returns one). The mount
# path is intentionally `/mcp/server` rather than `/mcp` because the
# WebSocket bridge already lives at `/mcp/bridge`; mounting at `/mcp`
# would create a precedence conflict.
from services.mcp_server import mcp as _mcp_server  # noqa: E402
_mcp_app = _mcp_server.streamable_http_app()
app.mount("/mcp/server", _mcp_app)
app.mount("/api/mcp/server", _mcp_app)


# Secondary FastAPI app that exposes ONLY the MCP server routes. Bound
# to the static `MCP_STATIC_PORT` (13316) by the lifespan below so MCP
# clients can hardcode a stable URL. Shares the same `_mcp_app`
# instance with the main app, so both ports route to the same FastMCP
# server (and therefore the same WebSocket-bridge → frontend path).
# `lifespan=None` because the FastMCP session_manager is started by
# the MAIN app's lifespan; running it here too would double-init.
_mcp_static_app = FastAPI(title="NarrativeNode MCP (static port)", lifespan=None)
_mcp_static_app.mount("/mcp/server", _mcp_app)
_mcp_static_app.mount("/api/mcp/server", _mcp_app)


@app.get("/health")
@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/version")
@app.get("/api/version")
def version():
    """Program version — consumed by the About tab in the Settings
    panel. Cleaner than having the frontend parse `/openapi.json` just
    to read `info.version` (which is also set from PROGRAM_VERSION on
    app startup). Single source of truth is `PROGRAM_VERSION` in
    version.py."""
    return {"version": PROGRAM_VERSION}


# ── Third-party license texts ────────────────────────────────────────
# Files live in `THIRD_PARTY_LICENSES/` at the repo root. The frontend
# Thanks tab fetches these on click to render the upstream license
# text in a modal. 404 path is intentional: the frontend falls back to
# a "license file not found, here's the project page" message so the
# UX still works if a file is missing.
_THIRD_PARTY_LICENSES_DIR = Path(__file__).resolve().parents[1] / "THIRD_PARTY_LICENSES"


@app.get("/third-party-licenses/{filename}")
@app.get("/api/third-party-licenses/{filename}")
def get_third_party_license(filename: str):
    # Defence against path traversal: only allow plain stems with the
    # `.txt` suffix and no directory separators / parent-references.
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    if not filename.endswith(".txt"):
        raise HTTPException(status_code=400, detail="Invalid filename")
    target = _THIRD_PARTY_LICENSES_DIR / filename
    if not target.is_file():
        raise HTTPException(status_code=404, detail="License file not found")
    try:
        text = target.read_text(encoding="utf-8")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read license: {exc}")
    return Response(content=text, media_type="text/plain; charset=utf-8")


# ── Project licence ─────────────────────────────────────────────────────
# Serves the repo-root `LICENCE.md` (Canadian English noun form) as plain
# text so the About tab can fetch and show it in a modal (same pattern as
# the third-party licence endpoint above). Read-only. The URL path stays
# `/license` to mirror the existing `/third-party-licenses` route — URL
# paths are stable identifiers, not user-facing prose.
_LICENCE_PATH = Path(__file__).resolve().parents[1] / "LICENCE.md"


@app.get("/license")
@app.get("/api/license")
def get_licence():
    if not _LICENCE_PATH.is_file():
        raise HTTPException(status_code=404, detail="Licence file not found")
    try:
        text = _LICENCE_PATH.read_text(encoding="utf-8")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read licence: {exc}")
    return Response(content=text, media_type="text/plain; charset=utf-8")


# Serve built frontend in production (must be last)
frontend_dist = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.isdir(frontend_dist):
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
