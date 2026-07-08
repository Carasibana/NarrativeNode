/**
 * useEntityByIdMap — shared, memoized `Map<entityId, Entity>` over the
 * five entity buckets (characters / locations / items / factions /
 * customs). Avoids the per-(consumer × render × entity lookup) cost of
 * walking all five buckets calling `.find()` that every "what entity has
 * this id?" surface previously paid.
 *
 * Same architecture as `useKnowledgeNodeMaps` / `useRelationshipNodeMaps`:
 * module-level cache keyed on the five bucket reference identities. Every
 * mutation path in `entitiesStore` produces a new array reference for at
 * least one bucket (Zustand immutable-update discipline), so the cache
 * invalidates correctly on any real change. Stale entries are not
 * possible.
 *
 * Knowledges are deliberately NOT included — they live on `projectStore`
 * and already have their own id-keyed map via
 * `useKnowledgeNodeMaps().knowledgesById`. Surfaces that need both
 * (e.g. RelationshipChip's `getEntity`) chain `entityMap.get(id) ??
 * knowledgesById.get(id)`.
 */

import { useMemo } from 'react'
import { useEntitiesStore } from '../store/entitiesStore'

const EMPTY_MAP = new Map()

let _cache = {
  characters: null,
  locations: null,
  items: null,
  factions: null,
  customs: null,
  map: EMPTY_MAP,
}

function _buildMap(characters, locations, items, factions, customs) {
  const map = new Map()
  for (const bucket of [characters, locations, items, factions, customs]) {
    if (!Array.isArray(bucket)) continue
    for (const e of bucket) {
      if (e && e.id) map.set(e.id, e)
    }
  }
  return map
}

export function useEntityByIdMap() {
  const characters = useEntitiesStore((s) => s.characters)
  const locations = useEntitiesStore((s) => s.locations)
  const items = useEntitiesStore((s) => s.items)
  const factions = useEntitiesStore((s) => s.factions)
  const customs = useEntitiesStore((s) => s.customs)

  return useMemo(() => {
    if (
      _cache.characters === characters
      && _cache.locations === locations
      && _cache.items === items
      && _cache.factions === factions
      && _cache.customs === customs
    ) {
      return _cache.map
    }
    const map = _buildMap(characters, locations, items, factions, customs)
    // eslint-disable-next-line react-hooks/globals
    _cache = { characters, locations, items, factions, customs, map }
    return map
  }, [characters, locations, items, factions, customs])
}
