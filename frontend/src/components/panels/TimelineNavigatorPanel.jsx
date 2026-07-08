/**
 * TimelineNavigatorPanel — Phase 1.12c Track 3.
 *
 * Canvas navigation flyout that reuses the Phase 1.12b
 * `TimelineGridView` component with a different set of click
 * handlers and zero commit-state. Opens from a button to the right
 * of the Table of Contents button in the chapter header row;
 * clicking any dot navigates the canvas to the corresponding node
 * AND opens the left sidebar's Entity Detail Panel on that entity
 * at that chain position.
 *
 * Layout:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ Header: Timeline Navigator       📍           │
 *   ├──────────────────────────────────────────────┤
 *   │ Filter strip: [⊕ 👤 📍 🎒 🚩 🔧]  [search…] │
 *   ├──────────────────────────────────────────────┤
 *   │                                              │
 *   │       <TimelineGridView />                   │
 *   │       (scrolls horizontally + vertically)    │
 *   │                                              │
 *   └──────────────────────────────────────────────┘
 *                                              ↳ right + bottom
 *                                                drag handles
 *
 * Size persistence: width + height stored in localStorage keys
 * `nn_timelineNavW` / `nn_timelineNavH`. Clamped to sane min/max.
 *
 * Close behaviours:
 *   - Click outside the panel (but not on the toggle button) closes it
 *   - Pressing Escape closes it
 *   - Clicking the Timeline button again toggles via the uiStore action
 *
 * Mutually exclusive with `TableOfContentsPanel` — the two flyouts
 * share screen real estate, so opening one closes the other via the
 * uiStore `toggleTocPanel` / `toggleTimelineNavPanel` actions.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useUiStore } from '../../store/uiStore'
import { computePovChain } from '../../utils/povSequence'
import { getEntityNarrativeChain } from '../../utils/narrativeChain'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import buildStoryTimelineView, { buildLiveStorySnapshot } from '../../utils/buildStoryTimelineView'
import TimelineGridView, { IDENTITY_CELL_W_DEFAULT, ORIGIN_FINAL_W } from '../timeline/TimelineGridView'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import { usePovOrderRegressedNodeIds } from '../../hooks/useAlerts'
import { RelationshipIcon } from '../ui/IdentityBadges'
import PinButton from '../ui/PinButton'
import {
  buildRelationshipRows,
  findRelationshipOriginNodeId,
  findRelationshipFinalNodeId,
} from '../../utils/buildRelationshipRows'

const EMPTY_ARRAY = []

// Default + clamp for the panel size. Chosen so the panel can show
// ~8-10 rows and ~12 scene columns without scrolling on a 1080p
// canvas, while staying comfortably under the canvas width / height
// so it never covers the whole screen.
const DEFAULT_W = 900
const DEFAULT_H = 460
const MIN_W = 400
const MAX_W = 1600
const MIN_H = 240
const MAX_H = 900

// Keep in sync with the same constant in
// `frontend/src/components/timeline/TimelineGridView.jsx`. The filter
// strip above the grid is sized to match so it sits visually "above
// the Entity identity column" instead of spanning the full panel
// width.
const IDENTITY_CELL_W = 180

// Filter tabs — same icon-only vocabulary as the Import dialog
// picker minus the preset_lists tab (preset lists never appear on
// the timeline grid, so they don't get a filter).
const TYPE_TABS = [
  { key: 'all',       icon: '⊕',                  label: 'All entity types' },
  { key: 'character', icon: TYPE_ICONS.character, label: 'Characters' },
  { key: 'location',  icon: TYPE_ICONS.location,  label: 'Locations' },
  { key: 'item',      icon: TYPE_ICONS.item,      label: 'Items' },
  { key: 'faction',   icon: TYPE_ICONS.faction,   label: 'Factions' },
  { key: 'custom',    icon: TYPE_ICONS.custom,    label: 'Custom entities' },
  { key: 'knowledge', icon: TYPE_ICONS.knowledge, label: 'Knowledge' },
  { key: 'relationship', icon: <RelationshipIcon size={12} />, label: 'Relationships' },
]

/**
 * Read a persisted int from localStorage with bounds validation.
 * Returns `fallback` if the key is missing, unparseable, or out of range.
 */
function readStoredInt(key, fallback, min, max) {
  try {
    const raw = localStorage.getItem(key)
    const n = raw ? parseInt(raw, 10) : NaN
    if (Number.isFinite(n) && n >= min && n <= max) return n
  } catch { /* swallow */ }
  return fallback
}

// Phase 3.7 perf fix (large-project load perf #8): outer wrapper subscribes
// only to the `open` flag and returns null when closed. The heavy
// `TimelineNavigatorPanelBody` (below) mounts ONLY when open === true,
// so all its `useStoreWithEqualityFn` / `useProjectStore` / `useMemo` /
// `useEffect` hooks — including the expensive
// `buildLiveStorySnapshot` / `buildStoryTimelineView` / per-entity
// chain walks — are completely skipped while the panel is closed
// (which is the default state during project load). Per the 2026-06-06
// perf-review agents: ~232 ms cumulative across 4 real renders during
// load on large-scale projects, all wasted because the panel is
// invisible.
export default function TimelineNavigatorPanel({ anchorTop, anchorLeft }) {
  const open = useUiStore((s) => s.timelineNavPanelOpen)
  if (!open) return null
  return <TimelineNavigatorPanelBody anchorTop={anchorTop} anchorLeft={anchorLeft} />
}

function TimelineNavigatorPanelBody({ anchorTop, anchorLeft }) {
  const open      = useUiStore((s) => s.timelineNavPanelOpen)
  const closePanel = useUiStore((s) => s.closeTimelineNavPanel)
  const setDetailPanel = useUiStore((s) => s.setDetailPanel)
  const openRelationshipDetail = useUiStore((s) => s.openRelationshipDetail)
  // Detail-panel state — the single source of truth for "what
  // position is the user currently at" (whether they clicked a dot
  // in the Navigator, a chip on a plot point, an entity node, or
  // just a plot point node on the canvas). Canvas.jsx wires canvas
  // selection through `setDetailPanel` so this state reflects
  // every selection path automatically. Phase 1.12c v0.1.12.58.
  const detailPanelMode    = useUiStore((s) => s.detailPanelMode)
  const detailPanelNodeId  = useUiStore((s) => s.detailPanelNodeId)
  const detailPanelEntityId = useUiStore((s) => s.detailPanelEntityId)

  const story   = useProjectStore((s) => s.story)
  const nodes   = useProjectStore((s) => s.nodes)
  const edges   = useProjectStore((s) => s.edges)
  const relationships = useProjectStore((s) => s.relationships)
  const chapters = useProjectStore((s) => s.story?.chapters || EMPTY_ARRAY)
  const acts     = useProjectStore((s) => s.story?.acts || EMPTY_ARRAY)
  const chapterXOffset = useProjectStore((s) => {
    const v = s.story?.chapter_x_offset
    return typeof v === 'number' ? v : 10
  })

  // Live entity library subscriptions — entitiesStore is the source
  // of truth for in-session CRUD edits (the static `story.entities`
  // only updates on save / load / explicit sync). Subscribing here
  // means the Navigator picks up entity renames + colour changes
  // immediately. Used to build the live story snapshot below.
  const entCharacters = useEntitiesStore((s) => s.characters)
  const entLocations  = useEntitiesStore((s) => s.locations)
  const entItems      = useEntitiesStore((s) => s.items)
  const entFactions    = useEntitiesStore((s) => s.factions)
  const entCustoms     = useEntitiesStore((s) => s.customs)
  const entKnowledges  = useProjectStore((s) => s.knowledges)
  const getEntityById  = useEntitiesStore((s) => s.getEntityById)

  const { fitView, setCenter, getViewport } = useReactFlow()

  // ── Panel size state (persisted) ─────────────────────────────
  const [panelW, setPanelW] = useState(() => readStoredInt('nn_timelineNavW', DEFAULT_W, MIN_W, MAX_W))
  const [panelH, setPanelH] = useState(() => readStoredInt('nn_timelineNavH', DEFAULT_H, MIN_H, MAX_H))

  // ── Pin state (persisted) ────────────────────────────────────
  // When pinned, click-outside-to-close is disabled — the panel
  // only closes via Escape or the Timeline header toggle.
  // Useful when the user wants to click around on the canvas
  // while keeping the Navigator visible. Persisted so the
  // preference sticks across opens.
  const [isPinned, setIsPinned] = useState(() => {
    try { return localStorage.getItem('nn_timelineNavPinned') === '1' } catch { return false }
  })
  const togglePinned = useCallback(() => {
    setIsPinned((prev) => {
      const next = !prev
      try { localStorage.setItem('nn_timelineNavPinned', next ? '1' : '0') } catch { /* swallow */ }
      return next
    })
  }, [])

  // ── Filter state ────────────────────────────────────────────
  const [filterType, setFilterType] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')

  // Reset filter state when panel opens so re-opening starts fresh.
  // Size state persists across opens.
  useEffect(() => {
    if (open) {
      setFilterType('all')
      setSearchQuery('')
    }
  }, [open])

  // ── Click-outside + Escape to close ─────────────────────────
  // Click-outside is gated on `!isPinned`. When pinned, the only
  // ways to close are Escape or the Timeline button in the
  // chapter row (which toggles the panel via the uiStore action).
  const panelRef = useRef(null)
  // Scroll body of the grid (overflow-auto). The wheel handler below
  // turns vertical wheel into horizontal scroll over the wide grid
  // content so the writer can sweep through scenes without holding
  // Shift. (v0.4.3.34)
  const scrollBodyRef = useRef(null)

  // Wheel → horizontal scroll over the scrollable scene strip only.
  // We hijack vertical wheel deltas and apply them to scrollLeft so the
  // long horizontal timeline pans naturally. The fixed sticky columns
  // that flank the scene strip keep their normal vertical wheel scroll
  // so the user can still move through the entity rows on tall
  // projects: the entity-label + origin columns on the left
  // (IDENTITY_CELL_W_DEFAULT + ORIGIN_FINAL_W wide) and the final
  // column pinned to the right (ORIGIN_FINAL_W wide). Attached as a
  // NATIVE non-passive listener because React's synthetic onWheel is
  // passive and cannot preventDefault. (v0.4.3.34)
  useEffect(() => {
    if (!open) return undefined
    const el = scrollBodyRef.current
    if (!el) return undefined
    function onWheel(e) {
      // Trackpad / Shift+wheel horizontal gestures already pan
      // horizontally natively — leave them.
      if (e.deltaY === 0) return
      // Nothing to pan horizontally — don't swallow the gesture.
      if (el.scrollWidth <= el.clientWidth) return
      const offsetX = e.clientX - el.getBoundingClientRect().left
      // Over the sticky entity-label + origin columns on the left, or
      // the sticky final column pinned to the right? Keep vertical
      // scroll there (clientWidth excludes any vertical scrollbar).
      if (offsetX < IDENTITY_CELL_W_DEFAULT + ORIGIN_FINAL_W) return
      if (offsetX > el.clientWidth - ORIGIN_FINAL_W) return
      el.scrollLeft += e.deltaY
      e.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    if (isPinned) return undefined
    function handler(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        // Ignore clicks on the Timeline toggle button — it has its
        // own toggle handler and we don't want the outside listener
        // to pre-empt the close-via-second-click behaviour.
        if (e.target.closest?.('[data-timeline-toggle]')) return
        closePanel()
      }
    }
    document.addEventListener('pointerdown', handler, { capture: true })
    return () => document.removeEventListener('pointerdown', handler, { capture: true })
  }, [open, isPinned, closePanel])

  useEffect(() => {
    if (!open) return undefined
    function handler(e) { if (e.key === 'Escape') closePanel() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, closePanel])

  // ── Preview build (live story snapshot + POV sequence + timeline view) ──
  //
  // The preview is recomputed whenever:
  //   - RF nodes change (drag scene → new chapter; new entity wire
  //     creates a new EntityRef on a plot point; modifier node added)
  //   - RF edges change (POV chain rewires; new connections)
  //   - story.chapters / story.acts change (chapter resize / reorder)
  //   - any entity bucket from entitiesStore changes (CRUD edit)
  //
  // The `liveStory` snapshot mirrors `buildStoryPayload`'s pattern
  // by pulling scenes + entity_nodes from the live RF
  // nodes array and entities from entitiesStore. Without this,
  // `buildStoryTimelineView` would read stale data from the static
  // `story.scenes` / `story.entity_nodes` / `story.entities`
  // and the Navigator would lag behind canvas edits — the bug
  // fixed in v0.1.12.47.
  const liveEntities = useMemo(() => ({
    characters: entCharacters,
    locations:  entLocations,
    items:      entItems,
    factions:   entFactions,
    customs:    entCustoms,
    knowledges: entKnowledges,
  }), [entCharacters, entLocations, entItems, entFactions, entCustoms, entKnowledges])

  const liveStory = useMemo(
    () => buildLiveStorySnapshot(story, nodes, edges, liveEntities),
    [story, nodes, edges, liveEntities],
  )

  const povSequence = useMemo(
    () => computePovChain(nodes, edges).sequence,
    [nodes, edges],
  )

  // Global Story Order drives non-POV column ordering + per-entity
  // modifier dot chain_index assignment — so the Navigator grid
  // reflects the same scene order the Story Order page shows
  // instead of canvas-x order (Phase 1.19 v0.1.19.2).
  const storyOrder = useStoryOrder()
  // Canonical pov_chapter_order regression set — the timeline's ⚠ indicator
  // consumes this instead of re-deriving the regression (one calculator,
  // shared with the alerts panel + scene-node badge).
  const regressedNodeIds = usePovOrderRegressedNodeIds()

  const preview = useMemo(
    () => buildStoryTimelineView(liveStory, povSequence, storyOrder, regressedNodeIds),
    [liveStory, povSequence, storyOrder, regressedNodeIds],
  )

  // ── Relationship rows ───────────────────────────────────────
  // Pseudo-entity rows built from `relationships`. Each row has the same
  // shape as an entity row so TimelineGridView can render it without
  // special-casing. Dots are emitted only for plot-point nodes in the
  // relationship's ordered chain (origin + entity / modifier nodes are
  // skipped). Built only when the relationship tab is active to avoid
  // the per-relationship chain walk when the user is browsing entity
  // rows.
  const relationshipRows = useMemo(() => {
    if (filterType !== 'relationship') return []
    return buildRelationshipRows(relationships, nodes, edges, storyOrder, getEntityById)
  }, [filterType, relationships, nodes, edges, storyOrder, getEntityById])

  // Id set used by `handleDotClick` to detect which rows are relationships
  // vs entities, so the dot click can route through the relationship
  // detail-panel mechanism instead of the entity setDetailPanel path.
  const relationshipRowIds = useMemo(() => {
    const s = new Set()
    for (const r of relationshipRows) s.add(r.id)
    return s
  }, [relationshipRows])

  // ── Row filter ──────────────────────────────────────────────
  // Relationship tab switches the row source from `preview.entities`
  // to `relationshipRows`. Relationships are a distinct first-class
  // object and are NOT included in the "All entity types" view — the
  // 'all' filter shows entities only.
  const filteredEntities = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (filterType === 'relationship') {
      return relationshipRows.filter((row) => {
        if (!q) return true
        return (row.name || '').toLowerCase().includes(q)
      })
    }
    if (!preview?.entities) return []
    return preview.entities.filter((ent) => {
      if (filterType !== 'all' && ent.type !== filterType) return false
      if (!q) return true
      return (ent.name || '').toLowerCase().includes(q)
    })
  }, [preview, filterType, searchQuery, relationshipRows])

  // ── Current-position derivation ─────────────────────────────
  // Single-highlight semantics: exactly ONE of {column header,
  // per-row dot} is highlighted based on the current detail panel
  // state. The detail panel state is the single source of truth —
  // both canvas clicks (via Canvas.jsx's onSelectionChange →
  // setDetailPanel) and Navigator dot clicks (via our own
  // setDetailPanel calls) flow through it, so the highlight moves
  // atomically whenever the user changes focus.
  //
  // Mapping:
  //   - scene (scene node selected, no entity):
  //       → highlightedColumnId = nodeId, picks = empty
  //   - entityChip (chip inside a scene node selected):
  //       → picks = { entityId: {kind:'scene', scene_id:nodeId} }, col = null
  //   - entityNodeModifier (modifier node selected):
  //       → picks = { entityId: {kind:'modifier', modifier_node_id:nodeId} }, col = null
  //   - entityNode (origin entity node selected):
  //       → picks = { entityId: {kind:'origin'} }, col = null
  //   - anything else (null / unknown): picks empty, col null
  const { navigatorPicks, highlightedColumnId } = useMemo(() => {
    const picks = new Map()
    let colId = null
    if (detailPanelMode === 'scene' && detailPanelNodeId) {
      colId = detailPanelNodeId
    } else if (detailPanelMode === 'entityChip' && detailPanelEntityId && detailPanelNodeId) {
      picks.set(detailPanelEntityId, { kind: 'scene', scene_id: detailPanelNodeId })
    } else if (detailPanelMode === 'entityNodeModifier' && detailPanelEntityId && detailPanelNodeId) {
      picks.set(detailPanelEntityId, { kind: 'modifier', modifier_node_id: detailPanelNodeId })
    } else if (detailPanelMode === 'entityNode' && detailPanelEntityId) {
      picks.set(detailPanelEntityId, { kind: 'origin' })
    }
    return { navigatorPicks: picks, highlightedColumnId: colId }
  }, [detailPanelMode, detailPanelNodeId, detailPanelEntityId])

  // Per-type counts for the tab tooltips. Relationship count is
  // independent of the entity counts — relationships are a separate
  // first-class object and are not included in the 'all' tally.
  const countsByType = useMemo(() => {
    const counts = { all: 0, character: 0, location: 0, item: 0, faction: 0, custom: 0, knowledge: 0, relationship: 0 }
    if (preview?.entities) {
      for (const ent of preview.entities) {
        counts.all += 1
        if (counts[ent.type] != null) counts[ent.type] += 1
      }
    }
    counts.relationship = (relationships || []).length
    return counts
  }, [preview, relationships])

  // ── Canvas navigation helpers ───────────────────────────────

  /** Fit the viewport to a single flow node. */
  const fitNode = useCallback((nodeId) => {
    if (!nodeId) return
    fitView({ nodes: [{ id: nodeId }], duration: 400, padding: 0.5 })
  }, [fitView])

  /**
   * Focus a horizontal flow-space x range (used for chapter / act
   * header clicks). Copy-adapted from `TableOfContentsPanel.focusXRange`
   * — sets the viewport centre to the midpoint of the range at a
   * zoom level that fills ~90% of the visible width, keeping the
   * current Y centre so the user doesn't lose their vertical place.
   */
  const focusXRange = useCallback((xMin, xMax) => {
    const container = document.querySelector('.react-flow')
    const rect = container?.getBoundingClientRect()
    const vpPxW = rect?.width || 1200
    const vpPxH = rect?.height || 800
    const padding = 0.1
    const columnFlowWidth = Math.max(1, xMax - xMin)
    const rawZoom = (vpPxW * (1 - padding * 2)) / columnFlowWidth
    const zoom = Math.max(0.15, Math.min(2, rawZoom))
    const centerX = (xMin + xMax) / 2
    const vp = getViewport()
    const currentFlowCenterY = (vpPxH / 2 - vp.y) / (vp.zoom || 1)
    setCenter(centerX, currentFlowCenterY, { zoom, duration: 400 })
  }, [getViewport, setCenter])

  /**
   * Compute a chapter's `[xMin, xMax]` flow-space range by walking
   * the chapters list and summing widths. Returns null when the
   * chapter id isn't found.
   */
  const getChapterXRange = useCallback((chapterId) => {
    let cursor = chapterXOffset
    for (const ch of chapters) {
      const xMin = cursor
      const xMax = cursor + (ch.width || 0)
      cursor = xMax
      if (ch.id === chapterId) return [xMin, xMax]
    }
    return null
  }, [chapters, chapterXOffset])

  /**
   * Compute an act's `[xMin, xMax]` flow-space range as the union of
   * its member chapters' x ranges. Returns null when the act or its
   * chapters aren't found.
   */
  const getActXRange = useCallback((actId) => {
    const act = acts.find((a) => a.id === actId)
    if (!act || !act.chapter_ids?.length) return null
    let xMin = null
    let xMax = null
    let cursor = chapterXOffset
    for (const ch of chapters) {
      const left  = cursor
      const right = cursor + (ch.width || 0)
      cursor = right
      if (act.chapter_ids[0] === ch.id) xMin = left
      if (act.chapter_ids[act.chapter_ids.length - 1] === ch.id) xMax = right
    }
    if (xMin == null || xMax == null) return null
    return [xMin, xMax]
  }, [acts, chapters, chapterXOffset])

  // ── TimelineGridView click handlers ─────────────────────────

  /**
   * Resolve the entity's origin / setup node for the Origin bookend
   * click. Origin nodes are stored as `EntityNode` records with
   * `is_modifier === false` and matching `entity_id`. Looked up
   * against the React Flow nodes array so we can navigate to the
   * canvas position directly.
   */
  const findEntityOriginNodeId = useCallback((entityId) => {
    const rfNode = nodes.find(
      (n) => n.type === 'entityNode'
        && n.data?.entity_id === entityId
        && !n.data?.is_modifier,
    )
    return rfNode?.id || null
  }, [nodes])

  /**
   * Resolve the chain index of a target node in the entity's
   * narrative chain. The chain index passed to setDetailPanel must
   * match the index inside `getEntityNarrativeChain`'s output —
   * NOT the dot's `chain_index` from `buildStoryTimelineView`. The
   * two differ because:
   *   - getEntityNarrativeChain walks the actual canvas connection
   *     graph from the entity's origin node and includes every
   *     plot-point + modifier node along the entity's chain (with
   *     chain[0] = origin entity node).
   *   - buildStoryTimelineView's chain_index counts only the dots
   *     in the timeline grid row, sorted by canvas x.
   *
   * Mismatched indices crash EntityChipDetailView's
   * `priorEffectiveState` memo when `chain[chainIndex - 1]` falls
   * off the end of the actual narrative chain — see the v0.1.12.45
   * bug fix for the symptom (Final dot click crashes the UI for
   * entities with modifier nodes in their personal chain).
   */
  const findNodeChainIndex = useCallback((entityId, targetNodeId) => {
    const chain = getEntityNarrativeChain(entityId, nodes, edges)
    return chain.findIndex((n) => n.id === targetNodeId)
  }, [nodes, edges])

  const handleDotClick = useCallback((entityId, col) => {
    // Relationship row routing — when the row's id matches a relationship,
    // dot clicks navigate to the relationship's canvas node and open the
    // RelationshipDetailPanel via the shared `openRelationshipDetail`
    // uiStore action (which sets `activeSelection = { kind, id, atNodeId }`
    // and flips `sidebarTab` to 'details'). Relationships have no per-dot
    // entity-chain model, so we don't compute a chain index here.
    if (relationshipRowIds.has(entityId)) {
      const rel = (relationships || []).find((r) => r.id === entityId)
      if (!rel) return
      if (col._kind === 'origin') {
        const originId = findRelationshipOriginNodeId(entityId, nodes)
        if (!originId) return
        fitNode(originId)
        openRelationshipDetail(entityId, originId)
        return
      }
      if (col._kind === 'final') {
        const finalId = findRelationshipFinalNodeId(rel, nodes, edges, storyOrder)
        if (!finalId) return
        fitNode(finalId)
        openRelationshipDetail(entityId, finalId)
        return
      }
      // Scene dot: navigate to the scene and open the relationship detail
      // panel at that scene's chain position.
      fitNode(col.id)
      openRelationshipDetail(entityId, col.id)
      return
    }
    // Origin bookend: navigate to the entity's setup node + open
    // its detail panel in 'entityNode' mode. Origin is chain[0].
    // Pick tracking flows through `setDetailPanel` → derived
    // `navigatorPicks` memo (Phase 1.12c v0.1.12.58), so we no
    // longer need to record picks locally.
    if (col._kind === 'origin') {
      const originId = findEntityOriginNodeId(entityId)
      if (!originId) return
      fitNode(originId)
      setDetailPanel('entityNode', originId, entityId, 0)
      return
    }
    // Final bookend: navigate to the entity's actual last chain
    // point — which may be a plot-point node OR a trailing modifier
    // node. Modifiers are full chain points under the chain-of-
    // history model, so skipping them would misrepresent the entity's
    // final state to the user.
    if (col._kind === 'final') {
      const chain = getEntityNarrativeChain(entityId, nodes, edges)
      if (chain.length === 0) return
      // chain[0] is the entity's origin entityNode; a chain with only
      // that one entry means the entity never reaches a plot point or
      // modifier, so Final is a no-op.
      if (chain.length === 1) return
      const lastIdx = chain.length - 1
      const lastNode = chain[lastIdx]
      fitNode(lastNode.id)
      if (lastNode?.type === 'entityNode' && lastNode.data?.is_modifier) {
        setDetailPanel('entityNodeModifier', lastNode.id, entityId, lastIdx)
      } else {
        setDetailPanel('entityChip', lastNode.id, entityId, lastIdx)
      }
      return
    }
    // Scene column dot: navigate to the plot point + open
    // 'entityChip' mode at the matching chain index. When the
    // scene isn't in the entity's narrative chain (orphaned chip),
    // pass chainIndex=-1 so the detail panel falls back to
    // origin-state for the prior view.
    fitNode(col.id)
    const idx = findNodeChainIndex(entityId, col.id)
    setDetailPanel('entityChip', col.id, entityId, idx)
  }, [
    nodes, edges, fitNode, setDetailPanel, findEntityOriginNodeId, findNodeChainIndex,
    relationshipRowIds, relationships, storyOrder, openRelationshipDetail,
  ])

  const handleModifierDotClick = useCallback((entityId, modifierNodeId) => {
    fitNode(modifierNodeId)
    // Modifier nodes ARE included in getEntityNarrativeChain's walk
    // (the chain visits entity nodes whose entity_id matches), so
    // the chain index resolves cleanly here. -1 fallback handles
    // the edge case where the modifier isn't reachable from the
    // entity's origin via narrative flow.
    const idx = findNodeChainIndex(entityId, modifierNodeId)
    setDetailPanel('entityNodeModifier', modifierNodeId, entityId, idx)
  }, [fitNode, setDetailPanel, findNodeChainIndex])

  const handleColumnHeaderClick = useCallback((col) => {
    // Scene column headers pan to the node AND open the left
    // sidebar's detail panel in scene mode — same behaviour
    // as clicking the scene node on the canvas. Origin / Final
    // don't have a single canvas node to navigate to, so they're
    // no-ops. Phase 1.12c v0.1.12.58.
    if (col._kind !== 'scene') return
    fitNode(col.id)
    setDetailPanel('scene', col.id)
  }, [fitNode, setDetailPanel])

  const handleChapterHeaderClick = useCallback((chapterId) => {
    const range = getChapterXRange(chapterId)
    if (range) focusXRange(range[0], range[1])
  }, [getChapterXRange, focusXRange])

  const handleActHeaderClick = useCallback((actId) => {
    const range = getActXRange(actId)
    if (range) focusXRange(range[0], range[1])
  }, [getActXRange, focusXRange])

  // ── Tooltip overrides (navigation-flavoured) ────────────────

  const columnHeaderTooltip = useCallback((col) => {
    if (col._kind === 'origin') return 'Origin state — click a dot to jump to an entity setup node'
    if (col._kind === 'final')  return 'Final state — click a dot to jump to an entity\'s last scene'
    return `Navigate to ${col.title}`
  }, [])

  const chapterHeaderTooltip = useCallback((ch) => (
    `Navigate to ${ch.title || `Chapter ${ch.number}`}`
  ), [])

  const actHeaderTooltip = useCallback((act) => (
    `Navigate to ${act.title || `Act ${act.number}`}`
  ), [])

  const dotTooltip = useCallback((ent, col) => {
    if (col._kind === 'origin') return `${ent.name} at origin state — navigate`
    if (col._kind === 'final')  return `${ent.name} at final state — navigate`
    return `${ent.name} in ${col.title} — navigate`
  }, [])

  const modifierDotTooltip = useCallback((ent, mod) => (
    `${ent.name} — modifier #${mod.chain_index} — navigate`
  ), [])

  // ── Drag-to-resize handlers ──────────────────────────────────
  // Right edge → width, bottom edge → height. Both use pointer
  // capture + document-level listeners + closure-local latest-value
  // refs so live dragging doesn't re-render the whole panel 60 fps
  // (only the setPanel* call triggers a re-render, which is the
  // cheap part). Final size persists to localStorage on pointerup.

  const handleRightEdgeDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startW = panelW
    let latestW = startW
    const onMove = (ev) => {
      const dx = ev.clientX - startX
      latestW = Math.max(MIN_W, Math.min(MAX_W, startW + dx))
      setPanelW(latestW)
    }
    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      try { localStorage.setItem('nn_timelineNavW', String(latestW)) } catch { /* swallow */ }
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }, [panelW])

  const handleBottomEdgeDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startY = e.clientY
    const startH = panelH
    let latestH = startH
    const onMove = (ev) => {
      const dy = ev.clientY - startY
      latestH = Math.max(MIN_H, Math.min(MAX_H, startH + dy))
      setPanelH(latestH)
    }
    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      try { localStorage.setItem('nn_timelineNavH', String(latestH)) } catch { /* swallow */ }
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }, [panelH])

  // ── Render ──────────────────────────────────────────────────

  if (!open) return null

  const hasStoryEntities = (preview?.entities?.length || 0) > 0

  return (
    <div
      ref={panelRef}
      data-help-region="timeline-navigator:panel"
      style={{
        position: 'absolute',
        top: anchorTop,
        left: anchorLeft,
        width: panelW,
        height: panelH,
        backgroundColor: '#27272a', // zinc-800
        border: '1px solid #52525b', // zinc-600
        borderRadius: 6,
        boxShadow: '0 10px 24px rgba(0, 0, 0, 0.5)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 60,
        overflow: 'hidden',
        pointerEvents: 'auto',
      }}
    >
      {/* Header */}
      <div
        data-help-region="timeline-navigator:header"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid #3f3f46',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: '#d4d4d8',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Timeline Navigator
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} data-help-region="timeline-navigator:pin">
          <PinButton isPinned={isPinned} onToggle={togglePinned} />
        </div>
      </div>

      {/* Body: grid + optional empty-state notice. Scrolls horizontally
          + vertically so long projects still fit.

          The grid is ALWAYS rendered (even with zero entity rows)
          so its sticky header strip — which carries the filter UI
          via `identityHeaderContent` — stays visible even when the
          current filter produces zero matches. Previously we
          conditionally swapped the grid for an empty-state message,
          which hid the filter UI itself and trapped the user
          (v0.1.12.45 fix). The empty-state notice now renders BELOW
          the grid as an inline message. */}
      <div ref={scrollBodyRef} data-help-region="timeline-navigator:grid" className="flex-1 min-h-0 overflow-auto">
        <TimelineGridView
            preview={preview}
            gridEntities={filteredEntities}
            importPicks={navigatorPicks}
            highlightedColumnId={highlightedColumnId}
            onDotClick={handleDotClick}
            onModifierDotClick={handleModifierDotClick}
            onColumnHeaderClick={handleColumnHeaderClick}
            onChapterHeaderClick={handleChapterHeaderClick}
            onActHeaderClick={handleActHeaderClick}
            columnHeaderTooltip={columnHeaderTooltip}
            chapterHeaderTooltip={chapterHeaderTooltip}
            actHeaderTooltip={actHeaderTooltip}
            dotTooltip={dotTooltip}
            modifierDotTooltip={modifierDotTooltip}
            identityHeaderContent={
              <div className="flex flex-col h-full bg-zinc-900/95">
                <div className="flex border-b border-zinc-700" data-help-region="timeline-navigator:filters">
                  {TYPE_TABS.map((tab) => {
                    const isActive = filterType === tab.key
                    const count = countsByType[tab.key] || 0
                    const title = `${tab.label} (${count})`
                    return (
                      <button
                        key={tab.key}
                        type="button"
                        onClick={() => setFilterType(tab.key)}
                        title={title}
                        className={`flex-1 min-w-0 flex items-center justify-center py-1.5 text-[11px] transition-colors border-b-2 ${
                          isActive
                            ? 'bg-zinc-700 text-zinc-100 border-accent-500'
                            : 'text-zinc-400 border-transparent hover:bg-zinc-700/50 hover:text-zinc-200'
                        }`}
                      >
                        {tab.icon}
                      </button>
                    )
                  })}
                </div>
                <div className="flex items-center gap-1.5 px-1.5 py-1 flex-1 min-h-0">
                  <input
                    type="text"
                    data-help-region="timeline-navigator:search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search…"
                    className="flex-1 min-w-0 bg-zinc-700 text-[11px] text-zinc-100 px-1.5 py-0.5 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
                  />
                  <span className="text-[9px] text-zinc-500 flex-shrink-0">
                    {filteredEntities.length}/{preview?.entities?.length || 0}
                  </span>
                </div>
              </div>
            }
        />
        {/* Inline empty-state notice — rendered BELOW the grid in
            the same scroll container, so the headers + filter UI
            above stay visible and the user can change filters
            without losing context. */}
        {!hasStoryEntities ? (
          <div className="px-4 py-6 text-center text-xs text-zinc-500">
            Your project doesn't have any entities yet. Add some from the Entity Library panel on the left, then reopen this view.
          </div>
        ) : filteredEntities.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-zinc-500">
            No entities match the current filter.
          </div>
        ) : null}
      </div>

      {/* Right-edge resize handle — drag to change width. 6px strip
          along the right edge, zinc-700 with accent-600 hover. Sits
          on top of the grid scroll area via absolute positioning so
          it doesn't interfere with horizontal scrolling. */}
      <div
        onPointerDown={handleRightEdgeDown}
        title="Drag to resize width"
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 6,
          cursor: 'ew-resize',
          backgroundColor: 'rgba(63, 63, 70, 0.0)',
          zIndex: 70,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(139, 92, 246, 0.4)' }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 0.0)' }}
      />

      {/* Bottom-edge resize handle — drag to change height. Same
          pattern, 6px along the bottom edge. */}
      <div
        onPointerDown={handleBottomEdgeDown}
        title="Drag to resize height"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 6,
          cursor: 'ns-resize',
          backgroundColor: 'rgba(63, 63, 70, 0.0)',
          zIndex: 70,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(139, 92, 246, 0.4)' }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 0.0)' }}
      />
    </div>
  )
}
