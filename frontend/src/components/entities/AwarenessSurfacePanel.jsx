/**
 * AwarenessSurfacePanel — single unified awareness modal that handles
 * every awareness-bearing surface kind in the project. Replaces the
 * older `AliasesPanel` (entity name + aliases) and
 * `AttributesAwarenessPanel` (per-attribute) variants — same modal
 * shell (`AwarenessModal`), same picker (`AwarenessPicker`), same
 * commit path (`commitAwarenessBatchAtAnchor`), but kind-aware so
 * additional surfaces (entity-existence, relationship, knowledge)
 * inherit the same UX automatically.
 *
 * Two layouts driven by surface kind:
 *   - Multi-tab kinds (`aliases` = name + each alias; `attributes`
 *     = each attribute on the entity): left sidebar lists sub-items;
 *     picker on the right edits the selected one.
 *   - Single-surface kinds (`entity` = entity-existence,
 *     `relationship`, `knowledge`): no sidebar — just the picker for
 *     the one wrapper.
 *
 * Driven by `useUiStore.awarenessSurfacePanel` —
 *   `null` when closed, otherwise:
 *     { kind, ids, anchor, initialItem? }
 *   ids is a kind-specific bag of identifiers:
 *     entity / aliases / attributes  → { entityId }
 *     relationship                   → { relationshipId }
 *     knowledge                      → { knowledgeId }
 *   initialItem (multi-tab kinds only): pre-select that sub-item
 *     attributes  → attributeId
 *     aliases     → { kind: 'name' } | { kind: 'alias', value }
 */

import { useEffect, useMemo, useState } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProjectStore } from '../../store/projectStore'
import {
  computeEffectiveState,
  computeRelationshipEffectiveState,
  computeKnowledgeEffectiveState,
  getEntityNarrativeChain,
  getRelationshipNodeOrder,
  getRelationshipCreationNodeId,
  getKnowledgeNodeOrder,
} from '../../utils/narrativeChain'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import AwarenessModal from '../ui/AwarenessModal'
import AwarenessPicker from './AwarenessPicker'
import { SCALE_BINARY, SCALE_ALIAS, AwarenessBadge } from '../ui/AwarenessBadges'
import { EntityAvatarName, NodeBadge, RelationshipLabelChip, KnowledgeIcon, KNOWLEDGE_COLOUR } from '../ui/IdentityBadges'
import { CircumstanceTypeBadge, MotivatorTypeBadge } from '../ui/TypeBadges'
import { IntensityBadge, INTENSITY_LABELS } from '../ui/IntensityBadge'

const NAME_ITEM_ID = '__entity_name__'

/**
 * Small helpers for the right pane. The shape is identical across every
 * surface kind — a short label, a bordered value preview box, the
 * "Awareness" sub-header, and the italic blurb above the picker — so
 * each kind branch supplies just the per-surface text and these
 * components draw the actual UI.
 */
function PreviewLabel({ children }) {
  return <div className="text-[10px] text-zinc-500 uppercase tracking-wider px-1 mb-1">{children}</div>
}

function PreviewValueBox({ value, valueColor, emptyText = '(empty)' }) {
  return (
    <div
      className="text-xs px-2 py-1.5 bg-zinc-800/50 border border-zinc-700 rounded"
      style={valueColor ? { color: valueColor } : { color: '#e4e4e7' }}
    >
      {value || <span className="italic text-zinc-500">{emptyText}</span>}
    </div>
  )
}

function PreviewBlock({ label, value, valueColor, emptyText }) {
  return (
    <div>
      <PreviewLabel>{label}</PreviewLabel>
      <PreviewValueBox value={value} valueColor={valueColor} emptyText={emptyText} />
    </div>
  )
}

function AwarenessHeader({ blurb }) {
  return (
    <div>
      <PreviewLabel>Awareness</PreviewLabel>
      <div className="text-[10px] text-zinc-500 italic px-1 leading-snug mb-2">{blurb}</div>
    </div>
  )
}

/**
 * PrecisionToggle — shared "Binary {0,3} vs Full {0,1,2,3}" toggle row
 * used by every awareness-bearing surface that carries an
 * `awareness_scale` field. The kind branches below pass in the current
 * scale and a setter; the row itself is identical regardless of host.
 */
function PrecisionToggle({ currentScale, onChange }) {
  return (
    <div data-help-region="awareness:precision_toggle" className="flex items-center gap-2">
      <label className="text-[10px] text-zinc-500 uppercase tracking-wider flex-shrink-0">Precision</label>
      <div className="inline-flex rounded border border-zinc-700 overflow-hidden">
        {[
          { key: 'binary', levels: [0, 3] },
          { key: 'full',   levels: [0, 1, 2, 3] },
        ].map((opt) => {
          const active = currentScale === opt.key
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => {
                if (currentScale === opt.key) return
                onChange(opt.key)
              }}
              title={opt.key === 'binary' ? 'Binary: known / not known' : 'Graduated: four awareness levels'}
              className={`inline-flex items-center gap-0.5 px-1.5 py-1 transition-colors ${
                active ? 'bg-zinc-700 ring-2 ring-inset ring-accent-500' : 'bg-zinc-900 opacity-50 hover:opacity-80 hover:bg-zinc-800'
              }`}
            >
              {opt.levels.map((lvl) => (
                <AwarenessBadge key={lvl} level={lvl} size={12} />
              ))}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default function AwarenessSurfacePanel() {
  const config = useUiStore((s) => s.awarenessSurfacePanel)
  const closePanel = useUiStore((s) => s.closeAwarenessSurfacePanel)

  const projectNodes = useProjectStore((s) => s.nodes)
  const projectEdges = useProjectStore((s) => s.edges)
  const knowledgesPS = useProjectStore((s) => s.knowledges)
  const relationships = useProjectStore((s) => s.relationships)
  const updateEntity = useEntitiesStore((s) => s.updateEntity)
  const updateRelationship = useProjectStore((s) => s.updateRelationship)
  const updateKnowledge = useProjectStore((s) => s.updateKnowledge)
  const commitAwarenessBatchAtAnchor = useProjectStore((s) => s.commitAwarenessBatchAtAnchor)
  const storyOrder = useStoryOrder()

  const characters = useEntitiesStore((s) => s.characters)
  const locations  = useEntitiesStore((s) => s.locations)
  const items      = useEntitiesStore((s) => s.items)
  const factions   = useEntitiesStore((s) => s.factions)
  const customs    = useEntitiesStore((s) => s.customs)
  const allEntities = useMemo(
    () => [...characters, ...locations, ...items, ...factions, ...customs],
    [characters, locations, items, factions, customs],
  )
  const entityMap = useMemo(() => {
    const m = new Map()
    for (const e of allEntities) m.set(e.id, e)
    return m
  }, [allEntities])

  const open = !!config
  const kind = config?.kind ?? null
  const ids = config?.ids ?? {}
  const anchor = config?.anchor ?? { kind: 'origin', nodeId: null }
  const initialItem = config?.initialItem ?? null

  // Resolve the host object for the current kind. `entity` is shared
  // by `aliases` / `attributes` / `entity` kinds — they're all
  // entity-bound surfaces.
  const entity = useMemo(() => {
    if (!ids.entityId) return null
    return entityMap.get(ids.entityId) || null
  }, [ids.entityId, entityMap])
  const relationship = useMemo(() => {
    if (kind !== 'relationship' || !ids.relationshipId) return null
    return (relationships || []).find((r) => r.id === ids.relationshipId) || null
  }, [kind, ids.relationshipId, relationships])
  const knowledge = useMemo(() => {
    if (kind !== 'knowledge' || !ids.knowledgeId) return null
    return (knowledgesPS || []).find((k) => k.id === ids.knowledgeId) || null
  }, [kind, ids.knowledgeId, knowledgesPS])

  // Resolve "is this anchor the host's origin?" The setter cares
  // because origin-anchor writes go to baseline, chain-anchor writes
  // go to history.
  const isOriginAnchor = useMemo(() => {
    if (!anchor || anchor.kind === 'origin' || !anchor.nodeId) return true
    if (kind === 'relationship' && relationship) {
      const creation = getRelationshipCreationNodeId(relationship, projectNodes, anchor.nodeId)
      return creation === anchor.nodeId
    }
    if (kind === 'knowledge' && knowledge) {
      const order = getKnowledgeNodeOrder(knowledge, projectNodes, projectEdges)
      return Array.isArray(order) && order.length > 0 && order[0] === anchor.nodeId
    }
    return false
  }, [anchor, kind, relationship, knowledge, projectNodes, projectEdges])

  // Chain-resolved entity state at the anchor — used by
  // entity-bound kinds for `aliases` / `attributes` / entity-existence
  // / entity-name targets. The walker resolves names, alias values,
  // attribute lists, and awareness wrappers.
  const effectiveEntityAtAnchor = useMemo(() => {
    if (!entity) return null
    // Use the chain walker at EVERY anchor, including the host's
    // origin. The previous baseline-strip path at origin missed
    // chain history events whose `node_id` equals the host's origin
    // (a legitimate data shape — the awareness object's first-set
    // point can BE the host's origin scene, producing history
    // events anchored there). The walker correctly applies any
    // event with `node_id` at-or-before the chosen anchor, so
    // passing `atNodeId === origin` gives baseline + events-at-origin
    // resolved together. When `anchor.nodeId` is non-null (writer
    // sitting on a specific scene which happens to be origin) use
    // it directly; when only `anchor.kind === 'origin'` is supplied
    // (no specific scene), look up the entity's origin EntityNode
    // id from its narrative chain.
    const atNodeId = anchor?.nodeId
      || getEntityNarrativeChain(entity.id, projectNodes, projectEdges)?.[0]?.id
      || null
    const eff = computeEffectiveState(entity, projectNodes, projectEdges, atNodeId, { storyOrder })
    return {
      name: eff?.name || entity.name || '',
      colour: eff?.colour || entity.colour || '#888888',
      name_awareness_raw: eff?.name_awareness_raw ?? eff?.name_awareness ?? null,
      awareness_raw: eff?.awareness_raw ?? eff?.awareness ?? null,
      aliases: (eff?.aliases || []).map((a) => ({
        ...a,
        awareness_raw: a?.awareness_raw ?? a?.awareness ?? null,
      })),
      attributes: (eff?.attributes || []).map((a) => ({
        ...a,
        awareness_raw: a?.awareness_raw ?? a?.awareness ?? null,
      })),
    }
  }, [entity, anchor?.nodeId, projectNodes, projectEdges, storyOrder])

  // ── Multi-tab draft state (aliases / attributes) ──────────────
  // For aliases: { __entity_name__: wrapper, [aliasValue]: wrapper, ... }
  // For attributes: { [attributeId]: wrapper, ... }
  const [multiDraft, setMultiDraft] = useState({})
  const [selectedSubId, setSelectedSubId] = useState(null)

  // ── Single-surface draft state ──────────────────────────────────
  const [singleDraft, setSingleDraft] = useState(null)

  const [saving, setSaving] = useState(false)

  // Initialize draft state when the panel opens or its target shifts.
  useEffect(() => {
    if (!open) {
      setMultiDraft({})
      setSelectedSubId(null)
      setSingleDraft(null)
      setSaving(false)
      return
    }

    if (kind === 'aliases' && effectiveEntityAtAnchor) {
      const next = { [NAME_ITEM_ID]: effectiveEntityAtAnchor.name_awareness_raw }
      for (const a of effectiveEntityAtAnchor.aliases) {
        if (!a || !a.value) continue
        next[a.value] = a.awareness_raw
      }
      setMultiDraft(next)
      const initial = (initialItem?.kind === 'name')
        ? NAME_ITEM_ID
        : (initialItem?.kind === 'alias' && next[initialItem.value] !== undefined)
          ? initialItem.value
          : NAME_ITEM_ID
      setSelectedSubId(initial)
    } else if (kind === 'attributes' && effectiveEntityAtAnchor) {
      const next = {}
      for (const a of effectiveEntityAtAnchor.attributes) next[a.id] = a.awareness_raw
      setMultiDraft(next)
      const firstId = effectiveEntityAtAnchor.attributes[0]?.id ?? null
      const init = (initialItem && next[initialItem] !== undefined) ? initialItem : firstId
      setSelectedSubId(init)
    } else if (kind === 'entity' && entity) {
      setSingleDraft(effectiveEntityAtAnchor?.awareness_raw ?? null)
    } else if (kind === 'relationship' && relationship) {
      // Use the walker at every anchor including origin so chain
      // history events whose `node_id` IS the relationship's origin
      // scene are correctly applied (the previous baseline-strip
      // path dropped them — see the matching entity-side comment
      // above and the Phase 2.11 Bugs & Fixes ToDo entry).
      const order = getRelationshipNodeOrder(relationship, projectNodes, projectEdges)
      const atNodeId = anchor?.nodeId || (Array.isArray(order) ? order[0] : null) || null
      const eff = computeRelationshipEffectiveState(relationship, order, atNodeId, { storyOrder })
      const wrapper = eff?.awareness_raw ?? eff?.awareness ?? null
      setSingleDraft(wrapper)
    } else if (kind === 'knowledge' && knowledge) {
      // Use the walker at every anchor including origin. The
      // `Adam is actually Marisol` case in TEST_PROJECT.nnz — where
      // baseline `entries`/`sources` are empty and three observer
      // events live in `history` anchored at the knowledge's origin
      // scene — was returning tracking-OFF through the strip path;
      // walker resolves the three events correctly.
      const order = getKnowledgeNodeOrder(knowledge, projectNodes, projectEdges)
      const atNodeId = anchor?.nodeId || (Array.isArray(order) ? order[0] : null) || null
      const eff = computeKnowledgeEffectiveState(knowledge, order, atNodeId, { nodes: projectNodes, ctx: { storyOrder } })
      const wrapper = eff?.awareness_raw ?? eff?.awareness ?? null
      setSingleDraft(wrapper)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, ids.entityId, ids.relationshipId, ids.knowledgeId, anchor?.kind, anchor?.nodeId, initialItem])

  if (!open) return null

  // ── Per-kind: sidebar items, picker config, header context ───────
  let badgeLabel = ''
  let sidebarItems = null            // null = no sidebar (single-surface)
  let pickerScale = SCALE_BINARY
  let pickerSurface = 'entity'
  let pickerParentEntityId = null
  let pickerContext = null
  let extraTrackingRow = null
  let rightPaneTopBlocks = null      // optional value preview blocks above the picker
  let currentValue = null            // wrapper bound to the picker
  let onPickerChange = () => {}
  let contextSlotNode = null
  let pickerDisabled = false

  const kindLabels = {
    aliases: 'Names & Aliases',
    attributes: 'Attributes',
    entity: 'Entity Awareness',
    relationship: 'Relationship Awareness',
    knowledge: 'Knowledge Awareness',
  }
  badgeLabel = kindLabels[kind] || 'Awareness'

  if (kind === 'aliases' && entity && effectiveEntityAtAnchor) {
    sidebarItems = [
      { id: NAME_ITEM_ID, label: effectiveEntityAtAnchor.name || '(unnamed)', color: effectiveEntityAtAnchor.colour, italic: false },
      ...effectiveEntityAtAnchor.aliases
        .filter((a) => a && a.value)
        .map((a) => ({ id: a.value, label: a.value, italic: false })),
    ]
    const isNameSelected = selectedSubId === NAME_ITEM_ID
    const selectedAlias = isNameSelected ? null : effectiveEntityAtAnchor.aliases.find((a) => a.value === selectedSubId) || null
    pickerSurface = 'alias'
    pickerScale = SCALE_ALIAS
    pickerParentEntityId = entity.id
    pickerContext = isNameSelected
      ? { parentName: effectiveEntityAtAnchor.name || 'this entity', aliasValue: effectiveEntityAtAnchor.name || '' }
      : { parentName: entity.name || 'this entity', aliasValue: selectedAlias?.value || '' }
    currentValue = multiDraft[selectedSubId] ?? null
    onPickerChange = (next) => setMultiDraft((d) => ({ ...d, [selectedSubId]: next }))
    rightPaneTopBlocks = (
      <>
        <PreviewBlock
          label={isNameSelected ? 'Canonical name' : 'Alias'}
          value={isNameSelected ? effectiveEntityAtAnchor.name : selectedAlias?.value}
          valueColor={isNameSelected ? (effectiveEntityAtAnchor.colour || '#888888') : null}
        />
        <AwarenessHeader blurb={isNameSelected
          ? <>Tracks who knows the canonical name <span className="text-zinc-300">"{effectiveEntityAtAnchor.name || '…'}"</span> and what they understand about it. Distinct from existence-awareness ("knows the entity exists") — an observer can know one without the other. Uses the 4-level alias scale.</>
          : <>Tracks who knows the alias <span className="text-zinc-300">"{selectedAlias?.value || '…'}"</span> and what they understand about it. Uses the 4-level alias scale.</>
        } />
      </>
    )
    pickerSurface = isNameSelected ? 'entity_name' : 'alias'
  } else if (kind === 'attributes' && entity && effectiveEntityAtAnchor) {
    sidebarItems = effectiveEntityAtAnchor.attributes.map((a) => ({
      id: a.id,
      label: a.name || '(unnamed)',
      italic: !a.name,
      leadingNode: a.attribute_type === 'circumstance'
        ? <CircumstanceTypeBadge size={13} />
        : a.attribute_type === 'motivator'
          ? <MotivatorTypeBadge size={13} />
          : null,
    }))
    // Per-selection badge label — when a circumstance / motivator is
    // active, the modal's top-left badge reads `Circumstance` /
    // `Motivator` to match the type of the selected sub-item.
    // Falls back to plural `Attributes` when nothing's selected or
    // the selection is a non-C/M attribute type.
    const _selectedForBadge = effectiveEntityAtAnchor.attributes.find((a) => a.id === selectedSubId)
    if (_selectedForBadge?.attribute_type === 'circumstance') badgeLabel = 'Circumstance'
    else if (_selectedForBadge?.attribute_type === 'motivator') badgeLabel = 'Motivator'
    const selectedAttr = effectiveEntityAtAnchor.attributes.find((a) => a.id === selectedSubId) || null
    const baseAttr = (entity.attributes || []).find((a) => a.id === selectedSubId)
    const currentScale = baseAttr?.awareness_scale === 'full' ? 'full' : 'binary'
    pickerSurface = 'attribute'
    pickerScale = currentScale === 'full' ? SCALE_ALIAS : SCALE_BINARY
    pickerParentEntityId = entity.id
    pickerContext = selectedAttr ? { parentName: entity.name || 'this entity', attributeName: selectedAttr.name || 'this attribute' } : null
    currentValue = selectedSubId ? (multiDraft[selectedSubId] ?? null) : null
    onPickerChange = (next) => setMultiDraft((d) => ({ ...d, [selectedSubId]: next }))
    extraTrackingRow = selectedAttr ? (
      <PrecisionToggle
        currentScale={currentScale}
        onChange={(next) => {
          const updated = (entity.attributes || []).map((a) =>
            a.id === selectedAttr.id ? { ...a, awareness_scale: next } : a,
          )
          updateEntity(entity.id, { ...entity, attributes: updated })
        }}
      />
    ) : null
    const isCM = selectedAttr && (selectedAttr.attribute_type === 'circumstance' || selectedAttr.attribute_type === 'motivator')
    const displayValue = (() => {
      if (!selectedAttr) return ''
      if (selectedAttr.attribute_type === 'file') return selectedAttr.file_ref || ''
      if (selectedAttr.attribute_type === 'text_list') {
        try { const arr = JSON.parse(selectedAttr.value || '[]'); return Array.isArray(arr) ? arr.join(', ') : (selectedAttr.value || '') } catch { return selectedAttr.value || '' }
      }
      if (selectedAttr.attribute_type === 'entity_list') {
        try {
          const idsArr = JSON.parse(selectedAttr.value || '[]')
          if (!Array.isArray(idsArr)) return selectedAttr.value || ''
          return idsArr.map((id) => entityMap.get(id)?.name || id).join(', ')
        } catch { return selectedAttr.value || '' }
      }
      // Phase 1.22 — circumstance / motivator don't carry a meaningful
      // `value`; their content lives in `description` + `intensity`,
      // each rendered in its own preview block below. Returning '' here
      // means the generic "Value" block isn't used for C/M (it's
      // replaced by per-field blocks in `rightPaneTopBlocks`).
      if (isCM) return ''
      return selectedAttr.value || ''
    })()
    rightPaneTopBlocks = selectedAttr ? (
      isCM ? (
        <>
          {/* Name + Intensity sit on the same row — the name takes the
              flexible left column, the intensity sits in a fixed-width
              right column so the badge + label form a compact lozenge
              alongside the name preview. Description gets its own
              full-width block below. */}
          <div className="flex items-end gap-2">
            <div className="flex-1 min-w-0">
              <PreviewBlock
                label={selectedAttr.attribute_type === 'motivator' ? 'Motivator' : 'Circumstance'}
                value={selectedAttr.name}
                emptyText="(unnamed)"
              />
            </div>
            <div className="flex-shrink-0">
              <PreviewLabel>Intensity</PreviewLabel>
              <div className="text-xs px-2 py-1.5 bg-zinc-800/50 border border-zinc-700 rounded flex items-center gap-2" style={{ color: '#e4e4e7' }}>
                {selectedAttr.intensity != null ? (
                  <>
                    <IntensityBadge level={selectedAttr.intensity} size={18} />
                    <span>{INTENSITY_LABELS[Math.max(0, Math.min(4, Math.round(selectedAttr.intensity)))]} ({Math.max(0, Math.min(4, Math.round(selectedAttr.intensity))) + 1}/5)</span>
                  </>
                ) : (
                  <span className="italic text-zinc-500">(unset)</span>
                )}
              </div>
            </div>
          </div>
          <PreviewBlock
            label="Description"
            value={selectedAttr.description || ''}
            emptyText="(no description)"
          />
          <AwarenessHeader blurb={
            <>Tracks who knows about <span className="text-zinc-300">"{selectedAttr.name || '…'}"</span>.</>
          } />
        </>
      ) : (
        <>
          <PreviewBlock label="Attribute" value={selectedAttr.name} emptyText="(unnamed)" />
          <PreviewBlock label="Value" value={displayValue} />
          <AwarenessHeader blurb={
            <>Tracks who knows the value of <span className="text-zinc-300">"{selectedAttr.name || '…'}"</span>.</>
          } />
        </>
      )
    ) : null
  } else if (kind === 'entity' && entity) {
    pickerSurface = 'entity'
    const entityScale = entity.awareness_scale === 'full' ? 'full' : 'binary'
    pickerScale = entityScale === 'full' ? SCALE_ALIAS : SCALE_BINARY
    pickerParentEntityId = entity.id
    pickerContext = { parentName: entity.name || 'this entity' }
    currentValue = singleDraft
    onPickerChange = (next) => setSingleDraft(next)
    extraTrackingRow = (
      <PrecisionToggle
        currentScale={entityScale}
        onChange={(next) => updateEntity(entity.id, { ...entity, awareness_scale: next })}
      />
    )
    rightPaneTopBlocks = (
      <AwarenessHeader blurb={
        <>Tracks who knows that <span className="text-zinc-300">{entity.name || 'this entity'}</span> exists.</>
      } />
    )
  } else if (kind === 'relationship' && relationship) {
    pickerSurface = 'relationship'
    const relScale = relationship.awareness_scale === 'full' ? 'full' : 'binary'
    pickerScale = relScale === 'full' ? SCALE_ALIAS : SCALE_BINARY
    pickerParentEntityId = null
    pickerContext = { relationshipName: relationship.name?.trim() || 'this relationship' }
    currentValue = singleDraft
    onPickerChange = (next) => setSingleDraft(next)
    extraTrackingRow = (
      <PrecisionToggle
        currentScale={relScale}
        onChange={(next) => updateRelationship(relationship.id, { ...relationship, awareness_scale: next })}
      />
    )
    rightPaneTopBlocks = (
      <AwarenessHeader blurb={
        <>Tracks who knows about <RelationshipLabelChip name={relationship.name?.trim() || 'this relationship'} />.</>
      } />
    )
  } else if (kind === 'knowledge' && knowledge) {
    pickerSurface = 'knowledge'
    pickerScale = ((knowledge.awareness_scale || 'full') === 'binary') ? SCALE_BINARY : SCALE_ALIAS
    pickerParentEntityId = null
    pickerContext = { parentName: knowledge.name || 'this knowledge' }
    currentValue = singleDraft
    onPickerChange = (next) => setSingleDraft(next)
    extraTrackingRow = (
      <PrecisionToggle
        currentScale={knowledge.awareness_scale || 'full'}
        onChange={(next) => updateKnowledge(knowledge.id, { ...knowledge, awareness_scale: next })}
      />
    )
    rightPaneTopBlocks = (
      <AwarenessHeader blurb={
        <>Tracks who knows about <span className="inline-flex items-center gap-1 align-middle"><KnowledgeIcon size={12} /><span style={{ color: KNOWLEDGE_COLOUR }}>{knowledge.name || 'this knowledge'}</span></span>.</>
      } />
    )
  } else {
    return null
  }

  // Header context: entity badge for entity-bound kinds; rel chip for
  // relationship; knowledge chip for knowledge. Plus chain-anchor scene
  // badge when not at origin.
  if (kind === 'aliases' || kind === 'attributes' || kind === 'entity') {
    const entityForBadge = entity
      ? { ...entity, name: effectiveEntityAtAnchor?.name || entity.name, colour: effectiveEntityAtAnchor?.colour || entity.colour }
      : null
    contextSlotNode = (
      <>
        {entityForBadge && <EntityAvatarName entity={entityForBadge} />}
        {!isOriginAnchor && anchor?.nodeId && (
          <NodeBadge nodeId={anchor.nodeId} nodes={projectNodes} entityMap={entityMap} />
        )}
      </>
    )
  } else if (kind === 'relationship') {
    contextSlotNode = (
      <>
        <RelationshipLabelChip name={relationship?.name?.trim() || 'Relationship'} />
        {!isOriginAnchor && anchor?.nodeId && (
          <NodeBadge nodeId={anchor.nodeId} nodes={projectNodes} entityMap={entityMap} />
        )}
      </>
    )
  } else if (kind === 'knowledge') {
    contextSlotNode = (
      <>
        <span className="inline-flex items-center gap-1">
          <KnowledgeIcon size={16} />
          <span className="text-xs" style={{ color: KNOWLEDGE_COLOUR }}>{knowledge?.name || '(unnamed)'}</span>
        </span>
        {!isOriginAnchor && anchor?.nodeId && (
          <NodeBadge nodeId={anchor.nodeId} nodes={projectNodes} entityMap={entityMap} />
        )}
      </>
    )
  }

  // ── Commit ────────────────────────────────────────────────────────
  async function handleOk() {
    if (saving) return
    setSaving(true)
    try {
      const anchorOut = { kind: isOriginAnchor ? 'origin' : 'chain', nodeId: isOriginAnchor ? null : anchor.nodeId }
      let batchItems = []
      if (kind === 'aliases' && entity) {
        batchItems = [{ target: { kind: 'entity_name', entityId: entity.id }, draft: multiDraft[NAME_ITEM_ID] ?? null }]
        for (const aliasValue of Object.keys(multiDraft)) {
          if (aliasValue === NAME_ITEM_ID) continue
          batchItems.push({ target: { kind: 'alias', entityId: entity.id, aliasValue }, draft: multiDraft[aliasValue] ?? null })
        }
      } else if (kind === 'attributes' && entity) {
        batchItems = Object.keys(multiDraft).map((attrId) => ({
          target: { kind: 'attribute', entityId: entity.id, attributeId: attrId },
          draft: multiDraft[attrId] ?? null,
        }))
      } else if (kind === 'entity' && entity) {
        batchItems = [{ target: { kind: 'entity', entityId: entity.id }, draft: singleDraft }]
      } else if (kind === 'relationship' && relationship) {
        batchItems = [{ target: { kind: 'relationship', relationshipId: relationship.id }, draft: singleDraft }]
      } else if (kind === 'knowledge' && knowledge) {
        batchItems = [{ target: { kind: 'knowledge', knowledgeId: knowledge.id }, draft: singleDraft }]
      }
      if (batchItems.length > 0) {
        await commitAwarenessBatchAtAnchor({ items: batchItems, anchor: anchorOut })
      }
      closePanel()
    } finally {
      setSaving(false)
    }
  }

  const rightPane = (
    <div className="space-y-3">
      {rightPaneTopBlocks && (
        <div data-help-region="awareness:value_preview">{rightPaneTopBlocks}</div>
      )}
      <AwarenessPicker
        value={currentValue}
        onChange={onPickerChange}
        surface={pickerSurface}
        mode="groups"
        scale={pickerScale}
        parentEntityId={pickerParentEntityId}
        context={pickerContext}
        extraTrackingRow={extraTrackingRow}
        disabled={pickerDisabled}
      />
    </div>
  )

  return (
    <AwarenessModal
      open={open}
      onClose={closePanel}
      badgeLabel={badgeLabel}
      contextSlot={contextSlotNode}
      items={sidebarItems}
      selectedId={selectedSubId}
      onSelectItem={setSelectedSubId}
      rightPane={rightPane}
      saving={saving}
      onOk={handleOk}
      emptyMessage={kind === 'attributes' ? 'No attributes' : kind === 'aliases' ? 'No aliases' : ''}
    />
  )
}
