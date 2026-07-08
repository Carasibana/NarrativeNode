/**
 * Phase 1.24c — Find / Replace utilities for the right-sidebar TipTap editor.
 *
 * Pure helpers (no React, no editor state mutation) that walk a
 * ProseMirror document and produce match ranges for a given query.
 * Mutation (selection, replacement) lives in the panel component
 * which holds the live editor instance.
 *
 * Match shape:
 *   { from: number, to: number, text: string }
 *
 * Positions are ABSOLUTE document positions, suitable to feed to
 * `editor.commands.setTextSelection({ from, to })` and
 * `editor.commands.insertContentAt({ from, to }, replacement)`.
 */

/**
 * Escape a string so it can be used as a literal inside a RegExp.
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build the RegExp object for the given query + options.
 *
 *   matchCase  — when false, the regex is case-insensitive (i flag).
 *   wholeWord  — when true, matches must be bracketed by word
 *                boundaries (\b).
 *
 * Returns null when the query is empty or only whitespace.
 */
export function buildSearchRegExp(query, { matchCase = false, wholeWord = false } = {}) {
  if (!query || !query.trim()) return null
  const escaped = escapeRegExp(query)
  const body = wholeWord ? `\\b${escaped}\\b` : escaped
  const flags = matchCase ? 'g' : 'gi'
  try {
    return new RegExp(body, flags)
  } catch {
    return null
  }
}

/**
 * Strip HTML tags from a stored `main_content` string and return the
 * plain text. Used by the All Scenes match counter — counting on
 * plain text is cheap and accurate; mapping back to ProseMirror
 * positions for iteration is left to the per-scene editor instance
 * when the writer steps into that scene.
 */
function htmlToPlainText(html) {
  if (!html || typeof html !== 'string') return ''
  // DOMParser handles entities + nested elements correctly without
  // running the content as live DOM (no script execution).
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return doc.body?.textContent || ''
}

/**
 * Count matches for `query` inside a stored `main_content` HTML
 * string. Pure plain-text count via the shared regex; doesn't try
 * to map to ProseMirror positions.
 */
export function countMatchesInHtml(html, query, opts = {}) {
  const re = buildSearchRegExp(query, opts)
  if (!re) return 0
  const text = htmlToPlainText(html)
  if (!text) return 0
  let count = 0
  re.lastIndex = 0
  let m
  while ((m = re.exec(text)) !== null) {
    count++
    if (m.index === re.lastIndex) re.lastIndex += 1
  }
  return count
}

/**
 * Aggregate match counts across an ordered list of scenes.
 *
 * Input:
 *   scenes — array of `{ sceneId, html, title? }` in story order.
 *   query / opts — same as the per-doc / per-html helpers above.
 *
 * Returns:
 *   {
 *     totalMatches: number,
 *     sceneCount: number (scenes that have at least one match),
 *     perScene: Array<{ sceneId, title, count }> in input order,
 *               only entries with count > 0.
 *   }
 */
export function countMatchesAcrossScenes(scenes, query, opts = {}) {
  const result = { totalMatches: 0, sceneCount: 0, perScene: [] }
  if (!Array.isArray(scenes) || !scenes.length) return result
  const re = buildSearchRegExp(query, opts)
  if (!re) return result
  for (const s of scenes) {
    const count = countMatchesInHtml(s.html, query, opts)
    if (count > 0) {
      result.totalMatches += count
      result.sceneCount += 1
      result.perScene.push({ sceneId: s.sceneId, title: s.title || '', count })
    }
  }
  return result
}

/**
 * Replace every match for `query` inside a stored `main_content` HTML
 * string. Walks the parsed DOM tree's text nodes only, so attribute
 * values (alt, href, etc.), tag names, and HTML entities outside text
 * are never touched. Returns the rewritten HTML plus a count of how
 * many matches were replaced.
 *
 * Used by the cross-scene Replace-all path (the in-editor open scene
 * uses TipTap's transaction chain instead, which preserves marks at
 * the replacement position; this helper operates on stored HTML for
 * scenes that aren't currently loaded into the editor).
 *
 * Returns `{ html, replaced }`. If the query is empty, the regex
 * fails to build, or the input is empty, `replaced = 0` and `html`
 * is the unchanged input.
 */
export function replaceMatchesInHtml(html, query, replacement, opts = {}) {
  if (!html || typeof html !== 'string') return { html: html || '', replaced: 0 }
  const re = buildSearchRegExp(query, opts)
  if (!re) return { html, replaced: 0 }
  const repl = replacement == null ? '' : String(replacement)
  // Wrap the input so DOMParser preserves multiple top-level nodes
  // and so we can read the rewritten string off `wrapper.innerHTML`.
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<div id="__nn_wrap__">${html}</div>`, 'text/html')
  const wrapper = doc.getElementById('__nn_wrap__')
  if (!wrapper) return { html, replaced: 0 }
  let replaced = 0
  const walker = doc.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT, null)
  const textNodes = []
  let n
  while ((n = walker.nextNode())) textNodes.push(n)
  for (const tn of textNodes) {
    const original = tn.nodeValue
    if (!original) continue
    re.lastIndex = 0
    const next = original.replace(re, () => {
      replaced += 1
      return repl
    })
    if (next !== original) tn.nodeValue = next
  }
  return { html: wrapper.innerHTML, replaced }
}

/**
 * Walk the doc and return every match for `query`.
 *
 * Iterates text nodes via `doc.descendants`. For each text node, runs
 * the regex repeatedly via `exec` to collect every match's range,
 * mapping back to absolute document positions.
 *
 * Returns an empty array when the regex couldn't be built (empty
 * query) or the doc has no matches.
 */
export function findMatchesInDoc(doc, query, opts = {}) {
  const re = buildSearchRegExp(query, opts)
  if (!re || !doc) return []
  const matches = []
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    const text = node.text || ''
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      const from = pos + m.index
      const to = from + m[0].length
      matches.push({ from, to, text: m[0] })
      // Guard against zero-length matches turning into an infinite loop.
      if (m.index === re.lastIndex) re.lastIndex += 1
    }
    return true
  })
  return matches
}
