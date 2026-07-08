import { BaseChangeChip } from '../ChangeChipBase'
import { RelationshipLabelChip, ParticipantsFallbackLabel } from '../IdentityBadges'
import ImageHoverPreview from '../ImageHoverPreview'
import { TYPE_ICONS } from '../../../utils/entityHelpers'
import { ActionEventBadge, ActionGlyphBadge, FallbackSubChip } from './atoms'

/**
 * One entry from a relationship's history list — used as a row in the
 * entity Detail Panel's "Relationship history" sidebar section AND as
 * the entity-origin "+ JOINED <relationship>" chip on canvas (when
 * the join is being aggregated onto the entity's origin node, with
 * trailing other-participant avatars).
 *
 * Renders a compact per-event-kind badge (✚ JOINED / ⚊ LEFT pill for
 * participant changes; glyph + plain field name for in-place
 * modifications) followed by the relationship label chip and the new
 * value (when present and scalar). Optionally trails a row of other-
 * participant avatars (used by the canvas entity-origin aggregation).
 *
 * Props:
 *   entry              — { relationship, change }
 *   onClick            — optional click handler
 *   getEntity          — entity-id resolver
 *   otherParticipantIds — optional array of entity ids to render as
 *                        a trailing avatar row (canvas entity-origin
 *                        case); omit for sidebar rows.
 *   allEntities        — required when otherParticipantIds is set;
 *                        used for avatar lookup.
 *   resolveNameAtAnchor — optional callback for chain-aware name
 *                        resolution at the chip's host anchor; falls
 *                        back to base entity name when omitted.
 */
export default function RelationshipHistoryChangeChip({
  entry, onClick, getEntity,
  otherParticipantIds = null,
  allEntities = null,
  resolveNameAtAnchor = null,
  // When true, suppresses the relationship label chip embedded in the
  // row. Used by surfaces (e.g. the Scene Detail Panel's Changes tab)
  // where the parent card already names the relationship as a section
  // header — repeating it inside every row is noise. Default false to
  // preserve the existing sidebar / canvas rendering.
  hideRelationshipLabel = false,
}) {
  const { relationship, change } = entry
  const hasName = !!(relationship?.name && String(relationship.name).trim().length > 0)
  const relName = hasName ? relationship.name.trim() : 'Relationship'
  // Build the participants-fallback label for un-named relationships
  // so the chip reads as e.g. "Alice & Bob" rather than the generic
  // word "Relationship". Mirrors the internal `RelChip` pattern in
  // `IdentityBadges.jsx` used by every other relationship-identity
  // surface.
  const fallback = !hasName ? (() => {
    const joinIds = Array.from(new Set(
      (relationship?.history?.participant_changes || [])
        .filter((c) => c.action === 'join')
        .map((c) => c.entity_id)
    ))
    if (joinIds.length === 0) return '(no participants)'
    return (
      <ParticipantsFallbackLabel
        participants={joinIds.map((id) => ({ entity_id: id }))}
        getEntity={getEntity}
        sliceMax={3}
        rel={relationship}
        resolveName={resolveNameAtAnchor}
      />
    )
  })() : null
  // Map the change to a top-level action colour for BaseChangeChip's
  // tinted left-border + bg.
  const action = change.action === 'remove' || change.action === 'leave'
    ? 'remove'
    : (change.action === 'join' ? 'add' : 'modify')
  // Per-event-kind leading badge.
  //   - Participant changes (pure action, no field name): full
  //     "✚ JOINED" / "⚊ LEFT" pill via ActionEventBadge.
  //   - Existence changes (pure action): "✚ STARTED" / "⚊ ENDED".
  //   - Value-bearing changes (perception / alias / role / name /
  //     hierarchy): glyph-only ActionGlyphBadge; the relationship
  //     label chip is the object badge; the field name + transition
  //     read after via the convention `[glyph] [object badge] ·
  //     [field name] : [old strike] → [new value]`.
  const isParticipant = change.type === 'participant'
  const isExistence = change.type === 'existence'
  const isPureAction = isParticipant || isExistence
  // Phase 1.21h — explicit dispatch over every known change.type. An
  // unknown type returns the loud fallback below so gaps are visible.
  const KNOWN_TYPES = new Set(['participant', 'existence', 'perception', 'alias', 'role', 'hierarchy', 'name', 'description'])
  if (!KNOWN_TYPES.has(change.type)) {
    return <FallbackSubChip kind={`relhistory:${change.type ?? 'unknown'}`} payload={{ relationship: relationship?.name ?? null, change }} />
  }
  const fieldLabel = (
    change.type === 'perception' ? 'Perception'
    : change.type === 'alias'    ? 'Alias'
    : change.type === 'role'     ? 'Role'
    : change.type === 'hierarchy' ? 'Hierarchy'
    : change.type === 'name'     ? 'Name'
    : change.type === 'description' ? 'Description'
    : ''
  )
  const leading = (() => {
    if (isParticipant) {
      return change.action === 'join'
        ? <ActionEventBadge action="add"    label="JOINED" />
        : <ActionEventBadge action="remove" label="LEFT" />
    }
    if (isExistence) {
      return change.action === 'activate'
        ? <ActionEventBadge action="add"    label="STARTED" />
        : <ActionEventBadge action="remove" label="ENDED" />
    }
    return <ActionGlyphBadge action="modify" />
  })()
  // Optional trailing other-participant avatar row — used by the
  // canvas entity-origin "+ JOINED <relationship>" aggregation. Up
  // to 3 inline + a "+N" overflow.
  const otherAvatars = (otherParticipantIds && allEntities && otherParticipantIds.length > 0) ? (
    <div className="flex items-center gap-0.5 flex-shrink-0 ml-0.5">
      {otherParticipantIds.slice(0, 3).map((eid) => {
        const other = allEntities.find((e) => e.id === eid)
        if (!other) return null
        const colour = other.colour || '#888'
        const refStr = other.profile_image_ref
        const src = refStr
          ? (refStr.startsWith('/') ? refStr : `/api/project/assets/${refStr.replace(/^assets\//, '')}`)
          : null
        const inner = src ? (
          <img
            src={src}
            alt=""
            className="rounded object-cover"
            style={{ width: 11, height: 11, border: `1px solid ${colour}` }}
            title={other.name}
          />
        ) : (
          <span
            className="rounded flex items-center justify-center text-[7px]"
            style={{ width: 11, height: 11, backgroundColor: colour + '22', border: `1px solid ${colour}` }}
            title={other.name}
          >
            {TYPE_ICONS[other.type] || '★'}
          </span>
        )
        if (src) {
          return (
            <ImageHoverPreview
              key={eid}
              src={src}
              borderColour={colour}
              size={80}
              previewSource={refStr ? {
                type: 'entity_profile',
                entityId: eid,
                ...(refStr.startsWith('data:') ? { url: refStr } : { fileRef: refStr }),
                entityName: other.name,
                entityColour: colour,
              } : undefined}
            >
              {inner}
            </ImageHoverPreview>
          )
        }
        return <span key={eid}>{inner}</span>
      })}
      {otherParticipantIds.length > 3 && (
        <span className="text-[8px] text-zinc-500">+{otherParticipantIds.length - 3}</span>
      )}
    </div>
  ) : null

  // Value-bearing transition: `: oldStrike → new`. Italic for alias.
  const italic = change.type === 'alias'
  const valCls = italic ? 'text-zinc-200 italic truncate' : 'text-zinc-200 truncate'
  const oldCls = italic
    ? 'text-zinc-500 line-through italic text-[8px] truncate flex-shrink-0'
    : 'text-zinc-500 line-through text-[8px] truncate flex-shrink-0'
  const oldVal = change.old_value
  const newVal = change.new_value
  const transition = !isPureAction ? (
    <span className="flex items-center gap-0.5 min-w-0">
      <span className="text-zinc-600 flex-shrink-0">:</span>
      {oldVal != null && <span className={oldCls}>{typeof oldVal === 'string' ? `"${oldVal}"` : String(oldVal)}</span>}
      {oldVal != null && <span className="text-zinc-600 flex-shrink-0">→</span>}
      {newVal != null
        ? <span className={valCls}>{typeof newVal === 'string' ? `"${newVal}"` : String(newVal)}</span>
        : null}
    </span>
  ) : null

  // Expandable details body — only when one of the value strings is
  // long enough that the inline `truncate` CSS will likely clip it
  // (~24 chars rule of thumb for these tight rows). Shows the full
  // untruncated old + new for review.
  const VAL_LONG = 24
  const oldStr = typeof oldVal === 'string' ? oldVal : (oldVal == null ? null : String(oldVal))
  const newStr = typeof newVal === 'string' ? newVal : (newVal == null ? null : String(newVal))
  const hasLongValue = !isPureAction && (
    (oldStr && oldStr.length > VAL_LONG) ||
    (newStr && newStr.length > VAL_LONG)
  )
  const expandedBody = hasLongValue ? (
    <div className="space-y-0.5">
      {oldStr != null && (
        <div>
          <span className="text-zinc-500">{fieldLabel} (was):</span>{' '}
          <span className={italic ? 'text-zinc-400 italic line-through' : 'text-zinc-400 line-through'}>
            {italic ? `"${oldStr}"` : oldStr}
          </span>
        </div>
      )}
      {newStr != null && (
        <div>
          <span className="text-zinc-500">{fieldLabel}:</span>{' '}
          <span className={italic ? 'text-zinc-200 italic' : 'text-zinc-200'}>
            {italic ? `"${newStr}"` : newStr}
          </span>
        </div>
      )}
    </div>
  ) : null

  // For participant join / leave events the change carries an
  // `entity_id` identifying WHO joined / left — render that entity's
  // avatar + chain-resolved name before the relationship label so the
  // chip reads as "[entity] JOINED [relationship]" instead of just
  // "JOINED [relationship]" (which made the relationship look like the
  // subject of the join).
  const participantBadge = (() => {
    if (!isParticipant || !change?.entity_id || !getEntity) return null
    const ent = getEntity(change.entity_id)
    if (!ent) return null
    const colour = ent.colour || '#888'
    const refStr = ent.profile_image_ref
    const src = refStr
      ? (refStr.startsWith('/') ? refStr : `/api/project/assets/${refStr.replace(/^assets\//, '')}`)
      : null
    const avatar = src ? (
      <ImageHoverPreview
        src={src}
        borderColour={colour}
        size={80}
        previewSource={refStr ? {
          type: 'entity_profile',
          entityId: change.entity_id,
          ...(refStr.startsWith('data:') ? { url: refStr } : { fileRef: refStr }),
          entityName: (resolveNameAtAnchor && resolveNameAtAnchor(change.entity_id)) || ent.name || '(unnamed)',
          entityColour: colour,
        } : undefined}
      >
        <img
          src={src}
          alt=""
          className="rounded object-cover flex-shrink-0"
          style={{ width: 11, height: 11, border: `1px solid ${colour}` }}
        />
      </ImageHoverPreview>
    ) : (
      <span
        className="rounded flex items-center justify-center text-[7px] flex-shrink-0"
        style={{ width: 11, height: 11, backgroundColor: colour + '22', border: `1px solid ${colour}` }}
      >
        {TYPE_ICONS[ent.type] || '★'}
      </span>
    )
    const name = (resolveNameAtAnchor && resolveNameAtAnchor(change.entity_id)) || ent.name || '(unnamed)'
    return (
      <span className="inline-flex items-center gap-1 min-w-0">
        {avatar}
        <span className="truncate" style={{ color: colour }}>{name}</span>
      </span>
    )
  })()

  return (
    <BaseChangeChip action={action} showSymbol={false} onClick={onClick} expandedBody={expandedBody} dataHelpRegion="change-subchip:relationship_history">
      {leading}
      {participantBadge}
      {!hideRelationshipLabel && (
        <RelationshipLabelChip name={relName}>
          {hasName ? relName : fallback}
        </RelationshipLabelChip>
      )}
      {!isPureAction && (
        <>
          <span className="text-zinc-600 flex-shrink-0">·</span>
          <span className="text-zinc-300 flex-shrink-0">{fieldLabel}</span>
          {transition}
        </>
      )}
      {otherAvatars}
    </BaseChangeChip>
  )
}
