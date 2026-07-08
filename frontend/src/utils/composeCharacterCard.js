/**
 * Phase 7.2 — Export-side composition for SillyTavern character cards.
 *
 * Turns a NarrativeNode entity's EFFECTIVE STATE AT A CHOSEN ANCHOR into
 * the card-data shape the shared serializer writes. This is the inverse of
 * the import mapping (card -> entity), and it is deliberately frontend-side:
 * the source of truth for "the entity's state at scene N" is the canonical
 * chain walker (`computeEffectiveState`), which already lives here and is
 * used everywhere else the chain is read. The thin backend `/export`
 * endpoint only embeds this card-data + the profile image into a PNG.
 *
 * Chain-aware: every value read comes from the walker at the chosen anchor
 * (`anchorNodeId`), never the entity baseline directly. With a null anchor
 * the walker returns the origin state, which IS the chain-aware result when
 * nothing is anchored (there is no prior chain entry to read past).
 *
 * Description recipe (Decision 4): the entity's effective description, then
 * each effective attribute as "Label: value" in display order (file/media
 * attributes and empty values skipped), then an optional relationships
 * section (default on). Perspectives and awareness are intentionally not
 * emitted. The modal previews this text and lets the user edit before
 * export.
 */

import { computeEffectiveState, computeRelationshipEffectiveState, getRelationshipNodeOrder } from './narrativeChain'
import { findPersonalityAttribute } from './personalityAttributeMatcher'
import { formatPerspectiveLine } from './perspectiveDescriptor'


/** A neutral, editable opening message. SillyTavern's `first_mes` is the
 *  character's greeting; NarrativeNode has no greeting concept, so this is
 *  authored at export time. `{{char}}` keeps it rename-safe. */
export const DEFAULT_FIRST_MES =
  '{{char}} looks up at you, ready to begin.\n\n"Hello there. Where would you like to start?"'


/** Flatten an attribute value to plain text. Strings pass through; lists
 *  join with ", " (entity-list / text-list values carry strings or
 *  {name|value} objects); anything else yields "". */
function attributeValueToText(attr) {
  const v = attr?.value
  if (v == null) return ''
  if (typeof v === 'string') return v.trim()
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === 'string' ? x : (x?.value ?? x?.name ?? '')))
      .filter((s) => typeof s === 'string' && s.trim())
      .join(', ')
  }
  return ''
}


/** Strip rich-text (TipTap) formatting to plain text, preserving paragraph and
 *  line breaks as newlines. The entity Notes field is HTML, but SillyTavern's
 *  `creator_notes` is plain text, so the `<p>` wrappers and other tags must not
 *  survive into the card. A value with no tags passes through untouched. */
function htmlToPlainText(value) {
  if (!value || typeof value !== 'string') return ''
  if (!/<[a-z!/][\s\S]*?>/i.test(value)) return value.trim()
  const normalised = value
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|blockquote|tr)\s*>/gi, '\n')
  let text
  if (typeof document !== 'undefined') {
    const el = document.createElement('div')
    el.innerHTML = normalised
    text = el.textContent || ''
  } else {
    text = normalised.replace(/<[^>]+>/g, '')
  }
  return text.replace(/\n{3,}/g, '\n\n').trim()
}


/** Build the relationships section for the entity at the anchor: every
 *  relationship that is active and has this entity as an effective
 *  participant, rendered as one line per relationship. Chain-aware via
 *  `computeRelationshipEffectiveState`. Returns [] when none apply. */
function relationshipLines(entityId, anchorNodeId, ctx) {
  const { relationships, nodes, edges, storyOrder, entityById } = ctx
  const out = []
  for (const rel of relationships || []) {
    let st
    try {
      const nodeOrder = getRelationshipNodeOrder(rel, nodes, edges, storyOrder) || []
      st = computeRelationshipEffectiveState(rel, nodeOrder, anchorNodeId || null)
    } catch {
      st = null
    }
    if (!st || !st.is_active) continue
    const me = (st.participants || []).find((p) => p.entity_id === entityId)
    if (!me) continue
    // Other participants' names are resolved chain-aware at the same anchor.
    const others = (st.participants || [])
      .filter((p) => p.entity_id !== entityId)
      .map((p) => {
        const oe = entityById && entityById.get(p.entity_id)
        if (!oe) return 'someone'
        try {
          return computeEffectiveState(oe, nodes, edges, anchorNodeId || null)?.name || oe.name || 'someone'
        } catch {
          return oe.name || 'someone'
        }
      })
    const label = (st.name && st.name.trim()) || 'Relationship'
    const who = others.length ? ` with ${others.join(' and ')}` : ''
    const perception = (me.perception && me.perception.trim()) ? ` (${me.perception.trim()})` : ''
    out.push(`${label}${who}${perception}`)
  }
  return out
}


/** Circumstance / motivator intensity ladder (0-4). Mirrors the slider in
 *  CircumstanceMotivatorForm and the chat-context formatter. */
const INTENSITY_LABELS = ['Faint', 'Mild', 'Moderate', 'Strong', 'Intense']

/** Format a circumstance or motivator attribute as one plain-text line. Their
 *  body lives in `description` (not `value`); `name` and `intensity` are
 *  optional. */
function formatCircumstanceOrMotivator(attr) {
  const name = (attr?.name || '').trim()
  const body = (attr?.description || '').trim().replace(/\s+/g, ' ')
  const intensity = (attr?.intensity != null && INTENSITY_LABELS[attr.intensity])
    ? ` (${INTENSITY_LABELS[attr.intensity]})`
    : ''
  if (!name && !body) return null
  if (name && body) return `${name}${intensity}: ${body}`
  return `${name || body}${intensity}`
}


/** Compose the readable, NON-substituted description prose for the preview.
 *  `{{char}}` substitution happens later, at export, on the final (possibly
 *  user-edited) text so the preview stays readable. */
export function composeInitialDescription(eff, options = {}) {
  const {
    includeRelationships = true, relationshipCtx = null, entityId = null, anchorNodeId = null,
    story = null, entityName = '',
  } = options
  const parts = []
  const desc = (eff?.description || '').trim()
  if (desc) parts.push(desc)

  // Regular attributes flatten inline as "Label: value". Circumstances,
  // motivators, and perspectives are specialised types (body in
  // `description`) collected into their own plain-text sections, mirroring
  // how the AI chat character context surfaces them.
  const circumstances = []
  const motivators = []
  const perspectives = []
  for (const attr of (eff?.attributes || [])) {
    if (!attr || typeof attr.attribute_type !== 'string') continue
    const t = attr.attribute_type
    if (t === 'file') continue // images / media are not prose
    if (t === 'circumstance') { const l = formatCircumstanceOrMotivator(attr); if (l) circumstances.push(l); continue }
    if (t === 'motivator') { const l = formatCircumstanceOrMotivator(attr); if (l) motivators.push(l); continue }
    if (t === 'perspective') {
      if (story) { const l = formatPerspectiveLine(attr, story, { hostName: entityName }); if (l) perspectives.push(l) }
      continue
    }
    if (typeof attr.name !== 'string') continue
    const text = attributeValueToText(attr)
    if (!text) continue
    parts.push(`${attr.name}: ${text}`)
  }

  if (circumstances.length) parts.push('Circumstances:\n' + circumstances.map((l) => `- ${l}`).join('\n'))
  if (motivators.length) parts.push('Motivators:\n' + motivators.map((l) => `- ${l}`).join('\n'))
  if (perspectives.length) parts.push('Perspectives:\n' + perspectives.map((l) => `- ${l}`).join('\n'))

  if (includeRelationships && relationshipCtx && entityId) {
    const rels = relationshipLines(entityId, anchorNodeId, relationshipCtx)
    if (rels.length) {
      parts.push('Relationships:\n' + rels.map((r) => `- ${r}`).join('\n'))
    }
  }
  return parts.join('\n\n')
}


/** Replace whole-word, case-insensitive occurrences of the entity's
 *  effective name with `{{char}}` so the card survives a rename in
 *  SillyTavern. `{{user}}` is never emitted on export. */
function substituteCharMacro(text, name) {
  if (!text || !name) return text || ''
  try {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return text.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), '{{char}}')
  } catch {
    return text
  }
}


/** Resolve the entity's effective state at the anchor. Thin wrapper so the
 *  modal and the assembler share one read path. */
export function effectiveStateForCard(entity, anchorNodeId, nodes, edges) {
  if (!entity) return null
  try {
    return computeEffectiveState(entity, nodes, edges, anchorNodeId || null)
  } catch {
    return null
  }
}


/** Assemble the final card-data payload for POST /character-card/export from
 *  the entity, its effective state, and the (possibly user-edited) preview
 *  text + authored first message. Applies `{{char}}` substitution to the
 *  free-prose fields. */
export function assembleCardData({ entity, eff, anchorNodeId = null, description, firstMes, projectTags = [] }) {
  const name = (eff?.name || entity?.name || 'Character').trim() || 'Character'
  const personalityHit = findPersonalityAttribute(entity, anchorNodeId ? [{ anchor_node_id: anchorNodeId }] : [])
  const personality = personalityHit
    ? substituteCharMacro(attributeValueToText(personalityHit), name)
    : ''
  const tagIds = Array.isArray(eff?.tag_ids) ? eff.tag_ids : (entity?.tag_ids || [])
  const tagNameById = new Map((projectTags || []).map((t) => [t.id, t.name]))
  const tags = tagIds.map((id) => tagNameById.get(id)).filter((n) => typeof n === 'string' && n.trim())
  return {
    card_data: {
      name,
      description: substituteCharMacro((description || '').trim(), name),
      personality,
      scenario: '',
      first_mes: substituteCharMacro((firstMes || '').trim(), name),
      mes_example: '',
      creator_notes: htmlToPlainText(entity?.notes),
      tags,
    },
    profile_image_ref: eff?.profile_image_ref || entity?.profile_image_ref || null,
  }
}
