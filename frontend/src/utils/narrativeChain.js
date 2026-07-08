/**
 * Shared narrative-chain utilities.
 * Used by EntityDetailPanel (sidebar) and SceneNode (canvas chips).
 * Pure functions — no React or store imports.
 */

// Re-export ENTITY_BUCKETS from entityHelpers (source of truth) for backward
// compatibility with existing consumers that import it from this module.
import { ENTITY_BUCKETS } from './entityHelpers.js'
import { buildAwarenessSourceConsumers } from './awarenessSourceIndex.js'
export { ENTITY_BUCKETS }

/**
 * Parse a list attribute's JSON-encoded value into a plain array. Returns [] on parse failure
 * or if the value isn't an array. text_list and entity_list attributes share the same storage
 * shape: `value` is a JSON-encoded array of strings.
 */
export function parseListValue(value) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Phase 1.22 — render a numeric attribute's float value for compact
 * chip / sub-chip display. Strips trailing `.0` so `15.0` shows as
 * `15` while `12.5` shows as `12.5`. Returns an empty string for
 * null / undefined / non-finite inputs.
 */
export function formatNumberForChip(n) {
  if (n === null || n === undefined) return ''
  const f = Number(n)
  if (!Number.isFinite(f)) return ''
  return Number.isInteger(f) ? String(f) : String(f)
}

/**
 * True when an awareness value is an `AwarenessRef` (relationship-sourced
 * projection) rather than a scalar dict. Refs round-trip through JSON as
 * plain objects with `relationship_id` + `level` keys, so detection is
 * shape-based — we can't rely on a Pydantic class. Scalar sets on a ref
 * are ignored: refs are all-or-nothing, swapping ref for dict is an
 * explicit separate operation.
 */
function isAwarenessRef(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, 'relationship_id')
    && Object.prototype.hasOwnProperty.call(value, 'level')
    && Object.keys(value).length === 2
}

// Wrapper-shape detection. A wrapper has at least one of `entries`,
// `sources`, or `history` (the awareness's own chain history). A flat
// dict (legacy shape) has none of those keys; its keys are entity ids
// mapping directly to levels.
function isAwarenessWrapper(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.prototype.hasOwnProperty.call(value, 'entries')
        || Object.prototype.hasOwnProperty.call(value, 'sources')
        || Object.prototype.hasOwnProperty.call(value, 'history'))
}

/**
 * Deep-clone an awareness value for the walker's initial state so later
 * in-place mutations don't leak back into the store.
 *
 * Note: this preserves shape (flat dict stays flat dict; wrapper stays
 * wrapper). Most walker init paths route through `resolveAwarenessField`
 * (Phase 1.21g) instead, which COLLAPSES the shape to a flat resolved
 * dict — so chain-time direct-entry mutations operate on the flat
 * shape uniformly. `cloneAwareness` is kept around for internal
 * shape-preserving operations (and for raw-shape consumers like the
 * picker).
 */
function cloneAwareness(value) {
  if (value == null) return null
  if (isAwarenessRef(value)) return { relationship_id: value.relationship_id, level: value.level }
  if (isAwarenessWrapper(value)) {
    const out = {}
    if (value.entries != null) out.entries = { ...value.entries }
    if (value.sources != null) out.sources = value.sources.map((s) => ({ ...s }))
    // Preserve the awareness object's own chain history (Phase 1.21k
    // awareness-as-second-class-object model). Dropping `history` here
    // strips chain entries before the walker / picker reads them.
    if (Array.isArray(value.history)) out.history = value.history.map((h) => ({ ...h, source: h?.source ? { ...h.source } : null }))
    return out
  }
  if (typeof value === 'object') return { ...value }
  return null
}

/**
 * Phase 1.21g — Resolve any awareness shape to a flat `{ entity_id: level }`
 * dict (or null when not tracking). This is the single read-side entry
 * point the walker uses to collapse the three valid on-disk shapes
 * (null, flat dict, wrapper) into the uniform flat-dict shape every
 * downstream consumer (sub-chips, alerts, "Aware Of" / "Known by"
 * sections, exports) expects.
 *
 * Resolution rule (per the Phase 1.21g design):
 *   1. Direct entries always win. Every `(entity_id, level)` in
 *      `wrapper.entries` is in the result.
 *   2. Among projections, the highest level wins. For each source in
 *      `wrapper.sources`, resolve its membership at the chain anchor;
 *      for each member NOT pinned by a direct entry, keep the max
 *      level across every projection that covers them.
 *   3. Otherwise absent. Entities not in `entries` and not covered by
 *      any projection have no entry on the result.
 *
 * `ctx` provides the data needed to resolve projected source membership:
 *   { nodes, edges, allEntities, allRelationships, anchorNodeId }
 *
 * `ctx` is optional; when missing or incomplete, projection sources
 * that need it resolve to empty memberships (so a flat dict still
 * resolves cleanly even without context).
 */
export function resolveAwarenessField(awareness, ctx) {
  if (awareness == null) return null
  if (typeof awareness !== 'object' || Array.isArray(awareness)) return null

  // Defensive: legacy single-AwarenessRef shape might appear in code
  // paths that haven't been routed through the backend's load-side
  // shim. Treat as a wrapper with one relationship source.
  if (isAwarenessRef(awareness)) {
    return resolveAwarenessField(
      { sources: [{ kind: 'relationship', relationship_id: awareness.relationship_id, level: awareness.level }] },
      ctx,
    )
  }

  // Wrapper shape — apply the awareness's own chain history first, then
  // resolve sources to flat dict.
  if (isAwarenessWrapper(awareness)) {
    const walked = applyAwarenessHistoryToWrapper(awareness, ctx)
    // Chain-tracked tracking state — when off at the anchor, the layer
    // is suppressed entirely regardless of the data sitting underneath.
    if (walked.tracking === false) return null
    const entries = walked.entries || {}
    const sources = walked.sources || []

    const result = { ...entries }
    const directKeys = new Set(Object.keys(entries))
    for (const src of sources) {
      const memberIds = resolveSourceMembership(src, ctx)
      for (const memberId of memberIds) {
        if (directKeys.has(memberId)) continue  // direct entry wins
        const existing = result[memberId]
        if (existing == null || src.level > existing) {
          result[memberId] = src.level
        }
      }
    }
    return Object.keys(result).length > 0 ? result : null
  }

  // Flat dict (legacy shape — no history possible) — return a clone.
  return { ...awareness }
}

/**
 * Same resolution as `resolveAwarenessField` but ALSO returns the
 * provenance of each observer's level: whether it came from a DIRECT
 * entry pin or was INHERITED from a projection source (and which
 * source(s) contributed).
 *
 * Returns `{ levels, provenance }` where:
 *   - `levels` — same flat `{entity_id: level}` shape `resolveAwarenessField`
 *     returns. Null if the awareness layer is tracking-off or has no
 *     observers at the anchor.
 *   - `provenance` — `{entity_id: { via, inherited_from? }}` per observer:
 *     - `via: 'direct'` → observer has a direct entry pin at the anchor.
 *     - `via: 'inherited'` → observer's level came only from projection(s).
 *       `inherited_from` is a list of contributing sources (every source
 *       whose level equals the resolved max), each as the raw Source shape
 *       `{ kind: 'relationship', relationship_id, level }`. Callers that
 *       need readable names should enrich the relationship_id to a name
 *       at presentation time.
 *
 * Useful for MCP read responses where the agent needs to know not just
 * "what level does observer X have" but ALSO "why does observer X have
 * that level" — i.e. distinguishing direct pins from group projections
 * (e.g. "Tyler is Unaware because he's a member of Sigma Tau Members,
 * which projects Unaware on this Knowledge").
 */
export function resolveAwarenessFieldWithProvenance(awareness, ctx) {
  if (awareness == null) return { levels: null, provenance: null }
  if (typeof awareness !== 'object' || Array.isArray(awareness)) return { levels: null, provenance: null }

  if (isAwarenessRef(awareness)) {
    return resolveAwarenessFieldWithProvenance(
      { sources: [{ kind: 'relationship', relationship_id: awareness.relationship_id, level: awareness.level }] },
      ctx,
    )
  }

  if (isAwarenessWrapper(awareness)) {
    const walked = applyAwarenessHistoryToWrapper(awareness, ctx)
    if (walked.tracking === false) return { levels: null, provenance: null }
    const entries = walked.entries || {}
    const sources = walked.sources || []

    const levels = { ...entries }
    const provenance = {}
    const directKeys = new Set(Object.keys(entries))
    for (const obs of directKeys) provenance[obs] = { via: 'direct' }
    for (const src of sources) {
      const memberIds = resolveSourceMembership(src, ctx)
      for (const memberId of memberIds) {
        if (directKeys.has(memberId)) continue  // direct entry wins; record only direct provenance
        const existing = levels[memberId]
        if (existing == null || src.level > existing) {
          levels[memberId] = src.level
          provenance[memberId] = { via: 'inherited', inherited_from: [{ ...src }] }
        } else if (src.level === existing && provenance[memberId]?.via === 'inherited') {
          // Tie at the resolved max — record this source too (all contributors).
          provenance[memberId].inherited_from.push({ ...src })
        }
      }
    }
    if (Object.keys(levels).length === 0) return { levels: null, provenance: null }
    return { levels, provenance }
  }

  // Flat dict (legacy shape — no history, no sources possible).
  const levels = { ...awareness }
  const provenance = {}
  for (const obs of Object.keys(levels)) provenance[obs] = { via: 'direct' }
  return { levels, provenance }
}

/**
 * Apply the awareness's OWN chain history to the wrapper's entries +
 * sources, returning the post-history wrapper shape `{ entries, sources }`.
 *
 * Awareness has its own chain history independent of the host's chain.
 * The history list is walked in story order (`ctx.storyOrder.orderedIds`)
 * up to `ctx.anchorNodeId`; each entry mutates entries (direct-entry
 * mutations) or sources (source mutations). When `ctx.storyOrder` isn't
 * supplied, history walking is skipped and the wrapper is returned with
 * entries/sources unchanged.
 *
 * Used by `resolveAwarenessField` (which then resolves sources to a flat
 * dict) and by `finaliseAwarenessShapes` (which keeps the wrapper shape
 * for editor surfaces that need to round-trip projection sources via
 * `awareness_raw`).
 */
export function applyAwarenessHistoryToWrapper(awareness, ctx) {
  // Defensive: filter out reserved wrapper keys ('entries' / 'sources'
  // / 'history') when initialising entries from a legacy flat-dict
  // baseline that may have picked up a stray wrapper key from a
  // partial migration. Without this guard, a stray `history` key on
  // the baseline would propagate as if it were an observer's
  // awareness level. See `awarenessCommit.js#_AWARENESS_RESERVED_WRAPPER_KEYS`
  // for the source-of-truth list. Mirrored here so callers using the
  // chain walker directly (without going through diffAwarenessDict)
  // also get the cleanup.
  let entries = isAwarenessWrapper(awareness) ? { ...(awareness.entries || {}) } : {}
  for (const k of Object.keys(entries)) {
    if (k === 'entries' || k === 'sources' || k === 'history') delete entries[k]
  }
  let sources = isAwarenessWrapper(awareness) ? (awareness.sources || []).map((s) => ({ ...s })) : []
  // Tracking state walks alongside entries / sources. Initial (origin)
  // state: tracking is ON iff the host has an established baseline.
  // For a wrapper this means the `entries` KEY is present (even with
  // value `{}` — that's the wrapped form of the flat-dict `{}` that
  // origin toggle-ON produces when no observers have been added yet)
  // OR the `sources` array is non-empty. A wrapper that exists ONLY
  // as a container for chain `history` (no `entries` key, no
  // `sources`) does NOT imply tracking-on at origin — that shape is
  // produced when the first awareness write is a chain-time
  // `tracking_action: 'on'` at a downstream scene with no baseline
  // ever established. For a flat-dict baseline, the dict's mere
  // existence (even when empty) means tracking-on. Chain
  // `tracking_action: 'on' | 'off'` events flip tracking forward
  // from their node_id. Final state determines whether the resolver
  // returns null (off) or the resolved data (on).
  let tracking = false
  if (awareness != null) {
    if (isAwarenessWrapper(awareness)) {
      const hasBaselineEntriesKey = Object.prototype.hasOwnProperty.call(awareness, 'entries') && awareness.entries != null
      const hasBaselineSources = Array.isArray(awareness.sources) && awareness.sources.length > 0
      tracking = hasBaselineEntriesKey || hasBaselineSources
    } else {
      tracking = true  // flat-dict baseline — tracking on at origin
    }
  }
  if (!isAwarenessWrapper(awareness)) {
    return { entries, sources, tracking }
  }

  const history = Array.isArray(awareness.history) ? awareness.history : null
  if (history && history.length > 0 && ctx?.storyOrder && Array.isArray(ctx.storyOrder.orderedIds || ctx.storyOrder)) {
    const orderedIds = ctx.storyOrder.orderedIds || ctx.storyOrder
    const orderIndex = new Map(orderedIds.map((id, i) => [id, i]))
    const anchorId = ctx.anchorNodeId
    const anchorIdx = anchorId && orderIndex.has(anchorId) ? orderIndex.get(anchorId) : Infinity
    // History entries with `node_id == null` are BASELINE writes: the
    // commit pipeline (`commitAwarenessBatchAtAnchor`) calls
    // `buildAwarenessHistoryEntriesFromDeltas(deltas, anchor.nodeId)`
    // for both origin AND chain anchors; on the origin path,
    // `anchor.nodeId === null` and the history event records the
    // baseline mutation as a null-node_id entry. The walker MUST
    // apply those unconditionally (BEFORE any anchored events), or
    // origin awareness writes silently disappear on read — observer
    // pins land in history that the read never sees, sources never
    // appear in `walked.sources`, and `awareness.provenance` comes
    // back empty. Surfaced 2026-05-18 by the freeform v8 blind-agent
    // test as "awareness.provenance empty when projection sources
    // exist" — but the bug applies to ALL origin-anchor awareness
    // writes, not just sources. Sort baseline-events first (-Infinity
    // < any orderIndex), then anchored events in story order.
    const inOrder = history
      .filter((h) => {
        if (!h) return false
        if (h.node_id == null) return true   // baseline write — always apply
        if (!orderIndex.has(h.node_id)) return false
        return orderIndex.get(h.node_id) <= anchorIdx
      })
      .sort((a, b) => {
        const ai = a.node_id == null ? -Infinity : orderIndex.get(a.node_id)
        const bi = b.node_id == null ? -Infinity : orderIndex.get(b.node_id)
        return ai - bi
      })
    for (const h of inOrder) {
      if (h.tracking_action === 'on') {
        tracking = true
      } else if (h.tracking_action === 'off') {
        tracking = false
      } else if (h.source_action) {
        const next = applySourceChange({ entries, sources }, h.source_action, h.source)
        if (next && typeof next === 'object' && !Array.isArray(next)) {
          entries = next.entries || {}
          sources = next.sources || []
        } else if (next == null) {
          entries = {}
          sources = []
        }
      } else if (h.observer_id) {
        if (h.level == null) delete entries[h.observer_id]
        else entries[h.observer_id] = h.level
      }
    }
  }

  return { entries, sources, tracking }
}

// Resolve a Source's membership (list of entity ids) at the chain
// anchor in `ctx`. Branches by kind. Returns an empty array when the
// source can't be resolved (missing context, missing referent, etc.) —
// callers treat this as "no contributing members".
function resolveSourceMembership(source, ctx) {
  if (!source || !ctx) return []
  if (source.kind === 'relationship') {
    return resolveRelationshipMembership(source.relationship_id, ctx)
  }
  if (source.kind === 'attribute') {
    return resolveAttributeListMembership(source.entity_id, source.attribute_id, ctx)
  }
  return []
}

function resolveRelationshipMembership(relationshipId, ctx) {
  if (!relationshipId || !ctx?.allRelationships) return []
  const rel = ctx.allRelationships.find((r) => r.id === relationshipId)
  if (!rel) return []
  // Build a relationship-scoped nodeOrder when one isn't supplied. The
  // observer-side caller (origin baseline emission) threads its own
  // entity chain into ctx.nodeOrder, but that chain doesn't position
  // the rel's join / leave events. Without a proper rel-scoped
  // ordering, computeRelationshipEffectiveState's `shouldApply` falls
  // back to "true" for every participant_change whose node_id isn't
  // in the order map, which makes the rel look active for the
  // observer at chain positions upstream of their actual join scene.
  let nodeOrder = ctx.nodeOrder
  if (!nodeOrder || nodeOrder.length === 0) {
    nodeOrder = getRelationshipNodeOrder(rel, ctx.nodes || [], ctx.edges || [], ctx.storyOrder)
  }
  const eff = computeRelationshipEffectiveState(rel, nodeOrder, ctx.anchorNodeId || null)
  const participants = eff?.participants || []
  return participants.map((p) => (typeof p === 'string' ? p : p?.entity_id)).filter(Boolean)
}

/**
 * Observer-side awareness resolution — given an awareness wrapper on
 * a target (entity / attribute / alias / relationship / knowledge) at
 * the current chain anchor, return the level at which
 * `observerEntityId` is aware of that target.
 *
 * The target's storage is single-entry per source: a relationship
 * source is ONE row in `wrapper.sources` (not N rows per
 * participant); a faction entry is ONE row in `wrapper.entries`
 * keyed by the faction's entity id (not N rows per member). The
 * inheritance walk happens here at read time so participants /
 * members don't pollute the target's display.
 *
 * Priority — DIRECT wins, then the MAX of inherited candidates:
 *
 *   1. DIRECT: `entries[observerEntityId]` returns immediately.
 *      Writer-set per-observer levels override every inherited path.
 *
 *   2. INHERITED via FACTION ENTRY: for each direct entry whose key
 *      is a FACTION entity F, look up F's specific membership
 *      relationship (`rel.membership_of === F.id` — NOT every
 *      relationship F participates in, only the dedicated membership
 *      relationship). If the observer is a participant in that
 *      membership relationship at the anchor, they inherit
 *      `entries[F]`.
 *
 *   3. INHERITED via RELATIONSHIP SOURCE: for each `{kind:
 *      'relationship'}` source, if the observer is a participant in
 *      that relationship at the anchor → inherit the source's level.
 *
 *   4. INHERITED via ATTRIBUTE SOURCE: for each `{kind: 'attribute'}`
 *      source, if the observer appears in the entity_list attribute's
 *      value at the anchor → inherit the source's level.
 *
 * `ctx` must carry `allEntities`, `allRelationships`, `nodes`,
 * `edges`, `storyOrder`, `anchorNodeId`. Missing context returns
 * null (cannot resolve).
 *
 * Returns the resolved level or null.
 */
export function resolveObserverAwarenessLevel(wrapper, observerEntityId, ctx) {
  if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)) return null
  if (!observerEntityId) return null

  const entries = _entriesOf(wrapper)
  const sources = _sourcesOf(wrapper)

  // Rule 1 — direct entry wins.
  if (observerEntityId in entries) {
    const v = entries[observerEntityId]
    return typeof v === 'number' ? v : null
  }

  // Among inherited candidates, take the max. Tracks the best
  // candidate found across rules 2-4 so a faction entry at level 3
  // beats a relationship source at level 1 even when both apply.
  let inherited = null
  const consider = (candidate) => {
    if (typeof candidate !== 'number') return
    if (inherited === null || candidate > inherited) inherited = candidate
  }

  const allEntities = Array.isArray(ctx?.allEntities) ? ctx.allEntities : null
  const allRelationships = Array.isArray(ctx?.allRelationships) ? ctx.allRelationships : null

  // Rule 2 — faction direct-entry cascade.
  if (allEntities && allRelationships) {
    for (const [maybeFactionId, level] of Object.entries(entries)) {
      if (typeof level !== 'number') continue
      const ent = allEntities.find((e) => e && e.id === maybeFactionId)
      if (!ent || ent.type !== 'faction') continue
      // The faction's SPECIFIC membership relationship — not every
      // relationship F is in, only the dedicated one with
      // `membership_of === F.id`. Each faction has at most one.
      const membershipRel = allRelationships.find((r) => r && r.membership_of === ent.id)
      if (!membershipRel) continue
      if (_observerIsParticipantInRelationship(observerEntityId, membershipRel, ctx)) {
        consider(level)
      }
    }
  }

  // Rule 3 — relationship sources.
  if (allRelationships) {
    for (const src of sources) {
      if (!src || src.kind !== 'relationship' || typeof src.level !== 'number') continue
      const rel = allRelationships.find((r) => r && r.id === src.relationship_id)
      if (!rel) continue
      if (_observerIsParticipantInRelationship(observerEntityId, rel, ctx)) {
        consider(src.level)
      }
    }
  }

  // Rule 4 — attribute-source (entity_list) membership.
  for (const src of sources) {
    if (!src || src.kind !== 'attribute' || typeof src.level !== 'number') continue
    const memberIds = resolveAttributeListMembership(src.entity_id, src.attribute_id, ctx)
    if (memberIds.includes(observerEntityId)) consider(src.level)
  }

  return inherited
}


function _entriesOf(wrapper) {
  if (!wrapper || typeof wrapper !== 'object') return {}
  if ('entries' in wrapper) return wrapper.entries || {}
  if ('sources' in wrapper || 'history' in wrapper) return {}
  return wrapper  // flat-dict baseline form
}


function _sourcesOf(wrapper) {
  if (!wrapper || typeof wrapper !== 'object') return []
  return Array.isArray(wrapper.sources) ? wrapper.sources : []
}


function _observerIsParticipantInRelationship(observerEntityId, rel, ctx) {
  if (!rel || !observerEntityId || !ctx) return false
  let nodeOrder = ctx.nodeOrder
  if (!nodeOrder || nodeOrder.length === 0) {
    nodeOrder = getRelationshipNodeOrder(rel, ctx.nodes || [], ctx.edges || [], ctx.storyOrder)
  }
  const eff = computeRelationshipEffectiveState(rel, nodeOrder, ctx.anchorNodeId || null)
  const participants = eff?.participants || []
  for (const p of participants) {
    const pid = typeof p === 'string' ? p : (p && p.entity_id)
    if (pid === observerEntityId) return true
  }
  return false
}


function resolveAttributeListMembership(entityId, attributeId, ctx) {
  if (!entityId || !attributeId || !ctx?.allEntities) return []
  const ent = ctx.allEntities.find((e) => e.id === entityId)
  if (!ent) return []
  // Chain-resolve the carrier entity to get the attribute's value at
  // the anchor (chain-time `attribute_changes` for value mutations are
  // applied by `computeEffectiveState`). The recursion is bounded —
  // resolving an attribute's VALUE never reads any awareness field, so
  // there's no cycle even if the carrier entity has its own awareness
  // referencing the same source.
  const eff = computeEffectiveState(ent, ctx.nodes || [], ctx.edges || [], ctx.anchorNodeId || null)
  const attr = (eff?.attributes || []).find((a) => a.id === attributeId)
  if (!attr || attr.attribute_type !== 'entity_list') return []
  try {
    const parsed = JSON.parse(attr.value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

/**
 * Phase 1.21g — apply a chain-time source mutation
 * (add / remove / set_level) to a wrapper-or-flat awareness field.
 *   - Wrapper input: mutate `.sources` list, leave `.entries` untouched.
 *   - Flat dict input: promote to wrapper { entries: <flat>, sources: [...] }
 *     so source mutations always survive a round trip even when base
 *     was a flat dict.
 *   - null input: same promotion path with empty entries.
 *   - AwarenessRef (legacy single-source): returned unchanged.
 *
 * Source identity is `(kind, relationship_id)` for relationship sources
 * and `(kind, entity_id, attribute_id)` for attribute-list sources.
 */
function applySourceChange(current, source_action, source) {
  if (!source || isAwarenessRef(current)) return current
  let entries = {}
  let sources = []
  if (isAwarenessWrapper(current)) {
    entries = { ...(current.entries || {}) }
    sources = Array.isArray(current.sources) ? [...current.sources] : []
  } else if (current && typeof current === 'object' && !Array.isArray(current)) {
    entries = { ...current }
  }
  const matches = (a, b) => {
    if (!a || !b || a.kind !== b.kind) return false
    if (a.kind === 'relationship') return a.relationship_id === b.relationship_id
    if (a.kind === 'attribute')    return a.entity_id === b.entity_id && a.attribute_id === b.attribute_id
    return false
  }
  if (source_action === 'add') {
    const idx = sources.findIndex((s) => matches(s, source))
    if (idx === -1) sources.push({ ...source })
    else            sources[idx] = { ...source }
  } else if (source_action === 'remove') {
    sources = sources.filter((s) => !matches(s, source))
  } else if (source_action === 'set_level') {
    const idx = sources.findIndex((s) => matches(s, source))
    if (idx >= 0) sources[idx] = { ...sources[idx], level: source.level }
  }
  const hasEntries = Object.keys(entries).length > 0
  const hasSources = sources.length > 0
  if (!hasEntries && !hasSources) return null
  return { entries, sources }
}

/**
 * Phase 1.21g — set / clear a single observer's level on a wrapper /
 * flat-dict awareness field, preserving shape:
 *   - Wrapper input: mutates `.entries`, leaves `.sources` untouched.
 *     Collapses to `null` only when BOTH entries and sources are empty.
 *   - Flat dict input: mutates the dict; collapses to `null` when empty.
 *   - AwarenessRef (legacy single-source) input: returned unchanged.
 *   - null input: a `set` starts a fresh flat dict; a `clear` stays null.
 */
function applyEntriesChange(current, observerId, level) {
  if (isAwarenessRef(current)) return current
  if (isAwarenessWrapper(current)) {
    const entries = { ...(current.entries || {}) }
    if (level == null) delete entries[observerId]
    else entries[observerId] = level
    const newWrapper = { ...current, entries }
    const hasEntries = Object.keys(entries).length > 0
    const hasSources = Array.isArray(newWrapper.sources) && newWrapper.sources.length > 0
    return (hasEntries || hasSources) ? newWrapper : null
  }
  const dict = (current && typeof current === 'object' && !Array.isArray(current)) ? { ...current } : {}
  if (level == null) delete dict[observerId]
  else dict[observerId] = level
  return Object.keys(dict).length > 0 ? dict : null
}

/**
 * Apply a single list_add or list_remove op to a list attribute, returning a new attribute
 * object with the updated JSON-encoded value. No-ops gracefully if the attribute isn't a
 * list type, if the parsed value isn't an array, or if the item is missing. list_add is
 * idempotent — duplicate adds are collapsed so effective state stays deterministic even
 * if the UI somehow writes two adds for the same item at different chain positions.
 */
function applyListOp(attr, action, item) {
  if (!attr || (attr.attribute_type !== 'text_list' && attr.attribute_type !== 'entity_list')) return attr
  if (item == null) return attr
  const list = parseListValue(attr.value)
  let next = list
  if (action === 'list_add') {
    if (!list.includes(item)) next = [...list, item]
  } else if (action === 'list_remove') {
    next = list.filter((x) => x !== item)
  } else {
    return attr
  }
  return { ...attr, value: JSON.stringify(next) }
}

/**
 * Walk the connection graph from an entity node forward and return the ordered
 * list of chain stops. The origin entity node is always chain[0]; subsequent
 * stops are sceneNodes and modifier entityNodes that carry this entity.
 *
 * ⚠ PARITY REQUIREMENT — KEEP IN LOCKSTEP WITH BACKEND ⚠
 * This function has a parallel Python implementation at
 * `backend/services/narrative_chain.py#get_entity_narrative_chain`. The two
 * are NOT a shared module — they're separate codebases (JS in the browser,
 * Python in FastAPI) that MUST produce identical chain ordering for the
 * same `(entity, story)` pair, because backend walkers (entity import,
 * export, etc.) rely on producing the same effective state the frontend's
 * `computeEffectiveState` shows the user.
 *
 * If you change the chain-walk rules here (edge-priority preference,
 * scene/modifier inclusion criteria, cycle handling, etc.), update the
 * Python port in the SAME commit. Drift between the two is a chain-of-
 * history correctness bug — silent data divergence between what the
 * user sees in the UI and what the backend exports / imports.
 */
/** Find the id of the prior chain stop for a given anchor — i.e. the
 *  scene immediately upstream on this entity's continuity chain.
 *  Walks the single incoming entity-continuity wire from the anchor
 *  (filtered by `source_entity_id` set + not `is_pov_path` + not
 *  `is_relationship`). Returns:
 *    - sceneNode id when the predecessor is another sceneNode
 *      (either the main forward chain's prior stop OR a sub-chain's
 *      prior stop — the topology is identical for both),
 *    - null when there's no incoming continuity wire OR the wire's
 *      source is the entity's origin EntityNode (in which case
 *      "prior" is baseline; let callers fall back to entity.* fields).
 *
 *  Use this for "prior state" lookups (diff sub-chips, inherited-
 *  value displays, etc.) — works uniformly for main-chain AND sub-
 *  chain anchors, where the old `chain[idx-1]` pattern returned
 *  baseline for the latter. Surfaced 2026-05-18 by the user: sub-
 *  chain attribute inheritance was broken in the Entity Detail panel
 *  because priorEffectiveState fell back to baseline for sub-chain
 *  anchors. */
export function getPriorChainNodeIdForAnchor(entityId, nodes, edges, anchorNodeId) {
  if (!anchorNodeId) return null
  const inEdge = edges.find((e) =>
    e.target === anchorNodeId
    && e.data?.source_entity_id === entityId
    && !e.data?.is_pov_path
    && !e.data?.is_relationship
  )
  if (!inEdge) return null
  const src = nodes.find((n) => n.id === inEdge.source)
  if (!src) return null
  if (src.type === 'entityNode') return null  // origin → baseline is prior
  if (src.type === 'sceneNode') return src.id
  return null
}


/**
 * Build (and cache locally) the three id-keyed lookup maps used by
 * `getEntityNarrativeChain` when callers don't pre-build their own.
 *
 *   - `nodesById`              : Map<nodeId, Node>           — node-by-id
 *   - `edgesBySource`          : Map<sourceId, Edge[]>       — edges-from-a-node
 *   - `entityNodesByEntityId`  : Map<entityId, EntityNode>   — entity origin lookup
 *
 * Hot-path callers (`computeStoryOrder`, `computeEffectiveState`,
 * `getRelationshipNodeOrder`) should build these ONCE at outer scope
 * and pass the same three maps to every chain walk inside, so the
 * build cost is amortised across all calls. One-shot callers can let
 * `getEntityNarrativeChain` build them locally — the build is still
 * a single linear pass that pays for itself across multiple steps of
 * even one chain walk.
 */
function _buildChainLookupMaps(nodes, edges) {
  const nodesById = new Map()
  const entityNodesByEntityId = new Map()
  for (const n of (nodes || [])) {
    if (!n?.id) continue
    nodesById.set(n.id, n)
    if (n.type === 'entityNode' && n.data?.entity_id) {
      // Origin nodes only. Modifier entity nodes share an entity_id with
      // their origin, but we want the ORIGIN as chain[0]; first-write
      // wins because origin nodes are encountered before modifiers in
      // a well-formed canvas, but be explicit so we never overwrite.
      if (!entityNodesByEntityId.has(n.data.entity_id)) {
        entityNodesByEntityId.set(n.data.entity_id, n)
      } else if (!n.data?.is_modifier) {
        // If we previously stored a modifier (shouldn't happen on
        // well-formed data, but be safe), let the origin take its
        // canonical slot.
        entityNodesByEntityId.set(n.data.entity_id, n)
      }
    }
  }
  const edgesBySource = new Map()
  for (const e of (edges || [])) {
    if (!e?.source) continue
    const list = edgesBySource.get(e.source)
    if (list) list.push(e)
    else edgesBySource.set(e.source, [e])
  }
  return { nodesById, edgesBySource, entityNodesByEntityId }
}

export function getEntityNarrativeChain(entityId, nodes, edges, lookupMaps = null) {
  // F#8: three id-keyed Maps replace 78.6% of this function's prior
  // child cost (`Array.prototype.find` on every chain step). When the
  // caller provides them (hot-path callers like `computeStoryOrder`
  // build once and pass through), we skip the local build entirely.
  const { nodesById, edgesBySource, entityNodesByEntityId } = lookupMaps || _buildChainLookupMaps(nodes, edges)

  const entityNode = entityNodesByEntityId.get(entityId)
    || nodes.find((n) => n.type === 'entityNode' && n.data?.entity_id === entityId)
    || null
  if (!entityNode) return []

  const chain = [entityNode]  // origin entity node is always chain[0]
  let currentId = entityNode.id
  const visited = new Set()

  while (currentId) {
    if (visited.has(currentId)) break
    visited.add(currentId)

    const currentNode = nodesById.get(currentId)
    const outFromCurrent = edgesBySource.get(currentId) || []
    // For entity nodes: prefer narrative-flow edges; fall back to relationship edge only if
    // no flow edge exists (entity introduced into narrative solely via a Case 2 wire).
    // For plot point nodes: never follow relationship edges as narrative steps — only follow
    // edges that carry this entity's chip output handle (narrative flow only).
    let outEdge
    if (currentNode?.type === 'entityNode') {
      outEdge = outFromCurrent.find((e) => !e.data?.is_relationship)
             || outFromCurrent.find((e) =>  e.data?.is_relationship)
    } else {
      // Plot point node: follow only narrative flow edges from this entity's chip.
      // Relationship wires (is_relationship) are never chain links — the auto-flow wire
      // created alongside every chip-to-chip relationship wire is the correct chain link.
      outEdge = outFromCurrent.find((e) => e.sourceHandle === entityId && !e.data?.is_relationship)
    }

    if (!outEdge) break

    const nextNode = nodesById.get(outEdge.target)
    if (!nextNode) break

    if (nextNode.type === 'sceneNode') {
      if (ENTITY_BUCKETS.some((b) => (nextNode.data[b] || []).some((r) => r.entity_id === entityId))) {
        chain.push(nextNode)
      }
      currentId = nextNode.id
    } else if (nextNode.type === 'entityNode' && nextNode.data?.entity_id === entityId) {
      chain.push(nextNode)
      currentId = nextNode.id
    } else {
      break
    }
  }

  return chain
}

/**
 * Public export of the lookup-map builder for hot-path callers that
 * invoke `getEntityNarrativeChain` many times per outer call. See
 * `_buildChainLookupMaps` for shape details.
 */
export function buildChainLookupMaps(nodes, edges) {
  return _buildChainLookupMaps(nodes, edges)
}

/**
 * Build an ordered list of node IDs that matters to a relationship's chain.
 * Use this instead of x-sorting nodes to build a `nodeOrder` for
 * `computeRelationshipEffectiveState`. Chain order MUST come from the global
 * story order (or, in fallback, the connection graph), never from canvas
 * x-position — a user dragging nodes should never silently reorder
 * narrative state.
 *
 * The relevant set is:
 *   - the relationship's origin node (if one exists)
 *   - every node referenced by any entry in `relationship.history`
 *   - every node in every current participant's narrative chain
 *     (so ambient-chip evaluation at scenes downstream of a participant's
 *     entry point works correctly)
 *
 * Ordering:
 *   - When `storyOrder` (result of `computeStoryOrder` / `useStoryOrder`) is
 *     provided, the function is a pure filter over `storyOrder.orderedIds`.
 *     This is the preferred path: the global story order already places
 *     every chain-participating node via the 12-tier priority stack, so
 *     manually-anchored scenes land at their deterministic global position
 *     without any per-relationship neighbour-pull tethering.
 *   - When `storyOrder` is omitted, falls back to the legacy per-
 *     relationship Kahn's topological sort over the induced narrative-flow
 *     subgraph. Retained for call sites that don't yet have access to a
 *     `storyOrder` result (e.g. non-React-hook call sites in projectStore
 *     actions). To be removed once every caller migrates.
 *
 * @param {Object}   relationship  - the Relationship object
 * @param {Object[]} nodes         - all React Flow nodes
 * @param {Object[]} edges         - all React Flow edges
 * @param {Object}   [storyOrder]  - optional global story order result
 *                                   `{ orderedIds: string[], ... }`; when
 *                                   provided, the sort becomes a filter over
 *                                   `orderedIds`.
 * @returns {string[]} ordered array of node IDs relevant to this relationship
 */
export function getRelationshipNodeOrder(relationship, nodes, edges, storyOrder) {
  if (!relationship) return []

  // 1. Collect every node relevant to this relationship's timeline.
  const relevantIds = new Set()

  // Relationship origin node
  const originNode = nodes.find(
    (n) => n.type === 'relationshipOriginNode' && n.data?.relationship_id === relationship.id
  )
  if (originNode) relevantIds.add(originNode.id)

  // Every history-event node
  const history = relationship.history || {}
  for (const list of Object.values(history)) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (entry?.node_id) relevantIds.add(entry.node_id)
    }
  }

  // Every current participant's narrative chain (so ambient-chip evaluation
  // at downstream scenes has the right order context)
  const participantIds = new Set(
    (history.participant_changes || [])
      .filter((c) => c.action === 'join')
      .map((c) => c.entity_id)
  )
  for (const eid of participantIds) {
    const chain = getEntityNarrativeChain(eid, nodes, edges)
    for (const node of chain) relevantIds.add(node.id)
  }

  if (relevantIds.size === 0) return []

  // 2a. Preferred path: filter over the global story order. The global order
  //     already positions every chain-participating node, including manually-
  //     anchored scenes, via the 12-tier priority stack — no per-relationship
  //     topological sort required.
  if (storyOrder && Array.isArray(storyOrder.orderedIds)) {
    const ordered = storyOrder.orderedIds.filter((id) => relevantIds.has(id))
    // Append any relevant ids that the global order doesn't place (non-chain-
    // participating types etc.) so the returned array still contains the full
    // relevant set.
    if (ordered.length < relevantIds.size) {
      const seen = new Set(ordered)
      for (const id of relevantIds) {
        if (!seen.has(id)) ordered.push(id)
      }
    }
    return ordered
  }

  // 2b. Fallback: topologically sort the induced sub-graph using narrative-
  //     flow edges only. Relationship wires and POV wires aren't narrative
  //     flow.
  const adj = new Map()
  const inDegree = new Map()
  for (const id of relevantIds) {
    adj.set(id, new Set())
    inDegree.set(id, 0)
  }
  for (const edge of edges) {
    if (edge.data?.is_relationship) continue
    if (edge.data?.is_pov_path) continue
    const { source, target } = edge
    if (!relevantIds.has(source) || !relevantIds.has(target)) continue
    const outSet = adj.get(source)
    if (!outSet.has(target)) {
      outSet.add(target)
      inDegree.set(target, inDegree.get(target) + 1)
    }
  }

  // Kahn's algorithm. Queue picks up in-degree-0 nodes; we use relevantIds
  // iteration order as the tie-breaker for deterministic output when
  // multiple siblings are eligible simultaneously.
  const queue = []
  for (const id of relevantIds) {
    if (inDegree.get(id) === 0) queue.push(id)
  }
  const ordered = []
  while (queue.length > 0) {
    const id = queue.shift()
    ordered.push(id)
    for (const next of adj.get(id) || []) {
      const deg = inDegree.get(next) - 1
      inDegree.set(next, deg)
      if (deg === 0) queue.push(next)
    }
  }

  // Any remaining (cycle / unreachable) — append at the end so they're still
  // included in the returned array.
  for (const id of relevantIds) {
    if (!ordered.includes(id)) ordered.push(id)
  }

  return ordered
}

/**
 * Extract the change set from either an origin entityNode (where changes
 * live directly on `node.data`) or a plot-point-scene EntityRef (where
 * changes live on the matching bucket entry). Returns null when no ref
 * exists on a plot point node (chip absent).
 */
function extractChangeSet(node, entity) {
  if (node.type === 'entityNode') {
    return {
      _node_id:             node.id,
      name_change:          node.data.name_change,
      colour_change:        node.data.colour_change,
      description_change:   node.data.description_change,
      profile_image_change: node.data.profile_image_change,
      alias_changes:        node.data.alias_changes || [],
      attribute_changes:    node.data.attribute_changes || [],
      tag_changes:          node.data.tag_changes || [],
    }
  }
  for (const b of ENTITY_BUCKETS) {
    const found = (node.data[b] || []).find((r) => r.entity_id === entity.id)
    if (found) {
      return {
        _node_id:             node.id,
        name_change:          found.name_change,
        colour_change:        found.colour_change,
        description_change:   found.description_change,
        profile_image_change: found.profile_image_change,
        alias_changes:        found.alias_changes || [],
        attribute_changes:    found.attribute_changes || [],
        tag_changes:          found.tag_changes || [],
      }
    }
  }
  return null
}

/**
 * Fold one chain stop's change set into `state`. Shared between the
 * main chain walker and the orphaned-chip path so both apply changes
 * identically. Scalar fields and attribute CRUD only — awareness is
 * second-class with its own host-attached chain (`host.awareness.history`)
 * walked by `applyAwarenessHistoryToWrapper` / `resolveAwarenessField` in
 * the finaliser pass.
 */
// eslint-disable-next-line no-unused-vars
function applyChangeSet(state, changes, awarenessCtx = null) {
  const {
    name_change, colour_change, description_change, profile_image_change,
    alias_changes, attribute_changes, tag_changes,
    _node_id: changeNodeId,
  } = changes

  if (name_change          != null) state.name              = name_change
  if (colour_change        != null) state.colour            = colour_change
  if (description_change   != null) state.description       = description_change
  if (profile_image_change != null) state.profile_image_ref = profile_image_change || null

  // Aliases — per-alias chain events on `alias_changes` are the
  // canonical shape (post v0.2.1.76 refactor). The walker applies
  // events additively (add → push if not already present by id;
  // remove → filter by id; modify → patch the matching id;
  // awareness_set / awareness_source_* → mutate the matching alias's
  // `awareness` via the same direct-mutation helpers used for entity
  // / attribute awareness — applyEntriesChange for `awareness_set`,
  // applySourceChange for `awareness_source_*`).
  //
  // ⚠ PARITY REQUIREMENT — KEEP THIS DISPATCHER IN LOCKSTEP WITH BACKEND ⚠
  // The matching Python walker dispatcher lives in
  // `backend/services/entity_import_service.py#_apply_scene_to_walked`
  // (and `_apply_modifier_to_walked`). Same action set, same target
  // resolution by `alias_id`, same direct-mutation against the alias's
  // awareness wrapper. If you add an action, change a payload, or
  // change the apply order here, update the Python walker in the SAME
  // commit. See `getEntityNarrativeChain` / `get_entity_narrative_chain`
  // for the broader parity rationale.
  if (Array.isArray(alias_changes) && alias_changes.length > 0) {
    for (const ev of alias_changes) {
      if (!ev || typeof ev !== 'object') continue
      if (ev.action === 'add') {
        const incoming = ev.alias
        if (!incoming || !incoming.id) continue
        if (state.aliases.some((a) => a.id === incoming.id)) continue
        // Keep awareness in wrapper-or-flat shape during the walk so
        // downstream `awareness_set` / `awareness_source_*` events on
        // this same alias can mutate it. The finaliser pass collapses
        // to resolved + raw at end of walk; no need to pre-resolve here.
        state.aliases = [...state.aliases, {
          ...incoming,
          awareness: cloneAwareness(incoming.awareness),
        }]
      } else if (ev.action === 'remove') {
        if (!ev.alias_id) continue
        state.aliases = state.aliases.filter((a) => a.id !== ev.alias_id)
      } else if (ev.action === 'modify') {
        if (!ev.alias_id || ev.new_value == null) continue
        state.aliases = state.aliases.map((a) =>
          a.id === ev.alias_id ? { ...a, value: ev.new_value } : a
        )
      } else if (ev.action === 'awareness_set') {
        if (!ev.alias_id || !ev.observer_id) continue
        const idx = state.aliases.findIndex((a) => a.id === ev.alias_id)
        if (idx < 0) continue
        const target = state.aliases[idx]
        const updated = applyEntriesChange(target.awareness, ev.observer_id, ev.level)
        state.aliases = state.aliases.map((a, i) =>
          i === idx ? { ...a, awareness: updated } : a
        )
      } else if (
        ev.action === 'awareness_source_add' ||
        ev.action === 'awareness_source_remove' ||
        ev.action === 'awareness_source_set_level'
      ) {
        if (!ev.alias_id || !ev.source) continue
        const idx = state.aliases.findIndex((a) => a.id === ev.alias_id)
        if (idx < 0) continue
        const sourceActionMap = {
          awareness_source_add: 'add',
          awareness_source_remove: 'remove',
          awareness_source_set_level: 'set_level',
        }
        const target = state.aliases[idx]
        const updated = applySourceChange(target.awareness, sourceActionMap[ev.action], ev.source)
        state.aliases = state.aliases.map((a, i) =>
          i === idx ? { ...a, awareness: updated } : a
        )
      }
    }
  }

  // Project Tag membership — chain events on `tag_changes` apply
  // additively (add / remove), with provenance tracked on each
  // effective_tag entry so the UI can distinguish baseline vs chain-
  // added tags. No awareness pass (tags are metadata not story data).
  // Same-node opposite-pair cancellation is enforced at WRITE time
  // in the store action (a `[add@N, remove@N]` pair for the same
  // tag_id strips both entries), so the walker never sees same-node
  // pairs — it just applies events in chain order.
  if (Array.isArray(tag_changes) && tag_changes.length > 0) {
    for (const ev of tag_changes) {
      if (!ev || typeof ev !== 'object' || !ev.tag_id) continue
      if (ev.action === 'add') {
        if (state.tag_ids.includes(ev.tag_id)) continue
        state.tag_ids = [...state.tag_ids, ev.tag_id]
        state.effective_tags = [...state.effective_tags, {
          tag_id: ev.tag_id,
          source: 'chain',
          added_at_node_id: changeNodeId || null,
        }]
      } else if (ev.action === 'remove') {
        if (!state.tag_ids.includes(ev.tag_id)) continue
        state.tag_ids = state.tag_ids.filter((id) => id !== ev.tag_id)
        state.effective_tags = state.effective_tags.filter((t) => t.tag_id !== ev.tag_id)
      }
    }
  }

  for (const ac of attribute_changes) {
    if (ac.action === 'modify') {
      const idx = state.attributes.findIndex((a) => a.id === ac.attribute_id)
      if (idx !== -1) {
        const existing = state.attributes[idx]
        const patch = { value: ac.new_value ?? existing.value }
        if (ac.file_ref_change != null) {
          patch.file_ref = ac.file_ref_change === '' ? null : ac.file_ref_change
        }
        // Number-typed attribute updates flow through `new_number_value`
        // on the modify entry. Without applying it here the chain walker
        // resolves to the origin number_value at every downstream scene
        // even though the chain entry recorded the change correctly —
        // a silent-no-op on the read side. Bug surfaced 2026-05-17b in
        // the blind-agent rom-com test (number_value 180 stayed 180 at
        // a scene that wrote 168). `hasOwnProperty` so explicit `null`
        // (clearing the number value) is distinguishable from "field
        // omitted" — same convention as `new_description` /
        // `new_intensity` below.
        if (Object.prototype.hasOwnProperty.call(ac, 'new_number_value')) {
          patch.number_value = ac.new_number_value
        }
        // Phase 1.22d — circumstance / motivator per-field modify
        // payload (Option A from Phase 1.22a). Each new_* field is
        // independently optional on the modify entry; only apply
        // those actually present on this entry. `hasOwnProperty` is
        // used (rather than `!= null`) for `new_intensity` and
        // `new_description` so explicit `null` (clearing intensity
        // back to unset, or clearing description) is distinguishable
        // from "field omitted".
        if (Object.prototype.hasOwnProperty.call(ac, 'new_name') && ac.new_name != null) {
          patch.name = ac.new_name
        }
        if (Object.prototype.hasOwnProperty.call(ac, 'new_description')) {
          patch.description = ac.new_description ?? ''
        }
        if (Object.prototype.hasOwnProperty.call(ac, 'new_intensity')) {
          patch.intensity = ac.new_intensity
        }
        // Phase 2.13b — perspective target rewire at a chain anchor.
        // Both fields are independently optional; null = explicit
        // orphan (matches the Phase 2.13a cascade contract's
        // null-target-keep-description shape). Field present but
        // omitted on the modify entry means "no change at this
        // anchor". `hasOwnProperty` so explicit null is
        // distinguishable from absence, same convention as
        // new_description / new_intensity above.
        if (Object.prototype.hasOwnProperty.call(ac, 'new_perspective_target_kind')) {
          patch.perspective_target_kind = ac.new_perspective_target_kind
        }
        if (Object.prototype.hasOwnProperty.call(ac, 'new_perspective_target_id')) {
          patch.perspective_target_id = ac.new_perspective_target_id
        }
        state.attributes[idx] = { ...existing, ...patch }
      }
    } else if (ac.action === 'add' && ac.attribute) {
      if (!state.attributes.some((a) => a.id === ac.attribute.id)) {
        state.attributes.push({ ...ac.attribute, awareness: cloneAwareness(ac.attribute.awareness) })
      }
    } else if (ac.action === 'remove') {
      state.attributes = state.attributes.filter((a) => a.id !== ac.attribute_id)
    } else if (ac.action === 'list_add' || ac.action === 'list_remove') {
      if (ac.cancelled) continue
      const idx = state.attributes.findIndex((a) => a.id === ac.attribute_id)
      if (idx !== -1) state.attributes[idx] = applyListOp(state.attributes[idx], ac.action, ac.list_item)
    } else if (ac.action === 'rename') {
      const idx = state.attributes.findIndex((a) => a.id === ac.attribute_id)
      if (idx !== -1 && ac.new_name != null) state.attributes[idx] = { ...state.attributes[idx], name: ac.new_name }
    }
  }

  return state
}


/**
 * Compute an entity's effective state by walking the chain up to (and including)
 * upToNodeId. Returns the baseline entity state if upToNodeId is null or not in chain.
 *
 * Phase 1.21g: optional `ctx` (5th argument) carries the data needed to
 * resolve projected awareness sources (relationship participants /
 * entity-list attribute entries). Shape:
 *   { allEntities, allRelationships }
 * When ctx is omitted (or its fields are missing), a flat-dict awareness
 * field still resolves cleanly; awareness wrappers with projected
 * sources get their projections resolved to empty memberships, which
 * matches the behaviour for any caller that hadn't opted in to
 * projection support.
 */
export function computeEffectiveState(entity, nodes, edges, upToNodeId, ctx = null) {
  const awarenessCtx = ctx ? { nodes, edges, anchorNodeId: upToNodeId, ...ctx } : { nodes, edges, anchorNodeId: upToNodeId }
  const state = {
    name:              entity.name || '',
    colour:            entity.colour || '#888888',
    description:       entity.description || '',
    profile_image_ref: entity.profile_image_ref || null,
    // Phase 1.21g — awareness fields are kept in their wrapper-or-flat
    // shape during the walk so chain-time entries mutations preserve any
    // projected sources that the base shape carries. A finalisation pass
    // before return collapses each surface to the resolved flat-dict
    // form on `awareness` (back-compat) and stores the wrapper-shape
    // version on `awareness_raw` (used by editor surfaces — picker
    // round-trip, source-chip display).
    aliases:           (entity.aliases || []).map((a) => ({
      ...a,
      awareness: cloneAwareness(a?.awareness),
    })),
    // Phase 3.4a — Project Tag membership. `tag_ids` holds the effective
    // tag-id set as a plain array (drives indexing / filter / search
    // call sites that just want "does this entity carry tag X?").
    // `effective_tags` carries provenance per tag — `{tag_id, source,
    // added_at_node_id?}` — driving the chain-origin badge variant in
    // the dialog UI. Both kept in sync: every tag_id in `tag_ids` has
    // exactly one entry in `effective_tags`. Tags carry no awareness,
    // so the awareness wrapper-or-flat pattern doesn't apply here.
    tag_ids:           [...(entity.tag_ids || [])],
    effective_tags:    (entity.tag_ids || []).map((tag_id) => ({
      tag_id,
      source: 'baseline',
    })),
    attributes:        (entity.attributes || []).map((a) => ({
      ...a,
      awareness: cloneAwareness(a?.awareness),
    })),
    awareness:         cloneAwareness(entity.awareness),
    name_awareness:    cloneAwareness(entity.name_awareness),
    // Per-entity awareness scale ('binary' | 'full'). Baseline-only; not
    // chain-tracked. Defaults to 'binary' when absent.
    awareness_scale:   entity.awareness_scale || 'binary',
  }

  const chain = getEntityNarrativeChain(entity.id, nodes, edges)

  if (upToNodeId && !chain.some((n) => n.id === upToNodeId)) {
    // The anchor scene isn't in the main forward-walked chain from
    // origin. Walk BACKWARD from the anchor along incoming entity-
    // continuity wires (this entity's `source_entity_id` set, not
    // POV / not relationship) to reconstruct any sub-chain leading
    // INTO the anchor. Apply each visited node's ref changes in
    // chain order (origin-most → anchor) on top of baseline.
    //
    // Without this, only the anchor's OWN ref changes get applied —
    // so a setup like `origin → orphan_1 (Gender=Female chain entry)
    // → orphan_2 (no changes)` would silently resolve `orphan_2` to
    // pure baseline, losing the Female change recorded one wire
    // back. Surfaced 2026-05-18 by the user during the orphan-
    // verification test.
    //
    // The forward walker (`getEntityNarrativeChain`) follows a SINGLE
    // branch from origin (first outgoing wire), so a disconnected
    // sub-chain branched off origin is invisible to it. The backward
    // walk here is contained: only fires on the orphan-resolution
    // path; main-chain semantics are unchanged.
    const subChain = []  // ordered origin-most → anchor
    const subVisited = new Set()
    let cursorId = upToNodeId
    while (cursorId && !subVisited.has(cursorId)) {
      subVisited.add(cursorId)
      const cur = nodes.find((n) => n.id === cursorId)
      if (!cur) break
      subChain.unshift(cur)  // prepend — building origin-most first
      // Find the incoming entity-continuity wire for this entity.
      // Soft-limit: at most one outgoing continuity wire per chip,
      // so incoming should also be at most one in well-formed data;
      // if there are multiple, take the first deterministically.
      const inEdge = edges.find((e) =>
        e.target === cursorId
        && e.data?.source_entity_id === entity.id
        && !e.data?.is_pov_path
        && !e.data?.is_relationship
      )
      if (!inEdge) break  // anchor (or sub-chain head) has no
                           // incoming chain wire — sub-chain ends
      // If the source is the entity's origin EntityNode, we've
      // reached the start of the sub-chain. Don't include the
      // origin in subChain — baseline is already in `state` from
      // the initialization above. Stop the walk.
      const srcNode = nodes.find((n) => n.id === inEdge.source)
      if (!srcNode) break
      if (srcNode.type === 'entityNode') break
      cursorId = inEdge.source
    }
    // Apply each sub-chain node's ref changes in chain order. This
    // mirrors the forward walker's loop — same `extractChangeSet` +
    // `applyChangeSet` pair so chain-time semantics are identical
    // between the two paths.
    for (const subNode of subChain) {
      const changes = extractChangeSet(subNode, entity)
      if (changes) applyChangeSet(state, changes, awarenessCtx)
    }
    finaliseAwarenessShapes(state, awarenessCtx)
    return state
  }

  for (const node of chain) {
    const changes = extractChangeSet(node, entity)
    if (!changes) {
      if (node.id === upToNodeId) break
      continue
    }
    applyChangeSet(state, changes, awarenessCtx)
    if (node.id === upToNodeId) break
  }

  finaliseAwarenessShapes(state, awarenessCtx)
  return state
}


/** Resolve an entity at a scene anchor AND its prior chain stop in
 *  one call — returns `{ current, prior }`. The canonical helper for
 *  any UI / read code that needs both views (chip rendering with diff
 *  sub-chips, detail panel attribute display, change-summary views,
 *  etc.) — replaces the previous pattern of every callsite re-running
 *  `getEntityNarrativeChain` + `chain[idx - 1]` + manual baseline
 *  fallback, which had two failure modes:
 *    (1) sub-chain anchors (chip wired off a non-main-chain branch
 *        from origin) silently dropped to baseline-as-prior because
 *        `chain.findIndex` returned -1; surfaced 2026-05-18 when
 *        sub-chain attribute inheritance was invisible in the Entity
 *        Detail Panel and on diff sub-chips,
 *    (2) per-file divergent baseline-shape literals as the prior
 *        fallback, easy to miss fields on (e.g. profile_image_ref,
 *        awareness, etc.) since each file maintained its own shape.
 *
 *  Both views are full chain-resolved state objects with the same
 *  shape `computeEffectiveState` returns. The "prior" anchor is
 *  resolved via:
 *    - Main forward chain (idx > 0): chain[idx - 1] (existing
 *      behaviour for ordinary chips on the POV chain).
 *    - Sub-chain (anchor not in main chain but has incoming entity-
 *      continuity wire): `getPriorChainNodeIdForAnchor` walks the
 *      wire and returns the predecessor sceneNode (fixes the sub-
 *      chain inheritance gap).
 *    - No prior (anchor IS chain head, or no incoming wire): use the
 *      entity's origin EntityNode as the prior anchor — feeding the
 *      origin into `computeEffectiveState` returns pure baseline,
 *      since the walker initialises from baseline and the origin
 *      EntityNode carries no chain entries.
 *
 *  Callers that only need prior can destructure `{ prior }`; the
 *  current walk runs anyway but the cost is the same chain length
 *  the caller would have computed itself for `effectiveState`. */
export function computeEffectiveStateWithPrior(entity, nodes, edges, anchorNodeId, ctx = null) {
  const current = computeEffectiveState(entity, nodes, edges, anchorNodeId, ctx)
  const chain = getEntityNarrativeChain(entity.id, nodes, edges)
  const idx = chain.findIndex((n) => n.id === anchorNodeId)
  let priorAnchorId = null
  if (idx > 0) {
    priorAnchorId = chain[idx - 1].id
  } else {
    const subChainPriorId = getPriorChainNodeIdForAnchor(entity.id, nodes, edges, anchorNodeId)
    if (subChainPriorId) {
      priorAnchorId = subChainPriorId
    } else if (chain.length > 0) {
      // Fall back to the entity's origin EntityNode (chain[0]). The
      // walker returns pure baseline when given the origin — its
      // own change record is empty for a fresh origin (origin
      // EntityNodes carry no chain entries; baseline lives on the
      // Entity object). This unifies the "no prior" case so every
      // caller gets the same baseline shape from one source instead
      // of constructing a per-file literal.
      priorAnchorId = chain[0].id
    }
  }
  const prior = priorAnchorId
    ? computeEffectiveState(entity, nodes, edges, priorAnchorId, ctx)
    : current  // defensive: entity has no origin EntityNode at all
                // (shouldn't happen for valid data, but a stale id
                // could trigger this — returning current is the
                // safest fallback since prior == current means
                // "no change happened here").
  return { current, prior }
}


/**
 * Phase 1.21g — final-pass resolution for awareness fields after the
 * walker has applied chain-time changes.
 *
 * During the walk every awareness surface (`state.awareness`,
 * `state.name_awareness`, `state.aliases[i].awareness`,
 * `state.attributes[i].awareness`) is kept in whatever shape its base
 * carried (wrapper or flat dict) so chain-time entries mutations can
 * preserve projected sources. This pass turns that internal shape
 * into the public state shape that downstream readers expect:
 *   - `awareness`      — resolved flat dict (or null) — back-compat.
 *   - `awareness_raw`  — the wrapper-or-flat shape with chain-time
 *                        entries applied. Editor surfaces read this
 *                        so their picker round-trip preserves sources.
 */
function finaliseAwarenessShapes(state, awarenessCtx) {
  const collapse = (current) => {
    const resolved = resolveAwarenessField(current, awarenessCtx)
    // `awareness_raw` is the wrapper-shape representation of the
    // CURRENT effective state at the anchor — entries reflect history
    // walked up to the anchor, sources reflect baseline sources after
    // any chain-time source mutations. Editor surfaces (pickers) read
    // awareness_raw to populate their initial draft so the user sees
    // (and edits from) chain-resolved state, not stale baseline.
    if (isAwarenessWrapper(current)) {
      const walked = applyAwarenessHistoryToWrapper(current, awarenessCtx)
      // Chain-tracked tracking state — when off at the anchor, surface
      // both shapes as null so the picker reads "tracking off" via the
      // null-wrapper convention.
      if (walked.tracking === false) return { resolved: null, raw: null }
      const raw = {}
      if (Object.keys(walked.entries).length > 0) raw.entries = walked.entries
      if (walked.sources.length > 0) raw.sources = walked.sources
      return { resolved, raw }
    }
    return { resolved, raw: cloneAwareness(current) }
  }
  {
    const { resolved, raw } = collapse(state.awareness)
    state.awareness = resolved
    state.awareness_raw = raw
  }
  {
    const { resolved, raw } = collapse(state.name_awareness)
    state.name_awareness = resolved
    state.name_awareness_raw = raw
  }
  for (let i = 0; i < (state.aliases || []).length; i++) {
    const a = state.aliases[i]
    const { resolved, raw } = collapse(a?.awareness)
    state.aliases[i] = { ...a, awareness: resolved, awareness_raw: raw }
  }
  for (let i = 0; i < (state.attributes || []).length; i++) {
    const a = state.attributes[i]
    const { resolved, raw } = collapse(a?.awareness)
    state.attributes[i] = { ...a, awareness: resolved, awareness_raw: raw }
  }
}

/**
 * Find the most recent node in the partner entity's narrative chain that is at or upstream
 * of `atNodeId`.
 *
 * Hybrid walk strategy:
 *   1. If `atNodeId` is in the POV chain, walk backwards through the POV sequence
 *      (narrative order) and return the most recent scene where the partner has a chip.
 *   2. If `atNodeId` is NOT in the POV chain, BFS backwards through entity flow edges
 *      until we either find the partner directly, or reach a node that IS in the POV chain —
 *      then switch to the POV walk from that intersection point.
 *   3. If the POV walk doesn't find the partner either, fall back to the relationship
 *      wire endpoint.
 *
 * @param {Object} partnerEntity  — the partner entity object
 * @param {Array}  nodes          — React Flow nodes
 * @param {Array}  edges          — React Flow edges
 * @param {string} atNodeId       — the node we're looking from
 * @param {string} relId          — relationship ID (for fallback wire endpoint)
 * @param {Object} [povChain]     — optional POV chain from computePovChain(); if omitted, POV walk is skipped
 *
 * Returns the node ID where the partner's state should be read from, or null.
 */
/**
 * Latest node in global story order that carries at least one of the given
 * entity ids as a chip (plot point) or as the node's own entity (entity origin
 * / modifier). Used as the anchor when building a participant-name resolver
 * for contexts that aren't tied to a specific chain position — e.g. the
 * Timeline Navigator's relationship identity row, the duplicate-rel confirm
 * dialog for origin-variant creates, drag-time tooltips. Returns the "most
 * advanced narrative state the user has defined" for any of the entities.
 *
 * Returns null when storyOrder is absent or no participant is present at any
 * node. Callers fall back to base-library names in that case.
 */
export function findLatestParticipantPresenceNodeId(participantEntityIds, nodes, storyOrder) {
  if (!storyOrder || !Array.isArray(storyOrder.orderedIds)) return null
  if (!participantEntityIds || participantEntityIds.length === 0) return null
  const ids = new Set(participantEntityIds)
  const nodeById = new Map((nodes || []).map((n) => [n.id, n]))
  for (let i = storyOrder.orderedIds.length - 1; i >= 0; i--) {
    const nid = storyOrder.orderedIds[i]
    const n = nodeById.get(nid)
    if (!n) continue
    if (n.type === 'sceneNode') {
      for (const b of ENTITY_BUCKETS) {
        const refs = n.data?.[b]
        if (Array.isArray(refs) && refs.some((r) => ids.has(r.entity_id))) return nid
      }
    } else if (n.type === 'entityNode' && ids.has(n.data?.entity_id)) {
      return nid
    }
  }
  return null
}

/**
 * Build a participant-name resolver pinned at the latest-presence anchor (see
 * `findLatestParticipantPresenceNodeId`). Returns a function
 * `(entityId) => name | null` suitable for passing as `resolveName` to
 * `participantsFallbackLabel` / `buildParticipantNameItems` /
 * `<ParticipantsFallbackLabel>` / `<RelationshipLabelStack>`. Returns null
 * when no anchor can be found — callers should omit the resolver in that
 * case and let the helper fall back to base-library names.
 */
export function makeLatestPresenceNameResolver({ participantEntityIds, nodes, edges, storyOrder, getEntity }) {
  const anchorId = findLatestParticipantPresenceNodeId(participantEntityIds, nodes, storyOrder)
  if (!anchorId) return null
  return (entityId) => {
    const ent = getEntity(entityId)
    if (!ent) return null
    const s = computeEffectiveState(ent, nodes, edges, anchorId)
    return s?.name || ent.name || null
  }
}

export function findPartnerChainNodeAtOrBefore(partnerEntity, nodes, edges, atNodeId, relId, povChain) {
  if (!partnerEntity || !atNodeId) return null

  const partnerChain = getEntityNarrativeChain(partnerEntity.id, nodes, edges)
  if (partnerChain.length === 0) return null

  const partnerChainNodeIds = new Set(partnerChain.map((n) => n.id))

  // Helper: walk backwards through the POV sequence from a given position to find the partner
  function povWalkBackFrom(povIndex) {
    if (!povChain?.sequence?.length) return null
    for (let i = povIndex - 1; i >= 0; i--) {
      const sceneId = povChain.sequence[i].nodeId
      if (partnerChainNodeIds.has(sceneId)) return sceneId
    }
    return null
  }

  // If the POV chain is available, check if atNodeId is directly in it
  if (povChain?.reachable?.has(atNodeId)) {
    const povIdx = povChain.sequence.findIndex((s) => s.nodeId === atNodeId)
    if (povIdx >= 0) {
      // Check the current node first
      if (partnerChainNodeIds.has(atNodeId)) return atNodeId
      const povResult = povWalkBackFrom(povIdx)
      if (povResult) return povResult
    }
  }

  // BFS backwards from atNodeId through non-relationship, non-POV edges.
  // If we find the partner directly, return it.
  // If we reach a node on the POV chain, switch to POV walk from there.
  const visited = new Set()
  const queue = [atNodeId]
  let bestNodeId = null
  let bestIdx    = -1

  while (queue.length > 0) {
    const current = queue.shift()
    if (visited.has(current)) continue
    visited.add(current)

    // Check if partner is at this node
    if (partnerChainNodeIds.has(current)) {
      const idx = partnerChain.findIndex((n) => n.id === current)
      if (idx > bestIdx) { bestIdx = idx; bestNodeId = current }
    }

    // If this node is on the POV chain (and it's not the starting node which we already checked),
    // try the POV walk from here
    if (current !== atNodeId && povChain?.reachable?.has(current)) {
      const povIdx = povChain.sequence.findIndex((s) => s.nodeId === current)
      if (povIdx >= 0) {
        // Check current POV node first
        if (partnerChainNodeIds.has(current) && !bestNodeId) {
          bestNodeId = current
        }
        const povResult = povWalkBackFrom(povIdx + 1)  // +1 to include current node's position
        if (povResult) {
          // Compare with BFS result — use whichever is further along the partner's chain
          const povResultIdx = partnerChain.findIndex((n) => n.id === povResult)
          if (povResultIdx > bestIdx) return povResult
        }
      }
    }

    for (const e of edges) {
      if (e.target === current && !e.data?.is_relationship && !e.data?.is_pov_path && !visited.has(e.source)) {
        queue.push(e.source)
      }
    }
  }

  if (bestNodeId) return bestNodeId

  // Fallback: use the relationship wire's partner-side endpoint
  if (relId) {
    const relEdge = edges.find((e) => e.data?.relationship_id === relId)
    if (relEdge) {
      if (partnerChainNodeIds.has(relEdge.source)) return relEdge.source
      if (partnerChainNodeIds.has(relEdge.target)) return relEdge.target
    }
  }

  return null
}

/**
 * Build an `action='add'` chip descriptor for a given Attribute object.
 *
 * Single source of truth for "this attribute is new here" chip rendering.
 * Used by both:
 *
 *   - The mid-chain `action='add'` branch in `computeChangeSubChips` (when
 *     iterating an `attribute_changes` chain entry).
 *   - The origin-mode branch (when iterating `entity.attributes` at an
 *     entity's own origin EntityNode, where attributes live on the entity
 *     baseline rather than as `action='add'` chain entries).
 *
 * Per-type enrichment (file thumbnails, list initial-state, circumstance /
 * motivator description + intensity, number typed value) lives here so
 * both paths render the same descriptor shape and any new attribute type
 * only needs one place to update.
 */
function _addChipFromAttribute(attr) {
  const truncLocal = (s, n = 22) => (s && s.length > n ? s.slice(0, n) + '…' : (s || ''))
  const isMedia        = attr.attribute_type === 'file'
  const isTextList     = attr.attribute_type === 'text_list'
  const isEntityList   = attr.attribute_type === 'entity_list'
  const isCircumstance = attr.attribute_type === 'circumstance'
  const isMotivator    = attr.attribute_type === 'motivator'
  const isPerspective  = attr.attribute_type === 'perspective'
  const isNumber       = attr.attribute_type === 'number'
  const chip = {
    action: 'add',
    field: attr.name,
    newValue: truncLocal(attr.value),
    attributeId: attr.id,
    attributeType: attr.attribute_type,
  }
  if (isMedia) {
    chip.isFileAttribute = true
    chip.newFileRef = attr.file_ref || null
  }
  if (isTextList || isEntityList) {
    chip.isListAttribute = true
    chip.isTextList = isTextList
    chip.isEntityList = isEntityList
    chip.initialList = parseListValue(attr.value)
  }
  if (isCircumstance || isMotivator) {
    chip.isCircumstanceOrMotivator = true
    chip.description = attr.description || ''
    chip.intensity   = attr.intensity ?? null
  }
  // Phase 2.13b — perspective sub-chips carry the target reference
  // + description (the perspective body) so the chip dispatcher can
  // render the row as `[P badge] [target badge] [trunc description]`
  // without re-resolving the target lookup. Same shape used on add
  // chips (here), modify chips (target rewire / description edit),
  // and remove chips (priorAttr's last-seen state).
  if (isPerspective) {
    chip.isPerspective = true
    chip.description = attr.description || ''
    chip.perspectiveTargetKind = attr.perspective_target_kind ?? null
    chip.perspectiveTargetId   = attr.perspective_target_id ?? null
  }
  if (isNumber) {
    chip.isNumber = true
    chip.newNumberValue = attr.number_value ?? null
    if (chip.newNumberValue != null) {
      chip.newValue = truncLocal(formatNumberForChip(chip.newNumberValue))
    }
  }
  return chip
}

/**
 * Given an entity's EntityRef (or modifier entity node data) at a specific chain stop,
 * and the entity's effective state *before* that stop (priorState), compute a list of
 * sub-chip descriptors that describe exactly what changed at this stop.
 *
 * Each descriptor: { action: 'add'|'modify'|'remove', field, oldValue?, newValue?, isColour?, isRelationship? }
 *
 * All field types are treated uniformly — first-class fields (name, colour, description,
 * profile image), user-defined attributes, and relationships (a special attribute type
 * whose value is another entity) are all in the same list.
 *
 * Origin mode: when called with `options.originMode = true`, iterates the
 * entity's own baseline attributes (`entity.attributes`) and emits one
 * `add` chip per attribute via `_addChipFromAttribute`. Used by origin
 * EntityNodes where attributes live on the entity baseline rather than
 * as `action='add'` chain entries on a chain stop. Origin mode skips
 * the first-class field chips (Name / Colour / Description / Profile
 * Image / Aliases) since those render via the entity's identity header
 * at origin, not as a chip stream.
 */
export function computeChangeSubChips(changeData, priorState, entity, allEntities, options = {}) {
  const chips = []
  const trunc = (s, n = 22) => (s && s.length > n ? s.slice(0, n) + '…' : (s || ''))

  // ── Origin mode ─────────────────────────────────────────────────────────────
  // At an entity's own origin EntityNode, attributes live on the entity
  // baseline (not as chain entries). Emit one add chip per baseline
  // attribute via the shared helper. This is the chain-aware path at
  // origin per the chain rule (origin baselines read directly).
  if (options.originMode) {
    for (const attr of (entity?.attributes || [])) {
      chips.push(_addChipFromAttribute(attr))
    }
    return chips
  }

  // ── First-class fields ──────────────────────────────────────────────────────
  if (changeData.name_change != null) {
    chips.push({ action: 'modify', field: 'Name', oldValue: trunc(priorState.name), newValue: trunc(changeData.name_change) })
  }
  if (changeData.colour_change != null) {
    chips.push({ action: 'modify', field: 'Colour', oldValue: priorState.colour, newValue: changeData.colour_change, isColour: true })
  }
  if (changeData.description_change != null) {
    chips.push({ action: 'modify', field: 'Description', oldValue: trunc(priorState.description, 16), newValue: trunc(changeData.description_change, 16) })
  }
  if (changeData.profile_image_change != null) {
    if (changeData.profile_image_change === '') {
      chips.push({ action: 'remove', field: 'Profile Image', isProfileImage: true, oldImageRef: priorState.profile_image_ref })
    } else {
      chips.push({ action: priorState.profile_image_ref ? 'modify' : 'add', field: 'Profile Image', isProfileImage: true, oldImageRef: priorState.profile_image_ref, newImageRef: changeData.profile_image_change })
    }
  }
  // Aliases — 2026-05-17 refactor: per-alias events on `alias_changes`
  // are the canonical shape. Each event already says what was added or
  // removed; we look the value up from `priorState` for `remove` events
  // (the event only carries `alias_id`). The legacy `aliases_change`
  // full-list snapshot path is kept as a fallback for the in-progress
  // draft state in the editor — the draft still uses the old full-list
  // interface until it's converted to events at save time, and the
  // editor's preview sub-chips compute from the unsaved draft directly.
  if (Array.isArray(changeData.alias_changes) && changeData.alias_changes.length > 0) {
    const priorById = new Map(
      (priorState.aliases || [])
        .filter((a) => a && typeof a === 'object' && a.id)
        .map((a) => [a.id, a])
    )
    const listOps = []
    for (const ev of changeData.alias_changes) {
      if (!ev || typeof ev !== 'object') continue
      if (ev.action === 'add' && ev.alias && ev.alias.value != null) {
        listOps.push({ type: 'add', item: ev.alias.value, cancelled: false })
      } else if (ev.action === 'remove' && ev.alias_id) {
        const priorAlias = priorById.get(ev.alias_id)
        if (priorAlias) {
          listOps.push({ type: 'remove', item: priorAlias.value, cancelled: false })
        }
      } else if (ev.action === 'modify' && ev.alias_id && ev.new_value != null) {
        // Modify renders as remove-old + add-new for the chip display.
        // The underlying event stays a single modify; the UI just
        // visualises the transition.
        const priorAlias = priorById.get(ev.alias_id)
        if (priorAlias && priorAlias.value !== ev.new_value) {
          listOps.push({ type: 'remove', item: priorAlias.value, cancelled: false })
          listOps.push({ type: 'add', item: ev.new_value, cancelled: false })
        }
      }
      // awareness_set / awareness_source_* per-alias events do not
      // contribute to the list-change chip (alias presence is
      // unchanged); awareness sub-chips ride a separate computation.
    }
    if (listOps.length > 0) {
      chips.push({ action: 'list_change', field: 'Aliases', isListAttribute: true, isTextList: true, listOps })
    }
  }

  // ── User-defined attribute changes ──────────────────────────────────────────
  // Two passes: first collect per-attribute list ops into groups, then walk the
  // full list to emit chips. Non-list ops are emitted in original order; list
  // ops are consolidated into one `list_change` descriptor per attribute per
  // scene (storage remains granular — only the display groups).
  const listGroups = new Map()  // attribute_id -> { ops: [...] }
  for (const ac of (changeData.attribute_changes || [])) {
    if (ac.action !== 'list_add' && ac.action !== 'list_remove') continue
    if (!listGroups.has(ac.attribute_id)) listGroups.set(ac.attribute_id, { ops: [] })
    listGroups.get(ac.attribute_id).ops.push({
      type: ac.action === 'list_add' ? 'add' : 'remove',
      item: ac.list_item,
      cancelled: ac.cancelled || false,
    })
  }
  const emittedListGroups = new Set()

  for (const ac of (changeData.attribute_changes || [])) {
    if (ac.action === 'add' && ac.attribute) {
      // Mid-chain add: the `add` chain entry IS this attribute's own
      // origin per the chain model. Hand the embedded attribute to the
      // shared helper that constructs the canonical add-chip shape.
      // Same code path the origin-mode branch above uses; per-type
      // enrichment lives in one place.
      chips.push(_addChipFromAttribute(ac.attribute))
    } else if (ac.action === 'modify') {
      const priorAttr = priorState.attributes.find((a) => a.id === ac.attribute_id)
      const attrType  = priorAttr?.attribute_type
        || (entity.attributes || []).find((a) => a.id === ac.attribute_id)?.attribute_type
        || 'text'
      const attrName  = priorAttr?.name || (entity.attributes || []).find((a) => a.id === ac.attribute_id)?.name || 'Attribute'
      const isMedia = attrType === 'file' || ac.file_ref_change != null
      const isCircumstance = attrType === 'circumstance'
      const isMotivator    = attrType === 'motivator'
      const isPerspective  = attrType === 'perspective'
      const isNumber       = attrType === 'number'

      // Phase 2.13b — perspective modify: the modify event can carry
      // any subset of new_description / new_perspective_target_kind /
      // new_perspective_target_id. Emit a perspective chip with the
      // effective post-edit target + description so the dispatcher can
      // render `[P badge] [target badge] [trunc description]` at the
      // chain anchor. Falls back to priorAttr's last-seen values for
      // any field this modify entry didn't touch.
      if (isPerspective) {
        const newDesc = Object.prototype.hasOwnProperty.call(ac, 'new_description')
          ? (ac.new_description ?? '')
          : (priorAttr?.description ?? '')
        const newKind = Object.prototype.hasOwnProperty.call(ac, 'new_perspective_target_kind')
          ? (ac.new_perspective_target_kind ?? null)
          : (priorAttr?.perspective_target_kind ?? null)
        const newId = Object.prototype.hasOwnProperty.call(ac, 'new_perspective_target_id')
          ? (ac.new_perspective_target_id ?? null)
          : (priorAttr?.perspective_target_id ?? null)
        chips.push({
          action: 'modify',
          attributeId: ac.attribute_id,
          attributeType: attrType,
          isPerspective: true,
          field: attrName,
          description: newDesc,
          perspectiveTargetKind: newKind,
          perspectiveTargetId:   newId,
          oldDescription: priorAttr?.description ?? '',
          oldPerspectiveTargetKind: priorAttr?.perspective_target_kind ?? null,
          oldPerspectiveTargetId:   priorAttr?.perspective_target_id ?? null,
        })
        continue
      }

      // Phase 1.22 — circumstance / motivator modify: the modify event
      // can carry any subset of new_description / new_intensity /
      // new_name (per the locked Option A payload shape). Read them
      // independently so the dispatcher can render the right transition.
      if (isCircumstance || isMotivator) {
        const intensityChanged = ac.new_intensity !== undefined && ac.new_intensity !== null
          ? true
          : (Object.prototype.hasOwnProperty.call(ac, 'new_intensity') && ac.new_intensity === null)
        const descChanged = ac.new_description != null
        const nameChanged = ac.new_name != null
        const chip = {
          action: 'modify',
          attributeId: ac.attribute_id,
          attributeType: attrType,
          isCircumstanceOrMotivator: true,
          field: nameChanged ? (priorAttr?.name || attrName) : attrName,
        }
        if (intensityChanged) {
          chip.oldIntensity = priorAttr?.intensity ?? null
          chip.newIntensity = ac.new_intensity
        }
        if (descChanged) {
          chip.oldValue = trunc(priorAttr?.description || '', 24)
          chip.newValue = trunc(ac.new_description, 24)
        } else if (nameChanged) {
          chip.oldValue = trunc(priorAttr?.name || '', 24)
          chip.newValue = trunc(ac.new_name, 24)
        }
        chips.push(chip)
        continue
      }

      // Phase 1.22 — number modify: emit as a standard text-modify chip
      // with the typed numeric value formatted for display.
      if (isNumber && ac.new_number_value !== undefined) {
        const oldNum = priorAttr?.number_value
        chips.push({
          action: 'modify',
          field: attrName,
          oldValue: oldNum != null ? formatNumberForChip(oldNum) : '',
          newValue: ac.new_number_value != null ? formatNumberForChip(ac.new_number_value) : '',
          attributeId: ac.attribute_id,
          attributeType: attrType,
          isNumber: true,
          oldNumberValue: oldNum ?? null,
          newNumberValue: ac.new_number_value ?? null,
        })
        continue
      }

      const chip = {
        action: 'modify',
        field: attrName,
        oldValue: trunc(priorAttr?.value || ''),
        newValue: trunc(ac.new_value ?? priorAttr?.value ?? ''),
        attributeId: ac.attribute_id,
        attributeType: attrType,
      }
      if (isMedia) {
        chip.isFileAttribute = true
        chip.oldFileRef = priorAttr?.file_ref || null
        // file_ref_change: null = no file_ref change at this node (value-only modify),
        // "" = cleared, "assets/…" = replaced
        chip.newFileRef = ac.file_ref_change === '' ? null : (ac.file_ref_change ?? priorAttr?.file_ref ?? null)
      }
      chips.push(chip)
    } else if (ac.action === 'rename') {
      const priorAttr = priorState.attributes.find((a) => a.id === ac.attribute_id)
      const oldName   = priorAttr?.name || (entity.attributes || []).find((a) => a.id === ac.attribute_id)?.name || 'Attribute'
      chips.push({
        action: 'rename',
        field: oldName,
        newValue: ac.new_name,
        attributeId: ac.attribute_id,
      })
    } else if (ac.action === 'remove') {
      const priorAttr = priorState.attributes.find((a) => a.id === ac.attribute_id)
      const attrName  = priorAttr?.name || (entity.attributes || []).find((a) => a.id === ac.attribute_id)?.name || 'Attribute'
      const attrType  = priorAttr?.attribute_type || (entity.attributes || []).find((a) => a.id === ac.attribute_id)?.attribute_type
      const isMedia = attrType === 'file'
      const isTextList   = attrType === 'text_list'
      const isEntityList = attrType === 'entity_list'
      const isCircumstance = attrType === 'circumstance'
      const isMotivator    = attrType === 'motivator'
      const isPerspective  = attrType === 'perspective'
      const chip = {
        action: 'remove',
        field: attrName,
        attributeId: ac.attribute_id,
        attributeType: attrType,
      }
      if (isMedia) {
        chip.isFileAttribute = true
        chip.oldFileRef = priorAttr?.file_ref || null
      }
      if (isTextList || isEntityList) {
        chip.isListAttribute = true
        chip.isTextList = isTextList
        chip.isEntityList = isEntityList
      }
      // Phase 1.22 — circumstance / motivator remove chips carry the
      // prior description + intensity so the new CircumstanceMotivatorSubChip
      // dispatcher can render the row directly off the chip.
      if (isCircumstance || isMotivator) {
        chip.isCircumstanceOrMotivator = true
        chip.description = priorAttr?.description || ''
        chip.intensity   = priorAttr?.intensity ?? null
      }
      // Phase 2.13b — perspective remove chips carry the prior
      // description + target so the PerspectiveSubChip dispatcher can
      // render the row directly off the chip (same shape as add/modify
      // perspective chips).
      if (isPerspective) {
        chip.isPerspective = true
        chip.description = priorAttr?.description || ''
        chip.perspectiveTargetKind = priorAttr?.perspective_target_kind ?? null
        chip.perspectiveTargetId   = priorAttr?.perspective_target_id ?? null
      }
      chips.push(chip)
    } else if (ac.action === 'list_add' || ac.action === 'list_remove') {
      // Emit exactly one chip per attribute_id regardless of how many ops are grouped.
      if (emittedListGroups.has(ac.attribute_id)) continue
      emittedListGroups.add(ac.attribute_id)
      const group = listGroups.get(ac.attribute_id)
      const priorAttr = priorState.attributes.find((a) => a.id === ac.attribute_id)
      const attrName  = priorAttr?.name || (entity.attributes || []).find((a) => a.id === ac.attribute_id)?.name || 'Attribute'
      const isEntityList = priorAttr?.attribute_type === 'entity_list'
      chips.push({
        action: 'list_change',
        field: attrName,
        attributeId: ac.attribute_id,
        isListAttribute: true,
        isEntityList,
        isTextList: !isEntityList,
        listOps: group.ops,
      })
    }
  }

  return chips
}

/**
 * Return the ordered list of node IDs where a relationship has any history changes.
 * Used by RelationshipDetailPanel for sparse chain navigation.
 */
export function getRelationshipHistoryNodes(relationship) {
  if (!relationship?.history) return []
  const nodeIds = new Set()
  for (const list of Object.values(relationship.history)) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (entry.node_id) nodeIds.add(entry.node_id)
    }
  }
  return [...nodeIds]
}

/**
 * Compute the effective state of a relationship by walking relationship.history
 * up to and including atNodeId (using nodeOrder to determine sequence).
 * Returns: { is_active, name, participants, participant_roles, hierarchy, membership_of }
 *
 * @param {Object} relationship  - the Relationship object
 * @param {string[]} nodeOrder   - ordered node IDs (e.g. from a narrative chain walk)
 * @param {string}   atNodeId    - walk up to this node (inclusive); null = apply all changes
 */
export function computeRelationshipEffectiveState(relationship, nodeOrder, atNodeId, ctx = null) {
  if (!relationship) return null

  const nodeOrderMap = new Map((nodeOrder || []).map((id, i) => [id, i]))
  const atIdx = atNodeId && nodeOrderMap.has(atNodeId) ? nodeOrderMap.get(atNodeId) : Infinity

  function shouldApply(nodeId) {
    if (!atNodeId) return true
    return nodeOrderMap.has(nodeId) ? nodeOrderMap.get(nodeId) <= atIdx : true
  }

  // Phase 1.21g — collapse awareness wrapper to flat resolved dict at
  // state init, same pattern as the entity walker. Projection
  // resolution requires `ctx.allRelationships` / `ctx.allEntities`;
  // when absent (today's most common case) flat-dict awareness still
  // resolves identically to before this phase.
  const awarenessCtx = ctx ? { nodeOrder, anchorNodeId: atNodeId, ...ctx } : { nodeOrder, anchorNodeId: atNodeId }

  const state = {
    is_active:         true,
    name:              relationship.name ?? null,
    description:       relationship.description ?? '',
    participants:      [],
    participant_roles: { ...(relationship.participant_roles || {}) },
    hierarchy:         relationship.hierarchy ?? null,
    membership_of:     relationship.membership_of ?? null,
    awareness:         resolveAwarenessField(relationship.awareness, awarenessCtx),
    // Phase 3.4a — baseline Project Tag membership + provenance.
    // Mirrors the entity walker shape; tags are metadata-only so no
    // awareness pass applies. Pool itself isn't chain-tracked.
    tag_ids:           [...(relationship.tag_ids || [])],
    effective_tags:    (relationship.tag_ids || []).map((tag_id) => ({
      tag_id,
      source: 'baseline',
    })),
  }

  const history = relationship.history || {}

  for (const ch of (history.existence_changes || [])) {
    if (shouldApply(ch.node_id)) state.is_active = ch.action === 'activate'
  }
  for (const ch of (history.participant_changes || [])) {
    if (!shouldApply(ch.node_id)) continue
    if (ch.action === 'join') {
      if (!state.participants.some((p) => p.entity_id === ch.entity_id)) {
        state.participants.push({ entity_id: ch.entity_id, perception: ch.initial_perception || '', alias_override: ch.initial_alias_override ?? null })
      }
    } else if (ch.action === 'leave') {
      state.participants = state.participants.filter((p) => p.entity_id !== ch.entity_id)
    }
  }
  for (const ch of (history.perception_changes || [])) {
    if (!shouldApply(ch.node_id)) continue
    const p = state.participants.find((p) => p.entity_id === ch.entity_id)
    if (p) p.perception = ch.new_perception
  }
  for (const ch of (history.alias_changes || [])) {
    if (!shouldApply(ch.node_id)) continue
    const p = state.participants.find((p) => p.entity_id === ch.entity_id)
    if (p) p.alias_override = ch.new_alias_override ?? null
  }
  for (const ch of (history.role_changes || [])) {
    if (!shouldApply(ch.node_id)) continue
    if (ch.new_role == null) delete state.participant_roles[ch.entity_id]
    else state.participant_roles[ch.entity_id] = { ...ch.new_role }
  }
  for (const ch of (history.hierarchy_changes || [])) {
    if (shouldApply(ch.node_id)) state.hierarchy = ch.new_hierarchy ?? null
  }
  for (const ch of (history.name_changes || [])) {
    if (shouldApply(ch.node_id)) state.name = ch.new_name ?? null
  }
  for (const ch of (history.description_changes || [])) {
    if (shouldApply(ch.node_id)) state.description = ch.new_description ?? ''
  }
  // Project Tag membership — same shape as the entity walker's
  // `tag_changes` apply (no awareness pass; baseline vs chain
  // provenance tracked on `effective_tags`). Each entry carries its
  // own `node_id` per the RelationshipHistory pattern.
  for (const ch of (history.tag_changes || [])) {
    if (!shouldApply(ch.node_id) || !ch?.tag_id) continue
    if (ch.action === 'add') {
      if (state.tag_ids.includes(ch.tag_id)) continue
      state.tag_ids = [...state.tag_ids, ch.tag_id]
      state.effective_tags = [...state.effective_tags, {
        tag_id: ch.tag_id,
        source: 'chain',
        added_at_node_id: ch.node_id || null,
      }]
    } else if (ch.action === 'remove') {
      if (!state.tag_ids.includes(ch.tag_id)) continue
      state.tag_ids = state.tag_ids.filter((id) => id !== ch.tag_id)
      state.effective_tags = state.effective_tags.filter((t) => t.tag_id !== ch.tag_id)
    }
  }

  // ── awareness_raw — wrapper view at the anchor (entries + sources
  // without source-expansion). Mirrors the entity walker pattern at
  // `finaliseAwarenessShapes`. Picker + observer-side resolver read
  // this so sources stay distinct rather than collapsing into
  // per-participant entries.
  if (isAwarenessWrapper(relationship.awareness)) {
    const walked = applyAwarenessHistoryToWrapper(relationship.awareness, awarenessCtx)
    if (walked.tracking === false) {
      state.awareness_raw = null
    } else {
      const raw = {}
      if (Object.keys(walked.entries || {}).length > 0) raw.entries = walked.entries
      if ((walked.sources || []).length > 0) raw.sources = walked.sources
      state.awareness_raw = Object.keys(raw).length > 0 ? raw : (walked.tracking ? {} : null)
    }
  } else if (relationship.awareness && typeof relationship.awareness === 'object' && !Array.isArray(relationship.awareness)) {
    state.awareness_raw = { ...relationship.awareness }
  } else {
    state.awareness_raw = null
  }

  return state
}

/**
 * Return all history changes recorded at a specific node for a relationship.
 * Used by RelationshipChip to generate change sub-chips.
 *
 * @param {Object}   relationship - the Relationship object
 * @param {string}   nodeId       - the node to check
 * @param {string}   [entityId]   - optional filter; if set, only return changes for this participant
 * @param {string[]} [nodeOrder]  - sorted node ID array; when provided, name change descriptors include old_value
 * @returns {Array} descriptors: { type, action, entity_id?, ... }
 */

/**
 * Phase 1.21h Fix #3 — return the canvas node id where this relationship
 * came into existence. Reads the explicit `creation_anchor_node_id`
 * field set at creation time (preferred); falls back to a
 * `membership_of`-gated heuristic for relationships missing the field.
 *
 * Fallback semantics differ by relationship kind:
 *
 *  - **Faction-membership relationships** (`membership_of` is set):
 *    the membership is activated at the faction's origin INDEPENDENT
 *    of any participant joins (members of a faction can join the
 *    membership relationship later via the canvas without re-creating
 *    it). The creation anchor is the FIRST `existence_changes`
 *    activate event by story order — subsequent activates after a
 *    deactivate cycle are chain entries on the rel's history, NOT
 *    new origins.
 *  - **Regular relationships** (`membership_of` is null): per the
 *    `createRelationship` design assumption ("all existing creation
 *    paths anchor every initial join to the same node"), the join
 *    event IS the creation anchor. Activate + join are bundled at
 *    one node at creation time. Heuristic: a node is the creation
 *    node when every initial join points to it, OR when all joins
 *    are on entity-origin nodes AND `candidateAnchor` is one of them.
 *    Returns null when the heuristic can't decide (compound-creation
 *    cases — joins anchored at distinct non-entity-origin nodes);
 *    callers should treat null as "not a creation-anchor write" and
 *    route to chain-entry instead of baseline.
 *
 * Phase 3.4f Item 7 / v0.3.4.31 — the faction-membership branch was
 * added after the tag-popover click-through surfaced a case where
 * the previous "joins-first regardless of `membership_of`" fallback
 * returned the participant-join node rather than the earlier
 * faction-activate node. See `Dracula Hunters Membership` in
 * `Dracula_02.nnz` for the reproducing data.
 *
 * @param {object}   relationship      - the Relationship object
 * @param {Array}    [nodes]           - optional canvas nodes array (used by
 *                                       fallback heuristic to detect
 *                                       entity-origin nodes AND by the
 *                                       multi-activate sort for faction
 *                                       memberships)
 * @param {string}   [candidateAnchor] - optional anchor to validate against
 *                                       the regular-relationship heuristic.
 *                                       Ignored for faction-memberships.
 * @returns {string | null}
 */
export function getRelationshipCreationNodeId(relationship, nodes = null, candidateAnchor = null) {
  if (!relationship) return null
  if (relationship.creation_anchor_node_id) return relationship.creation_anchor_node_id

  // ── Faction-membership branch ──────────────────────────────────────
  // The rel was activated at the faction's origin independent of any
  // later participant joins. First activate by story order is the
  // origin; later activates (post-deactivate re-activations) are
  // chain entries on the existence history, not new origins.
  if (relationship.membership_of) {
    const activateNodeIds = [...new Set(
      (relationship.history?.existence_changes || [])
        .filter((c) => c?.action === 'activate' && c?.node_id)
        .map((c) => c.node_id)
    )]
    if (activateNodeIds.length === 0) return null
    if (activateNodeIds.length === 1) return activateNodeIds[0]
    // Multi-activate: pick earliest by story order via the rel's node
    // order helper. Falls back to first-seen when nodes aren't supplied.
    if (!Array.isArray(nodes)) return activateNodeIds[0]
    const order = getRelationshipNodeOrder(relationship, nodes, null, null)
    const positionById = new Map(order.map((nid, idx) => [nid, idx]))
    let pick = null
    let pickPos = Number.POSITIVE_INFINITY
    for (const nid of activateNodeIds) {
      const pos = positionById.has(nid) ? positionById.get(nid) : Number.POSITIVE_INFINITY
      if (pos < pickPos) { pick = nid; pickPos = pos }
    }
    return pick
  }

  // ── Regular relationship branch ────────────────────────────────────
  // Per createRelationship's design assumption, activate + join are
  // bundled at one node at creation time. The join node IS the
  // creation anchor.
  const joins = (relationship.history?.participant_changes || []).filter((c) => c?.action === 'join')
  const joinNodeIds = [...new Set(joins.map((c) => c.node_id).filter(Boolean))]
  if (joinNodeIds.length === 1) return joinNodeIds[0]
  if (joinNodeIds.length === 0) {
    // Regular rel with no joins is unusual but possible. Use the
    // earliest activate event by story order as the origin.
    const activateNodeIds = [...new Set(
      (relationship.history?.existence_changes || [])
        .filter((c) => c?.action === 'activate' && c?.node_id)
        .map((c) => c.node_id)
    )]
    if (activateNodeIds.length === 0) return null
    if (activateNodeIds.length === 1) return activateNodeIds[0]
    return null
  }
  if (!candidateAnchor) return null
  // Multi-node-joins case: only an entity-origin-joined-here pattern
  // identifies the creation anchor unambiguously, and the candidate
  // must be one of the join nodes.
  if (Array.isArray(nodes) && joins.every((c) => {
    const n = nodes.find((x) => x.id === c.node_id)
    return n?.type === 'entityNode' && !n.data?.is_modifier
  }) && joinNodeIds.includes(candidateAnchor)) {
    return candidateAnchor
  }
  return null
}

export function getRelationshipChangesAtNode(relationship, nodeId, entityId, nodeOrder) {
  if (!relationship?.history || !nodeId) return []
  const history = relationship.history
  const changes = []

  for (const ch of (history.existence_changes || [])) {
    if (ch.node_id === nodeId) changes.push({ type: 'existence', action: ch.action })
  }
  for (const ch of (history.participant_changes || [])) {
    if (ch.node_id !== nodeId) continue
    if (entityId && ch.entity_id !== entityId) continue
    changes.push({ type: 'participant', action: ch.action, entity_id: ch.entity_id })
  }
  // Phase 1.21h — compute `old_value` for per-entity scalar change types
  // (perception / alias / role) the same way name_changes does below.
  // Walks prior history for the same (entity_id, change_type) and falls
  // back to the join event's initial value or `participant_roles` for
  // role.
  const ordinalMapForScalars = nodeOrder ? Object.fromEntries(nodeOrder.map((id, i) => [id, i])) : null
  const nodeOrdForScalars = ordinalMapForScalars ? (ordinalMapForScalars[nodeId] ?? Infinity) : null
  function priorScalarValue(listKey, valueKey, entId) {
    if (!ordinalMapForScalars) return null
    let latestPrior = null
    for (const prior of (history[listKey] || [])) {
      if (prior.node_id === nodeId) continue
      if (prior.entity_id !== entId) continue
      const priorOrd = ordinalMapForScalars[prior.node_id] ?? Infinity
      if (priorOrd < nodeOrdForScalars) {
        if (latestPrior === null || priorOrd > (ordinalMapForScalars[latestPrior.node_id] ?? Infinity)) {
          latestPrior = prior
        }
      }
    }
    return latestPrior ? (latestPrior[valueKey] ?? null) : null
  }
  for (const ch of (history.perception_changes || [])) {
    if (ch.node_id !== nodeId) continue
    if (entityId && ch.entity_id !== entityId) continue
    let old_value = priorScalarValue('perception_changes', 'new_perception', ch.entity_id)
    if (old_value == null) {
      const join = (history.participant_changes || []).find((c) => c.action === 'join' && c.entity_id === ch.entity_id)
      old_value = join?.initial_perception ?? null
    }
    changes.push({ type: 'perception', action: 'modify', entity_id: ch.entity_id, new_value: ch.new_perception ?? null, old_value })
  }
  for (const ch of (history.alias_changes || [])) {
    if (ch.node_id !== nodeId) continue
    if (entityId && ch.entity_id !== entityId) continue
    let old_value = priorScalarValue('alias_changes', 'new_alias_override', ch.entity_id)
    if (old_value == null) {
      const join = (history.participant_changes || []).find((c) => c.action === 'join' && c.entity_id === ch.entity_id)
      old_value = join?.initial_alias_override ?? null
    }
    changes.push({ type: 'alias', action: ch.new_alias_override ? 'modify' : 'remove', entity_id: ch.entity_id, new_value: ch.new_alias_override ?? null, old_value })
  }
  for (const ch of (history.role_changes || [])) {
    if (ch.node_id !== nodeId) continue
    if (entityId && ch.entity_id !== entityId) continue
    let old_value = null
    if (ordinalMapForScalars) {
      let latestPrior = null
      for (const prior of (history.role_changes || [])) {
        if (prior.node_id === nodeId) continue
        if (prior.entity_id !== ch.entity_id) continue
        const priorOrd = ordinalMapForScalars[prior.node_id] ?? Infinity
        if (priorOrd < nodeOrdForScalars) {
          if (latestPrior === null || priorOrd > (ordinalMapForScalars[latestPrior.node_id] ?? Infinity)) {
            latestPrior = prior
          }
        }
      }
      old_value = latestPrior
        ? (latestPrior.new_role?.value ?? null)
        : (relationship.participant_roles?.[ch.entity_id]?.value ?? null)
    }
    changes.push({ type: 'role', action: ch.new_role ? 'modify' : 'remove', entity_id: ch.entity_id, new_value: ch.new_role?.value ?? null, old_value })
  }
  for (const ch of (history.hierarchy_changes || [])) {
    if (ch.node_id === nodeId) changes.push({ type: 'hierarchy', action: ch.new_hierarchy ? 'modify' : 'remove' })
  }

  const ordinalMap = nodeOrder ? Object.fromEntries(nodeOrder.map((id, i) => [id, i])) : null
  const nodeOrd = ordinalMap ? (ordinalMap[nodeId] ?? Infinity) : null
  for (const ch of (history.name_changes || [])) {
    if (ch.node_id !== nodeId) continue
    let old_value = null
    if (ordinalMap) {
      let latestPrior = null
      for (const prior of (history.name_changes || [])) {
        if (prior.node_id === nodeId) continue
        const priorOrd = ordinalMap[prior.node_id] ?? Infinity
        if (priorOrd < nodeOrd) {
          if (latestPrior === null || priorOrd > (ordinalMap[latestPrior.node_id] ?? Infinity)) {
            latestPrior = prior
          }
        }
      }
      old_value = latestPrior ? (latestPrior.new_name ?? null) : (relationship.name ?? null)
    }
    changes.push({ type: 'name', action: 'modify', new_value: ch.new_name ?? null, old_value })
  }
  for (const ch of (history.description_changes || [])) {
    if (ch.node_id !== nodeId) continue
    let old_value = null
    if (ordinalMap) {
      let latestPrior = null
      for (const prior of (history.description_changes || [])) {
        if (prior.node_id === nodeId) continue
        const priorOrd = ordinalMap[prior.node_id] ?? Infinity
        if (priorOrd < nodeOrd) {
          if (latestPrior === null || priorOrd > (ordinalMap[latestPrior.node_id] ?? Infinity)) {
            latestPrior = prior
          }
        }
      }
      old_value = latestPrior ? (latestPrior.new_description ?? null) : (relationship.description ?? null)
    }
    changes.push({ type: 'description', action: 'modify', new_value: ch.new_description ?? null, old_value })
  }

  return changes
}

// ── Hierarchy chain-walker helpers ────────────────────────────────────────────

/**
 * Find the parent entity of `entityId` by walking all hierarchy-bearing
 * relationships at `atNodeId`. Returns { entityId, relationshipId } or null.
 */
export function getParentLocation(entityId, atNodeId, relationships, nodeOrder) {
  for (const rel of (relationships || [])) {
    const state = computeRelationshipEffectiveState(rel, nodeOrder || [], atNodeId)
    if (!state?.is_active) continue
    const hier = state.hierarchy
    if (!hier?.enabled || !hier.root_entity_id) continue
    if (hier.root_entity_id === entityId) continue
    const isChild = (state.participants || []).some((p) => p.entity_id === entityId)
    if (!isChild) continue
    return { entityId: hier.root_entity_id, relationshipId: rel.id }
  }
  return null
}

/**
 * Find all direct children of `entityId` across all hierarchy-bearing
 * relationships where `entityId` is the root.
 * Returns [{ entityId, relationshipId }, ...].
 */
export function getChildLocations(entityId, atNodeId, relationships, nodeOrder) {
  const results = []
  for (const rel of (relationships || [])) {
    const state = computeRelationshipEffectiveState(rel, nodeOrder || [], atNodeId)
    if (!state?.is_active) continue
    const hier = state.hierarchy
    if (!hier?.enabled || hier.root_entity_id !== entityId) continue
    for (const p of (state.participants || [])) {
      if (p.entity_id !== entityId) {
        results.push({ entityId: p.entity_id, relationshipId: rel.id })
      }
    }
  }
  return results
}

/**
 * Walk up the hierarchy from `entityId` to the root.
 * Returns an array [entityId, parentId, grandparentId, ...] from entity to root.
 * Stops if a cycle is detected.
 */
export function getHierarchyChain(entityId, atNodeId, relationships, nodeOrder) {
  const chain = [entityId]
  const visited = new Set([entityId])
  let current = entityId
  while (true) {
    const parent = getParentLocation(current, atNodeId, relationships, nodeOrder)
    if (!parent || visited.has(parent.entityId)) break
    chain.push(parent.entityId)
    visited.add(parent.entityId)
    current = parent.entityId
  }
  return chain
}

// ── Knowledge chain walker (Phase 1.21c) ───────────────────────────────────
//
// Knowledge is a first-class non-canvas-node object whose awareness + content
// state evolves along the chain. Mirrors the Relationship walker pattern:
// origin values on the Knowledge itself, per-change-type arrays on
// `Knowledge.history`, effective state at chain position Y = origin + all
// history entries with `node_id ≤ Y` in story order, applied in story order.

/**
 * Return the ordered list of node IDs where a Knowledge has any history
 * entries (across any of its change-type arrays). Used by consumers that
 * want sparse chain navigation (Knowledge detail panel chain arrows;
 * sub-chip query by scene).
 */
export function getKnowledgeHistoryNodes(knowledge) {
  if (!knowledge?.history) return []
  const nodeIds = new Set()
  for (const list of Object.values(knowledge.history)) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (entry?.node_id) nodeIds.add(entry.node_id)
    }
  }
  return [...nodeIds]
}

/**
 * Build an ordered list of node IDs relevant to a Knowledge's chain.
 * Parallels `getRelationshipNodeOrder`.
 *
 * The relevant set is: every node referenced by any entry in
 * `knowledge.history` (awareness_changes, name_changes, etc.).
 *
 * Ordering prefers the global story order when provided (filter over
 * `storyOrder.orderedIds`); falls back to arbitrary encounter order
 * otherwise. Unlike relationships, Knowledge has no "participants"
 * whose chains need pulling in — knowledges aren't canvas citizens.
 */
export function getKnowledgeNodeOrder(knowledge, _nodes, _edges, storyOrder) {
  if (!knowledge) return []

  const relevantIds = new Set()
  const history = knowledge.history || {}
  for (const list of Object.values(history)) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (entry?.node_id) relevantIds.add(entry.node_id)
    }
  }
  // Awareness-as-second-class-object — chain entries on the
  // Knowledge's awareness wrapper (per-observer levels, source
  // mutations, tracking on/off) live on `awareness.history`, not on
  // `knowledge.history.*`. Walk those node_ids too so granting an
  // observer awareness at a scene establishes Knowledge presence
  // there.
  const awarenessHistory = (knowledge.awareness && typeof knowledge.awareness === 'object' && Array.isArray(knowledge.awareness.history))
    ? knowledge.awareness.history
    : null
  if (awarenessHistory) {
    for (const entry of awarenessHistory) {
      if (entry?.node_id) relevantIds.add(entry.node_id)
    }
  }
  // Manual anchors widen the chain — the user has pinned this Knowledge
  // to these scenes; the chip + chain nav include them even when no
  // history entry exists at the node yet.
  const manualAnchors = Array.isArray(knowledge.manual_anchors) ? knowledge.manual_anchors : []
  for (const a of manualAnchors) {
    if (a?.node_id) relevantIds.add(a.node_id)
  }
  if (relevantIds.size === 0) return []

  if (storyOrder && Array.isArray(storyOrder.orderedIds)) {
    const ordered = storyOrder.orderedIds.filter((id) => relevantIds.has(id))
    if (ordered.length < relevantIds.size) {
      const seen = new Set(ordered)
      for (const id of relevantIds) {
        if (!seen.has(id)) ordered.push(id)
      }
    }
    return ordered
  }
  return [...relevantIds]
}

/**
 * Resolve a Knowledge's creation point — the chain position before which
 * the Knowledge does not yet exist in the narrative.
 *
 * Phase 1.21c Step 15. The creation point is read from the canvas state:
 *   - Knowledge has a `knowledgeOriginNode` in `nodes` →
 *       creation point = the origin node's own story-order position.
 *   - No `knowledgeOriginNode` exists →
 *       creation point = null (pre-story baseline; Knowledge has existed
 *       from the start of the story).
 *
 * Returns `{ creationNodeId, creationOrderIndex }` where `creationNodeId`
 * is the origin node id (when one exists) and `creationOrderIndex` is its
 * position within `storyOrder.orderedIds` (or -Infinity when no origin
 * node exists, so any chain position is on-or-after creation).
 */
export function resolveKnowledgeCreationPoint(knowledge, nodes, _edges, storyOrder) {
  if (!knowledge) return { creationNodeId: null, creationOrderIndex: -Infinity }
  const orderIds = storyOrder?.orderedIds || []
  const origin = (nodes || []).find(
    (n) => n.type === 'knowledgeOriginNode' && n.data?.knowledge_id === knowledge.id,
  )
  if (origin) {
    const idx = orderIds.indexOf(origin.id)
    // If the origin node isn't in the story order (e.g. floating outside the
    // POV chain), the Knowledge still exists everywhere along the chain that
    // IS ordered — no exclusion. Treat as "exists from the start" for the
    // purposes of `notYetExists` filtering.
    return { creationNodeId: origin.id, creationOrderIndex: idx >= 0 ? idx : -Infinity }
  }
  // Scene-born — earliest `existence_changes: activate` event in story order
  // anchors the creation point. Mirrors the relationship pattern.
  const activates = (knowledge.history?.existence_changes || []).filter(
    (c) => c?.action === 'activate' && c?.node_id,
  )
  if (activates.length === 0) {
    return { creationNodeId: null, creationOrderIndex: -Infinity }
  }
  const activateSet = new Set(activates.map((c) => c.node_id))
  const birthId = orderIds.find((id) => activateSet.has(id)) || activates[0].node_id
  const idx = orderIds.indexOf(birthId)
  return { creationNodeId: birthId, creationOrderIndex: idx >= 0 ? idx : -Infinity }
}

/**
 * Convenience predicate: does the Knowledge exist (yet) at the given
 * chain node? Composes `resolveKnowledgeCreationPoint` with story-order
 * comparison. `atNodeId == null` represents the story origin (pre-story
 * baseline); a Knowledge with a creation point doesn't exist there
 * unless its origin node falls outside the story order entirely.
 */
export function knowledgeExistsAtNode(knowledge, atNodeId, nodes, edges, storyOrder) {
  if (!knowledge) return false
  const { creationOrderIndex } = resolveKnowledgeCreationPoint(knowledge, nodes, edges, storyOrder)
  if (creationOrderIndex === -Infinity) return true   // no origin node = pre-story baseline
  if (atNodeId == null) return false                  // querying pre-story while creation point set
  const orderIds = storyOrder?.orderedIds || []
  const atIdx = orderIds.indexOf(atNodeId)
  if (atIdx < 0) return true                          // unordered query position; don't gate
  return atIdx >= creationOrderIndex
}

/**
 * Compute the effective state of a Knowledge at chain position `atNodeId`.
 * Walks `knowledge.history` arrays (awareness_changes, name_changes,
 * description_changes, colour_changes) and applies every entry with
 * `node_id ≤ atNodeId` in `nodeOrder` sequence.
 *
 * Returns:
 *   {
 *     name, description, colour, awareness,
 *     last_modified_event: SourceEventRef | null,
 *   }
 *
 * `last_modified_event` is the `source_event` of the most recent history
 * entry (across all four arrays) up to `atNodeId`. Surfaces the "most
 * recently modified by" navigation hint in the Knowledge detail panel
 * header (populated once Step 10+ wires source_event back-pointers).
 *
 * Note: `awareness_changes` with `level=null` strip the observer key from
 * the effective awareness dict (collapses to null if empty); mirrors the
 * semantics used elsewhere in the awareness layer.
 */
export function computeKnowledgeEffectiveState(knowledge, nodeOrder, atNodeId, options = {}) {
  if (!knowledge) return null

  const nodeOrderMap = new Map((nodeOrder || []).map((id, i) => [id, i]))
  const atIdx = atNodeId && nodeOrderMap.has(atNodeId) ? nodeOrderMap.get(atNodeId) : Infinity

  function shouldApply(nodeId) {
    if (!atNodeId) return true
    return nodeOrderMap.has(nodeId) ? nodeOrderMap.get(nodeId) <= atIdx : true
  }

  // Phase 1.21c Step 15 — creation-point gating. When the caller passes
  // `options.nodes`, resolve the Knowledge's creation anchor: a
  // `<KnowledgeOriginNode>` if one exists, otherwise the earliest
  // `existence_changes: activate` scene (scene-born). Short-circuit chain
  // positions strictly before the anchor with `notYetExists: true` + null
  // awareness. When `nodes` isn't passed (back-compat for older call
  // sites) the gating is skipped.
  const optsNodes = options?.nodes
  let notYetExists = false
  let creationAnchorId = null
  if (optsNodes) {
    const origin = optsNodes.find(
      (n) => n.type === 'knowledgeOriginNode' && n.data?.knowledge_id === knowledge.id,
    )
    if (origin) {
      creationAnchorId = origin.id
    } else {
      const activates = (knowledge.history?.existence_changes || []).filter(
        (c) => c?.action === 'activate' && c?.node_id,
      )
      if (activates.length) {
        const activateSet = new Set(activates.map((c) => c.node_id))
        creationAnchorId = (nodeOrder || []).find((id) => activateSet.has(id))
          || activates[0].node_id
      }
    }
  }
  // not_yet_exists gating uses GLOBAL story-order (not the Knowledge-
  // scoped `nodeOrder`). The Knowledge-scoped order contains only scenes
  // with Knowledge events — for the canonical "Knowledge created at
  // scene 4, queried at scene 1" case, scene 1 has no Knowledge event
  // and isn't in `nodeOrder`, so the Knowledge-scoped `atIdx` would
  // fall back to `Infinity` and the gate would silently fail to fire
  // (Infinity < anchorIdx is always false). Compare via the global
  // story-order index instead so any pre-creation scene anywhere in
  // the chain correctly resolves as `not_yet_exists`. The `shouldApply`
  // function above stays Knowledge-scoped — it gates the per-event
  // walk, where only Knowledge-scoped positioning matters. Surfaced
  // 2026-05-18 by the freeform v8 blind-agent test.
  const globalOrderIds = options?.ctx?.storyOrder?.orderedIds
    || (Array.isArray(options?.ctx?.storyOrder) ? options.ctx.storyOrder : null)
  const globalOrderIndex = globalOrderIds
    ? new Map(globalOrderIds.map((id, i) => [id, i]))
    : null
  if (creationAnchorId && atNodeId != null) {
    if (globalOrderIndex) {
      const anchorGlobalIdx = globalOrderIndex.has(creationAnchorId)
        ? globalOrderIndex.get(creationAnchorId) : -Infinity
      const atGlobalIdx = globalOrderIndex.has(atNodeId)
        ? globalOrderIndex.get(atNodeId) : Infinity
      if (anchorGlobalIdx !== -Infinity && atGlobalIdx < anchorGlobalIdx) notYetExists = true
    } else {
      // Back-compat for callers that don't supply ctx.storyOrder —
      // fall back to the Knowledge-scoped check (its bug-prone but
      // matches pre-fix behaviour for any caller that didn't thread
      // storyOrder through).
      const anchorIdx = nodeOrderMap.has(creationAnchorId)
        ? nodeOrderMap.get(creationAnchorId) : -Infinity
      if (anchorIdx !== -Infinity && atIdx < anchorIdx) notYetExists = true
    }
  } else if (creationAnchorId && atNodeId == null) {
    notYetExists = true
  }

  if (notYetExists) {
    return {
      notYetExists: true,
      name: '',
      description: '',
      colour: knowledge.colour ?? '#888888',
      profile_image_ref: null,
      awareness: null,
      last_modified_event: null,
    }
  }

  // Phase 1.21g — collapse awareness wrapper to flat resolved dict at
  // state init. `options.ctx` (when provided) carries `allEntities` /
  // `allRelationships` for projection resolution; absent it, flat-dict
  // awareness still resolves identically to before this phase.
  const knowledgeAwarenessCtx = options?.ctx
    ? { nodeOrder, anchorNodeId: atNodeId, ...options.ctx }
    : { nodeOrder, anchorNodeId: atNodeId }

  const state = {
    notYetExists: false,
    name:        knowledge.name ?? '',
    description: knowledge.description ?? '',
    colour:      knowledge.colour ?? '#888888',
    profile_image_ref: knowledge.profile_image_ref ?? null,
    awareness:   resolveAwarenessField(knowledge.awareness, knowledgeAwarenessCtx),
    last_modified_event: null,
    // Phase 3.4a — baseline Project Tag membership + provenance.
    // Walked from `knowledge.tag_ids` baseline + history.tag_changes
    // below.
    tag_ids:           [...(knowledge.tag_ids || [])],
    effective_tags:    (knowledge.tag_ids || []).map((tag_id) => ({
      tag_id,
      source: 'baseline',
    })),
  }

  const history = knowledge.history || {}

  // Apply each history-array entry in STORY order, not insert order.
  // The arrays are mutated by `setKnowledgeContentChangeAtNode` /
  // `setKnowledgeAwarenessAtNode` via filter+append, which preserves
  // insertion order — so writing scene 2 then scene 1 leaves
  // `[scene2, scene1]` in the array. Without sorting, the walker
  // applies scene 2 then scene 1, so scene 1's "later" write wins
  // even when the panel queries scene 2. Sort by story-order index
  // before iterating so each field's last-applicable entry up to
  // `atNodeId` actually corresponds to the latest story-order
  // position. Entries on nodes outside `nodeOrder` sort to the end
  // (Infinity) and apply last — same as before.
  const byStoryOrder = (arr) => {
    return (arr || []).slice().sort((a, b) => {
      const ai = nodeOrderMap.has(a?.node_id) ? nodeOrderMap.get(a.node_id) : Infinity
      const bi = nodeOrderMap.has(b?.node_id) ? nodeOrderMap.get(b.node_id) : Infinity
      return ai - bi
    })
  }

  // Track "most recently modified by" across every history array.
  // Normalised-history invariants guarantee at most one entry per
  // (entity_id/field, node_id) per array, so cross-array node-id
  // matches always come from different fields — `latestApplied`
  // tracks whichever has the highest story-order index applied.
  let latestApplied = { nodeIdx: -1, source_event: null }
  function recordApplied(ch) {
    const idx = nodeOrderMap.has(ch.node_id) ? nodeOrderMap.get(ch.node_id) : -1
    if (idx > latestApplied.nodeIdx) {
      latestApplied = { nodeIdx: idx, source_event: ch.source_event ?? null }
    }
  }

  for (const ch of byStoryOrder(history.name_changes)) {
    if (shouldApply(ch.node_id)) {
      if (typeof ch.new_name === 'string') state.name = ch.new_name
      recordApplied(ch)
    }
  }
  for (const ch of byStoryOrder(history.description_changes)) {
    if (shouldApply(ch.node_id)) {
      if (typeof ch.new_description === 'string') state.description = ch.new_description
      recordApplied(ch)
    }
  }
  for (const ch of byStoryOrder(history.colour_changes)) {
    if (shouldApply(ch.node_id)) {
      if (typeof ch.new_colour === 'string') state.colour = ch.new_colour
      recordApplied(ch)
    }
  }
  for (const ch of byStoryOrder(history.profile_image_changes)) {
    if (shouldApply(ch.node_id)) {
      // null is a valid value here — clears the image at this chain
      // position. `undefined` only when the field is missing from the
      // payload (older saves), in which case skip.
      if (ch.new_profile_image_ref !== undefined) {
        state.profile_image_ref = ch.new_profile_image_ref
      }
      recordApplied(ch)
    }
  }
  // Project Tag membership — same shape as the entity / relationship
  // walkers. Tags carry no awareness; baseline-vs-chain provenance is
  // tracked on `effective_tags`. Story-order walk so out-of-order
  // history entries resolve correctly.
  for (const ch of byStoryOrder(history.tag_changes)) {
    if (!shouldApply(ch.node_id) || !ch?.tag_id) continue
    if (ch.action === 'add') {
      if (state.tag_ids.includes(ch.tag_id)) continue
      state.tag_ids = [...state.tag_ids, ch.tag_id]
      state.effective_tags = [...state.effective_tags, {
        tag_id: ch.tag_id,
        source: 'chain',
        added_at_node_id: ch.node_id || null,
      }]
      recordApplied(ch)
    } else if (ch.action === 'remove') {
      if (!state.tag_ids.includes(ch.tag_id)) continue
      state.tag_ids = state.tag_ids.filter((id) => id !== ch.tag_id)
      state.effective_tags = state.effective_tags.filter((t) => t.tag_id !== ch.tag_id)
      recordApplied(ch)
    }
  }
  // Awareness mutations — scalar dict. AwarenessRef at origin is left
  // unchanged (refs are all-or-nothing; swapping is a separate op).
  //
  // Phase 1.21h — chain-entry establishment model. `action: 'add'` events
  // mark the chain anchor where tracking comes into existence for this
  // Knowledge (mirrors `attribute_changes action: 'add'` for entity
  // attributes added mid-chain). `action: 'remove'` disables tracking
  // from that anchor forward. Per-observer entries (no `action` field)
  // only apply when tracking is on. Library-row `awareness != null`
  // means "tracking established at origin"; library-row null + an `add`
  // chain entry means "tracking established mid-chain at the entry's
  // node". Either path produces an awareness dict from the establishment
  // anchor forward.
  if (!isAwarenessRef(state.awareness)) {
    let trackingOn = state.awareness != null
    let dict = trackingOn && typeof state.awareness === 'object'
      ? { ...state.awareness }
      : {}
    // Per-anchor scale tracking: candidates come from `awareness.history`
    // (`tracking_action: 'on'` carries `awareness_scale`). Walk story
    // order; latest applicable entry wins. Baseline
    // `knowledge.awareness_scale` is the fallback when no chain entry
    // applies (mirrors the entity-walker pattern at the entity state
    // init).
    let scale = knowledge.awareness_scale ?? null
    let scaleNodeIdx = -1
    // Walk the awareness object's own chain `history`:
    //   (1) re-establish `trackingOn` from `tracking_action: 'on'/'off'`
    //       events. The wrapper walker (`applyAwarenessHistoryToWrapper`
    //       via `resolveAwarenessField` at state init) computed
    //       `tracking` correctly, but `resolveAwarenessField` collapses
    //       tracking-on-with-empty-entries to null at line 157, which
    //       fools the seed `state.awareness != null` check above. Walk
    //       tracking events here in story order; latest applicable wins.
    //   (2) capture scale from `tracking_action: 'on'` entries that
    //       carry it.
    //   (3) call `recordApplied` for every applicable entry so
    //       `latestApplied` parity is preserved. Canonical
    //       `AwarenessHistoryEntry.source_event` carries the Knowledge-
    //       attachment back-pointer when the entry was spawned by an
    //       attached event; null otherwise.
    //
    // Per-observer / source entries on `awareness.history` are NOT
    // processed here — they were already applied by the wrapper walker
    // and flow through `state.awareness` (line 1949) when entries are
    // non-empty. The bug case is only "tracking on, no observers."
    const newAwarenessHistory = isAwarenessWrapper(knowledge.awareness)
      ? (knowledge.awareness.history || [])
      : []
    const sortedNewHistory = newAwarenessHistory
      .filter((h) => h?.node_id && shouldApply(h.node_id))
      .sort((a, b) => {
        const ai = nodeOrderMap.has(a.node_id) ? nodeOrderMap.get(a.node_id) : Infinity
        const bi = nodeOrderMap.has(b.node_id) ? nodeOrderMap.get(b.node_id) : Infinity
        return ai - bi
      })
    for (const h of sortedNewHistory) {
      if (h.tracking_action === 'on') {
        trackingOn = true
        if (h.awareness_scale) {
          const idx = nodeOrderMap.has(h.node_id) ? nodeOrderMap.get(h.node_id) : Infinity
          if (idx >= scaleNodeIdx) {
            scale = h.awareness_scale
            scaleNodeIdx = idx
          }
        }
      } else if (h.tracking_action === 'off') {
        trackingOn = false
      }
      recordApplied({ node_id: h.node_id, source_event: h.source_event ?? null })
    }
    // If tracking is now on but the legacy-walker dict is still the
    // initial empty `{}` (because state.awareness was null at init),
    // ensure entries from the wrapper walker are seeded. Otherwise the
    // "tracking on, no observers" case below would emit `null` instead
    // of the empty dict the picker needs to recognise tracking-on.
    if (trackingOn && !state.awareness && isAwarenessWrapper(knowledge.awareness)) {
      const walked = applyAwarenessHistoryToWrapper(knowledge.awareness, knowledgeAwarenessCtx)
      if (walked?.entries) dict = { ...walked.entries }
    }
    state.awareness = trackingOn ? dict : null
    state.awareness_scale = scale
  }

  // ── awareness_raw — wrapper view at the anchor (entries + sources
  // without member expansion). The picker reads this to render
  // sources as chips and to detect source mutations on diff. Without
  // awareness_raw, the picker would fall back to the flat dict and
  // either (a) render source-derived participants as un-removable
  // chips (when allRelationships is in ctx), or (b) silently swallow
  // sources entirely (when it isn't). Mirrors the entity walker's
  // `finaliseAwarenessShapes` pattern.
  if (isAwarenessWrapper(knowledge.awareness)) {
    const walked = applyAwarenessHistoryToWrapper(knowledge.awareness, knowledgeAwarenessCtx)
    if (walked.tracking === false) {
      state.awareness_raw = null
    } else {
      const raw = {}
      if (Object.keys(walked.entries || {}).length > 0) raw.entries = walked.entries
      if ((walked.sources || []).length > 0) raw.sources = walked.sources
      // Tracking-on-with-empty case: surface `{}` so the picker
      // reads tracking-on rather than off. Without this branch a
      // tracking-on history event with no observers yet would
      // produce `null` and the picker would re-display as off.
      state.awareness_raw = Object.keys(raw).length > 0 ? raw : (walked.tracking ? {} : null)
    }
  } else if (knowledge.awareness && typeof knowledge.awareness === 'object' && !Array.isArray(knowledge.awareness)) {
    // Flat-dict baseline — already in the per-observer shape the
    // picker expects. Clone to avoid downstream mutation.
    state.awareness_raw = { ...knowledge.awareness }
  } else {
    state.awareness_raw = null
  }

  state.last_modified_event = latestApplied.source_event
  return state
}

/**
 * Effective awareness dict for a Knowledge at chain position Y.
 * Convenience wrapper over `computeKnowledgeEffectiveState` when the caller
 * only cares about the awareness dict.
 */
export function computeKnowledgeAwarenessAt(knowledge, atNodeId, nodeOrder) {
  const state = computeKnowledgeEffectiveState(knowledge, nodeOrder || [], atNodeId)
  return state?.awareness ?? null
}

/**
 * Return the subset of a Knowledge's awareness_changes that happen at a
 * specific node. Used by the generalised Awareness sub-chip section
 * (Step 9) to render sub-chips on observer entity chips.
 */
/**
 * Aggregate every chain-tracked Relationship history change at `nodeId`
 * where the entity is a participant. Walks each relationship in
 * `allRelationships`, calls `getRelationshipChangesAtNode` filtered to
 * the observer entity, and tags every returned change with the parent
 * relationship + relationship name. Returns a flat list ordered by
 * relationship-iteration order.
 *
 * Used by the entity Detail Panel's "Changes at this point" section to
 * surface relationship-side mutations affecting the entity at the
 * viewing chain position alongside attribute-change and awareness-
 * change rows.
 */
export function getEntityRelationshipChangesAtNode(entityId, nodeId, allRelationships, nodeOrder) {
  if (!entityId || !nodeId) return []
  const out = []
  for (const rel of (allRelationships || [])) {
    const changes = getRelationshipChangesAtNode(rel, nodeId, entityId, nodeOrder)
    for (const ch of (changes || [])) {
      // Skip relationship-level changes (existence, hierarchy, name)
      // that don't have a participant scope — those describe the
      // relationship as a whole and aren't "what happened to this
      // entity here." Per-participant changes (perception, alias,
      // role, participant join/leave) all carry an `entity_id` and
      // are the meaningful entity-scoped events.
      if (ch.type === 'existence' || ch.type === 'hierarchy' || ch.type === 'name') continue
      if (ch.entity_id !== entityId) continue
      out.push({ relationship: rel, change: ch })
    }
  }
  return out
}

/**
 * Phase 1.21c Tier 4 — gather every awareness change at a chain
 * anchor where the given entity is the OBSERVER (the entity that
 * became aware of something at this chain position).
 *
 * **Universal awareness convention.** All awareness dicts have keys =
 * OBSERVERS, values = level. Chain-time events sit on the TARGET's
 * chain anchor (the chip-entity / origin / modifier node of the
 * thing being learned about), with `entity_id` (or `list_item` for
 * attributes) holding the OBSERVER's id. To collect rows where
 * `observerEntityId` is the observer, we therefore scan OTHER
 * entities' chips / origin / modifier nodes at this chain anchor —
 * not the observer's own ref. See `Glossary.md` § "Awareness →
 * Universal direction rule" for the full convention.
 *
 * Awareness changes have four chain-tracked sources, all surfaced in
 * one unified list so the UI renders a single "Awareness" sub-chip
 * section regardless of what the observer became aware *of*:
 *
 *   1. Entity-existence — other entity refs at this node with
 *      `awareness_changes` `target='entity', entity_id=observerId`.
 *      "Observer became aware of [chip-entity = target]."
 *   2. Relationship — other entity refs at this node with
 *      `awareness_changes` `target='relationship',
 *      entity_id=observerId`. "Observer became aware of relationship."
 *   3. Attribute — other entity refs at this node with
 *      `attribute_changes` `action='awareness_set',
 *      list_item=observerId`. "Observer became aware of [chip-entity]'s
 *      attribute."
 *   4. Knowledge — `Knowledge.history.awareness_changes` filtered to
 *      entries with `entity_id == observerEntityId AND
 *      node_id == nodeId`. ("Observer became aware of knowledge.")
 *
 * Today only source 4 has a wired write path (Phase 1.21c); sources 1–3
 * are aggregation-ready for when the Phase 1.21b / Tier 5 / Tier 8
 * write paths land.
 *
 * Args:
 *   observerEntityId — the observer entity's id (scope of "what THIS
 *                      entity learned at this anchor").
 *   nodeId           — the chain anchor (scene id / origin node id /
 *                      modifier node id).
 *   allNodes         — the project's nodes array. Used to resolve other
 *                      entities' refs at this anchor.
 *   allKnowledges    — the project's `projectStore.knowledges` (source 4).
 *
 * Returns a flat array of `{ kind, ... }` records; caller orders for
 * presentation.
 */
// ─── EXTENSION POINT: adding a new awareness surface ────────────────
// If a new awareness source is added to the data model in the future
// (e.g. awareness on `Story`, on a new first-class object, on a new
// kind of change record), this function and its peers need updates:
//
//   1. `collectFromRef` below — add a new branch when the source rides
//      on an EntityRef-shaped change-set (an `awareness_changes` entry
//      with a new `target=...`, an `attribute_changes`-style discrete
//      record, or a diff-derived form like the existing alias diff).
//   2. The outer loops in this function — add a new top-level loop if
//      the source lives outside per-ref change-sets (the Knowledge
//      `history.awareness_changes` block at the bottom is a template).
//   3. Walker signature — if the new source needs context the function
//      doesn't currently receive, extend the destructured params and
//      update every call site (search: `getAwarenessChangesForObserverAtNode(`).
//   4. Renderer `AwarenessSubChip.jsx` — add a render branch keyed off
//      `record.kind === '<new_kind>'`.
//   5. Dev preview `DevPreviewPanel.jsx` `AwarenessSubChipsPage` — add
//      a row exercising the new kind so it can be reviewed in isolation.
//   6. Detail Panel sections `AwareOfSection.jsx` + `KnownBySection.jsx`
//      — these aggregate per-kind for the inverse direction (what
//      THIS entity is aware of / who is aware of THIS entity); new
//      surfaces need matching aggregation + render branches there too.
export function getAwarenessChangesForObserverAtNode({ observerEntityId, nodeId, allNodes, allEdges, allEntities, allRelationships, allKnowledges }) {
  const out = []
  if (!observerEntityId || !nodeId) return out

  const node = (allNodes || []).find((n) => n.id === nodeId)
  if (!node) return out

  // Helper — collect awareness events from one ref-shaped change-set
  // (a plot-point bucket entry, or an entity origin / modifier node's
  // `data` itself). Post awareness-as-second-class hoist (v0.2a.2.5),
  // discrete awareness chain entries live on `host.awareness.history`
  // and are walked below via `emitFromHistory`. This helper now only
  // covers the per-alias awareness diff that rides on `aliases_change`
  // (a full-replacement of the alias list with each alias carrying
  // its own awareness wrapper).
  function collectFromRef(ref, targetEntityId) {
    if (!ref || !targetEntityId || targetEntityId === observerEntityId) return

    // Per-alias awareness diff. Aliases ride on the alias object itself
    // (not on a discrete change record), so when this ref carries
    // `aliases_change` we diff each alias's awareness against the prior
    // chain-resolved state and emit one record per observer-level delta.
    //
    // Phase 1.21g — diff is performed in RESOLVED form (flat dict),
    // collapsing both direct entries and projected sources into a
    // single per-observer level. This means a level change from a
    // source mutation (e.g. Cabal added as a source on this alias at
    // this scene) shows up alongside direct-entry changes uniformly.
    // When the new resolved level for the observer comes from a
    // projection, the record carries a `via` payload pointing at the
    // projecting source so AwarenessSubChip can render the
    // "via [Cabal]" / "via [Alice avatar] Friends" indicator.
    //
    // Aliases are matched between prior and new arrays by `value`.
    // Removed aliases produce no records (the value is gone, not just
    // its awareness).
    // Per-event alias_changes (post v0.2.1.89) — awareness_set and
    // awareness_source_* events directly identify the observer + level
    // for a specific alias. The pre-v0.2.1.89 legacy `aliases_change`
    // snapshot diff branch was removed in v0.2.1.91 once all writers
    // moved to per-event emission; legacy saves load through the
    // migration shim that clears the field, so nothing reaches this
    // code path with a non-null `aliases_change` anymore.
    if (Array.isArray(ref.alias_changes) && ref.alias_changes.length > 0 && allEdges && allEntities) {
      const targetEntity = allEntities.find((e) => e.id === targetEntityId) || null
      if (targetEntity) {
        // Resolve aliases at THIS chain anchor so we can look up alias_id → value
        // for the sub-chip text (the event only carries `alias_id`).
        const eff = computeEffectiveState(
          targetEntity, allNodes, allEdges, nodeId,
          { allEntities, allRelationships },
        )
        const aliasById = new Map()
        for (const a of (eff?.aliases || [])) {
          if (a && typeof a === 'object' && a.id) aliasById.set(a.id, a)
        }
        const projCtx = { allEntities, allRelationships, nodes: allNodes, edges: allEdges, anchorNodeId: nodeId }
        for (const ev of ref.alias_changes) {
          if (!ev || typeof ev !== 'object') continue
          const aliasId = ev.alias_id
          if (!aliasId) continue
          const alias = aliasById.get(aliasId)
          if (!alias) continue
          if (ev.action === 'awareness_set') {
            // Only this observer's mutations are interesting.
            if (ev.observer_id !== observerEntityId) continue
            out.push({
              kind: 'alias',
              changeId: `alias:${targetEntityId}:${alias.value}:${nodeId}:${ev.id || ev.observer_id}`,
              targetEntityId,
              aliasValue: alias.value,
              level: (ev.level === undefined || ev.level === null) ? null : ev.level,
            })
          } else if (
            ev.action === 'awareness_source_add' ||
            ev.action === 'awareness_source_set_level' ||
            ev.action === 'awareness_source_remove'
          ) {
            // Source mutations: emit a record only when THIS observer
            // is projected through the source (membership check), the
            // resolved level changes for them, and the source's level
            // matches the resolved level (i.e. this source is the one
            // contributing the level — mirrors the legacy diff's `via`
            // trace logic). `_source_*_remove` is handled by walking
            // prior-vs-new resolved state at the anchor.
            const aliasRaw = alias.awareness_raw ?? alias.awareness ?? null
            const resolved = resolveAwarenessField(aliasRaw, projCtx) || {}
            const resolvedLvl = resolved[observerEntityId]
            if (resolvedLvl === undefined || resolvedLvl === null) continue
            const src = ev.source
            if (!src) continue
            const members = resolveSourceMembership(src, projCtx)
            if (!members.includes(observerEntityId)) continue
            // Only the source whose level matches the resolved level
            // for this observer wins the `via` slot (the existing
            // chip-display convention).
            if (src.level !== resolvedLvl) continue
            out.push({
              kind: 'alias',
              changeId: `alias:${targetEntityId}:${alias.value}:${nodeId}:${ev.id || 'src'}`,
              targetEntityId,
              aliasValue: alias.value,
              level: resolvedLvl,
              via: src,
            })
          }
        }
      }
    }
  }

  if (node.type === 'sceneNode') {
    for (const bucket of ENTITY_BUCKETS) {
      for (const ref of (node.data?.[bucket] || [])) {
        collectFromRef(ref, ref.entity_id)
      }
    }
  } else if (node.type === 'entityNode') {
    // Origin / modifier node — its own `data` carries the change-set.
    collectFromRef(node.data, node.data?.entity_id)

    // Phase 1.21g — origin-node baseline awareness emission. At origin
    // (chain-position 0) no chain-time mutations have happened yet, but
    // the entity ALREADY has whatever awareness other surfaces have
    // recorded on it (others' Entity.awareness keyed on this observer,
    // alias awareness, attribute awareness, etc.). Surface those as
    // sub-chip records so the observer's origin chip reads as the
    // "from origin onward, you know X" baseline. Scene chips don't
    // need this — chain-time mutations carry the diff downstream.
    if (!node.data?.is_modifier && node.data?.entity_id && allEntities) {
      const projCtx = { allEntities, allRelationships, nodes: allNodes, edges: allEdges, anchorNodeId: nodeId }

      // Helper: trace which projected source (if any) contributes the
      // resolved level for `observerEntityId` on a wrapper. Used to set
      // the `via` payload on baseline records.
      const traceVia = (rawAwareness, level) => {
        if (level == null) return null
        if (!rawAwareness || typeof rawAwareness !== 'object' || Array.isArray(rawAwareness)) return null
        // Direct entry wins over projection.
        const directDict = Object.prototype.hasOwnProperty.call(rawAwareness, 'entries')
          ? (rawAwareness.entries || null)
          : (Object.prototype.hasOwnProperty.call(rawAwareness, 'sources') ? null : rawAwareness)
        if (directDict && Object.prototype.hasOwnProperty.call(directDict, observerEntityId)) return null
        const sources = Array.isArray(rawAwareness.sources) ? rawAwareness.sources : null
        if (!sources) return null
        for (const src of sources) {
          if (src.level !== level) continue
          const members = resolveSourceMembership(src, projCtx)
          if (members.includes(observerEntityId)) return src
        }
        return null
      }

      const emitBaselineRecord = (rawAwareness, partial) => {
        const resolved = resolveAwarenessField(rawAwareness, projCtx) || {}
        const lvl = resolved[observerEntityId]
        if (lvl === undefined) return
        const via = traceVia(rawAwareness, lvl)
        out.push({
          ...partial,
          changeId: `${partial.kind}-baseline-${partial.targetEntityId || partial.relationshipId || partial.knowledgeId || 'x'}-${partial.attributeId || partial.aliasValue || partial.awarenessFieldPath || ''}`,
          level: lvl,
          ...(via ? { via: via.kind === 'relationship'
            ? { kind: 'relationship', relationship_id: via.relationship_id }
            : { kind: 'attribute', entity_id: via.entity_id, attribute_id: via.attribute_id } } : {}),
        })
      }

      for (const ent of allEntities) {
        if (!ent || !ent.id || ent.id === observerEntityId) continue
        emitBaselineRecord(ent.awareness, {
          kind: 'entity_existence', targetEntityId: ent.id, awarenessFieldPath: 'awareness',
        })
        emitBaselineRecord(ent.name_awareness, {
          kind: 'entity_name', targetEntityId: ent.id, awarenessFieldPath: 'name_awareness',
        })
        for (const attr of (ent.attributes || [])) {
          if (!attr?.id) continue
          emitBaselineRecord(attr.awareness, {
            kind: 'attribute', targetEntityId: ent.id, attributeId: attr.id,
          })
        }
        for (const alias of (ent.aliases || [])) {
          if (alias == null || typeof alias === 'string') continue
          if (!alias.value) continue
          emitBaselineRecord(alias.awareness, {
            kind: 'alias', targetEntityId: ent.id, aliasValue: alias.value,
          })
        }
      }
      for (const rel of (allRelationships || [])) {
        if (!rel || !rel.id) continue
        emitBaselineRecord(rel.awareness, {
          kind: 'relationship', relationshipId: rel.id,
        })
      }
    }
  }

  // Awareness-as-second-class-object model — walk every awareness
  // object's own `history` list and emit records for entries whose
  // `node_id === nodeId` AND EITHER:
  //   - `observer_id === observerEntityId` (direct change), OR
  //   - `observer_id` is a faction observerEntityId inherits from
  //     via that faction's membership relationship (Rule 2 cascade), OR
  //   - `h.source` is a relationship / attribute source whose
  //     membership includes observerEntityId (Rule 3 / Rule 4 cascade).
  //
  // Inheritance pickups carry a `via` payload so the sub-chip can
  // render "(via Sigma Pi Brothers Members)" rather than reading as
  // a direct mutation. Mirrors the inheritance behaviour the
  // observer-side resolver in `resolveObserverAwarenessLevel` already
  // applies; without this, faction-membership awareness changes
  // wouldn't surface as "changes at this point" for the inheriting
  // member, even though the member's effective awareness HAS changed.
  const _inhProjCtx = { allEntities, allRelationships, nodes: allNodes, edges: allEdges, anchorNodeId: nodeId }
  const _inheritedViaObserverKey = (observerKey) => {
    if (!observerKey || observerKey === observerEntityId) return null
    const ent = (allEntities || []).find((e) => e?.id === observerKey)
    if (!ent || ent.type !== 'faction') return null
    const membershipRel = (allRelationships || []).find((r) => r?.membership_of === ent.id)
    if (!membershipRel) return null
    if (_observerIsParticipantInRelationship(observerEntityId, membershipRel, _inhProjCtx)) {
      return { kind: 'relationship', relationship_id: membershipRel.id }
    }
    return null
  }
  const _inheritedViaSource = (source) => {
    if (!source) return null
    const members = resolveSourceMembership(source, _inhProjCtx)
    if (!members.includes(observerEntityId)) return null
    if (source.kind === 'relationship') {
      return { kind: 'relationship', relationship_id: source.relationship_id }
    }
    if (source.kind === 'attribute') {
      return { kind: 'attribute', entity_id: source.entity_id, attribute_id: source.attribute_id }
    }
    return null
  }
  const emittedIds = new Set(out.map((r) => r?.changeId).filter(Boolean))
  const emitFromHistory = (history, makeRecord) => {
    if (!Array.isArray(history)) return
    for (const h of history) {
      if (!h) continue
      if (h.node_id !== nodeId) continue
      // Direct path — existing behaviour.
      if (h.observer_id === observerEntityId) {
        if (h.id && emittedIds.has(h.id)) continue
        const rec = makeRecord(h)
        if (!rec) continue
        out.push(rec)
        if (h.id) emittedIds.add(h.id)
        continue
      }
      // Phase 2.12 — Rule 2 inheritance: faction direct-entry event
      // where the inheriting member is observerEntityId.
      const viaKey = h.observer_id ? _inheritedViaObserverKey(h.observer_id) : null
      if (viaKey) {
        const inhId = h.id ? `${h.id}:inh:${viaKey.relationship_id}` : null
        if (inhId && emittedIds.has(inhId)) continue
        const rec = makeRecord(h)
        if (rec) {
          rec.changeId = inhId || `inh:${viaKey.relationship_id}:${nodeId}`
          rec.via = viaKey
          out.push(rec)
          if (inhId) emittedIds.add(inhId)
        }
        continue
      }
      // Phase 2.12 — Rule 3 / Rule 4 inheritance: source-based event
      // (awareness_source_add / awareness_source_set_level) where
      // observerEntityId is a member of the source's membership.
      const viaSrc = h.source ? _inheritedViaSource(h.source) : null
      if (viaSrc) {
        const inhId = h.id ? `${h.id}:inh:src` : null
        if (inhId && emittedIds.has(inhId)) continue
        const rec = makeRecord(h)
        if (rec) {
          rec.changeId = inhId || `inh:src:${nodeId}`
          rec.via = viaSrc
          out.push(rec)
          if (inhId) emittedIds.add(inhId)
        }
      }
    }
  }
  for (const ent of (allEntities || [])) {
    if (!ent || !ent.id || ent.id === observerEntityId) continue
    const baseRecord = (kind, extra) => (h) => ({
      kind,
      changeId: h.id,
      targetEntityId: ent.id,
      level: h.level ?? null,
      ...extra,
    })
    emitFromHistory(ent.awareness?.history, baseRecord('entity_existence'))
    emitFromHistory(ent.name_awareness?.history, baseRecord('entity_name'))
    for (const attr of (ent.attributes || [])) {
      if (!attr?.id) continue
      emitFromHistory(attr.awareness?.history, baseRecord('attribute', { attributeId: attr.id }))
    }
    for (const a of (ent.aliases || [])) {
      if (a == null || typeof a === 'string') continue
      if (!a.value) continue
      emitFromHistory(a.awareness?.history, baseRecord('alias', { aliasValue: a.value }))
    }
  }
  for (const rel of (allRelationships || [])) {
    if (!rel?.id) continue
    emitFromHistory(rel.awareness?.history, (h) => ({
      kind: 'relationship',
      changeId: h.id,
      relationshipId: rel.id,
      level: h.level ?? null,
    }))
  }
  for (const k of (allKnowledges || [])) {
    if (!k?.id) continue
    emitFromHistory(k.awareness?.history, (h) => ({
      kind: 'knowledge',
      changeId: h.id,
      knowledgeId: k.id,
      knowledge: k,
      level: h.level ?? null,
    }))
  }

  // Phase 1.21g — Source 5: membership-shift sub-chips on the OBSERVER side.
  // When this observer joins a relationship at this scene (or is added to an
  // entity_list attribute at this scene) AND that source is referenced as a
  // projected awareness source on some carrier surface, the observer
  // becomes aware of the carrier from this scene onward via that source.
  // Emit one sub-chip record per (consumer × event) so the observer sees
  // every awareness gain attributable to membership shifts.
  if (allEntities) {
    const consumerIndex = buildAwarenessSourceConsumers(allEntities, allRelationships, allKnowledges, allNodes)
    if (consumerIndex.size > 0) {
      // Helper: resolve a consumer descriptor into a sub-chip record.
      // Returns a partial record (caller fills in `via`).
      const recordForConsumer = (consumer, level) => {
        if (consumer.surfaceKind === 'entity' && consumer.awarenessFieldPath === 'awareness') {
          return { kind: 'entity_existence', targetEntityId: consumer.surfaceId, level }
        }
        if (consumer.surfaceKind === 'entity' && consumer.awarenessFieldPath === 'name_awareness') {
          return { kind: 'entity_name', targetEntityId: consumer.surfaceId, level }
        }
        if (consumer.surfaceKind === 'attribute') {
          return { kind: 'attribute', targetEntityId: consumer.parentEntityId, attributeId: consumer.surfaceId, level }
        }
        if (consumer.surfaceKind === 'alias') {
          return { kind: 'alias', targetEntityId: consumer.parentEntityId, aliasValue: consumer.surfaceId, level }
        }
        if (consumer.surfaceKind === 'relationship') {
          return { kind: 'relationship', relationshipId: consumer.surfaceId, level }
        }
        if (consumer.surfaceKind === 'knowledge') {
          const k = (allKnowledges || []).find((kk) => kk.id === consumer.surfaceId) || null
          return { kind: 'knowledge', knowledgeId: consumer.surfaceId, knowledge: k, level }
        }
        return null
      }

      // Relationship joins: walk every relationship's participant_changes
      // for action='join', node_id === nodeId, entity_id === observerEntityId.
      for (const rel of (allRelationships || [])) {
        const joins = (rel.history?.participant_changes || []).filter(
          (c) => c?.action === 'join' && c?.node_id === nodeId && c?.entity_id === observerEntityId,
        )
        if (joins.length === 0) continue
        const consumers = consumerIndex.get(`rel:${rel.id}`)
        if (!consumers || consumers.size === 0) continue
        for (const consumer of consumers) {
          const partial = recordForConsumer(consumer, consumer.sourceLevel ?? null)
          if (!partial) continue
          out.push({
            ...partial,
            changeId: `via-rel:${rel.id}:${consumer.surfaceKind}:${consumer.surfaceId}:${consumer.awarenessFieldPath}:${nodeId}`,
            via: { kind: 'relationship', relationship_id: rel.id },
          })
        }
      }

      // Entity-list attribute additions: scan this scene's EntityRefs (and
      // origin / modifier EntityNode data) for attribute_changes with
      // action='list_add' AND list_item === observerEntityId AND the
      // (carrier_entity_id, attribute_id) is referenced as a source.
      const visitListAdds = (carrierEntityId, attrChanges) => {
        if (!carrierEntityId || !attrChanges) return
        const owner = allEntities.find((e) => e.id === carrierEntityId)
        for (const ac of attrChanges) {
          if (ac?.action !== 'list_add') continue
          if (ac?.list_item !== observerEntityId) continue
          if (!ac?.attribute_id) continue
          const attr = (owner?.attributes || []).find((a) => a.id === ac.attribute_id)
          if (!attr || attr.attribute_type !== 'entity_list') continue
          const consumers = consumerIndex.get(`attr:${carrierEntityId}:${ac.attribute_id}`)
          if (!consumers || consumers.size === 0) continue
          for (const consumer of consumers) {
            const partial = recordForConsumer(consumer, consumer.sourceLevel ?? null)
            if (!partial) continue
            out.push({
              ...partial,
              changeId: `via-attr:${carrierEntityId}:${ac.attribute_id}:${consumer.surfaceKind}:${consumer.surfaceId}:${consumer.awarenessFieldPath}:${nodeId}`,
              via: { kind: 'attribute', entity_id: carrierEntityId, attribute_id: ac.attribute_id },
            })
          }
        }
      }
      if (node.type === 'sceneNode') {
        for (const bucket of ENTITY_BUCKETS) {
          for (const ref of (node.data?.[bucket] || [])) {
            visitListAdds(ref.entity_id, ref.attribute_changes)
          }
        }
      } else if (node.type === 'entityNode') {
        visitListAdds(node.data?.entity_id, node.data?.attribute_changes)
      }
    }
  }

  // Phase 1.21g — collapse duplicate records that describe the same
  // observer / target / via triple. The membership-shift block (Source 5)
  // and the chain-time source-mutation block (Source 1, source_action
  // events) can both fire for the same observer at the same scene when
  // an observer joins a relationship at scene N AND the same relationship
  // also has a source-level / source-add / source-remove mutation
  // recorded on the carrier surface at scene N. The source-mutation
  // record carries the post-mutation level (the level the observer
  // actually has at this anchor) so it wins; the membership-shift
  // record (which always uses the base source-descriptor level from
  // the reverse index) is dropped.
  return _dedupeAwarenessRecords(out)
}

function _awarenessRecordKey(rec) {
  if (!rec) return ''
  const viaKind = rec.via?.kind || ''
  const viaId   = rec.via?.relationship_id || rec.via?.attribute_id || ''
  const viaEnt  = rec.via?.entity_id || ''
  const target  = rec.targetEntityId || rec.relationshipId || rec.knowledgeId || ''
  const sub     = rec.attributeId || rec.aliasValue || ''
  return `${rec.kind}|${target}|${sub}|${viaKind}|${viaEnt}|${viaId}`
}

function _dedupeAwarenessRecords(records) {
  if (!Array.isArray(records) || records.length < 2) return records
  const isMembershipShift = (rec) => typeof rec.changeId === 'string' && (
    rec.changeId.startsWith('via-rel:') || rec.changeId.startsWith('via-attr:')
  )
  const byKey = new Map()
  for (const rec of records) {
    const key = _awarenessRecordKey(rec)
    if (!key) { byKey.set(Symbol(), rec); continue }
    const existing = byKey.get(key)
    if (!existing) { byKey.set(key, rec); continue }
    // Prefer the source-mutation record over the membership-shift record.
    if (isMembershipShift(existing) && !isMembershipShift(rec)) {
      byKey.set(key, rec)
    }
    // Otherwise keep the existing record (first-write or both are
    // source-mutation / both are membership-shift — same level either way).
  }
  return Array.from(byKey.values())
}

/**
 * Phase 1.21g — sub-chip records for a RELATIONSHIP that is acting as a
 * projected awareness source at a given scene. Mirror of
 * `getAwarenessChangesForObserverAtNode` but emitted from the SOURCE
 * side: each record reads "I am now propagating awareness of
 * [target] at level [N]" — the relationship is the source/contributor,
 * the target is the carrier surface that gained the relationship as a
 * source via a chain-time mutation at this scene.
 *
 * Currently detects per-alias source additions only — alias source
 * mutations ride on `aliases_change` (the per-alias diff approach we
 * use for the observer-side walker). Source additions on entity /
 * canonical-name / per-attribute awareness aren't yet wired at chain
 * anchors (per the v0.1.21.83 / v0.1.21.86 known-limitations notes);
 * this function will pick those up automatically when those mutations
 * land via the awareness_changes / attribute_changes language.
 *
 * Returns the same record shape as the observer-side walker so the
 * existing `AwarenessSubChip` component renders without any branching:
 *   { kind: 'alias', changeId, targetEntityId, aliasValue, level, ... }
 */
// eslint-disable-next-line no-unused-vars
export function getRelationshipSourceContributionsAtNode({ relationshipId, nodeId, allNodes, allEdges, allEntities, allRelationships, allKnowledges }) {
  const out = []
  if (!relationshipId || !nodeId) return out
  const node = (allNodes || []).find((n) => n.id === nodeId)
  if (!node) return out

  // Helper: scan an EntityRef-shaped object for chain-time mutations
  // that introduce / re-level THIS relationship as an awareness source
  // on any of the carrier's surfaces. Two sources of events:
  //   1. Per-event `alias_changes` with awareness_source_add /
  //      awareness_source_set_level actions whose source's
  //      `relationship_id` matches. Also `add` events whose baked-in
  //      alias awareness wrapper already carries the relationship as
  //      a source.
  //   2. `awareness_changes` with `source_action` — direct chain-time
  //      source mutations on entity-existence / canonical-name /
  //      per-relationship awareness fields (handled by the canonical
  //      `emitFromHistory` walker below, not here).
  function collectFromRef(ref, carrierEntityId) {
    if (!ref || !carrierEntityId) return
    // Per-event alias_changes path — find awareness_source_add /
    // awareness_source_set_level events targeting this relationship,
    // and add-event-baked relationship sources.
    if (Array.isArray(ref.alias_changes) && ref.alias_changes.length > 0) {
      // Resolve alias_id → value via the same ref's add events.
      const valueByAliasId = new Map()
      for (const ev of ref.alias_changes) {
        if (ev?.action === 'add' && ev.alias?.id && ev.alias.value) {
          valueByAliasId.set(ev.alias.id, ev.alias.value)
        }
      }
      for (const ev of ref.alias_changes) {
        if (!ev || typeof ev !== 'object') continue
        if (ev.action === 'add' && ev.alias) {
          const aliasValue = ev.alias.value
          if (!aliasValue) continue
          for (const src of _wrapperSources(ev.alias.awareness)) {
            if (src.kind !== 'relationship') continue
            if (src.relationship_id !== relationshipId) continue
            out.push({
              kind: 'alias',
              changeId: `relsrc:${relationshipId}:alias:${carrierEntityId}:${aliasValue}:${nodeId}:${ev.id || 'add'}`,
              targetEntityId: carrierEntityId,
              aliasValue,
              level: src.level,
            })
          }
        } else if (
          ev.action === 'awareness_source_add' ||
          ev.action === 'awareness_source_set_level'
        ) {
          const src = ev.source
          if (!src || src.kind !== 'relationship' || src.relationship_id !== relationshipId) continue
          const aliasValue = valueByAliasId.get(ev.alias_id)
          if (!aliasValue) continue
          out.push({
            kind: 'alias',
            changeId: `relsrc:${relationshipId}:alias:${carrierEntityId}:${aliasValue}:${nodeId}:${ev.id || 'src'}`,
            targetEntityId: carrierEntityId,
            aliasValue,
            level: src.level,
          })
        }
      }
    }

    // Post v0.2a.2.5: discrete chain-time source mutations on
    // entity / entity_name / relationship / per-attribute awareness
    // live on `host.awareness.history` and are emitted by the
    // `emitFromHistory` walker below.
  }

  if (node.type === 'sceneNode') {
    for (const bucket of ENTITY_BUCKETS) {
      for (const ref of (node.data?.[bucket] || [])) {
        collectFromRef(ref, ref.entity_id)
      }
    }
  } else if (node.type === 'entityNode') {
    collectFromRef(node.data, node.data?.entity_id)
  }

  // Awareness-as-second-class-object model — walk every awareness
  // object's own `history` list and emit source-mutation records that
  // reference THIS relationship as a contributor at this node. Same
  // record shape as the legacy collectFromRef paths above; dedup by
  // changeId so the migration's copy-not-move state doesn't double-emit.
  const emittedIds = new Set(out.map((r) => r?.changeId).filter(Boolean))
  const emitFromHistory = (history, makeRecord) => {
    if (!Array.isArray(history)) return
    for (const h of history) {
      if (!h) continue
      if (h.node_id !== nodeId) continue
      if (!h.source_action || !h.source) continue
      if (h.source.kind !== 'relationship') continue
      if (h.source.relationship_id !== relationshipId) continue
      if (h.id && emittedIds.has(h.id)) continue
      const lvl = h.source_action === 'remove' ? null : (h.source.level ?? null)
      const rec = makeRecord(h, lvl)
      if (!rec) continue
      out.push(rec)
      if (h.id) emittedIds.add(h.id)
    }
  }
  for (const ent of (allEntities || [])) {
    if (!ent || !ent.id) continue
    emitFromHistory(ent.awareness?.history, (h, lvl) => ({
      kind: 'entity_existence',
      changeId: h.id,
      targetEntityId: ent.id,
      level: lvl,
    }))
    emitFromHistory(ent.name_awareness?.history, (h, lvl) => ({
      kind: 'entity_name',
      changeId: h.id,
      targetEntityId: ent.id,
      level: lvl,
    }))
    for (const attr of (ent.attributes || [])) {
      if (!attr?.id) continue
      emitFromHistory(attr.awareness?.history, (h, lvl) => ({
        kind: 'attribute',
        changeId: h.id,
        targetEntityId: ent.id,
        attributeId: attr.id,
        level: lvl,
      }))
    }
    for (const a of (ent.aliases || [])) {
      if (a == null || typeof a === 'string') continue
      if (!a.value) continue
      emitFromHistory(a.awareness?.history, (h, lvl) => ({
        kind: 'alias',
        changeId: h.id,
        targetEntityId: ent.id,
        aliasValue: a.value,
        level: lvl,
      }))
    }
  }
  for (const rel of (allRelationships || [])) {
    if (!rel?.id) continue
    if (rel.id === relationshipId) continue
    emitFromHistory(rel.awareness?.history, (h, lvl) => ({
      kind: 'relationship',
      changeId: h.id,
      relationshipId: rel.id,
      level: lvl,
    }))
  }
  for (const k of (allKnowledges || [])) {
    if (!k?.id) continue
    emitFromHistory(k.awareness?.history, (h, lvl) => ({
      kind: 'knowledge',
      changeId: h.id,
      knowledgeId: k.id,
      knowledge: k,
      level: lvl,
    }))
  }

  return out
}

function _wrapperSources(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  if (Array.isArray(raw.sources)) return raw.sources
  return []
}


// ── Phase 1.22 — scene-side circumstance pool aggregator ──────────────────
//
// Returns the unified "what's going on at this scene" circumstance pool
// the writer reads in the Scene Detail Panel's Circumstances sub-tab and
// the Scene Detail Panel's per-entity rollup. Two parts:
//
//   - sceneLevel: the scene's own Scene.circumstances list, exactly as
//                 stored on the SceneNode (a property of the scene at
//                 its single chain position; not chain-tracked across
//                 entity narratives).
//
//   - perEntity:  for every entity present in the scene's chip lists,
//                 the chain-resolved circumstance and motivator
//                 attributes carried by that entity at THIS scene. Walks
//                 the entity's chain from origin to this scene via the
//                 existing computeEffectiveState walker — chain-aware
//                 by design.
//
// Returns: {
//   sceneLevel: Array<Circumstance>,
//   perEntity:  Array<{
//     entityId: string,
//     bucket:   'characters' | 'locations' | 'items' | 'factions' | 'customs',
//     circumstances: Array<Attribute>,  // chain-resolved at this scene
//     motivators:    Array<Attribute>,  // chain-resolved at this scene
//   }>,
// }
//
// Entities with no carried circumstances or motivators are still
// included in `perEntity` (with empty arrays) so the Scene Detail
// Panel's Per-entity section can render "(none)" rows — letting the
// writer see who has been considered.
export function computeSceneEffectiveCircumstancePool(scene, allEntities, nodes, edges) {
  if (!scene) return { sceneLevel: [], perEntity: [] }

  const sceneLevel = Array.isArray(scene.circumstances) ? scene.circumstances : []

  const buckets = ['characters', 'locations', 'items', 'factions', 'customs']
  const perEntity = []
  const allEntitiesById = new Map((allEntities || []).map((e) => [e.id, e]))

  for (const bucket of buckets) {
    const refs = scene[bucket] || []
    for (const ref of refs) {
      const entity = allEntitiesById.get(ref.entity_id)
      if (!entity) continue
      // Chain-aware read of the entity's effective state at THIS scene.
      // computeEffectiveState walks the chain from the entity's origin
      // through every modifier up to (and applying) this scene anchor.
      const effective = computeEffectiveState(entity, nodes, edges, scene.id) || {
        attributes: entity.attributes || [],
      }
      const attrs = Array.isArray(effective.attributes) ? effective.attributes : []
      perEntity.push({
        entityId: entity.id,
        bucket,
        circumstances: attrs.filter((a) => a?.attribute_type === 'circumstance'),
        motivators:    attrs.filter((a) => a?.attribute_type === 'motivator'),
      })
    }
  }

  return { sceneLevel, perEntity }
}
