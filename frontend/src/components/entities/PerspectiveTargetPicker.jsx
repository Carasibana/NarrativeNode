import { useMemo, useState } from 'react'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProjectStore } from '../../store/projectStore'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import { EntityAvatar, KnowledgeIcon, KNOWLEDGE_COLOUR, RelationshipIcon } from '../ui/IdentityBadges'

/**
 * Phase 2.13b — target picker for a Perspective attribute.
 *
 * A Perspective's target can be any of seven kinds: character, location,
 * item, faction, custom (the five entity types) plus knowledge and
 * relationship (the two non-entity first-class objects). This picker
 * surfaces all seven in a single popover with a tab strip across the
 * top, mirroring the unified "one popover, 7 type tabs" pattern picked
 * during ideation rather than the kind-dropdown + per-kind-picker
 * fallback.
 *
 * The picker mirrors the inline pattern used by `EntityPickerPopover`
 * (used by `EntityListAttribute`): the host caller toggles a
 * `showPicker` boolean and renders this component inline below the
 * triggering button when true. No createPortal positioning; the
 * popover lives in the form body.
 *
 * Props:
 *   onPick({kind, id})  — called when a row is clicked. The host
 *                          stores the picked (kind, id) on the
 *                          perspective draft and typically closes
 *                          the picker.
 *   onClose             — () => void. Called by the "Close picker"
 *                          footer button.
 *
 * Relationship rows use the relationship's `title` field if set;
 * otherwise they fall back to a `<A> ↔ <B>` label derived from join
 * events. Knowledge rows use the knowledge's `name`. Entity rows use
 * the existing `EntityAvatar` + name pattern from
 * `EntityPickerPopover`.
 */

// Tab strip kinds:
//   - Entity kinds: bare emoji glyph from `TYPE_ICONS` (matches the
//     entity library panel's tab strip).
//   - Knowledge: bare 📜 glyph (no nested framing — the chip border
//     elsewhere does the framing).
//   - Relationship: the canonical `RelationshipIcon` component in
//     its identity violet (`REL_COLOUR`) — keeps the relationship's
//     visual identity readable regardless of the tab's active /
//     inactive text colour.
const TARGET_KINDS = [
  { key: 'all',          renderIcon: () => '⊕',                  label: 'All target kinds' },
  { key: 'character',    renderIcon: () => TYPE_ICONS.character, label: 'Characters' },
  { key: 'location',     renderIcon: () => TYPE_ICONS.location,  label: 'Locations' },
  { key: 'item',         renderIcon: () => TYPE_ICONS.item,      label: 'Items' },
  { key: 'faction',      renderIcon: () => TYPE_ICONS.faction,   label: 'Factions' },
  { key: 'custom',       renderIcon: () => TYPE_ICONS.custom,    label: 'Custom entities' },
  { key: 'knowledge',    renderIcon: () => TYPE_ICONS.knowledge, label: 'Knowledge' },
  { key: 'relationship', renderIcon: () => <RelationshipIcon size={15} />, label: 'Relationship' },
]

// Compute a display label for a relationship row. Uses `title` when
// set; falls back to "<A> ↔ <B>" derived from the participants in
// the relationship's join events. When more than two participants
// are joined, appends "+ N more". Names are resolved via the
// entitiesStore lookup so renames in the entity library propagate.
function relationshipLabel(rel, getEntity) {
  if (rel.title && rel.title.trim()) return rel.title.trim()
  const joinIds = ((rel.history?.participant_changes) || [])
    .filter((c) => c.action === 'join')
    .map((c) => c.entity_id)
  const uniq = Array.from(new Set(joinIds))
  if (uniq.length === 0) return '(empty relationship)'
  const names = uniq.slice(0, 2).map((id) => getEntity(id)?.name || '?')
  if (uniq.length <= 2) return names.join(' ↔ ')
  return `${names.join(' ↔ ')} + ${uniq.length - 2} more`
}

export default function PerspectiveTargetPicker({ onPick, onClose }) {
  const characters    = useEntitiesStore((s) => s.characters)
  const locations     = useEntitiesStore((s) => s.locations)
  const items         = useEntitiesStore((s) => s.items)
  const factions      = useEntitiesStore((s) => s.factions)
  const customs       = useEntitiesStore((s) => s.customs)
  const getEntityById = useEntitiesStore((s) => s.getEntityById)
  const knowledges    = useProjectStore((s) => s.knowledges)
  const relationships = useProjectStore((s) => s.relationships)

  const [kindFilter, setKindFilter] = useState('all')
  const [search, setSearch]         = useState('')

  // Flatten the seven kinds into a single row list with normalised
  // shape: { kind, id, name, entity? }. Filter by kind tab + search
  // string, cap at 100 rows to keep the list responsive when a
  // project has hundreds of entities.
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase()
    const includeEntity = (kind) => kindFilter === 'all' || kindFilter === kind
    const includeKnowledge = kindFilter === 'all' || kindFilter === 'knowledge'
    const includeRel       = kindFilter === 'all' || kindFilter === 'relationship'

    const out = []
    if (includeEntity('character'))
      (characters || []).forEach((e) => out.push({ kind: 'character', id: e.id, name: e.name || '(unnamed)', entity: e }))
    if (includeEntity('location'))
      (locations || []).forEach((e) => out.push({ kind: 'location', id: e.id, name: e.name || '(unnamed)', entity: e }))
    if (includeEntity('item'))
      (items || []).forEach((e) => out.push({ kind: 'item', id: e.id, name: e.name || '(unnamed)', entity: e }))
    if (includeEntity('faction'))
      (factions || []).forEach((e) => out.push({ kind: 'faction', id: e.id, name: e.name || '(unnamed)', entity: e }))
    if (includeEntity('custom'))
      (customs || []).forEach((e) => out.push({ kind: 'custom', id: e.id, name: e.name || '(unnamed)', entity: e }))
    if (includeKnowledge)
      (knowledges || []).forEach((k) => out.push({ kind: 'knowledge', id: k.id, name: k.name || '(unnamed)' }))
    if (includeRel)
      (relationships || []).forEach((r) => out.push({ kind: 'relationship', id: r.id, name: relationshipLabel(r, getEntityById) }))

    return out
      .filter((r) => !s || (r.name || '').toLowerCase().includes(s))
      .slice(0, 100)
  }, [
    characters, locations, items, factions, customs,
    knowledges, relationships, kindFilter, search, getEntityById,
  ])

  function renderRowIcon(row) {
    if (row.kind === 'knowledge') {
      return <KnowledgeIcon size={16} colour={KNOWLEDGE_COLOUR} />
    }
    if (row.kind === 'relationship') {
      return <RelationshipIcon size={16} />
    }
    return <EntityAvatar entity={row.entity} size={16} />
  }

  return (
    <div className="bg-zinc-800 border border-zinc-700 rounded overflow-hidden" data-help-region="perspective-target-picker:picker">
      <div className="flex border-b border-zinc-700" data-help-region="perspective-target-picker:kind_tabs">
        {TARGET_KINDS.map((t) => {
          const isActive = kindFilter === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setKindFilter(t.key)}
              title={t.label}
              className={`flex-1 flex items-center justify-center py-1 text-sm transition-colors border-b-2 ${
                isActive
                  ? 'bg-zinc-700 text-zinc-100 border-accent-500'
                  : 'bg-zinc-800 text-zinc-400 border-transparent hover:bg-zinc-700/50 hover:text-zinc-200'
              }`}
            >
              {t.renderIcon()}
            </button>
          )
        })}
      </div>
      <div className="p-1.5 space-y-1">
        <input
          data-help-region="perspective-target-picker:search"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
        />
        <div className="max-h-40 overflow-y-auto space-y-0.5" data-help-region="perspective-target-picker:results">
          {rows.length === 0 && (
            <p className="text-[10px] text-zinc-600 italic px-1">No matches.</p>
          )}
          {rows.map((row) => (
            <button
              key={`${row.kind}:${row.id}`}
              type="button"
              onClick={() => onPick({ kind: row.kind, id: row.id })}
              className="w-full flex items-center gap-1.5 px-1 py-0.5 rounded text-left hover:bg-zinc-700"
            >
              {renderRowIcon(row)}
              <span className="text-[10px] text-zinc-200 truncate flex-1">{row.name}</span>
              <span className="text-[10px] text-zinc-500 flex-shrink-0 flex items-center" title={row.kind}>
                {row.kind === 'knowledge'
                  ? <KnowledgeIcon size={12} colour={KNOWLEDGE_COLOUR} />
                  : row.kind === 'relationship'
                    ? <RelationshipIcon size={12} />
                    : (TYPE_ICONS[row.kind] || '?')}
              </span>
            </button>
          ))}
        </div>
        <button
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
