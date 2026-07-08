"""Phase 5.8b — render markdown found in free-form export text fields.

Free-form text fields (entity / relationship / knowledge descriptions,
text-type attribute values, notes, circumstance / motivator / perspective
bodies, scene descriptions) may contain markdown the writer typed. When the
``render_markdown_in_text_fields`` export option is on, those fields are
converted to HTML here and fed through each renderer's existing
HTML-to-format parser (the same path scene prose uses); the Markdown export
passes them through unchanged and the plain-text export strips the markers.

Uses markdown-it-py, the Python port of markdown-it (the same
CommonMark / GFM family as the frontend's ``marked``), so export rendering
matches the in-app rendering of these fields. The configuration is
restricted to the decided feature set — bold, italic, strikethrough,
inline code, links, headings, lists, blockquotes (plus code blocks /
horizontal rules / hard breaks that CommonMark implies) — and deliberately
omits tables, since the renderers' HTML parsers only understand the TipTap
StarterKit element set.
"""
import re

from markdown_it import MarkdownIt

# CommonMark core (bold / italic / inline code / links / headings / lists /
# blockquotes / code blocks / paragraphs) plus GFM strikethrough. No tables
# or auto-linkify, which the downstream HTML parsers don't handle.
_MD = MarkdownIt("commonmark").enable("strikethrough")

# Block-level tags that mean a value can't be rendered inline on its label's
# line and must flow as its own block instead.
_BLOCK_TAG_RE = re.compile(r"<(?:h[1-6]|ul|ol|blockquote|pre|hr|table)\b", re.I)


def field_markdown_to_html(text: str) -> str:
    """Render a free-form field's markdown to block HTML. Empty / blank
    input returns an empty string. Never raises — on any parser error the
    raw text is returned escaped in a paragraph so the field still appears."""
    if not text or not text.strip():
        return ""
    try:
        return _MD.render(text)
    except Exception:
        import html as _html
        return f"<p>{_html.escape(text)}</p>"


def field_markdown_to_inline_html(text: str) -> str:
    """Render a field's markdown as INLINE HTML (no block wrappers) — for
    short values that sit on their label's line. Produces only inline tags
    (strong / em / s / code / a). Empty / blank input returns ""."""
    if not text or not text.strip():
        return ""
    try:
        return _MD.renderInline(text.strip())
    except Exception:
        import html as _html
        return _html.escape(text.strip())


def is_block_markdown(text: str) -> bool:
    """True when a value's markdown carries block structure (headings,
    lists, blockquotes, code fences, or more than one paragraph) and so
    should render as its own block under the label rather than inline on
    the label's line. False for a single line of inline content."""
    inner = (text or "").strip()
    if not inner:
        return False
    html_out = _MD.render(inner)
    if _BLOCK_TAG_RE.search(html_out):
        return True
    return html_out.count("<p") > 1
