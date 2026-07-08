/**
 * Phase 3.4f — Tagged-objects navigation helper for the Edit Tag
 * popover (Tags & Lists library tab).
 *
 * The popover lists every object carrying a given tag, grouped by
 * library-tab order, with each badge clickable. For chain-trackable
 * hosts (Entity / Knowledge / Relationship) the click lands on the
 * *earliest* scene anchor where the tag is present on that host —
 * i.e. the host's origin if the tag is in baseline, or the first
 * downstream chain event recording an `add` for this tag otherwise.
 * Non-chain hosts (Reference Node, Preset List, Context Cue,
 * Conversation) have no anchor concept; the caller handles them via
 * their own routing (centre canvas / switch tab / open editor /
 * open thread).
 *
 * Two exports:
 *   - `findEarliestProjectTagAnchor(tagId, hostKind, hostId, ...)`
 *     returns the node id of the earliest tagged anchor, or null
 *     when the host kind has no chain or the anchor can't be
 *     determined (defensive fallback — caller can default to the
 *     host's detail-panel-default-open behaviour).
 *   - `LIBRARY_HOST_ORDER` — canonical group order matching the
 *     entity library + tags-and-lists tab sequence used in the
 *     modal's group rendering.
 */
import {
  getEntityNarrativeChain,
  getKnowledgeNodeOrder,
  getRelationshipNodeOrder,
  getRelationshipCreationNodeId,
} from './narrativeChain'
import { ENTITY_BUCKETS } from './entityHelpers'

// Group order matching the entity-library tab sequence + the
// downstream tabs (relationships, references) + preset-list rows
// in the tags-and-lists tab. Program-tag-only hosts (cues +
// conversations) trail the project-pool order since they aren't
// in the entity library. Used by the modal's grouping render.
export const LIBRARY_HOST_ORDER = Object.freeze([
  'character',
  'location',
  'item',
  'faction',
  'custom',
  'knowledge',
  'relationship',
  'cue',
  'referenceNode',
  'presetList',
  'conversation',
])

// Display labels per host kind. The modal reads these for group
// headers; absent entries fall back to a Title-Cased kind.
export const LIBRARY_HOST_LABELS = Object.freeze({
  character:     'Characters',
  location:      'Locations',
  item:          'Items',
  faction:       'Factions',
  custom:        'Customs',
  knowledge:     'Knowledge',
  relationship:  'Relationships',
  cue:           'Context Cues',
  referenceNode: 'Reference Nodes',
  presetList:    'Preset Lists',
  conversation:  'Conversations',
})

// Resolve an entity's library-tab subtype from the host id by
// scanning each typed bucket. The collectHosts helper in
// globalSearch.js bundles every entity under `entity:<id>`; for
// grouping we need the subtype so each entity lands in its right
// library row.
export function resolveEntitySubtype(entityId, entities) {
  for (const bucket of ENTITY_BUCKETS) {
    const found = (entities?.[bucket] || []).find((e) => e.id === entityId)
    if (found) return found.type || bucket.replace(/s$/, '')
  }
  return null
}

/**
 * Walk a host's chain and return the node id of the earliest anchor
 * where this tag is present. Origin if in baseline; first chain
 * `add` event otherwise. Returns null when the host kind has no
 * chain or no anchor can be determined.
 *
 * For Knowledge / Relationship hosts the chain-event search MUST
 * chain-sort the matching events before picking the first, because
 * `history.tag_changes` is appended at write time — i.e. insertion
 * order, not chain order. A writer who adds a tag at scene 8 first
 * and then walks back to add it at scene 3 produces
 * `[add@8, add@3]`; iterating array order would return scene 8
 * (latest by chain order) and the popover navigation would land on
 * the wrong anchor. The Entity branch is safe without sorting
 * because it walks `getEntityNarrativeChain` (origin → downstream)
 * and only inspects per-node `tag_changes` on each chain step in
 * narrative-flow order.
 *
 * Optional `storyOrder` param: when the caller already computed the
 * project-wide story order (e.g. the popover's `grouped` memo) it
 * can pass it through to avoid re-walking it inside each host's
 * `get*NodeOrder` resolution.
 */
export function findEarliestProjectTagAnchor(tagId, hostKind, hostId, project, entities, storyOrder = undefined) {
  const nodes = project?.nodes || []
  const edges = project?.edges || []

  if (hostKind === 'character' || hostKind === 'location'
    || hostKind === 'item' || hostKind === 'faction' || hostKind === 'custom') {
    // Entity host. Resolve the entity, walk its narrative chain.
    let entity = null
    for (const bucket of ENTITY_BUCKETS) {
      const found = (entities?.[bucket] || []).find((e) => e.id === hostId)
      if (found) { entity = found; break }
    }
    if (!entity) return null

    const chain = getEntityNarrativeChain(hostId, nodes, edges)
    if (chain.length === 0) return null

    // chain[0] is the origin entity node. If the tag is on baseline,
    // origin is the earliest anchor by definition (it's where the
    // baseline applies).
    if ((entity.tag_ids || []).includes(tagId)) {
      return chain[0].id
    }

    // Else walk downstream chain stops in order, returning the first
    // `add` event for this tag. `chain` is already narrative-flow
    // ordered so the first match IS the earliest.
    for (let i = 1; i < chain.length; i += 1) {
      const n = chain[i]
      if (n.type === 'sceneNode') {
        for (const bucket of ENTITY_BUCKETS) {
          const ref = (n.data?.[bucket] || []).find((r) => r.entity_id === hostId)
          if (ref) {
            for (const ev of (ref.tag_changes || [])) {
              if (ev?.action === 'add' && ev.tag_id === tagId) return n.id
            }
            break
          }
        }
      } else if (n.type === 'entityNode' && n.data?.is_modifier && n.data?.entity_id === hostId) {
        for (const ev of (n.data?.tag_changes || [])) {
          if (ev?.action === 'add' && ev.tag_id === tagId) return n.id
        }
      }
    }
    return null
  }

  if (hostKind === 'knowledge') {
    const knowledges = project?.knowledges || []
    const k = knowledges.find((x) => x.id === hostId)
    if (!k) return null
    if ((k.tag_ids || []).includes(tagId)) {
      // Origin = the knowledge's source event's anchor node.
      return k.source_event?.node_id || null
    }
    // Chain-event branch: collect every `add` event for this tag,
    // then pick the one with the EARLIEST chain position via the
    // knowledge's node-order resolution. Array order on
    // `history.tag_changes` is insertion order, not chain order.
    const adds = (k.history?.tag_changes || []).filter(
      (ev) => ev?.action === 'add' && ev.tag_id === tagId && ev.node_id
    )
    if (adds.length === 0) return null
    if (adds.length === 1) return adds[0].node_id
    const order = getKnowledgeNodeOrder(k, nodes, edges, storyOrder)
    const positionById = new Map(order.map((nid, idx) => [nid, idx]))
    let earliest = adds[0]
    let earliestPos = positionById.has(adds[0].node_id) ? positionById.get(adds[0].node_id) : Number.POSITIVE_INFINITY
    for (let i = 1; i < adds.length; i += 1) {
      const pos = positionById.has(adds[i].node_id) ? positionById.get(adds[i].node_id) : Number.POSITIVE_INFINITY
      if (pos < earliestPos) { earliest = adds[i]; earliestPos = pos }
    }
    return earliest.node_id
  }

  if (hostKind === 'relationship') {
    const rels = project?.relationships || []
    const r = rels.find((x) => x.id === hostId)
    if (!r) return null
    if ((r.tag_ids || []).includes(tagId)) {
      // Baseline tag: the relationship's origin IS the earliest
      // tagged anchor (a baseline tag is effective from the rel's
      // creation point onwards). The canonical helper handles the
      // `membership_of`-gated split between faction-memberships
      // (origin = activate event) and regular rels (origin = join
      // event) — see `getRelationshipCreationNodeId` in
      // `narrativeChain.js`.
      return getRelationshipCreationNodeId(r, nodes)
    }
    // Chain-event branch: events are appended in insertion order, not
    // chain order. Story-sort matching `add` events and pick the
    // earliest.
    const addNodeIds = (r.history?.tag_changes || [])
      .filter((ev) => ev?.action === 'add' && ev.tag_id === tagId && ev.node_id)
      .map((ev) => ev.node_id)
    if (addNodeIds.length === 0) return null
    if (addNodeIds.length === 1) return addNodeIds[0]
    const order = getRelationshipNodeOrder(r, nodes, edges, storyOrder)
    const positionById = new Map(order.map((nid, idx) => [nid, idx]))
    let pick = null
    let pickPos = Number.POSITIVE_INFINITY
    for (const nid of addNodeIds) {
      const pos = positionById.has(nid) ? positionById.get(nid) : Number.POSITIVE_INFINITY
      if (pos < pickPos) { pick = nid; pickPos = pos }
    }
    return pick
  }

  // Reference Node / Preset List / Cue / Conversation: no chain,
  // caller handles routing without an anchor.
  return null
}
