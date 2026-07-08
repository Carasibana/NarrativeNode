/**
 * POV sequence computation — single source of truth for the POV chain.
 *
 * The POV chain is a linear sequence of scene node IDs defined by following
 * POV wires from the POV Origin Node through each scene's pov-out handle.
 *
 * All components that need POV chain data should use these functions
 * instead of computing the chain inline.
 */

/**
 * Compute the full POV chain from nodes and edges.
 *
 * Returns {
 *   sequence: [{ nodeId, povEntityId, index }],  — ordered 1-based
 *   reachable: Set<nodeId>,                      — all nodes reachable from origin (including origin)
 *   originId: string | null,                     — the POV origin node ID
 * }
 *
 * @param {Array} nodes   — React Flow nodes array
 * @param {Array} edges   — React Flow edges array
 */
export function computePovChain(nodes, edges) {
  const povEdges = edges.filter((e) => e.data?.is_pov_path)
  const origin = nodes.find((n) => n.type === 'povOriginNode')

  if (!origin) {
    return { sequence: [], reachable: new Set(), originId: null }
  }

  // Walk forward from origin through POV wires
  const reachable = new Set()
  const sequence = []
  let current = origin.id
  let idx = 0

  while (current) {
    if (reachable.has(current)) break  // safety: prevent infinite loop
    reachable.add(current)

    const outgoing = povEdges.find((e) => e.source === current)
    if (!outgoing) break

    current = outgoing.target
    idx++

    // Only scene (plot point) nodes get sequence entries
    const node = nodes.find((n) => n.id === current)
    if (node?.type === 'sceneNode') {
      sequence.push({
        nodeId: current,
        povEntityId: node.data?.pov_entity_id || null,
        index: idx,
      })
    }
  }

  return { sequence, reachable, originId: origin.id }
}

/**
 * Get the 1-based chain index for a specific node, or null if not in the chain.
 */
export function getPovChainIndex(chain, nodeId) {
  const entry = chain.sequence.find((s) => s.nodeId === nodeId)
  return entry ? entry.index : null
}

/**
 * Check if a node can trace back to the POV Origin Node.
 */
export function isReachableFromOrigin(chain, nodeId) {
  return chain.reachable.has(nodeId)
}

/**
 * Check if adding an edge from sourceId → targetId would create a cycle in the POV chain.
 * Uses the provided edges (after any pre-filtering like removing old wires).
 */
export function wouldCreatePovLoop(nodes, edges, sourceId, targetId) {
  const povEdges = edges.filter((e) => e.data?.is_pov_path)
  // Walk forward from target through existing POV edges — if we reach source, it's a loop
  const visited = new Set()
  const queue = [targetId]
  while (queue.length > 0) {
    const nodeId = queue.pop()
    if (visited.has(nodeId)) continue
    visited.add(nodeId)
    for (const e of povEdges) {
      if (e.source === nodeId) {
        if (e.target === sourceId) return true
        queue.push(e.target)
      }
    }
  }
  return false
}

// ── Shared cache + React hook ────────────────────────────────────────────────

import { useProjectStore } from '../store/projectStore'

// Phase 4.1g follow-up #2 — stable-identity POV chain. The old hook held
// raw `s.nodes` + `s.edges` subscriptions PER CONSUMER INSTANCE (173
// SceneNodes + 174 SceneTimeRows + 47 EntityNodes...), so every
// nodes-array identity write re-rendered all of them even when the POV
// chain was unchanged — the 2026-06-12 comparative forensics measured
// this as a leading slice of the ~2,800-fiber broadcast commits. The
// hook is now a single projectStore subscription resolving through this
// module cache; on recompute, a result-equivalence check keeps returning
// the PRIOR object when the chain is unchanged, so consumers re-render
// only when the POV chain actually changed.
let _chainCache = { nodes: null, edges: null, result: null }

function _povResultsEquivalent(a, b) {
  if (!a || !b) return false
  if (a.originId !== b.originId) return false
  if (a.sequence.length !== b.sequence.length) return false
  for (let i = 0; i < a.sequence.length; i++) {
    const x = a.sequence[i], y = b.sequence[i]
    if (x.nodeId !== y.nodeId || x.povEntityId !== y.povEntityId || x.index !== y.index) return false
  }
  if (a.reachable.size !== b.reachable.size) return false
  for (const id of a.reachable) if (!b.reachable.has(id)) return false
  return true
}

/**
 * Cached POV-chain accessor: identity-keyed on `(nodes, edges)`, with a
 * result-equivalence dedup so the returned object identity survives
 * recomputes that produce an unchanged chain. Safe from selectors,
 * event handlers, and store actions.
 */
export function getOrComputePovChain(nodes, edges) {
  if (_chainCache.result && _chainCache.nodes === nodes && _chainCache.edges === edges) {
    return _chainCache.result
  }
  const fresh = computePovChain(nodes, edges)
  const result = (_chainCache.result && _povResultsEquivalent(_chainCache.result, fresh))
    ? _chainCache.result
    : fresh
  _chainCache = { nodes, edges, result }
  return result
}

/**
 * React hook that returns the current POV chain. Stable object identity:
 * consumers re-render only when the chain content changes.
 */
export function usePovChain() {
  return useProjectStore((s) => getOrComputePovChain(s.nodes, s.edges))
}
