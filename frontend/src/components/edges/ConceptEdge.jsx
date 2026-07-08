/**
 * ConceptEdge , Phase 8.1 (§8.1.2).
 *
 * The concept wire: an undirected association between two concept-layer nodes.
 * No arrowheads. Rendered as a continuous `-O-O-O-` strand , dash segments
 * alternating with hollow rings (doughnuts) , coloured by an INVERTED gradient
 * along its length: each end is tinted the colour of the node at the OTHER end
 * (the stub near node A carries node B's colour and vice versa), so the wire
 * near a node signposts where it leads.
 *
 * The rings are separate hollow `<circle>`s placed at even arc-length
 * intervals (a plain `stroke-dasharray` can't make an open-centre ring); the
 * dashed stroke's gaps are phased to sit under the rings so the dashes abut
 * each ring's outer edge while its centre stays open. Ring / spacing constants
 * are hoisted for easy visual calibration.
 */

import { useRef, useState, useLayoutEffect } from 'react'
import { getBezierPath } from '@xyflow/react'
import { useProjectStore } from '../../store/projectStore'

const NEUTRAL = '#a3e635'     // fallback tint if an endpoint node is missing
const RING_R = 3              // hollow-ring radius (px)
const RING_STROKE = 1.5       // ring outline weight
const SPACING = 16            // arc-length between ring centres (px)
const DASH = 9                // dash segment length
const GAP = SPACING - DASH    // gap under each ring (~ring diameter + padding)
// Phase the dash gaps so they centre on the rings (rings sit at SPACING/2 +
// k*SPACING). Gap centre in the dash period = DASH + GAP/2; shift so it lands
// at SPACING/2. Tunable during visual calibration.
const DASH_OFFSET = (DASH + GAP / 2) - SPACING / 2

export default function ConceptEdge({
  id, source, target,
  sourceX, sourceY, sourcePosition,
  targetX, targetY, targetPosition,
  selected,
}) {
  const [path] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
  })

  // Endpoint colours. Returned as a stable "A|B" string so the edge only
  // re-renders when one of its two nodes is recoloured (A = source, B = target).
  const coloursStr = useProjectStore((s) => {
    const a = s.nodes.find((n) => n.id === source)?.data?.colour || NEUTRAL
    const b = s.nodes.find((n) => n.id === target)?.data?.colour || NEUTRAL
    return `${a}|${b}`
  })
  const [colourA, colourB] = coloursStr.split('|')

  // Sample ring centres at even arc-length intervals along the actual path.
  const measureRef = useRef(null)
  const [rings, setRings] = useState([])
  useLayoutEffect(() => {
    const el = measureRef.current
    if (!el) return
    let len = 0
    try { len = el.getTotalLength() } catch { return }
    const pts = []
    for (let d = SPACING / 2; d <= len - 1; d += SPACING) {
      const p = el.getPointAtLength(d)
      pts.push({ x: p.x, y: p.y })
    }
    // Measure-then-set: ring centres need the RENDERED path's arc length, so
    // this DOM-measurement + state write is the accepted pattern (mirrors
    // PortHandle's handle measurement). Keyed on `path`, so it re-runs only
    // when the wire's geometry actually changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRings(pts)
  }, [path])

  const gradId = `concept-grad-${id}`
  return (
    <>
      {/* Hidden measurement path (drives ring placement; no stroke). */}
      <path ref={measureRef} d={path} fill="none" stroke="none" />

      {/* Transparent wide hit area so the wire is selectable / deletable. */}
      <path d={path} fill="none" stroke="transparent" strokeWidth={16} className="react-flow__edge-interaction" />

      {/* Inverted gradient: stop@0 (the source end) = target node colour B;
          stop@1 (the target end) = source node colour A. */}
      <defs>
        <linearGradient
          id={gradId}
          gradientUnits="userSpaceOnUse"
          x1={sourceX} y1={sourceY} x2={targetX} y2={targetY}
        >
          <stop offset="0%" stopColor={colourB} />
          <stop offset="100%" stopColor={colourA} />
        </linearGradient>
      </defs>

      {/* Dash segments (the `-` between rings). */}
      <path
        d={path}
        fill="none"
        stroke={`url(#${gradId})`}
        strokeWidth={selected ? 2.4 : 1.8}
        strokeDasharray={`${DASH} ${GAP}`}
        strokeDashoffset={DASH_OFFSET}
        strokeLinecap="round"
      />

      {/* Hollow rings (the `O`s) sitting in the dash gaps. */}
      {rings.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={RING_R}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={RING_STROKE}
        />
      ))}
    </>
  )
}
