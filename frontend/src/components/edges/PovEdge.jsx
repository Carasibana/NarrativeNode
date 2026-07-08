import { useRef, useState, useLayoutEffect } from 'react'
import { getBezierPath } from '@xyflow/react'
import { usePovColor, getPovDerived } from '../../utils/povConstants'
import { useUiStore } from '../../store/uiStore'

/** Number of regular dashes between each inline arrow */
const DASHES_PER_ARROW = 5
/** Length of one dash */
const DASH_LEN = 6
/** Gap between dashes */
const GAP_LEN = 8
/** Extra gap where an arrow replaces a dash */
const ARROW_GAP = 14
/** One cycle = N normal dashes + 1 arrow gap */
const CYCLE_LEN = (DASHES_PER_ARROW * (DASH_LEN + GAP_LEN)) + ARROW_GAP

/**
 * Build a strokeDasharray that has N normal dashes then a larger gap for the arrow.
 * Pattern: [dash, gap, dash, gap, ..., dash, arrow_gap]
 */
function buildDashArray() {
  const parts = []
  for (let i = 0; i < DASHES_PER_ARROW; i++) {
    parts.push(DASH_LEN, GAP_LEN)
  }
  // The last entry is the arrow gap (replaces one dash)
  // We need a dash of 0 length then the arrow gap to keep the pattern valid
  parts.push(0, ARROW_GAP)
  return parts.join(' ')
}

const DASH_ARRAY = buildDashArray()

// Per-edge cache of computed arrow positions, keyed by edge id with the path
// string they were computed for. Arrow positions are a pure function of the
// edge's path geometry, which only changes when a connected node MOVES — never
// on pan / zoom / remount. `getTotalLength` / `getPointAtLength` (used to place
// the arrows) force a synchronous layout reflow, and during a canvas/minimap
// pan every POV edge unmounts+remounts as its nodes virtualize in and out of
// view — measuring each one on the synchronous layout path was the pan stutter
// (a trace attributed ~290ms of forced reflow to it). With this cache a remount
// reuses the stored arrows and does zero measurement; only a genuinely changed
// path (a node moved) remeasures. Keyed by id → bounded at one entry per edge.
const _povArrowCache = new Map()
const EMPTY_ARROWS = []

/**
 * POV wire edge — a dashed gold line with small directional arrows
 * replacing every Nth dash.
 */
export default function PovEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data }) {
  const [edgePath] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const povColor = usePovColor()
  const { bright } = getPovDerived(povColor)

  // Highlight when the source or target node is the sole selected node.
  // Guard against entityChip mode so selecting a chip doesn't highlight all scene wires.
  const dpMode = useUiStore((s) => s.detailPanelMode)
  const singleSelectedNodeId = useUiStore((s) => s.singleSelectedNodeId)
  const hoveredWireId = useUiStore((s) => s.hoveredWireId)
  const isHoveredFromPopup = hoveredWireId === id
  const isHighlightedBySelection = !!(
    dpMode !== 'entityChip' &&
    singleSelectedNodeId &&
    (singleSelectedNodeId === data?.source_node_id || singleSelectedNodeId === data?.target_node_id)
  )

  const isLit = selected || isHighlightedBySelection || isHoveredFromPopup
  const color = isLit ? bright : povColor
  const pathRef = useRef(null)
  // Seed from the per-edge cache so a remount during a pan paints the arrows
  // immediately with zero measurement (see `_povArrowCache`).
  const [arrows, setArrows] = useState(() => {
    const c = _povArrowCache.get(id)
    return c && c.path === edgePath ? c.arrows : EMPTY_ARROWS
  })

  // Compute arrow positions — placed at the centre of each arrow gap in the
  // dash pattern. Cache-first: a hit (same path → neither connected node moved,
  // which covers every pan / zoom / remount) reuses the stored arrows and does
  // NO SVG measurement, so it can't force a layout reflow. Only a changed path
  // (a node actually moved) remeasures and refreshes the cache.
  useLayoutEffect(() => {
    const cached = _povArrowCache.get(id)
    if (cached && cached.path === edgePath) {
      setArrows(cached.arrows) // same array ref on a hit → React bails, no re-render
      return
    }
    const el = pathRef.current
    if (!el) { setArrows(EMPTY_ARROWS); return }
    const totalLen = el.getTotalLength()
    if (totalLen < CYCLE_LEN) {
      _povArrowCache.set(id, { path: edgePath, arrows: EMPTY_ARROWS })
      setArrows(EMPTY_ARROWS)
      return
    }

    const result = []
    // First arrow appears at the end of the first cycle of dashes
    const firstArrowPos = DASHES_PER_ARROW * (DASH_LEN + GAP_LEN) + ARROW_GAP / 2
    for (let d = firstArrowPos; d < totalLen; d += CYCLE_LEN) {
      const pt = el.getPointAtLength(d)
      const ptAhead = el.getPointAtLength(Math.min(d + 2, totalLen))
      const angle = Math.atan2(ptAhead.y - pt.y, ptAhead.x - pt.x) * (180 / Math.PI)
      result.push({ x: pt.x, y: pt.y, angle })
    }
    _povArrowCache.set(id, { path: edgePath, arrows: result })
    setArrows(result)
  }, [edgePath, id])

  return (
    <g>
      {/* Wider invisible hit area for selection */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        className="react-flow__edge-interaction"
      />
      {/* Visible dashed line with arrow gaps */}
      <path
        ref={pathRef}
        d={edgePath}
        data-help-region="wire:pov"
        fill="none"
        className="react-flow__edge-path"
        style={{
          stroke: color,
          strokeWidth: isLit ? 4 : 3,
          strokeDasharray: DASH_ARRAY,
          strokeLinecap: 'round',
          filter: (isHighlightedBySelection || isHoveredFromPopup) ? `drop-shadow(0 0 3px ${bright}88)` : undefined,
          pointerEvents: 'none',
        }}
      />
      {/* Inline directional arrows — sit in the dash gaps */}
      {arrows.map((a, i) => (
        <g key={i} transform={`translate(${a.x},${a.y}) rotate(${a.angle})`}>
          <polygon
            points="-4,-3.5 5,0 -4,3.5"
            fill={color}
          />
        </g>
      ))}
    </g>
  )
}
