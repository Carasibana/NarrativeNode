/**
 * Shared TipTap-HTML → markdown converter.
 *
 * Quick-and-dirty regex pipeline: enough to give the AI a readable
 * surface for any TipTap-edited body (scene main_content, Context
 * Cue body, etc.). Preserves paragraph breaks and list bullets,
 * decodes the common HTML entities, collapses runs of blank lines,
 * and otherwise strips tags wholesale.
 *
 * Originally lived inline in `storyScopeBundleBuilder.js`; lifted
 * out because Context Cues need the same conversion at chat-send
 * time and a single source of truth keeps the wire shape consistent
 * between scene context and cue context.
 *
 * When a richer dedicated converter ships (handles bold / italic /
 * links / code blocks / etc. with proper markdown syntax), swap the
 * body of this function — every caller picks up the upgrade for
 * free.
 */
export function tiptapHtmlToMarkdown(html) {
  if (!html) return ''
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Strip all HTML to plain text, no markdown formatting. Used for
 * one-line previews (cue list rows, etc.) where we just want a
 * collapsed glance at the body.
 */
export function tiptapHtmlToPlain(html) {
  if (!html) return ''
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}
