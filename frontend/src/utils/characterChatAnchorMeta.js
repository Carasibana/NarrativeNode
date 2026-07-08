import { computeEffectiveState } from './narrativeChain'


/**
 * Phase 2.11b — shared helpers for character-chat anchor metadata
 * (extracted from ChatPanel's header so the message-list re-anchor
 * divider can reuse the same shape-aware label format and the same
 * latest-anchor selection rule).
 *
 *   - `latestAnchorNodeIdFromPins(pins)` — pick the node id used as the
 *     character-identity resolution point. Range pins → end node;
 *     single pins → the anchor node; multi → last pin's resolution
 *     point; dynamic / empty → null (chain walker treats null as
 *     "fully resolved baseline-only", matching the assembly function).
 *
 *   - `formatAnchorSpan(pins, nodes)` — writer-visible label. Shape-
 *     aware: single → scene title / "origin" / "modifier" depending
 *     on the node's kind, range → `<start label> to <end label>`,
 *     multi (>1 pin) → `<N> anchors`, dynamic / empty → `current
 *     scene`. No emdashes — hyphen-less "to" reads cleaner per the UI
 *     rule.
 *
 *   - `hashAnchorSpec(pins)` — change-detection token for the
 *     re-anchor divider in the message list. Two messages with
 *     different `anchor_dossier_hash` values are interpreted as
 *     having been sent across a re-anchor; the renderer drops an
 *     informational divider between them. Deterministic across calls
 *     so a thread that survives reload still detects the same
 *     boundaries on next render.
 */


export function latestAnchorNodeIdFromPins(pins) {
  if (!Array.isArray(pins) || pins.length === 0) return null
  let latest = null
  for (const pin of pins) {
    if (pin?.anchor_range?.end_node_id) latest = pin.anchor_range.end_node_id
    else if (pin?.anchor_node_id) latest = pin.anchor_node_id
  }
  return latest
}


export function formatAnchorSpan(pins, nodes) {
  if (!Array.isArray(pins) || pins.length === 0) return 'current scene'
  const titleOf = (nodeId) => {
    if (!nodeId) return ''
    const n = (nodes || []).find((x) => x.id === nodeId)
    if (!n) return ''
    if (n.type === 'entityNode') {
      return n.data?.is_modifier ? 'modifier' : 'origin'
    }
    return n.data?.title || 'Untitled Scene'
  }
  if (pins.length > 1) return `${pins.length} anchors`
  const pin = pins[0]
  if (pin?.anchor_range) {
    const startTitle = titleOf(pin.anchor_range.start_node_id)
    const endTitle = titleOf(pin.anchor_range.end_node_id)
    if (!startTitle && !endTitle) return 'a range'
    if (startTitle === endTitle) return startTitle
    return `${startTitle} to ${endTitle}`
  }
  if (pin?.anchor_node_id) return titleOf(pin.anchor_node_id)
  return 'current scene'
}


/**
 * Deterministic anchor-spec hash for the re-anchor divider.
 *
 * Per-pin encoding:
 *   - range  → `r:<start_node_id>:<end_node_id>`
 *   - single → `s:<anchor_node_id>`
 *   - dynamic / unrecognised → `d`
 *
 * The pin encodings are sorted alphabetically before joining so two
 * anchor specs that pick the same set of anchors in different
 * iteration order produce the same hash. Empty / dynamic spec hashes
 * to the string `dynamic`.
 */
/**
 * Phase 2.11b item 13 — chain-resolved persona snapshot for a
 * character-chat thread. Walks the entity chain to the latest anchor
 * node id from the spec (see `latestAnchorNodeIdFromPins`) and reads
 * the character's name, colour, and profile image AT that point.
 *
 * Returns `null` when `characterChat` is null. Returns a fallback
 * shape (no synthEntity, generic placeholder) when the character id
 * doesn't resolve in the loaded entity library (e.g. cross-story
 * thread opened with no story-mismatch gate — the gate handles this
 * case at the entry point, but the snapshot guards anyway).
 *
 * The walker resolves to baseline naturally when the chain has no
 * modifier entry on the requested fields, so this works at every
 * anchor shape (origin / mid-chain / range-end / multi-end / dynamic
 * = null → fully resolved baseline by convention of the walker).
 * The fallback path still feeds chain-resolved values when they
 * exist; `eff?.field ?? ch.field` is the standard walker-result-then-
 * baseline pattern used everywhere chain reads are surfaced.
 */
// Phase 2.12 — content-based memoisation cache for snapshots. Keyed
// by `${character_id}:${anchor_hash}` so a single character can have
// multiple cached snapshots (one per anchor configuration) without
// thrashing. When a subsequent call resolves to byte-for-byte
// identical content, we return the previously-cached object so React.
// memo on `MessageBubble` can bail out on shallow prop equality. The
// cache grows unboundedly within a session — bounded only by
// distinct (character_id, anchor_hash) pairs; for a project with N
// characters and M chats, that's at most N×M entries of tiny objects.
// No cross-session persistence; the cache rebuilds on next program
// launch from the live data.
const _snapshotCache = new Map()


function _snapshotsContentEqual(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.characterName !== b.characterName) return false
  if (a.characterColour !== b.characterColour) return false
  if (a.characterImageRef !== b.characterImageRef) return false
  if (a.anchorLabel !== b.anchorLabel) return false
  const sa = a.synthEntity, sb = b.synthEntity
  if (sa === sb) return true
  if (!sa || !sb) return false
  if (sa.id !== sb.id) return false
  if (sa.profile_image_ref !== sb.profile_image_ref) return false
  if (sa.colour !== sb.colour) return false
  if (sa.name !== sb.name) return false
  return true
}


export function buildCharacterPersonaSnapshot(characterChat, characters, nodes, edges) {
  if (!characterChat) return null
  const ch = (characters || []).find((c) => c.id === characterChat.character_id)
  if (!ch) {
    const fallback = {
      characterName: '(missing character)',
      characterColour: '#888888',
      characterImageRef: null,
      anchorLabel: formatAnchorSpan(characterChat.anchor_spec, nodes),
      synthEntity: null,
    }
    // Cache key includes anchor hash so same-character/different-
    // anchor chats don't thrash a single slot.
    const fallbackKey = `${characterChat.character_id}:${hashAnchorSpec(characterChat.anchor_spec)}:missing`
    const prevFallback = _snapshotCache.get(fallbackKey)
    if (prevFallback && _snapshotsContentEqual(prevFallback, fallback)) return prevFallback
    _snapshotCache.set(fallbackKey, fallback)
    return fallback
  }
  const latest = latestAnchorNodeIdFromPins(characterChat.anchor_spec)
  let eff = null
  try {
    eff = computeEffectiveState(ch, nodes, edges, latest || null)
  } catch { eff = null }
  const resolvedName = eff?.name || ch.name || 'Untitled'
  const resolvedColour = eff?.colour || ch.colour || '#7c3aed'
  const resolvedImage = eff?.profile_image_ref ?? ch.profile_image_ref ?? null
  const result = {
    characterName: resolvedName,
    characterColour: resolvedColour,
    characterImageRef: resolvedImage,
    anchorLabel: formatAnchorSpan(characterChat.anchor_spec, nodes),
    synthEntity: {
      id: ch.id,
      type: 'character',
      profile_image_ref: resolvedImage,
      colour: resolvedColour,
      name: resolvedName,
    },
  }
  // Content-based memoisation: return the cached object reference
  // when its resolved fields match. This lets `React.memo` on
  // consumers (e.g. `MessageBubble`) bail out via shallow prop
  // equality even when the snapshot's deps change (node / edge
  // updates) without the resolved fields actually changing.
  const cacheKey = `${characterChat.character_id}:${hashAnchorSpec(characterChat.anchor_spec)}`
  const prev = _snapshotCache.get(cacheKey)
  if (prev && _snapshotsContentEqual(prev, result)) return prev
  _snapshotCache.set(cacheKey, result)
  return result
}


export function hashAnchorSpec(pins) {
  if (!Array.isArray(pins) || pins.length === 0) return 'dynamic'
  const parts = []
  for (const pin of pins) {
    if (pin?.anchor_range?.start_node_id && pin?.anchor_range?.end_node_id) {
      parts.push(`r:${pin.anchor_range.start_node_id}:${pin.anchor_range.end_node_id}`)
    } else if (pin?.anchor_node_id) {
      parts.push(`s:${pin.anchor_node_id}`)
    } else {
      parts.push('d')
    }
  }
  parts.sort()
  return parts.join('|')
}
