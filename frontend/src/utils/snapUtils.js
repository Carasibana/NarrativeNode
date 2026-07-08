/**
 * snapUtils — shared snap-to-grid helpers used by the canvas drag /
 * resize paths so every surface rounds to the same grid.
 *
 * Phase 1.12c v0.1.12.63. Constants duplicated in:
 *   - frontend/src/components/canvas/Canvas.jsx (drag path)
 *   - frontend/src/store/projectStore.js (bulk snap action)
 *
 * Kept in sync manually — if you change SNAP_STEP or SNAP_POS_OFFSET
 * here, update the other two call sites too.
 *
 * `SNAP_POS_OFFSET = 10` matches the <Background gap={20}> dot
 * pattern, which renders dots at the CENTRE of each 20-px cell, i.e.
 * at flow-space (10, 10), (30, 10), (50, 10)… Positions are rounded
 * with that offset so snapped node top-left corners land on dots.
 * Dimensions are plain multiples of SNAP_STEP — combined with the
 * offset position, both the left AND right edge of a snapped node
 * land on dot columns.
 */

export const SNAP_STEP = 20
export const SNAP_POS_OFFSET = 10

/** Round a flow-space x or y to the nearest snap dot. */
export function snapPosition(v) {
  return Math.round((v - SNAP_POS_OFFSET) / SNAP_STEP) * SNAP_STEP + SNAP_POS_OFFSET
}

/** Round a flow-space width or height to the nearest grid step. */
export function snapDimension(v) {
  return Math.max(SNAP_STEP, Math.round(v / SNAP_STEP) * SNAP_STEP)
}

/** Round a flow-space width or height UP to the next grid step
 *  (used by `snapAllNodesToGrid` so bulk-snap never shrinks a node). */
export function snapDimensionUp(v) {
  return Math.max(SNAP_STEP, Math.ceil(v / SNAP_STEP) * SNAP_STEP)
}

/**
 * Tolerance-aware ceiling-round used by `snapAllNodesToGrid`. If the
 * value sits within `tolerance` pixels ABOVE a lower grid step, it
 * snaps DOWN to that step; otherwise it ceiling-rounds UP.
 *
 * Motivation: React Flow's `measured.width` / `measured.height` for a
 * custom node can drift 1-2 px above the content's natural size due
 * to border / padding / sub-pixel rounding inside the outer wrapper
 * div. A plain `Math.ceil(v / 20) * 20` then overshoots to the next
 * grid step (e.g. 81 → 100, 162 → 180). The user sees a minimal
 * entity origin node get 20 px taller than expected after Ctrl+click
 * snap.
 *
 * A 2-px tolerance covers that drift without breaking the content-
 * safety guarantee for nodes that legitimately need more space — a
 * plot point node with chips at 147 px still rounds up to 160
 * (147 - 140 = 7 > 2, so snap up), so no chip gets clipped.
 */
export function snapDimensionUpWithTolerance(v, tolerance = 2) {
  const floor = Math.floor(v / SNAP_STEP) * SNAP_STEP
  if (v - floor <= tolerance) {
    return Math.max(SNAP_STEP, floor)
  }
  return Math.max(SNAP_STEP, Math.ceil(v / SNAP_STEP) * SNAP_STEP)
}

/**
 * Snap-aware wrapper for NodeResizeControl's `onResize` callback
 * dimensions. Each node type's resize handler reads the live
 * `snapToGrid` flag from `projectStore` and passes the raw dimensions
 * through here; when snap is OFF the dimensions return unchanged,
 * when ON they round to multiples of `SNAP_STEP`. Keeps the resize-
 * path branching out of the node components.
 *
 * Takes the projectStore as a parameter (not imported) so this file
 * stays import-cycle-free — callers pass `useProjectStore.getState`
 * or the `snapToGrid` flag directly.
 */
export function applyResizeSnap({ width, height }, snapEnabled) {
  if (!snapEnabled) return { width, height }
  return {
    width: snapDimension(width),
    height: snapDimension(height),
  }
}

/**
 * Snap-aware wrapper for node-creation positions. Node-creation actions in
 * `projectStore.js` resolve a `{x, y}` position from a caller argument or a
 * sensible default, then pass it to this helper before stamping it on the
 * new node — so every new node drops onto the grid when snap is enabled,
 * matching the drag path's behaviour. When snap is disabled the position
 * passes through unchanged. Null-safe so actions can freely invoke it on
 * optional positions without guarding first.
 */
export function applyCreationPositionSnap(pos, snapEnabled) {
  if (!snapEnabled || !pos) return pos
  return {
    x: snapPosition(pos.x),
    y: snapPosition(pos.y),
  }
}
