/**
 * markdownToTiptapHtml — convert a markdown string to TipTap-compatible
 * HTML for the Apply to Editor Section path (Phase 2.9b items 4 + 5).
 *
 * Chat messages from the LLM are stored as raw markdown strings (e.g.
 * `**bold** hello\n\n- one\n- two`). When the writer applies a message
 * (or excerpt) to a Section, we need to convert that markdown into
 * HTML so TipTap can parse it via its existing schema mapping —
 * TipTap doesn't natively parse markdown.
 *
 * Implementation: thin wrapper around `marked` (MIT, see
 * THIRD_PARTY_LICENSES/marked.txt) chained into
 * `sanitizeHtmlForTiptap` (DOMPurify allow-list, Apache-2.0). The
 * sanitiser runs unconditionally so every caller — Apply to Section,
 * Inline Prompt Block, future Novelcrafter prose import,
 * anything-else-yet-unbuilt — gets the same safe output without
 * per-call discipline.
 *
 * Threat model: `marked.parse` passes inline HTML through unchanged.
 * If an LLM ever emits a `<script>` tag or an `onerror` attribute in
 * a chat message and the writer Applies that message into a Section,
 * the unsanitised path would persist the payload inside
 * `SceneNode.main_content` — which is re-emitted by every export
 * renderer (HTML / DOCX / PDF / Markdown / NovelCrafter-MD /
 * NovelCrafter-DOCX). Sanitising at the conversion boundary closes
 * that surface area in one place. See `sanitizeHtmlForTiptap.js` for
 * the allow-list rationale.
 *
 * Configured with GFM enabled (matches the chat panel's Streamdown
 * which bundles remark-gfm). Synchronous API — `marked.parse(md)`
 * returns the HTML string.
 *
 * Caller is responsible for plain-text coercion when the Apply target
 * is the Scene Description Section (Phase 2.9b item 6 / 2.9d). This
 * util does NOT coerce — it converts markdown to TipTap-safe HTML.
 */

import { marked } from 'marked'
import { sanitizeHtmlForTiptap } from './sanitizeHtmlForTiptap'

// Configure marked once at module load. GFM extensions (tables, task
// lists, strikethrough, autolinks) align with Streamdown's defaults.
// `breaks: false` matches CommonMark — soft newlines collapse to a
// space inside a paragraph, hard newlines are double-newline. The
// chat AI almost always uses double-newline for paragraph breaks
// (matches LLM markdown convention), so this is the right default.
marked.use({
  gfm: true,
  breaks: false,
})

/**
 * Convert a markdown string to HTML suitable for TipTap's
 * `setContent` / `insertContent` / static HTML storage.
 *
 * @param {string} md  — the raw markdown string (chat message content
 *                        or a selected excerpt of it).
 * @returns {string}  — HTML string. Empty string when `md` is falsy.
 */
export function markdownToTiptapHtml(md) {
  if (!md || typeof md !== 'string') return ''
  const html = marked.parse(md.trim())
  // `marked.parse` is synchronous when `async: false` (the default in
  // v15+); the return value is a string.
  if (typeof html !== 'string') return ''
  // DOMPurify allow-list scrub before the HTML reaches any caller.
  // The util's contract is "safe TipTap HTML", not "faithful HTML";
  // see header docstring for the threat-model rationale.
  return sanitizeHtmlForTiptap(html.trim())
}
