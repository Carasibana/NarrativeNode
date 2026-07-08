import { useMemo, useState } from 'react'
import { RelationshipLabelChip } from '../ui/IdentityBadges'
import { participantsFallbackLabel } from '../../utils/entityHelpers'

/**
 * Standalone Relationship picker popover — search input + filtered
 * list of pickable relationships. Parallel to
 * `KnowledgePickerPopover` / `ScenePickerPopover` in shape;
 * displays each relationship by its explicit name when set, else
 * falls back to a participants synthesis ("Alice & Bob") using the
 * same helper the rest of the app uses for relationship labels.
 *
 * Initial caller: the chat panel's "Add context" affordance
 * (Phase 2.5c manual context attach). The previously-existing
 * `ContributorPickerPopover` covers relationship picking inside a
 * unified entity / relationship / attribute picker for the
 * AwarenessPicker; this single-purpose variant exists so callers
 * that only want relationships don't pull in the extra tabs.
 *
 * Props:
 *   allRelationships — flat array of relationships. Caller usually
 *                      passes `projectStore.relationships`.
 *   allEntities      — flat list of entities used to resolve names
 *                      for the participant-fallback label. Caller
 *                      passes the flat union of every entity bucket.
 *   excludeIds       — Set / array of relationship ids to hide.
 *   onPick           — (relationshipId) => void.
 *   onClose          — () => void.
 */
export default function RelationshipPickerPopover({
  allRelationships,
  allEntities,
  excludeIds,
  onPick,
  onClose,
}) {
  const [search, setSearch] = useState('')

  const getEntity = useMemo(() => {
    const map = new Map((allEntities || []).map((e) => [e.id, e]))
    return (eid) => map.get(eid) || null
  }, [allEntities])

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    const excl = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || [])
    return (allRelationships || [])
      .filter((r) => r && !excl.has(r.id))
      .map((r) => ({ rel: r, label: _relLabel(r, getEntity) }))
      .filter(({ label }) => !s || (label || '').toLowerCase().includes(s))
      .slice(0, 50)
  }, [allRelationships, search, excludeIds, getEntity])

  return (
    <div data-help-region="relationship-picker:popover" className="bg-zinc-800 border border-zinc-700 rounded overflow-hidden">
      <div className="p-1.5 space-y-1">
        <input
          data-help-region="relationship-picker:search"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search relationships…"
          className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
        />
        <div className="max-h-32 overflow-y-auto space-y-0.5">
          {filtered.length === 0 && (
            <p className="text-[10px] text-zinc-600 italic px-1">No matches.</p>
          )}
          {filtered.map(({ rel, label }) => (
            <button
              key={rel.id}
              data-help-region="relationship-picker:relationship_row"
              type="button"
              onClick={() => onPick(rel.id)}
              className="w-full flex items-center gap-1.5 px-1 py-0.5 rounded text-left hover:bg-zinc-700"
            >
              <RelationshipLabelChip name={label} />
            </button>
          ))}
        </div>
        <button
          data-help-region="relationship-picker:close"
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


function _relLabel(rel, getEntity) {
  const explicit = rel.name?.trim()
  if (explicit) return explicit
  const joinIds = Array.from(new Set(
    ((rel.history?.participant_changes) || [])
      .filter((c) => c.action === 'join')
      .map((c) => c.entity_id),
  ))
  const synth = participantsFallbackLabel(
    joinIds.map((eid) => ({ entity_id: eid })),
    getEntity,
    3,
    rel,
  )
  return synth || `Relationship ${(rel.id || '').slice(0, 6)}…`
}
