import { useMemo, useCallback } from 'react'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProjectStore } from '../../store/projectStore'
import { computeRelationshipEffectiveState } from '../../utils/narrativeChain'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import { RelationshipLabelStack, RelationshipArrow } from '../ui/IdentityBadges'
import ImageHoverPreview from '../ui/ImageHoverPreview'

const REL_COLOUR = '#a78bfa'

function ParticipantAvatar({ entity, size = 20 }) {
  if (!entity) return null
  const colour    = entity.colour || '#888888'
  const assetName = entity.profile_image_ref ? entity.profile_image_ref.replace(/^assets\//, '') : null
  const src       = assetName ? `/api/project/assets/${assetName}` : null

  const inner = src ? (
    <img
      src={src} alt=""
      className="rounded object-cover flex-shrink-0"
      style={{ width: size, height: size, border: `1.5px solid ${colour}` }}
      title={entity.name}
    />
  ) : (
    <span
      className="rounded flex items-center justify-center flex-shrink-0"
      style={{ width: size, height: size, backgroundColor: colour + '22', border: `1.5px solid ${colour}`, fontSize: Math.floor(size * 0.45), lineHeight: 1 }}
      title={entity.name}
    >
      {TYPE_ICONS[entity.type] || '★'}
    </span>
  )

  if (src) return <ImageHoverPreview src={src} borderColour={colour} size={80}>{inner}</ImageHoverPreview>
  return inner
}

/**
 * Reusable relationship identity header.
 * Displays participant avatars, a resolved label, and status badges.
 *
 * @param {Object}   relationship  - full relationship object
 * @param {string}   [atNodeId]   - chain position (optional; omit for current/global state)
 * @param {string[]} [nodeOrder]  - sorted node ID array for effective-state computation
 * @param {boolean}  [compact]    - 16 px avatars and smaller text (default: false = 24 px)
 * @param {Function} [onClick]    - optional click handler (renders as button when provided)
 * @param {Function} [getEntity]  - optional entity resolver; uses store when omitted
 */
export default function RelationshipSummaryHeader({
  relationship,
  atNodeId,
  nodeOrder,
  compact = false,
  stacked = false,
  onClick,
  getEntity: getEntityProp,
  // Phase 2.8 — when true, the component drops its own
  // colour-tinted left border. Used by the Library's
  // relationships section, which carries the border on its own
  // wrapper so a sibling reorder grip can sit INSIDE the colour
  // bar (matching the entity-row layout: border → padding → grip
  // → content).
  noBorder = false,
}) {
  const allCharacters = useEntitiesStore((s) => s.characters)
  const allLocations  = useEntitiesStore((s) => s.locations)
  const allItems      = useEntitiesStore((s) => s.items)
  const allFactions   = useEntitiesStore((s) => s.factions)
  const allCustoms    = useEntitiesStore((s) => s.customs)
  const allKnowledges = useProjectStore((s) => s.knowledges || [])

  const getEntityFromStore = useCallback((id) => {
    for (const bucket of [allCharacters, allLocations, allItems, allFactions, allCustoms, allKnowledges]) {
      const found = bucket.find((e) => e.id === id)
      if (found) return found
    }
    return null
  }, [allCharacters, allLocations, allItems, allFactions, allCustoms, allKnowledges])

  const getEntity = getEntityProp ?? getEntityFromStore

  const effectiveState = useMemo(
    () => (atNodeId && nodeOrder?.length)
      ? computeRelationshipEffectiveState(relationship, nodeOrder, atNodeId)
      : null,
    [relationship, atNodeId, nodeOrder]
  )

  // History-only: if no effective state is computed (no atNodeId/nodeOrder)
  // derive all potential participants from `join` events in history.
  const participants = effectiveState?.participants || Array.from(new Set(
    (relationship.history?.participant_changes || [])
      .filter((c) => c.action === 'join')
      .map((c) => c.entity_id)
  )).map((eid) => ({ entity_id: eid }))
  const isActive     = effectiveState ? effectiveState.is_active : true
  const hasHierarchy = !!(relationship.hierarchy?.enabled || relationship.hierarchy?.root_entity_id)
  const isMembership = !!relationship.membership_of

  // Resolved primary name — `rel.name` wins; falls back to membership synthesis
  // when this is a members/hierarchy pseudo-relationship; null when no explicit
  // name is set so `RelationshipLabelStack` will render only the participant
  // synthesis line.
  const resolvedName = useMemo(() => {
    if (relationship.name) return relationship.name
    if (relationship.membership_of) {
      const parent = getEntity(relationship.membership_of)
      return hasHierarchy
        ? `${parent?.name || 'Unknown'} hierarchy`
        : `${parent?.name || 'Unknown'} members`
    }
    return null
  }, [relationship, getEntity, hasHierarchy])

  const emptyLabel = participants.length === 0 && !resolvedName ? 'Relationship' : null

  const avatarSize = compact ? 16 : 24

  const avatarRow = (
    <div className="flex items-center gap-0.5 flex-shrink-0">
      {participants.slice(0, 5).map((p) => (
        <ParticipantAvatar key={p.entity_id} entity={getEntity(p.entity_id)} size={avatarSize} />
      ))}
      {participants.length > 5 && (
        <span className="text-[9px] text-zinc-500 ml-0.5">+{participants.length - 5}</span>
      )}
      {participants.length === 0 && (
        <span
          className="rounded flex items-center justify-center flex-shrink-0 text-[10px] text-zinc-600"
          style={{ width: avatarSize, height: avatarSize, border: `1.5px solid ${REL_COLOUR}44`, backgroundColor: REL_COLOUR + '11' }}
        >
          <RelationshipArrow size="55%" strokeWidth={1.6} />
        </span>
      )}
    </div>
  )

  const badges = (
    <div className="flex items-center gap-0.5 flex-shrink-0">
      {!isActive && (
        <span className="text-[9px] text-red-400/70 bg-red-900/20 px-1 py-px rounded">ended</span>
      )}
      {hasHierarchy && (
        <span className="text-[9px] text-amber-400/70 bg-amber-900/20 px-1 py-px rounded">hierarchy</span>
      )}
      {isMembership && !hasHierarchy && (
        <span className="text-[9px] text-violet-400/70 bg-violet-900/20 px-1 py-px rounded">members</span>
      )}
    </div>
  )

  const labelNode = emptyLabel
    ? emptyLabel
    : (
      <RelationshipLabelStack
        name={resolvedName}
        participants={participants}
        getEntity={getEntity}
        sliceMax={3}
        rel={relationship}
      />
    )

  const content = stacked ? (
    <div className="flex flex-col gap-0.5 flex-1 min-w-0">
      <div className="flex items-center gap-1 min-w-0">
        <span className={`flex-1 min-w-0 ${compact ? 'text-[11px]' : 'text-xs'} text-zinc-200 font-medium`}>
          {labelNode}
        </span>
        {badges}
      </div>
      {avatarRow}
    </div>
  ) : (
    <>
      {avatarRow}
      {/* Resolved label */}
      <span className={`flex-1 min-w-0 ${compact ? 'text-[11px]' : 'text-xs'} text-zinc-200 font-medium`}>
        {labelNode}
      </span>
      {badges}
    </>
  )

  const baseClass = `flex items-center gap-2 ${compact ? 'px-1.5 py-1' : 'px-2 py-2'}`
  const borderStyle = noBorder ? {} : { borderLeft: `2px solid ${REL_COLOUR}66` }

  if (onClick) {
    return (
      <button
        data-help-region="badge:relationship_summary"
        type="button"
        className={`${baseClass} w-full text-left rounded transition-colors hover:bg-zinc-700/30`}
        style={borderStyle}
        onClick={onClick}
      >
        {content}
      </button>
    )
  }

  return (
    <div data-help-region="badge:relationship_summary" className={baseClass} style={borderStyle}>
      {content}
    </div>
  )
}
