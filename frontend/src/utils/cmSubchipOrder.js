/**
 * Phase 1.26 — Sub-chip ordering helper for circumstance / motivator
 * sub-chips on an entity chip at a scene.
 *
 * Two display-ordering modes per (scene, entity, kind):
 *
 * - **Auto** (manual order absent / empty): descending intensity, then
 *   stable UUID subsort. Newly added sub-chips slot into the sorted
 *   position naturally on the next render.
 * - **Manual** (manual order populated): each id in the order list
 *   takes its position; sub-chips not yet present in the list fall to
 *   the end, preserving their among-themselves order. New entries
 *   added while in manual mode therefore append to the bottom.
 *
 * The order list mixes chain-resolved attribute ids with scene-local
 * `EntityTemporaryCM` ids. Both are UUIDs and live in disjoint id
 * spaces, so a single ordered list per (scene, entity, kind) covers
 * the combined display set.
 *
 * The store action that writes the list is `reorderEntityCMs`. Reading
 * the list happens at every render site so display order stays
 * consistent across the canvas, hover popovers, and Detail Panel.
 */

/**
 * Pure helper. Given an array of CM entries (each must have `id` and
 * `intensity` fields) and a manual-order list, returns the entries in
 * display order. Does not mutate inputs.
 *
 * @param {Array<{id: string, intensity: number|null|undefined}>} entries
 * @param {Array<string>|undefined|null} manualOrder
 * @returns {Array} — same entry objects, reordered.
 */
export function orderedCMEntries(entries, manualOrder) {
  if (!Array.isArray(entries) || entries.length === 0) return []
  const hasManual = Array.isArray(manualOrder) && manualOrder.length > 0
  if (!hasManual) return autoSortCMEntries(entries)
  const orderMap = new Map(manualOrder.map((id, i) => [id, i]))
  // Stable sort: in-order entries by their position in manualOrder;
  // entries not in the manual list fall to the end, keeping their
  // relative order as they appeared in `entries`.
  return [...entries].sort((a, b) => {
    const ai = orderMap.has(a.id) ? orderMap.get(a.id) : Infinity
    const bi = orderMap.has(b.id) ? orderMap.get(b.id) : Infinity
    if (ai !== bi) return ai - bi
    // Both not in manual order: preserve original index (stable).
    if (ai === Infinity && bi === Infinity) {
      return entries.indexOf(a) - entries.indexOf(b)
    }
    return 0
  })
}

/**
 * Default auto-sort: descending intensity (null treated as -1, sinks
 * below 0), then ascending UUID for a deterministic tiebreak.
 *
 * @param {Array<{id: string, intensity: number|null|undefined}>} entries
 */
export function autoSortCMEntries(entries) {
  const intensityValue = (e) => (typeof e.intensity === 'number' ? e.intensity : -1)
  return [...entries].sort((a, b) => {
    const ai = intensityValue(a)
    const bi = intensityValue(b)
    if (ai !== bi) return bi - ai
    // Tiebreak: lexicographic on id (UUIDs are stable across saves).
    if (a.id < b.id) return -1
    if (a.id > b.id) return 1
    return 0
  })
}

/**
 * Read the manual-order array for a (scene, entity, kind) bucket.
 * Returns the array if present and non-empty, otherwise null.
 *
 * @param {object} sceneNodeData — scene node `data` object
 * @param {string} entityId
 * @param {'circumstance'|'motivator'} kind
 * @returns {Array<string>|null}
 */
export function getCMManualOrder(sceneNodeData, entityId, kind) {
  if (!sceneNodeData || !entityId) return null
  const map = sceneNodeData.cm_chip_order
  if (!map || typeof map !== 'object') return null
  const perEntity = map[entityId]
  if (!perEntity || typeof perEntity !== 'object') return null
  const arr = perEntity[kind]
  if (!Array.isArray(arr) || arr.length === 0) return null
  return arr
}

/**
 * Convenience: combined sort that pulls the manual order out of the
 * scene node data and applies it. Caller doesn't have to know whether
 * a manual order is present; if absent the auto-sort applies.
 *
 * @param {Array} entries
 * @param {object} sceneNodeData
 * @param {string} entityId
 * @param {'circumstance'|'motivator'} kind
 */
export function orderedCMEntriesFromScene(entries, sceneNodeData, entityId, kind) {
  const manual = getCMManualOrder(sceneNodeData, entityId, kind)
  return orderedCMEntries(entries, manual)
}
