/**
 * awarenessObserverIndex — Phase 2.11b
 *
 * Mirror of `awarenessSourceIndex.js`, with observer ids as the keys
 * instead of projected-source keys. For every awareness-bearing
 * surface in the project (entity / entity_name / attribute / alias /
 * relationship / knowledge), this index records which observers have
 * EVER been recorded on that surface — either in its baseline dict or
 * anywhere in its `history[]` chain entries.
 *
 * Consumed by [characterAwarenessInventory.js](characterAwarenessInventory.js)
 * to narrow the per-send chain walk to only the surfaces where the
 * focal character has ever appeared. Without this narrowing, the
 * inventory would have to walk every host's full chain (`O(N × chain
 * length)`); with it, the inventory walks only the hosts the
 * character has touched — which for a focal character in a novel-
 * length project is a far smaller set than the project's total
 * surface count.
 *
 * Sister pattern: `awarenessSourceIndex.buildAwarenessSourceConsumers`
 * iterates the same surfaces but indexes by SOURCE key (relationship
 * id or `(entity_id, attribute_id)` tuple). Both now go through the
 * shared `forEachAwarenessHostSurface` helper in
 * `awarenessSurfaceWalker.js` — same iteration order, same descriptor
 * shape, single source of truth. Each consumer only owns its own
 * per-surface logic (this one extracts observers; the source-index
 * one extracts sources).
 *
 * Observer descriptor shape:
 *   {
 *     host_kind:   'entity' | 'relationship' | 'knowledge',
 *     host_id:     string,                  // the host object's id
 *     target_kind: 'entity' | 'entity_name' | 'attribute' | 'alias'
 *                  | 'relationship' | 'knowledge',
 *     target_attr_id?:    string,           // for target_kind === 'attribute'
 *     target_alias_value?: string,          // for target_kind === 'alias'
 *   }
 *
 * The pair (host_kind+host_id, target_kind, target_attr_id|target_alias_value)
 * uniquely identifies an awareness wrapper. Multiple targets on the
 * same host get rolled up together — the inventory consumer groups
 * by host so each host's chain gets walked at most once per send,
 * even when the focal character observes multiple targets on the
 * same host (entity-level + name + attribute + alias).
 *
 * Returns `Map<observerId, Array<descriptor>>`. Order within each
 * array is iteration-stable (entities first, then relationships,
 * then knowledges).
 */


import { forEachAwarenessHostSurface } from './awarenessSurfaceWalker'


/**
 * Scan one awareness wrapper for every observer that has EVER been
 * recorded on it (in either the baseline dict or any history entry).
 * Calls `onObserver(observerId)` once per unique observer seen.
 *
 * Wrapper shapes handled:
 *   - Raw on-disk shape:
 *       { <observerId>: level, history: [{ observer_id, level, ... }], ... }
 *   - Walker-resolved shape:
 *       { flat: { <observerId>: level, ... }, history: [...], sources: [...], ... }
 *
 * Skips meta fields (`history`, `flat`, `sources`, `provenance`) so
 * they're never treated as observer ids.
 */
export function scanObserversInAwareness(awareness, onObserver) {
  if (!awareness || typeof awareness !== 'object') return
  const seen = new Set()
  const emit = (id) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    onObserver(id)
  }

  // Wrapper-shape baseline observers — modern format introduced
  // alongside the chain-history list. `entries` is a dict
  // `{ observerId: level, ... }`. The walker's `resolveAwarenessField`
  // unpacks this into the resolved flat dict; here we just want to
  // record that the observer has appeared at all.
  if (awareness.entries && typeof awareness.entries === 'object' && !Array.isArray(awareness.entries)) {
    for (const k of Object.keys(awareness.entries)) emit(k)
  }

  // Walker-resolved flat dict — when this function is handed an
  // already-resolved awareness shape (e.g. the chain walker's output),
  // the observers live under `.flat`.
  if (awareness.flat && typeof awareness.flat === 'object' && !Array.isArray(awareness.flat)) {
    for (const k of Object.keys(awareness.flat)) emit(k)
  }

  // Legacy flat-dict baseline observers — pre-wrapper shape where
  // observer ids were direct keys with numeric values on the awareness
  // object itself. Skip wrapper meta fields so they're never treated
  // as observer ids.
  for (const [k, v] of Object.entries(awareness)) {
    if (k === 'history' || k === 'flat' || k === 'entries' || k === 'sources' || k === 'provenance' || k === 'tracking') continue
    if (typeof v === 'number') emit(k)
  }

  // History entries — chain events recording when observer levels
  // changed at specific nodes.
  const hist = Array.isArray(awareness.history) ? awareness.history : []
  for (const e of hist) {
    if (!e || typeof e !== 'object') continue
    if (e.observer_id) emit(e.observer_id)
    if (Array.isArray(e.observers)) {
      for (const o of e.observers) emit(o)
    }
  }
}


/**
 * Build the observer→targets index by walking every awareness-bearing
 * surface in the project once.
 *
 * Phase 2.12 — the index now expands inherited observers in addition
 * to direct ones. Inheritance rules (must stay in sync with
 * `resolveObserverAwarenessLevel` in `narrativeChain.js`):
 *
 *   - Faction-direct-entry: when a wrapper entry's key is a Faction id,
 *     every participant of that faction's membership relationship
 *     (`relationship.membership_of === factionId`) is also recorded
 *     as observing this target.
 *   - Relationship source: when a wrapper has a `{kind: 'relationship'}`
 *     source, every participant of that relationship is recorded.
 *   - Attribute source: when a wrapper has a `{kind: 'attribute'}`
 *     source, every entity in the referenced entity_list attribute's
 *     value is recorded.
 *
 * The expansion is anchor-AGNOSTIC: it walks the relationship's base
 * `participants[]` plus every entity_id mentioned in
 * `participant_changes[]` (join events). The inventory walker still
 * resolves the actual level via `resolveObserverAwarenessLevel` per
 * anchor at consume time; this expansion only ensures the inventory
 * walker LOOKS at hosts where the focal character is an inherited
 * observer.
 *
 * @param {Array} allEntities    — every Entity (characters, locations,
 *                                  items, factions, customs, knowledges-
 *                                  as-entity for back-compat).
 * @param {Array} relationships  — every Relationship.
 * @param {Array} knowledges     — every Knowledge (post-Phase 1.21c
 *                                  first-class objects).
 * @returns {Map<string, Array<descriptor>>}
 */
export function buildAwarenessObserverIndex(allEntities, relationships, knowledges) {
  const index = new Map()
  const push = (observerId, target) => {
    let arr = index.get(observerId)
    if (!arr) { arr = []; index.set(observerId, arr) }
    arr.push(target)
  }

  // Map the surface walker's descriptor (designed around source-index's
  // vocabulary — surfaceKind / surfaceId / parentEntityId /
  // awarenessFieldPath) onto the observer-index's host_kind / host_id /
  // target_kind / target_attr_id / target_alias_value vocabulary. The
  // two are isomorphic; this `_toTarget` function is the only place the
  // mapping lives.
  forEachAwarenessHostSurface(
    { allEntities, relationships, knowledges },
    (awareness, descriptor) => {
      if (!awareness) return
      const target = _toTarget(descriptor)
      if (!target) return
      scanObserversInAwareness(awareness, (obs) => push(obs, target))
      // Phase 2.12 — inheritance-expansion pass. See header doc above.
      _expandInheritedObservers(awareness, target, push, allEntities, relationships)
    },
  )

  return index
}


/**
 * Walk one wrapper's entries / sources and emit inherited observer
 * ids via `push(observerId, target)`. Mirrors Rules 2-4 of
 * `resolveObserverAwarenessLevel` in `narrativeChain.js` — keep in
 * sync.
 */
function _expandInheritedObservers(awareness, target, push, allEntities, relationships) {
  if (!awareness || typeof awareness !== 'object') return
  const allEnts = Array.isArray(allEntities) ? allEntities : []
  const allRels = Array.isArray(relationships) ? relationships : []

  // Rule 2 — faction-direct-entry cascade: each (factionId, level)
  // entry expands to every participant the faction's membership
  // relationship has EVER had (base + every join event).
  //
  // We walk THREE places observers can live: `entries` (modern
  // wrapper baseline), top-level legacy flat-dict keys, and
  // `history[].observer_id` for chain-time `awareness_set` /
  // `awareness_source_set_level` events. Any faction observed in
  // any of those places at any chain point gets expanded.
  const _emitFactionMembersForObserver = (observerKey) => {
    const ent = allEnts.find((e) => e && e.id === observerKey)
    if (!ent || ent.type !== 'faction') return
    const membershipRel = allRels.find((r) => r && r.membership_of === ent.id)
    if (!membershipRel) return
    _emitRelationshipParticipants(membershipRel, push, target)
  }
  const entries = awareness.entries
  if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
    for (const observerKey of Object.keys(entries)) {
      _emitFactionMembersForObserver(observerKey)
    }
  }
  // Legacy flat-dict baseline observers too — pre-wrapper shape.
  for (const [k, v] of Object.entries(awareness)) {
    if (k === 'history' || k === 'flat' || k === 'entries' || k === 'sources' || k === 'provenance' || k === 'tracking') continue
    if (typeof v !== 'number') continue
    _emitFactionMembersForObserver(k)
  }
  // Chain-history-time faction observers — `awareness_set` events
  // recording per-observer level changes at specific anchors. The
  // event's `observer_id` might be a faction id; same Rule 2
  // expansion applies.
  const histEventsForFactions = Array.isArray(awareness.history) ? awareness.history : []
  for (const ev of histEventsForFactions) {
    if (!ev || typeof ev !== 'object') continue
    if (ev.action !== 'awareness_set') continue
    if (!ev.observer_id) continue
    _emitFactionMembersForObserver(ev.observer_id)
  }

  // Rule 3 — relationship-source cascade: each `{kind: 'relationship',
  // relationship_id, level}` source expands to every participant of
  // that relationship. Sources can live in two places — base
  // `wrapper.sources` (set at origin) AND `wrapper.history[]` chain
  // events (`action: 'awareness_source_add'` adds a source at a
  // specific chain point). Index is anchor-agnostic so we walk both
  // paths and emit participants for every relationship-source EVER
  // recorded — the level-resolver applies the per-anchor cutoff at
  // consume time.
  const baseSources = Array.isArray(awareness.sources) ? awareness.sources : []
  for (const src of baseSources) {
    if (!src || src.kind !== 'relationship') continue
    const rel = allRels.find((r) => r && r.id === src.relationship_id)
    if (!rel) continue
    _emitRelationshipParticipants(rel, push, target)
  }
  const histEvents = Array.isArray(awareness.history) ? awareness.history : []
  for (const ev of histEvents) {
    if (!ev || typeof ev !== 'object') continue
    if (ev.action !== 'awareness_source_add' && ev.action !== 'awareness_source_set_level') continue
    const src = ev.source
    if (!src || src.kind !== 'relationship') continue
    const rel = allRels.find((r) => r && r.id === src.relationship_id)
    if (!rel) continue
    _emitRelationshipParticipants(rel, push, target)
  }
}


/** Walk a relationship's base participants + history join events and
 *  emit every entity_id that's ever been a participant. */
function _emitRelationshipParticipants(rel, push, target) {
  const seen = new Set()
  const emit = (id) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    push(id, target)
  }
  for (const p of (rel.participants || [])) {
    if (p && p.entity_id) emit(p.entity_id)
  }
  const histList = rel.history?.participant_changes || []
  for (const h of histList) {
    if (h && h.entity_id) emit(h.entity_id)
  }
}


/** Translate a walker-emitted surface descriptor into an
 *  observer-index target descriptor. */
function _toTarget(d) {
  if (d.surfaceKind === 'entity') {
    if (d.awarenessFieldPath === 'name_awareness') {
      return { host_kind: 'entity', host_id: d.surfaceId, target_kind: 'entity_name' }
    }
    return { host_kind: 'entity', host_id: d.surfaceId, target_kind: 'entity' }
  }
  if (d.surfaceKind === 'attribute') {
    return {
      host_kind: 'entity', host_id: d.parentEntityId,
      target_kind: 'attribute', target_attr_id: d.surfaceId,
    }
  }
  if (d.surfaceKind === 'alias') {
    return {
      host_kind: 'entity', host_id: d.parentEntityId,
      target_kind: 'alias', target_alias_value: d.surfaceId,
    }
  }
  if (d.surfaceKind === 'relationship') {
    return { host_kind: 'relationship', host_id: d.surfaceId, target_kind: 'relationship' }
  }
  if (d.surfaceKind === 'knowledge') {
    return { host_kind: 'knowledge', host_id: d.surfaceId, target_kind: 'knowledge' }
  }
  return null
}
