#!/usr/bin/env python3
"""Standalone script to register or unregister NarrativeNode as the
Windows handler for `.nnz` project files — including the document icon.

This is a one-shot utility that runs independently of the dev server:
no uvicorn, no Vite, no subprocess startup. It just flips the HKCU
registry entries that tell Windows which program to invoke when the
user double-clicks a `.nnz` in Explorer.

All the actual registry work lives in the library module at
`backend/services/file_association.py`; this script is a thin wrapper
that handles argparse, exit codes, and human-readable status output.
Kept at the repo root so the user can run it without `cd`ing into
`backend/` or remembering the module path.

Usage:
    python associate_nnz.py              # register (the default)
    python associate_nnz.py --remove     # unregister cleanly
    python associate_nnz.py --status     # show current state, exit 0
    python associate_nnz.py --help       # show argparse help

Exit codes:
    0 — success, or --status reported cleanly
    1 — registry operation failed (permission denied, OSError, etc.)
    2 — platform does not support file association yet (non-Windows);
        macOS / Linux support is a stretch goal per the Phase 1.13
        OS File Association plan doc.

What gets registered:

- The `.nnz` extension maps to a `NarrativeNode.nnz` ProgID in HKCU.
- The ProgID's friendly name is "NarrativeNode Project".
- The ProgID's DefaultIcon points at `<repo>/assets/NNZ.ico`, so
  Windows Explorer shows the NarrativeNode document icon on `.nnz`
  files.
- The ProgID's shell-open command is `"<repo>/run.bat" "%1"`, so
  double-clicking a `.nnz` invokes `run.bat` with the file path as
  its first argument. `run.bat` forwards that arg to `python run.py`
  via its `%*` pass-through, which landed in v0.1.13.13's Track 1
  CLI-positional-arg work.

Everything is scoped to HKCU (current user) so no admin rights are
needed. A per-user association is the right default for a
dev-stack source distribution where each user is running their own
copy of the repo from their own checkout.

Stale-registration handling: `is_file_association_registered()` in
the library module returns False if the registry entry points at a
DIFFERENT repo's `run.bat` than this script's location. So if you
`git clone` NarrativeNode to a new directory and run this script,
the old registration from the previous clone will be reported as
"not registered" (even though HKCU still has entries pointing at
the stale location), and re-running `python associate_nnz.py`
from the new clone will overwrite them to point at the new path.
"""

from __future__ import annotations

import argparse
import os
import sys

# Library module lives under backend/services/. Add backend/ to sys.path
# so we can import it directly without making this script part of the
# backend package. The library has zero third-party dependencies so it
# imports cleanly without needing the venv activated.
_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.join(_HERE, "backend")
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from services.file_association import (  # noqa: E402
    UnsupportedPlatformError,
    is_file_association_registered,
    register_file_association,
    unregister_file_association,
)
from services.file_association import _RUN_BAT_PATH, _ICON_PATH  # noqa: E402


def _status_line() -> str:
    """Human-readable one-liner describing the current state of the
    .nnz file association on this platform."""
    if sys.platform != "win32":
        return f"not supported on {sys.platform} (Windows only for now)"
    return "registered" if is_file_association_registered() else "not registered"


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="associate_nnz.py",
        description=(
            "Register or unregister NarrativeNode as the Windows handler "
            "for .nnz project files. Writes HKCU-scoped registry entries "
            "so no admin rights are required. Runs independently of the "
            "dev server."
        ),
        epilog=(
            "With no flags, registers the association (idempotent: safe "
            "to run repeatedly). Use --remove to unregister, or --status "
            "to check the current state without changing anything."
        ),
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--remove",
        action="store_true",
        help="Unregister the association (default action is to register).",
    )
    group.add_argument(
        "--status",
        action="store_true",
        help="Show the current registration state and exit without changes.",
    )
    args = parser.parse_args()

    if args.status:
        print(f".nnz file association: {_status_line()}")
        return 0

    try:
        if args.remove:
            unregister_file_association()
            print(".nnz file association: REMOVED")
        else:
            register_file_association()
            print(".nnz file association: REGISTERED")
            print(f"  handler: {_RUN_BAT_PATH}")
            print(f"  icon:    {_ICON_PATH}")
        print(f"  current state: {_status_line()}")
        return 0
    except UnsupportedPlatformError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except PermissionError as exc:
        print(
            f"ERROR: permission denied writing to the registry: {exc}",
            file=sys.stderr,
        )
        return 1
    except OSError as exc:
        print(f"ERROR: registry operation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
