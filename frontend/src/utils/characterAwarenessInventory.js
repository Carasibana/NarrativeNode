/**
 * Phase 2.11b — character awareness inventory for the assembled
 * `<character_context>` dossier.
 *
 * The dossier needs to know: "what does the focal character know about
 * everything else, at the chosen anchor?". The existing
 * `sceneContextPrompt.buildSceneContextBlock` walks the INVERSE (who
 * knows about a given pinned entity), which is the wrong direction for
 * a character chat.
 *
 * Naive approach: walk every entity / relationship / knowledge in the
 * project, compute full effective state at the anchor (one chain walk
 * per host), check whether the focal character appears as an observer.
 * Correct, but `O(N)` chain walks per send — pays a cost on hosts the
 * character has never been involved with. Doesn't scale to a
 * novel-length project where N can hit thousands.
 *
 * Proper approach (this file):
 *   1. Build an observer→targets index by scanning each awareness
 *      wrapper's RAW state ONCE — both the baseline observer dict and
 *      every `history[]` entry. Each scan is `O(history.length)` per
 *      target, far cheaper than a full chain walk, and bounded by the
 *      total number of awareness chain entries in the project.
 *      Result shape: Map<observer_id, Array<{host_kind, host_id,
 *      target_kind, target_attr_id?, target_alias_value?}>>.
 *   2. For each observer, group targets by host so each host's chain
 *      gets walked AT MOST ONCE per send — even if the character
 *      observes multiple of its targets (entity-level + name +
 *      attribute + alias all live on the same host entity).
 *   3. Walk the focal character's targets through the existing chain
 *      walkers (`computeEffectiveState` / `computeRelationshipEffectiveState`
 *      / `computeKnowledgeEffectiveState`) to resolve the level at the
 *      anchor. Skip hosts where the level is null at the anchor (the
 *      observer was in history at some point but isn't in the resolved
 *      dict at this position).
 *
 * Net cost per send is `O(total awareness history entries scanned once)`
 * + `O(hosts the focal character has touched × chain length)`. The
 * second term is bounded by the character's footprint in the project,
 * not the project's total size. Scales correctly with project growth.
 *
 * Chain-aware throughout:
 *   - Index build reads raw `awareness.history` arrays (not chain-
 *     resolved values); the history IS the chain, so this is the
 *     chain-aware read for "has this observer ever been recorded
 *     anywhere on this awareness."
 *   - Level resolution at the anchor goes through the chain walkers.
 *   - No direct-baseline value reads bypass either of the above.
 */
import { useProjectStore } from '../store/projectStore'
import { useEntitiesStore } from '../store/entitiesStore'
import {
  computeEffectiveState,
  computeRelationshipEffectiveState,
  computeKnowledgeEffectiveState,
  getRelationshipNodeOrder,
  getKnowledgeNodeOrder,
  resolveObserverAwarenessLevel,
} from './narrativeChain'
import { getOrComputeStoryOrderFromStore } from '../hooks/useStoryOrder'
import {
  awarenessLevelName,
  attributeValueString,
} from './chatContextFormatters'
import { participantsFallbackLabel } from './entityHelpers'
import { buildAwarenessObserverIndex } from './awarenessObserverIndex'


/**
 * Build the inventory of awareness entries for one focal character at
 * one anchor. Returns Array<{ kind, label, description, level }>
 * sorted aware-first (descending level), then unaware-last.
 */
export function buildCharacterAwarenessInventory(focalCharacterId, anchorNodeId) {
  if (!focalCharacterId) return []
  const proj = useProjectStore.getState()
  const ent = useEntitiesStore.getState()
  const nodes = proj.nodes || []
  const edges = proj.edges || []

  // Story order — needed by relationship + knowledge chain walkers.
  // Use the SHARED, cached order (the same one the canvas uses): the
  // character-chat assembler calls this builder once PER PIN, so a fresh
  // ~110ms graph walk here fired dozens of times per send. The story
  // order is GLOBAL (identical on every call), so the per-call recompute
  // was pure waste; the cache makes every call after the first a
  // near-free read. Best-effort: fall back to null on any failure and let
  // the walkers do canvas-x-position ordering.
  let storyOrder = null
  try {
    storyOrder = getOrComputeStoryOrderFromStore()
  } catch { storyOrder = null }

  // Gather all hosts.
  const characters = ent.characters || []
  const allEntities = [
    ...characters,
    ...(ent.locations || []),
    ...(ent.items || []),
    ...(ent.factions || []),
    ...(ent.customs || []),
  ]
  const relationships = proj.relationships || []
  const knowledges = proj.knowledges || []

  // Build the observer→targets index in one scan (shared utility —
  // see `awarenessObserverIndex.js` for the surface-iteration logic).
  const index = buildAwarenessObserverIndex(allEntities, relationships, knowledges)
  const targets = index.get(focalCharacterId) || []
  if (targets.length === 0) return []

  // Group targets by host so each host's chain gets walked at most
  // once per send. Key by `${host_kind}:${host_id}`.
  const byHost = new Map()
  for (const t of targets) {
    if (t.host_kind === 'entity' && t.host_id === focalCharacterId) continue  // skip self-awareness
    const key = `${t.host_kind}:${t.host_id}`
    let bucket = byHost.get(key)
    if (!bucket) { bucket = []; byHost.set(key, bucket) }
    bucket.push(t)
  }

  // Lookup maps for fast host resolution during the walk loop.
  const entityById = new Map(allEntities.map((e) => [e.id, e]))
  const relationshipById = new Map(relationships.map((r) => [r.id, r]))
  const knowledgeById = new Map(knowledges.map((k) => [k.id, k]))
  const getEntityById = (id) => entityById.get(id) || null

  const entries = []

  for (const [key, bucket] of byHost) {
    const sepIdx = key.indexOf(':')
    const hostKind = key.slice(0, sepIdx)
    const hostId = key.slice(sepIdx + 1)

    let eff = null
    try {
      if (hostKind === 'entity') {
        const entity = entityById.get(hostId)
        if (!entity) continue
        eff = computeEffectiveState(entity, nodes, edges, anchorNodeId)
      } else if (hostKind === 'relationship') {
        const rel = relationshipById.get(hostId)
        if (!rel) continue
        const nodeOrder = getRelationshipNodeOrder(rel, nodes, edges, storyOrder)
        eff = computeRelationshipEffectiveState(rel, nodeOrder, anchorNodeId)
      } else if (hostKind === 'knowledge') {
        const k = knowledgeById.get(hostId)
        if (!k) continue
        const nodeOrder = getKnowledgeNodeOrder(k, nodes, edges, storyOrder)
        eff = computeKnowledgeEffectiveState(k, nodeOrder, anchorNodeId)
      }
    } catch { eff = null }
    if (!eff) continue

    // Extract every target on this host that the focal character
    // observes at this anchor. Phase 2.12 — `_resolveLevelOnHost`
    // now routes the wrapper through `resolveObserverAwarenessLevel`
    // (with proper ctx) so the inheritance rules from
    // `narrativeChain.js` apply: direct entry wins, then faction-
    // membership cascade, relationship-source cascade, and entity-
    // list attribute-source cascade. Previously this read the flat
    // dict directly, missing inherited awareness entirely.
    const inheritanceCtx = {
      allEntities,
      allRelationships: relationships,
      nodes,
      edges,
      storyOrder,
      anchorNodeId,
    }
    for (const t of bucket) {
      const level = _resolveLevelOnHost(eff, t, focalCharacterId, inheritanceCtx)
      if (level == null) continue
      const entry = _formatEntry(eff, t, level, hostKind, getEntityById)
      if (entry) {
        // Phase 2.12 — stamp the host id / kind on each entry so the
        // two-character `<other_character_context>` block can filter
        // the inventory down to entries pointing at one specific
        // other character (or its sub-elements). Non-breaking — the
        // existing `formatAwarenessInventory` ignores unknown fields.
        entry.host_id = hostId
        entry.host_kind = hostKind
        entries.push(entry)
      }
    }
  }

  // Sort: aware (level > 0) before unaware (level === 0); within each
  // bucket, descending by level then by stable kind order.
  const KIND_ORDER = { knowledge: 0, relationship: 1, entity: 2, attribute: 3, alias: 4, entity_name: 5 }
  entries.sort((a, b) => {
    const aAware = a.level > 0 ? 0 : 1
    const bAware = b.level > 0 ? 0 : 1
    if (aAware !== bAware) return aAware - bAware
    if (b.level !== a.level) return b.level - a.level
    return (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)
  })

  return entries
}


/**
 * Pull the focal character's awareness level for a specific target
 * descriptor off a host's chain-resolved effective state. Returns the
 * level number (0..3) or `null` if the character isn't present in the
 * resolved dict at this anchor (which can happen even when the index
 * said they appeared in history — they may have been removed by a
 * later chain event).
 */
function _resolveLevelOnHost(eff, t, observerId, ctx) {
  if (!eff) return null
  let wrapper = null
  if (t.target_kind === 'entity'        || t.target_kind === 'relationship' || t.target_kind === 'knowledge') {
    wrapper = eff.awareness_raw ?? eff.awareness
  } else if (t.target_kind === 'entity_name') {
    wrapper = eff.name_awareness_raw ?? eff.name_awareness
  } else if (t.target_kind === 'attribute') {
    const attr = (eff.attributes || []).find((a) => a.id === t.target_attr_id)
    wrapper = attr?.awareness_raw ?? attr?.awareness
  } else if (t.target_kind === 'alias') {
    const al = (eff.aliases || []).find((a) => (typeof a === 'object' && a?.value === t.target_alias_value))
    wrapper = al?.awareness_raw ?? al?.awareness
  }
  if (!wrapper) return null
  // Phase 2.12 — was: `const lv = flatAwareness(wrapper)[observerId]`
  // which read only DIRECT observer entries and missed every form of
  // inheritance (faction-membership cascade, relationship-source
  // cascade, attribute-source cascade). Route through the chain-aware
  // resolver in `narrativeChain.js` so inheritance applies properly.
  // The resolver applies precedence: direct entry wins, then the max
  // of every applicable inherited source. Returns null when neither
  // direct nor inherited paths produce a level.
  const lv = resolveObserverAwarenessLevel(wrapper, observerId, ctx || {})
  return typeof lv === 'number' ? lv : null
}


/**
 * Build the displayable inventory entry from a resolved level + the
 * target descriptor + the host's effective state. Returns null if the
 * target can't be labelled (e.g. attribute id was stripped from the
 * effective state at this anchor).
 */
function _formatEntry(eff, t, level, hostKind, getEntityById) {
  if (hostKind === 'entity') {
    const targetName = eff.name || '(unnamed entity)'
    if (t.target_kind === 'entity') {
      return { kind: 'entity', label: targetName, description: eff.description || '', level }
    }
    if (t.target_kind === 'entity_name') {
      return { kind: 'entity_name', label: `the name "${targetName}"`, description: '', level }
    }
    if (t.target_kind === 'attribute') {
      const attr = (eff.attributes || []).find((a) => a.id === t.target_attr_id)
      if (!attr) return null
      return {
        kind: 'attribute',
        label: `${targetName}'s "${attr.name || '(unnamed attribute)'}" attribute`,
        description: attributeValueString(attr) || '',
        level,
      }
    }
    if (t.target_kind === 'alias') {
      return {
        kind: 'alias',
        label: `${targetName}'s alias "${t.target_alias_value || '(unnamed)'}"`,
        description: '',
        level,
      }
    }
  }
  if (hostKind === 'relationship' && t.target_kind === 'relationship') {
    const customName = (eff.name || '').trim()
    const participants = (eff.participants || []).map((p) => p.entity_id).filter(Boolean)
    const label = customName
      || participantsFallbackLabel(participants, getEntityById, Infinity, eff, null)
      || '(unnamed relationship)'
    return { kind: 'relationship', label, description: eff.description || '', level }
  }
  if (hostKind === 'knowledge' && t.target_kind === 'knowledge') {
    return {
      kind: 'knowledge',
      label: eff.name || '(unnamed knowledge)',
      description: eff.description || '',
      level,
    }
  }
  return null
}


/**
 * Render the inventory as plain text suitable for splicing into the
 * `<character_context>` block. Aware entries get the level-labelled
 * descriptor; explicitly-unaware entries get a meta-instruction so the
 * LLM honours the blind spot without confabulating around the
 * reference.
 */
export function formatAwarenessInventory(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return ''
  const KIND_LABEL = {
    entity: 'Entity',
    entity_name: 'Entity name',
    attribute: 'Attribute',
    alias: 'Alias',
    relationship: 'Relationship',
    knowledge: 'Knowledge',
  }
  const lines = []
  lines.push("**What this character is aware of and unaware of** (chain-resolved at the chosen anchor):")
  lines.push('')
  for (const e of entries) {
    const tag = KIND_LABEL[e.kind] || '?'
    lines.push(`[${tag}] ${e.label}`)
    if (e.description) lines.push(`  About: ${e.description}`)
    if (Number(e.level) === 0) {
      lines.push(
        `  Awareness: ${awarenessLevelName(0)} — the character does NOT know this. ` +
        `If the writer references it, react in-character as someone genuinely unfamiliar; ` +
        `do not acknowledge any aspect of it.`,
      )
    } else {
      lines.push(`  Awareness: ${awarenessLevelName(e.level)}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
