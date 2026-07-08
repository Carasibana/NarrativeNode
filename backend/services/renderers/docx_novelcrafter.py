"""
Microsoft Word (NovelCrafter) variant renderer — Phase 1.12a Track 10b.

Part of the modular renderer package. This is a **variant** of the
base `docx` renderer (see `backend/services/renderers/docx.py`) — it
declares `variant_of="docx"` on its SPEC so the frontend hides it
from the top-level Format picker and exposes it instead via the
Layout sub-picker beneath the Microsoft Word format choice. User
picks "Microsoft Word (.docx)" → "NovelCrafter" and gets a `.zip`
bundle tailored for NovelCrafter's import / Extract workflow.

The canonical specification for NovelCrafter's import and Extract
format rules lives at:

    .References/NovelCrafter file formatting for import to Novelcrafter/
    Export for NovelCrafter importing.md

Read that file first if you're making changes here. The short
version:

  - **Manuscript file** (`.docx`): NovelCrafter's Word importer keys
    off the built-in `Heading 1` and `Heading 2` styles. Use
    `Heading 1` for acts (`#` equivalent), `Heading 2` for chapters
    (`##` equivalent). Flatten to `Heading 1` for chapters when
    there are no acts. Scenes separated by a `***` centred
    paragraph. Nothing else — no scene titles, no POV lines, no
    entity context, no changes blocks, no appendices, no images,
    no table of contents.
  - **Entity codex source file** (`.md`): a numbered list of entries
    formatted for NovelCrafter's Extract button. Same shape as the
    `markdown-novelcrafter` variant produces because the user
    pastes it into a NovelCrafter Snippet (plain text target), so
    the manuscript format and the entity file format are
    independent — docx manuscript + md entities.

## Output shape

`.zip` bundle (SPEC: `extension="zip"`, `mime_type="application/zip"`)
containing two files:

  - `{sanitised_title}-manuscript.docx` — clean NovelCrafter-ready
    Word document
  - `{sanitised_title}-entities.md` — entity codex source (same as
    `markdown-novelcrafter`'s entities file, for consistency and
    because Snippets are plain-text so markdown inline formatting
    is what Extract parses)

A single combined `.docx` is NOT viable for the same reason as the
markdown variant — NovelCrafter's naive manuscript importer would
try to ingest any additional `Heading 2` section (e.g. an entity
codex appendix) as garbage chapters. Two separate files keeps each
workflow clean.

## Renderer independence

Self-contained per the renderer-independence rule. Does
NOT import from `renderers/docx.py`, `renderers/markdown_novelcrafter.py`,
or any other sibling. The TipTap HTML parser is an own
`_TipTapToNovelCrafterDocx` class — structurally similar to
`_TipTapToDocx` in `renderers/docx.py` but deliberately minimal: no
headings, no blockquotes, no code blocks, no lists, no horizontal
rules, no media, no links. Only paragraphs with inline bold / italic
/ underline / strikethrough, because that's all NovelCrafter's
manuscript importer preserves.

The `_extract_aliases` helper and `_ALIAS_ATTRIBUTE_SYNONYMS` set
are copy-adapted from `markdown_novelcrafter.py` — same logic, same
synonym list, two copies because cross-renderer imports are
forbidden. Both copies check `sheet.aliases` first (native field,
Phase 1.16+) and fall back to the attribute synonym scan for older
saves.
"""

from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from io import BytesIO
from typing import Optional
from zipfile import ZIP_DEFLATED, ZipFile

# python-docx — absolute import, not a self-reference (see
# renderers/docx.py module docstring for why this works).
from docx import Document
from docx.document import Document as DocumentType
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Mm, Pt

from services.export_service import (
    ExportAttribute,
    ExportEntitySheet,
    ExportModel,
    ExportOptions,
    ExportScene,
    ExportSection,
)
from .registry import RendererSpec, register


# ── Public entry ───────────────────────────────────────────────────────


def render_docx_novelcrafter(
    model: ExportModel,
    options: Optional[ExportOptions] = None,
) -> bytes:
    """Build the two-file NovelCrafter bundle and return the ZIP bytes.

    Same one-or-the-other rule as `render_markdown_novelcrafter` —
    NC's importer ingests prose OR summaries, not both. Both-on
    collapses to prose; neither-on collapses to prose. The
    manuscript file inside the ZIP ends `-Prose.docx` or
    `-Summaries.docx` so the writer can tell at a glance which mode
    the bundle was rendered in.
    """
    options = options or ExportOptions()
    mode = _resolve_nc_mode(options)
    effective_options = _options_for_mode(options, mode)

    manuscript_bytes = _render_manuscript_docx(model, effective_options)
    # Phase 3.11 — codex-follows-family: when the writer picks the
    # DOCX bundle, both files inside the zip are DOCX. The standalone
    # codex download (`docx-novelcrafter-codex`) uses the same
    # renderer so the bundle and codex-only paths are byte-identical
    # for the entities file.
    entities_bytes = _render_entities_docx(model)

    title_slug = _sanitise_filename(model.title or "story")
    mode_suffix = "Prose" if mode == "prose" else "Summaries"
    manuscript_filename = f"{title_slug}-manuscript-{mode_suffix}.docx"
    entities_filename = f"{title_slug}-entities.docx"

    buf = BytesIO()
    with ZipFile(buf, "w", ZIP_DEFLATED) as zf:
        zf.writestr(manuscript_filename, manuscript_bytes)
        zf.writestr(entities_filename, entities_bytes)
    return buf.getvalue()


def _sanitise_filename(raw: str) -> str:
    """Strip characters unsafe in a filename and collapse whitespace
    to hyphens. Duplicate of the router's helper and of
    `markdown_novelcrafter._sanitise_filename` — each renderer stays
    self-contained."""
    cleaned = re.sub(r'[\\/:*?"<>|]+', "", raw or "").strip()
    cleaned = re.sub(r"\s+", "-", cleaned)
    return cleaned or "story"


def _resolve_nc_mode(options: ExportOptions) -> str:
    """Map the writer's two flags to NC's one-or-the-other constraint.
    Both-on collapses to prose; neither-on collapses to prose.
    Duplicated from `markdown_novelcrafter` per the renderer-
    independence convention (each format self-contained)."""
    if options.include_scene_body:
        return "prose"
    if options.include_scene_description:
        return "summaries"
    return "prose"


def _options_for_mode(options: ExportOptions, mode: str) -> ExportOptions:
    """Return a derivative ExportOptions with the per-scene flags
    coerced to the resolved NC mode so the downstream renderer
    sees a consistent picture."""
    from dataclasses import replace
    if mode == "summaries":
        return replace(options, include_scene_description=True, include_scene_body=False)
    return replace(options, include_scene_description=False, include_scene_body=True)


def nc_filename_suffix(options: ExportOptions) -> str:
    """Outer router consumes this to suffix the downloaded file's
    name (e.g. `Story-Prose.zip` / `Story-Summaries.zip`)."""
    return "Prose" if _resolve_nc_mode(options) == "prose" else "Summaries"


# ── Manuscript file ────────────────────────────────────────────────────


def _render_manuscript_docx(model: ExportModel, options: ExportOptions) -> bytes:
    """Build the NovelCrafter manuscript `.docx` file: Heading 1 for
    acts, Heading 2 for chapters (or Heading 1 if no acts), scene
    body prose as Normal paragraphs, `***` centred separator
    between scenes. Returns the document as raw bytes."""
    doc = Document()
    _setup_page_size(doc, options)
    _setup_margins(doc)
    _set_core_properties(doc, model)

    has_acts = any(s.kind == "act" for s in model.sections)

    for section in model.sections:
        _append_manuscript_section(doc, section, has_acts, options)

    buf = BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _setup_page_size(doc: DocumentType, options: ExportOptions) -> None:
    """Honour `options.page_size` even though we don't declare the
    `pagination` capability. Users who picked Letter on the base
    docx format and then switched to NovelCrafter layout expect
    their page size preference to carry through — the Layout
    sub-picker doesn't reset sibling settings."""
    section = doc.sections[0]
    size = (options.page_size or "a4").lower()
    if size == "letter":
        section.page_width = Inches(8.5)
        section.page_height = Inches(11.0)
    else:
        section.page_width = Mm(210)
        section.page_height = Mm(297)


def _setup_margins(doc: DocumentType) -> None:
    section = doc.sections[0]
    section.top_margin = Inches(1.0)
    section.bottom_margin = Inches(1.0)
    section.left_margin = Inches(1.0)
    section.right_margin = Inches(1.0)


def _set_core_properties(doc: DocumentType, model: ExportModel) -> None:
    props = doc.core_properties
    props.title = model.title or "Story"
    if model.author:
        props.author = model.author


def _append_manuscript_section(
    doc: DocumentType,
    section: ExportSection,
    has_acts: bool,
    options: ExportOptions,
) -> None:
    if section.kind == "act":
        doc.add_heading((section.label or "").strip(), level=1)
        for child in section.children:
            _append_manuscript_section(doc, child, has_acts, options)
        return

    if section.kind == "chapter":
        # Chapters are Heading 2 when acts exist, Heading 1 otherwise
        # (NovelCrafter's "flatten to Heading 1 when no acts" rule).
        chapter_level = 2 if has_acts else 1
        doc.add_heading((section.label or "").strip(), level=chapter_level)
        _append_manuscript_scenes(doc, section.scenes, options)
        return

    # "unchaptered"
    if section.scenes:
        chapter_level = 2 if has_acts else 1
        doc.add_heading(
            (section.label or "Unchaptered").strip(), level=chapter_level
        )
        _append_manuscript_scenes(doc, section.scenes, options)


def _append_manuscript_scenes(
    doc: DocumentType, scenes: list[ExportScene], options: ExportOptions
) -> None:
    """Emit a chapter's scenes separated by `***`. Honours
    `ExportOptions.include_scene_description` + `include_scene_body`
    per scene:
      - description only → italic Normal paragraph(s) with the
        description text.
      - body only (default) → the prose body as today.
      - both → description in italics, then a centred `---` Normal
        paragraph, then the prose body. Mirrors the Markdown
        renderer's summary/body split (see
        `markdown_novelcrafter._render_one_scene`); NovelCrafter's
        Markdown import documents the `---` divider for the
        summary/body transition. NC's DOCX import path may treat the
        whole block as prose — in that case the writer can read the
        italic description visually but the field-level split lands
        only in the Markdown export.
    Scenes that contribute nothing under the writer's flags are
    skipped so no stray `***` lands between empty entries.
    """
    rendered: list[ExportScene] = [
        s for s in scenes
        if _scene_has_content_for_options(s, options)
    ]
    for index, scene in enumerate(rendered):
        if index > 0:
            _append_scene_separator(doc)
        _append_one_scene(doc, scene, options)


def _scene_has_content_for_options(scene: ExportScene, options: ExportOptions) -> bool:
    if options.include_scene_description and (scene.description or "").strip():
        return True
    if options.include_scene_body and scene.main_content_html.strip():
        return True
    return False


def _append_one_scene(
    doc: DocumentType, scene: ExportScene, options: ExportOptions
) -> None:
    description_text = (scene.description or "").strip() if options.include_scene_description else ""
    has_body = options.include_scene_body and scene.main_content_html.strip()
    if description_text:
        p = doc.add_paragraph()
        run = p.add_run(description_text)
        run.italic = True
    if description_text and has_body:
        # Centred `---` matches the Markdown summary→body convention.
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.add_run("---")
    if has_body:
        _tiptap_to_docx_plain(doc, scene.main_content_html)


def _append_scene_separator(doc: DocumentType) -> None:
    """Emit a `***` centred Normal paragraph as NovelCrafter's scene
    separator."""
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run("***")
    run.bold = False
    run.italic = False


# ── Entities file ──────────────────────────────────────────────────────


# Attribute-name synonyms for aliases / nicknames. Copy-adapted from
# `markdown_novelcrafter.py._ALIAS_ATTRIBUTE_SYNONYMS` — same list,
# same semantics, two copies because cross-renderer imports are
# forbidden per the renderer-independence rule. When
# Phase 1.15 lands the native `Entity.aliases` field, BOTH copies
# need updating to check the native field first before falling back
# to synonym matching.
_ALIAS_ATTRIBUTE_SYNONYMS = frozenset({
    "aliases",
    "alias",
    "nicknames",
    "nickname",
    "nick",
    "also known as",
    "aka",
    "a.k.a",
    "a.k.a.",
    "other names",
    "other name",
    "alternate names",
    "alternative names",
    "known as",
    "goes by",
})


_BUCKET_SECTION_TITLES = {
    "character": "Characters",
    "location": "Locations",
    "item": "Items",
    "faction": "Factions",
    "custom": "Customs",
    # Phase 1.21c: Knowledge removed from Entity-subtype treatment.
    # Knowledges are first-class objects with their own export path TBD
    # (Phase 1.25 review).
}


def _render_entities(model: ExportModel) -> str:
    """Walk `model.entity_sheets` and emit the NovelCrafter entity
    codex source markdown. Same shape as `markdown_novelcrafter`'s
    entities file for consistency — markdown format because the
    user pastes it into a NovelCrafter Snippet (plain text /
    markdown target)."""
    parts: list[str] = [
        "# Entity Codex Source for NovelCrafter Extract",
        "",
        "Paste this file's contents into a NovelCrafter Snippet, then "
        "click the Extract button on the Snippet and pick the target "
        "codex type (Characters / Locations / Items / Lore / Other). "
        "Run Extract once per type. Alternatively, copy just one "
        "section at a time for cleaner per-type extraction.",
    ]

    if not model.entity_sheets:
        parts.append("")
        parts.append(
            "_(No entity reference sheets were included in this export.)_"
        )
        return "\n".join(parts) + "\n"

    by_bucket: dict[str, list[ExportEntitySheet]] = {}
    for sheet in model.entity_sheets:
        bucket = (sheet.type or "custom").lower()
        by_bucket.setdefault(bucket, []).append(sheet)

    canonical_order = ["character", "location", "item", "faction", "custom"]
    rendered_buckets: set[str] = set()
    for bucket_key in canonical_order:
        sheets = by_bucket.get(bucket_key)
        if not sheets:
            continue
        parts.append("")
        parts.append(f"## {_BUCKET_SECTION_TITLES.get(bucket_key, bucket_key.capitalize())}")
        parts.append("")
        for index, sheet in enumerate(sheets, start=1):
            parts.append(_render_entity_entry(sheet, index, bucket_key))
        rendered_buckets.add(bucket_key)

    for bucket_key, sheets in by_bucket.items():
        if bucket_key in rendered_buckets or not sheets:
            continue
        parts.append("")
        parts.append(f"## {bucket_key.capitalize()}")
        parts.append("")
        for index, sheet in enumerate(sheets, start=1):
            parts.append(_render_entity_entry(sheet, index, bucket_key))

    return "\n".join(parts).rstrip() + "\n"


def _render_entity_entry(
    sheet: ExportEntitySheet,
    index: int,
    bucket_key: str,
) -> str:
    """Render one entity as a numbered list entry in NovelCrafter's
    Extract-compatible format."""
    name = sheet.name or "(unnamed)"
    aliases = _extract_aliases(sheet)
    bucket_tag = bucket_key

    alias_block = ""
    if aliases:
        alias_block = " (" + ", ".join(aliases) + ")"

    header = f"{index}. **{name}{alias_block} [{bucket_tag}]:**"

    description = (sheet.description or "").strip()
    if not description:
        return header

    description_paragraphs = [
        p.strip() for p in re.split(r"\n\s*\n", description) if p.strip()
    ]

    if len(description_paragraphs) == 1:
        return f"{header} {description_paragraphs[0]}"

    lines: list[str] = [f"{header} {description_paragraphs[0]}"]
    for paragraph in description_paragraphs[1:]:
        lines.append("")
        lines.append(f"   {paragraph}")
    return "\n".join(lines)


def _extract_aliases(sheet: ExportEntitySheet) -> list[str]:
    """Return entity aliases, preferring the native `sheet.aliases`
    field when non-empty and falling back to the attribute synonym scan
    for older saves that stored aliases as a text_list attribute.
    Copy-adapted from `markdown_novelcrafter._extract_aliases`.
    """
    if sheet.aliases:
        return list(sheet.aliases)
    collected: list[str] = []
    seen: set[str] = set()
    for attr in sheet.attributes or []:
        if not _is_alias_attribute(attr):
            continue
        for value in _parse_alias_value(attr):
            if value not in seen:
                seen.add(value)
                collected.append(value)
    return collected


def _is_alias_attribute(attr: ExportAttribute) -> bool:
    name = (attr.name or "").strip().lower().rstrip(":").strip()
    name = re.sub(r"\s+", " ", name)
    return name in _ALIAS_ATTRIBUTE_SYNONYMS


def _parse_alias_value(attr: ExportAttribute) -> list[str]:
    if not attr or attr.attribute_type == "file":
        return []
    raw = (attr.value or "").strip()
    if not raw:
        return []
    if attr.attribute_type in ("text_list", "entity_list"):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return [str(x).strip() for x in parsed if str(x).strip()]
        except (ValueError, TypeError):
            return []
        return []
    parts: list[str] = []
    for chunk in raw.split(","):
        for sub in re.split(r"\s+and\s+", chunk):
            cleaned = sub.strip()
            if cleaned:
                parts.append(cleaned)
    return parts


# ── TipTap HTML → docx plain paragraphs converter ─────────────────────


class _TipTapToNovelCrafterDocx(HTMLParser):
    """Convert TipTap scene body HTML into plain docx paragraphs
    suitable for NovelCrafter's manuscript importer.

    Sibling class to the `_TipTapToDocx` in `renderers/docx.py` but
    structurally simpler because NovelCrafter's manuscript format is
    restrictive:

      - NO headings inside scene body (NovelCrafter reads every
        `Heading 1` / `Heading 2` as an act / chapter; body headings
        would break the hierarchy). `<h1>`..`<h6>` inside scene body
        render as plain paragraphs, no heading style.
      - NO blockquotes, code blocks, lists, horizontal rules. These
        would all confuse or bloat the importer. Text content is
        preserved as plain paragraphs; structural markup is dropped.
      - NO links — NovelCrafter strips them anyway, and the
        underline styling would clutter imported prose.
      - NO media tags (same policy as every NovelCrafter variant).

    What IS preserved:

      - `<p>` paragraph boundaries as separate `add_paragraph()` calls
      - `<strong>` / `<b>` → `run.bold = True`
      - `<em>` / `<i>` → `run.italic = True`
      - `<u>` → `run.underline = True`
      - `<s>` / `<del>` / `<strike>` → `run.font.strike = True`
      - `<br>` → `run.add_break()` within the current paragraph

    Copy-adapted from the markdown variant's `_TipTapToPlainMarkdown`
    in shape and from Track 7's `_TipTapToDocx` in mechanics, both
    per the renderer-independence rule.
    """

    _MEDIA_VOID = {"img", "source"}
    _MEDIA_CONTAINER = {"video", "audio", "picture", "figure", "figcaption"}

    def __init__(self, doc: DocumentType) -> None:
        super().__init__(convert_charrefs=True)
        self.doc = doc
        self._current_paragraph = None
        self._format_stack: list[dict] = []
        self._skip_depth = 0

    def _push_format(self, **overrides) -> None:
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

    def _ensure_paragraph(self):
        if self._current_paragraph is None:
            self._current_paragraph = self.doc.add_paragraph()
        return self._current_paragraph

    def _finish_paragraph(self) -> None:
        self._current_paragraph = None

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
            self._finish_paragraph()
            self._ensure_paragraph()
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            # Scene body headings would collide with NovelCrafter's
            # act / chapter hierarchy — render as plain paragraphs.
            self._finish_paragraph()
            self._ensure_paragraph()
        elif tag in ("strong", "b"):
            self._push_format(bold=True)
        elif tag in ("em", "i"):
            self._push_format(italic=True)
        elif tag == "u":
            self._push_format(underline=True)
        elif tag in ("s", "del", "strike"):
            self._push_format(strike=True)
        elif tag == "br":
            if self._current_paragraph is not None:
                try:
                    self._current_paragraph.add_run().add_break()
                except Exception:
                    pass
        # Everything else (blockquote, code, pre, ul, ol, li, a, hr,
        # etc.) is transparent: text content flows through but the
        # structural / formatting markers are dropped.

    def handle_endtag(self, tag: str) -> None:  # type: ignore[override]
        if self._skip_depth > 0:
            if tag in self._MEDIA_CONTAINER:
                self._skip_depth -= 1
            elif tag not in self._MEDIA_VOID and tag not in ("br", "hr"):
                self._skip_depth -= 1
            return

        if tag == "p":
            self._finish_paragraph()
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._finish_paragraph()
        elif tag in ("strong", "b", "em", "i", "u", "s", "del", "strike"):
            self._pop_format()

    def handle_data(self, data: str) -> None:  # type: ignore[override]
        if self._skip_depth > 0:
            return
        collapsed = re.sub(r"\s+", " ", data)
        if not collapsed or collapsed.isspace():
            if self._current_paragraph is None:
                return
        p = self._ensure_paragraph()
        run = p.add_run(collapsed)
        fmt = self._current_format()
        run.bold = bool(fmt.get("bold"))
        run.italic = bool(fmt.get("italic"))
        run.underline = bool(fmt.get("underline"))
        if fmt.get("strike"):
            run.font.strike = True

    def convert(self, html_text: str) -> None:
        self.feed(html_text or "")
        self._finish_paragraph()


def _tiptap_to_docx_plain(doc: DocumentType, html_text: str) -> None:
    """Top-level TipTap → NovelCrafter docx entry point. Feeds the
    HTML into the converter, which appends paragraphs + runs directly
    onto the document. No return value — paragraphs go straight onto
    the document."""
    converter = _TipTapToNovelCrafterDocx(doc)
    converter.convert(html_text)


# ── Registry binding ───────────────────────────────────────────────────


def render(model: ExportModel, options: Optional[ExportOptions] = None) -> bytes:
    return render_docx_novelcrafter(model, options)


SPEC = RendererSpec(
    format_id="docx-novelcrafter",
    label="Microsoft Word (NovelCrafter)",
    extension="zip",
    mime_type="application/zip",
    render=render,
    capabilities=frozenset(),  # deliberately empty — NovelCrafter format is minimal
    variant_of="docx",
    variant_label="NovelCrafter",
    # Force entity reference sheets on so the entity codex file
    # inside the zip is always populated, regardless of what the
    # user toggled in the Customise section. Same rationale as
    # markdown-novelcrafter.
    required_options={
        "include_entity_sheets": True,
    },
)
register(SPEC)


# ── DOCX entities renderer (Phase 3.11) ────────────────────────────────
# Companion to the markdown-codex export but emitted as DOCX so the
# writer who picked the DOCX family gets a DOCX codex too. Content
# layout mirrors `_render_entities` (the markdown version) so the
# writer can paste either into a NovelCrafter Snippet and hit
# Extract — DOCX preserves heading levels + bold + italics which NC's
# Snippet area accepts.


def _render_entities_docx(model: ExportModel) -> bytes:
    """Build the DOCX equivalent of `_render_entities`'s markdown.
    Same content shape: title heading, intro paragraph, `Heading 2`
    per bucket, numbered list of bold-name entries with optional
    italic aliases + plain-text description following the colon."""
    doc = Document()
    _setup_page_size(doc, ExportOptions())
    _setup_margins(doc)
    doc.core_properties.title = (model.title or "Story") + " — Entity Codex"

    doc.add_heading("Entity Codex Source for NovelCrafter Extract", level=1)
    doc.add_paragraph(
        "Paste this file's contents into a NovelCrafter Snippet, then "
        "click the Extract button on the Snippet and pick the target "
        "codex type (Characters / Locations / Items / Lore / Other). "
        "Run Extract once per type. Alternatively, copy just one "
        "section at a time for cleaner per-type extraction."
    )

    if not model.entity_sheets:
        p = doc.add_paragraph()
        run = p.add_run("(No entity reference sheets were included in this export.)")
        run.italic = True
        buf = BytesIO()
        doc.save(buf)
        return buf.getvalue()

    by_bucket: dict[str, list[ExportEntitySheet]] = {}
    for sheet in model.entity_sheets:
        bucket = (sheet.type or "custom").lower()
        by_bucket.setdefault(bucket, []).append(sheet)

    canonical_order = ["character", "location", "item", "faction", "custom"]
    rendered: set[str] = set()
    for bucket_key in canonical_order:
        sheets = by_bucket.get(bucket_key)
        if not sheets:
            continue
        doc.add_heading(
            _BUCKET_SECTION_TITLES.get(bucket_key, bucket_key.capitalize()),
            level=2,
        )
        for index, sheet in enumerate(sheets, start=1):
            _append_entity_entry_docx(doc, sheet, index, bucket_key)
        rendered.add(bucket_key)

    for bucket_key, sheets in by_bucket.items():
        if bucket_key in rendered or not sheets:
            continue
        doc.add_heading(bucket_key.capitalize(), level=2)
        for index, sheet in enumerate(sheets, start=1):
            _append_entity_entry_docx(doc, sheet, index, bucket_key)

    buf = BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _append_entity_entry_docx(
    doc: DocumentType,
    sheet: ExportEntitySheet,
    index: int,
    bucket_key: str,
) -> None:
    """One numbered entry as a Normal paragraph. Layout:

        1. **Name** *(alias1, alias2)* [bucket]: Description text.

    Bold for Name, italics for aliases, plain for the rest. Subsequent
    description paragraphs are indented Normal paragraphs so the entry
    stays visually grouped without using Word's list-numbering style
    (which would auto-renumber if the writer trims the doc — we want
    stable explicit numbers)."""
    name = sheet.name or "(unnamed)"
    aliases = _extract_aliases(sheet)
    description = (sheet.description or "").strip()

    p = doc.add_paragraph()
    p.add_run(f"{index}. ")
    name_run = p.add_run(name)
    name_run.bold = True
    if aliases:
        p.add_run(" (")
        alias_run = p.add_run(", ".join(aliases))
        alias_run.italic = True
        p.add_run(")")
    p.add_run(f" [{bucket_key}]:")
    if description:
        description_paragraphs = [
            s.strip() for s in re.split(r"\n\s*\n", description) if s.strip()
        ]
        if description_paragraphs:
            p.add_run(f" {description_paragraphs[0]}")
            for paragraph_text in description_paragraphs[1:]:
                indented = doc.add_paragraph()
                indented.paragraph_format.left_indent = Inches(0.35)
                indented.add_run(paragraph_text)


def render_docx_novelcrafter_story(
    model: ExportModel,
    options: Optional[ExportOptions] = None,
) -> bytes:
    """Story-only DOCX download — manuscript file alone, single .docx
    (no zip). Honours the prose/summaries mutex. Filename suffix
    `-Prose.docx` / `-Summaries.docx` applied at the outer router."""
    options = options or ExportOptions()
    mode = _resolve_nc_mode(options)
    effective_options = _options_for_mode(options, mode)
    return _render_manuscript_docx(model, effective_options)


def render_docx_novelcrafter_codex(
    model: ExportModel,
    options: Optional[ExportOptions] = None,
) -> bytes:
    """Codex-only DOCX download — entities sheet alone, single .docx
    (no zip)."""
    _ = options  # codex output is independent of per-scene depth flags
    return _render_entities_docx(model)


def _render_story_variant(model: ExportModel, options: Optional[ExportOptions] = None) -> bytes:
    return render_docx_novelcrafter_story(model, options)


def _render_codex_variant(model: ExportModel, options: Optional[ExportOptions] = None) -> bytes:
    return render_docx_novelcrafter_codex(model, options)


register(RendererSpec(
    format_id="docx-novelcrafter-story",
    label="Microsoft Word (NovelCrafter — Story)",
    extension="docx",
    mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    render=_render_story_variant,
    capabilities=frozenset(),
    hidden_from_picker=True,
    required_options={"include_entity_sheets": True},
))

register(RendererSpec(
    format_id="docx-novelcrafter-codex",
    label="Microsoft Word (NovelCrafter — Codex)",
    extension="docx",
    mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    render=_render_codex_variant,
    capabilities=frozenset(),
    hidden_from_picker=True,
    required_options={"include_entity_sheets": True},
))
