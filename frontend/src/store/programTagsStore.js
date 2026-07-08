import { create } from 'zustand'
import axios from 'axios'

/**
 * Phase 3.4e — Program Tags store.
 *
 * Cross-pool / per-user tag pool aggregation. Program Tags are flat
 * strings on `ContextCue.tags` and `Conversation.tags`. The pool
 * itself isn't a first-class object — it's the deduped set of every
 * tag string in use across both per-pool indexes, merged with the
 * cross-pool colour-overrides map at
 * `preferences/program_tag_colors.json`.
 *
 * The backend's `GET /api/program-tags` does the aggregation +
 * per-tag count computation; the store caches the response so the
 * library UI doesn't refetch on every render.
 *
 * Mutations (rename / recolour / delete) all dispatch via the
 * `deleteObject('programTag', name)` flow on projectStore (delete)
 * or the matching direct API calls (rename / recolour). After each
 * mutation we re-fetch the pool list so the count + canonical-casing
 * fields reflect the current backend state.
 */
export const useProgramTagsStore = create((set, get) => ({
  pool: [],
  loaded: false,
  loading: false,
  loadError: null,
  saveError: null,

  /** Fetch the aggregated pool. Idempotent — bails when a prior
   *  load is in flight AND when the pool is already loaded. Mutation
   *  actions that need a fresh count go through `refreshPool()`
   *  instead. Mount-callers can fire-and-forget; subsequent
   *  re-mounts (e.g. tab returns) hit the cache. */
  loadPool: async () => {
    if (get().loading) return get().pool
    if (get().loaded) return get().pool
    set({ loading: true, loadError: null })
    try {
      const { data } = await axios.get('/api/program-tags')
      const pool = Array.isArray(data) ? data : []
      set({ pool, loaded: true, loading: false })
      return pool
    } catch (err) {
      set({
        loadError: err?.response?.data?.detail || err.message || 'Failed to load program tags.',
        loading: false,
      })
      return get().pool
    }
  },

  /** Force a refetch of the pool. Called after a mutation lands so
   *  the counts + canonical casing reflect disk. Use this instead
   *  of `loadPool()` when the store is already `loaded`. */
  refreshPool: async () => {
    try {
      const { data } = await axios.get('/api/program-tags')
      const pool = Array.isArray(data) ? data : []
      set({ pool, loaded: true })
      return pool
    } catch (err) {
      set({
        loadError: err?.response?.data?.detail || err.message || 'Failed to refresh program tags.',
      })
      return get().pool
    }
  },

  /** Set / change the colour on a Program Tag. Wraps the per-tag
   *  PUT endpoint. Refreshes the pool on success so the row visual
   *  picks up the new colour. */
  setColor: async (name, color) => {
    set({ saveError: null })
    try {
      const { data } = await axios.put(
        `/api/program-tags/${encodeURIComponent(name)}/color`,
        { color },
      )
      await get().refreshPool()
      return data
    } catch (err) {
      set({
        saveError: err?.response?.data?.detail || err.message || 'Failed to set program tag colour.',
      })
      throw err
    }
  },

  /** Rename a Program Tag across every host. Wraps the rename
   *  endpoint. 409 collisions surface in `saveError`; the caller
   *  decides whether to retry / cancel. Refreshes the pool on
   *  success. */
  rename: async (oldName, newName) => {
    set({ saveError: null })
    try {
      const { data } = await axios.put('/api/program-tags/rename', {
        old_name: oldName,
        new_name: newName,
      })
      await get().refreshPool()
      return data
    } catch (err) {
      const detail = err?.response?.data?.detail
      const msg = typeof detail === 'string'
        ? detail
        : (err.message || 'Failed to rename program tag.')
      set({ saveError: msg })
      throw err
    }
  },

  /** Pre-create a Program Tag pool entry (a colour-map row that
   *  surfaces in the library list even before any cue / conversation
   *  carries the string). Wraps `PUT /api/program-tags/{name}/color`
   *  with the supplied colour. Refreshes the pool on success so the
   *  new entry appears. */
  create: async (name, color) => {
    set({ saveError: null })
    try {
      const { data } = await axios.put(
        `/api/program-tags/${encodeURIComponent(name)}/color`,
        { color: color || '#888888' },
      )
      await get().refreshPool()
      return data
    } catch (err) {
      set({
        saveError: err?.response?.data?.detail || err.message || 'Failed to create program tag.',
      })
      throw err
    }
  },
}))
