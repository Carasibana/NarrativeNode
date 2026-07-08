/**
 * Phase 2.6 — Context Cue Library section.
 * Phase 2.8 — tag support + sort + pin.
 * Phase 2.8 (v0.2.8.5) — restyled to mirror the conversation thread
 * browser's `ThreadRow` look-and-feel: same row chrome (rounded
 * border, hover bg, pinned accent tint), same `text-[11px]` title
 * + `text-[10px]` preview metrics, same hover-revealed
 * bottom-right action cluster with translucent backdrop, same
 * tag-chip strip pattern.
 *
 * Edit flow:
 *   - Click the title-area card → opens the cue's body in the
 *     right-sidebar TipTap editor.
 *   - ✎ action → switches the row into inline name-edit mode
 *     (Enter / blur saves, Esc cancels).
 *   - 📍︎ action → toggles pinned (pinned cues group at the top
 *     of the library list).
 *   - 🗑 action → delete with confirmation.
 *
 * Sort + pin:
 *   - `contextCuesSort` in `uiStore` selects the order: `manual`
 *     (insertion order, current default), `alpha-asc/desc`,
 *     `recent-desc/asc`. Sort dropdown sits inline with the tag
 *     filter's search input via the `trailing` slot.
 *   - Pinned cues always group at the top regardless of sort;
 *     within the pinned and unpinned groups, the chosen sort
 *     applies.
 *
 * Storage is program-level (`context_cues/` folder, one JSON per
 * cue + `order.json` sidecar); the backend stamps `updated_at`
 * whenever a cue's content actually changes so the "Recent" sort
 * surfaces what the writer's been touching.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useContextCuesStore } from '../../store/contextCuesStore'
import { useUiStore } from '../../store/uiStore'
import { confirm } from '../../store/dialogStore'
import { tiptapHtmlToPlain } from '../../utils/tiptapToMarkdown'
import { matchesTagFilter } from '../../utils/tagFilter'
import { useProgramTagsStore } from '../../store/programTagsStore'
import TagPicker from '../tags/TagPicker'
// Phase 3.4i — `RecentTagFilterBar` mount + per-row inline `TagBadge`
// chip strip removed; the universal `TagFilterBar` lives at the panel
// level and `ObjectTagsButton` handles the per-row glance.
import ObjectTagsButton from '../tags/ObjectTagsButton'
import { CueLabelChip } from '../ui/IdentityBadges'
import EntityColorPicker from '../ui/EntityColorPicker'
import { useAccentColor } from '../../utils/povConstants'
import useLibraryReorder from '../../hooks/useLibraryReorder'


const SORT_OPTIONS = [
  { key: 'manual',      label: 'Manual order',         hint: 'Insertion order (default)' },
  { key: 'alpha-asc',   label: 'Name A → Z' },
  { key: 'alpha-desc',  label: 'Name Z → A' },
  { key: 'recent-desc', label: 'Most recently edited' },
  { key: 'recent-asc',  label: 'Least recently edited' },
]


function _formatRelativeTime(input) {
  // Mirrors `ThreadBrowser._formatRelativeTime` exactly so the
  // cue library's "edited" stamp reads identically to the
  // conversation browser's. Accepts a Unix-ms number (cue
  // payload's `updated_at` shape) or an ISO string — the Date
  // constructor handles both.
  if (input == null || input === '') return ''
  const then = new Date(input)
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


export default function ContextCueSection({ nameFilter = '' }) {
  const cues = useContextCuesStore((s) => s.cues)
  const libraryLayout = useContextCuesStore((s) => s.libraryLayout)
  const loaded = useContextCuesStore((s) => s.loaded)
  const loading = useContextCuesStore((s) => s.loading)
  const loadError = useContextCuesStore((s) => s.loadError)
  const saveError = useContextCuesStore((s) => s.saveError)
  const loadCues = useContextCuesStore((s) => s.loadCues)
  const createCue = useContextCuesStore((s) => s.createCue)
  const updateCue = useContextCuesStore((s) => s.updateCue)
  const deleteCue = useContextCuesStore((s) => s.deleteCue)
  const saveLayout = useContextCuesStore((s) => s.saveLayout)
  const addLibraryDivider = useContextCuesStore((s) => s.addLibraryDivider)
  const updateLibraryDivider = useContextCuesStore((s) => s.updateLibraryDivider)
  const removeLibraryDivider = useContextCuesStore((s) => s.removeLibraryDivider)
  const markTagsUsed = useContextCuesStore((s) => s.markTagsUsed)

  const activeCueId = useUiStore((s) => s.rightSidebarContextCueId)
  const openContextCueEditor = useUiStore((s) => s.openContextCueEditor)

  const tagFilter = useUiStore((s) => s.contextCuesTagFilter)
  const sortKey = useUiStore((s) => s.contextCuesSort)
  const setSortKey = useUiStore((s) => s.setContextCuesSort)

  useEffect(() => { loadCues() }, [loadCues])

  // Phase 3.4i — pre-warm the program-tag pool so the TagFilterBar +
  // ObjectTagsButton popovers can resolve colours/counts immediately
  // on first render. The previous per-row colour-lookup memo (used by
  // the removed inline TagBadge chip strip) is gone; the popover
  // surfaces subscribe to the pool themselves.
  const loadProgramPool = useProgramTagsStore((s) => s.loadPool)
  useEffect(() => { loadProgramPool() }, [loadProgramPool])

  // ── Tag derivations ────────────────────────────────────────────
  // `allKnownTags` still feeds the per-cue TagPicker autocomplete
  // suggestion list. The previous `tagCounts` memo (only consumed by
  // the removed `RecentTagFilterBar`) is gone.
  const allKnownTags = useMemo(() => {
    const set = new Set()
    for (const c of (cues || [])) {
      for (const t of (c.tags || [])) {
        if (t && typeof t === 'string') set.add(t)
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [cues])

  // ── Filter + sort pipeline ────────────────────────────────────
  const filteredCues = useMemo(() => {
    let list = cues || []
    if (nameFilter) {
      const q = nameFilter.toLowerCase()
      list = list.filter((c) => {
        if ((c.name || '').toLowerCase().includes(q)) return true
        const plain = tiptapHtmlToPlain(c.body || '').toLowerCase()
        if (plain.includes(q)) return true
        return false
      })
    }
    list = list.filter((c) => matchesTagFilter(c, tagFilter))
    return list
  }, [cues, nameFilter, tagFilter])

  // Renderable items for the library — a mix of `{ type: 'cue', cue }`
  // and `{ type: 'divider', divider }` entries.
  //
  // Manual sort: walk `libraryLayout` (cue-id strings + divider
  // objects), resolve cue IDs to the filtered cue objects, drop
  // entries whose cue is missing (filtered out or hidden by the
  // tag / name predicates), and append any cues not yet placed in
  // the layout. Pinned cues then float to the top of the cue
  // group while keeping their relative layout order; dividers
  // stay with the unpinned section in layout order.
  //
  // Non-manual sorts (alpha / recent): dividers are HIDDEN
  // entirely — only cue entries render — and the chosen sort
  // applies inside the pinned and unpinned groups. The layout
  // is left untouched, so switching back to manual restores the
  // original divider-aware ordering.
  const orderedItems = useMemo(() => {
    const filteredById = new Map((filteredCues || []).map((c) => [c.id, c]))
    function _sortGroup(group) {
      if (sortKey === 'alpha-asc') {
        return [...group].sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }))
      }
      if (sortKey === 'alpha-desc') {
        return [...group].sort((a, b) => (b.name || '').localeCompare(a.name || '', undefined, { sensitivity: 'base' }))
      }
      if (sortKey === 'recent-desc') {
        return [...group].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
      }
      if (sortKey === 'recent-asc') {
        return [...group].sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0))
      }
      return group
    }

    if (sortKey !== 'manual') {
      const pinned = []
      const unpinned = []
      for (const c of (filteredCues || [])) {
        if (c.pinned) pinned.push(c)
        else unpinned.push(c)
      }
      return [..._sortGroup(pinned), ..._sortGroup(unpinned)].map((cue) => ({ type: 'cue', cue }))
    }

    // Manual: weave layout + dividers + cues.
    const layoutItems = []
    const placed = new Set()
    for (const entry of (libraryLayout || [])) {
      if (typeof entry === 'string') {
        const cue = filteredById.get(entry)
        if (cue) {
          layoutItems.push({ type: 'cue', cue })
          placed.add(entry)
        }
      } else if (entry && entry.type === 'divider' && entry.id) {
        layoutItems.push({ type: 'divider', divider: entry })
      }
    }
    // Append filtered cues not yet placed (newly-added cues that
    // haven't been written into the layout, or layout drift).
    for (const cue of (filteredCues || [])) {
      if (!placed.has(cue.id)) {
        layoutItems.push({ type: 'cue', cue })
      }
    }

    // Pinned float to top in layout order.
    const pinnedItems = layoutItems.filter((it) => it.type === 'cue' && it.cue.pinned)
    const rest = layoutItems.filter((it) => !(it.type === 'cue' && it.cue.pinned))
    return [...pinnedItems, ...rest]
  }, [filteredCues, libraryLayout, sortKey])

  // ── Row-level state ───────────────────────────────────────────
  const [editingNameId, setEditingNameId] = useState(null)
  const [editName, setEditName] = useState('')
  // Phase 3.12 — multi-select + batch delete. `selectMode` toggles the
  // library into selection mode (checkbox column visible, row clicks
  // toggle selection instead of opening the editor); `selectedIds`
  // tracks the picked cues. Dividers are excluded from selection — they
  // have their own per-row delete and aren't cues semantically.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  // Anchor for shift+click range selection. Carries the id of the
  // last cue clicked WITHOUT shift; the next shift+click selects
  // everything in display order between this anchor and the clicked
  // id. Reset on exit-select-mode.
  const selectionAnchorIdRef = useRef(null)
  function selectableIdOrder() {
    // Flat display-order list of cue ids that participate in
    // selection. Dividers don't get checkboxes so they're excluded.
    return (orderedItems || []).filter((it) => it.type === 'cue').map((it) => it.cue.id)
  }
  function toggleSelected(id, event) {
    const shift = !!(event && event.shiftKey)
    if (shift && selectionAnchorIdRef.current && selectionAnchorIdRef.current !== id) {
      const order = selectableIdOrder()
      const startIdx = order.indexOf(selectionAnchorIdRef.current)
      const endIdx = order.indexOf(id)
      if (startIdx !== -1 && endIdx !== -1) {
        const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
        setSelectedIds((prev) => {
          const next = new Set(prev)
          // Range-select adds every id in the span to the selection
          // (it doesn't toggle or replace) — matches the way most
          // shells / file managers treat shift+click while a
          // checkbox-style multi-select is already engaged.
          for (let i = lo; i <= hi; i++) next.add(order[i])
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
  }
  function exitSelectMode() {
    setSelectMode(false)
    setSelectedIds(new Set())
    selectionAnchorIdRef.current = null
  }
  const [tagPickerCueId, setTagPickerCueId] = useState(null)
  const [tagPickerAnchor, setTagPickerAnchor] = useState(null)
  const tagPickerRef = useRef(null)
  const [sortPickerOpen, setSortPickerOpen] = useState(false)
  const sortPickerRef = useRef(null)
  const sortTriggerRef = useRef(null)
  // Per-row colour picker. `colourPickerCueId` is the open cue
  // id; `colourAnchorRefs` holds one ref per cue so EntityColorPicker
  // can position itself against the swatch button. Stored as a
  // ref-keyed object (not state) so writing to a slot doesn't
  // re-render the whole list.
  const [colourPickerCueId, setColourPickerCueId] = useState(null)
  const colourAnchorRefs = useRef({})
  // Manual-sort reorder is driven by the shared
  // `useLibraryReorder` hook (single source of truth for the
  // state machine, grip / row / trailing-zone wiring, and the
  // top-edge / bottom-edge drop indicator). The grip handle is
  // only rendered while `reorderEnabled` (sort === 'manual') so
  // other sort modes can't start a reorder in the first place.
  const accentColor = useAccentColor()
  const reorderEnabled = sortKey === 'manual'
  const reorder = useLibraryReorder({
    total: orderedItems.length,
    enabled: reorderEnabled,
    onCommit: (src, dst) => { commitReorder(src, dst) },
  })

  // Outside-click dismissal for both popovers.
  useEffect(() => {
    if (!tagPickerCueId) return
    function onDown(e) {
      if (!tagPickerRef.current) return
      if (tagPickerRef.current.contains(e.target)) return
      setTagPickerCueId(null)
      setTagPickerAnchor(null)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [tagPickerCueId])
  useEffect(() => {
    if (!sortPickerOpen) return
    function onDown(e) {
      if (sortPickerRef.current?.contains(e.target)) return
      if (sortTriggerRef.current?.contains(e.target)) return
      setSortPickerOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [sortPickerOpen])

  // ── Cue mutations ─────────────────────────────────────────────
  function startNameEdit(cue) {
    setEditingNameId(cue.id)
    setEditName(cue.name)
  }
  async function commitNameEdit() {
    const name = editName.trim()
    if (!name || !editingNameId) { setEditingNameId(null); return }
    try { await updateCue(editingNameId, { name }) } catch { /* surface via saveError */ }
    setEditingNameId(null)
  }
  async function handleBatchDelete() {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    const ok = await confirm({
      title: ids.length === 1 ? 'Delete 1 context cue' : `Delete ${ids.length} context cues`,
      message: ids.length === 1
        ? 'This cue will be removed from the library; any chat sessions that currently have it pinned will lose it on next send.'
        : `These ${ids.length} cues will be removed from the library; any chat sessions that currently have them pinned will lose them on next send.`,
      buttons: [
        { label: ids.length === 1 ? 'Delete' : `Delete ${ids.length}`, value: 'delete', style: 'danger' },
        { label: 'Cancel', value: 'cancel', style: 'default' },
      ],
    })
    if (ok !== 'delete') return
    // Phase 3.12 — loop the existing per-cue delete action. v1 stays
    // on the per-row endpoint instead of adding a backend batch
    // route; small batches (<30 cues) finish in well under a second
    // and surface partial failures via the store's saveError. If
    // perf becomes an issue with bigger imports, the ToDo notes a
    // DELETE /api/ai-context-cues/batch upgrade path.
    for (const id of ids) {
      try { await deleteCue(id) } catch { /* surface via saveError */ }
    }
    exitSelectMode()
  }

  async function handleDelete(cueId) {
    const cue = cues.find((c) => c.id === cueId)
    if (!cue) return
    const ok = await confirm({
      title: 'Delete context cue',
      message: `Delete "${cue.name}"? This cue will be removed from the library; any chat sessions that currently have it pinned will lose it on next send.`,
      buttons: [
        { label: 'Delete', value: 'delete', style: 'danger' },
        { label: 'Cancel', value: 'cancel', style: 'default' },
      ],
    })
    if (ok !== 'delete') return
    try { await deleteCue(cueId) } catch { /* surface via saveError */ }
    if (activeCueId === cueId) openContextCueEditor(cueId)
  }
  async function handleNewCue() {
    const id = crypto.randomUUID()
    const newCue = { id, name: 'Untitled cue', body: '', tags: [], pinned: false }
    try {
      await createCue(newCue)
      openContextCueEditor(id)
      setEditingNameId(id)
      setEditName('')
    } catch { /* surface via saveError */ }
  }
  async function togglePin(cueId) {
    const cur = cues.find((c) => c.id === cueId)
    if (!cur) return
    try { await updateCue(cueId, { pinned: !cur.pinned }) } catch { /* surface via saveError */ }
  }
  async function setCueColour(cueId, hex) {
    try { await updateCue(cueId, { colour: hex || null }) } catch { /* surface via saveError */ }
  }
  async function commitReorder(srcIdx, dstIdx) {
    // Layout-aware reorder. `srcIdx` / `dstIdx` are positions in
    // `orderedItems` (what the writer sees). Each item carries
    // either a cue or a divider; we map the source item back to
    // its position in `libraryLayout`, splice it out, then splice
    // it in at the layout position derived from the destination
    // item (or `layout.length` for `dstIdx === orderedItems.length`
    // — the trailing-zone drop sentinel).
    //
    // The cues array stays UNTOUCHED by this — it's a flat data
    // set, no longer the manual-order source. Manual order lives
    // entirely in the layout, which is why switching sort modes
    // doesn't disturb it.
    if (srcIdx == null || dstIdx == null || srcIdx === dstIdx) return
    if (!reorderEnabled) return  // sanity guard — layout reorder only valid in manual sort
    const srcItem = orderedItems[srcIdx]
    if (!srcItem) return
    const srcKey = srcItem.type === 'cue' ? srcItem.cue.id : srcItem.divider.id

    const layout = [...(libraryLayout || [])]
    function _findKey(key) {
      return layout.findIndex((entry) => (
        typeof entry === 'string'
          ? entry === key
          : !!(entry && entry.id === key)
      ))
    }
    let srcPos = _findKey(srcKey)
    if (srcPos < 0) {
      // Source wasn't yet in the layout (e.g. newly-added cue
      // appended to `orderedItems`). Materialise an entry for it
      // and place at the end before doing the splice — this gives
      // the drop position a stable insertion point.
      const entry = srcItem.type === 'cue'
        ? srcItem.cue.id
        : srcItem.divider
      layout.push(entry)
      srcPos = layout.length - 1
    }
    const [moved] = layout.splice(srcPos, 1)

    let insertPos
    if (dstIdx >= orderedItems.length) {
      insertPos = layout.length
    } else {
      const dstItem = orderedItems[dstIdx]
      if (!dstItem) {
        insertPos = layout.length
      } else {
        const dstKey = dstItem.type === 'cue' ? dstItem.cue.id : dstItem.divider.id
        const dstPos = _findKey(dstKey)
        insertPos = dstPos < 0 ? layout.length : dstPos
      }
    }
    layout.splice(insertPos, 0, moved)
    try { await saveLayout(layout) } catch { /* surface via saveError */ }
  }
  async function addTagToCue(cueId, tag) {
    const trimmed = (tag || '').trim()
    if (!trimmed) return
    const cur = cues.find((c) => c.id === cueId)
    if (!cur) return
    const existing = cur.tags || []
    if (existing.some((t) => t.toLowerCase() === trimmed.toLowerCase())) return
    try {
      await updateCue(cueId, { tags: [...existing, trimmed] })
      markTagsUsed([trimmed])
    } catch { /* surface via saveError */ }
  }
  async function removeTagFromCue(cueId, tag) {
    const cur = cues.find((c) => c.id === cueId)
    if (!cur) return
    const nextTags = (cur.tags || []).filter((t) => t !== tag)
    try { await updateCue(cueId, { tags: nextTags }) } catch { /* surface via saveError */ }
  }

  // ── Render ─────────────────────────────────────────────────────
  const filterIsActive = !!(nameFilter || (tagFilter && ((tagFilter.and?.length || 0) + (tagFilter.or?.length || 0) + (tagFilter.not?.length || 0) > 0)))
  const activeSort = SORT_OPTIONS.find((o) => o.key === sortKey) || SORT_OPTIONS[0]

  const sortTrigger = (
    <button
      ref={sortTriggerRef}
      data-help-region="context-cue-library:sort"
      type="button"
      onClick={() => setSortPickerOpen((v) => !v)}
      title={`Sort: ${activeSort.label}`}
      aria-haspopup="menu"
      aria-expanded={sortPickerOpen}
      aria-label="Sort"
      className="text-zinc-600 hover:text-zinc-300 text-[10px] px-1 inline-flex items-center"
    >
      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <path d="M3 4h10M5 8h6M7 12h2" />
      </svg>
    </button>
  )

  // Header counts. `cueCountMatching` = number of cues passing the
  // active filter (filteredCues already applies the name +
  // tag filters). `cueCountTotal` is the unfiltered base count.
  // When a filter is active we show "(N of M)" so the writer can
  // see what's hidden; otherwise just "(N)" to match the entity-
  // bucket header style.
  const cueCountMatching = (filteredCues || []).length
  const cueCountTotal = (cues || []).length
  const headerCountLabel = filterIsActive
    ? `${cueCountMatching} of ${cueCountTotal}`
    : `${cueCountTotal}`

  return (
    <>
      {/* Section header — single row with title (left) and action
          cluster (right). Title shows the count, filter-aware:
          "N of M" when any filter is active so the writer can see
          what's being hidden, otherwise just "(N)". Action cluster
          carries Sort, Add divider (manual sort only), and the
          Select/Done toggle for batch operations.
          Visual rule: all three action buttons share the same chip
          shape (matched to the sort trigger's footprint) so the
          row reads as a coherent toolbar rather than a grab-bag of
          mismatched controls. */}
      {/* Section header — single row matching the entity-bucket tab
          header style. Title left, minimal icon cluster right:
          [sort] [select/done] [divider]. All three are icon-only
          chips with the same `text-zinc-600 hover:text-zinc-300
          text-[10px] px-1` shape — same as the divider button
          across every entity library tab — so the row reads as a
          unified row of subtle affordances rather than a mismatched
          toolbar. Divider stays right-most to match its position in
          EntityLibraryPanel. */}
      <div data-help-region="context-cue-library:header" className="px-3 py-1 text-xs text-zinc-500 flex-shrink-0 flex items-center justify-between relative">
        <span>Context Cues ({headerCountLabel})</span>
        <div className="flex items-center gap-0.5">
          {!selectMode && sortTrigger}
          <button
            data-help-region="context-cue-library:select_toggle"
            type="button"
            onClick={() => {
              if (selectMode) exitSelectMode()
              else setSelectMode(true)
            }}
            title={selectMode ? 'Exit select mode' : 'Enter select mode to delete multiple cues at once'}
            aria-label={selectMode ? 'Exit select mode' : 'Enter select mode'}
            aria-pressed={selectMode}
            className={`text-[10px] px-1 inline-flex items-center transition-colors ${
              selectMode ? 'text-accent-300 hover:text-accent-100' : 'text-zinc-600 hover:text-zinc-300'
            }`}
          >
            {/* Checklist icon — a box with a tick inside + two list
                lines beside it. Conveys "multi-select for batch
                action" at a glance. */}
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="2.5" width="5" height="5" rx="0.6" />
              <path d="M3.4 5 L4.2 5.8 L5.8 4.1" />
              <path d="M9 4 H14" />
              <rect x="2" y="9.5" width="5" height="5" rx="0.6" />
              <path d="M9 11 H14" />
            </svg>
          </button>
          {reorderEnabled && !selectMode && (
            <button
              type="button"
              onClick={() => { addLibraryDivider() }}
              className="text-zinc-600 hover:text-zinc-300 text-[10px] px-1"
              title="Add divider"
            >┄</button>
          )}
        </div>
        {sortPickerOpen && (
          <div
            ref={sortPickerRef}
            className="absolute right-2 top-7 z-30 bg-zinc-900 border border-zinc-700 rounded shadow-xl py-1 min-w-[180px]"
            role="menu"
          >
            {SORT_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                role="menuitemradio"
                aria-checked={sortKey === opt.key}
                onClick={() => { setSortKey(opt.key); setSortPickerOpen(false) }}
                className={`w-full text-left px-2 py-1 text-[11px] flex items-center gap-2 ${
                  sortKey === opt.key
                    ? 'bg-accent-900/40 text-accent-100'
                    : 'text-zinc-300 hover:bg-zinc-800/80 hover:text-zinc-100'
                }`}
              >
                <span className="w-3 inline-block text-center text-accent-300">
                  {sortKey === opt.key ? '•' : ''}
                </span>
                <span className="flex-1 truncate">{opt.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {selectMode && (
        <div className="px-2 py-1 flex-shrink-0 flex items-center gap-2 bg-zinc-900/80 border-y border-accent-700/40">
          <span className="text-[10px] text-zinc-400 flex-1">
            {selectedIds.size === 0
              ? 'Select cues to delete in bulk.'
              : `${selectedIds.size} selected`}
          </span>
          <button
            type="button"
            disabled={selectedIds.size === 0}
            onClick={handleBatchDelete}
            className="text-[10px] px-2 py-0.5 rounded border border-red-800/60 bg-red-900/30 text-red-200 hover:bg-red-900/50 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Delete the selected cues"
          >Delete selected</button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto min-h-0 px-2 pt-0.5 pb-2 space-y-1.5">
        {loadError && <div className="text-xs text-red-300 italic px-1">{loadError}</div>}
        {saveError && <div className="text-xs text-red-300 italic px-1">{saveError}</div>}
        {!loaded && loading && <p className="text-xs text-zinc-600 italic px-1">Loading…</p>}
        {loaded && orderedItems.length === 0 && (
          <p className="text-xs text-zinc-600 italic px-1">
            {filterIsActive ? 'No cues match the filter.' : 'No context cues yet.'}
          </p>
        )}

        {orderedItems.map((item, idx) => {
          // Divider rows render as a simple horizontal line + grip
          // + inline-editable label + delete button. Mirrors the
          // entity-bucket DividerItem visual.
          if (item.type === 'divider') {
            const divider = item.divider
            const isReorderDragOver = reorderEnabled
              && reorder.dragIdx != null
              && reorder.dragOverIdx === idx
              && reorder.dragIdx !== idx
            const isReorderDragOverAtEnd = reorderEnabled
              && reorder.dragIdx != null
              && reorder.dragOverIdx === orderedItems.length
              && idx === orderedItems.length - 1
              && reorder.dragIdx !== idx
            return (
              <CueDivider
                key={divider.id}
                divider={divider}
                accentColor={accentColor}
                isReorderDragOver={isReorderDragOver}
                isReorderDragOverAtEnd={isReorderDragOverAtEnd}
                rowDropProps={reorder.rowDropProps(idx)}
                gripProps={reorder.gripProps(idx)}
                onTitleChange={(title) => updateLibraryDivider(divider.id, title)}
                onRemove={() => removeLibraryDivider(divider.id)}
              />
            )
          }
          const cue = item.cue
          const isActive = activeCueId === cue.id
          const isEditingName = editingNameId === cue.id
          const cueTags = cue.tags || []
          const pickerOpenHere = tagPickerCueId === cue.id
          const relativeTime = _formatRelativeTime(cue.updated_at)
          const isReorderDragOver = reorderEnabled
            && reorder.dragIdx != null
            && reorder.dragOverIdx === idx
            && reorder.dragIdx !== idx
          // When the writer's drag is over the trailing zone below
          // the last row, paint the indicator as the BOTTOM edge of
          // the last row instead of rendering a separate visual on
          // the zone itself. Reads as "drop will land below this".
          const isReorderDragOverAtEnd = reorderEnabled
            && reorder.dragIdx != null
            && reorder.dragOverIdx === orderedItems.length
            && idx === orderedItems.length - 1
            && reorder.dragIdx !== idx
          // Per-cue colour tint: when the writer has set a colour
          // for this cue it takes precedence over the default
          // active/pinned/neutral chrome. The hex drives both the
          // border (full alpha at ~99%) and the background (subtle
          // ~14% alpha) so the row reads coloured without becoming
          // a solid block. Active selection still tints brighter
          // via the inset ring below.
          const hasColour = !!cue.colour
          const rowStyle = {
            ...(hasColour
              ? {
                  borderColor: cue.colour + '99',
                  backgroundColor: cue.colour + (isActive ? '40' : '24'),
                }
              : {}),
            // Drop indicator: inset shadow at the top edge in the
            // story accent colour, shown when this row is the
            // reorder drop target. boxShadow doesn't affect layout
            // (no row-height shift on hover), and the `inset` keeps
            // the line clipped to the row's rounded border. When the
            // drag is over the trailing zone below the last row,
            // paint the indicator on this (last) row's BOTTOM edge
            // instead so the writer reads it as "drop will land here
            // (after this row)".
            ...(isReorderDragOver ? { boxShadow: `inset 0 2px 0 0 ${accentColor}` } : {}),
            ...(isReorderDragOverAtEnd ? { boxShadow: `inset 0 -2px 0 0 ${accentColor}` } : {}),
          }
          const defaultRowCls = isActive
            ? 'border-accent-700/80 bg-accent-900/30'
            : cue.pinned
              ? 'border-accent-700/60 bg-accent-900/10 hover:bg-accent-900/20'
              : 'border-zinc-700 hover:bg-zinc-800/60'
          const isSelected = selectMode && selectedIds.has(cue.id)
          return (
            <div
              key={cue.id}
              data-help-region="context-cue-library:cue_row"
              draggable={!isEditingName && !selectMode}
              {...(selectMode ? {} : reorder.rowDropProps(idx))}
              onDragStart={selectMode ? undefined : (e) => {
                // Drag handle on the whole row so the writer can
                // drop the cue onto the chat composer to attach
                // it as context (mirroring the
                // entity/knowledge/relationship library DnD
                // sources). The composer's `onDrop` reads this
                // MIME and routes through `addPinnedContextItem`,
                // the same path the AddContext picker uses.
                e.dataTransfer.setData('application/nnz-cue-id', cue.id)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              className={`group/cue relative rounded border transition-colors ${
                isSelected
                  ? 'border-accent-600 bg-accent-900/40'
                  : hasColour ? '' : defaultRowCls
              }`}
              style={rowStyle}
            >
              <button
                type="button"
                onClick={isEditingName
                  ? undefined
                  : (selectMode ? (e) => toggleSelected(cue.id, e) : () => openContextCueEditor(cue.id))}
                title={selectMode
                  ? (isSelected ? 'Click to deselect (shift+click to range-select)' : 'Click to select (shift+click to range-select)')
                  : 'Open in editor'}
                className="w-full text-left px-1.5 py-1.5 flex items-start gap-1.5"
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
                {/* `leading-tight` (line-height 1.25) keeps the
                    chip text from feeling squished without the
                    full ~5px of invisible air the default 1.5
                    line-height would add. `items-start` pins the
                    chip to the top of the row instead of centring
                    it — `items-center` would push the chip down
                    by half the row's slack when the row is taller
                    than the chip (e.g. when the timestamp's line
                    box rounds up), which read as extra blank
                    space above the badge. */}
                <div className="flex items-start gap-1.5 min-w-0 leading-tight">
                  {cue.pinned && (
                    <span className="text-[10px] text-accent-300 flex-shrink-0" title="Pinned to the top of the library">{'📍︎'}</span>
                  )}
                  {isEditingName ? (
                    <input
                      autoFocus
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={commitNameEdit}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') { e.preventDefault(); commitNameEdit() }
                        if (e.key === 'Escape') { e.preventDefault(); setEditingNameId(null) }
                      }}
                      className="flex-1 min-w-0 text-[11px] text-zinc-100 bg-zinc-800 border border-accent-700/60 rounded px-1 py-0 focus:outline-none"
                    />
                  ) : (
                    // Flex wrapper (not block) so the chip is a flex
                    // child rather than an inline-level element in
                    // a line-box. A block wrapper inherits the
                    // ancestor's font-size (default ~14px), making
                    // its line-box ~17.5px tall — taller than the
                    // chip's ~14.5px outer box — so the chip's
                    // `align-middle` would float the chip with
                    // ~1.5px of invisible space above it. Flex
                    // layout eliminates that line-box entirely.
                    <div className="flex-1 min-w-0 flex">
                      <CueLabelChip name={cue.name || 'Untitled'} />
                    </div>
                  )}
                  {!isEditingName && relativeTime && (
                    <span className="text-[9px] text-zinc-500 flex-shrink-0" title={cue.updated_at ? new Date(cue.updated_at).toLocaleString() : ''}>{relativeTime}</span>
                  )}
                </div>
                {!isEditingName && (
                  <div className="flex items-center gap-1 mt-0.5 min-w-0">
                    {/* Reorder grip — Manual sort only, hidden
                        during inline rename. Mirrors the Entity
                        Library's grip pattern (separate drag
                        source from the whole-row drag, with
                        `e.stopPropagation()` on its onDragStart
                        to prevent the chat-attach drag from
                        firing too). Lives in the preview row,
                        aligned with the body-preview text. */}
                    {reorderEnabled && (
                      <span
                        {...reorder.gripProps(idx)}
                        title="Drag to reorder"
                        className="text-zinc-600 hover:text-zinc-300 cursor-grab active:cursor-grabbing opacity-0 group-hover/cue:opacity-100 transition-opacity flex-shrink-0 select-none leading-none"
                        style={{ fontSize: 9 }}
                      >⠿</span>
                    )}
                    {_previewLine(cue.body)
                      ? <div className="text-[10px] text-zinc-500 truncate flex-1 min-w-0">{_previewLine(cue.body)}</div>
                      : <div className="text-[10px] text-zinc-600 italic truncate flex-1 min-w-0">(empty — click to compose)</div>
                    }
                  </div>
                )}
                </div>
              </button>
              {/* Phase 3.4i — per-row inline TagBadge strip
                  removed; tag glance now lives in the hover-revealed
                  action cluster via `ObjectTagsButton` so the row
                  stays visually quieter at rest. */}
              {/* Hover-revealed action cluster — top-right of the
                  row, overlaying the timestamp area (non-interactive)
                  so the tag chip strip below stays fully clickable.
                  Translucent `bg-zinc-900/90` backdrop keeps the
                  underlying timestamp legible enough at rest.
                  Hidden entirely while the row is in inline rename
                  mode so the cluster doesn't sit on top of the
                  title-edit input. */}
              {!isEditingName && (
              <div className={`absolute right-1 top-1 flex items-center gap-0.5 transition-opacity bg-zinc-900/90 rounded px-0.5 ${
                pickerOpenHere || colourPickerCueId === cue.id ? 'opacity-100' : 'opacity-0 group-hover/cue:opacity-100'
              }`}>
                <button
                  type="button"
                  ref={(el) => { colourAnchorRefs.current[cue.id] = el }}
                  onClick={(e) => {
                    e.stopPropagation()
                    setColourPickerCueId((cur) => cur === cue.id ? null : cue.id)
                  }}
                  onContextMenu={(e) => {
                    // Right-click clears the custom row colour and
                    // reverts the row to its default chrome. No-op
                    // when no colour is set, so a right-click on an
                    // already-default swatch doesn't visually change
                    // anything.
                    e.preventDefault()
                    e.stopPropagation()
                    if (cue.colour) setCueColour(cue.id, null)
                  }}
                  title={cue.colour ? `Row colour: ${cue.colour}. Click to change, right-click to clear.` : 'Set a row colour for this cue'}
                  aria-label="Set row colour"
                  className="w-5 h-5 leading-none flex items-center justify-center rounded transition-colors hover:bg-zinc-700/60"
                >
                  <span
                    className="block w-3 h-3 rounded-sm border"
                    style={{
                      backgroundColor: cue.colour || 'transparent',
                      borderColor: cue.colour ? cue.colour : '#71717a',
                      backgroundImage: cue.colour
                        ? undefined
                        : 'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.08) 50%, transparent 50%, transparent 100%)',
                    }}
                  />
                </button>
                <CueRowActionButton
                  onClick={(e) => { e.stopPropagation(); togglePin(cue.id) }}
                  title={cue.pinned ? 'Unpin from the top of the library' : 'Pin to the top of the library'}
                  active={cue.pinned}
                >
                  {'📍︎'}
                </CueRowActionButton>
                <CueRowActionButton
                  onClick={(e) => {
                    e.stopPropagation()
                    if (pickerOpenHere) {
                      setTagPickerCueId(null)
                      setTagPickerAnchor(null)
                      return
                    }
                    const rect = e.currentTarget.getBoundingClientRect()
                    setTagPickerAnchor({
                      cueId: cue.id,
                      top: rect.bottom + 4,
                      left: rect.left,
                    })
                    setTagPickerCueId(cue.id)
                  }}
                  title="Add a tag to this cue"
                >
                  +
                </CueRowActionButton>
                {/* Phase 3.4i — read-only tag glance for this cue.
                    Sibling of the add-tag `+` button so the writer
                    can both add and inspect from the same cluster. */}
                <ObjectTagsButton
                  pool="program"
                  tagNames={cueTags}
                  hostHeader={<CueLabelChip name={cue.name || 'Untitled'} />}
                  size="xs"
                />
                <CueRowActionButton
                  onClick={(e) => { e.stopPropagation(); startNameEdit(cue) }}
                  title="Rename cue"
                >
                  ✎
                </CueRowActionButton>
                <CueRowActionButton
                  onClick={(e) => { e.stopPropagation(); handleDelete(cue.id) }}
                  title="Delete cue"
                  danger
                >
                  🗑
                </CueRowActionButton>
              </div>
              )}
            </div>
          )
        })}
        {/* Trailing drop zone — only rendered while a reorder
            drag is in progress AND manual sort is on. Targets
            `sortedCues.length` as the destination index, which
            `commitReorder` treats as "append to the end of the
            underlying cues array". Without this, the last row
            is unreachable as a drop position — you can only
            drop ON a row, never below the lowest one. The zone
            stays slim (h-3) but renders the same 2px accent
            indicator when active. */}
        {/* Invisible hit-area below the last row so the writer can
            drop a cue BELOW the lowest row. No chrome of its own —
            the visual indicator is painted on the last row's BOTTOM
            edge (via `isReorderDragOverAtEnd` above). */}
        {reorder.trailingZoneProps && (
          <div className="h-8" {...reorder.trailingZoneProps} />
        )}
      </div>

      <div className="border-t border-zinc-700 p-2 flex-shrink-0">
        <button
          data-help-region="context-cue-library:new_cue"
          onClick={handleNewCue}
          className="w-full px-2 py-1.5 text-xs rounded bg-accent-700/20 border border-accent-700/40 text-accent-300 hover:bg-accent-700/40 hover:text-accent-200 transition-colors"
        >
          + New Cue
        </button>
      </div>
      {/* Portalled TagPicker popover — escapes the sidebar's
          overflow-clip via `document.body` + `position: fixed`. */}
      {/* Colour picker mount — only one cue's picker is open at a
          time. EntityColorPicker handles its own portal +
          positioning against `anchorEl`. */}
      {colourPickerCueId && (() => {
        const cue = (cues || []).find((c) => c.id === colourPickerCueId)
        if (!cue) return null
        return (
          <EntityColorPicker
            value={cue.colour || '#52525b'}
            onChange={(hex) => setCueColour(cue.id, hex)}
            anchorEl={colourAnchorRefs.current[cue.id] || null}
            isOpen={true}
            onClose={() => setColourPickerCueId(null)}
          />
        )
      })()}
      {tagPickerCueId && tagPickerAnchor && (() => {
        const cue = (cues || []).find((c) => c.id === tagPickerCueId)
        if (!cue) return null
        const popoverW = 240
        const left = Math.max(8, Math.min(tagPickerAnchor.left, (typeof window !== 'undefined' ? window.innerWidth - popoverW - 8 : tagPickerAnchor.left)))
        return createPortal(
          <div
            ref={tagPickerRef}
            className="bg-zinc-900 border border-zinc-700 rounded shadow-xl p-2 min-w-[220px]"
            style={{ position: 'fixed', top: tagPickerAnchor.top, left, zIndex: 60 }}
          >
            <TagPicker
              currentTags={cue.tags || []}
              suggestedTags={allKnownTags}
              onAdd={(t) => addTagToCue(cue.id, t)}
              onRemove={(t) => removeTagFromCue(cue.id, t)}
              placeholder="Add tag…"
              autoFocus
            />
          </div>,
          document.body,
        )
      })()}
    </>
  )
}


function _previewLine(body) {
  const text = tiptapHtmlToPlain(body || '')
  if (!text) return ''
  return text.length > 64 ? text.slice(0, 64) + '…' : text
}


// Action-button helper — same chrome as the thread browser's
// `RowActionButton` so the two surfaces feel consistent. Three
// states: default / danger (red on hover) / active (accent fill).
// Library divider row for the cue list. Mirrors the entity-bucket
// `DividerItem`: ⠿ grip handle on the left (drives layout-reorder
// via the shared `useLibraryReorder` hook), thin horizontal line
// across the middle, inline-editable label on the right, and a
// hover-revealed × delete button. The drop indicator (top edge
// in-between, bottom edge for drop-at-end) is composed from
// the `isReorderDragOver` / `isReorderDragOverAtEnd` booleans
// derived in the parent so it matches the cue rows' visual.
function CueDivider({
  divider, accentColor,
  isReorderDragOver, isReorderDragOverAtEnd,
  rowDropProps, gripProps,
  onTitleChange, onRemove,
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(divider.title || '')
  useEffect(() => { setTitle(divider.title || '') }, [divider.title])
  function commitTitle() {
    onTitleChange(title)
    setEditing(false)
  }
  const rowStyle = {
    borderTop: isReorderDragOver ? `2px solid ${accentColor}` : '2px solid transparent',
    ...(isReorderDragOverAtEnd ? { boxShadow: `inset 0 -2px 0 0 ${accentColor}` } : {}),
  }
  return (
    <div
      className="flex items-center gap-1 px-1 py-0.5 group/divider"
      style={rowStyle}
      {...rowDropProps}
    >
      <span
        {...gripProps}
        className="text-zinc-600 hover:text-zinc-300 cursor-grab active:cursor-grabbing opacity-0 group-hover/divider:opacity-100 transition-opacity flex-shrink-0 select-none leading-none"
        style={{ fontSize: 9 }}
        title="Drag to reorder"
      >⠿</span>
      <div className="flex-1 border-t border-zinc-600 my-1" />
      {editing ? (
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitTitle()
            if (e.key === 'Escape') { setTitle(divider.title || ''); setEditing(false) }
          }}
          className="bg-transparent text-[9px] text-zinc-400 focus:outline-none w-20 text-right"
          placeholder="Label..."
        />
      ) : (
        <span
          className={`text-[9px] cursor-pointer hover:text-zinc-300 truncate max-w-[80px] ${
            divider.title ? 'text-zinc-500' : 'text-zinc-500 opacity-0 group-hover/divider:opacity-100 transition-opacity'
          }`}
          onClick={() => setEditing(true)}
          title={divider.title || 'Click to add label'}
        >
          {divider.title || '...'}
        </span>
      )}
      <button
        type="button"
        className="text-zinc-700 hover:text-red-400 opacity-0 group-hover/divider:opacity-100 transition-opacity flex-shrink-0 text-[9px]"
        onClick={onRemove}
        title="Remove divider"
      >×</button>
    </div>
  )
}


function CueRowActionButton({ children, onClick, title, danger, active }) {
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
