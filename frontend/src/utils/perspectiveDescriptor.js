/**
 * Phase 2.13c — Perspective target-descriptor helpers.
 *
 * One canonical source for the way a perspective's target is described
 * in any text-output context (chat system prompts, scene context blocks,
 * story-scope change bullets, MCP responses, etc.).
 *
 * Per the Phase 2.13 planning doc:
 *   - character / location / item / faction / custom → bare name
 *   - knowledge   → the Knowledge "<name>"
 *   - relationship → "<title>" (<A> ↔ <B>)  when titled
 *                  → the <A> ↔ <B> relationship  otherwise
 *
 * Orphaned-target perspectives (cascade-nulled `perspective_target_kind`
 * / `perspective_target_id`) return `null` from `resolvePerspectiveTarget
 * Descriptor` so the caller can skip them — they pollute the model's
 * context without adding meaning.
 */

import { ENTITY_BUCKETS } from './entityHelpers'

/**
 * Resolve the textual descriptor for a perspective's target.
 *
 * @param {string|null} kind  - perspective_target_kind on the attribute
 * @param {string|null} id    - perspective_target_id on the attribute
 * @param {object} story      - story bundle: { entities, knowledges,
 *                              relationships } in the canonical shape
 *                              `sceneContextPrompt` / `storyScopeBundle
 *                              Builder` consume.
 * @returns {string|null}     - The descriptor string, or `null` for
 *                              orphaned / unresolvable targets.
 */
export function resolvePerspectiveTargetDescriptor(kind, id, story) {
  if (!kind || !id || !story) return null

  if (kind === 'knowledge') {
    const k = (story.knowledges || []).find((x) => x && x.id === id)
    if (!k) return null
    const name = (k.name || '').trim()
    return name ? `the Knowledge "${name}"` : 'the Knowledge'
  }

  if (kind === 'relationship') {
    const r = (story.relationships || []).find((x) => x && x.id === id)
    if (!r) return null
    const title = (r.title || '').trim()
    const joins = ((r.history && r.history.participant_changes) || [])
      .filter((c) => c && c.action === 'join')
      .map((c) => c.entity_id)
    const uniq = Array.from(new Set(joins))
    const names = uniq.slice(0, 2).map((eid) => _resolveEntityName(eid, story) || '?')
    let participantsStr
    if (uniq.length === 0) participantsStr = ''
    else if (uniq.length === 1) participantsStr = names[0]
    else if (uniq.length === 2) participantsStr = `${names[0]} ↔ ${names[1]}`
    else participantsStr = `${names[0]} ↔ ${names[1]} + ${uniq.length - 2} more`

    if (title) {
      return participantsStr ? `"${title}" (${participantsStr})` : `"${title}"`
    }
    return participantsStr ? `the ${participantsStr} relationship` : 'the relationship'
  }

  // Entity kinds: character / location / item / faction / custom.
  const name = _resolveEntityName(id, story)
  return name || null
}

/**
 * Format a single perspective row as one rendered line. Returns `null`
 * when the perspective should be skipped — orphaned targets, or targets
 * that can't be resolved.
 *
 * Shape (with `hostName`):  `<host>'s Perspective of <target>: "<desc>"`
 * Shape (without hostName): `<target>: "<description>"`
 *
 * Examples:
 *   - on character Bob, host Alice:
 *       `Alice's Perspective of Bob: "He's a nice guy"`
 *   - on knowledge K, host Adam:
 *       `Adam's Perspective of the Knowledge "Marisol is Adam": "Crazy"`
 *   - on relationship R, host Marisol:
 *       `Marisol's Perspective of "Old flames" (Alice ↔ Bob): "..."`
 *
 * The host-name prefix matters because the same line can appear in
 * surfaces where the surrounding scaffolding does NOT name the host
 * entity (e.g. story-scope change rollups, alerts panel rows). The
 * detail-panel Attributes-tab render passes `hostName` too so each
 * row reads as a complete clause in isolation.
 *
 * @param {object}      attr      - the perspective attribute
 *                                  (attribute_type === 'perspective')
 * @param {object}      story     - story bundle (see
 *                                  resolvePerspectiveTargetDescriptor)
 * @param {object}      [opts]
 * @param {string|null} [opts.hostName] - host entity's display name. When
 *                                  provided, the line is prefixed with
 *                                  `<hostName>'s Perspective of `.
 * @returns {string|null}
 */
export function formatPerspectiveLine(attr, story, opts = {}) {
  if (!attr || attr.attribute_type !== 'perspective') return null
  const target = resolvePerspectiveTargetDescriptor(
    attr.perspective_target_kind,
    attr.perspective_target_id,
    story,
  )
  if (!target) return null
  const desc = (attr.description || '').trim().replace(/\s+/g, ' ')
  const hostName = opts && typeof opts.hostName === 'string' ? opts.hostName.trim() : ''
  const head = hostName ? `${hostName}'s Perspective of ${target}` : target
  return desc ? `${head}: "${desc}"` : head
}

function _resolveEntityName(entityId, story) {
  if (!entityId || !story) return null
  const entities = story.entities || {}
  for (const bucket of ENTITY_BUCKETS) {
    const list = entities[bucket] || []
    for (const e of list) {
      if (e && e.id === entityId) return e.name || null
    }
  }
  return null
}
