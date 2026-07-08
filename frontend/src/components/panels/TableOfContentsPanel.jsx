/**
 * TableOfContentsPanel — Phase 1.11 Track H.
 *
 * Floating flyout anchored to the TOC button on the LEFT side of the
 * ChapterColumnsOverlay's chapter header row. Lists the story structure
 * hierarchically:
 *
 *   Act 1: <title>
 *     Chapter 1: <title>
 *       1. Scene title
 *       2. Scene title
 *     Chapter 2: <title>
 *       3. Scene title
 *   Act 2: <title>
 *     Chapter 3: <title>
 *   (Unclaimed chapters — not in any act)
 *     Chapter 4: <title>
 *
 * Scene listing is scoped to POV-chain order only. Non-POV scenes that
 * happen to live spatially inside a chapter are intentionally NOT shown —
 * users can jump to the chapter itself to see them. Chapters with zero
 * POV-chain scenes are still listed (the user may be laying out
 * chapters first, populating scenes later).
 *
 * Click targets:
 *   - Scene row    → fitView on that one node (pan + zoom to it)
 *   - Chapter row  → setCenter + explicit zoom so the chapter column
 *                    fills the viewport width (works even when the
 *                    chapter is empty — uses the column's x range, not
 *                    its contents, for the zoom math)
 *   - Act row      → same setCenter math, but spanning the act's full
 *                    chapter range
 *
 * Mounted inside <ReactFlow> so `useReactFlow()` is callable. Positioned
 * in screen space via `position: absolute` on the parent overlay's
 * header row.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useProjectStore } from '../../store/projectStore'
import { useUiStore } from '../../store/uiStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { computePovChain } from '../../utils/povSequence'
import { resolveChapterIdForNode } from '../../utils/chapterMembership'
import { rowGeometryParams, multirowHeaderRows } from '../../utils/rowLayout'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import PinButton from '../ui/PinButton'
import PovNavToggleButton from '../ui/PovNavToggleButton'
import { usePovColor } from '../../utils/povConstants'
import { NodeBadge, KnowledgeLabelChip, EntityAvatar, RelationshipLabelChip } from '../ui/IdentityBadges'

const EMPTY_ARRAY = []

export default function TableOfContentsPanel({ anchorTop, anchorLeft }) {
  const open = useUiStore((s) => s.tocPanelOpen)
  const closePanel = useUiStore((s) => s.closeTocPanel)
  const povOnly = useUiStore((s) => s.tocPovOnly)
  const setPovOnly = useUiStore((s) => s.setTocPovOnly)
  // Phase 1.24b — entity-filter, set by `ShowInTocButton` on the
  // Entity / Relationship / Knowledge detail panels. When non-null,
  // the scenes list narrows to scenes that contain the source object.
  // Composes with `tocPovOnly` (both can be active).
  const tocFilter = useUiStore((s) => s.tocFilter)
  const clearTocFilter = useUiStore((s) => s.clearTocFilter)
  const setDetailPanel = useUiStore((s) => s.setDetailPanel)
  const openRelationshipDetail = useUiStore((s) => s.openRelationshipDetail)
  const openKnowledgeDetail = useUiStore((s) => s.openKnowledgeDetail)

  // Pin state (persisted) — mirrors the Timeline Navigator's pin pattern.
  // When pinned, click-outside-to-close is disabled so the user can keep
  // referring to the outline while clicking around on the canvas. Escape
  // and the TOC toolbar toggle still close the panel regardless.
  const [isPinned, setIsPinned] = useState(() => {
    try { return localStorage.getItem('nn_tocPinned') === '1' } catch { return false }
  })
  const togglePinned = useCallback(() => {
    setIsPinned((prev) => {
      const next = !prev
      try { localStorage.setItem('nn_tocPinned', next ? '1' : '0') } catch { /* swallow */ }
      return next
    })
  }, [])

  const chapters = useProjectStore((s) => s.story?.chapters || EMPTY_ARRAY)
  const acts = useProjectStore((s) => s.story?.acts || EMPTY_ARRAY)
  const chapterXOffset = useProjectStore((s) => {
    const v = s.story?.chapter_x_offset
    return typeof v === 'number' ? v : 10
  })
  // Phase 4.3 — layout mode + row grouping feed mode-aware chapter membership
  // below (multi-row needs the 2D resolver; the single-row x-only test reads
  // the wrong chapter from a node's per-row display position).
  const layoutMode = useProjectStore((s) => s.story?.canvas_layout_mode || 'single')
  const chapterRows = useProjectStore((s) => s.story?.chapter_rows || null)
  const actsExpanded = useProjectStore((s) => !!s.story?.multirow_acts_expanded)
  const chapterLabel = useProjectStore((s) => s.story?.chapter_label) || 'Chapter'
  const actLabel = useProjectStore((s) => s.story?.act_label) || 'Act'
  const nodes = useProjectStore((s) => s.nodes)
  const edges = useProjectStore((s) => s.edges)
  const storyOrder = useStoryOrder()

  // entityMap is required by NodeBadge to resolve entityNode identities.
  // NodeBadge uses it only for entityNode; for sceneNode the map is
  // unused, but NodeBadge still accepts it unconditionally. Built from
  // stable per-bucket selectors so we only re-render when the entity
  // collections themselves change.
  const characters = useEntitiesStore((s) => s.characters)
  const locations = useEntitiesStore((s) => s.locations)
  const items = useEntitiesStore((s) => s.items)
  const factions = useEntitiesStore((s) => s.factions)
  const customs = useEntitiesStore((s) => s.customs)
  const knowledges = useProjectStore((s) => s.knowledges)
  const entityMap = useMemo(() => {
    const m = new Map()
    for (const e of characters || []) m.set(e.id, e)
    for (const e of locations || []) m.set(e.id, e)
    for (const e of items || []) m.set(e.id, e)
    for (const e of factions || []) m.set(e.id, e)
    for (const e of customs || []) m.set(e.id, e)
    for (const e of knowledges || []) m.set(e.id, e)
    return m
  }, [characters, locations, items, factions, customs, knowledges])

  const { setCenter, fitView, getViewport } = useReactFlow()

  // Every scene (sceneNode) in global story order. When the POV-only
  // filter is on, the list is narrowed to just the POV-chain scenes;
  // otherwise it includes non-POV and flashback scenes too.
  //
  // Used two ways:
  //   - As the panel's full outline when the story has zero chapters.
  //   - As the ordering source for per-chapter scene lists AND for the
  //     trailing "unchaptered scenes" section when chapters exist (so a
  //     scene that sits outside every chapter's x-range still appears in
  //     the panel, in its correct global-order position among its peers).
  // Phase 1.24b — filter narrowing data sources. Composed alongside
  // the existing povOnly narrowing in the useMemo below.
  const relationshipsByScene = useProjectStore((s) => s.relationshipsByScene)
  const projectKnowledges = useProjectStore((s) => s.knowledges)

  // POV-only toggle styling — borrow the sidebar's `PovNavToggleButton`
  // so the TOC's toggle is visually identical. `hasAnyPov` gates the
  // button: when the project has zero POV-tagged scenes the toggle
  // would filter the TOC to nothing, so the button greys out instead.
  const povColor = usePovColor()
  const hasAnyPov = useMemo(() => {
    const pc = computePovChain(nodes, edges)
    return (pc?.sequence?.length || 0) > 0
  }, [nodes, edges])

  const scenesInStoryOrder = useMemo(() => {
    const orderedIds = storyOrder?.orderedIds || []
    let povIdSet = null
    if (povOnly) {
      const pc = computePovChain(nodes, edges)
      povIdSet = new Set((pc?.sequence || []).map((e) => e.nodeId))
    }
    // Phase 1.24b — entity / relationship / knowledge contains-checks.
    // Build a set of scene-ids the filter target touches, then test
    // inclusion per scene. Pre-computing avoids O(N×M) per scene.
    let filterIdSet = null
    if (tocFilter) {
      filterIdSet = new Set()
      if (tocFilter.type === 'entity') {
        // Scene contains the entity if it has an EntityRef for the
        // filter id in any of the chip arrays. Reads scene's baseline
        // chip lists (which are themselves chain-shape data — no
        // chain-aware concern at this layer; the filter is asking
        // "which scenes hold this entity at any chain anchor".)
        for (const n of nodes) {
          if (n.type !== 'sceneNode') continue
          const d = n.data
          if (!d) continue
          const buckets = [d.characters, d.locations, d.items, d.factions, d.customs]
          for (const b of buckets) {
            if (Array.isArray(b) && b.some((ref) => ref.entity_id === tocFilter.id)) {
              filterIdSet.add(n.id)
              break
            }
          }
        }
      } else if (tocFilter.type === 'relationship') {
        // Reuse the existing relationshipsByScene index — it already
        // tracks every scene whose id appears in any of the
        // relationship's history arrays (birth + sparse-chain stops).
        for (const [sceneId, relIds] of Object.entries(relationshipsByScene || {})) {
          if (relIds && relIds.has && relIds.has(tocFilter.id)) {
            filterIdSet.add(sceneId)
          }
        }
      } else if (tocFilter.type === 'knowledge') {
        // Walk the knowledge's history arrays and collect every
        // referenced node_id. Scenes among those node_ids are the
        // "knowledge contains" set.
        const k = (projectKnowledges || []).find((kk) => kk.id === tocFilter.id)
        if (k && k.history) {
          for (const list of Object.values(k.history)) {
            if (!Array.isArray(list)) continue
            for (const entry of list) {
              if (entry && entry.node_id) filterIdSet.add(entry.node_id)
            }
          }
        }
      }
    }
    const out = []
    for (const id of orderedIds) {
      const n = nodes.find((nn) => nn.id === id)
      if (!n || n.type !== 'sceneNode') continue
      if (povIdSet && !povIdSet.has(id)) continue
      if (filterIdSet && !filterIdSet.has(id)) continue
      out.push({
        nodeId: n.id,
        title: n.data?.title || n.data?.description || 'Untitled Scene',
      })
    }
    return out
  }, [storyOrder, nodes, edges, povOnly, tocFilter, relationshipsByScene, projectKnowledges])

  // Click-outside to close. Uses pointerdown in capture phase so it fires
  // BEFORE React Flow's own target-level handlers can stopPropagation on
  // clicks that land on the canvas background or a node wrapper — `mousedown`
  // in the bubble phase misses those because React Flow eats the event
  // before it reaches document. Matches the pattern used by every other
  // context/flyout menu in the app (CanvasContextMenu, AddMenu, etc.).
  const panelRef = useRef(null)
  useEffect(() => {
    if (!open || isPinned) return undefined
    function handler(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        // Ignore clicks on the TOC toggle button itself — it handles its
        // own open/close and we don't want the capture-phase listener to
        // fire closePanel() before the button's onClick fires toggleTocPanel().
        if (e.target.closest?.('[data-toc-toggle]')) return
        closePanel()
      }
    }
    document.addEventListener('pointerdown', handler, { capture: true })
    return () => document.removeEventListener('pointerdown', handler, { capture: true })
  }, [open, isPinned, closePanel])

  // Close on Escape.
  useEffect(() => {
    if (!open) return undefined
    function handler(e) {
      if (e.key === 'Escape') closePanel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, closePanel])

  // Build the outline as a nested tree of sections → chapters → scenes.
  // Each section is either an act (contiguous run of chapters belonging to
  // the same act) or a "no-act" bucket (consecutive chapters with no act).
  // The nested shape lets the renderer wrap every section in a div whose
  // `border-left` colour runs the full vertical height of the section —
  // so act bars span all their chapters + scenes, and chapter bars sit
  // in parallel next to the act bar for the duration of that chapter.
  const outline = useMemo(() => {
    // Group scenes by chapter in global story order (same ordering the
    // whole panel uses -- lets the per-chapter lists stay consistent with
    // the no-chapter fallback and with the unchaptered-scenes trailing
    // section below). Scenes outside every chapter's x-range go into
    // `unchapteredScenes` so we can render them at the end of the panel.
    const scenesByChapter = new Map()
    // Unchaptered scenes are split by their position in the POV / story
    // chain relative to chaptered scenes. Anything that comes before the
    // first chaptered scene goes into `unchapteredBefore` and renders
    // ABOVE the chapter / act sections, so the visual order in the TOC
    // matches the chain order. Everything else (including interleaved
    // and trailing unchaptered scenes) stays in `unchapteredAfter` and
    // renders below the sections — same behaviour as before for the
    // common "extras at the end" case.
    const unchapteredBefore = []
    const unchapteredAfter = []
    let firstChapteredChainIndex = Infinity
    let orderIdx = 0
    const buffered = []
    // Mode-aware chapter membership (canonical resolver). Single-row x-only
    // resolution reads the wrong chapter from a node's per-row display position
    // in multi-row, mis-grouping scenes and showing the wrong TOC order.
    const _geom = rowGeometryParams(chapterXOffset, multirowHeaderRows(layoutMode, actsExpanded))
    const _memberOpts = {
      mode: layoutMode,
      chapterRows,
      xOffset: chapterXOffset,
      rowsTopY: _geom.rowsTopY,
      rowGap: _geom.rowGap,
    }
    for (const s of scenesInStoryOrder) {
      orderIdx += 1
      const node = nodes.find((n) => n.id === s.nodeId)
      if (!node) continue
      const chapterId = resolveChapterIdForNode(node, chapters, _memberOpts)
      const entry = { nodeId: s.nodeId, title: s.title, chainIndex: orderIdx, chapterId }
      buffered.push(entry)
      if (chapterId && entry.chainIndex < firstChapteredChainIndex) {
        firstChapteredChainIndex = entry.chainIndex
      }
    }
    for (const entry of buffered) {
      if (entry.chapterId) {
        if (!scenesByChapter.has(entry.chapterId)) scenesByChapter.set(entry.chapterId, [])
        scenesByChapter.get(entry.chapterId).push(entry)
      } else if (entry.chainIndex < firstChapteredChainIndex) {
        unchapteredBefore.push(entry)
      } else {
        unchapteredAfter.push(entry)
      }
    }
    // Chapter → Act lookup + cached act x-ranges.
    const actByChapter = new Map()
    acts.forEach((a, i) => {
      for (const cid of a.chapter_ids) actByChapter.set(cid, { id: a.id, indexInStory: i })
    })
    // Pre-compute each act's flow x range (leftmost chapter's left edge
    // to rightmost chapter's right edge).
    const actRanges = new Map()
    for (const act of acts) {
      let xMin = chapterXOffset
      let xMax = chapterXOffset
      let cum = chapterXOffset
      for (const ch of chapters) {
        const w = ch.width || 0
        if (act.chapter_ids[0] === ch.id) xMin = cum
        if (act.chapter_ids[act.chapter_ids.length - 1] === ch.id) xMax = cum + w
        cum += w
      }
      actRanges.set(act.id, { xMin, xMax })
    }
    // Walk chapters[] and accumulate them into sections. Whenever the
    // active act changes (including to/from "no act"), start a new
    // section.
    const sections = []
    let cursor = chapterXOffset
    let currentSection = null
    let currentActId = '__INIT__'
    chapters.forEach((c, i) => {
      const xMin = cursor
      const xMax = cursor + (c.width || 0)
      cursor = xMax
      const actInfo = actByChapter.get(c.id)
      const actId = actInfo?.id || null
      if (actId !== currentActId) {
        if (actId) {
          const act = acts.find((a) => a.id === actId)
          const actIdx = acts.findIndex((a) => a.id === actId)
          const range = actRanges.get(act.id) || { xMin: 0, xMax: 0 }
          currentSection = {
            type: 'act',
            id: act.id,
            label: act.title ? `${actLabel} ${actIdx + 1}: ${act.title}` : `${actLabel} ${actIdx + 1}`,
            colour: act.colour,
            xMin: range.xMin,
            xMax: range.xMax,
            chapters: [],
          }
        } else {
          currentSection = { type: 'no-act', id: `no-act-${i}`, chapters: [] }
        }
        sections.push(currentSection)
        currentActId = actId
      }
      currentSection.chapters.push({
        id: c.id,
        label: c.title ? `${chapterLabel} ${i + 1}: ${c.title}` : `${chapterLabel} ${i + 1}`,
        colour: c.colour,
        xMin,
        xMax,
        scenes: (scenesByChapter.get(c.id) || []).map((s) => ({
          nodeId: s.nodeId,
          chainIndex: s.chainIndex,
        })),
      })
    })
    return { sections, unchapteredBefore, unchapteredAfter }
  }, [chapters, acts, nodes, chapterXOffset, layoutMode, chapterRows, actsExpanded, chapterLabel, actLabel, scenesInStoryOrder])

  function focusXRange(xMin, xMax) {
    // Compute the zoom level that makes the given flow-space x range fill
    // roughly 90% of the canvas viewport width, then setCenter on the
    // range midpoint while maintaining the current vertical position
    // (so clicking a column doesn't jar the user's Y view).
    const container = document.querySelector('.react-flow')
    const rect = container?.getBoundingClientRect()
    const vpPxW = rect?.width || 1200
    const vpPxH = rect?.height || 800
    const padding = 0.1 // 10% margin on each side
    const columnFlowWidth = Math.max(1, xMax - xMin)
    const rawZoom = (vpPxW * (1 - padding * 2)) / columnFlowWidth
    const zoom = Math.max(0.15, Math.min(2, rawZoom))
    const centerX = (xMin + xMax) / 2
    const vp = getViewport()
    const currentFlowCenterY = (vpPxH / 2 - vp.y) / (vp.zoom || 1)
    setCenter(centerX, currentFlowCenterY, { zoom, duration: 400 })
  }

  function handleSceneClick(nodeId) {
    fitView({ nodes: [{ id: nodeId }], duration: 400, padding: 0.5 })
  }

  if (!open) return null

  return (
    <div
      ref={panelRef}
      data-help-region="table-of-contents:panel"
      style={{
        position: 'absolute',
        top: anchorTop,
        left: anchorLeft,
        width: 320,
        maxHeight: 480,
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
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid #3f3f46',
          flexShrink: 0,
          gap: 8,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: '#d4d4d8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Table of Contents
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span data-help-region="table-of-contents:pov_filter" style={{ display: 'inline-flex' }}>
            <PovNavToggleButton
              hasAnyPov={hasAnyPov}
              povNavOnly={povOnly}
              onToggle={() => setPovOnly(!povOnly)}
              povColor={povColor}
            />
          </span>
          <span data-help-region="table-of-contents:pin" style={{ display: 'inline-flex' }}>
            <PinButton isPinned={isPinned} onToggle={togglePinned} />
          </span>
        </div>
      </div>

      {/* Body */}
      <div data-help-region="table-of-contents:outline" style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
        {/* Phase 1.24b — filter chip. Renders above the scenes list
            when an entity / relationship / knowledge filter is active.
            Reuses NodeBadge for entity / relationship identity (with
            the source object's origin canvas node id) and
            KnowledgeLabelChip for knowledge. Stale-id case: if the
            filter target was deleted while the filter was active, the
            badge has no source node — drop the chip and clear the
            filter so the panel reverts to unfiltered. */}
        {tocFilter && (() => {
          let badge = null
          let validTarget = false
          let onBadgeClick = null
          if (tocFilter.type === 'entity') {
            const entity = entityMap.get(tocFilter.id)
            if (entity) {
              validTarget = true
              const colour = entity.colour || '#71717a'
              const originNode = nodes.find((n) => n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id === entity.id)
              if (originNode) {
                onBadgeClick = () => setDetailPanel('entityNode', originNode.id, entity.id, 0)
              }
              badge = (
                <span
                  className={'inline-flex items-center gap-1 align-middle whitespace-nowrap' + (onBadgeClick ? ' cursor-pointer hover:brightness-125' : '')}
                  onClick={onBadgeClick || undefined}
                  role={onBadgeClick ? 'button' : undefined}
                  title={onBadgeClick ? `Open ${entity.name}'s detail panel at origin.` : undefined}
                >
                  <EntityAvatar entity={entity} />
                  <span className="font-medium" style={{ color: colour }}>{entity.name}</span>
                </span>
              )
            }
          } else if (tocFilter.type === 'relationship') {
            const projectRels = useProjectStore.getState().relationships || []
            const rel = projectRels.find((r) => r.id === tocFilter.id)
            if (rel) {
              validTarget = true
              onBadgeClick = () => openRelationshipDetail(rel.id, null)
              badge = <RelationshipLabelChip name={rel.name || 'Relationship'} onClick={onBadgeClick} />
            }
          } else if (tocFilter.type === 'knowledge') {
            const k = (projectKnowledges || []).find((kk) => kk.id === tocFilter.id)
            if (k) {
              validTarget = true
              onBadgeClick = () => openKnowledgeDetail(k.id, null)
              badge = <KnowledgeLabelChip name={k.name || 'Knowledge'} onClick={onBadgeClick} />
            }
          }
          if (!validTarget) {
            // Defer the clear to the next tick so we don't trigger a
            // store mutation during render.
            queueMicrotask(() => clearTocFilter())
            return null
          }
          return (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px 8px 10px',
                fontSize: 11,
              }}
            >
              <span style={{ color: '#a1a1aa' }}>Showing only Scenes with:</span>
              {badge}
              <button
                type="button"
                onClick={clearTocFilter}
                title="Clear filter"
                aria-label="Clear filter"
                onMouseEnter={(e) => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.borderColor = '#f87171' }}
                onMouseLeave={(e) => { e.currentTarget.style.color = '#a1a1aa'; e.currentTarget.style.borderColor = '#3f3f46' }}
                style={{
                  background: 'transparent',
                  border: '1px solid #3f3f46',
                  borderRadius: 3,
                  color: '#a1a1aa',
                  cursor: 'pointer',
                  fontSize: 11,
                  lineHeight: 1,
                  width: 18,
                  height: 18,
                  padding: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >×</button>
            </div>
          )
        })()}
        {tocFilter && scenesInStoryOrder.length === 0 && (
          <div style={{ padding: '8px 12px', fontSize: 11, color: '#71717a', fontStyle: 'italic' }}>
            No appearances yet.
          </div>
        )}
        {chapters.length === 0 ? (
          // No chapters: flat list of every scene in global story order.
          // Scenes are rendered flush-left with no chapter / act bars.
          <div style={{ marginLeft: 8, marginBottom: 4 }}>
            {scenesInStoryOrder.map((scene, idx) => (
              <SceneRow
                key={`scene-${scene.nodeId}`}
                nodeId={scene.nodeId}
                chainIndex={idx + 1}
                nodes={nodes}
                entityMap={entityMap}
                onClick={handleSceneClick}
              />
            ))}
          </div>
        ) : (
          <>
          {outline.unchapteredBefore.length > 0 && (
            <div style={{ marginLeft: 8, marginBottom: 4 }}>
              {outline.unchapteredBefore.map((scene) => (
                <SceneRow
                  key={`unchaptered-before-${scene.nodeId}`}
                  nodeId={scene.nodeId}
                  chainIndex={scene.chainIndex}
                  nodes={nodes}
                  entityMap={entityMap}
                  onClick={handleSceneClick}
                />
              ))}
            </div>
          )}
          {outline.sections.map((section) => {
            if (section.type === 'act') {
              return (
                <div
                  key={`act-${section.id}`}
                  style={{
                    marginLeft: 8,
                    marginBottom: 4,
                    borderLeft: `3px solid ${section.colour || '#52525b'}`,
                  }}
                >
                  <button
                    onClick={() => focusXRange(section.xMin, section.xMax)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 12px 6px 10px',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      color: section.colour || '#a1a1aa',
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 0.5)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent' }}
                    title="Focus viewport on this act's chapter range"
                  >
                    {section.label}
                  </button>
                  {section.chapters.map((chapter) => (
                    <ChapterGroup
                      key={`chapter-${chapter.id}`}
                      chapter={chapter}
                      onFocusChapter={focusXRange}
                      onFocusScene={handleSceneClick}
                      nodes={nodes}
                      entityMap={entityMap}
                    />
                  ))}
                </div>
              )
            }
            // no-act section: chapters sit flush-left with no wrapping act
            // bar and no "not in an {act}" header (removed so the panel
            // doesn't display labels for categories that don't exist).
            // The transparent 3 px borderLeft mirrors the act wrapper's
            // visible 3 px borderLeft so chapter colour bars line up
            // vertically across act / no-act sections.
            return (
              <div
                key={section.id}
                style={{
                  marginLeft: 8,
                  marginBottom: 4,
                  borderLeft: '3px solid transparent',
                }}
              >
                {section.chapters.map((chapter) => (
                  <ChapterGroup
                    key={`chapter-${chapter.id}`}
                    chapter={chapter}
                    onFocusChapter={focusXRange}
                    onFocusScene={handleSceneClick}
                    nodes={nodes}
                    entityMap={entityMap}
                  />
                ))}
              </div>
            )
          })}
          {outline.unchapteredAfter.length > 0 && (
            <div style={{ marginLeft: 8, marginBottom: 4 }}>
              {outline.unchapteredAfter.map((scene) => (
                <SceneRow
                  key={`unchaptered-scene-${scene.nodeId}`}
                  nodeId={scene.nodeId}
                  chainIndex={scene.chainIndex}
                  nodes={nodes}
                  entityMap={entityMap}
                  onClick={handleSceneClick}
                />
              ))}
            </div>
          )}
          </>
        )}
      </div>
    </div>
  )
}

/** Nested renderer for one chapter + its POV-chain scenes. Wraps in a
 *  div with `border-left` coloured by the chapter so the bar runs full
 *  height and sits PARALLEL (to the right of) any enclosing act bar.
 *  Scene buttons inside have no left border so there's just the two
 *  parallel bars: act on the outside, chapter on the inside. */
function ChapterGroup({ chapter, onFocusChapter, onFocusScene, nodes, entityMap }) {
  return (
    <div
      style={{
        marginLeft: 6,
        borderLeft: `3px solid ${chapter.colour || '#3f3f46'}`,
      }}
    >
      <button
        onClick={() => onFocusChapter(chapter.xMin, chapter.xMax)}
        style={{
          display: 'block',
          width: '100%',
          textAlign: 'left',
          padding: '5px 12px 5px 10px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: '#e4e4e7',
          fontSize: 12,
          fontWeight: 500,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 0.5)' }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent' }}
        title="Focus viewport on this chapter's column"
      >
        {chapter.label}
      </button>
      {chapter.scenes.map((scene) => (
        <SceneRow
          key={`scene-${scene.nodeId}`}
          nodeId={scene.nodeId}
          chainIndex={scene.chainIndex}
          nodes={nodes}
          entityMap={entityMap}
          onClick={onFocusScene}
          indent={20}
        />
      ))}
    </div>
  )
}

/**
 * Single scene row in the ToC outline. Renders a clickable row with the
 * scene's chain index (global story-order position) followed by a
 * NodeBadge so the identity reads the same as every scene reference
 * across the app (dialogs, alerts, detail panels). Used by all three
 * render sites: no-chapter fallback, ChapterGroup, and the unchaptered
 * scenes trailing section.
 */
function SceneRow({ nodeId, chainIndex, nodes, entityMap, onClick, indent = 10 }) {
  return (
    <button
      onClick={() => onClick(nodeId)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        textAlign: 'left',
        padding: `3px 12px 3px ${indent}px`,
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: '#a1a1aa',
        fontSize: 11,
        lineHeight: 1.4,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 0.5)' }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent' }}
      title="Focus viewport on this scene"
    >
      <span style={{ color: '#71717a', fontSize: 10, fontVariantNumeric: 'tabular-nums', minWidth: 18, textAlign: 'right' }}>
        {chainIndex}.
      </span>
      <NodeBadge nodeId={nodeId} nodes={nodes} entityMap={entityMap} />
    </button>
  )
}
