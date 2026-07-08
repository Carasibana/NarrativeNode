/**
 * Pixel-position math for the 19-hexagon honeycomb preset picker.
 *
 * Pure geometry, no React. Given a hex size, returns an array of
 * `{slot, x, y}` entries placing each preset hex at the correct
 * pixel position within a container. Slots match the `slot`
 * strings exported from `colorPickerPresets.js` — `center`,
 * `inner-0..5`, `outer-0..11`.
 *
 * Layout is pointy-top flat-side hexagons (the side of each hex
 * faces the viewer's top/bottom). For a hexagon inscribed in a
 * circle of radius `hexSize`:
 * - Width  = `hexSize * 2`                  (flat-side to flat-side)
 * - Height = `hexSize * sqrt(3)`            (point-to-point)
 * - Horizontal spacing between columns = `hexSize * 1.5`
 * - Vertical spacing between rows      = `hexSize * sqrt(3)`
 *
 * Honeycomb ring radii are chosen so inner hexes touch the centre
 * hex, and outer hexes touch the inner ring — the standard close-
 * packed arrangement. At `hexSize = r`:
 * - Inner-ring centres sit on a circle of radius `r * sqrt(3)`.
 * - Outer ring is NOT on a single circle. The 12 outer positions
 *   alternate between:
 *     - Axial (aligned with an inner-ring hex): radius `2 * r * sqrt(3)`
 *       — the inner hex is on the same line from centre, exactly
 *       between centre and this outer hex.
 *     - Corner (between two inner-ring hexes): radius `3 * r`
 *       — shares an edge with each of those two inner hexes.
 *   The axial distance (~3.46r) is larger than the corner distance
 *   (3r), which is what gives a proper close-packed 2nd-ring its
 *   hexagonal outline rather than a plain circle. Using a uniform
 *   outer radius (as the earlier version of this file did) made
 *   the axial hexes crash into their inner neighbours and the
 *   corner hexes crash into each other.
 *
 * Inner ring positions (60° apart, clockwise from 12 o'clock):
 *   i0 at 0°, i1 at 60°, i2 at 120°, i3 at 180°, i4 at 240°, i5 at 300°.
 * Outer ring positions (30° apart, clockwise from 12 o'clock):
 *   o0 at 0°, o1 at 30°, ..., o11 at 330°.
 * Even-index outer slots (0, 2, 4, 6, 8, 10) are axial.
 * Odd-index outer slots (1, 3, 5, 7, 9, 11) are corner.
 *
 * All coordinates returned are relative to the honeycomb's
 * geometric centre. Callers add their own container-level offset
 * (usually `totalWidth / 2` and `totalHeight / 2`) to position the
 * hexes inside a wrapping element.
 */

const SQRT3 = Math.sqrt(3)

export function getHoneycombLayout(hexSize) {
  // `hexSize` is the hex's full point-to-point width (the
  // dimension callers actually care about when sizing the
  // rendered `<PresetHexagon>`). The circumradius of the hex
  // (vertex distance from centre) is half that.
  const r = hexSize / 2
  const innerRadius = r * SQRT3
  const outerAxialRadius  = 2 * r * SQRT3  // axial slots (0, 2, 4, 6, 8, 10)
  const outerCornerRadius = 3 * r          // corner slots (1, 3, 5, 7, 9, 11)

  const result = [{ slot: 'center', x: 0, y: 0 }]

  // Inner ring: 6 positions, 60° apart, starting at 12 o'clock
  // going clockwise. Using sin(angle) for x and -cos(angle) for y
  // because screen y grows downward but the "top" of the clock is
  // at y = -radius.
  for (let i = 0; i < 6; i++) {
    const angleRad = (i * 60) * (Math.PI / 180)
    result.push({
      slot: `inner-${i}`,
      x: innerRadius * Math.sin(angleRad),
      y: -innerRadius * Math.cos(angleRad),
    })
  }

  // Outer ring: 12 positions, 30° apart. Alternate between
  // axial (even index, aligned with inner-ring hexes) and corner
  // (odd index, between inner-ring hexes) — different radii.
  for (let i = 0; i < 12; i++) {
    const angleRad = (i * 30) * (Math.PI / 180)
    const radius = (i % 2 === 0) ? outerAxialRadius : outerCornerRadius
    result.push({
      slot: `outer-${i}`,
      x: radius * Math.sin(angleRad),
      y: -radius * Math.cos(angleRad),
    })
  }

  return result
}

/** Total honeycomb bounding-box dimensions at a given hex size.
 *  Size is determined by the farther of the two outer-ring radii
 *  (the axial slots at 2*r*sqrt(3) ≈ 3.46r). `+ hexSize * 2` adds
 *  one full hex-width of margin so the edge hexes don't clip
 *  against the container. Layout is radially symmetric so the
 *  bounding box is square.
 */
export function getHoneycombBounds(hexSize) {
  // Horizontal reach: the farthest centre is the corner outer
  // ring at radius 3r = 1.5*hexSize (e.g. outer-3 at the right
  // edge at compass 90°). Adding half a hex width pushes to
  // the hex's right edge.
  // Vertical reach: the farthest centre is the axial outer
  // ring at radius 2r*sqrt(3) = hexSize*sqrt(3) (outer-0 at the
  // top at compass 0°). Adding half the hex's flat-to-flat
  // height (= hexSize*sqrt(3)/4) pushes to the hex's top flat.
  const halfWidth  = 1.5 * hexSize + hexSize / 2
  const halfHeight = hexSize * SQRT3 + hexSize * SQRT3 / 4
  // Square the container to the greater extent + margin so the
  // layout stays symmetric inside its wrapper.
  const halfBound = Math.max(halfWidth, halfHeight) + hexSize * 0.1
  const size = halfBound * 2
  return { width: size, height: size }
}
