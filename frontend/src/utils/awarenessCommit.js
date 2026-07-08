/**
 * awarenessCommit — shared helpers for the awareness commit pipeline.
 *
 * Awareness-bearing surfaces (entity-existence / entity_name / per-attribute /
 * per-alias / relationship / knowledge) all share the same wrapper data shape
 * and the same diff-vs-prior algorithm at commit time. This module is the
 * single home for the wrapper unwrap helpers and the diff function so every
 * commit path computes write descriptors identically.
 *
 * Wrapper shape:
 *   {
 *     entries: { <observerEntityId>: <level>, ... },
 *     sources: [ { kind: 'relationship', relationship_id, level }
 *              | { kind: 'attribute',    entity_id, attribute_id, level } ]
 *   }
 *
 * Acceptable inputs (for the unwrap helpers):
 *   null / undefined            -> empty entries, empty sources
 *   non-object / array          -> empty entries, empty sources
 *   AwarenessRef                -> { relationship_id: <id> } only,
 *                                  no entries / sources keys
 *                                  -> empty entries, empty sources
 *   Wrapper                     -> entries dict + sources array
 *   Flat dict (legacy)          -> entries dict, no sources
 *
 * Write descriptors (the diff output):
 *   { entity_id, level }
 *     Direct entry change for one observer. `level === null` records an
 *     explicit "remove the key" mutation at the chain anchor.
 *   { source_action: 'add' | 'remove' | 'set_level', source }
 *     Source-list mutation for a relationship / entity-list contributor.
 *     Identity matched on `(kind, relationship_id)` or
 *     `(kind, entity_id, attribute_id)` via `sourceKey`.
 */

// Wrapper-shape reserved keys that must never be treated as observer
// entity ids. A legacy flat-dict awareness that picked up a stray
// `history` key (or any other wrapper-shape key) from a partial
// migration would otherwise leak the reserved key into every
// downstream consumer that iterates `Object.keys(entries)` —
// including `diffAwarenessDict` (emits a chain entry with
// `observer_id: 'history'` and `level: <the history array>`), the
// chain walker (sets `entries.history = <array>`), and the
// `get_knowledge_awareness_history` projector (emits a `baseline_set`
// event with the bogus observer). Filtering at the parse boundary
// closes every downstream symptom in one place. Surfaced 2026-05-18
// by the freeform v7 blind-agent test.
const _AWARENESS_RESERVED_WRAPPER_KEYS = new Set(['entries', 'sources', 'history'])

function _filterObserverKeys(rawEntries) {
  if (!rawEntries || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) return {}
  const out = {}
  for (const [k, v] of Object.entries(rawEntries)) {
    if (_AWARENESS_RESERVED_WRAPPER_KEYS.has(k)) continue
    out[k] = v
  }
  return out
}

export function awarenessEntries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  if ('relationship_id' in value && !('entries' in value) && !('sources' in value)) return {}
  if ('entries' in value || 'sources' in value) return _filterObserverKeys(value.entries || {})
  return _filterObserverKeys(value)
}

export function awarenessSources(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  if ('relationship_id' in value && !('sources' in value)) return []
  return Array.isArray(value.sources) ? value.sources : []
}

export function sourceKey(source) {
  if (!source) return ''
  if (source.kind === 'relationship') return `rel:${source.relationship_id}`
  if (source.kind === 'attribute')    return `attr:${source.entity_id}:${source.attribute_id}`
  return ''
}

export function diffAwarenessDict(prior, next) {
  const writes = []

  const priorDict = awarenessEntries(prior)
  const nextDict  = awarenessEntries(next)
  const observers = new Set([...Object.keys(priorDict), ...Object.keys(nextDict)])
  for (const obs of observers) {
    const before = priorDict[obs]
    const after  = nextDict[obs]
    if (before === after) continue
    writes.push({ entity_id: obs, level: after === undefined ? null : after })
  }

  const priorByKey = new Map()
  for (const s of awarenessSources(prior)) {
    const k = sourceKey(s)
    if (k) priorByKey.set(k, s)
  }
  const nextByKey = new Map()
  for (const s of awarenessSources(next)) {
    const k = sourceKey(s)
    if (k) nextByKey.set(k, s)
  }
  for (const [k, src] of nextByKey) {
    const before = priorByKey.get(k)
    if (!before) writes.push({ source_action: 'add', source: { ...src } })
    else if (before.level !== src.level) writes.push({ source_action: 'set_level', source: { ...src } })
  }
  for (const [k, src] of priorByKey) {
    if (!nextByKey.has(k)) writes.push({ source_action: 'remove', source: { ...src } })
  }

  return writes
}

/**
 * Target descriptor — identifies which awareness-bearing surface a write
 * targets. The descriptor is just data; it carries the ids the helpers
 * need to read the prior baseline / chain-resolved value AND to land
 * chain entries on the right awareness object's history list.
 *
 *   { kind: 'entity',         entityId }
 *   { kind: 'entity_name',    entityId }
 *   { kind: 'attribute',      entityId, attributeId }
 *   { kind: 'alias',          entityId, aliasValue }
 *   { kind: 'relationship',   relationshipId }
 *   { kind: 'knowledge',      knowledgeId }
 */

/**
 * Read the prior baseline awareness wrapper for a target from an entity
 * snapshot. Returns null when the field is absent. Pure; no walker calls.
 */
export function readBaselineAwarenessForTarget(entity, target) {
  if (!entity || !target) return null
  if (target.kind === 'entity')      return entity.awareness ?? null
  if (target.kind === 'entity_name') return entity.name_awareness ?? null
  if (target.kind === 'attribute') {
    const attr = (entity.attributes || []).find((a) => a.id === target.attributeId)
    return attr?.awareness ?? null
  }
  if (target.kind === 'alias') {
    const al = (entity.aliases || []).find((a) => (typeof a === 'string' ? a : a?.value) === target.aliasValue)
    if (!al || typeof al === 'string') return null
    return al.awareness ?? null
  }
  throw new Error(`readBaselineAwarenessForTarget: unsupported target.kind '${target.kind}'`)
}

/**
 * Read the prior chain-resolved awareness wrapper for a target from a
 * walker-emitted effective state. Preserves the wrapper shape via the
 * `*_raw` field when available. Returns null when the field is absent.
 */
export function readEffectiveAwarenessForTarget(eff, target) {
  if (!eff || !target) return null
  if (target.kind === 'entity')      return eff.awareness_raw ?? eff.awareness ?? null
  if (target.kind === 'entity_name') return eff.name_awareness_raw ?? eff.name_awareness ?? null
  if (target.kind === 'attribute') {
    const attr = (eff.attributes || []).find((a) => a.id === target.attributeId)
    return attr?.awareness_raw ?? attr?.awareness ?? null
  }
  if (target.kind === 'alias') {
    const al = (eff.aliases || []).find((a) => (typeof a === 'string' ? a : a?.value) === target.aliasValue)
    if (!al || typeof al === 'string') return null
    return al.awareness_raw ?? al.awareness ?? null
  }
  throw new Error(`readEffectiveAwarenessForTarget: unsupported target.kind '${target.kind}'`)
}

/**
 * Apply the draft as a baseline write on a working entity copy,
 * dispatching on `target.kind`. Returns a new entity; the input is not
 * mutated. Caller is responsible for handing the result to
 * `updateEntity` (or accumulating multiple targets onto the same working
 * copy before the network call).
 */
// ── Awareness-as-second-class-object helpers ───────────────────────────────
// Awareness is attached to a host (Entity / Attribute / Alias / Relationship /
// Knowledge) and has its OWN chain history list. These helpers locate the
// awareness sub-object on a host given a target descriptor, and produce new
// awareness wrappers with chain entries appended.

/**
 * Read the awareness wrapper currently attached to `host` for the given
 * `target` descriptor. Returns null when the awareness is unset on the host
 * (the field doesn't exist or is null).
 *
 * `host` is whichever object owns the awareness:
 *   - Entity for kinds: 'entity', 'entity_name', 'attribute', 'alias'
 *   - Relationship for kind: 'relationship'
 *   - Knowledge for kind: 'knowledge'
 */
export function readAwarenessAtTarget(host, target) {
  if (!host || !target) return null
  if (target.kind === 'entity')      return host.awareness ?? null
  if (target.kind === 'entity_name') return host.name_awareness ?? null
  if (target.kind === 'attribute') {
    const attr = (host.attributes || []).find((a) => a.id === target.attributeId)
    return attr?.awareness ?? null
  }
  if (target.kind === 'alias') {
    const a = (host.aliases || []).find((x) => (typeof x === 'string' ? x : x?.value) === target.aliasValue)
    if (!a || typeof a === 'string') return null
    return a.awareness ?? null
  }
  if (target.kind === 'relationship') return host.awareness ?? null  // host IS the relationship
  if (target.kind === 'knowledge')    return host.awareness ?? null  // host IS the knowledge
  return null
}

/**
 * Return a NEW host with the awareness wrapper at `target` replaced by
 * `newAwareness`. Does not mutate the input host.
 */
export function setAwarenessAtTarget(host, target, newAwareness) {
  if (!host || !target) return host
  if (target.kind === 'entity')      return { ...host, awareness: newAwareness }
  if (target.kind === 'entity_name') return { ...host, name_awareness: newAwareness }
  if (target.kind === 'attribute') {
    return {
      ...host,
      attributes: (host.attributes || []).map((a) =>
        a.id === target.attributeId ? { ...a, awareness: newAwareness } : a
      ),
    }
  }
  if (target.kind === 'alias') {
    return {
      ...host,
      aliases: (host.aliases || []).map((a) => {
        if (typeof a === 'string') {
          return a === target.aliasValue ? { value: a, awareness: newAwareness } : a
        }
        return a?.value === target.aliasValue ? { ...a, awareness: newAwareness } : a
      }),
    }
  }
  if (target.kind === 'relationship') return { ...host, awareness: newAwareness }
  if (target.kind === 'knowledge')    return { ...host, awareness: newAwareness }
  return host
}

/**
 * Build awareness chain entries from diff-output deltas, anchored at the
 * given node id. Each delta becomes one `AwarenessHistoryEntry`-shaped
 * object: `{ id, node_id, observer_id, level, source_action?, source? }`.
 *
 * Direct-entry deltas (`{entity_id, level}`) → entry with `observer_id`+`level`.
 * Source-mutation deltas (`{source_action, source}`) → entry with
 * `source_action`+`source`, `observer_id` empty, `level` null.
 */
export function buildAwarenessHistoryEntriesFromDeltas(deltas, nodeId) {
  const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
  return (deltas || []).map((d) => {
    if (d.source_action) {
      return { id: newId(), node_id: nodeId, observer_id: '', level: null, source_action: d.source_action, source: { ...d.source } }
    }
    return { id: newId(), node_id: nodeId, observer_id: d.entity_id, level: d.level, source_action: null, source: null }
  })
}

/**
 * Append history entries to an awareness wrapper, enforcing the
 * normalised-history invariant:
 *   - At most one direct-entry per `(node_id, observer_id)`.
 *   - At most one source-mutation per `(node_id, source-identity)`.
 * Re-writes at the same key replace in place.
 *
 * Promotes flat-dict input to wrapper shape so the result always has a
 * `history` field. Returns a new wrapper object.
 */
export function appendAwarenessHistoryEntries(awareness, newEntries) {
  if (!Array.isArray(newEntries) || newEntries.length === 0) return awareness

  let entries = null
  let sources = null
  let history = []
  if (awareness == null) {
    // null → fresh wrapper with just history.
  } else if (typeof awareness === 'object' && !Array.isArray(awareness)) {
    if ('entries' in awareness || 'sources' in awareness || 'history' in awareness) {
      entries = awareness.entries == null ? null : { ...awareness.entries }
      sources = Array.isArray(awareness.sources) ? awareness.sources.map((s) => ({ ...s })) : null
      history = Array.isArray(awareness.history) ? [...awareness.history] : []
    } else if ('relationship_id' in awareness && 'level' in awareness) {
      // Legacy AwarenessRef — promote to wrapper with one source + fresh history.
      sources = [{ kind: 'relationship', relationship_id: awareness.relationship_id, level: awareness.level }]
    } else {
      // Flat dict — promote to wrapper.
      entries = { ...awareness }
    }
  }

  for (const newE of newEntries) {
    if (newE.tracking_action === 'on' || newE.tracking_action === 'off') {
      // Tracking events dedup per node — at most one tracking event per
      // node_id. Re-toggling at the same node replaces the prior event.
      const idx = history.findIndex((h) =>
        h?.node_id === newE.node_id && (h?.tracking_action === 'on' || h?.tracking_action === 'off')
      )
      if (idx >= 0) history[idx] = newE
      else history.push(newE)
    } else if (newE.source_action) {
      const key = sourceKey(newE.source)
      const idx = history.findIndex((h) =>
        h?.node_id === newE.node_id
        && (h?.source_action === 'add' || h?.source_action === 'remove' || h?.source_action === 'set_level')
        && sourceKey(h?.source) === key
      )
      if (idx >= 0) history[idx] = newE
      else history.push(newE)
    } else {
      const idx = history.findIndex((h) =>
        h?.node_id === newE.node_id
        && !h?.source_action
        && !h?.tracking_action
        && h?.observer_id === newE.observer_id
      )
      if (idx >= 0) history[idx] = newE
      else history.push(newE)
    }
  }

  const out = {}
  if (entries !== null) out.entries = entries
  if (sources !== null) out.sources = sources
  out.history = history
  return out
}

/**
 * Merge a picker draft onto an existing awareness wrapper at the
 * awareness object's origin, preserving the wrapper's own chain history.
 *
 * The picker emits null | flat dict | { entries, sources } and never
 * carries `history` through. Applying its output verbatim would collapse
 * any chain entries already attached to the awareness object. When the
 * existing wrapper has non-empty history, keep the wrapper shell and
 * overlay only the entries / sources the picker manages.
 *
 * When `oldAware` is null or a flat dict (no chain history to lose),
 * return the draft directly — matches the historical behaviour.
 */
export function mergeBaselineAwarenessDraft(oldAware, draft) {
  const oldIsWrapper = oldAware && typeof oldAware === 'object' && !Array.isArray(oldAware)
    && !('relationship_id' in oldAware && 'level' in oldAware)
    && ('history' in oldAware || 'sources' in oldAware || 'entries' in oldAware)
  const oldHasHistory = oldIsWrapper && Array.isArray(oldAware.history) && oldAware.history.length > 0
  if (!oldHasHistory) return draft

  let draftEntries = null
  let draftSources = null
  if (draft != null && typeof draft === 'object' && !Array.isArray(draft)) {
    if ('entries' in draft || 'sources' in draft) {
      draftEntries = draft.entries ?? null
      draftSources = Array.isArray(draft.sources) ? draft.sources : null
    } else {
      draftEntries = { ...draft }
    }
  }
  return { ...oldAware, entries: draftEntries, sources: draftSources, history: oldAware.history }
}

export function applyBaselineDraftToEntity(entity, target, draft) {
  if (target.kind === 'entity') {
    return { ...entity, awareness: mergeBaselineAwarenessDraft(entity.awareness ?? null, draft) }
  }
  if (target.kind === 'entity_name') {
    return { ...entity, name_awareness: mergeBaselineAwarenessDraft(entity.name_awareness ?? null, draft) }
  }
  if (target.kind === 'attribute') {
    return {
      ...entity,
      attributes: (entity.attributes || []).map((a) =>
        a.id === target.attributeId
          ? { ...a, awareness: mergeBaselineAwarenessDraft(a.awareness ?? null, draft) }
          : a
      ),
    }
  }
  if (target.kind === 'alias') {
    return {
      ...entity,
      aliases: (entity.aliases || []).map((a) => {
        if (typeof a === 'string') {
          return a === target.aliasValue
            ? { value: a, awareness: mergeBaselineAwarenessDraft(null, draft) }
            : a
        }
        return a?.value === target.aliasValue
          ? { ...a, awareness: mergeBaselineAwarenessDraft(a.awareness ?? null, draft) }
          : a
      }),
    }
  }
  throw new Error(`applyBaselineDraftToEntity: unsupported target.kind '${target.kind}'`)
}
