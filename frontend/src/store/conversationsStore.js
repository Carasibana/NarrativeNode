import { create } from 'zustand'
import axios from 'axios'
import { usePinnedContextStore } from './pinnedContextStore'

/**
 * Conversation persistence store — Phase 2.4b.
 *
 * Two layers of state:
 *   - `index`: lightweight metadata array (one entry per saved
 *              thread) backing the thread browser. Sorted by
 *              `updated_at` descending. Fetched once via
 *              loadIndex(); kept in sync with mutations via local
 *              optimistic updates so the browser never has to
 *              round-trip just to redraw.
 *   - `byId`:  cache of full `Conversation` objects (with full
 *              `messages` array) for threads the writer has opened
 *              this session. Lazy-loaded via openThread(id).
 *
 * Storage on disk is one JSON file per thread under
 * `preferences/conversations/{id}.json` (see
 * `backend/services/conversations_service.py`). The store hits
 * `/api/conversations/...` for every mutation so the on-disk copy
 * stays in lock-step with the in-memory state — the writer never
 * loses a conversation to a page refresh.
 *
 * Optimistic mutation pattern:
 *   - Mutation updates local state immediately so the UI feels
 *     instant.
 *   - The matching backend call runs in the background.
 *   - On failure the local state is rolled back to the pre-mutation
 *     snapshot and the error is surfaced via `lastError`.
 *
 * Streaming message appends are a special case — the chat panel
 * appends a user message + an empty assistant message before the
 * stream starts, then `appendDelta` updates the assistant message
 * content as tokens arrive. Final persistence happens at stream
 * end (or on cancel) via `commitAssistantMessage`. This avoids
 * one disk write per token.
 */

const ROOT = '/api/conversations'


function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'cv_' + Math.random().toString(36).slice(2, 10)
}


function nowIso() {
  return new Date().toISOString()
}


// Coerce an axios error's response payload into a STRING so callers
// can drop it straight into `lastError` without risking a React
// "Objects are not valid as a React child" crash when something
// downstream renders `lastError` as JSX. FastAPI's 422 returns
// `detail` as a list of validation objects (`{type, loc, msg, ...}`);
// other endpoints return a plain string. Anything else we JSON-encode
// as a fallback so the writer at least sees the shape.
function _stringifyAxiosError(err, fallback) {
  const detail = err?.response?.data?.detail
  if (typeof detail === 'string' && detail) return detail
  if (Array.isArray(detail) && detail.length) {
    return detail
      .map((d) => {
        if (typeof d === 'string') return d
        const loc = Array.isArray(d?.loc) ? d.loc.join('.') : ''
        const msg = d?.msg || ''
        return loc ? `${loc}: ${msg}` : msg
      })
      .filter(Boolean)
      .join('; ')
  }
  if (detail && typeof detail === 'object') {
    try { return JSON.stringify(detail) } catch { /* noop */ }
  }
  return err?.message || fallback || 'Request failed'
}


export const useConversationsStore = create((set, get) => ({
  index: [],
  byId: {},
  indexLoaded: false,
  indexLoading: false,
  loadError: null,
  lastError: null,
  // Which thread is currently open in the chat panel. null = the
  // thread browser is showing instead.
  activeThreadId: null,
  // Phase 2.4f — substring-match counts keyed by thread id, refreshed
  // on every thread-browser search query. Cleared back to {} when
  // the search input is empty so stale counts don't linger.
  searchHits: {},
  // Increments on every search query so multiple in-flight searches
  // resolve in order — late responses for stale queries are dropped.
  _searchSeq: 0,
  // Phase 2.6 — `story_id → display_name` lookup mirrored from
  // `conversations/index.json`'s categories map. Used by the thread
  // browser's tab strip to label per-story tabs. Loaded lazily via
  // `loadCategoriesMap`; the in-app `loadIndex` also seeds it for
  // free since the backend's `list_index` and `categories-map`
  // endpoints derive from the same in-memory index. Mutations to
  // `categoriesMap` happen in the same actions that mutate thread
  // `story_id` (currently only `createThread` via the backend's
  // first-save-of-story side effect).
  categoriesMap: {},
  categoriesMapLoaded: false,

  // ── Index + load ───────────────────────────────────────────

  loadIndex: async () => {
    if (get().indexLoading) return
    if (get().indexLoaded) return
    set({ indexLoading: true, loadError: null })
    try {
      const { data } = await axios.get(ROOT)
      set({
        index: Array.isArray(data) ? data : [],
        indexLoaded: true,
        indexLoading: false,
      })
    } catch (err) {
      set({
        loadError: err?.response?.data?.detail || err.message || 'Failed to load conversations',
        indexLoading: false,
      })
    }
  },

  /** Force a re-fetch of the conversations index AND the categories
   *  map from disk. Bypasses the already-loaded short-circuits in
   *  `loadIndex()` + `loadCategoriesMap()` so out-of-band disk
   *  mutations (Phase 3.9 NC chat import — writes new thread files
   *  server-side without going through the per-thread mutation
   *  hooks the store subscribes to) become visible in the browser
   *  without a manual page reload. Mirrors the Phase 3.8
   *  `contextCuesStore.reloadCues()` pattern. */
  reloadIndex: async () => {
    set({ indexLoaded: false, categoriesMapLoaded: false })
    await get().loadIndex()
    await get().loadCategoriesMap()
  },

  /** Fetch the persisted `story_id → display_name` map from
   *  `conversations/index.json` via the backend. Used by the
   *  thread browser tab strip (Phase 2.6e) to label per-story
   *  tabs without walking the on-disk `category.json` sidecars.
   *  Idempotent re: in-flight calls. */
  loadCategoriesMap: async () => {
    // Idempotent — bails when the map is already loaded. The thread
    // browser tab strip reads from the cache after the first load;
    // mutations that need a fresh fetch (e.g. story-rename via
    // `syncStoryFolder`) patch the map in place rather than re-
    // fetching the whole thing.
    if (get().categoriesMapLoaded) return get().categoriesMap
    try {
      const { data } = await axios.get(`${ROOT}/categories-map`)
      const map = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {}
      set({ categoriesMap: { ...map }, categoriesMapLoaded: true })
      return map
    } catch (err) {
      set({
        lastError: err?.response?.data?.detail || err.message || 'Failed to load conversation categories map',
      })
      return get().categoriesMap
    }
  },

  /** Phase 2.6g — project-load + story-rename hook. Fires
   *  `POST /api/conversations/sync-story-folder` so the backend
   *  can rename-existing-only the per-story folder (no-op when no
   *  folder exists yet, per the planning doc's lazy-creation rule)
   *  AND refresh the `index.categories[story_id]` map entry. On
   *  success the local `categoriesMap` is patched in place so the
   *  thread-browser tab strip reflects the new title without
   *  needing a full categories-map reload.
   *
   *  Caller responsibility: throttle / debounce title edits before
   *  reaching here. The story-title input already commits on
   *  Enter / blur, so each commit fires this once per real change
   *  — there's no per-keystroke flood. */
  syncStoryFolder: async (storyId, storyTitle) => {
    if (!storyId) return null
    try {
      const { data } = await axios.post(`${ROOT}/sync-story-folder`, {
        story_id: storyId,
        story_title: storyTitle || '',
      })
      // Patch the local categories map so the tab strip + grouped
      // tree pick up the new title immediately, without waiting for
      // the next full `loadCategoriesMap` round-trip.
      set((s) => ({
        categoriesMap: { ...s.categoriesMap, [storyId]: storyTitle || '' },
      }))
      return data
    } catch (err) {
      set({
        lastError: err?.response?.data?.detail || err.message || 'Failed to sync story folder',
      })
      return null
    }
  },

  /** Force a backend rebuild of `conversations/index.json` from the
   *  on-disk thread files + per-folder `category.json` sidecars.
   *  Refreshes the local `index` + `categoriesMap` from the
   *  follow-up GETs so the writer sees the rebuilt state without
   *  reloading the page. Returns `{ entries, categories }` counts
   *  the backend reports for the confirmation toast, or null on
   *  failure. */
  rebuildIndex: async () => {
    try {
      const { data } = await axios.post(`${ROOT}/rebuild-index`)
      // Force-refresh index + categoriesMap from the backend. Going
      // through `reloadIndex` (Phase 3.9) instead of `loadIndex` +
      // `loadCategoriesMap` directly — those short-circuit when the
      // `*Loaded` flags are true (the common case post-startup), so
      // calling them after a rebuild would silently leave the
      // stores stale. `reloadIndex` resets the flags first.
      await get().reloadIndex()
      return data || null
    } catch (err) {
      set({
        lastError: err?.response?.data?.detail || err.message || 'Failed to rebuild thread index',
      })
      return null
    }
  },

  /** Fetch a full thread (with messages) and cache it in `byId`.
   *  No-op if it's already cached and `force` is false. */
  openThread: async (threadId, { force = false } = {}) => {
    if (!threadId) return null
    if (!force && get().byId[threadId]) return get().byId[threadId]
    try {
      const { data } = await axios.get(`${ROOT}/${threadId}`)
      set((s) => ({ byId: { ...s.byId, [threadId]: data } }))
      return data
    } catch (err) {
      set({ lastError: err?.response?.data?.detail || err.message || 'Failed to load conversation' })
      return null
    }
  },

  setActiveThreadId: (id) => set({ activeThreadId: id || null }),

  /** Substring search across every saved thread's full message
   *  content. Returns a `{ threadId: matchCount }` map. Empty
   *  queries skip the request and clear the cached map. Phase 2.6 —
   *  the previous `categoryId` narrowing arg is gone (categories
   *  have been replaced by tags); thread-browser tab + tag-filter
   *  narrowing happens client-side after the server returns the
   *  full set of matches. The active-tab filter is cheap and a
   *  thread library big enough to matter is rare enough that the
   *  server-side pre-filter wasn't earning its complexity. */
  searchThreads: async (query) => {
    const seq = get()._searchSeq + 1
    set({ _searchSeq: seq })
    if (!query || !query.trim()) {
      set({ searchHits: {} })
      return {}
    }
    try {
      const params = { q: query }
      const { data } = await axios.get(`${ROOT}/search`, { params })
      // Drop the response if another search has been queued since
      // we started — the in-flight queue might resolve out of order
      // when the writer types fast, and we don't want stale counts.
      if (get()._searchSeq !== seq) return get().searchHits
      const map = {}
      for (const hit of (Array.isArray(data) ? data : [])) {
        if (hit && hit.id) map[hit.id] = Number(hit.match_count || 0)
      }
      set({ searchHits: map })
      return map
    } catch (err) {
      if (get()._searchSeq !== seq) return get().searchHits
      set({ lastError: err?.response?.data?.detail || err.message || 'Search failed' })
      return get().searchHits
    }
  },

  // ── Create / rename / delete ───────────────────────────────

  /** Create a new thread and mark it active. Returns the created
   *  Conversation on success, or null on failure. Caller can
   *  override the id/name via `seed`; otherwise we generate. */
  createThread: async (seed = {}) => {
    const id = seed.id || newId()
    const body = {
      id,
      name: seed.name || 'New conversation',
      profile_id: seed.profile_id || null,
      model: seed.model || null,
      system_prompt_id: seed.system_prompt_id || null,
      // Phase 2.11b — Character Chat threads pass a `character_chat`
      // metadata block at create time. Null for regular threads.
      character_chat: seed.character_chat || null,
      // Phase 2.12 — Two-character chat threads pass a
      // `two_character_chat` metadata block at create time. Mutually
      // exclusive with `character_chat` (the helper that builds the
      // seed guarantees only one is set). Null for regular and
      // single-character chats.
      two_character_chat: seed.two_character_chat || null,
    }
    // Optimistic: drop a stub into the local state immediately so
    // the browser/conversation view can render against it without
    // waiting for the round-trip. Phase 2.6 — `story_id` is stamped
    // by the backend at create time (reads `state.get_story().id`),
    // so the optimistic record uses null and we re-hydrate from the
    // server response. `tags` defaults to [] on both sides.
    const now = nowIso()
    const optimistic = {
      ...body,
      created_at: now,
      updated_at: now,
      pinned_in_browser: false,
      story_id: null,
      tags: [],
      messages: [],
      character_chat: body.character_chat,
      two_character_chat: body.two_character_chat,
    }
    set((s) => ({
      byId: { ...s.byId, [id]: optimistic },
      index: [
        {
          id, name: optimistic.name, created_at: now, updated_at: now,
          message_count: 0, last_message_preview: null,
          profile_id: body.profile_id, model: body.model,
          pinned_in_browser: false, story_id: null, tags: [],
        },
        ...s.index.filter((e) => e.id !== id),
      ],
      activeThreadId: id,
      lastError: null,
    }))
    try {
      const { data } = await axios.post(ROOT, body)
      // Phase 2.12 — also refresh the index entry from the server's
      // canonical record so the thread browser categorises the new
      // thread under the correct story bucket immediately (not after
      // the next page refresh). The optimistic record above stamped
      // story_id=null because the backend assigns story_id from
      // `state.get_story()` at create time; without this refresh the
      // index keeps the stale null and the thread shows under the
      // "Untitled" story bucket. Same goes for is_character_chat /
      // is_two_character_chat — they're derived backend-side from
      // the character_chat / two_character_chat metadata and need to
      // ride into the index entry for the browser badges to render.
      // Fixes a latent bug that affected single-character chats too;
      // both are now categorised correctly on first creation.
      set((s) => ({
        byId: { ...s.byId, [id]: data },
        index: s.index.map((e) => (e.id === id ? {
          ...e,
          name: data.name,
          updated_at: data.updated_at,
          pinned_in_browser: !!data.pinned_in_browser,
          story_id: data.story_id ?? null,
          story_title: data.story_title ?? null,
          tags: Array.isArray(data.tags) ? [...data.tags] : [],
          colour: data.colour ?? null,
          is_character_chat: !!data.character_chat,
          is_two_character_chat: !!data.two_character_chat,
        } : e)),
      }))
      return data
    } catch (err) {
      // Roll back.
      set((s) => {
        const nextById = { ...s.byId }
        delete nextById[id]
        return {
          byId: nextById,
          index: s.index.filter((e) => e.id !== id),
          activeThreadId: s.activeThreadId === id ? null : s.activeThreadId,
          lastError: err?.response?.data?.detail || err.message || 'Failed to create conversation',
        }
      })
      return null
    }
  },

  /** Generic thread metadata patch — handles name, render_mode,
   *  profile_id, model, system_prompt_id. Optimistic; rolls back
   *  on failure. The patch shape matches the backend's
   *  `UpdateConversationRequest` (render_mode accepts `__clear__`
   *  as a sentinel to reset the field). */
  updateThread: async (threadId, patch) => {
    if (!threadId) return null
    const prev = get().byId[threadId] || null
    // Thread-browser mutations (pin / rename / move-to-category /
    // etc.) routinely fire on threads the writer has never opened
    // — those exist in `index` but not in `byId`. We still want
    // those patches to apply, so bail only on missing threadId,
    // not on missing byId entry. The byId optimistic update is
    // skipped when `prev` is null and re-hydrated by the PUT
    // response below.
    // Resolve __clear__ sentinel for local state (backend handles
    // it on the wire; the local cache stores `null`). Phase 2.6 —
    // `category_id` is gone; `tags` mutations route through the
    // dedicated `addTagToThread` / `removeTagFromThread` actions
    // below since the wire shape is per-tag-add/remove rather than
    // a whole-list patch.
    const localPatch = { ...patch }
    if (localPatch.render_mode === '__clear__') localPatch.render_mode = null
    if (localPatch.colour === '__clear__') localPatch.colour = null
    set((s) => ({
      byId: prev
        ? { ...s.byId, [threadId]: { ...prev, ...localPatch, updated_at: nowIso() } }
        : s.byId,
      index: s.index.map((e) => (e.id === threadId ? {
        ...e,
        ...(localPatch.name != null ? { name: localPatch.name } : {}),
        ...(localPatch.pinned_in_browser != null ? { pinned_in_browser: !!localPatch.pinned_in_browser } : {}),
        ...('colour' in localPatch ? { colour: localPatch.colour } : {}),
      } : e)),
      lastError: null,
    }))
    try {
      const { data } = await axios.put(`${ROOT}/${threadId}`, patch)
      // Metadata patch — keep the local `messages` array. A streaming
      // assistant message lives only in local state until the stream
      // ends; replacing wholesale with the server's `messages` would
      // wipe it mid-stream.
      set((s) => {
        const local = s.byId[threadId]
        const merged = { ...data, messages: local?.messages ?? data.messages }
        return {
          byId: { ...s.byId, [threadId]: merged },
          index: s.index.map((e) => (e.id === threadId ? {
            ...e,
            name: data.name,
            updated_at: data.updated_at,
            pinned_in_browser: !!data.pinned_in_browser,
            story_id: data.story_id ?? null,
            tags: Array.isArray(data.tags) ? [...data.tags] : [],
            colour: data.colour ?? null,
          } : e)),
        }
      })
      return data
    } catch (err) {
      // Rollback. byId rollback only applies when we actually
      // mutated it above (i.e. there was a prev entry to begin
      // with). The index rollback re-reads from the persisted
      // store via a re-fetch on the next load — for the typical
      // pin/rename/move case the local index entry just stays
      // optimistically updated and is corrected on the next
      // refresh; surfacing `lastError` lets the writer know
      // something went wrong without us having to keep a full
      // pre-mutation index snapshot in scope.
      set((s) => ({
        byId: prev ? { ...s.byId, [threadId]: prev } : s.byId,
        index: prev
          ? s.index.map((e) => (e.id === threadId ? { ...e, name: prev.name } : e))
          : s.index,
        lastError: _stringifyAxiosError(err, 'Failed to update conversation'),
      }))
      return null
    }
  },

  renameThread: async (threadId, name) => {
    if (!threadId) return null
    const prev = get().byId[threadId] || null
    // Same lazy-byId story as `updateThread` above — the thread
    // browser routinely renames threads that haven't been opened
    // yet, so we only mutate byId optimistically when there's a
    // prev entry. The index update + PUT always run.
    set((s) => ({
      byId: prev
        ? { ...s.byId, [threadId]: { ...prev, name, updated_at: nowIso() } }
        : s.byId,
      index: s.index.map((e) => (e.id === threadId ? { ...e, name } : e)),
      lastError: null,
    }))
    try {
      const { data } = await axios.put(`${ROOT}/${threadId}`, { name })
      // Keep the local `messages` array, do NOT replace wholesale with the
      // server's. A streaming assistant message lives only in local state
      // until the stream ends; the server response from a rename does not
      // carry it, so a wholesale replace wipes it mid-stream (the bubble
      // vanishes on rename and only returns once the stream persists).
      // Mirrors the same guard in `patchThread`.
      set((s) => {
        const local = s.byId[threadId]
        const merged = { ...data, messages: local?.messages ?? data.messages }
        return {
          byId: { ...s.byId, [threadId]: merged },
          index: s.index.map((e) => (e.id === threadId ? {
            ...e,
            name: data.name,
            updated_at: data.updated_at,
          } : e)),
        }
      })
      return data
    } catch (err) {
      // Roll back. byId rollback only when we mutated it above;
      // index name is left optimistically applied and corrected on
      // the next index refresh, matching `updateThread`.
      set((s) => ({
        byId: prev ? { ...s.byId, [threadId]: prev } : s.byId,
        index: prev
          ? s.index.map((e) => (e.id === threadId ? { ...e, name: prev.name } : e))
          : s.index,
        lastError: err?.response?.data?.detail || err.message || 'Failed to rename conversation',
      }))
      return null
    }
  },

  /** Attach `tag` to the thread's `tags` array. No-op if the tag is
   *  already present (case-insensitive match). Routes through the
   *  existing `updateThread` PUT endpoint with the full new list —
   *  optimistic update + rollback semantics inherited from there.
   *  Tag strings are trimmed; empty / whitespace-only inputs no-op
   *  rather than landing as an empty string in the list. */
  addTagToThread: async (threadId, tag) => {
    if (!threadId) return null
    const trimmed = (typeof tag === 'string' ? tag : '').trim()
    if (!trimmed) return null
    const cur = get().byId[threadId] || get().index.find((e) => e.id === threadId) || null
    const currentTags = Array.isArray(cur?.tags) ? cur.tags : []
    const lower = trimmed.toLowerCase()
    if (currentTags.some((t) => (t || '').toLowerCase() === lower)) {
      // Already present — surface the current thread without a wire round-trip.
      return cur
    }
    const nextTags = [...currentTags, trimmed]
    return get().updateThread(threadId, { tags: nextTags })
  },

  /** Detach `tag` from the thread's `tags` array. Case-insensitive
   *  match — the original-casing entry is removed regardless of how
   *  the caller spelled the argument. No-op if the tag isn't on
   *  the thread. */
  removeTagFromThread: async (threadId, tag) => {
    if (!threadId) return null
    const target = (typeof tag === 'string' ? tag : '').trim().toLowerCase()
    if (!target) return null
    const cur = get().byId[threadId] || get().index.find((e) => e.id === threadId) || null
    const currentTags = Array.isArray(cur?.tags) ? cur.tags : []
    const nextTags = currentTags.filter((t) => (t || '').toLowerCase() !== target)
    if (nextTags.length === currentTags.length) {
      // Nothing to remove.
      return cur
    }
    return get().updateThread(threadId, { tags: nextTags })
  },

  deleteThread: async (threadId) => {
    const prevById = get().byId
    const prevIndex = get().index
    const prevActive = get().activeThreadId
    // Phase 2.10b bug 1 — explicitly clear this conversation's pin
    // bucket on the unified pinnedContextStore so deleting a thread
    // doesn't leak orphan pins in session memory.
    try { usePinnedContextStore.getState().clearPins(`chat:${threadId}`) } catch { /* ignore */ }
    set((s) => {
      const nextById = { ...s.byId }
      delete nextById[threadId]
      return {
        byId: nextById,
        index: s.index.filter((e) => e.id !== threadId),
        activeThreadId: s.activeThreadId === threadId ? null : s.activeThreadId,
        lastError: null,
      }
    })
    try {
      await axios.delete(`${ROOT}/${threadId}`)
    } catch (err) {
      set({
        byId: prevById,
        index: prevIndex,
        activeThreadId: prevActive,
        lastError: err?.response?.data?.detail || err.message || 'Failed to delete conversation',
      })
    }
  },

  // ── Message append / edit / delete ────────────────────────

  /** Append a complete (already-finalised) message. Used for user
   *  messages on send, and as the persistence call for an assistant
   *  message after the stream ends. */
  appendMessage: async (threadId, message) => {
    const prev = get().byId[threadId]
    if (!prev) return null
    // Optimistic
    const optimistic = { ...prev, messages: [...prev.messages, message], updated_at: nowIso() }
    set((s) => ({
      byId: { ...s.byId, [threadId]: optimistic },
      index: bumpIndex(s.index, threadId, optimistic),
      lastError: null,
    }))
    try {
      const { data } = await axios.post(`${ROOT}/${threadId}/messages`, message)
      set((s) => ({
        byId: { ...s.byId, [threadId]: data },
        index: bumpIndex(s.index, threadId, data),
      }))
      return data
    } catch (err) {
      // Roll back
      set((s) => ({
        byId: { ...s.byId, [threadId]: prev },
        index: bumpIndex(s.index, threadId, prev),
        lastError: err?.response?.data?.detail || err.message || 'Failed to append message',
      }))
      return null
    }
  },

  /** Optimistic-only local update used during streaming. The
   *  matching disk write happens via `appendMessage` (or
   *  `updateMessage`) at stream end. Doesn't touch the backend. */
  appendLocalMessage: (threadId, message) => {
    set((s) => {
      const prev = s.byId[threadId]
      if (!prev) return s
      const next = { ...prev, messages: [...prev.messages, message], updated_at: nowIso() }
      return {
        byId: { ...s.byId, [threadId]: next },
        index: bumpIndex(s.index, threadId, next),
      }
    })
  },

  /** Update an existing message in-place (used during streaming
   *  to grow the assistant message's content as tokens arrive,
   *  and after the fact for edit / pin / collapse). Local-only by
   *  default; pass `persist: true` to also write to disk.
   *
   *  Phase 2.5 perf fix — accepts an `options.skipIndexPreview` flag
   *  that omits the per-call `bumpIndex` call. The thread-browser
   *  index entry's `last_message_preview` ends up stale until the
   *  next non-skipped update (or stream end / persist), which is the
   *  right trade for token-streaming: the writer is in the chat
   *  panel, not the thread browser, and `bumpIndex` walks the full
   *  accumulated content on every call (slice/split/join on a string
   *  that grows by token). Stream end + persistMessagePatch +
   *  appendMessage all still bump the index normally. */
  updateLocalMessage: (threadId, messageId, patch, options = {}) => {
    const { skipIndexPreview = false } = options
    set((s) => {
      const prev = s.byId[threadId]
      if (!prev) return s
      const messages = prev.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m))
      const next = { ...prev, messages, updated_at: nowIso() }
      const patch_out = {
        byId: { ...s.byId, [threadId]: next },
      }
      if (!skipIndexPreview) {
        patch_out.index = bumpIndex(s.index, threadId, next)
      }
      return patch_out
    })
  },

  /** Persist a message patch to disk. Returns the updated thread
   *  on success, or null on failure (and rolls back the optimistic
   *  edit). */
  persistMessagePatch: async (threadId, messageId, patch) => {
    const prev = get().byId[threadId]
    if (!prev) return null
    const prevMsg = prev.messages.find((m) => m.id === messageId) || null
    if (!prevMsg) return null
    // Optimistic
    get().updateLocalMessage(threadId, messageId, patch)
    try {
      const { data } = await axios.put(`${ROOT}/${threadId}/messages/${messageId}`, patch)
      set((s) => ({ byId: { ...s.byId, [threadId]: data } }))
      return data
    } catch (err) {
      // Roll back
      set((s) => ({
        byId: { ...s.byId, [threadId]: prev },
        lastError: err?.response?.data?.detail || err.message || 'Failed to update message',
      }))
      return null
    }
  },

  deleteMessage: async (threadId, messageId) => {
    const prev = get().byId[threadId]
    if (!prev) return null
    // Optimistic
    const optimistic = { ...prev, messages: prev.messages.filter((m) => m.id !== messageId), updated_at: nowIso() }
    set((s) => ({
      byId: { ...s.byId, [threadId]: optimistic },
      index: bumpIndex(s.index, threadId, optimistic),
      lastError: null,
    }))
    try {
      const { data } = await axios.delete(`${ROOT}/${threadId}/messages/${messageId}`)
      set((s) => ({
        byId: { ...s.byId, [threadId]: data },
        index: bumpIndex(s.index, threadId, data),
      }))
      return data
    } catch (err) {
      set((s) => ({
        byId: { ...s.byId, [threadId]: prev },
        index: bumpIndex(s.index, threadId, prev),
        lastError: err?.response?.data?.detail || err.message || 'Failed to delete message',
      }))
      return null
    }
  },
}))


/** Helper: update an index entry for `threadId` from the supplied
 *  full thread, then move it to the top of the list (since any
 *  mutation bumps `updated_at`). */
function bumpIndex(index, threadId, thread) {
  const messages = thread.messages || []
  const last = messages[messages.length - 1]
  const lastPreview = last
    ? (last.content || '').split('\n').join(' ').slice(0, 120)
    : null
  const entry = {
    id: thread.id,
    name: thread.name,
    created_at: thread.created_at,
    updated_at: thread.updated_at,
    message_count: messages.length,
    last_message_preview: lastPreview,
    profile_id: thread.profile_id,
    model: thread.model,
    pinned_in_browser: !!thread.pinned_in_browser,
    // Phase 2.6 — story linkage + tagging. Mirror the new fields off
    // the loaded `Conversation` shape so the in-memory index entry
    // matches what the backend writes to `conversations/index.json`.
    story_id: thread.story_id ?? null,
    tags: Array.isArray(thread.tags) ? [...thread.tags] : [],
  }
  const rest = index.filter((e) => e.id !== threadId)
  return [entry, ...rest]
}


export function newMessageId() {
  return newId()
}
