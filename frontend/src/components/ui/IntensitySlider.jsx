import { useRef, useState, useCallback } from 'react'
import { IntensityBadge, INTENSITY_LABELS, INTENSITY_COLOURS } from './IntensityBadge'

/**
 * Phase 1.22d — Intensity slider for Circumstance / Motivator forms.
 *
 * Layout (two stacked rows so it always fits a narrow sidebar):
 *
 *   Row 1: [INTENSITY label] [animated current-state IntensityBadge]
 *          [text label e.g. "Strong" / "Unset"]  [optional ✕ unset btn]
 *
 *   Row 2: a custom horizontal slider —
 *     - track line (zinc-700) spanning the row
 *     - accent-coloured fill from the left edge to the current thumb
 *       position (width grows as you drag right)
 *     - 5 fixed dots positioned at evenly-spaced points along the
 *       track, each rendered as the IntensityBadge for that level
 *     - a draggable circle thumb sitting at the current position;
 *       the thumb sits on top of (and overlays) the dot at that
 *       position. Drag = move thumb to nearest dot. Click on any
 *       dot = jump to that level.
 *
 * Behaviour:
 *   - `level` prop is the current intensity (0-4) or null (unset).
 *   - When unset, no thumb shows and no fill bar shows; clicking any
 *     dot or dragging the thumb area sets the level for the first
 *     time. The Row 1 ✕ button clears back to null.
 *   - Drag uses pointer events; thumb snaps to dots on release. While
 *     dragging, the badge in Row 1 + the fill bar both animate live.
 *
 * Pure presentational component — receives `level` and `onChange` as
 * props; does not read or write any chain-tracked state.
 */
/**
 * `discBg` overrides the per-dot disc background. The disc is what
 * breaks the track line behind each badge's hollow-pentagon glyph, so
 * it has to be opaque AND match the panel the slider sits on. Default
 * (`bg-zinc-900`) suits the left sidebar; pass a different class when
 * dropping the slider into a panel with a different background so the
 * disc doesn't read as a dark halo.
 *
 * `scale` multiplies every dimension on the slider (header badge,
 * dot disc + glyph, thumb ring, track height). 1 = the sidebar default
 * size; 2 = double everything for surfaces with more room (e.g. the
 * new-entity modal).
 */
export default function IntensitySlider({ level, onChange, discBg = 'bg-zinc-900', scale = 1 }) {
  const trackRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const [dragLevel, setDragLevel] = useState(null) // live level while dragging; null when not dragging

  const displayLevel = dragging ? dragLevel : level
  const positions = [0, 1, 2, 3, 4]

  const levelFromClientX = useCallback((clientX) => {
    const el = trackRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const x = clientX - rect.left
    const ratio = Math.max(0, Math.min(1, x / rect.width))
    return Math.round(ratio * 4)
  }, [])

  const handlePointerDown = (e) => {
    e.preventDefault()
    const lv = levelFromClientX(e.clientX)
    if (lv == null) return
    setDragging(true)
    setDragLevel(lv)
    onChange(lv)
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const handlePointerMove = (e) => {
    if (!dragging) return
    const lv = levelFromClientX(e.clientX)
    if (lv == null) return
    setDragLevel(lv)
    onChange(lv)
  }
  const handlePointerUp = (e) => {
    if (!dragging) return
    setDragging(false)
    setDragLevel(null)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  const fillPct = displayLevel == null ? 0 : (displayLevel / 4) * 100
  const accent = displayLevel == null ? '#52525b' : INTENSITY_COLOURS[displayLevel]

  // Scaled dimensions. Base sizes (scale=1) match the sidebar's original.
  const headerBadgeSize = Math.round(18 * scale)
  const trackHeight     = Math.round(24 * scale)
  const lineHeight      = Math.round(4 * scale)
  const discSize        = Math.round(16 * scale)
  const dotBadgeSize    = Math.round(14 * scale)
  const thumbSize       = Math.round(20 * scale)
  const thumbBorderW    = Math.max(2, Math.round(2 * scale))

  return (
    <div className="space-y-1" data-help-region="entity-attributes:content">
      {/* Row 1 — header + animated current-state badge + text + clear */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Intensity</span>
        <IntensityBadge level={displayLevel} size={headerBadgeSize} />
        <span className="text-[10px] text-zinc-300">
          {displayLevel == null ? 'Unset' : INTENSITY_LABELS[displayLevel]}
        </span>
        {level != null && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="ml-auto text-[10px] text-zinc-500 hover:text-zinc-200 leading-none px-1"
            title="Clear (back to unset)"
          >
            ×
          </button>
        )}
      </div>

      {/* Row 2 — custom slider */}
      <div
        ref={trackRef}
        className="relative cursor-pointer select-none touch-none"
        style={{ height: trackHeight }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* Track background line */}
        <div
          className="absolute top-1/2 left-0 right-0 -translate-y-1/2 bg-zinc-700 rounded-full pointer-events-none"
          style={{ height: lineHeight }}
        />
        {/* Accent fill bar — grows from the left as level rises */}
        {displayLevel != null && (
          <div
            className="absolute top-1/2 left-0 -translate-y-1/2 rounded-full pointer-events-none transition-all"
            style={{ width: `${fillPct}%`, height: lineHeight, backgroundColor: accent }}
          />
        )}
        {/* 5 IntensityBadge dots, evenly spaced. Each is clickable to
            jump to that level. Wrapped in a small solid-bg disc so the
            track line doesn't show through the hollow regions of the
            pentagon glyphs — disc colour matches the sidebar
            background (zinc-900) so it blends with whichever panel
            the slider is dropped into. */}
        {positions.map((lv) => (
          <button
            key={lv}
            type="button"
            onClick={(e) => { e.stopPropagation(); onChange(lv) }}
            title={INTENSITY_LABELS[lv]}
            className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center rounded-full ${discBg}`}
            style={{ left: `${(lv / 4) * 100}%`, width: discSize, height: discSize }}
          >
            <IntensityBadge level={lv} size={dotBadgeSize} />
          </button>
        ))}
        {/* Draggable thumb — outline ring sitting on top of the active
            dot at the current position. Transparent middle so the
            IntensityBadge underneath stays visible through it; the
            ring colour follows the active tier so the thumb reads
            as part of that tier's visual language. Hidden when
            intensity is unset so the "Unset" state is visually
            distinct. */}
        {displayLevel != null && (
          <div
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full pointer-events-none transition-all"
            style={{
              left: `${fillPct}%`,
              width: thumbSize,
              height: thumbSize,
              borderWidth: thumbBorderW,
              borderStyle: 'solid',
              backgroundColor: 'transparent',
              borderColor: accent,
            }}
          />
        )}
      </div>
    </div>
  )
}
