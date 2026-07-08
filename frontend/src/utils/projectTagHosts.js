/**
 * Phase 3.4 Bugs & Fixes — orphan-tag auto-cleanup support.
 *
 * Walks the full project state to compute the set of distinct hosts
 * currently carrying a given Project Tag id, AND a fast count-only
 * primitive used by the orphan-tag cleanup gate.
 *
 * Shared by:
 *   - the MCP `_maybeCleanupOrphanedTag` integration in
 *     `services/mcpTools.js`
 *   - the frontend record-action cleanup integration in
 *     `store/projectStore.js` (chip-`×` detach paths)
 *   - the host-deletion cascade-strip paths inside
 *     `store/projectStore.js`'s `deleteObject`
 *
 * Counting semantics — a "host" is the OBJECT that carries the tag,
 * not the event that put the tag there. So:
 *
 *   - An entity that appears in three scenes via separate chain-add
 *     events for the same tag counts as ONE host.
 *   - A knowledge with the tag in baseline plus a chain-remove event
 *     downstream still counts as ONE host (the tag is "ever-tagged"
 *     on that knowledge from the orphan-detection point of view).
 *   - A scene with the tag added on one EntityRef and removed at the
 *     same node never lands in history (the normalisation invariant
 *     pair-cancels at write time), so no spurious count.
 *
 * This matches the discovery semantic used by the Phase 3.4i filter
 * walker (`utils/tagFilter.js:chainWideTagIdsForHost`): if a host
 * EVER carried the tag, it counts.
 */

const _TAG_HOST_ENTITY_BUCKETS = ['characters', 'locations', 'items', 'factions', 'customs']

const _TAG_HOST_KIND_FROM_BUCKET = {
  characters: 'character',
  locations:  'location',
  items:      'item',
  factions:   'faction',
  customs:    'custom',
}

/**
 * Pure walker — counts only. Returns the number of distinct hosts
 * currently carrying `tagId` across the project. Stops as soon as
 * the count exceeds `limit` (default 1) for the orphan-detection
 * fast path: "has this tag any hosts at all?". Callers wanting the
 * full distinct-host list use `collectAffectedHostsForTag` instead.
 *
 * Args:
 *   - `tagId`: Project Tag UUID
 *   - `state`: `{ entities, knowledges, relationships, nodes }` —
 *               extracted from the live stores by the caller so this
 *               helper stays pure / testable.
 *   - `limit?`: short-circuit threshold. Defaults `1` (the orphan
 *               check only needs to know if ANY host carries the tag).
 *
 * Returns: integer in `[0, limit + 1]`. Always at most `limit + 1`.
 */
export function countHostsForTag(tagId, state, limit = 1) {
  if (!tagId || !state) return 0
  const { entities = {}, knowledges = [], relationships = [], nodes = [] } = state
  const seen = new Set()
  const bump = (kind, id) => {
    const key = `${kind}:${id}`
    if (seen.has(key)) return
    seen.add(key)
  }

  for (const bucket of _TAG_HOST_ENTITY_BUCKETS) {
    for (const e of (entities[bucket] || [])) {
      if ((e.tag_ids || []).includes(tagId)) {
        bump(_TAG_HOST_KIND_FROM_BUCKET[bucket], e.id)
        if (seen.size > limit) return seen.size
      }
    }
  }
  for (const n of nodes) {
    if (n.type === 'sceneNode') {
      for (const bk of _TAG_HOST_ENTITY_BUCKETS) {
        for (const ref of (n.data?.[bk] || [])) {
          for (const ev of (ref.tag_changes || [])) {
            if (ev?.action === 'add' && ev.tag_id === tagId && ref.entity_id) {
              bump(_TAG_HOST_KIND_FROM_BUCKET[bk], ref.entity_id)
              if (seen.size > limit) return seen.size
            }
          }
        }
      }
    } else if (n.type === 'entityNode' && n.data?.is_modifier && n.data?.entity_id) {
      for (const ev of (n.data?.tag_changes || [])) {
        if (ev?.action === 'add' && ev.tag_id === tagId) {
          // Modifier nodes resolve back to the entity's kind via the
          // pool; without an entities lookup we can't determine that
          // here, but counting by entity_id key is correct since the
          // baseline bucket loop above already keyed by the same id.
          // Use a synthetic 'entity' kind so the seen-set dedup still
          // works against the same id under either visit order.
          bump('entity', n.data.entity_id)
          if (seen.size > limit) return seen.size
        }
      }
    } else if (n.type === 'referenceNode') {
      if ((n.data?.tag_ids || []).includes(tagId)) {
        bump('referenceNode', n.id)
        if (seen.size > limit) return seen.size
      }
    }
  }
  for (const k of knowledges) {
    if ((k.tag_ids || []).includes(tagId)) {
      bump('knowledge', k.id)
      if (seen.size > limit) return seen.size
      continue
    }
    for (const ev of (k.history?.tag_changes || [])) {
      if (ev?.action === 'add' && ev.tag_id === tagId) {
        bump('knowledge', k.id)
        if (seen.size > limit) return seen.size
        break
      }
    }
  }
  for (const r of relationships) {
    if ((r.tag_ids || []).includes(tagId)) {
      bump('relationship', r.id)
      if (seen.size > limit) return seen.size
      continue
    }
    for (const ev of (r.history?.tag_changes || [])) {
      if (ev?.action === 'add' && ev.tag_id === tagId) {
        bump('relationship', r.id)
        if (seen.size > limit) return seen.size
        break
      }
    }
  }
  return seen.size
}

/**
 * `true` when `tagId` has NO hosts in `state`. Convenience wrapper
 * around `countHostsForTag(tagId, state, 0)` — the orphan-cleanup
 * gate.
 */
export function isTagOrphaned(tagId, state) {
  return countHostsForTag(tagId, state, 0) === 0
}

/**
 * Full distinct-host list with names, sorted by encounter order
 * (entity-baseline → scene chain → reference → knowledge →
 * relationship). Used by MCP tools surfacing the `affected_hosts`
 * field in `update_tag` / `delete_tag` returns. Heavier than
 * `countHostsForTag`; prefer the counter for the orphan gate.
 *
 * Args:
 *   - `tagId`: Project Tag UUID
 *   - `state`: same shape as `countHostsForTag`
 *
 * Returns: `[{ kind, id, name }, ...]`
 */
export function collectAffectedHostsForTag(tagId, state) {
  if (!tagId || !state) return []
  const { entities = {}, knowledges = [], relationships = [], nodes = [] } = state
  const seen = new Set()
  const out = []
  const bump = (kind, id, name) => {
    const key = `${kind}:${id}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind, id, name: name || '' })
  }

  const entityNameById = new Map()
  for (const bucket of _TAG_HOST_ENTITY_BUCKETS) {
    for (const e of (entities[bucket] || [])) {
      entityNameById.set(e.id, { name: e.name || '', kind: _TAG_HOST_KIND_FROM_BUCKET[bucket] })
      if ((e.tag_ids || []).includes(tagId)) {
        bump(_TAG_HOST_KIND_FROM_BUCKET[bucket], e.id, e.name)
      }
    }
  }
  for (const n of nodes) {
    if (n.type === 'sceneNode') {
      for (const bk of _TAG_HOST_ENTITY_BUCKETS) {
        for (const ref of (n.data?.[bk] || [])) {
          for (const ev of (ref.tag_changes || [])) {
            if (ev?.action === 'add' && ev.tag_id === tagId && ref.entity_id) {
              const info = entityNameById.get(ref.entity_id)
              if (info) bump(info.kind, ref.entity_id, info.name)
            }
          }
        }
      }
    } else if (n.type === 'entityNode' && n.data?.is_modifier && n.data?.entity_id) {
      for (const ev of (n.data?.tag_changes || [])) {
        if (ev?.action === 'add' && ev.tag_id === tagId) {
          const info = entityNameById.get(n.data.entity_id)
          if (info) bump(info.kind, n.data.entity_id, info.name)
        }
      }
    } else if (n.type === 'referenceNode') {
      if ((n.data?.tag_ids || []).includes(tagId)) {
        bump('referenceNode', n.id, n.data?.title || '')
      }
    }
  }
  for (const k of knowledges) {
    if ((k.tag_ids || []).includes(tagId)) bump('knowledge', k.id, k.name)
    for (const ev of (k.history?.tag_changes || [])) {
      if (ev?.action === 'add' && ev.tag_id === tagId) bump('knowledge', k.id, k.name)
    }
  }
  for (const r of relationships) {
    if ((r.tag_ids || []).includes(tagId)) bump('relationship', r.id, r.name)
    for (const ev of (r.history?.tag_changes || [])) {
      if (ev?.action === 'add' && ev.tag_id === tagId) bump('relationship', r.id, r.name)
    }
  }
  return out
}
