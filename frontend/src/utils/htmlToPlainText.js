/**
 * Convert a TipTap-authored HTML string into a single plain-text
 * blob suitable for substring matching and snippet rendering.
 *
 * Pure function. Walks text nodes via `DOMParser` + `TreeWalker`;
 * never regex-strips tags (which would mangle attribute values that
 * contain `<` / `>`, drop entity-decoded characters, and chew
 * through nested markup unpredictably).
 *
 * Adjacent text nodes are joined with a single space and then runs
 * of whitespace are collapsed, so the output reads as one continuous
 * paragraph regardless of the source document's block structure.
 * That's the right shape for substring search — we don't want match
 * positions to depend on which paragraph wrapping happened to be in
 * the HTML.
 *
 * Returns an empty string for null / non-string / empty inputs, and
 * for environments without `DOMParser` (the helper is import-safe in
 * SSR contexts; it just returns "" in that case rather than throwing).
 */
export function htmlToPlainText(html) {
  if (!html || typeof html !== 'string') return ''
  if (typeof DOMParser === 'undefined') return ''
  const doc = new DOMParser().parseFromString(html, 'text/html')
  if (!doc?.body) return ''
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null)
  const parts = []
  let node
  while ((node = walker.nextNode())) {
    const text = node.nodeValue
    if (text && text.trim()) parts.push(text)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}
