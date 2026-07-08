import { useEntitiesStore } from '../store/entitiesStore'

/**
 * Zustand selector hook — returns a single entity by ID from any bucket,
 * or null if not found.  Stable reference: only re-renders when the
 * matched entity object itself changes.
 */
export function useEntityById(entityId) {
  return useEntitiesStore((s) => {
    for (const bucket of [s.characters, s.locations, s.items, s.factions, s.customs, s.knowledges || []]) {
      const found = bucket.find((e) => e.id === entityId)
      if (found) return found
    }
    return null
  })
}
