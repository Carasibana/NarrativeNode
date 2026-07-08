/**
 * edgeIndexes — lazily-built, identity-cached lookup indexes over the
 * project's edges array. Replaces ad-hoc `edges.filter(...)` scans on
 * hot-ish paths where the same question gets asked repeatedly.
 *
 * Currently exposes one index: `getEdgesByTargetHandle(edges)` returns a
 * `Map<"nodeId:handleId", Edge[]>` answering "which edges target this
 * (node, handle) pair?". Used by `PortHandle.handleClick` (gating the
 * WireListPopup open) and `WireListPopup.incoming` (rendering the
 * incoming list). Both previously did an O(N) `edges.filter` scan.
 *
 * Caching strategy: module-level cache keyed on the `edges` reference
 * identity. Every edge mutation in `projectStore` produces a new array
 * reference (Zustand immutable-update discipline), so the identity
 * check catches every real change. Stale entries are not possible.
 *
 * Helper `incomingAtTargetHandle(edges, nodeId, handleId)` performs
 * the build-if-needed + lookup in one call, returning a shared frozen
 * empty array when nothing targets the handle.
 */

const EMPTY_ARRAY = Object.freeze([])

let _cachedEdges = null
let _cachedMap = new Map()

function _buildByTargetHandle(edges) {
  const map = new Map()
  if (!Array.isArray(edges)) return map
  for (const edge of edges) {
    if (!edge?.target) continue
    const handle = edge.targetHandle ?? ''
    const key = `${edge.target}:${handle}`
    const list = map.get(key)
    if (list) list.push(edge)
    else map.set(key, [edge])
  }
  return map
}

export function getEdgesByTargetHandle(edges) {
  if (_cachedEdges === edges) return _cachedMap
  _cachedMap = _buildByTargetHandle(edges)
  _cachedEdges = edges
  return _cachedMap
}

export function incomingAtTargetHandle(edges, nodeId, handleId) {
  if (!nodeId) return EMPTY_ARRAY
  const map = getEdgesByTargetHandle(edges)
  const handle = handleId ?? ''
  return map.get(`${nodeId}:${handle}`) || EMPTY_ARRAY
}
