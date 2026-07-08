"""
Export endpoints — Phase 1.12a modular export pipeline.

One generic endpoint that dispatches through the renderer registry:

    POST /api/project/export/{format_id}

`format_id` is matched against the `RendererSpec`s registered in
`services.renderers`. When a new format lands it self-registers at
import time, so no edits to this file are needed to plumb it in —
drop a new module under `services/renderers/`, add one import line to
`services/renderers/__init__.py`, and the endpoint picks it up. See
`docs/export-renderer-guide.md` for the full walkthrough.

The endpoint reads the currently-loaded `Story` from `state`, builds
an `ExportModel` via `export_service.build_export_model`, and hands
it off to the format-specific renderer. Output is streamed back as a
download with `Content-Disposition: attachment; filename=...`.

The ExportOptions request body carries 24+ boolean / string fields
covering the full set of granular toggles (see
`services.export_service.ExportOptions`). POST was chosen over GET
because stuffing 24 flags into a query string is both ugly and
brittle to round-trip through the browser address bar or curl. The
frontend Export dialog always POSTs a full options payload built from
the currently-selected preset + any user overrides.
"""

from __future__ import annotations

import logging
import re
import traceback
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

import state
from services import error_log
from services.export_service import ExportOptions, build_export_model
from services.renderers import get_renderer, all_renderers  # noqa: F401 — import triggers renderer registration


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/project/export", tags=["export"])


class ExportOptionsRequest(BaseModel):
    """JSON body schema for POST /project/export/*. Every field maps
    one-to-one onto a field on `services.export_service.ExportOptions`.
    All fields default to their ExportOptions defaults so a minimal
    request body still produces a sensible export."""
    # Header / story metadata
    include_author: bool = True
    include_genre: bool = True
    include_story_description: bool = True  # Phase 5.8b — story blurb on title page
    include_cover_image: bool = True        # Phase 5.8b — cover as first page (image formats)
    render_markdown_in_text_fields: bool = True  # Phase 5.8b — render markdown in free-form fields
    include_scene_separator: bool = True    # Phase 5.8b — scene-break ornament between same-chapter scenes
    include_tags: bool = True
    include_tense: bool = True
    include_pov_type: bool = True
    include_language: bool = True
    include_default_pov_character: bool = True
    include_generated_timestamp: bool = True
    # Structure
    include_act_headings: bool = True
    include_chapter_headings: bool = True
    include_unchaptered_heading: bool = True
    # Per-scene elements
    include_transition_text: bool = True
    include_scene_title: bool = True
    include_scene_description: bool = True
    include_scene_pov_line: bool = True
    include_entity_context_line: bool = True
    include_scene_body: bool = True
    include_scene_changes_block: bool = True
    # Phase 1.22i — Circumstances & Motivators block. Plumbed
    # through to ExportOptions where every renderer reads it; the
    # field was missing from this HTTP schema (audit Bug 4) so it
    # was silently stripped from inbound payloads. Default True
    # matches the dataclass default — existing clients that don't
    # send the field still get the block when CM data is present.
    include_scene_cm_block: bool = True
    # Scene changes granularity
    include_metadata_changes: bool = True
    include_attribute_changes: bool = True
    include_relationship_changes: bool = True
    # Phase 1.25c — alias and awareness chain entries on EntityRefs.
    include_alias_changes: bool = True
    include_awareness_changes: bool = True
    # Appendices
    include_offscreen_appendix: bool = False
    include_entity_sheets: bool = False
    # Phase 1.25c — author's "Notes" sub-section on entity reference
    # sheets (gated also on non-empty `Entity.notes`). Default True.
    include_entity_notes: bool = True
    # Phase 1.25c — Knowledge appendix (after entity sheets). Default True.
    include_knowledge_section: bool = True
    # Phase 1.25c — chain history rows under each Knowledge entry.
    # Default False (chain history is chatty; opt-in).
    include_knowledge_chain_history: bool = False
    # Phase 1.25c — scene-time line on each scene header (default True).
    include_scene_time: bool = True
    # Phase 1.25c — frontend-precomputed scene-time payload, keyed by
    # scene id. Each entry is `{text, season_svg, tod_svg}`.
    pre_computed_scene_times: Optional[dict[str, dict[str, str]]] = None
    # Media attributes
    include_media_attributes: bool = True
    include_media_attribute_images: bool = True
    include_media_attribute_audio: bool = False
    include_media_attribute_video: bool = False
    # Build-level
    embed_assets: bool = True
    # Page size for paginated formats only (pdf / docx). Text
    # formats (html / markdown / txt) ignore this field. Default A4.
    page_size: Literal["a4", "letter"] = "a4"
    # Per-entity colouring — gated on the `entity_colours` capability
    # by the frontend dialog. Renderers that declare the capability
    # (html, pdf) render entity mentions in each entity's own colour
    # when True. Default False.
    use_entity_colours: bool = False
    # Track 9 — scope selector. None = full story; non-empty list =
    # restrict the export to scenes whose id is in the list. The
    # walker filters sections and offscreen scenes before the
    # renderer runs; renderers don't need to know scope exists.
    scope_scene_ids: Optional[list[str]] = None
    # Track 9 — entity state boundary. "origin" (default) = entity
    # reference sheets always use library state. "scope" = walker
    # walks each entity's chain forward to the moment immediately
    # before the earliest exported scene, applying all EntityRef
    # changes along the way. Only meaningful when scope_scene_ids is
    # non-empty; ignored otherwise.
    entity_state_boundary: Literal["origin", "scope"] = "origin"
    entity_context_mode: Literal["off", "minimal", "full"] = "minimal"
    # Phase 1.25a — Export preset architecture. The writer's chosen
    # preset (NarrativeNode native / Shunn / NovelCrafter / Customize).
    # In 1.25a preset semantics live on the frontend (the dialog
    # applies a per-preset toggle bundle to the local state before
    # POSTing); this field is included for logging and as a hook for
    # future server-side preset enforcement. Default `customize` so
    # existing API callers without the field are treated as
    # "honour the toggle values they sent" — current behaviour.
    preset_key: Literal["native", "prose", "shunn", "novelcrafter", "customize"] = "customize"
    # Phase 1.25a — Publication vs Full mode.
    export_mode: Literal["publication", "full"] = "full"
    # Phase 1.25b — pre-computed scene order. When non-None, the
    # walker uses this list as the canonical scene sequence for the
    # main narrative instead of calling `compute_pov_sequence`.
    # Frontend computes the order via Phase 1.19's `storyOrder.js`
    # (filtered to POV-only for Publication mode, full Story Order
    # for Full mode) and ships it here. None preserves legacy
    # behaviour (POV-wire chain via `compute_pov_sequence`) for any
    # API caller that doesn't supply an order.
    pre_computed_order: Optional[list[str]] = None
    # Phase 1.25b — set of scene ids that are on the POV path. When
    # `pre_computed_order` includes both POV-path and off-screen
    # scenes (Full mode), this set lets the renderer flag the POV
    # ones — useful for "Native" exports where the writer wants to
    # see at a glance which scenes are reader-facing vs writer-only.
    # In Publication mode this set typically equals
    # `pre_computed_order`. None preserves legacy behaviour
    # (every scene in `pov_sequence` is treated as POV-path).
    pov_path_scene_ids: Optional[list[str]] = None
    # Phase 4.3 — frontend-precomputed scene id → chapter id map. The
    # frontend resolves chapter membership mode-aware (single-row x-only
    # in single-row layout, 2D row-band in multi-row) and ships the
    # result so the export's chapter sectioning matches the canvas in
    # both modes. None preserves legacy behaviour (backend resolves via
    # the single-row `get_chapter_id_for_node`) for any API caller that
    # doesn't supply the map. A scene absent from the map is treated as
    # unchaptered.
    pre_computed_chapter_ids: Optional[dict[str, str]] = None


def _sanitise_filename(raw: str, fallback: str = "story") -> str:
    """Strip characters unsafe in a filename and collapse whitespace.
    Used to turn a story title into a safe download filename."""
    cleaned = re.sub(r"[\\/:*?\"<>|]+", "", raw or "").strip()
    cleaned = re.sub(r"\s+", "-", cleaned)
    return cleaned or fallback


def _to_options(req: ExportOptionsRequest) -> ExportOptions:
    """Copy a request body into a fresh `ExportOptions` dataclass.
    Kept separate from the Pydantic model so the render layer only
    depends on the dataclass, not the HTTP schema."""
    return ExportOptions(**req.model_dump())


@router.get("/formats")
def list_formats():
    """Enumerate the renderers currently registered. Used by the
    frontend Export dialog to (a) auto-populate the format picker
    instead of hard-coding the list, (b) discover each format's
    declared capabilities so the dialog can conditionally hide
    toggles that aren't meaningful for the currently-selected format,
    and (c) group variant renderers under their parent format via
    the `variant_of` field so the Format picker shows a clean list
    of top-level formats with a Layout sub-picker for any format
    that has variants. See `docs/export-renderer-guide.md` for the
    full capability catalogue and the Variants section for the
    variant grouping mechanism."""
    return [
        {
            "format_id": spec.format_id,
            "label": spec.label,
            "extension": spec.extension,
            "mime_type": spec.mime_type,
            "capabilities": sorted(spec.capabilities),
            "variant_of": spec.variant_of,
            "variant_label": spec.variant_label,
        }
        for spec in all_renderers()
        if not spec.hidden_from_picker
    ]


@router.post("/{format_id}")
def export_story(format_id: str, req: ExportOptionsRequest):
    """Export the currently-loaded story in the requested format.
    Dispatches through the renderer registry — `format_id` is matched
    against whichever renderer modules are registered in
    `services.renderers`."""
    try:
        spec = get_renderer(format_id)
    except KeyError:
        raise HTTPException(
            status_code=404,
            detail=f"unknown export format: {format_id!r}",
        )

    story = state.get_story()
    if story is None:
        raise HTTPException(status_code=404, detail="no story loaded")

    options = _to_options(req)
    # Apply the renderer's required_options overrides, if any. These
    # are declared on the SPEC and force certain ExportOptions fields
    # into a specific state regardless of what the caller sent — used
    # by renderers whose output is structurally impossible without
    # certain walker data being present (e.g. `markdown-novelcrafter`
    # always needs entity reference sheets populated because it builds
    # the entity codex file from them).
    if spec.required_options:
        for key, value in spec.required_options.items():
            setattr(options, key, value)

    # Wrap the model-build + render pipeline so any failure (renderer
    # bug, missing assets, unexpected story shape) surfaces as a 500
    # with the exception type + message in the detail AND a full
    # traceback in the uvicorn console. Without this, intermittent
    # export bugs become un-diagnosable after the fact — the user only
    # sees a generic "Export failed" banner and the server logs show
    # nothing about why.
    try:
        model = build_export_model(story, options)
        body = spec.render(model, options)
    except Exception as exc:
        tb = traceback.format_exc()
        logger.error(
            "Export (%s) failed (%s): %s\n%s",
            format_id, type(exc).__name__, exc, tb,
        )
        error_log.log_error(
            "EXPORT",
            exc,
            context={"format_id": format_id},
        )
        raise HTTPException(
            status_code=500,
            detail=f"Export failed ({type(exc).__name__}): {exc}",
        )
    # NC formats are one-or-the-other (prose OR summaries) per NC's
    # importer constraint; suffix the downloaded file so the writer
    # can tell which mode the bundle holds without unzipping. Each
    # renderer exposes its own `nc_filename_suffix(options)` helper —
    # we call into the right one by format_id.
    nc_suffix = ""
    if spec.format_id == "markdown-novelcrafter":
        from services.renderers.markdown_novelcrafter import nc_filename_suffix
        nc_suffix = f"-{nc_filename_suffix(options)}"
    elif spec.format_id == "docx-novelcrafter":
        from services.renderers.docx_novelcrafter import nc_filename_suffix
        nc_suffix = f"-{nc_filename_suffix(options)}"
    filename = f"{_sanitise_filename(model.title)}{nc_suffix}.{spec.extension}"
    return Response(
        content=body,
        media_type=spec.mime_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
