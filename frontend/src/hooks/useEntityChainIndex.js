/**
 * useEntityChainIndex — scoped per-entity subscription hooks built
 * over the module-level cache in `utils/entityChainIndex.js`.
 *
 * Phase 3.7 perf fix #14 (large-project chip-wiring perf).
 *
 * `useEntityChainSignature(entityId)`:
 *   Subscribes to `(nodes, edges)` and returns the per-entity
 *   signature string from the cached index. Default Zustand
 *   `Object.is` equality skips re-render on store updates that
 *   don't change the signature for THIS entity.
 *
 *   Replaces `useProjectStore((s) => s.nodes)` + `useProjectStore((s) => s.edges)`
 *   at consumer sites that need the chain to recompute when this
 *   entity's chain inputs change. The consumer's chain-walk memo
 *   gates on the signature; inside the memo the consumer reads
 *   fresh `(nodes, edges)` via `useProjectStore.getState()`.
 *
 *   Chain-aware preservation: the signature captures the full
 *   EntityRef contents at every scene the entity appears in, plus
 *   every chain edge that could carry the entity forward. Any
 *   chain-tracked value change at any anchor produces a different
 *   signature → consumer re-renders → chain walker re-runs with
 *   fresh `(nodes, edges)`. This change scopes WHEN the chain
 *   walker re-runs, not WHAT it does.
 *
 * `useEntityHasIncomingChainEdge(entityId, nodeId)`:
 *   Returns the boolean orphan-check value. Built on the same
 *   cached index. The default `Object.is` equality skips re-render
 *   on store updates that don't change this entity's incoming
 *   chain-edge presence at this scene node. Replaces the inline
 *   `useStore((s) => !s.edges.some(...))` pattern that walked all
 *   edges on every store update.
 */

import { useProjectStore } from '../store/projectStore'
import {
  selectEntityChainSignature,
  selectEntityHasIncomingChainEdge,
} from '../utils/entityChainIndex'

export function useEntityChainSignature(entityId) {
  return useProjectStore((s) => selectEntityChainSignature(s.nodes, s.edges, entityId))
}

export function useEntityHasIncomingChainEdge(entityId, nodeId) {
  return useProjectStore((s) => selectEntityHasIncomingChainEdge(s.nodes, s.edges, entityId, nodeId))
}
