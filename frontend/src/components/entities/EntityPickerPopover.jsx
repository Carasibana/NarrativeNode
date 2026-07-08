import { useMemo, useState } from 'react'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import { EntityAvatar } from '../ui/IdentityBadges'

/**
 * Standalone entity picker popover — type tabs (icon-only) + search + a
 * filtered entity list with per-row avatar, name, and type icon. Extracted
 * from `EntityListAttribute.jsx` so the same picker can drive the
 * entity_list attribute editor, the `EntityModal` entity-list row, and the
 * Phase 1.21 AwarenessPicker "+ Add" affordance.
 *
 * Props:
 *   allEntities — flat array of every entity pickable in this context.
 *                 Callers decide which buckets to include by concatenating
 *                 their own store slices.
 *   excludeIds  — Set of entity ids to hide from the list (usually the
 *                 ids already chosen in the caller's chip row).
 *   onPick      — (entityId) => void. Called when a row is clicked. The
 *                 popover stays open so multiple entities can be added
 *                 without reopening; the caller chooses when to close.
 *   onClose     — () => void. Called by the "Close picker" footer button.
 *   lockedType  — optional entity-type string (`'character'`, `'location'`, etc.).
 *                 When set, hides the type tab strip and pins the filter to
 *                 the given type. Callers that only want one entity kind
 *                 (e.g. the Character Chat Setup modal) use this to avoid
 *                 showing irrelevant tabs.
 */
export default function EntityPickerPopover({ allEntities, excludeIds, onPick, onClose, lockedType = null }) {
  const [typeFilter, setTypeFilter] = useState(lockedType || 'all')
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    const excl = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || [])
    return (allEntities || [])
      // Defensive: knowledges are first-class objects, not Entity subtypes.
      // If a caller passes a list that still includes them, drop them so they
      // can't surface under the "All" tab.
      .filter((e) => e?.type !== 'knowledge')
      .filter((e) => typeFilter === 'all' || e.type === typeFilter)
      .filter((e) => !excl.has(e.id))
      .filter((e) => !s || (e.name || '').toLowerCase().includes(s))
      .slice(0, 50)
  }, [allEntities, typeFilter, search, excludeIds])

  // Knowledge is a first-class object type post-Phase 1.21c, not an Entity
  // subtype — it's not selectable here (entity pickers pick Entities only).
  // Use `<KnowledgePickerPopover>` for Knowledge selection surfaces.
  const TYPES = [
    { key: 'all',       icon: '⊕',                  label: 'All entity types' },
    { key: 'character', icon: TYPE_ICONS.character, label: 'Characters' },
    { key: 'location',  icon: TYPE_ICONS.location,  label: 'Locations' },
    { key: 'item',      icon: TYPE_ICONS.item,      label: 'Items' },
    { key: 'faction',   icon: TYPE_ICONS.faction,   label: 'Factions' },
    { key: 'custom',    icon: TYPE_ICONS.custom,    label: 'Custom entities' },
  ]

  return (
    <div data-help-region="entity-picker:popover" className="bg-zinc-800 border border-zinc-700 rounded overflow-hidden">
      {/* Type tab strip — suppressed when `lockedType` is set so the
          caller doesn't expose tabs the writer can't usefully act on. */}
      {!lockedType && (
        <div data-help-region="entity-picker:type_tabs" className="flex border-b border-zinc-700">
          {TYPES.map((t) => {
            const isActive = typeFilter === t.key
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTypeFilter(t.key)}
                title={t.label}
                className={`flex-1 flex items-center justify-center py-1 text-sm transition-colors border-b-2 ${
                  isActive
                    ? 'bg-zinc-700 text-zinc-100 border-accent-500'
                    : 'bg-zinc-800 text-zinc-400 border-transparent hover:bg-zinc-700/50 hover:text-zinc-200'
                }`}
              >
                {t.icon}
              </button>
            )
          })}
        </div>
      )}

      <div className="p-1.5 space-y-1">
        <input
          data-help-region="entity-picker:search"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
        />
        <div className="max-h-32 overflow-y-auto space-y-0.5">
          {filtered.length === 0 && (
            <p className="text-[10px] text-zinc-600 italic px-1">No matches.</p>
          )}
          {filtered.map((e) => (
            <button
              key={e.id}
              data-help-region="entity-picker:entity_row"
              type="button"
              onClick={() => onPick(e.id)}
              className="w-full flex items-center gap-1.5 px-1 py-0.5 rounded text-left hover:bg-zinc-700"
            >
              <EntityAvatar entity={e} size={16} />
              <span className="text-[10px] text-zinc-200 truncate flex-1">{e.name}</span>
              <span className="text-[10px] flex-shrink-0" title={e.type}>{TYPE_ICONS[e.type] || '?'}</span>
            </button>
          ))}
        </div>
        <button
          data-help-region="entity-picker:close"
          type="button"
          onClick={onClose}
          className="w-full text-[9px] text-zinc-500 hover:text-zinc-300 text-center"
        >
          Close picker
        </button>
      </div>
    </div>
  )
}
