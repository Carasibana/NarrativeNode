/**
 * useNodeDataById — scoped subscription to ONE canvas node's `data`.
 *
 * Phase 4.1g #2. Components that only need their own (or one other)
 * node's scene-side data were subscribing to the whole `s.nodes`
 * array, so every array-identity write (dimension flushes, other
 * nodes' edits, adds elsewhere) re-rendered them. This hook returns
 * the node's `data` reference instead: Zustand's `Object.is` equality
 * fires a re-render only when THIS node's data reference changes.
 * Immutable-update discipline guarantees that any actual edit to the
 * node replaces its `data` object, so no real change is ever missed;
 * writes that merely replace the array (or other nodes) keep the
 * same `data` reference and are skipped.
 *
 * The id → node map is a module-level cache rebuilt once per `nodes`
 * array identity; every subscriber then pays O(1) per store write
 * instead of an O(N) `.find()`.
 */
import { useProjectStore } from '../store/projectStore'

let _cache = { nodes: null, map: null }

export function selectNodeById(nodes, nodeId) {
  if (!nodeId) return null
  if (_cache.nodes !== nodes) {
    _cache = { nodes, map: new Map((nodes || []).map((n) => [n.id, n])) }
  }
  return _cache.map.get(nodeId) || null
}

export function useNodeDataById(nodeId) {
  return useProjectStore((s) => selectNodeById(s.nodes, nodeId)?.data || null)
}
