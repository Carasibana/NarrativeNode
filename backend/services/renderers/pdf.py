"""
PDF renderer — Phase 1.12a Track 6.

Part of the modular renderer package: each format is its own file
under `backend/services/renderers/`, self-registering a `RendererSpec`
via the registry at the bottom of this module. See
`docs/export-renderer-guide.md` for the full pattern.

This renderer walks the `ExportModel` directly and emits a sequence
of ReportLab Platypus flowables, which the `SimpleDocTemplate` lays
out on pages. No HTML intermediate, no `from .html import render_html`
— fully self-contained per the renderer-independence rule.

The original Track 6 plan had PDF going through WeasyPrint (HTML → PDF
converter), which would have required a cross-renderer import. Swapped
to ReportLab at v0.1.12.10 because the Platypus flowable model matches
the pagination requirements one-to-one:

  - `PageBreak()` flowable → "act / chapter / appendix starts on a
    fresh page"
  - `KeepTogether([...])` flowable → "don't split a scene across a
    page break if it fits on one page"
  - `SimpleDocTemplate(pagesize=A4 | letter)` → A4 default, Letter
    opt-in via `ExportOptions.page_size`

Pagination rules implemented (per the shared *Pagination model* in
the Phase 1.12a planning doc):

  1. Acts start on a fresh page, except when they're the very first
     block in the document (tracked via `first_block` flag).
  2. Chapters start on a fresh page, except when they're the first
     chapter of an act (tracked via `prev_was_act_heading` flag).
  3. Unchaptered sections get a page break before them, same as
     chapters.
  4. Scenes pack within chapters — no forced page break per scene.
  5. Each scene's flowables are wrapped in `KeepTogether([...])` so
     ReportLab tries to keep the whole scene on one page. If the
     scene is longer than a page, `KeepTogether` gracefully falls
     back to starting it on a new page and flowing normally.
  6. Off-screen scenes appendix and entity reference sheets each
     start on a fresh page.

Styles live in a module-level registry built once at import time. A
dedicated `_TipTapToReportLab` class (sibling to `markdown.py`'s
`_TipTapToMarkdown` and `txt.py`'s `_TipTapToText`, shares no code
with them) walks TipTap scene-body HTML and emits Paragraph / Spacer
/ HRFlowable flowables with inline markup converted to ReportLab's
mini-HTML subset (`<b>` / `<i>` / `<u>` / `<br/>` / `<link href>`).
All media tags are silently dropped, matching the no-media policy
shared across text-based renderers in this package.
"""

from __future__ import annotations

import base64
import re
from html.parser import HTMLParser
from io import BytesIO
from typing import Optional

from reportlab.lib.colors import HexColor, black
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_JUSTIFY
from reportlab.lib.pagesizes import A4, letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    HRFlowable,
    Image,
    KeepTogether,
    ListFlowable,
    ListItem,
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from services import export_icons
from services.markdown_fields import (
    field_markdown_to_html,
    field_markdown_to_inline_html,
    is_block_markdown,
)
from services.export_service import (
    ExportAttribute,
    ExportChangeDetail,
    ExportEntityRelationship,
    ExportEntitySheet,
    ExportKnowledgeChainEntry,
    ExportKnowledgeSheet,
    ExportModel,
    ExportOptions,
    ExportScene,
    ExportSceneCMGroup,
    ExportSceneCMRow,
    ExportSceneEntityChange,
    ExportSceneEntityEntry,
    ExportSceneEntityGroup,
    ExportSection,
)
from .registry import RendererSpec, register


# Maps an `ExportSceneCMRow.prefix` string to the corresponding
# `attribute_type` ('circumstance' / 'motivator' / '') for type-badge
# resolution. Mirrors the same map in the HTML renderer; duplicated
# here per the renderer-independence rule.
_PREFIX_TO_ATTRIBUTE_TYPE = {
    "Scene Circumstance": "circumstance",
    "Circumstance": "circumstance",
    "Temporary Circumstance": "circumstance",
    "Motivator": "motivator",
    "Temporary Motivator": "motivator",
}


def _png_to_data_uri(data: bytes) -> str:
    """Wrap raw PNG bytes in a data: URI suitable for ReportLab
    Paragraph's inline `<img src=...>` markup."""
    return f"data:image/png;base64,{base64.b64encode(data).decode('ascii')}"


def _intensity_badge_inline_html(level: Optional[int], px: int = 11) -> str:
    """Inline `<img>` markup for an intensity badge at the given tier.
    Returns an empty string when level is None and the unset variant
    isn't desired."""
    png = export_icons.intensity_badge_png(level, size=px * 4)
    src = _png_to_data_uri(png)
    return f'<img src="{src}" width="{px}" height="{px}" valign="-1"/>'


def _cm_type_badge_inline_html(attribute_type: str, px: int = 11) -> str:
    """Inline `<img>` markup for a circumstance / motivator type badge.
    Empty string when the attribute_type isn't c/m."""
    png = export_icons.cm_type_badge_png(attribute_type, size=px * 4)
    if png is None:
        return ""
    src = _png_to_data_uri(png)
    return f'<img src="{src}" width="{px}" height="{px}" valign="-1"/>'


# ── Styles (built once at import time) ─────────────────────────────────


def _build_styles() -> dict[str, ParagraphStyle]:
    """Build the full style registry. Called once at module import,
    the returned dict is stored in `_STYLES` below."""
    base = getSampleStyleSheet()["BodyText"]
    styles: dict[str, ParagraphStyle] = {}

    styles["story_title"] = ParagraphStyle(
        "StoryTitle",
        parent=base,
        fontName="Times-Bold",
        fontSize=28,
        leading=34,
        alignment=TA_CENTER,
        spaceBefore=36,
        spaceAfter=12,
        textColor=black,
    )
    styles["byline"] = ParagraphStyle(
        "Byline",
        parent=base,
        fontName="Times-Italic",
        fontSize=13,
        leading=18,
        alignment=TA_CENTER,
        spaceAfter=8,
        textColor=HexColor("#555555"),
    )
    styles["metadata"] = ParagraphStyle(
        "Metadata",
        parent=base,
        fontName="Helvetica",
        fontSize=9,
        leading=13,
        alignment=TA_CENTER,
        spaceAfter=3,
        textColor=HexColor("#666666"),
    )
    styles["act_heading"] = ParagraphStyle(
        "ActHeading",
        parent=base,
        fontName="Helvetica-Bold",
        fontSize=20,
        leading=26,
        alignment=TA_CENTER,
        spaceBefore=36,
        spaceAfter=24,
        textColor=black,
        keepWithNext=1,  # Phase 5.8b — never orphan a heading from its content
    )
    styles["chapter_heading"] = ParagraphStyle(
        "ChapterHeading",
        parent=base,
        fontName="Helvetica-Bold",
        fontSize=16,
        leading=22,
        alignment=TA_LEFT,
        spaceBefore=12,
        spaceAfter=18,
        textColor=black,
        keepWithNext=1,  # Phase 5.8b — never orphan a heading from its content
    )
    styles["scene_title"] = ParagraphStyle(
        "SceneTitle",
        parent=base,
        fontName="Helvetica-Bold",
        fontSize=12,
        leading=16,
        alignment=TA_LEFT,
        spaceBefore=14,
        spaceAfter=4,
        textColor=black,
    )
    styles["transition"] = ParagraphStyle(
        "Transition",
        parent=base,
        fontName="Times-Italic",
        fontSize=11,
        leading=14,
        alignment=TA_CENTER,
        leftIndent=0,
        rightIndent=0,
        spaceBefore=8,
        spaceAfter=12,
        textColor=HexColor("#555555"),
    )
    # Phase 5.8b — small, muted text for the scene description; the light-grey
    # box around it is provided by the single-cell table in
    # `_scene_description_flowables` (so block markdown — lists, paragraphs —
    # is preserved inside the box).
    styles["scene_description"] = ParagraphStyle(
        "SceneDescription",
        parent=base,
        fontName="Times-Roman",
        fontSize=9,
        leading=12,
        alignment=TA_LEFT,
        spaceAfter=2,
        textColor=HexColor("#444444"),
    )
    styles["pov_line"] = ParagraphStyle(
        "POVLine",
        parent=base,
        fontName="Helvetica-Bold",
        fontSize=9,
        leading=12,
        alignment=TA_LEFT,
        spaceAfter=4,
        textColor=HexColor("#555555"),
    )
    styles["entity_context"] = ParagraphStyle(
        "EntityContext",
        parent=base,
        fontName="Helvetica",
        fontSize=9,
        leading=12,
        alignment=TA_LEFT,
        leftIndent=0,
        spaceAfter=3,
        textColor=HexColor("#555555"),
    )
    styles["body_paragraph"] = ParagraphStyle(
        "Body",
        parent=base,
        fontName="Times-Roman",
        fontSize=11,
        leading=15,
        alignment=TA_JUSTIFY,
        spaceAfter=8,
        firstLineIndent=18,
        textColor=black,
    )
    styles["blockquote"] = ParagraphStyle(
        "Blockquote",
        parent=base,
        fontName="Times-Italic",
        fontSize=11,
        leading=15,
        alignment=TA_LEFT,
        leftIndent=24,
        rightIndent=24,
        spaceBefore=6,
        spaceAfter=6,
        textColor=HexColor("#444444"),
    )
    styles["list_item"] = ParagraphStyle(
        "ListItem",
        parent=base,
        fontName="Times-Roman",
        fontSize=11,
        leading=14,
        alignment=TA_LEFT,
        textColor=black,
    )
    styles["preformatted"] = ParagraphStyle(
        "Preformatted",
        parent=base,
        fontName="Courier",
        fontSize=9,
        leading=12,
        alignment=TA_LEFT,
        leftIndent=12,
        backColor=HexColor("#f5f5f5"),
        borderPadding=4,
        spaceBefore=6,
        spaceAfter=6,
        textColor=black,
    )
    # Phase 5.8b — compact variants used when markdown is rendered inside an
    # entity reference sheet, so the block sits at the sheet's text size
    # (~10pt, left-aligned, no first-line indent) instead of the larger
    # justified scene-body size that looks out of place beside the sheet's
    # other details.
    styles["body_paragraph_compact"] = ParagraphStyle(
        "BodyCompact",
        parent=styles["body_paragraph"],
        fontSize=10,
        leading=13,
        alignment=TA_LEFT,
        firstLineIndent=0,
        spaceAfter=4,
    )
    styles["blockquote_compact"] = ParagraphStyle(
        "BlockquoteCompact",
        parent=styles["blockquote"],
        fontSize=10,
        leading=13,
        leftIndent=18,
        rightIndent=18,
        spaceBefore=4,
        spaceAfter=4,
    )
    styles["list_item_compact"] = ParagraphStyle(
        "ListItemCompact",
        parent=styles["list_item"],
        fontSize=10,
        leading=13,
    )
    # Phase 5.8b — centred text fallback for the scene-break dinkus when
    # the ornament PNG can't be rasterised.
    styles["scene_break"] = ParagraphStyle(
        "SceneBreak",
        parent=base,
        fontSize=11,
        leading=14,
        alignment=TA_CENTER,
        spaceBefore=8,
        spaceAfter=8,
        textColor=black,
    )
    styles["changes_header"] = ParagraphStyle(
        "ChangesHeader",
        parent=base,
        fontName="Helvetica-Bold",
        fontSize=9,
        leading=12,
        alignment=TA_LEFT,
        spaceBefore=10,
        spaceAfter=3,
        textColor=HexColor("#555555"),
    )
    styles["changes_entity"] = ParagraphStyle(
        "ChangesEntity",
        parent=base,
        fontName="Helvetica-Bold",
        fontSize=9,
        leading=12,
        leftIndent=12,
        spaceAfter=1,
        textColor=black,
    )
    styles["changes_detail"] = ParagraphStyle(
        "ChangesDetail",
        parent=base,
        fontName="Helvetica",
        fontSize=8,
        leading=11,
        leftIndent=24,
        spaceAfter=1,
        textColor=HexColor("#555555"),
    )
    styles["entity_sheet_name"] = ParagraphStyle(
        "EntitySheetName",
        parent=base,
        fontName="Helvetica-Bold",
        fontSize=14,
        leading=18,
        alignment=TA_LEFT,
        spaceBefore=12,
        spaceAfter=2,
        textColor=black,
    )
    styles["entity_sheet_type"] = ParagraphStyle(
        "EntitySheetType",
        parent=base,
        fontName="Helvetica-Oblique",
        fontSize=9,
        leading=12,
        alignment=TA_LEFT,
        spaceAfter=6,
        textColor=HexColor("#777777"),
    )
    styles["entity_sheet_description"] = ParagraphStyle(
        "EntitySheetDescription",
        parent=base,
        fontName="Times-Roman",
        fontSize=10,
        leading=14,
        alignment=TA_LEFT,
        spaceAfter=6,
        textColor=black,
    )
    styles["entity_sheet_attribute"] = ParagraphStyle(
        "EntitySheetAttribute",
        parent=base,
        fontName="Helvetica",
        fontSize=9,
        leading=12,
        leftIndent=12,
        spaceAfter=2,
        textColor=black,
    )
    styles["appendix_note"] = ParagraphStyle(
        "AppendixNote",
        parent=base,
        fontName="Times-Italic",
        fontSize=10,
        leading=14,
        alignment=TA_CENTER,
        spaceAfter=18,
        textColor=HexColor("#777777"),
    )
    return styles


_STYLES = _build_styles()


# ── Public entry ───────────────────────────────────────────────────────


def render_pdf(model: ExportModel, options: Optional[ExportOptions] = None) -> bytes:
    """Build a PDF from an ExportModel and return the raw bytes."""
    options = options or ExportOptions()

    pagesize = letter if (options.page_size or "a4").lower() == "letter" else A4

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=pagesize,
        topMargin=1.0 * inch,
        bottomMargin=1.0 * inch,
        leftMargin=1.0 * inch,
        rightMargin=1.0 * inch,
        title=model.title or "Story",
        author=model.author or "",
    )

    state = _RenderState()
    flowables: list = []

    # Phase 5.8b — story cover as a full first page, before the title
    # page. Drawn directly on the page canvas (onFirstPage) so it fills
    # the whole PAGE rather than the inset text frame, scaled to fit with
    # no cropping (fills the limiting side, letterboxes the other). A
    # leading PageBreak leaves page 1's text frame empty and starts the
    # title block on page 2.
    cover_uri = model.cover_image_data_uri if options.include_cover_image else None
    if cover_uri:
        flowables.append(PageBreak())

    # Story header (title block + byline + metadata). Sits at the top of
    # the title page (page 1, or page 2 when a cover precedes it).
    flowables.extend(_render_story_header(model, options))
    state.first_block = False

    # Sections.
    for section in model.sections:
        _append_section(flowables, section, options, state)

    # Appendices.
    if options.include_offscreen_appendix and model.offscreen_scenes:
        flowables.append(PageBreak())
        flowables.extend(_render_offscreen_appendix(model.offscreen_scenes, options))
        state.prev_was_act_heading = False

    if options.include_entity_sheets and model.entity_sheets:
        flowables.append(PageBreak())
        flowables.extend(_render_entity_sheets(model.entity_sheets, options))

    if options.include_knowledge_section and model.knowledge_sheets:
        flowables.append(PageBreak())
        flowables.extend(_render_knowledge_sheets(model.knowledge_sheets, options))

    if cover_uri:
        doc.build(flowables, onFirstPage=lambda c, d: _draw_cover_page(c, pagesize, cover_uri))
    else:
        doc.build(flowables)
    return buf.getvalue()


def _draw_cover_page(canvas, pagesize, data_uri: str) -> None:
    """Phase 5.8b — paint the story cover to fill page 1 (contain, no
    crop), centred, with a small uniform margin from the page edge.
    Drawn on the raw canvas so it is not constrained by the text frame.
    Any failure leaves page 1 blank rather than breaking the export."""
    try:
        import base64 as _b64
        from PIL import Image as _PILImage
        from reportlab.lib.utils import ImageReader
        raw = _b64.b64decode(data_uri.split(",", 1)[1])
        pil = _PILImage.open(BytesIO(raw))
        if pil.mode not in ("RGB", "L"):
            pil = pil.convert("RGB")
        page_w, page_h = pagesize
        margin = 18.0  # 0.25in breathing room from the page edge
        canvas.drawImage(
            ImageReader(pil),
            margin, margin,
            page_w - 2 * margin, page_h - 2 * margin,
            preserveAspectRatio=True, anchor="c", mask="auto",
        )
    except Exception:
        pass


class _RenderState:
    """Mutable state threaded through the walker so the pagination
    rules can consult 'is this the first block?' and 'was the
    previous block an act heading?' — both needed to suppress
    redundant page breaks per the Pagination model."""

    __slots__ = ("first_block", "prev_was_act_heading")

    def __init__(self) -> None:
        self.first_block: bool = True
        self.prev_was_act_heading: bool = False


# ── Story header ───────────────────────────────────────────────────────


def _render_story_header(model: ExportModel, options: ExportOptions) -> list:
    """Centred title + byline + metadata lines (one per field) at
    the top of page 1. Ends with a horizontal rule for visual
    separation from the first section heading."""
    flowables: list = []
    flowables.append(Paragraph(_esc(model.title or "Story"), _STYLES["story_title"]))

    if options.include_author and model.author:
        flowables.append(Paragraph(f"by {_esc(model.author)}", _STYLES["byline"]))

    meta_lines: list[str] = []
    if options.include_genre and model.genre:
        meta_lines.append(f"<b>Genre:</b> {_esc(model.genre)}")
    if options.include_tags and model.tags:
        meta_lines.append(f"<b>Tags:</b> {_esc(', '.join(model.tags))}")
    if options.include_tense and model.tense:
        meta_lines.append(f"<b>Tense:</b> {_esc(model.tense)}")
    if options.include_pov_type and model.pov_type:
        meta_lines.append(f"<b>POV style:</b> {_esc(model.pov_type)}")
    if options.include_language and model.language:
        meta_lines.append(f"<b>Language:</b> {_esc(model.language)}")
    if options.include_default_pov_character and model.default_pov_character_name:
        meta_lines.append(f"<b>Default POV:</b> {_esc(model.default_pov_character_name)}")
    if options.include_generated_timestamp and model.generated_at:
        meta_lines.append(f"<b>Generated:</b> {model.generated_at.strftime('%Y-%m-%d')}")

    if meta_lines:
        flowables.append(Spacer(1, 4))
        for line in meta_lines:
            flowables.append(Paragraph(line, _STYLES["metadata"]))

    # Phase 5.8b — story description blurb, below the metadata block.
    if options.include_story_description and model.description and model.description.strip():
        flowables.append(Spacer(1, 6))
        desc_html = _esc(model.description.strip()).replace("\n", "<br/>")
        flowables.append(Paragraph(desc_html, _STYLES["body_paragraph"]))

    flowables.append(Spacer(1, 12))
    flowables.append(HRFlowable(width="60%", thickness=0.5, color=HexColor("#cccccc"), hAlign="CENTER"))
    flowables.append(Spacer(1, 18))
    return flowables


# ── Sections ───────────────────────────────────────────────────────────


def _append_section(
    flowables: list,
    section: ExportSection,
    options: ExportOptions,
    state: _RenderState,
) -> None:
    """Append a section's flowables to the running list, applying
    the pagination rules as we go."""
    if section.kind == "act":
        if options.include_act_headings:
            if not state.first_block:
                flowables.append(PageBreak())
            flowables.append(
                Paragraph((section.label or "").upper(), _STYLES["act_heading"])
            )
            state.first_block = False
            state.prev_was_act_heading = True
        # Recurse into child chapters.
        for child in section.children:
            _append_section(flowables, child, options, state)
        return

    if section.kind == "chapter":
        if options.include_chapter_headings:
            # Page break before chapter UNLESS the previous block
            # was an act heading (first chapter of an act inherits
            # the act's break).
            if not state.first_block and not state.prev_was_act_heading:
                flowables.append(PageBreak())
            flowables.append(
                Paragraph(_esc(section.label or ""), _STYLES["chapter_heading"])
            )
            state.first_block = False
            state.prev_was_act_heading = False
        rendered_prev = False
        for scene in section.scenes:
            scene_flowables = _render_scene(scene, options)
            if scene_flowables:
                # Phase 5.8b — scenes flow naturally and split across pages
                # rather than being kept whole (which orphaned chapter
                # headings when the first scene was taller than a page).
                if rendered_prev and options.include_scene_separator:
                    flowables.extend(_scene_break_flowables())
                flowables.extend(scene_flowables)
                rendered_prev = True
                state.first_block = False
                state.prev_was_act_heading = False
        return

    # "unchaptered"
    if not section.scenes:
        return
    if options.include_unchaptered_heading:
        if not state.first_block and not state.prev_was_act_heading:
            flowables.append(PageBreak())
        flowables.append(
            Paragraph(_esc(section.label or "Unchaptered"), _STYLES["chapter_heading"])
        )
        state.first_block = False
        state.prev_was_act_heading = False
    rendered_prev = False
    for scene in section.scenes:
        scene_flowables = _render_scene(scene, options)
        if scene_flowables:
            # Phase 5.8b — scenes flow naturally (see chapter branch).
            if rendered_prev and options.include_scene_separator:
                flowables.extend(_scene_break_flowables())
            flowables.extend(scene_flowables)
            rendered_prev = True
            state.first_block = False
            state.prev_was_act_heading = False


# ── Free-form text fields (markdown-aware) ─────────────────────────────


def _scene_description_flowables(text: str, options: ExportOptions) -> list:
    """Phase 5.8b — scene description as a small, light-grey bordered box so
    it reads as distinct from the prose. Built as a MULTI-ROW single-column
    table (one row per paragraph / bullet) so ReportLab can split it between
    rows across pages — a single-row table cell can't split, and descriptions
    can run longer than a page. List items are flattened to standalone
    bulleted paragraphs (one per row) for the same reason."""
    inner = (text or "").strip()
    if not inner:
        return []
    if options.render_markdown_in_text_fields:
        blocks = _tiptap_to_flowables(field_markdown_to_html(inner), compact=True, flat_lists=True)
    else:
        blocks = [
            Paragraph(_esc(line), _STYLES["scene_description"])
            for line in inner.splitlines() if line.strip()
        ]
    return _boxed_block(blocks, options)


def _boxed_block(blocks: list, options: ExportOptions) -> list:
    """Phase 5.8b — wrap a list of flowables in a light-grey bordered box.
    Built as a MULTI-ROW single-column table (one row per flowable) so
    ReportLab can split it between rows across pages; a single-row cell can't
    split. Used for the scene-description box and the scene-context box."""
    blocks = [b for b in blocks if b is not None]
    if not blocks:
        return []
    rows = [[b] for b in blocks]
    pagesize = letter if (options.page_size or "a4").lower() == "letter" else A4
    frame_w = pagesize[0] - 2 * inch
    tbl = Table(rows, colWidths=[frame_w], splitByRow=1)
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), HexColor("#f0f0f0")),
        ("BOX", (0, 0), (-1, -1), 0.5, HexColor("#d8d8d8")),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
        ("TOPPADDING", (0, 0), (-1, 0), 6),        # extra pad inside the box top
        ("BOTTOMPADDING", (0, -1), (-1, -1), 6),   # ...and bottom
    ]))
    return [Spacer(1, 2), tbl, Spacer(1, 6)]


def _scene_break_flowables() -> list:
    """Phase 5.8b — scene-break ornament (centre diamond + fading rules)
    between same-chapter scenes, rasterised via resvg and centred. Falls
    back to a centred "* * *" if rasterisation is unavailable."""
    png = export_icons.scene_break_png(width=240, color="#3a3a3a")
    if png:
        img = Image(BytesIO(png), width=140, height=140 * 28 / 240)
        img.hAlign = "CENTER"
        return [Spacer(1, 8), img, Spacer(1, 8)]
    return [Spacer(1, 4), Paragraph("* * *", _STYLES["scene_break"]), Spacer(1, 4)]


def _block_field_flowables(text: str, options: ExportOptions, style, compact: bool = False) -> list:
    """Phase 5.8b — flowables for a free-form block field (description /
    notes / scene description). When `render_markdown_in_text_fields` is
    on, the text is parsed as markdown and rendered through the shared
    TipTap flowable builder; otherwise each non-empty line becomes its own
    paragraph in the given style. `compact` renders markdown at entity-sheet
    text size. Empty / blank input returns []."""
    inner = (text or "").strip()
    if not inner:
        return []
    if options.render_markdown_in_text_fields:
        return _tiptap_to_flowables(field_markdown_to_html(inner), compact=compact)
    return [Paragraph(_esc(line), style) for line in inner.splitlines() if line.strip()]


# ── Scene ──────────────────────────────────────────────────────────────


def _render_scene(scene: ExportScene, options: ExportOptions) -> list:
    """Return a list of flowables representing one scene. The caller
    wraps the list in a `KeepTogether` so the scene doesn't split
    across a page break."""
    flowables: list = []

    if options.include_transition_text and scene.transition_in_text.strip():
        flowables.append(
            Paragraph(
                _esc(scene.transition_in_text.strip()),
                _STYLES["transition"],
            )
        )

    if options.include_scene_title and scene.title:
        flowables.append(
            Paragraph(_esc(scene.title), _STYLES["scene_title"])
        )

    if options.include_scene_description and scene.description.strip():
        flowables.extend(_scene_description_flowables(scene.description, options))

    # Phase 5.8b — the scene "context" elements (time, circumstances &
    # motivators, POV, entity context) collect into a second light-grey box
    # that sits between the description and the prose, so the metadata reads
    # as distinct from the story text.
    context: list = []

    # Phase 1.25c — scene-time line. Icons rasterise via svglib;
    # data URIs inline through Paragraph's `<img>` mini-HTML support
    # (same pattern as the c/m type / intensity badges in v0.1.25.11).
    if options.include_scene_time and (
        scene.scene_time_text or scene.scene_time_season_svg or scene.scene_time_tod_svg
    ):
        bits: list[str] = []
        for svg in (scene.scene_time_season_svg, scene.scene_time_tod_svg):
            if not svg:
                continue
            png = export_icons.svg_to_png_bytes(svg, size=44)
            if not png:
                continue
            data_uri = _png_to_data_uri(png)
            bits.append(f'<img src="{data_uri}" width="11" height="11" valign="-1"/>')
        if scene.scene_time_text:
            bits.append(_esc(scene.scene_time_text))
        if bits:
            context.append(
                Paragraph(" ".join(bits), _STYLES["entity_context"])
            )

    if options.include_scene_cm_block and scene.cm_groups:
        context.extend(_render_scene_cm_block(scene.cm_groups, options))

    if options.include_scene_pov_line and scene.pov_entity_name:
        context.append(
            Paragraph(f"POV: {_esc(scene.pov_entity_name)}", _STYLES["pov_line"])
        )

    if options.include_entity_context_line and scene.entity_context_groups:
        context.extend(_render_entity_context(scene.entity_context_groups, options))

    if context:
        flowables.extend(_boxed_block(context, options))

    if options.include_scene_body and scene.main_content_html.strip():
        flowables.extend(_tiptap_to_flowables(scene.main_content_html))

    # Phase 5.8b — the Scene Changes block is metadata, not prose, so it goes
    # in a light-grey box (after the prose) like the description / context.
    if options.include_scene_changes_block and scene.changes:
        change_flow = _render_scene_changes(scene.changes, options)
        if change_flow:
            flowables.extend(_boxed_block(change_flow, options))

    return flowables


def _render_scene_cm_block(groups: list[ExportSceneCMGroup], options: ExportOptions) -> list:
    """Phase 1.22i — Circumstances & Motivators block. Header
    paragraph + nested per-group / per-row indented paragraphs.

    Phase 1.25c — each row leads with the c/m type badge (slate `C` /
    rust `M` pentagon) and trails with the intensity badge when set,
    matching the HTML rendering. Badges are rendered as small PNGs
    inline via Paragraph's `<img>` mini-HTML support; the same source
    geometry as the HTML SVG comes from `services.export_icons`.
    """
    out: list = []
    if not groups:
        return out
    out.append(Paragraph("<b>Circumstances &amp; Motivators:</b>", _STYLES["changes_header"]))
    for group in groups:
        if not group.rows:
            continue
        type_part = f" ({_esc(group.entity_type)})" if group.entity_type else ""
        out.append(Paragraph(
            f"&nbsp;&nbsp;• <b>{_esc(group.label)}</b>{type_part}",
            _STYLES["changes_entity"],
        ))
        for row in group.rows:
            name = (row.name or "").strip()
            desc = (row.description or "").strip()
            # Primary label is the name; with no name it's the body, which
            # renders inline markdown (Phase 5.8b).
            if name:
                label_part = _esc(name)
            elif desc:
                label_part = _inline_field(desc, options)
            else:
                label_part = "(unnamed)"
            type_badge = _cm_type_badge_inline_html(
                _PREFIX_TO_ATTRIBUTE_TYPE.get(row.prefix, "")
            )
            type_badge_part = f"{type_badge} " if type_badge else ""
            intensity_badge_part = ""
            if row.intensity is not None:
                intensity_badge_part = " " + _intensity_badge_inline_html(row.intensity)
            # Body after the name (when both present and distinct), inline md.
            desc_part = ""
            if desc and name and desc != name:
                desc_part = f" : {_inline_field(desc, options)}"
            out.append(Paragraph(
                f"&nbsp;&nbsp;&nbsp;&nbsp;{type_badge_part}<b>{_esc(row.prefix)}:</b> "
                f"{label_part}{intensity_badge_part}{desc_part}",
                _STYLES["changes_detail"],
            ))
    return out


def _render_entity_context(
    groups: list[ExportSceneEntityGroup],
    options: ExportOptions,
) -> list:
    use_colours = options.use_entity_colours
    flowables: list = []
    for group in groups:
        if not group.entries:
            continue
        name_bits: list[str] = []
        for entry in group.entries:
            name_txt = _esc(entry.name)
            if use_colours and entry.colour:
                name_bits.append(
                    f'<font color="{_esc(entry.colour)}">{name_txt}</font>'
                )
            else:
                name_bits.append(name_txt)
        flowables.append(
            Paragraph(
                f"<b>{_esc(group.label)}:</b> {', '.join(name_bits)}",
                _STYLES["entity_context"],
            )
        )
    return flowables


def _render_scene_changes(
    changes: list[ExportSceneEntityChange],
    options: ExportOptions,
) -> list:
    allowed_categories: set[str] = set()
    if options.include_metadata_changes:
        allowed_categories.add("metadata")
    if options.include_attribute_changes:
        allowed_categories.add("attribute")
    if options.include_relationship_changes:
        allowed_categories.add("relationship")

    if not allowed_categories:
        return []

    filtered: list[tuple[ExportSceneEntityChange, list[ExportChangeDetail]]] = []
    for change in changes:
        details = [d for d in change.details if d.category in allowed_categories]
        if details:
            filtered.append((change, details))

    if not filtered:
        return []

    use_colours = options.use_entity_colours
    flowables: list = [
        Paragraph("Changes recorded at this scene:", _STYLES["changes_header"]),
    ]
    for change, details in filtered:
        name_txt = _esc(change.entity_name)
        if use_colours and change.colour:
            name_txt = f'<font color="{_esc(change.colour)}">{name_txt}</font>'
        flowables.append(
            Paragraph(
                f"{name_txt} ({_esc(change.entity_type)})",
                _STYLES["changes_entity"],
            )
        )
        for detail in details:
            flowables.append(
                Paragraph(
                    _render_change_detail_pdf(detail),
                    _STYLES["changes_detail"],
                )
            )
    return flowables


# Action glyph + colour for the subchip-style change rendering.
# Pure ASCII glyphs because Helvetica (the default ReportLab font)
# doesn't carry the ✚ / ✱ / ⚊ characters HTML uses; they render as
# missing-glyph squares. Colours mirror the HTML palette
# (`frontend/src/components/ui/ChangeChipBase.jsx ACTION_COLOR`).
_CHANGE_ACTION_GLYPH_PDF = {"add": "+", "modify": "~", "remove": "−"}
_CHANGE_ACTION_COLOUR_PDF = {
    "add": "#16a34a",     # green-600 — readable on white at small size
    "modify": "#d97706",  # amber-600
    "remove": "#dc2626",  # red-600
}


def _render_change_detail_pdf(detail: ExportChangeDetail) -> str:
    """Render one ExportChangeDetail as inline Paragraph markup.
    When the structured `action` / `field_name` fields are populated
    (Phase 1.25c subchip data model), produce a subchip-shaped row
    matching the HTML output:

        [+ FieldName : "value"]              # add
        [~ FieldName : "old" → "new"]        # modify with transition
        [~ FieldName : "value"]              # modify with new only
        [− FieldName]                        # remove

    Falls back to the pre-formatted `text` for compound modifies / list
    ops / relationship change rows that don't carry structured data."""
    if detail.action and detail.field_name:
        glyph = _CHANGE_ACTION_GLYPH_PDF.get(detail.action, "~")
        colour = _CHANGE_ACTION_COLOUR_PDF.get(detail.action, "#555555")
        glyph_html = f'<font color="{colour}"><b>{glyph}</b></font>'
        field_html = _esc(detail.field_name)
        value_html = ""
        if detail.old_value is not None and detail.new_value is not None:
            value_html = (
                f' <font color="#888888"><strike>"{_esc(detail.old_value)}"</strike></font>'
                f' → "<b>{_esc(detail.new_value)}</b>"'
            )
        elif detail.new_value is not None:
            value_html = f' : "<b>{_esc(detail.new_value)}</b>"'
        return f"{glyph_html} <b>{field_html}</b>{value_html}"
    # Fallback — text-only path for shapes without structured data.
    return f"<i>{_esc(detail.category)}</i> — {_esc(detail.text)}"


# ── Appendices ─────────────────────────────────────────────────────────


def _render_offscreen_appendix(
    scenes: list[ExportScene],
    options: ExportOptions,
) -> list:
    flowables: list = [
        Paragraph("OFF-SCREEN SCENES", _STYLES["act_heading"]),
        Paragraph(
            "Non-POV scenes, presented in canvas order.",
            _STYLES["appendix_note"],
        ),
    ]
    for scene in scenes:
        scene_flowables = _render_scene(scene, options)
        if scene_flowables:
            # Phase 5.8b — off-screen scenes flow naturally too.
            flowables.extend(scene_flowables)
    return flowables


def _render_entity_sheets(
    sheets: list[ExportEntitySheet],
    options: ExportOptions,
) -> list:
    flowables: list = [
        Paragraph("ENTITY REFERENCE SHEETS", _STYLES["act_heading"]),
    ]
    for sheet in sheets:
        sheet_flowables = _render_entity_sheet(sheet, options)
        if sheet_flowables:
            flowables.append(KeepTogether(sheet_flowables))
    return flowables


def _render_knowledge_sheets(
    sheets: list[ExportKnowledgeSheet],
    options: ExportOptions,
) -> list:
    """Phase 1.25c — Knowledge appendix. Rendered after entity sheets,
    own page, parallel structure to entity sheets."""
    flowables: list = [
        Paragraph("KNOWLEDGE", _STYLES["act_heading"]),
    ]
    for sheet in sheets:
        sheet_flowables = _render_knowledge_sheet(sheet, options)
        if sheet_flowables:
            flowables.append(KeepTogether(sheet_flowables))
    return flowables


def _render_knowledge_sheet(sheet: ExportKnowledgeSheet, options: ExportOptions) -> list:
    """One Knowledge appendix entry. Uses the same two-column layout
    as `_render_entity_sheet` when a profile image is set, otherwise
    stacks vertically."""
    use_colour = bool(options.use_entity_colours and sheet.colour)
    name_markup = _esc(sheet.name)
    if use_colour:
        name_markup = f'<font color="{_esc(sheet.colour)}">{name_markup}</font>'
    # Short identity header beside the image; long content flows below
    # (see `_render_entity_sheet` — a table row cannot break a page).
    header_text: list = [
        Paragraph(name_markup, _STYLES["entity_sheet_name"]),
        Paragraph("Knowledge", _STYLES["entity_sheet_type"]),
    ]
    body_flowables: list = []
    body_flowables.extend(
        _block_field_flowables(sheet.description, options, _STYLES["entity_sheet_description"], compact=True)
    )
    if sheet.source_event_scene_title:
        body_flowables.append(
            Paragraph(
                f"<i>First established at: {_esc(sheet.source_event_scene_title)}</i>",
                _STYLES["entity_sheet_attribute"],
            )
        )
    if sheet.notes and sheet.notes.strip():
        body_flowables.append(Paragraph("<b>Notes:</b>", _STYLES["changes_header"]))
        body_flowables.extend(
            _block_field_flowables(sheet.notes, options, _STYLES["entity_sheet_attribute"], compact=True)
        )
    if sheet.chain_history:
        body_flowables.append(Paragraph("<b>Chain history:</b>", _STYLES["changes_header"]))
        for entry in sheet.chain_history:
            scene_part = (
                f" — {_esc(entry.scene_title)}"
                if entry.scene_title else ""
            )
            body_flowables.append(
                Paragraph(
                    f"<i>{_esc(entry.kind)}</i> — {_esc(entry.text)}{scene_part}",
                    _STYLES["entity_sheet_attribute"],
                )
            )

    profile_img: Optional[Image] = None
    if options.embed_assets and sheet.profile_image_data_uri:
        profile_img = _decode_data_uri_image(
            sheet.profile_image_data_uri,
            max_width=72.0,
            max_height=72.0,
        )
    if profile_img is not None:
        table_style_cmds = [
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]
        if use_colour:
            try:
                border_colour = HexColor(sheet.colour)
                table_style_cmds.append(("BOX", (0, 0), (0, 0), 1.5, border_colour))
                table_style_cmds.append(("LEFTPADDING", (0, 0), (0, 0), 2))
                table_style_cmds.append(("RIGHTPADDING", (0, 0), (0, 0), 2))
                table_style_cmds.append(("TOPPADDING", (0, 0), (0, 0), 2))
                table_style_cmds.append(("BOTTOMPADDING", (0, 0), (0, 0), 2))
            except Exception:
                pass
        table = Table(
            [[profile_img, header_text]],
            colWidths=[84.0, None],
            hAlign="LEFT",
        )
        table.setStyle(TableStyle(table_style_cmds))
        return [table] + body_flowables
    return header_text + body_flowables


def _render_entity_sheet(sheet: ExportEntitySheet, options: ExportOptions) -> list:
    """Render a single entity reference sheet. When `embed_assets` is
    on AND the sheet has a profile image, lay out as a two-column
    table (image left, name / type / description / attributes /
    relationships right). Otherwise stack everything vertically."""
    use_colour = bool(options.use_entity_colours and sheet.colour)

    # Name heading: wrap in a coloured font run when per-entity
    # colours are on.
    name_markup = _esc(sheet.name)
    if use_colour:
        name_markup = f'<font color="{_esc(sheet.colour)}">{name_markup}</font>'

    # Identity header that sits BESIDE the profile image. Kept short
    # (name + type only) so the image/header table row always fits on
    # one page — a ReportLab table row CANNOT break across pages, so
    # anything tall in this row would overflow the frame and raise a
    # LayoutError. Everything longer (description, attributes,
    # relationships, notes) goes in `body_flowables` below the table as
    # normal splittable flowables.
    header_text: list = [
        Paragraph(name_markup, _STYLES["entity_sheet_name"]),
        Paragraph(_esc((sheet.type or "").capitalize()), _STYLES["entity_sheet_type"]),
    ]

    body_flowables: list = []

    # Phase 1.25c — aliases line (when the entity has any).
    alias_values = [a for a in (sheet.aliases or []) if a]
    if alias_values:
        joined = " / ".join(_esc(a) for a in alias_values)
        body_flowables.append(
            Paragraph(f"<i>also: {joined}</i>", _STYLES["entity_sheet_description"])
        )

    body_flowables.extend(
        _block_field_flowables(sheet.description, options, _STYLES["entity_sheet_description"], compact=True)
    )

    # Non-file attributes: always rendered.
    for attr in sheet.attributes:
        if attr.attribute_type == "file":
            continue
        body_flowables.extend(_render_attribute_flowable(attr, options))

    # File-type attributes: rendered only when media embedding is
    # on AND the kind-specific toggle is on. Image attributes embed
    # the image inline; audio/video surface as placeholder paragraphs
    # since PDF can't play them back.
    if options.include_media_attributes:
        for attr in sheet.attributes:
            if attr.attribute_type != "file":
                continue
            media_flowables = _render_file_attribute_flowables(attr, options)
            body_flowables.extend(media_flowables)

    if sheet.relationships:
        body_flowables.append(Paragraph("<b>Relationships:</b>", _STYLES["changes_header"]))
        for rel in sheet.relationships:
            body_flowables.extend(_render_relationship_flowable(rel, options))

    # Phase 1.25c — Notes sub-section (entity.notes, free-form text).
    if options.include_entity_notes and sheet.notes and sheet.notes.strip():
        body_flowables.append(Paragraph("<b>Notes:</b>", _STYLES["changes_header"]))
        body_flowables.extend(
            _block_field_flowables(sheet.notes, options, _STYLES["entity_sheet_attribute"], compact=True)
        )

    # Optional profile image on the left. Only when `embed_assets` is
    # on AND the sheet actually has a profile image data URI.
    profile_img: Optional[Image] = None
    if options.embed_assets and sheet.profile_image_data_uri:
        profile_img = _decode_data_uri_image(
            sheet.profile_image_data_uri,
            max_width=72.0,   # 1 inch @ 72 DPI
            max_height=72.0,
        )

    if profile_img is not None:
        # Two-column layout: image left, short identity header right.
        # Only the header rides in the table; the body flows below it
        # (splittable). When per-entity colours are on, the image cell
        # gains a 1.5pt border in the entity's colour — matches the
        # HTML renderer's behaviour.
        table_style_cmds = [
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]
        if use_colour:
            try:
                border_colour = HexColor(sheet.colour)
                table_style_cmds.append(("BOX", (0, 0), (0, 0), 1.5, border_colour))
                table_style_cmds.append(("LEFTPADDING", (0, 0), (0, 0), 2))
                table_style_cmds.append(("RIGHTPADDING", (0, 0), (0, 0), 2))
                table_style_cmds.append(("TOPPADDING", (0, 0), (0, 0), 2))
                table_style_cmds.append(("BOTTOMPADDING", (0, 0), (0, 0), 2))
            except Exception:
                pass  # Bad hex → no border, continue gracefully.

        table = Table(
            [[profile_img, header_text]],
            colWidths=[84.0, None],  # 72pt image + 12pt gutter
            hAlign="LEFT",
        )
        table.setStyle(TableStyle(table_style_cmds))
        return [table] + body_flowables

    return header_text + body_flowables


def _inline_md_markup(text: str) -> str:
    """Phase 5.8b — inline markdown → ReportLab Paragraph markup, for a
    short value rendered on its label's line. markdown-it inline tags are
    remapped to the subset ReportLab's Paragraph understands."""
    h = field_markdown_to_inline_html(text)
    h = h.replace("<strong>", "<b>").replace("</strong>", "</b>")
    h = h.replace("<em>", "<i>").replace("</em>", "</i>")
    h = h.replace("<s>", "<strike>").replace("</s>", "</strike>")
    h = h.replace("<code>", '<font face="Courier">').replace("</code>", "</font>")
    return h


def _inline_field(text: str, options: ExportOptions) -> str:
    """Phase 5.8b — an inline-rendered free-form body field (circumstance /
    motivator / perspective body, relationship description / perception):
    inline markdown when enabled, else escaped text. Empty → ""."""
    inner = (text or "").strip()
    if not inner:
        return ""
    if options.render_markdown_in_text_fields:
        return _inline_md_markup(inner)
    return _esc(inner)


def _render_attribute_flowable(attr: ExportAttribute, options: ExportOptions) -> list:
    """Render one entity-sheet attribute as a list of flowables. A free-form
    text value renders markdown when enabled (Phase 5.8b): inline on the
    label's line when short, or as its own block below the label when it
    carries block structure (headings / lists / multiple paragraphs)."""
    name = _esc(attr.name or "(unnamed)")
    style = _STYLES["entity_sheet_attribute"]
    if attr.attribute_type in ("text_list", "entity_list"):
        return [Paragraph(f"<b>{name}:</b> {_esc(attr.value or '')}", style)]
    if attr.attribute_type == "perspective":
        # Phase 5.8b — first-person view on another object; body renders
        # inline markdown when enabled.
        body_part = _inline_field(attr.description, options)
        target = _esc(attr.perspective_target or "")
        if target and body_part:
            inner = f"Perspective on {target}: {body_part}"
        elif target:
            inner = f"Perspective on {target}"
        else:
            inner = body_part
        return [Paragraph(f"<b>{name}:</b> {inner}", style)]
    raw = attr.value or ""
    if options.render_markdown_in_text_fields and raw.strip():
        if is_block_markdown(raw):
            return [Paragraph(f"<b>{name}:</b>", style)] + _tiptap_to_flowables(
                field_markdown_to_html(raw), compact=True
            )
        return [Paragraph(f"<b>{name}:</b> {_inline_md_markup(raw)}", style)]
    return [Paragraph(f"<b>{name}:</b> {_esc(raw or '—')}", style)]


def _render_file_attribute_flowables(
    attr: ExportAttribute,
    options: ExportOptions,
) -> list:
    """Render a file-type entity attribute on an entity reference
    sheet. Respects the media kind toggles: images embed inline as
    `Image` flowables, audio/video surface as `[Audio: name]` /
    `[Video: name]` placeholder paragraphs, anything else drops
    through silently."""
    name = _esc(attr.name or "(unnamed)")
    kind = (attr.media_kind or "other").lower()

    if kind == "image":
        if not options.include_media_attribute_images:
            return []
        img = _decode_data_uri_image(
            attr.file_ref_data_uri,
            max_width=4.0 * inch,
            max_height=3.0 * inch,
        )
        if img is None:
            return [
                Paragraph(
                    f"<b>{name}:</b> <i>[image could not be embedded]</i>",
                    _STYLES["entity_sheet_attribute"],
                )
            ]
        return [
            Paragraph(f"<b>{name}:</b>", _STYLES["entity_sheet_attribute"]),
            img,
        ]

    if kind == "audio":
        if not options.include_media_attribute_audio:
            return []
        return [
            Paragraph(
                f"<b>{name}:</b> <i>[Audio attachment — not playable in PDF]</i>",
                _STYLES["entity_sheet_attribute"],
            )
        ]

    if kind == "video":
        if not options.include_media_attribute_video:
            return []
        return [
            Paragraph(
                f"<b>{name}:</b> <i>[Video attachment — not playable in PDF]</i>",
                _STYLES["entity_sheet_attribute"],
            )
        ]

    # Unknown media kind: silent drop.
    return []


def _render_relationship_flowable(
    rel: ExportEntityRelationship,
    options: ExportOptions,
) -> list:
    label = _esc(rel.display_label or "(unnamed)")
    # Colour the label using the first other participant's colour when
    # per-entity colours are on and there is exactly one other participant.
    if options.use_entity_colours and rel.other_participants:
        participant_colour = rel.other_participants[0].entity_colour
        if participant_colour:
            label = f'<font color="{_esc(participant_colour)}">{label}</font>'
    flag_bits: list[str] = []
    if rel.is_membership:
        flag_bits.append("MEMBERSHIP")
    if rel.has_hierarchy:
        flag_bits.append("HIERARCHY")
    flag_part = (
        f' <font color="#888888" size="7">[{" / ".join(flag_bits)}]</font>'
        if flag_bits else ""
    )
    flowables: list = [Paragraph(f"<b>{label}</b>{flag_part}", _STYLES["entity_sheet_attribute"])]
    description = (rel.description or "").strip()
    if description:
        flowables.append(Paragraph(
            f"<i>{_inline_field(description, options)}</i>",
            _STYLES["entity_sheet_attribute"],
        ))
    role = (rel.own_role or "").strip()
    if role:
        flowables.append(Paragraph(
            f"<i>Role:</i> {_esc(role)}",
            _STYLES["entity_sheet_attribute"],
        ))
    perception = (rel.own_perception or "").strip()
    if perception:
        flowables.append(Paragraph(
            f"<i>{_inline_field(perception, options)}</i>",
            _STYLES["entity_sheet_attribute"],
        ))
    return flowables


# ── Small helpers ──────────────────────────────────────────────────────


_RL_ESCAPE_MAP = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
}
_RL_ESCAPE_RE = re.compile("([&<>])")


def _esc(text: str) -> str:
    """Escape the three characters ReportLab's mini-HTML treats
    specially inside a `Paragraph` text run: `&`, `<`, `>`. Everything
    else (quotes, punctuation, unicode) passes through untouched."""
    if not text:
        return ""
    return _RL_ESCAPE_RE.sub(lambda m: _RL_ESCAPE_MAP[m.group(1)], str(text))


def _decode_data_uri_image(
    data_uri: Optional[str],
    max_width: float,
    max_height: float,
) -> Optional[Image]:
    """Decode a `data:image/...;base64,...` URI into a ReportLab
    `Image` flowable scaled to fit inside `max_width` × `max_height`
    while preserving aspect ratio. Returns `None` on any failure
    (malformed URI, unsupported image, decode error) so a single bad
    asset never breaks the whole export.

    Phase 1.25c — pre-normalise the image via Pillow before handing
    to ReportLab. ReportLab can render PNG/JPEG natively but renders
    several common upload formats as gray-square placeholders:
    CMYK-mode JPEGs, RGBA PNGs with non-trivial alpha, palette-mode
    indexed PNGs, animated GIFs (renders only the wrong frame, or
    fails entirely), WebP / AVIF / HEIC. Profile images dodge this
    because the in-app crop dialog re-encodes everything as standard
    RGB PNG; user-uploaded file-attribute images keep their original
    encoding and trip the renderer.

    Fix: pass every image through Pillow first — open, normalise the
    mode (CMYK / P / LA / 1 → RGB; RGBA → RGB on white), save back
    as a fresh PNG buffer. ReportLab then sees a vanilla RGB PNG
    every time, regardless of source format. Pillow comes in as a
    transitive dep of reportlab so no new dependency.
    """
    if not data_uri or not data_uri.startswith("data:"):
        return None
    try:
        from PIL import Image as PILImage  # transitive via reportlab
        header, _, b64 = data_uri.partition(",")
        if not b64:
            return None
        raw = base64.b64decode(b64)
        with PILImage.open(BytesIO(raw)) as pil_img:
            # Force the first frame for animated formats (GIF, WebP).
            try:
                pil_img.seek(0)
            except (EOFError, AttributeError):
                pass
            # Normalise mode. RGBA composites onto white so the
            # transparent regions render as white in the PDF (closer
            # to how an alpha-aware viewer would show the image
            # against its background); CMYK / palette / grayscale-
            # alpha all coerce to RGB.
            mode = pil_img.mode
            if mode in ("RGBA", "LA"):
                bg = PILImage.new("RGB", pil_img.size, (255, 255, 255))
                # Use the alpha channel as the mask if present.
                alpha = pil_img.split()[-1]
                bg.paste(pil_img.convert("RGB"), mask=alpha)
                normalised = bg
            elif mode != "RGB":
                normalised = pil_img.convert("RGB")
            else:
                normalised = pil_img.copy()
            png_buf = BytesIO()
            normalised.save(png_buf, format="PNG")
            png_buf.seek(0)
        img = Image(png_buf)
        # Scale proportionally into the bounding box.
        natural_w = float(img.drawWidth or max_width)
        natural_h = float(img.drawHeight or max_height)
        if natural_w <= 0 or natural_h <= 0:
            return None
        scale = min(max_width / natural_w, max_height / natural_h, 1.0)
        img.drawWidth = natural_w * scale
        img.drawHeight = natural_h * scale
        return img
    except Exception:
        return None


# ── TipTap HTML → ReportLab flowables ──────────────────────────────────


class _TipTapToReportLab(HTMLParser):
    """Convert TipTap StarterKit HTML into a list of ReportLab
    flowables (Paragraph / Preformatted / Spacer / HRFlowable). Each
    block-level tag becomes one flowable; inline tags (`<strong>`,
    `<em>`, `<u>`, `<a>`, `<br/>`) are converted into ReportLab's
    mini-HTML markup and inlined into the containing block's text.

    Sibling class to markdown.py's `_TipTapToMarkdown` and txt.py's
    `_TipTapToText`. Shares no code with either — each renderer
    carries its own HTML parser per the renderer-independence
    rule.

    Silently drops: `<img>`, `<video>`, `<audio>`, `<picture>`,
    `<source>`, `<figure>`, `<figcaption>` and their children. Plain
    PDFs don't embed media from this renderer (image embedding is a
    follow-up item if the user asks for it).
    """

    _MEDIA_VOID = {"img", "source"}
    _MEDIA_CONTAINER = {"video", "audio", "picture", "figure", "figcaption"}

    def __init__(self, compact: bool = False, flat_lists: bool = False) -> None:
        super().__init__(convert_charrefs=True)
        self.flowables: list = []
        # Phase 5.8b — compact mode renders at entity-sheet text size so a
        # markdown block sits consistently with the surrounding sheet detail.
        self._compact = compact
        # Phase 5.8b — flat_lists emits each <li> as its own standalone
        # bulleted paragraph (rather than collecting them into one atomic
        # ListFlowable). Used when the output goes into a multi-row table
        # (the scene-description box) so the table can split between list
        # items across pages instead of overflowing a single unsplittable row.
        self._flat_lists = flat_lists
        # Text accumulated for the current inline block; gets wrapped
        # into a Paragraph when the containing block closes.
        self._current_text: list[str] = []
        self._current_style_name: str = "body_paragraph"
        self._list_stack: list[dict] = []
        self._pending_list_items: list = []
        self._skip_depth = 0
        self._in_pre = False
        self._pre_text: list[str] = []
        self._link_hrefs: list[str] = []

    def _style(self, name: str):
        """Resolve a style name, swapping in the compact variant when this
        converter is rendering inside an entity reference sheet."""
        if self._compact and f"{name}_compact" in _STYLES:
            return _STYLES[f"{name}_compact"]
        return _STYLES[name]

    # ── Buffer management ─────────────────────────────────────────

    def _push_text(self, text: str) -> None:
        if self._skip_depth > 0:
            return
        self._current_text.append(text)

    def _finish_text_block(self, style_name: str) -> None:
        raw = "".join(self._current_text).strip()
        self._current_text = []
        if not raw:
            return
        # Collapse internal whitespace runs.
        cleaned = re.sub(r"\s+", " ", raw)
        try:
            self.flowables.append(Paragraph(cleaned, self._style(style_name)))
        except Exception:
            # Paragraph can raise if the mini-HTML is malformed. Fall
            # back to a stripped-tags plain version so we never lose
            # the scene body to a parser quirk.
            stripped = re.sub(r"<[^>]+>", "", cleaned)
            self.flowables.append(Paragraph(_esc(stripped), self._style(style_name)))

    # ── Tag dispatch ──────────────────────────────────────────────

    def handle_starttag(self, tag: str, attrs: list) -> None:  # type: ignore[override]
        if self._skip_depth > 0:
            if tag not in self._MEDIA_VOID and tag not in ("br", "hr"):
                self._skip_depth += 1
            return

        if tag in self._MEDIA_VOID:
            return
        if tag in self._MEDIA_CONTAINER:
            self._skip_depth = 1
            return

        if tag == "p":
            self._finish_text_block(self._current_style_name)
            self._current_style_name = "body_paragraph"
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._finish_text_block(self._current_style_name)
            # Scene body headings render as body paragraphs with
            # bold text, avoiding collision with the document's own
            # structural heading hierarchy.
            self._current_style_name = "body_paragraph"
            self._push_text("<b>")
        elif tag in ("strong", "b"):
            self._push_text("<b>")
        elif tag in ("em", "i"):
            self._push_text("<i>")
        elif tag == "u":
            self._push_text("<u>")
        elif tag in ("s", "del", "strike"):
            self._push_text("<strike>")
        elif tag == "code":
            if not self._in_pre:
                self._push_text("<font face='Courier'>")
        elif tag == "pre":
            self._finish_text_block(self._current_style_name)
            self._in_pre = True
            self._pre_text = []
        elif tag == "blockquote":
            self._finish_text_block(self._current_style_name)
            self._current_style_name = "blockquote"
        elif tag in ("ul", "ol"):
            self._finish_text_block(self._current_style_name)
            self._list_stack.append({"type": tag, "items": [], "n": 0})
        elif tag == "li":
            # Start collecting text for this list item. We use a
            # sub-paragraph per item and wrap them in a ListFlowable
            # when the list closes (or, in flat_lists mode, emit each as
            # its own standalone bulleted paragraph).
            self._current_text = []
        elif tag == "a":
            href = ""
            for key, value in attrs:
                if key == "href":
                    href = value or ""
                    break
            self._link_hrefs.append(href)
            if href:
                self._push_text(f'<link href="{_esc(href)}" color="#1a73e8">')
            else:
                self._push_text("<u>")
        elif tag == "br":
            self._push_text("<br/>")
        elif tag == "hr":
            self._finish_text_block(self._current_style_name)
            self.flowables.append(
                HRFlowable(
                    width="80%",
                    thickness=0.5,
                    color=HexColor("#cccccc"),
                    hAlign="CENTER",
                    spaceBefore=6,
                    spaceAfter=6,
                )
            )
        # Unknown tags: transparent (text content flows through).

    def handle_endtag(self, tag: str) -> None:  # type: ignore[override]
        if self._skip_depth > 0:
            if tag in self._MEDIA_CONTAINER:
                self._skip_depth -= 1
            elif tag not in self._MEDIA_VOID and tag not in ("br", "hr"):
                self._skip_depth -= 1
            return

        if tag == "p":
            self._finish_text_block(self._current_style_name)
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._push_text("</b>")
            self._finish_text_block(self._current_style_name)
        elif tag in ("strong", "b"):
            self._push_text("</b>")
        elif tag in ("em", "i"):
            self._push_text("</i>")
        elif tag == "u":
            self._push_text("</u>")
        elif tag in ("s", "del", "strike"):
            self._push_text("</strike>")
        elif tag == "code":
            if not self._in_pre:
                self._push_text("</font>")
        elif tag == "pre":
            pre_content = "".join(self._pre_text).rstrip()
            if pre_content:
                try:
                    self.flowables.append(
                        Preformatted(pre_content, _STYLES["preformatted"])
                    )
                except Exception:
                    pass
            self._pre_text = []
            self._in_pre = False
        elif tag == "blockquote":
            self._finish_text_block("blockquote")
            self._current_style_name = "body_paragraph"
        elif tag == "li":
            raw = "".join(self._current_text).strip()
            self._current_text = []
            if raw and self._list_stack:
                cleaned = re.sub(r"\s+", " ", raw)
                ctx = self._list_stack[-1]
                if self._flat_lists:
                    # Each item is its own standalone bulleted paragraph so a
                    # containing table can split between items across pages.
                    ctx["n"] += 1
                    marker = "•  " if ctx["type"] == "ul" else f"{ctx['n']}.  "
                    try:
                        para = Paragraph(marker + cleaned, self._style("list_item"))
                    except Exception:
                        stripped = re.sub(r"<[^>]+>", "", cleaned)
                        para = Paragraph(marker + _esc(stripped), self._style("list_item"))
                    self.flowables.append(para)
                else:
                    try:
                        para = Paragraph(cleaned, self._style("list_item"))
                    except Exception:
                        stripped = re.sub(r"<[^>]+>", "", cleaned)
                        para = Paragraph(_esc(stripped), self._style("list_item"))
                    ctx["items"].append(ListItem(para))
        elif tag in ("ul", "ol"):
            if self._list_stack:
                ctx = self._list_stack.pop()
                if ctx["items"] and not self._flat_lists:
                    bullet_type = "bullet" if ctx["type"] == "ul" else "1"
                    try:
                        self.flowables.append(
                            ListFlowable(
                                ctx["items"],
                                bulletType=bullet_type,
                                leftIndent=18,
                                bulletFontName="Helvetica",
                                bulletFontSize=10,
                            )
                        )
                    except Exception:
                        # Fall back to inlined bullets.
                        for item in ctx["items"]:
                            self.flowables.append(item)
        elif tag == "a":
            href = self._link_hrefs.pop() if self._link_hrefs else ""
            if href:
                self._push_text("</link>")
            else:
                self._push_text("</u>")

    def handle_data(self, data: str) -> None:  # type: ignore[override]
        if self._skip_depth > 0:
            return
        if self._in_pre:
            self._pre_text.append(data)
            return
        self._push_text(_esc(data))

    # ── Public API ────────────────────────────────────────────────

    def convert(self, html_text: str) -> list:
        self.feed(html_text or "")
        # Drain any remaining text in the buffer into a final block.
        self._finish_text_block(self._current_style_name)
        return self.flowables


def _tiptap_to_flowables(html_text: str, compact: bool = False, flat_lists: bool = False) -> list:
    converter = _TipTapToReportLab(compact=compact, flat_lists=flat_lists)
    return converter.convert(html_text)


# ── Registry binding ───────────────────────────────────────────────────


def render(model: ExportModel, options: Optional[ExportOptions] = None) -> bytes:
    return render_pdf(model, options)


SPEC = RendererSpec(
    format_id="pdf",
    label="PDF",
    extension="pdf",
    mime_type="application/pdf",
    render=render,
    capabilities=frozenset({
        # PDF is paginated — honours `ExportOptions.page_size`
        # ("a4" | "letter") and enforces the shared Pagination model
        # via PageBreak + KeepTogether flowables.
        "pagination",
        # PDF embeds profile images on entity reference sheets via
        # decoded base64 data URIs from `ExportEntitySheet
        # .profile_image_data_uri` when `embed_assets` is on.
        "embedded_assets",
        # PDF embeds image file attributes on entity reference sheets
        # as inline Image flowables when `include_media_attributes` +
        # `include_media_attribute_images` are both on. Audio/video
        # attributes surface as "[Audio: name]" / "[Video: name]"
        # placeholder paragraphs because PDF can't play them back.
        "embedded_media",
        # PDF wraps entity name text in `<font color="...">` runs when
        # `use_entity_colours` is on. Entity sheet name headings +
        # profile image Table border also adopt the entity's colour.
        "entity_colours",
    }),
)
register(SPEC)
