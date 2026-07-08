/**
 * entityChainIndex — per-entity chain-input digest cache.
 *
 * Phase 3.7 perf fix #14 (large-project chip-wiring perf).
 *
 * Problem solved:
 *   Per the post-v0.3.7.17 profile (`profiling-data.2026-06-06.11-58-30.json`),
 *   a single chip-wiring action triggers 7 separate blocking commits
 *   each 1.8-2.5 s with ~11,577 fiber re-renders per commit. Every
 *   EntityChip subscribes to `useProjectStore((s) => s.edges)` at
 *   `SceneNode.jsx:143`. Every edge mutation produces a new `edges`
 *   array reference → every chip's subscription reports a new value
 *   → every chip re-renders, even though most chips' chains aren't
 *   touched by the mutation. Profile change-descriptions confirm:
 *   all 560 EntityChip re-renders driven by hook index 14 (the
 *   `s.edges` subscription) only; zero props changes, zero context
 *   changes.
 *
 * Why a surface-fix (structural-equality comparator) doesn't help:
 *   Structural equality only saves the re-render when the array
 *   changed REFERENCE but not CONTENT. On a chip-wire, an edge was
 *   actually added; the content genuinely differs. We need to detect
 *   which entity that mutation affects and re-render only that
 *   entity's chips.
 *
 * Architecture:
 *   Maintain a single project-level index keyed by entityId. For each
 *   entityId, the index entry holds a digest string that captures
 *   every aspect of `(nodes, edges)` that the chain walker reads for
 *   that entity:
 *     1. Origin EntityNode id (changes if entity was re-instantiated)
 *     2. All chain-edge identities for this entity: every edge with
 *        `source_entity_id === entityId` OR `sourceHandle === entityId`,
 *        their `source`/`target`/`sourceHandle`/`is_relationship` flag
 *     3. All scene-node EntityRef entries for this entity: each
 *        bucket's EntityRef serialized so any field change (name,
 *        colour, has_pov, attribute_changes, etc.) invalidates the
 *        digest
 *     4. Incoming chain-edge presence per scene node (for the chip's
 *        orphan check; baked into the entry so the chip doesn't need
 *        a separate `s.edges` subscription)
 *
 *   Module-level cache keyed on `(nodes, edges)` reference identity.
 *   First call after a store change pays the rebuild; every other
 *   consumer in the same render tick reads through. Per-entity
 *   selectors get O(1) Map lookup against the cached signature.
 *
 *   Built once per `(nodes, edges)` ref change → 1 walk over nodes +
 *   1 walk over edges + per-entity digest assembly. Total per build:
 *   ~50 ms on large-scale projects (172 scenes × ~3 EntityRefs
 *   each = ~500 ref serializations). Replaces 1.8-2.5 s of per-edge
 *   re-render work. Cache reduces the cost to zero for any store
 *   update that doesn't change `(nodes, edges)` refs.
 *
 * Chain-aware preservation:
 *   The digest captures the FULL EntityRef contents at every scene
 *   the entity appears in, plus every chain edge that could carry
 *   the entity forward. Any chain-tracked value change (a `name_change`
 *   override at scene 7, an `attribute_changes` add, a `has_pov` flip)
 *   produces a different digest, triggering a re-render of that
 *   entity's chips, which re-runs the chain walker with fresh
 *   `(nodes, edges)` from `useProjectStore.getState()`. The change
 *   to subscription surface does not bypass the chain — it scopes
 *   WHEN the chain walker re-runs to mutations that actually affect
 *   THIS entity's chain.
 */

const ENTITY_BUCKETS = ['characters', 'locations', 'items', 'factions', 'customs']

// Module-level cache. Identity-equal `(nodes, edges)` refs hit; any
// single ref change rebuilds and replaces.
 
let _cache = { nodes: null, edges: null, result: null }

const EMPTY_STR = ''

function _hashString(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return h
}

/**
 * Returns `Map<entityId, { signature: string, hasIncomingChainEdgeAtNode: Map<nodeId, true> }>`.
 *
 * `signature` is a deterministic string capturing every input the
 * chain walker reads for this entity. `Object.is`-comparable.
 *
 * `hasIncomingChainEdgeAtNode` is a Map from scene-node id → `true`
 * for every scene where this entity has an incoming narrative-flow
 * chain edge (used by the EntityChip orphan check; absence at a
 * scene means orphan).
 */
export function getEntityChainIndex(nodes, edges) {
  if (_cache.nodes === nodes && _cache.edges === edges && _cache.result) {
    return _cache.result
  }

  // Phase 1: collect per-entity raw data.
  //   - originNodeId: from non-modifier entityNode with entity_id
  //   - chainEdges: edges where the entity is the chain source
  //   - sceneRefs: per scene node, EntityRef objects for this entity
  //   - incomingChainEdgeNodes: scene-node ids that have an incoming
  //     narrative-flow chain edge for this entity (orphan-check input)
  const perEntity = new Map()

  function ensureEntry(eid) {
    let e = perEntity.get(eid)
    if (!e) {
      e = {
        originNodeId: null,
        chainEdgeIds: new Set(), // dedupe per entity
        chainEdges: [],
        // modifierNodes: every `entityNode` with `is_modifier=true` and
        // `entity_id === eid`. These are downstream chain stops the
        // walker traverses via narrativeChain.js — their `data` carries
        // change-records that apply to the entity's effective state at
        // the modifier's position in the chain. MUST be captured in the
        // digest so chain-tracked mutations via modifier nodes invalidate
        // the per-entity signature.
        modifierNodes: [],
        sceneRefs: [],
        incomingChainEdgeNodes: new Set(),
      }
      perEntity.set(eid, e)
    }
    return e
  }

  function addChainEdge(entry, edge) {
    if (!entry.chainEdgeIds.has(edge.id)) {
      entry.chainEdgeIds.add(edge.id)
      entry.chainEdges.push(edge)
    }
  }

  // Phase 1a: walk nodes FIRST so we know each entity's origin node
  // id before scanning edges (needed to attribute origin-outgoing
  // chain edges that may not carry `source_entity_id` to the right
  // entity).
  const originNodeIdToEntityId = new Map()
  for (const node of nodes || []) {
    if (!node) continue
    if (node.type === 'entityNode' && node.data?.entity_id) {
      if (node.data.is_modifier) {
        // Modifier EntityNode: downstream chain stop. Walker reads its
        // change-record data (`name_change`, `colour_change`, etc.)
        // and applies to the effective state at this chain position.
        ensureEntry(node.data.entity_id).modifierNodes.push(node)
      } else {
        ensureEntry(node.data.entity_id).originNodeId = node.id
        originNodeIdToEntityId.set(node.id, node.data.entity_id)
      }
    } else if (node.type === 'sceneNode') {
      const data = node.data || {}
      for (const bucket of ENTITY_BUCKETS) {
        const refs = data[bucket]
        if (!refs) continue
        for (const ref of refs) {
          if (!ref?.entity_id) continue
          ensureEntry(ref.entity_id).sceneRefs.push({ nodeId: node.id, ref })
        }
      }
    }
  }

  // Phase 1b: walk edges. Each edge contributes:
  //   - to its source entity's chain edges (chain-source identity via
  //     `source_entity_id` or `sourceHandle`)
  //   - additionally, to whichever entity owns the source node's
  //     origin (catches origin-outgoing chain edges that may not
  //     carry `source_entity_id` — the chain walker at
  //     `narrativeChain.js:765-767` picks the first non-relationship
  //     outgoing edge regardless)
  //   - to its target scene's "has incoming chain edge for entity"
  //     map (orphan check)
  for (const edge of edges || []) {
    if (!edge) continue
    const data = edge.data || {}
    // The chain source identity: prefer `source_entity_id`; fall back
    // to `sourceHandle` for older saves / edge cases (the chain walker
    // checks both).
    const sourceEntityId = data.source_entity_id || edge.sourceHandle
    if (sourceEntityId) {
      addChainEdge(ensureEntry(sourceEntityId), edge)
    }
    // Origin-outgoing fallback: any edge sourced at an entity's origin
    // node is potentially part of THAT entity's chain even if the
    // edge omits `source_entity_id`.
    const ownedByOrigin = originNodeIdToEntityId.get(edge.source)
    if (ownedByOrigin) {
      addChainEdge(ensureEntry(ownedByOrigin), edge)
    }
    // Incoming chain edge: target node + source_entity_id (only counts
    // narrative-flow edges; relationship wires are not chain links per
    // `narrativeChain.js:760-773`).
    if (!data.is_relationship && data.source_entity_id && edge.target) {
      ensureEntry(data.source_entity_id).incomingChainEdgeNodes.add(edge.target)
    }
  }

  // Phase 2: per-entity signature assembly.
  //
  // Deterministic ordering: sort by id so the digest is stable
  // regardless of source-array order.
  //
  // We capture:
  //   - origin node id
  //   - each chain edge's id + source + target + sourceHandle +
  //     is_relationship flag (the fields the chain walker reads)
  //   - each scene EntityRef serialized (every field the walker /
  //     sub-chip computers / effective-state computers read)
  //
  // JSON.stringify per ref is the simplest stable serializer. Refs
  // typically run ~100-500 bytes; total cost dominated by ref count
  // (~500 on a large project), not per-ref cost.
  // Also capture edges sourced FROM modifier nodes for each entity —
  // the walker treats modifier outgoing edges as chain continuations
  // (`narrativeChain.js:765-767` picks the first non-relationship
  // outgoing edge from any entityNode, modifier or not).
  const modifierNodeIdToEntityId = new Map()
  for (const [eid, entry] of perEntity) {
    for (const mn of entry.modifierNodes) modifierNodeIdToEntityId.set(mn.id, eid)
  }
  for (const edge of edges || []) {
    if (!edge) continue
    const ownedByModifier = modifierNodeIdToEntityId.get(edge.source)
    if (ownedByModifier) {
      addChainEdge(ensureEntry(ownedByModifier), edge)
    }
  }

  const result = new Map()
  for (const [eid, entry] of perEntity) {
    entry.chainEdges.sort((a, b) => (a.id || '').localeCompare(b.id || ''))
    entry.modifierNodes.sort((a, b) => (a.id || '').localeCompare(b.id || ''))
    entry.sceneRefs.sort((a, b) => a.nodeId.localeCompare(b.nodeId))

    let sig = ''
    if (entry.originNodeId) sig += 'O:' + entry.originNodeId + ';'
    for (const e of entry.chainEdges) {
      sig += 'E:' + (e.id || '') + ':' + (e.source || '') + '>' + (e.target || '')
          + ':sh=' + (e.sourceHandle || '')
          + ':r=' + (e.data?.is_relationship ? 1 : 0) + ';'
    }
    // Modifier node `data` carries the change-records the walker
    // applies to effective state at this chain position. Serialize
    // the full data so any chain-tracked field edit (name_change,
    // colour_change, attribute_changes add/modify/remove, etc.)
    // flips the digest and triggers a re-render at this entity's
    // chips, which re-walks the chain through this modifier with
    // fresh `(nodes, edges)` from `useProjectStore.getState()`.
    for (const mn of entry.modifierNodes) {
      sig += 'M:' + mn.id + ':' + JSON.stringify(mn.data || {}) + ';'
    }
    for (const r of entry.sceneRefs) {
      sig += 'R:' + r.nodeId + ':' + JSON.stringify(r.ref) + ';'
    }
    result.set(eid, {
      signature: sig,
      // 32-bit djb2 hash of the signature. Multi-entity consumers
      // (e.g. a scene gating on "did ANY present entity's chain
      // change") join these tiny hashes instead of concatenating
      // full signatures, keeping their selector output cheap to
      // build and compare per store write.
      sigHash: _hashString(sig),
      hasIncomingChainEdgeAtNode: entry.incomingChainEdgeNodes,
    })
  }

   
  _cache = { nodes, edges, result }
  return result
}

/**
 * Selector: returns the signature string for `entityId` from the
 * index built from `(nodes, edges)`. Compatible with default Zustand
 * `Object.is` equality — string comparison fires no re-render when
 * the entity's chain inputs are unchanged.
 */
export function selectEntityChainSignature(nodes, edges, entityId) {
  if (!entityId) return EMPTY_STR
  const index = getEntityChainIndex(nodes, edges)
  return index.get(entityId)?.signature || EMPTY_STR
}

/**
 * Selector: returns `true` iff the entity has an incoming narrative-
 * flow chain edge at `nodeId`. The negation is the EntityChip orphan
 * status (a flashback chip is never orphaned — the caller is
 * responsible for that override; this selector ignores flashback
 * context).
 *
 * Returns a boolean — Zustand's default `Object.is` equality skips
 * re-render when the boolean is unchanged across store updates,
 * even when the underlying edges array reference changed.
 */
export function selectEntityHasIncomingChainEdge(nodes, edges, entityId, nodeId) {
  if (!entityId || !nodeId) return false
  const index = getEntityChainIndex(nodes, edges)
  return index.get(entityId)?.hasIncomingChainEdgeAtNode?.has(nodeId) || false
}

/**
 * Selector: joined per-entity signature hashes for a set of entity
 * ids. A cheap re-render gate for consumers whose derived state
 * depends on the chains of SEVERAL entities at once (e.g. a scene's
 * circumstance rollup over every present entity). The output string
 * is a few bytes per entity, so building and comparing it per store
 * write costs ~nothing; it changes exactly when any listed entity's
 * chain inputs change.
 */
export function selectEntitiesChainHash(nodes, edges, entityIds) {
  if (!entityIds || entityIds.length === 0) return EMPTY_STR
  const index = getEntityChainIndex(nodes, edges)
  let out = ''
  for (const eid of entityIds) out += (index.get(eid)?.sigHash ?? 'x') + ','
  return out
}
