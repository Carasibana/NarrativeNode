import { create } from 'zustand'
import axios from 'axios'

/**
 * System prompts are stored one-file-per-prompt under
 * `system_prompts/{slug}__{id}.json` at the project root (Phase 2.10a
 * moved them out of `preferences/`). Category subfolders under the
 * same root hold prompts grouped by category — the folder name IS
 * the category identity. Optional `system_prompts/categories.json`
 * maps category names to custom display colours.
 *
 * This store fetches both prompts and categories on demand (when the
 * System Prompts settings tab opens). It exposes:
 *   - The standard draft-pattern flow for prompt edits
 *     (`savePromptsDiff(draftList)` commits a batch).
 *   - Immediate-write actions for category CRUD (create / rename /
 *     delete / colour). Each refetches both prompts AND categories
 *     since a category change touches prompt-side category fields too.
 */
export const useSystemPromptsStore = create((set, get) => ({
  // Baseline list — exactly what's persisted on disk right now.
  prompts: [],
  loaded: false,
  loading: false,
  loadError: null,

  // Category list — same fetch / state lifecycle as prompts.
  categories: [],
  categoriesLoaded: false,
  categoriesLoading: false,
  categoriesLoadError: null,

  /** Fetch the full list. Idempotent; the tab calls this on mount.
   *  No-op while a previous load is still in flight. */
  loadPrompts: async () => {
    if (get().loading) return
    set({ loading: true, loadError: null })
    try {
      const { data } = await axios.get('/api/system-prompts')
      const raw = Array.isArray(data) ? data : []
      // Migration shim — load → convert → save emits only canonical
      // shapes per the no-cliffs save-format rule. Idempotent — no-op for prompts
      // that already match canonical. Three conversions:
      //   (1) Rename `pov_character_name` → `pov_character` in
      //       `context_markers` (Bug 5).
      //   (2) Strip any `context_cue_by_id` marker from
      //       `context_markers` and migrate its `id` into the new
      //       `static_cue_ids` field (Bug 6 — cues are static cue
      //       attachments, not dynamic markers). Defence-in-depth:
      //       per the Bug 6 ToDo there are no in-the-wild prompts
      //       carrying this marker, but the rule applies anyway.
      //   (3) Strip any `current_scene_title` / `current_scene_description`
      //       marker from `context_markers` (Bug 7 — both are strict
      //       subsets of the Scene Context Tier 1 toggle's emission;
      //       the writer enables Scene Context to cover them).
      //       Defence-in-depth: no in-the-wild prompts carry these.
      const prompts = raw.map((p) => {
        if (!p) return p
        let dirty = false
        let next = p
        if (Array.isArray(p.context_markers)) {
          const newMarkers = []
          const cueIdsFromMarkers = []
          for (const m of p.context_markers) {
            if (m && m.type === 'pov_character_name') {
              dirty = true
              newMarkers.push({ ...m, type: 'pov_character' })
            } else if (m && m.type === 'context_cue_by_id') {
              dirty = true
              if (m.id && typeof m.id === 'string') cueIdsFromMarkers.push(m.id)
              // Marker dropped from context_markers; id migrates to
              // static_cue_ids below.
            } else if (m && (m.type === 'current_scene_title' || m.type === 'current_scene_description')) {
              dirty = true
              // Marker silently dropped — writer relies on Scene Context
              // Tier 1 toggle to cover title / description per Bug 7.
            } else {
              newMarkers.push(m)
            }
          }
          if (dirty) {
            const existing = Array.isArray(p.static_cue_ids) ? p.static_cue_ids : []
            const mergedCueIds = [...existing]
            for (const id of cueIdsFromMarkers) {
              if (!mergedCueIds.includes(id)) mergedCueIds.push(id)
            }
            next = {
              ...p,
              context_markers: newMarkers,
              static_cue_ids: mergedCueIds,
            }
          }
        }
        return next
      })
      set({ prompts, loaded: true, loading: false })
    } catch (err) {
      set({
        loadError: err?.response?.data?.detail || err.message || 'Failed to load system prompts',
        loading: false,
      })
    }
  },

  /** Fetch the categories list. Idempotent. */
  loadCategories: async () => {
    if (get().categoriesLoading) return
    set({ categoriesLoading: true, categoriesLoadError: null })
    try {
      const { data } = await axios.get('/api/system-prompt-categories')
      set({ categories: Array.isArray(data) ? data : [], categoriesLoaded: true, categoriesLoading: false })
    } catch (err) {
      set({
        categoriesLoadError: err?.response?.data?.detail || err.message || 'Failed to load categories',
        categoriesLoading: false,
      })
    }
  },

  /** Diff `draftList` against the current baseline and apply the
   *  changes via per-id REST calls:
   *    - id in draft, not in baseline   → POST (create)
   *    - id in both, content differs    → PUT  (update)
   *    - id in baseline, not in draft   → DELETE
   *  Writes are sequential so a mid-batch failure stops the rest
   *  (rather than leaving the disk in a half-applied state).
   *  Throws on first failure; the partial state will still be
   *  re-read on the next loadPrompts() / page refresh, so nothing
   *  is silently lost.
   *  On success the baseline is replaced with a deep copy of the
   *  draft so subsequent dirty-checks are clean. */
  savePromptsDiff: async (draftList) => {
    const baseline = get().prompts
    const baselineById = new Map(baseline.map((p) => [p.id, p]))
    const draftById = new Map(draftList.map((p) => [p.id, p]))

    for (const d of draftList) {
      if (!baselineById.has(d.id)) {
        await axios.post('/api/system-prompts', d)
      }
    }
    for (const d of draftList) {
      const b = baselineById.get(d.id)
      if (b && JSON.stringify(b) !== JSON.stringify(d)) {
        await axios.put(`/api/system-prompts/${d.id}`, d)
      }
    }
    for (const b of baseline) {
      if (!draftById.has(b.id)) {
        await axios.delete(`/api/system-prompts/${b.id}`)
      }
    }

    set({ prompts: draftList.map((p) => ({ ...p })) })
  },

  // ── Category CRUD (immediate writes — no draft pattern) ────────
  // Each action refetches BOTH categories and prompts on success so
  // the store reflects any side-effects (e.g. delete-with-prompts
  // removed N prompts; move-prompts-to-root changed N prompts'
  // `category` fields). Throws on failure so the caller can surface
  // a writer-facing error.

  createCategory: async (name, colour = null) => {
    await axios.post('/api/system-prompt-categories', { name, colour })
    await get().loadCategories()
    await get().loadPrompts()
  },

  renameCategory: async (oldName, newName) => {
    await axios.put(`/api/system-prompt-categories/${encodeURIComponent(oldName)}`, { new_name: newName })
    await get().loadCategories()
    await get().loadPrompts()
  },

  deleteCategory: async (name, { movePromptsToRoot = true } = {}) => {
    await axios.delete(`/api/system-prompt-categories/${encodeURIComponent(name)}`, {
      params: { move_prompts_to_root: movePromptsToRoot },
    })
    await get().loadCategories()
    await get().loadPrompts()
  },

  setCategoryColour: async (name, colour) => {
    // `colour` may be null to clear the entry. Backend writes
    // `categories.json` accordingly.
    await axios.put(`/api/system-prompt-categories/${encodeURIComponent(name)}/colour`, { colour })
    await get().loadCategories()
  },

  /** Phase 2.10a item 5 — move a prompt to a different category
   *  (or to root for uncategorized). `targetCategory=null` means
   *  uncategorized. Refetches prompts + categories so the prompt-
   *  count badges + group memberships stay in sync. Throws on
   *  failure so callers can surface a writer-facing error. */
  moveSystemPrompt: async (promptId, targetCategory) => {
    await axios.put(`/api/system-prompts/${encodeURIComponent(promptId)}/category`, {
      category: targetCategory,
    })
    await get().loadPrompts()
    await get().loadCategories()
  },

  /** Duplicate an existing prompt. Copies every field (body,
   *  mock_messages, context_markers, surface_defaults,
   *  static_cue_ids) verbatim; generates a new UUID; computes a
   *  collision-free name within the source's category by scanning
   *  for `{name}` / `{name} (N)` patterns and picking the next
   *  free N. `shipped: false` on the copy regardless of source
   *  (the source's shipped flag is a static install marker; a
   *  user-authored duplicate is never shipped).
   *
   *  Same-category collision check only: two prompts named "Tense
   *  Action" in different categories is legitimate and we want to
   *  allow it. Filenames are `{slug}__{uuid}.json` so disk-level
   *  uniqueness is the UUID's job; the `(N)` suffix is purely for
   *  human readability in the picker UI.
   *
   *  Refetches prompts on success. Throws on failure. */
  duplicatePrompt: async (promptId) => {
    const baseline = get().prompts
    const source = baseline.find((p) => p.id === promptId)
    if (!source) throw new Error('Prompt not found')
    // Compute collision-free name. Strip any existing ` (N)` suffix
    // from the source's name first so a copy of "Foo (1)" → "Foo (2)"
    // rather than "Foo (1) (1)". The base name is whatever's left.
    const sourceName = source.name || 'Untitled'
    const baseMatch = sourceName.match(/^(.+?)\s*\((\d+)\)\s*$/)
    const baseName = (baseMatch ? baseMatch[1] : sourceName).trim()
    // Scan same-category prompts for `{baseName}` / `{baseName} (N)`
    // patterns. Build a set of taken Ns; "Foo" with no suffix counts
    // as taken at N=0 so we start at 1 when the unsuffixed name
    // already exists in the category.
    const sourceCategory = source.category || null
    const sameCategory = baseline.filter((p) => (p.category || null) === sourceCategory)
    const taken = new Set()
    for (const p of sameCategory) {
      const n = p.name || ''
      if (n === baseName) { taken.add(0); continue }
      const m = n.match(/^(.+?)\s*\((\d+)\)\s*$/)
      if (m && m[1].trim() === baseName) {
        const num = parseInt(m[2], 10)
        if (!Number.isNaN(num) && num > 0) taken.add(num)
      }
    }
    let nextN = 1
    while (taken.has(nextN)) nextN += 1
    const newName = `${baseName} (${nextN})`
    const newId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : `dup_${Math.random().toString(36).slice(2)}_${baseline.length}`
    const copy = {
      ...source,
      id: newId,
      name: newName,
      shipped: false,
    }
    // POST always creates the file at the root (Uncategorized) per
    // the backend's "folder is source of truth — `category` field on
    // input is ignored" contract (see save_prompt in
    // system_prompts_service.py). If the source lives in a category,
    // follow up with a move-to-category call so the duplicate lands
    // next to its source. Done in two steps because there's no
    // single-shot create-in-category endpoint today.
    await axios.post('/api/system-prompts', copy)
    if (sourceCategory) {
      try {
        await axios.put(`/api/system-prompts/${encodeURIComponent(newId)}/category`, {
          category: sourceCategory,
        })
      } catch {
        // Move failed — the duplicate exists at root. Surface the
        // partial-success state through loadPrompts; writer can
        // manually Move-to... to fix.
      }
    }
    await get().loadPrompts()
    return newId
  },
}))
