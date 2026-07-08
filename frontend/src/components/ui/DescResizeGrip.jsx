import { useState } from 'react'

/**
 * Horizontal resize grip for the description-text section on Scene and
 * Entity origin nodes. Absolutely positioned over the description wrapper's
 * bottom border (which acts as the centre line) so toggling it on selection
 * doesn't shift node layout. Only renders two short floater lines that fade
 * in / spread outward around the existing border on hover and active.
 *
 * Props:
 *   onMouseDown    drag-start handler (parent owns drag state).
 *   onDoubleClick  toggle reset / expand handler.
 *   active         true while a drag is in progress (white floaters).
 *   accentColor    live accent colour for hover state.
 *   parentBottomPad px below the wrapper inside the parent container,
 *                  used to centre the strip on the wrapper's bottom border.
 *                  Scene nodes use `pb-1` (4); entity origin nodes use
 *                  `pb-2` (8). Defaults to 4 to match the original Scene
 *                  call site.
 */
export default function DescResizeGrip({
  onMouseDown,
  onDoubleClick,
  active,
  accentColor,
  parentBottomPad = 4,
}) {
  const [hover, setHover] = useState(false)
  const emphasised = hover || active
  let side
  let sideOpacity
  if (active) {
    side = 'rgba(255, 255, 255, 0.6)'
    sideOpacity = 1
  } else if (hover) {
    side = accentColor
    sideOpacity = 0.6
  } else {
    side = 'rgba(161, 161, 170, 0.3)'
    sideOpacity = 1
  }
  const floaterGap = emphasised ? 4 : 2
  // Strip height of 10 px straddles the wrapper's bottom border (5 px on
  // each side). With the strip positioned so its midline aligns with the
  // border's OUTER edge, the border's 1 px thickness occupies strip y
  // [midY - borderThickness, midY] — i.e., the border sits ABOVE the
  // midline, not symmetrically across it. Floaters compute their offsets
  // from the border's two edges (not midY) so they stay equidistant from
  // the visible centre line regardless of border thickness.
  const stripHeight = 10
  const midY = stripHeight / 2
  const borderThickness = 1
  const borderTopEdge = midY - borderThickness
  const borderBottomEdge = midY
  const floaterAbove = borderTopEdge - floaterGap - 1
  const floaterBelow = borderBottomEdge + floaterGap
  const common = {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    pointerEvents: 'none',
    transition: 'top 0.12s ease-out, opacity 0.12s ease-out',
  }
  return (
    <div
      className="nodrag"
      data-help-region="detail-panel:details_description"
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Drag to resize. Double-click to fit text or reset."
      style={{
        position: 'absolute',
        // Centre the strip's midline on the wrapper's bottom border. The
        // wrapper sits inside a parent with `parentBottomPad` px of
        // bottom padding, so the wrapper's bottom border is that many
        // px above the parent's bottom edge. To put the strip's midline
        // (stripHeight / 2 from the strip's top) at that y coordinate:
        // bottom = parentBottomPad - stripHeight / 2.
        left: 8,
        right: 8,
        bottom: parentBottomPad - stripHeight / 2,
        height: stripHeight,
        cursor: 'ns-resize',
        zIndex: 2,
      }}
    >
      <div style={{ ...common, top: floaterAbove, width: '20%', height: 1, backgroundColor: side, opacity: sideOpacity }} />
      <div style={{ ...common, top: floaterBelow, width: '20%', height: 1, backgroundColor: side, opacity: sideOpacity }} />
    </div>
  )
}
