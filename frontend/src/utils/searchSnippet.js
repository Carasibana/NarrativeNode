/**
 * Snippet renderer for the Phase 1.24d global-search modal.
 *
 * Given a plain-text body and the offset / length of a single match
 * inside it, returns a window of context centred on the match plus
 * the match itself, ready for the result row to render as
 *
 *     {before}<mark>{match}</mark>{after}{additionalCount > 0 && "+N more"}
 *
 * The window targets `contextChars` total characters split roughly
 * evenly before / after the match. Trims to word boundaries when
 * possible so we don't slice a word in half. Adds an ellipsis prefix
 * / suffix when the window is truncated on that side.
 *
 * `additionalCount` is a passthrough — callers who already know how
 * many further match offsets exist for the same field provide it
 * here so the consumer can render the "+N more" badge alongside.
 *
 * Pure function. No DOM, no globals.
 */
export function buildSnippet(plainText, matchOffset, matchLength, contextChars = 120, additionalCount = 0) {
  const empty = { before: '', match: '', after: '', additionalCount }
  if (!plainText || typeof plainText !== 'string') return empty
  if (matchOffset == null || matchLength == null) return empty
  const len = plainText.length
  const start = Math.max(0, Math.min(matchOffset, len))
  const end = Math.max(start, Math.min(matchOffset + matchLength, len))
  const matchStr = plainText.slice(start, end)
  // Half the context budget on each side; integer-floor so a 120-char
  // window splits as 60/60.
  const halfBudget = Math.max(0, Math.floor(contextChars / 2))
  let beforeStart = Math.max(0, start - halfBudget)
  let afterEnd = Math.min(len, end + halfBudget)

  // Word-boundary trim on the LEFT: if we sliced into the middle of a
  // word, walk forward to the next whitespace so the snippet starts
  // at a word boundary.
  if (beforeStart > 0) {
    while (beforeStart < start && !/\s/.test(plainText[beforeStart - 1])) {
      beforeStart += 1
    }
  }
  // Word-boundary trim on the RIGHT: walk back to the previous
  // whitespace if we sliced through a word.
  if (afterEnd < len) {
    while (afterEnd > end && !/\s/.test(plainText[afterEnd])) {
      afterEnd -= 1
    }
  }

  const beforeRaw = plainText.slice(beforeStart, start)
  const afterRaw = plainText.slice(end, afterEnd)
  const beforeEllipsis = beforeStart > 0 ? '…' : ''
  const afterEllipsis = afterEnd < len ? '…' : ''
  return {
    before: `${beforeEllipsis}${beforeRaw}`,
    match: matchStr,
    after: `${afterRaw}${afterEllipsis}`,
    additionalCount,
  }
}
