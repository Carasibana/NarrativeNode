/**
 * Auto-tidy wire routing utilities.
 *
 * Routes wires around non-connected node bounding boxes using a
 * visibility graph + Dijkstra shortest-path algorithm.
 *
 * Pure computation — no React or store imports.
 */

import {
  toRelativeWaypoint,
  resolveWaypoints,
  buildWaypointPath,
  getPointOnPath,
} from './wirePathUtils'
import { ENTITY_BUCKETS } from './entityHelpers'
import { getMeasuredWidth, getMeasuredHeight } from './measuredDimensionsStore'

// ── Node bounding boxes ───────────────────────────────────────────────────

/**
 * Extract a padded axis-aligned bounding box from a React Flow node.
 *
 * Dimension resolution order:
 *   1. node.measured.width / height  (React Flow v12 measured — most accurate)
 *   2. node.data.width / height      (persisted after user resize)
 *   3. Fallback defaults per node type
 *
 * @param {object} node - React Flow node with .position, .data, optionally .measured
 * @param {number} [padding=20] - Canvas-px padding on all sides
 * @returns {{ left: number, top: number, right: number, bottom: number }}
 */
export function getNodeBBox(node, padding = 20) {
  const w =
    (node.measured?.width || 0) ||
    (getMeasuredWidth(node.id) || 0) ||
    node.data?.width ||
    (node.type === 'sceneNode' ? 220 : 160)
  const h =
    (node.measured?.height || 0) ||
    (getMeasuredHeight(node.id) || 0) ||
    node.data?.height ||
    _estimateNodeHeight(node)
  return {
    left:   node.position.x - padding,
    top:    node.position.y - padding,
    right:  node.position.x + w + padding,
    bottom: node.position.y + h + padding,
  }
}

/** Estimate a node's height from its content when measured/data dimensions are unavailable. */
function _estimateNodeHeight(node) {
  if (node.type !== 'sceneNode') return 100 // entityNode baseline
  // Count entity chips to estimate height
  const buckets = ['characters', 'locations', 'items', 'factions', 'customs']
  let chipCount = 0
  for (const b of buckets) chipCount += (node.data?.[b] || []).length
  // Header (~36px) + each chip row (~32px) + description area (~40px) + padding
  return Math.max(100, 36 + chipCount * 32 + 40 + 16)
}

// ── Geometry primitives ───────────────────────────────────────────────────

/**
 * Test whether two line segments (a→b) and (c→d) intersect.
 * Uses the parametric cross-product method.
 */
export function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const abx = bx - ax, aby = by - ay
  const cdx = dx - cx, cdy = dy - cy
  const denom = abx * cdy - aby * cdx
  if (Math.abs(denom) < 1e-10) return false // parallel / collinear

  const acx = cx - ax, acy = cy - ay
  const t = (acx * cdy - acy * cdx) / denom
  const u = (acx * aby - acy * abx) / denom

  // Strict interior — exclude touching at endpoints (t/u ∈ (ε, 1−ε))
  const EPS = 1e-6
  return t > EPS && t < 1 - EPS && u > EPS && u < 1 - EPS
}

/**
 * Test whether a line segment (ax,ay)→(bx,by) intersects a rectangle.
 *
 * Checks both edge crossings AND endpoint containment — a segment that
 * starts or ends inside the rectangle is always considered intersecting.
 */
export function segmentIntersectsRect(ax, ay, bx, by, rect) {
  // Endpoint inside the rectangle → segment passes through it
  if (isPointInsideRect(ax, ay, rect) || isPointInsideRect(bx, by, rect)) return true

  const { left: l, top: t, right: r, bottom: b } = rect
  return (
    segmentsIntersect(ax, ay, bx, by, l, t, r, t) || // top edge
    segmentsIntersect(ax, ay, bx, by, r, t, r, b) || // right edge
    segmentsIntersect(ax, ay, bx, by, r, b, l, b) || // bottom edge
    segmentsIntersect(ax, ay, bx, by, l, b, l, t)    // left edge
  )
}

/**
 * Test whether a point is strictly inside a rectangle.
 */
export function isPointInsideRect(x, y, rect) {
  return x > rect.left && x < rect.right && y > rect.top && y < rect.bottom
}

// ── Visibility graph ──────────────────────────────────────────────────────

/**
 * Build a visibility graph from source/target + obstacle-corner vertices.
 *
 * @param {{ x: number, y: number }} source
 * @param {{ x: number, y: number }} target
 * @param {{ left, top, right, bottom }[]} obstacles — padded bounding boxes
 * @returns {{ vertices: {x,y}[], adjacency: Map<number, {idx: number, dist: number}[]> }}
 */
export function buildVisibilityGraph(source, target, obstacles) {
  // 1. Collect candidate vertices
  const vertices = [source, target]
  for (const rect of obstacles) {
    vertices.push(
      { x: rect.left,  y: rect.top },
      { x: rect.right, y: rect.top },
      { x: rect.right, y: rect.bottom },
      { x: rect.left,  y: rect.bottom },
    )
  }

  // 2. Filter out corners that sit inside another obstacle
  const reachable = vertices.map((v, i) => {
    if (i < 2) return true // source & target are always reachable
    return !obstacles.some((rect) => isPointInsideRect(v.x, v.y, rect))
  })

  // 3. Build adjacency — connect pairs with clear line-of-sight
  const adjacency = new Map()
  for (let i = 0; i < vertices.length; i++) {
    if (!reachable[i]) continue
    adjacency.set(i, [])
  }

  for (let i = 0; i < vertices.length; i++) {
    if (!reachable[i]) continue
    for (let j = i + 1; j < vertices.length; j++) {
      if (!reachable[j]) continue
      const a = vertices[i], b = vertices[j]
      // Check if segment a→b intersects any obstacle
      const blocked = obstacles.some((rect) =>
        segmentIntersectsRect(a.x, a.y, b.x, b.y, rect),
      )
      if (!blocked) {
        const dx = b.x - a.x, dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        adjacency.get(i).push({ idx: j, dist })
        adjacency.get(j).push({ idx: i, dist })
      }
    }
  }

  return { vertices, adjacency }
}

// ── Dijkstra shortest path ────────────────────────────────────────────────

/**
 * Find the shortest path from sourceIdx to targetIdx in the visibility graph.
 *
 * @returns {number[] | null} — ordered vertex indices from source to target, or null
 */
export function dijkstra(vertices, adjacency, sourceIdx, targetIdx) {
  const n = vertices.length
  const dist = new Array(n).fill(Infinity)
  const prev = new Array(n).fill(-1)
  const visited = new Set()

  dist[sourceIdx] = 0
  // Simple priority queue (sorted array) — fine for <200 vertices
  const queue = [{ idx: sourceIdx, d: 0 }]

  while (queue.length > 0) {
    // Pop smallest distance
    let minI = 0
    for (let i = 1; i < queue.length; i++) {
      if (queue[i].d < queue[minI].d) minI = i
    }
    const { idx: u } = queue.splice(minI, 1)[0]

    if (visited.has(u)) continue
    visited.add(u)
    if (u === targetIdx) break

    const neighbors = adjacency.get(u)
    if (!neighbors) continue
    for (const { idx: v, dist: w } of neighbors) {
      if (visited.has(v)) continue
      const nd = dist[u] + w
      if (nd < dist[v]) {
        dist[v] = nd
        prev[v] = u
        queue.push({ idx: v, d: nd })
      }
    }
  }

  // Reconstruct path
  if (dist[targetIdx] === Infinity) return null
  const path = []
  for (let u = targetIdx; u !== -1; u = prev[u]) path.push(u)
  path.reverse()
  return path
}

// ── Handle position computation ───────────────────────────────────────────

/**
 * Approximate handle positions for an edge (fallback when real positions unavailable).
 *
 * Source handle: right side of the source node, y offset 16px from top
 * Target handle: left side of the target node, y offset 16px from top
 *
 * These match the Handle style={{ top: 16 }} used by EntityNode and
 * SceneNode target handles.  For SceneNode entity chip outputs
 * this is only a rough estimate — prefer real positions from
 * buildHandlePositionMap() when available.
 */
export function computeHandlePositions(sourceNode, targetNode) {
  const sw = sourceNode.measured?.width ?? getMeasuredWidth(sourceNode.id) ?? sourceNode.data?.width ??
    (sourceNode.type === 'sceneNode' ? 220 : 160)
  return {
    sourceX: sourceNode.position.x + sw,
    sourceY: sourceNode.position.y + 16,
    targetX: targetNode.position.x,
    targetY: targetNode.position.y + 16,
  }
}

/**
 * Build a map of edge ID → actual {sourceX, sourceY, targetX, targetY}
 * using React Flow's internal node handle bounds.
 *
 * This must be called from a React component context (needs getInternalNode
 * from useReactFlow()).  The resulting map is passed into the store's
 * tidyWires action so it can use pixel-accurate handle positions instead
 * of the fixed y+16 estimate.
 *
 * @param {object[]} edges — all edges from store
 * @param {(id: string) => object|undefined} getInternalNode — from useReactFlow()
 * @returns {Map<string, {sourceX: number, sourceY: number, targetX: number, targetY: number}>}
 */
export function buildHandlePositionMap(edges, getInternalNode) {
  const map = new Map()

  for (const edge of edges) {
    if (edge.type !== 'transitionEdge') continue

    const srcInternal = getInternalNode(edge.source)
    const tgtInternal = getInternalNode(edge.target)
    if (!srcInternal || !tgtInternal) continue

    const srcBounds = srcInternal.internals.handleBounds
    const tgtBounds = tgtInternal.internals.handleBounds
    if (!srcBounds || !tgtBounds) continue

    // Find the specific handles by ID (matching React Flow's getHandle logic)
    const srcHandle = edge.sourceHandle
      ? srcBounds.source?.find((h) => h.id === edge.sourceHandle)
      : srcBounds.source?.[0]
    const tgtHandle = edge.targetHandle
      ? tgtBounds.target?.find((h) => h.id === edge.targetHandle)
      : tgtBounds.target?.[0]
    if (!srcHandle || !tgtHandle) continue

    // Replicate React Flow's getHandlePosition logic:
    //   Position.Right  → { x: handle.x + width, y: handle.y + height/2 }
    //   Position.Left   → { x: handle.x,         y: handle.y + height/2 }
    const srcAbs = srcInternal.internals.positionAbsolute
    const tgtAbs = tgtInternal.internals.positionAbsolute

    const sw = srcHandle.width ?? 1, sh = srcHandle.height ?? 1
    const th = tgtHandle.height ?? 1

    // Source handle is Position.Right (output), target is Position.Left (input)
    map.set(edge.id, {
      sourceX: srcHandle.x + sw + srcAbs.x,
      sourceY: srcHandle.y + sh / 2 + srcAbs.y,
      targetX: tgtHandle.x + tgtAbs.x,
      targetY: tgtHandle.y + th / 2 + tgtAbs.y,
    })
  }

  return map
}

// ── Handle Y estimation (for routing order) ──────────────────────────────

const HEADER_HEIGHT = 36 // approximate SceneNode header height (title area)
const CHIP_HEIGHT = 28   // approximate height per entity chip row

/**
 * Estimate the Y position of an edge's source handle on the canvas.
 *
 * For SceneNode sources, this uses the entity chip's position within the
 * node's bucket ordering (characters → locations → items → factions → customs).
 * The relative ordering is what matters — it determines which wires route
 * through upper vs. lower tracks in the channel.
 */
export function estimateHandleY(edge, nodeMap) {
  const sourceNode = nodeMap.get(edge.source)
  if (!sourceNode) return 0

  // EntityNode: fixed handle at top: 16
  if (sourceNode.type === 'entityNode') {
    return sourceNode.position.y + 16
  }

  // SceneNode: find the chip's vertical index
  const entityId = edge.data?.source_entity_id
  if (!entityId) return sourceNode.position.y + 16

  let chipIndex = 0
  for (const bucket of ENTITY_BUCKETS) {
    const refs = sourceNode.data?.[bucket] || []
    for (const ref of refs) {
      if (ref.entity_id === entityId) {
        return sourceNode.position.y + HEADER_HEIGHT + chipIndex * CHIP_HEIGHT + CHIP_HEIGHT / 2
      }
      chipIndex++
    }
  }

  return sourceNode.position.y + 16 // fallback
}

// ── Waypoint type selection ────────────────────────────────────────────────

// ── Main entry point ──────────────────────────────────────────────────────

/**
 * Compute auto-routed waypoints for a single edge.
 *
 * @param {number} sourceX
 * @param {number} sourceY
 * @param {number} targetX
 * @param {number} targetY
 * @param {{ left, top, right, bottom }[]} obstacles — padded bounding boxes
 * @returns {{ t, offsetX, offsetY, type }[]} — relative waypoints (may be empty)
 */
export function computeTidyWaypoints(sourceX, sourceY, targetX, targetY, obstacles) {
  if (obstacles.length === 0) return []

  // Quick check: direct path clear?
  const directBlocked = obstacles.some((rect) =>
    segmentIntersectsRect(sourceX, sourceY, targetX, targetY, rect),
  )
  if (!directBlocked) return []

  // Build visibility graph and find shortest obstacle-free path
  const source = { x: sourceX, y: sourceY }
  const target = { x: targetX, y: targetY }
  const { vertices, adjacency } = buildVisibilityGraph(source, target, obstacles)
  const path = dijkstra(vertices, adjacency, 0, 1) // 0 = source, 1 = target

  if (!path || path.length <= 2) return [] // no intermediate waypoints needed

  // Convert intermediate path points — always 'sharp' so rendered straight-line
  // segments exactly match the visibility-checked paths (Catmull-Rom curves
  // can overshoot into obstacles)
  const pathPts = path.map((idx) => vertices[idx])
  const waypoints = []
  for (let i = 1; i < pathPts.length - 1; i++) {
    waypoints.push(
      toRelativeWaypoint(sourceX, sourceY, targetX, targetY, pathPts[i].x, pathPts[i].y, 'sharp'),
    )
  }

  waypoints.sort((a, b) => a.t - b.t)
  return waypoints
}

// ── Solved-route-as-obstacle conversion ───────────────────────────────────

/** Half-width of the thin rectangular obstacle created from each route segment. */
const ROUTE_OBSTACLE_HALF_WIDTH = 6

/**
 * Convert a routed path into thin axis-aligned rectangular obstacles.
 *
 * Each segment between consecutive points (source → waypoint → … → target)
 * becomes an AABB expanded by ROUTE_OBSTACLE_HALF_WIDTH. These are added to
 * the obstacle list so subsequent wires route around already-solved paths.
 *
 * @param {object[]} waypoints — relative waypoints
 * @param {number} sourceX
 * @param {number} sourceY
 * @param {number} targetX
 * @param {number} targetY
 * @returns {{ left, top, right, bottom }[]}
 */
export function routeToObstacles(waypoints, sourceX, sourceY, targetX, targetY) {
  const resolved = resolveWaypoints(sourceX, sourceY, targetX, targetY, waypoints)
  const pts = [
    { x: sourceX, y: sourceY },
    ...resolved,
    { x: targetX, y: targetY },
  ]

  const obstacles = []
  const hw = ROUTE_OBSTACLE_HALF_WIDTH
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]
    obstacles.push({
      left:   Math.min(a.x, b.x) - hw,
      top:    Math.min(a.y, b.y) - hw,
      right:  Math.max(a.x, b.x) + hw,
      bottom: Math.max(a.y, b.y) + hw,
    })
  }
  return obstacles
}

// ── Path simplification ──────────────────────────────────────────────────

/**
 * Remove unnecessary waypoints by testing whether shortcuts are clear.
 *
 * Greedy forward scan: from each waypoint, find the farthest subsequent
 * waypoint reachable by a direct line that doesn't intersect any obstacle,
 * then skip all intermediate waypoints.
 *
 * Re-evaluates sharp/curve type at each remaining waypoint based on the
 * new surrounding geometry.
 */
export function simplifyPath(waypoints, sourceX, sourceY, targetX, targetY, obstacles) {
  if (waypoints.length <= 1) return waypoints

  const resolved = resolveWaypoints(sourceX, sourceY, targetX, targetY, waypoints)
  const pts = [
    { x: sourceX, y: sourceY },
    ...resolved,
    { x: targetX, y: targetY },
  ]

  // Greedy: from each kept point, skip as far ahead as possible
  const kept = [0]
  let i = 0
  while (i < pts.length - 1) {
    let farthest = i + 1
    for (let j = pts.length - 1; j > i + 1; j--) {
      const blocked = obstacles.some((r) =>
        segmentIntersectsRect(pts[i].x, pts[i].y, pts[j].x, pts[j].y, r),
      )
      if (!blocked) { farthest = j; break }
    }
    kept.push(farthest)
    i = farthest
  }

  // Convert back to relative waypoints (skip endpoints at first and last)
  // Always 'sharp' — matches visibility-checked straight-line segments
  const result = []
  for (let k = 1; k < kept.length - 1; k++) {
    const idx = kept[k]
    const pt = pts[idx]
    result.push(toRelativeWaypoint(sourceX, sourceY, targetX, targetY, pt.x, pt.y, 'sharp'))
  }
  result.sort((a, b) => a.t - b.t)
  return result
}

// ── Parallel sibling routing ──────────────────────────────────────────────

/** Spacing in canvas-px between parallel sibling wires. */
const PARALLEL_SPACING = 15

/**
 * Offset a set of waypoints perpendicular to the route direction.
 *
 * At each waypoint, computes the local wire direction from the previous
 * point to the next, rotates 90° to get the perpendicular, and shifts
 * the waypoint by `perpOffset` canvas-px in that direction.
 *
 * @param {object[]} waypoints — relative waypoints
 * @param {number} sourceX
 * @param {number} sourceY
 * @param {number} targetX
 * @param {number} targetY
 * @param {number} perpOffset — signed offset (positive = CCW perpendicular)
 * @returns {object[]} — new relative waypoints with the offset applied
 */
export function offsetRouteWaypoints(waypoints, sourceX, sourceY, targetX, targetY, perpOffset) {
  if (waypoints.length === 0 || perpOffset === 0) return waypoints

  const resolved = resolveWaypoints(sourceX, sourceY, targetX, targetY, waypoints)
  const pts = [
    { x: sourceX, y: sourceY },
    ...resolved,
    { x: targetX, y: targetY },
  ]

  const result = []
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1], curr = pts[i], next = pts[i + 1]
    // Average of incoming and outgoing direction
    const dirX = (curr.x - prev.x) + (next.x - curr.x)
    const dirY = (curr.y - prev.y) + (next.y - curr.y)
    const len = Math.sqrt(dirX * dirX + dirY * dirY)
    if (len < 1) {
      result.push(waypoints[i - 1])
      continue
    }
    // Perpendicular (90° CCW rotation)
    const perpX = -dirY / len
    const perpY = dirX / len
    const newX = curr.x + perpX * perpOffset
    const newY = curr.y + perpY * perpOffset
    result.push(
      toRelativeWaypoint(sourceX, sourceY, targetX, targetY, newX, newY, waypoints[i - 1].type),
    )
  }
  result.sort((a, b) => a.t - b.t)
  return result
}

/**
 * Compute the perpendicular offset for the Nth wire in a sibling group of size count.
 * Centers the group around 0: offsets are -spacing*(count-1)/2, ..., 0, ..., +spacing*(count-1)/2
 */
export function siblingOffset(index, count) {
  if (count <= 1) return 0
  return PARALLEL_SPACING * (index - (count - 1) / 2)
}

// ── Cross-wire waypoint deconfliction ─────────────────────────────────────

const DECONFLICT_DIST = 15

/**
 * Nudge waypoints from different edges apart when they overlap.
 *
 * Mutates `edgeRoutes[].waypoints` in place.
 *
 * @param {{ edgeId: string, waypoints: object[], sourceX: number, sourceY: number, targetX: number, targetY: number }[]} edgeRoutes
 */
export function deconflictWaypoints(edgeRoutes) {
  const minSq = DECONFLICT_DIST * DECONFLICT_DIST

  // Resolve all waypoints to absolute positions for comparison
  const resolved = edgeRoutes.map((er) => ({
    ...er,
    abs: resolveWaypoints(er.sourceX, er.sourceY, er.targetX, er.targetY, er.waypoints),
  }))

  for (let a = 0; a < resolved.length; a++) {
    for (let b = a + 1; b < resolved.length; b++) {
      for (let i = 0; i < resolved[a].abs.length; i++) {
        for (let j = 0; j < resolved[b].abs.length; j++) {
          const pa = resolved[a].abs[i], pb = resolved[b].abs[j]
          const dx = pa.x - pb.x, dy = pa.y - pb.y
          if (dx * dx + dy * dy >= minSq) continue

          // Compute perpendicular to edge B's local wire direction at point j
          const er = resolved[b]
          const pts = [
            { x: er.sourceX, y: er.sourceY },
            ...er.abs,
            { x: er.targetX, y: er.targetY },
          ]
          const pi = j + 1 // index in pts (offset by 1 for source)
          const prev = pts[pi - 1], next = pts[pi + 1] || pts[pi]
          const dirX = next.x - prev.x, dirY = next.y - prev.y
          const len = Math.sqrt(dirX * dirX + dirY * dirY)
          if (len < 1) continue

          const perpX = -dirY / len, perpY = dirX / len
          const newX = pb.x + perpX * DECONFLICT_DIST
          const newY = pb.y + perpY * DECONFLICT_DIST

          // Update edge B's waypoint
          const newRel = toRelativeWaypoint(
            er.sourceX, er.sourceY, er.targetX, er.targetY,
            newX, newY, er.waypoints[j].type,
          )
          er.waypoints[j] = newRel
          resolved[b].abs[j] = { x: newX, y: newY, type: newRel.type }
        }
      }
    }
  }
}

// ── Transition note dot positioning ───────────────────────────────────────

/**
 * Find a visible position for the transition note dot along the tidied path.
 *
 * Starts at the path midpoint and walks outward in both directions until
 * finding a spot that isn't behind any node bounding box. Returns the
 * label_offset_x/y values that place the dot at that clear position.
 *
 * @param {number} sourceX
 * @param {number} sourceY
 * @param {number} targetX
 * @param {number} targetY
 * @param {object[]} waypoints — relative waypoints for the path
 * @param {{ left, top, right, bottom }[]} allNodeBBoxes — ALL node bounding boxes (unpadded)
 * @returns {{ label_offset_x: number, label_offset_y: number }}
 */
export function findClearDotPosition(sourceX, sourceY, targetX, targetY, waypoints, allNodeBBoxes) {
  const resolved = resolveWaypoints(sourceX, sourceY, targetX, targetY, waypoints)
  const pathStr = waypoints.length > 0
    ? buildWaypointPath(sourceX, sourceY, targetX, targetY, resolved)
    : null

  const mid = pathStr
    ? getPointOnPath(pathStr, 0.5)
    : { x: (sourceX + targetX) / 2, y: (sourceY + targetY) / 2 }

  // Check if midpoint is clear
  if (!allNodeBBoxes.some((r) => isPointInsideRect(mid.x, mid.y, r))) {
    return { label_offset_x: 0, label_offset_y: 0 }
  }

  // Walk along path to find a clear spot
  if (!pathStr) return { label_offset_x: 0, label_offset_y: 0 }

  for (let dt = 0.05; dt <= 0.45; dt += 0.05) {
    for (const t of [0.5 + dt, 0.5 - dt]) {
      if (t < 0.05 || t > 0.95) continue
      const pt = getPointOnPath(pathStr, t)
      if (!allNodeBBoxes.some((r) => isPointInsideRect(pt.x, pt.y, r))) {
        return { label_offset_x: pt.x - mid.x, label_offset_y: pt.y - mid.y }
      }
    }
  }

  return { label_offset_x: 0, label_offset_y: 0 } // fallback
}
