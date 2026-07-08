/**
 * Phase 1.20 drag-preview tooltip.
 *
 * While a wire is being dragged AND has snapped to a valid candidate
 * target (React Flow's `connectionRadius` snap + `isValidConnection`
 * pass), render a small dark card anchored to the target port describing
 * the action that will fire on release. Invalid / rejected targets never
 * reach this component because `isValidConnection` refuses the snap, so
 * the tooltip only ever shows accept wording.
 *
 * Rendered once per canvas, inside the Canvas component (under
 * ReactFlowProvider). Subscribes to `useConnection()` for the live snap
 * state, and reads `uiStore.activeDrag` for the source-side metadata
 * (payload type, source entity / scene) that the message builder needs.
 *
 * The tooltip is portal-rendered into the target node's outer
 * `.react-flow__node` wrapper so it escapes the inner `overflow: hidden`
 * clipping the same way the reject X overlay does.
 *
 * Message composition reuses the shared badge components from
 * `IdentityBadges.jsx` -- `NodeBadge` for scenes, `EntityAvatarName` for
 * entities, `RelationshipLabelChip` for relationships -- so the wording
 * reads consistently with every confirm-dialog message across the app.
 */

import { useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useConnection } from '@xyflow/react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { resolvePort, PAYLOAD } from '../../utils/portCatalogue'
import { measureHandlePosition, findHandleEl } from '../../utils/portMeasurement'
import { ENTITY_BUCKETS } from '../../utils/entityHelpers'
import {
  NodeBadge,
  EntityAvatarName,
  RelationshipLabelChip,
  KnowledgeLabelChip,
  ParticipantsFallbackLabel,
  PovStartGlyph,
} from '../ui/IdentityBadges'

function resolveSourceEntityId(activeDrag, projectState) {
  const { sourceNodeType, sourceHandleId, sourceNodeId } = activeDrag
  if (sourceNodeType === 'sceneNode' && sourceHandleId) {
    if (sourceHandleId === 'broadcast' || sourceHandleId === 'pov-out' || sourceHandleId === 'pov-in') return null
    if (sourceHandleId.startsWith('chip-in-') || sourceHandleId.startsWith('rel-in-')) return null
    return sourceHandleId
  }
  if (sourceNodeType === 'entityNode') {
    const srcNode = projectState.nodes.find((n) => n.id === sourceNodeId)
    return srcNode?.data?.entity_id ?? null
  }
  return null
}

function RelChipLabel({ rel, getEntity, resolveName }) {
  if (!rel) return <RelationshipLabelChip name="this relationship" />
  if (rel.name && rel.name.trim()) {
    return <RelationshipLabelChip name={rel.name.trim()} />
  }
  const joinIds = Array.from(new Set(
    ((rel.history?.participant_changes) || [])
      .filter((c) => c.action === 'join')
      .map((c) => c.entity_id)
  ))
  return (
    <RelationshipLabelChip name="Relationship">
      <ParticipantsFallbackLabel
        participants={joinIds.map((id) => ({ entity_id: id }))}
        getEntity={getEntity}
        sliceMax={3}
        rel={rel}
        resolveName={resolveName || null}
      />
    </RelationshipLabelChip>
  )
}

/**
 * Compose the JSX message shown in the tooltip. Mirrors the branching in
 * `portCatalogue.describeAction` so the visual wording tracks the
 * plain-string wording used in tests / AI tool descriptions.
 * Returns null for silent-drop combinations (no tooltip should appear).
 */
function buildDragMessage({
  source, target,
  sourceEntity, targetEntity, targetRel, sourceKnowledge,
  sourceNodeId, targetNodeId,
  nodes, entityMap, getEntity,
  flags,
}) {
  const src = resolvePort({ nodeType: source.nodeType, handleId: source.handleId, direction: 'source' })
  const tgt = resolvePort({ nodeType: target.nodeType, handleId: target.handleId, direction: 'target' })
  if (!src || !tgt) return null

  const sceneBadge = () => <NodeBadge nodeId={targetNodeId} nodes={nodes} entityMap={entityMap} />
  const sourceSceneBadge = () => <NodeBadge nodeId={sourceNodeId} nodes={nodes} entityMap={entityMap} />
  const entityBadge = (ent) => ent ? <EntityAvatarName entity={ent} /> : <span className="text-zinc-400 italic">this entity</span>
  const knowledgeBadge = () => sourceKnowledge
    ? <KnowledgeLabelChip name={sourceKnowledge.name || '(unnamed)'} />
    : <span className="text-zinc-400 italic">this Knowledge</span>

  // Knowledge awareness-grant source -- chip-out or origin-node-out.
  // Action-only drops resolve to either an awareness write at the
  // target's chain position OR a manual anchor at a scene.
  if (src.payload === PAYLOAD.KNOWLEDGE_AWARENESS_GRANT) {
    if (tgt.kind === 'entity-in') {
      if (flags.isTargetModifier) {
        return <>Grant {entityBadge(targetEntity)} awareness of {knowledgeBadge()} at this modifier</>
      }
      return <>Grant {entityBadge(targetEntity)} awareness of {knowledgeBadge()} (at origin)</>
    }
    if (tgt.kind === 'chip-in') {
      return <>Grant {entityBadge(targetEntity)} awareness of {knowledgeBadge()} at {sceneBadge()}</>
    }
    if (tgt.kind === 'flow-in') {
      if (flags.knowledgeAlreadyChippedAtTarget) return null  // silent no-op; no tooltip
      return <>Manual-anchor {knowledgeBadge()} at {sceneBadge()}</>
    }
    return null  // silent reject for other target shapes
  }

  // POV source -> any scene target except rel-in: branch A (POV attach or reassignment)
  if (src.payload === PAYLOAD.POV) {
    if (target.nodeType === 'sceneNode' && tgt.kind !== 'rel-in-scene') {
      return <>Attach <PovStartGlyph /> chain to {sceneBadge()}</>
    }
    return null
  }

  // Broadcast source
  if (src.kind === 'broadcast') {
    if (flags.isFlashbackTarget) {
      return <>Mark {sceneBadge()} as flashback of {sourceSceneBadge()}</>
    }
    return <>Broadcast all entities from {sourceSceneBadge()} to {sceneBadge()}</>
  }

  // Narrative-flow source (chip-out / entity-out)
  if (tgt.kind === 'rel-origin-in') {
    if (src.kind === 'entity-out' && flags.isEntityOrigin) {
      return <>Add {entityBadge(sourceEntity)} as participant (at relationship origin)</>
    }
    return null
  }

  if (tgt.kind === 'rel-in-entity') {
    return <>Add {entityBadge(sourceEntity)} as faction member</>
  }

  if (tgt.kind === 'rel-in-scene') {
    return <>Add {entityBadge(sourceEntity)} as participant in <RelChipLabel rel={targetRel} getEntity={getEntity} /></>
  }

  if (tgt.kind === 'entity-in') {
    if (flags.isTargetModifier) {
      if (flags.isTargetModifierBlank) {
        return <>Turns this node into a <NodeBadge nodeId={targetNodeId} nodes={nodes} entityMap={entityMap} /> for {entityBadge(sourceEntity)}</>
      }
      return <>Wire {entityBadge(sourceEntity)} through this modifier</>
    }
    if (src.kind === 'entity-out') {
      return <>Create relationship between {entityBadge(sourceEntity)} and {entityBadge(targetEntity)}</>
    }
    return null
  }

  if (tgt.kind === 'chip-in') {
    if (flags.isSameEntity) {
      return <>Wire {entityBadge(sourceEntity)} into {sceneBadge()}</>
    }
    if (flags.isSourceEntityInTargetScene) {
      return <>Create relationship between {entityBadge(sourceEntity)} and {entityBadge(targetEntity)} at {sceneBadge()}</>
    }
    return <>Create relationship + add {entityBadge(sourceEntity)} to {sceneBadge()}</>
  }

  if (tgt.kind === 'pov-in') {
    if (flags.isSourceEntityInTargetScene) {
      if (flags.isCharacter) return <>Attach <PovStartGlyph /> to {entityBadge(sourceEntity)}</>
      return null
    }
    if (flags.isCharacter) {
      return <>Add {entityBadge(sourceEntity)} to {sceneBadge()} and attach <PovStartGlyph /></>
    }
    return <>Add {entityBadge(sourceEntity)} to {sceneBadge()}</>
  }

  if (tgt.kind === 'flow-in') {
    return <>Wire {entityBadge(sourceEntity)} into {sceneBadge()}</>
  }

  return null
}

export default function DragTooltip() {
  const connection = useConnection()
  const activeDrag = useUiStore((s) => s.activeDrag)

  const toNodeId = connection?.inProgress ? connection.toNode?.id ?? null : null
  const toHandleId = connection?.inProgress ? (connection.toHandle?.id ?? null) : null
  const isActive = connection?.inProgress && connection.isValid !== false && !!toNodeId

  const [measurement, setMeasurement] = useState(null)
  useLayoutEffect(() => {
    if (!isActive) {
      if (measurement !== null) setMeasurement(null)
      return
    }
    const handleEl = findHandleEl(toNodeId, toHandleId)
    const m = handleEl ? measureHandlePosition(handleEl) : null
    setMeasurement(m)
  }, [isActive, toNodeId, toHandleId])  // eslint-disable-line react-hooks/exhaustive-deps

  // entityMap subscription — lifted out of the per-drag-target useMemo
  // below (Perf #5). The message builder needs a `Map<entityId, entity>`
  // for `NodeBadge` resolution, but the map contents only change when an
  // entity is added / edited / deleted. The previous pattern rebuilt
  // the whole spread + Map on every drag target change (every node /
  // handle hover during a wire drag). Now: rebuild only when an entity
  // bucket changes.
  const _characters = useEntitiesStore((s) => s.characters)
  const _locations = useEntitiesStore((s) => s.locations)
  const _items = useEntitiesStore((s) => s.items)
  const _factions = useEntitiesStore((s) => s.factions)
  const _customs = useEntitiesStore((s) => s.customs)
  const entityMap = useMemo(() => new Map(
    [
      ...(_characters || []),
      ...(_locations || []),
      ...(_items || []),
      ...(_factions || []),
      ...(_customs || []),
    ].map((e) => [e.id, e])
  ), [_characters, _locations, _items, _factions, _customs])

  // Build the JSX message once per (active, target) pair.
  const message = useMemo(() => {
    if (!isActive || !activeDrag || !connection?.toNode) return null
    const projectState = useProjectStore.getState()
    const entitiesState = useEntitiesStore.getState()
    const getEntity = entitiesState.getEntityById

    const sourceEntityId = resolveSourceEntityId(activeDrag, projectState)
    const sourceEntity = sourceEntityId ? getEntity(sourceEntityId) || null : null
    const sourceNode = projectState.nodes.find((n) => n.id === activeDrag.sourceNodeId) || null

    const toNode = connection.toNode

    let targetEntity = null
    let targetRel = null
    const isChipIn = toHandleId && toHandleId.startsWith('chip-in-')
    const isRelInScene = toHandleId && toHandleId.startsWith('rel-in-') && toNode.type === 'sceneNode'
    const isRelInEntity = toHandleId && toHandleId.startsWith('rel-in-') && toNode.type === 'entityNode'
    if (isChipIn) {
      targetEntity = getEntity(toHandleId.slice(8)) || null
    }
    if (toNode.type === 'entityNode') {
      // For entity-shaped targets (origin or modifier), the target entity is
      // resolved from the node's `entity_id` rather than the handle id.
      targetEntity = getEntity(toNode.data?.entity_id) || targetEntity
    }
    if (isRelInScene || isRelInEntity) {
      const relId = toHandleId.slice(7)
      targetRel = projectState.relationships.find((r) => r.id === relId) || null
    }

    // Phase 1.21c — resolve source Knowledge for the awareness-grant
    // tooltip variant (chip-out or origin-node-out drag).
    let sourceKnowledge = null
    if (sourceNode?.type === 'knowledgeOriginNode') {
      const kid = sourceNode.data?.knowledge_id
      if (kid) sourceKnowledge = (projectState.knowledges || []).find((k) => k.id === kid) || null
    } else if (
      activeDrag.sourceNodeType === 'sceneNode'
      && typeof activeDrag.sourceHandleId === 'string'
      && activeDrag.sourceHandleId.startsWith('knowledge-chip-out-')
    ) {
      const kid = activeDrag.sourceHandleId.slice('knowledge-chip-out-'.length)
      if (kid) sourceKnowledge = (projectState.knowledges || []).find((k) => k.id === kid) || null
    }

    const flags = {
      isCharacter: sourceEntity?.type === 'character',
      isSameEntity: !!sourceEntityId && isChipIn && toHandleId.slice(8) === sourceEntityId,
      isFlashbackTarget: toNode.type === 'sceneNode' ? !!toNode.data?.is_flashback : false,
      isEntityOrigin: sourceNode?.type === 'entityNode' ? !sourceNode.data?.is_modifier : false,
      isTargetModifier: toNode.type === 'entityNode' ? !!toNode.data?.is_modifier : false,
      isTargetModifierBlank: toNode.type === 'entityNode' && !!toNode.data?.is_modifier && !toNode.data?.entity_id,
      isSourceEntityInTargetScene:
        !!sourceEntityId &&
        toNode.type === 'sceneNode' &&
        ENTITY_BUCKETS.some((b) => (toNode.data?.[b] || []).some((r) => r.entity_id === sourceEntityId)),
      knowledgeAlreadyChippedAtTarget: !!sourceKnowledge && toNode.type === 'sceneNode' && (() => {
        // Cheap check that mirrors getKnowledgeNodeOrder's relevant-id
        // logic without importing the full helper here. Returns true when
        // the target scene already appears in the Knowledge's chain
        // (history entry or manual anchor) -- in which case the manual-
        // anchor drop would be a silent no-op and no tooltip should show.
        const history = sourceKnowledge.history || {}
        for (const list of Object.values(history)) {
          if (Array.isArray(list) && list.some((c) => c?.node_id === toNode.id)) return true
        }
        return (sourceKnowledge.manual_anchors || []).some((a) => a?.node_id === toNode.id)
      })(),
    }

    return buildDragMessage({
      source: { nodeType: activeDrag.sourceNodeType, handleId: activeDrag.sourceHandleId },
      target: { nodeType: toNode.type, handleId: toHandleId },
      sourceEntity,
      targetEntity,
      targetRel,
      sourceKnowledge,
      sourceNodeId: activeDrag.sourceNodeId,
      targetNodeId: toNode.id,
      nodes: projectState.nodes,
      entityMap,
      getEntity,
      flags,
    })
  }, [isActive, activeDrag, connection?.toNode, toHandleId, entityMap])

  if (!isActive || !activeDrag || !measurement || !message) return null

  return createPortal(
    <div
      className="flex items-center gap-1 flex-wrap"
      style={{
        position: 'absolute',
        left: measurement.centerX + 14,
        top: measurement.centerY,
        transform: 'translateY(-50%)',
        background: '#18181b',
        color: '#e4e4e7',
        fontSize: 11,
        lineHeight: 1.3,
        padding: '5px 9px',
        borderRadius: 4,
        border: '1px solid #52525b',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        zIndex: 1000,
        boxShadow: '0 2px 10px rgba(0, 0, 0, 0.5)',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        maxWidth: 380,
      }}
    >
      {message}
    </div>,
    measurement.portalTarget,
  )
}
