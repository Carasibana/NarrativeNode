/**
 * Project-level tag-host index.
 *
 * Replaces the per-popover-open per-host O(canvas) chain rewalks that
 * `collectHostsForProjectTag` + `findEarliestProjectTagAnchor` did
 * inside `TagPopover.grouped`. Two split caches with different
 * dependency surfaces:
 *
 *   - `membershipIndex: Map<tagId, Set<hostKey>>`
 *       Depends on the tag-bearing fields of entity / knowledge /
 *       relationship / preset-list baselines + canvas-resident tag
 *       data (scene `EntityRef.tag_changes`, modifier `EntityNode
 *       .data.tag_changes`, `referenceNode.data.tag_ids`). Stable
 *       across position drags, name / description edits, wire
 *       reroutes, POV chip toggles.
 *
 *   - `anchorIndex: Map<tagId, Map<hostKey, anchorNodeId | null>>`
 *       Depends on `membershipIndex` + project-wide story order.
 *       Rebuilds when membership changes OR canvas structure changes
 *       (anchor positions can shift even with no tag mutation).
 *
 * A null anchor means the host has no canvas anchor (preset lists).
 * The caller handles routing differently for those (no "navigate to
 * the anchor" affordance).
 *
 * Host-key convention matches `collectHostsForProjectTag`:
 *   - `entity:{id}`        — every entity bucket
 *   - `knowledge:{id}`
 *   - `relationship:{id}`
 *   - `presetList:{id}`
 *   - `referenceNode:{id}`
 *
 * Pure functions only — wrap with React memos / context at the call
 * site to share across consumers.
 */

import { ENTITY_BUCKETS } from './entityHelpers'
import { getRelationshipCreationNodeId } from './narrativeChain'

const EMPTY_SET = Object.freeze(new Set())
const EMPTY_MAP = Object.freeze(new Map())

/**
 * Build `Map<tagId, Set<hostKey>>` in a single pass over the
 * project's tag-bearing surface. O(N) where N = total host count +
 * total canvas-node-resident tag events.
 *
 * Inputs:
 *   entities        — { characters, locations, items, factions,
 *                       customs, presetLists }
 *   knowledges      — `projectStore.knowledges`
 *   relationships   — `projectStore.relationships`
 *   nodes           — `projectStore.nodes`
 */
export function buildMembershipIndex({
  entities = null,
  knowledges = null,
  relationships = null,
  nodes = null,
} = {}) {
  const out = new Map()

  function record(tagId, hostKey) {
    if (!tagId || !hostKey) return
    let set = out.get(tagId)
    if (!set) {
      set = new Set()
      out.set(tagId, set)
    }
    set.add(hostKey)
  }

  // Entity baselines (5 buckets)
  for (const bucket of ENTITY_BUCKETS) {
    for (const e of (entities?.[bucket] || [])) {
      const id = e?.id
      if (!id) continue
      for (const tagId of (e.tag_ids || [])) record(tagId, `entity:${id}`)
    }
  }

  // Knowledge baselines + chain events
  for (const k of (knowledges || [])) {
    const id = k?.id
    if (!id) continue
    for (const tagId of (k.tag_ids || [])) record(tagId, `knowledge:${id}`)
    for (const ev of (k.history?.tag_changes || [])) {
      if (ev?.action === 'add' && ev.tag_id) record(ev.tag_id, `knowledge:${id}`)
    }
  }

  // Relationship baselines + chain events
  for (const r of (relationships || [])) {
    const id = r?.id
    if (!id) continue
    for (const tagId of (r.tag_ids || [])) record(tagId, `relationship:${id}`)
    for (const ev of (r.history?.tag_changes || [])) {
      if (ev?.action === 'add' && ev.tag_id) record(ev.tag_id, `relationship:${id}`)
    }
  }

  // Preset list baselines (canvas-free hosts)
  for (const pl of (entities?.presetLists || [])) {
    const id = pl?.id
    if (!id) continue
    for (const tagId of (pl.tag_ids || [])) record(tagId, `presetList:${id}`)
  }

  // Canvas-resident tag data:
  //   - referenceNode.data.tag_ids        (baseline tags on the
  //                                        reference node itself)
  //   - sceneNode.data.<bucket>[].tag_changes
  //                                       (chain-event tags on a
  //                                        scene's entity chips)
  //   - entityNode (modifier).data.tag_changes
  //                                       (chain-event tags on a
  //                                        modifier node)
  for (const n of (nodes || [])) {
    const t = n?.type
    if (t === 'referenceNode') {
      for (const tagId of (n.data?.tag_ids || [])) record(tagId, `referenceNode:${n.id}`)
    } else if (t === 'sceneNode') {
      for (const bk of ENTITY_BUCKETS) {
        for (const ref of (n.data?.[bk] || [])) {
          const eid = ref?.entity_id
          if (!eid) continue
          for (const ev of (ref.tag_changes || [])) {
            if (ev?.action === 'add' && ev.tag_id) record(ev.tag_id, `entity:${eid}`)
          }
        }
      }
    } else if (t === 'entityNode' && n.data?.is_modifier && n.data?.entity_id) {
      for (const ev of (n.data?.tag_changes || [])) {
        if (ev?.action === 'add' && ev.tag_id) record(ev.tag_id, `entity:${n.data.entity_id}`)
      }
    }
  }

  return out
}

/**
 * Build `Map<tagId, Map<hostKey, anchorNodeId | null>>` in a single
 * pass over the project's tag-bearing surface plus story order.
 *
 * For each `(tagId, hostKey)` pair, the anchor is the EARLIEST node
 * (in story order) where that tag becomes effective for that host:
 *   - Entity baseline tag → entity origin node
 *   - Entity chain-event tag (scene chip / modifier node)
 *                          → that scene / modifier node
 *   - Knowledge baseline tag → `k.source_event.node_id`
 *   - Knowledge chain-event tag → that event's `node_id`
 *   - Relationship baseline tag
 *                          → `getRelationshipCreationNodeId(r)`
 *   - Relationship chain-event tag → that event's `node_id`
 *   - Reference node baseline tag → the reference node id itself
 *   - Preset list baseline tag → null (off-canvas host)
 *
 * When the same `(tagId, hostKey)` pair produces multiple candidate
 * anchors (baseline + chain entries, or multiple chain entries),
 * story-order position decides — earliest wins. `null` is sticky:
 * once a host is recorded with a `null` anchor it stays null
 * regardless of subsequent candidates (the off-canvas case).
 *
 * O(N) where N = total host count + canvas-resident tag events.
 */
export function buildAnchorIndex({
  storyOrder = [],
  entities = null,
  knowledges = null,
  relationships = null,
  nodes = null,
} = {}) {
  const out = new Map()

  const orderPos = new Map()
  for (let i = 0; i < storyOrder.length; i += 1) orderPos.set(storyOrder[i], i)

  // Entity origin index: entity_id → origin node id. Skips modifier
  // nodes (those are downstream chain stops, not origins).
  const entityOriginById = new Map()
  for (const n of (nodes || [])) {
    if (n?.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id) {
      entityOriginById.set(n.data.entity_id, n.id)
    }
  }

  function record(tagId, hostKey, candidate) {
    if (!tagId || !hostKey) return
    let anchors = out.get(tagId)
    if (!anchors) {
      anchors = new Map()
      out.set(tagId, anchors)
    }
    if (!anchors.has(hostKey)) {
      anchors.set(hostKey, candidate)
      return
    }
    const prev = anchors.get(hostKey)
    // null is sticky — off-canvas hosts stay null even if a later
    // pass tries to set a node id for them.
    if (prev === null || candidate === null) return
    const prevPos = orderPos.has(prev) ? orderPos.get(prev) : Number.POSITIVE_INFINITY
    const newPos = orderPos.has(candidate) ? orderPos.get(candidate) : Number.POSITIVE_INFINITY
    if (newPos < prevPos) anchors.set(hostKey, candidate)
  }

  // Entity baselines: anchor = entity origin
  for (const bucket of ENTITY_BUCKETS) {
    for (const e of (entities?.[bucket] || [])) {
      const id = e?.id
      if (!id) continue
      if (!(e.tag_ids || []).length) continue
      const origin = entityOriginById.get(id)
      if (!origin) continue
      for (const tagId of e.tag_ids) record(tagId, `entity:${id}`, origin)
    }
  }

  // Knowledge baselines + chain events
  for (const k of (knowledges || [])) {
    const id = k?.id
    if (!id) continue
    const baseline = k.source_event?.node_id || null
    for (const tagId of (k.tag_ids || [])) {
      record(tagId, `knowledge:${id}`, baseline)
    }
    for (const ev of (k.history?.tag_changes || [])) {
      if (ev?.action === 'add' && ev.tag_id && ev.node_id) {
        record(ev.tag_id, `knowledge:${id}`, ev.node_id)
      }
    }
  }

  // Relationship baselines + chain events
  for (const r of (relationships || [])) {
    const id = r?.id
    if (!id) continue
    if ((r.tag_ids || []).length) {
      const baseline = getRelationshipCreationNodeId(r, nodes) || null
      for (const tagId of r.tag_ids) {
        record(tagId, `relationship:${id}`, baseline)
      }
    }
    for (const ev of (r.history?.tag_changes || [])) {
      if (ev?.action === 'add' && ev.tag_id && ev.node_id) {
        record(ev.tag_id, `relationship:${id}`, ev.node_id)
      }
    }
  }

  // Preset lists — no canvas anchor
  for (const pl of (entities?.presetLists || [])) {
    const id = pl?.id
    if (!id) continue
    for (const tagId of (pl.tag_ids || [])) {
      record(tagId, `presetList:${id}`, null)
    }
  }

  // Canvas-resident tag events
  for (const n of (nodes || [])) {
    const t = n?.type
    if (t === 'referenceNode') {
      // Reference node baseline tags: the reference node IS its own
      // anchor (no separate origin concept). The popover's
      // referenceNode branch doesn't use the anchor for routing today,
      // but recording the node id keeps the index uniform.
      for (const tagId of (n.data?.tag_ids || [])) {
        record(tagId, `referenceNode:${n.id}`, n.id)
      }
    } else if (t === 'sceneNode') {
      for (const bk of ENTITY_BUCKETS) {
        for (const ref of (n.data?.[bk] || [])) {
          const eid = ref?.entity_id
          if (!eid) continue
          for (const ev of (ref.tag_changes || [])) {
            if (ev?.action === 'add' && ev.tag_id) record(ev.tag_id, `entity:${eid}`, n.id)
          }
        }
      }
    } else if (t === 'entityNode' && n.data?.is_modifier && n.data?.entity_id) {
      for (const ev of (n.data?.tag_changes || [])) {
        if (ev?.action === 'add' && ev.tag_id) record(ev.tag_id, `entity:${n.data.entity_id}`, n.id)
      }
    }
  }

  return out
}

/**
 * O(1) host-set lookup. Returns an empty frozen Set for unknown tagId.
 */
export function getHostsForTag(membershipIndex, tagId) {
  if (!membershipIndex || !tagId) return EMPTY_SET
  return membershipIndex.get(tagId) || EMPTY_SET
}

/**
 * O(1) anchor lookup. Returns `null` if the host is off-canvas or
 * unknown, `undefined` if the host doesn't carry the tag at all.
 * Callers can distinguish "no anchor known" (null) from "not tagged"
 * (undefined) via this signature.
 */
export function getAnchorForHost(anchorIndex, tagId, hostKey) {
  if (!anchorIndex || !tagId || !hostKey) return undefined
  const anchors = anchorIndex.get(tagId) || EMPTY_MAP
  return anchors.has(hostKey) ? anchors.get(hostKey) : undefined
}
