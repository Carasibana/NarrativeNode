"""
Plain text renderer — Phase 1.12a Track 4.

Part of the modular renderer package: each format is its own file
under `backend/services/renderers/`, self-registering a `RendererSpec`
via the registry at the bottom of this module. See
`docs/export-renderer-guide.md` for the full pattern.

Structurally identical walk to the Markdown renderer — same
`ExportModel` traversal, same per-element helpers, same toggle
handling — but emits pure plain text:

  - **Headings use setext-style rules** underneath the heading text.
    Story title uses an over + under `=` box; acts use `=` underline;
    chapters use `-` underline; scenes use `~` underline. Clean, no
    `#` markers, no markup leaking through.
  - **Paragraphs wrap at 72 characters** via `textwrap.fill`, the
    traditional plain-text width. Lists and blockquotes use
    `initial_indent` / `subsequent_indent` so wrapped continuations
    line up with the item text rather than the bullet.
  - **No inline emphasis.** Bold / italic / strikethrough all strip
    to plain text — plain text has no way to express them, so trying
    to fake it with ALL CAPS or asterisks just pollutes the output.
  - **No media.** Images, audio, video are dropped completely — same
    rule as the markdown renderer. File-type entity attributes are
    skipped on entity reference sheets.
  - **Links keep only the link text.** The URL is dropped. A reader
    of the text file can't click a URL anyway; surfacing it would
    just clutter the prose.

Document structure, in order:

    ========================================================================
                                  STORY TITLE
    ========================================================================

    by Author

    Genre: ...
    Tense: ...
    POV style: ...
    ...


    ACT 1: SETUP
    ============

    Chapter 1: Opening
    ------------------

        Transition italic.

    The Meeting
    ~~~~~~~~~~~

        Scene description.

    > POV: Alice

    - Characters: Alice, Bob
    - Location: The Docks

    Scene body wrapped at 72 characters with paragraph breaks
    preserved and inline formatting silently dropped.

    Changes recorded at this scene:

      - Alice (character)
          - attribute: Age -> 29
      - Robert (character)
          - metadata: Renamed to "Robert"


    OFF-SCREEN SCENES
    =================

    Non-POV scenes, presented in canvas order.

    Side Scene
    ~~~~~~~~~~

        A side moment.


    ENTITY REFERENCE SHEETS
    =======================

    Alice
    -----

    Character

    A curious protagonist.

      Age: 28

    Relationships:

      - Bob (character) - Her oldest friend...
"""

from __future__ import annotations

import re
import textwrap
from html.parser import HTMLParser
from typing import Optional

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


# Page width used for setext rules + prose wrapping. 72 is the
# traditional plain-text width (fits in most email clients and
# terminals with margin to spare).
_PAGE_WIDTH = 72


# ── Public entry ───────────────────────────────────────────────────────


def render_txt(model: ExportModel, options: Optional[ExportOptions] = None) -> str:
    """Return the complete plain-text document as a string.

    Registry-facing `render` wrapper at the bottom encodes UTF-8.
    """
    options = options or ExportOptions()
    parts: list[str] = []

    parts.append(_render_story_header(model, options))

    for section in model.sections:
        rendered = _render_section(section, options)
        if rendered:
            parts.append(rendered)

    if options.include_offscreen_appendix and model.offscreen_scenes:
        parts.append(_render_offscreen_appendix(model.offscreen_scenes, options))

    if options.include_entity_sheets and model.entity_sheets:
        parts.append(_render_entity_sheets(model.entity_sheets, options))
    if options.include_knowledge_section and model.knowledge_sheets:
        parts.append(_render_knowledge_sheets(model.knowledge_sheets, options))

    return "\n\n".join(p for p in parts if p).rstrip() + "\n"


# ── Story header ───────────────────────────────────────────────────────


def _render_story_header(model: ExportModel, options: ExportOptions) -> str:
    """Story title box + byline + metadata block.

    Title is centred inside a `=`-rule box for prominence. Byline is
    centred on its own line below. Metadata fields each get their own
    line (one field per line)."""
    lines: list[str] = []
    rule = "=" * _PAGE_WIDTH
    title = (model.title or "").upper().strip()

    lines.append(rule)
    lines.append(_centre(title))
    lines.append(rule)

    if options.include_author and model.author:
        lines.append("")
        lines.append(_centre(f"by {model.author}"))

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

    if meta_lines:
        lines.append("")
        lines.extend(meta_lines)

    # Phase 5.8b — story description blurb, below the metadata block,
    # wrapped to the page width like body prose.
    if options.include_story_description and model.description and model.description.strip():
        lines.append("")
        for raw in model.description.strip().split("\n"):
            stripped = raw.strip()
            lines.append(_wrap_paragraph(stripped) if stripped else "")

    return "\n".join(lines)


def _centre(text: str) -> str:
    if not text:
        return ""
    # `str.center` uses the WHOLE width including the text; if text is
    # longer than the width it just returns the text unchanged, which
    # is fine for our use.
    return text.center(_PAGE_WIDTH).rstrip()


# ── Sections ───────────────────────────────────────────────────────────


# Section level → underline character. 1 = act (outermost), 2 = chapter,
# 3 = scene. Story title uses its own over+under rule box rather than a
# setext heading, so there's no entry at level 0.
_LEVEL_UNDERLINE = {
    1: "=",
    2: "-",
    3: "~",
    4: '"',
    5: "'",
    6: ".",
}


def _setext_heading(text: str, level: int) -> str:
    """Build a setext-style heading: the text followed by a rule made
    of `level`-appropriate characters, length matching the text."""
    char = _LEVEL_UNDERLINE.get(max(1, min(6, level)), "-")
    text = (text or "").strip()
    if not text:
        return ""
    return f"{text}\n{char * len(text)}"


def _render_section(
    section: ExportSection,
    options: ExportOptions,
) -> str:
    """Render a section (act / chapter / unchaptered).

    Heading levels are chosen by `section.kind` directly, not by
    recursion depth, so a chapter always looks like a chapter
    regardless of whether it's nested inside an act or sits standalone
    at the top level. Mapping: act → 1 (`=`), chapter → 2 (`-`),
    unchaptered → 2 (`-`), scene → 3 (`~`)."""
    parts: list[str] = []

    if section.kind == "act":
        if options.include_act_headings:
            parts.append(_setext_heading(section.label.upper(), 1))
        for child in section.children:
            rendered = _render_section(child, options)
            if rendered:
                parts.append(rendered)
        return "\n\n".join(parts)

    if section.kind == "chapter":
        if options.include_chapter_headings:
            parts.append(_setext_heading(section.label, 2))
        for i, scene in enumerate(section.scenes):
            if i > 0 and options.include_scene_separator:
                parts.append("* * *".center(_PAGE_WIDTH).rstrip())
            parts.append(_render_scene(scene, options))
        return "\n\n".join(parts)

    # "unchaptered"
    if section.scenes:
        if options.include_unchaptered_heading:
            parts.append(_setext_heading(section.label, 2))
        for i, scene in enumerate(section.scenes):
            if i > 0 and options.include_scene_separator:
                parts.append("* * *".center(_PAGE_WIDTH).rstrip())
            parts.append(_render_scene(scene, options))
    return "\n\n".join(parts)


# ── Scene ──────────────────────────────────────────────────────────────


def _render_scene(
    scene: ExportScene,
    options: ExportOptions,
) -> str:
    parts: list[str] = []

    if options.include_transition_text and scene.transition_in_text.strip():
        wrapped = _wrap_paragraph(
            scene.transition_in_text.strip(),
            initial_indent="    ",
            subsequent_indent="    ",
        )
        parts.append(wrapped)

    if options.include_scene_title and scene.title:
        parts.append(_setext_heading(scene.title, 3))

    if options.include_scene_description and scene.description.strip():
        parts.append(_block_field_text(scene.description, options, indent="    "))

    # Phase 1.25c — scene-time text-only (icons skipped in txt).
    if options.include_scene_time and scene.scene_time_text:
        parts.append(_wrap_paragraph(scene.scene_time_text, initial_indent="    ", subsequent_indent="    "))

    if options.include_scene_cm_block and scene.cm_groups:
        cm_txt = _render_scene_cm_block(scene.cm_groups, options)
        if cm_txt:
            parts.append(cm_txt)

    if options.include_scene_pov_line and scene.pov_entity_name:
        parts.append(f"POV: {scene.pov_entity_name}")

    if options.include_entity_context_line and scene.entity_context_groups:
        context_lines = _render_entity_context(scene.entity_context_groups)
        if context_lines:
            parts.append(context_lines)

    if options.include_scene_body and scene.main_content_html.strip():
        body_txt = _tiptap_html_to_text(scene.main_content_html)
        if body_txt:
            parts.append(body_txt)

    if options.include_scene_changes_block and scene.changes:
        changes_txt = _render_scene_changes(scene.changes, options)
        if changes_txt:
            parts.append(changes_txt)

    return "\n\n".join(parts)


def _render_entity_context(groups: list[ExportSceneEntityGroup]) -> str:
    """Scene entity context rendered as a bullet list — one line per
    bucket, comma-separated names."""
    lines: list[str] = []
    for group in groups:
        if not group.entries:
            continue
        names = ", ".join(entry.name for entry in group.entries)
        lines.append(f"- {group.label}: {names}")
    return "\n".join(lines)


def _render_scene_changes(
    changes: list[ExportSceneEntityChange],
    options: ExportOptions,
) -> str:
    """Changes block as a nested bullet list with two-space indent for
    the nested details. Filtered by the same granular toggles as the
    other renderers."""
    allowed_categories: set[str] = set()
    if options.include_metadata_changes:
        allowed_categories.add("metadata")
    if options.include_attribute_changes:
        allowed_categories.add("attribute")
    if options.include_relationship_changes:
        allowed_categories.add("relationship")

    if not allowed_categories:
        return ""

    filtered: list[tuple[ExportSceneEntityChange, list[ExportChangeDetail]]] = []
    for change in changes:
        details = [d for d in change.details if d.category in allowed_categories]
        if details:
            filtered.append((change, details))

    if not filtered:
        return ""

    lines: list[str] = ["Changes recorded at this scene:", ""]
    for change, details in filtered:
        lines.append(f"  - {change.entity_name} ({change.entity_type})")
        for detail in details:
            # Drop colour metadata details — a bare hex string is noise
            # in plain text. Plain-language rewrite of the model layer's
            # `→` arrow.
            if detail.category == "metadata" and detail.text.startswith("Colour "):
                continue
            text = detail.text.replace(" → ", " changed to ")
            lines.append(f"      - {text}")
    return "\n".join(lines)


def _inline_field(text: str, options: ExportOptions) -> str:
    """Phase 5.8b — inline-rendered free-form body field. When markdown
    rendering is on, txt strips the markers (keeping the text); raw text
    otherwise. Empty → ""."""
    inner = (text or "").strip()
    if not inner:
        return ""
    if options.render_markdown_in_text_fields:
        return _tiptap_html_to_text(field_markdown_to_inline_html(inner)).strip()
    return inner


def _render_scene_cm_block(groups: list[ExportSceneCMGroup], options: ExportOptions) -> str:
    """Phase 1.22i — Circumstances & Motivators block. One bullet per
    group (Scene + each entity), nested rows underneath."""
    if not groups:
        return ""
    lines: list[str] = ["Circumstances & Motivators:", ""]
    for group in groups:
        if not group.rows:
            continue
        if group.kind == "scene":
            lines.append(f"  - {group.label}")
        else:
            type_part = f" ({group.entity_type})" if group.entity_type else ""
            lines.append(f"  - {group.label}{type_part}")
        for row in group.rows:
            lines.append("    " + _render_cm_row(row, options))
    return "\n".join(lines)


def _render_cm_row(row: ExportSceneCMRow, options: ExportOptions) -> str:
    name = (row.name or "").strip()
    desc = (row.description or "").strip()
    label = name or (_inline_field(desc, options) if desc else "(unnamed)")
    parts = [f"- {row.prefix}: {label}"]
    if row.intensity_label:
        parts.append(f"[{row.intensity_label}]")
    if desc and name and desc != name:
        parts.append(f": {_inline_field(desc, options)}")
    return " ".join(parts)


# ── Appendices ─────────────────────────────────────────────────────────


def _render_offscreen_appendix(
    scenes: list[ExportScene],
    options: ExportOptions,
) -> str:
    parts: list[str] = [_setext_heading("OFF-SCREEN SCENES", 1)]
    parts.append("Non-POV scenes, presented in canvas order.")
    for scene in scenes:
        parts.append(_render_scene(scene, options))
    return "\n\n".join(parts)


def _render_entity_sheets(
    sheets: list[ExportEntitySheet],
    options: ExportOptions,
) -> str:
    parts: list[str] = [_setext_heading("ENTITY REFERENCE SHEETS", 1)]
    for sheet in sheets:
        parts.append(_render_entity_sheet(sheet, options))
    return "\n\n".join(parts)


def _render_knowledge_sheets(
    sheets: list[ExportKnowledgeSheet],
    options: ExportOptions,
) -> str:
    """Phase 1.25c — Knowledge appendix in plain text."""
    parts: list[str] = [_setext_heading("KNOWLEDGE", 1)]
    for sheet in sheets:
        parts.append(_render_knowledge_sheet(sheet, options))
    return "\n\n".join(parts)


def _render_knowledge_sheet(sheet: ExportKnowledgeSheet, options: ExportOptions) -> str:
    lines: list[str] = [_setext_heading(sheet.name, 2)]
    lines.append("")
    lines.append("Knowledge")
    if sheet.description and sheet.description.strip():
        lines.append("")
        lines.append(_block_field_text(sheet.description, options))
    if sheet.source_event_scene_title:
        lines.append("")
        lines.append(f"  First established at: {sheet.source_event_scene_title}")
    if sheet.notes and sheet.notes.strip():
        lines.append("")
        lines.append("Notes:")
        lines.append("")
        lines.append(_block_field_text(sheet.notes, options, indent="  "))
    if sheet.chain_history:
        lines.append("")
        lines.append("Chain history:")
        lines.append("")
        for entry in sheet.chain_history:
            scene_part = f" @ {entry.scene_title}" if entry.scene_title else ""
            lines.append(f"  {entry.kind}: {entry.text}{scene_part}")
    return "\n".join(lines)


def _render_entity_sheet(sheet: ExportEntitySheet, options: ExportOptions) -> str:
    lines: list[str] = [_setext_heading(sheet.name, 2)]
    lines.append("")
    lines.append(sheet.type.capitalize())

    # Phase 1.25c — aliases line under the type.
    alias_values = [a for a in (sheet.aliases or []) if a]
    if alias_values:
        lines.append("also: " + " / ".join(alias_values))

    if sheet.description.strip():
        lines.append("")
        lines.append(_block_field_text(sheet.description, options))

    # Attributes — skip file-type attributes entirely (no media in text).
    non_media_attrs = [
        a for a in sheet.attributes if a.attribute_type != "file"
    ]
    if non_media_attrs:
        lines.append("")
        for attr in non_media_attrs:
            lines.append(_render_attribute_line(attr, options))

    if sheet.relationships:
        lines.append("")
        lines.append("Relationships:")
        lines.append("")
        for rel in sheet.relationships:
            lines.append(_render_relationship_line(rel, options))

    # Phase 1.25c — Notes sub-section (entity.notes, free-form text).
    if options.include_entity_notes and sheet.notes and sheet.notes.strip():
        lines.append("")
        lines.append("Notes:")
        lines.append("")
        lines.append(_block_field_text(sheet.notes, options, indent="  "))

    return "\n".join(lines)


def _render_attribute_line(attr: ExportAttribute, options: ExportOptions) -> str:
    name = attr.name or "(unnamed)"
    if attr.attribute_type in ("text_list", "entity_list"):
        return f"  {name}: {attr.value or ''}"
    if attr.attribute_type == "perspective":
        # Phase 5.8b — first-person view on another object; body markdown
        # markers stripped when rendering is on.
        body = _inline_field(attr.description, options)
        target = attr.perspective_target or ""
        if target and body:
            inner = f"Perspective on {target}: {body}"
        elif target:
            inner = f"Perspective on {target}"
        else:
            inner = body or "-"
        return f"  {name}: {inner}"
    raw = attr.value or ""
    # Phase 5.8b — markdown in a text value: strip the markers (text format).
    # Block-structured values flow under the label; short values stay inline.
    if options.render_markdown_in_text_fields and raw.strip():
        if is_block_markdown(raw):
            return f"  {name}:\n{_block_field_text(raw, options, indent='    ')}"
        stripped = _tiptap_html_to_text(field_markdown_to_inline_html(raw)).strip()
        return f"  {name}: {stripped}"
    return f"  {name}: {raw or '-'}"


def _render_relationship_line(rel: ExportEntityRelationship, options: ExportOptions) -> str:
    label = rel.display_label or "(unnamed)"
    flag_bits: list[str] = []
    if rel.is_membership:
        flag_bits.append("membership")
    if rel.has_hierarchy:
        flag_bits.append("hierarchy")
    flag_str = f" [{' / '.join(flag_bits)}]" if flag_bits else ""
    bits: list[str] = []
    description = (rel.description or "").strip()
    if description:
        bits.append(_inline_field(description, options))
    role = (rel.own_role or "").strip()
    if role:
        bits.append(f"role: {role}")
    perception = (rel.own_perception or "").strip()
    if perception:
        bits.append(_inline_field(perception, options))
    if bits:
        return f"  - {label}{flag_str} - " + "; ".join(bits)
    return f"  - {label}{flag_str}"


# ── Paragraph wrapping ─────────────────────────────────────────────────


def _block_field_text(text: str, options: ExportOptions, indent: str = "") -> str:
    """Phase 5.8b — render a free-form block field (description / notes /
    scene description) to plain text. When `render_markdown_in_text_fields`
    is on, the markdown is converted to HTML and stripped back to text (so
    the markers are gone but the content stays); otherwise each writer line
    is wrapped as a paragraph. Empty / blank input returns ""."""
    inner = (text or "").strip()
    if not inner:
        return ""
    if options.render_markdown_in_text_fields:
        body = _tiptap_html_to_text(field_markdown_to_html(inner)).strip("\n")
        if indent:
            body = "\n".join((indent + ln) if ln.strip() else ln for ln in body.splitlines())
        return body
    out = [
        _wrap_paragraph(line.strip(), initial_indent=indent, subsequent_indent=indent)
        for line in inner.splitlines()
        if line.strip()
    ]
    return "\n".join(out)


def _wrap_paragraph(
    text: str,
    initial_indent: str = "",
    subsequent_indent: str = "",
) -> str:
    """Wrap a single paragraph to `_PAGE_WIDTH`, preserving leading /
    continuation indentation. Collapses internal whitespace runs so
    prose typed with soft line breaks comes out clean."""
    if not text:
        return ""
    normalised = re.sub(r"\s+", " ", text).strip()
    if not normalised:
        return ""
    return textwrap.fill(
        normalised,
        width=_PAGE_WIDTH,
        initial_indent=initial_indent,
        subsequent_indent=subsequent_indent,
        break_long_words=False,
        break_on_hyphens=False,
    )


# ── TipTap HTML → plain text converter ────────────────────────────────


class _TipTapToText(HTMLParser):
    """Convert the TipTap StarterKit tag subset to pure plain text.

    Strips all inline formatting (bold, italic, strike, inline code):
    the text content flows through, the tag markers do not. Preserves
    block structure (paragraphs, lists, blockquotes, code blocks,
    headings, horizontal rules) as distinct blocks joined by blank
    lines.

    Silently drops: `<img>`, `<video>`, `<audio>`, `<picture>`,
    `<source>`, `<figure>`, `<figcaption>` and their children — plain
    text has no way to express media, and the no-media policy applies
    to every text-based renderer in this package.

    Links render as their visible text only; the URL is dropped. Plain
    text can't be clicked, and surfacing URLs inline clutters prose.
    """

    _MEDIA_VOID = {"img", "source"}
    _MEDIA_CONTAINER = {"video", "audio", "picture", "figure", "figcaption"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[str] = []  # finished block chunks
        self._current: list[str] = []  # in-progress block text
        self._current_initial_indent: str = ""
        self._current_subsequent_indent: str = ""
        self._current_is_literal: bool = False  # bypass wrapping (pre / code block)
        self._list_stack: list[dict] = []
        self._skip_depth = 0
        self._in_pre = False
        self._in_blockquote_depth = 0

    # ── Block bookkeeping ──────────────────────────────────────────

    def _start_new_block(
        self,
        initial_indent: str = "",
        subsequent_indent: str = "",
        literal: bool = False,
    ) -> None:
        self._finish_block()
        self._current_initial_indent = initial_indent
        self._current_subsequent_indent = subsequent_indent
        self._current_is_literal = literal

    def _finish_block(self) -> None:
        raw = "".join(self._current).strip()
        if not raw:
            self._current = []
            return

        if self._current_is_literal:
            # Code blocks etc. — keep content verbatim, just indent it.
            indent = self._current_subsequent_indent or "    "
            chunk = "\n".join(indent + line for line in raw.split("\n"))
        else:
            chunk = _wrap_paragraph(
                raw,
                initial_indent=self._current_initial_indent,
                subsequent_indent=self._current_subsequent_indent,
            )

        if self._in_blockquote_depth > 0:
            chunk = _prefix_blockquote(chunk, self._in_blockquote_depth)

        self.blocks.append(chunk)
        self._current = []
        self._current_initial_indent = ""
        self._current_subsequent_indent = ""
        self._current_is_literal = False

    def _emit(self, text: str) -> None:
        if self._skip_depth > 0:
            return
        self._current.append(text)

    # ── Tag dispatch ───────────────────────────────────────────────

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
            self._start_new_block()
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            # Scene-body headings: render as ALL-CAPS paragraphs. No
            # setext underlines inside scene bodies — that would
            # collide visually with the scene's own setext heading.
            self._start_new_block()
        elif tag in ("strong", "b", "em", "i", "s", "del", "strike"):
            pass  # strip formatting markers
        elif tag == "code":
            if not self._in_pre:
                pass  # inline code: strip the tag, keep the text
        elif tag == "pre":
            self._start_new_block(subsequent_indent="    ", literal=True)
            self._in_pre = True
        elif tag == "blockquote":
            self._finish_block()
            self._in_blockquote_depth += 1
        elif tag == "ul":
            if not self._list_stack:
                self._start_new_block()
            else:
                if self._current and not "".join(self._current).endswith("\n"):
                    self._current.append("\n")
            self._list_stack.append({"type": "ul", "index": 0})
        elif tag == "ol":
            if not self._list_stack:
                self._start_new_block()
            else:
                if self._current and not "".join(self._current).endswith("\n"):
                    self._current.append("\n")
            self._list_stack.append({"type": "ol", "index": 0})
        elif tag == "li":
            depth = max(0, len(self._list_stack) - 1)
            indent = "  " * depth
            top = self._list_stack[-1] if self._list_stack else None
            if top and top["type"] == "ol":
                top["index"] += 1
                marker = f"{top['index']}. "
            else:
                marker = "- "
            if self._current and not "".join(self._current).endswith("\n"):
                self._current.append("\n")
            self._current.append(indent + marker)
            # List items emit their own literal block — no secondary
            # wrap, because the indent markers matter positionally.
            self._current_is_literal = True
        elif tag == "a":
            pass  # drop href, keep text
        elif tag == "br":
            self._emit("\n")
        elif tag == "hr":
            self._finish_block()
            self.blocks.append("-" * _PAGE_WIDTH)
        # Unknown tags: transparent.

    def handle_endtag(self, tag: str) -> None:  # type: ignore[override]
        if self._skip_depth > 0:
            if tag in self._MEDIA_CONTAINER:
                self._skip_depth -= 1
            elif tag not in self._MEDIA_VOID and tag not in ("br", "hr"):
                self._skip_depth -= 1
            return

        if tag == "p":
            self._finish_block()
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            # Uppercase the completed heading body before finishing.
            heading_text = "".join(self._current).strip()
            self._current = [heading_text.upper()] if heading_text else []
            self._finish_block()
        elif tag in ("strong", "b", "em", "i", "s", "del", "strike"):
            pass
        elif tag == "code":
            pass
        elif tag == "pre":
            self._in_pre = False
            self._finish_block()
        elif tag == "blockquote":
            self._finish_block()
            if self._in_blockquote_depth > 0:
                self._in_blockquote_depth -= 1
        elif tag in ("ul", "ol"):
            if self._list_stack:
                self._list_stack.pop()
            if not self._list_stack:
                self._finish_block()
        elif tag == "li":
            pass
        elif tag == "a":
            pass

    def handle_data(self, data: str) -> None:  # type: ignore[override]
        if self._skip_depth > 0:
            return
        if self._in_pre:
            self._emit(data)
            return
        collapsed = re.sub(r"\s+", " ", data)
        self._emit(collapsed)

    def convert(self, html_text: str) -> str:
        self.feed(html_text or "")
        self._finish_block()
        return "\n\n".join(b for b in self.blocks if b)


def _prefix_blockquote(text: str, depth: int) -> str:
    prefix = "> " * depth
    return "\n".join(prefix + line for line in text.split("\n"))


def _tiptap_html_to_text(html_text: str) -> str:
    """Top-level HTML-to-text entry point. One-shot: creates a fresh
    parser, feeds the HTML, returns the joined plain-text blocks."""
    converter = _TipTapToText()
    return converter.convert(html_text)


# ── Registry binding ───────────────────────────────────────────────────


def render(model: ExportModel, options: Optional[ExportOptions] = None) -> bytes:
    return render_txt(model, options).encode("utf-8")


SPEC = RendererSpec(
    format_id="txt",
    label="Plain text",
    extension="txt",
    mime_type="text/plain; charset=utf-8",
    render=render,
    capabilities=frozenset(),
    # Plain text has no capabilities. No pagination, no colours,
    # no embedded media, no anchor links — it's the lowest-common-
    # denominator format, and that's the whole point.
)
register(SPEC)
