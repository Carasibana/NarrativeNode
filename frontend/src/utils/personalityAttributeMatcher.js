/**
 * Phase 2.11b item 8 — Personality attribute synonym matcher.
 *
 * The Character Chat Setup modal surfaces a hint when the character
 * has an attribute that describes their personality / temperament —
 * the writer is encouraged to put that kind of information into a
 * named attribute on the character entity so it gets pulled into the
 * dossier automatically. To find such an attribute we match the
 * attribute's name (case-insensitive) against a list of synonyms
 * writers commonly use. Doesn't have to be comprehensive — it's a
 * helper, not a hard gate. Misses just mean the Setup modal shows
 * the "add one?" hint instead of the preview.
 *
 * `Voice` is deliberately NOT in this list: writers also use it for
 * literal audio descriptions of a character's voice (timbre, pitch,
 * cadence), which is not personality. Matching on "Voice" would
 * surface audio-quality blurbs as if they were personality cues.
 *
 * Chain-aware: the attribute's value is resolved at the latest pin
 * anchor across the provided pins, NOT read from the entity's
 * baseline. So if a writer renamed the character's "Personality"
 * attribute or changed its value mid-chain, the Setup modal preview
 * reflects the chosen anchor's state.
 */
import { computeEffectiveState } from './narrativeChain'
import { useProjectStore } from '../store/projectStore'


// Case-insensitive synonym list. Writers commonly use one of these
// as the attribute name for personality / temperament information.
// Order doesn't matter — we return the first attribute the character
// has whose name matches any of these.
const PERSONALITY_ATTR_SYNONYMS = [
  'Personality',
  'Manner',
  'Mannerisms',
  'Disposition',
  'Demeanour',
  'Temperament',
  'Nature',
  'Behaviour',
  'Attitude',
  'Quirks',
  'Style',
]

const _SYNONYM_SET_LOWERCASE = new Set(
  PERSONALITY_ATTR_SYNONYMS.map((s) => s.toLowerCase()),
)


/**
 * Find a personality attribute on the character at the chosen
 * anchor. Returns `{name, value}` for the first matching attribute,
 * or `null` when none of the character's attributes match the
 * synonym list.
 *
 * @param {object|null} character — the character Entity object (raw,
 *                                  from `entitiesStore`).
 * @param {Array} pins — pin shapes from the anchor selector. Empty /
 *                       all-dynamic means resolve at baseline.
 * @returns {{name: string, value: any}|null}
 */
export function findPersonalityAttribute(character, pins = []) {
  if (!character) return null
  // Resolve the effective state at the latest pin anchor. Same shape
  // the assembly function uses for `{{character_name}}` resolution
  // (see `assembleCharacterChatSystemMessage.js`).
  let latestAnchor = null
  if (Array.isArray(pins)) {
    for (const pin of pins) {
      if (pin?.anchor_range?.end_node_id) {
        latestAnchor = pin.anchor_range.end_node_id
      } else if (pin?.anchor_node_id) {
        latestAnchor = pin.anchor_node_id
      }
    }
  }
  let attrs = []
  try {
    const proj = useProjectStore.getState()
    const nodes = proj.nodes || []
    const edges = proj.edges || []
    // Funnel both anchored and no-anchor cases through the chain
    // walker. With `upToNodeId === null` the walker returns the
    // entity's state with no modifiers applied (origin baseline,
    // which IS the chain-aware result when no anchor is selected —
    // there's no chain entry to read past). Keeps the read path
    // single-source: never a direct `character.attributes` read.
    const eff = computeEffectiveState(character, nodes, edges, latestAnchor || null)
    attrs = Array.isArray(eff?.attributes) ? eff.attributes : []
  } catch {
    attrs = []
  }
  for (const attr of attrs) {
    if (!attr || typeof attr.name !== 'string') continue
    if (_SYNONYM_SET_LOWERCASE.has(attr.name.toLowerCase())) {
      return { name: attr.name, value: attr.value }
    }
  }
  return null
}


// Exported for the Setup modal to display in the "no Personality
// attribute? Add one." hint (so the writer knows what names the
// matcher will pick up).
export { PERSONALITY_ATTR_SYNONYMS }
