import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { useUiStore } from '../../store/uiStore'
import { useSettingsStore } from '../../store/settingsStore'
import { confirm } from '../../store/dialogStore'
import { useAccentColor } from '../../utils/povConstants'
import AccentLogo from '../ui/AccentLogo'
import CoverPlaceholder from '../ui/CoverPlaceholder'
import ProjectCard, { EyeIcon, EyeOffIcon } from './ProjectCard'
import TIPS from '../../data/Tips.json'

// Per-shelf visible count (one page). The modal width is sized so a row of
// (PAGE_SIZE - 1) collapsed cards + 1 expanded card fits without wrapping
// (an expanded card is wider than two collapsed ones, so the width that
// fits the expanded row would otherwise pack in an extra collapsed card and
// wrap on expand — hence the explicit cap). Members beyond this are reached
// via paging (a later 5.5b slice); the shelf label shows the true total.
const PAGE_SIZE = 6

/**
 * Phase 5.5b — Story Library full-screen surface (main shelved view).
 *
 * Opened from the hamburger "Library" entry; covers the editor while open,
 * Close returns to it. Renders the user's ordered shelves (from
 * `GET /library/layout`; first-run default = Recents + Favourites) as
 * labelled rows of `ProjectCard`s, fed by `GET /library`. Hidden stories
 * are filtered out of every shelf (the Hidden section lands later).
 *
 * Card actions are live: Open loads the project (routed through App's
 * unsaved-changes guard via `onOpenProject`, which also re-registers the
 * library entry); Favourite / Hide / Remove call the library API and
 * refresh. Expansion is a single-card accordion across the whole view.
 *
 * This slice covers the shelved view + Recents/Favourites + the actions.
 * Adjacency grouping, paging, drag-reorder, the All tab, add-shelf, and the
 * New-Story / Rename / Add-to-library affordances are later 5.5b slices.
 */

// Normalize a tag to a comparison key: case-insensitive, with space /
// underscore / dash treated as equivalent. (camelCase-boundary handling is
// the dedicated tag-normalization slice; the default layout has no tag
// shelf, so this only bites once a tag shelf is added.)
function normalizeTagKey(t) {
  return String(t || '').toLowerCase().replace(/[\s_-]+/g, '')
}

function byLastOpenedDesc(a, b) {
  return (b.last_opened || 0) - (a.last_opened || 0)
}

// ── All-tab sort (§236) ─────────────────────────────────────────────────
// Sort keys for the All view. Each comparator returns the ASCENDING order;
// descending is the reverse of the sorted list (see sortEntries). Default is
// 'recent' descending (matches the historical recency order).
const SORT_KEYS = [
  ['recent', 'Recent'],     // last_opened
  ['title', 'Title'],
  ['modified', 'Modified'], // file mtime (NOT last_opened)
  ['series', 'Series'],
]

function entryTitle(e) {
  return (e.title || 'Untitled')
}

// The mtime shown on the card: the resolved path's last-modified, else the
// first known path's. 0 when nothing is known (sorts oldest).
function entryMtime(e) {
  const paths = e.paths || []
  const resolved = paths.find((p) => p.path === e.resolved_path) || paths[0]
  return (resolved && resolved.last_modified) || 0
}

function compareAsc(a, b, key) {
  if (key === 'title') return entryTitle(a).localeCompare(entryTitle(b))
  if (key === 'recent') return (a.last_opened || 0) - (b.last_opened || 0)
  if (key === 'modified') return entryMtime(a) - entryMtime(b)
  if (key === 'series') {
    const aHas = !!a.series
    const bHas = !!b.series
    // No-series entries cluster as one group, BEFORE the series ones in
    // ascending (so they fall last when the list is reversed for descending).
    if (aHas !== bHas) return aHas ? 1 : -1
    if (!aHas) return entryTitle(a).localeCompare(entryTitle(b))
    const s = a.series.localeCompare(b.series)
    if (s !== 0) return s
    return (a.series_number ?? Infinity) - (b.series_number ?? Infinity)
  }
  return 0
}

function sortEntries(entries, key, dir) {
  const sorted = entries.slice().sort((a, b) => compareAsc(a, b, key))
  return dir === 'desc' ? sorted.reverse() : sorted
}

// Persist a small UI preference (the All-tab sort) across sessions via
// localStorage (the same store recents use); tolerant of a blocked store.
function readLibPref(key, fallback) {
  try { return window.localStorage.getItem(key) || fallback } catch { return fallback }
}
function writeLibPref(key, value) {
  try { window.localStorage.setItem(key, value) } catch { /* ignore */ }
}

// Keep entries listed in `order` first (in that order), then the rest by the
// fallback sort. Mirrors the shared reconcile's "listed first, append the
// rest" shape (manual drag-order persistence lands in the reorder slice).
function orderByHint(members, order, fallback) {
  const byId = new Map(members.map((m) => [m.id, m]))
  const listedSet = new Set((order || []).filter((id) => byId.has(id)))
  const listed = (order || []).filter((id) => listedSet.has(id)).map((id) => byId.get(id))
  const rest = members.filter((m) => !listedSet.has(m.id)).sort(fallback)
  return [...listed, ...rest]
}

function shelfLabel(shelf) {
  if (shelf.title) return shelf.title
  switch (shelf.type) {
    case 'recents': return 'Recents'
    case 'favourites': return 'Favourites'
    case 'series': return shelf.series || 'Series'
    case 'tag': return `#${shelf.tag || ''}`
    case 'custom': return 'Collection'
    case 'all': return 'All Stories'
    default: return 'Shelf'
  }
}

function shelfMembers(shelf, entries, showHidden = false) {
  const visible = showHidden ? entries.slice() : entries.filter((e) => !e.hidden)
  const byId = new Map(visible.map((e) => [e.id, e]))
  switch (shelf.type) {
    case 'recents': {
      // Recent = recently opened AND still openable (a missing file drops
      // off Recent only, design doc §2.1).
      return visible
        .filter((e) => !e.missing)
        .slice()
        .sort(byLastOpenedDesc)
        .slice(0, shelf.count || 10)
    }
    case 'favourites':
      return orderByHint(visible.filter((e) => e.favourite), shelf.order, byLastOpenedDesc)
    case 'series':
      return visible
        .filter((e) => (e.series || '') === (shelf.series || ''))
        .slice()
        .sort((a, b) => (a.series_number ?? Infinity) - (b.series_number ?? Infinity))
    case 'tag': {
      const key = normalizeTagKey(shelf.tag)
      const tagged = visible.filter((e) => (e.tags || []).some((t) => normalizeTagKey(t) === key))
      return orderByHint(tagged, shelf.order, byLastOpenedDesc)
    }
    case 'custom':
      return (shelf.story_ids || []).map((id) => byId.get(id)).filter(Boolean)
    case 'all':
      return visible.slice().sort(byLastOpenedDesc)
    default:
      return []
  }
}

// Members for a whole group. Derived shelves share one query, so a group shows
// that query across N rows (any shelf yields the same members). Custom
// collections each carry their own story_ids, so a group of same-named
// collections shows the UNION of their members, in order, deduped.
function groupMembers(group, entries, showHidden) {
  if (group.shelves[0].type !== 'custom') {
    return shelfMembers(group.shelves[0], entries, showHidden)
  }
  const seen = new Set()
  const out = []
  for (const shelf of group.shelves) {
    for (const m of shelfMembers(shelf, entries, showHidden)) {
      if (!seen.has(m.id)) { seen.add(m.id); out.push(m) }
    }
  }
  return out
}

function entryToCard(entry) {
  return {
    id: entry.id,
    title: entry.title || 'Untitled',
    description: entry.description || '',
    tags: entry.tags || [],
    series: entry.series,
    seriesNumber: entry.series_number,
    accentColor: entry.accent_color || null,
    favourite: !!entry.favourite,
    hidden: !!entry.hidden,
    pinned: !!entry.pinned_default_path,
    missing: !!entry.missing,
    // Cache-bust by last_opened: the cover cache refreshes on open / save,
    // which bumps last_opened, so the URL changes only when the cover may have.
    coverUrl: entry.has_cover ? `/api/library/cover/${entry.id}?v=${entry.last_opened || 0}` : null,
    paths: (entry.paths || []).map((p) => ({
      path: p.path,
      lastModified: p.last_modified,
      isAutosave: p.is_autosave,
    })),
    resolvedPath: entry.resolved_path || null,
    warning: !!entry.warning,
  }
}

// Horizontal drop-position indicator shown between shelves during a reorder
// drag (as opposed to the merge outline drawn around a compatible shelf).
function InsertionLine() {
  return <div className="h-0.5 -my-1.5 rounded bg-accent-400" />
}

function GripDots() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
      <circle cx="2.5" cy="3" r="1.2" /><circle cx="7.5" cy="3" r="1.2" />
      <circle cx="2.5" cy="7" r="1.2" /><circle cx="7.5" cy="7" r="1.2" />
      <circle cx="2.5" cy="11" r="1.2" /><circle cx="7.5" cy="11" r="1.2" />
    </svg>
  )
}

function PagerChevron({ dir }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dir === 'left' ? <polyline points="15 18 9 12 15 6" /> : <polyline points="9 18 15 12 9 6" />}
    </svg>
  )
}

// Page indicator: prev / next arrows flanking a row of page dots; the current
// page's dot is widened into a pill. Hidden when there's only one page.
function ShelfPager({ page, pageCount, onPrev, onNext, onGoto }) {
  const ref = useRef(null)
  const prevRef = useRef(onPrev)
  const nextRef = useRef(onNext)
  const lastWheel = useRef(0)
  const show = pageCount > 1

  // Keep the latest callbacks in refs so the mount-time wheel listener always
  // invokes the current ones without re-attaching every render.
  useEffect(() => {
    prevRef.current = onPrev
    nextRef.current = onNext
  })

  // Scroll-wheel over the pager steps pages (short cooldown so a trackpad
  // flick doesn't skip many). A native non-passive listener is needed to
  // preventDefault — React's onWheel is passive, so it can't stop the modal
  // from also scrolling.
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    function onWheel(e) {
      e.preventDefault()
      if (e.timeStamp - lastWheel.current < 200) return
      lastWheel.current = e.timeStamp
      if (e.deltaY > 0) nextRef.current?.()
      else if (e.deltaY < 0) prevRef.current?.()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [show])

  if (!show) return null
  return (
    <div ref={ref} className="flex items-center justify-center gap-2 mt-2" title="Scroll to change pages">
      <button
        type="button"
        onClick={onPrev}
        disabled={page === 0}
        title="Previous page"
        className="text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <PagerChevron dir="left" />
      </button>
      <div className="flex items-center gap-1.5">
        {Array.from({ length: pageCount }).map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onGoto(i)}
            title={`Page ${i + 1}`}
            className={`h-1.5 rounded-full transition-all ${
              i === page ? 'w-4 bg-accent-400' : 'w-1.5 bg-zinc-600 hover:bg-zinc-400'
            }`}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onNext}
        disabled={page === pageCount - 1}
        title="Next page"
        className="text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <PagerChevron dir="right" />
      </button>
    </div>
  )
}

// Contiguous shelves with the same type AND filter chain into one group whose
// members flow across the group's rows (design doc §4.1). The group key
// captures "same filter": the tag / series value or the recents count;
// favourites / all have no filter (group by type); custom collections group
// by name (case-insensitive), so two collections with the same name combine.
function normCollName(title) {
  return String(title || '').trim().toLowerCase()
}

function shelfGroupKey(shelf) {
  switch (shelf.type) {
    case 'recents': return `recents:${shelf.count || 10}`
    case 'favourites': return 'favourites'
    case 'all': return 'all'
    case 'series': return `series:${shelf.series || ''}`
    case 'tag': return `tag:${normalizeTagKey(shelf.tag)}`
    case 'custom': return `custom:${normCollName(shelf.title)}`
    default: return `${shelf.type}:${shelf.id}`  // anything else: never groups
  }
}

function groupShelves(shelves) {
  const groups = []
  for (const shelf of shelves) {
    const key = shelfGroupKey(shelf)
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.shelves.push(shelf)
    else groups.push({ key, shelves: [shelf] })
  }
  return groups
}

// A group of one or more contiguous same-type-and-filter shelves: one header,
// the matching members flowing across N rows of PAGE_SIZE (N = shelf count),
// and one pager advancing the whole group. A group of one is just a normal
// single-row shelf.
function ShelfGroup({ group, members, index, dragIndex, mergeTarget, onDragStartGroup, onDragOverGroup, onDropGroup, onDragEndGroup, expandedKey, onToggleExpand, onOpen, onFav, onHide, onRemove, onRemoveShelf, onReorderCards, draggedStoryId, onCardDragStart, onCardDragEnd, onAddToCollection, onRemoveFromCollection, onLocate }) {
  const [page, setPage] = useState(0)
  const dragActive = dragIndex != null
  const dragging = dragIndex === index
  const rowCount = group.shelves.length
  const perPage = rowCount * PAGE_SIZE
  const pageCount = Math.max(1, Math.ceil(members.length / perPage))
  const safePage = Math.min(page, pageCount - 1)
  const pageMembers = members.slice(safePage * perPage, safePage * perPage + perPage)
  const rows = chunk(pageMembers, PAGE_SIZE)
  const groupId = group.shelves[0].id

  // Card drag-reorder (Phase 5.5b §228). Only manual-order shelves carry a
  // user-set order: favourites / tag persist it as `shelf.order`, custom as
  // `story_ids`. Recents / series / all are rule-sorted, so their cards are
  // not draggable. The drag state is LOCAL to the group (separate from the
  // shelf-level reorder state in LibraryView) and a single full-members id
  // order is handed up to persist.
  const manualOrder = group.shelves[0].type === 'favourites'
    || group.shelves[0].type === 'tag'
    || group.shelves[0].type === 'custom'
  const [cardDragId, setCardDragId] = useState(null)
  const [cardDropSlot, setCardDropSlot] = useState(null)  // full-members insertion index

  function commitCardReorder() {
    const dragId = cardDragId
    const slot = cardDropSlot
    setCardDragId(null)
    setCardDropSlot(null)
    if (dragId == null || slot == null) return
    const ids = members.map((m) => m.id)
    const from = ids.indexOf(dragId)
    if (from < 0) return
    if (slot === from || slot === from + 1) return  // dropped onto its own slot
    const without = ids.filter((id) => id !== dragId)
    const insertAt = Math.max(0, Math.min(without.length, from < slot ? slot - 1 : slot))
    without.splice(insertAt, 0, dragId)
    onReorderCards?.(groupId, without)
  }

  // Drag-to-edge cross-page reorder (§229). While a card drag is active and
  // the group has more than one page, holding the cursor at the shelf's left
  // or right edge auto-advances the page so the card can be dropped on a
  // different page. The interval delay before the first flip is a dwell: a
  // quick drop near an edge does not page; only a deliberate hold does.
  const edgeTimerRef = useRef(null)
  const edgeDirRef = useRef(null)
  function stopEdgeScroll() {
    if (edgeTimerRef.current) { clearInterval(edgeTimerRef.current); edgeTimerRef.current = null }
    edgeDirRef.current = null
  }
  function startEdgeScroll(dir) {
    if (edgeDirRef.current === dir) return  // already flipping this way
    stopEdgeScroll()
    edgeDirRef.current = dir
    edgeTimerRef.current = setInterval(() => {
      setPage((p) => (dir === 'next' ? Math.min(pageCount - 1, p + 1) : Math.max(0, p - 1)))
    }, 600)
  }
  useEffect(() => () => { if (edgeTimerRef.current) clearInterval(edgeTimerRef.current) }, [])

  // Cross-shelf add to a custom collection (§225). A card dragged from ANY
  // other shelf can be dropped onto a custom collection to ADD it (a copy by
  // reference, the source shelf is untouched). The drag started elsewhere when
  // this group's own reorder drag is NOT active (cardDragId == null) while a
  // story drag is in flight (draggedStoryId set). Already-present stories are
  // not eligible (no duplicates).
  const isCustom = group.shelves[0].type === 'custom'
  // A group can be several same-named collections; eligibility checks them all.
  const alreadyIn = isCustom && group.shelves.some((s) => (s.story_ids || []).includes(draggedStoryId))
  const addMode = isCustom && cardDragId == null && draggedStoryId != null && !alreadyIn
  const [addOver, setAddOver] = useState(false)
  if (!addMode && addOver) setAddOver(false)  // clear when the drag ends / leaves eligibility

  return (
    <section
      onDragOver={
        dragActive ? (e) => {
          e.preventDefault()
          const rect = e.currentTarget.getBoundingClientRect()
          const half = (e.clientY - rect.top) < rect.height / 2 ? 'top' : 'bottom'
          onDragOverGroup?.(index, half)
        } : (addMode ? (e) => { e.preventDefault(); setAddOver(true) } : undefined)
      }
      onDragLeave={addMode ? () => setAddOver(false) : undefined}
      onDrop={
        dragActive ? (e) => { e.preventDefault(); e.stopPropagation(); onDropGroup?.() }
        : (addMode ? (e) => { e.preventDefault(); setAddOver(false); onAddToCollection?.(group.shelves[0].id, draggedStoryId) } : undefined)
      }
      className={`rounded ${dragging ? 'opacity-50' : ''} ${mergeTarget ? 'outline outline-2 outline-accent-500/70 outline-offset-2' : ''} ${
        addMode ? (addOver ? 'outline outline-2 outline-accent-400 outline-offset-2 bg-accent-500/10' : 'outline-dashed outline-2 outline-accent-500/40 outline-offset-2') : ''
      }`}
    >
      <h2 className="group text-xs uppercase tracking-wider text-zinc-400 mb-2 flex items-baseline gap-2">
        <span
          draggable
          onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStartGroup?.(index) }}
          onDragEnd={() => onDragEndGroup?.()}
          title="Drag to reorder shelves"
          className="cursor-grab self-center opacity-0 group-hover:opacity-100 transition-opacity text-zinc-500 hover:text-zinc-300"
        >
          <GripDots />
        </span>
        <span>{shelfLabel(group.shelves[0])} <span className="text-zinc-600">({members.length})</span></span>
        <button
          type="button"
          onClick={() => onRemoveShelf?.(group.shelves[group.shelves.length - 1].id)}
          title={rowCount > 1 ? 'Remove a row from this group' : 'Remove this shelf'}
          className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-zinc-500 hover:text-red-300 normal-case leading-none"
        >
          {rowCount > 1 ? '−' : '×'}
        </button>
      </h2>
      {members.length === 0 ? (
        isCustom ? (
          <div className={`text-xs italic rounded border border-dashed px-3 py-8 text-center ${
            addMode ? 'border-accent-500/60 text-accent-200' : 'border-zinc-700 text-zinc-600'
          }`}>
            {addMode ? 'Drop to add to this collection' : 'Empty. Drag stories here to add them.'}
          </div>
        ) : (
          <div className="text-xs text-zinc-600 italic">Empty.</div>
        )
      ) : (
        <>
          {/* The whole card-flow area is a drop surface so a release in a
              gap, in the centred margins, or just past the last cover still
              commits at the indicated slot. The per-card handlers stopPropagation,
              so a drop ON a card commits through the card; only dead-zone drops
              fall through to here. */}
          <div
            className="flex flex-col gap-4"
            onDragOver={manualOrder && cardDragId != null ? (e) => {
              e.preventDefault()
              // Auto-page when the cursor is dragged a short distance PAST the
              // cards on the row under it, rather than to a fixed margin
              // position. With few cards (or none expanded) the row is narrow
              // and centred, so a fixed edge zone would sit far out in empty
              // space; measuring the actual card band keeps the trigger close.
              if (pageCount > 1) {
                const SLOP = 28
                const x = e.clientX
                const y = e.clientY
                const rects = [...e.currentTarget.querySelectorAll('[data-libcard]')].map((el) => el.getBoundingClientRect())
                const rowRects = rects.filter((r) => y >= r.top && y <= r.bottom)
                const band = rowRects.length ? rowRects : rects
                if (band.length) {
                  const left = Math.min(...band.map((r) => r.left))
                  const right = Math.max(...band.map((r) => r.right))
                  if (x > right + SLOP) startEdgeScroll('next')
                  else if (x < left - SLOP) startEdgeScroll('prev')
                  else stopEdgeScroll()
                } else stopEdgeScroll()
              }
            } : undefined}
            onDrop={manualOrder && cardDragId != null ? (e) => { e.preventDefault(); stopEdgeScroll(); commitCardReorder() } : undefined}
          >
            {rows.map((row, ri) => (
              <div key={ri} className="flex flex-nowrap items-start gap-4 justify-center">
                {row.map((entry, ci) => {
                  const card = entryToCard(entry)
                  const key = `${groupId}:${entry.id}`
                  const fullIndex = safePage * perPage + ri * PAGE_SIZE + ci
                  const dragging = manualOrder && cardDragId != null
                  // Insertion line: before this card when the slot lands on it;
                  // after the very last card when the slot is the end. The line
                  // is absolutely positioned in the gap so it never reflows the
                  // row (a flex child would shift the whole row).
                  const lineBefore = dragging && cardDropSlot === fullIndex
                  const lineAfter = dragging && fullIndex === members.length - 1 && cardDropSlot === members.length
                  return (
                    <div
                      key={key}
                      data-libcard
                      className={`relative flex-shrink-0 ${cardDragId === entry.id ? 'opacity-40' : ''}`}
                      draggable={expandedKey !== key}
                      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'copyMove'; setCardDragId(entry.id); onCardDragStart?.(entry.id) }}
                      onDragEnd={() => { setCardDragId(null); setCardDropSlot(null); stopEdgeScroll(); onCardDragEnd?.() }}
                      onDragOver={dragging ? (e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        stopEdgeScroll()  // over a card centre = not at an edge
                        const rect = e.currentTarget.getBoundingClientRect()
                        const after = (e.clientX - rect.left) > rect.width / 2
                        setCardDropSlot(after ? fullIndex + 1 : fullIndex)
                      } : undefined}
                      onDrop={dragging ? (e) => { e.preventDefault(); e.stopPropagation(); stopEdgeScroll(); commitCardReorder() } : undefined}
                    >
                      {lineBefore && (
                        <div className="absolute top-0 left-[-10px] w-0.5 h-[13.5rem] rounded bg-accent-400 pointer-events-none z-20" />
                      )}
                      {lineAfter && (
                        <div className="absolute top-0 right-[-10px] w-0.5 h-[13.5rem] rounded bg-accent-400 pointer-events-none z-20" />
                      )}
                      <ProjectCard
                        card={card}
                        expanded={expandedKey === key}
                        onToggleExpand={() => onToggleExpand(key)}
                        onOpen={(path) => onOpen(card, path)}
                        onToggleFavourite={() => onFav(entry.id, entry.favourite)}
                        onHide={() => onHide(entry.id, !!entry.hidden)}
                        onRemove={() => onRemove(card)}
                        onRemoveFromCollection={isCustom ? () => onRemoveFromCollection?.(groupId, entry.id) : undefined}
                        onLocate={() => onLocate(card)}
                      />
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          <ShelfPager
            page={safePage}
            pageCount={pageCount}
            onPrev={() => setPage(Math.max(0, safePage - 1))}
            onNext={() => setPage(Math.min(pageCount - 1, safePage + 1))}
            onGoto={(i) => setPage(i)}
          />
        </>
      )}
    </section>
  )
}

const SHELF_TYPE_OPTIONS = [
  ['recents', 'Recents'],
  ['series', 'Series'],
  ['tag', 'Tag'],
  ['custom', 'Collection'],
  ['all', 'All stories'],
]

// Inline picker for a new shelf (design doc §4). Recents / Series / Tag /
// Collection / All. A Collection starts empty and named; stories are added by
// dragging their cards onto it. Series / Tag pick from the values actually
// present in the library. The built shelf omits `id` — the backend assigns one.
function AddShelfPicker({ entries, onAdd, onCancel }) {
  const [type, setType] = useState('recents')
  const [count, setCount] = useState(10)
  const [series, setSeries] = useState('')
  const [tag, setTag] = useState('')
  const [name, setName] = useState('')

  const seriesOptions = useMemo(
    () => [...new Set(entries.map((e) => e.series).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [entries],
  )
  const tagOptions = useMemo(
    () => [...new Set(entries.flatMap((e) => e.tags || []))].sort((a, b) => a.localeCompare(b)),
    [entries],
  )

  const canAdd =
    type === 'recents' || type === 'all'
    || (type === 'series' && !!series)
    || (type === 'tag' && !!tag)
    || (type === 'custom' && !!name.trim())

  function build() {
    if (type === 'recents') return { type, count: Math.max(1, Number(count) || 10) }
    if (type === 'series') return { type, series }
    if (type === 'tag') return { type, tag }
    if (type === 'custom') return { type, title: name.trim(), story_ids: [] }
    return { type }  // all
  }

  const fieldCls = 'bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200'

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select value={type} onChange={(e) => setType(e.target.value)} className={fieldCls}>
        {SHELF_TYPE_OPTIONS.map(([v, label]) => (
          <option key={v} value={v}>{label}</option>
        ))}
      </select>

      {type === 'recents' && (
        <label className="flex items-center gap-1 text-xs text-zinc-400 normal-case tracking-normal">
          Count
          <input
            type="number"
            min="1"
            value={count}
            onChange={(e) => setCount(e.target.value)}
            className={`w-16 ${fieldCls}`}
          />
        </label>
      )}

      {type === 'series' && (
        seriesOptions.length === 0 ? (
          <span className="text-xs text-zinc-600 italic normal-case tracking-normal">No series in the library yet.</span>
        ) : (
          <select value={series} onChange={(e) => setSeries(e.target.value)} className={fieldCls}>
            <option value="">Pick a series…</option>
            {seriesOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )
      )}

      {type === 'tag' && (
        tagOptions.length === 0 ? (
          <span className="text-xs text-zinc-600 italic normal-case tracking-normal">No tags in the library yet.</span>
        ) : (
          <select value={tag} onChange={(e) => setTag(e.target.value)} className={fieldCls}>
            <option value="">Pick a tag…</option>
            {tagOptions.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )
      )}

      {type === 'custom' && (
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Collection name…"
          className={`w-48 ${fieldCls}`}
        />
      )}

      <button
        type="button"
        onClick={() => onAdd(build())}
        disabled={!canAdd}
        className="text-xs px-3 py-1 rounded bg-accent-600 hover:bg-accent-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Add
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="text-xs px-2 py-1 rounded border border-zinc-600 text-zinc-300 hover:text-zinc-100"
      >
        Cancel
      </button>
    </div>
  )
}

// The "+ Add shelf" affordance, rendered at the bottom of the shelves in the
// shelf-header position; clicking expands the inline picker in place.
function AddShelfControl({ entries, onAdd }) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <section>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
        >
          + Add shelf
        </button>
      </section>
    )
  }
  return (
    <section>
      <h2 className="text-xs uppercase tracking-wider text-zinc-400 mb-2">Add shelf</h2>
      <AddShelfPicker
        entries={entries}
        onAdd={(spec) => { onAdd(spec); setOpen(false) }}
        onCancel={() => setOpen(false)}
      />
    </section>
  )
}

// All-tab search. A leading `#` flips to tag-only mode (match tags only,
// title/description excluded); a plain query matches title + description +
// tags (so a tag matches without needing the `#`). Mirrors the global
// search's `#` prefix; tag matching uses the richer normalized key.
function parseQuery(raw) {
  const trimmed = (raw || '').trim()
  if (trimmed.startsWith('#')) return { term: trimmed.slice(1).trim(), tagOnly: true }
  return { term: trimmed, tagOnly: false }
}

function matchesQuery(entry, term, tagOnly) {
  if (!term) return true
  const tagKey = normalizeTagKey(term)
  const tagHit = !!tagKey && (entry.tags || []).some((t) => normalizeTagKey(t).includes(tagKey))
  if (tagOnly) return tagHit
  const q = term.toLowerCase()
  return (entry.title || '').toLowerCase().includes(q)
    || (entry.description || '').toLowerCase().includes(q)
    || tagHit
}

// Chunk a flat list into rows of `size`. The All tab lays its cards out in
// rows of PAGE_SIZE (like the shelves) so each row is a non-wrapping,
// expansion-sized line — expanding a card never pushes one to the next row.
function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// The show / hide hidden-projects eye. Shared by the Shelves top-right and the
// All-tab control row.
function ShowHiddenToggle({ showHidden, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={showHidden
        ? 'Showing hidden projects. Click to hide them again.'
        : 'Show hidden projects so you can restore them.'}
      className={`p-1 rounded transition-colors ${
        showHidden ? 'text-accent-300 hover:text-accent-200' : 'text-zinc-600 hover:text-zinc-400'
      }`}
    >
      {showHidden ? <EyeIcon className="w-4 h-4" /> : <EyeOffIcon className="w-4 h-4" />}
    </button>
  )
}

// The All tab: every non-hidden story, filtered by the search bar, laid out
// as scrollable rows of PAGE_SIZE cards (the unfiltered safety net, design
// doc §5).
function AllTabView({ entries, query, onQueryChange, expandedKey, onToggleExpand, onOpen, onFav, onHide, onRemove, onLocate, showHidden, onToggleShowHidden, sortKey, sortDir, onSortKeyChange, onToggleSortDir }) {
  const { term, tagOnly } = parseQuery(query)
  const matched = entries.filter((e) => (showHidden || !e.hidden) && matchesQuery(e, term, tagOnly))
  const visible = sortEntries(matched, sortKey, sortDir)
  return (
    <div className="flex flex-col gap-4">
      {/* One row: count (left), search (centred), sort + direction + show-hidden
          (right) — keeps each in its horizontal lane without wasting rows. */}
      <div className="grid grid-cols-[1fr_minmax(0,28rem)_1fr] items-center gap-3">
        <div className="text-[11px] text-zinc-500">
          {visible.length} {visible.length === 1 ? 'story' : 'stories'}{term ? ' matching' : ''}
        </div>
        <div className="relative w-full justify-self-center">
          <input
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search title, description, tags (or #tag for tags only)…"
            className="w-full bg-zinc-800 text-xs text-zinc-100 px-2.5 py-1.5 pr-7 rounded border border-zinc-700 focus:outline-none focus:border-accent-500"
          />
          {query && (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 leading-none"
              title="Clear"
            >
              ×
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 justify-self-end">
          <div className="flex items-center gap-1 text-[11px] text-zinc-400">
            <span className="text-zinc-500">Sort</span>
            <select
              value={sortKey}
              onChange={(e) => onSortKeyChange(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-[11px] text-zinc-200 focus:outline-none focus:border-accent-500"
            >
              {SORT_KEYS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
            <button
              type="button"
              onClick={onToggleSortDir}
              title={sortDir === 'asc' ? 'Ascending (click for descending)' : 'Descending (click for ascending)'}
              className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800 leading-none"
            >
              {sortDir === 'asc' ? '↑' : '↓'}
            </button>
          </div>
          <ShowHiddenToggle showHidden={showHidden} onToggle={onToggleShowHidden} />
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="text-xs text-zinc-600 italic">No stories match.</div>
      ) : (
        <div className="flex flex-col gap-4">
          {chunk(visible, PAGE_SIZE).map((row, ri) => (
            <div key={ri} className="flex flex-nowrap items-start gap-4 justify-center">
              {row.map((entry) => {
                const card = entryToCard(entry)
                const key = `all:${entry.id}`
                return (
                  <ProjectCard
                    key={key}
                    card={card}
                    expanded={expandedKey === key}
                    onToggleExpand={() => onToggleExpand(key)}
                    onOpen={(path) => onOpen(card, path)}
                    onToggleFavourite={() => onFav(entry.id, entry.favourite)}
                    onHide={() => onHide(entry.id, !!entry.hidden)}
                    onRemove={() => onRemove(card)}
                    onLocate={() => onLocate(card)}
                  />
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PlusIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

// The hamburger menu's Open (folder) icon, mirrored here.
function FolderOpenIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

// The hamburger menu's Settings (gear) icon, mirrored here.
function GearIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

// A welcome-panel action styled like a default (placeholder) cover, with a
// centred icon and a label below. Used for New Story (+) and Open (folder).
function WelcomeActionTile({ icon, label, title, accent, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="group flex-1 min-w-0 flex flex-col items-center gap-1.5"
    >
      <div
        className="relative w-full overflow-hidden rounded border bg-zinc-900 transition-transform group-hover:scale-[1.04]"
        style={{ aspectRatio: '2 / 3', borderColor: accent }}
      >
        <CoverPlaceholder className="w-full h-full" />
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-zinc-100 group-hover:bg-black/25 group-hover:text-white transition-colors">
          {icon}
        </div>
      </div>
      <span className="text-xs text-zinc-300 group-hover:text-zinc-100">{label}</span>
    </button>
  )
}

export default function LibraryView({ onOpenProject, onNewStory, onOpenFile, onSettings }) {
  const open = useUiStore((s) => s.libraryOpen)
  const closeLibrary = useUiStore((s) => s.closeLibrary)
  const accent = useAccentColor()
  // Phase 5.5c — startup checkbox, bound to the same preference as the
  // Program Settings toggle (toggling either updates the other).
  const showLibraryOnStartup = useSettingsStore((s) => s.preferences.show_library_on_startup)
  const updatePreferences = useSettingsStore((s) => s.updatePreferences)

  const [entries, setEntries] = useState([])
  const [shelves, setShelves] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [expandedKey, setExpandedKey] = useState(null)
  const [activeTab, setActiveTab] = useState('main')  // 'main' (shelves) | 'all'
  const [allQuery, setAllQuery] = useState('')
  // Reveal hidden projects (so the closed-eye toggle can restore them).
  // Off by default; the toggle lives top-right of the content on both tabs.
  const [showHidden, setShowHidden] = useState(false)
  // All-tab sort (§236). Default recent / desc (the historical recency order);
  // persisted across sessions in localStorage.
  const [allSortKey, setAllSortKeyState] = useState(() => readLibPref('nn-lib-sort-key', 'recent'))
  const [allSortDir, setAllSortDirState] = useState(() => readLibPref('nn-lib-sort-dir', 'desc'))
  const setAllSortKey = useCallback((k) => { setAllSortKeyState(k); writeLibPref('nn-lib-sort-key', k) }, [])
  const toggleAllSortDir = useCallback(() => setAllSortDirState((d) => {
    const next = d === 'asc' ? 'desc' : 'asc'
    writeLibPref('nn-lib-sort-dir', next)
    return next
  }), [])
  // A tip shown in the left panel, re-rolled each time the library opens (§238).
  const [tip, setTip] = useState('')
  const [dragIndex, setDragIndex] = useState(null)  // group index being dragged (shelf reorder)
  // The live drop target during a drag: { mode:'merge', index } (would group
  // with that compatible shelf) or { mode:'insert', slot } (would land at that
  // gap between groups). Null when not over a valid target.
  const [drop, setDrop] = useState(null)
  // The story id of a card currently being dragged, lifted here so any shelf
  // can react (a custom collection lights up as an add target). Null when no
  // card drag is in flight.
  const [draggedStoryId, setDraggedStoryId] = useState(null)

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [lib, layout] = await Promise.all([
        axios.get('/api/library'),
        axios.get('/api/library/layout'),
      ])
      setEntries(lib.data?.entries || [])
      setShelves(layout.data?.shelves || [])
    } catch {
      setError('Could not load the library.')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  // Re-roll the displayed tip each time the library opens (§238).
  useEffect(() => {
    if (open && TIPS.length) setTip(TIPS[Math.floor(Math.random() * TIPS.length)])
  }, [open])

  const handleFav = useCallback(async (id, current) => {
    try {
      await axios.put(`/api/library/${id}/favourite`, { value: !current })
      await load({ silent: true })
    } catch { /* leave the view as-is on failure */ }
  }, [load])

  const handleHide = useCallback(async (id, current = false) => {
    try {
      await axios.put(`/api/library/${id}/hidden`, { value: !current })
      await load({ silent: true })
    } catch { /* ignore */ }
  }, [load])

  const handleRemove = useCallback(async (card) => {
    // Phase 5.6a — warn when removing a favourite / pinned entry.
    const flags = [card.favourite && 'a favourite', card.pinned && 'pinned to a default location'].filter(Boolean)
    const warn = flags.length ? ` Note: this project is ${flags.join(' and ')}.` : ''
    const result = await confirm({
      title: 'Remove from library',
      message: `Remove "${card.title}" from the NarrativeNode library?${warn} Your project file is NOT deleted: this only removes it from the library (its library entry and cached cover), and you can add it back later. The file on disk is left untouched.`,
      buttons: [
        { label: 'Remove from library', value: 'remove', style: 'danger' },
        { label: 'Cancel', value: 'cancel', style: 'secondary' },
      ],
    })
    if (result !== 'remove') return
    try {
      await axios.delete(`/api/library/${card.id}`)
      await load({ silent: true })
    } catch { /* ignore */ }
  }, [load])

  const handleOpen = useCallback((card, path) => {
    onOpenProject?.({ id: card.id, title: card.title, path: path || card.resolvedPath })
  }, [onOpenProject])

  // Phase 5.6a — Cleanup Library: re-scan every entry's paths, strip the
  // dead ones, and remove any project whose files are all missing (the
  // .nnz files are never deleted). Confirms first, then reports the result.
  const handleCleanup = useCallback(async () => {
    const go = await confirm({
      title: 'Clean up library',
      message: 'Re-check every project’s file locations, forget paths that no longer exist, and remove any project whose files are all missing? Your project files are not deleted, only their library entries.',
      buttons: [
        { label: 'Clean up', value: 'go', style: 'danger' },
        { label: 'Cancel', value: 'cancel', style: 'secondary' },
      ],
    })
    if (go !== 'go') return
    try {
      const { data } = await axios.post('/api/library/cleanup')
      await load({ silent: true })
      const removed = data?.entries_removed || 0
      const stripped = data?.paths_stripped || 0
      await confirm({
        title: 'Library cleaned up',
        message: (removed || stripped)
          ? `Removed ${removed} project${removed === 1 ? '' : 's'} whose files were all missing${stripped ? `, and tidied ${stripped} stale path${stripped === 1 ? '' : 's'}` : ''}.`
          : 'Everything is already up to date; there was nothing to clean up.',
        buttons: [{ label: 'OK', value: 'ok', style: 'secondary' }],
      })
    } catch { /* leave the library as-is on failure */ }
  }, [load])

  // Phase 5.6a — Locate: open a native file picker and point a (missing)
  // entry at its moved / found .nnz. The backend verifies the picked file's
  // story id; a match adds the path (clearing missing), a mismatch warns and
  // changes nothing.
  const handleLocate = useCallback(async (card) => {
    try {
      const { data } = await axios.post(`/api/library/${card.id}/locate`)
      if (data?.located) {
        await load({ silent: true })
      } else if (data?.mismatch) {
        await confirm({
          title: 'That is a different story',
          message: `The file you picked is "${data.picked_title}", not "${card.title}", so nothing was changed. Pick the matching .nnz to locate this project.`,
          buttons: [{ label: 'OK', value: 'ok', style: 'secondary' }],
        })
      } else if (data?.error) {
        await confirm({
          title: 'Could not locate',
          message: data.error,
          buttons: [{ label: 'OK', value: 'ok', style: 'secondary' }],
        })
      }
      // cancelled → no-op
    } catch { /* leave the entry as-is on failure */ }
  }, [load])

  // Add / remove a shelf by PUTting the whole layout (a new shelf omits `id`;
  // the backend assigns one and returns the persisted layout).
  const addShelf = useCallback(async (spec) => {
    const next = [...shelves, spec]
    try {
      const { data } = await axios.put('/api/library/layout', { shelves: next })
      setShelves(data?.shelves || next)
    } catch { /* leave the layout as-is on failure */ }
  }, [shelves])

  const removeShelf = useCallback(async (shelfId) => {
    const next = shelves.filter((s) => s.id !== shelfId)
    try {
      const { data } = await axios.put('/api/library/layout', { shelves: next })
      setShelves(data?.shelves || next)
    } catch { /* ignore */ }
  }, [shelves])

  // Persist a card reorder within a manual-order shelf (§228). Favourites /
  // tag store the user's order as `shelf.order` (a hint the membership walk
  // honours); custom collections store it as `story_ids` (the list IS the
  // order). Optimistic so the card lands immediately, then reconciled with
  // the persisted layout.
  const reorderCards = useCallback(async (shelfId, orderedIds) => {
    const next = shelves.map((s) => {
      if (s.id !== shelfId) return s
      return s.type === 'custom' ? { ...s, story_ids: orderedIds } : { ...s, order: orderedIds }
    })
    setShelves(next)
    try {
      const { data } = await axios.put('/api/library/layout', { shelves: next })
      setShelves(data?.shelves || next)
    } catch { /* keep the optimistic order on failure */ }
  }, [shelves])

  // Add a story to a custom collection by dragging its card from any other
  // shelf onto the collection (§225). Appends to `story_ids` (dedup); the
  // source shelf is untouched. Optimistic, then reconciled with the layout.
  const addToCollection = useCallback(async (shelfId, storyId) => {
    if (!storyId) return
    let changed = false
    const next = shelves.map((s) => {
      if (s.id !== shelfId || s.type !== 'custom') return s
      const ids = s.story_ids || []
      if (ids.includes(storyId)) return s
      changed = true
      return { ...s, story_ids: [...ids, storyId] }
    })
    if (!changed) return
    setShelves(next)
    try {
      const { data } = await axios.put('/api/library/layout', { shelves: next })
      setShelves(data?.shelves || next)
    } catch { /* keep the optimistic add on failure */ }
  }, [shelves])

  // Remove a story from a custom collection (strip from `story_ids`). The
  // story stays in the library and every other shelf; only this collection's
  // membership changes. Optimistic, then reconciled with the layout.
  const removeFromCollection = useCallback(async (shelfId, storyId) => {
    const target = shelves.find((s) => s.id === shelfId && s.type === 'custom')
    if (!target) return
    // A group can be several same-named collections; remove from all of them so
    // the story leaves the combined group, not just one underlying collection.
    const key = normCollName(target.title)
    let changed = false
    const next = shelves.map((s) => {
      if (s.type !== 'custom' || normCollName(s.title) !== key) return s
      const ids = s.story_ids || []
      if (!ids.includes(storyId)) return s
      changed = true
      return { ...s, story_ids: ids.filter((id) => id !== storyId) }
    })
    if (!changed) return
    setShelves(next)
    try {
      const { data } = await axios.put('/api/library/layout', { shelves: next })
      setShelves(data?.shelves || next)
    } catch { /* keep the optimistic removal on failure */ }
  }, [shelves])

  // While dragging a group over another: same group key → it would MERGE
  // (outline that shelf); otherwise it's a reorder → show an insertion line
  // at the gap nearest the cursor (top half = before, bottom half = after).
  const handleDragOverGroup = useCallback((index, half) => {
    if (dragIndex == null) return
    if (index === dragIndex) { setDrop(null); return }
    const groups = groupShelves(shelves)
    const sameKey = groups[dragIndex]?.key === groups[index]?.key
    if (sameKey) setDrop({ mode: 'merge', index })
    else setDrop({ mode: 'insert', slot: half === 'top' ? index : index + 1 })
  }, [dragIndex, shelves])

  // Apply the current drop: MERGE places the dragged group's shelves right
  // after the target's (contiguous same-key → groupShelves merges them); a
  // reorder moves the dragged group to the insertion slot. Works on group
  // object refs to avoid index-shift bugs.
  const handleDropGroup = useCallback(async () => {
    const d = drop
    const from = dragIndex
    setDragIndex(null)
    setDrop(null)
    if (from == null || d == null) return
    const groups = groupShelves(shelves)
    const dragged = groups[from]
    if (!dragged) return
    const without = groups.filter((g) => g !== dragged)
    if (d.mode === 'merge') {
      const target = groups[d.index]
      const ti = without.indexOf(target)
      if (ti < 0) return
      without.splice(ti + 1, 0, dragged)
    } else {
      const before = d.slot < groups.length ? groups[d.slot] : null
      if (before === dragged) return  // dropped onto its own gap → no-op
      if (before == null) without.push(dragged)
      else {
        const bi = without.indexOf(before)
        without.splice(bi < 0 ? without.length : bi, 0, dragged)
      }
    }
    const next = without.flatMap((g) => g.shelves)
    try {
      const { data } = await axios.put('/api/library/layout', { shelves: next })
      setShelves(data?.shelves || next)
    } catch { /* ignore */ }
  }, [drop, dragIndex, shelves])

  if (!open) return null

  const isEmpty = !loading && !error && entries.length === 0
  const shelfGroups = groupShelves(shelves)

  return (
    <div
      className="fixed inset-0 z-[55] bg-black/60 flex items-center justify-center p-6"
      onClick={closeLibrary}
    >
      <div
        data-help-region="projects:view"
        className="relative bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl w-[1580px] h-[780px] max-w-[95vw] max-h-[90vh] overflow-hidden flex"
        style={{ boxShadow: `0 0 24px 4px ${accent}33` }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Settings gear — tucked into the modal's top-left corner, equidistant
            from the top + left edges, level with the header row. */}
        <button
          type="button"
          onClick={() => onSettings?.()}
          title="Settings"
          className="absolute top-2 left-2 z-20 p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors"
        >
          <GearIcon className="w-4 h-4" />
        </button>

        {/* Show-Library-on-Startup checkbox in the modal's bottom-left corner,
            equidistant from the edges to match the Settings gear's inset; bound
            to the same preference as the Program Settings toggle (Phase 5.5c). */}
        <label className="absolute bottom-2 left-2 z-20 p-1 flex items-center gap-2 text-[11px] leading-none text-zinc-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showLibraryOnStartup !== false}
            onChange={(e) => updatePreferences({ show_library_on_startup: e.target.checked })}
            style={{ accentColor: accent }}
            className="cursor-pointer"
          />
          Show Library on Startup
        </label>

        {/* Left panel — branding / welcome. The Welcome-modal content folds
            in here (design doc §8.20); the standalone WelcomeModal retire +
            the startup toggle are a later 5.5c slice. */}
        <aside data-help-region="projects:header" className="relative w-64 flex-shrink-0 border-r border-zinc-700 bg-zinc-950/40 flex flex-col items-center px-6 pb-10 text-center">
          {/* Spacer dropping the logo just below the header line (~10px below
              the divider). The Settings gear lives on the modal corner above. */}
          <div className="h-16 flex-shrink-0" />
          <AccentLogo className="w-24 h-24 flex-shrink-0" />
          <div className="mt-3 flex-shrink-0">
            <div className="text-lg font-semibold text-zinc-100">Welcome to NarrativeNode</div>
            <div className="mt-1 text-xs text-zinc-500">Your story library</div>
          </div>
          {/* A random tip, anchored near the bottom (mt-auto). The bottom
              margin reserves room for the upcoming "Show library on startup"
              checkbox (242) so it isn't crowded. */}
          {tip && (
            <div className="mt-auto w-full flex-shrink-0 text-[11px] italic text-zinc-500 leading-snug">
              <span className="not-italic text-zinc-400">Tip: </span>{tip}
            </div>
          )}
          {/* New + Open: cover-styled action tiles, centred vertically against
              the whole modal height (absolute, so the logo/welcome above don't
              shift them off-centre). */}
          <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 px-6 flex gap-3">
            <WelcomeActionTile
              label="New"
              title="Start a new blank story"
              accent={accent}
              icon={<PlusIcon className="w-8 h-8" />}
              onClick={() => onNewStory?.()}
            />
            <WelcomeActionTile
              label="Open"
              title="Open a saved story from a file"
              accent={accent}
              icon={<FolderOpenIcon className="w-8 h-8" />}
              onClick={() => onOpenFile?.()}
            />
          </div>
          {/* Cleanup action: bottom-right of the welcome section, inline with
              the Show Library on Startup checkbox in the modal's bottom-left.
              Subtle bordered button so it reads as a button, not plain text
              (§253). */}
          <button
            type="button"
            onClick={handleCleanup}
            title="Re-check project file locations, forget paths that no longer exist, and remove any project whose files are all missing. Your project files are not deleted."
            className="absolute bottom-2 right-2 z-20 text-[11px] text-zinc-500 hover:text-zinc-300 border border-zinc-700 hover:border-zinc-600 rounded px-2 py-0.5 transition-colors"
          >
            Cleanup
          </button>
        </aside>

        {/* Right — the shelves. */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="grid grid-cols-3 items-center px-4 py-3 border-b border-zinc-700 flex-shrink-0">
            <h1 className="text-base font-semibold text-zinc-100">Library</h1>
            <div className="flex items-center gap-1 text-xs justify-self-center">
              {[['main', 'Shelves'], ['all', 'All']].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => { setActiveTab(id); setExpandedKey(null) }}
                  className={`px-2.5 py-1 rounded transition-colors ${
                    activeTab === id
                      ? 'bg-zinc-700 text-zinc-100'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={closeLibrary}
              className="justify-self-end px-3 py-1.5 text-xs rounded border border-zinc-600 text-zinc-300 hover:bg-zinc-700/50"
              title="Close the library and return to the editor"
            >
              Close
            </button>
          </div>

          <div data-help-region="projects:shelves" className="flex-1 overflow-y-auto px-6 py-5">
            {loading && (
              <div className="text-sm text-zinc-500">Loading library…</div>
            )}

            {error && (
              <div className="text-sm text-red-300">{error}</div>
            )}

            {isEmpty && (
              <div className="flex flex-col items-center justify-center gap-2 text-center py-16">
                <div className="text-sm text-zinc-400">Your story library is empty</div>
                <div className="text-xs text-zinc-600">Open or save a project to add it here.</div>
              </div>
            )}

            {!loading && !error && entries.length > 0 && activeTab === 'main' && (
              <div
                className="relative flex flex-col gap-6"
                // A drop surface for shelf reorder so releasing in the gap
                // between shelves (or on the insertion line itself) still lands
                // at the indicated slot. Sections stopPropagation on their own
                // drop, so a drop ON a shelf commits once through the shelf.
                onDragOver={dragIndex != null ? (e) => e.preventDefault() : undefined}
                onDrop={dragIndex != null ? (e) => { e.preventDefault(); handleDropGroup() } : undefined}
              >
                {/* Show-hidden eye, top-right in line with the first shelf's
                    header (no dedicated row, so the top shelf sits up high). */}
                <div className="absolute top-0 right-0 z-10">
                  <ShowHiddenToggle showHidden={showHidden} onToggle={() => setShowHidden((v) => !v)} />
                </div>
                {shelfGroups.map((g, i) => (
                  <Fragment key={g.shelves[0].id}>
                    {drop?.mode === 'insert' && drop.slot === i && <InsertionLine />}
                    <ShelfGroup
                      group={g}
                      members={groupMembers(g, entries, showHidden)}
                      index={i}
                      dragIndex={dragIndex}
                      mergeTarget={drop?.mode === 'merge' && drop.index === i}
                      onDragStartGroup={(idx) => { setDragIndex(idx); setDrop(null) }}
                      onDragOverGroup={handleDragOverGroup}
                      onDropGroup={handleDropGroup}
                      onDragEndGroup={() => { setDragIndex(null); setDrop(null) }}
                      expandedKey={expandedKey}
                      onToggleExpand={(key) => setExpandedKey((cur) => (cur === key ? null : key))}
                      onOpen={handleOpen}
                      onFav={handleFav}
                      onHide={handleHide}
                      onRemove={handleRemove}
                      onRemoveShelf={removeShelf}
                      onReorderCards={reorderCards}
                      draggedStoryId={draggedStoryId}
                      onCardDragStart={setDraggedStoryId}
                      onCardDragEnd={() => setDraggedStoryId(null)}
                      onAddToCollection={addToCollection}
                      onRemoveFromCollection={removeFromCollection}
                      onLocate={handleLocate}
                    />
                  </Fragment>
                ))}
                {drop?.mode === 'insert' && drop.slot === shelfGroups.length && <InsertionLine />}
                <AddShelfControl entries={entries} onAdd={addShelf} />
              </div>
            )}

            {!loading && !error && entries.length > 0 && activeTab === 'all' && (
              <AllTabView
                entries={entries}
                query={allQuery}
                onQueryChange={setAllQuery}
                expandedKey={expandedKey}
                onToggleExpand={(key) => setExpandedKey((cur) => (cur === key ? null : key))}
                onOpen={handleOpen}
                onFav={handleFav}
                onHide={handleHide}
                onRemove={handleRemove}
                onLocate={handleLocate}
                showHidden={showHidden}
                onToggleShowHidden={() => setShowHidden((v) => !v)}
                sortKey={allSortKey}
                sortDir={allSortDir}
                onSortKeyChange={setAllSortKey}
                onToggleSortDir={toggleAllSortDir}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
