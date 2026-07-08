/**
 * useAwarenessSourceConsumers — Phase 1.21g Step 3
 *
 * React hook returning the reverse index from a projected source
 * (relationship id or `(entity_id, attribute_id)` tuple) to every
 * awareness field that uses it as a source. Memoised on the inputs
 * that affect the index (the project's entities + relationships +
 * knowledges).
 *
 * Consumers use `relationshipSourceKey(relId)` /
 * `attributeSourceKey(entityId, attrId)` to look up their source key,
 * then iterate the resulting `Set<descriptor>` to find every
 * awareness field that needs attention on a membership-change event.
 *
 * Index value shape and descriptor field documentation: see
 * `frontend/src/utils/awarenessSourceIndex.js`.
 */

import { useMemo } from 'react'
import { useEntitiesStore } from '../store/entitiesStore'
import { useProjectStore } from '../store/projectStore'
import { buildAwarenessSourceConsumers } from '../utils/awarenessSourceIndex'

export function useAwarenessSourceConsumers() {
  const characters    = useEntitiesStore((s) => s.characters)
  const locations     = useEntitiesStore((s) => s.locations)
  const items         = useEntitiesStore((s) => s.items)
  const factions      = useEntitiesStore((s) => s.factions)
  const customs       = useEntitiesStore((s) => s.customs)
  const relationships = useProjectStore((s) => s.relationships)
  const knowledges    = useProjectStore((s) => s.knowledges)
  const nodes         = useProjectStore((s) => s.nodes)

  return useMemo(() => {
    const allEntities = [...characters, ...locations, ...items, ...factions, ...customs]
    return buildAwarenessSourceConsumers(allEntities, relationships, knowledges, nodes)
  }, [characters, locations, items, factions, customs, relationships, knowledges, nodes])
}
