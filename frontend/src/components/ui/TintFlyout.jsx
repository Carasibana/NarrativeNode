import { createPortal } from 'react-dom'
import PresetHexagon from './PresetHexagon'

/**
 * Ring of 6 tint hexagons arranged radially around a given
 * anchor point (the centre of the hex that was hovered). Used
 * by both the preset honeycomb and the saturation-square
 * pointer to surface related colours on sustained hover.
 *
 * Rendered in a portal on `document.body` so the flyout can
 * float above neighbouring hexes in the honeycomb without
 * being clipped by whatever wrapping container the hovered
 * hex lives in, and so the drop-shadow reads cleanly against
 * the colour-picker popover background.
 *
 * The 6 tints are laid out at 0°/60°/120°/180°/240°/300° from
 * 12 o'clock, at a radius that keeps them outside the hovered
 * hex's own area (roughly 2× the hex size). Each one is a
 * smaller `<PresetHexagon>`. Clicking a tint calls `onPick(hex)`
 * with that tint's colour.
 *
 * The flyout is purely read-only for hover purposes — it does
 * NOT have its own `useHoverDelay`; keeping mouse inside the
 * flyout ring is the caller's job (typically by NOT dismissing
 * while the pointer is over it). For v1 the caller holds
 * `isOpen` and we just render — the caller decides when to
 * tear down.
 */
const TINT_COUNT = 6

export default function TintFlyout({
  tints,
  anchorCentre,   // { x, y } viewport-space coordinates
  hexSize = 32,
  ringRadius,     // override; defaults to a touching-edge radius
                  // computed for tint hexes that are ~55% the size
                  // of the source hex (hexSize * 1.25).
  onPick,
  onHoverEnter,   // called when pointer enters a tint — used by
                  // the parent hover-delay controller to cancel
                  // any pending close while pointer is on the
                  // flyout.
  onHoverLeave,
}) {
  if (!tints || tints.length === 0) return null

  const effectiveRingRadius = ringRadius ?? (hexSize * 1.25)
  const hexHeight = hexSize * Math.sqrt(3) / 2
  const positions = Array.from({ length: TINT_COUNT }, (_, i) => {
    const angleRad = (i * 60) * (Math.PI / 180)
    return {
      x: Math.sin(angleRad) * effectiveRingRadius,
      y: -Math.cos(angleRad) * effectiveRingRadius,
    }
  })

  return createPortal(
    <div
      data-tint-flyout="true"
      data-nested-modal="true"
      data-help-region="colour-picker:tint_ring"
      // Stop mousedown reaching document-level listeners on
      // panels that host the picker (SettingsPanel, EntityModal,
      // etc). Without this, clicking a tint hex bubbles through
      // the portal to document → closes the panel → unmounts
      // the picker.
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: anchorCentre.x,
        top: anchorCentre.y,
        width: 0,
        height: 0,
        pointerEvents: 'none',
        zIndex: 10000,
      }}
    >
      {positions.map((pos, i) => {
        const colour = tints[i % tints.length]
        return (
          <div
            key={i}
            onPointerEnter={onHoverEnter}
            onPointerLeave={onHoverLeave}
            style={{
              position: 'absolute',
              left: pos.x - hexSize / 2,
              top: pos.y - hexHeight / 2,
              pointerEvents: 'auto',
              filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))',
              // Small fade-in so the ring doesn't appear abruptly.
              animation: 'tint-flyout-fade 120ms ease-out',
            }}
          >
            <PresetHexagon
              colour={colour}
              size={hexSize}
              onClick={() => onPick(colour)}
              ariaLabel={`Tint ${colour}`}
              dataHelpRegion="colour-picker:tint"
            />
          </div>
        )
      })}
      <style>{`
        @keyframes tint-flyout-fade {
          from { opacity: 0; transform: scale(0.8); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>,
    document.body,
  )
}
