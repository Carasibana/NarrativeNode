/**
 * Story Seeds tab — edits THIS project's seeds (attribute stubs +
 * bundled preset lists inside its `.nnz`'s `seeds.json`). Fetches on
 * mount via GET /api/project/seeds, commits via PUT.
 *
 * Saving here updates backend session state AND marks the project
 * dirty — seeds live inside the `.nnz`, so a seeds edit is a project
 * change and the header Save button needs to reflect that. The actual
 * write to disk happens when the user saves the project normally.
 *
 * Draft / server-snapshot pattern: keep two copies, compare for dirty
 * state, offer Revert to discard local changes, Save to commit. The
 * Settings panel's close / Escape / click-outside behaviours are
 * owned by `SettingsPanel`; this tab only worries about its own
 * Save / Revert affordances.
 *
 * Scope: per-story. Travels with the `.nnz`. Separate from
 * `DefaultSeedsTab` (template for new projects, persisted at
 * `preferences/default_seeds.json`) — same editor component, different
 * save target.
 */
import axios from 'axios'
import { useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../../../store/projectStore'
import { useEntitiesStore } from '../../../store/entitiesStore'
import { useUiStore } from '../../../store/uiStore'
import SeedsEditor from '../../seeds/SeedsEditor'
import SeedsImportDialog from '../../seeds/SeedsImportDialog'

// Shape returned by an empty-seeds project / a fresh SeedsFile. Used
// as the initial state before the mount-time GET resolves.
function emptySeeds() {
  return {
    version: '0.1.14.0',
    seeds: { character: [], location: [], item: [], faction: [], custom: [] },
    preset_lists: [],
  }
}

// Lightweight deep equality for detecting dirty state. SeedsFile is
// small + plain (strings / arrays / primitives), so JSON stringify
// compare is cheap and avoids a lodash dependency.
function isEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

export default function StorySeedsTab() {
  const projectPresetLists = useEntitiesStore((s) => s.presetLists)

  // Server snapshot: the last known canonical state from the backend.
  // `null` until the initial GET resolves; gates the editor render so
  // the user doesn't briefly see empty seeds before real data loads.
  const [server, setServer] = useState(null)
  const [draft, setDraft]   = useState(emptySeeds())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [savedRecently, setSavedRecently] = useState(false)
  const [fetchKey, setFetchKey] = useState(0)

  // Initial fetch — re-runs when fetchKey increments (Retry button)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    axios
      .get('/api/project/seeds')
      .then(({ data }) => {
        if (cancelled) return
        const normalised = { ...emptySeeds(), ...(data || {}) }
        normalised.seeds = { ...emptySeeds().seeds, ...(data?.seeds || {}) }
        normalised.preset_lists = data?.preset_lists || []
        setServer(normalised)
        setDraft(normalised)
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(err?.response?.data?.detail || err.message || 'Failed to load seeds')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [fetchKey])

  // Clear the "Saved ✓" flash after a short delay. Ref-held timeout
  // so a rapid second save cancels the first flash cleanly.
  const savedFlashTimeoutRef = useRef(null)
  useEffect(() => () => clearTimeout(savedFlashTimeoutRef.current), [])

  async function handleSave() {
    setSaving(true)
    try {
      // Response body is { seeds, project_preset_lists }. Backend may
      // have promoted bundled preset lists from the seeds into the
      // project's `story.preset_lists`; we refresh our local copy so
      // the picker + Entity Library reflect the new project state in
      // one round-trip.
      const { data } = await axios.put('/api/project/seeds', draft)
      const seedsData = data?.seeds || {}
      const normalised = { ...emptySeeds(), ...seedsData }
      normalised.seeds = { ...emptySeeds().seeds, ...(seedsData.seeds || {}) }
      normalised.preset_lists = seedsData.preset_lists || []
      setServer(normalised)
      setDraft(normalised)
      if (Array.isArray(data?.project_preset_lists)) {
        useEntitiesStore.getState().setPresetLists(data.project_preset_lists)
      }
      // Seeds are part of the .nnz, so a seeds edit is a project
      // change — light up the header Save button.
      useProjectStore.getState().markUnsaved()
      setSavedRecently(true)
      clearTimeout(savedFlashTimeoutRef.current)
      savedFlashTimeoutRef.current = setTimeout(() => setSavedRecently(false), 2000)
    } catch (err) {
      setLoadError(err?.response?.data?.detail || err.message || 'Failed to save seeds')
    } finally {
      setSaving(false)
    }
  }

  function handleRevert() {
    if (server) setDraft(server)
  }

  // Pull the store action at the top of the component body would
  // require a re-render; call getState() at click-time instead. Fire-
  // and-forget — the action surfaces its own user-visible error via
  // projectStore.error when it fails.
  function handleExport() {
    useProjectStore.getState().exportStorySeeds()
  }

  // ── Import flow ──────────────────────────────────────────────
  // A hidden <input type="file"> is click()'d by the Import button;
  // its onChange uploads the file for a preview, and the returned
  // preview drives the SeedsImportDialog. The dialog then calls back
  // with (mode, selection) which fires the apply. We hold the File
  // object between the two calls so the dialog doesn't have to know
  // about it.
  const importInputRef = useRef(null)
  const pendingImportFileRef = useRef(null)
  const [importPreview, setImportPreview] = useState(null)
  const [importFilename, setImportFilename] = useState('')

  function handleImportClick() {
    importInputRef.current?.click()
  }

  // Respond to a one-shot "please open the import picker" request
  // from the toolbar Import/Export menu. The menu sets uiStore's
  // pendingStorySeedsAction to 'import' and also opens this tab;
  // when the tab mounts / this effect sees the flag, we fire the
  // file picker and immediately clear the flag so a subsequent open
  // of the Settings panel doesn't retrigger.
  const pendingAction = useUiStore((s) => s.pendingStorySeedsAction)
  useEffect(() => {
    if (pendingAction === 'import') {
      useUiStore.getState().clearPendingStorySeedsAction()
      handleImportClick()
    }
  }, [pendingAction])

  async function handleFileChosen(e) {
    const file = e.target.files?.[0]
    e.target.value = ''  // allow re-picking the same file later
    if (!file) return
    pendingImportFileRef.current = file
    setImportFilename(file.name)
    try {
      const preview = await useProjectStore.getState().previewSeedsImport(file, 'story')
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
      await useProjectStore.getState().applySeedsImport(file, 'story', mode, selection)
      // Refetch from the server so the editor reflects the merged state.
      const { data } = await axios.get('/api/project/seeds')
      const normalised = { ...emptySeeds(), ...(data || {}) }
      normalised.seeds = { ...emptySeeds().seeds, ...(data?.seeds || {}) }
      normalised.preset_lists = data?.preset_lists || []
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

        {loading && <div className="text-xs text-zinc-500">Loading seeds…</div>}
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
            projectPresetLists={projectPresetLists}
          />
        )}
      </div>

      {/* Hidden file input driven by the Import button. Accepts both
          `.json` (standalone seeds) and `.nnz` (extracts seeds.json
          from the project archive). */}
      <input
        ref={importInputRef}
        type="file"
        accept=".json,.nnz,.nnplot,application/json"
        style={{ display: 'none' }}
        onChange={handleFileChosen}
      />

      {/* Import preview + granular-selection dialog. Mounts via portal
          from the component itself; appears above the Settings panel
          when preview data is present. */}
      {importPreview && (
        <SeedsImportDialog
          filename={importFilename}
          preview={importPreview}
          scopeLabel="Story"
          onApply={handleImportApply}
          onCancel={handleImportCancel}
        />
      )}

      {/* Footer */}
      <div data-help-region="settings:story_seeds_footer" className="flex items-center justify-between gap-2 px-4 py-3 border-t border-zinc-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={handleImportClick}
            disabled={dirty}
            data-help-region="settings:story_seeds_import"
            className="px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100 border border-zinc-600 hover:border-zinc-500 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title={dirty ? 'Save or revert your unsaved changes before importing.' : 'Import seeds from a .json or .nnz file'}
          >
            Import…
          </button>
          <button
            onClick={handleExport}
            data-help-region="settings:story_seeds_export"
            className="px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100 border border-zinc-600 hover:border-zinc-500 rounded"
            title="Export these seeds to a standalone .json file"
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
            data-help-region="settings:story_seeds_revert"
            className="px-4 py-1.5 text-sm text-zinc-300 hover:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Revert
          </button>
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            data-help-region="settings:story_seeds_save"
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
    <div data-help-region="settings:story_seeds_scope_banner" className="rounded border border-accent-700/50 bg-accent-900/20 px-3 py-2 text-[11px] text-accent-200 space-y-1.5">
      <div>
        <span className="font-semibold">This story only.</span>{' '}
        Define attributes and preset lists here and they&apos;ll be
        automatically added to every <span className="font-semibold">new</span>{' '}
        entity you create in this project. Good for baseline attributes
        specific to this story&apos;s world — e.g. a &quot;Mana Type&quot;
        attribute on every Character in a fantasy novel, or a
        &quot;Faction&quot; attribute on every Location in a political
        thriller.
      </div>
      <div>
        These seeds travel with the project: save this story as a
        <code className="mx-1 px-1 py-0.5 bg-zinc-900/60 rounded">.nnz</code>
        and anyone who opens it will get the same entity defaults.
      </div>
    </div>
  )
}
