#!/usr/bin/env python3
"""
NarrativeNode first-time setup.
Run this once before using run.py or run.bat.

  python setup.py
"""
import hashlib
import subprocess
import sys
import os
import venv as venv_mod

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(ROOT, "backend")
FRONTEND = os.path.join(ROOT, "frontend")
VENV_DIR = os.path.join(ROOT, ".venv")
REQUIREMENTS_FILE = os.path.join(BACKEND, "requirements.txt")
REQUIREMENTS_STAMP = os.path.join(VENV_DIR, "requirements.sha1")
VENV_PYTHON = os.path.join(VENV_DIR, "Scripts", "python.exe") if sys.platform == "win32" \
    else os.path.join(VENV_DIR, "bin", "python")

# Minimum versions
MIN_PYTHON = (3, 11)
MIN_NODE = (22, 12)   # Vite 8 requires Node >=20.19 or >=22.12


def step(msg):
    print(f"\n>>> {msg}")


def check_python():
    if sys.version_info < MIN_PYTHON:
        print(f"ERROR: Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]}+ is required.")
        print(f"       You have Python {sys.version_info.major}.{sys.version_info.minor}.")
        print(f"       Download from https://www.python.org/downloads/")
        print(f"       Then re-run setup (python setup.py, or setup.bat on Windows).")
        sys.exit(1)
    print(f"  Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro} - OK")


def _probe_node():
    """Return (raw_version_str, parts_tuple), or raise: FileNotFoundError if no
    `node` is on PATH, OSError (e.g. PermissionError) if a `node` is found but
    can't be executed, or ValueError if its output can't be parsed."""
    result = subprocess.run(
        ["node", "--version"],
        capture_output=True, text=True,
        shell=sys.platform == "win32",
    )
    raw = result.stdout.strip().lstrip("v")  # e.g. "22.12.0"
    if not raw:
        raise ValueError("node --version returned empty output")
    parts = tuple(int(x) for x in raw.split(".")[:2])
    return raw, parts


def _node_version_ok(parts):
    # Vite 8 requires Node ^20.19 or >=22.12
    return (parts[0] == 20 and parts >= (20, 19)) or parts >= MIN_NODE


def _winget_install_node():
    """Try to install Node.js LTS via winget. Returns True if winget succeeded."""
    try:
        subprocess.check_call(
            ["winget", "install", "OpenJS.NodeJS.LTS",
             "--accept-package-agreements", "--accept-source-agreements"],
            shell=True,
        )
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


def check_node():
    raw, parts = "", ()
    needs_install = False
    upgrade = False

    try:
        raw, parts = _probe_node()
        if not _node_version_ok(parts):
            print(f"  Node.js {raw} found but version {MIN_NODE[0]}.{MIN_NODE[1]}+ is required.")
            needs_install = True
            upgrade = True
    except FileNotFoundError:
        print("  Node.js not found.")
        needs_install = True
    except OSError:
        # A `node` is on PATH but couldn't be executed (e.g. PermissionError).
        # Common in WSL, where a Windows-side node leaks in via PATH interop
        # without a Linux execute bit. Treat it as "no usable node".
        print("  Node.js found on PATH but could not be run.")
        needs_install = True
    except ValueError:
        print("  Could not parse Node.js version.")
        needs_install = True

    if needs_install:
        if sys.platform == "win32":
            # Offer the winget auto-install, but ask first — don't install
            # software behind the user's back. On yes (and winget present),
            # install and stop for a re-run so the new PATH takes effect. On
            # no / non-interactive stdin / winget failure, fall through to the
            # manual instructions below.
            verb = "Upgrade" if upgrade else "Install"
            gerund = "Upgrading" if upgrade else "Installing"
            try:
                answer = input(
                    f"  Node.js is required. {verb} Node.js LTS now via winget? [y/N] "
                ).strip().lower()
            except (EOFError, KeyboardInterrupt):
                answer = "n"
            if answer in ("y", "yes"):
                print(f"  {gerund} Node.js LTS via winget...")
                if _winget_install_node():
                    print("  Node.js installed.")
                    print("  IMPORTANT: Close this window and re-run setup.bat so the")
                    print("             new PATH takes effect.")
                    sys.exit(0)
                else:
                    print("  winget not available or installation failed.")

        # Fallback: manual instructions, tailored to the platform.
        print(f"ERROR: Node.js {MIN_NODE[0]}.{MIN_NODE[1]}+ is required.")
        if sys.platform == "win32":
            print("       Install via:  winget install OpenJS.NodeJS.LTS")
            print("       Or download:  https://nodejs.org/")
        elif sys.platform == "darwin":
            print("       Install via:  brew install node")
            print("       Or download:  https://nodejs.org/")
        else:
            print("       Install via your package manager, or nvm:")
            print("         https://github.com/nvm-sh/nvm   then:  nvm install 22")
            print("       Or download:  https://nodejs.org/")
        print("       Then re-run setup (python setup.py, or setup.bat on Windows).")
        sys.exit(1)

    print(f"  Node.js {raw} - OK")


def _maybe_prompt_file_association(is_first_time: bool) -> None:
    """First-time setup only: ask the user whether to register
    NarrativeNode as the default Windows handler for .nnz files.

    Skipped silently on:
    - Non-first-time runs (the venv was already there before setup
      started). The user has opted in or out before; re-running setup
      to refresh dependencies should not re-prompt.
    - Non-Windows platforms. File-association support is Windows-only
      for now; macOS and Linux equivalents are planned.
    - Non-interactive stdin (EOFError on input() — e.g. CI, piped
      stdin, setup running in a non-terminal context).
    - User interrupt (Ctrl+C during the prompt).

    Default is NO — the user must type `y` or `yes` to opt in. Enter
    by itself (empty response) is treated as no. Any registry error
    during registration is logged but does not fail setup; the rest
    of the installation continues normally and the user can retry
    registration later via `python run.py --associate` or
    `python associate_nnz.py`.
    """
    if not is_first_time:
        return
    if sys.platform != "win32":
        return

    step("Register NarrativeNode as the default program for .nnz files?")
    print("  When registered, double-clicking a .nnz file in Windows")
    print("  Explorer will open it directly in NarrativeNode.")
    print("  You can change this later at any time:")
    print("    python run.py --associate        (register)")
    print("    python run.py --disassociate     (unregister)")
    print("    python associate_nnz.py [--remove|--status]")
    print()

    try:
        answer = input("  Register now? [y/N] ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print("\n  Skipped.")
        return

    if answer not in ("y", "yes"):
        print("  Skipped. (You can register later with any of the commands above.)")
        return

    # Library is pure stdlib (winreg + pathlib + sys), so importing it
    # from the system Python that's running setup.py works cleanly —
    # no need to invoke VENV_PYTHON via subprocess just for this call.
    # The module lives under `backend/services/` and is resolved via the
    # `sys.path.insert(BACKEND)` on the previous line; Pylance can't
    # follow that runtime path mutation statically, hence the ignore.
    sys.path.insert(0, BACKEND)
    try:
        from services.file_association import register_file_association  # pyright: ignore[reportMissingImports]
        register_file_association()
    except Exception as exc:
        print(f"  ERROR: registration failed ({exc}).")
        print("  Setup will continue; you can retry registration later.")
        return

    print("  .nnz file association registered.")


def main():
    step("Checking requirements...")
    check_python()
    check_node()

    # Capture whether this is a fresh first-time setup BEFORE the venv
    # gets created below. Used later by `_maybe_prompt_file_association`
    # to decide whether to show the one-time .nnz registration prompt —
    # we don't want to re-pester the user every time they re-run setup
    # to refresh their dependencies after a git pull.
    is_first_time = not os.path.isfile(VENV_PYTHON)

    # 1. Virtual environment
    if os.path.isfile(VENV_PYTHON):
        step("Virtual environment already exists - skipping creation.")
    else:
        step("Creating virtual environment in .venv/ ...")
        venv_mod.create(VENV_DIR, with_pip=True)
        print("    Done.")

    # 2. Backend Python dependencies
    step("Installing backend dependencies...")
    subprocess.check_call([
        VENV_PYTHON, "-m", "pip", "install", "--upgrade", "pip", "--quiet",
    ])
    subprocess.check_call([
        VENV_PYTHON, "-m", "pip", "install", "-r", REQUIREMENTS_FILE,
    ])
    # Record a hash of the installed requirements.txt so run.py's
    # ensure_deps_current() check treats the venv as fresh and skips
    # its redundant pip install until the file is modified again.
    try:
        with open(REQUIREMENTS_FILE, "rb") as f:
            req_hash = hashlib.sha1(f.read()).hexdigest()
        with open(REQUIREMENTS_STAMP, "w") as f:
            f.write(req_hash)
    except OSError:
        pass
    print("    Done.")

    # 3. Frontend Node dependencies
    step("Installing frontend dependencies (npm install)...")
    subprocess.check_call(
        ["npm", "install"],
        cwd=FRONTEND,
        shell=sys.platform == "win32",
    )
    print("    Done.")

    # 4. Frontend production build. Produces frontend/dist/, which
    # `python run.py` (prod mode) serves directly via uvicorn. Without
    # this step, the user has to run `python run.py --dev` (which spins
    # up Vite) or manually `npm run build` before the prod launcher
    # works. Running the build at the end of setup means a fresh clone
    # is immediately runnable in either mode.
    step("Building frontend (npm run build)...")
    subprocess.check_call(
        ["npm", "run", "build"],
        cwd=FRONTEND,
        shell=sys.platform == "win32",
    )
    print("    Done.")

    # 5. First-time only: offer to register the .nnz file association.
    # No-op on re-runs, non-Windows, and non-interactive stdin.
    _maybe_prompt_file_association(is_first_time)

    print("\n" + "=" * 50)
    print("  Setup complete!")
    print("  Run the app:   python run.py")
    print("  Or double-click run.bat")
    print("  Dev mode:      python run.py --dev")
    print("=" * 50 + "\n")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as e:
        print(f"\nERROR: Setup failed (exit code {e.returncode})")
        sys.exit(1)
