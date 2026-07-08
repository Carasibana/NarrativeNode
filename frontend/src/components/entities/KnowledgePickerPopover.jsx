import { useMemo, useState } from 'react'
import ImageHoverPreview from '../ui/ImageHoverPreview'
import { KnowledgeIcon } from '../ui/IdentityBadges'

/**
 * Standalone Knowledge picker popover — search input + filtered list of
 * pickable knowledges. Parallel to `EntityPickerPopover` in shape, but
 * simpler: no type tabs (knowledges don't have subtypes), and each row
 * carries a small muted "(N known)" count (observers with any positive
 * awareness level on this Knowledge).
 *
 * Used by the Entity Detail Panel's new "Knowledge" tab (Step 7) "+ Add
 * Knowledge" affordance, and by the attached-Knowledge "modify existing
 * Knowledge" flow (Step 11).
 *
 * Props:
 *   allKnowledges — flat array of every Knowledge pickable in this context.
 *                   Callers pass `projectStore.knowledges`.
 *   excludeIds    — Set of knowledge ids to hide from the list (usually
 *                   the ids already chosen in the caller's chip row).
 *   onPick        — (knowledgeId) => void. Called when a row is clicked.
 *                   The popover stays open so multiple knowledges can be
 *                   added without reopening; the caller chooses when to
 *                   close.
 *   onClose       — () => void. Called by the "Close picker" footer button.
 */
export default function KnowledgePickerPopover({ allKnowledges, excludeIds, onPick, onClose }) {
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    const excl = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || [])
    return (allKnowledges || [])
      .filter((k) => !excl.has(k.id))
      .filter((k) => !s || (k.name || '').toLowerCase().includes(s))
      .slice(0, 50)
  }, [allKnowledges, search, excludeIds])

  return (
    <div data-help-region="knowledge-picker:popover" className="bg-zinc-800 border border-zinc-700 rounded overflow-hidden">
      <div className="p-1.5 space-y-1">
        <input
          data-help-region="knowledge-picker:search"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search knowledges…"
          className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
        />
        <div className="max-h-32 overflow-y-auto space-y-0.5">
          {filtered.length === 0 && (
            <p className="text-[10px] text-zinc-600 italic px-1">No matches.</p>
          )}
          {filtered.map((k) => {
            const colour    = k.colour || '#c9a876'
            const assetName = k.profile_image_ref ? k.profile_image_ref.split('/').pop() : null
            // Known-by count — observers at any positive level. When
            // `awareness` is an AwarenessRef the count isn't locally
            // resolvable without chain context; show "(ref)" as a hint.
            let countLabel
            if (k.awareness && typeof k.awareness === 'object' && 'relationship_id' in k.awareness) {
              countLabel = '(ref)'
            } else if (k.awareness && typeof k.awareness === 'object') {
              const positives = Object.values(k.awareness).filter((v) => typeof v === 'number' && v > 0).length
              countLabel = `(${positives} known)`
            } else {
              countLabel = '(0 known)'
            }
            return (
              <button
                key={k.id}
                data-help-region="knowledge-picker:knowledge_row"
                type="button"
                onClick={() => onPick(k.id)}
                className="w-full flex items-center gap-1.5 px-1 py-0.5 rounded text-left hover:bg-zinc-700"
              >
                <ImageHoverPreview src={assetName ? `/api/project/assets/${assetName}` : null} borderColour={colour} size={80}>
                  <span
                    className="rounded-sm flex-shrink-0 flex items-center justify-center overflow-hidden"
                    style={{ width: 16, height: 16, border: `1.5px solid ${colour}`, backgroundColor: colour + '33' }}
                  >
                    {assetName ? (
                      <img src={`/api/project/assets/${assetName}`} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-[10px] leading-none select-none">📜</span>
                    )}
                  </span>
                </ImageHoverPreview>
                <span className="text-[10px] text-zinc-200 truncate flex-1">
                  {k.name || <em className="text-zinc-500">(unnamed)</em>}
                </span>
                <span className="text-[9px] text-zinc-500 flex-shrink-0">{countLabel}</span>
                <KnowledgeIcon size={10} />
              </button>
            )
          })}
        </div>
        <button
          data-help-region="knowledge-picker:close"
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
