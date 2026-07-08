"""Phase 1.25e — Shunn manuscript PDF renderer.

Consumes the format-agnostic event stream from `services.shunn_walker`
and produces a submission-ready PDF matching the Shunn novel-format
specification. Sibling to `docx_shunn.py`; both renderers walk the same
event stream so content sequencing stays consistent.

Implementation rules mirror the DOCX renderer (see that module for
notes). The ReportLab specifics:
  - `BaseDocTemplate` + two `PageTemplate`s: `TitlePage` (no header,
    page numbering suppressed) and `Body` (running header in the top
    right, body frame below). The first PageTemplate built into the
    document flow is the title page; the rest of the flow uses the
    body template via a `NextPageTemplate('Body')` flowable.
  - Times-Roman + Times-Bold + Times-Italic + Times-BoldItalic are
    ReportLab's built-in font family aliases — no installation needed
    on the rendering machine. They're a serif default; rendering
    machines that have actual Times New Roman installed see no
    difference.
  - Double spacing implemented via `leading = 24pt` (12pt × 2).
  - First-line indent on body paragraphs implemented via
    `firstLineIndent = 0.5 inch`; flush-left paragraphs use a separate
    style with no indent.
  - Page break before chapter heading via `PageBreak()` flowable;
    vertical spacing pushes the heading ~1/3 down the page.
  - Running header drawn directly onto the canvas via the body
    PageTemplate's `onPage` callback.
"""
from __future__ import annotations

from io import BytesIO
from typing import Optional

from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4, letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
)

from services.export_service import ExportModel, ExportOptions
from services.shunn_walker import (
    ChapterStartEvent,
    EndMarkerEvent,
    ParagraphEvent,
    Run,
    SceneBreakEvent,
    TitlePageEvent,
    author_last_name,
    shortened_title,
    walk_shunn,
)
from .registry import RendererSpec, register


# Body styles — built once at module import time.
_BODY = ParagraphStyle(
    "ShunnBody",
    fontName="Times-Roman",
    fontSize=12,
    leading=24,                     # double-spaced
    firstLineIndent=0.5 * inch,
    spaceBefore=0,
    spaceAfter=0,
    alignment=TA_LEFT,              # ragged-right per spec
)
_BODY_FLUSH = ParagraphStyle(
    "ShunnBodyFlush",
    parent=_BODY,
    firstLineIndent=0,
)
_CONTACT = ParagraphStyle(
    "ShunnContact",
    fontName="Times-Roman",
    fontSize=12,
    leading=14,                     # single-spaced contact block
    alignment=TA_LEFT,
)
_WORDCOUNT = ParagraphStyle(
    "ShunnWordCount",
    fontName="Times-Roman",
    fontSize=12,
    leading=14,
    alignment=TA_RIGHT,
)
_TITLE = ParagraphStyle(
    "ShunnTitle",
    fontName="Times-Bold",
    fontSize=14,
    leading=18,
    alignment=TA_CENTER,
)
_BYLINE = ParagraphStyle(
    "ShunnByline",
    fontName="Times-Roman",
    fontSize=12,
    leading=18,
    alignment=TA_CENTER,
)
_CHAPTER = ParagraphStyle(
    "ShunnChapter",
    fontName="Times-Bold",
    fontSize=14,
    leading=24,
    alignment=TA_CENTER,
)
_CENTRED_SYMBOL = ParagraphStyle(
    "ShunnCentredSymbol",
    fontName="Times-Roman",
    fontSize=12,
    leading=24,
    alignment=TA_CENTER,
)


# ── Public entry ──────────────────────────────────────────────────────


def render_pdf_shunn(model: ExportModel, options: Optional[ExportOptions] = None) -> bytes:
    """Render the model as a Shunn-compliant PDF."""
    options = options or ExportOptions()
    page_size = A4 if (options.page_size or "letter").lower() == "a4" else letter

    last_name = author_last_name(model.author)
    short_title = shortened_title(model.title or "")

    buf = BytesIO()
    doc = BaseDocTemplate(
        buf,
        pagesize=page_size,
        leftMargin=1.0 * inch,
        rightMargin=1.0 * inch,
        topMargin=1.0 * inch,
        bottomMargin=1.0 * inch,
        title=model.title or "Untitled",
        author=model.author or "",
    )
    # Title page: no header, no page number.
    title_frame = Frame(
        doc.leftMargin, doc.bottomMargin,
        doc.width, doc.height,
        id="titleFrame",
    )
    # Body pages: header drawn in `onPage`. Frame begins below the
    # header band (we reserve 0.5" of extra top space for the header
    # so it doesn't overlap with the body's first line).
    header_band = 0.5 * inch
    body_frame = Frame(
        doc.leftMargin, doc.bottomMargin,
        doc.width, doc.height - header_band,
        id="bodyFrame",
    )

    def _draw_body_header(canvas, _doc):
        """Right-aligned `<Last Name> / <Shortened Title> / Page #` in
        the page header. Page number = canvas.getPageNumber() minus
        the title page (so the first body page reads as `1`)."""
        canvas.saveState()
        canvas.setFont("Times-Roman", 12)
        page_num = canvas.getPageNumber() - 1  # subtract title page
        text = f"{last_name} / {short_title} / {page_num}"
        # Position: right edge at right margin, baseline 0.5" below
        # top edge.
        page_w = page_size[0]
        page_h = page_size[1]
        x = page_w - 1.0 * inch
        y = page_h - 0.5 * inch
        canvas.drawRightString(x, y, text)
        canvas.restoreState()

    doc.addPageTemplates([
        PageTemplate(id="TitlePage", frames=[title_frame]),
        PageTemplate(id="Body", frames=[body_frame], onPage=_draw_body_header),
    ])

    flow: list = []
    body_started = False
    for event in walk_shunn(model, options=options):
        if isinstance(event, TitlePageEvent):
            flow.extend(_emit_title_page(event))
        elif isinstance(event, ChapterStartEvent):
            if not body_started:
                # Switch to the Body PageTemplate before the first
                # chapter so the body pages carry the running header.
                flow.append(NextPageTemplate("Body"))
                flow.append(PageBreak())
                body_started = True
            else:
                flow.append(PageBreak())
            flow.extend(_emit_chapter_heading(event.label))
        elif isinstance(event, ParagraphEvent):
            flow.append(_emit_body_paragraph(event))
        elif isinstance(event, SceneBreakEvent):
            flow.append(Paragraph("#", _CENTRED_SYMBOL))
        elif isinstance(event, EndMarkerEvent):
            flow.append(Paragraph("# # #", _CENTRED_SYMBOL))

    if not body_started:
        # Even with no chapters, emit a body page so a manuscript-shape
        # PDF always has at least one body page.
        flow.append(NextPageTemplate("Body"))
        flow.append(PageBreak())

    doc.build(flow)
    return buf.getvalue()


# ── Title page ────────────────────────────────────────────────────────


def _emit_title_page(ev: TitlePageEvent) -> list:
    """Emit the title page as a sequence of flowables. Top-left
    contact block flows first; word-count line sits to its right via a
    one-row two-column Table. Then ~1/3 page of vertical space, then
    the title block."""
    from reportlab.platypus import Table, TableStyle

    out: list = []

    # Top row: contact block (left column) + word count (right column).
    # Build the contact paragraph as a multi-line single-spaced block.
    contact_text = "<br/>".join(_xml_escape(line) for line in (ev.contact_lines or []))
    contact_para = Paragraph(contact_text or "&nbsp;", _CONTACT)
    word_count_para = Paragraph(_xml_escape(ev.word_count_line), _WORDCOUNT)

    table = Table(
        [[contact_para, word_count_para]],
        colWidths=["*", 2.0 * inch],
    )
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    out.append(table)

    # Vertical spacer to push the title ~1/3 down the page.
    out.append(Spacer(1, 3.0 * inch))
    out.append(Paragraph(_xml_escape(ev.title), _TITLE))
    out.append(Spacer(1, 0.25 * inch))
    out.append(Paragraph(_xml_escape(ev.byline), _BYLINE))
    return out


# ── Chapter heading ───────────────────────────────────────────────────


def _emit_chapter_heading(label: str) -> list:
    """Emit a centred chapter heading sitting ~1/3 down the page.
    `PageBreak()` is appended by the caller; here we only need the
    leading vertical space + the heading itself."""
    out: list = [Spacer(1, 2.5 * inch)]
    out.append(Paragraph(_xml_escape(label or "Chapter"), _CHAPTER))
    out.append(Spacer(1, 0.25 * inch))
    return out


# ── Body paragraph ────────────────────────────────────────────────────


def _emit_body_paragraph(ev: ParagraphEvent) -> Paragraph:
    """One body paragraph as a single Paragraph flowable. Inline
    italic / bold runs translate to ReportLab's mini-HTML markup.
    `flush_left=True` selects the no-first-line-indent style."""
    style = _BODY_FLUSH if ev.flush_left else _BODY
    text = "".join(_run_to_markup(r) for r in ev.runs)
    if not text.strip():
        # ReportLab's Paragraph chokes on completely empty content;
        # emit a non-breaking space so the line still occupies a slot.
        text = "&nbsp;"
    return Paragraph(text, style)


def _run_to_markup(run: Run) -> str:
    """Convert one Run to ReportLab Paragraph mini-HTML."""
    text = _xml_escape(run.text)
    if run.italic and run.bold:
        return f"<b><i>{text}</i></b>"
    if run.italic:
        return f"<i>{text}</i>"
    if run.bold:
        return f"<b>{text}</b>"
    return text


# ── Helpers ───────────────────────────────────────────────────────────


def _xml_escape(s: str) -> str:
    """Escape `&`, `<`, `>` for ReportLab Paragraph mini-HTML. Other
    characters (curly quotes, em-dashes, ellipses) pass through."""
    if not s:
        return ""
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


# ── Registry hook ─────────────────────────────────────────────────────


def render(model: ExportModel, options: Optional[ExportOptions] = None) -> bytes:
    return render_pdf_shunn(model, options)


SPEC = RendererSpec(
    format_id="pdf-shunn",
    label="PDF (Shunn manuscript)",
    extension="pdf",
    mime_type="application/pdf",
    render=render,
    capabilities=frozenset({"pagination"}),
    variant_of="pdf",
    variant_label="Shunn",
    required_options={},
)
register(SPEC)
