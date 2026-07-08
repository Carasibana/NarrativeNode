"""`/settings/file-association` — query + toggle the Windows `.nnz`
file-type association.

Thin HTTP skin over `services/file_association.py`. The service layer
owns the platform-specific logic (HKCU registry writes on Windows,
`UnsupportedPlatformError` elsewhere); this router just translates
its three public functions into JSON endpoints and reports a single
consistent `{registered, supported}` status shape.

- `supported` is False on non-Windows. The frontend hides the row
  entirely in that case rather than showing a disabled control with
  an "unsupported" note.
- `registered` is True only when the extension key maps to this
  repo's `run.bat` specifically. A stale registration pointing at a
  different clone reports as False so the UX can offer to re-register
  against the current location.
"""
import sys

from fastapi import APIRouter, HTTPException

from services import file_association as file_association_service


router = APIRouter(prefix="/settings/file-association", tags=["settings"])


def _status() -> dict:
    """Shape returned by every endpoint in this router so the
    frontend gets a consistent payload regardless of which action
    was invoked. `supported` drives the "hide row entirely" logic in
    the Program Settings tab."""
    return {
        "supported": sys.platform == "win32",
        "registered": file_association_service.is_file_association_registered(),
    }


@router.get("")
def get_file_association_status():
    """Report whether the platform supports the feature and whether
    the current user has it registered. Always 200 — non-Windows
    returns `{supported: false, registered: false}` rather than an
    error so the frontend can branch on the shape cleanly."""
    return _status()


@router.post("/register")
def register_file_association():
    """Write the HKCU registry entries that make Windows route
    double-clicked `.nnz` files to this repo's `run.bat`. Idempotent
    — safe to call even when already registered.

    Returns the updated status so the frontend can update its UI
    without a second GET round-trip.
    """
    try:
        file_association_service.register_file_association()
    except file_association_service.UnsupportedPlatformError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except (PermissionError, OSError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to register file association: {exc!r}",
        )
    return _status()


@router.post("/unregister")
def unregister_file_association():
    """Remove the HKCU registry entries. Idempotent — no-ops cleanly
    if already unregistered or if any of the keys are already
    missing.

    Returns the updated status so the frontend can update its UI
    without a second GET round-trip.
    """
    try:
        file_association_service.unregister_file_association()
    except file_association_service.UnsupportedPlatformError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except (PermissionError, OSError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to unregister file association: {exc!r}",
        )
    return _status()
