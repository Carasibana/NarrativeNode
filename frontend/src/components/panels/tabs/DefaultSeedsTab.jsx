/**
 * Default Seeds tab — edits `preferences/default_seeds.json` (the
 * user-level seeds template). Fetches on mount via GET
 * /api/settings/default-seeds, commits via PUT.
 *
 * Scope: machine-local, outside any project. Default seeds act as a
 * one-shot template — contents are copied into a new project's own
 * `seeds.json` at project-creation time (wiring lands in a later
 * commit). Edits here don't affect existing projects; they don't
 * mark the currently-open project dirty either.
 *
 * Separate from `StorySeedsTab` (which edits THIS project's seeds).
 * Both tabs use the shared `SeedsEditor` component; Default Seeds
 * passes an empty `projectPresetLists` array since there's no project
 * context here — bundled preset lists inside the seeds file itself
 * are the sole source of preset lists for preset-type stubs.
 */
import axios from 'axios'
import { useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../../../store/projectStore'
import SeedsEditor from '../../seeds/SeedsEditor'
import SeedsImportDialog from '../../seeds/SeedsImportDialog'

// Shape returned by a blank default seeds file. Used as the initial
// state before the mount-time GET resolves, and as the "empty
// template" after the user clears every stub + bundled list.
// Intentionally duplicated from StorySeedsTab rather than shared —
// the two tabs will diverge in minor ways (footers, banners, save
// semantics) and a shared helper would accumulate conditionals.
function emptySeeds() {
  return {
    version: '0.1.14.0',
    seeds: { character: [], location: [], item: [], faction: [], custom: [] },
    preset_lists: [],
  }
}

function isEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

// Guarantee all expected bucket keys are present on the returned
// seeds object, regardless of what the backend sends. Same helper
// pattern used in StorySeedsTab — keeps the editor's iteration over
// `seeds.character`, `seeds.location`, etc. null-safe.
function normalise(data) {
  const empty = emptySeeds()
  const out = { ...empty, ...(data || {}) }
  out.seeds = { ...empty.seeds, ...(data?.seeds || {}) }
  out.preset_lists = data?.preset_lists || []
  return out
}


export default function DefaultSeedsTab() {
  // Server snapshot + local draft. Same pattern as StorySeedsTab
  // (draft / revert / dirty-flag) — explained in detail there; not
  // repeating the rationale here.
  const [server, setServer] = useState(null)
  const [draft, setDraft]   = useState(emptySeeds())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [savedRecently, setSavedRecently] = useState(false)
  const [fetchKey, setFetchKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    axios
      .get('/api/settings/default-seeds')
      .then(({ data }) => {
        if (cancelled) return
        const normalised = normalise(data)
        setServer(normalised)
        setDraft(normalised)
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(err?.response?.data?.detail || err.message || 'Failed to load default seeds')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [fetchKey])

  const savedFlashTimeoutRef = useRef(null)
  useEffect(() => () => clearTimeout(savedFlashTimeoutRef.current), [])

  async function handleSave() {
    setSaving(true)
    try {
      const { data } = await axios.put('/api/settings/default-seeds', draft)
      const normalised = normalise(data)
      setServer(normalised)
      setDraft(normalised)
      // Note: no `projectStore.hasUnsavedChanges = true` here. Default
      // seeds are NOT part of the currently-open project; they're a
      // separate file on disk. Saving here shouldn't light up the
      // header Save button.
      setSavedRecently(true)
      clearTimeout(savedFlashTimeoutRef.current)
      savedFlashTimeoutRef.current = setTimeout(() => setSavedRecently(false), 2000)
    } catch (err) {
      setLoadError(err?.response?.data?.detail || err.message || 'Failed to save default seeds')
    } finally {
      setSaving(false)
    }
  }

  function handleRevert() {
    if (server) setDraft(server)
  }

  // Export — fire-and-forget store action. Errors surface via
  // projectStore.error, same as exportStorySeeds.
  function handleExport() {
    useProjectStore.getState().exportDefaultSeeds()
  }

  // ── Import flow (same pattern as StorySeedsTab) ──────────────
  const importInputRef = useRef(null)
  const pendingImportFileRef = useRef(null)
  const [importPreview, setImportPreview] = useState(null)
  const [importFilename, setImportFilename] = useState('')

  function handleImportClick() {
    importInputRef.current?.click()
  }

  async function handleFileChosen(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    pendingImportFileRef.current = file
    setImportFilename(file.name)
    try {
      const preview = await useProjectStore.getState().previewSeedsImport(file, 'default')
      setImportPreview(preview)
    } catch (err) {
      setLoadError(err?.response?.data?.detail || err.message || 'Failed to read seeds from file')
      pendingImportFileRef.current = null
    }
  }

  async function handleImportApply(mode, selection) {
    const file = pendingImportFileRef.current
    if (!file) return
    try {
      await useProjectStore.getState().applySeedsImport(file, 'default', mode, selection)
      // Refetch from the default-seeds endpoint so the editor
      // reflects the merged state. Unlike the Story Seeds tab, we
      // don't need to refresh any project-level store — default
      // seeds are their own file on disk.
      const { data } = await axios.get('/api/settings/default-seeds')
      const normalised = normalise(data)
      setServer(normalised)
      setDraft(normalised)
      setSavedRecently(true)
      clearTimeout(savedFlashTimeoutRef.current)
      savedFlashTimeoutRef.current = setTimeout(() => setSavedRecently(false), 2000)
    } catch (err) {
      setLoadError(err?.response?.data?.detail || err.message || 'Import failed')
    } finally {
      setImportPreview(null)
      setImportFilename('')
      pendingImportFileRef.current = null
    }
  }

  function handleImportCancel() {
    setImportPreview(null)
    setImportFilename('')
    pendingImportFileRef.current = null
  }

  const dirty = !!server && !isEqual(draft, server)

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <ScopeBanner />

        {loading && <div className="text-xs text-zinc-500">Loading default seeds…</div>}
        {loadError && (
          <div className="rounded border border-red-700/50 bg-red-900/20 px-3 py-2 text-xs text-red-200 flex items-center justify-between gap-3">
            <span>{loadError}</span>
            <button
              onClick={() => setFetchKey((k) => k + 1)}
              className="flex-shrink-0 px-2 py-1 text-[11px] rounded border border-red-700/60 hover:bg-red-900/40 text-red-200"
            >Retry</button>
          </div>
        )}

        {!loading && !loadError && (
          <SeedsEditor
            value={draft}
            onChange={setDraft}
            // No project context at this layer — bundled preset lists
            // inside the seeds file itself are the sole source of
            // preset lists for the stub picker.
            projectPresetLists={[]}
          />
        )}
      </div>

      {/* Hidden file input driven by the Import button — same
          pattern as StorySeedsTab, scoped to 'default'. */}
      <input
        ref={importInputRef}
        type="file"
        accept=".json,.nnz,.nnplot,application/json"
        style={{ display: 'none' }}
        onChange={handleFileChosen}
      />
      {importPreview && (
        <SeedsImportDialog
          filename={importFilename}
          preview={importPreview}
          scopeLabel="Default"
          onApply={handleImportApply}
          onCancel={handleImportCancel}
        />
      )}

      {/* Footer — save / revert with dirty indicator + saved flash.
          Import/Export sit on the left so they read as file-system
          affordances, distinct from the Revert/Save draft controls. */}
      <div data-help-region="settings:default_seeds_footer" className="flex items-center justify-between gap-2 px-4 py-3 border-t border-zinc-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={handleImportClick}
            disabled={dirty}
            data-help-region="settings:default_seeds_import"
            className="px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100 border border-zinc-600 hover:border-zinc-500 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title={dirty ? 'Save or revert your unsaved changes before importing.' : 'Import default seeds from a .json or .nnz file'}
          >
            Import…
          </button>
          <button
            onClick={handleExport}
            data-help-region="settings:default_seeds_export"
            className="px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100 border border-zinc-600 hover:border-zinc-500 rounded"
            title="Export these default seeds to a standalone .json file"
          >
            Export…
          </button>
          <span className="text-xs text-zinc-500">
            {savedRecently && <span className="text-green-400">Saved ✓</span>}
            {!savedRecently && dirty && <span>Unsaved changes</span>}
          </span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleRevert}
            disabled={!dirty || saving}
            data-help-region="settings:default_seeds_revert"
            className="px-4 py-1.5 text-sm text-zinc-300 hover:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Revert
          </button>
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            data-help-region="settings:default_seeds_save"
            className="px-4 py-1.5 text-sm bg-accent-700 hover:bg-accent-600 text-white rounded disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}


function ScopeBanner() {
  return (
    <div data-help-region="settings:default_seeds_scope_banner" className="rounded border border-amber-700/50 bg-amber-900/20 px-3 py-2 text-[11px] text-amber-200 space-y-1.5">
      <div>
        <span className="font-semibold">Template for every new project.</span>{' '}
        Define attributes and preset lists here once and they&apos;ll be
        pre-populated on every <span className="font-semibold">new</span>{' '}
        project you make — so you don&apos;t have to re-add the same
        baseline fields to every story by hand. Good for things like an
        &quot;Age&quot; attribute you always want on new Characters, or a
        &quot;Climate&quot; attribute on new Locations.
      </div>
      <div>
        Existing projects aren&apos;t touched — these defaults only apply
        to projects you create <span className="font-semibold">after</span>{' '}
        your edits. To change seeds on a project that&apos;s already been
        made, open it and use the <span className="font-semibold">Story
        Seeds</span> tab.
      </div>
    </div>
  )
}
