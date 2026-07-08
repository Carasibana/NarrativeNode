/**
 * Phase 1.24d global search engine.
 *
 * Single entry: `runGlobalSearch(query, scopeFlags, project, entities)`
 * returns
 *
 *     { groups: [{ groupKey, results: [...] }], totalCount }
 *
 * Pure function. id-only result payloads (name resolution stays in
 * the modal's render layer). Case-insensitive substring match.
 *
 * The search reads explicit entries only:
 *   - For chain-tracked objects (entities, relationships, knowledges)
 *     it checks the BASELINE on the origin object, plus every chain
 *     entry that adds or modifies a value (skipping `remove` actions
 *     because they have no value to match against). It does NOT
 *     re-derive the effective state at each chain stop — inherited
 *     values produce no result. The first time the value is set,
 *     and any subsequent explicit change, are emitted with their
 *     own anchor node.
 *   - Non-chain objects (scenes, chapters, acts, transition_text,
 *     non-scene canvas-node titles) emit a single result anchored
 *     at the object itself.
 *
 * Each result row is annotated with `anchorNodeId` for chain-tracked
 * matches (origin node id or the scene / modifier node where the
 * change entry sits) so the modal can render
 *
 *     [Item identity badge] [field label] @ [chain-anchor badge] : snippet
 *
 * For non-chain matches `anchorNodeId` is null and the modal omits
 * the chain-anchor badge.
 *
 * V1 stance (per the per-pillar planning doc):
 *   - Live-on-keystroke. No debounce.
 *   - Cache TipTap-derived plain text once per scene per session via
 *     `sceneTextCache`. No other caches.
 *   - No Web Worker; everything runs on the main thread.
 *   - 25 results per group cap. Surplus indicated as a "+N more"
 *     group footer (the engine includes the count; the modal renders
 *     it).
 *   - Out-of-scope work — debounce, indexing, worker thread,
 *     fuzzy / edit-distance / synonym matching — is deferred to a
 *     later phase if writer feedback flags lag.
 */

import { ENTITY_BUCKETS } from './entityHelpers.js'
import { getSceneText } from './sceneTextCache.js'
import { buildSnippet } from './searchSnippet.js'
import { htmlToPlainText } from './htmlToPlainText.js'

const RESULTS_PER_GROUP_CAP = 25

// Group keys in render order. The modal renders every present group
// in this order; absent groups are skipped at render time. Matches
// the SCOPE_CHIPS order in the modal so result groups appear in the
// same sequence the writer sees in the filter row.
const GROUP_ORDER = [
  'characters',
  'locations',
  'items',
  'factions',
  'customs',
  'knowledges',
  'relationships',
  'cues',
  'references',
  'attributes',
  'circumstances',
  'motivators',
  'perspectives',
  'scenes',
  'chapters',
  'acts',
  'other',
]

// ────────────────────────────────────────────────────────────────────────
// Match utilities
// ────────────────────────────────────────────────────────────────────────

function findAllMatches(haystack, needleLower) {
  if (!haystack || typeof haystack !== 'string') return []
  const lower = haystack.toLowerCase()
  const out = []
  let idx = 0
  while (idx <= lower.length - needleLower.length) {
    const next = lower.indexOf(needleLower, idx)
    if (next < 0) break
    out.push(next)
    idx = next + Math.max(1, needleLower.length)
  }
  return out
}

/**
 * Build a `matches` payload from a single field's text. Returns
 * `null` if the field doesn't match (so callers can skip without
 * any allocations). Otherwise emits one entry with the FIRST match's
 * snippet plus an `additionalCount` for any further offsets.
 */
function makeFieldMatch(text, needleLower, fieldLabel) {
  const offsets = findAllMatches(text, needleLower)
  if (offsets.length === 0) return null
  const first = offsets[0]
  const snippet = buildSnippet(text, first, needleLower.length, 120, offsets.length - 1)
  return { fieldLabel, snippet }
}

// ────────────────────────────────────────────────────────────────────────
// Result accumulator with per-group cap
// ────────────────────────────────────────────────────────────────────────

function makeAccumulator() {
  return {
    groups: new Map(GROUP_ORDER.map((k) => [k, { results: [], overflow: 0 }])),
    totalCount: 0,
  }
}

function pushResult(acc, groupKey, result) {
  const g = acc.groups.get(groupKey) || acc.groups.get('other')
  if (!g) return
  if (g.results.length >= RESULTS_PER_GROUP_CAP) {
    g.overflow += 1
    return
  }
  g.results.push(result)
  acc.totalCount += 1
}

/** Per per-pillar plan tier mapping (V1, no fuzzy / synonym):
 *    tier 1 — name / title fields                     (most semantically central)
 *    tier 2 — descriptions
 *    tier 3 — aliases, attributes, transitions, c / m, alias-overrides
 *    tier 4 — long-form body text (scene main_content, reference content)
 *    tier 5 — non-scene node titles (low-signal canvas labels)
 *  Anything that doesn't match falls to tier 9 so it sorts last. */
function fieldLabelToTier(fieldLabel, kind) {
  const f = fieldLabel || ''
  if (kind === 'referenceNote' && f === 'Reference') return 4
  if (kind === 'groupNode' && f === 'Group') return 5
  if (kind === 'povOriginNode' && f === 'POV') return 5
  if (f === 'Name' || f === 'Title' || f === 'Chapter' || f === 'Act') return 1
  if (f === 'Description') return 2
  if (f.startsWith('Alias') || f.startsWith('Attribute') || f === 'Transition' || f.startsWith('Circumstance') || f.startsWith('Motivator')) return 3
  if (f === 'Name change' || f === 'Description change' || f === 'Alias change') return 3
  if (f === 'Scene Content' || f === 'Body') return 4
  return 9
}

function finalize(acc) {
  const groups = []
  for (const key of GROUP_ORDER) {
    const g = acc.groups.get(key)
    if (!g || g.results.length === 0) continue
    // Within-group sort: tier ascending (tier 1 first), then by the
    // visible match text alphabetically as a stable tie-breaker.
    g.results.sort((a, b) => {
      const ta = fieldLabelToTier(a.fieldLabel, a.kind)
      const tb = fieldLabelToTier(b.fieldLabel, b.kind)
      if (ta !== tb) return ta - tb
      const la = (a.snippet?.match || '').toLowerCase()
      const lb = (b.snippet?.match || '').toLowerCase()
      return la < lb ? -1 : la > lb ? 1 : 0
    })
    groups.push({ groupKey: key, results: g.results, overflow: g.overflow })
  }
  return { groups, totalCount: acc.totalCount }
}

// ────────────────────────────────────────────────────────────────────────
// Entity scope (chain-tracked)
//
// For each entity in scope, check the origin baseline plus every
// chain entry that explicitly sets a value. The chain-walking
// utility is deliberately NOT used — we don't need effective state,
// just the explicit entries. Walking node lists by `entity_id`
// avoids the cost of a full chain walker run per keystroke.
//
// For each match, the anchor is:
//   - origin entityNode for baseline matches
//   - the modifier entityNode (is_modifier=true) for changes set on
//     a modifier node
//   - the sceneNode whose chip carries the change for changes set on
//     a scene chip
// ────────────────────────────────────────────────────────────────────────

const ENTITY_TYPE_TO_SCOPE = {
  character: 'characters',
  location: 'locations',
  item: 'items',
  faction: 'factions',
  custom: 'customs',
}

/** Bucket an entity into the canonical group key. Each entity type
 *  has its own result group (Characters / Locations / Items /
 *  Factions / Customs); knowledges keep their own group. The SCOPE
 *  filter chip uses the same key so a one-to-one mapping holds
 *  between chip and group. */
function entityGroupKey(entity) {
  if (!entity || !entity.type) return 'other'
  const t = entity.type
  if (t === 'character') return 'characters'
  if (t === 'location')  return 'locations'
  if (t === 'item')      return 'items'
  if (t === 'faction')   return 'factions'
  if (t === 'custom')    return 'customs'
  if (t === 'knowledge') return 'knowledges'
  return 'other'
}
function entityScopeKey(entity) {
  if (!entity || !entity.type) return null
  if (entity.type === 'knowledge') return 'knowledges'
  return ENTITY_TYPE_TO_SCOPE[entity.type] || null
}

function originNodeForEntity(entityId, nodes) {
  return nodes.find(
    (n) => n.type === 'entityNode' && n.data?.is_modifier !== true && n.data?.entity_id === entityId,
  )
}

/** Yield every chain stop for an entity past origin: modifier nodes
 *  whose entity_id matches, plus sceneNodes that carry a chip for
 *  this entity. The order doesn't matter for search — each entry is
 *  independent and self-anchoring. */
function* chainStopsForEntity(entityId, nodes) {
  for (const n of nodes) {
    if (n.type === 'entityNode' && n.data?.is_modifier === true && n.data?.entity_id === entityId) {
      yield { node: n, ref: n.data }
    } else if (n.type === 'sceneNode') {
      for (const b of ENTITY_BUCKETS) {
        const ref = (n.data?.[b] || []).find((r) => r.entity_id === entityId)
        if (ref) {
          yield { node: n, ref }
          break
        }
      }
    }
  }
}

/** Look up an attribute's identifying definition (name + attribute_type)
 *  from its origin — the chain stop where it was first created.
 *  Attributes created at the entity's origin EntityNode live in
 *  `entity.attributes[]`; attributes created downstream via an
 *  `action='add'` chain entry live on the add entry's embedded
 *  `attribute` payload. Returns `{ name, attributeType }` (either
 *  field may be null if unresolved or not set).
 *
 *  Note: this is identity resolution ("which attribute is this and
 *  what kind?"), not chain-aware value computation. An attribute's
 *  name and type are properties of its origin definition; modify
 *  entries don't rename or retype attributes. Used by the search
 *  engine to label result rows and route them to the right group. */
function resolveAttributeDef(entity, nodes, attributeId) {
  if (!attributeId) return { name: null, attributeType: null }
  const baselineHit = (entity?.attributes || []).find((a) => a && a.id === attributeId)
  if (baselineHit) return { name: baselineHit.name || null, attributeType: baselineHit.attribute_type || null }
  for (const n of nodes) {
    if (n.type === 'entityNode' && n.data?.is_modifier === true && n.data?.entity_id === entity.id) {
      for (const ac of n.data?.attribute_changes || []) {
        if (ac?.action === 'add' && ac.attribute?.id === attributeId) {
          return { name: ac.attribute.name || null, attributeType: ac.attribute.attribute_type || null }
        }
      }
    } else if (n.type === 'sceneNode') {
      for (const b of ENTITY_BUCKETS) {
        const ref = (n.data?.[b] || []).find((r) => r.entity_id === entity.id)
        if (!ref) continue
        for (const ac of ref.attribute_changes || []) {
          if (ac?.action === 'add' && ac.attribute?.id === attributeId) {
            return { name: ac.attribute.name || null, attributeType: ac.attribute.attribute_type || null }
          }
        }
        break
      }
    }
  }
  return { name: null, attributeType: null }
}

/** Map an attribute to its result-row routing — `circumstance` /
 *  `motivator` attributes flow to their own groups + chips, every
 *  other attribute type lands in the generic Attributes group. */
function attributeRouting(attributeType) {
  if (attributeType === 'circumstance') return { groupKey: 'circumstances', flagKey: 'circumstances', kind: 'circumstance' }
  if (attributeType === 'motivator')   return { groupKey: 'motivators',    flagKey: 'motivators',    kind: 'motivator'  }
  if (attributeType === 'perspective') return { groupKey: 'perspectives',  flagKey: 'perspectives',  kind: 'perspective' }
  return { groupKey: 'attributes', flagKey: 'attributes', kind: 'attribute' }
}

/** Knowledge content changes (name / description) live on the
 *  Knowledge's own `history.*_changes` arrays, anchored by `node_id`,
 *  NOT on `EntityRef.*_change` fields like entities use. Walk them
 *  here and emit a result row per matching change entry, anchored at
 *  the change's `node_id`. */
function addKnowledgeChainResults(acc, knowledge, needleLower) {
  const groupKey = 'knowledges'
  const history = knowledge.history || {}
  for (const c of history.name_changes || []) {
    if (!c) continue
    const m = makeFieldMatch(c.new_name, needleLower, 'Name change')
    if (m) pushResult(acc, groupKey, {
      kind: 'knowledge',
      id: knowledge.id,
      anchorNodeId: c.node_id || null,
      ...m,
    })
  }
  for (const c of history.description_changes || []) {
    if (!c) continue
    const m = makeFieldMatch(c.new_description, needleLower, 'Description change')
    if (m) pushResult(acc, groupKey, {
      kind: 'knowledge',
      id: knowledge.id,
      anchorNodeId: c.node_id || null,
      ...m,
    })
  }
}

function addEntityResults(acc, entity, nodes, needleLower, scopeFlags) {
  const groupKey = entityGroupKey(entity)
  const scopeKey = entityScopeKey(entity)
  // Per-section gates. The sub-type chip (Characters, Locations, etc.)
  // controls the entity-itself matches (name / description / aliases /
  // alias_changes). The Attributes / Circumstances / Motivators chips
  // are independent of the sub-type chip — turning the sub-type off
  // does NOT hide attribute / c / m matches on that entity. Each
  // attribute is routed to one of those three groups via
  // `attributeRouting(attributeType)` based on its `attribute_type`:
  // circumstance / motivator attributes flow to their own groups +
  // chips, every other attribute type stays under Attributes.
  const subTypeOn = scopeKey ? !!scopeFlags[scopeKey] : true
  const attributesOn = !!scopeFlags.attributes
  const circumstancesOn = !!scopeFlags.circumstances
  const motivatorsOn = !!scopeFlags.motivators
  if (!subTypeOn && !attributesOn && !circumstancesOn && !motivatorsOn) return

  const origin = originNodeForEntity(entity.id, nodes)
  const originId = origin?.id || null

  // Baseline pass — values that exist directly on the entity object.
  // These are emitted with the origin node as their anchor (or null
  // if no origin node was found — defensive; shouldn't happen for a
  // real entity in a loaded story).
  if (subTypeOn) {
    const baseFields = [
      { label: 'Name',        text: entity.name },
      { label: 'Description', text: entity.description },
    ]
    for (const f of baseFields) {
      const m = makeFieldMatch(f.text, needleLower, f.label)
      if (!m) continue
      pushResult(acc, groupKey, {
        kind: entity.type === 'knowledge' ? 'knowledge' : 'entity',
        id: entity.id,
        anchorNodeId: originId,
        ...m,
      })
    }
  }

  // Baseline attributes — name OR value. Each attribute is routed to
  // its proper group + chip via `attributeRouting(attr.attribute_type)`:
  // circumstance / motivator attributes flow to those chips and
  // groups, every other attribute type stays under Attributes. This
  // means a circumstance defined at an entity's origin is gated by
  // the **Circumstances** chip, not the Attributes chip — same chip
  // controls the same conceptual data wherever it lives.
  if (Array.isArray(entity.attributes)) {
    for (const attr of entity.attributes) {
      if (!attr) continue
      const routing = attributeRouting(attr.attribute_type)
      if (!scopeFlags[routing.flagKey]) continue
      const rawName = typeof attr.name === 'string' && attr.name.trim().length > 0 ? attr.name : null
      const fieldLabel = `Attribute: ${rawName || '(unnamed)'}`
      let m = makeFieldMatch(attr.name, needleLower, fieldLabel)
      if (!m) m = makeFieldMatch(typeof attr.value === 'string' ? attr.value : '', needleLower, fieldLabel)
      if (!m) m = makeFieldMatch(typeof attr.description === 'string' ? attr.description : '', needleLower, fieldLabel)
      if (!m) continue
      pushResult(acc, routing.groupKey, {
        kind: routing.kind,
        action: 'add',
        attributeName: rawName,
        attributeType: attr.attribute_type || null,
        description: typeof attr.description === 'string' ? attr.description : null,
        intensity: typeof attr.intensity === 'number' ? attr.intensity : null,
        id: `${entity.id}:${attr.id || attr.name || ''}`,
        entityId: entity.id,
        attributeId: attr.id || null,
        anchorNodeId: originId,
        ...m,
      })
    }
  }

  // Baseline aliases — gated by the entity sub-type chip (aliases
  // are entity-itself state, not attributes).
  if (subTypeOn && Array.isArray(entity.aliases)) {
    for (const alias of entity.aliases) {
      if (!alias) continue
      const text = typeof alias.value === 'string' ? alias.value : (typeof alias === 'string' ? alias : '')
      const m = makeFieldMatch(text, needleLower, `Alias: ${text}`)
      if (!m) continue
      pushResult(acc, groupKey, {
        kind: entity.type === 'knowledge' ? 'knowledge' : 'entity',
        id: entity.id,
        anchorNodeId: originId,
        ...m,
      })
    }
  }

  // Chain pass — explicit change entries only. Each entry is
  // checked independently; no inheritance / effective-state
  // tracking. Inherited values (chip exists at a node but no change
  // entry for the field in question) emit nothing.
  for (const stop of chainStopsForEntity(entity.id, nodes)) {
    const { node, ref } = stop
    if (!ref) continue
    // Name / description / alias changes are entity-itself fields,
    // gated by the entity sub-type chip.
    if (subTypeOn && ref.name_change != null) {
      const m = makeFieldMatch(ref.name_change, needleLower, 'Name change')
      if (m) pushResult(acc, groupKey, {
        kind: entity.type === 'knowledge' ? 'knowledge' : 'entity',
        id: entity.id,
        anchorNodeId: node.id,
        ...m,
      })
    }
    if (subTypeOn && ref.description_change != null) {
      const m = makeFieldMatch(ref.description_change, needleLower, 'Description change')
      if (m) pushResult(acc, groupKey, {
        kind: entity.type === 'knowledge' ? 'knowledge' : 'entity',
        id: entity.id,
        anchorNodeId: node.id,
        ...m,
      })
    }
    // Attribute changes — `add` and `modify` only (`remove` has no
    // value to match against). Each entry routes to its own group +
    // chip via `attributeRouting(attribute_type)`: circumstance and
    // motivator chain entries land in the **Circumstances** /
    // **Motivators** groups, every other attribute_type stays under
    // **Attributes**.
    if (Array.isArray(ref.attribute_changes)) {
      for (const ac of ref.attribute_changes) {
        if (!ac) continue
        if (ac.action === 'add' && ac.attribute) {
          const a = ac.attribute
          const routing = attributeRouting(a.attribute_type)
          if (!scopeFlags[routing.flagKey]) continue
          const rawName = typeof a.name === 'string' && a.name.trim().length > 0 ? a.name : null
          const fieldLabel = `Attribute: ${rawName || '(unnamed)'}`
          let m = makeFieldMatch(a.name, needleLower, fieldLabel)
          if (!m) m = makeFieldMatch(typeof a.value === 'string' ? a.value : '', needleLower, fieldLabel)
          if (!m) m = makeFieldMatch(typeof a.description === 'string' ? a.description : '', needleLower, fieldLabel)
          if (m) pushResult(acc, routing.groupKey, {
            kind: routing.kind,
            action: 'add',
            attributeName: rawName,
            attributeType: a.attribute_type || null,
            description: typeof a.description === 'string' ? a.description : null,
            intensity: typeof a.intensity === 'number' ? a.intensity : null,
            id: `${entity.id}:${a.id || a.name || ''}@${node.id}`,
            entityId: entity.id,
            attributeId: a.id || null,
            anchorNodeId: node.id,
            ...m,
          })
        } else if (ac.action === 'modify') {
          const def = resolveAttributeDef(entity, nodes, ac.attribute_id)
          const routing = attributeRouting(def.attributeType)
          if (!scopeFlags[routing.flagKey]) continue
          const newValue = typeof ac.new_value === 'string' ? ac.new_value : ''
          const newDescription = typeof ac.new_description === 'string' ? ac.new_description : null
          const newIntensity = typeof ac.new_intensity === 'number' ? ac.new_intensity : null
          const rawName = typeof def.name === 'string' && def.name.trim().length > 0 ? def.name : null
          const fieldLabel = `Attribute: ${rawName || '(unnamed)'}`
          // For circumstance / motivator modify entries, also match
          // against `new_description` (the c/m descriptive text uses
          // its own field, not `new_value`).
          let m = makeFieldMatch(newValue, needleLower, fieldLabel)
          if (!m) m = makeFieldMatch(newDescription, needleLower, fieldLabel)
          if (m) pushResult(acc, routing.groupKey, {
            kind: routing.kind,
            action: 'modify',
            attributeName: rawName,
            attributeType: def.attributeType,
            description: newDescription,
            newValue: newValue || null,
            newIntensity,
            id: `${entity.id}:${ac.attribute_id || ''}@${node.id}`,
            entityId: entity.id,
            attributeId: ac.attribute_id || null,
            anchorNodeId: node.id,
            ...m,
          })
        }
      }
    }
    // Alias changes — per-event `alias_changes` (post v0.2.1.76).
    // Index alias values from `add` events (chain-added alias
    // searchable from the scene it was added) and from `modify`
    // events (renamed value searchable from the scene the rename
    // landed).
    if (Array.isArray(ref.alias_changes) && ref.alias_changes.length > 0) {
      for (const ev of ref.alias_changes) {
        if (!ev || typeof ev !== 'object') continue
        let text = ''
        if (ev.action === 'add' && ev.alias) {
          text = typeof ev.alias.value === 'string' ? ev.alias.value : ''
        } else if (ev.action === 'modify' && typeof ev.new_value === 'string') {
          text = ev.new_value
        }
        if (!text) continue
        const m = makeFieldMatch(text, needleLower, `Alias change: ${text}`)
        if (!m) continue
        pushResult(acc, groupKey, {
          kind: entity.type === 'knowledge' ? 'knowledge' : 'entity',
          id: entity.id,
          anchorNodeId: node.id,
          ...m,
        })
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Relationship scope (chain-tracked, history lives on the relationship)
//
// Match against:
//   - baseline `name` (when set; relationships fall back to a
//     resolver-derived participants label when null, which we don't
//     match against here — only the user-set name is searchable)
//   - baseline `description`
//   - chain `history.name_changes[].new_name`
//   - chain `history.description_changes[].new_description`
//   - chain `history.alias_changes[].new_alias_override` (per-
//     participant alias overrides recorded at a chain anchor)
//
// Anchor for baseline matches: `creation_anchor_node_id` (the
// relationship's own origin per the chain model). Anchor for chain
// matches: the change entry's `node_id`.
// ────────────────────────────────────────────────────────────────────────

function addRelationshipResults(acc, rel, needleLower) {
  if (!rel) return
  const originId = rel.creation_anchor_node_id || null

  // Baseline name (only when explicitly set — null name relies on a
  // resolver-derived label that's not part of the user's authored
  // text and shouldn't be searchable as if it were).
  if (typeof rel.name === 'string' && rel.name.length > 0) {
    const m = makeFieldMatch(rel.name, needleLower, 'Name')
    if (m) pushResult(acc, 'relationships', {
      kind: 'relationship',
      id: rel.id,
      anchorNodeId: originId,
      ...m,
    })
  }
  if (typeof rel.description === 'string' && rel.description.length > 0) {
    const m = makeFieldMatch(rel.description, needleLower, 'Description')
    if (m) pushResult(acc, 'relationships', {
      kind: 'relationship',
      id: rel.id,
      anchorNodeId: originId,
      ...m,
    })
  }

  const history = rel.history || {}
  for (const c of history.name_changes || []) {
    if (!c) continue
    const m = makeFieldMatch(c.new_name, needleLower, 'Name change')
    if (m) pushResult(acc, 'relationships', {
      kind: 'relationship',
      id: rel.id,
      anchorNodeId: c.node_id || null,
      ...m,
    })
  }
  for (const c of history.description_changes || []) {
    if (!c) continue
    const m = makeFieldMatch(c.new_description, needleLower, 'Description change')
    if (m) pushResult(acc, 'relationships', {
      kind: 'relationship',
      id: rel.id,
      anchorNodeId: c.node_id || null,
      ...m,
    })
  }
  for (const c of history.alias_changes || []) {
    if (!c) continue
    const m = makeFieldMatch(c.new_alias_override, needleLower, 'Alias change')
    if (m) pushResult(acc, 'relationships', {
      kind: 'relationship',
      id: rel.id,
      anchorNodeId: c.node_id || null,
      ...m,
    })
  }
}

// ────────────────────────────────────────────────────────────────────────
// Circumstance / Motivator scope (non-chain, scene-scoped)
//
// Two storage shapes covered here:
//   - `SceneNode.circumstances[]` — Circumstance objects (`id`, optional
//     `name`, `description`, optional `intensity`). Apply to every
//     entity in the scene; not chain-tracked. Scene-side circumstances
//     have NO motivator equivalent (Phase 1.22 chose circumstance-only
//     at the scene level).
//   - `SceneNode.entity_temporary_circumstances[]` — EntityTemporaryCM
//     objects (`id`, `entity_id`, `attribute_type` ∈ {circumstance,
//     motivator}, `name`, `description`, `intensity`). Scoped to one
//     entity at one scene; not chain-tracked.
//
// Entity-attribute circumstance / motivator records (Attribute with
// `attribute_type='circumstance'|'motivator'`) live on the regular
// entity-attribute chain machinery and are searched via the
// `attributes` chip + `addEntityResults` — not duplicated here.
//
// Each match is anchored at the scene the record sits on (so the
// modal's NodeBadge reads as the scene where the c/m applies).
// ────────────────────────────────────────────────────────────────────────

function addCircumstanceMotivatorResults(acc, sceneNode, needleLower, scopeFlags) {
  if (!sceneNode || sceneNode.type !== 'sceneNode') return
  const data = sceneNode.data || {}
  const sceneId = sceneNode.id

  // Scene-side circumstances (gated by the `circumstances` chip).
  if (scopeFlags.circumstances && Array.isArray(data.circumstances)) {
    for (const c of data.circumstances) {
      if (!c) continue
      const labelText = c.name || c.description || '(unnamed)'
      let m = makeFieldMatch(c.name, needleLower, `Circumstance: ${labelText}`)
      if (!m) m = makeFieldMatch(c.description, needleLower, `Circumstance: ${labelText}`)
      if (!m) continue
      pushResult(acc, 'circumstances', {
        kind: 'circumstance',
        action: 'add',
        attributeName: c.name || null,
        attributeType: 'circumstance',
        description: typeof c.description === 'string' ? c.description : null,
        intensity: typeof c.intensity === 'number' ? c.intensity : null,
        id: `${sceneId}:${c.id || ''}`,
        sceneId,
        anchorNodeId: sceneId,
        ...m,
      })
    }
  }

  // Temporary entity-scoped circumstances / motivators.
  const temps = Array.isArray(data.entity_temporary_circumstances) ? data.entity_temporary_circumstances : []
  for (const t of temps) {
    if (!t) continue
    const isCircumstance = t.attribute_type === 'circumstance'
    const isMotivator = t.attribute_type === 'motivator'
    const groupKey = isCircumstance ? 'circumstances' : isMotivator ? 'motivators' : null
    const flagOn = (isCircumstance && scopeFlags.circumstances) || (isMotivator && scopeFlags.motivators)
    if (!groupKey || !flagOn) continue
    const labelText = t.name || t.description || '(unnamed)'
    const fieldPrefix = isCircumstance ? 'Circumstance' : 'Motivator'
    let m = makeFieldMatch(t.name, needleLower, `${fieldPrefix}: ${labelText}`)
    if (!m) m = makeFieldMatch(t.description, needleLower, `${fieldPrefix}: ${labelText}`)
    if (!m) continue
    pushResult(acc, groupKey, {
      kind: isCircumstance ? 'circumstance' : 'motivator',
      action: 'add',
      attributeName: t.name || null,
      attributeType: isCircumstance ? 'circumstance' : 'motivator',
      description: typeof t.description === 'string' ? t.description : null,
      intensity: typeof t.intensity === 'number' ? t.intensity : null,
      isTemporary: true,
      id: `${sceneId}:${t.id || ''}`,
      sceneId,
      entityId: t.entity_id || null,
      anchorNodeId: sceneId,
      ...m,
    })
  }
}

// ────────────────────────────────────────────────────────────────────────
// Scene scope (non-chain)
// ────────────────────────────────────────────────────────────────────────

function addSceneResults(acc, scene, needleLower) {
  // Title and description match directly off the scene's data.
  const titleMatch = makeFieldMatch(scene.title, needleLower, 'Title')
  if (titleMatch) {
    pushResult(acc, 'scenes', {
      kind: 'scene',
      id: scene.id,
      anchorNodeId: null,
      ...titleMatch,
    })
  }
  const descMatch = makeFieldMatch(scene.description, needleLower, 'Description')
  if (descMatch) {
    pushResult(acc, 'scenes', {
      kind: 'scene',
      id: scene.id,
      anchorNodeId: null,
      ...descMatch,
    })
  }
  // main_content goes through the per-scene plain-text cache so
  // typing-while-modal-open stays cheap. User-facing label matches
  // the "Scene Content" affordance in the left sidebar.
  const mainText = getSceneText(scene.id, scene.main_content || '')
  const mainMatch = makeFieldMatch(mainText, needleLower, 'Scene Content')
  if (mainMatch) {
    pushResult(acc, 'scenes', {
      kind: 'scene',
      id: scene.id,
      anchorNodeId: null,
      ...mainMatch,
    })
  }
}

// ────────────────────────────────────────────────────────────────────────
// Connection edge transition_text scope (non-chain)
//
// Each connection in `story.connections` (mirrored on `projectStore.edges`
// as React Flow edges with the original connection in `e.data`) carries
// an optional `transition_text` — the writer's note for the bridge
// between two scenes. Match these and group under **Scenes** since
// transitions are scene-to-scene bridges.
//
// Anchor on the source node so the modal's NodeBadge reads as the
// scene the transition exits from. The modal builds the row label by
// resolving both source + target scene titles for context.
// ────────────────────────────────────────────────────────────────────────

function addTransitionResults(acc, edges, needleLower) {
  for (const e of edges || []) {
    const c = e?.data
    if (!c) continue
    if (c.is_pov_path || c.is_relationship) continue
    const text = typeof c.transition_text === 'string' ? c.transition_text : ''
    const m = makeFieldMatch(text, needleLower, 'Transition')
    if (!m) continue
    pushResult(acc, 'scenes', {
      kind: 'transition',
      id: c.id || e.id,
      sourceNodeId: c.source_node_id || null,
      targetNodeId: c.target_node_id || null,
      anchorNodeId: c.source_node_id || null,
      ...m,
    })
  }
}

// ────────────────────────────────────────────────────────────────────────
// Chapter / Act name coverage (non-chain)
//
// Chapters and acts are story-level structural objects defined in
// Phase 1.11 (column-division view). Each has a `title` string the
// writer can search. Grouped under **Scenes** since chapters / acts
// organise scenes; gated by the **Scenes** chip.
// ────────────────────────────────────────────────────────────────────────

function addChapterResults(acc, story, needleLower) {
  for (const c of story?.chapters || []) {
    if (!c) continue
    const m = makeFieldMatch(c.title, needleLower, 'Chapter')
    if (m) pushResult(acc, 'chapters', {
      kind: 'chapter',
      id: c.id,
      colour: c.colour || null,
      anchorNodeId: null,
      ...m,
    })
  }
}

function addActResults(acc, story, needleLower) {
  for (const a of story?.acts || []) {
    if (!a) continue
    const m = makeFieldMatch(a.title, needleLower, 'Act')
    if (m) pushResult(acc, 'acts', {
      kind: 'act',
      id: a.id,
      colour: a.colour || null,
      anchorNodeId: null,
      ...m,
    })
  }
}

// ────────────────────────────────────────────────────────────────────────
// Non-scene canvas-node coverage (reference notes, generic groups,
// POV origin)
//
// First-class node types whose content has its own home group are
// already covered by their respective scopes:
//   - entityNode (origin / modifier) → covered via baseline / chain
//     matches in `addEntityResults`.
//   - relationshipOriginNode → covered via relationship name in
//     `addRelationshipResults`.
//
// What's left here:
//   - referenceNode — standalone canvas note. Has its own `title`
//     and `content` (plain text OR TipTap JSON when `is_rich_text`).
//     We match raw `content` directly; rich-text JSON literals still
//     surface the writer's words in substring matches even without
//     a dedicated parser.
//   - genericGroupNode — visual-only grouping rectangle. Has
//     `title` only.
//   - povOriginNode — POV system anchor; matches on `title` if set
//     (most save data has it default-blank).
//
// All three route to the catchall **Other** group. They don't have
// dedicated chips; they're gated by the **Scenes** chip since
// they're canvas-level writer-authored content (similar mental
// model to scene content) until / unless writer feedback flags
// wanting their own chip.
// ────────────────────────────────────────────────────────────────────────

function addNonSceneNodeResults(acc, nodes, needleLower, scopeFlags) {
  for (const n of nodes || []) {
    if (n.type === 'referenceNode') {
      if (!scopeFlags.references) continue
      const titleMatch = makeFieldMatch(n.data?.title, needleLower, 'Title')
      if (titleMatch) pushResult(acc, 'references', {
        kind: 'referenceNote',
        id: n.id,
        anchorNodeId: n.id,
        ...titleMatch,
      })
      const contentMatch = makeFieldMatch(typeof n.data?.content === 'string' ? n.data.content : '', needleLower, 'Reference')
      if (contentMatch) pushResult(acc, 'references', {
        kind: 'referenceNote',
        id: n.id,
        anchorNodeId: n.id,
        ...contentMatch,
      })
    } else if (n.type === 'genericGroupNode') {
      if (!scopeFlags.scenes) continue
      const m = makeFieldMatch(n.data?.title, needleLower, 'Group')
      if (m) pushResult(acc, 'other', {
        kind: 'groupNode',
        id: n.id,
        anchorNodeId: n.id,
        ...m,
      })
    } else if (n.type === 'povOriginNode') {
      if (!scopeFlags.scenes) continue
      const m = makeFieldMatch(n.data?.title, needleLower, 'POV')
      if (m) pushResult(acc, 'other', {
        kind: 'povOriginNode',
        id: n.id,
        anchorNodeId: n.id,
        ...m,
      })
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Context Cue scope.
//
// Cues live program-level (one JSON per cue under `context_cues/`,
// not in the `.nnz`). For search:
//   - `cue.name` (tier-1)
//   - `cue.body` (TipTap HTML; flattened to plain via htmlToPlainText
//     and emitted as `Body` field). Tier-4 (long-form body text).
//
// Tags are matched via the tag channel; they're not duplicated here.
//
// Each match emits `kind: 'contextCue'` with `id: cue.id` and no
// `anchorNodeId` (cues are not chain-scoped). The modal opens the
// cue editor via `uiStore.openContextCueEditor`.
// ────────────────────────────────────────────────────────────────────────

function addContextCueResults(acc, cue, needleLower) {
  if (!cue) return
  // Tier-1: name.
  const nameMatch = makeFieldMatch(cue.name, needleLower, 'Name')
  if (nameMatch) pushResult(acc, 'cues', {
    kind: 'contextCue',
    id: cue.id,
    anchorNodeId: null,
    ...nameMatch,
  })
  // Tier-4: body (TipTap HTML → plain text). Skip when body is empty
  // or the HTML-to-plain conversion yields nothing — both cheap
  // short-circuits before the substring scan.
  const bodyText = cue.body ? htmlToPlainText(cue.body) : ''
  if (bodyText) {
    const bodyMatch = makeFieldMatch(bodyText, needleLower, 'Body')
    if (bodyMatch) pushResult(acc, 'cues', {
      kind: 'contextCue',
      id: cue.id,
      anchorNodeId: null,
      ...bodyMatch,
    })
  }
}

// ────────────────────────────────────────────────────────────────────────
// Phase 3.4e — Tag-match channel.
//
// Tags are always part of the search. Two modes based on the query
// prefix:
//
//   - "#magic" / "#Magic" / "#MAGIC" — TAG-ONLY mode. Skips every
//     other search channel; only emits tag groups. The `#` is
//     stripped before lookup.
//   - "magic" — mixed mode. Existing text-search channels run AS WELL
//     AS the tag-match channel, both surfaced in the same result.
//
// Tag matching is **exact case-insensitive**. Substrings are not
// considered — `#mag` does NOT match a tag named "Magic". A tag
// matches when its stored name's lowercased form equals the (#-
// stripped, trimmed) query's lowercased form.
//
// Project Tags + Program Tags share a name space FOR SEARCH (one
// "Tagged #MAGIC" header per matching tag NAME, regardless of which
// pool it lives in). A query that matches both a Project Tag "Magic"
// (id-keyed) and a Program Tag "Magic" (string-keyed) merges their
// hosts under one header — they share the visual identity.
//
// For chain-trackable hosts (Entity / Knowledge / Relationship) the
// chain semantic is **chain-wide ever-tagged**: a host matches if it
// has carried the tag at ANY point on its chain — baseline `tag_ids`
// OR any `tag_changes` `add` event in chain history — regardless of
// whether the tag was later removed. Matches the Phase 3.4i filter
// bar semantic so search and filter behave consistently.
//
// For baseline-only hosts (PresetList / ReferenceNode) and Program
// Tag hosts (ContextCue / Conversation) the semantic is "tag is on
// the host's baseline list".
// ────────────────────────────────────────────────────────────────────────

const TAG_PREFIX = '#'

/** Detect tag-only mode; return `{ stripped, tagOnlyMode }`. The
 *  stripped form has the leading `#` removed and whitespace trimmed.
 *  Plain queries (no prefix) come through unchanged with
 *  `tagOnlyMode: false`. */
function parseTagPrefix(rawQuery) {
  const q = (rawQuery || '')
  const trimmed = q.trim()
  if (trimmed.startsWith(TAG_PREFIX)) {
    return { stripped: trimmed.slice(1).trim(), tagOnlyMode: true }
  }
  return { stripped: trimmed, tagOnlyMode: false }
}

/** Walk both pools (project + program) and return canonical-cased
 *  tag identities whose NAME exactly matches the needle (case-
 *  insensitive). The dedup key is the lowercased name; project + program
 *  pools that share a name produce ONE merged entry. Each entry
 *  carries `{ name, color, projectTagId | null }` — `projectTagId`
 *  is set when at least one of the pools is the Project Tag pool and
 *  drives id-keyed lookup against chain-trackable hosts. */
function findExactTagMatches(needleStripped, projectTagPool, programTagPool) {
  if (!needleStripped) return []
  const needleLower = needleStripped.toLowerCase()
  const byLower = new Map()  // lower -> { name, color, projectTagId }

  // Project pool first so its canonical casing wins on tie.
  for (const t of (projectTagPool || [])) {
    if (!t?.name) continue
    if (t.name.toLowerCase() !== needleLower) continue
    byLower.set(needleLower, {
      name: t.name,
      color: t.color || '#888888',
      projectTagId: t.id || null,
    })
  }

  // Program pool — merge into existing entry if Project pool also matched.
  for (const t of (programTagPool || [])) {
    if (!t?.name) continue
    if (t.name.toLowerCase() !== needleLower) continue
    const existing = byLower.get(needleLower)
    if (existing) {
      // Project entry already present; nothing to merge except the
      // Program-side color when the project entry's color is the
      // default and program's isn't.
      if (existing.color === '#888888' && t.color && t.color !== '#888888') {
        existing.color = t.color
      }
      continue
    }
    byLower.set(needleLower, {
      name: t.name,
      color: t.color || '#888888',
      projectTagId: null,  // program-only match
    })
  }

  return [...byLower.values()]
}

/** Walk every Project-Tag-bearing host (entities, knowledges,
 *  relationships, preset lists, reference nodes) PLUS scene EntityRef
 *  tag_changes + modifier-mode EntityNode tag_changes; return the
 *  Set of host keys whose chain-wide ever-tagged set contains
 *  `projectTagId`. Host key shape:
 *    `entity:<id>` / `knowledge:<id>` / `relationship:<id>` /
 *    `presetList:<id>` / `referenceNode:<id>`
 *  Same walker shape the 3.4e TagsAndListsSection uses for its
 *  per-tag count computation. */
export function collectHostsForProjectTag(projectTagId, project, entities) {
  const hits = new Set()
  if (!projectTagId) return hits

  const bump = (k) => { if (k) hits.add(k) }

  // Entity baselines
  for (const bucket of ['characters', 'locations', 'items', 'factions', 'customs']) {
    for (const e of (entities?.[bucket] || [])) {
      if ((e.tag_ids || []).includes(projectTagId)) bump(`entity:${e.id}`)
    }
  }
  // Knowledge baseline + chain
  const knowledges = (project?.knowledges) || (entities?.knowledges) || []
  for (const k of knowledges) {
    if ((k.tag_ids || []).includes(projectTagId)) bump(`knowledge:${k.id}`)
    for (const ev of (k.history?.tag_changes || [])) {
      if (ev?.action === 'add' && ev.tag_id === projectTagId) bump(`knowledge:${k.id}`)
    }
  }
  // Relationship baseline + chain
  for (const r of (project?.relationships || [])) {
    if ((r.tag_ids || []).includes(projectTagId)) bump(`relationship:${r.id}`)
    for (const ev of (r.history?.tag_changes || [])) {
      if (ev?.action === 'add' && ev.tag_id === projectTagId) bump(`relationship:${r.id}`)
    }
  }
  // Preset lists — baseline only
  for (const pl of (entities?.presetLists || [])) {
    if ((pl.tag_ids || []).includes(projectTagId)) bump(`presetList:${pl.id}`)
  }
  // Canvas nodes — reference nodes (baseline) + scene EntityRef +
  // modifier-mode EntityNode tag_changes.
  for (const n of (project?.nodes || [])) {
    if (n.type === 'referenceNode') {
      if ((n.data?.tag_ids || []).includes(projectTagId)) bump(`referenceNode:${n.id}`)
    } else if (n.type === 'sceneNode') {
      for (const bk of ['characters', 'locations', 'items', 'factions', 'customs']) {
        for (const ref of (n.data?.[bk] || [])) {
          for (const ev of (ref.tag_changes || [])) {
            if (ev?.action === 'add' && ev.tag_id === projectTagId) {
              if (ref.entity_id) bump(`entity:${ref.entity_id}`)
            }
          }
        }
      }
    } else if (n.type === 'entityNode' && n.data?.is_modifier && n.data?.entity_id) {
      for (const ev of (n.data?.tag_changes || [])) {
        if (ev?.action === 'add' && ev.tag_id === projectTagId) bump(`entity:${n.data.entity_id}`)
      }
    }
  }
  return hits
}

/** Same idea for Program Tags — walks ContextCues + Conversations
 *  for hosts whose `.tags: list[str]` contains a string that
 *  case-insensitively matches `tagNameLower`. Returns a Set of
 *  `cue:<id>` / `conversation:<id>` host keys. */
export function collectHostsForProgramTag(tagNameLower, cues, conversations) {
  const hits = new Set()
  if (!tagNameLower) return hits
  const match = (t) => typeof t === 'string' && t.toLowerCase() === tagNameLower

  for (const c of (cues || [])) {
    if ((c.tags || []).some(match)) hits.add(`cue:${c.id}`)
  }
  // Conversations: walk the index (has tags array per entry).
  for (const e of (conversations || [])) {
    if ((e.tags || []).some(match)) hits.add(`conversation:${e.id}`)
  }
  return hits
}

/** Build the tag-group result rows for a given matched tag. Resolves
 *  display names from the available stores and emits one row per
 *  hit host (capped by RESULTS_PER_GROUP_CAP). Cues + conversations
 *  always count whether the matched tag was a Project or Program
 *  identity, because Program Tags live on those hosts. */
function buildTagGroup(tag, project, entities, cues, conversations, membershipIndex = null) {
  // Read project hosts from the shared `useTagHostIndex` cache when
  // the caller threaded one through (the GlobalSearchModal does).
  // Falls back to the in-place walker for callers that don't have a
  // hook context. Same result either way — the index is an O(1)
  // cache of the same data the walker computes.
  const projectHostKeys = tag.projectTagId
    ? (membershipIndex
        ? (membershipIndex.get(tag.projectTagId) || new Set())
        : collectHostsForProjectTag(tag.projectTagId, project, entities))
    : new Set()
  const programHostKeys = collectHostsForProgramTag(
    tag.name.toLowerCase(), cues, conversations,
  )
  const allKeys = new Set([...projectHostKeys, ...programHostKeys])
  if (allKeys.size === 0) return null

  const results = []
  let overflow = 0

  // Build per-key display rows. Look up name from the relevant store.
  const entityBuckets = ['characters', 'locations', 'items', 'factions', 'customs']
  const entityById = new Map()
  for (const bk of entityBuckets) {
    for (const e of (entities?.[bk] || [])) entityById.set(e.id, e)
  }
  const knowledges = (project?.knowledges) || (entities?.knowledges) || []
  const knowledgeById = new Map(knowledges.map((k) => [k.id, k]))
  const relationshipById = new Map((project?.relationships || []).map((r) => [r.id, r]))
  const presetById = new Map((entities?.presetLists || []).map((pl) => [pl.id, pl]))
  const referenceById = new Map(
    (project?.nodes || [])
      .filter((n) => n.type === 'referenceNode')
      .map((n) => [n.id, n]),
  )
  const cueById = new Map((cues || []).map((c) => [c.id, c]))
  const conversationById = new Map((conversations || []).map((e) => [e.id, e]))

  const push = (row) => {
    if (results.length >= RESULTS_PER_GROUP_CAP) { overflow += 1; return }
    results.push(row)
  }

  for (const key of allKeys) {
    const sep = key.indexOf(':')
    if (sep < 0) continue
    const hostKind = key.slice(0, sep)
    const hostId = key.slice(sep + 1)
    if (hostKind === 'entity') {
      const e = entityById.get(hostId)
      if (!e) continue
      push({
        kind: 'taggedHost',
        hostKind: e.type || 'entity',
        id: hostId,
        displayName: e.name || '(unnamed)',
      })
    } else if (hostKind === 'knowledge') {
      const k = knowledgeById.get(hostId)
      if (!k) continue
      push({
        kind: 'taggedHost',
        hostKind: 'knowledge',
        id: hostId,
        displayName: k.name || '(unnamed)',
      })
    } else if (hostKind === 'relationship') {
      const r = relationshipById.get(hostId)
      if (!r) continue
      push({
        kind: 'taggedHost',
        hostKind: 'relationship',
        id: hostId,
        displayName: r.name || '(unnamed relationship)',
      })
    } else if (hostKind === 'presetList') {
      const pl = presetById.get(hostId)
      if (!pl) continue
      push({
        kind: 'taggedHost',
        hostKind: 'presetList',
        id: hostId,
        displayName: pl.name || '(unnamed list)',
      })
    } else if (hostKind === 'referenceNode') {
      const n = referenceById.get(hostId)
      if (!n) continue
      push({
        kind: 'taggedHost',
        hostKind: 'referenceNode',
        id: hostId,
        displayName: n.data?.title || '(untitled reference)',
      })
    } else if (hostKind === 'cue') {
      const c = cueById.get(hostId)
      if (!c) continue
      push({
        kind: 'taggedHost',
        hostKind: 'cue',
        id: hostId,
        displayName: c.name || '(unnamed cue)',
      })
    } else if (hostKind === 'conversation') {
      const e = conversationById.get(hostId)
      if (!e) continue
      push({
        kind: 'taggedHost',
        hostKind: 'conversation',
        id: hostId,
        displayName: e.name || '(unnamed conversation)',
      })
    }
  }

  // Stable alpha sort within the group.
  results.sort((a, b) => {
    const la = (a.displayName || '').toLowerCase()
    const lb = (b.displayName || '').toLowerCase()
    return la < lb ? -1 : la > lb ? 1 : 0
  })
  return {
    tagName: tag.name,
    tagColor: tag.color,
    projectTagId: tag.projectTagId,
    results,
    overflow,
  }
}

/** Top-level tag channel: parse the query, look up exact-matching
 *  tags across both pools, build a result group per matched tag.
 *  Returns `{ groups, tagOnlyMode, strippedQuery }`. Empty groups
 *  (no hosts carry the tag) are omitted. */
function runTagChannel(rawQuery, project, entities, cues, conversations, programTagPool, membershipIndex = null) {
  const { stripped, tagOnlyMode } = parseTagPrefix(rawQuery)
  if (!stripped) return { tagGroups: [], tagOnlyMode, strippedQuery: stripped }
  const projectTagPool = project?.story?.project_tags || []
  const matchedTags = findExactTagMatches(stripped, projectTagPool, programTagPool)
  const tagGroups = []
  for (const tag of matchedTags) {
    const built = buildTagGroup(tag, project, entities, cues, conversations, membershipIndex)
    if (built) tagGroups.push(built)
  }
  return { tagGroups, tagOnlyMode, strippedQuery: stripped }
}

// ────────────────────────────────────────────────────────────────────────
// Public entry
// ────────────────────────────────────────────────────────────────────────

/**
 * `project` is `useProjectStore.getState()`-shaped — at minimum
 * exposes `nodes`, `story` (with `chapters`, `acts`), `relationships`,
 * `knowledges`, and `connections` are derived from `edges`.
 *
 * `entities` is `useEntitiesStore.getState()`-shaped — exposes the
 * five entity buckets plus `knowledges`.
 *
 * Either store can be passed as `null` to skip its scope cleanly.
 *
 * `extras` carries the cross-pool sources needed by the Phase 3.4e
 * tag-match channel:
 *   - `cues`         — `useContextCuesStore.getState().cues` (full
 *                      cue list with `.tags: string[]` per cue).
 *   - `conversations`— `useConversationsStore.getState().index`
 *                      (lightweight per-thread index entries; carry
 *                      `.tags`).
 *   - `programTagPool` — `useProgramTagsStore.getState().pool`
 *                      (aggregated pool with canonical name + color).
 * All `extras` fields are optional; missing fields just narrow what
 * the tag channel can find.
 *
 * Returns `{ groups, tagGroups, totalCount, tagOnlyMode }`.
 *
 * - `groups`: existing static-key groups (entities / scenes / etc.).
 *   Empty when `tagOnlyMode` is true.
 * - `tagGroups`: one entry per matched tag NAME; each carries
 *   `{ tagName, tagColor, projectTagId, results: [taggedHost rows],
 *   overflow }`. Empty when the query has no tag content or matches
 *   no host-carrying tags.
 * - `tagOnlyMode`: true when the query started with `#`. Tells the
 *   modal to render only `tagGroups` and suppress the existing
 *   text-search groups.
 */
export function runGlobalSearch(query, scopeFlags, project, entities, extras = {}) {
  const rawQuery = query || ''
  // Tags scope flag — when present and false, the tag channel is
  // skipped entirely (including in `#`-prefix tag-only mode, since
  // the writer explicitly turned the channel off). When the flag is
  // missing (legacy callers / no scope row), default to ON so
  // existing behaviour is preserved.
  const tagsScopeOn = scopeFlags ? (scopeFlags.tags !== false) : true
  const { tagGroups, tagOnlyMode, strippedQuery } = tagsScopeOn
    ? runTagChannel(
        rawQuery,
        project,
        entities,
        extras.cues || [],
        extras.conversations || [],
        extras.programTagPool || [],
        extras.membershipIndex || null,
      )
    : { tagGroups: [], tagOnlyMode: rawQuery.trim().startsWith('#'), strippedQuery: rawQuery.trim().replace(/^#+/, '').trim() }

  // In tag-only mode (#-prefix), short-circuit existing channels.
  // An empty stripped query (`#` typed alone) returns empty tag
  // groups and we don't fall back to the text channels.
  if (tagOnlyMode) {
    const totalCount = tagGroups.reduce((s, g) => s + g.results.length, 0)
    return { groups: [], tagGroups, totalCount, tagOnlyMode: true }
  }

  // Plain mode: existing channels (entity / scene / etc.) PLUS the
  // tag channel run side-by-side. An empty stripped query short-
  // circuits the text channels too — matches the pre-3.4e behaviour.
  const q = (strippedQuery || '').toLowerCase()
  if (!q) return { groups: [], tagGroups: [], totalCount: 0, tagOnlyMode: false }

  const acc = makeAccumulator()
  const nodes = project?.nodes || []
  const flags = scopeFlags || {}

  // Entities (with knowledges getting their own group). Knowledge
  // records don't carry `type: 'knowledge'` natively (the synthesis
  // pattern matches `useAlerts.js` / `AlertsPanel.jsx` — the knowledge
  // store keeps records type-less, consumers add the type when they
  // need an entity-shaped object). The engine's group / scope
  // routing keys off `entity.type`, so synthesize it here.
  if (entities) {
    const buckets = [
      { key: 'characters', list: entities.characters || [],                                                  injectType: null         },
      { key: 'locations',  list: entities.locations  || [],                                                  injectType: null         },
      { key: 'items',      list: entities.items      || [],                                                  injectType: null         },
      { key: 'factions',   list: entities.factions   || [],                                                  injectType: null         },
      { key: 'customs',    list: entities.customs    || [],                                                  injectType: null         },
      { key: 'knowledges', list: entities.knowledges || [],                                                  injectType: 'knowledge'  },
    ]
    for (const b of buckets) {
      // The Attributes / Circumstances / Motivators chips are OR'd
      // into the entity scope: if the entity sub-type is off but any
      // attribute-routing chip is on, the entity is still iterated
      // so its attributes / circumstances / motivators (which route
      // by `attribute_type`) are reachable.
      if (!flags[b.key] && !flags.attributes && !flags.circumstances && !flags.motivators) continue
      for (const raw of b.list) {
        const entity = b.injectType && !raw.type ? { ...raw, type: b.injectType } : raw
        addEntityResults(acc, entity, nodes, q, flags)
        // Knowledge content changes (name / description) live on
        // `knowledge.history.*_changes`, not on EntityRef chain stops,
        // so the generic `chainStopsForEntity` walk inside
        // `addEntityResults` doesn't see them. Walk them here.
        if (b.injectType === 'knowledge' && flags.knowledges) {
          addKnowledgeChainResults(acc, entity, q)
        }
      }
    }
  }

  // Relationships — `project.relationships` is the canonical source
  // (loaded from `story.relationships` at project load).
  if (flags.relationships) {
    for (const rel of project?.relationships || []) {
      addRelationshipResults(acc, rel, q)
    }
  }

  // Circumstances + Motivators (scene-side + temporary). Walks every
  // sceneNode once; per-record gating happens inside the helper.
  if (flags.circumstances || flags.motivators) {
    for (const n of nodes) {
      if (n.type === 'sceneNode') addCircumstanceMotivatorResults(acc, n, q, flags)
    }
  }

  // Connection edge transition_text — gated by the **Scenes** chip
  // (transitions are scene-to-scene bridges and group with scenes
  // per the per-pillar plan).
  if (flags.scenes) {
    addTransitionResults(acc, project?.edges || [], q)
  }
  // Non-scene canvas nodes — references gated by their own chip;
  // generic groups + POV origin nodes ride on the **Scenes** chip
  // (no dedicated chip for those edge categories).
  if (flags.scenes || flags.references) {
    addNonSceneNodeResults(acc, nodes, q, flags)
  }
  if (flags.chapters) addChapterResults(acc, project?.story || {}, q)
  if (flags.acts)     addActResults(acc, project?.story || {}, q)

  // Context Cues — program-level. Loop the cue list passed via
  // `extras.cues` (the modal subscribes to `useContextCuesStore.cues`).
  // Gated by the `cues` scope chip; no other scope flag covers them.
  if (flags.cues) {
    for (const cue of (extras.cues || [])) addContextCueResults(acc, cue, q)
  }

  // Scenes — read from the canvas nodes array, NOT `story.scenes`.
  // `story.scenes` is the loaded snapshot that only gets rebuilt at
  // save time; live edits (typing in the right-sidebar TipTap editor,
  // title rename, etc.) flow through `updateNodeData` which patches
  // `nodes` directly. Reading from `story.scenes` would show stale
  // text right up until the next save.
  if (flags.scenes) {
    for (const n of nodes) {
      if (n.type !== 'sceneNode') continue
      addSceneResults(acc, {
        id: n.id,
        title: n.data?.title,
        description: n.data?.description,
        main_content: n.data?.main_content,
      }, q)
    }
  }

  const finalized = finalize(acc)
  const tagCount = tagGroups.reduce((s, g) => s + g.results.length, 0)
  return {
    ...finalized,
    tagGroups,
    totalCount: finalized.totalCount + tagCount,
    tagOnlyMode: false,
  }
}
