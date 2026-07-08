/**
 * Phase 2.7a — shared attach-to-chat glyph.
 *
 * One SVG glyph used by every "add as context" affordance across
 * the program (drop-zone overlay copy, detail-panel header button,
 * canvas-node corner button, scene-chip corner button). Visual
 * consistency across surfaces is what makes the affordance
 * recognisable.
 *
 * Glyph design: the chat-tab speech bubble (same path used by
 * `ChatToggleCorner`) with a coloured annotation badge in the
 * lower-right corner.
 *
 *   - `mode='add'`     → bold green "+"  (item not yet pinned).
 *   - `mode='remove'`  → bold red  "−"   (item is currently pinned;
 *                                          click to unpin).
 *
 * The bubble + content lines stay `currentColor` so they pick up
 * the surrounding text style; only the corner annotation carries
 * the mode-specific colour, since that's the part the writer reads
 * to decide what the click will do.
 *
 * `size` prop maps to the renderer's pixel width / height. The
 * chip-corner constraint is the tightest size in the system
 * (~10-12px), and the bigger surfaces (detail-panel header, canvas-
 * node corner) use the same component at 14-16px. One canonical
 * shape; the size just scales.
 */
function AttachToChatGlyph({ size = 14, className = '', title, mode = 'add' }) {
  const annotationColour = mode === 'remove' ? '#ef4444' : '#22c55e' // red-500 / green-500
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      {/* Speech bubble + interior content lines — matches the chat
          tab's glyph byte-for-byte so the writer reads this as "the
          chat icon" at a glance. Content lines stop short on the
          right to leave a clean corner for the annotation badge. */}
      <path d="M6 4 H18 A4 4 0 0 1 22 8 V12 A4 4 0 0 1 18 16 H11 L7 20 L8 16 H6 A4 4 0 0 1 2 12 V8 A4 4 0 0 1 6 4 Z" />
      <line x1="6" y1="9" x2="14" y2="9" />
      <line x1="6" y1="13" x2="12" y2="13" />
      {/* Bold annotation badge in the lower-right. Thicker stroke
          than the bubble so it reads as an annotation rather than
          another bubble detail; the chat-tab corner is empty (the
          bubble's tail points the other way) so the badge sits in
          clean space. Vertical stroke renders only in add mode so
          the "+" becomes a "−" in remove mode. */}
      {mode === 'add' && (
        <line x1="19" y1="17" x2="19" y2="22" strokeWidth="3" stroke={annotationColour} />
      )}
      <line x1="16.5" y1="19.5" x2="21.5" y2="19.5" strokeWidth="3" stroke={annotationColour} />
    </svg>
  )
}

export default AttachToChatGlyph
