import { TYPE_ICONS } from '../../../utils/entityHelpers'
import { BaseChangeChip } from '../ChangeChipBase'

/**
 * Compact relationship-change row used in the entity Detail Panel's
 * "Changes at this point" section (sidebar context, not canvas).
 *
 * Renders the partner entity's profile image + entity-coloured name
 * with the relationship's `chip.field` / `chip.action` shape produced
 * upstream. Modify variants append an `oldValue → newValue` pair.
 *
 * Sidebar density (16px avatar) is intentionally larger than the
 * canvas-side `RelChangeChip` (12px) — see the sub-chip layout
 * convention's "context inventory" section. Style preserved verbatim
 * from its previous home in `EntityDetailPanelShared.jsx`.
 *
 * Migrated in v0.1.21.99 (sub-chip relocation pass).
 */
export default function RelationshipChangeChip({ chip, allEntities, onClick, onDismiss }) {
  const partner = chip.relEntityId ? allEntities.find((e) => e.id === chip.relEntityId) : null
  const colour = partner?.colour || chip.partnerFallbackColour || '#888888'
  const profileRef = partner?.profile_image_ref || null
  const assetName = profileRef ? profileRef.replace(/^assets\//, '') : null
  const name = partner?.name || chip.field || 'Unknown'

  // Truncation thresholds: name uses CSS truncate (variable, hard to
  // detect), so use a 24-char rule of thumb. The inline old → new
  // values render at text-[8px] without explicit clipping but live
  // inside a .truncate parent — long values clip. Threshold ~30 chars
  // for the combined `oldValue → newValue` string.
  const isLongName = (name || '').length > 24
  const oldStr = chip.oldValue == null ? null : String(chip.oldValue)
  const newStr = chip.newValue == null ? null : String(chip.newValue)
  const isLongValue = (oldStr && oldStr.length > 24) || (newStr && newStr.length > 24)
  const expandedBody = (isLongName || isLongValue) ? (
    <div className="space-y-0.5">
      {isLongName && (
        <div>
          <span className="text-zinc-500">Partner:</span>{' '}
          <span style={{ color: colour }}>{name}</span>
        </div>
      )}
      {chip.action === 'modify' && oldStr && (
        <div>
          <span className="text-zinc-500">Was:</span>{' '}
          <span className="text-zinc-400 line-through">{oldStr}</span>
        </div>
      )}
      {chip.action === 'modify' && newStr && (
        <div>
          <span className="text-zinc-500">Now:</span>{' '}
          <span className="text-zinc-200">{newStr}</span>
        </div>
      )}
    </div>
  ) : null

  return (
    <BaseChangeChip action={chip.action} onDismiss={onDismiss} onClick={onClick} expandedBody={expandedBody} dataHelpRegion="change-subchip:relationship">
      {assetName ? (
        <img
          src={`/api/project/assets/${assetName}`}
          alt=""
          className="rounded-sm object-cover flex-shrink-0"
          style={{ width: 16, height: 16, border: `1.5px solid ${colour}` }}
        />
      ) : (
        <span
          className="rounded-sm flex items-center justify-center flex-shrink-0 text-[9px]"
          style={{ width: 16, height: 16, backgroundColor: colour + '22', border: `1.5px solid ${colour}` }}
        >
          {TYPE_ICONS[partner?.type] || '?'}
        </span>
      )}
      <span className={`truncate ${chip.action === 'remove' ? 'line-through text-zinc-500' : ''}`} style={{ color: chip.action === 'remove' ? undefined : colour }}>
        {name}
      </span>
      {chip.action === 'modify' && chip.oldValue != null && (
        <span className="text-zinc-500 truncate ml-1 text-[8px]">
          <span className="line-through opacity-60">{chip.oldValue}</span>
          <span className="mx-0.5">→</span>
          <span className="text-zinc-300">{chip.newValue}</span>
        </span>
      )}
    </BaseChangeChip>
  )
}
