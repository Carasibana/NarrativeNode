/**
 * Single hex-shaped swatch button for the colour-picker
 * honeycomb. Flat-top regular hex via CSS `clip-path: polygon`.
 *
 * The clip-path percentages (0/25/50/75/100) form a regular
 * hexagon only inside a bounding box with aspect ratio 2:sqrt(3)
 * (width : height). A 1:1 bounding box would stretch the shape
 * vertically. To keep the rendered hex regular regardless of the
 * caller's `size` prop, the button renders at:
 *   width  = size               (point-to-point width)
 *   height = size * sqrt(3)/2   (flat-to-flat height)
 *
 * Flat-top hex vertices (percentages of the bounding box):
 *   top-left:     25  0
 *   top-right:    75  0
 *   right:       100 50
 *   bottom-right: 75 100
 *   bottom-left:  25 100
 *   left:          0 50
 *
 * Selected state is rendered via an expanded sibling element
 * sitting BEHIND the button so the outline appears OUTSIDE the
 * hex silhouette. Inset box-shadow + inner clip-path (the
 * previous approach) put the outline inside the hex, which the
 * user called out as wrong.
 */
const HEX_CLIP_PATH = 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)'
const SQRT3 = Math.sqrt(3)

export default function PresetHexagon({
  colour,
  size = 40,
  isSelected = false,
  isHovered = false,
  selectedRingColour,
  onClick,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onTouchStart,
  ariaLabel,
  // Behaviour-neutral help-region passthrough. Defaults to the colour-
  // picker swatch concept key (one tag for the repeated swatch TYPE);
  // the tint-ring flyout reuses this hex at a smaller size and passes
  // its own key.
  dataHelpRegion = 'colour-picker:swatch',
}) {
  const width  = size
  const height = size * SQRT3 / 2
  const ringColour = selectedRingColour ?? pickContrast(colour)
  const hoverFilter = isHovered
    ? 'drop-shadow(0 0 6px rgba(255,255,255,0.45))'
    : undefined

  // Container sized to the expanded (selected-ring) extent so
  // the outer indicator doesn't get cropped by any overflow
  // boundary above.
  const selectedRingWidth = 3
  const containerWidth  = width  + selectedRingWidth * 2
  const containerHeight = height + selectedRingWidth * 2

  return (
    <div
      style={{
        position: 'relative',
        width:  containerWidth,
        height: containerHeight,
        // Centre the hex + ring inside the container so the
        // overall footprint matches `width × height` at the
        // caller's layout level (the extra 2 * ring ends up as
        // symmetric margin around the hex).
        marginLeft:  -selectedRingWidth,
        marginTop:   -selectedRingWidth,
      }}
    >
      {isSelected && (
        // Expanded hex behind the button; when the button's
        // clip shows only its own silhouette, the extra few
        // pixels of this expanded element peek out as a ring.
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            clipPath: HEX_CLIP_PATH,
            background: ringColour,
            pointerEvents: 'none',
          }}
        />
      )}
      <button
        type="button"
        onClick={onClick}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerDown={onPointerDown}
        onTouchStart={onTouchStart}
        aria-label={ariaLabel || `Select colour ${colour}`}
        aria-pressed={isSelected}
        data-help-region={dataHelpRegion || undefined}
        style={{
          position: 'absolute',
          left: selectedRingWidth,
          top:  selectedRingWidth,
          width,
          height,
          clipPath: HEX_CLIP_PATH,
          background: colour,
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          filter: hoverFilter,
          transition: 'filter 120ms ease-out',
        }}
      />
    </div>
  )
}

/** Return black or white depending on which offers better
 *  contrast against the input hex. Luminance-weighted so yellow
 *  picks black and dark blue picks white. */
function pickContrast(hex) {
  if (!hex || !hex.startsWith('#') || hex.length !== 7) return '#ffffff'
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.55 ? '#000000' : '#ffffff'
}
