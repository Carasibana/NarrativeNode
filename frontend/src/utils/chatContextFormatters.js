/**
 * Shared chat-context formatters — Phase 2.5h.
 *
 * Lifted out of `sceneContextPrompt.js` so the Story Scope appendage
 * (Phase 2.5h) can reuse the same helpers without importing the
 * scene-specific block builder.
 *
 * Everything here is presentation-only: takes already-resolved data
 * (chain-walked elsewhere) and renders strings. No store reads, no
 * chain walks, no I/O.
 */
import { ENTITY_BUCKETS } from './entityHelpers'


/** Collapse multi-line / repeated whitespace to a single space. */
export function oneline(s) {
  if (!s) return ''
  return String(s).replace(/\s+/g, ' ').trim()
}


/** Title-case the first letter only (matches buckets → bucket label). */
export function titleCase(s) {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}


/** Resolve an entity by id across every bucket; returns `{ entity, type }`
 *  with `type` as the singular bucket name (e.g. `'character'`), or null. */
export function findEntity(story, entityId) {
  const entities = story?.entities || {}
  for (const bucket of ENTITY_BUCKETS) {
    const list = entities[bucket] || []
    for (const e of list) {
      if (e && e.id === entityId) {
        return { entity: e, type: bucket.replace(/s$/, '') }
      }
    }
  }
  return null
}


/** Convenience — just the baseline name for an entity id, or '' if unknown.
 *  Caller is responsible for using a chain-aware name when one is required;
 *  this helper is only for places that genuinely want the baseline. */
export function entityNameBaseline(story, entityId) {
  if (!entityId) return ''
  const found = findEntity(story, entityId)
  return found?.entity?.name || ''
}


/** Pull just the scene-node ids out of `storyOrder.orderedIds`, preserving
 *  story order. Used for 1-based "scene X of N" positioning and for
 *  ordering a chapter / act's scenes by story position. */
export function sceneOrderList(nodes, storyOrder) {
  const orderedIds = storyOrder?.orderedIds || []
  if (orderedIds.length === 0) return []
  const nodeTypeById = new Map()
  for (const n of nodes || []) {
    if (n && n.id) nodeTypeById.set(n.id, n.type)
  }
  const out = []
  for (const id of orderedIds) {
    if (nodeTypeById.get(id) === 'sceneNode') out.push(id)
  }
  return out
}


/** Format a 0-3 awareness level as `"Partially aware (3/4)"` — descriptor
 *  name plus 1-based rank out of 4 distinct levels. Mirrors the
 *  `intensityName` shape so the LLM gets the same relative-weight signal
 *  for awareness that it already gets for circumstance / motivator
 *  intensity. Levels 1-2 are inhabited only by the alias / knowledge
 *  scale; the binary scale (entity / attribute / relationship) uses only
 *  {0, 3} but the suffix uses the full 4-level scale either way so the
 *  reader can see how far from "fully aware" a given level sits. */
export function awarenessLevelName(n) {
  const num = Number(n)
  let name
  switch (num) {
    case 0: name = 'Unaware'; break
    case 1: name = 'Nominally aware'; break
    case 2: name = 'Partially aware'; break
    case 3: name = 'Fully aware'; break
    default: return String(n)
  }
  return `${name} (${num + 1}/4)`
}


/** Format a 0-4 intensity value as "Strong (4/5)" — the descriptor name
 *  plus 1-based position so the model has a relative-weight sense. */
export function intensityName(n) {
  const num = Number(n)
  let name
  switch (num) {
    case 0: name = 'Faint'; break
    case 1: name = 'Mild'; break
    case 2: name = 'Moderate'; break
    case 3: name = 'Strong'; break
    case 4: name = 'Intense'; break
    default: return String(n)
  }
  return `${name} (${num + 1}/5)`
}


export function weekdayName(n) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return days[Number(n)] || ''
}


export function seasonName(n) {
  const seasons = ['Spring', 'Summer', 'Autumn', 'Winter']
  return seasons[Number(n)] || ''
}


export function monthName(n) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December']
  return months[Number(n) - 1] || ''
}


/** Build the comma-separated time / weekday / season / date / year string
 *  for a scene's `data`. Returns '' when no time fields are set. */
export function formatTimeBits(data) {
  if (!data) return ''
  const bits = []
  if (data.time_of_day_tier === 'labelled' && data.time_of_day_labelled) bits.push(data.time_of_day_labelled)
  else if (data.time_of_day_tier === 'exact' && data.time_of_day_exact) bits.push(data.time_of_day_exact)
  else if (data.time_of_day_tier === 'broad' && data.time_of_day_broad) bits.push(data.time_of_day_broad)
  if (data.weekday != null) {
    const n = weekdayName(data.weekday)
    if (n) bits.push(n)
  }
  if (data.season != null) {
    const n = seasonName(data.season)
    if (n) bits.push(n)
  }
  if (data.date_month != null) {
    const m = monthName(data.date_month)
    if (m) bits.push(data.date_day_of_month != null ? `${m} ${data.date_day_of_month}` : m)
  }
  if (data.year != null) bits.push(`year ${data.year}`)
  return bits.join(', ')
}


/** Collapse awareness wrapper / flat dict variants into a flat
 *  `{observerId: level}`. Handles the `{flat, observers, provenance}`
 *  wrapper shape from the chain walker plus the legacy flat-dict
 *  shape from `awareness` (vs `awareness_raw`). */
export function flatAwareness(awareness) {
  if (!awareness || typeof awareness !== 'object') return {}
  if (awareness.flat && typeof awareness.flat === 'object') return awareness.flat
  const out = {}
  for (const [k, v] of Object.entries(awareness)) {
    if (typeof v === 'number') out[k] = v
  }
  return out
}


/** Stringify an attribute's value field per its `attribute_type`. Returns
 *  '' for attributes whose value field isn't populated (the caller renders
 *  a bare-name fallback). For circumstance / motivator returns
 *  "<description> [<intensity>]". */
export function attributeValueString(attr) {
  if (!attr) return ''
  const t = attr.attribute_type
  if (t === 'text_list' || t === 'entity_list') {
    if (Array.isArray(attr.values) && attr.values.length > 0) return attr.values.join(', ')
    if (Array.isArray(attr.value)) return attr.value.join(', ')
    return ''
  }
  if (t === 'file') {
    return attr.file_ref ? `[file: ${attr.file_ref}]` : ''
  }
  if (t === 'circumstance' || t === 'motivator') {
    const bits = []
    if (attr.description) bits.push(oneline(String(attr.description)))
    if (attr.intensity != null) bits.push(`[${intensityName(attr.intensity)}]`)
    return bits.join(' ')
  }
  return attr.value != null ? String(attr.value) : ''
}
