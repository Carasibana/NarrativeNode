/**
 * awarenessSourceIndex — Phase 1.21g Step 3
 *
 * Reverse index from a *projected source* (relationship id, or
 * `(entity_id, attribute_id)` tuple) to every awareness field that
 * references it as a `Source`. Consumed by `useAlerts.js` (Step 7) to
 * find which awareness fields need attention when a participant leaves
 * a relationship or an entity is removed from an entity-list
 * attribute.
 *
 * Build is pure, idempotent over inputs. Walks every awareness-bearing
 * surface in the project — entities (including each entity's
 * `name_awareness`), per-entity attributes, per-entity aliases,
 * relationships, knowledges. For each surface whose awareness is the
 * wrapper shape with at least one source, emits one consumer
 * descriptor per source.
 *
 * Source key format:
 *   rel:<relationshipId>                 — relationship-source ref
 *   attr:<entityId>:<attributeId>        — entity-list attribute-source ref
 *
 * Consumer descriptor shape:
 *   {
 *     surfaceKind: 'entity'|'attribute'|'alias'|'relationship'|'knowledge',
 *     surfaceId:   string,                // the awareness-bearing object's id (or alias `value` for aliases)
 *     parentEntityId?: string,            // for attributes + aliases — the entity that owns the surface
 *     awarenessFieldPath: 'awareness' | 'name_awareness',
 *     sourceLevel: number,                // the level the projected source contributes at
 *   }
 *
 * Returns a `Map<string, Set<descriptor>>`. The Set lets multiple
 * descriptors coexist for the same source (e.g. the same relationship
 * referenced as a source on two different entities' awareness fields).
 */

import { forEachAwarenessHostSurface } from './awarenessSurfaceWalker'


function _sourceKey(source) {
  if (!source || typeof source !== 'object') return null
  if (source.kind === 'relationship' && source.relationship_id) {
    return `rel:${source.relationship_id}`
  }
  if (source.kind === 'attribute' && source.entity_id && source.attribute_id) {
    return `attr:${source.entity_id}:${source.attribute_id}`
  }
  return null
}

function _isWrapperWithSources(awareness) {
  if (!awareness || typeof awareness !== 'object' || Array.isArray(awareness)) return false
  return Array.isArray(awareness.sources) && awareness.sources.length > 0
}

export function buildAwarenessSourceConsumers(entities, relationships, knowledges, nodes = null) {
  const index = new Map()

  const add = (sourceKey, descriptor) => {
    let set = index.get(sourceKey)
    if (!set) { set = new Set(); index.set(sourceKey, set) }
    set.add(descriptor)
  }

  const indexAwareness = (awareness, baseDescriptor) => {
    if (!_isWrapperWithSources(awareness)) return
    for (const src of awareness.sources) {
      const key = _sourceKey(src)
      if (!key) continue
      add(key, { ...baseDescriptor, sourceLevel: src.level })
    }
  }

  // Host-baseline walk — shared with `awarenessObserverIndex.js` via
  // `forEachAwarenessHostSurface`. The shared walker is documented to
  // preserve the original iteration order + descriptor shape this code
  // expects, so the resulting index is byte-for-byte identical to the
  // pre-refactor implementation.
  forEachAwarenessHostSurface(
    { allEntities: entities, relationships, knowledges },
    indexAwareness,
  )

  // Phase 1.21g — also walk chain-time mutations on canvas nodes.
  // Sources can be added at any chain anchor, not just at origin; those
  // references live in `aliases_change` (per-alias) and (post-Step 6
  // entity/name/attribute extension) `awareness_changes` /
  // `attribute_changes` on EntityRefs and EntityNode data. For the
  // reverse index we want a global "this source is referenced anywhere
  // in the project" view, so any wrapper with sources counts —
  // regardless of where in the chain it appears. The carrier
  // descriptor on chain-time references uses the EntityRef's
  // `entity_id` as the carrier identity (same shape downstream
  // consumers use).
  if (Array.isArray(nodes)) {
    const visitRefLike = (carrierEntityId, refLike) => {
      if (!carrierEntityId || !refLike) return
      // Per-alias chain-time mutations. Two shapes coexist:
      //
      // Canonical (post v0.2.1.76): per-event `alias_changes` events.
      // The `add` events carry a full Alias payload (id + value +
      // baseline awareness), so we index any wrapper baked in there.
      // The `awareness_source_add` / `awareness_source_set_level`
      // events carry the source directly — index by the matching
      // alias's id (resolved against prior add events when present).
      // `awareness_source_remove` events do not contribute to the
      // forward index (the source is being removed, not referenced).
      const aliasChanges = refLike.alias_changes
      if (Array.isArray(aliasChanges) && aliasChanges.length > 0) {
        // Build an alias_id → value map from the same ref's add events
        // so source-events can name their target alias by value (the
        // index surfaceId for aliases is the value, mirroring the
        // legacy snapshot path's behaviour).
        const valueByAliasId = new Map()
        for (const ev of aliasChanges) {
          if (ev?.action === 'add' && ev.alias?.id && ev.alias.value) {
            valueByAliasId.set(ev.alias.id, ev.alias.value)
          }
        }
        for (const ev of aliasChanges) {
          if (!ev || typeof ev !== 'object') continue
          if (ev.action === 'add' && ev.alias) {
            const aliasValue = ev.alias.value
            if (!aliasValue) continue
            indexAwareness(ev.alias.awareness, {
              surfaceKind: 'alias',
              surfaceId: aliasValue,
              parentEntityId: carrierEntityId,
              awarenessFieldPath: 'awareness',
            })
          } else if (
            ev.action === 'awareness_source_add' ||
            ev.action === 'awareness_source_set_level'
          ) {
            const aliasValue = valueByAliasId.get(ev.alias_id)
            if (!aliasValue || !ev.source) continue
            // Synthesise a minimal wrapper carrying just this source
            // so the generic `indexAwareness` records it under the
            // alias's surface descriptor. Same effect as if the source
            // had been baked into the alias's baseline awareness.
            indexAwareness({ sources: [ev.source] }, {
              surfaceKind: 'alias',
              surfaceId: aliasValue,
              parentEntityId: carrierEntityId,
              awarenessFieldPath: 'awareness',
            })
          }
        }
      }
    }
    for (const n of nodes) {
      if (!n) continue
      if (n.type === 'sceneNode') {
        const data = n.data || {}
        for (const bucket of ['characters', 'locations', 'items', 'factions', 'customs']) {
          for (const ref of (data[bucket] || [])) {
            visitRefLike(ref.entity_id, ref)
          }
        }
      } else if (n.type === 'entityNode' && n.data?.entity_id) {
        visitRefLike(n.data.entity_id, n.data)
      }
    }
  }

  return index
}

/** Source-key helpers exposed for callers (e.g. `useAlerts.js`) so they
 *  can look up by source kind without hardcoding the key format. */
export function relationshipSourceKey(relationshipId) {
  return `rel:${relationshipId}`
}

export function attributeSourceKey(entityId, attributeId) {
  return `attr:${entityId}:${attributeId}`
}
