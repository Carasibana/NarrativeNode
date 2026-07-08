import { useAccentColor } from '../../utils/povConstants'

/**
 * Shared pin toggle for floating panels (Table of Contents, Timeline
 * Navigator, etc). When active, the panel's click-outside-to-close
 * behaviour should be gated by the caller on `!isPinned`. Panels remain
 * closable via Escape and their own toolbar toggle regardless of pin
 * state.
 *
 * Active state is communicated by an accent-coloured background + border;
 * the 📍︎ glyph (U+1F4CD U+FE0E — round pushpin with the text variation
 * selector for upright monochrome rendering) stays the same in both
 * states. Accent colour tracks the current story's `accent_color` via
 * `useAccentColor`.
 *
 * Props:
 *   isPinned — bool; current pin state (caller manages persistence)
 *   onToggle — () => void; fires on click
 *   title    — optional; hover tooltip (defaults describe each state)
 */
export default function PinButton({ isPinned, onToggle, title }) {
  const accent = useAccentColor()
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={isPinned}
      data-help-region="pin-button:button"
      style={{
        background: isPinned ? accent : 'transparent',
        border: '1px solid',
        borderColor: isPinned ? accent : 'transparent',
        borderRadius: 3,
        color: isPinned ? '#fafafa' : '#71717a',
        cursor: 'pointer',
        fontSize: 12,
        lineHeight: 1,
        padding: '2px 5px',
        transition: 'all 120ms',
      }}
      title={title || (isPinned
        ? 'Pinned — clicks outside the panel won\'t close it. Click to unpin.'
        : 'Pin panel open (clicks outside won\'t close it)')}
    >
      {'📍︎'}
    </button>
  )
}
