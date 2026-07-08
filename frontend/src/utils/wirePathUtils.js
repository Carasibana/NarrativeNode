/**
 * Wire routing waypoint utilities.
 *
 * Waypoints use relative positioning: { t, offsetX, offsetY, type }.
 *   t       — 0–1 position along the source→target baseline
 *   offsetX — canvas-space X displacement from the base point
 *   offsetY — canvas-space Y displacement from the base point
 *   type    — 'curve' (smooth bend) or 'sharp' (hard-angle pivot)
 */

// ── Coordinate conversion ──────────────────────────────────────────────────

/**
 * Convert relative waypoints to absolute {x, y, type} positions for rendering.
 */
export function resolveWaypoints(sourceX, sourceY, targetX, targetY, waypoints) {
  const dx = targetX - sourceX
  const dy = targetY - sourceY
  return waypoints.map((wp) => ({
    x: sourceX + wp.t * dx + wp.offsetX,
    y: sourceY + wp.t * dy + wp.offsetY,
    type: wp.type,
  }))
}

/**
 * Convert an absolute canvas position to a relative waypoint for storage.
 */
export function toRelativeWaypoint(sourceX, sourceY, targetX, targetY, absX, absY, type = 'curve') {
  const dx = targetX - sourceX
  const dy = targetY - sourceY
  const lenSq = dx * dx + dy * dy
  const t = lenSq > 0
    ? Math.max(0, Math.min(1, ((absX - sourceX) * dx + (absY - sourceY) * dy) / lenSq))
    : 0.5
  const baseX = sourceX + t * dx
  const baseY = sourceY + t * dy
  return { t, offsetX: absX - baseX, offsetY: absY - baseY, type }
}

// ── Path construction ──────────────────────────────────────────────────────

/**
 * Build an SVG path `d` string from source through resolved waypoints to target.
 *
 * @param {number} sourceX
 * @param {number} sourceY
 * @param {number} targetX
 * @param {number} targetY
 * @param {{x: number, y: number, type: string}[]} resolved — already-resolved absolute positions
 * @returns {string} SVG path d attribute
 */
export function buildWaypointPath(sourceX, sourceY, targetX, targetY, resolved) {
  // Full point chain: source (endpoint) → waypoints → target (endpoint)
  const pts = [
    { x: sourceX, y: sourceY, type: 'endpoint' },
    ...resolved,
    { x: targetX, y: targetY, type: 'endpoint' },
  ]

  if (pts.length < 2) return ''

  let d = `M ${pts[0].x},${pts[0].y}`

  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1]
    const curr = pts[i]

    // Sharp points always produce straight line segments
    if (prev.type === 'sharp' || curr.type === 'sharp') {
      d += ` L ${curr.x},${curr.y}`
      continue
    }

    // Both are curve/endpoint — use Catmull-Rom → cubic bezier
    // Four-point window: [P0, P1(prev), P2(curr), P3]
    // P0: pts[i-2] if exists and not sharp; else duplicate P1
    // P3: pts[i+1] if exists and not sharp; else duplicate P2
    const p0 = (i >= 2 && pts[i - 2].type !== 'sharp') ? pts[i - 2] : prev
    const p3 = (i + 1 < pts.length && pts[i + 1].type !== 'sharp') ? pts[i + 1] : curr

    // Catmull-Rom to cubic bezier: CP1 = P1 + (P2 - P0) / 6, CP2 = P2 - (P3 - P1) / 6
    const cp1x = prev.x + (curr.x - p0.x) / 6
    const cp1y = prev.y + (curr.y - p0.y) / 6
    const cp2x = curr.x - (p3.x - prev.x) / 6
    const cp2y = curr.y - (p3.y - prev.y) / 6

    d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${curr.x},${curr.y}`
  }

  return d
}

// ── Path querying ──────────────────────────────────────────────────────────

/**
 * Get a point at parameter t (0–1) along an SVG path string.
 * Uses a temporary SVGPathElement (never appended to DOM).
 */
export function getPointOnPath(pathString, t) {
  if (!pathString) return { x: 0, y: 0 }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', pathString)
  const totalLen = path.getTotalLength()
  const pt = path.getPointAtLength(t * totalLen)
  return { x: pt.x, y: pt.y }
}

// ── Push existing point along path ────────────────────────────────────────

/**
 * Push an existing waypoint along the wire path until it sits on the circle
 * of radius `radius` centered at `centerX/centerY`.  Walks from the existing
 * point's path position away from the center.
 *
 * Returns { x, y } on the path at the circle boundary, or null on failure.
 */
export function findPathCircleExit(pathString, existingX, existingY, centerX, centerY, radius) {
  if (!pathString) return null
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  el.setAttribute('d', pathString)
  const totalLen = el.getTotalLength()
  if (totalLen < 1) return null

  const radiusSq = radius * radius

  // Find the path-length position closest to a canvas point
  const findLen = (px, py) => {
    let best = 0, bestDistSq = Infinity
    const coarseStep = totalLen / 50
    for (let l = 0; l <= totalLen; l += coarseStep) {
      const p = el.getPointAtLength(l)
      const dx = p.x - px, dy = p.y - py
      const dSq = dx * dx + dy * dy
      if (dSq < bestDistSq) { bestDistSq = dSq; best = l }
    }
    // Refine with finer steps around the best match
    const lo = Math.max(0, best - coarseStep)
    const hi = Math.min(totalLen, best + coarseStep)
    for (let l = lo; l <= hi; l += coarseStep / 10) {
      const p = el.getPointAtLength(l)
      const dx = p.x - px, dy = p.y - py
      const dSq = dx * dx + dy * dy
      if (dSq < bestDistSq) { bestDistSq = dSq; best = l }
    }
    return best
  }

  const existLen = findLen(existingX, existingY)
  const centerLen = findLen(centerX, centerY)

  // Walk away from center along the path in 5px steps
  const dir = existLen >= centerLen ? 1 : -1
  for (let l = existLen; l >= 0 && l <= totalLen; l += dir * 5) {
    const p = el.getPointAtLength(l)
    const dx = p.x - centerX, dy = p.y - centerY
    if (dx * dx + dy * dy >= radiusSq) return { x: p.x, y: p.y }
  }

  // Hit the path end — return the endpoint
  const p = el.getPointAtLength(dir > 0 ? totalLen : 0)
  return { x: p.x, y: p.y }
}

// ── Insertion index ────────────────────────────────────────────────────────

/**
 * Find the index to insert a new waypoint at to maintain t-sorted order.
 * Returns waypoints.length if the new t is larger than all existing.
 */
export function findInsertionIndex(waypoints, newT) {
  const idx = waypoints.findIndex((wp) => wp.t > newT)
  return idx === -1 ? waypoints.length : idx
}
