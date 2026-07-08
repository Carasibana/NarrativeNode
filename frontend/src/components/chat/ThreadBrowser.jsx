/**
 * Thread browser — Phase 2.6e.
 *
 * Default view of the chat panel when no conversation is active.
 * Lists every saved thread organised by the story it belongs to.
 *
 * Tab strip:
 *   - `[All]` — always present; renders as a grouped tree with one
 *     expandable parent per story-category plus a shared
 *     "Untitled" parent for story_id-less threads.
 *   - `[<loaded story title>]` — appears when a project is loaded.
 *     Default-selected when present.
 *   - `[Untitled]` — appears separately when there are threads with
 *     `story_id == null` AND the loaded story isn't itself
 *     untitled. Story-specific tab; flat list.
 *
 * Tag cloud filter row below the tab strip uses the modular Phase
 * 2.6a `TagFilterRow` / `TagCloud` / `TagChip` components against
 * `utils/tagFilter.js:matchesTagFilter`. Tab and tag filters
 * combine via AND.
 *
 * Sort order within every container (pinned section + each
 * category group's children): pinned first, then unpinned, both
 * by `updated_at` descending.
 *
 * Per-thread row carries:
 *   - thread name (click to open; ✎ rename in place)
 *   - relative last-activity timestamp + raw timestamp tooltip
 *   - one-line preview of the last message
 *   - total message count + tag chip strip (read-only here; the
 *     full tag editor lands with Phase 2.6f)
 *   - story-category indicator when rendered outside its
 *     own category group (i.e. the Pinned section in All view)
 *   - hover actions: 📍 pin, ✎ rename, 🗑 delete (the previous
 *     🏷 move-to-category affordance is gone — tags replace
 *     writer-defined categories).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSettingsStore } from '../../store/settingsStore'
import { useConversationsStore } from '../../store/conversationsStore'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { createCharacterChatThread, createTwoCharacterChatThread } from '../../utils/createCharacterChatThread'
import { confirm as confirmDialog } from '../../store/dialogStore'
import { matchesTagFilter } from '../../utils/tagFilter'
import TagFilterBar from '../tags/TagFilterBar'
import ObjectTagsButton from '../tags/ObjectTagsButton'
// Phase 3.4i — `TagFilterRow` / `TagCloud` / `TagChip` mounts removed
// (filter migrated to the universal `TagFilterBar`); per-row inline
// `TagBadge` chip strip replaced by `ObjectTagsButton` in the action
// cluster. Those imports are gone with their consumers.
import TagPicker from '../tags/TagPicker'
import EntityColorPicker from '../ui/EntityColorPicker'
import { ConversationLabelChip } from '../ui/IdentityBadges'
import CharacterChatSetupModal from './CharacterChatSetupModal'
import { useEntitiesStore } from '../../store/entitiesStore'


// Sentinel tab values. Story_ids are real UUIDs so these can't collide.
const ALL_TAB = '__all__'
const UNTITLED_TAB = '__untitled__'  // matches the uiStore expand-state key


export default function ThreadBrowser() {
  const prefs              = useSettingsStore((s) => s.preferences)
  const createThread       = useConversationsStore((s) => s.createThread)
  const loadIndex          = useConversationsStore((s) => s.loadIndex)
  const indexLoaded        = useConversationsStore((s) => s.indexLoaded)
  const indexLoading       = useConversationsStore((s) => s.indexLoading)
  const index              = useConversationsStore((s) => s.index)
  const setActiveThreadId  = useConversationsStore((s) => s.setActiveThreadId)
  const updateThread       = useConversationsStore((s) => s.updateThread)
  const renameThread       = useConversationsStore((s) => s.renameThread)
  const deleteThread       = useConversationsStore((s) => s.deleteThread)
  const searchThreads      = useConversationsStore((s) => s.searchThreads)
  const rebuildIndex       = useConversationsStore((s) => s.rebuildIndex)
  const searchHits         = useConversationsStore((s) => s.searchHits)
  const lastError          = useConversationsStore((s) => s.lastError)
  const categoriesMap      = useConversationsStore((s) => s.categoriesMap)
  const categoriesMapLoaded = useConversationsStore((s) => s.categoriesMapLoaded)
  const loadCategoriesMap  = useConversationsStore((s) => s.loadCategoriesMap)
  const addTagToThread     = useConversationsStore((s) => s.addTagToThread)
  const removeTagFromThread = useConversationsStore((s) => s.removeTagFromThread)

  // Loaded story — drives the per-story tab + the default-tab
  // resolution. `story.id` and `story.title` are top-level Story
  // baseline fields, not chain-tracked entity values.
  const loadedStoryId    = useProjectStore((s) => s.story?.id || null)
  const loadedStoryTitle = useProjectStore((s) => s.story?.title || '')

  const activeTab            = useUiStore((s) => s.chatBrowserActiveTab)
  const setActiveTab         = useUiStore((s) => s.setChatBrowserActiveTab)
  const tagFilter            = useUiStore((s) => s.chatBrowserTagFilter)
  const setTagFilter         = useUiStore((s) => s.setChatBrowserTagFilter)
  const expandedCategories   = useUiStore((s) => s.chatBrowserExpandedCategories)
  const toggleCategoryExpand = useUiStore((s) => s.toggleChatBrowserCategoryExpanded)
  const requestSettingsOpen  = useUiStore((s) => s.requestSettingsOpen)

  useEffect(() => { if (!indexLoaded) loadIndex() }, [indexLoaded, loadIndex])
  useEffect(() => { if (!categoriesMapLoaded) loadCategoriesMap() }, [categoriesMapLoaded, loadCategoriesMap])

  // Default-tab seed: jump to the loaded-story tab on first
  // project-load when the writer hasn't touched the active-tab
  // selector this session. Once the writer picks any tab manually,
  // we don't override their choice.
  const hasAutoSelectedRef = useRef(false)
  useEffect(() => {
    if (hasAutoSelectedRef.current) return
    if (!loadedStoryId) return
    if (activeTab !== ALL_TAB) return
    setActiveTab(loadedStoryId)
    hasAutoSelectedRef.current = true
  }, [loadedStoryId, activeTab, setActiveTab])

  const [search, setSearch] = useState('')
  const hasProfile = (prefs.ai_provider_profiles || []).length > 0

  // Debounced full-content search. Backend ignores the per-tab
  // narrowing arg now (categories are gone); narrowing happens
  // client-side after the response lands.
  useEffect(() => {
    const q = search.trim()
    if (!q) { searchThreads(''); return undefined }
    const t = setTimeout(() => { searchThreads(q) }, 180)
    return () => clearTimeout(t)
  }, [search, searchThreads])

  // Has-untitled-threads check: governs whether the Untitled tab
  // appears as a sibling of the loaded-story tab. When no project
  // is loaded the "untitled" bucket is implicit in All; we don't
  // render a redundant Untitled tab.
  const hasUntitledThreads = useMemo(
    () => (index || []).some((e) => !e.story_id),
    [index],
  )

  // Tab visibility: All + loaded-story (when present) + Untitled
  // (when present, AND the loaded story isn't itself the
  // untitled bucket — if no project is loaded the All tab covers
  // everything so a separate Untitled tab would just duplicate).
  const showLoadedStoryTab = !!loadedStoryId
  const showUntitledTab = hasUntitledThreads && !!loadedStoryId

  // Recover from a stale activeTab pointing at a story_id whose
  // threads have all been deleted (or a project the writer just
  // closed). Falls back to the loaded-story tab when one exists,
  // else All.
  useEffect(() => {
    if (activeTab === ALL_TAB) return
    if (activeTab === UNTITLED_TAB) {
      if (!hasUntitledThreads) setActiveTab(loadedStoryId || ALL_TAB)
      return
    }
    // Specific story tab — must match loaded story OR must appear
    // in the index's story_id list to be valid.
    if (activeTab === loadedStoryId) return
    const stillKnown = (index || []).some((e) => e.story_id === activeTab)
    if (!stillKnown) setActiveTab(loadedStoryId || ALL_TAB)
  }, [activeTab, hasUntitledThreads, loadedStoryId, index, setActiveTab])

  // Active-tab filter predicate. `story_id` field on the index
  // entry is the canonical category — no derived computation.
  const tabFilter = (e) => {
    if (activeTab === ALL_TAB) return true
    if (activeTab === UNTITLED_TAB) return !e.story_id
    return e.story_id === activeTab
  }

  // Search predicate — name + last-message preview substring +
  // server-side content match hit. Untouched from the previous
  // implementation.
  const q = search.trim().toLowerCase()
  const searchMatches = (e) => {
    if (!q) return true
    if ((e.name || '').toLowerCase().includes(q)) return true
    if ((e.last_message_preview || '').toLowerCase().includes(q)) return true
    if ((searchHits[e.id] || 0) > 0) return true
    return false
  }

  // Phase 3.4i — `cloudTags` memo + `setTagToAndIfOff` row-chip-click
  // callback removed alongside the deprecated `TagFilterRow` mount and
  // the per-row inline `TagBadge` chip strip. The universal
  // `TagFilterBar` owns its own pool resolution now.
  const tabScopedEntries = useMemo(
    () => (index || []).filter(tabFilter),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, activeTab, hasUntitledThreads, loadedStoryId],
  )

  // Picker-suggestion pool — unions tags across the WHOLE index
  // (not just the active tab) so the writer can surface any
  // previously-used tag when adding to a thread, regardless of
  // which tab they're filtering by. Fed to the per-thread TagPicker
  // type-ahead via the row's `+` add-tag affordance.
  const allKnownTags = useMemo(() => {
    const seen = new Set()
    const out = []
    for (const e of (index || [])) {
      for (const t of (e.tags || [])) {
        if (typeof t !== 'string') continue
        const trimmed = t.trim()
        if (!trimmed) continue
        const k = trimmed.toLowerCase()
        if (seen.has(k)) continue
        seen.add(k)
        out.push(trimmed)
      }
    }
    out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    return out
  }, [index])

  // Final-pass row set: tab + tag filter + search.
  const visibleEntries = useMemo(() => {
    const filtered = tabScopedEntries
      .filter((e) => matchesTagFilter(e, tagFilter))
      .filter(searchMatches)
    // Sort by updated_at desc; pinned-vs-unpinned ordering is
    // applied at the render-section level below so it works
    // uniformly inside pinned sections AND inside each category
    // group of the All view.
    filtered.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    return filtered
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabScopedEntries, tagFilter, search, searchHits])

  const totalCount = visibleEntries.length

  // Phase 3.10 — ⋯ menu state + rebuild handler. Disk-as-truth
  // recovery action for when the index drifts (e.g. after a
  // cancelled NC import, manual file deletion, etc.). Confirm
  // dialog before commit because the operation is non-trivial; the
  // result toast surfaces the resolved entry / category counts.
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  // Phase 3.12 #2 — chat-thread multi-select + batch delete. Mirrors
  // the ContextCueSection pattern: select-mode toggle in the header
  // converts each thread row into a checkbox-bearing surface, click
  // toggles selection instead of opening the thread. Batch-delete bar
  // appears above the list with the count + danger action.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  // Anchor for shift+click range selection. Carries the id of the
  // last thread clicked WITHOUT shift; the next shift+click selects
  // everything in display order between this anchor and the clicked
  // id. Reset on exit-select-mode. Stored on a ref so capturing it
  // inside the `toggleThreadSelected` useCallback doesn't bust the
  // callback identity on every selection change.
  const selectionAnchorIdRef = useRef(null)
  // `selectableIdOrder` + `toggleThreadSelected` are defined further
  // down — after pinnedEntries / unpinnedEntries / allViewGroups are
  // available — to avoid a TDZ on those refs. Search for
  // "Phase 3.12 #2 — shift+click range select" below.
  const exitThreadSelectMode = useCallback(() => {
    setSelectMode(false)
    setSelectedIds(new Set())
    selectionAnchorIdRef.current = null
  }, [])
  const handleBatchDeleteThreads = useCallback(async () => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    const choice = await confirmDialog({
      title: ids.length === 1 ? 'Delete 1 conversation' : `Delete ${ids.length} conversations`,
      message: ids.length === 1
        ? 'This cannot be undone — the saved thread file will be removed from disk.'
        : `These ${ids.length} threads cannot be recovered — the saved files will be removed from disk.`,
      buttons: [
        { label: 'Cancel', value: 'cancel', style: 'secondary' },
        { label: ids.length === 1 ? 'Delete' : `Delete ${ids.length}`, value: 'delete', style: 'danger' },
      ],
    })
    if (choice !== 'delete') return
    // Loop the existing per-thread delete. v1 stays on the per-row
    // endpoint same as the context cue batch delete; the index +
    // file-on-disk side-effects per row are small enough that
    // sequential awaits land in well under a second for typical
    // cleanup batches.
    for (const id of ids) {
      try { await deleteThread(id) } catch { /* surfaces via lastError */ }
    }
    exitThreadSelectMode()
  }, [selectedIds, deleteThread, exitThreadSelectMode])

  async function handleRebuildIndex() {
    setMoreMenuOpen(false)
    const ok = await confirmDialog({
      title: 'Rebuild thread index?',
      message: (
        'Walks every saved thread file and rebuilds the index from disk. '
        + 'Orphan index entries (files missing) are dropped, missing entries '
        + 'for present files are added, and categories with no remaining '
        + 'threads are removed from the browser. Safe to run: it does not '
        + 'delete any actual thread files on disk.'
      ),
      buttons: [
        { label: 'Rebuild', value: 'rebuild', style: 'primary' },
        { label: 'Cancel', value: 'cancel', style: 'neutral' },
      ],
    })
    if (ok !== 'rebuild') return
    setRebuilding(true)
    try {
      const result = await rebuildIndex()
      if (result) {
        await confirmDialog({
          title: 'Index rebuilt',
          message: (
            `Thread index now has ${result.entries} entr${result.entries === 1 ? 'y' : 'ies'} `
            + `across ${result.categories} categor${result.categories === 1 ? 'y' : 'ies'}.`
          ),
          buttons: [{ label: 'OK', value: 'ok', style: 'primary' }],
        })
      }
    } finally {
      setRebuilding(false)
    }
  }

  async function handleNewConversation() {
    if (!hasProfile) return
    const seed = {
      name: 'New conversation',
      profile_id: prefs.ai_default_model?.profile_id || prefs.ai_default_profile_id || (prefs.ai_provider_profiles || [])[0]?.id || null,
      model: prefs.ai_default_model?.model || null,
      system_prompt_id: prefs.default_system_prompt_id || null,
    }
    // Backend stamps `story_id` from the currently-loaded story; we
    // don't pass anything here. The new thread will land in the
    // loaded-story folder (or untitled/ if no project is loaded).
    await createThread(seed)
  }

  // Phase 2.11b item 14 — chat panel entry point for Character Chat.
  // Opens the Setup modal with no character pre-populated; the
  // writer picks via the search field. On Confirm, creates a thread
  // pre-seeded with the `character_chat` metadata block + the
  // surface defaults (Persona prompt + model) the modal collected.
  const [setupModalOpen, setSetupModalOpen] = useState(false)
  // Phase 2.12 — two-modal flow state for AI-to-AI chat.
  // `firstCharacterMeta` is set when the writer clicks "Add 2nd
  // Character: AI to AI Chat" in the first Setup modal; it snapshots
  // modal 1's draft (a `CharacterChatMeta` shape) and opens the
  // second modal. Modal 2 carries the same modal component but with
  // `allowAdd2nd=false` so the writer can't recursively add a third.
  // Modal 2's Confirm assembles a `TwoCharacterChatMeta` from
  // [firstCharacterMeta, secondCharacterMeta] and creates the thread.
  // Modal 2's Close (X / Esc) returns the writer to modal 1 (which
  // stays mounted in the background with its draft state intact).
  const [secondSetupModalOpen, setSecondSetupModalOpen] = useState(false)
  const [firstCharacterMeta, setFirstCharacterMeta] = useState(null)
  const charactersList = useEntitiesStore((s) => s.characters)
  async function handleCharacterChatConfirm(meta, opts = {}) {
    setSetupModalOpen(false)
    if (!hasProfile) return
    // Phase 2.11b — seed-building + chain-aware auto-name extracted
    // into the shared `createCharacterChatThread` helper so the two
    // entry points (this thread-browser one + the new entity-detail-
    // panel one) can't drift on name resolution / profile fallback /
    // createThread shape.
    const proj = useProjectStore.getState()
    await createCharacterChatThread(meta, opts, {
      createThread,
      prefs,
      charactersList,
      projectNodes: proj.nodes || [],
      projectEdges: proj.edges || [],
    })
  }
  // Phase 2.12 — modal 1's "Add 2nd Character" routes here. Snapshot
  // modal 1's draft, then open modal 2 layered on top.
  function handleAddSecondCharacter(meta) {
    setFirstCharacterMeta(meta)
    setSecondSetupModalOpen(true)
  }
  // Phase 2.12 — modal 2's Confirm. Pairs the snapshot with the
  // newly-built meta and dispatches to the shared two-character
  // thread-creation helper.
  async function handleSecondCharacterConfirm(secondMeta, opts = {}) {
    setSecondSetupModalOpen(false)
    setSetupModalOpen(false)
    const first = firstCharacterMeta
    setFirstCharacterMeta(null)
    if (!first || !hasProfile) return
    const proj = useProjectStore.getState()
    await createTwoCharacterChatThread(first, secondMeta, opts, {
      createThread,
      prefs,
      charactersList,
      projectNodes: proj.nodes || [],
      projectEdges: proj.edges || [],
    })
  }

  // useCallback the per-row handler refs so memoised ThreadRows can
  // bail out when nothing about their entry has changed. Without this,
  // every keystroke / tag toggle / unrelated store update in the
  // browser parent would rebuild these function refs and force every
  // ThreadRow to re-render. Profile capture
  // `profiling-data.2026-05-31.18-31-58.json` showed `ThreadRow`
  // rendering 1248 times for 412ms self — second-highest known
  // component on the entire profile — caused by exactly this pattern.
  const togglePin = useCallback(async (threadId, currentValue) => {
    await updateThread(threadId, { pinned_in_browser: !currentValue })
  }, [updateThread])
  const rename = useCallback(async (threadId, newName) => {
    if (!newName.trim()) return
    await renameThread(threadId, newName.trim())
  }, [renameThread])
  const removeThread = useCallback(async (threadId) => {
    const choice = await confirmDialog({
      title: 'Delete conversation',
      message: 'Delete this conversation? This cannot be undone — the saved thread file will be removed from disk.',
      buttons: [
        { label: 'Cancel', value: 'cancel', style: 'secondary' },
        { label: 'Delete', value: 'delete', style: 'danger' },
      ],
    })
    if (choice !== 'delete') return
    await deleteThread(threadId)
  }, [deleteThread])
  const setThreadColour = useCallback((threadId, hex) => {
    updateThread(threadId, { colour: hex })
  }, [updateThread])

  // Story-mismatch gate for character-chat threads. Character chats
  // depend on story-specific references — `character_id` resolves
  // against the loaded entity library, `anchor_spec` node ids resolve
  // against the loaded canvas. Opening one while a different project
  // is loaded silently produces broken state (avatar "?" placeholder,
  // dossier walks emit empty entries, send produces the no-character
  // fallback). Regular chats don't have this problem, so the gate
  // only fires for character chats (`is_character_chat` OR
  // `is_two_character_chat` — both depend on character details from
  // the owning project). `story_id === null` ("Untitled" bucket)
  // opens with no gate. See planning doc *Story-mismatch gate on
  // opening a character chat*.
  const openThreadGuarded = useCallback((threadId) => {
    const entry = (index || []).find((e) => e.id === threadId)
    // Mismatch check is by story UUID (`story_id`), not name. The
    // owning project's title comes from a snapshot stored on the
    // thread itself (`entry.story_title`, written at save time) with
    // a fallback to the local categories map. Picking the snapshot
    // first means the message is accurate even when the categories
    // map hasn't seen this story yet (foreign-project thread, fresh
    // install, etc).
    const isCharacterChatKind = entry?.is_character_chat || entry?.is_two_character_chat
    if (isCharacterChatKind && entry.story_id && entry.story_id !== loadedStoryId) {
      const storyTitle = entry.story_title
        || categoriesMap?.[entry.story_id]
        || '(unknown project)'
      const chatLabel = entry.is_two_character_chat ? 'two-character chat' : 'character chat'
      confirmDialog({
        title: 'Wrong project loaded',
        message: `This ${chatLabel} is dependent on character details in the project "${storyTitle}". Load that project to re-load this ${chatLabel}.`,
        buttons: [{ label: 'OK', value: 'ok', style: 'secondary' }],
      })
      return
    }
    setActiveThreadId(threadId)
  }, [index, loadedStoryId, categoriesMap, setActiveThreadId])

  // Split visibleEntries into pinned vs unpinned. The pinned
  // section above gets every pinned entry regardless of which
  // category they belong to; the unpinned grouping below differs
  // per active-tab type (flat for story-specific, grouped tree
  // for All).
  const pinnedEntries = visibleEntries.filter((e) => e.pinned_in_browser)
  const unpinnedEntries = visibleEntries.filter((e) => !e.pinned_in_browser)

  // Render-mode for the unpinned section depends on the active tab.
  const isAllView = activeTab === ALL_TAB

  // For the All view, group unpinned entries by story_id. Sort
  // categories alphabetically by display name; Untitled is always
  // last regardless of name sort. Inside each group sort by
  // updated_at desc (inherited from visibleEntries sort).
  const allViewGroups = useMemo(() => {
    if (!isAllView) return []
    const byKey = new Map()
    for (const entry of unpinnedEntries) {
      const key = entry.story_id || UNTITLED_TAB
      if (!byKey.has(key)) byKey.set(key, [])
      byKey.get(key).push(entry)
    }
    const groups = []
    for (const [key, entries] of byKey.entries()) {
      if (key === UNTITLED_TAB) continue
      const displayName = categoriesMap[key] || '(unnamed story)'
      groups.push({ key, displayName, entries })
    }
    groups.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()))
    if (byKey.has(UNTITLED_TAB)) {
      groups.push({ key: UNTITLED_TAB, displayName: 'Untitled', entries: byKey.get(UNTITLED_TAB) })
    }
    return groups
  }, [isAllView, unpinnedEntries, categoriesMap])

  // Phase 3.12 #2 — shift+click range select. Display order depends
  // on the active view: pinnedEntries first, then unpinnedEntries
  // (story tab) or each All-view group's entries in display order.
  const selectableIdOrder = useMemo(() => {
    const order = []
    for (const e of pinnedEntries) order.push(e.id)
    if (!isAllView) {
      for (const e of unpinnedEntries) order.push(e.id)
    } else {
      for (const g of allViewGroups) {
        for (const e of g.entries) order.push(e.id)
      }
    }
    return order
  }, [pinnedEntries, unpinnedEntries, allViewGroups, isAllView])
  const toggleThreadSelected = useCallback((id, event) => {
    const shift = !!(event && event.shiftKey)
    if (shift && selectionAnchorIdRef.current && selectionAnchorIdRef.current !== id) {
      const startIdx = selectableIdOrder.indexOf(selectionAnchorIdRef.current)
      const endIdx = selectableIdOrder.indexOf(id)
      if (startIdx !== -1 && endIdx !== -1) {
        const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
        setSelectedIds((prev) => {
          const next = new Set(prev)
          for (let i = lo; i <= hi; i++) next.add(selectableIdOrder[i])
          return next
        })
        return
      }
    }
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
    selectionAnchorIdRef.current = id
  }, [selectableIdOrder])

  return (
    <div data-help-region="thread-browser:panel" className="relative h-full overflow-hidden flex flex-col">
      {/* Phase 3.4i — search input + universal TagFilterBar share
          one row so the conversation browser's filter zone matches
          every other tag-filtered library surface. The old
          `TagFilterRow` row below the tab strip is gone. */}
      <div className="px-3 pt-3 pb-2 flex-shrink-0">
        <div className="flex items-start gap-1.5">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or last message…"
            data-help-region="thread-browser:search"
            className="flex-1 min-w-0 bg-zinc-800 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
          />
          <TagFilterBar
            pool="program"
            programScope="conversations"
            filterState={tagFilter}
            onFilterStateChange={setTagFilter}
          />
        </div>
      </div>

      <TabStrip
        activeTab={activeTab}
        onSelect={setActiveTab}
        showLoadedStoryTab={showLoadedStoryTab}
        loadedStoryId={loadedStoryId}
        loadedStoryTitle={loadedStoryTitle}
        showUntitledTab={showUntitledTab}
        rightSlot={
          // Phase 3.10 — recovery / maintenance overflow menu.
          // Pinned to the right edge of the categories row so it
          // doesn't scroll with the tabs and stays one click away
          // from the thread browser the writer's already looking at.
          // Phase 3.12 #2 — sibling select-mode toggle (checklist
          // icon) sits left of the overflow menu, matching the
          // ContextCueSection header pattern.
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => {
                if (selectMode) exitThreadSelectMode()
                else setSelectMode(true)
              }}
              title={selectMode ? 'Exit select mode' : 'Enter select mode to delete multiple conversations at once'}
              aria-label={selectMode ? 'Exit select mode' : 'Enter select mode'}
              aria-pressed={selectMode}
              data-help-region="thread-browser:select_mode"
              className={`text-[11px] px-1.5 py-1 inline-flex items-center transition-colors ${
                selectMode ? 'text-accent-300 hover:text-accent-100' : 'text-zinc-400 hover:text-zinc-100'
              }`}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2" y="2.5" width="5" height="5" rx="0.6" />
                <path d="M3.4 5 L4.2 5.8 L5.8 4.1" />
                <path d="M9 4 H14" />
                <rect x="2" y="9.5" width="5" height="5" rx="0.6" />
                <path d="M9 11 H14" />
              </svg>
            </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setMoreMenuOpen((v) => !v)}
              disabled={rebuilding}
              title="More browser actions"
              data-help-region="thread-browser:more_actions"
              className="px-2 py-1 text-[11px] rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ⋯
            </button>
            {moreMenuOpen && (
              <>
                {/* Backdrop closes the popover on next outside click.
                    z-10 keeps it under the popover but above the
                    rest of the panel. */}
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setMoreMenuOpen(false)}
                />
                <div className="absolute top-full right-0 mt-1 z-20 w-56 bg-zinc-900 border border-zinc-700 rounded shadow-xl py-1">
                  <button
                    type="button"
                    onClick={handleRebuildIndex}
                    disabled={rebuilding}
                    className="w-full text-left px-3 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800/80 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {rebuilding ? 'Rebuilding…' : 'Rebuild thread index'}
                  </button>
                </div>
              </>
            )}
          </div>
          </div>
        }
      />

      {selectMode && (
        <div className="px-3 py-1 flex-shrink-0 flex items-center gap-2 bg-zinc-900/80 border-y border-accent-700/40">
          <span className="text-[10px] text-zinc-400 flex-1">
            {selectedIds.size === 0
              ? 'Select conversations to delete in bulk.'
              : `${selectedIds.size} selected`}
          </span>
          <button
            type="button"
            disabled={selectedIds.size === 0}
            onClick={handleBatchDeleteThreads}
            className="text-[10px] px-2 py-0.5 rounded border border-red-800/60 bg-red-900/30 text-red-200 hover:bg-red-900/50 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Delete the selected conversations"
          >Delete selected</button>
        </div>
      )}

      {indexLoading && !indexLoaded && (
        <div className="px-3 py-2 text-[10px] text-zinc-500 italic">Loading conversations…</div>
      )}
      {lastError && (
        <div className="mx-3 mb-2 text-[10px] text-red-200 border border-red-700/50 bg-red-900/20 rounded px-2 py-1 break-words">
          ✗ {lastError}
        </div>
      )}

      <div data-help-region="thread-browser:threads" className="flex-1 overflow-y-auto px-3 pb-3 space-y-1">
        {totalCount === 0 && indexLoaded && (
          <div className="text-[11px] text-zinc-500 italic text-center pt-4">
            {search.trim()
              ? 'No conversations match your search.'
              : (isAllView ? 'No conversations yet.' : 'No conversations in this tab yet.')}
          </div>
        )}

        {pinnedEntries.length > 0 && (
          <SectionHeader label="Pinned" count={pinnedEntries.length} />
        )}
        {pinnedEntries.map((entry) => (
          <ThreadRow
            key={entry.id}
            entry={entry}
            categoryLabel={isAllView ? (categoriesMap[entry.story_id] || (entry.story_id ? '(unnamed story)' : 'Untitled')) : null}
            matchCount={search.trim() ? (searchHits[entry.id] || 0) : 0}
            allKnownTags={allKnownTags}
            onOpen={openThreadGuarded}
            onTogglePin={togglePin}
            onRename={rename}
            onDelete={removeThread}
            onAddTag={addTagToThread}
            onRemoveTag={removeTagFromThread}
            onSetColour={setThreadColour}
            selectMode={selectMode}
            isSelected={selectedIds.has(entry.id)}
            onToggleSelected={toggleThreadSelected}
          />
        ))}

        {/* Story-specific tab (or Untitled tab): flat list of unpinned
            entries. The Pinned section above handled the pinned bucket. */}
        {!isAllView && (
          <>
            {pinnedEntries.length > 0 && unpinnedEntries.length > 0 && (
              <SectionHeader label="Unpinned" count={unpinnedEntries.length} />
            )}
            {unpinnedEntries.map((entry) => (
              <ThreadRow
                key={entry.id}
                entry={entry}
                categoryLabel={null}
                matchCount={search.trim() ? (searchHits[entry.id] || 0) : 0}
                allKnownTags={allKnownTags}
                onOpen={openThreadGuarded}
                onTogglePin={togglePin}
                onRename={rename}
                onDelete={removeThread}
                onAddTag={addTagToThread}
                onRemoveTag={removeTagFromThread}
                onSetColour={setThreadColour}
                selectMode={selectMode}
                isSelected={selectedIds.has(entry.id)}
                onToggleSelected={toggleThreadSelected}
              />
            ))}
          </>
        )}

        {/* (Bottom container with the "+ New Conversation" button
            lives outside the scroll list — see after the </div>
            below.) */}
        {/* All view: grouped tree. One expandable parent per
            story-category + Untitled at the end. Expand state lives
            in uiStore so it survives tab switches within the
            session. */}
        {isAllView && allViewGroups.map((group) => {
          // `expandedCategories` missing key = expanded by default.
          const collapsed = expandedCategories[group.key] === false
          const headerKey = group.key
          return (
            <div key={headerKey} className="mt-1.5">
              <button
                type="button"
                onClick={() => toggleCategoryExpand(headerKey === UNTITLED_TAB ? null : headerKey)}
                className="w-full flex items-center gap-1.5 px-1 py-1 hover:bg-zinc-800/40 rounded select-none"
              >
                <span className="text-[9px] text-zinc-500 font-mono w-3 text-center flex-shrink-0">
                  {collapsed ? '▶' : '▼'}
                </span>
                <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-300 truncate">
                  {group.displayName}
                </span>
                <span className="text-[9px] text-zinc-600 flex-shrink-0">({group.entries.length})</span>
                <div className="flex-1 h-px bg-zinc-800 ml-1" />
              </button>
              {!collapsed && group.entries.map((entry) => (
                <ThreadRow
                  key={entry.id}
                  entry={entry}
                  categoryLabel={null}  // group header already tells the writer which story they're in
                  matchCount={search.trim() ? (searchHits[entry.id] || 0) : 0}
                  allKnownTags={allKnownTags}
                  onOpen={openThreadGuarded}
                  onTogglePin={togglePin}
                  onRename={rename}
                  onDelete={removeThread}
                  onAddTag={addTagToThread}
                  onRemoveTag={removeTagFromThread}
                  onSetColour={setThreadColour}
                  selectMode={selectMode}
                  isSelected={selectedIds.has(entry.id)}
                  onToggleSelected={toggleThreadSelected}
                />
              ))}
            </div>
          )
        })}
      </div>

      {/* Phase 2.10 Bug 9 — bottom-anchored "+ New Conversation"
          button matching the left-sidebar library's "+ New <thing>"
          pattern (e.g. `EntityLibraryPanel.jsx:832` "+ New Knowledge").
          Same `border-t border-zinc-700 p-2 flex-shrink-0` container,
          same accent-outline button chrome. Warning (no AI profile
          configured) sits inline above the button so the writer sees
          the cause when the button looks disabled. */}
      <div
        className="border-t border-zinc-700 p-2 flex-shrink-0 space-y-2"
        style={{ zoom: 1.25 }}
      >
        {!hasProfile && (
          <div className="text-[11px] text-amber-300 border border-amber-700/40 rounded px-2 py-1.5 leading-relaxed">
            No AI provider connection configured. Open{' '}
            <button
              type="button"
              onClick={() => requestSettingsOpen('mcpApi')}
              className="underline font-medium text-amber-200 hover:text-amber-100"
            >
              Settings → MCP &amp; API Connections
            </button>{' '}
            to add one before starting a conversation.
          </div>
        )}
        <div className="flex items-stretch gap-2">
          <button
            type="button"
            onClick={handleNewConversation}
            disabled={!hasProfile}
            data-help-region="thread-browser:new_conversation"
            className="flex-1 px-2 py-1.5 text-xs rounded bg-accent-700/20 border border-accent-700/40 text-accent-300 hover:bg-accent-700/40 hover:text-accent-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            + New Conversation
          </button>
          {/* Phase 2.11b item 14 — Character Chat entry point.
              Opens the Setup modal with no character pre-populated. */}
          <button
            type="button"
            onClick={() => setSetupModalOpen(true)}
            disabled={!hasProfile}
            data-help-region="thread-browser:new_character_chat"
            className="flex-1 px-2 py-1.5 text-xs rounded bg-accent-700/20 border border-accent-700/40 text-accent-300 hover:bg-accent-700/40 hover:text-accent-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            🎭 Talk to a Character
          </button>
        </div>
      </div>
      <CharacterChatSetupModal
        open={setupModalOpen}
        initialCharacterId={null}
        onConfirm={handleCharacterChatConfirm}
        onClose={() => setSetupModalOpen(false)}
        onConfirmAddSecond={handleAddSecondCharacter}
      />
      {/* Phase 2.12 — second Setup modal layered above the first when
          the writer clicks "Add 2nd Character: AI to AI Chat". The
          second instance receives `allowAdd2nd=false` so the writer
          can't add a third character (two-character chat is the spec
          for v1). Closing the second via X / Esc returns to modal 1
          (which stays mounted in the background with state intact).
          On Confirm, both modals close and the two-character thread
          is created via the shared helper. */}
      <CharacterChatSetupModal
        open={secondSetupModalOpen}
        initialCharacterId={null}
        allowAdd2nd={false}
        onConfirm={handleSecondCharacterConfirm}
        onClose={() => setSecondSetupModalOpen(false)}
      />
    </div>
  )
}


// ── Tab strip ─────────────────────────────────────────────────
function TabStrip({ activeTab, onSelect, showLoadedStoryTab, loadedStoryId, loadedStoryTitle, showUntitledTab, rightSlot }) {
  const stripRef = useRef(null)
  // Translate vertical wheel scroll into horizontal scroll when
  // the strip overflows. Same trick as the previous category-tabs
  // implementation — native listener with passive: false so we
  // can cancel the default vertical scroll cleanly.
  useEffect(() => {
    const el = stripRef.current
    if (!el) return undefined
    function onWheel(e) {
      if (el.scrollWidth <= el.clientWidth) return
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  // Phase 3.10 — `rightSlot` pins to the right of the categories
  // row (e.g. the ⋯ overflow menu). It lives OUTSIDE the scrollable
  // strip so it doesn't scroll away when the writer pans tabs
  // horizontally. The border-bottom moves to the outer wrapper so
  // the slot sits flush with the tab strip's bottom edge.
  return (
    <div data-help-region="thread-browser:tabs" className="flex items-stretch flex-shrink-0 border-b border-zinc-800">
      <div
        ref={stripRef}
        className="flex items-stretch gap-1 px-3 pb-2 overflow-x-auto flex-1 min-w-0"
      >
        <TabButton active={activeTab === ALL_TAB} label="All" onClick={() => onSelect(ALL_TAB)} />
        {showLoadedStoryTab && (
          <TabButton
            active={activeTab === loadedStoryId}
            label={loadedStoryTitle || 'Untitled'}
            onClick={() => onSelect(loadedStoryId)}
            title={loadedStoryTitle || 'The loaded story has no title.'}
          />
        )}
        {showUntitledTab && (
          <TabButton
            active={activeTab === UNTITLED_TAB}
            label="Untitled"
            onClick={() => onSelect(UNTITLED_TAB)}
            title="Threads created with no project loaded, or whose originating story isn't currently loaded."
          />
        )}
      </div>
      {rightSlot && (
        <div className="flex-shrink-0 pr-2 pb-2 flex items-center">
          {rightSlot}
        </div>
      )}
    </div>
  )
}

function TabButton({ active, label, onClick, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex-shrink-0 px-2 py-1 text-[11px] rounded transition-colors max-w-[14rem] truncate ${
        active
          ? 'bg-accent-900/30 text-accent-200 border border-accent-700/60'
          : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 border border-transparent'
      }`}
    >
      {label}
    </button>
  )
}


// ── Section header ─────────────────────────────────────────────
function SectionHeader({ label, count }) {
  return (
    <div className="flex items-center gap-1.5 px-1 pt-2 pb-0.5 first:pt-0">
      <span className="text-[9px] uppercase tracking-wider font-semibold text-zinc-500">{label}</span>
      <span className="text-[9px] text-zinc-600">({count})</span>
      <div className="flex-1 h-px bg-zinc-800" />
    </div>
  )
}


// ── Single thread row ─────────────────────────────────────────
// `memo` so this row only re-renders when its own props actually
// change. Phase 2.11 Bugs & Fixes — profile capture
// `profiling-data.2026-05-31.18-31-58.json` showed `ThreadRow`
// rendering 1248 times for 412 ms self / 421 ms actualMs, the
// second-highest self-time component on the entire profile. The
// browser parent was passing inline-lambda handlers that bound
// `entry.id` (`onOpen={() => setActiveThreadId(entry.id)}`, etc.)
// at the call site — new function references every parent render
// forced every memoised row to re-render. Handler signatures here
// now take `(threadId, ...args)`; the call sites pass stable refs
// (Zustand actions + parent `useCallback`s) and this component does
// the `entry.id` binding at each DOM event handler.
const ThreadRow = memo(function ThreadRow({
  entry, categoryLabel, matchCount,
  allKnownTags,
  onOpen, onTogglePin, onRename, onDelete,
  onAddTag, onRemoveTag, onSetColour,
  // Phase 3.12 #2 — multi-select machinery threaded from the parent.
  selectMode = false, isSelected = false, onToggleSelected,
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.name || '')
  const inputRef = useRef(null)
  // Phase 3.4i — the per-row inline `TagBadge` chip strip was removed
  // in favour of the hover-revealed `ObjectTagsButton` in the action
  // cluster, so the previous `programTagPool` subscription + colour
  // lookup that lived here is gone. The popover surfaces resolve
  // colours from `programTagsStore` themselves.
  // Tag picker pops open from the hover-cluster "+ tag" affordance
  // (moved here from the chip strip to match the cue library's
  // pattern — actions live in the bottom-right cluster, the row
  // body stays clean). Anchored to the trigger button so the
  // popover floats below it.
  const [tagPickerOpen, setTagPickerOpen] = useState(false)
  const tagPickerRef = useRef(null)
  const tagTriggerRef = useRef(null)
  // Per-row colour picker. Open state + anchor ref live alongside
  // the existing row-level state; EntityColorPicker handles its
  // own portal + viewport-aware positioning.
  const [colourPickerOpen, setColourPickerOpen] = useState(false)
  const colourAnchorRef = useRef(null)
  useEffect(() => {
    if (!tagPickerOpen) return undefined
    function onDocClick(e) {
      if (tagPickerRef.current?.contains(e.target)) return
      if (tagTriggerRef.current?.contains(e.target)) return
      setTagPickerOpen(false)
    }
    function onKey(e) {
      if (e.key === 'Escape') setTagPickerOpen(false)
    }
    document.addEventListener('mousedown', onDocClick, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [tagPickerOpen])
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])
  function commitName() {
    setEditing(false)
    const next = draft.trim()
    if (!next || next === entry.name) return
    onRename(entry.id, next)
  }
  function cancelEdit() {
    setEditing(false)
    setDraft(entry.name || '')
  }

  const relativeTime = _formatRelativeTime(entry.updated_at)
  const messageWord = entry.message_count === 1 ? 'message' : 'messages'
  const tags = Array.isArray(entry.tags) ? entry.tags : []
  // Per-thread colour tint mirrors the cue library pattern. When
  // set, the hex drives the row border (full-ish alpha) and a
  // subtle background tint; the default pinned/unpinned chrome is
  // only applied when no colour is set.
  const hasColour = !!entry.colour
  const rowStyle = hasColour
    ? {
        borderColor: entry.colour + '99',
        backgroundColor: entry.colour + '24',
      }
    : undefined
  const defaultRowCls = entry.pinned_in_browser
    ? 'border-accent-700/60 bg-accent-900/10 hover:bg-accent-900/20'
    : 'border-zinc-700 hover:bg-zinc-800/60'

  return (
    <div
      className={`group/thread relative rounded border transition-colors ${
        isSelected ? 'border-accent-600 bg-accent-900/40' : (hasColour ? '' : defaultRowCls)
      }`}
      style={rowStyle}
    >
      <button
        type="button"
        onClick={editing
          ? undefined
          : (selectMode ? (e) => onToggleSelected?.(entry.id, e) : () => onOpen(entry.id))}
        title={selectMode
          ? (isSelected ? 'Click to deselect (shift+click to range-select)' : 'Click to select (shift+click to range-select)')
          : undefined}
        className="w-full text-left px-2 py-1.5 flex items-start gap-1.5"
      >
        {selectMode && (
          <span
            aria-hidden="true"
            className={`mt-0.5 w-3 h-3 flex-shrink-0 rounded-sm border flex items-center justify-center transition-colors ${
              isSelected
                ? 'border-accent-400 bg-accent-700 text-zinc-50'
                : 'border-zinc-600 bg-zinc-900/40'
            }`}
          >
            {isSelected && (
              <svg viewBox="0 0 10 10" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 5 L4 7 L8 2.5" />
              </svg>
            )}
          </span>
        )}
        <div className="flex-1 min-w-0">
        {/* Header uses `items-start` + `leading-tight` and a flex
            chip wrapper for the same reason the cue library does:
            keeps the badge flush against the row card's top edge
            with no invisible line-height / vertical-align drift,
            so visible top whitespace stays equal to visible side
            whitespace. */}
        <div className="flex items-start gap-1.5 min-w-0 leading-tight">
          {entry.pinned_in_browser && (
            <span className="text-[10px] text-accent-300 flex-shrink-0" title="Pinned to the top of this tab">{'📍︎'}</span>
          )}
          {entry.is_character_chat && (
            <span className="text-[10px] flex-shrink-0" title="Character chat">🎭</span>
          )}
          {entry.is_two_character_chat && (
            <span className="text-[10px] flex-shrink-0 whitespace-nowrap" title="Two-character chat">🎭⇆🎭</span>
          )}
          {editing ? (
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commitName}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') { e.preventDefault(); commitName() }
                if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
              }}
              className="flex-1 min-w-0 text-[11px] text-zinc-100 bg-zinc-800 border border-accent-700/60 rounded px-1 py-0 focus:outline-none"
            />
          ) : (
            <div className="flex-1 min-w-0 flex">
              <ConversationLabelChip name={entry.name || 'Untitled'} />
            </div>
          )}
          <span className="text-[9px] text-zinc-500 flex-shrink-0" title={entry.updated_at || ''}>{relativeTime}</span>
          {matchCount > 0 && (
            <span
              className="text-[9px] flex-shrink-0 ml-0.5 px-1.5 rounded-full bg-accent-900/40 text-accent-200 border border-accent-700/60"
              title={`${matchCount} match${matchCount === 1 ? '' : 'es'} inside this conversation`}
            >
              {matchCount}
            </span>
          )}
        </div>
        {entry.last_message_preview && (
          <div className="text-[10px] text-zinc-500 truncate mt-0.5">{entry.last_message_preview}</div>
        )}
        <div className="text-[9px] text-zinc-600 mt-0.5 flex items-center gap-1.5 flex-wrap">
          <span>{entry.message_count} {messageWord}</span>
          {categoryLabel && (
            <span className="text-zinc-500" title={`This thread belongs to "${categoryLabel}"`}>
              · {categoryLabel}
            </span>
          )}
        </div>
        </div>
      </button>
      {/* Phase 3.4i — per-row inline TagBadge strip removed; tag
          glance now lives in the hover-revealed action cluster via
          `ObjectTagsButton` so the row stays visually quieter at
          rest, matching the cue library convention. */}
      {/* Hover-revealed action cluster — top-right of the row,
          overlaying the timestamp area (non-interactive) so the
          tag chip strip below stays fully clickable. Mirrors the
          cue library convention. Hidden entirely while the row is
          in inline rename mode so the cluster doesn't sit on top
          of the title-edit input. */}
      {!editing && (
      <div className={`absolute right-1 top-1 flex items-center gap-0.5 transition-opacity bg-zinc-900/90 rounded px-0.5 ${
        tagPickerOpen || colourPickerOpen ? 'opacity-100' : 'opacity-0 group-hover/thread:opacity-100'
      }`}>
        <button
          type="button"
          ref={colourAnchorRef}
          onClick={(e) => { e.stopPropagation(); setColourPickerOpen((v) => !v) }}
          onContextMenu={(e) => {
            // Right-click clears the custom row colour and reverts
            // to the default pinned/unpinned chrome. `__clear__` is
            // the backend's explicit-clear sentinel for this PATCH
            // field; sending a bare `null` is indistinguishable
            // from "leave alone" on the wire.
            e.preventDefault()
            e.stopPropagation()
            if (entry.colour) onSetColour?.(entry.id, '__clear__')
          }}
          title={entry.colour ? `Row colour: ${entry.colour}. Click to change, right-click to clear.` : 'Set a row colour for this conversation'}
          aria-label="Set row colour"
          className="w-5 h-5 leading-none flex items-center justify-center rounded transition-colors hover:bg-zinc-700/60"
        >
          <span
            className="block w-3 h-3 rounded-sm border"
            style={{
              backgroundColor: entry.colour || 'transparent',
              borderColor: entry.colour ? entry.colour : '#71717a',
              backgroundImage: entry.colour
                ? undefined
                : 'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.08) 50%, transparent 50%, transparent 100%)',
            }}
          />
        </button>
        <RowActionButton
          onClick={(e) => { e.stopPropagation(); onTogglePin(entry.id, entry.pinned_in_browser) }}
          title={entry.pinned_in_browser ? 'Unpin from the top of this tab' : 'Pin to the top of this tab'}
          active={entry.pinned_in_browser}
        >
          {'📍︎'}
        </RowActionButton>
        <button
          type="button"
          ref={tagTriggerRef}
          onClick={(e) => { e.stopPropagation(); setTagPickerOpen((v) => !v) }}
          title="Add a tag to this conversation"
          aria-label="Add a tag"
          aria-expanded={tagPickerOpen}
          className="text-[10px] w-5 h-5 leading-none flex items-center justify-center rounded transition-colors text-zinc-500 hover:text-zinc-100 hover:bg-zinc-700/60"
        >
          +
        </button>
        {/* Phase 3.4i — read-only tag glance for this thread.
            Sibling of the add-tag `+` button so the writer can both
            add and inspect from the same cluster. */}
        <ObjectTagsButton
          pool="program"
          tagNames={tags}
          hostHeader={<ConversationLabelChip name={entry.name || 'Untitled'} />}
          size="xs"
        />
        <RowActionButton
          onClick={(e) => { e.stopPropagation(); setEditing(true) }}
          title="Rename"
        >✎</RowActionButton>
        <RowActionButton
          onClick={(e) => { e.stopPropagation(); onDelete(entry.id) }}
          title="Delete"
          danger
        >🗑</RowActionButton>
        {tagPickerOpen && (
          <div
            ref={tagPickerRef}
            className="absolute right-0 top-full mt-1 z-30 bg-zinc-900 border border-zinc-700 rounded shadow-xl p-2 min-w-[220px]"
          >
            <TagPicker
              currentTags={tags}
              suggestedTags={allKnownTags || []}
              onAdd={(t) => { onAddTag?.(entry.id, t) }}
              onRemove={(t) => { onRemoveTag?.(t) }}
              placeholder="Add tag…"
              autoFocus
            />
          </div>
        )}
      </div>
      )}
      <EntityColorPicker
        value={entry.colour || '#52525b'}
        onChange={(hex) => onSetColour?.(entry.id, hex)}
        anchorEl={colourAnchorRef.current}
        isOpen={colourPickerOpen}
        onClose={() => setColourPickerOpen(false)}
      />
    </div>
  )
})

function RowActionButton({ children, onClick, title, danger, active }) {
  let colour
  if (active) {
    colour = 'bg-accent-700/80 text-white hover:bg-accent-600'
  } else if (danger) {
    colour = 'text-zinc-500 hover:text-red-200 hover:bg-red-900/30'
  } else {
    colour = 'text-zinc-500 hover:text-zinc-100 hover:bg-zinc-700/60'
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`text-[10px] w-5 h-5 leading-none flex items-center justify-center rounded transition-colors ${colour}`}
    >
      {children}
    </button>
  )
}


// ── Time formatting ───────────────────────────────────────────
function _formatRelativeTime(iso) {
  if (!iso) return ''
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return ''
  const now = new Date()
  const deltaMs = now.getTime() - then.getTime()
  const deltaMinutes = Math.round(deltaMs / 60000)
  if (deltaMinutes < 1) return 'just now'
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`
  const deltaHours = Math.round(deltaMinutes / 60)
  if (deltaHours < 24) return `${deltaHours}h ago`
  const deltaDays = Math.round(deltaHours / 24)
  if (deltaDays === 1) return 'yesterday'
  if (deltaDays < 7) return `${deltaDays}d ago`
  const sameYear = now.getFullYear() === then.getFullYear()
  const opts = sameYear
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' }
  try {
    return then.toLocaleDateString(undefined, opts)
  } catch {
    return then.toISOString().slice(0, 10)
  }
}
