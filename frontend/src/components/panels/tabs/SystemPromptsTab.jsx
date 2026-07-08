import { useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { useSettingsStore } from '../../../store/settingsStore'
import { useSystemPromptsStore } from '../../../store/systemPromptsStore'
import { confirm } from '../../../store/dialogStore'
import SettingsTabFooter from './SettingsTabFooter'
import SystemPromptEditModal from '../SystemPromptEditModal'
import PersonaPreambleSection from './PersonaPreambleSection'
import EntityColorPicker from '../../ui/EntityColorPicker'
import PopoverSectionRow from '../../ui/PopoverSectionRow'
import SystemPromptPickerList from '../../ui/SystemPromptPickerList'
import {
  importNovelcrafterPromptFromClipboard,
  copyNovelcrafterPromptToClipboard,
  stripHtmlForNcExport,
} from '../../../utils/novelcrafterPromptImport'
import { useContextCuesStore } from '../../../store/contextCuesStore'

/**
 * System Prompts tab — Phase 2.3e (Phase 2.10a items 2 + 3).
 *
 * Standalone Settings panel tab (between MCP & API Connections and
 * About) for managing named system-prompt templates AND the
 * categories that group them.
 *
 * Storage model:
 *   - Each prompt is its own JSON file under
 *     `system_prompts/{slug}__{id}.json` at the project root (or
 *     inside a category subfolder for grouped prompts).
 *   - Categories are plain-named subfolders under `system_prompts/`;
 *     the folder name IS the category identity. Optional
 *     `system_prompts/categories.json` maps category names to
 *     custom display colours.
 *   - `default_system_prompt_id` lives on `user_preferences.json`.
 *
 * UX model:
 *   - Categories use IMMEDIATE writes (create / rename / delete /
 *     colour-pick → backend → refetch). Filesystem operations don't
 *     fit the draft-pattern model cleanly.
 *   - Prompt edits use the standard DRAFT pattern (edits accumulate
 *     locally; Save commits the whole batch via `savePromptsDiff`).
 *   - Cancel discards prompt drafts; category changes are already
 *     persisted by then.
 */
function shallowEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

export default function SystemPromptsTab({ onClose, onDirtyChange, registerSave }) {
  const prefs           = useSettingsStore((s) => s.preferences)
  const updatePrefs     = useSettingsStore((s) => s.updatePreferences)

  const baselinePrompts = useSystemPromptsStore((s) => s.prompts)
  const loaded          = useSystemPromptsStore((s) => s.loaded)
  const loading         = useSystemPromptsStore((s) => s.loading)
  const loadError       = useSystemPromptsStore((s) => s.loadError)
  const loadPrompts     = useSystemPromptsStore((s) => s.loadPrompts)
  const savePromptsDiff = useSystemPromptsStore((s) => s.savePromptsDiff)

  const categories          = useSystemPromptsStore((s) => s.categories)
  const categoriesLoaded    = useSystemPromptsStore((s) => s.categoriesLoaded)
  const categoriesLoadError = useSystemPromptsStore((s) => s.categoriesLoadError)
  const loadCategories      = useSystemPromptsStore((s) => s.loadCategories)
  const createCategory      = useSystemPromptsStore((s) => s.createCategory)
  const renameCategory      = useSystemPromptsStore((s) => s.renameCategory)
  const deleteCategory      = useSystemPromptsStore((s) => s.deleteCategory)
  const setCategoryColour   = useSystemPromptsStore((s) => s.setCategoryColour)
  const moveSystemPrompt    = useSystemPromptsStore((s) => s.moveSystemPrompt)
  const duplicatePrompt     = useSystemPromptsStore((s) => s.duplicatePrompt)

  useEffect(() => { loadPrompts() }, [loadPrompts])
  useEffect(() => { loadCategories() }, [loadCategories])

  // Draft state mirrors the persisted baseline at mount / after Save.
  // All inline edits flow into this; nothing hits the backend until
  // the writer explicitly Saves.
  const [draftPrompts, setDraftPrompts]     = useState([])
  const [draftDefaultId, setDraftDefaultId] = useState(null)
  const [draftPerSurfacePrompts, setDraftPerSurfacePrompts] = useState({})
  const [saveError, setSaveError]           = useState(null)
  const [categoryError, setCategoryError]   = useState(null)
  const [ncImportStatus, setNcImportStatus] = useState(null)  // { kind: 'success'|'error', text } | null

  // Phase 3.11a — load the existing Context Cue library so the
  // "Paste a NovelCrafter prompt" handler can resolve bundled NC
  // snippets against existing cues by name. The store de-dupes
  // calls and only fetches once per session; calling it on mount
  // means the paste handler can read straight from in-memory state.
  const cueList = useContextCuesStore((s) => s.cues) || []
  const cueBodyLoadComplete = useContextCuesStore((s) => s.bodyLoadComplete)
  const loadCues = useContextCuesStore((s) => s.loadCues)
  useEffect(() => { loadCues?.() }, [loadCues])

  useEffect(() => {
    // Deep-copy so the writer's edits don't mutate the baseline.
    setDraftPrompts(baselinePrompts.map((p) => ({ ...p })))
  }, [baselinePrompts])
  useEffect(() => {
    setDraftDefaultId(prefs.default_system_prompt_id || null)
  }, [prefs.default_system_prompt_id])
  useEffect(() => {
    setDraftPerSurfacePrompts({ ...(prefs.default_prompts_per_surface || {}) })
  }, [prefs.default_prompts_per_surface])

  const isDirty = useMemo(() => {
    if (!shallowEqual(draftPrompts, baselinePrompts)) return true
    if (draftDefaultId !== (prefs.default_system_prompt_id || null)) return true
    if (!shallowEqual(draftPerSurfacePrompts, prefs.default_prompts_per_surface || {})) return true
    return false
  }, [draftPrompts, baselinePrompts, draftDefaultId, prefs.default_system_prompt_id, draftPerSurfacePrompts, prefs.default_prompts_per_surface])

  // Standard dirty-emit wiring (mirrors the other preference tabs).
  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => { onDirtyChangeRef.current = onDirtyChange }, [onDirtyChange])
  useEffect(() => { onDirtyChangeRef.current?.(isDirty) }, [isDirty])
  useEffect(() => () => onDirtyChangeRef.current?.(false), [])

  // commitDraft: apply prompt diffs + push the default pointer if
  // it changed. Returns true on success so handleSave can decide
  // whether to close the panel.
  async function commitDraft() {
    setSaveError(null)
    try {
      await savePromptsDiff(draftPrompts)
      const patch = {}
      if (draftDefaultId !== (prefs.default_system_prompt_id || null)) {
        patch.default_system_prompt_id = draftDefaultId
      }
      if (!shallowEqual(draftPerSurfacePrompts, prefs.default_prompts_per_surface || {})) {
        patch.default_prompts_per_surface = draftPerSurfacePrompts
        // The chat_panel slot mirrors to the legacy global per the
        // one-cycle backward-compat rule. Catch this here on the
        // batched save so the mirrored field stays in lockstep.
        if ((draftPerSurfacePrompts.chat_panel ?? null) !== (prefs.default_system_prompt_id ?? null)) {
          patch.default_system_prompt_id = draftPerSurfacePrompts.chat_panel ?? null
        }
      }
      if (Object.keys(patch).length > 0) {
        await updatePrefs(patch)
      }
      onDirtyChangeRef.current?.(false)
      return true
    } catch (err) {
      const detail = err?.response?.data?.detail
      setSaveError(typeof detail === 'string' ? detail : (err?.message || 'Failed to save system prompts'))
      return false
    }
  }

  // Register the "Save & continue" callback used by the parent's
  // unsaved-changes prompt when the writer switches tabs.
  const commitDraftRef = useRef(commitDraft)
  commitDraftRef.current = commitDraft
  const registerSaveRef = useRef(registerSave)
  useEffect(() => { registerSaveRef.current = registerSave }, [registerSave])
  useEffect(() => {
    registerSaveRef.current?.(() => commitDraftRef.current?.())
    return () => registerSaveRef.current?.(null)
  }, [])

  async function handleSave() {
    await commitDraft()
  }
  function handleCancel() {
    onDirtyChange?.(false)
    onClose?.()
  }

  // ── Category CRUD wrappers (immediate writes, error surfacing) ─
  async function handleCreateCategory(name, colour) {
    setCategoryError(null)
    try {
      await createCategory(name, colour)
    } catch (err) {
      const detail = err?.response?.data?.detail
      setCategoryError(typeof detail === 'string' ? detail : (err?.message || 'Failed to create category'))
      throw err
    }
  }
  async function handleRenameCategory(oldName, newName) {
    setCategoryError(null)
    try {
      await renameCategory(oldName, newName)
    } catch (err) {
      const detail = err?.response?.data?.detail
      setCategoryError(typeof detail === 'string' ? detail : (err?.message || 'Failed to rename category'))
      throw err
    }
  }
  async function handleDeleteCategory(name, promptCount) {
    setCategoryError(null)
    if (promptCount > 0) {
      const choice = await confirm({
        title: `Delete category "${name}"`,
        message: `This category contains ${promptCount} prompt${promptCount === 1 ? '' : 's'}. What should happen to them?`,
        buttons: [
          { label: 'Cancel', value: 'cancel', style: 'neutral' },
          { label: 'Move to Uncategorized', value: 'move', style: 'primary' },
          { label: 'Delete with category', value: 'delete', style: 'danger' },
        ],
      })
      if (choice === 'cancel' || choice === false) return
      try {
        await deleteCategory(name, { movePromptsToRoot: choice === 'move' })
      } catch (err) {
        const detail = err?.response?.data?.detail
        setCategoryError(typeof detail === 'string' ? detail : (err?.message || 'Failed to delete category'))
      }
      return
    }
    const ok = await confirm({
      title: `Delete category "${name}"`,
      message: `Delete the empty category "${name}"?`,
      buttons: [
        { label: 'Cancel', value: false, style: 'neutral' },
        { label: 'Delete', value: true,  style: 'danger' },
      ],
    })
    if (!ok) return
    try {
      await deleteCategory(name, { movePromptsToRoot: true })
    } catch (err) {
      const detail = err?.response?.data?.detail
      setCategoryError(typeof detail === 'string' ? detail : (err?.message || 'Failed to delete category'))
    }
  }
  async function handleSetColour(name, colour) {
    setCategoryError(null)
    try {
      await setCategoryColour(name, colour)
    } catch (err) {
      const detail = err?.response?.data?.detail
      setCategoryError(typeof detail === 'string' ? detail : (err?.message || 'Failed to update colour'))
    }
  }

  // ── Modal launch state ────────────────────────────────────────
  // Editing happens in the bespoke `<SystemPromptEditModal>` (Phase
  // 2.10a item 4). The Settings tab is now the launcher: click a
  // prompt row → opens the modal in edit mode; "Create new prompt"
  // → opens in create mode. The modal does immediate writes via
  // the REST endpoints (POST / PUT / DELETE), then refetches.
  const [modalState, setModalState] = useState(null)  // null | { mode, prompt }
  function openCreateModal() {
    setModalState({ mode: 'create', prompt: null })
  }
  function openEditModal(p) {
    setModalState({ mode: 'edit', prompt: p })
  }
  function closeModal() {
    setModalState(null)
  }

  async function handleModalSave(draftPrompt) {
    // POST if create, PUT if edit. Backend ignores the `category`
    // field on input — folder location is source of truth. In
    // create mode, if the writer picked a non-null category in the
    // modal's dropdown, follow up the POST with a move-to-category
    // call so the new file lands in the chosen folder (mirrors the
    // duplicatePrompt store action's two-step flow).
    if (modalState?.mode === 'create') {
      await axios.post('/api/system-prompts', draftPrompt)
      if (draftPrompt.category) {
        try {
          await axios.put(
            `/api/system-prompts/${encodeURIComponent(draftPrompt.id)}/category`,
            { category: draftPrompt.category },
          )
        } catch {
          // Partial-success: prompt exists at root. Refetch surfaces it.
        }
      }
    } else {
      await axios.put(`/api/system-prompts/${draftPrompt.id}`, draftPrompt)
    }
    await loadPrompts()
  }

  async function handleModalDelete(id) {
    await axios.delete(`/api/system-prompts/${id}`)
    if (draftDefaultId === id) {
      // Clear the local draft pointer too. If the user had set this
      // prompt as default and never saved, the tab's draft tracked
      // that intent locally — now that the prompt's gone, clear it.
      setDraftDefaultId(null)
    }
    await loadPrompts()
  }

  async function handlePasteNovelcrafterPrompt() {
    setNcImportStatus(null)
    try {
      const result = await importNovelcrafterPromptFromClipboard()
      const {
        draft,
        nc_type,
        removed_markers,
        translated_markers = 0,
        translated_kinds = [],
        components = [],
        unresolved_includes = [],
      } = result
      const typeLabel = nc_type ? ` (${nc_type})` : ''

      // Resolve bundled NC components against the existing Context
      // Cue library. Three outcomes per component:
      //   (1) name match + identical body → reuse existing cue.id,
      //       no warning. (Body compare only when the store has
      //       finished its background body-backfill phase; if
      //       bodies aren't loaded yet, we treat any name match
      //       as same-name-different-body so the writer double-
      //       checks. See contextCuesStore.bodyLoadComplete.)
      //   (2) name match + different body → reuse existing cue.id
      //       (per writer's rule: never overwrite an existing cue
      //       on import), warning surfaced.
      //   (3) no name match → mint a fresh UUID and stage the cue
      //       as draft state on the modal. The cue isn't written
      //       to disk until the writer hits "Create" in the modal.
      const stagedCues = []
      const reusedCueNames = []
      const collisionWarnings = []
      const allCueIds = [...(draft.static_cue_ids || [])]
      for (const comp of components) {
        const existing = (cueList || []).find((c) => c && typeof c.name === 'string' && c.name === comp.name)
        if (existing) {
          allCueIds.push(existing.id)
          if (cueBodyLoadComplete && (existing.body || '') === comp.body) {
            reusedCueNames.push(comp.name)
          } else {
            collisionWarnings.push(comp.name)
          }
        } else {
          const newId = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : `cue-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
          stagedCues.push({ id: newId, name: comp.name, body: comp.body })
          allCueIds.push(newId)
        }
      }

      // Dedupe cue id list while preserving order.
      const seenIds = new Set()
      const dedupedCueIds = []
      for (const id of allCueIds) {
        if (seenIds.has(id)) continue
        seenIds.add(id)
        dedupedCueIds.push(id)
      }

      const prefilledDraft = { ...draft, static_cue_ids: dedupedCueIds }

      // Build the success banner. Lead with the prompt name + NC
      // type, then summarise marker stripping, cue reuse + staging,
      // collisions, and unresolved snippet includes.
      const parts = [`Imported "${draft.name}"${typeLabel}.`]
      // Phase 3.11c — translator output lands BEFORE the marker-removal
      // count so the writer reads "12 markers translated to NN pills"
      // before the "5 unsupported markers removed" line. Translated
      // markers are the win; removed markers are the residual that
      // didn't have an analog.
      if (translated_markers > 0) {
        const kindsLabel = translated_kinds.length > 0
          ? ` (${translated_kinds.join(', ')})`
          : ''
        parts.push(translated_markers === 1
          ? `1 NovelCrafter marker translated into a NarrativeNode context pill${kindsLabel}.`
          : `${translated_markers} NovelCrafter markers translated into NarrativeNode context pills${kindsLabel}.`)
      }
      const totalMarkers = removed_markers
        + components.reduce((sum, c) => sum + (c.removed_markers || 0), 0)
      if (totalMarkers > 0) {
        parts.push(totalMarkers === 1
          ? '1 unsupported NovelCrafter marker removed.'
          : `${totalMarkers} unsupported NovelCrafter markers removed.`)
      }
      if (stagedCues.length > 0) {
        parts.push(stagedCues.length === 1
          ? `1 snippet staged as a new Context Cue ("${stagedCues[0].name}") — confirm by hitting Create in the editor.`
          : `${stagedCues.length} snippets staged as new Context Cues — confirm by hitting Create in the editor.`)
      }
      if (reusedCueNames.length > 0) {
        parts.push(reusedCueNames.length === 1
          ? `Reused existing Context Cue: "${reusedCueNames[0]}".`
          : `Reused ${reusedCueNames.length} existing Context Cues.`)
      }
      if (collisionWarnings.length > 0) {
        const list = collisionWarnings.map((n) => `"${n}"`).join(', ')
        parts.push(`Existing Context Cue${collisionWarnings.length === 1 ? '' : 's'} ${list} kept unchanged; bundled snippet content was NOT applied.`)
      }
      if (unresolved_includes.length > 0) {
        const list = unresolved_includes.map((n) => `"${n}"`).join(', ')
        parts.push(`Unresolved NovelCrafter snippet ${unresolved_includes.length === 1 ? 'reference' : 'references'} (content not in clipboard): ${list}.`)
      }

      setNcImportStatus({ kind: 'success', text: parts.join(' ') })
      setModalState({ mode: 'create', prompt: prefilledDraft, stagedCues })
    } catch (err) {
      setNcImportStatus({
        kind: 'error',
        text: err?.message || 'Couldn’t import the NovelCrafter prompt.',
      })
    }
  }

  /**
   * Phase 3.11b — Copy for NovelCrafter. Builds and writes a
   * `nc:prompt:1` clipboard blob from a prompt row's data + its
   * attached Context Cues. Reuses the same inline banner state as
   * the import/paste path (success or error message).
   *
   * @param {object} promptEntry  the prompt-row payload from the
   *                              draft prompts list. Carries
   *                              `static_cue_ids[]` for cue resolve.
   * @param {'self-contained'|'bundle'|'reference-only'} shape
   *                              Mirrors NC's three "clipboard
   *                              formats". `self-contained` inlines
   *                              cue bodies, `bundle` packages cues
   *                              as components, `reference-only`
   *                              leaves include markers unresolved.
   */
  async function handleCopyNovelcrafterPrompt(promptEntry, shape) {
    // Don't pre-clear the banner state — re-clicking the copy button
    // while a prior banner is still visible used to unmount the
    // banner (clear → reflow) then remount it (set → reflow),
    // causing the whole modal to jitter. Now we overwrite the
    // banner content in a single state update at the end of the
    // operation; the writer sees a clean replace instead of a
    // disappear-then-reappear.
    try {
      const attachedIds = Array.isArray(promptEntry?.static_cue_ids) ? promptEntry.static_cue_ids : []
      const attachedCues = []
      const missingCueIds = []
      for (const id of attachedIds) {
        const cue = (cueList || []).find((c) => c && c.id === id)
        if (!cue) { missingCueIds.push(id); continue }
        attachedCues.push({ name: cue.name || '', body: stripHtmlForNcExport(cue.body || '') })
      }
      const summary = await copyNovelcrafterPromptToClipboard(promptEntry, {
        shape,
        attachedCues,
        ncType: promptEntry?.category || null,
      })
      const shapeLabel = shape === 'bundle'
        ? 'bundle (with included Context Cues)'
        : shape === 'reference-only'
          ? 'reference-only (Context Cue references not resolved)'
          : 'self-contained (Context Cue content inlined)'
      const parts = [
        `Copied "${summary.prompt_name}" to clipboard as ${shapeLabel}.`,
        `NovelCrafter type field: "${summary.nc_type}".`,
      ]
      if (summary.cue_count > 0) {
        parts.push(`${summary.cue_count} Context Cue${summary.cue_count === 1 ? '' : 's'} included.`)
      }
      // Phase 3.11c #5 — surface NN pill → NC marker emission counts.
      // `emitted_marker_count` is the number of NN context_markers that
      // got an NC `{...}` equivalent written into the exported body.
      // `unsupported_marker_types` lists NN pill types that had no NC
      // analog and got dropped — the round-trip is lossy on those.
      if (summary.emitted_marker_count > 0) {
        parts.push(summary.emitted_marker_count === 1
          ? '1 NarrativeNode context pill emitted as a NovelCrafter marker in the prompt body.'
          : `${summary.emitted_marker_count} NarrativeNode context pills emitted as NovelCrafter markers in the prompt body.`)
      }
      if (Array.isArray(summary.unsupported_marker_types) && summary.unsupported_marker_types.length > 0) {
        const list = summary.unsupported_marker_types.join(', ')
        parts.push(`${summary.unsupported_marker_types.length} pill type${summary.unsupported_marker_types.length === 1 ? '' : 's'} had no NovelCrafter equivalent and were dropped: ${list}.`)
      }
      if (missingCueIds.length > 0) {
        parts.push(`${missingCueIds.length} attached cue id${missingCueIds.length === 1 ? '' : 's'} couldn't be resolved and were skipped.`)
      }
      setNcImportStatus({ kind: 'success', text: parts.join(' ') })
      return true
    } catch (err) {
      setNcImportStatus({
        kind: 'error',
        text: err?.message || 'Couldn’t copy the prompt to the clipboard.',
      })
      return false
    }
  }

  async function handleDuplicatePrompt(id) {
    // Immediate backend write — mirrors handleModalSave / handleModalDelete's
    // pattern. The draft-list pattern in this tab only governs the
    // per-surface default pointers + the legacy global default; per-
    // prompt CRUD goes straight to disk. The store action's reload
    // refreshes `baselinePrompts` which feeds the displayed list.
    try {
      setCategoryError(null)
      await duplicatePrompt(id)
    } catch (err) {
      setCategoryError(err?.response?.data?.detail || err?.message || 'Failed to duplicate prompt')
    }
  }

  // ── Group draft prompts by category for display ────────────────
  // Every group — including Uncategorized — is its own collapsible
  // section. Uncategorized only renders when there's at least one
  // prompt at the root of `system_prompts/`; a writer who's put
  // every prompt in a category doesn't see an empty Uncategorized
  // header taking up space.
  const UNCATEGORIZED_KEY = '__uncategorized__'
  const promptGroups = useMemo(() => {
    const byCategory = new Map()
    byCategory.set(null, [])
    for (const c of categories) byCategory.set(c.name, [])
    for (const p of draftPrompts) {
      const key = p.category || null
      if (!byCategory.has(key)) byCategory.set(key, [])
      byCategory.get(key).push(p)
    }
    const groups = []
    const uncategorized = byCategory.get(null) || []
    if (uncategorized.length > 0) {
      groups.push({ key: UNCATEGORIZED_KEY, name: null, colour: null, prompts: uncategorized })
    }
    for (const c of categories) {
      groups.push({ key: c.name, name: c.name, colour: c.colour, prompts: byCategory.get(c.name) || [] })
    }
    // Stray prompts whose `category` references a folder we don't
    // know about yet — surface them too so they're not invisible.
    for (const [key, prompts] of byCategory.entries()) {
      if (key === null) continue
      if (categories.find((c) => c.name === key)) continue
      groups.push({ key, name: key, colour: null, prompts, orphan: true })
    }
    return groups
  }, [draftPrompts, categories])

  // ── Collapse state — every group starts collapsed on first load ─
  // Stored by group.key so the Uncategorized sentinel + named
  // categories live in the same Set. On first load every visible
  // group is collapsed; subsequently, newly-appearing groups
  // (added category, prompts moved back to root) default to
  // collapsed too.
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set())
  const initializedCollapseRef = useRef(false)
  // Track every group key that has ever appeared in `promptGroups`
  // since mount. A group is "newly appeared" only if it's NOT in
  // this set. Without this ref, a previously-expanded group (which
  // is absent from `collapsedGroups`) was being misclassified as
  // "new" every time the prompt list refreshed, and got re-
  // collapsed — making any prompt-list refresh (e.g. after
  // duplicating a prompt) close the writer's open category.
  const seenGroupKeysRef = useRef(new Set())
  useEffect(() => {
    if (!categoriesLoaded || !loaded) return
    // Compute everything OUTSIDE the setState updater so the updater
    // is pure. React's StrictMode invokes state updaters twice in dev
    // and commits the SECOND call's result; if we mutated
    // `initializedCollapseRef` / `seenGroupKeysRef` inside the
    // updater, the first call's writes would contaminate the second
    // call (init flips to true, seenGroupKeysRef gets populated, the
    // replay hits the post-init branch with everything already
    // "seen" and returns an empty Set → every group renders expanded).
    const isFirstInit = !initializedCollapseRef.current
    const seenBefore = seenGroupKeysRef.current
    const newlyAppearedKeys = []
    for (const g of promptGroups) {
      if (!seenBefore.has(g.key)) newlyAppearedKeys.push(g.key)
    }
    const knownKeys = new Set(promptGroups.map((g) => g.key))
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (isFirstInit) {
        for (const g of promptGroups) next.add(g.key)
        return next
      }
      // Drop stale keys (groups that no longer exist).
      for (const key of prev) if (!knownKeys.has(key)) next.delete(key)
      // Collapse only groups we've never seen before. Previously-
      // expanded groups stay expanded.
      for (const key of newlyAppearedKeys) next.add(key)
      return next
    })
    // Mutate refs AFTER queueing the updater so the updater stays pure.
    if (isFirstInit) initializedCollapseRef.current = true
    for (const g of promptGroups) seenBefore.add(g.key)
  }, [categoriesLoaded, loaded, promptGroups])
  function toggleGroupCollapse(key) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        // Expanding this group — enforce single-expand (accordion)
        // by collapsing every OTHER known group. Pulls the full set
        // of known group keys from `seenGroupKeysRef` so empty
        // categories (which aren't in `promptGroups` but are still
        // rendered) collapse too. The previous code achieved single-
        // expand only as a side-effect of the post-mount collapse
        // effect re-running on every prompt-list change; making it
        // explicit here keeps single-expand stable across the v0.2.10.45
        // collapse-effect fix.
        for (const k of seenGroupKeysRef.current) {
          if (k !== key) next.add(k)
        }
        next.delete(key)
      } else {
        // Collapsing — just add this one.
        next.add(key)
      }
      return next
    })
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <ScopeBanner />

        {(loadError || categoriesLoadError) && (
          <div className="rounded border border-red-700/50 bg-red-900/20 px-3 py-2 text-xs text-red-200">
            {loadError && <div>Couldn&apos;t load system prompts: {loadError}</div>}
            {categoriesLoadError && <div>Couldn&apos;t load categories: {categoriesLoadError}</div>}
          </div>
        )}
        {saveError && (
          <div className="rounded border border-red-700/50 bg-red-900/20 px-3 py-2 text-xs text-red-200">
            Couldn&apos;t save: {saveError}
          </div>
        )}
        {categoryError && (
          <div className="rounded border border-red-700/50 bg-red-900/20 px-3 py-2 text-xs text-red-200">
            {categoryError}
          </div>
        )}
        {ncImportStatus && (
          <div
            className={
              ncImportStatus.kind === 'success'
                ? 'rounded border border-emerald-700/50 bg-emerald-900/20 px-3 py-2 text-xs text-emerald-200 flex items-start gap-2'
                : 'rounded border border-red-700/50 bg-red-900/20 px-3 py-2 text-xs text-red-200 flex items-start gap-2'
            }
          >
            <span className="flex-1">{ncImportStatus.text}</span>
            <button
              type="button"
              onClick={() => setNcImportStatus(null)}
              className="text-zinc-400 hover:text-zinc-100 transition-colors"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        {!loaded && !loadError && loading && (
          <div className="text-xs text-zinc-500">Loading system prompts…</div>
        )}

        {loaded && categoriesLoaded && (
          <section data-help-region="settings:system_prompts_list" className={sectionCls}>
            <header className={sectionHdrCls}>System Prompts</header>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              Named system-prompt templates, grouped by category. The default prompt is sent as the <code className="px-1 py-0.5 bg-zinc-700/60 rounded text-[10px]">system</code> role message at the start of every chat session; switching prompts mid-session takes effect on the next message only. Picking <span className="font-semibold">No system prompt</span> as the default skips the system-role message entirely. Categories are subfolders under <code className="px-1 py-0.5 bg-zinc-700/60 rounded text-[10px]">system_prompts/</code>; you can drag a prompt onto a category header to move it, or use the prompt&apos;s <span className="font-semibold">Move to&hellip;</span> menu.
            </p>

            {draftPrompts.length === 0 && categories.length === 0 ? (
              <div className="rounded border border-dashed border-zinc-700 bg-zinc-900/40 px-3 py-4 text-[11px] text-zinc-500 text-center">
                No system prompts or categories yet. Click <span className="font-semibold text-zinc-300">+ Add system prompt</span> or <span className="font-semibold text-zinc-300">+ Add category</span> to get started.
              </div>
            ) : (
              <div className="space-y-3">
                {promptGroups.map((g) => (
                  <PromptGroup
                    key={g.key}
                    group={g}
                    categories={categories}
                    collapsed={collapsedGroups.has(g.key)}
                    onToggleCollapse={() => toggleGroupCollapse(g.key)}
                    onEditPrompt={openEditModal}
                    onRenameCategory={handleRenameCategory}
                    onDeleteCategory={handleDeleteCategory}
                    onSetCategoryColour={handleSetColour}
                    onMovePrompt={moveSystemPrompt}
                    onDuplicatePrompt={handleDuplicatePrompt}
                    onCopyForNc={handleCopyNovelcrafterPrompt}
                    cueList={cueList}
                  />
                ))}
                {/* Empty categories with no prompts yet — show them too so
                    they're not invisible until a prompt is dropped in. */}
                {categories.filter((c) => !promptGroups.find((g) => g.key === c.name)).map((c) => {
                  const group = { key: c.name, name: c.name, colour: c.colour, prompts: [] }
                  return (
                    <PromptGroup
                      key={c.name}
                      group={group}
                      categories={categories}
                      collapsed={collapsedGroups.has(c.name)}
                      onToggleCollapse={() => toggleGroupCollapse(c.name)}
                      onEditPrompt={openEditModal}
                      defaultId={draftDefaultId}
                      onSetDefault={setDraftDefaultId}
                      onRenameCategory={handleRenameCategory}
                      onDeleteCategory={handleDeleteCategory}
                      onSetCategoryColour={handleSetColour}
                      onMovePrompt={moveSystemPrompt}
                    />
                  )
                })}
              </div>
            )}

            <div className="flex items-center gap-3 pt-1 flex-wrap">
              <button
                type="button"
                onClick={openCreateModal}
                data-help-region="settings:system_prompts_add"
                className="px-3 py-1.5 text-xs bg-accent-700 hover:bg-accent-600 text-white rounded transition-colors"
              >
                + Add system prompt
              </button>
              <button
                type="button"
                onClick={handlePasteNovelcrafterPrompt}
                title="Paste a prompt copied from NarrativeNode, or NovelCrafter."
                data-help-region="settings:system_prompts_paste"
                className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded transition-colors"
              >
                Paste a prompt
              </button>
              <AddCategoryInline onCreate={handleCreateCategory} />
              <DefaultSystemPromptPicker
                prompts={draftPrompts}
                value={draftDefaultId}
                onChange={(v) => setDraftDefaultId(v)}
              />
            </div>
          </section>
        )}

        {loaded && categoriesLoaded && (
          <DefaultPromptPerSurfaceSection
            prompts={baselinePrompts}
            categories={categories}
            draftPerSurface={draftPerSurfacePrompts}
            setDraftPerSurface={setDraftPerSurfacePrompts}
          />
        )}

        <PersonaPreambleSection />
      </div>

      <SettingsTabFooter isDirty={isDirty} onSave={handleSave} onCancel={handleCancel} />

      {modalState && (
        <SystemPromptEditModal
          mode={modalState.mode}
          prompt={modalState.prompt}
          stagedCues={modalState.stagedCues}
          categories={categories}
          onSave={handleModalSave}
          onDelete={handleModalDelete}
          onMove={moveSystemPrompt}
          onClose={closeModal}
        />
      )}
    </div>
  )
}

// ── Inline "Add category" affordance (sits next to "+ Add system prompt") ─

function AddCategoryInline({ onCreate }) {
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColour, setNewColour] = useState(DEFAULT_COLOUR)
  const [pickerOpen, setPickerOpen] = useState(false)
  const swatchRef = useRef(null)
  const [creating, setCreating] = useState(false)

  async function handleAdd() {
    if (!newName.trim()) return
    setCreating(true)
    try {
      await onCreate(newName.trim(), newColour === DEFAULT_COLOUR ? null : newColour)
      setNewName('')
      setNewColour(DEFAULT_COLOUR)
      setShowAdd(false)
    } catch {
      // error surfaced by the parent's `categoryError` banner
    } finally {
      setCreating(false)
    }
  }

  if (!showAdd) {
    return (
      <button
        type="button"
        onClick={() => setShowAdd(true)}
        data-help-region="settings:system_prompts_add_category"
        className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded border border-zinc-600 transition-colors"
      >
        + Add category
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2 rounded border border-zinc-700 bg-zinc-900/40 px-2 py-1">
      <button
        ref={swatchRef}
        type="button"
        onClick={() => setPickerOpen(true)}
        title="Pick a colour for this category"
        className="w-6 h-6 rounded border border-zinc-600 cursor-pointer flex-shrink-0"
        style={{ backgroundColor: newColour }}
      />
      <EntityColorPicker
        value={newColour}
        onChange={setNewColour}
        anchorEl={swatchRef.current}
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
      />
      <input
        type="text"
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleAdd()
          if (e.key === 'Escape') { setShowAdd(false); setNewName(''); setNewColour(DEFAULT_COLOUR) }
        }}
        placeholder="Category name"
        autoFocus
        className={inputCls + ' w-44'}
      />
      <button
        type="button"
        onClick={handleAdd}
        disabled={!newName.trim() || creating}
        className="px-2 py-0.5 text-[11px] bg-accent-700 hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded transition-colors"
      >
        {creating ? 'Adding…' : 'Add'}
      </button>
      <button
        type="button"
        onClick={() => { setShowAdd(false); setNewName(''); setNewColour(DEFAULT_COLOUR) }}
        className="px-2 py-0.5 text-[11px] bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded border border-zinc-600 transition-colors"
      >
        Cancel
      </button>
    </div>
  )
}

// ── Prompt list grouped by category ────────────────────────────

function PromptGroup({
  group,
  categories,
  collapsed,
  onToggleCollapse,
  onEditPrompt,
  onRenameCategory,
  onDeleteCategory,
  onSetCategoryColour,
  onMovePrompt,
  onDuplicatePrompt,
  onCopyForNc,
  cueList,
}) {
  // Uncategorized is the root of `system_prompts/`; orphan groups
  // reference a folder that doesn't exist (so nothing to rename /
  // delete / recolour on disk). Both render without category-
  // management affordances.
  const isUncategorized = group.name === null
  const isManaged = !isUncategorized && !group.orphan
  const groupName = group.name
  const groupColour = group.colour || DEFAULT_COLOUR

  // Category-management UI state — local to the header.
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState(groupName || '')
  useEffect(() => { setRenameDraft(groupName || '') }, [groupName])

  const [pickerOpen, setPickerOpen] = useState(false)
  const swatchRef = useRef(null)

  async function commitRename() {
    const next = renameDraft.trim()
    if (!next || next === groupName) {
      setRenameDraft(groupName || '')
      setRenaming(false)
      return
    }
    try {
      await onRenameCategory(groupName, next)
      setRenaming(false)
    } catch {
      setRenameDraft(groupName || '')
      setRenaming(false)
    }
  }

  // ── Drag-and-drop drop target ─────────────────────────────────
  // The header (and the body when expanded) accepts drops of
  // SystemPromptRow chips. `mime` is the application's marker so
  // we don't accidentally accept unrelated drags.
  const [dragOver, setDragOver] = useState(false)
  function handleDragOver(e) {
    if (!e.dataTransfer.types.includes('application/x-nn-system-prompt-id')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!dragOver) setDragOver(true)
  }
  function handleDragLeave() {
    setDragOver(false)
  }
  async function handleDrop(e) {
    setDragOver(false)
    const promptId = e.dataTransfer.getData('application/x-nn-system-prompt-id')
    if (!promptId) return
    // Don't move if it's already in this category.
    const sourceCategory = e.dataTransfer.getData('application/x-nn-source-category') || ''
    const targetCategory = isUncategorized ? '' : (groupName || '')
    if (sourceCategory === targetCategory) return
    e.preventDefault()
    try {
      await onMovePrompt(promptId, isUncategorized ? null : groupName)
    } catch {
      // parent surfaces the error via categoryError; nothing to do here
    }
  }

  const dropTargetCls = dragOver ? 'ring-2 ring-accent-500/60 rounded' : ''

  return (
    <div
      className={dropTargetCls}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div data-help-region="settings:system_prompts_category" className="w-full flex items-center px-1 pb-1 gap-2">
        {/* Chevron-only toggle: nested interactive elements inside a
            <button> are invalid HTML and stop bubbling can't be
            relied upon. Splitting the toggle out lets the colour dot
            and name behave as their own click targets. */}
        <button
          type="button"
          onClick={onToggleCollapse}
          title={collapsed ? 'Expand' : 'Collapse'}
          className="text-zinc-400 hover:text-zinc-200 text-[10px] w-4 flex-shrink-0 rounded hover:bg-zinc-800/40 transition-colors py-0.5"
        >
          {collapsed ? '▸' : '▾'}
        </button>
        {isManaged ? (
          <button
            ref={swatchRef}
            type="button"
            onClick={() => setPickerOpen(true)}
            onContextMenu={(e) => {
              if (!group.colour) return
              e.preventDefault()
              onSetCategoryColour(groupName, null)
            }}
            title={group.colour
              ? `Colour: ${group.colour} (click to change, right-click to clear)`
              : 'Pick a colour for this category'}
            className="w-3 h-3 rounded-full flex-shrink-0 border border-zinc-700 cursor-pointer"
            style={{ backgroundColor: groupColour }}
          />
        ) : (
          <span
            className="w-3 h-3 rounded-full flex-shrink-0 border border-zinc-700"
            style={{ backgroundColor: groupColour }}
          />
        )}
        {renaming ? (
          <input
            type="text"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') { setRenameDraft(groupName || ''); setRenaming(false) }
            }}
            autoFocus
            className={inputCls + ' text-[11px] uppercase tracking-wider font-semibold flex-1 min-w-[100px]'}
          />
        ) : isManaged ? (
          <button
            type="button"
            onClick={onToggleCollapse}
            title="Click to collapse / expand"
            className="text-[11px] font-semibold text-zinc-300 hover:text-accent-300 uppercase tracking-wider flex-1 min-w-0 text-left truncate transition-colors"
          >
            {groupName}
          </button>
        ) : (
          <span
            className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wider flex-1 min-w-0 truncate"
            onClick={onToggleCollapse}
          >
            {isUncategorized ? 'Uncategorized' : groupName}
            {group.orphan && (
              <span className="ml-2 text-[9px] text-amber-300 normal-case tracking-normal italic">
                (no folder — prompts reference a category that doesn&apos;t exist)
              </span>
            )}
          </span>
        )}
        {isManaged && !collapsed && (
          <>
            <button
              type="button"
              onClick={() => setRenaming(true)}
              title={`Rename category "${groupName}"`}
              aria-label={`Rename category "${groupName}"`}
              className="px-1.5 py-0.5 text-[11px] bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 rounded border border-zinc-700 transition-colors flex-shrink-0 leading-none"
            >
              ✎
            </button>
            <button
              type="button"
              onClick={() => onDeleteCategory(groupName, group.prompts.length)}
              title={`Delete category "${groupName}"`}
              aria-label={`Delete category "${groupName}"`}
              className="px-1.5 py-0.5 text-[11px] bg-red-900/40 hover:bg-red-900/60 text-red-200 rounded border border-red-800/60 transition-colors flex-shrink-0 leading-none"
            >
              🗑
            </button>
          </>
        )}
        <span className="text-[10px] text-zinc-500 flex-shrink-0">
          {group.prompts.length} prompt{group.prompts.length === 1 ? '' : 's'}
        </span>
      </div>
      {isManaged && (
        <EntityColorPicker
          value={groupColour}
          onChange={(hex) => onSetCategoryColour(groupName, hex)}
          anchorEl={swatchRef.current}
          isOpen={pickerOpen}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {!collapsed && (
        group.prompts.length === 0 ? (
          <div className="rounded border border-dashed border-zinc-800 bg-zinc-900/20 px-3 py-2 text-[10px] text-zinc-600 italic ml-4">
            (empty — drop a prompt here to move it into this category)
          </div>
        ) : (
          <ul className="space-y-1.5">
            {group.prompts.map((p) => (
              <SystemPromptRow
                key={p.id}
                promptEntry={p}
                categories={categories}
                onEdit={() => onEditPrompt(p)}
                onMoveTo={(target) => onMovePrompt(p.id, target)}
                onDuplicate={() => onDuplicatePrompt(p.id)}
                onCopyForNc={onCopyForNc ? (shape) => onCopyForNc(p, shape) : undefined}
                cueList={cueList}
              />
            ))}
          </ul>
        )
      )}
    </div>
  )
}

function SystemPromptRow({ promptEntry, categories, onEdit, onMoveTo, onDuplicate, onCopyForNc, cueList }) {
  // Each prompt is a single clickable row; clicking opens the bespoke
  // editing modal (Phase 2.10a §4.11). Row also acts as a drag source
  // for the move-between-categories drop targets on group headers.
  const previewLine = (promptEntry.prompt || '').split('\n').find((l) => l.trim()) || ''
  const [moveMenuOpen, setMoveMenuOpen] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  // Phase 3.11b — NC clipboard export state. The popover only
  // surfaces when the prompt has attached Context Cues whose body
  // arrangement would differ between NC's three "clipboard formats"
  // (self-contained / bundle / reference-only); cue-less prompts
  // just trigger a one-click copy in `self-contained` shape.
  const [copyMenuOpen, setCopyMenuOpen] = useState(false)
  const [copying, setCopying] = useState(false)
  // Phase 3.11b — brief accent-colour flash on the clipboard icon
  // after a successful copy. Clears itself after ~1.5s. The timeout
  // ref is tracked so a follow-up click restarts the flash cleanly
  // (re-clicking before the previous flash has faded out still
  // produces a fresh full-duration flash), and a final cleanup on
  // unmount avoids a `setState on an unmounted component` warning.
  const [justCopied, setJustCopied] = useState(false)
  const justCopiedTimeoutRef = useRef(null)
  useEffect(() => () => {
    if (justCopiedTimeoutRef.current) {
      clearTimeout(justCopiedTimeoutRef.current)
      justCopiedTimeoutRef.current = null
    }
  }, [])
  const attachedCueCount = useMemo(() => {
    const ids = Array.isArray(promptEntry?.static_cue_ids) ? promptEntry.static_cue_ids : []
    return ids.filter((id) => (cueList || []).some((c) => c && c.id === id)).length
  }, [promptEntry?.static_cue_ids, cueList])

  function handleDragStart(e) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-nn-system-prompt-id', promptEntry.id)
    e.dataTransfer.setData('application/x-nn-source-category', promptEntry.category || '')
  }

  async function handleMoveTo(target) {
    setMoveMenuOpen(false)
    if ((target || null) === (promptEntry.category || null)) return
    try {
      await onMoveTo(target)
    } catch {
      // parent surfaces the error via categoryError
    }
  }

  async function runCopyForNc(shape) {
    setCopyMenuOpen(false)
    setCopying(true)
    try {
      const ok = await onCopyForNc?.(shape)
      if (ok) {
        // Restart any in-flight flash so a re-click gets a fresh
        // full-duration flash rather than picking up the tail end
        // of the previous one.
        if (justCopiedTimeoutRef.current) {
          clearTimeout(justCopiedTimeoutRef.current)
        }
        setJustCopied(true)
        justCopiedTimeoutRef.current = setTimeout(() => {
          setJustCopied(false)
          justCopiedTimeoutRef.current = null
        }, 1500)
      }
    } finally {
      setCopying(false)
    }
  }

  function handleCopyClick() {
    // Cue-less prompts: one-click silent copy in `self-contained`
    // shape (all three NC formats produce the same output when
    // there's nothing to include / bundle / reference). Cued
    // prompts: open the popover so the writer picks a shape.
    if (attachedCueCount === 0) {
      runCopyForNc('self-contained')
    } else {
      setCopyMenuOpen((v) => !v)
    }
  }

  return (
    <li
      data-help-region="settings:system_prompts_row"
      className="rounded border border-zinc-700 bg-zinc-900/30 overflow-visible relative"
      draggable
      onDragStart={handleDragStart}
    >
      <div className="w-full flex items-stretch">
        <button
          type="button"
          onClick={onEdit}
          title="Open editor (drag to move between categories)"
          className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 hover:bg-zinc-800/60 transition-colors text-left cursor-grab active:cursor-grabbing"
        >
          <span className="text-xs text-zinc-100 font-medium whitespace-nowrap flex-shrink-0">{promptEntry.name || 'Untitled system prompt'}</span>
          {promptEntry.shipped && (
            <span
              className="text-[9px] text-sky-300 border border-sky-700/60 rounded px-1.5 py-0.5 flex-shrink-0"
              title="Shipped with NarrativeNode. You can freely edit, rename, or delete it. Deleted shipped prompts will not be reinstalled on the next launch."
            >shipped</span>
          )}
          {promptEntry.is_persona && (
            <span
              className="text-[9px] text-accent-200 border border-accent-600/60 rounded px-1.5 py-0.5 flex-shrink-0"
              title="Persona prompt: eligible for use as a voice template in the Character Chat surface."
            >🎭 persona</span>
          )}
          {previewLine && (
            <span className="text-[10px] text-zinc-500 truncate italic">&ldquo;{previewLine}&rdquo;</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setMoveMenuOpen((v) => !v)}
          title="Move to a different category"
          className="px-2 text-[10px] text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 transition-colors border-l border-zinc-700 flex-shrink-0"
        >
          Move to&hellip;
        </button>
        <button
          type="button"
          disabled={duplicating}
          onClick={async () => {
            setDuplicating(true)
            try { await onDuplicate?.() } finally { setDuplicating(false) }
          }}
          title="Duplicate this prompt. Creates a copy in the same category with (N) appended to the name."
          aria-label="Duplicate prompt"
          className="px-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 transition-colors border-l border-zinc-700 flex-shrink-0 disabled:opacity-40 disabled:cursor-wait flex items-center"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="5" width="8" height="9" rx="1.2" />
            <path d="M3 11 V3.2 a1 1 0 0 1 1 -1 H10.5" />
          </svg>
        </button>
        {onCopyForNc && (
          <button
            type="button"
            disabled={copying}
            onClick={handleCopyClick}
            title={attachedCueCount === 0
              ? 'Copy this prompt as a NovelCrafter clipboard blob (paste into NovelCrafter’s prompt editor).'
              : `Copy this prompt as a NovelCrafter clipboard blob. ${attachedCueCount} attached Context Cue${attachedCueCount === 1 ? '' : 's'} — pick how to handle ${attachedCueCount === 1 ? 'it' : 'them'}.`}
            aria-label="Copy for NovelCrafter"
            className={`px-2 transition-colors border-l border-zinc-700 flex-shrink-0 disabled:opacity-40 disabled:cursor-wait flex items-center ${
              justCopied
                ? 'bg-accent-700/40 text-accent-100'
                : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60'
            }`}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="4" y="3" width="8" height="11" rx="1.2" />
              <path d="M6 3 V2 a1 1 0 0 1 1 -1 H9 a1 1 0 0 1 1 1 V3" />
            </svg>
          </button>
        )}
      </div>
      {moveMenuOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMoveMenuOpen(false)}
          />
          <ul className="absolute right-2 top-full mt-1 z-50 min-w-[160px] rounded border border-zinc-700 bg-zinc-900 shadow-lg py-1 text-xs">
            <li>
              <button
                type="button"
                onClick={() => handleMoveTo(null)}
                disabled={!promptEntry.category}
                className="w-full text-left px-3 py-1.5 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-200"
              >
                Uncategorized
              </button>
            </li>
            {categories.map((c) => (
              <li key={c.name}>
                <button
                  type="button"
                  onClick={() => handleMoveTo(c.name)}
                  disabled={promptEntry.category === c.name}
                  className="w-full text-left px-3 py-1.5 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-200 flex items-center gap-2"
                >
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0 border border-zinc-700"
                    style={{ backgroundColor: c.colour || DEFAULT_COLOUR }}
                  />
                  {c.name}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {copyMenuOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setCopyMenuOpen(false)}
          />
          <div className="absolute right-2 top-full mt-1 z-50 w-[320px] rounded border border-zinc-700 bg-zinc-900 shadow-lg py-2 text-xs">
            <div className="px-3 pb-2 border-b border-zinc-800">
              <div className="text-[11px] font-semibold text-zinc-200">Copy for NovelCrafter</div>
              <div className="text-[10px] text-zinc-500 mt-0.5">
                {attachedCueCount} attached Context Cue{attachedCueCount === 1 ? '' : 's'}. Pick a clipboard format:
              </div>
            </div>
            <NcCopyOption
              label="Copy without any dependencies"
              defaultBadge
              description={`Context Cue content gets inlined into the prompt body so the destination is self-contained. ${attachedCueCount === 1 ? 'The attached cue’s' : 'Attached cues’'} body text is appended after the system message.`}
              onPick={() => runCopyForNc('self-contained')}
            />
            <NcCopyOption
              label="Copy full prompt with all dependencies"
              description={`Emits an array bundle: the prompt + each Context Cue as a NovelCrafter "component". Pasting into NovelCrafter adds every snippet to its library at once.`}
              onPick={() => runCopyForNc('bundle')}
            />
            <NcCopyOption
              label="Copy prompt as-is"
              description={`Leaves {include("...")} markers in the prompt body but does NOT bundle the cues. The destination NovelCrafter instance must already have snippets with matching names.`}
              onPick={() => runCopyForNc('reference-only')}
            />
          </div>
        </>
      )}
    </li>
  )
}

/**
 * Phase 3.11b — one row inside the "Copy for NovelCrafter" popover.
 * Matches NovelCrafter's own clipboard-format menu wording (label
 * verbatim from NC's UI; description is our own plain-language
 * explanation of what the option does to attached Context Cues).
 */
function NcCopyOption({ label, description, defaultBadge = false, onPick }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="w-full text-left px-3 py-2 hover:bg-zinc-800 transition-colors flex flex-col gap-0.5 border-t border-zinc-800/60 first:border-t-0"
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-semibold text-zinc-100">{label}</span>
        {defaultBadge && (
          <span className="text-[9px] text-accent-200 border border-accent-600/60 rounded px-1 py-0 leading-tight">Default</span>
        )}
      </div>
      <span className="text-[10px] text-zinc-500 leading-snug">{description}</span>
    </button>
  )
}

function DefaultSystemPromptPicker({ prompts, value, onChange }) {
  return (
    <label data-help-region="settings:system_prompts_default_picker" className="flex items-center gap-2 text-[11px] text-zinc-400">
      <span>Default prompt:</span>
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value || null)}
        className={selectCls + ' w-56'}
      >
        <option value="">No system prompt</option>
        {prompts.map((p) => (
          <option key={p.id} value={p.id}>{p.name || 'Untitled system prompt'}</option>
        ))}
      </select>
    </label>
  )
}

// ── Phase 2.10a item 11 — Default System Prompt per Surface ──────
// Section above the System Prompts list. Four horizontal columns,
// one per surface (chat panel / scene description summary / section
// PBH / inline PB). Each column shows the surface label, the
// currently-selected default's name (or "No system prompt"), and on
// hover opens the bespoke `<SystemPromptPickerList>` flyout — same
// picker used by every surface's gear/settings popover.
//
// Writes are immediate. The picker's `onPick` IS the "set as default"
// action here (no separate ★ button — clicking a row in the flyout
// sets it as the surface's default). Picking "No system prompt"
// clears the slot. Chat panel writes additionally mirror the legacy
// global `default_system_prompt_id` for one-cycle backward compat.
// Two-row layout: row 1 holds Chat Panel + Character Chat (the two
// "talk to the AI as a peer" surfaces), centred horizontally. Row 2
// holds the three in-editor prompt surfaces (Scene Description, Section
// Prompt, Inline Prompt). Renders via a 6-column grid where every cell
// is `col-span-2`; the top row's first cell is `col-start-2` so the two
// items centre at cols 2-3 and 4-5 (cols 1 and 6 remain empty).
const SURFACES_TOP = [
  { key: 'chat_panel',     label: 'Chat Panel' },
  { key: 'character_chat', label: 'Character Chat' },
]
const SURFACES_BOTTOM = [
  { key: 'scene_description_pbh', label: 'Scene Description' },
  { key: 'section_pbh',           label: 'Section Prompt' },
  { key: 'ipb',                   label: 'Inline Prompt' },
]
const SURFACES = [...SURFACES_TOP, ...SURFACES_BOTTOM]

function DefaultPromptPerSurfaceSection({ prompts, categories, draftPerSurface, setDraftPerSurface }) {
  // Shared hover-flyout state for the four columns — only one open
  // at a time. 500ms grace mirrors the chat panel + PBH gear popover
  // close timer so category-collapse-shrinks-flyout doesn't race.
  const [hoverFlyout, setHoverFlyout] = useState(null)
  const closeTimerRef = useRef(null)
  function openFlyout(key) {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    setHoverFlyout(key)
  }
  function scheduleCloseFlyout() {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = setTimeout(() => {
      setHoverFlyout(null)
      closeTimerRef.current = null
    }, 500)
  }

  // Picker open-category state, one slot per surface — so the
  // writer's last-expanded category persists across hover open /
  // close cycles within this section's mount.
  const [openKeys, setOpenKeys] = useState({
    chat_panel: null,
    scene_description_pbh: null,
    section_pbh: null,
    ipb: null,
    character_chat: null,
  })
  function setOpenKey(surfaceKey, next) {
    setOpenKeys((prev) => ({ ...prev, [surfaceKey]: next }))
  }

  function setSurfacePromptDefault(surfaceKey, promptId) {
    // Edits accumulate in the tab's draft state; nothing hits the
    // backend until Save. The chat_panel → legacy mirror is applied
    // at commit time, not here.
    setDraftPerSurface((prev) => ({ ...(prev || {}), [surfaceKey]: promptId || null }))
    // Picking a default is a definitive action — close the flyout
    // so the writer sees the new selection on the column row
    // without having to dismiss it manually.
    setHoverFlyout(null)
  }

  return (
    <section data-help-region="settings:system_prompts_default_per_surface" className={sectionCls}>
      <header className={sectionHdrCls}>Default System Prompt per Surface</header>
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        Each of the four AI-aware surfaces in NarrativeNode picks up this default when its picker opens. Surfaces can still override per-session via their own gear / Settings popovers; this is just the starting point. Click any column to change the default; click the currently-selected row again to clear it.
      </p>
      <div className="grid grid-cols-6 gap-2">
        {SURFACES_TOP.map((s, i) => {
          const promptId = draftPerSurface?.[s.key] ?? null
          const promptObj = promptId ? (prompts || []).find((p) => p.id === promptId) : null
          const value = promptId == null
            ? 'No system prompt'
            : (promptObj?.name || '(unknown prompt)')
          const stale = promptId != null && !promptObj
          return (
            <div key={s.key} className={`col-span-2 ${i === 0 ? 'col-start-2' : ''}`}>
              <PopoverSectionRow
                label={s.label}
                value={value}
                secondary={stale ? 'Prompt deleted — pick a new default.' : null}
                isOpen={hoverFlyout === s.key}
                onEnter={() => openFlyout(s.key)}
                onLeave={scheduleCloseFlyout}
                flyoutWidth={260}
                flyoutDataAttr="default-prompt-flyout"
                hideChevron
                centerContent
                trigger="click"
              >
                <SystemPromptPickerList
                  prompts={prompts || []}
                  categories={categories || []}
                  activePromptId={promptId}
                  defaultPromptId={promptId}
                  onPick={(id) => setSurfacePromptDefault(s.key, id === promptId ? null : id)}
                  controlledOpenKey={openKeys[s.key]}
                  onOpenKeyChange={(k) => setOpenKey(s.key, k)}
                />
              </PopoverSectionRow>
            </div>
          )
        })}
        {SURFACES_BOTTOM.map((s) => {
          const promptId = draftPerSurface?.[s.key] ?? null
          const promptObj = promptId ? (prompts || []).find((p) => p.id === promptId) : null
          const value = promptId == null
            ? 'No system prompt'
            : (promptObj?.name || '(unknown prompt)')
          const stale = promptId != null && !promptObj
          return (
            <div key={s.key} className="col-span-2">
              <PopoverSectionRow
                label={s.label}
                value={value}
                secondary={stale ? 'Prompt deleted — pick a new default.' : null}
                isOpen={hoverFlyout === s.key}
                onEnter={() => openFlyout(s.key)}
                onLeave={scheduleCloseFlyout}
                flyoutWidth={260}
                flyoutDataAttr="default-prompt-flyout"
                hideChevron
                centerContent
                trigger="click"
              >
                <SystemPromptPickerList
                  prompts={prompts || []}
                  categories={categories || []}
                  activePromptId={promptId}
                  defaultPromptId={promptId}
                  onPick={(id) => setSurfacePromptDefault(s.key, id === promptId ? null : id)}
                  controlledOpenKey={openKeys[s.key]}
                  onOpenKeyChange={(k) => setOpenKey(s.key, k)}
                />
              </PopoverSectionRow>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function ScopeBanner() {
  return (
    <div data-help-region="settings:system_prompts_scope_banner" className="rounded border border-sky-700/50 bg-sky-900/20 px-3 py-2 text-[11px] text-sky-200 space-y-1.5">
      <div>
        <span className="font-semibold">Whole-program system prompts.</span>{' '}
        These templates are available to every chat session on this machine.
      </div>
      <div className="text-sky-300/80">
        Stored under{' '}
        <code className="px-1 py-0.5 bg-sky-950/60 rounded text-[10px]">system_prompts/</code>{' '}
        as one JSON file per prompt. Categories are subfolders. Files are written on Save.
      </div>
      <div className="text-sky-300/80">
        Prompts marked <span className="text-sky-200 font-semibold">shipped</span> travel with NarrativeNode. You can freely edit, rename, or delete them. Deleted shipped prompts will not be reinstalled on the next launch.
      </div>
    </div>
  )
}

const DEFAULT_COLOUR = '#888888'  // neutral grey matching the backend's `categories_service.DEFAULT_COLOUR`

const sectionCls    = 'rounded border border-zinc-700/60 bg-zinc-900/40 px-4 py-3 space-y-3 flex flex-col'
const sectionHdrCls = 'text-[11px] font-semibold text-zinc-300 uppercase tracking-wider pb-1 mb-2 border-b border-zinc-700/60'
const inputCls      = 'w-full bg-zinc-800 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500'
const selectCls     = inputCls + ' appearance-none'
