#!/usr/bin/env python3
"""
NarrativeNode launcher.
Run setup.py first if you haven't already.

Usage:
  python run.py          # Production mode (serves built frontend)
  python run.py --dev    # Dev mode (FastAPI + Vite hot reload)
"""
import argparse
import hashlib
import json
import socket
import subprocess
import sys
import os
import tempfile
import threading
import time
import webbrowser
import urllib.request
import urllib.error

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(ROOT, "backend")
FRONTEND = os.path.join(ROOT, "frontend")
VENV_DIR = os.path.join(ROOT, ".venv")
REQUIREMENTS_FILE = os.path.join(BACKEND, "requirements.txt")
REQUIREMENTS_STAMP = os.path.join(VENV_DIR, "requirements.sha1")
ICO_PATH = os.path.join(ROOT, "assets", "NN.ico")
LOCKFILE_PATH = os.path.join(tempfile.gettempdir(), "narrativenode.lock")

_win32_job_handle = None  # kept alive by _setup_kill_on_close_job() to prevent premature GC


# ──────────────────────────────────────────────────────────────────────────
# Startup banner
#
# The NarrativeNode ASCII banner. It used to live only in run.bat /
# run_dev.bat, so it printed on Windows batch-file launches only. Printing
# it here shows it on every platform (macOS / Linux included). The art is a
# plain string: the `%%` doubling in the .bat was a batch escape (a literal
# `%` must be written `%%` there), NOT a Python requirement, so the percents
# here are single. Never apply the `%` operator to this string.
# ──────────────────────────────────────────────────────────────────────────

_BANNER_SEP = "================================================"
_BANNER_ART = """\
            =========         ========
            ==========       =========
           ============      =======++
           ==============    =======# -+
       :++-======-+++=====  =======##  :+
     :+:  ====%%%===++++++= +====+##  #####.
  :#####  ==%%%#%%==+====+==+++++###  #####.
  :#####  =%###### =++++++===+=#####  .#:
     #:  =%#######  ======##:######:##=
      #- =#######     #############
        =########      ############
        #########       ##########
        ########         #########"""


def _print_banner(dev_mode: bool) -> None:
    """Print the NarrativeNode ASCII startup banner. In dev mode the
    subtitle gains a [DEV MODE] suffix, matching what run_dev.bat printed.
    Cross-platform: every launch shows it, not just Windows batch-file
    launches."""
    subtitle = "    NarrativeNode - The Plot Planner"
    if dev_mode:
        subtitle += "   [DEV MODE]"
    print(_BANNER_SEP)
    print()
    print(_BANNER_ART)
    print()
    print(_BANNER_SEP)
    print(subtitle)
    print(_BANNER_SEP)
    print()


# ──────────────────────────────────────────────────────────────────────────
# Dynamic port selection
#
# Dev mode launches two servers (uvicorn for the backend, Vite for the
# frontend). Prod mode launches one (uvicorn serving the built frontend).
# Historically both ports were hardcoded — 8000 for the frontend and 8001
# for the backend — which caused two problems:
#
#   1. Stale URLs in the startup banner when anything moved.
#   2. Silent collisions when Vite's built-in auto-fallback landed on
#      uvicorn's port: Vite defaults `server.strictPort` to false, so a
#      `--port 8000` hint becomes a try-the-next-one loop if 8000 is busy,
#      and 8001 is exactly where we're spawning uvicorn.
#
# We now pick free ports up front via `_pick_free_port` before spawning
# anything, pass the chosen values into each subprocess via environment
# variables (NN_BACKEND_PORT / NN_FRONTEND_PORT), and set
# `server.strictPort: true` in `vite.config.js` so Vite fails hard if the
# handed-out port is somehow unavailable at bind time instead of silently
# walking into uvicorn's slot. The banner, browser opener, and CORS
# allow-list all read from the same picked values.
# ──────────────────────────────────────────────────────────────────────────

PORT_PROBE_LIMIT = 20  # max increments from a hint before we give up


def _validate_project_file(raw: str | None) -> str | None:
    """Validate a user-supplied project file path from the CLI.

    Returns the absolute path as a string if the user passed a valid
    `.nnz` or legacy `.nnplot` that exists on disk, or None if no file
    argument was provided. On any validation failure — wrong extension,
    file not found — prints a clear error to stderr and exits non-zero
    BEFORE any servers are spawned, so we fail fast.

    Legacy `.nnplot` is accepted here even though the current extension
    is `.nnz` — the backend's startup handler runs the same load +
    in-place rename pipeline the HTTP endpoints use, so a legacy file
    passed on the CLI ends up as `.nnz` on disk after successful load.
    """
    if raw is None:
        return None
    abs_path = os.path.abspath(raw)
    lower = abs_path.lower()
    if not (lower.endswith(".nnz") or lower.endswith(".nnplot")):
        print(
            f"ERROR: {abs_path!r} is not a NarrativeNode project file "
            f"(expected a .nnz or legacy .nnplot extension).",
            file=sys.stderr,
        )
        sys.exit(1)
    if not os.path.isfile(abs_path):
        print(f"ERROR: file not found: {abs_path!r}", file=sys.stderr)
        sys.exit(1)
    return abs_path


def _pick_free_port(hint: int, reserved: set[int] | None = None) -> int:
    """Return a currently-free TCP port at or after `hint`.

    Probes ports in the range [hint, hint + PORT_PROBE_LIMIT) by
    binding a socket to `127.0.0.1:<port>`, releasing it, and reporting
    the first one that succeeds. Ports listed in `reserved` are skipped
    so two back-to-back calls to this helper produce distinct results
    (the caller passes the first pick in when asking for the second).

    Raises RuntimeError if every port in the probe window is busy.

    NOTE: there is a brief window between the probe release and the
    real server's bind where another process could grab the port. Vite
    is configured with `server.strictPort: true` so it fails loud if
    that race hits the frontend; uvicorn fails with a clear OSError
    and non-zero exit which `run.py` surfaces via subprocess.wait().
    """
    reserved = reserved or set()
    for offset in range(PORT_PROBE_LIMIT):
        port = hint + offset
        if port in reserved:
            continue
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            # NOTE: deliberately NOT setting SO_REUSEADDR here. On
            # Windows, SO_REUSEADDR has weaker semantics than on Linux
            # and allows binding a port that is ALREADY bound exclusively
            # by another process, producing a false-positive "free"
            # reading. Without the flag, bind() correctly fails when the
            # port is in use — which is exactly what we want this probe
            # to detect.
            try:
                s.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError(
        f"Could not find a free port in range [{hint}, {hint + PORT_PROBE_LIMIT}). "
        f"Something is holding a lot of ports — check for stale NarrativeNode or "
        f"other dev-server processes and try again."
    )


# ──────────────────────────────────────────────────────────────────────────
# Single-instance lockfile + handoff
#
# When NarrativeNode is already running and the user double-clicks another
# .nnz file, the second run.py launch detects the existing instance via
# a lockfile, hands the file path off via HTTP, brings the existing
# browser tab to the foreground, and exits quietly — instead of spawning
# a second parallel server pair on different ports.
#
# The lockfile lives at `<tempdir>/narrativenode.lock` and contains a
# JSON blob with the backend port + PID so the second instance can probe
# whether the first is still alive. Written AFTER servers are ready (so a
# partial startup doesn't leave a stale lockfile); deleted on shutdown via
# try/finally in run_dev / run_prod.
#
# The handoff posts to POST /api/project/pending-load-request, which
# stashes the path without touching the story. The frontend's focus
# listener picks it up and routes it through the unsaved-changes guard.
# ──────────────────────────────────────────────────────────────────────────


def _write_lockfile(backend_port: int, frontend_port: int | None = None) -> None:
    """Write the lockfile after servers are ready. Contains enough info
    for a second instance to locate the running backend and hand off."""
    try:
        with open(LOCKFILE_PATH, "w") as f:
            json.dump({
                "backend_port": backend_port,
                "frontend_port": frontend_port,
                "pid": os.getpid(),
            }, f)
    except OSError:
        pass  # Non-fatal — worst case, the second instance can't detect us


def _remove_lockfile() -> None:
    """Delete the lockfile on shutdown."""
    try:
        os.remove(LOCKFILE_PATH)
    except OSError:
        pass


def _read_lockfile() -> dict | None:
    """Read the lockfile if it exists. Returns the parsed JSON dict, or
    None if the file is missing / unreadable / malformed."""
    try:
        with open(LOCKFILE_PATH, "r") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError, ValueError):
        return None


def _probe_running_instance(lock: dict) -> bool:
    """Ping the backend /health endpoint at the port recorded in the
    lockfile. Returns True if the instance is alive and responsive."""
    port = lock.get("backend_port")
    if not port:
        return False
    try:
        resp = urllib.request.urlopen(
            f"http://127.0.0.1:{port}/health", timeout=2
        )
        return resp.status == 200
    except Exception:
        return False


def _probe_frontend_alive(lock: dict) -> bool:
    """Query the running instance's /alive endpoint to check whether a
    browser tab has recently heartbeat'd in. Used by the handoff path to
    decide whether a second browser tab needs to be opened, or whether
    an existing tab's periodic poll will pick up the pending request.

    Returns False on any network error, malformed response, or when the
    backend reports no live frontend — in those cases the handoff path
    falls back to opening the browser explicitly.
    """
    port = lock.get("backend_port")
    if not port:
        return False
    try:
        resp = urllib.request.urlopen(
            f"http://127.0.0.1:{port}/project/alive", timeout=2
        )
        if resp.status != 200:
            return False
        payload = json.loads(resp.read().decode("utf-8"))
        return bool(payload.get("alive"))
    except Exception:
        return False


def _handoff_to_running_instance(lock: dict, file_path: str) -> bool:
    """Post the file path to the running instance's pending-load-request
    endpoint. Opens a fresh browser tab ONLY when no live tab is
    detected — otherwise relies on the existing tab's periodic poll to
    pick up the pending request.

    This split is the fix for the silent-data-loss race that earlier
    revisions had: unconditionally calling `webbrowser.open()` opened a
    second browser tab whose mount-time poll would consume the pending-
    load-request before the original tab's focus listener could ever
    fire. The original tab had unsaved work and didn't get its dirty-
    check guard — changes were silently discarded. Now:

      - If an existing tab is alive (recent frontend heartbeat): POST
        the pending request and exit. The tab's periodic poll catches
        it within ~1.5s and runs the 3-button unsaved-changes guard.
      - If no tab is alive (backend running but browser closed): POST
        the pending request AND open a fresh browser tab. The new tab
        has no unsaved work by definition, so its mount-time poll
        loads the file straight through.

    Returns True if the handoff POST succeeded (regardless of whether
    we opened the browser).
    """
    port = lock.get("backend_port")
    if not port:
        return False
    try:
        payload = json.dumps({"path": file_path}).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/project/pending-load-request",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=5)
        if resp.status != 200:
            return False
    except Exception:
        return False

    if _probe_frontend_alive(lock):
        # Existing tab's periodic poll will pick up the pending request
        # within ~1.5s and route it through the unsaved-changes guard.
        print("Pending request queued; existing browser tab will pick it up.", flush=True)
        return True

    # No live tab — open a fresh one so the user sees a reaction.
    frontend_port = lock.get("frontend_port") or lock.get("backend_port")
    webbrowser.open(f"http://localhost:{frontend_port}")
    return True


def _try_handoff(file_path: str | None) -> bool:
    """Check for a running instance and, if one exists AND we have a file
    to hand off, do the handoff and return True (caller should exit).
    Returns False if there's no running instance, no file to hand off,
    or the handoff fails for any reason — caller should continue with
    a fresh server launch.

    If there IS a running instance but no file to hand off (user just
    ran `python run.py` or `python run.py --dev` without a file), we
    still detect the instance but DON'T exit — the user might
    intentionally want a second instance. Only the file-association
    double-click case warrants a handoff.
    """
    if not file_path:
        return False
    lock = _read_lockfile()
    if not lock:
        return False
    if not _probe_running_instance(lock):
        # Stale lockfile from a crashed / terminated instance. Clean up
        # so it doesn't confuse the next launch.
        _remove_lockfile()
        return False
    # Running instance is alive and we have a file to hand off.
    print(
        f"NarrativeNode is already running (port {lock.get('backend_port')}). "
        f"Handing off {file_path} to the existing instance...",
        flush=True,
    )
    if _handoff_to_running_instance(lock, file_path):
        print("Handoff succeeded. Exiting.", flush=True)
        return True
    else:
        print(
            "Handoff failed. Starting a new instance instead.",
            flush=True,
        )
        return False


def _handle_association_flag(action: str) -> int:
    """Run a one-shot Windows file-association toggle and return an
    exit code. Called from the `--associate` / `--disassociate` flags
    in `run.py`'s main block BEFORE any venv / dependency / subprocess
    work — deliberately minimal so the user can toggle the association
    even on a machine where the venv is missing or broken.

    `action` is either "register" or "unregister". The actual registry
    work happens in `backend/services/file_association.py`; this
    wrapper handles sys.path plumbing so the import works from a
    repo-root run.py without making this file part of the backend
    package. Pairs with the standalone `associate_nnz.py` script —
    both are thin wrappers around the same library function, they
    exist so users can toggle the association through whichever
    entry point they prefer (the server launcher or the dedicated
    utility).
    """
    if BACKEND not in sys.path:
        sys.path.insert(0, BACKEND)

    try:
        from services.file_association import (
            UnsupportedPlatformError,
            is_file_association_registered,
            register_file_association,
            unregister_file_association,
        )
    except ImportError as exc:
        print(
            f"ERROR: could not import file_association module: {exc}",
            file=sys.stderr,
        )
        return 1

    try:
        if action == "register":
            register_file_association()
            print(".nnz file association: REGISTERED", flush=True)
        else:  # "unregister"
            unregister_file_association()
            print(".nnz file association: REMOVED", flush=True)
        state = "registered" if is_file_association_registered() else "not registered"
        print(f"  current state: {state}", flush=True)
        return 0
    except UnsupportedPlatformError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except PermissionError as exc:
        print(f"ERROR: permission denied writing to the registry: {exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"ERROR: registry operation failed: {exc}", file=sys.stderr)
        return 1


def _set_console_icon():
    """Set the console window icon on Windows using the app .ico file.

    Two mechanisms tried in sequence:
    1. SetCurrentProcessExplicitAppUserModelID — gives this process its
       own taskbar identity so Windows can look up its icon separately
       from the generic cmd.exe / Windows Terminal icon. Works on Win 10+
       when the taskbar groups by AUMID (which is most configurations).
    2. WM_SETICON on the console HWND — the classic technique. Works on
       classic cmd.exe / conhost.exe but not on Windows Terminal, which
       ignores per-window icon messages.

    Both are best-effort; if neither works on the user's Windows config,
    the taskbar shows the default console icon and nothing breaks.
    """
    if sys.platform != "win32" or not os.path.isfile(ICO_PATH):
        return
    try:
        import ctypes
        from ctypes import wintypes
        # AUMID: give this process a distinct taskbar identity. Tested
        # on Win 11 — does NOT fix the taskbar icon when the console is
        # hosted by Windows Terminal (the default on Win 11). Left in
        # because it doesn't hurt and may help on classic cmd / conhost
        # setups. A real fix requires a compiled .exe launcher with an
        # embedded icon resource; parked for the eventual "ship as a
        # standalone Windows app" effort.
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
            "NarrativeNode.App"
        )
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        hwnd = kernel32.GetConsoleWindow()
        if not hwnd:
            return
        icon = user32.LoadImageW(
            0, ICO_PATH, 1,  # IMAGE_ICON
            0, 0,
            0x00000010 | 0x00000040,  # LR_LOADFROMFILE | LR_DEFAULTSIZE
        )
        if icon:
            user32.SendMessageW(hwnd, 0x0080, 0, icon)  # WM_SETICON, ICON_SMALL
            user32.SendMessageW(hwnd, 0x0080, 1, icon)  # WM_SETICON, ICON_BIG
    except Exception:
        pass  # Non-critical — silently skip if anything fails
VENV_PYTHON = os.path.join(VENV_DIR, "Scripts", "python.exe") if sys.platform == "win32" \
    else os.path.join(VENV_DIR, "bin", "python")


def _open_when_ready(url: str, timeout: int = 30) -> None:
    """Poll url until it responds, then open it in the default browser."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=1)
            webbrowser.open(url)
            return
        except Exception:
            time.sleep(0.5)


def open_browser_when_ready(url: str) -> None:
    """Start a daemon thread that opens url once the server is up."""
    t = threading.Thread(target=_open_when_ready, args=(url,), daemon=True)
    t.start()


def check_setup():
    if not os.path.isfile(VENV_PYTHON):
        print("ERROR: Virtual environment not found.")
        print("       Run 'python setup.py' (or double-click setup.bat) first.")
        sys.exit(1)


def _requirements_hash() -> str:
    """SHA-1 of the current requirements.txt contents. Used as a
    cheap fingerprint to detect when dependencies have been added /
    changed since the last pip install."""
    try:
        with open(REQUIREMENTS_FILE, "rb") as f:
            return hashlib.sha1(f.read()).hexdigest()
    except OSError:
        return ""


def _stamped_hash() -> str:
    """Read the previously-installed requirements hash from the venv
    stamp file. Empty string if the stamp is missing or unreadable."""
    try:
        with open(REQUIREMENTS_STAMP, "r") as f:
            return f.read().strip()
    except OSError:
        return ""


def ensure_deps_current():
    """Re-run `pip install -r requirements.txt` when the file has
    changed since the last recorded install. No-op when the stamp
    file already matches the current requirements.txt hash, so normal
    runs have zero overhead. Runs automatically on `git pull` of new
    dependencies without requiring the user to re-run setup.py."""
    current = _requirements_hash()
    if not current:
        # requirements.txt missing — let setup.py catch this properly.
        return
    if current == _stamped_hash():
        return

    print(">>> requirements.txt changed since last install — syncing venv...")
    try:
        subprocess.check_call([
            VENV_PYTHON, "-m", "pip", "install", "-r", REQUIREMENTS_FILE,
        ])
    except subprocess.CalledProcessError as exc:
        print(f"ERROR: pip install failed (exit code {exc.returncode})")
        print("       Try running 'python setup.py' manually.")
        sys.exit(1)

    try:
        with open(REQUIREMENTS_STAMP, "w") as f:
            f.write(current)
    except OSError:
        # Non-fatal — the next run just repeats the no-op pip install.
        pass
    print("    Dependencies synced.\n")


# ──────────────────────────────────────────────────────────────────────────
# Frontend auto-rebuild
#
# Production mode serves the frontend out of `frontend/dist/`. Without
# this guard, editing a frontend source then launching `run.py` (prod)
# silently serves a stale build because the launcher never re-runs
# `npm run build`. The auto-rebuild compares the newest mtime across
# every input that meaningfully affects the build against the mtime of
# `dist/index.html`. If any source is newer, we run the build before
# starting the server.
#
# Dev mode (`run.py --dev`) bypasses this entirely — Vite serves
# directly from `src/` via HMR and never reads `dist/`, so rebuilding
# there would be pure waste.
# ──────────────────────────────────────────────────────────────────────────

_FRONTEND_BUILD_INPUTS = (
    "index.html",
    "vite.config.js",
    "package.json",
    "package-lock.json",
    "tailwind.config.js",
    "postcss.config.js",
    "eslint.config.js",
)


def _newest_frontend_source_mtime() -> float:
    """Newest mtime across every frontend file that meaningfully
    affects the build output. Walks `frontend/src/` recursively plus
    the top-level config files listed in `_FRONTEND_BUILD_INPUTS`.
    Returns 0.0 if the src tree doesn't exist (no sources, nothing to
    compare against).

    Deliberately ignores `node_modules/` (churn doesn't change build
    output for a given package-lock) and `dist/` itself (can't be
    newer than itself).
    """
    newest = 0.0
    src_dir = os.path.join(FRONTEND, "src")
    if os.path.isdir(src_dir):
        for root, _dirs, files in os.walk(src_dir):
            for name in files:
                try:
                    m = os.path.getmtime(os.path.join(root, name))
                    if m > newest:
                        newest = m
                except OSError:
                    pass
    for rel in _FRONTEND_BUILD_INPUTS:
        try:
            m = os.path.getmtime(os.path.join(FRONTEND, rel))
            if m > newest:
                newest = m
        except OSError:
            pass
    return newest


_BUILD_COMMIT_STAMP = os.path.join(FRONTEND, "dist", ".build-commit")


def _current_git_commit() -> str | None:
    """The current HEAD commit SHA, or None when this isn't a git
    checkout (e.g. a zip download) or git isn't on PATH. This is the
    PRIMARY frontend-build staleness signal: a `git pull` moves HEAD,
    which stays detectable even when the pulled files' mtimes don't end
    up newer than a previously-built dist/ (the exact failure mode an
    mtime-only check has, which silently serves a stale build)."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    sha = result.stdout.strip()
    return sha or None


def _read_build_commit_stamp() -> str | None:
    """The HEAD commit the current dist/ was built from, as recorded by
    the last successful build, or None when unstamped (a dist/ built
    before this stamping existed, a manual `npm run build`, or a failed
    stamp write). An unstamped dist/ is treated as needing a rebuild so
    the stamp becomes trustworthy from then on."""
    try:
        with open(_BUILD_COMMIT_STAMP, "r", encoding="utf-8") as fh:
            return fh.read().strip() or None
    except OSError:
        return None


def _write_build_commit_stamp(commit: str | None) -> None:
    """Record the HEAD commit dist/ was just built from. Best-effort: a
    failed write only costs one extra rebuild on the next launch. Lives
    inside dist/ so it is wiped together with the build it describes."""
    if not commit:
        return
    try:
        with open(_BUILD_COMMIT_STAMP, "w", encoding="utf-8") as fh:
            fh.write(commit)
    except OSError:
        pass


def ensure_frontend_built() -> None:
    """Rebuild `frontend/dist/` when any watched source file has been
    modified since the last build. No-op when `dist/index.html` is
    newer than every watched source, so a clean launch has zero
    overhead beyond a handful of os.stat() calls.

    Triggers `npm install` first when `node_modules/` is missing so a
    fresh checkout or post-clone launch works without a separate setup
    step.

    Only called from `run_prod()`. Dev mode bypasses this because Vite
    serves directly from `src/` via HMR and doesn't read from `dist/`.

    Exits non-zero on `npm install` or `npm run build` failure so the
    user sees the build error in the console (and `run.bat`'s
    `if errorlevel 1 pause` keeps the window open to read it).
    """
    newest_src = _newest_frontend_source_mtime()
    if newest_src == 0.0:
        # No sources found — defer to run_prod's own dist/ existence check
        # to produce the standard "build the app first" message.
        return
    dist_index = os.path.join(FRONTEND, "dist", "index.html")
    try:
        dist_mtime = os.path.getmtime(dist_index)
    except OSError:
        dist_mtime = 0.0
    # Decide whether a rebuild is needed using two independent signals,
    # because neither alone is reliable:
    #
    #   1. Git commit SHA (PRIMARY). `git pull` / `git checkout` does NOT
    #      guarantee that updated source files get mtimes newer than a
    #      dist/ built earlier, so an mtime-only check silently serves a
    #      stale build after an update. We stamp the HEAD commit dist/ was
    #      built from into `dist/.build-commit`; if HEAD has since moved,
    #      the build is stale no matter what the mtimes say.
    #   2. Source mtime (FALLBACK). Catches uncommitted local edits run in
    #      production mode (HEAD unchanged but a source file was saved);
    #      reliable there because saving a file sets a fresh mtime.
    #
    # When git is unavailable (zip download, git not on PATH) signal 1 is
    # simply absent and we fall back to the mtime check alone: the prior
    # behaviour, never worse.
    head_commit = _current_git_commit()
    stamped_commit = _read_build_commit_stamp()

    reason = None
    if dist_mtime == 0.0:
        reason = "frontend/dist/ missing or empty"
    elif head_commit is not None and head_commit != stamped_commit:
        reason = (
            "frontend build is unstamped (rebuilding to record its commit)"
            if stamped_commit is None
            else "frontend source commit changed since last build (e.g. a pull)"
        )
    elif dist_mtime < newest_src:
        reason = "frontend sources changed since last build"

    if reason is None:
        return  # Build is current; nothing to do.

    print(f">>> Rebuilding frontend: {reason}...")

    if not os.path.isdir(os.path.join(FRONTEND, "node_modules")):
        print("    Installing frontend dependencies (npm install)...")
        try:
            subprocess.check_call(
                ["npm", "install"],
                cwd=FRONTEND,
                shell=sys.platform == "win32",
            )
        except subprocess.CalledProcessError as exc:
            print(f"ERROR: npm install failed (exit code {exc.returncode})")
            sys.exit(1)

    print("    Running npm run build...")
    try:
        subprocess.check_call(
            ["npm", "run", "build"],
            cwd=FRONTEND,
            shell=sys.platform == "win32",
        )
    except subprocess.CalledProcessError as exc:
        print(f"ERROR: npm run build failed (exit code {exc.returncode})")
        sys.exit(1)
    # Record the commit dist/ was built from so the next launch detects a
    # pull/checkout that moved HEAD even when file mtimes don't reflect it.
    _write_build_commit_stamp(head_commit)
    print("    Frontend rebuilt.\n")


# ──────────────────────────────────────────────────────────────────────────
# Windows Job Object — kill-on-close guard
#
# When run.py exits for any reason (Ctrl+C, window close, crash), Windows
# normally leaves child subprocesses (uvicorn, node/Vite) running as
# orphans that hold their ports. A Job Object with KILL_ON_JOB_CLOSE fixes
# this: all processes assigned to the job are killed the moment run.py's
# last handle to the job closes, which happens automatically on exit.
#
# Best-effort: if creation or assignment fails (e.g. the process is
# already in an incompatible parent job), we fall back silently. The
# program is fully functional without the guard; Ctrl+C still works.
# ──────────────────────────────────────────────────────────────────────────

def _create_win32_job():
    """Create a Windows Job Object with KILL_ON_JOB_CLOSE. Returns the
    opaque job handle, or None on any failure or non-Windows platform."""
    if sys.platform != "win32":
        return None
    try:
        import ctypes, ctypes.wintypes
        kernel32 = ctypes.windll.kernel32

        class _BasicLimit(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit",     ctypes.c_int64),
                ("LimitFlags",             ctypes.wintypes.DWORD),
                ("MinimumWorkingSetSize",   ctypes.c_size_t),
                ("MaximumWorkingSetSize",   ctypes.c_size_t),
                ("ActiveProcessLimit",      ctypes.wintypes.DWORD),
                ("Affinity",               ctypes.c_void_p),
                ("PriorityClass",          ctypes.wintypes.DWORD),
                ("SchedulingClass",        ctypes.wintypes.DWORD),
            ]

        class _IoCounters(ctypes.Structure):
            _fields_ = [
                (f, ctypes.c_uint64) for f in (
                    "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                    "ReadTransferCount",  "WriteTransferCount",  "OtherTransferCount",
                )
            ]

        class _ExtLimit(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", _BasicLimit),
                ("IoInfo",               _IoCounters),
                ("ProcessMemoryLimit",    ctypes.c_size_t),
                ("JobMemoryLimit",        ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed",     ctypes.c_size_t),
            ]

        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = _ExtLimit()
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = kernel32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))
        if not ok:
            kernel32.CloseHandle(job)
            return None
        return job
    except Exception:
        return None


def _setup_kill_on_close_job() -> None:
    """Assign run.py's own process to a kill-on-close Job Object.

    Must be called before spawning any children. All subprocesses started
    afterward automatically inherit job membership. When run.py exits for
    any reason -- including a closed terminal window -- the OS tears down
    every process in the job simultaneously, leaving no orphaned node.exe
    or uvicorn workers behind.

    Best-effort: if the assignment fails (e.g. already inside a Windows job
    that disallows nesting), falls back silently. The program is fully
    functional without the guard; Ctrl+C still works via _kill_tree().
    """
    job = _create_win32_job()
    if job is None:
        return
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        kernel32.AssignProcessToJobObject(job, kernel32.GetCurrentProcess())
        global _win32_job_handle
        _win32_job_handle = job
    except Exception:
        pass


def _kill_tree(pid: int) -> None:
    """Kill a process and all its descendants.

    On Windows, uses taskkill /F /T which terminates the full process tree
    rooted at pid -- including grandchildren spawned by npm or uvicorn that
    .terminate() would leave behind. On other platforms, sends SIGTERM to
    the immediate process only.
    """
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True,
        )
    else:
        try:
            import signal as _signal
            os.kill(pid, _signal.SIGTERM)
        except ProcessLookupError:
            pass


# ──────────────────────────────────────────────────────────────────────────
# Animated terminal tab title
#
# Drives the tab title via OSC 0. The "compass-anchored" animation relies on
# combining marks (U+0307 above, U+0323 below) rendering at zero advance
# width. Some terminals (notably macOS Terminal.app and older Linux setups)
# treat combining marks as spacing chars, which makes the ℕ jitter
# horizontally — visible bug, not just cosmetic.
#
# Rather than guess by terminal name, we PROBE at startup: write a ℕ
# followed by a combining-dot-above, then query the cursor column via CSI 6n.
# If the cursor advanced by exactly one cell, combining marks rendered at
# zero width (correct) and we animate. Anything else (advance of 2, no
# response within timeout, can't enter raw mode) falls back to a single
# static "ℕ NarrativeNode" emit — no thread, no animation.
#
# The probe writes 2 chars then erases them with backspaces, so the user
# sees nothing in the terminal body. Runs once at launch.
# ──────────────────────────────────────────────────────────────────────────

# Compass-anchored frames — invisible characters written as \u escapes so
# editors / re-encodes can't silently downgrade NBSP to plain space or strip
# the combining marks. See tab_title_integration.md §4.
_NN_REST = " ℕ "          # NBSP + ℕ + NBSP: 3 cells wide, matches orbit frames so width never jitters
_NN_SEP = " | "                          # separator between animated icon field and label

# Per-frame hold durations (seconds). Indexed in parallel with _NN_FRAMES so
# the dot orbits with apparent velocity: fast on the "front" half of the orbit
# (right -> below -> left, coming toward the viewer), slow on the "back" half
# (left -> above -> right, moving away). Shorter hold = visually faster.
_NN_FRAME_HOLDS = (
    0.15,   # right  : entering the descent
    0.14,   # below  : front of orbit, fastest while still visible
    0.19,   # left   : starting the climb
    0.28,   # above  : back of orbit, slowest but never stops
)
_NN_FRAMES = (
    " ℕ·",  # 0 right: NBSP + N + middle-dot
    " ℕ̣ ",  # 1 below: NBSP + N + combining-dot-below + NBSP
    "·ℕ ",  # 2 left:  middle-dot + N + NBSP
    " ℕ̇ ",  # 3 above: NBSP + N + combining-dot-above + NBSP
)


def _enable_vt_on_windows() -> None:
    """Enable VT escape-sequence processing on Windows stdout AND stdin.

    Windows Terminal honours OSC natively, but legacy conhost needs the flag
    set. We also enable ENABLE_VIRTUAL_TERMINAL_INPUT on stdin so the CSI 6n
    cursor-position response from the terminal arrives as raw bytes we can
    parse, rather than being eaten by the line-buffered console input layer.
    No-op on non-Windows and on any failure (the title is cosmetic — never
    break startup over it).
    """
    if sys.platform != "win32":
        return
    try:
        import ctypes
        k = ctypes.windll.kernel32
        h_out = k.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
        m_out = ctypes.c_uint32()
        if k.GetConsoleMode(h_out, ctypes.byref(m_out)):
            k.SetConsoleMode(h_out, m_out.value | 0x0004)  # ENABLE_VIRTUAL_TERMINAL_PROCESSING
        h_in = k.GetStdHandle(-10)   # STD_INPUT_HANDLE
        m_in = ctypes.c_uint32()
        if k.GetConsoleMode(h_in, ctypes.byref(m_in)):
            k.SetConsoleMode(h_in, m_in.value | 0x0200)  # ENABLE_VIRTUAL_TERMINAL_INPUT
    except Exception:
        pass


def _parse_csi_cursor_response(buf: str) -> int | None:
    """Parse `ESC [ row ; col R` from buf, return 1-based col. None on parse
    failure. Tolerant of leading junk so a key buffered before the probe
    doesn't break detection."""
    i = buf.rfind("\033[")
    if i < 0:
        return None
    j = buf.find("R", i)
    if j < 0:
        return None
    parts = buf[i + 2:j].split(";")
    if len(parts) != 2:
        return None
    try:
        return int(parts[1])
    except ValueError:
        return None


def _query_cursor_col(timeout: float = 0.25) -> int | None:
    """Send CSI 6n and read the column from the terminal's reply.

    Returns the 1-based column the cursor is currently on, or None if the
    terminal doesn't respond within `timeout` seconds, can't be put into the
    right mode, or replies with something unparseable. Caller treats None as
    'unsupported, fall back to static'.
    """
    if sys.platform == "win32":
        try:
            import msvcrt
        except ImportError:
            return None
        try:
            sys.stdout.write("\033[6n")
            sys.stdout.flush()
            buf = ""
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if msvcrt.kbhit():
                    ch = msvcrt.getwch()
                    buf += ch
                    if ch == "R":
                        break
                else:
                    time.sleep(0.005)
            return _parse_csi_cursor_response(buf)
        except Exception:
            return None
    # POSIX path
    try:
        import termios
        import tty
        import select
    except ImportError:
        return None
    try:
        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
    except (termios.error, OSError, ValueError):
        return None
    try:
        tty.setcbreak(fd)
        sys.stdout.write("\033[6n")
        sys.stdout.flush()
        buf = ""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            r, _, _ = select.select([fd], [], [], max(0.0, deadline - time.monotonic()))
            if not r:
                break
            try:
                ch = os.read(fd, 32).decode("utf-8", "ignore")
            except OSError:
                break
            buf += ch
            if "R" in buf:
                break
        return _parse_csi_cursor_response(buf)
    finally:
        try:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)
        except Exception:
            pass


def _detect_combining_mark_support() -> bool:
    """Probe whether combining marks render at zero advance width.

    Writes ℕ + combining-dot-above, queries cursor column before and after,
    and erases the test characters with backspaces. If the column advanced
    by exactly 1 (the bare ℕ width), combining marks were applied as
    zero-width (correct rendering) → animation is safe. Any other outcome
    (advance of 2, probe failure, terminal silence) → static fallback.
    """
    if not sys.stdout.isatty() or not sys.stdin.isatty():
        return False
    _enable_vt_on_windows()
    baseline = _query_cursor_col()
    if baseline is None:
        return False
    sys.stdout.write("Ṅ")  # ℕ + combining-dot-above
    sys.stdout.flush()
    after = _query_cursor_col()
    if after is None:
        # Best-effort cleanup of whatever we just wrote so the user
        # doesn't see a stray Ṅ above the banner.
        sys.stdout.write("\b\b  \b\b")
        sys.stdout.flush()
        return False
    advance = after - baseline
    if advance > 0:
        sys.stdout.write("\b" * advance + " " * advance + "\b" * advance)
        sys.stdout.flush()
    return advance == 1


# Reassertion schedule (seconds after the initial emit) for the static
# fallback path. The static title is one-shot at heart, but child
# processes started around the same time (Vite finishing its dev-server
# startup, uvicorn printing its banner, npm wrapping its child) routinely
# stomp the title with their own OSC 0 within the first few seconds. The
# animated path defends against this by re-asserting every frame
# (~0.14–0.28 s) anyway as a side effect of cycling frames; the static
# path needs explicit catch-up. Each delay below is chosen to fire AFTER
# the next plausible hijack moment, not at a constant tick rate. After
# the last entry the schedule stops — by then the dev servers are quiet
# and the title is stable.
_STATIC_TITLE_REASSERT_DELAYS = (0.5, 1.5, 4.0, 10.0)


def _emit_static_title(label: str) -> None:
    """Single OSC 0 emit + a short series of delayed re-emits to reclaim
    the title after child-process hijacks (Vite / uvicorn startup, npm
    banners). The re-emits fire at the schedule in
    `_STATIC_TITLE_REASSERT_DELAYS` on a daemon thread; nothing runs
    after the last entry. No-op on non-TTY."""
    if not sys.stdout.isatty():
        return
    _enable_vt_on_windows()
    title_seq = "\033]0;" + label + _NN_SEP + _NN_REST + "\a"

    def emit_once() -> None:
        try:
            sys.stdout.write(title_seq)
            sys.stdout.flush()
        except Exception:
            pass

    emit_once()

    def reassert_loop() -> None:
        elapsed = 0.0
        for delay in _STATIC_TITLE_REASSERT_DELAYS:
            time.sleep(delay - elapsed)
            elapsed = delay
            emit_once()

    threading.Thread(target=reassert_loop, daemon=True, name="tab-title-static-reassert").start()


def start_tab_title(label: str):
    """Set the terminal tab title, animated if the terminal supports it.

    Detection runs once at call time. If the probe confirms combining-mark
    zero-width rendering, a daemon thread emits the compass-anchored orbit
    continuously with variable per-frame hold durations (see _NN_FRAME_HOLDS)
    so the dot speeds up on the front of the orbit and slows on the back.
    Each frame emit also re-asserts ownership of the title, so child
    processes (Node, Vite, uvicorn) cannot keep a stolen title for longer
    than one frame interval.

    Returns a `threading.Event` whose `.set()` stops the animator and leaves
    a clean static "<label> | ℕ" behind, OR None if there's no animation to
    stop (probe failed: static emit already done, OR stdout is not a TTY).

    Label comes FIRST in the title (before the separator and icon) so any
    width jitter in the icon frames only affects the trailing end of the
    title — the label stays anchored at the tab's left edge.
    """
    if not sys.stdout.isatty():
        return None
    if not _detect_combining_mark_support():
        _emit_static_title(label)
        return None
    stop = threading.Event()

    def emit(icon: str) -> None:
        try:
            sys.stdout.write("\033]0;" + label + _NN_SEP + icon + "\a")
            sys.stdout.flush()
        except Exception:
            pass

    def loop() -> None:
        while not stop.is_set():
            for frame, hold in zip(_NN_FRAMES, _NN_FRAME_HOLDS):
                if stop.is_set():
                    break
                emit(frame)
                stop.wait(hold)
        emit(_NN_REST)

    threading.Thread(target=loop, daemon=True, name="tab-title").start()
    return stop


def run_dev(load_file: str | None = None):
    # Pick free ports up front so the banner, the browser-open call, the
    # backend CORS list, and the Vite proxy all agree on reality. Backend
    # first so the frontend pick can reserve it; hints match the historical
    # defaults (8001 / 8000) so a clean machine gets the same ports it
    # always did.
    backend_port = _pick_free_port(8001)
    frontend_port = _pick_free_port(8000, reserved={backend_port})

    frontend_url = f"http://localhost:{frontend_port}"
    backend_url = f"http://localhost:{backend_port}"

    print("Starting NarrativeNode (dev mode)...", flush=True)
    print(f"  App:      {frontend_url}", flush=True)
    print(f"  API docs: {backend_url}/docs", flush=True)
    if load_file:
        print(f"  Opening:  {load_file}", flush=True)
    print("  Press Ctrl+C to stop.\n", flush=True)

    open_browser_when_ready(frontend_url)

    # Environment wiring: both processes inherit the picked ports so
    # backend/main.py can build its CORS allow-list, vite.config.js can
    # point its /api proxy at the real backend, and both servers bind
    # their own chosen ports. `NN_LOAD_FILE` (when set) tells the backend
    # startup handler to load a specific project file on launch.
    backend_env = os.environ.copy()
    backend_env["NN_BACKEND_PORT"] = str(backend_port)
    backend_env["NN_FRONTEND_PORT"] = str(frontend_port)
    # Dev-mode marker for the backend. Gates development-only diagnostics
    # such as the failed-tool-call log (services/dev_tool_call_log.py);
    # unset in production so those paths no-op.
    backend_env["NN_DEV_MODE"] = "1"
    if load_file:
        backend_env["NN_LOAD_FILE"] = load_file

    frontend_env = os.environ.copy()
    frontend_env["NN_BACKEND_PORT"] = str(backend_port)
    frontend_env["NN_FRONTEND_PORT"] = str(frontend_port)

    # Assign run.py itself to the kill-on-close job BEFORE spawning children.
    # All descendants (uvicorn worker, npm, node/Vite) automatically inherit
    # job membership, so they are cleaned up when run.py exits for any reason.
    _setup_kill_on_close_job()

    backend_proc = subprocess.Popen(
        [VENV_PYTHON, "-m", "uvicorn", "main:app", "--reload",
         "--reload-exclude", "version.py",
         "--port", str(backend_port)],
        cwd=BACKEND,
        env=backend_env,
    )
    # CREATE_NEW_PROCESS_GROUP isolates npm/cmd.exe from the console process
    # group so uvicorn's reload signal does not propagate into the frontend
    # and trigger the "Terminate batch job (Y/N)?" prompt on Ctrl+C.
    frontend_proc = subprocess.Popen(
        ["npm", "run", "dev"],
        cwd=FRONTEND,
        shell=sys.platform == "win32",
        env=frontend_env,
        creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0),
    )

    _write_lockfile(backend_port, frontend_port)
    tab = start_tab_title("NarrativeNode (dev)")
    try:
        backend_proc.wait()
        frontend_proc.wait()
    except KeyboardInterrupt:
        print("\nShutting down...")
        _kill_tree(backend_proc.pid)
        _kill_tree(frontend_proc.pid)
    finally:
        if tab:
            tab.set()
        _remove_lockfile()


def run_prod(load_file: str | None = None):
    # Auto-rebuild the frontend when sources are newer than dist/. No-op
    # when dist/ is current; runs `npm install` + `npm run build` when
    # stale. Dev mode bypasses this because Vite serves from src/.
    ensure_frontend_built()

    dist = os.path.join(FRONTEND, "dist")
    if not os.path.isdir(dist):
        print("ERROR: frontend/dist not found.")
        print("       Run 'npm run build' in frontend/ to build the app first,")
        print("       or use 'python run.py --dev' for development mode.")
        sys.exit(1)

    # Prod has exactly one server — uvicorn serving the built frontend
    # from the same origin — so only one port to pick. Hint is 8000
    # (historical default) because Vite isn't running in prod mode and
    # can't collide with us here.
    backend_port = _pick_free_port(8000)
    backend_url = f"http://localhost:{backend_port}"

    print("Starting NarrativeNode...", flush=True)
    print(f"  Opening {backend_url} in your browser...", flush=True)
    if load_file:
        print(f"  Opening:  {load_file}", flush=True)
    print("  Press Ctrl+C to stop.\n", flush=True)

    open_browser_when_ready(backend_url)

    backend_env = os.environ.copy()
    backend_env["NN_BACKEND_PORT"] = str(backend_port)
    if load_file:
        backend_env["NN_LOAD_FILE"] = load_file
    # Same-origin in prod — no separate frontend, so no CORS allow-list
    # entry needed. main.py's dev-origin logic no-ops when the env var
    # is unset.

    _setup_kill_on_close_job()

    backend_proc = subprocess.Popen(
        [VENV_PYTHON, "-m", "uvicorn", "main:app", "--port", str(backend_port)],
        cwd=BACKEND,
        env=backend_env,
    )

    _write_lockfile(backend_port)
    tab = start_tab_title("NarrativeNode")
    try:
        backend_proc.wait()
    except KeyboardInterrupt:
        print("\nShutting down...")
        _kill_tree(backend_proc.pid)
    finally:
        if tab:
            tab.set()
        _remove_lockfile()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="NarrativeNode launcher")
    parser.add_argument("--dev", action="store_true", help="Dev mode with hot reload")
    parser.add_argument(
        "file",
        nargs="?",
        default=None,
        help="Path to a .nnz project file to open on launch (optional)",
    )
    assoc_group = parser.add_mutually_exclusive_group()
    assoc_group.add_argument(
        "--associate",
        action="store_true",
        help="Register NarrativeNode as the Windows handler for .nnz files and exit without starting the app.",
    )
    assoc_group.add_argument(
        "--disassociate",
        action="store_true",
        help="Unregister NarrativeNode as the Windows handler for .nnz files and exit without starting the app.",
    )
    args = parser.parse_args()

    # Association flags are one-shot operations — they exit without
    # touching the venv, dependencies, or any subprocess. Handled
    # before check_setup() so the user can toggle the association
    # even on a machine with a missing or broken venv. Rejecting
    # combinations with --dev or a file path is explicit because
    # argparse's mutually_exclusive_group only handles mutex within
    # a single group.
    if args.associate or args.disassociate:
        if args.file is not None or args.dev:
            print(
                "ERROR: --associate / --disassociate are one-shot operations "
                "and cannot be combined with --dev or a project file path.",
                file=sys.stderr,
            )
            sys.exit(2)
        action = "register" if args.associate else "unregister"
        sys.exit(_handle_association_flag(action))

    _print_banner(args.dev)
    _set_console_icon()
    check_setup()
    ensure_deps_current()

    load_file = _validate_project_file(args.file)

    # Single-instance handoff: if NarrativeNode is already running AND
    # we have a file to hand off, post it to the existing instance and
    # exit. If no file was given (bare `run.py` or `run.py --dev`), we
    # don't hand off — the user might intentionally want a second
    # instance. Only the file-association double-click case warrants it.
    if _try_handoff(load_file):
        sys.exit(0)

    if args.dev:
        run_dev(load_file=load_file)
    else:
        run_prod(load_file=load_file)
