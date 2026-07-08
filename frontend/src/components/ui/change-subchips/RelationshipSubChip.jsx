import { TYPE_ICONS } from '../../../utils/entityHelpers'
import { computeEffectiveState } from '../../../utils/narrativeChain'
import ImageHoverPreview from '../ImageHoverPreview'
import { BaseChangeChip, trunc } from '../ChangeChipBase'
import { FallbackSubChip } from './atoms'

/**
 * Chip-styled sub-chip showing a relationship change (add/remove/modify) at a scene or modifier node,
 * or an existing relationship at an entity origin node.
 *
 * Styled consistently with ChangeSubChip: action-coloured background (green/amber/red),
 * related entity profile image with relationship badge overlay, and old → new description format.
 *
 * Props:
 *   relationship   — the Relationship object {id, entity_a_id, entity_b_id, entity_a_description, entity_b_description, ...}
 *   changeType     — 'add' | 'remove' | 'modify' | null (null = existing, no action badge)
 *   ownerEntityId  — which entity owns the chip this sub-chip lives inside
 *   allEntities    — flat array of all entities (for looking up the other entity)
 *   onRemove       — optional callback: () → void  (called when × is clicked)
 *   relChipId      — optional string id attr for the intra-node wire renderer to target
 *   descChange     — for changeType 'modify': the new description value being applied (null otherwise)
 *   oldDesc        — for changeType 'modify': the previous description value (from priorState)
 *   nodes          — optional: canvas nodes array (for effective name/colour/image resolution)
 *   edges          — optional: canvas edges array (for effective name/colour/image resolution)
 *   atNodeId       — optional: current node ID (for effective name/colour/image resolution)
 *   reviewFlagged  — boolean; when true, a ⚑ flag icon is shown
 *   onClick        — optional callback; called when the sub-chip body is clicked (used for sidebar tab navigation)
 */
export default function RelationshipSubChip({ relationship, changeType, ownerEntityId, allEntities, onRemove, relChipId, descChange = null, oldDesc = null, nodes, edges, atNodeId, reviewFlagged, onClick }) {
  const otherId = relationship.entity_a_id === ownerEntityId
    ? relationship.entity_b_id
    : relationship.entity_a_id
  const otherEntity = allEntities.find((e) => e.id === otherId)

  let otherColour = otherEntity?.colour || '#888888'
  let otherName   = otherEntity?.name   || 'Unknown'
  let otherImage  = otherEntity?.profile_image_ref || null

  if (!otherEntity) {
    const ownerIsA = relationship.entity_a_id === ownerEntityId
    const fbName   = ownerIsA ? relationship.entity_b_name_fallback   : relationship.entity_a_name_fallback
    const fbColour = ownerIsA ? relationship.entity_b_colour_fallback : relationship.entity_a_colour_fallback
    if (fbName)   otherName   = fbName
    if (fbColour) otherColour = fbColour
  }
  if (otherEntity && nodes && edges && atNodeId) {
    const eff = computeEffectiveState(otherEntity, nodes, edges, atNodeId)
    if (eff) {
      otherName   = eff.name
      otherColour = eff.colour
      otherImage  = eff.profile_image_ref || null
    }
  }
  const otherIcon = TYPE_ICONS[otherEntity?.type] || '?'

  const selfDesc = relationship.entity_a_id === ownerEntityId
    ? (relationship.entity_a_description || '')
    : (relationship.entity_b_description || '')

  // Profile image of the related entity (or type icon fallback) with relationship badge
  const imgSize = 14
  const otherImgSrc = otherImage ? `/api/project/assets/${otherImage.replace(/^assets\//, '')}` : null
  const profileImg = (
    <ImageHoverPreview
      src={otherImgSrc}
      borderColour={otherColour}
      size={100}
      previewSource={otherImage && otherId ? {
        type: 'entity_profile',
        entityId: otherId,
        ...(otherImage.startsWith('data:') ? { url: otherImage } : { fileRef: otherImage }),
        entityName: otherName,
        entityColour: otherColour,
      } : undefined}
    >
      {otherImage ? (
        <span className="relative flex-shrink-0" style={{ width: imgSize, height: imgSize }}>
          <img
            src={otherImgSrc}
            alt=""
            className="rounded-sm object-cover"
            style={{ width: imgSize, height: imgSize, border: `1.5px solid ${otherColour}` }}
          />
          <span
            className="absolute flex items-center justify-center rounded-full bg-zinc-900 border border-zinc-600"
            style={{ width: 8, height: 8, bottom: -2, right: -2, fontSize: 5, lineHeight: 1 }}
            title="Relationship"
          >↔</span>
        </span>
      ) : (
        <span className="relative flex-shrink-0" style={{ width: imgSize, height: imgSize }}>
          <span
            className="flex items-center justify-center rounded-sm"
            style={{ width: imgSize, height: imgSize, fontSize: 8, backgroundColor: otherColour + '22', border: `1.5px solid ${otherColour}` }}
          >{otherIcon}</span>
          <span
            className="absolute flex items-center justify-center rounded-full bg-zinc-900 border border-zinc-600"
            style={{ width: 8, height: 8, bottom: -2, right: -2, fontSize: 5, lineHeight: 1 }}
            title="Relationship"
          >↔</span>
        </span>
      )}
    </ImageHoverPreview>
  )

  // Truncation thresholds used in the visible row — kept here so the
  // expand-body decision can compare against them without drift.
  const NAME_TRUNC = 12
  const DESC_TRUNC_MODIFY = 14
  const DESC_TRUNC_DEFAULT = 20  // matches `trunc()` default in ChangeChipBase
  const isLongName = (otherName || '').length > NAME_TRUNC
  const buildExpandedBody = (mode, oldD, newD) => {
    const oldLong = (oldD || '').length > (mode === 'modify' ? DESC_TRUNC_MODIFY : DESC_TRUNC_DEFAULT)
    const newLong = (newD || '').length > (mode === 'modify' ? DESC_TRUNC_MODIFY : DESC_TRUNC_DEFAULT)
    if (!isLongName && !oldLong && !newLong) return null
    return (
      <div className="space-y-0.5">
        {isLongName && (
          <div>
            <span className="text-zinc-500">Other:</span>{' '}
            <span style={{ color: otherColour }}>{otherName}</span>
          </div>
        )}
        {mode === 'modify' && oldD && (
          <div>
            <span className="text-zinc-500">Description (was):</span>{' '}
            <span className="text-zinc-400 line-through">{oldD}</span>
          </div>
        )}
        {mode === 'modify' && newD && (
          <div>
            <span className="text-zinc-500">Description:</span>{' '}
            <span className="text-zinc-200">{newD}</span>
          </div>
        )}
        {mode !== 'modify' && (oldD || newD) && (
          <div>
            <span className="text-zinc-500">Description:</span>{' '}
            <span className={mode === 'remove' ? 'text-zinc-400 line-through' : 'text-zinc-200'}>
              {newD || oldD}
            </span>
          </div>
        )}
      </div>
    )
  }

  // ── Modify ─────────────────────────────────────────────────────────────────
  if (changeType === 'modify') {
    const newDescDisplay = descChange != null ? descChange : selfDesc
    const oldDescDisplay = oldDesc != null ? oldDesc : selfDesc
    return (
      <BaseChangeChip action="modify" onDismiss={onRemove} reviewFlagged={reviewFlagged} onClick={onClick} id={relChipId}
        expandedBody={buildExpandedBody('modify', oldDescDisplay, newDescDisplay)}
        dataHelpRegion="change-subchip:relationship">
        {profileImg}
        <span className="text-zinc-300">{trunc(otherName, NAME_TRUNC)}</span>
        {(oldDescDisplay || newDescDisplay) && <>
          <span className="text-zinc-600 flex-shrink-0">:</span>
          <span className="text-zinc-500 line-through text-[8px]">{trunc(oldDescDisplay, DESC_TRUNC_MODIFY) || '—'}</span>
          <span className="text-zinc-500">→</span>
          <span className="text-zinc-200">{trunc(newDescDisplay, DESC_TRUNC_MODIFY) || '—'}</span>
        </>}
      </BaseChangeChip>
    )
  }

  // ── Add ────────────────────────────────────────────────────────────────────
  if (changeType === 'add') {
    return (
      <BaseChangeChip action="add" onDismiss={onRemove} reviewFlagged={reviewFlagged} onClick={onClick} id={relChipId}
        expandedBody={buildExpandedBody('add', null, selfDesc)}
        dataHelpRegion="change-subchip:relationship">
        {profileImg}
        <span className="text-zinc-300">{trunc(otherName, NAME_TRUNC)}</span>
        {selfDesc && <>
          <span className="text-zinc-600 flex-shrink-0">:</span>
          <span className="text-zinc-200">{trunc(selfDesc)}</span>
        </>}
      </BaseChangeChip>
    )
  }

  // ── Remove ─────────────────────────────────────────────────────────────────
  if (changeType === 'remove') {
    return (
      <BaseChangeChip action="remove" onDismiss={onRemove} reviewFlagged={reviewFlagged} onClick={onClick} id={relChipId}
        expandedBody={buildExpandedBody('remove', selfDesc, null)}
        dataHelpRegion="change-subchip:relationship">
        {profileImg}
        <span className="text-zinc-300">{trunc(otherName, NAME_TRUNC)}</span>
        {selfDesc && <>
          <span className="text-zinc-600 flex-shrink-0">:</span>
          <span className="text-zinc-500 line-through text-[8px]">{trunc(selfDesc)}</span>
        </>}
      </BaseChangeChip>
    )
  }

  // ── Existing (no action, e.g. origin node display) ─────────────────────────
  // Phase 1.21h — null `changeType` is the documented "existing"
  // case (no action badge, just the presence indicator). Any other
  // unrecognised value falls to the loud fallback chip so unhandled
  // changeType values are immediately visible during development.
  if (changeType !== null && changeType !== undefined) {
    return <FallbackSubChip kind={`relsubchip:changeType=${changeType}`} payload={{ relationship_id: relationship?.id, ownerEntityId, changeType }} />
  }
  return (
    <BaseChangeChip action={null} color={otherColour} showSymbol={false} onDismiss={onRemove} id={relChipId}
      expandedBody={buildExpandedBody('existing', null, selfDesc)}
      dataHelpRegion="change-subchip:relationship">
      {profileImg}
      <span className="text-zinc-300">{trunc(otherName, NAME_TRUNC)}</span>
      {selfDesc && <>
        <span className="text-zinc-600 flex-shrink-0">:</span>
        <span className="text-zinc-400">{trunc(selfDesc)}</span>
      </>}
    </BaseChangeChip>
  )
}
