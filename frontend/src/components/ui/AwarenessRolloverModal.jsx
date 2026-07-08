/**
 * AwarenessRolloverModal — opens after a chain-anchor commit on a value
 * whose own awareness layer has tracking on at the anchor and at least
 * one observer in the resolved entries. The writer can adjust observer
 * levels for the value transition or hit OK to leave them as-is.
 *
 * Multi-field commits (multiple tracked values touched in one save)
 * surface as paginated pages — Next / Prev / counter chrome appears
 * only when there's more than one page; single-page commits show a
 * clean OK-only footer.
 *
 * The modal header carries a small toggle that flips the story-level
 * `awareness_rollover_check_enabled` flag directly, giving the writer
 * an in-place escape hatch without hunting through Story Settings.
 *
 * Writes are deferred until OK on the LAST page; the modal accumulates
 * per-page draft edits and commits them atomically through
 * `commitAwarenessAtAnchor` when the writer confirms.
 */

import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import AwarenessPicker from '../entities/AwarenessPicker'
import ToggleInput from './ToggleInput'
import { EntityAvatar } from './IdentityBadges'

export default function AwarenessRolloverModal() {
  const modal = useUiStore((s) => s.awarenessRolloverModal)
  const setDraft = useUiStore((s) => s.setAwarenessRolloverDraft)
  const setPage = useUiStore((s) => s.setAwarenessRolloverPage)
  const close = useUiStore((s) => s.closeAwarenessRolloverModal)
  const updateStorySettings = useProjectStore((s) => s.updateStorySettings)
  const story = useProjectStore((s) => s.story)
  const commitAwarenessAtAnchor = useProjectStore((s) => s.commitAwarenessAtAnchor)
  const characters  = useEntitiesStore((s) => s.characters)
  const locations_  = useEntitiesStore((s) => s.locations)
  const items_      = useEntitiesStore((s) => s.items)
  const factions_   = useEntitiesStore((s) => s.factions)
  const customs_    = useEntitiesStore((s) => s.customs)

  if (!modal) return null
  const pages = modal.pages || []
  if (pages.length === 0) return null
  const idx = modal.currentPageIdx || 0
  const page = pages[idx]
  if (!page) return null

  const total = pages.length
  const isFirst = idx === 0
  const isLast = idx === total - 1

  // Surface kind drives the picker's surface prop. The picker needs to
  // know which level scale + label set to use.
  const surfaceForPicker = (() => {
    const k = page.target?.kind
    if (k === 'entity_name') return 'entity_name'
    if (k === 'attribute')   return 'attribute'
    if (k === 'alias')       return 'alias'
    if (k === 'relationship') return 'relationship'
    if (k === 'knowledge')   return 'knowledge'
    return 'entity'
  })()

  // Parent entity id for the picker's "Add observer" exclusion list.
  const parentEntityIdForPicker = page.target?.entityId || null

  const trackingEnabled = story?.awareness_rollover_check_enabled !== false

  function handlePickerChange(next) {
    setDraft(idx, next)
  }

  function handleToggleStorySetting(next) {
    updateStorySettings({ awareness_rollover_check_enabled: !!next })
  }

  function handleNext() {
    setPage(idx + 1)
  }

  function handlePrev() {
    setPage(idx - 1)
  }

  function handleOK() {
    // Commit each page's draft at its anchor. Untouched drafts (draft
    // === priorWrapper) write nothing — commitAwarenessAtAnchor's
    // chain branch already no-ops when the diff is empty.
    for (const p of pages) {
      try {
        commitAwarenessAtAnchor({
          target: p.target,
          anchor: p.anchor,
          draft: p.draft,
        })
      } catch { /* never trap a single page failure */ }
    }
    close()
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) close() }}
    >
      <div
        className="bg-zinc-800 border border-zinc-600 rounded-lg shadow-2xl w-[480px] max-w-[92vw] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        data-help-region="awareness-rollover:modal"
      >
        {/* Header — title + escape toggle */}
        <div className="px-4 py-3 border-b border-zinc-700 flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">
              {page.fieldLabel} has awareness tracking
            </h2>
            <p className="text-[11px] text-zinc-500 mt-1 leading-snug">
              If needed adjust the awareness for your change.
            </p>
          </div>
          <div
            className="flex flex-col items-end gap-1 flex-shrink-0"
            title="When ON, this prompt opens whenever you commit a chain-anchor change to a value whose awareness layer has tracking enabled (with at least one observer). Turn OFF to commit silently. Your tracking data is preserved either way. You can turn it back on under Story Settings, Awareness checks."
            data-help-region="awareness-rollover:show_checks_toggle"
          >
            <span className="text-[9px] text-zinc-500 uppercase tracking-wider">Show Awareness checks</span>
            <ToggleInput
              value={trackingEnabled}
              defaultValue={true}
              onLabel="On"
              offLabel="Off"
              onCommit={handleToggleStorySetting}
            />
          </div>
        </div>

        {/* Body — value-transition reminder + AwarenessPicker */}
        <div className="p-4 space-y-3">
          {/* Value transition: a small "Was → Now" line above the
              picker so the writer can see exactly what change they're
              being asked about. Either side may be null when the field
              has no prior override at this anchor (inherited from
              upstream); the renderer falls back to a muted "(none)"
              marker so the slot isn't visually empty. */}
          <div className="text-[11px] text-zinc-300 bg-zinc-900/50 border border-zinc-700 rounded px-2.5 py-2 flex flex-col gap-1" data-help-region="awareness-rollover:value_transition">
            {/* Field heading: when the target is bound to an entity,
                show that entity as a small avatar+name badge so the
                writer sees whose field this is, then the field label. */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {(() => {
                const eid = page.target?.entityId
                if (!eid) return null
                const allEnts = [...characters, ...locations_, ...items_, ...factions_, ...customs_]
                const ent = allEnts.find((e) => e.id === eid)
                if (!ent) return null
                return (
                  <span className="inline-flex items-center gap-1.5">
                    <EntityAvatar entity={ent} size={22} />
                    <span className="text-sm font-medium" style={{ color: ent.colour || '#888888' }}>{ent.name}</span>
                    <span className="text-sm text-zinc-500">'s</span>
                  </span>
                )
              })()}
              <span className="text-zinc-100 text-sm font-medium">{page.fieldLabel}</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-zinc-500">Was:</span>
              {page.oldValue == null || page.oldValue === ''
                ? <span className="text-zinc-600 italic">(none)</span>
                : <span className="text-zinc-200 break-all">{String(page.oldValue)}</span>
              }
              <span className="text-zinc-500">→</span>
              <span className="text-zinc-500">Now:</span>
              {page.newValue == null || page.newValue === ''
                ? <span className="text-zinc-600 italic">(none)</span>
                : <span className="text-zinc-200 break-all">{String(page.newValue)}</span>
              }
            </div>
          </div>
          <AwarenessPicker
            value={page.draft}
            onChange={handlePickerChange}
            surface={surfaceForPicker}
            mode="groups"
            parentEntityId={parentEntityIdForPicker}
            hideToggleRow
            chipSize="lg"
          />
        </div>

        {/* Footer — Prev / Next / OK + counter when N > 1 */}
        <div className="px-4 py-3 border-t border-zinc-700 flex items-center justify-between gap-2" data-help-region="awareness-rollover:footer">
          <div className="text-[11px] text-zinc-500">
            {total > 1 && (
              <span>{idx + 1} / {total}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {total > 1 && !isFirst && (
              <button
                onClick={handlePrev}
                className="px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100 border border-zinc-600 rounded hover:bg-zinc-700"
              >
                ← Prev
              </button>
            )}
            {!isLast ? (
              <button
                onClick={handleNext}
                className="px-3 py-1.5 text-xs bg-accent-700 hover:bg-accent-600 text-white rounded"
              >
                Next →
              </button>
            ) : (
              <button
                onClick={handleOK}
                className="px-4 py-1.5 text-xs bg-accent-700 hover:bg-accent-600 text-white rounded"
              >
                OK
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
