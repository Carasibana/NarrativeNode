import { create } from 'zustand'
import axios from 'axios'

// Per-install localStorage key for tag-usage timestamps. Drives the
// "recently used" sort order on the Context Cue tag cloud. Stored
// client-side because it's a UX preference (which tags the writer
// has touched lately), not data the writer needs to share across
// installs.
const _TAG_USAGE_LS_KEY = 'nn_context_cue_tag_usage'

function _loadTagUsageFromLocalStorage() {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(_TAG_USAGE_LS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed : {}
  } catch { return {} }
}

function _persistTagUsage(map) {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(_TAG_USAGE_LS_KEY, JSON.stringify(map || {})) }
  catch { /* localStorage may be unavailable / full — UX preference is non-critical */ }
}

/**
 * Phase 2.8 — Context Cues store.
 *
 * A Context Cue is a named, reusable chunk of reference content
 * the writer composes once and pulls into AI conversations on
 * demand. Cues live program-level — backed by the top-level
 * `context_cues/` folder (one JSON per cue + an `order.json`
 * sidecar; never in `.nnz`) — and the REST endpoint is a single
 * PUT-the-whole-list since the list is small, rare-to-mutate, and
 * the order matters (matches the library UI's display order). The
 * backend folder layout shipped in v0.2.8.1; pre-2.8 saves used a
 * single `preferences/ai_context_cues.json` file (gone, no compat).
 *
 * Mirror of the systemPromptsStore lifecycle: idempotent
 * `loadCues()` populates the baseline on first reference; the
 * library section uses the standard draft pattern locally and
 * commits via `saveCues(draftList)` which replaces the file
 * contents in one PUT.
 *
 * Both the library section and the chat panel read from this same
 * store — the chat panel uses the `cues` list to render quick-
 * picker options and to look up bodies for pinned cues at chat-
 * send time.
 */
export const useContextCuesStore = create((set, get) => ({
  cues: [],
  // Phase 2.8 — Cue library manual-order layout. A mixed array of
  // either cue-id strings (each renders the matching cue at that
  // position) or divider objects `{ type: 'divider', id, title }`.
  // Drives the rendering of the Context Cue library section in
  // `sortKey === 'manual'` only; non-manual sorts ignore the
  // layout, filter to cue-typed entries, and sort the cues
  // alphabetically / by recency. Backed by the `order.json`
  // sidecar in the `context_cues/` folder (extended shape — see
  // `backend/services/context_cues_service.py`).
  libraryLayout: [],
  loaded: false,
  loading: false,
  // Phase 3.4e — body-backfill state. `loadCues()` runs two phases:
  // phase 1 fetches the cheap `/index` endpoint so the library
  // renders instantly with name/tags/preview/colour/pinned but
  // empty bodies; phase 2 backfills full HTML bodies via the bulk
  // endpoint in the background. `bodyLoadComplete` flips true once
  // phase 2 lands; until then the name-filter degrades to
  // name-only matching (body is empty so the body branch silently
  // matches nothing). Mutations that landed during phase 2 are
  // preserved (the backfill skips any cue whose body is already
  // non-empty) so an open editor never has its in-progress body
  // clobbered by a stale server payload.
  bodiesLoading: false,
  bodyLoadComplete: false,
  loadError: null,
  saveError: null,

  // Per-tag last-used timestamp (ms since epoch). Drives the
  // "recently used" sort order on the tag cloud / expand modal in
  // the Library section. Loaded from localStorage on first
  // reference; persisted on every mutation so recency survives
  // reloads. UX preference, not story data — never goes near
  // `.nnz` or `context_cues/`.
  tagUsage: _loadTagUsageFromLocalStorage(),

  /** Stamp the given tags as used right now. Called whenever the
   *  writer attaches a tag to a cue. Trims, dedupes case-
   *  insensitively (preserving the casing of the first occurrence
   *  in the input), updates the in-memory map, persists. */
  markTagsUsed: (tags) => {
    if (!Array.isArray(tags) || tags.length === 0) return
    const now = Date.now()
    const cur = get().tagUsage || {}
    const next = { ...cur }
    const seenLower = new Set()
    for (const raw of tags) {
      const t = (raw || '').trim()
      if (!t) continue
      const lower = t.toLowerCase()
      if (seenLower.has(lower)) continue
      seenLower.add(lower)
      next[t] = now
    }
    set({ tagUsage: next })
    _persistTagUsage(next)
  },

  /** Phase 3.4e — two-phase load.
   *
   *  **Phase 1 (foreground, fast):** GET `/api/ai-context-cues/index`
   *  + GET `/api/ai-context-cues/layout` in parallel. The index endpoint
   *  returns cheap per-cue metadata (id, name, tags, favourite,
   *  preview, updated_at, created_at, colour) — no HTML body. We map
   *  those into the same `cues` shape every consumer reads,
   *  initialising `body: ''` so the library list renders the
   *  instant phase 1 lands. `loaded` flips true here.
   *
   *  **Phase 2 (background):** GET `/api/ai-context-cues` (the bulk
   *  bodies endpoint). The response merges into the existing `cues`
   *  array — but only into entries whose `body` is still empty, so
   *  any mutation that landed during the window (e.g. the user
   *  opened an editor and typed something) is NOT clobbered.
   *  `bodyLoadComplete` flips true at the end.
   *
   *  Idempotent on both phases: a re-entrant `loadCues()` bails
   *  while either phase is in flight, and the full-already-loaded
   *  guard at the top short-circuits subsequent tab returns. */
  loadCues: async () => {
    if (get().loading || get().bodiesLoading) return
    if (get().loaded && get().bodyLoadComplete) return

    // ── Phase 1: index + layout (fast) ──────────────────────────
    if (!get().loaded) {
      set({ loading: true, loadError: null })
      try {
        const [indexRes, layoutRes] = await Promise.all([
          axios.get('/api/ai-context-cues/index'),
          axios.get('/api/ai-context-cues/layout'),
        ])
        const indexEntries = Array.isArray(indexRes.data) ? indexRes.data : []
        const cuesFromIndex = indexEntries.map((e) => ({
          id:         e.id,
          name:       e.name || '',
          body:       '',                 // backfilled in phase 2
          tags:       Array.isArray(e.tags) ? e.tags : [],
          pinned:     !!e.favourite,      // index uses `favourite`; cue uses `pinned`
          colour:     e.colour || null,
          updated_at: e.updated_at || null,
          preview:    e.preview || '',    // kept for the body-load-window fallback
        }))
        set({
          cues: cuesFromIndex,
          libraryLayout: Array.isArray(layoutRes.data) ? layoutRes.data : [],
          loaded: true,
          loading: false,
        })
      } catch (err) {
        set({
          loadError: err?.response?.data?.detail || err.message || 'Failed to load context cues.',
          loading: false,
        })
        return
      }
    }

    // ── Phase 2: full bodies (background) ───────────────────────
    set({ bodiesLoading: true })
    try {
      const { data } = await axios.get('/api/ai-context-cues')
      const fullCues = Array.isArray(data) ? data : []
      const bodyById = new Map(fullCues.map((c) => [c.id, c.body || '']))
      set({
        cues: get().cues.map((c) => {
          // Don't clobber an in-progress edit that landed during
          // the body-load window (updateCue would have set a
          // non-empty body in the meantime).
          if (c.body) return c
          const body = bodyById.get(c.id)
          if (body == null) return c   // server doesn't know this id (rare race)
          return { ...c, body }
        }),
        bodiesLoading: false,
        bodyLoadComplete: true,
      })
    } catch (err) {
      // Don't surface as `loadError` — the index load succeeded and
      // the library is usable. The name-filter will degrade
      // gracefully to name-only matching until a subsequent
      // loadCues() retries the backfill.
      set({ bodiesLoading: false })
       
      console.warn('[loadCues] body backfill failed:', err)
    }
  },

  /** Force a re-fetch of cues from disk. Bypasses the
   *  already-loaded short-circuit in `loadCues()` so out-of-band
   *  disk mutations (currently: Phase 3.8 NC snippet import, which
   *  writes new cue files server-side without going through the
   *  per-cue mutation hooks the store subscribes to) become visible
   *  in the library without a manual page reload. Resets `loaded`
   *  + `bodyLoadComplete` so both phases of `loadCues()` re-run. */
  reloadCues: async () => {
    set({ loaded: false, bodyLoadComplete: false })
    await get().loadCues()
  },

  /** Replace the persisted layout with `nextLayout`. Single PUT.
   *  Backend scrubs the inbound entries: drops references to cues
   *  that no longer exist, dedupes divider IDs, and appends any
   *  on-disk cues missing from the layout (so a stale client
   *  doesn't orphan them). Returns the persisted layout. */
  saveLayout: async (nextLayout) => {
    set({ saveError: null })
    try {
      const { data } = await axios.put(
        '/api/ai-context-cues/layout',
        nextLayout,
      )
      const next = Array.isArray(data) ? data : nextLayout
      set({ libraryLayout: next })
      return next
    } catch (err) {
      const msg = err?.response?.data?.detail || err.message || 'Failed to save cue layout.'
      set({ saveError: msg })
      throw err
    }
  },

  /** Append a new divider to the end of the layout. The writer can
   *  drag it into position afterwards. Returns the new divider id
   *  so the caller can scroll-into-view / focus the title input. */
  addLibraryDivider: async () => {
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `divider-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const cur = get().libraryLayout || []
    const next = [...cur, { type: 'divider', id, title: '' }]
    await get().saveLayout(next)
    return id
  },

  /** Set the title on an existing divider. Empty title is legal —
   *  the row still renders just the horizontal line (matches the
   *  entity-bucket DividerItem behaviour). */
  updateLibraryDivider: async (dividerId, title) => {
    const cur = get().libraryLayout || []
    const next = cur.map((entry) => (
      entry && typeof entry === 'object' && entry.id === dividerId
        ? { ...entry, title }
        : entry
    ))
    await get().saveLayout(next)
  },

  /** Drop a divider from the layout. Surrounding cues collapse
   *  together at that position. */
  removeLibraryDivider: async (dividerId) => {
    const cur = get().libraryLayout || []
    const next = cur.filter((entry) => !(
      entry && typeof entry === 'object' && entry.id === dividerId
    ))
    await get().saveLayout(next)
  },

  /** Replace the saved cue list with `draftList`. Single PUT — the
   *  backend rewrites the whole file. On success the baseline is
   *  replaced with a deep copy of the draft so subsequent dirty
   *  checks are clean. Throws on failure; caller surfaces the
   *  error and decides whether to retry. */
  saveCues: async (draftList) => {
    set({ saveError: null })
    try {
      const { data } = await axios.put(
        '/api/ai-context-cues',
        draftList,
      )
      const next = Array.isArray(data) ? data : draftList.map((c) => ({ ...c }))
      set({ cues: next })
      // The backend reorganises `order.json` when cues are added /
      // removed (drops cue IDs no longer present; appends new ones
      // at the end of the layout) while PRESERVING divider entries
      // in place relative to surrounding cues. Re-pull the layout
      // so the in-memory copy matches what's on disk — otherwise
      // a subsequent reorder would PUT a stale layout that
      // re-introduces deleted cue IDs.
      try {
        const { data: layoutData } = await axios.get('/api/ai-context-cues/layout')
        if (Array.isArray(layoutData)) set({ libraryLayout: layoutData })
      } catch { /* layout refresh is best-effort; surface failures elsewhere */ }
      return next
    } catch (err) {
      const msg = err?.response?.data?.detail || err.message || 'Failed to save context cues.'
      set({ saveError: msg })
      throw err
    }
  },

  /** Get one cue by id — convenience accessor for callers (e.g. the
   *  chat panel resolving a pinned cue's body for the system prompt
   *  appendage). Returns null when the id isn't found. */
  getCueById: (id) => {
    if (!id) return null
    return get().cues.find((c) => c.id === id) || null
  },

  /** Phase 3.4c — per-id create. Hits `POST /api/ai-context-cues`
   *  (single cue) rather than the bulk PUT, then appends the
   *  returned cue to local state. The backend stamps `updated_at` and
   *  appends the id to the layout server-side; we re-pull layout on
   *  success so the in-memory copy reflects what's on disk. Returns
   *  the persisted cue (with `updated_at` stamped) on success, throws
   *  on failure (caller surfaces the error). Refuses to overwrite an
   *  existing id — use `updateCue(id, ...)` for that.
   *
   *  Replaces the `saveCues([...cues, newCue])` bulk-PUT pattern
   *  that ContextCueSection used pre-3.4c. Each create is now O(1)
   *  on the wire instead of O(N) where N = total cues.
   */
  createCue: async (cue) => {
    set({ saveError: null })
    try {
      const { data } = await axios.post('/api/ai-context-cues', cue)
      const persisted = data || cue
      set((s) => ({
        cues: [...s.cues, persisted],
      }))
      // Backend appends the new cue's id to the layout — re-pull so
      // the in-memory layout matches disk before any subsequent
      // reorder PUTs a stale value.
      try {
        const { data: layoutData } = await axios.get('/api/ai-context-cues/layout')
        if (Array.isArray(layoutData)) set({ libraryLayout: layoutData })
      } catch { /* layout refresh best-effort */ }
      return persisted
    } catch (err) {
      const msg = err?.response?.data?.detail || err.message || 'Failed to create context cue.'
      set({ saveError: msg })
      throw err
    }
  },

  /** Phase 3.4c — per-id update. Hits `PUT /api/ai-context-cues/{id}`
   *  with the full updated cue body, then merges the server-stamped
   *  fields (`updated_at`) into local state. The caller passes a
   *  PARTIAL update via `updates` — the action reads the current cue
   *  from local state, applies the patch, sends the full new shape
   *  to the backend (the backend expects a complete cue body since
   *  the file is a full rewrite). No-op when the id isn't found.
   *
   *  Replaces every `saveCues(cues.map(c => c.id === id ? ... : c))`
   *  pattern. Each update is now O(1) on the wire and atomic on disk
   *  (the cue's own JSON file is rewritten; other cues are
   *  untouched).
   */
  updateCue: async (id, updates) => {
    if (!id) return null
    const cur = get().cues.find((c) => c.id === id)
    if (!cur) return null
    const next = { ...cur, ...(updates || {}) }
    set({ saveError: null })
    // Optimistic local update so the UI reflects the change
    // immediately. Rolled back on failure.
    set((s) => ({
      cues: s.cues.map((c) => (c.id === id ? next : c)),
    }))
    try {
      const { data } = await axios.put(`/api/ai-context-cues/${id}`, next)
      const persisted = data || next
      // Merge server-stamped fields (`updated_at`) back into local
      // state without disturbing any concurrent edits that may have
      // landed during the await.
      set((s) => ({
        cues: s.cues.map((c) => (c.id === id ? { ...c, ...persisted } : c)),
      }))
      return persisted
    } catch (err) {
      // Rollback: restore the pre-patch shape.
      set((s) => ({
        cues: s.cues.map((c) => (c.id === id ? cur : c)),
        saveError: err?.response?.data?.detail || err.message || 'Failed to update context cue.',
      }))
      throw err
    }
  },

  /** Phase 3.4c — per-id delete. Hits `DELETE /api/ai-context-cues/{id}`
   *  then strips the cue locally + drops its id from the layout. The
   *  backend already handles layout cleanup on its side; we re-pull
   *  the layout afterwards to stay in sync.
   *
   *  Replaces the `saveCues(cues.filter(c => c.id !== id))` bulk-PUT
   *  pattern.
   */
  deleteCue: async (id) => {
    if (!id) return false
    const prevCues = get().cues
    const prevLayout = get().libraryLayout
    // Optimistic local strip — UI reacts immediately.
    set((s) => ({
      cues: s.cues.filter((c) => c.id !== id),
      libraryLayout: (s.libraryLayout || []).filter((entry) => (
        typeof entry === 'string' ? entry !== id : true
      )),
      saveError: null,
    }))
    try {
      await axios.delete(`/api/ai-context-cues/${id}`)
      // Re-pull the layout to absorb any backend-side scrubbing
      // (e.g. divider cleanup) that the strip above didn't catch.
      try {
        const { data: layoutData } = await axios.get('/api/ai-context-cues/layout')
        if (Array.isArray(layoutData)) set({ libraryLayout: layoutData })
      } catch { /* layout refresh best-effort */ }
      return true
    } catch (err) {
      // Rollback on failure.
      set({
        cues: prevCues,
        libraryLayout: prevLayout,
        saveError: err?.response?.data?.detail || err.message || 'Failed to delete context cue.',
      })
      throw err
    }
  },
}))
