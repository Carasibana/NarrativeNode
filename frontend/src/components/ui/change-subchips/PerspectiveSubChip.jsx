import { useState } from 'react'
import { BaseChangeChip } from '../ChangeChipBase'
import { ActionGlyphBadge } from './atoms'
import { PerspectiveTypeBadge } from '../TypeBadges'
import { EntityLabelChip, KnowledgeLabelChip, RelationshipLabelChip } from '../IdentityBadges'
import { useEntitiesStore } from '../../../store/entitiesStore'
import { useProjectStore } from '../../../store/projectStore'

/**
 * Phase 2.13b — Perspective subchip.
 *
 * Dispatched by every surface where an entity-chip's `attribute_changes`
 * entry of type `perspective` is rendered as a sub-chip:
 *   - Canvas SceneNode entity chips (per-entity-per-scene change list).
 *   - Canvas EntityNode origin + modifier nodes.
 *   - Scene Changes tab change-event rows.
 *   - Detail Panel "Changes at this point" section of the Details tab.
 *
 * Visual shape:
 *   `[action glyph] [P type badge] [target identity chip] [trunc description]`
 *
 * The target identity chip uses the same identity-badge family as
 * everywhere else (EntityLabelChip / KnowledgeLabelChip /
 * RelationshipLabelChip) so a perspective row reads as "this entity has
 * a perspective ON ___" at a glance. The description follows in muted
 * text, truncated to whatever fits.
 *
 * Falls back to "(deleted target)" muted text when
 * `perspectiveTargetKind` / `perspectiveTargetId` is null — that's the
 * orphaned-target shape from the Phase 2.13a cascade contract.
 */

function relationshipLabel(rel, getEntityById) {
  if (!rel) return '(missing)'
  if (rel.title && rel.title.trim()) return rel.title.trim()
  const joins = (rel.history?.participant_changes || [])
    .filter((c) => c.action === 'join')
    .map((c) => c.entity_id)
  const uniq = Array.from(new Set(joins))
  if (uniq.length === 0) return '(empty relationship)'
  const names = uniq.slice(0, 2).map((id) => getEntityById(id)?.name || '?')
  return uniq.length <= 2 ? names.join(' ↔ ') : `${names.join(' ↔ ')} + ${uniq.length - 2} more`
}

function TargetChip({ kind, id }) {
  // Source data pulled at render time from the live stores. The chip
  // is short-lived (one row in a chain-events list); re-resolving on
  // each render keeps it in sync with downstream renames in the
  // entity library / knowledge library without extra plumbing.
  const getEntityById = useEntitiesStore((s) => s.getEntityById)
  const knowledges    = useProjectStore((s) => s.knowledges)
  const relationships = useProjectStore((s) => s.relationships)
  if (!kind || !id) {
    return <span className="text-[10px] text-zinc-500 italic">(deleted target)</span>
  }
  if (kind === 'knowledge') {
    const kn = (knowledges || []).find((x) => x.id === id)
    return <KnowledgeLabelChip name={kn?.name || '(missing)'} />
  }
  if (kind === 'relationship') {
    const r = (relationships || []).find((x) => x.id === id)
    return <RelationshipLabelChip name={relationshipLabel(r, getEntityById)} />
  }
  const e = getEntityById(id)
  return e ? <EntityLabelChip entity={e} /> : <span className="text-[10px] text-zinc-500 italic">(deleted target)</span>
}

export default function PerspectiveSubChip({
  description,
  perspectiveTargetKind,
  perspectiveTargetId,
  action = null,
  oldDescription,
  oldPerspectiveTargetKind,
  oldPerspectiveTargetId,
  onClick,
  onDismiss,
  onAddKnowledge,
  reviewFlagged,
}) {
  const [expanded, setExpanded] = useState(false)
  const isChangeEvent = !!action
  const trimmedDesc = (description || '').trim()

  // Truncated body text — `BaseChangeChip` clamps the chip width; we
  // surface up to ~26 chars inline, then offer a chevron expansion for
  // the full description when there's more to read.
  const TRUNC = 26
  const truncatedDesc = trimmedDesc.length > TRUNC ? trimmedDesc.slice(0, TRUNC) + '…' : trimmedDesc
  const hasMoreDesc = trimmedDesc.length > truncatedDesc.length
  const showChevron = hasMoreDesc && !isChangeEvent

  // For a modify event, if either the description OR the target
  // changed, show a transition block on expand. The chevron is
  // emitted by BaseChangeChip via `expandedBody`.
  const descChanged   = isChangeEvent && action === 'modify' && oldDescription != null && oldDescription !== description
  const targetChanged = isChangeEvent && action === 'modify' && (
    oldPerspectiveTargetKind !== perspectiveTargetKind ||
    oldPerspectiveTargetId   !== perspectiveTargetId
  )
  const hasModifyTransition = descChanged || targetChanged
  const modifyTransitionBody = hasModifyTransition ? (
    <div className="space-y-1">
      {targetChanged && (
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-zinc-500">Target:</span>
          <TargetChip kind={oldPerspectiveTargetKind} id={oldPerspectiveTargetId} />
          <span className="text-zinc-500">→</span>
          <TargetChip kind={perspectiveTargetKind} id={perspectiveTargetId} />
        </div>
      )}
      {descChanged && (
        <div className="space-y-0.5">
          <div><span className="text-zinc-500">Was:</span>{' '}<span className="text-zinc-400 line-through">"{oldDescription || ''}"</span></div>
          <div><span className="text-zinc-500">Now:</span>{' '}<span className="text-zinc-200">"{description || ''}"</span></div>
        </div>
      )}
    </div>
  ) : null

  function handleChevronClick(e) {
    e.stopPropagation()
    setExpanded((v) => !v)
  }

  const titleAttr = trimmedDesc ? `Perspective · "${trimmedDesc}"` : 'Perspective'

  return (
    <div className="select-none" title={titleAttr}>
      <BaseChangeChip
        action={action}
        showSymbol={false}
        onDismiss={onDismiss}
        onAddKnowledge={onAddKnowledge}
        reviewFlagged={reviewFlagged}
        onClick={onClick}
        expandedBody={modifyTransitionBody}
        dataHelpRegion="change-subchip:perspective"
      >
        <span className="flex items-center gap-1 min-w-0">
          {isChangeEvent && <ActionGlyphBadge action={action} />}
          <PerspectiveTypeBadge size={15} />
          {/* Target badge is wrapped in `flex-shrink-0` so it always
              renders at its natural width when there's room — the
              description span (below) is the only flex-shrinkable
              child and absorbs all the squeeze first. If the badge's
              natural width still exceeds the chip's container, the
              badge's INTERNAL `truncate min-w-0` on its name span
              kicks in as a fallback. */}
          <span className="flex-shrink-0 min-w-0">
            <TargetChip kind={perspectiveTargetKind} id={perspectiveTargetId} />
          </span>
          {trimmedDesc && (
            <span className="truncate text-zinc-300 min-w-0 flex-1">{truncatedDesc}</span>
          )}
          {showChevron && (
            <button
              type="button"
              onClick={handleChevronClick}
              className="nodrag flex-shrink-0 text-zinc-500 hover:text-zinc-300 leading-none"
              style={{ fontSize: 10 }}
              title={expanded ? 'Hide full description' : 'Show full description'}
            >
              {expanded ? '▾' : '▸'}
            </button>
          )}
        </span>
      </BaseChangeChip>
      {showChevron && expanded && (
        <div
          className="mt-0.5 ml-4 pr-2 text-[9px] text-zinc-400 leading-snug whitespace-pre-wrap"
          style={{ borderLeft: '1px dashed #3f3f46', paddingLeft: 6 }}
        >
          {trimmedDesc}
        </div>
      )}
    </div>
  )
}
