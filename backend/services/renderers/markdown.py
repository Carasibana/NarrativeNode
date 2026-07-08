"""
Markdown renderer — Phase 1.12a Track 3.

Part of the modular renderer package: each format is its own file
under `backend/services/renderers/`, self-registering a `RendererSpec`
via the registry at the bottom of this module. See
`docs/export-renderer-guide.md` for the full pattern.

Consumes an `ExportModel` produced by `build_export_model` and emits a
single self-contained Markdown document. No external template files,
no Jinja2 / markdownify / html2text dependencies — plain Python
string helpers plus a small `html.parser.HTMLParser` subclass that
converts TipTap's HTML subset into native markdown formatting.

Key design decisions (per user direction during v0.1.12.6 planning):

  - **Pure markdown only.** No embedded HTML tags anywhere in the
    output. Any HTML construct TipTap can produce that markdown cannot
    express natively is silently dropped rather than leaked through as
    raw `<tag>` text.
  - **No media whatsoever.** Images, audio, and video are omitted
    completely — not a placeholder, not an alt-text fallback, nothing.
    The `include_media_attributes` family of toggles is ignored by
    this renderer. File-type entity attributes are dropped from entity
    reference sheets. `<img>` / `<video>` / `<audio>` / `<picture>` /
    `<figure>` tags inside scene bodies are dropped with their
    contents.
  - **Entity links become plain text.** Markdown doesn't have a cheap
    way to do hover popovers like the HTML renderer's entity-ref
    popovers, and linking each mention to a `#entity-id` anchor works
    in some markdown processors but not others. We sidestep the
    inconsistency by rendering entity names as plain bold text. Entity
    reference sheets still exist as their own section; readers can
    jump to them via the document's outline / table of contents in
    their markdown viewer of choice.

Document structure, in order:

    # Story Title

    by Jane Doe

    **Genre:** Noir
    **Tense:** Past
    **POV style:** 3rd Person Limited
    ...

    ---

    ## Act 1

    ### Chapter 1: The Beginning

    *Transition text into scene 1...*

    #### Scene Title

    *Scene description*

    > **POV:** Alice

    - **Characters:** Alice, Bob
    - **Location:** The Docks

    Scene body converted from TipTap HTML into native markdown.

    **Changes recorded at this scene:**

    - **Alice** (character)
      - _attribute_ — Age → 29
    - **Bob** (character)
      - _metadata_ — Renamed to Robert

    ## Off-screen scenes

    > Non-POV scenes, presented in canvas order.

    #### Scene title...

    ---

    ## Entity reference sheets

    ### Alice

    *Character*

    Alice's description text.

    - **Age:** 28
    - **Species:** Human

    **Relationships:**

    - **Bob** (character) — Alice's perspective of Bob
"""

from __future__ import annotations

import re
from datetime import datetime
from html.parser import HTMLParser
from typing import Optional

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


def render_markdown(model: ExportModel, options: Optional[ExportOptions] = None) -> str:
    """Return a complete Markdown document as a string.

    This is the human-readable internal entry point. The registry-facing
    wrapper `render` below calls this and encodes UTF-8.
    """
    options = options or ExportOptions()
    parts: list[str] = []

    parts.append(_render_story_header(model, options))

    for section in model.sections:
        rendered = _render_section(section, options, heading_level=2)
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
    """H1 title + optional byline + optional metadata block.

    Metadata fields render one-per-line using markdown hard breaks
    (trailing two spaces + newline) so each field appears on its own
    visual line without introducing extra vertical space between them.
    An older revision (v0.1.12.6) also emitted a YAML frontmatter
    block at the top, but that duplicated the same data the metadata
    block already shows — removed in v0.1.12.8."""
    lines: list[str] = [f"# {_escape_md_inline(model.title)}"]

    if options.include_author and model.author:
        lines.append("")
        lines.append(f"by {_escape_md_inline(model.author)}")

    meta_lines: list[str] = []
    if options.include_genre and model.genre:
        meta_lines.append(f"**Genre:** {_escape_md_inline(model.genre)}")
    if options.include_tags and model.tags:
        meta_lines.append(f"**Tags:** {_escape_md_inline(', '.join(model.tags))}")
    if options.include_tense and model.tense:
        meta_lines.append(f"**Tense:** {_escape_md_inline(model.tense)}")
    if options.include_pov_type and model.pov_type:
        meta_lines.append(f"**POV style:** {_escape_md_inline(model.pov_type)}")
    if options.include_language and model.language:
        meta_lines.append(f"**Language:** {_escape_md_inline(model.language)}")
    if options.include_default_pov_character and model.default_pov_character_name:
        meta_lines.append(f"**Default POV:** {_escape_md_inline(model.default_pov_character_name)}")
    if options.include_generated_timestamp and model.generated_at:
        meta_lines.append(f"**Generated:** {model.generated_at.strftime('%Y-%m-%d')}")

    if meta_lines:
        lines.append("")
        # Trailing two spaces force a markdown hard line break — renders
        # as separate lines in any standards-compliant processor. Last
        # line has no trailing break (nothing to break before).
        lines.append("  \n".join(meta_lines))

    # Phase 5.8b — story description blurb, below the metadata block.
    if options.include_story_description and model.description and model.description.strip():
        lines.append("")
        lines.append(_escape_md_inline(model.description.strip()))

    lines.append("")
    lines.append("---")
    return "\n".join(lines)


# ── Sections ───────────────────────────────────────────────────────────


def _render_section(
    section: ExportSection,
    options: ExportOptions,
    heading_level: int,
) -> str:
    """Recursively render a section (act / chapter / unchaptered)."""
    parts: list[str] = []

    heading_level = max(2, min(6, heading_level))

    if section.kind == "act":
        if options.include_act_headings:
            parts.append(_heading(heading_level, section.label))
        for child in section.children:
            rendered = _render_section(
                child,
                options,
                heading_level=heading_level + 1,
            )
            if rendered:
                parts.append(rendered)
        return "\n\n".join(parts)

    if section.kind == "chapter":
        if options.include_chapter_headings:
            parts.append(_heading(heading_level, section.label))
        scene_blocks = [
            _render_scene(scene, options, heading_level=heading_level + 1)
            for scene in section.scenes
        ]
        scene_blocks = [b for b in scene_blocks if b]
        # Phase 5.8b — dinkus "* * *" between scenes (NOT before the first
        # nor after the last) when the scene-separator option is on; a plain
        # blank line otherwise.
        scene_sep = "\n\n* * *\n\n" if options.include_scene_separator else "\n\n"
        parts.append(scene_sep.join(scene_blocks))
        return "\n\n".join(p for p in parts if p)

    # "unchaptered"
    if section.scenes:
        if options.include_unchaptered_heading:
            parts.append(_heading(heading_level, section.label))
        scene_blocks = [
            _render_scene(scene, options, heading_level=heading_level + 1)
            for scene in section.scenes
        ]
        scene_blocks = [b for b in scene_blocks if b]
        scene_sep = "\n\n* * *\n\n" if options.include_scene_separator else "\n\n"
        parts.append(scene_sep.join(scene_blocks))
    return "\n\n".join(p for p in parts if p)


# ── Scene ──────────────────────────────────────────────────────────────


def _render_scene(
    scene: ExportScene,
    options: ExportOptions,
    heading_level: int,
) -> str:
    parts: list[str] = []
    heading_level = max(2, min(6, heading_level))

    if options.include_transition_text and scene.transition_in_text.strip():
        parts.append(f"*{_escape_md_inline(scene.transition_in_text.strip())}*")

    if options.include_scene_title and scene.title:
        parts.append(_heading(heading_level, scene.title))

    if options.include_scene_description and scene.description.strip():
        if options.render_markdown_in_text_fields:
            parts.append(scene.description.strip())
        else:
            parts.append(f"*{_escape_md_inline(scene.description.strip())}*")

    # Phase 1.25c — scene-time text-only (icons skipped in markdown).
    if options.include_scene_time and scene.scene_time_text:
        parts.append(f"*{_escape_md_inline(scene.scene_time_text)}*")

    if options.include_scene_cm_block and scene.cm_groups:
        cm_md = _render_scene_cm_block(scene.cm_groups, options)
        if cm_md:
            parts.append(cm_md)

    if options.include_scene_pov_line and scene.pov_entity_name:
        parts.append(f"> **POV:** {_escape_md_inline(scene.pov_entity_name)}")

    if options.include_entity_context_line and scene.entity_context_groups:
        context_lines = _render_entity_context(scene.entity_context_groups)
        if context_lines:
            parts.append(context_lines)

    if options.include_scene_body and scene.main_content_html.strip():
        body_md = _tiptap_html_to_markdown(scene.main_content_html)
        if body_md:
            parts.append(body_md)

    if options.include_scene_changes_block and scene.changes:
        changes_md = _render_scene_changes(scene.changes, options)
        if changes_md:
            parts.append(changes_md)

    return "\n\n".join(parts)


def _inline_field(text: str, options: ExportOptions) -> str:
    """Phase 5.8b — inline-rendered free-form body field. Passes the writer's
    markdown through unchanged when enabled; escapes it otherwise. Empty → ""."""
    inner = (text or "").strip()
    if not inner:
        return ""
    if options.render_markdown_in_text_fields:
        return inner
    return _escape_md_inline(inner)


def _render_scene_cm_block(groups: list[ExportSceneCMGroup], options: ExportOptions) -> str:
    """Phase 1.22i — render the per-scene Circumstances & Motivators
    block. Top-level bullet per group (Scene + one per entity); each
    group's rows render as nested bullets. Each row is:

        - <Prefix>: <name | "(unnamed)"> [<intensity>] — <description>

    Description is omitted when empty OR when it's identical to the
    name (avoids "Storm — Storm" stutter for name-only entries)."""
    if not groups:
        return ""
    lines: list[str] = ["**Circumstances & Motivators:**", ""]
    for group in groups:
        if not group.rows:
            continue
        if group.kind == "scene":
            header = f"- **{_escape_md_inline(group.label)}**"
        else:
            type_part = f" ({_escape_md_inline(group.entity_type)})" if group.entity_type else ""
            header = f"- **{_escape_md_inline(group.label)}**{type_part}"
        lines.append(header)
        for row in group.rows:
            lines.append("  " + _render_cm_row(row, options))
    return "\n".join(lines)


def _render_cm_row(row: ExportSceneCMRow, options: ExportOptions) -> str:
    """Format one CM row as a markdown bullet sub-item."""
    name = (row.name or "").strip()
    desc = (row.description or "").strip()
    label = _escape_md_inline(name) if name else (_inline_field(desc, options) if desc else "(unnamed)")
    parts = [f"- **{_escape_md_inline(row.prefix)}:** {label}"]
    if row.intensity_label:
        parts.append(f"[{_escape_md_inline(row.intensity_label)}]")
    # Description on the same line, only when there's a distinct name.
    if desc and name and desc != name:
        parts.append(f": {_inline_field(desc, options)}")
    return " ".join(parts)


def _render_entity_context(groups: list[ExportSceneEntityGroup]) -> str:
    """Render the multi-row scene entity context as a bullet list —
    one line per entity bucket with comma-separated entity names in
    bold."""
    lines: list[str] = []
    for group in groups:
        if not group.entries:
            continue
        names = ", ".join(
            f"**{_escape_md_inline(entry.name)}**" for entry in group.entries
        )
        lines.append(f"- **{_escape_md_inline(group.label)}:** {names}")
    return "\n".join(lines)


def _render_scene_changes(
    changes: list[ExportSceneEntityChange],
    options: ExportOptions,
) -> str:
    """Render the per-scene changes block. Nested markdown list: one
    top-level bullet per entity, then sub-bullets in plain language.
    Filtered by the granular toggles (metadata / attribute /
    relationship). The category labels (`_metadata_` / `_attribute_`
    / `_relationship_`) are deliberately NOT shown here — they're
    internal taxonomy, not reading vocabulary; the per-row text
    already reads as a self-explanatory sentence.

    Markdown-specific filters:
      - Colour-change details are dropped entirely (the hex is
        meaningless to a markdown reader and adds noise).
      - The `→` arrow used in the model layer is rewritten to plain
        " changed to " so a reader sees `Description changed to
        "..."` rather than `Description → "..."`.
    """
    allowed_categories: set[str] = set()
    if options.include_metadata_changes:
        allowed_categories.add("metadata")
    if options.include_attribute_changes:
        allowed_categories.add("attribute")
    if options.include_relationship_changes:
        allowed_categories.add("relationship")

    if not allowed_categories:
        return ""

    filtered_entities: list[tuple[ExportSceneEntityChange, list[ExportChangeDetail]]] = []
    for change in changes:
        details = [
            d for d in change.details
            if d.category in allowed_categories and not _is_colour_detail(d)
        ]
        if details:
            filtered_entities.append((change, details))

    if not filtered_entities:
        return ""

    lines: list[str] = ["**Changes recorded at this scene:**", ""]
    for change, details in filtered_entities:
        lines.append(
            f"- **{_escape_md_inline(change.entity_name)}** "
            f"({_escape_md_inline(change.entity_type)})"
        )
        for detail in details:
            text = _plainify_change_text(detail.text)
            lines.append(f"  - {_escape_md_inline(text)}")
    return "\n".join(lines)


def _is_colour_detail(detail: ExportChangeDetail) -> bool:
    """Markdown-specific: colour metadata changes are noise (a hex
    string the reader can't act on) so this renderer drops them
    entirely. The model layer still emits them; other renderers may
    keep them — markdown alone filters here."""
    return detail.category == "metadata" and detail.text.startswith("Colour ")


def _plainify_change_text(text: str) -> str:
    """Rewrite the model-layer's compact `→` arrows into plain reading
    language. The model uses `→` in two places:
      - `Description → "..."`  → `Description changed to "..."`
      - `"Age" → "29"`         → `"Age" changed to "29"`
    Either way the substitution reads naturally."""
    return text.replace(" → ", " changed to ")


# ── Appendices ─────────────────────────────────────────────────────────


def _render_offscreen_appendix(
    scenes: list[ExportScene],
    options: ExportOptions,
) -> str:
    """Off-screen appendix: H2 heading + one H4 scene per non-POV scene."""
    parts: list[str] = [_heading(2, "Off-screen scenes")]
    parts.append("> Non-POV scenes, presented in canvas order.")
    for scene in scenes:
        parts.append(_render_scene(scene, options, heading_level=4))
    return "\n\n".join(parts)


def _render_entity_sheets(
    sheets: list[ExportEntitySheet],
    options: ExportOptions,
) -> str:
    """Entity reference sheets appendix — one H3 entity per entry."""
    parts: list[str] = [_heading(2, "Entity reference sheets")]
    for sheet in sheets:
        parts.append(_render_entity_sheet(sheet, options))
    return "\n\n".join(parts)


def _render_knowledge_sheets(
    sheets: list[ExportKnowledgeSheet],
    options: ExportOptions,
) -> str:
    """Phase 1.25c — Knowledge appendix. Markdown form parallels the
    entity-sheet output: one H3 per Knowledge with description + source
    event + notes + optional chain history below."""
    parts: list[str] = [_heading(2, "Knowledge")]
    for sheet in sheets:
        parts.append(_render_knowledge_sheet(sheet, options))
    return "\n\n".join(parts)


def _block_field_md(text: str, options: ExportOptions) -> str:
    """Phase 5.8b — a free-form block field for the markdown export. When
    `render_markdown_in_text_fields` is on, the writer's markdown passes
    through unchanged (it is already markdown); otherwise each line is
    escaped so literal text with stray metacharacters stays literal.
    Empty / blank input returns ""."""
    inner = (text or "").strip()
    if not inner:
        return ""
    if options.render_markdown_in_text_fields:
        return inner
    return "\n".join(_escape_md_inline(ln) for ln in inner.splitlines() if ln.strip())


def _render_knowledge_sheet(sheet: ExportKnowledgeSheet, options: ExportOptions) -> str:
    lines: list[str] = [_heading(3, sheet.name)]
    lines.append("")
    lines.append("*Knowledge*")
    if sheet.description and sheet.description.strip():
        lines.append("")
        lines.append(_block_field_md(sheet.description, options))
    if sheet.source_event_scene_title:
        lines.append("")
        lines.append(f"*First established at: {_escape_md_inline(sheet.source_event_scene_title)}*")
    if sheet.notes and sheet.notes.strip():
        lines.append("")
        lines.append("**Notes:**")
        lines.append("")
        lines.append(_block_field_md(sheet.notes, options))
    if sheet.chain_history:
        lines.append("")
        lines.append("**Chain history:**")
        lines.append("")
        for entry in sheet.chain_history:
            scene_part = (
                f" — _{_escape_md_inline(entry.scene_title)}_"
                if entry.scene_title else ""
            )
            lines.append(
                f"- *{_escape_md_inline(entry.kind)}*: "
                f"{_escape_md_inline(entry.text)}{scene_part}"
            )
    return "\n".join(lines)


def _render_entity_sheet(sheet: ExportEntitySheet, options: ExportOptions) -> str:
    lines: list[str] = [_heading(3, sheet.name)]
    lines.append("")
    lines.append(f"*{_escape_md_inline(sheet.type.capitalize())}*")

    # Phase 1.25c — aliases line under the type.
    alias_values = [a for a in (sheet.aliases or []) if a]
    if alias_values:
        lines.append("")
        joined = " / ".join(_escape_md_inline(a) for a in alias_values)
        lines.append(f"*also: {joined}*")

    if sheet.description.strip():
        lines.append("")
        lines.append(_block_field_md(sheet.description, options))

    # Attributes — skip file-type attributes entirely (no media in markdown).
    non_media_attrs = [
        a for a in sheet.attributes if a.attribute_type != "file"
    ]
    if non_media_attrs:
        lines.append("")
        for attr in non_media_attrs:
            lines.append(_render_attribute_line(attr, options))

    # Relationships.
    if sheet.relationships:
        lines.append("")
        lines.append("**Relationships:**")
        lines.append("")
        for rel in sheet.relationships:
            lines.append(_render_relationship_line(rel, options))

    # Phase 1.25c — Notes sub-section (entity.notes, free-form text).
    if options.include_entity_notes and sheet.notes and sheet.notes.strip():
        lines.append("")
        lines.append("**Notes:**")
        lines.append("")
        lines.append(_block_field_md(sheet.notes, options))

    return "\n".join(lines)


def _render_attribute_line(attr: ExportAttribute, options: ExportOptions) -> str:
    """Render one non-file entity attribute as a markdown bullet."""
    name = _escape_md_inline(attr.name or "(unnamed)")
    if attr.attribute_type in ("text_list", "entity_list"):
        # Value is a JSON-encoded list of strings. Surface the raw JSON
        # — a future pass can parse and re-render as a nested sublist.
        return f"- **{name}:** {_escape_md_inline(attr.value or '')}"
    if attr.attribute_type == "perspective":
        # Phase 5.8b — first-person view on another object; body passes
        # markdown through when enabled.
        body = _inline_field(attr.description, options)
        target = _escape_md_inline(attr.perspective_target or "")
        if target and body:
            inner = f"Perspective on {target}: {body}"
        elif target:
            inner = f"Perspective on {target}"
        else:
            inner = body
        return f"- **{name}:** {inner}"
    raw = attr.value or ""
    # Phase 5.8b — pass the writer's markdown through unchanged when enabled
    # (it is already markdown); otherwise escape so literal text stays literal.
    if options.render_markdown_in_text_fields and raw.strip():
        return f"- **{name}:** {raw}"
    return f"- **{name}:** {_escape_md_inline(raw or '—')}"


def _render_relationship_line(rel: ExportEntityRelationship, options: ExportOptions) -> str:
    label = _escape_md_inline(rel.display_label or "(unnamed)")
    flag_bits: list[str] = []
    if rel.is_membership:
        flag_bits.append("membership")
    if rel.has_hierarchy:
        flag_bits.append("hierarchy")
    flag_str = f" *[{' / '.join(flag_bits)}]*" if flag_bits else ""
    bits: list[str] = []
    description = (rel.description or "").strip()
    if description:
        bits.append(_inline_field(description, options))
    role = (rel.own_role or "").strip()
    if role:
        bits.append(f"role: {_escape_md_inline(role)}")
    perception = (rel.own_perception or "").strip()
    if perception:
        bits.append(_inline_field(perception, options))
    if bits:
        return f"- **{label}**{flag_str} — " + "; ".join(bits)
    return f"- **{label}**{flag_str}"


# ── Small helpers ──────────────────────────────────────────────────────


def _heading(level: int, text: str) -> str:
    level = max(1, min(6, level))
    return "#" * level + " " + _escape_md_inline(text or "")


# Minimum safe set for inline-context escaping. Omits characters that
# only have markdown semantics at line start (`#`, `-`, `+`, `|`), or
# only in specific adjacent contexts (`!` before `[`, `(` `)` after
# `]`), or that are only convention in some flavours (`_`, `{` `}`).
# Escaping those everywhere leads to ugly artefacts in perfectly safe
# text (entity names containing dashes, scene titles with punctuation).
_MD_INLINE_ESCAPE_RE = re.compile(r"([\\`*\[\]~])")


def _escape_md_inline(text: str) -> str:
    """Escape the minimum set of markdown special characters in a
    plain-text inline run. Used on entity names, scene titles,
    descriptions — anything that came in as a plain string, NOT on
    scene body content that's already been converted by the HTML
    parser below."""
    if not text:
        return ""
    return _MD_INLINE_ESCAPE_RE.sub(r"\\\1", str(text))


# ── TipTap HTML → Markdown converter ───────────────────────────────────


class _TipTapToMarkdown(HTMLParser):
    """Convert the TipTap StarterKit tag subset to native markdown.

    Handles: `<p>`, `<h1>`..`<h6>`, `<strong>` / `<b>`, `<em>` / `<i>`,
    `<s>` / `<del>`, `<code>` (inline + inside `<pre>`), `<pre>`,
    `<blockquote>`, `<ul>` / `<ol>` / `<li>` (nested), `<a href>`,
    `<br>`, `<hr>`.

    Silently drops: `<img>`, `<video>`, `<audio>`, `<picture>`,
    `<source>`, `<figure>`, `<figcaption>` (with their children).
    Unknown tags are transparent — their text content still flows
    through but the tag markers are ignored.

    Headings inside scene bodies are bumped down by a fixed offset so
    they don't collide with the document's own scene heading. The
    offset is applied inside `handle_starttag` for the heading tags.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[str] = []
        self._current: list[str] = []
        self._list_stack: list[dict] = []
        self._skip_depth = 0  # positive = dropping the current subtree
        self._in_pre = False
        self._in_blockquote_depth = 0
        self._link_hrefs: list[str] = []

    # ── Block bookkeeping ──────────────────────────────────────────

    def _finish_block(self) -> None:
        chunk = "".join(self._current).rstrip()
        if chunk:
            if self._in_blockquote_depth > 0:
                chunk = _prefix_blockquote(chunk, self._in_blockquote_depth)
            self.blocks.append(chunk)
        self._current = []

    def _emit(self, text: str) -> None:
        if self._skip_depth > 0:
            return
        self._current.append(text)

    # ── Tag dispatch ───────────────────────────────────────────────

    _MEDIA_VOID = {"img", "source"}
    _MEDIA_CONTAINER = {"video", "audio", "picture", "figure", "figcaption"}

    def handle_starttag(self, tag: str, attrs: list) -> None:  # type: ignore[override]
        if self._skip_depth > 0:
            # Nested inside a dropped subtree — deepen the counter so
            # the matching endtag brings us back out correctly.
            if tag not in self._MEDIA_VOID and tag not in ("br", "hr"):
                self._skip_depth += 1
            return

        if tag in self._MEDIA_VOID:
            return
        if tag in self._MEDIA_CONTAINER:
            self._skip_depth = 1
            return

        if tag == "p":
            self._finish_block()
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._finish_block()
            # Bump TipTap's heading levels down so body headings don't
            # outrank the scene's own heading. TipTap's H1 → markdown H5,
            # TipTap's H2 → markdown H6, etc. Capped at H6 (the markdown
            # max), so H3-H6 all collapse to H6.
            level = min(6, int(tag[1]) + 4)
            self._emit("#" * level + " ")
        elif tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i"):
            self._emit("*")
        elif tag in ("s", "del", "strike"):
            self._emit("~~")
        elif tag == "code":
            if not self._in_pre:
                self._emit("`")
        elif tag == "pre":
            self._finish_block()
            self._in_pre = True
            self._emit("```\n")
        elif tag == "blockquote":
            self._finish_block()
            self._in_blockquote_depth += 1
        elif tag == "ul":
            # Top-level list starts a new block; nested list continues
            # the current block so items stay tight (no blank line
            # between siblings).
            if self._list_stack:
                if self._current and not "".join(self._current).endswith("\n"):
                    self._current.append("\n")
            else:
                self._finish_block()
            self._list_stack.append({"type": "ul", "index": 0})
        elif tag == "ol":
            if self._list_stack:
                if self._current and not "".join(self._current).endswith("\n"):
                    self._current.append("\n")
            else:
                self._finish_block()
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
            # If the current block already has content, start this
            # item on its own line (so siblings stack without blank
            # lines between them).
            if self._current and not "".join(self._current).endswith("\n"):
                self._current.append("\n")
            self._current.append(indent + marker)
        elif tag == "a":
            href = ""
            for key, value in attrs:
                if key == "href":
                    href = value or ""
                    break
            self._link_hrefs.append(href)
            self._emit("[")
        elif tag == "br":
            self._emit("  \n")
        elif tag == "hr":
            self._finish_block()
            self.blocks.append("---")
        # Unknown tags: silently pass through (their text content still flows).

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
            self._finish_block()
        elif tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i"):
            self._emit("*")
        elif tag in ("s", "del", "strike"):
            self._emit("~~")
        elif tag == "code":
            if not self._in_pre:
                self._emit("`")
        elif tag == "pre":
            self._emit("\n```")
            self._in_pre = False
            self._finish_block()
        elif tag == "blockquote":
            self._finish_block()
            if self._in_blockquote_depth > 0:
                self._in_blockquote_depth -= 1
        elif tag in ("ul", "ol"):
            if self._list_stack:
                self._list_stack.pop()
            # Only finish the block once we've exited ALL nested lists —
            # inner list closures leave the block open so the parent
            # list can continue on the next line.
            if not self._list_stack:
                self._finish_block()
        elif tag == "li":
            pass  # Text flows into the current block; new <li> adds its own newline.
        elif tag == "a":
            href = self._link_hrefs.pop() if self._link_hrefs else ""
            if href:
                self._emit(f"]({href})")
            else:
                self._emit("]")

    def handle_data(self, data: str) -> None:  # type: ignore[override]
        if self._skip_depth > 0:
            return
        if self._in_pre:
            self._emit(data)
            return
        # Collapse whitespace runs but keep inter-word spaces.
        collapsed = re.sub(r"\s+", " ", data)
        self._emit(collapsed)

    # ── Public API ─────────────────────────────────────────────────

    def convert(self, html_text: str) -> str:
        self.feed(html_text or "")
        self._finish_block()
        return "\n\n".join(b for b in self.blocks if b)


def _prefix_blockquote(text: str, depth: int) -> str:
    """Apply `> ` (or `> > ` for nested depth) at the start of every
    line in a rendered block so the block flows through as a markdown
    blockquote."""
    prefix = "> " * depth
    return "\n".join(prefix + line for line in text.split("\n"))


def _tiptap_html_to_markdown(html_text: str) -> str:
    """Top-level converter entry point. One-shot: creates a fresh
    parser, feeds the HTML, returns the joined markdown blocks."""
    converter = _TipTapToMarkdown()
    return converter.convert(html_text)


# ── Registry binding ───────────────────────────────────────────────────


def render(model: ExportModel, options: Optional[ExportOptions] = None) -> bytes:
    return render_markdown(model, options).encode("utf-8")


SPEC = RendererSpec(
    format_id="markdown",
    label="Markdown",
    extension="md",
    mime_type="text/markdown; charset=utf-8",
    render=render,
    capabilities=frozenset(),
    # Markdown deliberately declares no capabilities in v0.1.12.12:
    #   - No `embedded_assets` / `embedded_media`: the no-media-in-markdown
    #     policy (per user direction in v0.1.12.6) strips all media
    #     tags and file-type attributes unconditionally.
    #   - No `entity_links`: markdown anchor link support is
    #     processor-dependent (Obsidian yes, plain markdown no), so
    #     we don't claim it.
    #   - No `entity_colours`: markdown has no inline colour syntax.
    #   - No `pagination`: markdown is not paginated.
)
register(SPEC)
