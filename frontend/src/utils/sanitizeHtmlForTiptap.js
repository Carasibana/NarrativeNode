/**
 * sanitizeHtmlForTiptap — defence-in-depth HTML sanitization for any
 * user-provided HTML that will be written into TipTap content.
 *
 * Why this exists (Phase 3.6 — Novelcrafter prose import):
 *
 * The Novelcrafter import flow lands HTML inside `SceneNode.main_content`.
 * That field is re-emitted by every downstream surface — canvas
 * preview, right-sidebar editor, every export renderer (HTML / DOCX
 * / PDF / Markdown / NovelCrafter-MD / NovelCrafter-DOCX). A
 * malicious `<script>` or event-handler attribute that survives
 * import would persist across that entire surface area, with
 * potential for code execution any time the content is rendered
 * outside TipTap's safe parse layer.
 *
 * TipTap's own schema-based parse drops unknown nodes during
 * `setContent` / `insertContent`, but that is NOT a security boundary
 * — it is a content-shape filter. Attribute-level event handlers can
 * survive on allowed nodes, and any subsequent code path that
 * stringifies the TipTap document and re-renders the HTML through
 * `innerHTML` or `dangerouslySetInnerHTML` would re-introduce the
 * payload. Sanitization at the boundary closes that gap.
 *
 * The util is intentionally generic: any feature that writes
 * user-provided HTML into TipTap should route through it. Primary
 * consumer is the NC prose import commit handler; secondary
 * consumer is the chat-panel Apply-to-Editor-Section flow (closes
 * the parallel risk on AI-generated chat content).
 *
 * Allow-list rationale:
 *
 *   - Block-level structural tags TipTap renders natively:
 *     `h1`–`h6`, `p`, `blockquote`, `pre`, `ul`, `ol`, `li`, `hr`,
 *     `div` (used by TipTap section / prompt-block extensions).
 *   - Inline marks TipTap's StarterKit renders: `strong`, `em`, `u`,
 *     `s`, `code`, `br`, `span`.
 *   - Link + image: `a` (with `href` restricted to http/https/mailto
 *     — `javascript:` and `data:` URLs are blocked because they are
 *     the canonical attribute-based XSS vectors), `img` (with `src`
 *     restricted to http/https — `data:` URLs blocked because SVG
 *     payloads can carry embedded scripts).
 *
 *   - Explicitly forbidden tags: `<script>`, `<style>`, `<iframe>`,
 *     `<object>`, `<embed>`, `<svg>`, `<math>`, `<form>`, `<input>`,
 *     `<button>`, `<link>`, `<meta>`, `<base>`. SVG is forbidden
 *     wholesale (SVG-with-embedded-script is a classic XSS vector
 *     and NN has no use case for inline SVG in prose).
 *   - All `on*` event-handler attributes stripped (the DOMPurify
 *     default; explicit here for clarity).
 *
 * Returns the empty string for falsy / non-string input.
 */

import DOMPurify from 'dompurify'

// Sanitizer config. DOMPurify mutates its return when given an
// `IN_PLACE: false` (default) string input, so this object is
// reused for every call without risk.
const _CONFIG = {
  // Allow-list of HTML tags. Anything not in this list is dropped
  // (not escaped — the tag is removed and the inner content is
  // preserved by default per `KEEP_CONTENT: true`, which keeps
  // legitimate text inside forbidden wrappers visible).
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p',
    // Inline marks: `s` is TipTap's strikethrough; `del` is GFM-marked's
    // strikethrough output — keep both so chat MD that uses `~~foo~~`
    // round-trips through `markdownToTiptapHtml` without losing the
    // strikethrough. TipTap will drop `<del>` at parse if its schema
    // doesn't render it, but DOMPurify shouldn't strip it pre-parse.
    'strong', 'em', 'u', 's', 'del', 'code', 'pre',
    // `mark` — used by the Highlight extension configured on every
    // NN editor (`@tiptap/extension-highlight`). Required for highlight
    // round-trip.
    'mark',
    'blockquote',
    'ul', 'ol', 'li',
    'a',
    'hr', 'br',
    'img',
    'span', 'div',
  ],
  // Allow-list of attributes. Anything not in this list is stripped.
  // `class` is needed by TipTap's section / prompt-block extensions
  // to mark their wrapper nodes; without it, NN-produced HTML
  // round-trips lossily.
  ALLOWED_ATTR: [
    'href',     // <a>
    'src', 'alt',  // <img>
    'class',
  ],
  // URL schemes allowed in href / src. `javascript:` is the canonical
  // XSS vector (executes script on click / load). `data:` is the
  // common second vector (data:image/svg+xml;base64,... can carry
  // arbitrary script). Restricting to http/https/mailto closes both.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  // Belt-and-braces: explicitly forbid the dangerous tag set even
  // though omitting them from ALLOWED_TAGS already drops them.
  // Documents intent for anyone reading the config.
  FORBID_TAGS: [
    'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math',
    'form', 'input', 'button', 'link', 'meta', 'base',
  ],
  // Strip every event handler attribute (`onclick`, `onerror`,
  // `onload`, etc.). DOMPurify does this by default; explicit here.
  FORBID_ATTR: [],
  // Preserve text inside dropped tags so writer-typed prose nested
  // inside a forbidden wrapper isn't lost on import. The wrapper
  // tag is removed; its text children survive as text nodes.
  KEEP_CONTENT: true,
}

/**
 * Sanitize `html` for safe insertion into a TipTap editor.
 *
 * @param {string} html  — the input HTML string. Typically the
 *                          output of `markdownToTiptapHtml` (for MD
 *                          import) or raw HTML from an `.html` /
 *                          `.docx`-derived NC bundle.
 * @returns {string}     — the sanitized HTML string. Empty string
 *                          when `html` is falsy or non-string.
 */
export function sanitizeHtmlForTiptap(html) {
  if (!html || typeof html !== 'string') return ''
  return DOMPurify.sanitize(html, _CONFIG)
}
