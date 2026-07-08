/**
 * Animated 4-column × 3-row dot equalizer for the Media Preview tray chip.
 *
 * Purely decorative — does not read real audio levels. Each column has 3 dots
 * (bottom, mid, top). The bottom dot is always lit while playing. Mid and top
 * dots animate with staggered per-column delays to suggest oscillation. When
 * paused, no animation runs and all dots sit at a dimmed flat level so the
 * indicator remains visible without implying playback.
 *
 * Colour is driven by the parent's CSS `color` (set via inline `style` here)
 * so the equalizer tints to the accent hue of the chip it's embedded in.
 *
 * Props:
 *   playing — boolean; true while media is actively playing
 *   colour  — CSS colour string; defaults to the app accent colour variable
 */
export default function EqualizerIndicator({ playing, colour }) {
  const stateClass = playing ? 'eq-playing' : 'eq-paused'
  return (
    <span
      className={`inline-flex items-end gap-[2px] ${stateClass}`}
      style={{ color: colour || 'var(--color-accent-400)', width: 14, height: 10 }}
      aria-hidden="true"
      data-help-region="badge:equalizer_indicator"
    >
      {[0, 1, 2, 3].map((colIdx) => {
        const delay = `${colIdx * 0.15}s`
        return (
          <span key={colIdx} className="flex flex-col-reverse gap-[1px]">
            <span className="eq-dot eq-dot-bot" />
            <span className="eq-dot eq-dot-mid" style={{ animationDelay: delay }} />
            <span className="eq-dot eq-dot-top" style={{ animationDelay: delay }} />
          </span>
        )
      })}
    </span>
  )
}
