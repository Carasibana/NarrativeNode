/**
 * useRelationshipNodeMaps — shared, memoized maps that cache
 * `getRelationshipNodeOrder` across every consumer in the canvas.
 *
 *   - `forwardMap`: `Map<relId, ReadonlyArray<nodeId>>`
 *       The same shape `getRelationshipNodeOrder(rel, n, e, so)` returns,
 *       but computed once for every Relationship in the project rather
 *       than per-(scene, rel) pair.
 *   - `relationshipsById`: `Map<relId, Relationship>`
 *       Direct id-to-relationship lookup so callers can resolve ids
 *       back to objects without iterating the array.
 *
 * Same pattern as `useKnowledgeNodeMaps` (Perf #7). Sister fix to that
 * one: SceneNode's `relChipsAtScene` ran the order walk for every
 * relationship in the project on every render — and each order walk
 * walks every current participant's narrative chain — so the cost
 * compounded across (scenes × relationships × participants).
 *
 * `computeRelationshipEffectiveState` is NOT cached here — it depends
 * on `atNodeId` (scene-specific) and would need a 2-D map keyed on
 * (relId, sceneId). The expensive part of the per-scene work is
 * `getRelationshipNodeOrder` (the participant-chain walks); the
 * effective-state compute stays where it is.
 *
 * Caching strategy: module-level entry keyed on the four reference
 * identities (`relationships` / `nodes` / `edges` / `storyOrder`).
 * Every mutation path in `projectStore` produces a new reference for
 * at least one of these via immutable update discipline (verified for
 * relationship add / edit / delete, history mutations, participant
 * changes, node deletion cascades, edge changes, storyOrder rebuilds
 * via `useStoryOrder`). Stale entries are not possible.
 */

import { useProjectStore } from '../store/projectStore'
import { useUiStore } from '../store/uiStore'
import { useStoryOrder, storyOrderNodesEqual, storyOrderEdgesEqual } from './useStoryOrder'
import { getRelationshipNodeOrder } from '../utils/narrativeChain'

const EMPTY_ARRAY = Object.freeze([])
const EMPTY_MAPS = Object.freeze({
  forwardMap: new Map(),
  relationshipsById: new Map(),
})

let _cache = {
  relationships: null,
  nodes: null,
  edges: null,
  storyOrder: null,
  maps: EMPTY_MAPS,
}

function _buildMaps(relationships, nodes, edges, storyOrder) {
  const forwardMap = new Map()
  const relationshipsById = new Map()
  if (!Array.isArray(relationships) || relationships.length === 0) {
    return { forwardMap, relationshipsById }
  }
  for (const rel of relationships) {
    relationshipsById.set(rel.id, rel)
    forwardMap.set(rel.id, getRelationshipNodeOrder(rel, nodes, edges, storyOrder))
  }
  return { forwardMap, relationshipsById }
}

// Resolve the shared maps for the given inputs through the module cache.
// Identity hit → stale maps (stable identity, no consumer re-render).
// Identity miss but nodes/edges structurally equal AND relationships +
// storyOrder identity unchanged → refresh the cached input refs but keep
// the SAME maps object (the order walks read only the structural slice
// `storyOrderNodesEqual` / `storyOrderEdgesEqual` already cover, so an
// array-identity churn that doesn't touch that slice cannot change the
// maps). Otherwise rebuild. The module cache means only the FIRST
// consumer per store change pays the structural compare; every other
// consumer that store-change hits the refreshed identity fast-path.
function _resolveRelationshipMaps(relationships, nodes, edges, storyOrder) {
  if (
    _cache.relationships === relationships
    && _cache.nodes === nodes
    && _cache.edges === edges
    && _cache.storyOrder === storyOrder
  ) {
    return _cache.maps
  }
  if (
    _cache.maps !== EMPTY_MAPS
    && _cache.relationships === relationships
    && _cache.storyOrder === storyOrder
    && storyOrderNodesEqual(_cache.nodes, nodes)
    && storyOrderEdgesEqual(_cache.edges, edges)
  ) {
    _cache = { relationships, nodes, edges, storyOrder, maps: _cache.maps }
    return _cache.maps
  }
  const maps = _buildMaps(relationships, nodes, edges, storyOrder)
  _cache = { relationships, nodes, edges, storyOrder, maps }
  return maps
}

// Single stable-identity subscription. The old hook held raw `s.nodes` +
// `s.edges` subscriptions, so every nodes/edges array-identity write
// re-rendered every consumer (173 SceneNodes etc.) even when the maps
// were unchanged — a leading slice of the full-canvas broadcast commits.
// Now: storyOrder via the stable `useStoryOrder` (gesture + fitView
// gated), a cheap gesture-flag subscription, and one projectStore
// selector that returns the shared maps object. During a continuous
// canvas gesture the selector short-circuits to the stale maps so drag
// frames never rebuild (the order walks don't depend on position, but
// `storyOrderNodesEqual` does — without the gate every drag frame would
// fail the structural compare and rebuild).
export function useRelationshipNodeMaps() {
  const storyOrder = useStoryOrder()
  const gestureActive = useUiStore((s) => s.isDraggingNodes || s.canvasGestureActive)
  return useProjectStore((s) => {
    if (gestureActive && _cache.maps !== EMPTY_MAPS) return _cache.maps
    return _resolveRelationshipMaps(s.relationships, s.nodes, s.edges, storyOrder)
  })
}

/** Returns the cached `ReadonlyArray<nodeId>` for the given relationship,
 *  or the shared `EMPTY_ARRAY` singleton when none — avoids per-call
 *  allocations on render-hot paths. */
export function relationshipNodeOrder(forwardMap, relId) {
  return forwardMap.get(relId) || EMPTY_ARRAY
}
