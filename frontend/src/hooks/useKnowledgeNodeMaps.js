/**
 * useKnowledgeNodeMaps — shared, memoized maps that answer the two
 * canonical "where does this Knowledge live on the canvas?" questions:
 *
 *   - `forwardMap`: `Map<knowledgeId, ReadonlyArray<nodeId>>`
 *       The same shape `getKnowledgeNodeOrder(k, n, e, so)` returns, but
 *       computed once for every Knowledge in the project, not per-call.
 *   - `reverseMap`: `Map<nodeId, ReadonlyArray<knowledgeId>>`
 *       The inverse — "which Knowledges have a chip on THIS scene /
 *       entity node?" Lets `SceneNode.knowledgeChipsAtScene` (and
 *       `EntityNode.knowledgeChipsAtNode`) become a single O(1) lookup.
 *
 * Before this hook landed, every Scene rendered its chip strip by
 * walking every Knowledge in the project (`getKnowledgeNodeOrder` per
 * (scene, knowledge) pair). For a story with 50 scenes and 30
 * knowledges that's 1,500 walks per dep-change tick AND each Scene
 * re-walks every Knowledge in isolation — same computation runs 50
 * times. The maps factor that work out: first consumer to render after
 * a `(knowledges, nodes, edges, storyOrder)` change pays the cost
 * once, every other consumer reads the shared cache.
 *
 * Caching strategy: a module-level entry keyed on the four reference
 * identities (`knowledges` / `nodes` / `edges` / `storyOrder`). Every
 * mutation path in the codebase produces a new reference for at least
 * one of these (Zustand discipline — immutable `.map()` / `.filter()`
 * / `[...spread]` updates throughout `projectStore`), so any change
 * that could affect a Knowledge's chain order invalidates the cache.
 * Stale entries are not possible.
 *
 * Same shape as `useStoryOrder`'s `_lastStoryOrderResult` cache — a
 * deliberate module-level memo that all consumers share. The
 * `react-hooks/globals` rule normally forbids this, but the cache
 * trivially invalidates on real change.
 */

import { useProjectStore } from '../store/projectStore'
import { useUiStore } from '../store/uiStore'
import { useStoryOrder, storyOrderNodesEqual, storyOrderEdgesEqual } from './useStoryOrder'
import { getKnowledgeNodeOrder } from '../utils/narrativeChain'

const EMPTY_ARRAY = Object.freeze([])
const EMPTY_MAPS = Object.freeze({
  forwardMap: new Map(),
  reverseMap: new Map(),
  knowledgesById: new Map(),
})

// Module-level cache. Holds one tuple — the most recent compute. Keyed
// on the four input reference identities; replaced wholesale on miss.
let _cache = {
  knowledges: null,
  nodes: null,
  edges: null,
  storyOrder: null,
  maps: EMPTY_MAPS,
}

function _buildMaps(knowledges, nodes, edges, storyOrder) {
  const forwardMap = new Map()
  const reverseMap = new Map()
  const knowledgesById = new Map()
  if (!Array.isArray(knowledges) || knowledges.length === 0) {
    return { forwardMap, reverseMap, knowledgesById }
  }
  for (const k of knowledges) {
    knowledgesById.set(k.id, k)
    const ordered = getKnowledgeNodeOrder(k, nodes, edges, storyOrder)
    forwardMap.set(k.id, ordered)
    for (const nodeId of ordered) {
      const list = reverseMap.get(nodeId)
      if (list) list.push(k.id)
      else reverseMap.set(nodeId, [k.id])
    }
  }
  return { forwardMap, reverseMap, knowledgesById }
}

// Resolve the shared maps through the module cache. Identity hit → stale
// maps (stable identity, no consumer re-render). Identity miss but
// nodes/edges structurally equal AND knowledges + storyOrder identity
// unchanged → refresh the cached input refs but keep the SAME maps object
// (the chain order walks read only the structural slice
// `storyOrderNodesEqual` / `storyOrderEdgesEqual` already cover). The
// module cache means only the FIRST consumer per store change pays the
// structural compare; every other consumer hits the refreshed identity.
function _resolveKnowledgeMaps(knowledges, nodes, edges, storyOrder) {
  if (
    _cache.knowledges === knowledges
    && _cache.nodes === nodes
    && _cache.edges === edges
    && _cache.storyOrder === storyOrder
  ) {
    return _cache.maps
  }
  if (
    _cache.maps !== EMPTY_MAPS
    && _cache.knowledges === knowledges
    && _cache.storyOrder === storyOrder
    && storyOrderNodesEqual(_cache.nodes, nodes)
    && storyOrderEdgesEqual(_cache.edges, edges)
  ) {
    _cache = { knowledges, nodes, edges, storyOrder, maps: _cache.maps }
    return _cache.maps
  }
  const maps = _buildMaps(knowledges, nodes, edges, storyOrder)
  _cache = { knowledges, nodes, edges, storyOrder, maps }
  return maps
}

// Single stable-identity subscription. The old hook held raw `s.nodes` +
// `s.edges` subscriptions, so every nodes/edges array-identity write
// re-rendered every consumer even when the maps were unchanged. Now:
// storyOrder via the stable `useStoryOrder` (gesture + fitView gated), a
// cheap gesture-flag subscription, and one projectStore selector that
// returns the shared maps object — short-circuiting to the stale maps
// during a continuous canvas gesture so drag frames never rebuild.
export function useKnowledgeNodeMaps() {
  const storyOrder = useStoryOrder()
  const gestureActive = useUiStore((s) => s.isDraggingNodes || s.canvasGestureActive)
  return useProjectStore((s) => {
    if (gestureActive && _cache.maps !== EMPTY_MAPS) return _cache.maps
    return _resolveKnowledgeMaps(s.knowledges, s.nodes, s.edges, storyOrder)
  })
}

/**
 * Convenience accessor — returns the ReadonlyArray<knowledgeId> for the
 * given node id, or the shared `EMPTY_ARRAY` singleton when no
 * Knowledges touch it (avoids per-call allocations on render-hot paths
 * like SceneNode chip strips).
 */
export function knowledgesAtNode(reverseMap, nodeId) {
  return reverseMap.get(nodeId) || EMPTY_ARRAY
}
