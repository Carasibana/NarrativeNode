/**
 * Phase 2.11b item 5 — Character Chat system-message assembly.
 *
 * Takes the character chat inputs and produces the literal system
 * message string the LLM receives at send time. Matches the
 * four-section assembly the planning doc *System prompt assembly*
 * section locks in:
 *
 *   {persona_preamble_with_{{character_name}}_substituted}
 *
 *   <character_context>
 *   {chain-resolved dossier from the chat-panel pin-resolution
 *    pipeline + temp circumstance / motivator if set}
 *   </character_context>
 *
 *   <system_prompt>
 *   {writer's Persona prompt body, verbatim}
 *   </system_prompt>
 *
 *   <custom_instructions>     (only when non-empty)
 *   {writer's free-text additional instructions}
 *   </custom_instructions>
 *
 * The character context is produced by reusing `buildSceneContextBlock`
 * from `sceneContextPrompt.js` — the same pipeline the chat panel uses
 * to render pinned-context dossiers. One source of truth for chain-
 * resolved entity dossier shape.
 *
 * When `character_id` is null / no pins are provided, the
 * `<character_context>` block carries the genuine no-character
 * fallback string (fetched from the backend alongside the preamble,
 * defined once in `backend/services/persona_preamble_service.py`).
 *
 * Async: `buildSceneContextBlock` is async + `/api/persona-preamble`
 * is a network call. Callers await.
 *
 * The function reads from the live project store + entities store
 * directly. Callers don't need to thread store state through.
 */

import axios from 'axios'
import { buildSceneContextBlock } from './sceneContextPrompt'
import { useProjectStore } from '../store/projectStore'
import { useEntitiesStore } from '../store/entitiesStore'
import { computeEffectiveState } from './narrativeChain'
import {
  buildCharacterAwarenessInventory,
  formatAwarenessInventory,
} from './characterAwarenessInventory'
import { awarenessLevelName } from './chatContextFormatters'


// Substitute `{{key}}` occurrences in the template with the
// corresponding value. Used for the Persona Preamble's
// `{{character_name}}` placeholder. New placeholders just add a key
// to the `vars` object at the call site — no schema change.
function _resolvePlaceholders(template, vars) {
  let out = template || ''
  for (const [key, value] of Object.entries(vars || {})) {
    out = out.split(`{{${key}}}`).join(value == null ? '' : String(value))
  }
  return out
}


// Strip the leading `## Additional Context` header that
// `buildSceneContextBlock`'s pinned-only path emits. We wrap the
// dossier in `<character_context>` tags instead, so the header is
// redundant.
function _stripAdditionalContextHeader(block) {
  if (!block) return ''
  return block.replace(/^##\s+Additional Context\s*\n+/, '').trimEnd()
}


// Resolve the character's effective name at the latest anchor across
// the provided pins. For range pins, that's the range's end node; for
// single, the anchor; for dynamic, fall back to the entity's baseline
// name. The latest anchor is the right resolution point because the
// Persona Preamble identifies the character to the model, and the
// "current" identity from the model's perspective is the latest
// stop on the selected window.
function _resolveCharacterNameAtAnchor(character, pins, nodes, edges) {
  if (!character) return ''
  if (!Array.isArray(pins) || pins.length === 0) return character.name || ''
  let latestAnchor = null
  for (const pin of pins) {
    if (pin?.anchor_range?.end_node_id) {
      latestAnchor = pin.anchor_range.end_node_id
    } else if (pin?.anchor_node_id) {
      latestAnchor = pin.anchor_node_id
    }
  }
  if (!latestAnchor) return character.name || ''
  try {
    const eff = computeEffectiveState(character, nodes, edges, latestAnchor)
    return eff?.name || character.name || ''
  } catch {
    return character.name || ''
  }
}


// Intensity labels mirror `INTENSITY_LABELS` in
// `components/ui/IntensityBadge.jsx` — kept inline so this utility
// doesn't depend on a UI module.
const _INTENSITY_LABELS = ['Faint', 'Mild', 'Moderate', 'Strong', 'Intense']

// Render a conversation-scoped Temp Circumstance / Motivator entry
// (the `{name, description, intensity}` shape produced by
// `CircumstanceMotivatorForm` in the Setup modal) into the dossier
// line that rides inside `<character_context>`. Returns `null` when
// the entry is empty so the caller can skip it. Accepts the legacy
// plain-string shape too (lifted to `{description: <str>}`).
function _renderTempCMLine(label, entry) {
  if (!entry) return null
  if (typeof entry === 'string') {
    const txt = entry.trim()
    if (!txt) return null
    return `**${label}**: ${txt}`
  }
  if (typeof entry !== 'object') return null
  const name = (entry.name || '').trim()
  const desc = (entry.description || '').trim()
  const intensity = Number.isInteger(entry.intensity) ? entry.intensity : null
  if (!name && !desc && intensity == null) return null
  const intensityLabel = intensity != null ? _INTENSITY_LABELS[intensity] : null
  const head = name || '(unnamed)'
  const parts = [`**${label}**: ${head}`]
  if (intensityLabel) parts[0] += ` _(Intensity: ${intensityLabel})_`
  if (desc) parts.push(desc)
  return parts.join('\n')
}


/**
 * Resolve the OTHER character's effective state at their own anchor,
 * then build the `<other_character_context>` block content the
 * speaking character's system message wraps. Filters the speaker's
 * awareness inventory down to entries pointing at the other character
 * or its sub-elements (entity / entity_name / attribute / alias) so
 * the LLM gets an explicit list of what the speaker knows about the
 * person they're talking to — not a god-view dump.
 *
 * Returns the assembled block body (string) or '' when no useful
 * content. Caller is responsible for the XML wrapping.
 */
function _buildOtherCharacterContextBody(speakerCharacterId, speakerLatestAnchor, otherCharacter, otherCharacterLatestAnchor, nodes, edges) {
  if (!otherCharacter) return ''
  let otherEff = null
  try {
    otherEff = computeEffectiveState(otherCharacter, nodes, edges, otherCharacterLatestAnchor || null)
  } catch { otherEff = null }
  const otherName = otherEff?.name || otherCharacter.name || '(unnamed character)'
  const otherDescription = (otherEff?.description || '').trim()

  const lines = []
  lines.push(`**You are speaking with: ${otherName}**`)
  if (otherDescription) {
    lines.push('')
    lines.push(`About them: ${otherDescription}`)
  }

  // Filter the speaker's awareness inventory to entries about the
  // other character. Built fresh from the speaker's anchor so
  // "what the speaker knows" is computed at the speaker's chain
  // point, NOT the other character's. host_kind / host_id were
  // added to inventory entries in v0.2.12.x for this filter.
  let filtered = []
  try {
    const inventory = buildCharacterAwarenessInventory(speakerCharacterId, speakerLatestAnchor || null)
    filtered = (inventory || []).filter((e) => e.host_kind === 'entity' && e.host_id === otherCharacter.id)
  } catch { filtered = [] }

  if (filtered.length > 0) {
    lines.push('')
    lines.push('**What you are aware of (and unaware of) about them:**')
    lines.push('')
    for (const e of filtered) {
      const tag = ({
        entity: 'Entity',
        entity_name: 'Entity name',
        attribute: 'Attribute',
        alias: 'Alias',
      })[e.kind] || '?'
      lines.push(`[${tag}] ${e.label}`)
      if (e.description) lines.push(`  About: ${e.description}`)
      if (Number(e.level) === 0) {
        lines.push(
          `  Awareness: ${awarenessLevelName(0)} — you do NOT know this about them. ` +
          `If it comes up, react in-character as someone genuinely unfamiliar; do not acknowledge any aspect of it.`,
        )
      } else {
        lines.push(`  Awareness: ${awarenessLevelName(e.level)}`)
      }
      lines.push('')
    }
  }
  return lines.join('\n').trimEnd()
}


/**
 * Assemble the final system message for a character chat send.
 *
 * @param {object} args
 * @param {string} args.character_id          Entity id of the character being played.
 * @param {Array} args.pins                   Pin shapes from the anchor selector
 *                                            (single / range / multi expanded into
 *                                            individual pins). Empty / dynamic →
 *                                            no anchor, dossier renders at baseline.
 * @param {string} args.persona_prompt_body   The chosen Persona system prompt's body.
 * @param {object|string|null} args.temp_circumstance Conversation-scoped circumstance
 *                                            ({name, description, intensity} from the
 *                                            in-program C/M form). Legacy plain-string
 *                                            shape still accepted.
 * @param {object|string|null} args.temp_motivator    Conversation-scoped motivator
 *                                            (same shape as temp_circumstance).
 * @param {string|null} args.custom_instructions Conversation-scoped free-form
 *                                            additional instructions.
 * @param {object|null} args.other_character  Phase 2.12 — when provided, the assembled
 *                                            message includes an `<other_character_context>`
 *                                            block (between `<character_context>` and
 *                                            `<system_prompt>`) carrying an
 *                                            awareness-filtered view of the OTHER
 *                                            character in a two-character chat. Shape:
 *                                            `{ character_id, pins }`. Null in
 *                                            single-character mode — assembler produces
 *                                            byte-for-byte the same output it did in
 *                                            Phase 2.11b. **No-regression invariant.**
 * @returns {Promise<string>}                 The fully assembled system message.
 */
export async function assembleCharacterChatSystemMessage({
  character_id,
  pins = [],
  persona_prompt_body,
  temp_circumstances = [],
  temp_motivators = [],
  custom_instructions = null,
  other_character = null,
}) {
  // 1. Fetch the program's Persona Preamble + the no-character
  //    fallback. Backend caches the value so this is cheap per send.
  let preambleTemplate = ''
  let noCharacterFallback = 'no character selected'
  try {
    const { data } = await axios.get('/api/persona-preamble')
    if (typeof data?.body === 'string') preambleTemplate = data.body
    if (typeof data?.character_context_fallback_no_character === 'string') {
      noCharacterFallback = data.character_context_fallback_no_character
    }
  } catch { /* fall through with defaults */ }

  // 2. Resolve the character + name at the latest anchor across pins.
  let character = null
  let characterName = ''
  if (character_id) {
    const ent = useEntitiesStore.getState()
    character = (ent?.characters || []).find((c) => c.id === character_id) || null
    if (character) {
      const proj = useProjectStore.getState()
      characterName = _resolveCharacterNameAtAnchor(character, pins, proj.nodes || [], proj.edges || [])
    }
  }

  // 3. Substitute placeholders in the preamble. `{{character_name}}`
  //    is the only one defined today; future named placeholders just
  //    add a key to the `vars` object.
  const preamble = _resolvePlaceholders(preambleTemplate, {
    character_name: characterName,
  })

  // 4. Build the character context body via the chat-panel pin-
  //    resolution pipeline. Strip the `## Additional Context` header
  //    that path emits — we have our own `<character_context>` wrapper.
  let characterContextBody = noCharacterFallback
  if (character_id && Array.isArray(pins) && pins.length > 0) {
    // Defensive: ensure every pin carries the right kind / id even if
    // the caller forgot. The pin-resolution renderer drops items whose
    // kind / id are missing, which would silently produce an empty
    // dossier — better to enforce here.
    const characterPins = pins.map((p) => ({ ...(p || {}), kind: 'entity', id: character_id }))
    try {
      const block = await buildSceneContextBlock({ pinnedItems: characterPins })
      const stripped = _stripAdditionalContextHeader(block)
      if (stripped) characterContextBody = stripped
    } catch {
      // Walker / store error — fall through with the fallback so the
      // model gets something coherent in the tags.
      characterContextBody = noCharacterFallback
    }
  }

  // 5. Splice in the conversation-scoped temp fields. Both ride
  //    INSIDE the `<character_context>` block — they're additions to
  //    the character's situational context, not separate sections.
  //    The Setup modal captures these via the same
  //    `CircumstanceMotivatorForm` used for entity / scene C/M, so
  //    they arrive as {name, description, intensity} objects (legacy
  //    plain-string shape from v0.2.11.12..v0.2.11.15 also accepted).
  //    Phase 2.12g+ accepts arrays of entries; each entry renders
  //    as its own line. Legacy singular shape lifted to single-item
  //    list by the backend Pydantic migration; for any caller still
  //    passing the legacy shape directly, the `||` fallback below
  //    keeps the assembly working without crashing.
  const _circList = Array.isArray(temp_circumstances)
    ? temp_circumstances
    : (temp_circumstances ? [temp_circumstances] : [])
  const _motList = Array.isArray(temp_motivators)
    ? temp_motivators
    : (temp_motivators ? [temp_motivators] : [])
  const tempLines = []
  for (const entry of _circList) {
    const line = _renderTempCMLine('Conversation-scoped circumstance', entry)
    if (line) tempLines.push(line)
  }
  for (const entry of _motList) {
    const line = _renderTempCMLine('Conversation-scoped motivator', entry)
    if (line) tempLines.push(line)
  }
  if (tempLines.length > 0) {
    characterContextBody = characterContextBody.trimEnd() + '\n\n' + tempLines.join('\n\n')
  }

  // 5b. Splice in the character's awareness inventory — what they
  //     know and don't know about other targets in the project at
  //     the chosen anchor. Aware entries get a level-labelled
  //     descriptor; explicitly-unaware entries get a meta-instruction
  //     so the LLM honours the blind spot without confabulating. See
  //     `characterAwarenessInventory.js` for the walker + format.
  if (character_id) {
    let latestAnchor = null
    for (const pin of (Array.isArray(pins) ? pins : [])) {
      if (pin?.anchor_range?.end_node_id) latestAnchor = pin.anchor_range.end_node_id
      else if (pin?.anchor_node_id) latestAnchor = pin.anchor_node_id
    }
    let awarenessSection = ''
    try {
      const inventory = buildCharacterAwarenessInventory(character_id, latestAnchor || null)
      awarenessSection = formatAwarenessInventory(inventory)
    } catch { awarenessSection = '' }
    if (awarenessSection) {
      characterContextBody = characterContextBody.trimEnd() + '\n\n' + awarenessSection
    }
  }

  // 5c. Phase 2.12 — build the `<other_character_context>` block when
  //     the caller is two-character mode. Resolves the OTHER
  //     character's effective state at THEIR own anchor (independent
  //     of the speaker's anchor) plus the speaker's awareness inventory
  //     filtered to entries about that character. Empty when no
  //     other_character is provided OR the resolution produces no
  //     useful content — block silently omits, no empty wrappers.
  //     **No-regression invariant:** when `other_character` is null
  //     (regular + single-character chats), this section is a no-op
  //     and the assembled output below matches v0.2.11.29 byte-for-byte.
  let otherCharacterContextBody = ''
  if (other_character && other_character.character_id) {
    const ent = useEntitiesStore.getState()
    const otherChar = (ent?.characters || []).find((c) => c.id === other_character.character_id) || null
    if (otherChar) {
      const proj = useProjectStore.getState()
      // Resolve the OTHER character's latest anchor from their own
      // pins — independent of the speaker's pins.
      let otherLatestAnchor = null
      for (const pin of (Array.isArray(other_character.pins) ? other_character.pins : [])) {
        if (pin?.anchor_range?.end_node_id) otherLatestAnchor = pin.anchor_range.end_node_id
        else if (pin?.anchor_node_id) otherLatestAnchor = pin.anchor_node_id
      }
      // Speaker's latest anchor (already resolved above for the
      // awareness inventory — extract the same way for filter use).
      let speakerLatestAnchor = null
      for (const pin of (Array.isArray(pins) ? pins : [])) {
        if (pin?.anchor_range?.end_node_id) speakerLatestAnchor = pin.anchor_range.end_node_id
        else if (pin?.anchor_node_id) speakerLatestAnchor = pin.anchor_node_id
      }
      try {
        otherCharacterContextBody = _buildOtherCharacterContextBody(
          character_id,
          speakerLatestAnchor,
          otherChar,
          otherLatestAnchor,
          proj.nodes || [],
          proj.edges || [],
        )
      } catch { otherCharacterContextBody = '' }
    }
  }

  // 6. Assemble the final string. Custom Instructions section ONLY
  //    renders when the field is non-empty (matches the "no empty
  //    wrappers" principle from the planning doc). Phase 2.12 —
  //    `<other_character_context>` rides between `<character_context>`
  //    and `<system_prompt>` when present (two-character mode);
  //    omitted entirely otherwise (regular + single-character chats
  //    — no-regression invariant per Rule 4).
  const parts = [
    preamble.trim(),
    '',
    '<character_context>',
    characterContextBody.trim(),
    '</character_context>',
  ]
  if (otherCharacterContextBody) {
    parts.push(
      '',
      '<other_character_context>',
      otherCharacterContextBody.trim(),
      '</other_character_context>',
    )
  }
  parts.push(
    '',
    '<system_prompt>',
    (persona_prompt_body || '').trim(),
    '</system_prompt>',
  )
  if (typeof custom_instructions === 'string' && custom_instructions.trim()) {
    parts.push('', '<custom_instructions>', custom_instructions.trim(), '</custom_instructions>')
  }
  return parts.join('\n')
}
