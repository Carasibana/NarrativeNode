import { TYPE_ICONS } from '../../../utils/entityHelpers'
import { BaseChangeChip, NullBadge, trunc } from '../ChangeChipBase'
import { ActionEventBadge, ActionGlyphBadge, FallbackSubChip } from './atoms'
import ChangeSubChip from './ChangeSubChip'

/**
 * Sub-chip rendered inside a `RelationshipChip` showing a per-event
 * change to the relationship at this scene (participant join/leave,
 * perception/alias/role mutation, existence start/end, hierarchy /
 * name change).
 *
 * Layout convention for value-modification sub-chips (perception /
 * alias / role):
 *   [action icon] [object badge] · [field name] : [old strike] → [new]
 *
 * Where:
 *   - action icon: provided by BaseChangeChip in the action's colour
 *   - object badge: avatar + colour-tinted name of the participant
 *     subject when distinct from the parent chip's container
 *   - field name: the value being altered (Role / Perception / Alias)
 *   - transition: only on modify variants
 *
 * Container-wide changes (existence / hierarchy / name) fall back to
 * the field-name-first shape via the legacy `field` + `extra` slots
 * because there's no participant subject to badge.
 *
 * Migrated from `components/nodes/RelationshipChip.jsx` in v0.1.21.99
 * (sub-chip relocation pass). Style preserved verbatim.
 */
export default function RelChangeChip({ change, getEntity, onDismiss }) {
  let action = change.action === 'activate' ? 'add' : change.action === 'deactivate' ? 'remove' : change.action

  // Truncation thresholds matching the in-row `trunc()` calls below.
  const NAME_TRUNC = 10
  const VAL_TRUNC = 20  // matches trunc() default
  const isLongStr = (v, n) => typeof v === 'string' && v.length > n
  const buildValueExpand = (label, oldVal, newVal, italic = false) => {
    const oldLong = isLongStr(oldVal, VAL_TRUNC)
    const newLong = isLongStr(newVal, VAL_TRUNC)
    if (!oldLong && !newLong) return null
    const valCls = italic ? 'italic text-zinc-200' : 'text-zinc-200'
    const oldCls = italic ? 'italic text-zinc-400 line-through' : 'text-zinc-400 line-through'
    return (
      <div className="space-y-0.5">
        {oldVal != null && (
          <div>
            <span className="text-zinc-500">{label} (was):</span>{' '}
            <span className={oldCls}>"{oldVal}"</span>
          </div>
        )}
        {newVal != null && (
          <div>
            <span className="text-zinc-500">{label}:</span>{' '}
            <span className={valCls}>"{newVal}"</span>
          </div>
        )}
      </div>
    )
  }

  function entityBadge(ent) {
    if (!ent) return null
    const colour = ent.colour || '#888888'
    const imgRef = ent.profile_image_ref
    const imgSrc = imgRef ? `/api/project/assets/${imgRef.replace(/^assets\//, '')}` : null
    const icon = TYPE_ICONS[ent.type] || '?'
    return (
      <span className="inline-flex items-center gap-0.5 flex-shrink-0 min-w-0">
        {imgSrc ? (
          <img src={imgSrc} alt="" className="rounded-sm object-cover flex-shrink-0"
            style={{ width: 12, height: 12, border: `1.5px solid ${colour}` }} />
        ) : (
          <span className="flex items-center justify-center rounded-sm flex-shrink-0"
            style={{ width: 12, height: 12, fontSize: 7, backgroundColor: colour + '22', border: `1.5px solid ${colour}` }}>
            {icon}
          </span>
        )}
        <span className="truncate" style={{ color: colour }}>{trunc(ent.name || '?', 10)}</span>
      </span>
    )
  }

  function transitionParts(oldVal, newVal, italic = false) {
    if (action !== 'modify') return null
    const valCls = italic ? 'text-zinc-200 italic truncate' : 'text-zinc-200 truncate'
    const oldCls = italic
      ? 'text-zinc-500 line-through italic text-[8px] truncate flex-shrink-0'
      : 'text-zinc-500 line-through text-[8px] truncate flex-shrink-0'
    return (
      <>
        <span className="text-zinc-600 flex-shrink-0">:</span>
        {oldVal != null && <span className={oldCls}>{trunc(oldVal)}</span>}
        {oldVal != null && <span className="text-zinc-600 flex-shrink-0">→</span>}
        {newVal != null
          ? <span className={valCls}>{trunc(newVal)}</span>
          : <NullBadge />}
      </>
    )
  }

  if (change.type === 'participant') {
    action = change.action === 'join' ? 'add' : 'remove'
    const ent = getEntity(change.entity_id)
    return (
      <BaseChangeChip action={action} showSymbol={false} onDismiss={onDismiss} dataHelpRegion="change-subchip:relationship_history">
        <ActionEventBadge action={action} label={change.action === 'join' ? 'JOINED' : 'LEFT'} />
        {entityBadge(ent) || <span className="text-zinc-300 flex-shrink-0">{ent?.name || '?'}</span>}
      </BaseChangeChip>
    )
  } else if (change.type === 'perception') {
    const ent = getEntity(change.entity_id)
    return (
      <BaseChangeChip action={action} showSymbol={false} onDismiss={onDismiss} dataHelpRegion="change-subchip:relationship_history"
        expandedBody={buildValueExpand('Perception', change.old_value, change.new_value)}>
        <ActionGlyphBadge action={action} />
        {entityBadge(ent)}
        <span className="text-zinc-600 flex-shrink-0">·</span>
        <span className="text-zinc-300 flex-shrink-0">Perception</span>
        {transitionParts(change.old_value, change.new_value)}
      </BaseChangeChip>
    )
  } else if (change.type === 'alias') {
    const ent = getEntity(change.entity_id)
    return (
      <BaseChangeChip action={action} showSymbol={false} onDismiss={onDismiss} dataHelpRegion="change-subchip:relationship_history"
        expandedBody={buildValueExpand('Alias', change.old_value, change.new_value, true)}>
        <ActionGlyphBadge action={action} />
        {entityBadge(ent)}
        <span className="text-zinc-600 flex-shrink-0">·</span>
        <span className="text-zinc-300 flex-shrink-0">Alias</span>
        {transitionParts(change.old_value, change.new_value, true)}
      </BaseChangeChip>
    )
  } else if (change.type === 'role') {
    const ent = getEntity(change.entity_id)
    return (
      <BaseChangeChip action={action} showSymbol={false} onDismiss={onDismiss} dataHelpRegion="change-subchip:relationship_history"
        expandedBody={buildValueExpand('Role', change.old_value, change.new_value)}>
        <ActionGlyphBadge action={action} />
        {entityBadge(ent)}
        <span className="text-zinc-600 flex-shrink-0">·</span>
        <span className="text-zinc-300 flex-shrink-0">Role</span>
        {transitionParts(change.old_value, change.new_value)}
      </BaseChangeChip>
    )
  } else if (change.type === 'existence') {
    return (
      <BaseChangeChip action={action} showSymbol={false} onDismiss={onDismiss} dataHelpRegion="change-subchip:relationship_history">
        <ActionEventBadge action={action} label={change.action === 'activate' ? 'STARTED' : 'ENDED'} />
      </BaseChangeChip>
    )
  } else if (change.type === 'hierarchy') {
    return (
      <BaseChangeChip action={action} showSymbol={false} onDismiss={onDismiss} dataHelpRegion="change-subchip:relationship_history">
        <ActionGlyphBadge action={action} />
        <span className="text-zinc-300 flex-shrink-0">Hierarchy</span>
      </BaseChangeChip>
    )
  } else if (change.type === 'name') {
    const newVal = change.new_value
    const oldVal = change.old_value
    return (
      <BaseChangeChip action={action} showSymbol={false} onDismiss={onDismiss} dataHelpRegion="change-subchip:relationship_history"
        expandedBody={buildValueExpand('Name', oldVal, newVal)}>
        <ActionGlyphBadge action={action} />
        <span className="text-zinc-300 flex-shrink-0">Name</span>
        <span className="flex items-center gap-0.5 min-w-0">
          <span className="text-zinc-600 flex-shrink-0">:</span>
          {oldVal != null
            ? <span className="text-zinc-500 line-through text-[8px] truncate flex-shrink-0">{trunc(oldVal)}</span>
            : <NullBadge />
          }
          <span className="text-zinc-600 flex-shrink-0">→</span>
          {newVal != null
            ? <span className="text-zinc-200 truncate">{trunc(newVal)}</span>
            : <NullBadge />
          }
        </span>
      </BaseChangeChip>
    )
  } else if (change.type === 'description') {
    // Reuse the universal generic-modify branch in `ChangeSubChip` —
    // same renderer that entity / Knowledge description changes use.
    return (
      <ChangeSubChip
        chip={{
          action: 'modify',
          field: 'Description',
          oldValue: change.old_value ?? null,
          newValue: change.new_value ?? null,
        }}
        onDismiss={onDismiss}
      />
    )
  }

  // Phase 1.21h — catchall fallback. The if/else above covers every
  // known relationship change.type discriminator; if a new type lands
  // in the walker without a matching renderer branch here, render the
  // visually-loud fallback so the gap is immediately visible.
  return <FallbackSubChip kind={`relchange:${change.type ?? 'unknown'}`} payload={change} />
}
