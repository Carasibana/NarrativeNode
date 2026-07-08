"""
Microsoft Word (.docx) renderer — Phase 1.12a Track 7.

Part of the modular renderer package: each format is its own file
under `backend/services/renderers/`, self-registering a `RendererSpec`
via the registry at the bottom of this module. See
`docs/export-renderer-guide.md` for the full pattern.

Walks the `ExportModel` directly and constructs a `python-docx`
`Document` block by block. No HTML intermediate — fully self-contained
per the renderer-independence rule, with its own
`_TipTapToDocx` TipTap HTML parser that emits Word runs directly
rather than sharing the markdown/text parsers.

`python-docx` is MIT-licensed and the `.docx` format is ECMA-376 /
ISO/IEC 29500 standardised under Microsoft's Open Specification
Promise. Generated files open cleanly in Word, Google Docs,
LibreOffice, Pages, Scrivener, and most writing tools.

## Style scheme

Uses Word's built-in paragraph styles so the resulting document has
a proper document outline (Navigation Pane, Table of Contents
generation, NovelCrafter's `.docx` importer which keys off `Heading 1`
for acts and `Heading 2` for chapters — see the Track 10b planning
notes):

| Element | python-docx call | Built-in style |
|---|---|---|
| Story title | `add_heading(..., level=0)` | Title |
| Byline | styled Normal paragraph, italic, centred | Normal |
| Metadata line | styled Normal paragraph, smaller italic | Normal |
| Act heading | `add_heading(..., level=1)` | Heading 1 |
| Chapter heading | `add_heading(..., level=2)` | Heading 2 |
| Scene title | `add_heading(..., level=3)` | Heading 3 |
| Scene body prose | `add_paragraph(..., style='Normal')` | Normal |
| Scene transition / description | italic Normal paragraphs | Normal |
| POV line | bold Normal paragraph | Normal |
| Entity context | italic Normal paragraph | Normal |
| Changes block header | bold Normal paragraph | Normal |
| Changes block entry | Normal paragraph w/ inline formatting | Normal |
| Entity reference sheet name | `add_heading(..., level=2)` | Heading 2 |
| Entity reference sheet attributes | Normal paragraphs, bold labels | Normal |

## Pagination

Honours the shared Pagination model from the planning doc:

  - `doc.add_page_break()` called before each act, chapter, and
    appendix, with first-block suppression (for the very first act)
    and first-chapter-in-act suppression (tracked by
    `_RenderState.prev_was_act_heading`).
  - Scenes are not split across pages when they fit: each
    paragraph within a scene has
    `paragraph.paragraph_format.keep_with_next = True`, except the
    last paragraph in the scene. Word's layout engine then tries to
    keep the entire chain together on one page. If the scene is
    longer than a single page, Word falls back to normal layout —
    acceptable per the Pagination model.
  - Page size is pulled from `options.page_size`:
    - A4: 210 × 297 mm (default)
    - letter: 8.5 × 11 in

## Capabilities

  - `pagination` — page_size + PageBreak + keep_with_next
  - `embedded_assets` — profile images on entity reference sheets
  - `embedded_media` — file-type image attributes inline; audio /
    video surface as placeholder paragraphs
  - `entity_colours` — inline run colour via `run.font.color.rgb`
  - (NOT `entity_links` — requires bookmark + hyperlink XML
    manipulation that python-docx doesn't expose directly; possible
    follow-up item if users ask for it)
"""

from __future__ import annotations

import base64
import re
from html.parser import HTMLParser
from io import BytesIO
from typing import Optional

# python-docx — top-level absolute import, NOT a self-reference to
# this module. Python 3's absolute-import-by-default rule means
# `from docx import Document` inside this file resolves to the
# installed python-docx package, not to the sibling module with the
# same short name (us).
from docx import Document
from docx.document import Document as DocumentType
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Mm, Pt, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

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


# ── Public entry ───────────────────────────────────────────────────────


def render_docx(model: ExportModel, options: Optional[ExportOptions] = None) -> bytes:
    """Build a .docx document from an ExportModel and return the raw bytes."""
    options = options or ExportOptions()

    doc = Document()
    _setup_page_size(doc, options)
    _setup_margins(doc)
    _set_core_properties(doc, model)

    state = _RenderState()

    # Phase 5.8b — story cover as a full first page, before the title
    # page. The cover gets its OWN section with tiny margins so the image
    # fills the whole PAGE (not the 1in text area), scaled to fit with no
    # crop. A following section (new page) restores the normal margins for
    # the rest of the document.
    if options.include_cover_image and model.cover_image_data_uri:
        cover_stream = _decode_data_uri(model.cover_image_data_uri)
        if cover_stream is not None:
            try:
                sec = doc.sections[0]
                page_w, page_h = sec.page_width, sec.page_height
                cover_margin = Inches(0.25)  # small breathing room from the edge
                sec.top_margin = sec.bottom_margin = cover_margin
                sec.left_margin = sec.right_margin = cover_margin
                avail_w = page_w - 2 * cover_margin
                avail_h = page_h - 2 * cover_margin
                cover_para = doc.add_paragraph()
                cover_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
                pic = cover_para.add_run().add_picture(cover_stream, width=avail_w)
                if pic.height and avail_h and pic.height > avail_h:
                    factor = avail_h / pic.height
                    pic.height = int(pic.height * factor)
                    pic.width = int(pic.width * factor)
                # New section on a fresh page for the rest of the document,
                # with the normal 1in margins restored (page size carried
                # over from the cover section).
                content_sec = doc.add_section()
                content_sec.page_width = page_w
                content_sec.page_height = page_h
                content_sec.top_margin = content_sec.bottom_margin = Inches(1.0)
                content_sec.left_margin = content_sec.right_margin = Inches(1.0)
            except Exception:
                pass  # Bad / unreadable cover → skip it, continue export.

    # Story header — title + optional byline + optional metadata line.
    # Sits at the top of the title page (page 1, or page 2 after a cover).
    _render_story_header(doc, model, options)
    state.first_block = False
    state.prev_was_act_heading = False

    # Sections — acts, chapters, unchaptered, each with their scenes.
    for section in model.sections:
        _append_section(doc, section, options, state)

    # Off-screen scenes appendix.
    if options.include_offscreen_appendix and model.offscreen_scenes:
        doc.add_page_break()
        _render_offscreen_appendix(doc, model.offscreen_scenes, options)
        state.prev_was_act_heading = False

    # Entity reference sheets appendix.
    if options.include_entity_sheets and model.entity_sheets:
        doc.add_page_break()
        _render_entity_sheets(doc, model.entity_sheets, options)

    # Knowledge appendix (after entity sheets).
    if options.include_knowledge_section and model.knowledge_sheets:
        doc.add_page_break()
        _render_knowledge_sheets(doc, model.knowledge_sheets, options)

    buf = BytesIO()
    doc.save(buf)
    return buf.getvalue()


class _RenderState:
    """Mutable state threaded through the walker so the pagination
    rules can consult 'is this the first block?' and 'was the
    previous block an act heading?' — both needed to suppress
    redundant page breaks per the Pagination model."""

    __slots__ = ("first_block", "prev_was_act_heading")

    def __init__(self) -> None:
        self.first_block: bool = True
        self.prev_was_act_heading: bool = False


# ── Document setup ─────────────────────────────────────────────────────


def _setup_page_size(doc: DocumentType, options: ExportOptions) -> None:
    """Set the document's page size from `options.page_size`.
    A4 is the default; letter is the other supported value."""
    section = doc.sections[0]
    size = (options.page_size or "a4").lower()
    if size == "letter":
        section.page_width = Inches(8.5)
        section.page_height = Inches(11.0)
    else:
        # A4 210 × 297 mm
        section.page_width = Mm(210)
        section.page_height = Mm(297)


def _setup_margins(doc: DocumentType) -> None:
    """1-inch margins on all sides — standard manuscript layout.
    Matches the PDF renderer's margin defaults."""
    section = doc.sections[0]
    section.top_margin = Inches(1.0)
    section.bottom_margin = Inches(1.0)
    section.left_margin = Inches(1.0)
    section.right_margin = Inches(1.0)


def _set_core_properties(doc: DocumentType, model: ExportModel) -> None:
    """Populate the document's Office core properties — these show
    up in Word's "File → Info" panel and in the file metadata
    readable by indexers / searchers."""
    props = doc.core_properties
    props.title = model.title or "Story"
    if model.author:
        props.author = model.author
    if model.genre:
        props.category = model.genre
    if model.tags:
        props.keywords = ", ".join(model.tags)


# ── Story header ───────────────────────────────────────────────────────


def _render_story_header(
    doc: DocumentType,
    model: ExportModel,
    options: ExportOptions,
) -> None:
    """Title (Heading 0 / Title style) + optional byline + optional
    metadata line, all centred. Sits at the top of page 1."""
    title_para = doc.add_heading(model.title or "Story", level=0)
    title_para.alignment = WD_ALIGN_PARAGRAPH.CENTER

    if options.include_author and model.author:
        byline = doc.add_paragraph()
        byline.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = byline.add_run(f"by {model.author}")
        run.italic = True
        run.font.size = Pt(13)

    meta_lines: list[str] = []
    if options.include_genre and model.genre:
        meta_lines.append(f"Genre: {model.genre}")
    if options.include_tags and model.tags:
        meta_lines.append(f"Tags: {', '.join(model.tags)}")
    if options.include_tense and model.tense:
        meta_lines.append(f"Tense: {model.tense}")
    if options.include_pov_type and model.pov_type:
        meta_lines.append(f"POV style: {model.pov_type}")
    if options.include_language and model.language:
        meta_lines.append(f"Language: {model.language}")
    if options.include_default_pov_character and model.default_pov_character_name:
        meta_lines.append(f"Default POV: {model.default_pov_character_name}")
    if options.include_generated_timestamp and model.generated_at:
        meta_lines.append(f"Generated: {model.generated_at.strftime('%Y-%m-%d')}")

    for line in meta_lines:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = p.add_run(line)
        run.font.size = Pt(9)
        run.italic = True

    # Phase 5.8b — story description blurb, below the metadata block.
    # Read as prose (left-aligned), distinct from the centred header.
    if options.include_story_description and model.description and model.description.strip():
        for raw in model.description.strip().split("\n"):
            stripped = raw.strip()
            p = doc.add_paragraph()
            if stripped:
                run = p.add_run(stripped)
                run.font.size = Pt(11)


# ── Sections ───────────────────────────────────────────────────────────


def _add_scene_break(doc) -> None:
    """Phase 5.8b — centred scene-break ornament (centre diamond + fading
    rules) between same-chapter scenes; rasterised via resvg, with a centred
    "* * *" fallback if rasterisation is unavailable."""
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(6)
    p.paragraph_format.space_after = Pt(6)
    png = export_icons.scene_break_png(width=240, color="#3a3a3a")
    if png:
        try:
            p.add_run().add_picture(BytesIO(png), width=Inches(1.6))
            return
        except Exception:
            pass
    run = p.add_run("* * *")
    run.font.size = Pt(11)


def _append_section(
    doc: DocumentType,
    section: ExportSection,
    options: ExportOptions,
    state: _RenderState,
) -> None:
    """Append a section's paragraphs to the document, applying the
    shared Pagination model's page-break rules."""
    if section.kind == "act":
        if options.include_act_headings:
            if not state.first_block:
                doc.add_page_break()
            doc.add_heading((section.label or "").strip(), level=1)
            state.first_block = False
            state.prev_was_act_heading = True
        for child in section.children:
            _append_section(doc, child, options, state)
        return

    if section.kind == "chapter":
        if options.include_chapter_headings:
            if not state.first_block and not state.prev_was_act_heading:
                doc.add_page_break()
            doc.add_heading((section.label or "").strip(), level=2)
            state.first_block = False
            state.prev_was_act_heading = False
        for i, scene in enumerate(section.scenes):
            if i > 0 and options.include_scene_separator:
                _add_scene_break(doc)
            _render_scene(doc, scene, options)
            state.first_block = False
            state.prev_was_act_heading = False
        return

    # "unchaptered"
    if not section.scenes:
        return
    if options.include_unchaptered_heading:
        if not state.first_block and not state.prev_was_act_heading:
            doc.add_page_break()
        doc.add_heading((section.label or "Unchaptered").strip(), level=2)
        state.first_block = False
        state.prev_was_act_heading = False
    for i, scene in enumerate(section.scenes):
        if i > 0 and options.include_scene_separator:
            _add_scene_break(doc)
        _render_scene(doc, scene, options)
        state.first_block = False
        state.prev_was_act_heading = False


# ── Scene ──────────────────────────────────────────────────────────────


def _render_scene(
    doc: DocumentType,
    scene: ExportScene,
    options: ExportOptions,
) -> None:
    """Render one scene as a sequence of paragraphs. All paragraphs
    emitted for this scene have `keep_with_next = True` except the
    last, so Word tries to keep the whole scene on one page. Matches
    the Pagination model's rule 5 (no scene split across page break
    when it fits on one page)."""
    scene_paragraphs: list = []

    def track(paragraph):
        """Helper: remember every paragraph we add for this scene
        so we can apply keep_with_next at the end."""
        if paragraph is not None:
            scene_paragraphs.append(paragraph)

    if options.include_transition_text and scene.transition_in_text.strip():
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = p.add_run(scene.transition_in_text.strip())
        run.italic = True
        run.font.size = Pt(11)
        _set_space_before(p, Pt(12))
        track(p)

    if options.include_scene_title and scene.title:
        heading = doc.add_heading(scene.title.strip(), level=3)
        track(heading)

    if options.include_scene_description and scene.description.strip():
        _add_scene_description(doc, scene.description, options)

    # Phase 5.8b — the scene "context" elements (time, circumstances &
    # motivators, POV, entity context) collect into a second light-grey
    # boxed cell between the description and the prose, distinct from the
    # story text. (Table rows split across pages in Word, so no page-fit
    # constraint here.)
    show_time = options.include_scene_time and (
        scene.scene_time_text or scene.scene_time_season_svg or scene.scene_time_tod_svg
    )
    show_cm = options.include_scene_cm_block and bool(scene.cm_groups)
    show_pov = options.include_scene_pov_line and bool(scene.pov_entity_name)
    show_ctx = options.include_entity_context_line and bool(scene.entity_context_groups)
    if show_time or show_cm or show_pov or show_ctx:
        ctx_table = doc.add_table(rows=1, cols=1)
        ctx_table.autofit = False
        content_w = Inches(6.5 if (options.page_size or "a4").lower() == "letter" else 6.27)
        cell = ctx_table.rows[0].cells[0]
        try:
            ctx_table.columns[0].width = content_w
            cell.width = content_w
        except Exception:
            pass
        _set_cell_box_border(cell)
        _shade_cell(cell)
        leading = cell.paragraphs[0]
        # Phase 1.25c — scene-time line. Icons rasterise to PNG and inline.
        if show_time:
            p = cell.add_paragraph()
            for svg in (scene.scene_time_season_svg, scene.scene_time_tod_svg):
                if not svg:
                    continue
                png = export_icons.svg_to_png_bytes(svg, size=44)
                if not png:
                    continue
                _add_inline_badge(p, png)
                sp = p.add_run(" ")
                sp.font.size = Pt(9)
            if scene.scene_time_text:
                run = p.add_run(scene.scene_time_text)
                run.font.size = Pt(9)
                run.font.color.rgb = RGBColor(0x88, 0x88, 0x88)
        if show_cm:
            _render_scene_cm_block(cell, scene.cm_groups, options, track)
        if show_pov:
            p = cell.add_paragraph()
            run = p.add_run(f"POV: {scene.pov_entity_name}")
            run.bold = True
            run.font.size = Pt(9)
        if show_ctx:
            _render_entity_context(cell, scene.entity_context_groups, options, track)
        # Drop the cell's initial empty paragraph if content was added after it.
        if len(cell.paragraphs) > 1 and not leading.text and not leading.runs:
            leading._element.getparent().remove(leading._element)

    if options.include_scene_body and scene.main_content_html.strip():
        body_paragraphs = _tiptap_to_docx_paragraphs(
            doc, scene.main_content_html, options
        )
        for p in body_paragraphs:
            track(p)

    # Phase 5.8b — the Scene Changes block is metadata, not prose, so it goes
    # in a light-grey boxed cell (after the prose) like the description /
    # context. Rendered into the cell; if nothing renders (all granular
    # change toggles off / no matching changes), the empty box is removed.
    if options.include_scene_changes_block and scene.changes:
        ch_table, ch_cell = _boxed_cell(doc, options)
        ch_leading = ch_cell.paragraphs[0]
        _render_scene_changes(ch_cell, scene.changes, options, track)
        if len(ch_cell.paragraphs) > 1:
            if not ch_leading.text and not ch_leading.runs:
                ch_leading._element.getparent().remove(ch_leading._element)
        else:
            ch_table._element.getparent().remove(ch_table._element)

    # Phase 5.8b — scenes flow naturally and split across pages rather
    # than being held whole via a keep_with_next chain (which orphaned
    # chapter headings when the first scene was taller than a page). The
    # chapter heading keeps its own built-in "keep with next" so it stays
    # with the first line of its content; the prose below flows freely.
    if scene_paragraphs:
        try:
            scene_paragraphs[-1].paragraph_format.keep_with_next = False
        except Exception:
            pass


def _set_space_before(paragraph, value) -> None:
    """Helper: set paragraph_format.space_before safely."""
    try:
        paragraph.paragraph_format.space_before = value
    except Exception:
        pass


# Maps an `ExportSceneCMRow.prefix` string to the corresponding
# `attribute_type` ('circumstance' / 'motivator' / '') for type-badge
# resolution. Mirrors the same map in the HTML / PDF renderers;
# duplicated here per the renderer-independence rule.
_PREFIX_TO_ATTRIBUTE_TYPE = {
    "Scene Circumstance": "circumstance",
    "Circumstance": "circumstance",
    "Temporary Circumstance": "circumstance",
    "Motivator": "motivator",
    "Temporary Motivator": "motivator",
}


def _add_inline_badge(paragraph, png: bytes, *, height_pt: float = 11.0) -> None:
    """Append the badge PNG as an inline image run on `paragraph`.
    `height_pt` is the rendered height in points (matches the inline
    text size); width is computed by python-docx from the PNG aspect
    ratio (always 1:1 for our square badges)."""
    if not png:
        return
    run = paragraph.add_run()
    # python-docx wants Inches/Pt for sizing; Pt is points,
    # 1 point = 1/72 inch. Square PNGs so we only set height.
    run.add_picture(BytesIO(png), height=Pt(height_pt))


def _render_scene_cm_block(doc, groups: list[ExportSceneCMGroup], options: ExportOptions, track) -> None:
    """Phase 1.22i — Circumstances & Motivators block in docx. Header
    paragraph followed by one bullet per group, with nested bullets
    per row. Uses python-docx's `List Bullet` / `List Bullet 2`
    built-in styles.

    Phase 1.25c — each row leads with the c/m type badge (slate `C` /
    rust `M` pentagon) and trails with the intensity badge when set,
    matching HTML / PDF rendering. Badges are PNGs sourced from
    `services.export_icons`, embedded inline as a Run picture."""
    if not groups:
        return
    header = doc.add_paragraph()
    run = header.add_run("Circumstances & Motivators:")
    run.bold = True
    run.font.size = Pt(10)
    track(header)
    for group in groups:
        if not group.rows:
            continue
        type_part = f" ({group.entity_type})" if group.entity_type else ""
        gp = doc.add_paragraph(style="List Bullet")
        gr = gp.add_run(f"{group.label}{type_part}")
        gr.bold = True
        gr.font.size = Pt(10)
        track(gp)
        for row in group.rows:
            name = (row.name or "").strip()
            desc = (row.description or "").strip()
            rp = doc.add_paragraph(style="List Bullet 2")
            # Type badge — inline picture run, then a trailing space.
            type_png = export_icons.cm_type_badge_png(
                _PREFIX_TO_ATTRIBUTE_TYPE.get(row.prefix, ""), size=44
            )
            if type_png:
                _add_inline_badge(rp, type_png)
                sp = rp.add_run(" ")
                sp.font.size = Pt(10)
            prefix_run = rp.add_run(f"{row.prefix}: ")
            prefix_run.bold = True
            prefix_run.font.size = Pt(10)
            # Primary label: name (plain); with no name it's the body (inline md).
            if name:
                label_run = rp.add_run(name)
                label_run.font.size = Pt(10)
            elif desc:
                _add_inline_field(rp, desc, options, size=10)
            else:
                label_run = rp.add_run("(unnamed)")
                label_run.font.size = Pt(10)
            # Intensity badge — inline after the label when the row's
            # intensity tier is recorded.
            if row.intensity is not None:
                gap = rp.add_run(" ")
                gap.font.size = Pt(10)
                intensity_png = export_icons.intensity_badge_png(
                    row.intensity, size=44
                )
                _add_inline_badge(rp, intensity_png)
            # Body after the name (when both present and distinct), inline md.
            if desc and name and desc != name:
                sep = rp.add_run(" : ")
                sep.font.size = Pt(10)
                _add_inline_field(rp, desc, options, size=10)
            track(rp)


def _render_entity_context(
    doc: DocumentType,
    groups: list[ExportSceneEntityGroup],
    options: ExportOptions,
    track,
) -> None:
    """Scene entity context — one paragraph per bucket with the
    entries listed. Uses per-entity colour inline runs when
    `use_entity_colours` is on and the entry has a colour set."""
    use_colours = options.use_entity_colours
    for group in groups:
        if not group.entries:
            continue
        p = doc.add_paragraph()
        label_run = p.add_run(f"{group.label}: ")
        label_run.bold = True
        label_run.font.size = Pt(9)
        label_run.italic = True
        for index, entry in enumerate(group.entries):
            if index > 0:
                sep = p.add_run(", ")
                sep.font.size = Pt(9)
                sep.italic = True
            name_run = p.add_run(entry.name)
            name_run.font.size = Pt(9)
            name_run.italic = True
            if use_colours and entry.colour:
                _apply_hex_colour(name_run, entry.colour)
        track(p)


def _render_scene_changes(
    doc: DocumentType,
    changes: list[ExportSceneEntityChange],
    options: ExportOptions,
    track,
) -> None:
    """Changes block — one bold label paragraph followed by per-entity
    entries with nested detail lines underneath."""
    allowed: set[str] = set()
    if options.include_metadata_changes:
        allowed.add("metadata")
    if options.include_attribute_changes:
        allowed.add("attribute")
    if options.include_relationship_changes:
        allowed.add("relationship")
    if not allowed:
        return

    filtered: list[tuple[ExportSceneEntityChange, list[ExportChangeDetail]]] = []
    for change in changes:
        details = [d for d in change.details if d.category in allowed]
        if details:
            filtered.append((change, details))
    if not filtered:
        return

    header = doc.add_paragraph()
    header_run = header.add_run("Changes recorded at this scene:")
    header_run.bold = True
    header_run.font.size = Pt(9)
    _set_space_before(header, Pt(10))
    track(header)

    for change, details in filtered:
        entry = doc.add_paragraph()
        entry.paragraph_format.left_indent = Inches(0.25)
        name_run = entry.add_run(change.entity_name)
        name_run.bold = True
        name_run.font.size = Pt(9)
        if options.use_entity_colours and change.colour:
            _apply_hex_colour(name_run, change.colour)
        type_run = entry.add_run(f" ({change.entity_type})")
        type_run.font.size = Pt(9)
        track(entry)

        for detail in details:
            d_para = doc.add_paragraph()
            d_para.paragraph_format.left_indent = Inches(0.5)
            _render_change_detail_docx(d_para, detail)
            track(d_para)


# Action glyph + colour for the docx subchip-style change rendering.
# ASCII glyphs because Calibri (Word default) doesn't reliably carry
# the ✚ / ✱ / ⚊ characters HTML uses. Colours match the HTML palette.
_CHANGE_ACTION_GLYPH_DOCX = {"add": "+", "modify": "~", "remove": "−"}
_CHANGE_ACTION_COLOUR_DOCX = {
    "add": RGBColor(0x16, 0xA3, 0x4A),     # green-600
    "modify": RGBColor(0xD9, 0x77, 0x06),  # amber-600
    "remove": RGBColor(0xDC, 0x26, 0x26),  # red-600
}


def _render_change_detail_docx(paragraph, detail: ExportChangeDetail) -> None:
    """Render one ExportChangeDetail into a docx paragraph as a
    sequence of styled runs. Mirrors the HTML / PDF subchip output:

        + FieldName : "value"           # add
        ~ FieldName : "old" → "new"     # modify with transition
        ~ FieldName : "value"           # modify with new only
        − FieldName                     # remove

    Falls back to text-only rendering for shapes without structured
    data (compound modifies, list ops, relationship changes)."""
    if detail.action and detail.field_name:
        glyph = _CHANGE_ACTION_GLYPH_DOCX.get(detail.action, "~")
        colour = _CHANGE_ACTION_COLOUR_DOCX.get(detail.action)
        glyph_run = paragraph.add_run(f"{glyph} ")
        glyph_run.bold = True
        glyph_run.font.size = Pt(8)
        if colour is not None:
            glyph_run.font.color.rgb = colour
        field_run = paragraph.add_run(detail.field_name)
        field_run.bold = True
        field_run.font.size = Pt(8)
        if detail.old_value is not None and detail.new_value is not None:
            old_run = paragraph.add_run(f' "{detail.old_value}"')
            old_run.font.size = Pt(8)
            old_run.font.strike = True
            old_run.font.color.rgb = RGBColor(0x88, 0x88, 0x88)
            arrow_run = paragraph.add_run(" → ")
            arrow_run.font.size = Pt(8)
            new_run = paragraph.add_run(f'"{detail.new_value}"')
            new_run.bold = True
            new_run.font.size = Pt(8)
        elif detail.new_value is not None:
            sep_run = paragraph.add_run(" : ")
            sep_run.font.size = Pt(8)
            new_run = paragraph.add_run(f'"{detail.new_value}"')
            new_run.bold = True
            new_run.font.size = Pt(8)
    else:
        cat_run = paragraph.add_run(f"{detail.category} — ")
        cat_run.italic = True
        cat_run.font.size = Pt(8)
        text_run = paragraph.add_run(detail.text)
        text_run.font.size = Pt(8)


# ── Appendices ─────────────────────────────────────────────────────────


def _render_offscreen_appendix(
    doc: DocumentType,
    scenes: list[ExportScene],
    options: ExportOptions,
) -> None:
    """Off-screen scenes appendix — H1 heading + note + each scene
    rendered as a normal scene block. Page break before handled by
    the caller (`render_docx`)."""
    doc.add_heading("Off-screen scenes", level=1)
    note = doc.add_paragraph()
    note.alignment = WD_ALIGN_PARAGRAPH.CENTER
    note_run = note.add_run("Non-POV scenes, presented in canvas order.")
    note_run.italic = True
    note_run.font.size = Pt(10)
    for scene in scenes:
        _render_scene(doc, scene, options)


def _render_entity_sheets(
    doc: DocumentType,
    sheets: list[ExportEntitySheet],
    options: ExportOptions,
) -> None:
    """Entity reference sheets appendix — H1 heading + each entity
    rendered as a small block (image + name + type + description +
    attributes + relationships). Page break before handled by
    caller."""
    doc.add_heading("Entity reference sheets", level=1)
    for sheet in sheets:
        _render_entity_sheet(doc, sheet, options)


def _render_knowledge_sheets(
    doc: DocumentType,
    sheets: list[ExportKnowledgeSheet],
    options: ExportOptions,
) -> None:
    """Phase 1.25c — Knowledge appendix. H1 heading + each Knowledge
    rendered as a small block (image + name + description + source-
    event + notes + optional chain history)."""
    doc.add_heading("Knowledge", level=1)
    for sheet in sheets:
        _render_knowledge_sheet(doc, sheet, options)


def _add_block_field(container, text: str, options: ExportOptions, *, size: int = 10) -> list:
    """Phase 5.8b — append a free-form block field (description / notes) to
    a docx container (document body or table cell). When
    `render_markdown_in_text_fields` is on, the markdown is parsed and
    rendered through the shared TipTap → docx builder; otherwise each non-
    empty line becomes its own Pt(size) paragraph. Returns the paragraphs
    added so callers that need keep_with_next can track them."""
    inner = (text or "").strip()
    if not inner:
        return []
    if options.render_markdown_in_text_fields:
        return _tiptap_to_docx_paragraphs(
            container, field_markdown_to_html(inner), options, base_size=size
        )
    added = []
    for raw in inner.splitlines():
        line = raw.strip()
        if not line:
            continue
        p = container.add_paragraph()
        run = p.add_run(line)
        run.font.size = Pt(size)
        added.append(p)
    return added


class _InlineMdToRuns(HTMLParser):
    """Phase 5.8b — append inline markdown (rendered to inline HTML) to an
    existing docx paragraph as runs, honouring strong / em / s / code as run
    formatting. Links render as their text (docx hyperlink plumbing is more
    than this inline case warrants)."""

    def __init__(self, paragraph, size: int, base_italic: bool = False, base_color=None) -> None:
        super().__init__(convert_charrefs=True)
        self._p = paragraph
        self._size = size
        self._base_italic = base_italic
        self._base_color = base_color
        self._bold = self._italic = self._strike = self._mono = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("strong", "b"):
            self._bold += 1
        elif tag in ("em", "i"):
            self._italic += 1
        elif tag in ("s", "del", "strike"):
            self._strike += 1
        elif tag == "code":
            self._mono += 1

    def handle_endtag(self, tag):
        if tag in ("strong", "b"):
            self._bold = max(0, self._bold - 1)
        elif tag in ("em", "i"):
            self._italic = max(0, self._italic - 1)
        elif tag in ("s", "del", "strike"):
            self._strike = max(0, self._strike - 1)
        elif tag == "code":
            self._mono = max(0, self._mono - 1)

    def handle_data(self, data):
        if not data:
            return
        run = self._p.add_run(data)
        run.font.size = Pt(self._size)
        if self._bold:
            run.bold = True
        if self._italic or self._base_italic:
            run.italic = True
        if self._strike:
            run.font.strike = True
        if self._mono:
            run.font.name = "Courier New"
        if self._base_color is not None:
            run.font.color.rgb = self._base_color


def _add_inline_md_runs(paragraph, text: str, size: int = 9, italic: bool = False, color=None) -> None:
    """Phase 5.8b — render a short value's inline markdown as runs appended
    to `paragraph`. `italic` / `color` apply to every run as a base style
    (markdown emphasis layers on top)."""
    parser = _InlineMdToRuns(paragraph, size, base_italic=italic, base_color=color)
    parser.feed(field_markdown_to_inline_html(text))
    parser.close()


def _add_inline_field(paragraph, text: str, options: ExportOptions, *, size: int = 10,
                      italic: bool = False, color=None) -> None:
    """Phase 5.8b — append an inline-rendered free-form body field (C/M /
    perspective body, relationship description / perception) to a paragraph:
    inline markdown runs when enabled, else a plain run. `italic` / `color`
    are the base styling for the field."""
    inner = (text or "").strip()
    if not inner:
        return
    if options.render_markdown_in_text_fields:
        _add_inline_md_runs(paragraph, inner, size=size, italic=italic, color=color)
    else:
        run = paragraph.add_run(inner)
        run.font.size = Pt(size)
        if italic:
            run.italic = True
        if color is not None:
            run.font.color.rgb = color


def _shade_cell(cell, fill: str = "F0F0F0") -> None:
    """Phase 5.8b — fill a table cell with a light grey (w:shd)."""
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    tcPr.append(shd)


def _set_cell_box_border(cell, color: str = "D8D8D8") -> None:
    """Phase 5.8b — a thin single border on all four sides of a cell.
    Appended before any w:shd so tcPr child order stays schema-valid."""
    tcPr = cell._tc.get_or_add_tcPr()
    borders = OxmlElement("w:tcBorders")
    for edge in ("top", "left", "bottom", "right"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), "4")
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), color)
        borders.append(el)
    tcPr.append(borders)


def _boxed_cell(doc, options: ExportOptions):
    """Phase 5.8b — create a light-grey bordered single-cell table and return
    (table, cell). The caller renders content into `cell`; an empty cell's
    table should be removed by the caller."""
    table = doc.add_table(rows=1, cols=1)
    table.autofit = False
    content_w = Inches(6.5 if (options.page_size or "a4").lower() == "letter" else 6.27)
    cell = table.rows[0].cells[0]
    try:
        table.columns[0].width = content_w
        cell.width = content_w
    except Exception:
        pass
    _set_cell_box_border(cell)
    _shade_cell(cell)
    return table, cell


def _add_scene_description(doc, text: str, options: ExportOptions):
    """Phase 5.8b — scene description as a small, light-grey boxed callout
    (a single-cell shaded table) so it reads as distinct from the scene
    prose; block markdown (bullet lists, paragraphs) is preserved inside."""
    inner = (text or "").strip()
    table = doc.add_table(rows=1, cols=1)
    table.autofit = False
    content_w = Inches(6.5 if (options.page_size or "a4").lower() == "letter" else 6.27)
    try:
        table.columns[0].width = content_w
        table.rows[0].cells[0].width = content_w
    except Exception:
        pass
    cell = table.rows[0].cells[0]
    _set_cell_box_border(cell)
    _shade_cell(cell)
    leading = cell.paragraphs[0]
    if options.render_markdown_in_text_fields:
        _tiptap_to_docx_paragraphs(cell, field_markdown_to_html(inner), options, base_size=9)
    else:
        for line in inner.splitlines():
            if line.strip():
                p = cell.add_paragraph()
                r = p.add_run(line.strip())
                r.font.size = Pt(9)
    # Drop the cell's initial empty paragraph if content was added after it.
    if len(cell.paragraphs) > 1 and not leading.text and not leading.runs:
        leading._element.getparent().remove(leading._element)
    return table


def _render_knowledge_sheet(
    doc: DocumentType,
    sheet: ExportKnowledgeSheet,
    options: ExportOptions,
) -> None:
    use_colour = bool(options.use_entity_colours and sheet.colour)

    profile_stream: Optional[BytesIO] = None
    if options.embed_assets and sheet.profile_image_data_uri:
        profile_stream = _decode_data_uri(sheet.profile_image_data_uri)

    if profile_stream is not None:
        # Two-column table: image left, text right.
        table = doc.add_table(rows=1, cols=2)
        table.alignment = WD_TABLE_ALIGNMENT.LEFT
        table.autofit = False
        try:
            table.columns[0].width = Inches(1.2)
        except Exception:
            pass
        img_cell = table.rows[0].cells[0]
        img_cell.vertical_alignment = WD_ALIGN_VERTICAL.TOP
        img_para = img_cell.paragraphs[0]
        img_run = img_para.add_run()
        try:
            img_run.add_picture(profile_stream, width=Inches(1.0))
        except Exception:
            pass
        text_cell = table.rows[0].cells[1]
        text_cell.vertical_alignment = WD_ALIGN_VERTICAL.TOP
        _populate_knowledge_sheet_text(text_cell, sheet, options, use_colour)
    else:
        _populate_knowledge_sheet_text(doc, sheet, options, use_colour)


def _populate_knowledge_sheet_text(container, sheet, options, use_colour) -> None:
    # Reuse the container's leading paragraph only when it is TRULY blank
    # (no text AND no runs). Checking text alone is not enough: a cover
    # image lives in a run with empty text (Phase 5.8b), so a text-only
    # check would hijack the cover paragraph and drop the first knowledge
    # name onto the cover page.
    _p0 = container.paragraphs[0] if (hasattr(container, "paragraphs") and container.paragraphs) else None
    reuse = _p0 is not None and not _p0.text and not _p0.runs
    name_para = _p0 if reuse else container.add_paragraph()
    name_run = name_para.add_run(sheet.name)
    name_run.bold = True
    name_run.font.size = Pt(14)
    if use_colour:
        _apply_hex_colour(name_run, sheet.colour)
    type_para = container.add_paragraph()
    type_run = type_para.add_run("Knowledge")
    type_run.italic = True
    type_run.font.size = Pt(9)
    _add_block_field(container, sheet.description, options, size=10)
    if sheet.source_event_scene_title:
        src_para = container.add_paragraph()
        src_run = src_para.add_run(f"First established at: {sheet.source_event_scene_title}")
        src_run.italic = True
        src_run.font.size = Pt(9)
        src_run.font.color.rgb = RGBColor(0x88, 0x88, 0x88)
    if sheet.notes and sheet.notes.strip():
        header = container.add_paragraph()
        header_run = header.add_run("Notes")
        header_run.bold = True
        header_run.font.size = Pt(9)
        _add_block_field(container, sheet.notes, options, size=9)
    if sheet.chain_history:
        header = container.add_paragraph()
        header_run = header.add_run("Chain history")
        header_run.bold = True
        header_run.font.size = Pt(9)
        for entry in sheet.chain_history:
            p = container.add_paragraph()
            kind_run = p.add_run(f"{entry.kind} — ")
            kind_run.italic = True
            kind_run.font.size = Pt(8)
            text_run = p.add_run(entry.text)
            text_run.font.size = Pt(8)
            if entry.scene_title:
                scene_run = p.add_run(f"  @ {entry.scene_title}")
                scene_run.italic = True
                scene_run.font.size = Pt(8)
                scene_run.font.color.rgb = RGBColor(0x88, 0x88, 0x88)


def _render_entity_sheet(
    doc: DocumentType,
    sheet: ExportEntitySheet,
    options: ExportOptions,
) -> None:
    """Render one entity reference sheet. When `embed_assets` is on
    AND the sheet has a profile image, use a two-column table (image
    left, text right). Otherwise render as a vertical stack."""
    use_colour = bool(options.use_entity_colours and sheet.colour)
    profile_stream: Optional[BytesIO] = None
    if options.embed_assets and sheet.profile_image_data_uri:
        profile_stream = _decode_data_uri(sheet.profile_image_data_uri)

    if profile_stream is not None:
        # Two-column layout via a borderless 1x2 table
        table = doc.add_table(rows=1, cols=2)
        table.alignment = WD_TABLE_ALIGNMENT.LEFT
        table.autofit = False
        try:
            table.columns[0].width = Inches(1.25)
            table.columns[1].width = Inches(5.0)
            for cell in table.columns[0].cells:
                cell.width = Inches(1.25)
            for cell in table.columns[1].cells:
                cell.width = Inches(5.0)
        except Exception:
            pass

        img_cell = table.rows[0].cells[0]
        img_cell.vertical_alignment = WD_ALIGN_VERTICAL.TOP
        # Remove the default empty paragraph before adding the image
        img_para = img_cell.paragraphs[0]
        img_run = img_para.add_run()
        try:
            img_run.add_picture(profile_stream, width=Inches(1.0))
        except Exception:
            pass

        text_cell = table.rows[0].cells[1]
        text_cell.vertical_alignment = WD_ALIGN_VERTICAL.TOP
        _populate_entity_sheet_text_cell(text_cell, sheet, options, use_colour)
    else:
        _populate_entity_sheet_direct(doc, sheet, options, use_colour)


def _populate_entity_sheet_text_cell(cell, sheet, options, use_colour) -> None:
    """Add the text-side content of an entity reference sheet into
    a table cell (when there's a profile image)."""
    # First paragraph of a new cell is already empty — repurpose it
    # for the name heading instead of adding a new one.
    name_para = cell.paragraphs[0]
    name_run = name_para.add_run(sheet.name)
    name_run.bold = True
    name_run.font.size = Pt(14)
    if use_colour:
        _apply_hex_colour(name_run, sheet.colour)

    type_para = cell.add_paragraph()
    type_run = type_para.add_run((sheet.type or "").capitalize())
    type_run.italic = True
    type_run.font.size = Pt(9)

    _append_entity_sheet_aliases(cell, sheet)

    _add_block_field(cell, sheet.description, options, size=10)

    _append_entity_sheet_attributes(cell, sheet, options)
    _append_entity_sheet_relationships(cell, sheet, options)
    _append_entity_sheet_notes(cell, sheet, options)


def _populate_entity_sheet_direct(doc, sheet, options, use_colour) -> None:
    """Add the entity reference sheet content directly as document
    paragraphs (when there's no profile image, no table wrapper)."""
    name_para = doc.add_heading(sheet.name, level=2)
    if use_colour:
        for run in name_para.runs:
            _apply_hex_colour(run, sheet.colour)

    type_para = doc.add_paragraph()
    type_run = type_para.add_run((sheet.type or "").capitalize())
    type_run.italic = True
    type_run.font.size = Pt(9)

    _append_entity_sheet_aliases(doc, sheet)

    _add_block_field(doc, sheet.description, options, size=10)

    _append_entity_sheet_attributes(doc, sheet, options)
    _append_entity_sheet_relationships(doc, sheet, options)
    _append_entity_sheet_notes(doc, sheet, options)


def _append_entity_sheet_aliases(container, sheet) -> None:
    """Phase 1.25c — aliases line under the type heading (italic, dim)."""
    alias_values = [a for a in (sheet.aliases or []) if a]
    if not alias_values:
        return
    p = container.add_paragraph()
    run = p.add_run("also: " + " / ".join(alias_values))
    run.italic = True
    run.font.size = Pt(9)
    run.font.color.rgb = RGBColor(0x88, 0x88, 0x88)


def _append_entity_sheet_notes(container, sheet, options) -> None:
    """Phase 1.25c — Notes sub-section (entity.notes, free-form text).
    Renders a bold "Notes" header followed by one paragraph per non-
    empty line so writer-entered line breaks survive the export."""
    if not options.include_entity_notes:
        return
    if not (sheet.notes and sheet.notes.strip()):
        return
    header = container.add_paragraph()
    header_run = header.add_run("Notes")
    header_run.bold = True
    header_run.font.size = Pt(9)
    _add_block_field(container, sheet.notes, options, size=9)


def _append_entity_sheet_attributes(container, sheet, options) -> None:
    """Append attribute rows to `container` (either a `_Cell` or the
    document body — both expose `add_paragraph`)."""
    for attr in sheet.attributes:
        if attr.attribute_type == "file":
            # File attributes handled separately below with media
            # embedding rules.
            continue
        name = attr.name or "(unnamed)"
        raw = attr.value or ""
        is_text = attr.attribute_type not in ("text_list", "entity_list", "perspective")
        # Phase 5.8b — markdown in a text value: block structure flows under
        # the label, short values stay inline on the label's line.
        if options.render_markdown_in_text_fields and is_text and raw.strip():
            if is_block_markdown(raw):
                label = container.add_paragraph()
                label_run = label.add_run(f"{name}:")
                label_run.bold = True
                label_run.font.size = Pt(9)
                _add_block_field(container, raw, options, size=9)
            else:
                p = container.add_paragraph()
                name_run = p.add_run(f"{name}: ")
                name_run.bold = True
                name_run.font.size = Pt(9)
                _add_inline_md_runs(p, raw, size=9)
            continue
        # Phase 5.8b — perspective body renders inline markdown when enabled.
        if attr.attribute_type == "perspective" and options.render_markdown_in_text_fields:
            p = container.add_paragraph()
            nr = p.add_run(f"{name}: ")
            nr.bold = True
            nr.font.size = Pt(9)
            target = (attr.perspective_target or "").strip()
            body = (attr.description or "").strip()
            if target:
                pr = p.add_run(f"Perspective on {target}" + (": " if body else ""))
                pr.font.size = Pt(9)
            if body:
                _add_inline_field(p, body, options, size=9)
            elif not target:
                er = p.add_run("—")
                er.font.size = Pt(9)
            continue
        p = container.add_paragraph()
        name_run = p.add_run(f"{name}: ")
        name_run.bold = True
        name_run.font.size = Pt(9)
        value_run = p.add_run(_format_attribute_value(attr))
        value_run.font.size = Pt(9)

    # File attributes — respect the media embedding toggles.
    if options.include_media_attributes:
        for attr in sheet.attributes:
            if attr.attribute_type != "file":
                continue
            _append_file_attribute(container, attr, options)


def _append_file_attribute(container, attr, options) -> None:
    """Render a file-type entity attribute: image inline (embed), or
    audio/video as a placeholder line."""
    kind = (attr.media_kind or "other").lower()
    name = attr.name or "(unnamed)"

    if kind == "image":
        if not options.include_media_attribute_images:
            return
        label_para = container.add_paragraph()
        label_run = label_para.add_run(f"{name}:")
        label_run.bold = True
        label_run.font.size = Pt(9)
        img_stream = _decode_data_uri(attr.file_ref_data_uri)
        if img_stream is None:
            placeholder_para = container.add_paragraph()
            placeholder_run = placeholder_para.add_run(
                "[image could not be embedded]"
            )
            placeholder_run.italic = True
            placeholder_run.font.size = Pt(9)
            return
        img_para = container.add_paragraph()
        img_run = img_para.add_run()
        try:
            img_run.add_picture(img_stream, width=Inches(3.5))
        except Exception:
            placeholder_run = container.add_paragraph().add_run(
                "[image could not be embedded]"
            )
            placeholder_run.italic = True
            placeholder_run.font.size = Pt(9)
        return

    if kind == "audio":
        if not options.include_media_attribute_audio:
            return
        p = container.add_paragraph()
        name_run = p.add_run(f"{name}: ")
        name_run.bold = True
        name_run.font.size = Pt(9)
        placeholder = p.add_run("[Audio attachment — not playable in Word]")
        placeholder.italic = True
        placeholder.font.size = Pt(9)
        return

    if kind == "video":
        if not options.include_media_attribute_video:
            return
        p = container.add_paragraph()
        name_run = p.add_run(f"{name}: ")
        name_run.bold = True
        name_run.font.size = Pt(9)
        placeholder = p.add_run("[Video attachment — not playable in Word]")
        placeholder.italic = True
        placeholder.font.size = Pt(9)
        return
    # Unknown media kind: silent drop.


def _append_entity_sheet_relationships(container, sheet, options) -> None:
    if not sheet.relationships:
        return
    header_para = container.add_paragraph()
    header_run = header_para.add_run("Relationships:")
    header_run.bold = True
    header_run.font.size = Pt(9)
    for rel in sheet.relationships:
        p = container.add_paragraph()
        p.paragraph_format.left_indent = Inches(0.25)
        label_run = p.add_run(rel.display_label or "(unnamed)")
        label_run.bold = True
        label_run.font.size = Pt(9)
        # Colour the label using the first other participant's colour
        # when per-entity colours are on and there is one other participant.
        if options.use_entity_colours and rel.other_participants:
            participant_colour = rel.other_participants[0].entity_colour
            if participant_colour:
                _apply_hex_colour(label_run, participant_colour)
        # Phase 1.25c (Bug 8) — surface hierarchy / membership flags as
        # small uppercase fragments after the label.
        flag_bits: list[str] = []
        if rel.is_membership:
            flag_bits.append("MEMBERSHIP")
        if rel.has_hierarchy:
            flag_bits.append("HIERARCHY")
        if flag_bits:
            flag_run = p.add_run(f"  [{' / '.join(flag_bits)}]")
            flag_run.font.size = Pt(7)
            flag_run.font.color.rgb = RGBColor(0x88, 0x88, 0x88)
        # Phase 1.25c — description, role, and perception each emit
        # their own indented paragraph so the writer can see them
        # distinctly. All italic at 9pt to match the existing perception
        # styling.
        description = (rel.description or "").strip()
        if description:
            d = container.add_paragraph()
            d.paragraph_format.left_indent = Inches(0.5)
            _add_inline_field(d, description, options, size=9, italic=True)
        role = (rel.own_role or "").strip()
        if role:
            r = container.add_paragraph()
            r.paragraph_format.left_indent = Inches(0.5)
            run = r.add_run(f"Role: {role}")
            run.italic = True
            run.font.size = Pt(9)
        perception = (rel.own_perception or "").strip()
        if perception:
            pp = container.add_paragraph()
            pp.paragraph_format.left_indent = Inches(0.5)
            _add_inline_field(pp, perception, options, size=9, italic=True)


def _format_attribute_value(attr: ExportAttribute) -> str:
    if attr.attribute_type in ("text_list", "entity_list"):
        return attr.value or ""
    if attr.attribute_type == "perspective":
        # Phase 5.8b — first-person view on another object.
        body = attr.description or ""
        target = attr.perspective_target or ""
        if target and body:
            return f"Perspective on {target}: {body}"
        if target:
            return f"Perspective on {target}"
        return body or "—"
    return attr.value or "—"


# ── Small helpers ──────────────────────────────────────────────────────


def _apply_hex_colour(run, hex_value: str) -> None:
    """Apply a `#rrggbb` colour string to a docx run's font colour.
    Silently skips on malformed hex — a single bad colour never
    breaks the export."""
    if not hex_value:
        return
    cleaned = hex_value.strip()
    if cleaned.startswith("#"):
        cleaned = cleaned[1:]
    if len(cleaned) != 6:
        return
    try:
        r = int(cleaned[0:2], 16)
        g = int(cleaned[2:4], 16)
        b = int(cleaned[4:6], 16)
        run.font.color.rgb = RGBColor(r, g, b)
    except (ValueError, AttributeError):
        pass


def _decode_data_uri(data_uri: Optional[str]) -> Optional[BytesIO]:
    """Decode a `data:...;base64,...` URI into a BytesIO ready for
    `add_picture()`. Returns None on any failure so a single bad
    asset never breaks the whole export."""
    if not data_uri or not data_uri.startswith("data:"):
        return None
    try:
        _, _, b64 = data_uri.partition(",")
        if not b64:
            return None
        raw = base64.b64decode(b64)
        return BytesIO(raw)
    except Exception:
        return None


# ── TipTap HTML → docx paragraphs converter ────────────────────────────


class _TipTapToDocx(HTMLParser):
    """Convert TipTap StarterKit HTML into a sequence of python-docx
    paragraphs + runs directly on a `Document`. Sibling class to the
    markdown / txt / pdf parsers. Shares no code with them per the
    renderer-independence rule.

    Block-level tags (`<p>`, `<h1>`..`<h6>`, `<blockquote>`, `<pre>`,
    `<li>`) each start a new paragraph with a specific paragraph
    style. Inline tags (`<strong>`, `<em>`, `<u>`, `<s>`) push
    formatting onto a stack that applies to runs created via
    `handle_data`. Media tags (`<img>`, `<video>`, `<audio>`,
    `<picture>`, `<figure>`) are tracked separately: `<img>` with a
    data URI gets embedded as an inline image on the current paragraph
    when `include_media_attribute_images` is on; other media tags and
    their children are dropped.
    """

    _MEDIA_VOID = {"source"}
    _MEDIA_CONTAINER = {"video", "audio", "picture", "figure", "figcaption"}

    def __init__(self, doc: DocumentType, options: ExportOptions, base_size: Optional[int] = None) -> None:
        super().__init__(convert_charrefs=True)
        self.doc = doc
        self.options = options
        # Phase 5.8b — when set, every run is sized to this point size so a
        # markdown block rendered inside an entity sheet matches the sheet's
        # text instead of the larger scene-body default.
        self._base_size = base_size
        self.emitted_paragraphs: list = []
        self._current_paragraph = None
        self._format_stack: list[dict] = []
        self._list_stack: list[dict] = []
        self._link_stack: list[str] = []
        self._skip_depth = 0
        self._in_pre = False
        self._pre_text: list[str] = []

    def _push_format(self, **overrides) -> None:
        # Start from a copy of the current top-of-stack so ancestor
        # formatting is preserved when children push their own.
        base = dict(self._format_stack[-1]) if self._format_stack else {
            "bold": False, "italic": False, "underline": False, "strike": False
        }
        base.update(overrides)
        self._format_stack.append(base)

    def _pop_format(self) -> None:
        if self._format_stack:
            self._format_stack.pop()

    def _current_format(self) -> dict:
        if self._format_stack:
            return self._format_stack[-1]
        return {"bold": False, "italic": False, "underline": False, "strike": False}

    def _ensure_paragraph(self, style: Optional[str] = None):
        if self._current_paragraph is None:
            try:
                p = self.doc.add_paragraph(style=style) if style else self.doc.add_paragraph()
            except KeyError:
                p = self.doc.add_paragraph()
            self._current_paragraph = p
            self.emitted_paragraphs.append(p)
        return self._current_paragraph

    def _finish_paragraph(self) -> None:
        self._current_paragraph = None

    def handle_starttag(self, tag: str, attrs: list) -> None:  # type: ignore[override]
        if self._skip_depth > 0:
            if tag not in self._MEDIA_VOID and tag != "img" and tag != "br" and tag != "hr":
                self._skip_depth += 1
            return

        if tag == "img":
            self._handle_img(attrs)
            return
        if tag in self._MEDIA_VOID:
            return
        if tag in self._MEDIA_CONTAINER:
            self._skip_depth = 1
            return

        if tag == "p":
            self._finish_paragraph()
            self._ensure_paragraph()
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            # Scene body headings render as a new paragraph with bold
            # text, not a Word Heading style, so they don't fight the
            # document's own outline hierarchy (acts/chapters/scenes).
            self._finish_paragraph()
            self._ensure_paragraph()
            self._push_format(bold=True)
        elif tag in ("strong", "b"):
            self._push_format(bold=True)
        elif tag in ("em", "i"):
            self._push_format(italic=True)
        elif tag == "u":
            self._push_format(underline=True)
        elif tag in ("s", "del", "strike"):
            self._push_format(strike=True)
        elif tag == "code":
            if not self._in_pre:
                # Inline code — push a formatting flag we read at run
                # creation time to apply Courier font. We piggyback on
                # the format stack via a custom key.
                self._push_format(code=True)
        elif tag == "pre":
            self._finish_paragraph()
            self._in_pre = True
            self._pre_text = []
        elif tag == "blockquote":
            self._finish_paragraph()
            p = self._ensure_paragraph()
            try:
                p.paragraph_format.left_indent = Inches(0.5)
                p.paragraph_format.right_indent = Inches(0.5)
            except Exception:
                pass
            self._push_format(italic=True)
        elif tag in ("ul", "ol"):
            self._finish_paragraph()
            self._list_stack.append({"type": tag, "index": 0})
        elif tag == "li":
            self._finish_paragraph()
            depth = max(0, len(self._list_stack) - 1)
            top = self._list_stack[-1] if self._list_stack else None
            if top and top["type"] == "ol":
                top["index"] += 1
                marker = f"{top['index']}. "
            else:
                marker = "\u2022 "  # bullet
            p = self._ensure_paragraph()
            try:
                p.paragraph_format.left_indent = Inches(0.25 * (depth + 1))
            except Exception:
                pass
            marker_run = p.add_run(marker)
            marker_run.font.size = Pt(self._base_size or 11)
        elif tag == "a":
            href = ""
            for key, value in attrs:
                if key == "href":
                    href = value or ""
                    break
            self._link_stack.append(href)
            # Link text is styled as underlined (blueish) run — we
            # push underline + encode the href in the format stack
            # so handle_data can apply it.
            self._push_format(underline=True, link_href=href or None)
        elif tag == "br":
            if self._current_paragraph is not None:
                run = self._current_paragraph.add_run()
                try:
                    run.add_break()
                except Exception:
                    pass
        elif tag == "hr":
            self._finish_paragraph()
            hr_para = self.doc.add_paragraph()
            hr_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
            hr_run = hr_para.add_run("* * *")
            hr_run.italic = True
            self.emitted_paragraphs.append(hr_para)

    def handle_endtag(self, tag: str) -> None:  # type: ignore[override]
        if self._skip_depth > 0:
            if tag in self._MEDIA_CONTAINER:
                self._skip_depth -= 1
            elif tag not in self._MEDIA_VOID and tag != "img" and tag != "br" and tag != "hr":
                self._skip_depth -= 1
            return

        if tag == "p":
            self._finish_paragraph()
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._pop_format()
            self._finish_paragraph()
        elif tag in ("strong", "b", "em", "i", "u", "s", "del", "strike"):
            self._pop_format()
        elif tag == "code":
            if not self._in_pre:
                self._pop_format()
        elif tag == "pre":
            # Emit accumulated <pre> content as a single Courier
            # paragraph.
            raw = "".join(self._pre_text).rstrip()
            if raw:
                p = self.doc.add_paragraph()
                for line in raw.split("\n"):
                    if line != raw.split("\n")[0]:
                        try:
                            p.add_run().add_break()
                        except Exception:
                            pass
                    run = p.add_run(line)
                    run.font.name = "Courier New"
                    run.font.size = Pt(9)
                self.emitted_paragraphs.append(p)
            self._pre_text = []
            self._in_pre = False
        elif tag == "blockquote":
            self._pop_format()
            self._finish_paragraph()
        elif tag in ("ul", "ol"):
            if self._list_stack:
                self._list_stack.pop()
            self._finish_paragraph()
        elif tag == "li":
            self._finish_paragraph()
        elif tag == "a":
            if self._link_stack:
                self._link_stack.pop()
            self._pop_format()

    def handle_data(self, data: str) -> None:  # type: ignore[override]
        if self._skip_depth > 0:
            return
        if self._in_pre:
            self._pre_text.append(data)
            return
        if not data or data.isspace():
            # Skip whitespace-only runs at the start of a paragraph,
            # but allow them inside paragraphs for inter-word spacing.
            if self._current_paragraph is None:
                return
            data = re.sub(r"\s+", " ", data)
            if not data:
                return
        else:
            data = re.sub(r"\s+", " ", data)
        p = self._ensure_paragraph()
        run = p.add_run(data)
        if self._base_size:
            run.font.size = Pt(self._base_size)
        fmt = self._current_format()
        run.bold = bool(fmt.get("bold"))
        run.italic = bool(fmt.get("italic"))
        run.underline = bool(fmt.get("underline"))
        if fmt.get("strike"):
            run.font.strike = True
        if fmt.get("code"):
            run.font.name = "Courier New"

    def _handle_img(self, attrs: list) -> None:
        """Inline <img>: decode the data URI if present and
        `include_media_attribute_images` is on, then embed as an
        inline picture in the current paragraph."""
        if not self.options.include_media_attributes:
            return
        if not self.options.include_media_attribute_images:
            return
        src = ""
        for key, value in attrs:
            if key == "src":
                src = value or ""
                break
        if not src:
            return
        stream = _decode_data_uri(src)
        if stream is None:
            return
        p = self._ensure_paragraph()
        run = p.add_run()
        try:
            run.add_picture(stream, width=Inches(3.5))
        except Exception:
            pass

    def convert(self, html_text: str) -> list:
        self.feed(html_text or "")
        self._finish_paragraph()
        return self.emitted_paragraphs


def _tiptap_to_docx_paragraphs(
    doc: DocumentType,
    html_text: str,
    options: ExportOptions,
    base_size: Optional[int] = None,
) -> list:
    """Top-level TipTap → docx entry point. Creates a fresh parser,
    feeds the HTML, and returns the list of Paragraph objects that
    were emitted so the caller can apply `keep_with_next` to them.
    `base_size` sizes all runs to that point size (Phase 5.8b — used for
    markdown blocks inside entity sheets)."""
    converter = _TipTapToDocx(doc, options, base_size=base_size)
    return converter.convert(html_text)


# ── Registry binding ───────────────────────────────────────────────────


def render(model: ExportModel, options: Optional[ExportOptions] = None) -> bytes:
    return render_docx(model, options)


SPEC = RendererSpec(
    format_id="docx",
    label="Word (.docx)",
    extension="docx",
    mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    render=render,
    capabilities=frozenset({
        # DOCX is paginated — honours ExportOptions.page_size and
        # enforces the shared Pagination model via add_page_break()
        # + keep_with_next on every-paragraph-but-the-last in a scene.
        "pagination",
        # Profile images embed on entity reference sheets via
        # add_picture() reading base64 data URIs from the model.
        "embedded_assets",
        # File-type image attributes embed inline; audio / video
        # surface as placeholder paragraphs since Word can't play
        # them back. Scene body <img> tags also get embedded when
        # the image toggle is on.
        "embedded_media",
        # Entity mentions render in their own colour via
        # run.font.color.rgb when use_entity_colours is on.
        "entity_colours",
        # (NOT entity_links — docx bookmarks + hyperlinks require
        # raw XML manipulation that python-docx doesn't expose
        # directly. Possible follow-up item.)
    }),
)
register(SPEC)
