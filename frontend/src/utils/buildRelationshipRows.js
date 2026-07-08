// Build pseudo-entity rows for relationships so `TimelineGridView` can render
// them through the same row pipeline it uses for entities. A relationship row
// has the same shape as an entity row (`{ id, name, type, colour, dots, ... }`)
// which lets the grid render it without special-casing.
//
// Used by `TimelineNavigatorPanel` when the user activates the Relationships
// filter tab — relationships are a distinct first-class object and do NOT
// appear in the "All entity types" view.
//
// Dot emission follows the same "sparse chain" semantics used by
// `RelationshipDetailPanel`'s chain navigation bar — a dot appears only at a
// scene where the relationship chip is actually present:
//   (a) the scene is a history-event node for the relationship (any change
//       type: birth, join / leave, perception, alias, role, hierarchy,
//       manual_anchor, etc.)
//   (b) the scene is an "ambient-inclusion" node: the relationship is active
//       there AND every current participant is present at the scene
// Relationship origin nodes, entity origins, and modifier nodes are never
// emitted as dots (they aren't scene columns).

import {
  getRelationshipNodeOrder,
  computeRelationshipEffectiveState,
  makeLatestPresenceNameResolver,
} from './narrativeChain'
import { participantsFallbackLabel } from './entityHelpers'

// Entity buckets on a `sceneNode.data` — used to enumerate the entity
// chips present at a scene for the ambient-inclusion check. Kept local rather
// than imported because narrativeChain's ENTITY_BUCKETS is internal.
const SCENE_ENTITY_BUCKETS = ['characters', 'locations', 'items', 'factions', 'customs']

/**
 * Compute the sparse chain (node ids) for a relationship — the subset of
 * `getRelationshipNodeOrder`'s ordered list where the relationship chip is
 * actually present (event node OR ambient inclusion). Mirrors the sparseChain
 * useMemo in `RelationshipDetailPanel` so the Timeline Navigator and the
 * relationship detail panel agree on which scenes count as chain points.
 */
function computeSparseRelationshipChain(rel, nodes, nodeOrder) {
  if (!rel) return []
  const hist = rel.history || {}
  const seen = new Set()

  // (a) Every history-event node id. Dynamic iteration so any future
  // history bucket is auto-covered without re-listing.
  for (const arr of Object.values(hist)) {
    if (!Array.isArray(arr)) continue
    for (const entry of arr) {
      if (entry?.node_id) seen.add(entry.node_id)
    }
  }

  // (b) Ambient inclusion: for every plot-point that's not already a
  // history-event node, include it when the relationship is active there
  // AND every current participant has a chip at the scene.
  for (const node of nodes) {
    if (node.type !== 'sceneNode') continue
    if (seen.has(node.id)) continue
    const eff = computeRelationshipEffectiveState(rel, nodeOrder, node.id)
    if (!eff || !eff.is_active) continue
    const participants = eff.participants || []
    if (participants.length === 0) continue
    const sceneEntityIds = new Set()
    for (const bucket of SCENE_ENTITY_BUCKETS) {
      for (const ref of (node.data?.[bucket] || [])) {
        if (ref?.entity_id) sceneEntityIds.add(ref.entity_id)
      }
    }
    if (participants.every((p) => sceneEntityIds.has(p.entity_id))) {
      seen.add(node.id)
    }
  }

  // Filter nodeOrder so the result preserves the global ordering.
  return nodeOrder.filter((id) => seen.has(id))
}

// Neutral fallback colour for the relationship identity cell when the model
// doesn't carry a per-relationship colour (currently the default — see
// the relationship shape in `projectStore.js`).
const RELATIONSHIP_FALLBACK_COLOUR = '#71717a' // zinc-500

/**
 * Resolve the display label for a relationship. Uses the custom `rel.name`
 * when set; otherwise falls back to the participant-synthesis string used
 * throughout the UI ("Alice & Bob", etc.). When `nodes` / `edges` / `storyOrder`
 * are provided, each participant's name is chain-resolved at the latest node
 * in global story order where any participant is present — so the row label
 * shows the "most advanced narrative state" the user has defined. Without
 * those args, falls back to base-library names.
 */
export function resolveRelationshipLabel(rel, getEntityById, nodes = null, edges = null, storyOrder = null) {
  if (rel?.name && rel.name.trim()) return rel.name.trim()
  const participants = (rel?.history?.participant_changes || [])
    .filter((c) => c.action === 'join')
    .map((c) => ({ entity_id: c.entity_id }))
  // De-duplicate by entity_id (a single entity could have join/leave/join).
  const seen = new Set()
  const uniq = []
  for (const p of participants) {
    if (seen.has(p.entity_id)) continue
    seen.add(p.entity_id)
    uniq.push(p)
  }
  const resolveName = (nodes && edges && storyOrder)
    ? makeLatestPresenceNameResolver({
        participantEntityIds: uniq.map((p) => p.entity_id),
        nodes, edges, storyOrder, getEntity: getEntityById,
      })
    : null
  const label = participantsFallbackLabel(uniq, getEntityById, Infinity, rel, resolveName)
  return label || 'Relationship'
}

/**
 * Build relationship pseudo-entity rows for the Timeline Navigator grid.
 *
 * @param {Object[]} relationships - top-level relationships from projectStore
 * @param {Object[]} nodes         - React Flow nodes
 * @param {Object[]} edges         - React Flow edges
 * @param {Object}   storyOrder    - result from `useStoryOrder`
 * @param {Function} getEntityById - entitiesStore getter for label synthesis
 * @returns {Array<{id, name, type, colour, profile_image_data_uri, dots,
 *                  final_colour, final_name, final_profile_image_data_uri}>}
 */
export function buildRelationshipRows(relationships, nodes, edges, storyOrder, getEntityById) {
  if (!Array.isArray(relationships) || relationships.length === 0) return []

  const sceneIds = new Set()
  for (const n of (nodes || [])) {
    if (n.type === 'sceneNode') sceneIds.add(n.id)
  }

  const rows = []
  for (const rel of relationships) {
    if (!rel?.id) continue
    // Full ordered set (origin + history + participant chains) — needed as
    // input to `computeRelationshipEffectiveState` inside the sparse-chain
    // derivation.
    const nodeOrder = getRelationshipNodeOrder(rel, nodes, edges, storyOrder) || []
    // Sparse chain: only the nodes where the relationship chip is actually
    // present (history event or ambient inclusion).
    const sparseIds = computeSparseRelationshipChain(rel, nodes || [], nodeOrder)
    const dots = []
    for (const nid of sparseIds) {
      if (!sceneIds.has(nid)) continue
      dots.push({ column_id: nid, is_modifier: false })
    }
    const colour = rel.colour || RELATIONSHIP_FALLBACK_COLOUR

    // Always attach the raw participants list + rel reference so the grid
    // can render <RelationshipLabelStack>. When the rel has a custom name
    // it shows name + participant-synthesis subtitle; without a name it
    // shows only the participant-synthesis line (with styled `as {alias}`
    // suffixes). Either way the participant list is needed at render time.
    let fallbackParticipants = []
    {
      const joins = (rel?.history?.participant_changes || [])
        .filter((c) => c.action === 'join')
        .map((c) => ({ entity_id: c.entity_id }))
      const seen = new Set()
      for (const p of joins) {
        if (seen.has(p.entity_id)) continue
        seen.add(p.entity_id)
        fallbackParticipants.push(p)
      }
    }

    const rowResolveName = makeLatestPresenceNameResolver({
      participantEntityIds: fallbackParticipants.map((p) => p.entity_id),
      nodes, edges, storyOrder, getEntity: getEntityById,
    })
    rows.push({
      id: rel.id,
      name: resolveRelationshipLabel(rel, getEntityById, nodes, edges, storyOrder),
      type: 'relationship',
      colour,
      profile_image_data_uri: null,
      dots,
      final_colour: null,
      final_name: null,
      final_profile_image_data_uri: null,
      // Rendering hints for the grid (relationship-row only). The grid
      // prefers these over the plain `name` string when present so the
      // participant-synthesis label renders with styled alias suffixes.
      _relationshipRef: rel,
      _fallbackParticipants: fallbackParticipants,
      _resolveName: rowResolveName,
    })
  }
  return rows
}

/**
 * Find the canvas node id of a relationship's origin node, if one exists.
 * Returns null when the relationship has no persisted origin node.
 */
export function findRelationshipOriginNodeId(relId, nodes) {
  const n = (nodes || []).find(
    (node) => node.type === 'relationshipOriginNode' && node.data?.relationship_id === relId,
  )
  return n?.id || null
}

/**
 * Resolve the canvas node id for the relationship's Final bookend — the
 * last entry in the relationship's sparse chain (only scenes where the
 * relationship chip is actually present, matching the dots rendered in
 * the Timeline Navigator row). Returns null when the sparse chain is
 * empty (no history events and no ambient-inclusion scenes).
 */
export function findRelationshipFinalNodeId(rel, nodes, edges, storyOrder) {
  const nodeOrder = getRelationshipNodeOrder(rel, nodes, edges, storyOrder) || []
  const sparseIds = computeSparseRelationshipChain(rel, nodes || [], nodeOrder)
  if (sparseIds.length === 0) return null
  return sparseIds[sparseIds.length - 1]
}
