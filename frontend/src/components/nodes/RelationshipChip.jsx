import { useState, useMemo, useCallback } from 'react'
import { Position } from '@xyflow/react'
import PortHandle from '../canvas/PortHandle'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProjectStore } from '../../store/projectStore'
import { useUiStore } from '../../store/uiStore'
import { confirm } from '../../store/dialogStore'
import { computeRelationshipEffectiveState, getRelationshipChangesAtNode, getRelationshipNodeOrder, computeEffectiveState, getRelationshipSourceContributionsAtNode, getRelationshipCreationNodeId } from '../../utils/narrativeChain'
import AwarenessSubChip from '../ui/change-subchips/AwarenessSubChip'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import { useEntityByIdMap } from '../../hooks/useEntityByIdMap'
import { useKnowledgeNodeMaps } from '../../hooks/useKnowledgeNodeMaps'
import ImageHoverPreview from '../ui/ImageHoverPreview'
import { TYPE_ICONS, participantsFallbackLabel } from '../../utils/entityHelpers'
import { RelationshipLabelStack, RelationshipIcon } from '../ui/IdentityBadges'
import { buildDeleteRelationshipMessage, buildEndRelationshipMessage } from '../ui/popupMessages'
import { useAccentColor } from '../../utils/povConstants'
import AttachToChatButton from '../chat/AttachToChatButton'

const REL_COLOUR = '#a78bfa'
// Phase 4.1g #3 — stable handle-style identity (REL_COLOUR is constant).
const REL_CHIP_HANDLE_STYLE = Object.freeze({
  width: 10, height: 10, background: REL_COLOUR, border: '2px solid #18181b',
  left: -11, top: 8, transform: 'none',
})

// ── Participant avatar (small, with colour border + hover enlargement) ──────────

function ParticipantAvatar({ entityId, getEntity }) {
  const ent     = getEntity(entityId)
  const colour  = ent?.colour  || '#888888'
  const name    = ent?.name    || '?'
  const imgRef  = ent?.profile_image_ref || null
  const asset   = imgRef ? imgRef.replace(/^assets\//, '') : null

  const inner = asset ? (
    <img
      src={`/api/project/assets/${asset}`}
      alt=""
      className="rounded-sm object-cover flex-shrink-0"
      style={{ width: 14, height: 14, border: `1.5px solid ${colour}` }}
      title={name}
    />
  ) : (
    <span
      className="rounded-sm flex items-center justify-center flex-shrink-0 text-[8px]"
      style={{ width: 14, height: 14, backgroundColor: colour + '22', border: `1.5px solid ${colour}` }}
      title={name}
    >
      {TYPE_ICONS[ent?.type] || '★'}
    </span>
  )

  if (asset) {
    return (
      <ImageHoverPreview
        src={`/api/project/assets/${asset}`}
        borderColour={colour}
        size={80}
        previewSource={imgRef ? {
          type: 'entity_profile',
          entityId,
          ...(imgRef.startsWith('data:') ? { url: imgRef } : { fileRef: imgRef }),
          entityName: name,
          entityColour: colour,
        } : undefined}
      >
        {inner}
      </ImageHoverPreview>
    )
  }
  return inner
}

// `RelChangeChip` was relocated in v0.1.21.99 to
// `frontend/src/components/ui/change-subchips/RelChangeChip.jsx`.
// Every sub-chip component now lives in `change-subchips/`. We import
// it here for use within RelationshipChip's own JSX AND re-export it
// so existing import paths (`import { RelChangeChip } from '.../
// RelationshipChip'`) keep working without breakage.
import RelChangeChip from '../ui/change-subchips/RelChangeChip'
export { RelChangeChip }

// ── RelationshipChip ─────────────────────────────────────────────────────────

export default function RelationshipChip({ nodeId, relationship, parentNodeType = 'sceneNode' }) {
  const [hovered, setHovered] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const accentColor = useAccentColor()
  const deleteObject                    = useProjectStore((s) => s.deleteObject)
  const recordRelationshipChange        = useProjectStore((s) => s.recordRelationshipChange)
  const removeRelationshipChange        = useProjectStore((s) => s.removeRelationshipChange)
  const addEntityAsParticipantAtScene   = useProjectStore((s) => s.addEntityAsParticipantAtScene)
  const openRelationshipDetail   = useUiStore((s) => s.openRelationshipDetail)
  const activeSelection          = useUiStore((s) => s.activeSelection)
  const isSelected = activeSelection?.kind === 'relationship' && activeSelection?.id === relationship.id && activeSelection?.atNodeId === nodeId
  const allCharacters = useEntitiesStore((s) => s.characters)
  const allLocations  = useEntitiesStore((s) => s.locations)
  const allItems      = useEntitiesStore((s) => s.items)
  const allFactions   = useEntitiesStore((s) => s.factions)
  const allCustoms    = useEntitiesStore((s) => s.customs)
  const allKnowledges = useProjectStore((s) => s.knowledges || [])

  const storeNodes = useProjectStore((s) => s.nodes)
  const storeEdges = useProjectStore((s) => s.edges)
  const allRelationships = useProjectStore((s) => s.relationships)

  // Graph-walk narrative order for this relationship's chain. Canvas
  // x-position is NEVER used for chain ordering (see v0.1.18.121+ audit):
  // moving a node on canvas must not silently change narrative state.
  // Filtered over the global story order so manual-anchor scenes land at
  // their deterministic global position (Phase 1.19).
  const storyOrder = useStoryOrder()
  const nodeOrder = useMemo(
    () => getRelationshipNodeOrder(relationship, storeNodes, storeEdges, storyOrder),
    [relationship, storeNodes, storeEdges, storyOrder]
  )

  // Perf #6: shared `entityMap` + `knowledgesById` replace the 6-bucket
  // `.find()` walk. The chain walker (`computeEffectiveState`) still
  // runs identically — the Map lookup ONLY replaces the baseline
  // resolution step. Result remains chain-aware at this chip's scene.
  const entityMap = useEntityByIdMap()
  const { knowledgesById } = useKnowledgeNodeMaps()
  const getEntity = useCallback((id) => {
    const found = entityMap.get(id) || knowledgesById.get(id) || null
    if (!found) return null
    // Phase 1.21h — return the entity in its chain-resolved state
    // at THIS chip's scene so sub-chips that render entity badges
    // (RelChangeChip's participant badge, etc.) pick up chain-time
    // changes to name / colour / profile_image_ref. Falls back to
    // the base entity when the walker can't resolve.
    const eff = computeEffectiveState(found, storeNodes, storeEdges, nodeId)
    if (!eff) return found
    return {
      ...found,
      name: eff.name || found.name,
      colour: eff.colour || found.colour,
      profile_image_ref: eff.profile_image_ref ?? found.profile_image_ref ?? null,
      attributes: eff.attributes || found.attributes,
      aliases: eff.aliases || found.aliases,
    }
  }, [entityMap, knowledgesById, storeNodes, storeEdges, nodeId])

  const effectiveState = useMemo(
    () => computeRelationshipEffectiveState(relationship, nodeOrder, nodeId),
    [relationship, nodeOrder, nodeId]
  )

  // Phase 1.21h Fix #2 — at the relationship's creation node, baseline
  // `participant_roles` entries don't have history events to drive
  // sub-chip emission (the role's value IS the baseline at creation,
  // not a chain entry). Synthesize role sub-chips from baseline at the
  // creation node so role assignment at creation is visible.
  const isCreationNodeForChip = useMemo(
    () => getRelationshipCreationNodeId(relationship, storeNodes, nodeId) === nodeId,
    [relationship, nodeId, storeNodes],
  )

  const changes = useMemo(() => {
    const base = getRelationshipChangesAtNode(relationship, nodeId, undefined, nodeOrder)
    if (!isCreationNodeForChip) return base
    // Synthesize role baseline emissions: any participant with a
    // `participant_roles[entityId]` entry at creation gets a synthetic
    // 'modify' change with old_value=null. The relationship name baseline
    // similarly isn't covered by `name_changes`; emit it too if present.
    const synthetic = []
    const roles = relationship.participant_roles || {}
    const existingRoleEntityIds = new Set(
      base.filter((c) => c.type === 'role').map((c) => c.entity_id),
    )
    for (const [entId, role] of Object.entries(roles)) {
      if (existingRoleEntityIds.has(entId)) continue
      if (role?.value) {
        synthetic.push({
          type: 'role',
          action: 'modify',
          entity_id: entId,
          new_value: role.value,
          old_value: null,
          isBaselineSynthetic: true,
        })
      }
    }
    return [...base, ...synthetic]
  }, [relationship, nodeId, nodeOrder, isCreationNodeForChip])

  // Phase 1.21g — sub-chip records for scenes where this relationship is
  // newly registered as a projected awareness source. Mirrors how observer
  // chips render `AwarenessSubChip` records: the relationship is the
  // contributor and the carrier entity is the target. Same component
  // renders without any branching.
  const allEntities = useMemo(
    () => [...allCharacters, ...allLocations, ...allItems, ...allFactions, ...allCustoms],
    [allCharacters, allLocations, allItems, allFactions, allCustoms]
  )
  const sourceContributions = useMemo(
    () => getRelationshipSourceContributionsAtNode({
      relationshipId: relationship.id,
      nodeId,
      allNodes: storeNodes,
      allEdges: storeEdges,
      allEntities,
      allRelationships,
      allKnowledges,
    }),
    [relationship.id, nodeId, storeNodes, storeEdges, allEntities, allRelationships, allKnowledges]
  )

  // Does this chip mark the ORIGIN POINT of a scene-born relationship?
  // True when:
  //   - this chip lives on a scene (sceneNode, not a faction),
  //   - the relationship has no dedicated relationshipOriginNode, AND
  //   - this scene IS the earliest of the rel's own HISTORY-event nodes
  //     in story order. We can't just use `nodeOrder[0]` -- that array
  //     also carries each participant's entity narrative chain for
  //     ambient-chip evaluation, which pulls in entity-origin nodes that
  //     sort earlier than any scene. Filtering to only history-event
  //     nodes (joins, leaves, existence activates, etc.) gives the true
  //     creation scene even when later participants join at later scenes.
  const isSceneBornOriginChip = useMemo(() => {
    if (parentNodeType !== 'sceneNode') return false
    const hasRelOriginNode = storeNodes.some(
      (n) => n.type === 'relationshipOriginNode' && n.data?.relationship_id === relationship.id
    )
    if (hasRelOriginNode) return false
    const eventNodeIds = new Set()
    for (const list of Object.values(relationship.history || {})) {
      if (!Array.isArray(list)) continue
      for (const entry of list) {
        if (entry?.node_id) eventNodeIds.add(entry.node_id)
      }
    }
    if (eventNodeIds.size === 0) return false
    const birthId = nodeOrder.find((id) => eventNodeIds.has(id))
    return birthId === nodeId
  }, [parentNodeType, storeNodes, relationship, nodeId, nodeOrder])

  // Participant-name resolver: each participant's display name at this
  // chip's scene is the participant entity's chain-resolved effective name
  // walked up to (and including) this scene. Without this the fallback
  // label reads base-library names and misses any name_change applied
  // upstream.
  const resolveParticipantName = useCallback((entityId) => {
    const ent = getEntity(entityId)
    if (!ent) return null
    const s = computeEffectiveState(ent, storeNodes, storeEdges, nodeId)
    return s?.name || ent.name || null
  }, [getEntity, storeNodes, storeEdges, nodeId])

  // 3-tier label: chain-resolved name → base name → participant synthesis.
  // `label` is always a plain string — used for tooltips, dialog messages,
  // and any context that needs a flat text form.
  const label = useMemo(() => {
    if (effectiveState?.name) return effectiveState.name
    if (relationship.name) return relationship.name
    const parts = effectiveState?.participants || []
    if (parts.length === 0) return 'Relationship'
    return participantsFallbackLabel(parts, getEntity, 3, relationship, resolveParticipantName)
  }, [relationship, effectiveState, getEntity, resolveParticipantName])

  // Resolved name (chain-walk wins over base); null when neither is set so
  // RelationshipLabelStack falls back to the pure participant-synthesis row.
  const resolvedName = effectiveState?.name || relationship.name || null
  const participants = effectiveState?.participants || []

  async function handleDelete(e) {
    e.stopPropagation()
    // Full delete when this IS the creation point.
    // Case A: all joins point to this single nodeId (scene-created relationship
    //         with participants).
    // Case B: all joins point to entity origin nodes collectively and this is
    //         one of them (origin→origin relationship — both origin nodes
    //         should trigger full delete).
    // Case C: every join's node has been deleted (phantom references) — the
    //         real creation context is gone, treat any remaining node as
    //         creation-equivalent so the orphaned rel can be deleted outright.
    // Case D: zero-participant scene-born relationship — the rel was created
    //         via the "+ Add Relationship" button inside a scene but has no
    //         participants yet. Its birth scene is the first `activate`
    //         existence-change; if we're at that node, deleting here is
    //         equivalent to cancelling the creation, which should delete the
    //         rel entirely rather than record a redundant "end" existence
    //         change at the same scene.
    // Phase 1.21h Fix #3 — route creation-node detection through the
    // shared helper. Local escape hatches preserved: zero-participant
    // birth scenes (existence-only relationships) and phantom-join
    // cleanup cases still resolve to creation-equivalent so the user
    // can delete an orphaned rel.
    const joins = (relationship.history?.participant_changes || []).filter((c) => c.action === 'join')
    const allJoinNodeIds = new Set(joins.map((c) => c.node_id))
    const allJoinsPhantom = joins.length > 0 && [...allJoinNodeIds].every(
      (nid) => !storeNodes.some((x) => x.id === nid)
    )
    const existenceActivates = (relationship.history?.existence_changes || []).filter((c) => c.action === 'activate')
    const isZeroParticipantBirthScene = joins.length === 0
      && existenceActivates.length > 0
      && existenceActivates[0].node_id === nodeId
    const isCreationNode = isZeroParticipantBirthScene
      || allJoinsPhantom
      || getRelationshipCreationNodeId(relationship, storeNodes, nodeId) === nodeId

    if (isCreationNode) {
      const ok = await confirm({
        title: 'Delete relationship',
        message: buildDeleteRelationshipMessage({ rel: relationship, getEntity, resolveName: resolveParticipantName }),
        buttons: [
          { label: 'Delete from story', value: 'delete', style: 'danger' },
          { label: 'Cancel', value: 'cancel', style: 'default' },
        ],
      })
      if (ok === 'delete') deleteObject('relationship', relationship.id)
    } else {
      const entityMap = new Map(
        [...allCharacters, ...allLocations, ...allItems, ...allFactions, ...allCustoms, ...allKnowledges]
          .map((ent) => [ent.id, ent])
      )
      const ok = await confirm({
        title: 'End relationship here',
        message: buildEndRelationshipMessage({ rel: relationship, getEntity, endNodeId: nodeId, nodes: storeNodes, entityMap, resolveName: resolveParticipantName }),
        buttons: [
          { label: 'End here', value: 'end', style: 'danger' },
          { label: 'Cancel', value: 'cancel', style: 'default' },
        ],
      })
      if (ok === 'end') {
        recordRelationshipChange(relationship.id, {
          type: 'existence',
          data: { action: 'deactivate', node_id: nodeId },
        })
      }
    }
  }

  return (
    <div
      data-help-region="relationship-chip:chip"
      className="relative flex flex-col pl-2 pr-1 pt-0.5 pb-0.5 rounded nodrag cursor-pointer"
      style={{
        backgroundColor: '#1c1c2e',
        // Unselected border + left bar use REL_COLOUR (the relationship identity).
        // When selected, switch the outline to the user's accent colour so the
        // "this is the active selection" signal matches every other selected
        // node / chip in the app.
        borderTopWidth: 1,
        borderRightWidth: 1,
        borderBottomWidth: 1,
        borderLeftWidth: 2,
        borderStyle: 'solid',
        borderTopColor:    isSelected ? accentColor : `${REL_COLOUR}33`,
        borderRightColor:  isSelected ? accentColor : `${REL_COLOUR}33`,
        borderBottomColor: isSelected ? accentColor : `${REL_COLOUR}33`,
        borderLeftColor:   isSelected ? accentColor : `${REL_COLOUR}88`,
        boxShadow: isSelected ? `0 0 0 1px ${accentColor}66` : undefined,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => { e.stopPropagation(); openRelationshipDetail(relationship.id, nodeId) }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/nnz-entity-id')) {
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'copy'
          setIsDragOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setIsDragOver(false)
      }}
      onDrop={(e) => {
        // Entity drag onto a rel chip: add the entity to the scene (if not
        // already present) AND record `join@sceneId` on the relationship.
        // stopPropagation so SceneNode's scene-body drop handler doesn't
        // also fire and double-add the chip; our store action handles both.
        const entityId = e.dataTransfer.getData('application/nnz-entity-id')
        if (!entityId) return
        e.preventDefault()
        e.stopPropagation()
        setIsDragOver(false)
        addEntityAsParticipantAtScene(relationship.id, entityId, nodeId)
      }}
      data-dragover={isDragOver ? 'true' : undefined}
    >
      {/* Input port — accepts entity chip wires to add participants */}
      <PortHandle
        nodeId={nodeId}
        nodeType={parentNodeType}
        type="target"
        position={Position.Left}
        id={`rel-in-${relationship.id}`}
        style={REL_CHIP_HANDLE_STYLE}
      />

      {/* Phase 2.7b — chain-anchored "Add as context" button. Anchored
          to this scene so the attached payload carries the
          relationship's chain-resolved state at this scene anchor.
          Self-gates on the chat-open hook. */}
      <AttachToChatButton
        kind="relationship"
        id={relationship.id}
        anchorNodeId={nodeId}
        size={10}
        title="Add this relationship at this scene as context to the open conversation"
        stopPropagation
        className={`absolute top-0.5 right-5 transition-opacity ${hovered ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      />

      {/* Delete button — visible on hover */}
      <button
        className={`absolute top-0.5 right-0.5 w-3.5 h-3.5 flex items-center justify-center rounded text-[9px] leading-none transition-all hover:bg-red-500/25 hover:text-red-400 nodrag ${hovered ? 'opacity-100 text-zinc-500' : 'opacity-0 pointer-events-none'}`}
        onClick={(e) => { e.stopPropagation(); handleDelete(e) }}
        title="Delete relationship"
      >✕</button>

      {/* `NEW : RELATIONSHIP` origin-point badge for scene-born relationships.
          Matches the badge style used on relationshipOriginNode so scene-born
          rels read with visual parity to origin-node rels. Only shown when
          this chip IS the origin point (see `isSceneBornOriginChip` above). */}
      {isSceneBornOriginChip && (
        <span
          className="text-[9px] uppercase tracking-widest font-semibold px-1.5 py-0.5 rounded flex-shrink-0 self-start mb-0.5"
          style={{ color: REL_COLOUR, backgroundColor: REL_COLOUR + '22' }}
          title="Origin point of this relationship"
        >
          NEW : RELATIONSHIP
        </span>
      )}

      {/* Header row — icon + stacked label (name on top, participants subtitle
          below when a name is set; single participant-synthesis line otherwise). */}
      <div className="flex items-start gap-1 min-w-0 pr-4">
        <span className="mt-[1px] inline-flex">
          <RelationshipIcon size={10} />
        </span>
        <span className="text-[10px] text-zinc-200 flex-1 min-w-0" title={label}>
          <RelationshipLabelStack
            name={resolvedName}
            participants={participants}
            getEntity={getEntity}
            sliceMax={3}
            rel={relationship}
            resolveName={resolveParticipantName}
          />
        </span>
      </div>

      {/* Participant avatars */}
      {participants.length > 0 && (
        <div className="flex flex-wrap gap-0.5 mt-0.5 pl-1">
          {participants.map((p) => (
            <ParticipantAvatar key={p.entity_id} entityId={p.entity_id} getEntity={getEntity} />
          ))}
        </div>
      )}

      {/* Change sub-chips (changes recorded at this node) */}
      {changes.length > 0 && (
        <div className="flex flex-col gap-0.5 mt-0.5">
          {changes.map((ch, i) => (
            <RelChangeChip
              key={i}
              change={ch}
              getEntity={getEntity}
              onDismiss={() => removeRelationshipChange(relationship.id, ch, nodeId)}
            />
          ))}
        </div>
      )}

      {/* Phase 1.21g — awareness sub-chips for scenes where this
          relationship begins propagating an awareness (i.e. it was added
          as a projected awareness source on a carrier surface here).
          Reads "this rel now grants [target] [level]" — the relationship
          chip plays the same observer-side role here that an entity chip
          plays for its own awareness changes. */}
      {sourceContributions.length > 0 && (
        <div className="flex flex-col gap-0.5 mt-0.5">
          {sourceContributions.map((rec) => (
            <AwarenessSubChip
              key={rec.changeId || `${rec.kind}-${rec.targetEntityId}-${rec.aliasValue}`}
              record={rec}
              observerName={label}
              getEntity={getEntity}
              getRelationship={(id) => allRelationships?.find((r) => r.id === id) || null}
              getKnowledge={(id) => allKnowledges?.find((k) => k.id === id) || null}
            />
          ))}
        </div>
      )}
    </div>
  )
}
