/**
 * Phase 3.4i — Universal Tag Filter Bar.
 *
 * Drop-in component for every library panel's filter row. Replaces
 * the bespoke filter UI in Context Cues + Conversations (TagPicker +
 * TagCloud + TagExpandModal + RecentTagFilterBar combo) AND adds tag
 * filtering to entity-family library panels that didn't have it.
 *
 * Two visual zones:
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │ ... [filter input rendered by parent] [⌧ 🏷 3 ▾] │   ← trigger
 *   ├──────────────────────────────────────────────────┤
 *   │  [+ #MAGIC] [| #LORE] [− #DRAFT]                 │   ← active-filter
 *   └──────────────────────────────────────────────────┘     row (hidden when empty)
 *
 * Pool-agnostic via the `pool` prop:
 *   - `'project'` — Project Tags pool from `entitiesStore.projectTags`.
 *                   Filter state contains tag UUIDs. Counts computed
 *                   internally via a single-pass walk of every chain-
 *                   trackable host (same shape `TagsAndListsSection`
 *                   uses for its library row counts).
 *   - `'program'` — Program Tags pool from `programTagsStore.pool`.
 *                   Filter state contains tag NAMES (case-insensitive).
 *                   Counts come precomputed from the backend pool
 *                   aggregation endpoint.
 *
 * Filter state shape (both pools): `{ and: string[], or: string[], not: string[] }`.
 *
 * Locked Pre-Prep decisions (Phase 3.4i):
 *   - Trigger: funnel SVG + 🏷️ emoji + count suffix when at least one
 *     tag is active in any bucket.
 *   - Popover sort: pure alphabetical, case-insensitive. Count is
 *     still computed + displayed on each chip but does NOT drive the
 *     sort — stable order is more important than ranking-by-popularity
 *     so the writer's mental map of the popover doesn't reshuffle as
 *     they tag/untag hosts mid-session.
 *   - Popover chip cycle: full 4-state `null → AND → OR → NOT → null`.
 *   - Active-row chip cycle: 3-state `AND → OR → NOT → AND`; the `×`
 *     button is the only way to remove a tag from the active filter.
 *
 * Props:
 *   - `pool`: `'project' | 'program'`
 *   - `filterState`: `{ and, or, not }`
 *   - `onFilterStateChange(next)`
 *   - `triggerLabel?`: defaults to `'Tags'` (rendered next to the
 *                      funnel + 🏷 glyphs; small text label for
 *                      affordance discoverability)
 *   - `size?`: passes through to inner `TagBadge` size inside
 *             `TagFilterChip`; defaults to `'sm'`.
 *   - `programScope?`: only meaningful when `pool='program'`. One of
 *                       `'cues' | 'conversations' | 'all'` (default
 *                       `'all'`). Scopes the program pool to count
 *                       only the relevant host kind AND hides tags
 *                       that have zero hosts in the chosen scope so
 *                       the filter doesn't surface tags that match
 *                       nothing in the active list. Without this
 *                       scoping, a tag carried only by a Conversation
 *                       still appears in the Cues tab filter with
 *                       count 1, even though no cue carries it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import TagFilterChip from './TagFilterChip'
import { isEmptyTagFilter } from '../../utils/tagFilter'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProjectStore } from '../../store/projectStore'
import { useProgramTagsStore } from '../../store/programTagsStore'

const POPOVER_WIDTH = 340
const ANCHOR_GAP = 4

// Funnel icon as inline SVG so we don't introduce a new asset dep.
function FunnelGlyph({ size = 12 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d="M2 2.5h12a.5.5 0 0 1 .4.8L9.5 9.4V13a.5.5 0 0 1-.78.42l-2-1.33A.5.5 0 0 1 6.5 12V9.4L1.6 3.3a.5.5 0 0 1 .4-.8Z" />
    </svg>
  )
}

export default function TagFilterBar({
  pool,
  filterState,
  onFilterStateChange,
  triggerLabel = 'Tags',
  size = 'sm',
  programScope = 'all',
}) {
  if (pool !== 'project' && pool !== 'program') {
    throw new Error(`TagFilterBar: \`pool\` prop must be 'project' or 'program', got "${pool}"`)
  }
  if (programScope !== 'all' && programScope !== 'cues' && programScope !== 'conversations') {
    throw new Error(`TagFilterBar: \`programScope\` prop must be 'all' | 'cues' | 'conversations', got "${programScope}"`)
  }

  const safeState = filterState || { and: [], or: [], not: [] }
  const activeCount =
    (safeState.and?.length || 0) +
    (safeState.or?.length || 0) +
    (safeState.not?.length || 0)
  const isEmpty = isEmptyTagFilter(safeState)

  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const triggerRef = useRef(null)
  const popoverRef = useRef(null)

  // ── Pool data subscriptions ────────────────────────────────────────
  // Project pool: tag pool + every host slice we need to compute
  // usage counts (single-pass walk identical to the one
  // `TagsAndListsSection` uses).
  const projectTags = useEntitiesStore((s) => s.projectTags)
  const knowledges = useProjectStore((s) => s.knowledges)
  const relationships = useProjectStore((s) => s.relationships)
  const nodes = useProjectStore((s) => s.nodes)
  const characters = useEntitiesStore((s) => s.characters)
  const locations = useEntitiesStore((s) => s.locations)
  const items = useEntitiesStore((s) => s.items)
  const factions = useEntitiesStore((s) => s.factions)
  const customs = useEntitiesStore((s) => s.customs)
  const presetLists = useEntitiesStore((s) => s.presetLists)
  // Program pool: backend-aggregated `{name, color, count, ...}` list.
  const programPool = useProgramTagsStore((s) => s.pool)

  // Sorted pool with counts ready for the popover render. Same sort
  // contract for both pools: pure alphabetical (case-insensitive).
  // The count stays available on each entry for the chip's `(N)`
  // suffix render but does NOT drive the sort — stable order is more
  // important than ranking-by-popularity, since count changes mid-
  // session as the writer tags/untags hosts would otherwise reshuffle
  // the popover unexpectedly. (Originally locked Pre-Prep decision
  // was "descending by count, alphabetical tie-break" matching 3.4e's
  // library row sort; revised during 3.4i implementation review.)
  const sortedPool = useMemo(() => {
    if (pool === 'program') {
      // Phase 3.4i — scope the program pool count by host kind so a
      // tag carried only by a Conversation doesn't surface in the
      // Cues tab filter (and vice versa). Tags with zero hosts in
      // the chosen scope are dropped entirely — otherwise the writer
      // sees them in the dropdown, requires the tag, and gets an
      // empty list with no obvious reason.
      const rows = []
      for (const t of (programPool || [])) {
        const cueCount = t.cue_count || 0
        const conversationCount = t.conversation_count || 0
        let count
        if (programScope === 'cues') count = cueCount
        else if (programScope === 'conversations') count = conversationCount
        else count = typeof t.count === 'number' ? t.count : (cueCount + conversationCount)
        if (count <= 0) continue
        rows.push({
          id: (t.name || '').toLowerCase(),
          name: t.name || '',
          color: t.color || '#888888',
          count,
        })
      }
      rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      return rows
    }
    // Project pool — compute distinct-host counts via single-pass
    // walk identical to `TagsAndListsSection`'s `projectTagCounts`.
    const tally = {}
    const bump = (tagId, hostKey) => {
      if (!tagId || !hostKey) return
      if (!tally[tagId]) tally[tagId] = new Set()
      tally[tagId].add(hostKey)
    }
    for (const bucket of [characters, locations, items, factions, customs]) {
      for (const e of (bucket || [])) {
        for (const id of (e.tag_ids || [])) bump(id, `entity:${e.id}`)
      }
    }
    for (const k of (knowledges || [])) {
      for (const id of (k.tag_ids || [])) bump(id, `knowledge:${k.id}`)
      for (const ev of (k.history?.tag_changes || [])) {
        if (ev?.action === 'add' && ev.tag_id) bump(ev.tag_id, `knowledge:${k.id}`)
      }
    }
    for (const r of (relationships || [])) {
      for (const id of (r.tag_ids || [])) bump(id, `relationship:${r.id}`)
      for (const ev of (r.history?.tag_changes || [])) {
        if (ev?.action === 'add' && ev.tag_id) bump(ev.tag_id, `relationship:${r.id}`)
      }
    }
    for (const pl of (presetLists || [])) {
      for (const id of (pl.tag_ids || [])) bump(id, `presetList:${pl.id}`)
    }
    for (const n of (nodes || [])) {
      if (n.type === 'referenceNode') {
        for (const id of (n.data?.tag_ids || [])) bump(id, `referenceNode:${n.id}`)
      } else if (n.type === 'sceneNode') {
        for (const bucket of ['characters', 'locations', 'items', 'factions', 'customs']) {
          for (const ref of (n.data?.[bucket] || [])) {
            for (const ev of (ref.tag_changes || [])) {
              if (ev?.action === 'add' && ev.tag_id) bump(ev.tag_id, `entity:${ref.entity_id}`)
            }
          }
        }
      } else if (n.type === 'entityNode' && n.data?.is_modifier && n.data?.entity_id) {
        for (const ev of (n.data?.tag_changes || [])) {
          if (ev?.action === 'add' && ev.tag_id) bump(ev.tag_id, `entity:${n.data.entity_id}`)
        }
      }
    }
    const rows = (projectTags || []).map((t) => ({
      id: t.id,
      name: t.name || '',
      color: t.color || '#888888',
      count: tally[t.id]?.size || 0,
    }))
    rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    return rows
  }, [pool, programScope, projectTags, programPool, characters, locations, items, factions, customs, knowledges, relationships, nodes, presetLists])

  // Pool filtered by the in-popover search query.
  const filteredPool = useMemo(() => {
    const q = searchQuery.replace(/^#+/, '').trim().toLowerCase()
    if (!q) return sortedPool
    return sortedPool.filter((r) => (r.name || '').toLowerCase().includes(q))
  }, [sortedPool, searchQuery])

  // ── State transition helpers ───────────────────────────────────────
  // Cycle a tag's filter state. Pool-agnostic since the filter state
  // shape is the same for both pools (string ids OR lower-cased names).
  const transitionTag = useCallback((tagId, nextState) => {
    const next = {
      and: (safeState.and || []).filter((id) => id !== tagId),
      or:  (safeState.or  || []).filter((id) => id !== tagId),
      not: (safeState.not || []).filter((id) => id !== tagId),
    }
    if (nextState === 'and') next.and.push(tagId)
    else if (nextState === 'or') next.or.push(tagId)
    else if (nextState === 'not') next.not.push(tagId)
    // 'null' → already removed from all three buckets above
    onFilterStateChange?.(next)
  }, [safeState, onFilterStateChange])

  const clearAll = useCallback(() => {
    onFilterStateChange?.({ and: [], or: [], not: [] })
  }, [onFilterStateChange])

  // Map filter state → per-tag-id current state for the popover chip
  // render. Project pool stores ids as-is; program pool stores
  // lower-cased name as the canonical key (matches `sortedPool` row.id).
  const stateOfTag = useCallback((tagId) => {
    if ((safeState.and || []).includes(tagId)) return 'and'
    if ((safeState.or  || []).includes(tagId)) return 'or'
    if ((safeState.not || []).includes(tagId)) return 'not'
    return 'null'
  }, [safeState])

  // ── Popover open/close behaviour ───────────────────────────────────
  const closePopover = useCallback(() => {
    setOpen(false)
    setSearchQuery('')  // clear search on close — opens fresh next time
  }, [])

  // Escape + click-outside dismiss.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closePopover() }
    }
    const onDown = (e) => {
      if (popoverRef.current?.contains(e.target)) return
      if (triggerRef.current?.contains(e.target)) return
      closePopover()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [open, closePopover])

  // Anchor the popover relative to the trigger button. Default
  // placement is BELOW the trigger; flip to ABOVE when the popover's
  // estimated height wouldn't fit between the trigger's bottom edge
  // and the viewport bottom. The available-space comparison uses an
  // estimated max height (40vh tag list + ~100px chrome) so the
  // decision happens BEFORE the popover paints — no flicker.
  const anchorRect = triggerRef.current?.getBoundingClientRect()
  const popoverPlacement = useMemo(() => {
    if (!anchorRect) return null
    const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800
    const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1280
    const margin = 8
    const estPopoverH = Math.min(viewportH * 0.4 + 100, viewportH - margin * 2)
    const spaceBelow = viewportH - anchorRect.bottom - margin
    const spaceAbove = anchorRect.top - margin
    const flipAbove = spaceBelow < estPopoverH && spaceAbove > spaceBelow
    // Horizontal anchor: align popover's LEFT edge to the trigger's
    // LEFT edge, but clamp to viewport so it never spills off the
    // right side on narrow panels (chat sidebar, etc.) — slides back
    // left as needed.
    const desiredLeft = anchorRect.left
    const left = Math.max(margin, Math.min(desiredLeft, viewportW - POPOVER_WIDTH - margin))
    // Constrain maxHeight strictly to available space in the chosen
    // direction so the popover can never spill off-screen — even if
    // it ends up tiny in an extreme case. The content area has its
    // own `overflow-y-auto` so the tag list scrolls internally.
    if (flipAbove) {
      return {
        style: {
          left,
          bottom: viewportH - anchorRect.top + ANCHOR_GAP,
          width: POPOVER_WIDTH,
          maxHeight: Math.max(spaceAbove - ANCHOR_GAP, 0),
          zIndex: 10000,
        },
        placement: 'above',
      }
    }
    return {
      style: {
        left,
        top: anchorRect.bottom + ANCHOR_GAP,
        width: POPOVER_WIDTH,
        maxHeight: Math.max(spaceBelow - ANCHOR_GAP, 0),
        zIndex: 10000,
      },
      placement: 'below',
    }
  // anchorRect comes from `triggerRef.current?.getBoundingClientRect()`
  // which is read each render — depending on its identity here is
  // sufficient (open/close toggles re-render, and so does any scroll
  // event the parent surfaces).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, anchorRect?.left, anchorRect?.top, anchorRect?.bottom])

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        ref={triggerRef}
        data-help-region="tag-filter:trigger"
        onClick={() => setOpen((v) => !v)}
        title={isEmpty ? 'Filter by tag' : `${activeCount} tag filter${activeCount === 1 ? '' : 's'} active — click to edit`}
        className={`inline-flex items-center gap-1 px-1.5 py-1 rounded border text-[11px] transition-colors ${
          isEmpty
            ? 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
            : 'border-accent-600 bg-accent-700/30 text-accent-200 hover:bg-accent-700/50'
        }`}
      >
        <FunnelGlyph size={12} />
        {/* U+FE0F variation selector forces emoji presentation on
            platforms (notably Windows) that would otherwise render
            U+1F3F7 as text. Matches the Tags & Lists library tab. */}
        <span aria-hidden="true">{'\u{1F3F7}\u{FE0F}'}</span>
        <span>{triggerLabel}</span>
        {activeCount > 0 && (
          <span className="font-mono leading-none">{activeCount}</span>
        )}
        <span className="text-[9px] opacity-70" aria-hidden="true">▾</span>
      </button>

      {open && popoverPlacement && createPortal(
        <div
          ref={popoverRef}
          data-help-region="tag-filter:popover"
          className="fixed bg-zinc-900 border border-zinc-700 rounded shadow-xl p-2 flex flex-col"
          style={popoverPlacement.style}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Popover header */}
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] text-zinc-400 uppercase tracking-wider">Filter by tag</span>
            <button
              type="button"
              onClick={closePopover}
              className="w-5 h-5 inline-flex items-center justify-center rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700/60"
              title="Close"
              aria-label="Close filter popover"
            >
              ✕
            </button>
          </div>

          {/* Search input */}
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="search tags…"
            data-help-region="tag-filter:search"
            className="w-full mb-2 px-2 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-accent-500"
          />

          {/* Tag list */}
          <div className="flex flex-wrap items-center gap-1 max-h-[40vh] overflow-y-auto mb-2">
            {filteredPool.length === 0 ? (
              <div className="text-[10px] italic text-zinc-600 px-1 py-1">
                {sortedPool.length === 0
                  ? (pool === 'project' ? 'No project tags yet.' : 'No program tags yet.')
                  : 'No tags match this search.'}
              </div>
            ) : (
              filteredPool.map((r) => (
                <TagFilterChip
                  key={r.id}
                  tag={{ id: r.id, name: r.name, color: r.color, count: r.count }}
                  state={stateOfTag(r.id)}
                  mode="popover"
                  size={size}
                  onCycle={(next) => transitionTag(r.id, next)}
                  dataHelpRegion="tag-filter:state_chip"
                />
              ))
            )}
          </div>

          {/* Footer actions */}
          <div className="flex items-center justify-between border-t border-zinc-800 pt-1.5">
            <button
              type="button"
              onClick={clearAll}
              disabled={isEmpty}
              data-help-region="tag-filter:clear_all"
              className={`text-[10px] uppercase tracking-wider rounded px-2 py-1 transition-colors ${
                isEmpty
                  ? 'text-zinc-700 cursor-not-allowed'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
              title="Clear every active tag filter"
            >
              Clear all
            </button>
            <button
              type="button"
              onClick={closePopover}
              data-help-region="tag-filter:done"
              className="text-[10px] uppercase tracking-wider rounded px-2 py-1 text-accent-300 hover:text-accent-200 hover:bg-zinc-800"
            >
              Done
            </button>
          </div>
        </div>,
        document.body,
      )}

      {/* Active-filter chip row (below the trigger). Hidden when empty.
          Renders chips in the same stable `sortedPool` order the
          popover uses (descending count, alphabetical tie-break) so
          cycling a chip's state changes ONLY its wrap colour — never
          its position. Grouping by state (all AND then OR then NOT)
          made chips visually jump between buckets on every click,
          confusing the writer about which chip they were targeting. */}
      {!isEmpty && (
        <div className="flex flex-wrap items-center gap-1">
          {sortedPool.map((r) => {
            const state = stateOfTag(r.id)
            if (state === 'null') return null
            return (
              <TagFilterChip
                key={r.id}
                tag={{ id: r.id, name: r.name, color: r.color }}
                state={state}
                mode="active-row"
                size={size}
                onCycle={(next) => transitionTag(r.id, next)}
                onRemove={() => transitionTag(r.id, 'null')}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
