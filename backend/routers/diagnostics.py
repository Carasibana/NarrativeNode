"""
Diagnostics endpoints — currently scoped to one feature: download the
verbose error.log file that the save / autosave / export catch blocks
write to.

The frontend's error banner shows a "Download error log" link when an
error is showing; the link points at `GET /api/diagnostics/error-log`,
which streams the contents of the project's `logs/error.log` as a text
download.

`/error-log/info` is a small JSON probe used by the banner to decide
whether to render the download link at all: if the log file doesn't
exist yet (no errors have ever fired), there's nothing to download
and the link stays hidden.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse

from services import error_log


router = APIRouter(prefix="/diagnostics", tags=["diagnostics"])


@router.get("/error-log/info")
async def error_log_info():
    """Report whether the error log exists and how big it is. The
    frontend banner uses this to gate the visibility of the download
    link — no point showing it when there's nothing to download."""
    path = error_log.get_error_log_path()
    if not path.exists():
        return JSONResponse({"exists": False, "path": str(path), "size_bytes": 0})
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    return JSONResponse({"exists": True, "path": str(path), "size_bytes": size})


@router.get("/error-log")
async def download_error_log():
    """Stream the project's `logs/error.log` back as a text download.
    Returns 404 if the file doesn't exist yet (no errors have fired).
    """
    path = error_log.get_error_log_path()
    if not path.exists():
        return JSONResponse(
            {"detail": "error.log does not exist yet (no failures recorded)"},
            status_code=404,
        )
    return FileResponse(
        path,
        media_type="text/plain; charset=utf-8",
        filename="narrativenode-error.log",
    )
