import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { confirm } from '../../store/dialogStore'

/**
 * Shared import-preview dialog for both Story Seeds and Default
 * Seeds. Renders a backend `build_import_preview` response with a
 * checkbox-per-item selection UI, a preset-list conflict warning,
 * and a Replace / Append / Cancel action bar. When the user picks
 * Replace and the target isn't empty, a second destructive confirm
 * is shown before the apply is fired.
 *
 * Props:
 *   filename      — original file name shown in the header
 *   preview       — JSON from the backend: {version, stubs: {char|loc|item|faction|custom: [...]}, preset_lists: [...], target_is_empty}
 *   scopeLabel    — 'Story' or 'Default' — used in copy and the Replace confirm
 *   onApply(mode, selection) — called when the user clicks Replace or Append (after the destructive confirm, if applicable)
 *   onCancel()    — called on Cancel, backdrop click, ✕, or Escape
 */

const BUCKET_LABELS = {
  character: 'Characters',
  location:  'Locations',
  item:      'Items',
  faction:   'Factions',
  custom:    'Custom',
  knowledge: 'Knowledge',
}
const BUCKET_ORDER = ['character', 'location', 'item', 'faction', 'custom', 'knowledge']

export default function SeedsImportDialog({ filename, preview, scopeLabel, onApply, onCancel }) {
  const [stubSel, setStubSel] = useState({})
  const [plSel, setPlSel]     = useState(new Set())

  // Re-initialise selection state each time a new preview is loaded:
  // all stubs checked, all preset lists EXCEPT conflicts checked (so
  // the default Apply behaviour matches what the backend would do
  // with a full-include selection — conflicts skipped). Deferred
  // via setTimeout(0) so the setState doesn't fire synchronously
  // inside the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!preview) return undefined
    const t = setTimeout(() => {
      const nextStub = {}
      for (const b of BUCKET_ORDER) {
        const rows = preview.stubs?.[b] || []
        nextStub[b] = new Set(rows.map((_r, i) => i))
      }
      setStubSel(nextStub)
      const pls = new Set()
      ;(preview.preset_lists || []).forEach((pl, i) => {
        if (pl.match_type !== 'conflict') pls.add(i)
      })
      setPlSel(pls)
    }, 0)
    return () => clearTimeout(t)
  }, [preview])

  // Close on Escape.
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  if (!preview) return null

  const totalStubs = BUCKET_ORDER.reduce(
    (acc, b) => acc + (preview.stubs?.[b]?.length || 0), 0,
  )
  const totalPl = (preview.preset_lists || []).length

  function toggleStub(bucket, index) {
    setStubSel((prev) => {
      const next = { ...prev, [bucket]: new Set(prev[bucket]) }
      if (next[bucket].has(index)) next[bucket].delete(index)
      else next[bucket].add(index)
      return next
    })
  }
  function togglePl(index, matchType) {
    if (matchType === 'conflict') return  // always skipped — disabled
    setPlSel((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }
  function buildSelection() {
    return {
      stubs: Object.fromEntries(
        BUCKET_ORDER.map((b) => [b, Array.from(stubSel[b] || new Set())]),
      ),
      preset_lists: Array.from(plSel),
    }
  }

  async function handleReplace() {
    const sel = buildSelection()
    if (!preview.target_is_empty) {
      const result = await confirm({
        title: `Replace existing ${scopeLabel.toLowerCase()} seeds?`,
        message:
          `Your current ${scopeLabel.toLowerCase()} seeds have content that will be ` +
          `overwritten by the imported selection. Any stubs you had are discarded. ` +
          `This can't be undone — save a backup first if you need one.`,
        buttons: [
          { label: 'Replace',  value: 'replace', style: 'danger'  },
          { label: 'Cancel',   value: 'cancel',  style: 'neutral' },
        ],
      })
      if (result !== 'replace') return
    }
    onApply('replace', sel)
  }
  function handleAppend() {
    onApply('append', buildSelection())
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      data-nested-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
      // Stop mousedown from bubbling up to document — otherwise the
      // SettingsPanel's click-outside listener (which lives at
      // document level and fires on mousedown) treats clicks on this
      // portal-rendered dialog as "outside the settings panel" and
      // closes it, unmounting the tab mid-import.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div data-help-region="seeds-import:modal" className="bg-zinc-800 border border-zinc-600 rounded-lg shadow-2xl w-[640px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div data-help-region="seeds-import:header" className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 flex-shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">
              Import {scopeLabel} Seeds
            </h2>
            <div className="text-[11px] text-zinc-500 mt-0.5 truncate" title={filename}>
              {filename} &middot; {totalStubs} stub{totalStubs !== 1 ? 's' : ''}, {totalPl} preset list{totalPl !== 1 ? 's' : ''}
            </div>
          </div>
          <button
            onClick={onCancel}
            className="text-zinc-400 hover:text-zinc-200"
            title="Cancel"
            aria-label="Cancel import"
          >✕</button>
        </div>

        {/* Body */}
        <div data-help-region="seeds-import:body" className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-xs">
          <p className="text-zinc-400 leading-relaxed">
            Uncheck anything you don&apos;t want to bring in. Conflict preset
            lists (same name, different values) are skipped — rename or
            remove the existing list in the target first if you want to
            import the incoming one.
          </p>

          {/* Stub sections */}
          {BUCKET_ORDER.map((bucket) => {
            const rows = preview.stubs?.[bucket] || []
            if (rows.length === 0) return null
            const bucketSet = stubSel[bucket] || new Set()
            return (
              <section key={bucket} data-help-region="seeds-import:stub_section" className="space-y-1">
                <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                  {BUCKET_LABELS[bucket]} &middot; {rows.length}
                </div>
                <div className="space-y-0.5 pl-1">
                  {rows.map((row) => (
                    <label
                      key={row.index}
                      data-help-region="seeds-import:stub_row"
                      className="flex items-center gap-2 py-0.5 cursor-pointer hover:bg-zinc-700/40 rounded px-1"
                    >
                      <input
                        type="checkbox"
                        checked={bucketSet.has(row.index)}
                        onChange={() => toggleStub(bucket, row.index)}
                        className="cursor-pointer"
                      />
                      <span className="text-zinc-200">{row.name || <em className="text-zinc-500">(unnamed)</em>}</span>
                      <span className="text-[10px] text-zinc-500">{row.attribute_type}</span>
                      {row.attribute_type === 'preset' && row.preset_list_name && (
                        <span className="text-[10px] text-accent-400">→ {row.preset_list_name}</span>
                      )}
                      {row.default_value != null && row.default_value !== '' && (
                        <span className="text-[10px] text-zinc-500 truncate">= {row.default_value}</span>
                      )}
                    </label>
                  ))}
                </div>
              </section>
            )
          })}

          {/* Preset-list section */}
          {(preview.preset_lists || []).length > 0 && (
            <section data-help-region="seeds-import:preset_list_section" className="space-y-1">
              <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                Preset lists &middot; {preview.preset_lists.length}
              </div>
              <div className="space-y-0.5 pl-1">
                {preview.preset_lists.map((pl) => {
                  const isConflict = pl.match_type === 'conflict'
                  return (
                    <div key={pl.index} data-help-region="seeds-import:preset_list_row" className={`px-1 py-0.5 rounded ${isConflict ? 'bg-red-900/20' : 'hover:bg-zinc-700/40'}`}>
                      <label className={`flex items-center gap-2 py-0.5 ${isConflict ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                        <input
                          type="checkbox"
                          checked={plSel.has(pl.index) && !isConflict}
                          disabled={isConflict}
                          onChange={() => togglePl(pl.index, pl.match_type)}
                          className={isConflict ? 'cursor-not-allowed' : 'cursor-pointer'}
                        />
                        <span className={`${isConflict ? 'text-zinc-500' : 'text-zinc-200'}`}>{pl.name}</span>
                        <MatchBadge matchType={pl.match_type} />
                        <span className="text-[10px] text-zinc-500 truncate">
                          {pl.values.length} value{pl.values.length !== 1 ? 's' : ''}: {pl.values.slice(0, 5).join(', ')}{pl.values.length > 5 ? '…' : ''}
                        </span>
                      </label>
                      {isConflict && pl.existing_values && (
                        <div className="ml-6 mt-0.5 text-[10px] text-red-300">
                          Existing: {pl.existing_values.slice(0, 6).join(', ')}{pl.existing_values.length > 6 ? '…' : ''}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </div>

        {/* Footer */}
        <div data-help-region="seeds-import:footer" className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-700 flex-shrink-0">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100 rounded border border-zinc-600 hover:border-zinc-500"
          >
            Cancel
          </button>
          <button
            data-help-region="seeds-import:append"
            onClick={handleAppend}
            className="px-3 py-1.5 text-xs rounded border border-zinc-600 text-zinc-200 hover:bg-zinc-700"
            title="Add selected items on top of your existing seeds"
          >
            Append
          </button>
          <button
            data-help-region="seeds-import:replace"
            onClick={handleReplace}
            className="px-3 py-1.5 text-xs rounded bg-accent-700 hover:bg-accent-600 text-white"
            title="Replace your current seeds with the selected items"
          >
            Replace
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function MatchBadge({ matchType }) {
  if (matchType === 'new') {
    return <span className="text-[9px] font-semibold uppercase tracking-wider text-green-400 bg-green-900/30 px-1 py-0.5 rounded">new</span>
  }
  if (matchType === 'identical') {
    return <span className="text-[9px] font-semibold uppercase tracking-wider text-zinc-400 bg-zinc-700/50 px-1 py-0.5 rounded">identical</span>
  }
  if (matchType === 'conflict') {
    return <span className="text-[9px] font-semibold uppercase tracking-wider text-red-300 bg-red-900/40 px-1 py-0.5 rounded">conflict</span>
  }
  return null
}
