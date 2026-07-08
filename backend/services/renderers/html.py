"""
HTML renderer for the Phase 1.12a export pipeline.

Part of the modular renderer package: each format is its own file
under `backend/services/renderers/`, self-registering a `RendererSpec`
via the registry at the bottom of this module. See
`docs/export-renderer-guide.md` for the full pattern.

Consumes an `ExportModel` produced by `build_export_model` and emits a
single self-contained HTML document with embedded CSS. No external
template files, no Jinja2 dependency — plain Python string helpers
with `html.escape` for user-provided text.

Why plain Python over Jinja2? For a single template with no
user-facing customisation, string helpers are:
  - zero new dependencies (Jinja2 would be one more pip install)
  - simpler to test (no template discovery, no separate escaping rules)
  - easier to refactor (full type checking, IDE "find usages" works)
  - easier to diff in code review

If a future phase adds user-customisable templates, Jinja2 can be
swapped in at that point without disturbing the data model (which is
what `ExportModel` exists to isolate).

HTML structure, in order:
  <!DOCTYPE html>
  <head>
    - title
    - embedded CSS (dark theme + print media override)
  </head>
  <body>
    <header class="nn-story-header">
      story title, author, genre, tags, generated-at timestamp
    </header>
    <main>
      for each ExportSection in model.sections:
        - act: <h1 class="nn-act-header">
            + recurse into act.children (chapter sections)
        - chapter: <h2 class="nn-chapter-header">
            + each scene in section.scenes
        - unchaptered: <h2 class="nn-chapter-header nn-unchaptered">
            + scenes (only rendered if non-empty)
      for each scene:
        - transition paragraph (italic, prose-style) if non-empty
        - <article class="nn-scene">
            <h3 class="nn-scene-title">title</h3>
            <p class="nn-scene-description"> if non-empty
            <p class="nn-scene-context"> if non-empty
            <div class="nn-scene-body"> main_content_html
    </main>
    (optional) <section class="nn-appendix"> off-screen scenes
    (optional) <section class="nn-appendix"> entity reference sheets
  </body>
"""

from __future__ import annotations

import html
from datetime import datetime
from typing import Optional

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


def render_html(model: ExportModel, options: Optional[ExportOptions] = None) -> str:
    """Return a complete HTML document as a string."""
    options = options or ExportOptions()
    accent = model.accent_color or "#7c3aed"  # default is Tailwind accent-700
    pov_color = model.pov_color or "#eab308"  # default is the gold POV swatch
    parts: list[str] = []
    parts.append("<!DOCTYPE html>")
    parts.append('<html lang="en">')
    parts.append(_render_head(model, accent, pov_color))
    parts.append("<body>")
    # Phase 5.8b — story cover as the first thing in the document, before
    # the title page. Its own print page via `page-break-after`.
    if options.include_cover_image and model.cover_image_data_uri:
        parts.append(
            f'<div class="nn-cover"><img src="{html.escape(model.cover_image_data_uri)}" alt="Cover"></div>'
        )
    parts.append(_render_story_header(model, options))
    parts.append("<main>")
    parts.append(_render_sections(model.sections, options))
    parts.append("</main>")
    if options.include_offscreen_appendix and model.offscreen_scenes:
        parts.append(_render_offscreen_appendix(model.offscreen_scenes, options))
    if options.include_entity_sheets and model.entity_sheets:
        parts.append(_render_entity_sheets(model.entity_sheets, options))
    if options.include_knowledge_section and model.knowledge_sheets:
        parts.append(_render_knowledge_sheets(model.knowledge_sheets, options))
    parts.append("</body>")
    parts.append("</html>")
    return "\n".join(parts)


# ── <head> + CSS ───────────────────────────────────────────────────────


def _render_head(model: ExportModel, accent: str, pov_color: str) -> str:
    title = html.escape(model.title)
    css = _CSS_TEMPLATE.replace("__ACCENT__", accent).replace("__POV__", pov_color)
    return (
        "<head>"
        '<meta charset="UTF-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{title}</title>"
        f"<style>{css}</style>"
        "</head>"
    )


_CSS_TEMPLATE = """
:root {
  --accent: __ACCENT__;
  --pov-color: __POV__;
  --bg: #18181b;
  --bg-card: #27272a;
  --fg: #e4e4e7;
  --fg-muted: #a1a1aa;
  --fg-dim: #71717a;
  --border: #3f3f46;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: Georgia, "Times New Roman", serif;
  font-size: 16px;
  line-height: 1.6;
  padding: 48px 24px;
}
main, .nn-story-header, .nn-appendix {
  max-width: 760px;
  margin: 0 auto;
}
.nn-story-header {
  border-bottom: 1px solid var(--border);
  padding-bottom: 24px;
  margin-bottom: 48px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.nn-story-header h1 {
  color: var(--accent);
  font-size: 2.5rem;
  margin: 0 0 8px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.nn-story-header .nn-byline {
  color: var(--fg-muted);
  font-size: 1rem;
  font-style: italic;
  margin: 0 0 16px;
}
.nn-story-header .nn-meta {
  color: var(--fg-dim);
  font-size: 0.8rem;
  margin: 0;
}
.nn-story-header .nn-meta span + span::before {
  content: " · ";
  color: var(--border);
}
.nn-story-header .nn-description {
  color: var(--fg);
  font-size: 0.95rem;
  line-height: 1.5;
  margin: 16px 0 0;
  white-space: pre-wrap;
}
.nn-cover {
  text-align: center;
  margin: 0 0 24px;
}
.nn-cover img {
  max-width: 100%;
  max-height: 90vh;
  height: auto;
  border: 1px solid var(--border);
  border-radius: 3px;
}
@media print {
  .nn-cover { page-break-after: always; }
}
.nn-story-header .nn-narrative {
  margin: 16px 0 12px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px 24px;
}
.nn-story-header .nn-narrative-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.nn-story-header .nn-narrative-row dt {
  color: var(--fg-dim);
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 0;
  white-space: nowrap;
}
.nn-story-header .nn-narrative-row dd {
  color: var(--fg);
  margin: 0;
  font-size: 0.9rem;
}
h1.nn-act-header {
  color: var(--accent);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 1.2rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  text-align: center;
  margin: 64px 0 32px;
  padding-bottom: 8px;
  border-bottom: 2px solid var(--accent);
}
h2.nn-chapter-header {
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 1.6rem;
  font-weight: 600;
  margin: 48px 0 24px;
  padding-left: 12px;
  border-left: 4px solid var(--accent);
}
h2.nn-chapter-header.nn-unchaptered {
  color: var(--fg-muted);
  font-style: italic;
  border-left-color: var(--fg-dim);
}
.nn-scene {
  margin: 0 0 40px;
}
.nn-scene-transition {
  color: var(--fg-muted);
  font-style: italic;
  text-align: center;
  margin: 24px 0;
}
.nn-scene-title {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--fg);
  margin: 0 0 4px;
}
.nn-scene-description {
  color: var(--fg-muted);
  font-size: 0.82rem;
  margin: 0 0 10px;
  padding: 6px 10px;
  background: rgba(128, 128, 128, 0.12);
  border: 1px solid var(--border);
  border-radius: 4px;
}
.nn-scene-description > :first-child { margin-top: 0; }
.nn-scene-description > :last-child { margin-bottom: 0; }
.nn-scene-context {
  font-size: 0.85rem;
  margin: 0 0 12px;
  padding: 6px 10px;
  background: rgba(128, 128, 128, 0.10);
  border: 1px solid var(--border);
  border-radius: 4px;
}
.nn-scene-context > :first-child { margin-top: 0; }
.nn-scene-context > :last-child { margin-bottom: 0; }
.nn-scene-break {
  text-align: center;
  margin: 1.6em 0;
  color: var(--fg-muted);
  line-height: 0;
}
.nn-scene-break svg {
  width: 180px;
  max-width: 60%;
  height: auto;
}
.nn-scene-pov {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 0.8rem;
  color: var(--fg);
  margin: 0 0 6px;
}
.nn-scene-pov-label {
  display: inline-block;
  padding: 1px 6px;
  border: 1px solid var(--pov-color);
  border-radius: 2px;
  color: var(--pov-color);
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-right: 4px;
  vertical-align: 1px;
}
.nn-scene-context {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  margin: 0 0 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 12px;
  font-size: 0.8rem;
}
.nn-scene-context dt {
  color: var(--fg-dim);
  font-weight: 500;
  white-space: nowrap;
  margin: 0;
}
.nn-scene-context dd {
  color: var(--fg);
  margin: 0;
}

/* Entity reference link + hover popover. Used in scene contexts,
   scene changes blocks, and anywhere else an entity name appears
   that we want to hyperlink to its reference sheet. The popover
   shows a bigger version of the profile image on hover. */
.nn-entity-ref {
  position: relative;
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px dotted rgba(124, 58, 237, 0.5);
  cursor: pointer;
}
.nn-entity-ref:hover {
  color: var(--fg);
  border-bottom-color: var(--fg);
}
.nn-entity-ref.nn-entity-ref-no-link {
  cursor: default;
}
.nn-entity-ref-popover {
  display: none;
  position: absolute;
  left: 0;
  top: calc(100% + 6px);
  z-index: 100;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  pointer-events: none;
}
.nn-entity-ref-popover img {
  display: block;
  width: 96px;
  height: 96px;
  object-fit: cover;
  border-radius: 2px;
}
.nn-entity-ref:hover .nn-entity-ref-popover {
  display: block;
}
.nn-scene-body {
  color: var(--fg);
}
.nn-scene-changes {
  margin: 24px 0 0;
  padding: 12px 16px;
  background: var(--bg-card);
  border-left: 3px solid var(--fg-dim);
  border-radius: 2px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 0.8rem;
}
.nn-scene-changes-label {
  color: var(--fg-dim);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.7rem;
  font-weight: 600;
  margin: 0 0 8px;
}
.nn-scene-changes-entities {
  list-style: none;
  padding: 0;
  margin: 0;
}
.nn-scene-changes-entities > li {
  padding: 4px 0;
  margin-top: 4px;
}
.nn-scene-changes-entities > li:first-child {
  margin-top: 0;
}
.nn-scene-changes-entity-header {
  color: var(--fg);
  font-weight: 600;
  margin-bottom: 2px;
}
.nn-scene-changes-entity {
  color: var(--fg);
}
.nn-scene-changes-type {
  color: var(--fg-dim);
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 500;
}
.nn-scene-changes-details {
  list-style: none;
  padding: 0 0 0 14px;
  margin: 0;
  border-left: 1px solid var(--border);
}
.nn-scene-changes-details > li {
  color: var(--fg-muted);
  padding: 2px 0 2px 8px;
  font-size: 0.78rem;
}
.nn-scene-changes-details > li.nn-scene-changes-metadata {
  color: var(--fg-muted);
}
.nn-scene-changes-details > li.nn-scene-changes-attribute {
  color: var(--fg);
}
.nn-scene-changes-details > li.nn-scene-changes-relationship {
  color: var(--fg);
  font-style: italic;
}
/* Phase 1.25c — subchip-shaped change indicator. Mirrors the
 * frontend `<BaseChangeChip>` / `<ActionGlyphBadge>` visual:
 * tinted background, action-coloured left border, glyph pill,
 * field name, value transition. Action colours match
 * `frontend/src/components/ui/ChangeChipBase.jsx ACTION_COLOR`. */
.nn-change-subchip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px 1px 4px;
  border-radius: 3px;
  font-size: 0.78rem;
  line-height: 1.4;
}
.nn-change-subchip-add    { background-color: rgba(74, 222, 128, 0.18);  border-left: 2px solid rgba(74, 222, 128, 0.66); }
.nn-change-subchip-modify { background-color: rgba(251, 191, 36, 0.18);  border-left: 2px solid rgba(251, 191, 36, 0.66); }
.nn-change-subchip-remove { background-color: rgba(248, 113, 113, 0.18); border-left: 2px solid rgba(248, 113, 113, 0.66); }
.nn-change-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
  border-radius: 2px;
  font-size: 0.72rem;
  font-weight: 700;
  flex-shrink: 0;
}
.nn-change-glyph-add    { color: #4ade80; background-color: rgba(74, 222, 128, 0.13);  }
.nn-change-glyph-modify { color: #fbbf24; background-color: rgba(251, 191, 36, 0.13);  }
.nn-change-glyph-remove { color: #f87171; background-color: rgba(248, 113, 113, 0.13); }
.nn-change-field { color: var(--fg-muted); }
.nn-change-arrow { color: var(--fg-muted); margin: 0 4px; }
.nn-change-old { color: var(--fg-muted); text-decoration: line-through; opacity: 0.7; }
.nn-change-new { color: var(--fg); }
.nn-change-image-wrap { display: inline-block; margin-left: 6px; vertical-align: middle; }
.nn-change-image-wrap img { max-height: 32px; width: auto; vertical-align: middle; border-radius: 2px; }
.nn-scene-body p {
  margin: 0 0 1em;
}
.nn-scene-body img {
  max-width: 100%;
  height: auto;
}
.nn-appendix {
  margin-top: 96px;
  padding-top: 32px;
  border-top: 2px solid var(--border);
}
.nn-appendix h1 {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 1.2rem;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.15em;
  text-align: center;
  margin: 0 0 16px;
}
.nn-appendix-note {
  color: var(--fg-dim);
  font-size: 0.85rem;
  font-style: italic;
  text-align: center;
  max-width: 560px;
  margin: 0 auto 32px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.nn-entity-sheet,
.nn-knowledge-sheet {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 16px 20px;
  margin-bottom: 16px;
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.nn-knowledge-sheet img {
  width: 64px;
  height: 64px;
  border-radius: 4px;
  object-fit: cover;
  flex-shrink: 0;
  border: 2px solid var(--fg-dim);
}
.nn-knowledge-sheet .nn-entity-body { flex: 1; min-width: 0; }
.nn-knowledge-sheet h2 {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 1.1rem;
  margin: 0 0 4px;
}
.nn-knowledge-source {
  color: var(--fg-muted);
  font-size: 0.82rem;
  font-style: italic;
  margin: 4px 0 8px;
}
.nn-knowledge-history {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 0.82rem;
}
.nn-knowledge-history-label {
  color: var(--fg-dim);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.7rem;
  font-weight: 600;
  margin: 0 0 8px;
}
.nn-knowledge-history ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
.nn-knowledge-history > ul > li {
  padding: 3px 0 3px 10px;
  margin: 0;
  border-left: 2px solid var(--border);
}
.nn-knowledge-chain-kind {
  color: var(--fg-dim);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-size: 0.7rem;
  font-weight: 600;
}
.nn-knowledge-chain-scene { color: var(--fg-muted); }

.nn-entity-sheet img {
  width: 64px;
  height: 64px;
  border-radius: 4px;
  object-fit: cover;
  flex-shrink: 0;
  border: 2px solid var(--fg-dim);
}
.nn-entity-sheet .nn-entity-body {
  flex: 1;
  min-width: 0;
}
.nn-entity-sheet h2 {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 1.1rem;
  margin: 0 0 4px;
  color: var(--fg);
}
.nn-entity-sheet .nn-entity-type {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg-dim);
  margin: 0 0 8px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.nn-entity-sheet .nn-entity-aliases {
  color: var(--fg-dim);
  font-size: 0.82rem;
  font-style: italic;
  margin: 0 0 8px;
}
.nn-entity-sheet .nn-entity-description {
  color: var(--fg-muted);
  font-size: 0.9rem;
  margin: 0 0 12px;
}
.nn-entity-sheet dl {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  font-size: 0.85rem;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.nn-entity-sheet dt {
  color: var(--fg-dim);
  font-weight: 500;
}
.nn-entity-sheet dd {
  margin: 0;
  color: var(--fg);
}
.nn-entity-relationships {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 0.82rem;
}
/* Phase 1.25c — entity Notes section. Same chrome as the
 * Relationships block above so the sheet keeps a consistent rhythm. */
.nn-entity-notes {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 0.82rem;
}
.nn-entity-notes-label {
  color: var(--fg-dim);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.7rem;
  font-weight: 600;
  margin: 0 0 8px;
}
.nn-entity-notes-body {
  color: var(--fg);
  margin: 0;
  white-space: pre-wrap;
}
.nn-entity-relationships-label {
  color: var(--fg-dim);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.7rem;
  font-weight: 600;
  margin: 0 0 8px;
}
.nn-entity-relationships ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
.nn-entity-relationships > ul > li {
  padding: 4px 0;
  margin: 0;
  border-left: 2px solid var(--border);
  padding-left: 10px;
}
.nn-entity-relationships > ul > li + li {
  margin-top: 4px;
}
.nn-entity-relationship-header {
  color: var(--fg);
  font-weight: 600;
  margin-bottom: 2px;
}
.nn-entity-relationship-type {
  color: var(--fg-dim);
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 500;
}
/* Phase 1.25c — scene-time line under the scene title. Inline icons
 * sit beside the text; both wrap together when the line gets long. */
.nn-scene-time {
  color: var(--fg-dim);
  font-size: 0.82rem;
  margin: 4px 0 6px;
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.nn-scene-time-icon {
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
  flex-shrink: 0;
}
.nn-scene-time-icon svg {
  width: 1.05em;
  height: 1.05em;
}
.nn-entity-relationship-desc,
.nn-entity-relationship-perception {
  color: var(--fg-muted);
  font-size: 0.8rem;
  font-style: italic;
  margin: 2px 0 0;
}
.nn-entity-relationship-role {
  color: var(--fg-dim);
  font-size: 0.75rem;
  margin: 2px 0 0;
}
.nn-entity-relationship-flag {
  display: inline-block;
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 1px 6px;
  border-radius: 3px;
  background-color: var(--border);
  color: var(--fg-dim);
  margin-left: 4px;
  font-weight: 500;
}
@media print {
  :root {
    --bg: #ffffff;
    --bg-card: #f5f5f5;
    --fg: #18181b;
    --fg-muted: #52525b;
    --fg-dim: #71717a;
    --border: #d4d4d8;
  }
  body { padding: 24px; font-size: 11pt; }
  h1.nn-act-header, h2.nn-chapter-header { page-break-before: always; }
  h1.nn-act-header:first-child, h2.nn-chapter-header:first-child { page-break-before: avoid; }
  .nn-scene { page-break-inside: avoid; }
  .nn-appendix { page-break-before: always; }
}
"""


# ── <header> story header block ───────────────────────────────────────


def _render_story_header(model: ExportModel, options: ExportOptions) -> str:
    title = html.escape(model.title)

    # Byline — author only (timestamp moved to the meta line).
    byline_html = ""
    if options.include_author and model.author:
        byline_html = f'<p class="nn-byline">by {html.escape(model.author)}</p>'

    # Meta line — genre, tags, generated timestamp. Each has its own
    # toggle; if all three are off this line is skipped entirely.
    meta_parts: list[str] = []
    if options.include_genre and model.genre:
        meta_parts.append(f"<span>{html.escape(model.genre)}</span>")
    if options.include_tags and model.tags:
        tag_text = ", ".join(html.escape(t) for t in model.tags)
        meta_parts.append(f"<span>{tag_text}</span>")
    if options.include_generated_timestamp:
        meta_parts.append(
            f"<span>Generated {html.escape(model.generated_at.strftime('%Y-%m-%d %H:%M UTC'))}</span>"
        )
    meta_html = f'<p class="nn-meta">{"".join(meta_parts)}</p>' if meta_parts else ""

    # Narrative metadata — tense, POV type, language, default POV character.
    # Only the rows whose toggle is on AND whose value is set are included.
    narrative_rows: list[str] = []
    if options.include_default_pov_character and model.default_pov_character_name:
        narrative_rows.append(
            f'<div class="nn-narrative-row"><dt>Primary POV</dt>'
            f'<dd>{html.escape(model.default_pov_character_name)}</dd></div>'
        )
    if options.include_pov_type and model.pov_type:
        narrative_rows.append(
            f'<div class="nn-narrative-row"><dt>POV style</dt>'
            f'<dd>{html.escape(model.pov_type)}</dd></div>'
        )
    if options.include_tense and model.tense:
        label = {
            "past": "Past tense",
            "present": "Present tense",
        }.get(model.tense.lower(), model.tense)
        narrative_rows.append(
            f'<div class="nn-narrative-row"><dt>Tense</dt>'
            f'<dd>{html.escape(label)}</dd></div>'
        )
    if options.include_language and model.language:
        narrative_rows.append(
            f'<div class="nn-narrative-row"><dt>Language</dt>'
            f'<dd>{html.escape(model.language)}</dd></div>'
        )
    narrative_html = (
        f'<dl class="nn-narrative">{"".join(narrative_rows)}</dl>' if narrative_rows else ""
    )

    # Phase 5.8b — story description blurb, just below the metadata block.
    description_html = ""
    if options.include_story_description and model.description and model.description.strip():
        description_html = f'<p class="nn-description">{html.escape(model.description.strip())}</p>'

    return (
        '<header class="nn-story-header">'
        f"<h1>{title}</h1>"
        f"{byline_html}"
        f"{narrative_html}"
        f"{meta_html}"
        f"{description_html}"
        "</header>"
    )


# ── Free-form text fields (markdown-aware) ─────────────────────────────


def _block_field_html(text: str, options: ExportOptions, css_class: str) -> str:
    """Phase 5.8b — render a free-form block field (description / notes /
    scene description). When `render_markdown_in_text_fields` is on, the
    text is treated as markdown and rendered to HTML inside a div with the
    given class; otherwise it is escaped as a single paragraph with newline
    breaks preserved. Empty / blank input returns an empty string."""
    inner = (text or "").strip()
    if not inner:
        return ""
    if options.render_markdown_in_text_fields:
        return f'<div class="{css_class}">{field_markdown_to_html(inner)}</div>'
    body = "<br>".join(html.escape(line) for line in inner.splitlines())
    return f'<p class="{css_class}">{body}</p>'


def _notes_field_html(notes: str, options: ExportOptions) -> str:
    """Phase 5.8b — render the entity / knowledge "Notes" block. Markdown
    when enabled, else the escaped lines joined with <br>. Empty input
    returns an empty string."""
    inner = (notes or "").strip()
    if not inner:
        return ""
    if options.render_markdown_in_text_fields:
        body = f'<div class="nn-entity-notes-body">{field_markdown_to_html(inner)}</div>'
    else:
        br = "<br>".join(html.escape(line) for line in inner.splitlines())
        body = f'<p class="nn-entity-notes-body">{br}</p>'
    return (
        '<div class="nn-entity-notes">'
        '<p class="nn-entity-notes-label">Notes</p>'
        f'{body}'
        '</div>'
    )


# ── <main> sections ────────────────────────────────────────────────────


def _scene_break_html() -> str:
    """Phase 5.8b — scene-break ornament between same-chapter scenes. Inline
    SVG using currentColor so it follows the document theme."""
    return (
        '<div class="nn-scene-break" aria-hidden="true">'
        f'{export_icons.scene_break_svg("currentColor")}'
        '</div>'
    )


def _render_sections(sections: list[ExportSection], options: ExportOptions) -> str:
    parts: list[str] = []
    for section in sections:
        if section.kind == "act":
            if options.include_act_headings:
                parts.append(f'<h1 class="nn-act-header">{html.escape(section.label)}</h1>')
            parts.append(_render_sections(section.children, options))
        elif section.kind == "chapter":
            if section.scenes:
                if options.include_chapter_headings:
                    parts.append(f'<h2 class="nn-chapter-header">{html.escape(section.label)}</h2>')
                for i, scene in enumerate(section.scenes):
                    if i > 0 and options.include_scene_separator:
                        parts.append(_scene_break_html())
                    parts.append(_render_scene(scene, options))
        elif section.kind == "unchaptered":
            if section.scenes:
                if options.include_unchaptered_heading:
                    parts.append(
                        '<h2 class="nn-chapter-header nn-unchaptered">Unchaptered</h2>'
                    )
                for i, scene in enumerate(section.scenes):
                    if i > 0 and options.include_scene_separator:
                        parts.append(_scene_break_html())
                    parts.append(_render_scene(scene, options))
    return "\n".join(parts)


def _render_scene(scene: ExportScene, options: ExportOptions) -> str:
    parts: list[str] = []
    if options.include_transition_text and scene.transition_in_text:
        parts.append(
            f'<p class="nn-scene-transition">{html.escape(scene.transition_in_text)}</p>'
        )
    parts.append('<article class="nn-scene">')
    if options.include_scene_title:
        title = html.escape(scene.title) if scene.title else "Untitled Scene"
        parts.append(f'<h3 class="nn-scene-title" id="scene-{html.escape(scene.id)}">{title}</h3>')
    if options.include_scene_description and scene.description:
        parts.append(_block_field_html(scene.description, options, "nn-scene-description"))
    # Phase 5.8b — the scene "context" elements (time, circumstances &
    # motivators, POV, entity context) collect into a second light-grey box
    # between the description and the prose, distinct from the story text.
    ctx_parts: list[str] = []
    # Phase 1.25c — scene-time line (date / weekday / tod / season /
    # duration / gap). Pre-formatted by the frontend; embedded SVG
    # icons travel inside `scene_time_*_svg` and inline directly.
    if options.include_scene_time and (
        scene.scene_time_text or scene.scene_time_season_svg or scene.scene_time_tod_svg
    ):
        bits: list[str] = ['<p class="nn-scene-time">']
        if scene.scene_time_season_svg:
            bits.append(
                f'<span class="nn-scene-time-icon">{scene.scene_time_season_svg}</span>'
            )
        if scene.scene_time_tod_svg:
            bits.append(
                f'<span class="nn-scene-time-icon">{scene.scene_time_tod_svg}</span>'
            )
        if scene.scene_time_text:
            bits.append(
                f'<span class="nn-scene-time-text">{html.escape(scene.scene_time_text)}</span>'
            )
        bits.append('</p>')
        ctx_parts.append("".join(bits))
    if options.include_scene_cm_block and scene.cm_groups:
        cm_html = _render_scene_cm_block(scene.cm_groups, options)
        if cm_html:
            ctx_parts.append(cm_html)
    # POV line — who carries the point of view in this scene. Rendered
    # above the entity context line because POV is structurally more
    # important than "who else is present".
    if options.include_scene_pov_line and scene.pov_entity_name:
        ctx_parts.append(
            f'<p class="nn-scene-pov"><span class="nn-scene-pov-label">POV</span> '
            f"{html.escape(scene.pov_entity_name)}</p>"
        )
    if options.include_entity_context_line and scene.entity_context_groups:
        ctx_parts.append(_render_scene_context(scene.entity_context_groups, options))
    if ctx_parts:
        parts.append('<div class="nn-scene-context">' + "".join(ctx_parts) + '</div>')
    # main_content_html is already HTML from TipTap — pass through verbatim.
    # (A future hardening pass could strip unsafe tags, but for local export
    # the user IS the author and we trust their own content.)
    if options.include_scene_body:
        parts.append(f'<div class="nn-scene-body">{scene.main_content_html}</div>')
    # Per-scene change summary — only rendered when the scene actually
    # had changes recorded on at least one EntityRef, and only when
    # the granular toggles yield at least one visible line.
    if options.include_scene_changes_block and scene.changes:
        filtered = _filter_scene_changes(scene.changes, options)
        if filtered:
            # Phase 5.8b — the Scene Changes block is metadata, not prose, so
            # it sits in a light-grey box (like the description / context).
            parts.append(
                '<div class="nn-scene-context">'
                + _render_scene_changes(filtered, options)
                + '</div>'
            )
    parts.append("</article>")
    return "\n".join(parts)


def _inline_field(text: str, options: ExportOptions) -> str:
    """Phase 5.8b — inline-rendered free-form body field (circumstance /
    motivator / perspective body, relationship description / perception):
    inline markdown when enabled, else escaped. Empty → ""."""
    inner = (text or "").strip()
    if not inner:
        return ""
    if options.render_markdown_in_text_fields:
        return field_markdown_to_inline_html(inner)
    return html.escape(inner)


def _render_scene_cm_block(groups: list[ExportSceneCMGroup], options: ExportOptions) -> str:
    """Phase 1.22i — Circumstances & Motivators block. Rendered as an
    `<aside>` with a header + nested `<ul>` per group.

    Phase 1.25c — each row leads with the canonical c/m type badge
    SVG (slate `C` for circumstances, rust `M` for motivators) and
    trails with the intensity badge SVG when set, mirroring the
    on-canvas / detail-panel rendering. Renderers that can't carry
    SVG (markdown / txt) keep the text-only `[label]` form.
    """
    if not groups:
        return ""
    parts: list[str] = ['<aside class="nn-scene-cm-block">']
    parts.append('<p class="nn-scene-cm-header"><strong>Circumstances &amp; Motivators</strong></p>')
    parts.append('<ul class="nn-scene-cm-groups">')
    for group in groups:
        if not group.rows:
            continue
        type_part = f' ({html.escape(group.entity_type)})' if group.entity_type else ''
        parts.append(f'<li><strong>{html.escape(group.label)}</strong>{type_part}<ul>')
        for row in group.rows:
            name = (row.name or '').strip()
            desc = (row.description or '').strip()
            # Primary label is the name; with no name it's the body (inline md).
            if name:
                label = html.escape(name)
            elif desc:
                label = _inline_field(desc, options)
            else:
                label = '(unnamed)'
            # Type badge SVG — pentagon outline + letter, slate `C` for
            # circumstances, rust `M` for motivators. Falls back to
            # empty string for prefixes that aren't a c/m row.
            type_badge = export_icons.cm_type_badge_svg(
                _attribute_type_for_prefix(row.prefix), size=14
            )
            type_badge_part = f'{type_badge} ' if type_badge else ''
            # Intensity badge SVG — pentagon with wedges fill at the
            # row's tier (0..4) or dashed grey when unset. Skip
            # entirely when the row's intensity wasn't recorded
            # (avoids visual noise on intensity-less rows).
            intensity_badge = ''
            if row.intensity is not None:
                intensity_badge = ' ' + export_icons.intensity_badge_svg(
                    row.intensity, size=14, title=row.intensity_label or None,
                )
            desc_part = ''
            if desc and name and desc != name:
                desc_part = f' : {_inline_field(desc, options)}'
            parts.append(
                f'<li>{type_badge_part}<strong>{html.escape(row.prefix)}:</strong> '
                f'{label}{intensity_badge}{desc_part}</li>'
            )
        parts.append('</ul></li>')
    parts.append('</ul></aside>')
    return "".join(parts)


# Maps an `ExportSceneCMRow.prefix` string to the corresponding
# `attribute_type` ('circumstance' / 'motivator' / '') for type-badge
# resolution. Mirrors the prefix vocabulary used in
# `_build_scene_cm_groups` in `export_service.py`.
_PREFIX_TO_ATTRIBUTE_TYPE = {
    "Scene Circumstance": "circumstance",
    "Circumstance": "circumstance",
    "Temporary Circumstance": "circumstance",
    "Motivator": "motivator",
    "Temporary Motivator": "motivator",
}


def _attribute_type_for_prefix(prefix: str) -> str:
    return _PREFIX_TO_ATTRIBUTE_TYPE.get(prefix, "")


def _render_entity_link(
    *,
    entity_id: str,
    name: str,
    profile_image_data_uri: Optional[str],
    link_to_sheet: bool,
    colour: Optional[str] = None,
) -> str:
    """Render one entity name as either a link (when entity sheets are
    included in the export so the anchor target exists) or a non-link
    span, with a hover popover showing the profile image if one is
    available. Used by the scene context, the scene changes block,
    and anywhere else an entity name appears in the document.

    When `colour` is not None, an inline `style="color: #xxxxxx"` is
    emitted on the link/span so the entity name renders in its own
    colour — consumed only when the caller passes a non-None colour,
    which in practice means `ExportOptions.use_entity_colours` is on.
    """
    popover = ""
    if profile_image_data_uri:
        popover = (
            f'<span class="nn-entity-ref-popover">'
            f'<img src="{html.escape(profile_image_data_uri)}" alt="">'
            f'</span>'
        )
    escaped_name = html.escape(name)
    escaped_id = html.escape(entity_id)
    style_attr = ""
    if colour:
        style_attr = f' style="color: {html.escape(colour)}; border-bottom-color: {html.escape(colour)}"'
    if link_to_sheet:
        return (
            f'<a class="nn-entity-ref" href="#entity-{escaped_id}"{style_attr}>'
            f'{escaped_name}{popover}'
            f'</a>'
        )
    return (
        f'<span class="nn-entity-ref nn-entity-ref-no-link"{style_attr}>'
        f'{escaped_name}{popover}'
        f'</span>'
    )


def _render_scene_context(
    groups: list[ExportSceneEntityGroup],
    options: ExportOptions,
) -> str:
    """Render the scene's entity context as a multi-row <dl> with one
    row per bucket. Character / Location / Item / Faction / Custom
    each get their own dt+dd pair. Each entity name inside the dd is a
    linked / hover-popover span via `_render_entity_link`."""
    link_to_sheet = options.include_entity_sheets
    use_colours = options.use_entity_colours
    parts: list[str] = ['<dl class="nn-scene-context">']
    for group in groups:
        parts.append(f'<dt>{html.escape(group.label)}</dt>')
        rendered_names = [
            _render_entity_link(
                entity_id=entry.id,
                name=entry.name,
                profile_image_data_uri=entry.profile_image_data_uri,
                link_to_sheet=link_to_sheet,
                colour=entry.colour if use_colours else None,
            )
            for entry in group.entries
        ]
        parts.append(f'<dd>{", ".join(rendered_names)}</dd>')
    parts.append('</dl>')
    return "\n".join(parts)


# Filter scene-changes detail entries against the granular toggles.
# Matching is against the `category` field (metadata / attribute /
# relationship) rather than fragile prefix strings, so new detail
# shapes can be added without touching filter logic.


def _filter_scene_changes(
    changes: list[ExportSceneEntityChange],
    options: ExportOptions,
) -> list[ExportSceneEntityChange]:
    """Drop details whose category the user turned off, then drop any
    entity entry whose details are entirely filtered away, so the
    block doesn't show an entity with nothing to say."""
    out: list[ExportSceneEntityChange] = []
    for change in changes:
        kept: list[ExportChangeDetail] = []
        for detail in change.details:
            if detail.category == "metadata" and not options.include_metadata_changes:
                continue
            if detail.category == "attribute" and not options.include_attribute_changes:
                continue
            if detail.category == "relationship" and not options.include_relationship_changes:
                continue
            kept.append(detail)
        if kept:
            out.append(ExportSceneEntityChange(
                entity_id=change.entity_id,
                entity_name=change.entity_name,
                entity_type=change.entity_type,
                profile_image_data_uri=change.profile_image_data_uri,
                details=kept,
            ))
    return out


def _render_scene_changes(
    changes: list[ExportSceneEntityChange],
    options: ExportOptions,
) -> str:
    """Render the 'Changes recorded here' footer block for a scene.
    One entry per entity with changes, each entry showing the entity
    name (as a link to its reference sheet with a hover popover) +
    type label, then a nested sub-list of specific change details."""
    link_to_sheet = options.include_entity_sheets
    use_colours = options.use_entity_colours
    parts: list[str] = []
    parts.append('<aside class="nn-scene-changes">')
    parts.append('<p class="nn-scene-changes-label">Changes recorded here</p>')
    parts.append('<ul class="nn-scene-changes-entities">')
    for change in changes:
        name_html = _render_entity_link(
            entity_id=change.entity_id,
            name=change.entity_name,
            profile_image_data_uri=change.profile_image_data_uri,
            link_to_sheet=link_to_sheet,
            colour=change.colour if use_colours else None,
        )
        parts.append('<li>')
        parts.append(
            '<div class="nn-scene-changes-entity-header">'
            f'{name_html} '
            f'<span class="nn-scene-changes-type">({html.escape(change.entity_type)})</span>'
            '</div>'
        )
        parts.append('<ul class="nn-scene-changes-details">')
        for detail in change.details:
            parts.append(_render_change_detail_html(detail))
        parts.append('</ul>')
        parts.append('</li>')
    parts.append('</ul>')
    parts.append('</aside>')
    return "\n".join(parts)


_CHANGE_ACTION_GLYPH = {"add": "✚", "modify": "✱", "remove": "⚊"}


def _render_change_detail_html(detail) -> str:
    """Render one ExportChangeDetail as a subchip-shaped `<li>` when
    the structured `action` / `field_name` fields are populated;
    falls back to the pre-formatted text for details that don't carry
    structured data (compound modifies, list ops, relationship change
    rows that aren't yet structured)."""
    cat_class = f"nn-scene-changes-{html.escape(detail.category)}"
    if detail.action and detail.field_name:
        action = detail.action
        glyph = _CHANGE_ACTION_GLYPH.get(action, "✱")
        field_html = html.escape(detail.field_name)
        # Value transition fragment — for modify with both old and
        # new, render `old → new`; for add/modify with new only,
        # render `: new`; for remove, render nothing.
        value_html = ""
        if detail.old_value is not None and detail.new_value is not None:
            value_html = (
                ' <span class="nn-change-old">"'
                f'{html.escape(detail.old_value)}'
                '"</span>'
                '<span class="nn-change-arrow">→</span>'
                f'<span class="nn-change-new">"{html.escape(detail.new_value)}"</span>'
            )
        elif detail.new_value is not None:
            value_html = (
                f' : <span class="nn-change-new">"{html.escape(detail.new_value)}"</span>'
            )
        # Profile-image replacement — embed the new image inline next
        # to the chip when the data URI is set.
        image_html = ""
        if detail.new_image_data_uri:
            image_html = (
                f'<span class="nn-change-image-wrap">'
                f'<img src="{html.escape(detail.new_image_data_uri)}" alt="new profile image" />'
                '</span>'
            )
        return (
            f'<li class="{cat_class}">'
            f'<span class="nn-change-subchip nn-change-subchip-{action}">'
            f'<span class="nn-change-glyph nn-change-glyph-{action}">{glyph}</span>'
            f'<span class="nn-change-field">{field_html}</span>'
            f'{value_html}'
            '</span>'
            f'{image_html}'
            '</li>'
        )
    # Fallback — text-only path, kept for compound modifies / list ops
    # that haven't been ported to the structured shape.
    return (
        f'<li class="{cat_class}">'
        f'{html.escape(detail.text)}'
        '</li>'
    )


# ── Appendices ─────────────────────────────────────────────────────────


def _render_offscreen_appendix(scenes: list[ExportScene], options: ExportOptions) -> str:
    parts: list[str] = []
    parts.append('<section class="nn-appendix">')
    parts.append("<h1>Off-screen Scenes</h1>")
    for scene in scenes:
        parts.append(_render_scene(scene, options))
    parts.append("</section>")
    return "\n".join(parts)


def _render_knowledge_sheets(
    sheets: list[ExportKnowledgeSheet],
    options: ExportOptions,
) -> str:
    """Phase 1.25c — Knowledge appendix. Rendered after entity sheets.
    Each entry is a small `<article>` mirroring the entity sheet shape:
    profile image (when set + embed_assets is on), name heading,
    description, source-event link line, optional chain history."""
    parts: list[str] = []
    parts.append('<section class="nn-appendix nn-appendix-knowledge">')
    parts.append("<h1>Knowledge</h1>")
    parts.append(
        '<p class="nn-appendix-note">'
        "Knowledges in this story — first-class lore objects parallel to "
        "entity reference sheets. Each entry shows the knowledge's origin "
        "state."
        "</p>"
    )
    for sheet in sheets:
        parts.append(_render_knowledge_sheet(sheet, options))
    parts.append("</section>")
    return "\n".join(parts)


def _render_knowledge_sheet(sheet: ExportKnowledgeSheet, options: ExportOptions) -> str:
    use_colour = bool(options.use_entity_colours and sheet.colour)
    colour_attr = html.escape(sheet.colour) if use_colour else ""
    img_style = f' style="border-color: {colour_attr}"' if use_colour else ""
    h2_style = f' style="color: {colour_attr}"' if use_colour else ""

    img_html = ""
    if sheet.profile_image_data_uri:
        img_html = f'<img src="{html.escape(sheet.profile_image_data_uri)}" alt=""{img_style}>'
    desc_html = _block_field_html(sheet.description, options, "nn-entity-description")
    source_html = ""
    if sheet.source_event_scene_id:
        # Source-event line links to the scene anchor when the scene
        # title is known; falls through to bare text otherwise.
        title = sheet.source_event_scene_title or "(scene)"
        scene_id = html.escape(sheet.source_event_scene_id)
        source_html = (
            '<p class="nn-knowledge-source">First established at: '
            f'<a href="#scene-{scene_id}">{html.escape(title)}</a>'
            '</p>'
        )
    notes_html = _notes_field_html(sheet.notes, options)
    history_html = ""
    if sheet.chain_history:
        rows = "".join(
            f'<li><span class="nn-knowledge-chain-kind">{html.escape(entry.kind)}</span> '
            f'— {html.escape(entry.text)}'
            + (
                f' <span class="nn-knowledge-chain-scene">@ '
                f'<a href="#scene-{html.escape(entry.scene_id)}">'
                f'{html.escape(entry.scene_title or "(scene)")}'
                f'</a></span>'
                if entry.scene_id else ""
            )
            + '</li>'
            for entry in sheet.chain_history
        )
        history_html = (
            '<div class="nn-knowledge-history">'
            '<p class="nn-knowledge-history-label">Chain history</p>'
            f'<ul>{rows}</ul>'
            '</div>'
        )
    return (
        f'<article class="nn-knowledge-sheet" id="knowledge-{html.escape(sheet.id)}">'
        f"{img_html}"
        '<div class="nn-entity-body">'
        f'<h2{h2_style}>{html.escape(sheet.name)}</h2>'
        '<p class="nn-entity-type">Knowledge</p>'
        f"{desc_html}"
        f"{source_html}"
        f"{notes_html}"
        f"{history_html}"
        "</div>"
        "</article>"
    )


def _render_entity_sheets(
    sheets: list[ExportEntitySheet],
    options: ExportOptions,
) -> str:
    parts: list[str] = []
    parts.append('<section class="nn-appendix">')
    parts.append("<h1>Entity Reference</h1>")
    # Clarifier note — the reference sheets show origin-state / library
    # definitions, NOT the end-of-chain or scene-specific state of each
    # entity. Any per-scene attribute / relationship / name changes are
    # recorded inline with their scenes in the main narrative above.
    # Without this note, a reader might mistake the reference sheets
    # for "final state" snapshots.
    parts.append(
        '<p class="nn-appendix-note">'
        "These reference sheets show each entity's "
        "<strong>origin state</strong> — their definition in the entity "
        "library, before any changes recorded at specific scenes. "
        "Per-scene modifications (attribute changes, relationship changes, "
        "renamings, etc.) are listed inline with their scenes in the main "
        "narrative above."
        "</p>"
    )
    for sheet in sheets:
        parts.append(_render_entity_sheet(sheet, options))
    parts.append("</section>")
    return "\n".join(parts)


def _render_entity_sheet(sheet: ExportEntitySheet, options: ExportOptions) -> str:
    # When per-entity colours are on and the sheet has a colour set,
    # use inline styles to colour the name heading and the profile
    # image border in the entity's own colour. Falls through to the
    # default CSS styling when either condition isn't met.
    use_colour = bool(options.use_entity_colours and sheet.colour)
    colour_attr = html.escape(sheet.colour) if use_colour else ""
    img_style = f' style="border-color: {colour_attr}"' if use_colour else ""
    h2_style = f' style="color: {colour_attr}"' if use_colour else ""

    img_html = ""
    if sheet.profile_image_data_uri:
        img_html = f'<img src="{html.escape(sheet.profile_image_data_uri)}" alt=""{img_style}>'
    aliases_html = ""
    if sheet.aliases:
        joined = " / ".join(html.escape(a) for a in sheet.aliases if a)
        if joined:
            aliases_html = (
                f'<p class="nn-entity-aliases">also: {joined}</p>'
            )
    desc_html = _block_field_html(sheet.description, options, "nn-entity-description")
    attr_html = ""
    if sheet.attributes:
        rows: list[str] = []
        for attr in sheet.attributes:
            rendered = _render_attribute_row(attr, options)
            if rendered:
                rows.append(rendered)
        if rows:
            attr_html = f"<dl>{''.join(rows)}</dl>"
    rel_html = _render_sheet_relationships(sheet.relationships, options) if sheet.relationships else ""
    notes_html = ""
    if options.include_entity_notes:
        notes_html = _notes_field_html(sheet.notes, options)
    # `id="entity-<id>"` anchor lets scene-level entity links navigate
    # straight to the reference sheet via `href="#entity-<id>"`.
    return (
        f'<article class="nn-entity-sheet" id="entity-{html.escape(sheet.id)}">'
        f"{img_html}"
        '<div class="nn-entity-body">'
        f'<h2{h2_style}>{html.escape(sheet.name)}</h2>'
        f'<p class="nn-entity-type">{html.escape(sheet.type)}</p>'
        f"{aliases_html}"
        f"{desc_html}"
        f"{attr_html}"
        f"{rel_html}"
        f"{notes_html}"
        "</div>"
        "</article>"
    )


def _render_sheet_relationships(
    relationships: list[ExportEntityRelationship],
    options: ExportOptions,
) -> str:
    """Render the origin-state relationships block on an entity
    reference sheet. One row per relationship showing the relationship
    label (as a link when there is a single other participant) and the
    owner's perception text if present."""
    use_colours = options.use_entity_colours
    parts: list[str] = []
    parts.append('<div class="nn-entity-relationships">')
    parts.append('<p class="nn-entity-relationships-label">Relationships</p>')
    parts.append('<ul>')
    for rel in relationships:
        # For a two-party relationship (exactly one other participant),
        # render the label as a linked entity ref with hover popover.
        # For N-party relationships (zero or 2+ other participants),
        # render the label as plain text — there is no single link target.
        if len(rel.other_participants) == 1:
            p = rel.other_participants[0]
            label_html = _render_entity_link(
                entity_id=p.entity_id,
                name=rel.display_label,
                profile_image_data_uri=p.profile_image_data_uri,
                link_to_sheet=True,
                colour=p.entity_colour if use_colours else None,
            )
        else:
            label_html = html.escape(rel.display_label or "(unnamed)")
        parts.append('<li>')
        flag_bits: list[str] = []
        if rel.is_membership:
            flag_bits.append('<span class="nn-entity-relationship-flag">membership</span>')
        if rel.has_hierarchy:
            flag_bits.append('<span class="nn-entity-relationship-flag">hierarchy</span>')
        flag_html = " " + " ".join(flag_bits) if flag_bits else ""
        parts.append(
            f'<div class="nn-entity-relationship-header">'
            f'{label_html}{flag_html}'
            '</div>'
        )
        if rel.description:
            parts.append(
                f'<p class="nn-entity-relationship-desc">'
                f'{_inline_field(rel.description, options)}'
                '</p>'
            )
        if rel.own_role:
            parts.append(
                f'<p class="nn-entity-relationship-role">'
                f'Role: {html.escape(rel.own_role)}'
                '</p>'
            )
        if rel.own_perception:
            parts.append(
                f'<p class="nn-entity-relationship-perception">'
                f'{_inline_field(rel.own_perception, options)}'
                '</p>'
            )
        parts.append('</li>')
    parts.append('</ul>')
    parts.append('</div>')
    return "\n".join(parts)


def _render_attribute_row(attr: ExportAttribute, options: ExportOptions) -> str:
    """Render one attribute row in the entity reference sheet grid.
    File-type attributes branch on `media_kind` to pick the right
    element (<img> / <audio> / <video>) and consult the granular
    media toggles to decide whether to embed the media at all.

    Returns empty string if the attribute should be skipped entirely
    (e.g., audio attribute with audio embedding turned off produces
    an empty row — less noisy than a dead placeholder).
    """
    name = html.escape(attr.name)

    if attr.attribute_type == "file":
        if not attr.file_ref_data_uri:
            return f"<dt>{name}</dt><dd><em>no file</em></dd>"
        # Parent media toggle short-circuits all file-type rendering
        # when off — the attribute still appears but without the
        # embedded media.
        if not options.include_media_attributes:
            return f"<dt>{name}</dt><dd><em>file attribute (embedding disabled)</em></dd>"
        kind = attr.media_kind
        if kind == "image" and options.include_media_attribute_images:
            return (
                f"<dt>{name}</dt>"
                f'<dd><img src="{html.escape(attr.file_ref_data_uri)}" alt="" '
                'style="max-width: 320px; max-height: 240px; height: auto; border: 1px solid var(--border); border-radius: 2px;"></dd>'
            )
        if kind == "audio" and options.include_media_attribute_audio:
            return (
                f"<dt>{name}</dt>"
                f'<dd><audio controls src="{html.escape(attr.file_ref_data_uri)}" '
                'style="max-width: 320px;"></audio></dd>'
            )
        if kind == "video" and options.include_media_attribute_video:
            return (
                f"<dt>{name}</dt>"
                f'<dd><video controls src="{html.escape(attr.file_ref_data_uri)}" '
                'style="max-width: 320px; max-height: 240px; border: 1px solid var(--border); border-radius: 2px;"></video></dd>'
            )
        # Toggle off for this kind — show a placeholder row so the
        # user still sees the attribute exists.
        kind_label = kind or "file"
        return f"<dt>{name}</dt><dd><em>{html.escape(kind_label)} attribute (embedding disabled)</em></dd>"

    if attr.attribute_type in ("text_list", "entity_list"):
        # Value is JSON-encoded list of strings; keep the raw JSON for now
        # since we don't have the entity name resolution cached here.
        return f"<dt>{name}</dt><dd>{html.escape(attr.value)}</dd>"
    if attr.attribute_type == "perspective":
        # Phase 5.8b — a first-person view on another object. Body in
        # `description` (inline markdown when enabled), target resolved to a
        # display name by the walker.
        body = _inline_field(attr.description, options)
        target = html.escape(attr.perspective_target or "")
        if target and body:
            inner = f"Perspective on {target}: {body}"
        elif target:
            inner = f"Perspective on {target}"
        elif body:
            inner = body
        else:
            inner = "<em>empty</em>"
        return f"<dt>{name}</dt><dd>{inner}</dd>"
    raw = attr.value or ""
    if options.render_markdown_in_text_fields and raw.strip():
        if is_block_markdown(raw):
            return f"<dt>{name}</dt><dd>{field_markdown_to_html(raw)}</dd>"
        return f"<dt>{name}</dt><dd>{field_markdown_to_inline_html(raw)}</dd>"
    return f"<dt>{name}</dt><dd>{html.escape(raw or '—')}</dd>"


# ── Registry binding ───────────────────────────────────────────────────
#
# `render_html` returns a str for historic reasons; the registry's
# uniform interface is `bytes`, so this thin wrapper encodes as UTF-8
# at the boundary.


def render(model: ExportModel, options: Optional[ExportOptions] = None) -> bytes:
    return render_html(model, options).encode("utf-8")


SPEC = RendererSpec(
    format_id="html",
    label="HTML",
    extension="html",
    mime_type="text/html; charset=utf-8",
    render=render,
    capabilities=frozenset({
        # HTML embeds profile images on entity reference sheets via
        # base64 data URIs when `embed_assets` is on.
        "embedded_assets",
        # HTML embeds image / audio / video file attributes inline via
        # <img> / <audio> / <video> tags when the media toggles are on.
        "embedded_media",
        # HTML links entity mentions to `#entity-{id}` anchors on the
        # reference-sheet appendix.
        "entity_links",
        # HTML applies inline `style="color: ..."` to entity name
        # spans when `use_entity_colours` is on, using per-entity
        # colour fields on ExportSceneEntityEntry / Change /
        # EntityRelationship / EntitySheet. Entity sheet H2 and
        # profile image border also adopt the entity's colour.
        "entity_colours",
    }),
)
register(SPEC)
