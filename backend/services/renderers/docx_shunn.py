"""Phase 1.25e — Shunn manuscript DOCX renderer.

Consumes the format-agnostic event stream from `services.shunn_walker`
and produces a submission-ready DOCX matching the Shunn novel-format
specification (`.References/Shunn Manuscript Format/Shunn Manuscript
Format - Specification.md`).

Implementation rules:
  - Times New Roman 12pt body, fall back to a generic serif if the
    font isn't available on the rendering machine.
  - 1-inch margins on all four sides.
  - Double-spaced body, ragged-right (no justification).
  - Hyphenation off.
  - First-line indent 0.5 inch on every body paragraph EXCEPT the
    first paragraph after a chapter heading or scene break (those are
    flush-left with no indent).
  - No blank lines between paragraphs.
  - Italics rendered as italic runs (not underlined).
  - Real em-dashes / curly quotes / single ellipsis character pass
    through verbatim — TipTap supplies these in the source HTML.
  - Page break before each chapter heading. Chapter heading sits ~1/3
    down the new page; emitted as centred runs with leading vertical
    space.
  - Title page is unnumbered; running header starts on the first body
    page.
  - Running header: `<Last Name> / <Shortened Title> / Page #`
    right-aligned in the page header.
  - End-of-manuscript marker: centred `# # #` after the final
    paragraph.
"""
from __future__ import annotations

from io import BytesIO
from typing import Optional

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from docx.shared import Inches, Pt

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


def render_docx_shunn(model: ExportModel, options: Optional[ExportOptions] = None) -> bytes:
    """Render the model as a Shunn-compliant DOCX. `options` is read
    only for `page_size` (Letter / A4); every other Shunn rule is
    fixed by spec."""
    options = options or ExportOptions()
    doc = Document()
    _configure_page_setup(doc, options)
    _configure_default_style(doc)

    last_name = author_last_name(model.author)
    short_title = shortened_title(model.title or "")

    # The title page is its own section with no running header /
    # numbering. After the title page we start a new section, set the
    # running header on it, and emit body content there.
    title_page_emitted = False
    body_started = False

    for event in walk_shunn(model, options=options):
        if isinstance(event, TitlePageEvent):
            _emit_title_page(doc, event)
            title_page_emitted = True
        elif isinstance(event, ChapterStartEvent):
            if not body_started:
                _start_body_section(doc, last_name=last_name, short_title=short_title)
                body_started = True
            _emit_chapter_heading(doc, event.label)
        elif isinstance(event, ParagraphEvent):
            _emit_body_paragraph(doc, event)
        elif isinstance(event, SceneBreakEvent):
            _emit_scene_break(doc)
        elif isinstance(event, EndMarkerEvent):
            _emit_end_marker(doc)

    # If the model produced no chapters at all we still want a numbered
    # body section, even if empty, so the document is structurally
    # valid.
    if title_page_emitted and not body_started:
        _start_body_section(doc, last_name=last_name, short_title=short_title)

    buf = BytesIO()
    doc.save(buf)
    return buf.getvalue()


# ── Page setup + default style ────────────────────────────────────────


def _configure_page_setup(doc, options: ExportOptions) -> None:
    """Configure margins + page size on the document's first section.
    Subsequent sections inherit unless explicitly overridden."""
    section = doc.sections[0]
    section.left_margin = Inches(1.0)
    section.right_margin = Inches(1.0)
    section.top_margin = Inches(1.0)
    section.bottom_margin = Inches(1.0)
    # Page size from options.page_size.
    if (options.page_size or "letter").lower() == "a4":
        section.page_width = Inches(8.27)   # 210mm ≈ 8.27"
        section.page_height = Inches(11.69) # 297mm ≈ 11.69"
    else:
        section.page_width = Inches(8.5)
        section.page_height = Inches(11.0)


def _configure_default_style(doc) -> None:
    """Configure the Normal style: Times New Roman 12pt, double
    spacing, no first-line indent (paragraphs that need an indent set
    it explicitly). Falls back silently to a serif default when Times
    isn't available — python-docx writes the font name into the doc;
    the rendering machine substitutes."""
    style = doc.styles["Normal"]
    font = style.font
    font.name = "Times New Roman"
    # East-Asian font slot fallback so non-Latin glyphs also pick a
    # serif default rather than the Word stock fallback.
    rpr = style.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    rfonts.set(qn("w:ascii"), "Times New Roman")
    rfonts.set(qn("w:hAnsi"), "Times New Roman")
    rfonts.set(qn("w:cs"), "Times New Roman")
    font.size = Pt(12)
    pf = style.paragraph_format
    pf.line_spacing_rule = WD_LINE_SPACING.DOUBLE
    pf.space_before = Pt(0)
    pf.space_after = Pt(0)


# ── Title page ────────────────────────────────────────────────────────


def _emit_title_page(doc, ev: TitlePageEvent) -> None:
    """Top-left contact block + top-right word count, then ~1/3 down
    the title block. Title page has no running header and is
    unnumbered (achieved by putting body content in a separate
    section that resets numbering)."""
    # Top-left contact block + top-right word-count: emit a single
    # paragraph with a tab leader so the word-count sits right-aligned.
    # The freshly-constructed Document may or may not carry a default
    # leading paragraph depending on python-docx version; if it does,
    # re-use it; otherwise add one.
    if doc.paragraphs:
        first_paragraph = doc.paragraphs[0]
    else:
        first_paragraph = doc.add_paragraph()
    # Set up a right-aligned tab stop at the right margin so the
    # word-count line sits flush right while the contact block stays
    # left.
    tab_stops = first_paragraph.paragraph_format.tab_stops
    # 6.5" = 8.5" page - 2x1" margins. For A4 the writer's flow
    # tolerates a slight offset (~0.27") which won't break the layout.
    tab_stops.add_tab_stop(Inches(6.5), alignment=2)  # 2 = WD_TAB_ALIGNMENT.RIGHT
    pf = first_paragraph.paragraph_format
    pf.line_spacing_rule = WD_LINE_SPACING.SINGLE
    # First line: contact[0] + tab + word_count
    contact_lines = list(ev.contact_lines or [])
    head = contact_lines[0] if contact_lines else ""
    tail_lines = contact_lines[1:]
    first_paragraph.add_run(head)
    first_paragraph.add_run("\t")
    first_paragraph.add_run(ev.word_count_line)
    for line in tail_lines:
        p = doc.add_paragraph()
        p.paragraph_format.line_spacing_rule = WD_LINE_SPACING.SINGLE
        p.add_run(line)

    # Vertical spacer so the title block sits ~1/3 down the page.
    # 11" page - 1" top margin = 10" body height. ~1/3 down = 3.3"
    # of vertical space above the title. Each blank-paragraph line
    # at single-spacing (12pt) is ~14pt high; ~14 blank lines ≈ 3.3".
    for _ in range(14):
        spacer = doc.add_paragraph()
        spacer.paragraph_format.line_spacing_rule = WD_LINE_SPACING.SINGLE

    title_para = doc.add_paragraph()
    title_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_para.paragraph_format.line_spacing_rule = WD_LINE_SPACING.SINGLE
    title_run = title_para.add_run(ev.title)
    title_run.bold = True

    # Blank line then byline.
    blank = doc.add_paragraph()
    blank.paragraph_format.line_spacing_rule = WD_LINE_SPACING.SINGLE
    byline_para = doc.add_paragraph()
    byline_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    byline_para.paragraph_format.line_spacing_rule = WD_LINE_SPACING.SINGLE
    byline_para.add_run(ev.byline)


# ── Body section + running header ─────────────────────────────────────


def _start_body_section(doc, *, last_name: str, short_title: str) -> None:
    """Start a fresh section for the body so it can carry its own
    running header and so page numbering restarts at 1 here."""
    new_section = doc.add_section(WD_SECTION.NEW_PAGE)
    # Inherit margins / page size from the title-page section.
    new_section.left_margin = Inches(1.0)
    new_section.right_margin = Inches(1.0)
    new_section.top_margin = Inches(1.0)
    new_section.bottom_margin = Inches(1.0)
    new_section.page_width = doc.sections[0].page_width
    new_section.page_height = doc.sections[0].page_height
    # Restart numbering at 1 on this section.
    _restart_page_numbering(new_section)
    # Linked-to-previous = False so the body's header doesn't bleed
    # into the title page.
    header = new_section.header
    header.is_linked_to_previous = False
    _populate_running_header(header, last_name=last_name, short_title=short_title)


def _populate_running_header(header, *, last_name: str, short_title: str) -> None:
    """Right-aligned `<Last Name> / <Shortened Title> / Page #` in the
    page header area. Uses a Word PAGE field for the live page
    number."""
    # Header may already contain an empty paragraph by default.
    if header.paragraphs:
        para = header.paragraphs[0]
    else:
        para = header.add_paragraph()
    para.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    pf = para.paragraph_format
    pf.line_spacing_rule = WD_LINE_SPACING.SINGLE
    para.add_run(f"{last_name} / {short_title} / ")
    _add_page_number_field(para)


def _add_page_number_field(paragraph) -> None:
    """Append a Word PAGE field to the paragraph so the header shows
    the live page number rather than a static value."""
    run = paragraph.add_run()
    fld_char_begin = OxmlElement("w:fldChar")
    fld_char_begin.set(qn("w:fldCharType"), "begin")
    run._r.append(fld_char_begin)
    instr_text = OxmlElement("w:instrText")
    instr_text.set(qn("xml:space"), "preserve")
    instr_text.text = "PAGE"
    run._r.append(instr_text)
    fld_char_end = OxmlElement("w:fldChar")
    fld_char_end.set(qn("w:fldCharType"), "end")
    run._r.append(fld_char_end)


def _restart_page_numbering(section) -> None:
    """Set the section's page numbering to restart at 1."""
    sect_pr = section._sectPr
    # Remove any existing pgNumType so we don't duplicate.
    existing = sect_pr.find(qn("w:pgNumType"))
    if existing is not None:
        sect_pr.remove(existing)
    pg_num_type = OxmlElement("w:pgNumType")
    pg_num_type.set(qn("w:start"), "1")
    sect_pr.append(pg_num_type)


# ── Chapter heading + body paragraphs ─────────────────────────────────


def _emit_chapter_heading(doc, label: str) -> None:
    """Emit a centred chapter heading sitting ~1/3 down a fresh page
    (the section's `page-break-before` already pushed us to a new
    page; we add vertical space to push the heading down)."""
    # Vertical space before the heading — ~1/3 down the body. Same
    # logic as the title-page spacer; a smaller stack here since the
    # body is double-spaced and each blank paragraph is taller.
    for _ in range(5):
        spacer = doc.add_paragraph()
        spacer.paragraph_format.line_spacing_rule = WD_LINE_SPACING.SINGLE

    para = doc.add_paragraph()
    para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    pf = para.paragraph_format
    pf.line_spacing_rule = WD_LINE_SPACING.DOUBLE
    pf.page_break_before = True
    run = para.add_run(label or "Chapter")
    run.bold = True

    # Blank lines after heading so the first paragraph sits a few
    # lines below the heading.
    for _ in range(2):
        blank = doc.add_paragraph()
        blank.paragraph_format.line_spacing_rule = WD_LINE_SPACING.SINGLE


def _emit_body_paragraph(doc, ev: ParagraphEvent) -> None:
    """Emit one body paragraph. `flush_left=True` means the first
    paragraph of a chapter or scene — no first-line indent. Every
    other paragraph gets the standard 0.5-inch first-line indent."""
    para = doc.add_paragraph()
    pf = para.paragraph_format
    pf.line_spacing_rule = WD_LINE_SPACING.DOUBLE
    if not ev.flush_left:
        pf.first_line_indent = Inches(0.5)
    for run in ev.runs:
        _emit_run(para, run)


def _emit_run(paragraph, run: Run) -> None:
    """Emit one styled fragment as a docx run."""
    docx_run = paragraph.add_run(run.text)
    if run.italic:
        docx_run.italic = True
    if run.bold:
        docx_run.bold = True


def _emit_scene_break(doc) -> None:
    """Centred `#` between scenes within a chapter. Standard double
    spacing — no extra blank lines."""
    para = doc.add_paragraph()
    para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    para.paragraph_format.line_spacing_rule = WD_LINE_SPACING.DOUBLE
    para.add_run("#")


def _emit_end_marker(doc) -> None:
    """Centred `# # #` after the final paragraph."""
    para = doc.add_paragraph()
    para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    para.paragraph_format.line_spacing_rule = WD_LINE_SPACING.DOUBLE
    para.add_run("# # #")


# ── Registry hook ─────────────────────────────────────────────────────


def render(model: ExportModel, options: Optional[ExportOptions] = None) -> bytes:
    return render_docx_shunn(model, options)


SPEC = RendererSpec(
    format_id="docx-shunn",
    label="Word document (Shunn manuscript)",
    extension="docx",
    mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    render=render,
    capabilities=frozenset({"pagination"}),
    variant_of="docx",
    variant_label="Shunn",
    # Shunn output is body-only by spec — manuscripts don't carry
    # entity reference sheets, scene-time lines, c/m blocks, etc.
    # The Shunn preset bundle in `frontend/src/utils/exportPresets.js`
    # already turns these toggles off; the renderer ignores them
    # entirely either way.
    required_options={},
)
register(SPEC)
