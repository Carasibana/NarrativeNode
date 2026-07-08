import { getEntityNarrativeChain, computeEffectiveState } from './narrativeChain'

/**
 * Helpers that build a `SourceEventRef` (the back-pointer shape used
 * by Knowledge.source_event and Knowledge.history.source_event_changes)
 * from an entity-side change-sub-chip descriptor.
 *
 * Chip descriptors come from `computeChangeSubChips` and identify the
 * field that changed at a specific scene; here we look up the carrier
 * (EntityRef on the scene node) to find the actual `change_id` and
 * package it together with carrier-context metadata for navigation
 * and cleanup.
 *
 * Returns `null` when the change can't be resolved (chip kind not
 * supported / entity ref missing the change record). Callers treat
 * null as "don't open the popover".
 */

/**
 * Resolve the `change_id` (and event_type) for an entity-side chip
 * given its EntityRef carrier. Walks the EntityRef's
 * `attribute_changes` for attribute add/modify/remove and the
 * scalar_change_ids dict for name / colour / description / profile
 * image scalar changes.
 */
export function buildSourceEventFromEntityRefChip(chip, entityRef, nodeId) {
  if (!chip || !entityRef || !nodeId) return null
  const baseMeta = { node_id: nodeId, entity_id: entityRef.entity_id }

  // Scalar fields — change_id lives in EntityRef.scalar_change_ids[field]
  if (chip.field === 'Name' && entityRef.scalar_change_ids?.name_change) {
    return {
      event_type: 'entity_ref_scalar',
      change_id: entityRef.scalar_change_ids.name_change,
      ...baseMeta,
      field: 'name_change',
    }
  }
  if (chip.field === 'Colour' && entityRef.scalar_change_ids?.colour_change) {
    return {
      event_type: 'entity_ref_scalar',
      change_id: entityRef.scalar_change_ids.colour_change,
      ...baseMeta,
      field: 'colour_change',
    }
  }
  if (chip.field === 'Description' && entityRef.scalar_change_ids?.description_change) {
    return {
      event_type: 'entity_ref_scalar',
      change_id: entityRef.scalar_change_ids.description_change,
      ...baseMeta,
      field: 'description_change',
    }
  }
  if (chip.isProfileImage && entityRef.scalar_change_ids?.profile_image_change) {
    return {
      event_type: 'entity_ref_scalar',
      change_id: entityRef.scalar_change_ids.profile_image_change,
      ...baseMeta,
      field: 'profile_image_change',
    }
  }

  // Attribute add / modify / remove — change_id on the
  // attribute_changes[] entry.
  if (chip.attributeId) {
    const ac = (entityRef.attribute_changes || []).find((c) => {
      if (c?.action === 'add') return c.attribute?.id === chip.attributeId
      return c.attribute_id === chip.attributeId
    })
    if (ac?.id) {
      return {
        event_type: 'attribute_change',
        change_id: ac.id,
        ...baseMeta,
        attribute_id: chip.attributeId,
      }
    }
  }

  return null
}

/**
 * Walk a Knowledge's `history.source_event_changes` chain to the
 * effective `source_event` at a given chain anchor. Most-recent entry
 * with `node_id` ≤ `atNodeId` (in story order) wins; falls back to
 * `knowledge.source_event` baseline when no chain entries qualify.
 *
 * Mirrors the standard chain-walker pattern: each entry's
 * `new_source_event` is the value being declared at that anchor (a
 * rebinding to a new triggering change, or `null` to explicitly
 * decouple). Entries lacking a `node_id` or whose node is missing
 * from `storyOrder.orderedIds` are skipped.
 */
export function resolveKnowledgeSourceEventAt(knowledge, atNodeId, storyOrder) {
  if (!knowledge) return null
  const baseline = knowledge.source_event ?? null
  const changes = knowledge.history?.source_event_changes
  if (!Array.isArray(changes) || changes.length === 0) return baseline
  if (!atNodeId) return baseline
  const orderIds = storyOrder?.orderedIds || []
  if (!Array.isArray(orderIds) || orderIds.length === 0) return baseline
  const orderIndex = new Map(orderIds.map((id, i) => [id, i]))
  const anchorIdx = orderIndex.has(atNodeId) ? orderIndex.get(atNodeId) : Infinity
  let latest = baseline
  let latestIdx = -1
  for (const ch of changes) {
    if (!ch?.node_id) continue
    if (!orderIndex.has(ch.node_id)) continue
    const idx = orderIndex.get(ch.node_id)
    if (idx > anchorIdx) continue
    if (idx > latestIdx) {
      latest = ch.new_source_event ?? null
      latestIdx = idx
    }
  }
  return latest
}

/**
 * Build a SourceEventRef for an entity-baseline value at the entity's
 * origin (no chain change record — the value IS the baseline). Used
 * by the "Add knowledge of this change" entry-point on origin
 * EntityNodes so writers can tie a Knowledge to a pre-story-baseline
 * attribute or scalar.
 *
 * For an attribute baseline, `change_id` is the Attribute's own UUID
 * (each attribute carries an `id`). For a scalar baseline (entity
 * name / colour / description / profile_image), there's no UUID so
 * we synthesise `${entity.id}:${field}` — uniquely identifies the
 * baseline scalar within the project, matches Tier 0's "stable
 * identifier per event" rule.
 */
export function buildSourceEventFromOriginAttribute(attribute, entity, originNodeId) {
  if (!attribute?.id || !entity?.id || !originNodeId) return null
  return {
    event_type: 'entity_baseline',
    change_id: attribute.id,
    node_id: originNodeId,
    entity_id: entity.id,
    attribute_id: attribute.id,
  }
}

/**
 * Reverse-direction helper: given a SourceEventRef, resolve enough
 * data to render an `EventBadge` summary including the value
 * transition (action / oldValue / newValue).
 *
 * Identity-first lookup: SourceEventRef carries a stable
 * `change_id` UUID (Phase 1.21c Tier 0 universalisation). We use the
 * carrier-context metadata (entity_id + node_id) only to NARROW the
 * search to the right carrier ref; the actual match is by UUID. This
 * keeps the badge in lockstep with the underlying change object —
 * even after re-orderings, edits, or migrations — and means the
 * caller doesn't have to carry display fields alongside the ref.
 *
 * Args:
 *   sourceEvent — SourceEventRef
 *   allEntities — array of entities (for owner lookup)
 *   nodes       — project nodes (optional — needed to find the
 *                 carrier and read its change record + prior value)
 *   edges       — project edges (optional — used by the chain walker
 *                 when computing chain-prior `oldValue` for stacked
 *                 modifies)
 *
 * Returns props for `<EventBadge>` or null when sourceEvent is empty.
 * When the carrier / change record can't be located, returns
 * label-only props (no transition row).
 */
export function resolveEventBadgePropsFromSourceEvent(sourceEvent, allEntities, nodes, edges) {
  if (!sourceEvent || !sourceEvent.change_id) return null
  const owner = sourceEvent.entity_id
    ? (allEntities || []).find((e) => e?.id === sourceEvent.entity_id) || null
    : null

  // Field label resolution from the source ref alone (so a label
  // renders even when the carrier can't be found).
  let fieldLabel = ''
  if (sourceEvent.attribute_id && owner) {
    const attr = (owner.attributes || []).find((a) => a.id === sourceEvent.attribute_id)
    fieldLabel = attr?.name || 'Attribute'
  } else if (sourceEvent.field === 'name_change') fieldLabel = 'Name'
  else if (sourceEvent.field === 'colour_change') fieldLabel = 'Colour'
  else if (sourceEvent.field === 'description_change') fieldLabel = 'Description'
  else if (sourceEvent.field === 'profile_image_change') fieldLabel = 'Profile Image'

  const baseProps = {
    entity: owner,
    nodeId: sourceEvent.node_id,
    fieldLabel,
    action: 'modify',
  }

  if (!nodes || !sourceEvent.node_id || !sourceEvent.entity_id) return baseProps

  // Origin-baseline back-pointer — value lives on the entity baseline
  // (no chain change record, no scene/modifier carrier ref). Resolve
  // BEFORE the carrier-ref lookup, since the carrier IS the entity
  // origin EntityNode (non-modifier) and there's no EntityRef to read
  // from. Reading entity.attributes / entity scalar fields is the
  // chain-aware path here per the origin rule: sourceEvent.node_id IS
  // the entity's origin node, so this object's origin matches the
  // active anchor.
  if (sourceEvent.event_type === 'entity_baseline') {
    if (sourceEvent.attribute_id && owner) {
      const attr = (owner.attributes || []).find((a) => a.id === sourceEvent.attribute_id)
      if (!attr) return baseProps
      const isFile = attr.attribute_type === 'file'
      const newValue = isFile ? (attr.file_ref || attr.value) : attr.value
      return {
        entity: owner,
        nodeId: sourceEvent.node_id,
        fieldLabel: attr.name || 'Attribute',
        action: 'add',
        oldValue: undefined,
        newValue,
      }
    }
    if (sourceEvent.field && owner) {
      let value
      if (sourceEvent.field === 'name')        value = owner.name
      else if (sourceEvent.field === 'colour') value = owner.colour
      else if (sourceEvent.field === 'description') value = owner.description
      else if (sourceEvent.field === 'profile_image') value = owner.profile_image_ref
      const labelByField = { name: 'Name', colour: 'Colour', description: 'Description', profile_image: 'Profile Image' }
      return {
        entity: owner,
        nodeId: sourceEvent.node_id,
        fieldLabel: labelByField[sourceEvent.field] || sourceEvent.field,
        action: 'add',
        oldValue: undefined,
        newValue: value,
      }
    }
    return baseProps
  }

  // Find the carrier ref (EntityRef on a scene node or modifier node
  // data) at the source event's anchor node — needed for chain-time
  // change events (attribute_change, entity_ref_scalar) below.
  const carrierNode = nodes.find((n) => n.id === sourceEvent.node_id)
  if (!carrierNode) return baseProps
  let carrierRef = null
  if (carrierNode.type === 'sceneNode') {
    for (const bucket of ['characters', 'locations', 'items', 'factions', 'customs']) {
      const refs = carrierNode.data?.[bucket] || []
      const match = refs.find((r) => r.entity_id === sourceEvent.entity_id)
      if (match) { carrierRef = match; break }
    }
  } else if (carrierNode.type === 'entityNode' && carrierNode.data?.is_modifier && carrierNode.data?.entity_id === sourceEvent.entity_id) {
    carrierRef = carrierNode.data
  }
  if (!carrierRef) return baseProps

  if (sourceEvent.event_type === 'attribute_change' || sourceEvent.attribute_id) {
    const ac = (carrierRef.attribute_changes || []).find((c) => c?.id === sourceEvent.change_id)
    if (!ac) return baseProps
    // Resolve the entity baseline attribute for type detection + the
    // pre-state value. For action='add', `ac.attribute` is the change
    // record's payload and the baseline doesn't have it yet.
    const ownerAttr = (owner?.attributes || []).find((a) => a.id === ac.attribute_id || a.id === ac.attribute?.id) || null
    const attrType = ownerAttr?.attribute_type ?? ac?.attribute?.attribute_type ?? 'text'
    const isFile = attrType === 'file'

    let action = 'modify'
    let newValue
    if (ac.action === 'add') {
      action = 'add'
      newValue = isFile ? (ac.attribute?.file_ref || ac.attribute?.value) : ac.attribute?.value
    } else if (ac.action === 'remove') {
      action = 'remove'
      newValue = undefined
    } else if (ac.action === 'modify') {
      // Text/preset attributes use `ac.new_value`; file attributes use
      // `ac.file_ref_change`. Backend serialises absent fields as null,
      // so checking `!== undefined` doesn't reliably discriminate the
      // two branches — fall back on the attribute type instead.
      newValue = isFile ? ac.file_ref_change : ac.new_value
    }
    // Old value: chain-prior at the entity's narrative chain step
    // BEFORE sourceEvent.node_id. Walk the entity's chain to find the
    // prior node, then resolve effective state there. Falls back to
    // baseline when there's no prior chain step (e.g. the change is
    // at the entity's origin).
    let oldValue
    if (owner) {
      let priorState = null
      if (nodes && edges) {
        try {
          const chain = getEntityNarrativeChain(owner.id, nodes, edges)
          const idxAt = chain.findIndex((n) => n.id === sourceEvent.node_id)
          if (idxAt > 0) {
            const priorNodeId = chain[idxAt - 1]?.id
            if (priorNodeId) priorState = computeEffectiveState(owner, nodes, edges, priorNodeId)
          }
        } catch { /* ignore — fall through to baseline */ }
      }
      const priorAttrs = priorState?.attributes || owner.attributes || []
      const priorAttr = priorAttrs.find((a) => a.id === (ac.attribute_id || ac.attribute?.id))
      if (priorAttr) {
        oldValue = isFile ? (priorAttr.file_ref || priorAttr.value) : priorAttr.value
      } else if (ownerAttr) {
        oldValue = isFile ? (ownerAttr.file_ref || ownerAttr.value) : ownerAttr.value
      }
    }
    return { entity: owner, nodeId: sourceEvent.node_id, fieldLabel, action, oldValue, newValue }
  }

  if (sourceEvent.event_type === 'entity_ref_scalar' || sourceEvent.field) {
    const fieldKey = sourceEvent.field
    const idMap = carrierRef.scalar_change_ids || {}
    if (idMap[fieldKey] !== sourceEvent.change_id) return baseProps
    const newValue = carrierRef[fieldKey]   // e.g. ref.name_change, ref.colour_change
    // Chain-prior oldValue: walk the entity's chain to the step before
    // sourceEvent.node_id and read the field's effective value there.
    // Falls back to entity baseline when there's no prior chain step.
    let priorState = null
    if (owner && nodes && edges) {
      try {
        const chain = getEntityNarrativeChain(owner.id, nodes, edges)
        const idxAt = chain.findIndex((n) => n.id === sourceEvent.node_id)
        if (idxAt > 0) {
          const priorNodeId = chain[idxAt - 1]?.id
          if (priorNodeId) priorState = computeEffectiveState(owner, nodes, edges, priorNodeId)
        }
      } catch { /* ignore — fall through to baseline */ }
    }
    let oldValue
    if (fieldKey === 'name_change')             oldValue = priorState?.name ?? owner?.name
    else if (fieldKey === 'colour_change')      oldValue = priorState?.colour ?? owner?.colour
    else if (fieldKey === 'description_change') oldValue = priorState?.description ?? owner?.description
    else if (fieldKey === 'profile_image_change') oldValue = priorState?.profile_image_ref ?? owner?.profile_image_ref
    return { entity: owner, nodeId: sourceEvent.node_id, fieldLabel, action: 'modify', oldValue, newValue }
  }

  return baseProps
}

/**
 * Build an auto-suggested Knowledge name from a chip descriptor. Used
 * as the default for Path A's name field; the writer can rename in the
 * creation flow. One-time snapshot at creation — does NOT auto-update
 * if the trigger change is later edited.
 */
export function buildSuggestedKnowledgeName(chip, entityRef, entity) {
  const ownerName = entity?.name || 'Entity'
  if (chip?.attributeId) {
    return `${ownerName}'s ${chip.field || 'attribute'}`
  }
  if (chip?.field) {
    return `${ownerName}'s ${chip.field}`
  }
  return `Knowledge of change`
}
