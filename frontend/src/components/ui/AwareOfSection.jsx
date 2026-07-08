/**
 * AwareOfSection — the "Aware of" section at the bottom of the entity
 * Detail Panel's Awareness sub-tab. Lists every awareness entry where
 * THIS entity appears in the keys of an awareness-bearing dict
 * anywhere in the project, grouped by level then kind.
 *
 * Universal pipeline:
 *   - One walker pass collects `{ kind, ...metadata, level }` records
 *     covering every awareness target (entity / entity_name / alias /
 *     attribute / relationship / knowledge). Every kind reads from the
 *     same chain-resolved-state walkers.
 *   - One renderer (`AwareOfRow`) dispatches on `record.kind` to the
 *     right row sub-component. Adding a new kind to the walker pass
 *     above + a new branch here makes it render automatically.
 *   - Unknown kinds fall through to `FallbackSubChip` so gaps are
 *     immediately visible during development.
 */

import { useMemo, useState } from 'react'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProjectStore } from '../../store/projectStore'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import {
  computeEffectiveState,
  computeKnowledgeEffectiveState,
  computeRelationshipEffectiveState,
  getRelationshipNodeOrder,
  knowledgeExistsAtNode,
  resolveObserverAwarenessLevel,
} from '../../utils/narrativeChain'
import { participantsFallbackLabel } from '../../utils/entityHelpers'
import { AwarenessBadge, SCALE_ALIAS } from './AwarenessBadges'
import { EntityAvatar, KnowledgeIcon, KNOWLEDGE_COLOUR, RelationshipLabelChip } from './IdentityBadges'
import { FallbackSubChip } from './change-subchips/atoms'
import { useUiStore } from '../../store/uiStore'
import ContributorPickerPopover from '../entities/ContributorPickerPopover'
import { decodeAwareness, buildOutValue } from '../entities/AwarenessPicker'

// Top-down: most-aware first (3 → 0). Always render all four so the
// layout is stable for drag-and-drop level reassignment in the future.
const LEVELS = [3, 2, 1, 0]

// Per-level "+" add-button tint, matching the AwarenessBadge palette
// (0 red, 1 blue, 2 amber, 3 emerald). The "aware of" add uses the
// level's own colour scheme per the design.
const LEVEL_ADD_BTN_CLASS = {
  0: 'text-red-300 bg-red-950/40 hover:bg-red-900/60 border border-red-800/50',
  1: 'text-blue-300 bg-blue-950/40 hover:bg-blue-900/60 border border-blue-800/50',
  2: 'text-amber-300 bg-amber-950/40 hover:bg-amber-900/60 border border-amber-800/50',
  3: 'text-emerald-300 bg-emerald-950/40 hover:bg-emerald-900/60 border border-emerald-800/50',
}

// Kind ordering within each level group.
const KIND_ORDER = ['entity', 'name', 'alias', 'attribute', 'relationship', 'knowledge']

const KIND_LABELS = {
  entity:       'Entity',
  name:         'Name',
  alias:        'Alias',
  attribute:    'Attribute',
  relationship: 'Relationship',
  knowledge:    'Knowledge',
}

// Row format: `[avatar] [entity name] {kind label} "{value}"` — avatar
// is the entity's actual profile image (or the colour-tinted type-icon
// fallback when no image is set), entity name is the chain-resolved
// name. Used for entity, name, and alias rows.

function EntityRow({ entity, onClick }) {
  const colour = entity.colour || '#888888'
  const clickable = typeof onClick === 'function'
  return (
    <div
      className={`flex items-center gap-1.5 px-1.5 py-1 rounded bg-zinc-800/40 border border-zinc-700${clickable ? ' cursor-pointer hover:bg-zinc-800/70 hover:border-accent-500 transition-colors' : ''}`}
      onClick={onClick}
      title={clickable ? 'Open entity awareness' : undefined}
    >
      <EntityAvatar entity={entity} size={16} />
      <span className="text-[11px] truncate min-w-0 flex-1" style={{ color: colour }}>
        {entity.name || '(unnamed)'}
      </span>
    </div>
  )
}

function NameRow({ entity, name, onClick }) {
  const colour = entity?.colour || '#888888'
  const clickable = typeof onClick === 'function'
  return (
    <div
      className={`flex items-center gap-1.5 px-1.5 py-1 rounded bg-zinc-800/40 border border-zinc-700${clickable ? ' cursor-pointer hover:bg-zinc-800/70 hover:border-accent-500 transition-colors' : ''}`}
      onClick={onClick}
      title={clickable ? 'Edit awareness' : undefined}
    >
      <EntityAvatar entity={entity} size={16} />
      <span className="text-[11px] flex-shrink-0 font-medium" style={{ color: colour }}>
        {entity?.name || '(unnamed)'}'s
      </span>
      <span className="text-[11px] truncate min-w-0 flex-1 text-zinc-200">
        <span className="text-zinc-500">Name:</span> {name || '(unnamed)'}
      </span>
    </div>
  )
}

function AliasRow({ entity, aliasValue, onClick }) {
  const colour = entity?.colour || '#888888'
  const clickable = typeof onClick === 'function'
  return (
    <div
      className={`flex items-center gap-1.5 px-1.5 py-1 rounded bg-zinc-800/40 border border-zinc-700${clickable ? ' cursor-pointer hover:bg-zinc-800/70 hover:border-accent-500 transition-colors' : ''}`}
      onClick={onClick}
      title={clickable ? 'Edit awareness' : undefined}
    >
      <EntityAvatar entity={entity} size={16} />
      <span className="text-[11px] flex-shrink-0 font-medium" style={{ color: colour }}>
        {entity?.name || '(unnamed)'}'s
      </span>
      <span className="text-[11px] truncate min-w-0 flex-1 text-zinc-200">
        <span className="text-zinc-500">Alias:</span> {aliasValue || '(unnamed)'}
      </span>
    </div>
  )
}

function KnowledgeRow({ knowledge, onClick }) {
  const clickable = typeof onClick === 'function'
  return (
    <div
      className={`flex items-center gap-1.5 px-1.5 py-1 rounded bg-zinc-800/40 border border-zinc-700${clickable ? ' cursor-pointer hover:bg-zinc-800/70 hover:border-accent-500 transition-colors' : ''}`}
      onClick={onClick}
      title={clickable ? 'Open Knowledge awareness' : undefined}
    >
      <KnowledgeIcon size={16} />
      <span className="text-[11px] truncate min-w-0 flex-1" style={{ color: KNOWLEDGE_COLOUR }}>
        {knowledge.name || '(unnamed)'}
      </span>
    </div>
  )
}

function AttributeRow({ entity, attribute, onClick }) {
  const colour = entity?.colour || '#888888'
  const clickable = typeof onClick === 'function'
  return (
    <div
      className={`flex items-center gap-1.5 px-1.5 py-1 rounded bg-zinc-800/40 border border-zinc-700${clickable ? ' cursor-pointer hover:bg-zinc-800/70 hover:border-accent-500 transition-colors' : ''}`}
      onClick={onClick}
      title={clickable ? 'Edit awareness' : undefined}
    >
      <EntityAvatar entity={entity} size={16} />
      <span className="text-[11px] flex-shrink-0 font-medium" style={{ color: colour }}>
        {entity?.name || '(unnamed)'}'s
      </span>
      <span className="text-[11px] truncate min-w-0 flex-1 text-zinc-200">
        <span className="text-zinc-500">{attribute?.name || '(unnamed)'}:</span>{' '}
        {attribute?.value || <span className="italic text-zinc-600">(empty)</span>}
      </span>
    </div>
  )
}

function RelationshipRow({ relationship, fallbackLabel, onClick }) {
  const clickable = typeof onClick === 'function'
  const hasName = !!(relationship?.name && String(relationship.name).trim().length > 0)
  return (
    <div
      className={`flex items-center gap-1.5 px-1.5 py-1 rounded bg-zinc-800/40 border border-zinc-700${clickable ? ' cursor-pointer hover:bg-zinc-800/70 hover:border-accent-500 transition-colors' : ''}`}
      onClick={onClick}
      title={clickable ? 'Open relationship' : undefined}
    >
      <span className="min-w-0 flex-1 truncate">
        <RelationshipLabelChip name={hasName ? relationship.name : 'Relationship'}>
          {hasName ? relationship.name : (fallbackLabel || '(no participants)')}
        </RelationshipLabelChip>
      </span>
    </div>
  )
}

// Universal kind-agnostic dispatcher: takes a record from the walker
// and delegates to the right row sub-component based on `record.kind`.
// Unknown kinds fall through to FallbackSubChip so the gap is visible.
function AwareOfRow({ record }) {
  if (!record) return null
  const k = record.kind
  if (k === 'entity')       return <EntityRow entity={record.entity} onClick={record.onClick} />
  if (k === 'name')         return <NameRow entity={record.entity} name={record.name} onClick={record.onClick} />
  if (k === 'alias')        return <AliasRow entity={record.entity} aliasValue={record.aliasValue} onClick={record.onClick} />
  if (k === 'attribute')    return <AttributeRow entity={record.entity} attribute={record.attribute} onClick={record.onClick} />
  if (k === 'relationship') return <RelationshipRow relationship={record.relationship} fallbackLabel={record.fallbackLabel} onClick={record.onClick} />
  if (k === 'knowledge')    return <KnowledgeRow knowledge={record.knowledge} onClick={record.onClick} />
  return <FallbackSubChip kind={`awareofrow:${k ?? 'unknown'}`} payload={record} />
}

function KindSubGroup({ kind, children }) {
  return (
    <div className="space-y-1">
      <div className="text-[9px] uppercase tracking-wider text-zinc-500 px-1">
        {KIND_LABELS[kind]}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function LevelHeader({ level }) {
  const label = SCALE_ALIAS.shortLabels[level] || `Level ${level}`
  return (
    <div className="flex items-center gap-2 px-1">
      <AwarenessBadge level={level} size={14} />
      <span className="text-[11px] uppercase tracking-wider text-zinc-300">
        {label}
      </span>
    </div>
  )
}

// Default matcher: "this entity_id is a key in the entries dict at any
// level". Returns the level when matched, null otherwise. The
// component lets callers swap in a different matcher (e.g. a
// relationship-source matcher) so the same render path serves both
// observer and source-provider use cases.
function makeEntityKeyMatcher(entityId) {
  return (wrapper) => {
    if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)) return null
    if ('relationship_id' in wrapper) return null
    // Wrapper-shape: read from entries; flat-dict: read directly.
    const entries = Object.prototype.hasOwnProperty.call(wrapper, 'entries')
      ? (wrapper.entries || {})
      : wrapper
    if (!(entityId in entries)) return null
    return entries[entityId]
  }
}

// Source-matcher: "this `{kind, id}` source is registered on the
// wrapper's `sources` array". Used by callers like the relationship
// awareness tab where the panel subject is a source provider, not an
// observer.
export function makeSourceMatcher(sourceKind, sourceId) {
  return (wrapper) => {
    if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)) return null
    if (!Array.isArray(wrapper.sources)) return null
    for (const s of wrapper.sources) {
      if (!s || s.kind !== sourceKind) continue
      if (sourceKind === 'relationship' && s.relationship_id !== sourceId) continue
      if (sourceKind === 'attribute' && (s.entity_id !== sourceId.entityId || s.attribute_id !== sourceId.attributeId)) continue
      return s.level
    }
    return null
  }
}

export default function AwareOfSection({
  entityId,           // back-compat: when set, default-matches `entityId in entries` AND filters self out of the iteration
  nodeId,
  entityName,
  // Custom matcher function `(wrapper) => level | null`. When provided,
  // overrides the default entity-key matcher. Callers (e.g. the
  // relationship awareness tab) supply this to find surfaces where
  // their subject appears as a source.
  matcher,
  // Header label and italic subline customisation. Defaults to the
  // entity-style "Aware of…" header + "Everything {entityName} is
  // aware of, grouped by awareness level."
  headerLabel = 'Aware of…',
  subjectLabel,
  // Optional set of (kind, id) pairs to skip during iteration. Used to
  // avoid listing the subject itself when the subject is a relationship.
  skipRelationshipId = null,
}) {
  // ── Per-bucket entity selectors (stable refs; never call allEntities()
  //    in a selector — would create a new array each render).
  const characters = useEntitiesStore((s) => s.characters)
  const locations  = useEntitiesStore((s) => s.locations)
  const items      = useEntitiesStore((s) => s.items)
  const factions   = useEntitiesStore((s) => s.factions)
  const customs    = useEntitiesStore((s) => s.customs)

  // ── Knowledge chain-state needs project topology
  const knowledgeObjs = useProjectStore((s) => s.knowledges)
  const relationships = useProjectStore((s) => s.relationships)
  const projectNodes  = useProjectStore((s) => s.nodes)
  const projectEdges  = useProjectStore((s) => s.edges)
  const storyOrder = useStoryOrder()
  const commitAwarenessAtAnchor = useProjectStore((s) => s.commitAwarenessAtAnchor)

  // Group entries by `level` then by `kind`. Output:
  //   { 3: { entity: [...], knowledge: [...] }, 2: {...}, ... }
  //
  // Universal awareness convention: every awareness dict has keys =
  // OBSERVERS, values = level. To find what THIS entity is aware of at
  // the current chain position, walk every other awareness-carrying
  // object's effective state to that anchor and check if `entityId`
  // appears in the keys.
  // Flat entity list shared with the observer resolver — it needs
  // `allEntities` to recognise faction observers for the cascade
  // rule, and to find membership relationships.
  const _allEntitiesForResolver = useMemo(
    () => [...characters, ...locations, ...items, ...factions, ...customs],
    [characters, locations, items, factions, customs],
  )

  // Effective matcher: caller-supplied custom matcher takes
  // priority. Default falls through to the chain-aware observer
  // resolver — it walks the wrapper's entries + sources at the
  // anchor with the full inheritance rules (direct wins, then
  // faction-direct-entry cascade via the faction's membership
  // relationship, then relationship sources, then attribute
  // sources). Source-derived levels surface here without the
  // walker pre-expanding members into the target's flat dict.
  const effectiveMatcher = useMemo(() => {
    if (typeof matcher === 'function') return matcher
    if (!entityId) return makeEntityKeyMatcher(entityId)
    const ctx = {
      allEntities: _allEntitiesForResolver,
      allRelationships: relationships,
      nodes: projectNodes,
      edges: projectEdges,
      storyOrder,
      anchorNodeId: nodeId,
    }
    return (wrapper) => resolveObserverAwarenessLevel(wrapper, entityId, ctx)
  }, [matcher, entityId, _allEntitiesForResolver, relationships, projectNodes, projectEdges, storyOrder, nodeId])

  const grouped = useMemo(() => {
    const out = { 0: {}, 1: {}, 2: {}, 3: {} }

    // Walk every entity / relationship / knowledge in the project at
    // the current anchor; for each awareness-bearing surface, the
    // matcher returns the level (or null when the subject doesn't
    // appear). Source-key callers pass the source-matcher; entity-key
    // callers fall through to the default matcher.
    const allEntities = [...characters, ...locations, ...items, ...factions, ...customs]
    for (const e of allEntities) {
      if (!e) continue
      if (entityId && e.id === entityId) continue
      const eff = computeEffectiveState(e, projectNodes, projectEdges, nodeId || null, { storyOrder })
      const resolvedEntity = { ...e, name: eff?.name || e.name, colour: eff?.colour || e.colour, type: e.type }

      // (1) Entity-existence
      {
        const lvl = effectiveMatcher(eff?.awareness_raw ?? eff?.awareness)
        if (lvl != null && lvl in out) (out[lvl].entity ||= []).push({ kind: 'entity', entity: resolvedEntity })
      }
      // (2) Canonical-name
      {
        const lvl = effectiveMatcher(eff?.name_awareness_raw ?? eff?.name_awareness)
        if (lvl != null && lvl in out) (out[lvl].name ||= []).push({ kind: 'name', entity: resolvedEntity, name: resolvedEntity.name })
      }
      // (3) Per-alias
      for (const alias of (eff?.aliases || [])) {
        const lvl = effectiveMatcher(alias?.awareness_raw ?? alias?.awareness)
        if (lvl != null && lvl in out) (out[lvl].alias ||= []).push({ kind: 'alias', entity: resolvedEntity, aliasValue: alias.value })
      }
      // (4) Per-attribute
      for (const attr of (eff?.attributes || [])) {
        const lvl = effectiveMatcher(attr?.awareness_raw ?? attr?.awareness)
        if (lvl != null && lvl in out) (out[lvl].attribute ||= []).push({ kind: 'attribute', entity: resolvedEntity, attribute: attr })
      }
    }

    // (5) Relationship awareness — chain-resolved at the current anchor.
    const getEntityForRel = (eid) => allEntities.find((e) => e.id === eid) || null
    for (const rel of (relationships || [])) {
      if (!rel) continue
      if (skipRelationshipId && rel.id === skipRelationshipId) continue
      const nodeOrder = getRelationshipNodeOrder(rel, projectNodes, projectEdges)
      const eff = computeRelationshipEffectiveState(rel, nodeOrder, nodeId || null, { storyOrder })
      const lvl = effectiveMatcher(eff?.awareness_raw ?? eff?.awareness)
      if (lvl == null || !(lvl in out)) continue
      const fallbackLabel = participantsFallbackLabel(eff?.participants || [], getEntityForRel)
      ;(out[lvl].relationship ||= []).push({
        kind: 'relationship',
        relationship: { ...rel, name: eff?.name ?? rel.name },
        fallbackLabel,
      })
    }

    // (6) Knowledge. At a scene we gate on the knowledge existing at that
    // scene; at the entity's origin (nodeId null) we evaluate each
    // knowledge's latest state so awareness established at the knowledge's
    // own baseline is visible from the entity's origin view.
    {
      const orderIds = storyOrder?.orderedIds || []
      for (const k of (knowledgeObjs || [])) {
        let wrapper
        if (nodeId) {
          if (!knowledgeExistsAtNode(k, nodeId, projectNodes, projectEdges, storyOrder)) continue
          // ctx.storyOrder is required so the awareness.history list is
          // walked when collapsing the wrapper to the resolved dict.
          // Without it, observers added via the universal setter at chain
          // anchors stay invisible to the matcher.
          let eff
          try {
            eff = computeKnowledgeEffectiveState(k, orderIds, nodeId, { nodes: projectNodes, ctx: { storyOrder } })
          } catch { continue }
          if (!eff || eff.notYetExists) continue
          wrapper = eff.awareness_raw ?? eff.awareness
        } else {
          // At the entity's origin (null anchor): read the knowledge's own
          // baseline awareness directly. The node-anchored walker reports
          // notYetExists for a null anchor, which would hide awareness
          // established at the knowledge's baseline (origin = baseline).
          wrapper = k.awareness ?? null
        }
        const lvl = effectiveMatcher(wrapper)
        if (lvl == null || !(lvl in out)) continue
        ;(out[lvl].knowledge ||= []).push({ kind: 'knowledge', knowledge: k })
      }
    }

    return out
  }, [
    characters, locations, items, factions, customs,
    knowledgeObjs, relationships, projectNodes, projectEdges, storyOrder, nodeId, entityId,
    effectiveMatcher, skipRelationshipId,
  ])

  // Resolve the chain anchor for the target's awareness picker.
  //
  // Rule: when the user is positioned at a scene (`nodeId` is set),
  // the picker opens at THAT scene as a chain anchor. Period. Edits
  // commit a chain entry at that scene. Falling back to the target's
  // origin because "the target has no presence at this scene yet"
  // would silently back-write to baseline, which is the recurring
  // chain-violation bug. If presence at the scene needs to be
  // established for the chain entry to land cleanly, that's a
  // setter-level concern — it must NOT cause this layer to write to
  // baseline behind the user's back.
  //
  // Only when `nodeId` is null (no scene context at all) does origin
  // become the legitimate anchor.
  const anchorForTarget = () => {
    if (!nodeId) return { kind: 'origin', nodeId: null }
    return { kind: 'chain', nodeId }
  }

  // ── Inverse "aware of" add ────────────────────────────────────────
  // The "+" beside each level records THIS entity as an observer on a
  // picked target at that level, at the panel's chain point. Mirrors the
  // "known by" add exactly: read the TARGET's current awareness wrapper
  // at the anchor (chain-resolved via the same walkers used above), add
  // this entity as an observer, and commit the FULL draft (the commit
  // replaces the observer set, so a partial draft would drop the
  // target's other observers). Only offered in the standard
  // entity-subject mode (entityId set, no custom matcher).
  const [addPickerLevel, setAddPickerLevel] = useState(null)
  const canAdd = !!entityId && typeof matcher !== 'function'

  const readTargetAwarenessAtAnchor = (pick) => {
    const at = nodeId || null
    const findEnt = (id) => _allEntitiesForResolver.find((e) => e.id === id) || null
    if (pick.kind === 'entity') {
      const e = findEnt(pick.entity_id)
      if (!e) return null
      const eff = computeEffectiveState(e, projectNodes, projectEdges, at, { storyOrder })
      return { target: { kind: 'entity', entityId: pick.entity_id }, current: eff?.awareness_raw ?? eff?.awareness ?? null }
    }
    if (pick.kind === 'relationship') {
      const rel = (relationships || []).find((r) => r.id === pick.relationship_id)
      if (!rel) return null
      const order = getRelationshipNodeOrder(rel, projectNodes, projectEdges)
      const eff = computeRelationshipEffectiveState(rel, order, at, { storyOrder })
      return { target: { kind: 'relationship', relationshipId: pick.relationship_id }, current: eff?.awareness_raw ?? eff?.awareness ?? null }
    }
    if (pick.kind === 'knowledge') {
      const k = (knowledgeObjs || []).find((x) => x.id === pick.knowledge_id)
      if (!k) return null
      const eff = computeKnowledgeEffectiveState(k, storyOrder?.orderedIds || [], at, { nodes: projectNodes, ctx: { storyOrder } })
      return { target: { kind: 'knowledge', knowledgeId: pick.knowledge_id }, current: eff?.awareness_raw ?? eff?.awareness ?? null }
    }
    if (pick.kind === 'alias') {
      const e = findEnt(pick.entity_id)
      if (!e) return null
      const eff = computeEffectiveState(e, projectNodes, projectEdges, at, { storyOrder })
      const al = (eff?.aliases || []).find((a) => (typeof a === 'string' ? a : a?.value) === pick.alias_value)
      const current = (al && typeof al !== 'string') ? (al.awareness_raw ?? al.awareness ?? null) : null
      return { target: { kind: 'alias', entityId: pick.entity_id, aliasValue: pick.alias_value }, current }
    }
    return null
  }

  const handleAwareOfPick = (pick, level) => {
    if (!entityId || !pick) return
    const resolved = readTargetAwarenessAtAnchor(pick)
    if (!resolved || !resolved.target) return
    const { entries, sources } = decodeAwareness(resolved.current)
    const draft = buildOutValue({ ...entries, [entityId]: level }, sources)
    commitAwarenessAtAnchor({ target: resolved.target, anchor: anchorForTarget(), draft })
  }
  const withClickHandler = (record) => {
    if (!record) return record
    if (record.kind === 'name') {
      return { ...record, onClick: () => useUiStore.getState().openAliasesPanel(
        record.entity.id, anchorForTarget(), { kind: 'name' },
      ) }
    }
    if (record.kind === 'alias') {
      return { ...record, onClick: () => useUiStore.getState().openAliasesPanel(
        record.entity.id, anchorForTarget(), { kind: 'alias', value: record.aliasValue },
      ) }
    }
    if (record.kind === 'attribute') {
      return { ...record, onClick: () => useUiStore.getState().openAttributesAwarenessPanel(
        record.entity.id, anchorForTarget(), record.attribute?.id ?? null,
      ) }
    }
    if (record.kind === 'relationship') {
      return { ...record, onClick: () => useUiStore.getState().openAwarenessSurfacePanel({
        kind: 'relationship', ids: { relationshipId: record.relationship.id }, anchor: anchorForTarget(),
      }) }
    }
    if (record.kind === 'entity') {
      return { ...record, onClick: () => useUiStore.getState().openAwarenessSurfacePanel({
        kind: 'entity', ids: { entityId: record.entity.id }, anchor: anchorForTarget(),
      }) }
    }
    if (record.kind === 'knowledge') {
      return { ...record, onClick: () => useUiStore.getState().openAwarenessSurfacePanel({
        kind: 'knowledge', ids: { knowledgeId: record.knowledge.id }, anchor: anchorForTarget(),
      }) }
    }
    return record
  }

  return (
    <div className="space-y-3" data-help-region="awareness-display:aware_of">
      <div className="text-[10px] uppercase tracking-wider text-zinc-400 px-1">
        {headerLabel}
      </div>
      <div className="text-[10px] text-zinc-500 italic px-1 leading-snug">
        Everything <span className="text-zinc-300">{subjectLabel || entityName || 'this entity'}</span> is aware of, grouped by awareness level.
      </div>

      <div className="space-y-3">
        {LEVELS.map((level) => {
          const levelKinds = grouped[level] || {}
          const liveKindsHere = KIND_ORDER.filter((k) => Array.isArray(levelKinds[k]) && levelKinds[k].length > 0)
          const isEmpty = liveKindsHere.length === 0

          return (
            <div key={level} className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <LevelHeader level={level} />
                {canAdd && (
                  <button
                    type="button"
                    onClick={() => setAddPickerLevel(addPickerLevel === level ? null : level)}
                    title={addPickerLevel === level ? 'Close picker' : `Add something ${entityName || 'this entity'} is aware of at this level`}
                    className={`inline-flex items-center justify-center w-4 h-4 rounded text-[11px] leading-none flex-shrink-0 transition-colors ${LEVEL_ADD_BTN_CLASS[level] || 'text-zinc-300 bg-white/10 hover:bg-white/20'}`}
                  >{addPickerLevel === level ? '✕' : '✚'}</button>
                )}
              </div>
              {canAdd && addPickerLevel === level && (
                <div className="px-1">
                  <ContributorPickerPopover
                    allEntities={_allEntitiesForResolver}
                    allRelationships={relationships || []}
                    allKnowledges={knowledgeObjs || []}
                    onPick={(pick) => handleAwareOfPick(pick, level)}
                    onClose={() => setAddPickerLevel(null)}
                  />
                </div>
              )}
              <div className="pl-2 space-y-2">
                {isEmpty && (
                  <p className="text-[10px] text-zinc-600 italic px-1">
                    (none yet)
                  </p>
                )}

                {liveKindsHere.map((kind) => (
                  <KindSubGroup key={kind} kind={kind}>
                    {(levelKinds[kind] || []).map((record, i) => (
                      <AwareOfRow
                        key={`${kind}-${i}`}
                        record={withClickHandler(record)}
                      />
                    ))}
                  </KindSubGroup>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
