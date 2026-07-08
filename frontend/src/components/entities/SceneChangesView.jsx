import { useMemo } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import {
  ENTITY_BUCKETS,
  computeEffectiveState,
  computeEffectiveStateWithPrior,
  computeChangeSubChips,
  getEntityNarrativeChain,
  getAwarenessChangesForObserverAtNode,
  getRelationshipChangesAtNode,
  getKnowledgeNodeOrder,
} from '../../utils/narrativeChain'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import {
  buildSourceEventFromEntityRefChip,
  buildSuggestedKnowledgeName,
} from '../../utils/sourceEventBuilder'
import ImageHoverPreview from '../ui/ImageHoverPreview'
import { TYPE_ICONS, participantsFallbackLabel } from '../../utils/entityHelpers'
import { KNOWLEDGE_COLOUR, RelationshipIcon } from '../ui/IdentityBadges'
import { AwarenessBadge } from '../ui/AwarenessBadges'
import { knowledgeContentChangeToSubChip } from '../ui/change-subchips/knowledgeChangeAdapter'
import ChangeSubChip from '../ui/change-subchips/ChangeSubChip'
import CircumstanceMotivatorSubChip from '../ui/change-subchips/CircumstanceMotivatorSubChip'
import PerspectiveSubChip from '../ui/change-subchips/PerspectiveSubChip'
import AwarenessSubChip from '../ui/change-subchips/AwarenessSubChip'
import RelationshipHistoryChangeChip from '../ui/change-subchips/RelationshipHistoryChangeChip'
import { CircumstanceTypeBadge } from '../ui/TypeBadges'
import { IntensityBadge, INTENSITY_LABELS } from '../ui/IntensityBadge'
import { useAccentColor } from '../../utils/povConstants'

/**
 * SceneChangesView — Phase 1.21k aggregated "what happens at this scene"
 * digest. One card per source (entity / relationship / knowledge); each
 * card has a header (avatar + name + click drills the LEFT detail panel
 * into that source at this scene) followed by the source's change rows
 * rendered directly with the same chip primitives the per-entity panel
 * uses. No nested "Changes at this point" header — the source name
 * already labels the group.
 *
 * Per-entity rows expose hover dismiss `−` (routes through
 * `clearEntityRefChange`) and "Add knowledge of this change" `✚` (opens
 * the AddKnowledgeFromChangePopover with a sourceEvent built from the
 * entity's EntityRef on this scene). Relationship and Knowledge rows
 * are presentation-only for now (their dismiss / Add-Knowledge wiring
 * lives in the per-source detail panels).
 */
function SourceCard({ avatar, label, colour, onClick, children, borderColour }) {
  return (
    <div data-help-region="detail-scene:changes_source_card" className="border rounded mb-2 last:mb-0" style={{ borderColor: borderColour || '#3f3f46' }}>
      <button
        onClick={onClick}
        className="w-full px-2 py-1 flex items-center gap-1.5 bg-zinc-800/40 border-b text-left text-[10px] hover:bg-zinc-800/70"
        style={{ borderColor: borderColour || '#3f3f46', color: colour }}
        title="Open"
      >
        {avatar}
        <span className="truncate flex-1">{label}</span>
        <span className="text-zinc-600 text-[9px]">›</span>
      </button>
      <div className="px-1 py-1 space-y-0.5">
        {children}
      </div>
    </div>
  )
}

function EntityAvatar({ entity, profileRef, colour, size = 14 }) {
  const assetName = profileRef ? profileRef.replace(/^assets\//, '') : null
  const c = colour || entity?.colour || '#888888'
  return (
    <ImageHoverPreview src={assetName ? `/api/project/assets/${assetName}` : null} borderColour={c} size={64}>
      <span
        className="inline-flex items-center justify-center flex-shrink-0 rounded-sm overflow-hidden"
        style={{ width: size, height: size, border: `1.5px solid ${c}`, backgroundColor: assetName ? 'transparent' : c + '22' }}
      >
        {assetName
          ? <img src={`/api/project/assets/${assetName}`} alt="" className="w-full h-full object-cover" />
          : <span style={{ fontSize: size * 0.6, lineHeight: 1 }}>{TYPE_ICONS[entity?.type] || '?'}</span>}
      </span>
    </ImageHoverPreview>
  )
}

export default function SceneChangesView({ nodeId }) {
  const setDetailPanel = useUiStore((s) => s.setDetailPanel)
  const openRelationshipDetail = useUiStore((s) => s.openRelationshipDetail)
  const openKnowledgeDetail = useUiStore((s) => s.openKnowledgeDetail)
  const clearEntityRefChange = useProjectStore((s) => s.clearEntityRefChange)
  const nodes = useProjectStore((s) => s.nodes)
  const edges = useProjectStore((s) => s.edges)
  const allRelationships = useProjectStore((s) => s.relationships)
  const allKnowledges = useProjectStore((s) => s.knowledges)
  const characters = useEntitiesStore((s) => s.characters)
  const locations = useEntitiesStore((s) => s.locations)
  const items = useEntitiesStore((s) => s.items)
  const factions = useEntitiesStore((s) => s.factions)
  const customs = useEntitiesStore((s) => s.customs)
  const storyOrder = useStoryOrder()
  // Phase 1.22h — workspace accent for temporary chevron strokes.
  const sceneAccentColour = useAccentColor()

  const allEntities = useMemo(
    () => [...characters, ...locations, ...items, ...factions, ...customs],
    [characters, locations, items, factions, customs],
  )
  const getEntity = (id) => allEntities.find((e) => e.id === id) || null

  const node = nodes.find((n) => n.id === nodeId)

  // Per-entity sources — every EntityRef on this scene with at least one
  // chain change here (entity scalar / attribute changes, or awareness
  // deltas the entity is the OBSERVER of), OR scene-side temporary
  // circumstance/motivator entries (Phase 1.22h — scene IS origin for
  // those, not chain-tracked).
  const entitySources = useMemo(() => {
    if (!node) return []
    // Phase 1.22h — temporary C/M entries grouped by entity (scene-side).
    const allTemp = node?.data?.entity_temporary_circumstances || []
    const tempByEntity = new Map()
    for (const t of allTemp) {
      if (!t?.entity_id) continue
      if (!tempByEntity.has(t.entity_id)) tempByEntity.set(t.entity_id, [])
      tempByEntity.get(t.entity_id).push(t)
    }
    const seen = new Set()
    const out = []
    for (const bucket of ENTITY_BUCKETS) {
      const refs = node.data?.[bucket] || []
      for (const ref of refs) {
        const entity = getEntity(ref.entity_id)
        if (!entity) continue
        // Current + prior chain-resolved state at this scene via the
        // unified helper (computeEffectiveStateWithPrior). Handles
        // sub-chain backward walks and unifies the "no prior"
        // baseline fallback. `chain`/`idx` are still computed below
        // because `chainIdx` is passed as an opaque navigation
        // parameter to the detail panel — needed independently of
        // the chain-resolved state.
        const { current: eff, prior: priorState } = computeEffectiveStateWithPrior(entity, nodes, edges, nodeId)
        const chain = getEntityNarrativeChain(entity.id, nodes, edges)
        const idx = chain.findIndex((n) => n.id === nodeId)
        const chips = computeChangeSubChips(ref, priorState, entity, allEntities)
          .filter((c) => !c.isRelationship)
        const awarenessChips = getAwarenessChangesForObserverAtNode({
          observerEntityId: entity.id,
          nodeId,
          allNodes: nodes,
          allEdges: edges,
          allEntities: [...allEntities, ...allKnowledges],
          allRelationships,
          allKnowledges,
        })
        const tempEntries = tempByEntity.get(entity.id) || []
        if (chips.length === 0 && awarenessChips.length === 0 && tempEntries.length === 0) continue
        // `eff` was already computed above via the unified helper —
        // reuse it instead of a duplicate chain walk.
        seen.add(entity.id)
        out.push({ entity, ref, chips, awarenessChips, tempEntries, effective: eff || entity, chainIdx: idx })
      }
    }
    // Edge case: a temp entry exists for an entity that's no longer on
    // any chip in this scene (e.g. chip removed after temp added).
    // Still surface it so the user can find / clear it.
    for (const [entityId, tempEntries] of tempByEntity.entries()) {
      if (seen.has(entityId)) continue
      const entity = getEntity(entityId)
      if (!entity) continue
      const eff = computeEffectiveState(entity, nodes, edges, nodeId)
      out.push({ entity, ref: null, chips: [], awarenessChips: [], tempEntries, effective: eff || entity, chainIdx: -1 })
    }
    return out
  }, [node, nodeId, nodes, edges, allEntities, allRelationships, allKnowledges])

  // Per-relationship sources — every relationship with at least one
  // history entry anchored at this scene (existence / participant /
  // perception / alias / role / hierarchy / name / description /
  // awareness). Aggregated rel-level digest, not duplicated per
  // participant.
  const relationshipSources = useMemo(() => {
    if (!node) return []
    const orderedIds = storyOrder?.orderedIds || null
    const out = []
    for (const rel of (allRelationships || [])) {
      const changes = getRelationshipChangesAtNode(rel, nodeId, null, orderedIds)
      // Name / description scalar history live outside the per-entity
      // helper return; pull them by scanning rel.history directly.
      const nameDescChanges = []
      for (const ch of (rel.history?.name_changes || [])) {
        if (ch?.node_id === nodeId) nameDescChanges.push({ type: 'name', action: 'modify', new_value: ch.new_name ?? null, old_value: ch.old_name ?? null })
      }
      for (const ch of (rel.history?.description_changes || [])) {
        if (ch?.node_id === nodeId) nameDescChanges.push({ type: 'description', action: 'modify', new_value: ch.new_description ?? null, old_value: ch.old_description ?? null })
      }
      const all = [...changes, ...nameDescChanges]
      if (all.length === 0) continue
      out.push({ rel, changes: all })
    }
    return out
  }, [node, nodeId, allRelationships, storyOrder])

  // Host-side awareness changes at this scene — walks every awareness
  // wrapper in the project (entity / entity_name / per-attribute /
  // per-alias / relationship / knowledge) and collects entries whose
  // `node_id` matches this scene. Each entry is grouped by HOST (the
  // object whose awareness is being touched) so the section reads as
  // "awareness on Alice's Title was set to tier 3 for Gal Pals" — host
  // first, then the change rows. Covers writes that don't ride on a
  // chip's `attribute_changes` chain entry (the observer-helper path
  // already covers those for chip-side observers).
  //
  // Dedup: if an awareness entry is already represented as an
  // AwarenessSubChip on one of the entity sources above (matched by
  // changeId / entry.id), drop it here so the user doesn't see the
  // same awareness change twice. The Awareness section only contains
  // entries that aren't covered elsewhere in this tab.
  const representedAwarenessIds = useMemo(() => {
    const ids = new Set()
    for (const src of entitySources) {
      for (const rec of (src.awarenessChips || [])) {
        if (rec?.changeId) ids.add(rec.changeId)
      }
    }
    return ids
  }, [entitySources])

  const awarenessHostSources = useMemo(() => {
    if (!node) return []
    const groups = []
    function pushHostEntries(host, wrapper) {
      if (!wrapper || !Array.isArray(wrapper.history)) return
      const entries = wrapper.history.filter(
        (h) => h?.node_id === nodeId && !(h?.id && representedAwarenessIds.has(h.id)),
      )
      if (entries.length === 0) return
      groups.push({ host, entries })
    }
    // Entity / name / per-attribute / per-alias awareness wrappers.
    for (const e of allEntities) {
      pushHostEntries({ kind: 'entity', entity: e }, e.awareness)
      pushHostEntries({ kind: 'entity_name', entity: e }, e.name_awareness)
      for (const attr of (e.attributes || [])) {
        pushHostEntries({ kind: 'attribute', entity: e, attribute: attr }, attr?.awareness)
      }
      for (const al of (e.aliases || [])) {
        if (al && typeof al === 'object' && al.value) {
          pushHostEntries({ kind: 'alias', entity: e, aliasValue: al.value }, al.awareness)
        }
      }
    }
    // Relationships.
    for (const r of (allRelationships || [])) {
      pushHostEntries({ kind: 'relationship', relationship: r }, r.awareness)
    }
    // Knowledges.
    for (const k of (allKnowledges || [])) {
      pushHostEntries({ kind: 'knowledge', knowledge: k }, k.awareness)
    }
    return groups
  }, [node, nodeId, allEntities, allRelationships, allKnowledges, representedAwarenessIds])

  // Per-knowledge sources — every Knowledge with at least one chain
  // entry at this scene (history.* OR awareness.history). Manual-anchor-
  // only presence is omitted; that's display, not a "change".
  const knowledgeSources = useMemo(() => {
    if (!node) return []
    const out = []
    for (const k of (allKnowledges || [])) {
      const order = getKnowledgeNodeOrder(k, nodes, edges, null)
      if (!order.includes(nodeId)) continue
      const rows = []
      const history = k.history || {}
      for (const listKey of ['name_changes', 'description_changes', 'colour_changes', 'profile_image_changes']) {
        for (const entry of (history[listKey] || [])) {
          if (entry?.node_id !== nodeId) continue
          const chip = knowledgeContentChangeToSubChip(listKey, entry)
          if (chip) rows.push({ kind: 'content', entry, chip })
        }
      }
      for (const entry of (history.existence_changes || [])) {
        if (entry?.node_id !== nodeId) continue
        rows.push({ kind: 'existence', entry })
      }
      if (rows.length === 0) continue
      out.push({ knowledge: k, rows })
    }
    return out
  }, [node, nodeId, nodes, edges, allKnowledges])

  if (!node) return null

  // Phase 1.22g — scene-level circumstances are NOT chain-tracked (they
  // live directly on Scene.circumstances; the scene IS their origin so
  // baseline-direct read here is the chain-aware path). They are not
  // per-anchor change events, but the user wants them visible in the
  // Changes tab as a separate section so a writer can see "what's
  // happening at this scene" in one place.
  const sceneLevelCircs = Array.isArray(node?.data?.circumstances) ? node.data.circumstances : []

  const totalSources = entitySources.length + relationshipSources.length + knowledgeSources.length + awarenessHostSources.length + sceneLevelCircs.length
  if (totalSources === 0) {
    return (
      <div className="p-4 text-xs text-zinc-600 italic text-center">
        No changes recorded at this scene.
      </div>
    )
  }

  return (
    <div className="p-2">
      {sceneLevelCircs.length > 0 && (
        <SourceCard
          avatar={<span className="inline-flex items-center justify-center"><CircumstanceTypeBadge size={14} /></span>}
          label="Scene-level circumstances"
          colour="#94a3b8"
          borderColour="#94a3b855"
          onClick={() => {
            // Scene Detail Panel Circumstances sub-tab. Set the sub-tab
            // first so the panel lands focused on the right tab.
            useUiStore.getState().setDetailPanelActiveSubTab('circumstances')
            setDetailPanel('scene', nodeId)
          }}
        >
          {sceneLevelCircs.map((c) => (
            <CircumstanceMotivatorSubChip
              key={c.id}
              attributeType="circumstance"
              name={c.name || ''}
              description={c.description || ''}
              intensity={c.intensity ?? null}
              onClick={() => {
                useUiStore.getState().setDetailPanelActiveSubTab('circumstances')
                setDetailPanel('scene', nodeId)
              }}
            />
          ))}
        </SourceCard>
      )}
      {entitySources.map(({ entity, ref, chips, awarenessChips, tempEntries, effective, chainIdx }) => {
        const colour = effective?.colour || entity.colour || '#888888'
        const name = effective?.name || entity.name || '(unnamed)'
        const profileRef = effective?.profile_image_ref || entity.profile_image_ref || null
        // Sub-tab routing matches the canvas SceneNode sub-chip click
        // policy: attribute sub-chips land on the entity's 'attributes'
        // tab; scalar / colour / profile-image / aliases / etc. land
        // on 'details'. Awareness sub-chips land on 'awareness'.
        const tabForChip = (chip) => (chip.attributeId ? 'attributes' : 'details')
        return (
          <SourceCard
            key={`ent-${entity.id}`}
            avatar={<EntityAvatar entity={entity} profileRef={profileRef} colour={colour} />}
            label={name}
            colour={colour}
            borderColour={colour + '55'}
            onClick={() => setDetailPanel('entityChip', nodeId, entity.id, chainIdx, 'details')}
          >
            {/* Phase 1.22h — temporary C/M entries (scene-side, scene IS
                origin). Render at top of card so they read first. Click
                routes to the entity Detail Panel Attributes tab where
                the temp affordance lives; rendered with chevron-corner
                badges + dashed accent border for visual scoping. */}
            {tempEntries.map((t) => (
              <div
                key={`temp-${t.id}`}
                className="rounded px-1 py-0.5"
                style={{ border: `1px dashed ${sceneAccentColour}` }}
              >
                <CircumstanceMotivatorSubChip
                  attributeType={t.attribute_type}
                  name={t.name || ''}
                  description={t.description || ''}
                  intensity={t.intensity ?? null}
                  temporary
                  temporaryColour={sceneAccentColour}
                  onClick={() => setDetailPanel('entityChip', nodeId, entity.id, chainIdx, 'attributes')}
                />
              </div>
            ))}
            {chips.map((chip, i) => {
              // Phase 2.13b — perspective change events dispatch to the
              // dedicated PerspectiveSubChip. Same descriptor shape as
              // the canvas dispatchers; click navigates to the
              // entity's Detail Panel Attributes tab at this anchor.
              if (chip.isPerspective) {
                return (
                  <PerspectiveSubChip
                    key={`chip-${i}`}
                    description={chip.description}
                    perspectiveTargetKind={chip.perspectiveTargetKind}
                    perspectiveTargetId={chip.perspectiveTargetId}
                    action={chip.action}
                    oldDescription={chip.oldDescription}
                    oldPerspectiveTargetKind={chip.oldPerspectiveTargetKind}
                    oldPerspectiveTargetId={chip.oldPerspectiveTargetId}
                    onClick={() => setDetailPanel('entityChip', nodeId, entity.id, chainIdx, 'attributes')}
                    onDismiss={() => clearEntityRefChange(nodeId, entity.id, chip)}
                  />
                )
              }
              // Phase 1.22g — circumstance / motivator change events
              // dispatch to the dedicated CircumstanceMotivatorSubChip
              // (same chip descriptor shape as the SceneNode / EntityNode
              // canvas dispatchers; click navigates to the entity's
              // Detail Panel Attributes tab at this scene anchor —
              // sidebar handles the section-scroll on its end).
              if (chip.isCircumstanceOrMotivator) {
                return (
                  <CircumstanceMotivatorSubChip
                    key={`chip-${i}`}
                    attributeType={chip.attributeType}
                    name={chip.field}
                    description={chip.description}
                    intensity={chip.intensity ?? null}
                    action={chip.action}
                    oldValue={chip.oldValue}
                    newValue={chip.newValue}
                    oldIntensity={chip.oldIntensity}
                    newIntensity={chip.newIntensity}
                    onClick={() => setDetailPanel('entityChip', nodeId, entity.id, chainIdx, 'attributes')}
                    onDismiss={() => clearEntityRefChange(nodeId, entity.id, chip)}
                    onAddKnowledge={(e) => {
                      const sourceEvent = buildSourceEventFromEntityRefChip(chip, ref, nodeId)
                      if (!sourceEvent) return
                      const rect = e?.currentTarget?.getBoundingClientRect?.() || null
                      useUiStore.getState().openAddKnowledgeFromChangePopover({
                        anchorRect: rect,
                        sourceEvent,
                        suggestedName: buildSuggestedKnowledgeName(chip, ref, entity),
                        triggerNodeId: nodeId,
                        isOrigin: false,
                        eventDisplay: {
                          ownerEntityId: entity.id,
                          action: chip.action,
                          fieldLabel: chip.field,
                          oldValue: chip.oldValue,
                          newValue: chip.newValue,
                        },
                      })
                    }}
                  />
                )
              }
              return (
                <ChangeSubChip
                  key={`chip-${i}`}
                  chip={chip}
                  entityColour={colour}
                  onClick={() => setDetailPanel('entityChip', nodeId, entity.id, chainIdx, tabForChip(chip))}
                  onDismiss={() => clearEntityRefChange(nodeId, entity.id, chip)}
                  onAddKnowledge={(e) => {
                    const sourceEvent = buildSourceEventFromEntityRefChip(chip, ref, nodeId)
                    if (!sourceEvent) return
                    const rect = e?.currentTarget?.getBoundingClientRect?.() || null
                    useUiStore.getState().openAddKnowledgeFromChangePopover({
                      anchorRect: rect,
                      sourceEvent,
                      suggestedName: buildSuggestedKnowledgeName(chip, ref, entity),
                      triggerNodeId: nodeId,
                      isOrigin: false,
                      eventDisplay: {
                        ownerEntityId: entity.id,
                        action: chip.action,
                        fieldLabel: chip.field,
                        oldValue: chip.oldValue,
                        newValue: chip.newValue,
                      },
                    })
                  }}
                />
              )
            })}
            {awarenessChips.map((rec) => (
              <AwarenessSubChip
                key={rec.changeId || `aw-${rec.kind}-${rec.targetEntityId || rec.knowledgeId || rec.relationshipId}`}
                record={rec}
                observerName={name}
                getEntity={(eid) => allEntities.find((e) => e.id === eid) || null}
                getRelationship={(rid) => allRelationships?.find((r) => r.id === rid) || null}
                getKnowledge={(kid) => (allKnowledges || []).find((k) => k.id === kid) || null}
                onClick={() => setDetailPanel('entityChip', nodeId, entity.id, chainIdx, 'awareness')}
              />
            ))}
          </SourceCard>
        )
      })}

      {relationshipSources.map(({ rel, changes }) => {
        // Resolve participants for the header label. History-only:
        // derive from `join` events, fall back to participants_fallback.
        const pts = Array.from(new Set(
          (rel.history?.participant_changes || [])
            .filter((c) => c.action === 'join')
            .map((c) => c.entity_id)
        )).map((eid) => ({ entity_id: eid }))
        const resolveNameHere = (eid) => {
          const ent = getEntity(eid)
          if (!ent) return null
          const s = computeEffectiveState(ent, nodes, edges, nodeId)
          return s?.name || ent.name || null
        }
        const label = rel.name || (pts.length > 0
          ? participantsFallbackLabel(pts, getEntity, 3, rel, resolveNameHere)
          : '(unnamed relationship)')
        const relAvatar = <RelationshipIcon size={12} />
        return (
          <SourceCard
            key={`rel-${rel.id}`}
            avatar={relAvatar}
            label={label}
            colour="#a78bfa"
            borderColour="#a78bfa55"
            onClick={() => openRelationshipDetail(rel.id, nodeId)}
          >
            {changes.map((change, i) => (
              <RelationshipHistoryChangeChip
                key={`relhist-${rel.id}-${i}`}
                entry={{ relationship: rel, change }}
                getEntity={(eid) => allEntities.find((e) => e.id === eid) || null}
                resolveNameAtAnchor={resolveNameHere}
                hideRelationshipLabel
                onClick={() => openRelationshipDetail(rel.id, nodeId)}
              />
            ))}
          </SourceCard>
        )
      })}

      {knowledgeSources.map(({ knowledge, rows }) => {
        const colour = knowledge.colour || KNOWLEDGE_COLOUR
        const assetName = knowledge.profile_image_ref ? knowledge.profile_image_ref.replace(/^assets\//, '') : null
        const knowledgeAvatar = (
          <span
            className="inline-flex items-center justify-center flex-shrink-0 rounded-sm overflow-hidden"
            style={{ width: 14, height: 14, border: `1.5px solid ${colour}`, backgroundColor: assetName ? 'transparent' : colour + '22' }}
          >
            {assetName
              ? <img src={`/api/project/assets/${assetName}`} alt="" className="w-full h-full object-cover" />
              : <span style={{ fontSize: 9, lineHeight: 1 }}>📜</span>}
          </span>
        )
        return (
          <SourceCard
            key={`k-${knowledge.id}`}
            avatar={knowledgeAvatar}
            label={knowledge.name || '(unnamed)'}
            colour={colour}
            borderColour={`${KNOWLEDGE_COLOUR}55`}
            onClick={() => openKnowledgeDetail(knowledge.id, nodeId)}
          >
            {rows.map((row, i) => {
              if (row.kind === 'content' && row.chip) {
                return (
                  <ChangeSubChip
                    key={`${row.entry?.id || i}`}
                    chip={row.chip}
                    entityColour={colour}
                    onClick={() => openKnowledgeDetail(knowledge.id, nodeId)}
                  />
                )
              }
              if (row.kind === 'existence') {
                const action = row.entry?.action === 'activate' ? 'add' : 'remove'
                return (
                  <ChangeSubChip
                    key={`${row.entry?.id || i}-existence`}
                    chip={{ action, field: row.entry?.action === 'activate' ? 'Created' : 'Deactivated', newValue: null }}
                    entityColour={colour}
                    onClick={() => openKnowledgeDetail(knowledge.id, nodeId)}
                  />
                )
              }
              return null
            })}
          </SourceCard>
        )
      })}

      {/* Awareness section — every awareness change anchored at this
          scene, grouped by HOST (the object whose awareness wrapper is
          being touched). Covers writes that don't ride on a chip's
          attribute_changes — e.g. AttributesAwarenessPanel commits to
          `attribute.awareness.history` directly. The header keeps the
          section visually distinct from the entity / relationship /
          knowledge cards above. */}
      {awarenessHostSources.length > 0 && (
        <div data-help-region="detail-scene:changes_awareness_section" className="mt-3 mb-1 text-[10px] uppercase tracking-wider text-zinc-500 px-1">
          Awareness
        </div>
      )}
      {awarenessHostSources.map(({ host, entries }, hostIdx) => {
        // Resolve a header label + avatar + click target for the host.
        let label, avatar, colour, onCardClick, key
        // Resolve a click target for the host. For entity-hosted
        // awareness changes we route into the entity's chip at THIS
        // scene if the entity is in the scene (chain-anchor view),
        // otherwise fall through to the entity's origin EntityNode.
        // Sub-tab matches where the awareness layer is editable for
        // each host kind: attributes → 'attributes', everything else
        // entity-hosted → 'awareness'.
        function entityNavTarget(e, subTabName) {
          if (!e) return null
          // Prefer the chip-at-this-scene if the entity is present here.
          for (const bucket of ENTITY_BUCKETS) {
            const refs = node?.data?.[bucket] || []
            const hit = refs.find((r) => r.entity_id === e.id)
            if (hit) {
              const chain = getEntityNarrativeChain(e.id, nodes, edges)
              const idx = chain.findIndex((n) => n.id === nodeId)
              return () => setDetailPanel('entityChip', nodeId, e.id, idx, subTabName)
            }
          }
          // Otherwise drill into the entity origin.
          const originNodeId = (nodes.find((n) =>
            n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id === e.id
          ))?.id
          if (!originNodeId) return null
          return () => setDetailPanel('entityNode', originNodeId, e.id, 0, subTabName)
        }
        if (host.kind === 'entity') {
          const e = host.entity
          colour = e.colour || '#888888'
          label = e.name || '(unnamed)'
          avatar = <EntityAvatar entity={e} profileRef={e.profile_image_ref || null} colour={colour} />
          onCardClick = entityNavTarget(e, 'awareness') || (() => {})
          key = `aw-ent-${e.id}`
        } else if (host.kind === 'entity_name') {
          const e = host.entity
          colour = e.colour || '#888888'
          label = `${e.name || '(unnamed)'} · Name`
          avatar = <EntityAvatar entity={e} profileRef={e.profile_image_ref || null} colour={colour} />
          onCardClick = entityNavTarget(e, 'awareness') || (() => {})
          key = `aw-name-${e.id}`
        } else if (host.kind === 'attribute') {
          const e = host.entity
          colour = e.colour || '#888888'
          label = `${e.name || '(unnamed)'} · ${host.attribute?.name || 'Attribute'}`
          avatar = <EntityAvatar entity={e} profileRef={e.profile_image_ref || null} colour={colour} />
          onCardClick = entityNavTarget(e, 'attributes') || (() => {})
          key = `aw-attr-${e.id}-${host.attribute?.id || hostIdx}`
        } else if (host.kind === 'alias') {
          const e = host.entity
          colour = e.colour || '#888888'
          label = `${e.name || '(unnamed)'} · "${host.aliasValue}"`
          avatar = <EntityAvatar entity={e} profileRef={e.profile_image_ref || null} colour={colour} />
          onCardClick = entityNavTarget(e, 'awareness') || (() => {})
          key = `aw-alias-${e.id}-${host.aliasValue}`
        } else if (host.kind === 'relationship') {
          const r = host.relationship
          colour = '#a78bfa'
          label = r.name || '(unnamed relationship)'
          avatar = <RelationshipIcon size={12} />
          onCardClick = () => openRelationshipDetail(r.id, nodeId)
          key = `aw-rel-${r.id}`
        } else if (host.kind === 'knowledge') {
          const k = host.knowledge
          colour = k.colour || KNOWLEDGE_COLOUR
          label = k.name || '(unnamed)'
          const assetName = k.profile_image_ref ? k.profile_image_ref.replace(/^assets\//, '') : null
          avatar = (
            <span
              className="inline-flex items-center justify-center flex-shrink-0 rounded-sm overflow-hidden"
              style={{ width: 14, height: 14, border: `1.5px solid ${colour}`, backgroundColor: assetName ? 'transparent' : colour + '22' }}
            >
              {assetName
                ? <img src={`/api/project/assets/${assetName}`} alt="" className="w-full h-full object-cover" />
                : <span style={{ fontSize: 9, lineHeight: 1 }}>📜</span>}
            </span>
          )
          onCardClick = () => openKnowledgeDetail(k.id, nodeId)
          key = `aw-k-${k.id}`
        } else {
          return null
        }

        return (
          <SourceCard
            key={key}
            avatar={avatar}
            label={label}
            colour={colour}
            borderColour={colour + '55'}
            onClick={onCardClick}
          >
            {entries.map((entry, i) => {
              // Render each awareness history entry as a compact text row.
              // The entry shape varies (source_action / tracking_action /
              // direct observer_id), so the chip is a small descriptive
              // line keyed on the action kind.
              let line
              if (entry.tracking_action === 'on') {
                line = <>Tracking <span className="text-green-400">on</span></>
              } else if (entry.tracking_action === 'off') {
                line = <>Tracking <span className="text-red-400">off</span></>
              } else if (entry.source_action) {
                const src = entry.source || {}
                const srcLabel = src.kind === 'relationship'
                  ? ((allRelationships || []).find((r) => r.id === src.relationship_id)?.name || 'Relationship')
                  : src.kind === 'attribute'
                    ? (() => {
                        const ent = allEntities.find((e) => e.id === src.entity_id)
                        const attr = (ent?.attributes || []).find((a) => a.id === src.attribute_id)
                        return `${ent?.name || '?'} · ${attr?.name || 'Attribute'}`
                      })()
                    : 'Source'
                const lvl = entry.source_action === 'remove' ? null : (src.level ?? null)
                line = (
                  <>
                    <span className="text-zinc-400">{entry.source_action === 'remove' ? 'Remove source' : (entry.source_action === 'set_level' ? 'Set level' : 'Add source')}</span>
                    <span className="text-zinc-600">·</span>
                    <span className="text-zinc-200">{srcLabel}</span>
                    {lvl != null && <AwarenessBadge level={lvl} size={14} title={`Level ${lvl}`} />}
                  </>
                )
              } else if (entry.observer_id) {
                const obs = allEntities.find((e) => e.id === entry.observer_id)
                const obsName = obs?.name || '(unknown observer)'
                line = (
                  <>
                    <span className="text-zinc-200">{obsName}</span>
                    {entry.level != null && <AwarenessBadge level={entry.level} size={14} title={`Level ${entry.level}`} />}
                  </>
                )
              } else {
                line = <span className="text-zinc-500 italic">Awareness change</span>
              }
              return (
                <div
                  key={entry.id || `aw-${i}`}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-zinc-300 hover:bg-zinc-800/60 cursor-pointer"
                  onClick={onCardClick}
                  style={{ borderLeft: `2px solid ${colour}` }}
                >
                  {line}
                </div>
              )
            })}
          </SourceCard>
        )
      })}
    </div>
  )
}
