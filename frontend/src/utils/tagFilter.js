/**
 * Phase 2.6 — Tag filter predicate (modular foundations).
 *
 * Pure, object-type-agnostic, no React, no store reads. Anything with a
 * `tags: string[]` field can be filtered by these helpers. Initial
 * consumers: conversation thread browser (Phase 2.6) and the Context
 * Cue Library (Phase 2.7). Any future taggable object type adopts the
 * same predicate and the same UI components without touching this
 * module.
 *
 * ### Filter shape
 *
 * `filterState` is `{ and: string[], or: string[], not: string[] }`.
 * Per the cloud's cycling model (`OFF → AND → OR → NOT → OFF`) each
 * tag lives in EXACTLY one of those three buckets at a time, or in
 * none of them (the `OFF` state simply doesn't appear). The three
 * arrays must therefore be disjoint in practice; this predicate
 * doesn't enforce that — feed in a contradictory state (same tag in
 * both AND and NOT) and the NOT bucket wins (the thread is excluded).
 *
 * ### Formal semantics (planning doc Filter logic — formal)
 *
 * Let `A = and`, `O = or`, `N = not`. A tagged object `t` matches when:
 *
 *     t.tags ⊇ A                          (has every AND-required tag)
 *   AND  (O empty OR t.tags ∩ O ≠ ∅)      (has at least one OR-allowed
 *                                          tag, if any OR tags are set)
 *   AND  t.tags ∩ N = ∅                   (has none of the NOT-excluded
 *                                          tags)
 *
 * Empty `A` / `O` / `N` are no-ops on their respective predicates
 * (empty AND-set is vacuously satisfied; absent OR constraint; no
 * NOT exclusion). All three empty → predicate is `true` for every
 * input.
 *
 * ### Case-insensitive matching
 *
 * Tags are compared lower-cased per the planning doc:
 *   "Lower-cased for matching, displayed with original casing."
 * The predicate normalises both the object's tags and the filter
 * arrays before comparing.
 */

function _normalise(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const t of list) {
    if (typeof t !== 'string') continue
    const trimmed = t.trim()
    if (!trimmed) continue
    out.push(trimmed.toLowerCase())
  }
  return out
}

/**
 * Returns true if `taggedObject` satisfies `filterState`.
 *
 * `taggedObject` is any object with a `tags: string[]` field. Other
 * fields are ignored — this predicate has no notion of conversation,
 * cue, or any object type.
 *
 * `filterState` is `{ and, or, not }` — missing fields are treated as
 * empty arrays so a partial filter (e.g. `{ and: ['foo'] }`) works.
 */
export function matchesTagFilter(taggedObject, filterState) {
  const objTags = new Set(_normalise(taggedObject?.tags))
  const and = _normalise(filterState?.and)
  const or = _normalise(filterState?.or)
  const not = _normalise(filterState?.not)

  // Has every AND-required tag.
  for (const t of and) {
    if (!objTags.has(t)) return false
  }
  // Has none of the NOT-excluded tags.
  for (const t of not) {
    if (objTags.has(t)) return false
  }
  // Has at least one OR-allowed tag (only when OR set is non-empty).
  if (or.length > 0) {
    let found = false
    for (const t of or) {
      if (objTags.has(t)) { found = true; break }
    }
    if (!found) return false
  }
  return true
}

/**
 * Merge two or more `filterState` objects into a single composite
 * filter. Set-union per bucket: the resulting AND contains every
 * AND tag from every input; same for OR and NOT.
 *
 * Useful for future composite-filter scenarios where multiple
 * independent UI surfaces contribute constraints (e.g. a global
 * "always-applied" tag filter combined with the cloud's
 * per-session state). Tags are normalised (trimmed, lower-cased,
 * deduped) before being merged so two surfaces using different
 * casings of the same tag don't double-count.
 */
export function mergeTagFilterStates(...states) {
  const and = new Set()
  const or = new Set()
  const not = new Set()
  for (const s of states) {
    if (!s) continue
    for (const t of _normalise(s.and)) and.add(t)
    for (const t of _normalise(s.or)) or.add(t)
    for (const t of _normalise(s.not)) not.add(t)
  }
  return {
    and: Array.from(and),
    or: Array.from(or),
    not: Array.from(not),
  }
}

/**
 * The empty filter — accepts every tagged object. Exported as a
 * shared module-level constant so consumers can use it as the
 * `useState` initial value without each rebuilding the same shape.
 * Frozen so a consumer that accidentally mutates the value won't
 * corrupt the shared instance.
 */
export const EMPTY_TAG_FILTER = Object.freeze({
  and: Object.freeze([]),
  or: Object.freeze([]),
  not: Object.freeze([]),
})

/**
 * Returns true when the filter is the no-op filter — every bucket
 * empty. UI uses this to decide whether to render "clear filter"
 * affordances and to skip per-row filter calls entirely on big
 * lists.
 */
export function isEmptyTagFilter(filterState) {
  if (!filterState) return true
  const a = filterState.and
  const o = filterState.or
  const n = filterState.not
  const aLen = Array.isArray(a) ? a.length : 0
  const oLen = Array.isArray(o) ? o.length : 0
  const nLen = Array.isArray(n) ? n.length : 0
  return aLen === 0 && oLen === 0 && nLen === 0
}

/**
 * Cycle a single tag's state in a filter through the canonical
 * `OFF → AND → OR → NOT → OFF` sequence. Returns the next
 * `filterState`. The caller decides when to commit the new state
 * (typical pattern: hold filter state in `uiStore`, click on a
 * tag chip calls this and saves the result).
 *
 * Tag membership is checked case-insensitively against the buckets;
 * the original casing is preserved in whichever bucket the tag
 * lands in. If the tag is already present in multiple buckets
 * (shouldn't happen in well-formed state but is tolerated), it's
 * removed from all buckets first and then placed in the next
 * bucket per the cycle.
 */
export function cycleTagState(filterState, tag) {
  const state = filterState || EMPTY_TAG_FILTER
  const tagLower = (tag || '').trim().toLowerCase()
  if (!tagLower) return state

  const isIn = (bucket) =>
    Array.isArray(bucket) && bucket.some((t) => (t || '').toLowerCase() === tagLower)
  const stripFrom = (bucket) =>
    Array.isArray(bucket)
      ? bucket.filter((t) => (t || '').toLowerCase() !== tagLower)
      : []

  const cleanAnd = stripFrom(state.and)
  const cleanOr = stripFrom(state.or)
  const cleanNot = stripFrom(state.not)

  // Determine current state by checking the ORIGINAL filter buckets
  // (not the stripped copies). When a tag is in multiple buckets via
  // contradictory writes, fall through to OFF as a defensive reset.
  const inAnd = isIn(state.and)
  const inOr = isIn(state.or)
  const inNot = isIn(state.not)
  const multiBucket = (inAnd ? 1 : 0) + (inOr ? 1 : 0) + (inNot ? 1 : 0) > 1

  let nextState
  if (multiBucket) {
    // Contradictory entry — reset to OFF instead of guessing which
    // bucket to cycle from.
    nextState = 'OFF'
  } else if (inAnd) {
    nextState = 'OR'
  } else if (inOr) {
    nextState = 'NOT'
  } else if (inNot) {
    nextState = 'OFF'
  } else {
    nextState = 'AND'
  }

  switch (nextState) {
    case 'AND':
      return { and: [...cleanAnd, tag.trim()], or: cleanOr, not: cleanNot }
    case 'OR':
      return { and: cleanAnd, or: [...cleanOr, tag.trim()], not: cleanNot }
    case 'NOT':
      return { and: cleanAnd, or: cleanOr, not: [...cleanNot, tag.trim()] }
    case 'OFF':
    default:
      return { and: cleanAnd, or: cleanOr, not: cleanNot }
  }
}

/**
 * Return the current state of `tag` in `filterState` as one of
 * `'OFF' | 'AND' | 'OR' | 'NOT'`. UI components use this to decide
 * a chip's visual state. Case-insensitive lookup.
 */
export function tagStateOf(filterState, tag) {
  const state = filterState || EMPTY_TAG_FILTER
  const tagLower = (tag || '').trim().toLowerCase()
  if (!tagLower) return 'OFF'
  const isIn = (bucket) =>
    Array.isArray(bucket) && bucket.some((t) => (t || '').toLowerCase() === tagLower)
  if (isIn(state.and)) return 'AND'
  if (isIn(state.or)) return 'OR'
  if (isIn(state.not)) return 'NOT'
  return 'OFF'
}

// ── Phase 3.4i — Project Tag (id-based) predicates ──────────────────────
//
// The existing helpers above work on string tags case-insensitively —
// correct shape for Program Tags (ContextCue / Conversation per-host
// string lists). Project Tags reference pool entries by UUID instead,
// so the predicate input is naturally a `Set<string>` of ids. Same
// `{ and, or, not }` filter shape, same set-theoretic semantics, just
// id equality instead of lower-cased string equality.

/**
 * Returns true if `tagIdSet` (a Set of tag ids the host carries —
 * usually built via `chainWideTagIdsForHost` so "ever-tagged"
 * semantics apply) satisfies `filterState`.
 *
 * `filterState.{and, or, not}` arrays contain tag UUIDs. Empty
 * arrays are no-ops per the same rules as `matchesTagFilter`.
 */
export function matchesProjectTagFilterBySet(tagIdSet, filterState) {
  const set = tagIdSet instanceof Set ? tagIdSet : new Set(tagIdSet || [])
  const and = Array.isArray(filterState?.and) ? filterState.and : []
  const or  = Array.isArray(filterState?.or)  ? filterState.or  : []
  const not = Array.isArray(filterState?.not) ? filterState.not : []
  // AND: every required tag present.
  for (const id of and) if (!set.has(id)) return false
  // NOT: no excluded tag present.
  for (const id of not) if (set.has(id)) return false
  // OR: at least one if non-empty.
  if (or.length > 0) {
    let found = false
    for (const id of or) if (set.has(id)) { found = true; break }
    if (!found) return false
  }
  return true
}

// ── Phase 3.4i — Chain-wide tag walk for Project Tag hosts ──────────────
//
// Every chain-trackable Project Tag host (Entity / Knowledge /
// Relationship) carries:
//   - a baseline tag set at the host's origin (`host.tag_ids`)
//   - a chain of `tag_changes` add / remove events recorded against
//     downstream chain anchors (the host's `history.tag_changes` for
//     Knowledge / Relationship; the per-bucket `EntityRef.tag_changes`
//     on scene nodes + modifier `EntityNode.data.tag_changes` for
//     entities)
//
// The "chain-wide ever-tagged" semantic intentionally IGNORES `remove`
// events — a tag that was added at scene 2 and removed at scene 5
// still counts as "ever tagged" for filter discovery. This matches the
// 3.4i planning doc's filter semantic: the filter discovers any host
// that carried a tag at ANY point on its chain, regardless of whether
// the tag is currently effective at any particular anchor.
//
// Baseline-only hosts (Reference Node / Preset List) have no chain;
// the walker returns their `tag_ids` as the entire tag set.

const _ENTITY_HOST_KINDS = new Set(['entity', 'character', 'location', 'item', 'faction', 'custom'])

/**
 * Split `host`'s tags into `{ baseline, chainAdded }` arrays for
 * the ObjectTagsPopover render. `baseline` is the set in
 * `host.tag_ids` (the snapshot at the host's origin — rendered solid).
 * `chainAdded` is every tag id that appears in any downstream
 * `tag_changes.add` event AND is NOT in baseline (rendered dashed).
 *
 * Tags that appear in BOTH (baseline + chain-re-add after a chain
 * remove) count as baseline; we don't double-list them.
 *
 * Args:
 *   - `host`     — the host object. Shape varies by kind: an entity
 *                  row for entity kinds, a knowledge/relationship row
 *                  for those, the canvas node for `referenceNode`,
 *                  the preset list row for `presetList`.
 *   - `hostKind` — one of `entity` / `character` / `location` / `item`
 *                  / `faction` / `custom` / `knowledge` / `relationship`
 *                  / `referenceNode` / `presetList`.
 *   - `nodes?`   — canvas nodes array; required for entity kinds
 *                  (the chain events live across nodes, not on the
 *                  entity row). Ignored for non-entity kinds.
 *
 * Returns `{ baseline: string[], chainAdded: string[] }`. Both arrays
 * are de-duplicated; element order is encounter order during the walk.
 */
export function splitTagIdsByOrigin(host, hostKind, nodes = null) {
  if (!host) return { baseline: [], chainAdded: [] }

  if (hostKind === 'referenceNode') {
    return { baseline: Array.from(new Set(host.data?.tag_ids || [])), chainAdded: [] }
  }
  if (hostKind === 'presetList') {
    return { baseline: Array.from(new Set(host.tag_ids || [])), chainAdded: [] }
  }

  const baselineList = Array.from(new Set(host.tag_ids || []))
  const baselineSet = new Set(baselineList)
  const chainAdded = new Set()

  if (hostKind === 'knowledge' || hostKind === 'relationship') {
    for (const ev of (host.history?.tag_changes || [])) {
      if (ev?.action === 'add' && ev.tag_id && !baselineSet.has(ev.tag_id)) {
        chainAdded.add(ev.tag_id)
      }
    }
    return { baseline: baselineList, chainAdded: Array.from(chainAdded) }
  }

  if (_ENTITY_HOST_KINDS.has(hostKind)) {
    const entityId = host.id
    if (entityId && Array.isArray(nodes)) {
      for (const n of nodes) {
        if (n.type === 'sceneNode') {
          for (const bucket of ['characters', 'locations', 'items', 'factions', 'customs']) {
            for (const ref of (n.data?.[bucket] || [])) {
              if (ref.entity_id !== entityId) continue
              for (const ev of (ref.tag_changes || [])) {
                if (ev?.action === 'add' && ev.tag_id && !baselineSet.has(ev.tag_id)) {
                  chainAdded.add(ev.tag_id)
                }
              }
            }
          }
        } else if (n.type === 'entityNode' && n.data?.is_modifier && n.data?.entity_id === entityId) {
          for (const ev of (n.data?.tag_changes || [])) {
            if (ev?.action === 'add' && ev.tag_id && !baselineSet.has(ev.tag_id)) {
              chainAdded.add(ev.tag_id)
            }
          }
        }
      }
    }
    return { baseline: baselineList, chainAdded: Array.from(chainAdded) }
  }

  // Unknown host kind — treat as baseline-only with no chain.
  return { baseline: baselineList, chainAdded: [] }
}

/**
 * Return the union of every tag id `host` has ever carried across its
 * chain (baseline ∪ all chain-add events, ignoring later removes).
 * Wraps `splitTagIdsByOrigin` and unions the two arrays. Used as the
 * predicate input by filter-bar matching paths so a host that ever
 * carried a tag matches a filter on that tag, even if the tag was
 * later removed at a downstream chain anchor.
 *
 * Returns a `Set<string>` of tag UUIDs. Empty Set when the host has
 * no tags.
 */
export function chainWideTagIdsForHost(host, hostKind, nodes = null) {
  const { baseline, chainAdded } = splitTagIdsByOrigin(host, hostKind, nodes)
  const out = new Set()
  for (const id of baseline) out.add(id)
  for (const id of chainAdded) out.add(id)
  return out
}
