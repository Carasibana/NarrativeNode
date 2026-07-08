"""Windows file-association registration for NarrativeNode project files.

Exposes three public functions — `register_file_association`,
`unregister_file_association`, and `is_file_association_registered` —
that manipulate HKCU-scoped registry entries so double-clicking a `.nnz`
file in Windows Explorer launches NarrativeNode (via `run.bat`) with
that project preloaded.

Scope:

- **Windows only.** Non-Windows platforms raise `NotImplementedError`
  with a clear message; macOS `.app` / Linux `.desktop` equivalents
  are planned.
- **Current user only (HKCU), not machine-wide (HKLM).** HKCU writes
  don't require admin rights, and a per-user association is the right
  default for a dev-stack source distribution where each user is
  running their own copy of the repo from their own checkout.
- **This module is the library layer, not the UX.** It exposes the
  register / unregister / query functions but does not wire them into
  any caller. The three planned call sites — Settings panel toggle,
  `setup.py` first-time prompt, and `run.py --associate` CLI flag —
  all land in Track 4 (see the planning doc) and import from here.

Registry layout written by `register_file_association`:

    HKCU\\Software\\Classes\\.nnz                             → "NarrativeNode.nnz"
    HKCU\\Software\\Classes\\NarrativeNode.nnz                 → "NarrativeNode Project"
    HKCU\\Software\\Classes\\NarrativeNode.nnz\\DefaultIcon    → "<repo>\\assets\\NNZ.ico"
    HKCU\\Software\\Classes\\NarrativeNode.nnz\\shell\\open
        Icon                                                   → "<repo>\\assets\\NNZ.ico"
        FriendlyAppName                                        → "NarrativeNode"
    HKCU\\Software\\Classes\\NarrativeNode.nnz\\shell\\open\\command
                                                              → "<repo>\\run.bat" "%1"
    HKCU\\Software\\Classes\\Applications\\run.bat
        FriendlyAppName                                        → "NarrativeNode"
    HKCU\\Software\\Classes\\Applications\\run.bat\\DefaultIcon
                                                              → "<repo>\\assets\\NNZ.ico"

The `shell\\open\\Icon` value puts the NNZ icon next to the "Open"
entry in Explorer's right-click menu; without it Windows falls back
to the icon of the exe in `shell\\open\\command`, which is `run.bat`
(a script with no embedded icon → generic blank icon).

The `Applications\\run.bat` subtree fixes the "Open with" dialog —
Windows reads the display name and icon from there when the target
is a `.bat` (since batch files carry no PE version info). Note that
this key is keyed by bare filename, so if the user happens to have
unrelated tooling that also uses `run.bat` the `FriendlyAppName`
will collide; the unregister step removes only values we wrote and
leaves any foreign keys alone as a courtesy.

`unregister_file_association` recursively deletes the `NarrativeNode.nnz`
ProgID subtree plus the `.nnz` extension mapping. Idempotent — no-ops if
the keys don't exist, so repeated calls are safe.

`is_file_association_registered` returns True only if the extension key
maps to the correct ProgID AND the ProgID's shell-open command points
at THIS specific repo's `run.bat` (via absolute-path comparison). Stale
registrations from a different clone of the repo report as NOT
registered, so the UX layer can offer a re-register option that points
at the current location instead of silently leaving a dead handler in
place.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Repo root is derived from this module's location — `file_association.py`
# lives at `<repo>/backend/services/file_association.py`, so three levels
# up is the repo root. Using `resolve()` follows symlinks so a symlinked
# checkout still gets the real absolute path Windows wants.
_MODULE_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _MODULE_DIR.parent.parent

_RUN_BAT_PATH = _REPO_ROOT / "run.bat"
_ICON_PATH = _REPO_ROOT / "assets" / "NNZ.ico"

# Registry key paths. All HKCU-scoped; `HKEY_CURRENT_USER\\Software\\Classes`
# is the per-user mirror of the machine-wide `HKEY_CLASSES_ROOT`.
_EXT_KEY = r"Software\Classes\.nnz"
_PROG_ID = "NarrativeNode.nnz"
_PROG_KEY = rf"Software\Classes\{_PROG_ID}"
_ICON_KEY = rf"{_PROG_KEY}\DefaultIcon"
_OPEN_KEY = rf"{_PROG_KEY}\shell\open"
_COMMAND_KEY = rf"{_OPEN_KEY}\command"

# Per-basename Applications subtree — Windows looks here for the
# "Open with" dialog's display name and icon when the target is a
# .bat (no PE version info). Keyed on the bare filename rather
# than a path, which is how Windows indexes it.
_APPLICATIONS_KEY = r"Software\Classes\Applications\run.bat"
_APPLICATIONS_ICON_KEY = rf"{_APPLICATIONS_KEY}\DefaultIcon"

_FRIENDLY_NAME = "NarrativeNode Project"
_FRIENDLY_APP_NAME = "NarrativeNode"


class UnsupportedPlatformError(NotImplementedError):
    """Raised when a file-association function is called on a platform
    where no implementation exists yet (currently anything that isn't
    Windows). Subclasses NotImplementedError so callers that don't care
    about the distinction can still catch it with a broader except."""


def _require_windows() -> None:
    if sys.platform != "win32":
        raise UnsupportedPlatformError(
            f"File-association registration is only implemented for "
            f"Windows. Current platform: {sys.platform}. macOS and Linux "
            f"support is planned."
        )


def _expected_command() -> str:
    """The exact string the shell\\open\\command value should hold after
    a successful `register_file_association` call. Centralised so
    `register_file_association` and `is_file_association_registered`
    can't drift out of agreement about the format."""
    return f'"{_RUN_BAT_PATH}" "%1"'


def _expected_icon() -> str:
    """The exact string every icon registry value should hold.
    Conventional Windows shell format: `path,index` with no
    surrounding quotes. Unlike `shell\\open\\command` (which is
    parsed with argv-style quote handling), the various icon-value
    parsers in the shell are strict and treat `"..."` as a literal
    filename containing quote characters — which naturally fails to
    resolve, silently falling back to a generic blank icon."""
    return f"{_ICON_PATH},0"


def register_file_association() -> None:
    """Write the HKCU-scoped registry entries that make Windows treat
    NarrativeNode as the handler for `.nnz` files. Idempotent — safe to
    call even if the association already exists; repeat calls just
    rewrite the same values.

    Raises `UnsupportedPlatformError` on non-Windows platforms. Other
    errors (permission denied, registry corruption, winreg API failure)
    propagate as whatever exception `winreg` raises, typically
    `PermissionError` or `OSError`. Callers in the UX layer should
    catch these and surface a user-readable error.
    """
    _require_windows()
    import winreg  # Windows-only stdlib module, imported lazily.

    # .nnz extension → ProgID.
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, _EXT_KEY) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, _PROG_ID)

    # ProgID friendly name — shown in Explorer's "Type" column and in
    # the "Open with" dialog.
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, _PROG_KEY) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, _FRIENDLY_NAME)

    # DefaultIcon — Explorer reads this to render file-type thumbnails.
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, _ICON_KEY) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, _expected_icon())

    # shell\open key — Icon shows next to the "Open" entry in the
    # right-click menu; FriendlyAppName is a secondary source the
    # "Open with" dialog also consults.
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, _OPEN_KEY) as key:
        winreg.SetValueEx(key, "Icon", 0, winreg.REG_SZ, _expected_icon())
        winreg.SetValueEx(key, "FriendlyAppName", 0, winreg.REG_SZ, _FRIENDLY_APP_NAME)

    # shell\open\command — the actual command line Windows invokes on
    # double-click. %1 is substituted with the clicked file's path.
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, _COMMAND_KEY) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, _expected_command())

    # Applications\run.bat — primary source the "Open with" dialog
    # reads for program display name and icon. Without these the
    # dialog shows "run.bat" (the filename) and a generic icon.
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, _APPLICATIONS_KEY) as key:
        winreg.SetValueEx(key, "FriendlyAppName", 0, winreg.REG_SZ, _FRIENDLY_APP_NAME)
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, _APPLICATIONS_ICON_KEY) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, _expected_icon())


def unregister_file_association() -> None:
    """Remove every HKCU registry entry that `register_file_association`
    writes. Idempotent — no-ops cleanly if any of the keys are already
    missing, so callers can use this as a "make sure not registered"
    primitive without a prior check. Raises `UnsupportedPlatformError`
    on non-Windows platforms.
    """
    _require_windows()
    import winreg

    def _delete_tree(root, subkey: str) -> None:
        """Recursively delete a registry key and all its subkeys.
        `winreg.DeleteKey` refuses non-leaf keys on Windows, so we
        have to walk the subkeys depth-first and delete the leaves
        first. No-op if the top-level key doesn't exist."""
        try:
            with winreg.OpenKey(root, subkey, 0, winreg.KEY_READ | winreg.KEY_WRITE) as key:
                while True:
                    try:
                        child = winreg.EnumKey(key, 0)
                    except OSError:
                        # No more subkeys — EnumKey raises when index
                        # is past the end of the subkey list.
                        break
                    _delete_tree(key, child)
            winreg.DeleteKey(root, subkey)
        except FileNotFoundError:
            pass

    # Order matters — delete the ProgID subtree first so that the
    # extension key's deletion doesn't orphan anything. Actually it
    # doesn't matter functionally (HKCU\Classes is flat at this level),
    # but it matches the forward "register" order in reverse.
    _delete_tree(winreg.HKEY_CURRENT_USER, _PROG_KEY)
    _delete_tree(winreg.HKEY_CURRENT_USER, _EXT_KEY)

    # Applications\run.bat cleanup. Surgical rather than wholesale:
    # some unrelated tool might legitimately use the same bare
    # `run.bat` filename, so we only remove the specific values /
    # subkeys we wrote, and only delete the parent key itself if
    # it's now empty. If anything foreign is in there it stays.
    _delete_value(winreg.HKEY_CURRENT_USER, _APPLICATIONS_KEY, "FriendlyAppName")
    _delete_tree(winreg.HKEY_CURRENT_USER, _APPLICATIONS_ICON_KEY)
    _delete_key_if_empty(winreg.HKEY_CURRENT_USER, _APPLICATIONS_KEY)


def _delete_value(root, subkey: str, name: str) -> None:
    """Delete a single named value from a registry key. No-ops
    cleanly if the key or value doesn't exist."""
    import winreg
    try:
        with winreg.OpenKey(root, subkey, 0, winreg.KEY_SET_VALUE) as key:
            winreg.DeleteValue(key, name)
    except FileNotFoundError:
        pass


def _delete_key_if_empty(root, subkey: str) -> None:
    """Delete `subkey` only if it has no subkeys AND no values.
    Lets us clean up our own additions without stomping on foreign
    tooling that happens to share the same key namespace."""
    import winreg
    try:
        with winreg.OpenKey(root, subkey, 0, winreg.KEY_READ) as key:
            num_subkeys, num_values, _ = winreg.QueryInfoKey(key)
            if num_subkeys != 0 or num_values != 0:
                return
    except FileNotFoundError:
        return
    try:
        winreg.DeleteKey(root, subkey)
    except FileNotFoundError:
        pass


def is_file_association_registered() -> bool:
    """Return True if the `.nnz` file association is currently registered
    in HKCU AND its shell-open command points at THIS repo's `run.bat`.
    Returns False on any of:

    - Non-Windows platform (always False, never raises).
    - No registration at all.
    - Extension key exists but maps to a different ProgID.
    - ProgID exists but its shell-open command points somewhere else
      (e.g. a stale registration from a different clone of the repo
      that the user has since moved or deleted).

    The "points at THIS repo" check is important for a dev-stack
    project where a user might `git clone` to a new location, run
    `register_file_association` there, and end up with two competing
    registrations. The UX layer in Track 4 should treat a "registered
    but pointing elsewhere" state as effectively unregistered and
    offer to re-register with the current repo path.
    """
    if sys.platform != "win32":
        return False
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _EXT_KEY) as key:
            ext_value, _ = winreg.QueryValueEx(key, "")
            if ext_value != _PROG_ID:
                return False
    except FileNotFoundError:
        return False

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _COMMAND_KEY) as key:
            command, _ = winreg.QueryValueEx(key, "")
    except FileNotFoundError:
        return False

    return command == _expected_command()
