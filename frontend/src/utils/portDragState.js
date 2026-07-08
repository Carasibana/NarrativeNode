/**
 * Drag-time guard precompute for Phase 1.20 port feedback.
 *
 * Given an in-flight drag's source + payload type, return two Sets of
 * target identifiers where a normally-accepting port would be rejected:
 *   - `nodeIds`: whole-node rejections (cycle / pov-loop / story-order /
 *     direction-semantic silent drops / relationshipOriginNode whose rel
 *     already contains the source entity).
 *   - `handles`: per-port rejections keyed by `${nodeId}:${handleId}`.
 *     Currently: `rel-in-{relId}` handles whose relationship already has
 *     the source entity as an active participant at that chain position.
 *
 * Used by Canvas.onConnectStart to stash both sets on `uiStore.activeDrag`
 * so each port can answer "am I blocked?" via O(1) Set.has lookups, and so
 * `isValidConnection` can gate React Flow's drag-snapping without touching
 * any store during the drag.
 *
 * Called once per drag (on drag start). `storyOrder` is the precomputed
 * Map<nodeId, index> returned by `computeStoryOrder`; `relationships` is
 * the project's relationship array (used for the participant pre-check).
 */

import { wouldCreateCycle } from '../store/projectStore'
import { wouldCreatePovLoop } from './povSequence'
import { wouldContradictStoryOrder } from './storyOrder'
import { PAYLOAD } from './portCatalogue'
import { getRelationshipNodeOrder, computeRelationshipEffectiveState } from './narrativeChain'

/**
 * Result shape: two Sets.
 *   - `nodeIds` blocks every port on a given node (used by cycle / pov-loop
 *     / story-order / direction-semantic rejections that operate at
 *     node-level granularity).
 *   - `handles` blocks a SPECIFIC port via `${nodeId}:${handleId}` keys.
 *     Used for per-port rejections like "source entity is already a
 *     participant in this relationship at this chain position".
 *
 * PortHandle and Canvas.isValidConnection both consult both sets; a target
 * is rejected if either set blocks it.
 */
export function computeBlockedTargets({ sourceNodeId, sourceHandleId, payloadType, nodes, edges, storyOrder, relationships }) {
  const nodeIds = new Set()
  const handles = new Set()
  if (!sourceNodeId || !payloadType) return { nodeIds, handles }

  if (payloadType === PAYLOAD.POV) {
    for (const n of nodes) {
      if (n.id === sourceNodeId) continue
      if (wouldCreatePovLoop(nodes, edges, sourceNodeId, n.id)) nodeIds.add(n.id)
    }
    return { nodeIds, handles }
  }

  if (payloadType === PAYLOAD.NARRATIVE_FLOW || payloadType === PAYLOAD.BROADCAST) {
    // Determine what the source represents for direction-semantic rejections
    // (handled by onConnect as silent drops: scene chip -> entity origin,
    // modifier -> origin, origin -> modifier-holding-other-entity, etc.).
    const srcNode = nodes.find((n) => n.id === sourceNodeId)
    const srcIsScene = srcNode?.type === 'sceneNode'
    const srcIsEntityOrigin = srcNode?.type === 'entityNode' && !srcNode?.data?.is_modifier
    const srcIsEntityModifier = srcNode?.type === 'entityNode' && !!srcNode?.data?.is_modifier
    const srcIsChipOut =
      srcIsScene &&
      !!sourceHandleId &&
      sourceHandleId !== 'broadcast' &&
      sourceHandleId !== 'pov-out' &&
      sourceHandleId !== 'pov-in' &&
      !sourceHandleId.startsWith('chip-in-') &&
      !sourceHandleId.startsWith('rel-in-')
    const srcEntityId = srcIsChipOut
      ? sourceHandleId
      : (srcIsEntityOrigin || srcIsEntityModifier)
        ? srcNode?.data?.entity_id ?? null
        : null

    for (const n of nodes) {
      if (n.id === sourceNodeId) continue
      if (wouldCreateCycle(edges, sourceNodeId, n.id)) { nodeIds.add(n.id); continue }
      if (storyOrder && wouldContradictStoryOrder(storyOrder, sourceNodeId, n.id)) { nodeIds.add(n.id); continue }

      // Direction-semantic silent-drops against entityNode targets.
      if (n.type === 'entityNode') {
        const targetIsModifier = !!n.data?.is_modifier
        const targetAssignedEid = n.data?.entity_id ?? null

        // Scene chip -> entity ORIGIN node: silent drop (projectStore.js
        // ~L3697 -- "no meaningful wire direction").
        if (srcIsChipOut && !targetIsModifier) { nodeIds.add(n.id); continue }

        // Modifier source -> entity ORIGIN target: silent drop (projectStore.js
        // ~L3564 -- modifiers can't emit into another entity's origin).
        if (srcIsEntityModifier && !targetIsModifier) { nodeIds.add(n.id); continue }

        // Modifier target already holding a different entity: silent drop
        // (projectStore.js ~L3493 -- modifier entity_id is locked).
        if (targetIsModifier && targetAssignedEid && srcEntityId && srcEntityId !== targetAssignedEid) {
          nodeIds.add(n.id)
          continue
        }
      }
    }

    // Relationship-participant pre-check: a source entity can't be "added"
    // as a participant at a chain position where it is already one. For
    // every relationship where the source entity is already active at a
    // node, reject that node's rel-in-{relId} handle (or the whole
    // relationship-origin node, which maps 1:1 to one relationship).
    if (srcEntityId && Array.isArray(relationships)) {
      for (const rel of relationships) {
        const changes = rel?.history?.participant_changes
        if (!Array.isArray(changes) || changes.length === 0) continue
        // Cheap reject: if source entity never appears in this rel, skip
        // the full chain walk entirely.
        if (!changes.some((c) => c.entity_id === srcEntityId)) continue
        const nodeOrder = getRelationshipNodeOrder(rel, nodes, edges)
        for (const nid of nodeOrder) {
          const state = computeRelationshipEffectiveState(rel, nodeOrder, nid)
          if (!state) continue
          const isParticipant = (state.participants || []).some((p) => p.entity_id === srcEntityId)
          if (!isParticipant) continue
          const node = nodes.find((nn) => nn.id === nid)
          if (!node) continue
          if (node.type === 'relationshipOriginNode') {
            nodeIds.add(nid)
          } else {
            // sceneNode scene-level rel chip OR entityNode faction rel chip
            handles.add(`${nid}:rel-in-${rel.id}`)
          }
        }
      }
    }

    return { nodeIds, handles }
  }

  // relationshipJoin and any future payload types have no guards today.
  return { nodeIds, handles }
}
