/**
 * Phase 2.11b item 1 — extract of `ChainRangeSelectorModal`'s inner
 * content into a reusable inline component.
 *
 * The original modal (`ChainRangeSelectorModal.jsx`) ships the chat
 * panel's pinned-context anchor-edit UX. That UX is also needed inline
 * inside the Character Chat Setup modal (planning doc *Architecture
 * Rule 2*) — same timeline grid, same selection state machine (single
 * / range / multi / dynamic), same "Remove that?" overlay, same
 * "Dynamically match current scene" button, same selection-description
 * text — but embedded as a section of a bigger modal, not as a modal
 * of its own.
 *
 * This component owns everything inside the standalone modal except
 * the modal chrome (backdrop, box, header, Cancel / Confirm footer):
 * the timeline grid, the selection state machine and its handlers,
 * the "Dynamically match current scene" button + interaction hint,
 * the selection-description text, and the "Remove that?" cursor-
 * anchored popover. The wrapping modal renders only its chrome around
 * an instance of this component; the future Character Chat Setup
 * modal embeds it inline without any chrome.
 *
 * Imperative ref API (used by both wrappers):
 *   - `getCurrentPins()` → returns the pins array that would be
 *      committed for the current selection state. Wrappers consume
 *      this from their own Confirm button.
 *   - `getSelection()` → returns the raw selection state object.
 */
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { computePovChain } from '../../utils/povSequence'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import { usePovOrderRegressedNodeIds } from '../../hooks/useAlerts'
import {
  getEntityNarrativeChain,
  getKnowledgeNodeOrder,
  getRelationshipNodeOrder,
} from '../../utils/narrativeChain'
import buildStoryTimelineView, { buildLiveStorySnapshot } from '../../utils/buildStoryTimelineView'
import {
  buildRelationshipRows,
  findRelationshipOriginNodeId,
} from '../../utils/buildRelationshipRows'
import TimelineGridView from '../timeline/TimelineGridView'


// Document-level modifier tracker. `TimelineGridView`'s onDotClick
// signature doesn't include the event, so we sniff Ctrl/Cmd state via
// a doc-wide mousedown listener kept in sync. Mounted on first import.
const _lastEventModifiers = { ctrl: false, shift: false }
if (typeof document !== 'undefined') {
  document.addEventListener('mousedown', (e) => {
    _lastEventModifiers.ctrl = !!(e.ctrlKey || e.metaKey)
    _lastEventModifiers.shift = !!e.shiftKey
  }, true)
}


// React onClick handlers for the dot grid; they fire AFTER the
// document-level mousedown handler. When the mousedown handler has
// already consumed the click for a multi-key gesture (ctrl-toggle
// or shift-range-from-origin), the React click handler must skip
// re-applying its plain-click behaviour. The shared sentinel below
// captures every modifier kind we route specially.
function _eventConsumedByMousedown() {
  return _lastEventModifiers.ctrl || _lastEventModifiers.shift
}


// Resolve the entity's origin EntityNode id from the live node list.
// The entity's origin EntityNode is the chain point at chain[0] for
// any non-modifier entityNode whose data.entity_id === entityId.
function _findEntityOriginNodeId(entityId, nodes) {
  for (const n of (nodes || [])) {
    if (n?.type === 'entityNode' && !n?.data?.is_modifier && n?.data?.entity_id === entityId) {
      return n.id
    }
  }
  return null
}


// Initial selection state, derived from the focused pin's existing
// shape so opening the selector pre-populates the selection.
function _initialSelectionFromItem(item, chainIds) {
  if (!item) return { mode: 'none', pickIds: [] }
  // Phase 2.11b item 11 — multi-pin seed shape. The Setup modal's
  // re-anchor flow passes `item.anchor_pins` carrying the saved
  // CharacterChatMeta.anchor_spec list so the selector resumes the
  // writer's existing selection. Range pins expand to their full
  // chain slice; single pins contribute their anchor node id. Mode
  // collapses to 'single' when only one pin / one node ends up
  // picked, 'range' when one contiguous run, 'multi' otherwise.
  if (Array.isArray(item.anchor_pins) && item.anchor_pins.length > 0) {
    const picked = new Set()
    for (const pin of item.anchor_pins) {
      if (pin?.anchor_range) {
        const startIdx = chainIds.indexOf(pin.anchor_range.start_node_id)
        const endIdx = chainIds.indexOf(pin.anchor_range.end_node_id)
        if (startIdx >= 0 && endIdx >= 0 && startIdx <= endIdx) {
          for (let i = startIdx; i <= endIdx; i++) picked.add(chainIds[i])
        }
      } else if (pin?.anchor_node_id) {
        picked.add(pin.anchor_node_id)
      }
    }
    const pickIds = Array.from(picked)
    if (pickIds.length === 0) return { mode: 'dynamic', pickIds: [] }
    if (pickIds.length === 1) return { mode: 'single', pickIds }
    // Check contiguity to decide range vs multi.
    const idxes = pickIds.map((id) => chainIds.indexOf(id)).filter((i) => i >= 0).sort((a, b) => a - b)
    let contiguous = idxes.length >= 2
    for (let i = 1; i < idxes.length; i++) {
      if (idxes[i] !== idxes[i - 1] + 1) { contiguous = false; break }
    }
    return contiguous
      ? { mode: 'range', pickIds: idxes.map((i) => chainIds[i]) }
      : { mode: 'multi',  pickIds: idxes.map((i) => chainIds[i]) }
  }
  if (item.anchor_range) {
    const { start_node_id, end_node_id } = item.anchor_range
    const startIdx = chainIds.indexOf(start_node_id)
    const endIdx = chainIds.indexOf(end_node_id)
    if (startIdx >= 0 && endIdx >= 0 && startIdx <= endIdx) {
      return { mode: 'range', pickIds: chainIds.slice(startIdx, endIdx + 1) }
    }
  }
  if (item.anchor_node_id) {
    return { mode: 'single', pickIds: [item.anchor_node_id] }
  }
  return { mode: 'dynamic', pickIds: [] }
}


const ChainRangeSelector = forwardRef(function ChainRangeSelector({
  item,
  otherPinMarkers,
  otherPinRangeFillSpans = null,
  dynamicResolutionPoint,
  dynamicPinSessionId = null,
  onClearOtherPin,
  onAddDynamicPin = null,
  // Hide the "Dynamically match the conversation's current scene"
  // button + interaction hint. The Character Chat Setup modal sets
  // this true because dynamic-anchor mode has no meaning in a
  // character chat (the chat has no per-message scene anchor to
  // follow).
  hideDynamicOption = false,
  // Width override for the embedded `TimelineGridView`'s sticky-left
  // identity column. Default null = use the grid's own default
  // (180 px). Pass 0 to collapse the identity column entirely when
  // the wrapping surface already shows the object's identity (e.g.
  // the Character Chat Setup modal's avatar + name header).
  identityCellWidth = null,
  // Fired whenever the internal selection state changes, with the
  // current selection object. Lets parents track the active anchor
  // live (e.g. to update an avatar + name preview to the chain-
  // resolved state at the latest anchor in the selection).
  onSelectionChange = null,
  // When true, restricts selection to a SINGLE chain point: shift-click
  // ranges, ctrl / meta multi-select, and click-drag ranges are all
  // disabled, so every click picks exactly one scene. Used by surfaces
  // that capture one static snapshot (e.g. character-card export) rather
  // than a context window. Default false keeps the range / multi UX.
  singleSelect = false,
  // When true, show the sticky-right Final bookend (◉ "Final") and let
  // the writer anchor to the object's final state, mirroring the Timeline
  // Navigator's Final column. Default false keeps the bookend hidden (the
  // standalone pinned-context anchor modal, where the object's last chain
  // stop is already its rightmost dot). The Character Chat Setup modal
  // sets this true so a writer can talk to a character at their end state
  // in one click without scrolling a long chain. Selecting Final anchors
  // to the object's last chain node id (static, like every other point
  // here), so it resolves consistently with Origin / scene / modifier.
  showFinalBookend = false,
}, ref) {
  // Whether another (non-focused) dynamic context entry already
  // exists for this object. Drives the dashed-amber button styling
  // and gates the ctrl-click-adds-dynamic affordance.
  const hasDynamicPin = !!dynamicPinSessionId

  // ── Live preview (same path the Timeline Navigator uses) ─────────
  const nodes        = useProjectStore((s) => s.nodes)
  const edges        = useProjectStore((s) => s.edges)
  const story        = useProjectStore((s) => s.story)
  const relationships = useProjectStore((s) => s.relationships)
  const entCharacters = useEntitiesStore((s) => s.characters)
  const entLocations  = useEntitiesStore((s) => s.locations)
  const entItems      = useEntitiesStore((s) => s.items)
  const entFactions   = useEntitiesStore((s) => s.factions)
  const entCustoms    = useEntitiesStore((s) => s.customs)
  const entKnowledges = useEntitiesStore((s) => s.knowledges)
  const getEntityById = useEntitiesStore((s) => s.getEntityById)

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

  const storyOrder = useStoryOrder()
  // Canonical pov_chapter_order regression set (shared calculator — see
  // TimelineNavigatorPanel / scene-node badge), so the embedded timeline's ⚠
  // indicator matches the alerts panel.
  const regressedNodeIds = usePovOrderRegressedNodeIds()

  const preview = useMemo(
    () => buildStoryTimelineView(liveStory, povSequence, storyOrder, regressedNodeIds),
    [liveStory, povSequence, storyOrder, regressedNodeIds],
  )

  // Filter to the single focused row. Entities + knowledge come from
  // `preview.entities`; relationships are built via the dedicated row
  // builder the Timeline Navigator also uses.
  const focusedRow = useMemo(() => {
    if (!item) return null
    if (item.kind === 'relationship') {
      const rows = buildRelationshipRows(relationships || [], nodes || [], edges || [], storyOrder, getEntityById)
      return rows.find((r) => r.id === item.id) || null
    }
    return (preview?.entities || []).find((e) => e.id === item.id) || null
  }, [item, preview, relationships, nodes, edges, storyOrder, getEntityById])

  // ── Chain ids for this single row ───────────────────────────────
  const chainIds = useMemo(() => {
    if (!item) return []
    if (item.kind === 'entity') {
      const chain = getEntityNarrativeChain(item.id, nodes || [], edges || []) || []
      return chain.map((n) => n.id)
    }
    if (item.kind === 'knowledge') {
      const k = (preview?.entities || []).find((e) => e.id === item.id)
      if (!k) return []
      const kRaw = (entKnowledges || []).find((x) => x.id === item.id)
      if (!kRaw) return []
      return getKnowledgeNodeOrder(kRaw, nodes || [], edges || []) || []
    }
    if (item.kind === 'relationship') {
      const r = (relationships || []).find((x) => x.id === item.id)
      if (!r) return []
      return getRelationshipNodeOrder(r, nodes || [], edges || []) || []
    }
    return []
  }, [item, nodes, edges, preview, entKnowledges, relationships])

  // ── Local selection state ───────────────────────────────────────
  const [selection, setSelection] = useState(() => _initialSelectionFromItem(item, chainIds))
  // dragAnchor: the chain point id that mouse-down started on (used
  // to extend a range as the writer drags through adjacent points).
  // Cleared on mouseup anywhere.
  const [dragAnchor, setDragAnchor] = useState(null)
  const scrollContainerRef = useRef(null)
  const cursorPosRef = useRef({ x: 0, y: 0 })

  // Reset selection when the focused pin changes (e.g. selector
  // re-mounted for a different pin without unmounting).
  useEffect(() => {
    setSelection(_initialSelectionFromItem(item, chainIds))
    setDragAnchor(null)
  }, [item, chainIds])

  // Broadcast selection changes to the parent so live previews
  // (e.g. the Setup modal's chain-resolved avatar + name header)
  // can react without polling the imperative ref.
  useEffect(() => {
    if (onSelectionChange) onSelectionChange(selection)
  }, [selection, onSelectionChange])

  // Mouseup anywhere ends drag-range.
  useEffect(() => {
    function onUp() { setDragAnchor(null) }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [])

  // Wheel-over-row → horizontal scroll. When the chain is wider than
  // the scroll viewport, scrolling the mouse wheel while hovered over
  // the timeline body translates vertical wheel delta into horizontal
  // scrollLeft. Skipped when there's no horizontal overflow (so a
  // normal vertical wheel pass-through still works inside short chains
  // that fit in the panel). Skipped when the writer holds Shift (which
  // is already the browser convention for explicit horizontal-wheel
  // scrolling — we don't want to double up). Uses `passive: false` so
  // `preventDefault()` can stop the modal body from scrolling at the
  // same time.
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    function onWheel(e) {
      if (e.shiftKey) return
      if (el.scrollWidth <= el.clientWidth) return
      if (e.deltaY === 0) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ── Resolve origin / final node ids ─────────────────────────────
  const _originNodeIdForEntity = useMemo(() => {
    if (item?.kind === 'entity') return _findEntityOriginNodeId(item.id, nodes || [])
    if (item?.kind === 'knowledge') {
      for (const n of (nodes || [])) {
        if (n?.type === 'knowledgeOriginNode' && n?.data?.knowledge_id === item.id) return n.id
      }
      return null
    }
    if (item?.kind === 'relationship') {
      return findRelationshipOriginNodeId(item.id, nodes || [])
    }
    return null
  }, [item, nodes])

  const _finalNodeIdForEntity = useMemo(() => {
    if (!chainIds.length) return null
    return chainIds[chainIds.length - 1]
  }, [chainIds])

  // The node id the Final bookend selects, or null when the bookend
  // isn't shown / the chain is too short to have a distinct final
  // (a length-1 chain is origin-only, so Final would just be Origin —
  // matching the Timeline Navigator, which treats Final as a no-op
  // there). When non-null this id is treated as the Final bookend for
  // pick-shape + selection-ring purposes so the sticky-right bookend
  // lights up rather than the redundant inline last dot.
  const _finalSelectableId = useMemo(
    () => (showFinalBookend && chainIds.length > 1 ? _finalNodeIdForEntity : null),
    [showFinalBookend, chainIds, _finalNodeIdForEntity],
  )

  // Mousedown-based drag start.
  useEffect(() => {
    function onDown(e) {
      if (e.button !== 0) return
      const el = document.elementFromPoint(e.clientX, e.clientY)
      if (!el) return
      const scrollRoot = scrollContainerRef.current
      if (scrollRoot && !scrollRoot.contains(el)) return
      let dotEl = el.closest?.('[data-dot-key]')
      if (!dotEl) {
        let cur = el
        while (cur && cur !== scrollRoot && cur !== document.body) {
          const found = cur.querySelector?.('[data-dot-key]')
          if (found) { dotEl = found; break }
          cur = cur.parentElement
        }
      }
      if (!dotEl) return
      const key = dotEl.getAttribute('data-dot-key') || ''
      const parts = key.split('|')
      const rawId = parts[parts.length - 1]
      if (!rawId) return
      let targetNodeId = rawId
      if (rawId === '__origin__') targetNodeId = _originNodeIdForEntity
      // The Final bookend anchors to the object's last chain node id.
      // When the bookend isn't shown it never renders a dot, so this
      // branch is dead there and the standalone modal is unaffected.
      if (rawId === '__final__') targetNodeId = _finalNodeIdForEntity
      if (!targetNodeId) return
      if (!singleSelect && e.shiftKey) {
        // Shift+click selects a range from origin up to and including
        // the clicked dot — quick "everything up to here" gesture.
        // Origin itself shift-clicked is a degenerate range of length
        // 1 (mode='single'), which is fine. No drag anchor — shift+
        // click is one-shot, not a drag start.
        const originId = _originNodeIdForEntity
        if (!originId) return
        const targetIdx = chainIds.indexOf(targetNodeId)
        const originIdx = chainIds.indexOf(originId)
        if (targetIdx < 0 || originIdx < 0) return
        const lo = Math.min(originIdx, targetIdx)
        const hi = Math.max(originIdx, targetIdx)
        const pickIds = chainIds.slice(lo, hi + 1)
        setSelection({ mode: lo === hi ? 'single' : 'range', pickIds })
        return
      }
      if (!singleSelect && (e.ctrlKey || e.metaKey)) {
        setSelection((prev) => {
          const ids = new Set((prev.mode === 'multi' || prev.mode === 'range' || prev.mode === 'single')
            ? prev.pickIds
            : [])
          if (ids.has(targetNodeId)) ids.delete(targetNodeId)
          else ids.add(targetNodeId)
          return { mode: 'multi', pickIds: Array.from(ids) }
        })
        return
      }
      setSelection({ mode: 'single', pickIds: [targetNodeId] })
      // No drag anchor in single-select mode, so click-drag can't grow a range.
      if (!singleSelect) setDragAnchor(targetNodeId)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [_originNodeIdForEntity, _finalNodeIdForEntity, singleSelect])

  // Click handlers.
  const handleDotClick = useCallback((_entId, col) => {
    if (_eventConsumedByMousedown()) return
    let targetNodeId = null
    if (col?._kind === 'origin') targetNodeId = _originNodeIdForEntity
    else if (col?._kind === 'final') targetNodeId = _finalNodeIdForEntity
    else if (col?._kind === 'scene') targetNodeId = col.id
    if (!targetNodeId) return
    setSelection({ mode: 'single', pickIds: [targetNodeId] })
  }, [_originNodeIdForEntity, _finalNodeIdForEntity])

  const handleModifierDotClick = useCallback((_entId, modifierNodeId) => {
    if (_eventConsumedByMousedown()) return
    if (!modifierNodeId) return
    setSelection({ mode: 'single', pickIds: [modifierNodeId] })
  }, [])

  // Re-resolve the in-flight drag selection from a live cursor (x, y).
  const _updateSelectionForCursor = useCallback((cursorX) => {
    if (!dragAnchor) return
    const root = scrollContainerRef.current || document
    if (!root) return
    const candidates = []
    const nodeEls = root.querySelectorAll
      ? root.querySelectorAll('[data-dot-key]')
      : document.querySelectorAll('[data-dot-key]')
    let anchorCx = null
    for (const el of nodeEls) {
      const key = el.getAttribute('data-dot-key') || ''
      if (key.startsWith('__header__|')) continue
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      const cx = rect.left + rect.width / 2
      const parts = key.split('|')
      let rawId = parts[parts.length - 1]
      if (rawId === '__origin__') rawId = _originNodeIdForEntity
      if (rawId === '__final__') rawId = _finalNodeIdForEntity
      if (!rawId) continue
      candidates.push({ id: rawId, cx })
      if (rawId === dragAnchor) anchorCx = cx
    }
    if (candidates.length === 0 || anchorCx == null) return
    let resolvedId = dragAnchor
    if (cursorX > anchorCx) {
      let best = anchorCx
      for (const c of candidates) {
        if (c.cx <= cursorX && c.cx > best) { best = c.cx; resolvedId = c.id }
      }
    } else if (cursorX < anchorCx) {
      let best = anchorCx
      for (const c of candidates) {
        if (c.cx >= cursorX && c.cx < best) { best = c.cx; resolvedId = c.id }
      }
    }
    const startIdx = chainIds.indexOf(dragAnchor)
    const endIdx = chainIds.indexOf(resolvedId)
    if (startIdx < 0 || endIdx < 0) return
    const lo = Math.min(startIdx, endIdx)
    const hi = Math.max(startIdx, endIdx)
    const pickIds = chainIds.slice(lo, hi + 1)
    setSelection({ mode: lo === hi ? 'single' : 'range', pickIds })
  }, [dragAnchor, chainIds, _originNodeIdForEntity, _finalNodeIdForEntity])

  // Edge-scroll RAF loop while dragging.
  useEffect(() => {
    if (!dragAnchor) return
    let rafId = null
    const EDGE_PX = 60
    const MAX_SPEED = 16
    function tick() {
      const container = scrollContainerRef.current
      if (container) {
        const rect = container.getBoundingClientRect()
        const { x, y } = cursorPosRef.current
        let dx = 0
        if (x < rect.left + EDGE_PX) {
          const depth = Math.max(0, rect.left + EDGE_PX - x)
          dx = -Math.min(MAX_SPEED, (depth / EDGE_PX) * MAX_SPEED)
        } else if (x > rect.right - EDGE_PX) {
          const depth = Math.max(0, x - (rect.right - EDGE_PX))
          dx = Math.min(MAX_SPEED, (depth / EDGE_PX) * MAX_SPEED)
        }
        let dy = 0
        if (y < rect.top + EDGE_PX) {
          const depth = Math.max(0, rect.top + EDGE_PX - y)
          dy = -Math.min(MAX_SPEED, (depth / EDGE_PX) * MAX_SPEED)
        } else if (y > rect.bottom - EDGE_PX) {
          const depth = Math.max(0, y - (rect.bottom - EDGE_PX))
          dy = Math.min(MAX_SPEED, (depth / EDGE_PX) * MAX_SPEED)
        }
        if (dx !== 0) container.scrollLeft += dx
        if (dy !== 0) container.scrollTop += dy
        if (dx !== 0 || dy !== 0) {
          _updateSelectionForCursor(x)
        }
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId)
    }
  }, [dragAnchor, _updateSelectionForCursor])

  // Document-level mousemove during drag. Records cursor position
  // for the RAF loop AND extends the selection in real-time. A
  // document-level listener (rather than a parent-element listener)
  // lets this component work the same when embedded inside another
  // modal (the Setup modal) and still track cursor across the whole
  // viewport.
  useEffect(() => {
    function onMove(e) {
      cursorPosRef.current = { x: e.clientX, y: e.clientY }
      if (!dragAnchor) return
      const candidates = []
      const nodeEls = document.querySelectorAll('[data-dot-key]')
      let anchorCx = null
      for (const el of nodeEls) {
        const key = el.getAttribute('data-dot-key') || ''
        if (key.startsWith('__header__|')) continue
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue
        const cx = rect.left + rect.width / 2
        const parts = key.split('|')
        let rawId = parts[parts.length - 1]
        if (rawId === '__origin__') rawId = _originNodeIdForEntity
        if (rawId === '__final__') rawId = _finalNodeIdForEntity
        if (!rawId) continue
        candidates.push({ id: rawId, cx })
        if (rawId === dragAnchor) anchorCx = cx
      }
      if (candidates.length === 0 || anchorCx == null) return
      let resolvedId = dragAnchor
      if (e.clientX > anchorCx) {
        let best = anchorCx
        for (const c of candidates) {
          if (c.cx <= e.clientX && c.cx > best) { best = c.cx; resolvedId = c.id }
        }
      } else if (e.clientX < anchorCx) {
        let best = anchorCx
        for (const c of candidates) {
          if (c.cx >= e.clientX && c.cx < best) { best = c.cx; resolvedId = c.id }
        }
      }
      const startIdx = chainIds.indexOf(dragAnchor)
      const endIdx = chainIds.indexOf(resolvedId)
      if (startIdx < 0 || endIdx < 0) return
      const lo = Math.min(startIdx, endIdx)
      const hi = Math.max(startIdx, endIdx)
      const pickIds = chainIds.slice(lo, hi + 1)
      setSelection({ mode: lo === hi ? 'single' : 'range', pickIds })
    }
    document.addEventListener('mousemove', onMove)
    return () => document.removeEventListener('mousemove', onMove)
  }, [dragAnchor, chainIds, _originNodeIdForEntity, _finalNodeIdForEntity])

  const setDynamic = useCallback(() => {
    setSelection({ mode: 'dynamic', pickIds: [] })
    setDragAnchor(null)
  }, [])

  // ── Build the props for TimelineGridView ────────────────────────
  const importPicks = useMemo(() => {
    if (!item || selection.pickIds.length === 0) return new Map()
    const primary = selection.pickIds[0]
    const pickShape = _resolvePickShape(primary, nodes, _originNodeIdForEntity, _finalSelectableId)
    if (!pickShape) return new Map()
    return new Map([[item.id, pickShape]])
  }, [item, selection.pickIds, nodes, _originNodeIdForEntity, _finalSelectableId])

  const extraSelectedDots = useMemo(() => {
    if (!item || selection.pickIds.length === 0) return new Map()
    const entry = { origin: false, final: false, scenes: new Set(), modifiers: new Set() }
    for (const id of selection.pickIds) {
      if (id === _originNodeIdForEntity) {
        entry.origin = true
      } else if (_finalSelectableId && id === _finalSelectableId) {
        // The last chain node is represented by the sticky Final bookend
        // when it's shown, so light the bookend rather than the inline
        // last dot (which is the same state) — matches the Navigator.
        entry.final = true
      } else {
        const node = (nodes || []).find((n) => n.id === id)
        if (node?.type === 'entityNode' && node.data?.is_modifier) entry.modifiers.add(id)
        else entry.scenes.add(id)
      }
    }
    return new Map([[item.id, entry]])
  }, [item, selection.pickIds, nodes, _originNodeIdForEntity, _finalSelectableId])

  const rangeFillSpansMap = useMemo(() => {
    if (!item || selection.pickIds.length < 2) return null
    const idxes = selection.pickIds
      .map((id) => chainIds.indexOf(id))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)
    if (idxes.length < 2) return null
    let contiguous = true
    for (let i = 1; i < idxes.length; i++) {
      if (idxes[i] !== idxes[i - 1] + 1) { contiguous = false; break }
    }
    if (!contiguous) return null
    function _idForFraction(idx) {
      const nodeId = chainIds[idx]
      if (nodeId === _originNodeIdForEntity) return '__origin__'
      if (_finalSelectableId && nodeId === _finalSelectableId) return '__final__'
      return nodeId
    }
    return new Map([[item.id, {
      startChainPointId: _idForFraction(idxes[0]),
      endChainPointId: _idForFraction(idxes[idxes.length - 1]),
    }]])
  }, [item, selection.pickIds, chainIds, _originNodeIdForEntity, _finalSelectableId])

  const dynamicResolutionMap = useMemo(() => {
    if (!item || !dynamicResolutionPoint) return new Map()
    return new Map([[item.id, dynamicResolutionPoint]])
  }, [item, dynamicResolutionPoint])

  const otherPinMarkersMap = useMemo(() => {
    if (!item || !otherPinMarkers) return new Map()
    return new Map([[item.id, otherPinMarkers]])
  }, [item, otherPinMarkers])

  // ── Right-click handler for dashed-ringed dots ──────────────────
  const [otherPinConfirm, setOtherPinConfirm] = useState(null)
  const handleOtherPinContextMenu = useCallback((sessionId, _anchorPointId, cursorPos, marker) => {
    if (!sessionId) return
    setOtherPinConfirm({
      sessionId,
      label: marker?.label || 'this context entry',
      x: cursorPos?.x ?? 0,
      y: cursorPos?.y ?? 0,
    })
  }, [])
  const confirmRemoveOtherPin = useCallback(() => {
    const sid = otherPinConfirm?.sessionId
    setOtherPinConfirm(null)
    if (sid && onClearOtherPin) onClearOtherPin(sid)
  }, [otherPinConfirm, onClearOtherPin])
  const cancelRemoveOtherPin = useCallback(() => setOtherPinConfirm(null), [])
  // Esc dismisses the confirm popover. Captures BEFORE other Esc
  // handlers (e.g. the wrapping modal's close handler) so the popover
  // takes the keystroke first when it's open.
  useEffect(() => {
    if (!otherPinConfirm) return
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOtherPinConfirm(null)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [otherPinConfirm])

  // Stable references for `TimelineGridView`'s props that don't depend
  // on the active drag-selection. Phase 2.11 Bugs & Fixes — without
  // these, profile `profiling-data.2026-05-31.19-28-15.json` showed
  // `TimelineGridView` re-rendering 170 times for 158 ms self, with
  // 137 / 170 renders citing `Props changed: [gridEntities,
  // importPicks, extraSelectedDots, rangeFillSpans, dotTooltip,
  // modifierDotTooltip]`. The first prop and the two tooltip lambdas
  // were rebuilt every parent render (`[focusedRow]` literal + inline
  // arrows); now they keep identity until `focusedRow` actually
  // changes. `importPicks` / `extraSelectedDots` / `rangeFillSpans`
  // legitimately change during a drag-selection (selection state
  // moves) — those changes are warranted and not addressed here.
  const gridEntities = useMemo(() => (focusedRow ? [focusedRow] : []), [focusedRow])
  const dotTooltipCb = useCallback((ent, col) => col._kind === 'origin'
    ? `${ent.name} at origin — click to anchor here. Shift-click on a downstream point to select a range from origin to that point.`
    : col._kind === 'final'
      ? `${ent.name} at final state — click to anchor here. Shift-click to select a range from origin to here.`
      : `${ent.name} at "${col.title}" — click to anchor here. Shift-click to select a range from origin to here.`,
  [])
  const modifierDotTooltipCb = useCallback(
    (ent, mod) => `${ent.name} — modifier #${mod.chain_index} — click to anchor here. Shift-click to select a range from origin to here.`,
    [],
  )

  // ── Imperative ref API for wrappers ─────────────────────────────
  useImperativeHandle(ref, () => ({
    getCurrentPins() {
      if (!item) return []
      return _selectionToPins(selection, chainIds, item)
    },
    getSelection() {
      return selection
    },
  }), [item, selection, chainIds])

  if (!item) return null

  return (
    <>
      {/* Cursor-anchored "Remove that?" popover for right-click on
          a dashed-ringed chain point. Portaled to fixed inset-0 so
          it sits ABOVE the timeline body's overflow container AND
          above any wrapping modal's chrome. */}
      {otherPinConfirm && (
        <div
          className="fixed inset-0 z-[70]"
          onClick={(e) => { e.stopPropagation(); cancelRemoveOtherPin() }}
          onContextMenu={(e) => { e.preventDefault(); cancelRemoveOtherPin() }}
        >
          <div
            className="absolute bg-zinc-900 border border-zinc-700 rounded-md shadow-2xl px-3 py-2.5 max-w-[300px] text-xs text-zinc-200"
            style={{
              left: Math.min(otherPinConfirm.x + 6, window.innerWidth - 310),
              top: Math.min(otherPinConfirm.y + 6, window.innerHeight - 110),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-[11px] text-zinc-300 leading-snug">
              Already attached as context: <span className="font-semibold text-zinc-100">{otherPinConfirm.label}</span>.
              <br />
              Remove that?
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={cancelRemoveOtherPin}
                className="text-[10px] px-2 py-0.5 rounded border border-zinc-700 bg-zinc-800/40 text-zinc-300 hover:bg-zinc-700/60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmRemoveOtherPin}
                className="text-[10px] px-2 py-0.5 rounded border border-red-700 bg-red-900/40 text-red-100 hover:bg-red-800/60 font-semibold"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Timeline body — `TimelineGridView` with a single-row gridEntities.
          `pb-2` gives the dot row breathing room above the horizontal
          scrollbar that appears at the bottom of the scroll container
          when the chain is wider than the viewport. Without it, the
          scrollbar visually butts up against the bottom of the dots. */}
      <div ref={scrollContainerRef} className="flex-1 overflow-auto pb-2" data-help-region="chain-range-selector:timeline">
        {focusedRow ? (
          <TimelineGridView
            preview={preview}
            gridEntities={gridEntities}
            importPicks={importPicks}
            extraSelectedDots={extraSelectedDots}
            otherPinMarkers={otherPinMarkersMap}
            dynamicResolutionPoint={dynamicResolutionMap}
            rangeFillSpans={rangeFillSpansMap}
            otherPinRangeFillSpans={otherPinRangeFillSpans}
            hideFinalBookend={!showFinalBookend}
            identityCellWidth={identityCellWidth}
            onDotClick={handleDotClick}
            onModifierDotClick={handleModifierDotClick}
            onOtherPinMarkerContextMenu={handleOtherPinContextMenu}
            onColumnHeaderClick={null}
            onChapterHeaderClick={null}
            onActHeaderClick={null}
            dotTooltip={dotTooltipCb}
            modifierDotTooltip={modifierDotTooltipCb}
          />
        ) : (
          <div className="px-4 py-4 text-[11px] text-zinc-500 italic">
            This item has no narrative chain to anchor to.
          </div>
        )}
      </div>

      {/* Dynamic option + interaction hint. `hideDynamicOption`
          suppresses the "Dynamically match the conversation's current
          scene" button entirely — set by the Character Chat Setup
          modal because a character chat has no per-message scene
          anchor for dynamic mode to follow. The interaction hint
          (drag, ctrl-click) still renders. */}
      <div className="px-4 py-2 border-t border-zinc-800 flex flex-col gap-2">
        {!hideDynamicOption && (
          <div className="flex items-start gap-3">
            <button
              type="button"
              data-help-region="chain-range-selector:dynamic_match"
              onClick={(e) => {
                if ((e.ctrlKey || e.metaKey) && !hasDynamicPin && onAddDynamicPin) {
                  e.preventDefault()
                  onAddDynamicPin()
                  return
                }
                setDynamic()
              }}
              onContextMenu={(e) => {
                if (!dynamicPinSessionId) return
                e.preventDefault()
                setOtherPinConfirm({
                  sessionId: dynamicPinSessionId,
                  label: 'Dynamically match current scene',
                  x: e.clientX,
                  y: e.clientY,
                })
              }}
              title={hasDynamicPin
                ? 'This item already has a dynamic context entry attached. Right-click to remove that entry.'
                : 'Click to set this entry to dynamic. Ctrl-click to add a dynamic context entry alongside your current selection.'}
              className={`text-[11px] rounded px-2 py-1 border transition-colors flex-shrink-0 ${
                selection.mode === 'dynamic'
                  ? 'border-amber-500 bg-amber-900/40 text-amber-100'
                  : hasDynamicPin
                    ? 'border-dashed border-amber-500/70 bg-zinc-800/40 text-zinc-200 hover:bg-zinc-700/60'
                    : 'border-zinc-700 bg-zinc-800/40 text-zinc-300 hover:bg-zinc-700/60'
              }`}
            >
              Dynamically match the conversation's current scene
            </button>
            <div className="text-[10px] text-zinc-500">
              When dynamic, this context follows whatever scene the conversation is currently reading from (or starts from the {item.kind === 'entity' ? 'entity\'s initial state' : 'object\'s initial state'} when no scene is active).
              {hasDynamicPin && (
                <> A dynamic entry for this item is already attached.</>
              )}
              {!hasDynamicPin && onAddDynamicPin && (
                <> Hold <kbd className="px-1 py-px bg-zinc-800 border border-zinc-700 rounded text-zinc-300">Ctrl</kbd> + click to add a dynamic entry alongside your current selection.</>
              )}
            </div>
          </div>
        )}
        <div className="text-[10px] text-zinc-500">
          {singleSelect ? (
            'Click a scene to anchor the snapshot there. Click another to move it.'
          ) : (
            <>Click a chain point to anchor here. Click and drag to select a range. Hold <kbd className="px-1 py-px bg-zinc-800 border border-zinc-700 rounded text-zinc-300">Shift</kbd> while clicking to select a range from origin up to and including the clicked point. Hold <kbd className="px-1 py-px bg-zinc-800 border border-zinc-700 rounded text-zinc-300">Ctrl</kbd> while clicking to pick multiple non-adjacent points (each becomes its own context entry on confirm). Right-click a dashed-ringed point to remove the other context entry that covers it (with a confirmation prompt).</>
          )}
        </div>
      </div>

      {/* Selection description (footer-style summary text) */}
      <div className="px-4 py-1 text-[10px] text-zinc-500" data-help-region="chain-range-selector:selection_summary">
        {_describeSelection(selection, chainIds, nodes, _originNodeIdForEntity, _finalNodeIdForEntity)}
      </div>
    </>
  )
})

// `React.memo` so parent re-renders don't cascade through here on every
// outer store mutation. Profile capture at v0.2.11.16 showed this
// component rendering 387 times in lockstep with `TimelineGridView`
// while the Character Chat Setup modal was open — once per outer store
// commit despite the writer doing nothing. The Setup modal already
// memoises its `item` prop and uses `useCallback` for the
// `onSelectionChange` handler, so memoising the export is the missing
// piece. `TimelineGridView` is rendered as a child of this component,
// so memoising the parent stops the child cascade too without needing
// to memoise `TimelineGridView` itself.
export default memo(ChainRangeSelector)


// ── Helpers ──────────────────────────────────────────────────────

// Build the `pick` shape `TimelineGridView` expects (used by
// `importPicks` + `resolveIdentityState` to drive the row's identity-
// cell effective state) from a chain node id. Origin is its own bookend
// cell. When the Final bookend is shown (`finalSelectableId` non-null),
// the chain's last node is represented by the sticky-right Final bookend,
// so emit `kind: 'final'` for it — the pick ring + identity resolution
// then land on the bookend rather than the redundant inline last dot.
// When the bookend is hidden (`finalSelectableId` null — the standalone
// modal), the last node stays a regular scene / modifier and no `final`
// pick is ever emitted.
function _resolvePickShape(nodeId, nodes, originNodeId, finalSelectableId) {
  if (!nodeId) return null
  if (nodeId === originNodeId) return { kind: 'origin' }
  if (finalSelectableId && nodeId === finalSelectableId) return { kind: 'final' }
  const node = (nodes || []).find((n) => n.id === nodeId)
  if (node?.type === 'sceneNode') return { kind: 'scene', scene_id: nodeId }
  if (node?.type === 'entityNode' && node?.data?.is_modifier) {
    return { kind: 'modifier', modifier_node_id: nodeId }
  }
  return null
}


// Convert in-selector selection into final pin payload(s). Non-
// contiguous multi-mode expands into multiple pins (one range per
// contiguous run, one single-anchor per isolated point) per the 2.7c
// spec.
function _selectionToPins(selection, chainIds, item) {
  if (!item) return []
  const base = { kind: item.kind, id: item.id }
  if (selection.mode === 'dynamic') return [{ ...base }]
  if (selection.pickIds.length === 0) return []
  if (selection.mode === 'single' || selection.pickIds.length === 1) {
    return [{ ...base, anchor_node_id: selection.pickIds[0] }]
  }
  const idxes = selection.pickIds
    .map((id) => chainIds.indexOf(id))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)
  if (idxes.length === 0) return []
  const pins = []
  let runStart = idxes[0]
  let runEnd = idxes[0]
  for (let i = 1; i < idxes.length; i++) {
    const cur = idxes[i]
    if (cur === runEnd + 1) {
      runEnd = cur
    } else {
      pins.push(_runToPin(base, chainIds, runStart, runEnd))
      runStart = cur
      runEnd = cur
    }
  }
  pins.push(_runToPin(base, chainIds, runStart, runEnd))
  return pins
}


function _runToPin(base, chainIds, startIdx, endIdx) {
  if (startIdx === endIdx) return { ...base, anchor_node_id: chainIds[startIdx] }
  return {
    ...base,
    anchor_range: {
      start_node_id: chainIds[startIdx],
      end_node_id: chainIds[endIdx],
      members: chainIds.slice(startIdx, endIdx + 1),
    },
  }
}


// Writer-facing summary of the current selection state.
function _describeSelection(selection, chainIds, nodes, originNodeId, finalNodeId) {
  if (selection.mode === 'dynamic') return 'Will be dynamic (follows the conversation\'s current scene).'
  if (selection.pickIds.length === 0) return 'Click a point on the timeline to anchor here.'
  function _labelFor(id) {
    if (id === originNodeId) return 'Origin'
    if (id === finalNodeId && chainIds.length > 1) return 'Final'
    const node = (nodes || []).find((n) => n.id === id)
    if (!node) return '(missing)'
    if (node.type === 'sceneNode') return node.data?.title || 'Untitled scene'
    if (node.type === 'entityNode' && node.data?.is_modifier) return 'Modifier'
    return '(chain point)'
  }
  if (selection.mode === 'single') {
    return `Anchored at "${_labelFor(selection.pickIds[0])}".`
  }
  if (selection.mode === 'range') {
    const sorted = selection.pickIds
      .map((id) => ({ id, idx: chainIds.indexOf(id) }))
      .filter((x) => x.idx >= 0)
      .sort((a, b) => a.idx - b.idx)
    if (sorted.length === 0) return 'Click a point on the timeline to anchor here.'
    return `Range across ${sorted.length} points: "${_labelFor(sorted[0].id)}" → "${_labelFor(sorted[sorted.length - 1].id)}".`
  }
  if (selection.mode === 'multi') {
    const idxes = selection.pickIds
      .map((id) => chainIds.indexOf(id))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)
    let runs = 0
    let prev = -2
    for (const i of idxes) {
      if (i !== prev + 1) runs += 1
      prev = i
    }
    return `${idxes.length} points selected; will commit as ${runs} separate context entries on confirm.`
  }
  return 'Click a point on the timeline to anchor here.'
}
