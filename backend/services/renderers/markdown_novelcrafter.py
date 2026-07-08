"""
Markdown (NovelCrafter) variant renderer — Phase 1.12a Track 10a.

Part of the modular renderer package: each format (including variants)
is its own file under `backend/services/renderers/`, self-registering
a `RendererSpec` via the registry at the bottom of this module. See
`docs/export-renderer-guide.md` for the full pattern and the Variants
section for the variant-specific rules this renderer follows.

This renderer is a **variant** of the base `markdown` renderer — it
declares `variant_of="markdown"` on its SPEC so the frontend hides
it from the top-level Format picker and exposes it instead via a
"Layout" sub-picker beneath the Markdown format choice. From the
user's perspective: they pick "Markdown" → "NovelCrafter" and get a
`.zip` bundle tailored for NovelCrafter's import / Extract workflow.

The canonical specification for NovelCrafter's import and Extract
format rules lives at:

    .References/NovelCrafter file formatting for import to Novelcrafter/
    Export for NovelCrafter importing.md

Read that file first if you're making changes here — it's the distilled
rulebook for what NovelCrafter's importer accepts and what its Extract
feature parses. The short version:

  - **Manuscript file** (`.md`): acts as `#`, chapters as `##`, scenes
    separated by `***`. If no acts, use `#` for chapters. NOTHING else
    — no scene titles, no POV lines, no entity context, no changes,
    no appendices, no images, no TOC, no front/back matter.
  - **Entity codex source file** (`.md`): a numbered list of entries
    in the format `1. **Name (aliases) [type]:** description`, grouped
    into sections per entity bucket (Characters / Locations / Items /
    Factions / Customs). User pastes this into a NovelCrafter Snippet
    and runs Extract to populate codex entries. The Extract feature is
    **not** a file importer — it's an in-app button, so the exporter
    produces text the user manually pastes, not a direct import file.

## Output shape

`.zip` bundle (stored in `mime_type="application/zip"`, `extension="zip"`
on the SPEC) containing exactly two files:

  - `{sanitised_title}-manuscript.md` — clean manuscript
  - `{sanitised_title}-entities.md` — entity codex source

A single combined `.md` is NOT viable because NovelCrafter's manuscript
importer would ingest any `##`-level entity section headings as
additional garbage chapters (the importer is deliberately naive).
Two separate files keeps each workflow clean.

## Aliases workaround

Phase 1.15 will add a native `Entity.aliases: list[str]` field. Until
then, this renderer scans each entity's `attributes` for any attribute
whose name matches a list of alias synonyms (`aliases`, `nicknames`,
`aka`, `also known as`, `other names`, etc.) and uses the matched
attribute's value(s) as the parenthesised aliases in the NovelCrafter
entry format. See `_ALIAS_ATTRIBUTE_SYNONYMS` below.

**When Phase 1.15 ships:** update `_extract_aliases` to check
`entity.aliases` first and fall back to the synonym-attribute-matching
path only if the native field is empty. Cross-referenced from the
Phase 1.15 Aliases ToDo item so this isn't forgotten.

## Renderer independence

Self-contained per the renderer-independence rule. Does NOT
import from `renderers/markdown.py` or any other sibling renderer. The
TipTap HTML → plain markdown conversion is handled by an own
`_TipTapToPlainMarkdown` class — structurally similar to
`renderers/markdown.py`'s `_TipTapToMarkdown` but simpler (no headings,
no blockquotes, no code blocks, no lists, no horizontal rules — all
forbidden or unsupported inside a NovelCrafter-imported manuscript's
scene prose).
"""

from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from io import BytesIO
from typing import Optional
from zipfile import ZIP_DEFLATED, ZipFile

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


def render_markdown_novelcrafter(
    model: ExportModel,
    options: Optional[ExportOptions] = None,
) -> bytes:
    """Build the two-file NovelCrafter bundle and return the ZIP bytes.

    NovelCrafter's Markdown importer ingests EITHER prose OR scene
    summaries — not both at once. We mirror that constraint at the
    renderer boundary: if the writer's flags say both are on, prefer
    prose (the more common NC import case). If neither is on, default
    to prose. The manuscript ZIP filename ends `-Prose.md` or
    `-Summaries.md` so the writer can tell at a glance which mode the
    bundle was rendered in.
    """
    options = options or ExportOptions()
    mode = _resolve_nc_mode(options)
    effective_options = _options_for_mode(options, mode)

    manuscript_md = _render_manuscript(model, effective_options)
    entities_md = _render_entities(model)

    title_slug = _sanitise_filename(model.title or "story")
    mode_suffix = "Prose" if mode == "prose" else "Summaries"
    manuscript_filename = f"{title_slug}-manuscript-{mode_suffix}.md"
    entities_filename = f"{title_slug}-entities.md"

    buf = BytesIO()
    with ZipFile(buf, "w", ZIP_DEFLATED) as zf:
        zf.writestr(manuscript_filename, manuscript_md)
        zf.writestr(entities_filename, entities_md)
    return buf.getvalue()


def _resolve_nc_mode(options: ExportOptions) -> str:
    """Map the writer's two flags to NC's one-or-the-other constraint.
    Both-on collapses to prose; neither-on collapses to prose.
    Returns 'prose' or 'summaries'."""
    if options.include_scene_body:
        return "prose"
    if options.include_scene_description:
        return "summaries"
    return "prose"


def _options_for_mode(options: ExportOptions, mode: str) -> ExportOptions:
    """Return a derivative ExportOptions with the per-scene flags
    coerced to the resolved NC mode so downstream renderers see a
    consistent picture (always one of: body-only / description-only).
    Avoids mutating the writer's `options` instance."""
    from dataclasses import replace
    if mode == "summaries":
        return replace(options, include_scene_description=True, include_scene_body=False)
    return replace(options, include_scene_description=False, include_scene_body=True)


def nc_filename_suffix(options: ExportOptions) -> str:
    """Outer router consumes this to suffix the downloaded file's
    name (e.g. `Story-Prose.zip` / `Story-Summaries.zip`).
    Same one-or-the-other resolution as the renderer itself."""
    return "Prose" if _resolve_nc_mode(options) == "prose" else "Summaries"


def _sanitise_filename(raw: str) -> str:
    """Strip characters unsafe in a filename and collapse whitespace
    to hyphens. Duplicate of the router's helper so this renderer
    stays self-contained and doesn't reach across module boundaries."""
    cleaned = re.sub(r'[\\/:*?"<>|]+', "", raw or "").strip()
    cleaned = re.sub(r"\s+", "-", cleaned)
    return cleaned or "story"


# ── Manuscript file ────────────────────────────────────────────────────


def _render_manuscript(model: ExportModel, options: ExportOptions) -> str:
    """Walk the ExportModel's sections and emit the NovelCrafter
    manuscript markdown. Uses `#` for acts, `##` for chapters (flat
    `#` for chapters when there are no acts), `***` between scenes
    within a chapter, and `---` between summary and prose body
    within a scene (NovelCrafter's documented Markdown import shape).

    Honours `ExportOptions.include_scene_description` +
    `include_scene_body`:
      - both False  → nothing per scene (the chapter still renders
        a heading; the scene contributes nothing).
      - description only → scene's description (the writer's beat
        summary). NC's parser treats pre-`---` content as the
        scene's `summary_md`.
      - body only (default) → scene's prose body, no leading
        summary. The output is just the manuscript.
      - both → description + `---` + prose. NC's parser splits on
        the `---` and lands the summary on `summary_md`, the prose
        on `body_md`.
    """
    # Decide whether to use acts or flat chapters based on whether
    # any top-level section is an act. NovelCrafter's rule: "If you
    # don't use any acts, only use Heading 1 throughout your document
    # for the chapter titles."
    has_acts = any(s.kind == "act" for s in model.sections)

    parts: list[str] = []

    for section in model.sections:
        rendered = _render_manuscript_section(section, has_acts, options)
        if rendered:
            parts.append(rendered)

    return "\n\n".join(p for p in parts if p).rstrip() + "\n"


def _render_manuscript_section(
    section: ExportSection,
    has_acts: bool,
    options: ExportOptions,
) -> str:
    parts: list[str] = []

    if section.kind == "act":
        parts.append(f"# {(section.label or '').strip()}")
        for child in section.children:
            rendered = _render_manuscript_section(child, has_acts, options)
            if rendered:
                parts.append(rendered)
        return "\n\n".join(parts)

    if section.kind == "chapter":
        # Chapters are `##` when there are acts, `#` otherwise.
        heading_char = "##" if has_acts else "#"
        parts.append(f"{heading_char} {(section.label or '').strip()}")
        parts.append(_render_manuscript_scenes(section.scenes, options))
        return "\n\n".join(p for p in parts if p)

    # "unchaptered" — promote to a top-level chapter heading with the
    # section's label (typically "Unchaptered"). NovelCrafter has no
    # concept of "unchaptered POV scenes" so the least-surprising
    # fallback is to treat it as its own chapter.
    if section.scenes:
        heading_char = "##" if has_acts else "#"
        parts.append(f"{heading_char} {(section.label or 'Unchaptered').strip()}")
        parts.append(_render_manuscript_scenes(section.scenes, options))
    return "\n\n".join(p for p in parts if p)


def _render_manuscript_scenes(scenes: list[ExportScene], options: ExportOptions) -> str:
    """Render a chapter's scenes joined by `***`. Each scene's content
    is composed of an optional pre-`---` summary block (the writer's
    description) followed by an optional prose body block, per
    `ExportOptions.include_scene_description` + `include_scene_body`.
    The format mirrors NovelCrafter's documented import structure
    (see `_parse_chapters_into_scenes` in
    `novelcrafter_import_service.py`): pre-`---` content is the
    scene's `summary_md`, post-`---` is its `body_md`.

    A scene that contributes nothing under the writer's chosen
    flags (empty description, empty body, or both flags off) is
    skipped entirely so there are no blank `***` artefacts between
    real scenes.
    """
    blocks: list[str] = []
    for scene in scenes:
        scene_block = _render_one_scene(scene, options)
        if scene_block:
            blocks.append(scene_block)
    # Join with the `***` scene separator on its own line, padded by
    # blank lines so markdown processors render it as a thematic break.
    return "\n\n***\n\n".join(blocks)


def _render_one_scene(scene: ExportScene, options: ExportOptions) -> str:
    """Compose one scene's content per the depth flags. Returns an
    empty string when the chosen flags leave the scene with nothing
    to render (caller drops it from the join)."""
    description_text = (scene.description or "").strip() if options.include_scene_description else ""
    body_md = ""
    if options.include_scene_body:
        body_md = _tiptap_to_plain_markdown(scene.main_content_html).strip()
    if description_text and body_md:
        # Both — description then `---` separator then prose body.
        return f"{description_text}\n\n---\n\n{body_md}"
    if description_text:
        return description_text
    if body_md:
        return body_md
    return ""


# ── Entities file ──────────────────────────────────────────────────────


# Attribute-name synonyms for aliases / nicknames. Case-insensitive,
# whitespace-collapsed, trailing-colon-stripped before matching. If an
# entity has an attribute whose name matches one of these, that
# attribute's value(s) populate the parenthesised aliases slot in the
# NovelCrafter entity format.
#
# Fuzzy synonyms like "titles" / "epithets" are deliberately left off
# because they overlap with unrelated concepts ("Job Title") and could
# mis-match. See the Phase 1.15 cross-reference note in ToDo.md — when
# the native Entity.aliases field lands, `_extract_aliases` below
# should check it first and fall back to this synonym path only if the
# native field is empty.
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
}


def _render_entities(model: ExportModel) -> str:
    """Walk the entity reference sheets and emit the NovelCrafter
    entity codex source markdown — a top-level heading + usage
    instructions, followed by one `##` section per entity bucket
    containing a numbered list of `**Name (aliases) [type]:** description`
    entries.

    If the model has no entity sheets (should not happen because the
    SPEC's `required_options` forces `include_entity_sheets=True`, but
    defensive), emit a minimal note instead of an empty list.
    """
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

    # Group sheets by bucket / type. Preserve model order within each
    # bucket so the output mirrors the order the user laid out their
    # library in (stable).
    by_bucket: dict[str, list[ExportEntitySheet]] = {}
    for sheet in model.entity_sheets:
        bucket = (sheet.type or "custom").lower()
        by_bucket.setdefault(bucket, []).append(sheet)

    # Emit sections in a deterministic order: the canonical bucket
    # order (character / location / item / faction / custom), then any
    # unknown bucket types at the end for robustness.
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

    # Any unrecognised bucket types (shouldn't happen, but defensive).
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
    Extract-compatible format:

        1. **Name (alias1, alias2) [bucket]:** Description text.

           Multi-paragraph description content flows as continuation
           lines, indented with three spaces so markdown processors
           keep it part of the list item rather than starting a new
           paragraph.

    Skips the parenthesised aliases entirely when the entity has none.
    """
    name = sheet.name or "(unnamed)"
    aliases = _extract_aliases(sheet)
    bucket_tag = bucket_key  # "character", "location", etc.

    alias_block = ""
    if aliases:
        alias_block = " (" + ", ".join(aliases) + ")"

    header = f"{index}. **{name}{alias_block} [{bucket_tag}]:**"

    # Description flows after the header on the same line if short, or
    # as continuation lines if multi-paragraph. Per NovelCrafter's
    # format example: "Feel free to use multiline descriptions."
    description = (sheet.description or "").strip()
    if not description:
        # Empty description — just the header, nothing after.
        return header

    # Split description on paragraph breaks and render each paragraph
    # as a continuation line under the list item.
    description_paragraphs = [
        p.strip() for p in re.split(r"\n\s*\n", description) if p.strip()
    ]

    if len(description_paragraphs) == 1:
        # Single paragraph — inline with the header.
        return f"{header} {description_paragraphs[0]}"

    # Multi-paragraph — header line + three-space-indented continuation
    # paragraphs separated by blank lines.
    lines: list[str] = [f"{header} {description_paragraphs[0]}"]
    for paragraph in description_paragraphs[1:]:
        lines.append("")
        lines.append(f"   {paragraph}")
    return "\n".join(lines)


def _extract_aliases(sheet: ExportEntitySheet) -> list[str]:
    """Return the entity's aliases, preferring the native `sheet.aliases`
    field when non-empty and falling back to scanning attributes for
    legacy synonym-named entries (e.g. "Also Known As", "Aliases").
    Preserves insertion order and deduplicates if multiple synonym
    attributes are found on the same entity.
    """
    # Native aliases field takes priority (Phase 1.16+)
    if sheet.aliases:
        return list(sheet.aliases)
    # Legacy fallback: attribute-name synonym scan
    collected: list[str] = []
    seen: set[str] = set()
    for attr in sheet.attributes or []:
        if not _is_alias_attribute(attr):
            continue
        for value in _parse_alias_value(attr):
            # Case-sensitive dedup (Ally vs ally are kept separate)
            if value not in seen:
                seen.add(value)
                collected.append(value)
    return collected


def _is_alias_attribute(attr: ExportAttribute) -> bool:
    name = (attr.name or "").strip().lower().rstrip(":").strip()
    # Collapse internal whitespace so "Also   Known As" matches
    # "also known as" in the synonym set.
    name = re.sub(r"\s+", " ", name)
    return name in _ALIAS_ATTRIBUTE_SYNONYMS


def _parse_alias_value(attr: ExportAttribute) -> list[str]:
    """Pull the list of aliases out of an attribute's value. Shape
    depends on `attribute_type`:

      - `text_list` / `entity_list`: the value is a JSON array of
        strings. Parse and return the non-empty entries.
      - `text`: single freeform string. Split on commas and " and "
        to catch both "Ally, Al, Alie" and "Ally and Al" forms.
      - `preset`: single preset selection. Treat the selected value
        as one alias.
      - `file`: ignored — no alias data in a file attribute.

    Empty / malformed values return an empty list — aliases just
    don't get emitted for that attribute.
    """
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

    # text or preset — single string, possibly comma/and-separated.
    parts: list[str] = []
    for chunk in raw.split(","):
        for sub in re.split(r"\s+and\s+", chunk):
            cleaned = sub.strip()
            if cleaned:
                parts.append(cleaned)
    return parts


# ── TipTap HTML → plain markdown converter ─────────────────────────────


class _TipTapToPlainMarkdown(HTMLParser):
    """Convert TipTap scene body HTML into plain markdown for
    NovelCrafter's manuscript importer.

    Structurally similar to `renderers/markdown.py`'s `_TipTapToMarkdown`
    but simpler because NovelCrafter's manuscript format is much more
    restrictive:

      - NO headings (NovelCrafter reads every `#` / `##` as an act /
        chapter; scene body headings would break the hierarchy).
        `<h1>`..`<h6>` inside scene body text render as plain
        paragraphs.
      - NO blockquotes, code blocks, lists, horizontal rules. These
        would all confuse or bloat the importer. Text content is
        preserved but the structural markup is dropped.
      - NO links — NovelCrafter strips them anyway, and the bracketed
        link syntax would clutter the imported prose.
      - NO media tags (same as every other text-based renderer in
        this package).

    What IS preserved:

      - `<p>` paragraph boundaries
      - `<strong>` / `<b>`, `<em>` / `<i>`, `<s>` / `<del>` inline
        formatting as `**...**`, `*...*`, `~~...~~`
      - `<br>` hard line breaks as markdown `  \n` (two trailing spaces
        + newline)

    Pure text preservation — no headings, no lists, no links, no
    media. Sibling class to `_TipTapToMarkdown` / `_TipTapToText` /
    `_TipTapToReportLab` per the renderer-independence rule; shares
    zero code with any of them.
    """

    _MEDIA_VOID = {"img", "source"}
    _MEDIA_CONTAINER = {"video", "audio", "picture", "figure", "figcaption"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[str] = []
        self._current: list[str] = []
        self._skip_depth = 0

    def _finish_block(self) -> None:
        raw = "".join(self._current).strip()
        self._current = []
        if raw:
            self.blocks.append(raw)

    def _emit(self, text: str) -> None:
        if self._skip_depth > 0:
            return
        self._current.append(text)

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
            self._finish_block()
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            # Scene body headings would collide with NovelCrafter's
            # act/chapter hierarchy — render them as plain paragraphs.
            self._finish_block()
        elif tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i"):
            self._emit("*")
        elif tag in ("s", "del", "strike"):
            self._emit("~~")
        elif tag == "br":
            self._emit("  \n")
        # Everything else (ul, ol, li, blockquote, code, pre, hr, a, u,
        # code, etc.) is transparent: text content flows through but
        # the tag markers are ignored. This deliberately produces flat
        # paragraph prose even from structured TipTap content.

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

    def handle_data(self, data: str) -> None:  # type: ignore[override]
        if self._skip_depth > 0:
            return
        collapsed = re.sub(r"\s+", " ", data)
        self._emit(collapsed)

    def convert(self, html_text: str) -> str:
        self.feed(html_text or "")
        self._finish_block()
        return "\n\n".join(b for b in self.blocks if b)


def _tiptap_to_plain_markdown(html_text: str) -> str:
    converter = _TipTapToPlainMarkdown()
    return converter.convert(html_text)


# ── Registry binding ───────────────────────────────────────────────────


def render(model: ExportModel, options: Optional[ExportOptions] = None) -> bytes:
    return render_markdown_novelcrafter(model, options)


def render_markdown_novelcrafter_story(
    model: ExportModel,
    options: Optional[ExportOptions] = None,
) -> bytes:
    """Story-only download — the manuscript markdown alone, single file
    (no zip). Honours the prose/summaries mutex: both-on collapses to
    prose, neither-on falls back to prose. Suffixed at the outer
    router (`-Prose.md` / `-Summaries.md`) by `nc_filename_suffix`."""
    options = options or ExportOptions()
    mode = _resolve_nc_mode(options)
    effective_options = _options_for_mode(options, mode)
    manuscript_md = _render_manuscript(model, effective_options)
    return manuscript_md.encode("utf-8")


def render_markdown_novelcrafter_codex(
    model: ExportModel,
    options: Optional[ExportOptions] = None,
) -> bytes:
    """Codex-only download — the entities markdown alone, single file
    (no zip). The mutex doesn't apply (codex isn't manuscript text);
    just dump the entities sheet."""
    _ = options  # codex output is independent of per-scene depth flags
    entities_md = _render_entities(model)
    return entities_md.encode("utf-8")


SPEC = RendererSpec(
    format_id="markdown-novelcrafter",
    label="Markdown (NovelCrafter)",
    extension="zip",
    mime_type="application/zip",
    render=render,
    capabilities=frozenset(),  # deliberately empty — NovelCrafter format is minimal
    variant_of="markdown",
    variant_label="NovelCrafter",
    # The router applies these overrides to the user's ExportOptions
    # before calling build_export_model, so the walker always
    # populates entity reference sheets (the entity codex file needs
    # them) regardless of what the user toggled in the Customise
    # section. See `routers/export.py::export_story` for where this
    # gets merged in.
    required_options={
        "include_entity_sheets": True,
    },
)
register(SPEC)


# ── Hidden download-variant slugs (Phase 3.11) ────────────────────────
# These two are NOT in the Format picker — the dialog's NC-umbrella
# three-button bar dispatches to them by format_id. The umbrella
# (above) stays visible as the family selector; the buttons pick
# which of the three downloadables (story / codex / bundle) the
# writer wants.
def _render_story(model: ExportModel, options: Optional[ExportOptions] = None) -> bytes:
    return render_markdown_novelcrafter_story(model, options)


def _render_codex(model: ExportModel, options: Optional[ExportOptions] = None) -> bytes:
    return render_markdown_novelcrafter_codex(model, options)


register(RendererSpec(
    format_id="markdown-novelcrafter-story",
    label="Markdown (NovelCrafter — Story)",
    extension="md",
    mime_type="text/markdown",
    render=_render_story,
    capabilities=frozenset(),
    hidden_from_picker=True,
    required_options={"include_entity_sheets": True},
))

register(RendererSpec(
    format_id="markdown-novelcrafter-codex",
    label="Markdown (NovelCrafter — Codex)",
    extension="md",
    mime_type="text/markdown",
    render=_render_codex,
    capabilities=frozenset(),
    hidden_from_picker=True,
    required_options={"include_entity_sheets": True},
))
