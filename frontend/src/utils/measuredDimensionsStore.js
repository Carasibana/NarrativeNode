/**
 * measuredDimensionsStore — side store for React Flow's auto-measured
 * node dimensions.
 *
 * Phase 4.1g #4. React Flow's ResizeObserver measurements used to be
 * applied back into `projectStore.nodes` (rAF-coalesced), which
 * replaced the whole `nodes` array identity per flush. Every such
 * write re-rendered every `s.nodes` subscriber and re-armed a fresh
 * measurement pass: the measure → write → re-render → re-measure
 * loop behind the post-load commit storms, plus a full-canvas
 * aftershock ~1 s after every mutation. Measured dimensions are
 * renderer bookkeeping — never persisted, never part of undo — so
 * they don't belong in the primary store at all.
 *
 * They now live here: a module-level Map keyed by node id, written
 * directly from `onNodesChange` (no store write, no array identity
 * change, no re-render wave). React Flow keeps its own internal copy
 * for layout/rendering; this map exists so app code outside the
 * React Flow provider (store actions, pure geometry utils) can read
 * fresh measurements.
 *
 * Read precedence at consumer call sites: `node.measured` FIRST
 * (only present when an explicit action set it — collapsed reference
 * nodes at load and on toggle, snap-to-grid, silent layout
 * corrections — and authoritative there: collapsed reference nodes
 * deliberately suppress their ResizeObserver changes, so this store
 * would be stale for them), THEN this side store (the fresh
 * measurement for every ordinary node), then the persisted
 * `data.width` / `style` / top-level fields, then type defaults.
 *
 * Reactivity: writes bump a version counter, notified on a rAF so a
 * measurement burst (~288 changes on a big load) coalesces into a
 * handful of notifications. Every current consumer reads at
 * event/action time (drag-start captures, layout actions, story
 * ordering, tool calls), so nothing subscribes yet; the
 * subscribe/version pair exists for any future render-path consumer
 * (wrap it in `useSyncExternalStore`). This module stays React-free
 * so pure geometry utils (chapterMembership, groupMembership,
 * wireTidyUtils) can import from it without pulling React into
 * their dependency graph.
 */

const _dims = new Map()
let _version = 0
const _listeners = new Set()
let _notifyRafHandle = null

function _notifySoon() {
  if (_notifyRafHandle !== null) return
  const fire = () => {
    _notifyRafHandle = null
    for (const l of _listeners) {
      try { l() } catch { /* listener errors must not break the loop */ }
    }
  }
  _notifyRafHandle = (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function')
    ? window.requestAnimationFrame(fire)
    : setTimeout(fire, 16)
}

/**
 * Apply a batch of React Flow `dimensions` changes
 * (`{ id, dimensions: { width, height } }`). Sub-pixel re-measurements
 * (< 1px delta) are dropped — ResizeObserver re-emits unchanged sizes
 * after large re-renders, and echoing those was the original feedback
 * loop's fuel.
 */
export function applyMeasuredDimensionChanges(changes) {
  let applied = false
  for (const c of changes) {
    if (!c?.id || !c.dimensions) continue
    const cur = _dims.get(c.id)
    if (cur
        && Math.abs(cur.width - c.dimensions.width) < 1
        && Math.abs(cur.height - c.dimensions.height) < 1) continue
    _dims.set(c.id, { width: c.dimensions.width, height: c.dimensions.height })
    applied = true
  }
  if (applied) {
    _version += 1
    _notifySoon()
  }
}

/** Drop a node's measurement (node deleted). */
export function dropMeasuredDimensions(nodeId) {
  if (_dims.delete(nodeId)) {
    _version += 1
    _notifySoon()
  }
}

/** Reset on project load — stale ids from the prior project must not linger. */
export function clearMeasuredDimensions() {
  if (_dims.size === 0) return
  _dims.clear()
  _version += 1
  _notifySoon()
}

export function getMeasuredDimensions(nodeId) {
  return _dims.get(nodeId) || null
}

export function getMeasuredWidth(nodeId) {
  return _dims.get(nodeId)?.width ?? null
}

export function getMeasuredHeight(nodeId) {
  return _dims.get(nodeId)?.height ?? null
}

/** Subscribe to measurement changes (rAF-coalesced). Returns an unsubscribe fn. */
export function subscribeMeasuredDimensions(listener) {
  _listeners.add(listener)
  return () => _listeners.delete(listener)
}

/** Monotonic version counter — bumps whenever any node's measurement changes. */
export function getMeasuredDimensionsVersion() {
  return _version
}
