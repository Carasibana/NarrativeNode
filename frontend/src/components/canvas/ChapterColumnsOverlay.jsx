/**
 * ChapterColumnsOverlay — Phase 1.11 column-division view.
 *
 * Two layers, mounted as children of <ReactFlow>:
 *
 *   1. Flow-space tint bands: rendered via <ViewportPortal> so they pan and
 *      zoom with the canvas. Each chapter gets a vertical band spanning the
 *      chapter's flow-space x range, tinted with the chapter colour at a
 *      very low alpha (~6%). Between each adjacent pair of bands sits a
 *      thin 1 px divider line at ~18% alpha. Both are deliberately subtle.
 *
 *   2. Screen-space header row: absolutely positioned at the very top of
 *      the ReactFlow container. The header is a **two-row stack** — an Act
 *      row on top, Chapter row below. Each row is `ROW_HEIGHT_PX` tall,
 *      sized to match the left sidebar's tab rows (Library/Details tabs
 *      row for acts, entity type icons row for chapters).
 *
 *      The Act row is **collapsible** via `uiStore.chapterHeaderActsCollapsed`.
 *      When collapsed the Act row is hidden entirely and the total header
 *      shrinks to just the Chapter row height. The canvas toolbar reads the
 *      same collapse state and shifts its top offset down or up accordingly
 *      (see CanvasToolbar.jsx).
 *
 *      Chapter cells are positioned by computing each cell's screen x from
 *      `flow.x * viewport.zoom + viewport.x`, so the header column positions
 *      track the flow-space tint bands as the user pans and zooms. Each cell
 *      shows a two-line title stack (auto-numbered "Chapter N" + optional
 *      custom title). Two STATIC buttons live at the far right of the
 *      Chapter row: a collapse-toggle chevron and the Add Chapter ＋.
 *
 * Chapter membership for plot point nodes is derived from x-position via
 * `getChapterIdForNode` in chapterMembership.js — this component is
 * display-only and never writes chapter_id to any node.
 *
 * Later commits will layer on top of this skeleton:
 *   - double-click header popup editor (title + colour)
 *   - divider-drag resize
 *   - × hover delete
 *   - drag-to-reorder
 *   - act row content (act cells + drag-to-create + edge-drag resize)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ViewportPortal, useViewport, useReactFlow, useStore } from '@xyflow/react'
import { useProjectStore } from '../../store/projectStore'
import { useUiStore } from '../../store/uiStore'
import TableOfContentsPanel from '../panels/TableOfContentsPanel'
import TimelineNavigatorPanel from '../panels/TimelineNavigatorPanel'
import EntityColorPicker from '../ui/EntityColorPicker'
import { getMeasuredWidth, getMeasuredHeight } from '../../utils/measuredDimensionsStore'
import { buildChapterLayout, rowGeometryParams, multirowHeaderRows, multirowHeaderRowsForStory, MIN_ROW_HEIGHT, rowIndexForTop } from '../../utils/rowLayout'

// Stable empty array to avoid re-render churn when story has no chapters.
const EMPTY_ARRAY = []

// Default chapter tint when `chapter.colour` is null. Neutral zinc so it
// reads as "no colour set" rather than a deliberate choice.
const DEFAULT_CHAPTER_COLOUR = '#71717a' // zinc-500

// Very large vertical extent for the tint bands so they cover any plausible
// canvas area without the user ever seeing them end. Not Infinity because
// browsers can glitch on extreme values; 100 000 flow-px is fine.
const BAND_TOP = -50000
const BAND_HEIGHT = 100000
// Horizontal counterpart for multi-row row dividers: they start at the
// strip's left edge and run far to the right, the way single-row column
// dividers run BAND_HEIGHT down. Not Infinity (browsers glitch on extreme
// values); 100 000 flow-px reads as "to the right edge, always".
const BAND_WIDTH = 100000

// Phase 4.3 multi-row layout. The vertical geometry (ROWS_TOP_Y,
// ROW_VGAP, ROW_HEADER_RESERVED) now lives in utils/rowLayout via
// `rowGeometryParams`, shared with the chapter-as-group node
// repositioning in projectStore so bands and node anchors stay aligned.

// Row height matches the left sidebar's `py-1.5 text-xs border-b` tab rows
// after the sidebar's `zoom: 1.25` CSS scale is applied to them. The raw
// computed box is 29 px (16 px line-height + 12 px py-1.5 padding + 1 px
// border) but the sidebar's root wrapper (see EntityLibraryPanel.jsx line
// 677: `style={{ width: 224, zoom: 1.25 }}`) scales everything inside by
// 1.25x in screen space, so the actually-rendered row height is ~36 px.
// The chapter header does NOT inherit that zoom (it sits on the canvas,
// not in the sidebar), so it has to use a raw pixel value to match the
// zoomed sidebar's apparent height. Matching font-size (15 ≈ 12 × 1.25)
// and line-height (1.333 to match text-xs's unitless multiplier) keeps
// the visual rhythm consistent too.
export const ROW_HEIGHT_PX = 38.5

// Multi-row viewport cull overscan, in SCREEN px (divided by zoom at use).
// A small margin so a row whose edge is right at the viewport boundary stays
// rendered; kept minimal because the per-frame cost scales with the number of
// rows rendered, and the dominant vertical-motion cost is React Flow node
// churn (not overlay rows), which a larger overscan does not help.
const ROW_OVERSCAN_FLOW = 2 * ROW_HEIGHT_PX

// Shared style for the edge-shuffle arrow buttons in multi-row chapter
// header cells (Phase 4.3 §5 — move a row's first/last chapter to the
// adjacent row). Caller spreads `left` or `right` on top.
const rowShuffleBtnStyle = {
  position: 'absolute',
  top: (ROW_HEIGHT_PX - 18) / 2,
  width: 18,
  height: 18,
  borderRadius: 3,
  border: '1px solid rgba(82, 82, 91, 0.8)',
  backgroundColor: 'rgba(63, 63, 70, 0.9)',
  color: '#a1a1aa',
  cursor: 'pointer',
  fontSize: 12,
  lineHeight: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  zIndex: 2,
}

// Corner-button size. Square, sized to fit flush inside the row height
// with a small margin above and below.
const ROW_BUTTON_SIZE = 28
const ROW_BUTTON_MARGIN = (ROW_HEIGHT_PX - ROW_BUTTON_SIZE) / 2

const HEADER_BG = 'rgba(24, 24, 27, 0.88)' // zinc-900 @ 88%
const BORDER_COLOUR = 'rgba(63, 63, 70, 0.8)' // zinc-700-ish

// Given `chapters` and `acts`, return every chapter id NOT yet claimed by
// any existing act, in chapters[] order. Used by the Add Act button which
// defaults a new act to span whichever chapters are currently free. The
// store's `addAct` runs the result through `_pruneActContiguity`, so if
// the unclaimed set is not contiguous (a gap between two existing acts)
// the new act gets the longest contiguous run of free chapters.
function _unclaimedChapterIds(chapters, acts) {
  const claimed = new Set()
  for (const a of acts) {
    for (const id of a.chapter_ids) claimed.add(id)
  }
  const out = []
  for (const c of chapters) {
    if (!claimed.has(c.id)) out.push(c.id)
  }
  return out
}

// Phase 4.3 — multi-row act-resize cursor mapping. Given a flow-space point
// (the live cursor during an act-edge drag) and the current multi-row layout,
// return the global `chapters[]` index of the chapter under the cursor. The
// row is chosen by the cursor's Y (it "enters" the next row once it reaches
// that row's header top, via `rowIndexForTop` with the full header reserve);
// within the row the chapter is chosen by X, clamped to the row's ends. Empty
// rows fall back to the nearest non-empty row (scan up then down). Because the
// row-major flattening of `chapter_rows` equals `chapters[]`, this index feeds
// the SAME shared/solo clamp + commit logic the single-row path uses.
function chapterIndexAtFlowPoint(flowX, flowY, rowLayout, mrHeaderRows, chapters) {
  if (!rowLayout || !rowLayout.bands || rowLayout.bands.length === 0) return 0
  const bands = rowLayout.bands
  const reserve = mrHeaderRows * ROW_HEIGHT_PX
  let rowIdx = rowIndexForTop(flowY, bands, reserve)
  if (rowIdx < 0) rowIdx = 0
  const cellsInRow = (r) => rowLayout.cells.filter((c) => c.rowIndex === r)
  let rowCells = cellsInRow(rowIdx)
  if (rowCells.length === 0) {
    for (let r = rowIdx - 1; r >= 0 && rowCells.length === 0; r--) rowCells = cellsInRow(r)
    for (let r = rowIdx + 1; r < bands.length && rowCells.length === 0; r++) rowCells = cellsInRow(r)
  }
  if (rowCells.length === 0) return 0
  let target = rowCells[rowCells.length - 1]
  if (flowX < rowCells[0].left) {
    target = rowCells[0]
  } else {
    for (const c of rowCells) {
      if (flowX < c.left + c.width) { target = c; break }
    }
  }
  const idx = chapters.findIndex((c) => c.id === target.id)
  return idx < 0 ? 0 : idx
}

// Canvas dot-grid gap (see <Background gap={20}> in Canvas.jsx). Chapter
// widths are snapped to multiples of this value during divider drag so
// column boundaries land exactly on grid dots at any zoom level. Minimum
// chapter width is also expressed as a multiple of the grid (6 × 20 = 120).
const GRID_SNAP_PX = 20
const MIN_CHAPTER_WIDTH_PX = 120

export default function ChapterColumnsOverlay() {
  const chapters = useProjectStore((s) => s.story?.chapters || EMPTY_ARRAY)
  const acts = useProjectStore((s) => s.story?.acts || EMPTY_ARRAY)
  const storedChapterXOffset = useProjectStore((s) => {
    const v = s.story?.chapter_x_offset
    return typeof v === 'number' ? v : 10
  })
  const chapterLabel = useProjectStore((s) => s.story?.chapter_label) || 'Chapter'
  const actLabel = useProjectStore((s) => s.story?.act_label) || 'Act'
  const addChapter = useProjectStore((s) => s.addChapter)
  const insertChapterAt = useProjectStore((s) => s.insertChapterAt)
  const addChapterRow = useProjectStore((s) => s.addChapterRow)
  const deleteChapterRow = useProjectStore((s) => s.deleteChapterRow)
  const moveChapterBetweenRows = useProjectStore((s) => s.moveChapterBetweenRows)
  const setRowHeightLive = useProjectStore((s) => s.setRowHeightLive)
  const addAct = useProjectStore((s) => s.addAct)
  const setChapterTitleAndColour = useProjectStore((s) => s.setChapterTitleAndColour)
  const setChapterResizeLive = useProjectStore((s) => s.setChapterResizeLive)
  const deleteChapter = useProjectStore((s) => s.deleteChapter)
  const setActTitleAndColour = useProjectStore((s) => s.setActTitleAndColour)
  const setActRange = useProjectStore((s) => s.setActRange)
  const setAdjacentActBoundary = useProjectStore((s) => s.setAdjacentActBoundary)
  const deleteAct = useProjectStore((s) => s.deleteAct)
  const actsCollapsed = useUiStore((s) => s.chapterHeaderActsCollapsed)
  const toggleActs = useUiStore((s) => s.toggleChapterHeaderActs)
  // Phase 4.3 — multi-row acts header is driven by a PERSISTED per-story
  // marker (not the ephemeral uiStore flag single-row uses), because the
  // multi-row node positions are anchored to the header allowance and must
  // survive save/reload. Defaults false (collapsed). The toggle re-anchors
  // every scene (push down on expand / up on collapse) so membership + story
  // order are unchanged — only the on-screen y shifts.
  const multirowActsExpanded = useProjectStore((s) => !!s.story?.multirow_acts_expanded)
  const toggleMultirowActsExpanded = useProjectStore((s) => s.toggleMultirowActsExpanded)
  const chapterHeaderCollapsed = useUiStore((s) => s.chapterHeaderCollapsed)
  const toggleChapterHeaderCollapsed = useUiStore((s) => s.toggleChapterHeaderCollapsed)
  // Phase 1.11 Bug 4 — z-order preference for the canvas tint bands. True
  // (default) = bands sit BEHIND nodes; false = legacy overlay mode.
  const tintBehindNodes = useProjectStore((s) => s.story?.chapter_tint_behind_nodes !== false)
  // Phase 4.3 — multi-row layout. `chapterRows` is the additive row
  // grouping overlay (null = never enabled); `layoutMode` is the active
  // view. `multiRow` gates every rows-specific render branch below; when
  // false the overlay renders the exact single-row path (byte-identical).
  const chapterRows = useProjectStore((s) => s.story?.chapter_rows || null)
  const layoutMode = useProjectStore((s) => s.story?.canvas_layout_mode || 'single')
  const viewport = useViewport()
  // Canvas pixel width (reactive, no DOM read). Used to sticky-centre header
  // labels (chapter / act) in the on-screen portion of a wide cell so the
  // label stays visible when the cell extends past either viewport edge.
  const canvasWidth = useStore((s) => s.width)
  // Canvas pixel height (reactive). Used by the multi-row header layer to
  // cull off-screen rows: the screen-space header strips / cells / act
  // segments / handles / chevrons re-render on every viewport frame, so
  // rendering all rows (not just the few on screen) makes per-frame cost
  // scale with project size. Gating each per-row map on `bandVisible[]`
  // (derived from this height + the viewport) keeps the cost flat — O(rows
  // on screen) regardless of how many rows the story has.
  const canvasHeight = useStore((s) => s.height)
  // Used by the single-click-to-fit handler on chapter / act header
  // cells (Phase 1.12c v0.1.12.60). `setCenter` pans + zooms the
  // viewport to the clicked chapter / act's flow-space x range, same
  // math as `TableOfContentsPanel.focusXRange`. Double-click still
  // opens the in-place editor — single vs double is disambiguated
  // via a short timer (see `scheduleHeaderFit` below).
  const { setCenter, getViewport } = useReactFlow()

  // In-place chapter edit state. When `editingChapterId` is set, the
  // matching chapter cell shows a colour chip on its left and swaps the
  // custom-title display for a text input. `draftTitle` and `draftColour`
  // hold the form values locally so the store only sees a single snapshot
  // when the user commits. `editingCellRef` attaches to the currently
  // editing cell's outer div so the click-outside handler can check
  // whether a mousedown landed inside or outside it. `colourChipRef`
  // anchors the EntityColorPicker popover to the visible colour chip.
  const [editingChapterId, setEditingChapterId] = useState(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftColour, setDraftColour] = useState(DEFAULT_CHAPTER_COLOUR)
  const editingCellRef = useRef(null)
  const titleInputRef = useRef(null)
  const colourChipRef = useRef(null)
  const [chapterColourPickerOpen, setChapterColourPickerOpen] = useState(false)

  // ── Single-click-to-fit handler (Phase 1.12c v0.1.12.60) ───────
  // Click a chapter / act header cell to pan + zoom the canvas to
  // that chapter / act's x range, same behaviour as the Timeline
  // Navigator's header click. Double-click still opens the in-place
  // editor — single vs double is disambiguated by a 220 ms timer:
  // on click, schedule the fit action; if a second click arrives
  // before the timer fires, the double-click handler clears the
  // timer and opens the editor instead. Standard single-vs-double
  // disambiguation — matches OS double-click interval defaults.
  const headerClickTimerRef = useRef(null)
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

  const scheduleHeaderFit = useCallback((xMin, xMax) => {
    if (headerClickTimerRef.current) {
      clearTimeout(headerClickTimerRef.current)
    }
    headerClickTimerRef.current = setTimeout(() => {
      headerClickTimerRef.current = null
      focusXRange(xMin, xMax)
    }, 220)
  }, [focusXRange])

  const cancelHeaderFit = useCallback(() => {
    if (headerClickTimerRef.current) {
      clearTimeout(headerClickTimerRef.current)
      headerClickTimerRef.current = null
    }
  }, [])

  // Ensure a pending fit timer doesn't fire after the component
  // unmounts (e.g. project switch).
  useEffect(() => () => {
    if (headerClickTimerRef.current) clearTimeout(headerClickTimerRef.current)
  }, [])

  // In-place act edit state — mirrors the chapter editor above. Each act
  // cell behaves the same as a chapter cell when double-clicked: colour
  // chip on the left, title input in the middle, delete button on the
  // right. `editingActCellRef` attaches to the currently editing act cell
  // so click-outside detection has a distinct ref from the chapter
  // editor's (the two editors are independent).
  const [editingActId, setEditingActId] = useState(null)
  // Phase 4.3 — in multi-row an act can appear as one segment PER ROW it
  // spans. This records the segment key the user actually double-clicked so
  // the inline editor opens on THAT row's segment, not always the act's first
  // one. Null in single-row (one cell) or when an editor opens from a non-
  // segment path; the multi-row render then falls back to the first segment.
  const [editingActSegKey, setEditingActSegKey] = useState(null)
  const [draftActTitle, setDraftActTitle] = useState('')
  const [draftActColour, setDraftActColour] = useState(DEFAULT_CHAPTER_COLOUR)
  const editingActCellRef = useRef(null)
  const actTitleInputRef = useRef(null)
  const actColourChipRef = useRef(null)
  const [actColourPickerOpen, setActColourPickerOpen] = useState(false)

  // Act edge drag state. Similar structure to the chapter resize: the
  // reactive bit (`actResizeState`) tracks which act and which edge is
  // being dragged for render-time highlights; the heavy drag data lives
  // on `actResizeRef.current` so mousemove / mouseup read the latest
  // values without re-rendering. Draft indices drive the live preview
  // by overriding the act's chapter_ids during `actRanges` computation.
  // `actResizeState` holds the slice of drag state that the render path
  // needs to read each frame: which act and edge is being grabbed, the
  // mode, and (in shared mode) the partner act ids + their initial outer
  // bounds. Updated only when the drag starts/ends, NOT on every
  // mousemove. The mousemove handler updates `draftPivotIdx` (shared mode)
  // or `draftActLeftIdx`/`draftActRightIdx` (solo mode) in state, and
  // tracks the live committed values on `actResizeRef.current` for the
  // mouseup commit. Refs aren't readable from render under the React 19
  // hook rules, hence the split.
  const [actResizeState, setActResizeState] = useState(null)
  const [draftActLeftIdx, setDraftActLeftIdx] = useState(0)
  const [draftActRightIdx, setDraftActRightIdx] = useState(0)
  const [draftPivotIdx, setDraftPivotIdx] = useState(0)
  const actResizeRef = useRef(null)
  // Latest multi-row layout snapshot for the act-resize cursor mapping.
  // `startActResize` and the drag listener run AFTER the component body, so
  // they read this ref (refs always hold the latest) instead of closing over
  // `rowLayout` / `mrHeaderRows` directly — those are declared lower in the
  // body, so putting them in a useCallback/useEffect deps array up here would
  // trip a TDZ error. Assigned during render once those are computed.
  const multiRowMapRef = useRef(null)

  // Flash timestamp for the "Add Act blocked" feedback: set to `Date.now()`
  // when the user clicks Add Act but every chapter is already in an act.
  // Used as the React key on the flash element so clicking Add Act
  // repeatedly restarts the fade animation. A setTimeout inside a
  // useEffect clears the timestamp back to 0 after 2s so the element
  // unmounts cleanly when the animation finishes.
  const [actAddBlockedAt, setActAddBlockedAt] = useState(0)
  useEffect(() => {
    if (!actAddBlockedAt) return undefined
    const id = setTimeout(() => setActAddBlockedAt(0), 2000)
    return () => clearTimeout(id)
  }, [actAddBlockedAt])

  // Chapter column resize drag state. Supports three handle modes:
  //
  //   - 'right': drag the right edge of any chapter, which also serves as
  //     the divider between that chapter and the next. Updates the chapter's
  //     width; for non-last chapters this shifts every chapter after it.
  //   - 'left-first': drag the LEFT edge of the first chapter. Updates the
  //     story's `chapter_x_offset` AND the first chapter's width in
  //     opposite directions, so the chapter's right edge stays pinned and
  //     the left edge slides (extending into negative x if needed).
  //
  // The current draft values live on `resizeRef.current` (not in state) so
  // that the mouseup handler reads the latest committed values directly
  // — React Strict Mode invokes state updater functions twice, and the
  // earlier functional-setState-with-side-effect pattern (v0.1.11.15)
  // caused the store action to fire twice per drag → two undo entries.
  // Using the ref avoids that. `draftChapterWidth` and `draftXOffset` are
  // still state purely because they need to trigger rerenders.
  // `resizeState` is the reactive part of the resize drag: just the active
  // chapter id and mode, used for render-time visual highlights on the
  // active handle. The rest of the drag data (initial values, start x,
  // live committed values) lives on `resizeRef.current` so the mousemove
  // / mouseup handlers read the freshest values without triggering extra
  // re-renders. `draftChapterWidth` and `draftXOffset` are state purely
  // so they can drive rerenders of the edges computation during drag.
  const [resizeState, setResizeState] = useState(null) // { chapterId, mode } | null
  const [draftChapterWidth, setDraftChapterWidth] = useState(0)
  const [draftXOffset, setDraftXOffset] = useState(0)
  const resizeRef = useRef(null)
  const resizingChapterId = resizeState?.chapterId ?? null

  // Phase 4.3d — right-click "Insert chapter" context menu on a column
  // divider handle. `{ x, y, index }` (screen coords + the chapters[]
  // insertion index) while open; null when closed.
  const [dividerMenu, setDividerMenu] = useState(null)
  const dividerMenuRef = useRef(null)

  // Phase 4.3 — row-height drag (§5). `rowResizeRef` holds the live drag
  // data (mirrors `resizeRef`); `rowResizingId` is the reactive flag for
  // the active row so the cursor / highlight can render.
  const [rowResizingId, setRowResizingId] = useState(null)
  const rowResizeRef = useRef(null)

  // Effective x-offset for the edges computation. When the user is
  // dragging the first-chapter's LEFT edge, use the live draft value;
  // otherwise fall through to whatever the store currently has. Derived
  // during render — no sync effect needed, which keeps us clear of the
  // react-hooks/set-state-in-effect rule.
  const effectiveXOffset = resizeState?.mode === 'left-first'
    ? draftXOffset
    : storedChapterXOffset

  // Phase 4.3d — chapter-creation affordances on the column divider
  // handles. A handle sits on chapter `i`'s right edge (the divider
  // between chapter i and i+1), so inserting "at that divider" means
  // splicing a new empty chapter in at index `i + 1`. Mode-agnostic:
  // `insertChapterAt` shifts downstream nodes so existing membership is
  // preserved, and a new empty chapter has no story-order impact.
  const insertChapterAtDivider = useCallback((dividerIndex) => {
    insertChapterAt(dividerIndex)
  }, [insertChapterAt])

  const closeDividerMenu = useCallback(() => setDividerMenu(null), [])

  // Close the divider context menu on outside-click / Escape.
  useEffect(() => {
    if (!dividerMenu) return undefined
    const handleOutside = (e) => {
      if (dividerMenuRef.current && !dividerMenuRef.current.contains(e.target)) closeDividerMenu()
    }
    const handleKey = (e) => { if (e.key === 'Escape') closeDividerMenu() }
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('keydown', handleKey)
    }
  }, [dividerMenu, closeDividerMenu])

  const startResize = useCallback((ev, chapter, mode) => {
    // Stop the event from reaching React Flow's pan/zoom handlers and
    // the chapter cell's double-click handler underneath.
    ev.stopPropagation()
    ev.preventDefault()
    // Compute the chapter's flow-space LEFT edge at drag start so the
    // mousemove handler can identify `border_x` — the x threshold that
    // separates nodes that should slide along with the drag from
    // nodes that should stay put. We walk the chapters list rather
    // than reading from the `edges` memo (not in scope here) —
    // O(chapters), cheap. Phase 1.12c v0.1.12.61.
    let edgeLeft = storedChapterXOffset
    for (const c of chapters) {
      if (c.id === chapter.id) break
      edgeLeft += (c.width || 0)
    }
    // Capture the IDs + initial x of every node that sits on the
    // "moving side" of the chapter border. The set is captured ONCE
    // at drag start; subsequent frames update positions via dx from
    // initial so the live-shift doesn't accumulate floating-point
    // drift frame-over-frame. Rule uses node CENTER x with strict
    // inequality to match `getChapterIdForNode`'s "ties resolve to
    // the left chapter" convention:
    //   - right mode  → centerX >  (initialEdgeLeft + initialWidth)
    //   - left-first  → centerX <  initialXOffset
    const liveNodes = useProjectStore.getState().nodes || []
    const affectedNodes = []
    // Phase 4.3 — in multi-row mode the resized chapter sits in ONE row,
    // so resizing its width must slide only the nodes that are in the SAME
    // ROW and to the right of the chapter's right edge (the chapters after
    // it in that row + their nodes). The single-row x-only test would wrongly
    // sweep nodes in every other row. We resolve the chapter's cell from a
    // fresh layout (drag-start widths) and gate the affected set on the row
    // band (center-y) as well as the border (center-x).
    const _st = useProjectStore.getState().story
    const mrRows = (_st?.canvas_layout_mode === 'multi' && Array.isArray(_st?.chapter_rows) && _st.chapter_rows.length)
      ? _st.chapter_rows
      : null
    if (mrRows && mode === 'right') {
      const geom = rowGeometryParams(storedChapterXOffset, multirowHeaderRowsForStory(_st))
      const cell = buildChapterLayout(chapters, mrRows, geom.xOffset, geom.rowsTopY, geom.rowGap)
        .cells.find((c) => c.id === chapter.id)
      if (cell) {
        const borderX = cell.left + cell.width
        const bandTop = cell.rowTop
        const bandBottom = cell.rowTop + cell.rowHeight
        for (const n of liveNodes) {
          const w = n.measured?.width ?? getMeasuredWidth(n.id) ?? n.data?.width ?? n.width ?? 0
          const h = n.measured?.height ?? getMeasuredHeight(n.id) ?? n.data?.height ?? n.height ?? 0
          const centerX = (n.position?.x || 0) + w / 2
          const centerY = (n.position?.y || 0) + h / 2
          if (centerX > borderX && centerY >= bandTop && centerY <= bandBottom) {
            affectedNodes.push({ id: n.id, initialX: n.position?.x || 0 })
          }
        }
      }
    } else if (mode === 'right') {
      const borderX = edgeLeft + (chapter.width || 0)
      for (const n of liveNodes) {
        const w = n.measured?.width ?? getMeasuredWidth(n.id) ?? n.data?.width ?? n.width ?? 0
        const centerX = (n.position?.x || 0) + w / 2
        if (centerX > borderX) {
          affectedNodes.push({ id: n.id, initialX: n.position?.x || 0 })
        }
      }
    } else if (mode === 'left-first') {
      const borderX = storedChapterXOffset
      for (const n of liveNodes) {
        const w = n.measured?.width ?? getMeasuredWidth(n.id) ?? n.data?.width ?? n.width ?? 0
        const centerX = (n.position?.x || 0) + w / 2
        if (centerX < borderX) {
          affectedNodes.push({ id: n.id, initialX: n.position?.x || 0 })
        }
      }
    }
    resizeRef.current = {
      chapterId: chapter.id,
      mode, // 'right' | 'left-first'
      initialWidth: chapter.width || 0,
      initialXOffset: storedChapterXOffset,
      initialEdgeLeft: edgeLeft,
      startClientX: ev.clientX,
      currentWidth: chapter.width || 0,
      currentXOffset: storedChapterXOffset,
      affectedNodes,       // captured once at drag start
      didSnapshot: false,  // lazy snapshot on first mousemove
    }
    setResizeState({ chapterId: chapter.id, mode })
    setDraftChapterWidth(chapter.width || 0)
    setDraftXOffset(storedChapterXOffset)
    // Phase 4.1g follow-up — chapter-border drags write the store per
    // mousemove frame (width + slid node positions); the gesture gate
    // lets `useStoryOrder` serve its cached result mid-drag (one
    // ordering recompute at release instead of one per frame).
    useUiStore.getState().setCanvasGestureActive(true)
  }, [storedChapterXOffset, chapters])

  // While a chapter is being resized, listen on the document for mousemove
  // (updates the draft state, snapped to the grid) and mouseup (commits
  // the final values via the appropriate store action). The ref-based
  // design avoids re-attaching listeners on every mousemove.
  useEffect(() => {
    if (!resizingChapterId) return undefined
    const handleMove = (ev) => {
      const s = resizeRef.current
      if (!s) return
      const deltaScreenPx = ev.clientX - s.startClientX
      // Convert the screen-space drag delta into flow-space pixels. Chapter
      // widths are stored in flow coordinates, so we divide by the current
      // viewport zoom to get the "real" delta in the chapter's coordinate
      // system regardless of how far the user has zoomed the canvas.
      const deltaFlowPx = deltaScreenPx / viewport.zoom
      // Snap the DELTA (not the final value) to the grid so the chapter
      // stays grid-aligned from its starting position — this preserves
      // the alignment if the starting value was already off-grid from a
      // legacy project or an earlier drag at a different zoom.
      const snappedDelta = Math.round(deltaFlowPx / GRID_SNAP_PX) * GRID_SNAP_PX

      // Phase 1.12c v0.1.12.61 — live node reflow.
      //
      // Snapshot lazily on the first mousemove so a click without any
      // movement doesn't create a phantom undo entry. Every subsequent
      // frame writes live via `setChapterResizeLive` WITHOUT capturing
      // another snapshot, so the whole drag collapses to ONE undo step
      // restoring the pre-drag chapter width + node positions.
      //
      // Shift-held opt-out: if Shift is pressed during a frame, the
      // frame's `nodeUpdates` list is empty and the chapter resizes
      // without sliding nodes. The user can press/release Shift mid-
      // drag and the reflow follows immediately — pressing Shift
      // snaps nodes back to their initial x, releasing it slides them
      // to `initial + delta` again. Gives the user a live "toggle"
      // between the two modes within one drag.
      if (!s.didSnapshot) {
        useProjectStore.getState()._snapshot()
        s.didSnapshot = true
      }
      const shiftHeld = !!ev.shiftKey

      if (s.mode === 'right') {
        const newWidth = Math.max(MIN_CHAPTER_WIDTH_PX, s.initialWidth + snappedDelta)
        s.currentWidth = newWidth
        setDraftChapterWidth(newWidth)
        // Effective delta after the min-width clamp — nodes shift by
        // the ACTUAL width change, not the raw drag delta.
        const effectiveDelta = newWidth - s.initialWidth
        const nodeUpdates = shiftHeld
          ? []
          : s.affectedNodes.map((a) => ({ id: a.id, x: a.initialX + effectiveDelta }))
        setChapterResizeLive(s.chapterId, { width: newWidth, nodeUpdates })
      } else if (s.mode === 'left-first') {
        // Left-edge drag on the first chapter: offset changes by the
        // snapped delta, width changes by the opposite amount so the
        // chapter's right edge stays pinned. Width still clamps to the
        // 120 px floor — if the drag would shrink past that, the offset
        // stops changing too (both fields stop moving as a pair).
        const rawWidth = s.initialWidth - snappedDelta
        const clampedWidth = Math.max(MIN_CHAPTER_WIDTH_PX, rawWidth)
        const widthDelta = s.initialWidth - clampedWidth
        const newXOffset = s.initialXOffset + widthDelta
        s.currentWidth = clampedWidth
        s.currentXOffset = newXOffset
        setDraftChapterWidth(clampedWidth)
        setDraftXOffset(newXOffset)
        const offsetDelta = newXOffset - s.initialXOffset
        const nodeUpdates = shiftHeld
          ? []
          : s.affectedNodes.map((a) => ({ id: a.id, x: a.initialX + offsetDelta }))
        setChapterResizeLive(s.chapterId, {
          width: clampedWidth,
          xOffset: newXOffset,
          nodeUpdates,
        })
      }
    }
    const handleUp = () => {
      // Live updates already wrote the final state; mouseup just
      // releases the drag ref and clears the resize highlight. The
      // gesture-gate clear is what triggers the single end-of-drag
      // story-order recompute (the flag flip re-renders consumers).
      resizeRef.current = null
      setResizeState(null)
      useUiStore.getState().setCanvasGestureActive(false)
    }
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
    return () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
      // Safety: never leave the gate stuck on if the overlay unmounts
      // mid-drag — a stuck gate would silently freeze ordering updates.
      useUiStore.getState().setCanvasGestureActive(false)
    }
  }, [resizingChapterId, viewport.zoom, setChapterResizeLive])

  // Phase 4.3 — row-height drag (§5). Mirrors the chapter-width drag on
  // the y-axis: dragging a row's bottom boundary DOWN grows the row and
  // pushes every row below (and its nodes) down; dragging UP shrinks it,
  // bounded by the row's own content (so its nodes never spill out the
  // bottom). `band` carries the row's flow-space top + height.
  const startRowResize = useCallback((ev, band) => {
    ev.stopPropagation()
    ev.preventDefault()
    const liveNodes = useProjectStore.getState().nodes || []
    const boundaryY = band.top + band.height
    const affected = []
    let maxOwnBottom = 0
    for (const n of liveNodes) {
      const h = n.measured?.height ?? getMeasuredHeight(n.id) ?? n.data?.height ?? n.height ?? 0
      const top = n.position?.y || 0
      const cy = top + h / 2
      if (cy > boundaryY) {
        affected.push({ id: n.id, initialY: top })  // a row BELOW → slides with the boundary
      } else if (cy >= band.top) {
        maxOwnBottom = Math.max(maxOwnBottom, top + h - band.top)  // this row's content extent
      }
    }
    rowResizeRef.current = {
      rowId: band.rowId,
      initialHeight: band.height,
      startClientY: ev.clientY,
      affected,
      // Content-fit floor — must match the auto-refit's content-fit
      // (MIN_ROW_HEIGHT + CONTENT_PAD=40) so dragging to the floor lands
      // exactly where auto-fit would sit, clearing the user-set flag.
      minHeight: Math.max(MIN_ROW_HEIGHT, maxOwnBottom + 40),
      didSnapshot: false,
    }
    setRowResizingId(band.rowId)
    useUiStore.getState().setCanvasGestureActive(true)
  }, [])

  useEffect(() => {
    if (!rowResizingId) return undefined
    const handleMove = (ev) => {
      const s = rowResizeRef.current
      if (!s) return
      const deltaFlowY = (ev.clientY - s.startClientY) / viewport.zoom
      const snapped = Math.round(deltaFlowY / GRID_SNAP_PX) * GRID_SNAP_PX
      const newHeight = Math.max(s.minHeight, s.initialHeight + snapped)
      if (!s.didSnapshot) {
        useProjectStore.getState()._snapshot()
        s.didSnapshot = true
      }
      const effectiveDelta = newHeight - s.initialHeight
      const nodeUpdates = s.affected.map((a) => ({ id: a.id, y: a.initialY + effectiveDelta }))
      // Above the content-fit floor => user-set (sticky); exactly at the floor
      // (dragged all the way down) => clear user-set, reverting to auto-fit.
      setRowHeightLive(s.rowId, { height: newHeight, nodeUpdates, userSet: newHeight > s.minHeight })
    }
    const handleUp = () => {
      rowResizeRef.current = null
      setRowResizingId(null)
      useUiStore.getState().setCanvasGestureActive(false)
    }
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
    return () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
      useUiStore.getState().setCanvasGestureActive(false)
    }
  }, [rowResizingId, viewport.zoom, setRowHeightLive])

  const openEditor = useCallback((chapter) => {
    setEditingChapterId(chapter.id)
    setDraftTitle(chapter.title || '')
    setDraftColour(chapter.colour || DEFAULT_CHAPTER_COLOUR)
  }, [])

  const cancelEditor = useCallback(() => {
    setChapterColourPickerOpen(false)
    setEditingChapterId(null)
  }, [])

  const commitEditor = useCallback(() => {
    if (!editingChapterId) return
    // Normalize: "" for title means "no custom title", null for colour
    // means "default tint" (store the null instead of the default hex so
    // the UI can later tell apart "user picked zinc-500" from "unset").
    const finalTitle = draftTitle
    const finalColour = draftColour && draftColour.toLowerCase() !== DEFAULT_CHAPTER_COLOUR.toLowerCase()
      ? draftColour
      : null
    setChapterTitleAndColour(editingChapterId, finalTitle, finalColour)
    setChapterColourPickerOpen(false)
    setEditingChapterId(null)
  }, [editingChapterId, draftTitle, draftColour, setChapterTitleAndColour])

  // Focus + select the title input whenever a new editor opens. Runs on
  // editingChapterId change so switching between cells re-focuses the
  // new one immediately.
  useEffect(() => {
    if (editingChapterId && titleInputRef.current) {
      titleInputRef.current.focus()
      titleInputRef.current.select()
    }
  }, [editingChapterId])

  // Click outside the editing cell = commit. Matches existing inline-edit
  // pattern elsewhere in the app. Clicks inside the editing cell (the
  // colour chip or the title input itself) do NOT commit; only clicks
  // whose target is outside the cell ref do. The EntityColorPicker
  // is portaled to document.body so we also exclude it by the
  // data-nested-modal attribute it sets on its popover div.
  useEffect(() => {
    if (!editingChapterId) return undefined
    function handler(e) {
      if (editingCellRef.current && editingCellRef.current.contains(e.target)) return
      if (e.target?.closest?.('[data-nested-modal="true"]')) return
      commitEditor()
    }
    document.addEventListener('mousedown', handler, { capture: true })
    return () => document.removeEventListener('mousedown', handler, { capture: true })
  }, [editingChapterId, commitEditor])

  const handleTitleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitEditor()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEditor()
    }
  }, [commitEditor, cancelEditor])

  const handleChipResetContextMenu = useCallback((e) => {
    // Block the browser's native context menu AND stop the event from
    // bubbling up to React Flow's onContextMenu, which would otherwise
    // open the canvas's "add node here" context menu underneath.
    e.preventDefault()
    e.stopPropagation()
    setDraftColour(DEFAULT_CHAPTER_COLOUR)
  }, [])

  // Delete the chapter currently being edited. Called by the in-cell delete
  // button. Clears the editor state first so the overlay doesn't try to
  // re-read stale `editingChapterId` after the chapter is gone. The store's
  // `deleteChapter` action already handles pruning any acts that referenced
  // the deleted chapter, and snapshots for undo.
  const handleDeleteChapter = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!editingChapterId) return
    const id = editingChapterId
    setEditingChapterId(null)
    deleteChapter(id)
  }, [editingChapterId, deleteChapter])

  // ── Act editor handlers (mirror the chapter versions above) ────────────────

  const openActEditor = useCallback((act) => {
    setEditingActId(act.id)
    // Default to the act's first segment; the multi-row double-click handler
    // overrides this with the actual segment key right after this call.
    setEditingActSegKey(null)
    setDraftActTitle(act.title || '')
    setDraftActColour(act.colour || DEFAULT_CHAPTER_COLOUR)
  }, [])

  const cancelActEditor = useCallback(() => {
    setActColourPickerOpen(false)
    setEditingActId(null)
    setEditingActSegKey(null)
  }, [])

  const commitActEditor = useCallback(() => {
    if (!editingActId) return
    const finalTitle = draftActTitle
    const finalColour = draftActColour && draftActColour.toLowerCase() !== DEFAULT_CHAPTER_COLOUR.toLowerCase()
      ? draftActColour
      : null
    setActTitleAndColour(editingActId, finalTitle, finalColour)
    setActColourPickerOpen(false)
    setEditingActId(null)
    setEditingActSegKey(null)
  }, [editingActId, draftActTitle, draftActColour, setActTitleAndColour])

  // Focus + select the act title input whenever a new act editor opens.
  useEffect(() => {
    if (editingActId && actTitleInputRef.current) {
      actTitleInputRef.current.focus()
      actTitleInputRef.current.select()
    }
  }, [editingActId])

  // Click outside the editing act cell = commit. Independent from the
  // chapter editor's click-outside handler — the two handlers ref different
  // cells and mutate different state, so they don't interfere with each
  // other even if both could be simultaneously listening (in practice
  // only one editor is active at a time because opening a new one
  // triggers the other's click-outside handler and closes it).
  // The EntityColorPicker is portaled to document.body so exclude it via
  // data-nested-modal to prevent the picker from immediately committing.
  useEffect(() => {
    if (!editingActId) return undefined
    function handler(e) {
      if (editingActCellRef.current && editingActCellRef.current.contains(e.target)) return
      if (e.target?.closest?.('[data-nested-modal="true"]')) return
      commitActEditor()
    }
    document.addEventListener('mousedown', handler, { capture: true })
    return () => document.removeEventListener('mousedown', handler, { capture: true })
  }, [editingActId, commitActEditor])

  const handleActTitleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitActEditor()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelActEditor()
    }
  }, [commitActEditor, cancelActEditor])

  const handleActChipResetContextMenu = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    setDraftActColour(DEFAULT_CHAPTER_COLOUR)
  }, [])

  const handleDeleteAct = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!editingActId) return
    const id = editingActId
    setEditingActId(null)
    deleteAct(id)
  }, [editingActId, deleteAct])

  // Compute each chapter's flow-space left edge and width up front so both
  // layers (bands + header cells) share the same geometry. Also build a
  // lookup so the Act row can translate chapter_ids → flow-space ranges.
  // Live resize: when `resizingChapterId` matches a chapter, its width is
  // overridden with `draftChapterWidth` so the tint band, header cell,
  // divider handle, and act ranges all reposition in lockstep as the
  // user drags — no visual lag between store commit and display. The
  // starting cumulative uses `effectiveXOffset` (which picks the live
  // drag value during a first-chapter-left-edge drag, or the stored
  // `story.chapter_x_offset` otherwise).
  //
  // Memoised so hook deps downstream (the act resize useCallback /
  // useEffect that reads `edges`) get a stable reference across renders
  // and don't re-attach document listeners on every mousemove.
  const { edges, edgeById } = useMemo(() => {
    const _edges = []
    const _edgeById = new Map()
    let cumulative = effectiveXOffset
    for (const c of chapters) {
      const effectiveWidth = resizingChapterId === c.id
        ? draftChapterWidth
        : (c.width || 0)
      const edge = { id: c.id, left: cumulative, width: effectiveWidth }
      _edges.push(edge)
      _edgeById.set(c.id, edge)
      cumulative += effectiveWidth
    }
    return { edges: _edges, edgeById: _edgeById }
  }, [chapters, resizingChapterId, draftChapterWidth, effectiveXOffset])

  // ── Act edge drag to resize the act's chapter range ───────────────────────
  // Defined HERE (below `edges`) so `startActResize` and its document
  // listener effect can close over the memoised `edges` without tripping
  // TDZ errors or react-hooks/exhaustive-deps.
  //
  // Shared-boundary mode: when the user grabs an act handle that sits at
  // a boundary touching ANOTHER act (the right edge of Act 1 touching the
  // left edge of Act 2, or vice versa), both acts move together as the
  // user drags so no gap or overlap can ever form between them. The
  // single mouseup commits via `setAdjacentActBoundary` which atomically
  // updates both acts' `chapter_ids` in one snapshot.

  const startActResize = useCallback((ev, act, edge) => {
    ev.stopPropagation()
    ev.preventDefault()
    const initialLeftIdx = chapters.findIndex((c) => c.id === act.chapter_ids[0])
    const initialRightIdx = chapters.findIndex((c) => c.id === act.chapter_ids[act.chapter_ids.length - 1])
    if (initialLeftIdx === -1 || initialRightIdx === -1) return

    // Shared-boundary detection: is there another act whose chapter range
    // sits flush against the edge being grabbed?
    //   - Right edge of `act` is shared if some OTHER act's leftmost
    //     chapter is at index `initialRightIdx + 1`.
    //   - Left edge of `act` is shared if some OTHER act's rightmost
    //     chapter is at index `initialLeftIdx - 1`.
    let partnerAct = null
    let leftActOfPair = null
    let rightActOfPair = null
    if (edge === 'right') {
      partnerAct = acts.find((other) => {
        if (other.id === act.id) return false
        const otherLeftIdx = chapters.findIndex((c) => c.id === other.chapter_ids[0])
        return otherLeftIdx === initialRightIdx + 1
      })
      if (partnerAct) {
        leftActOfPair = act
        rightActOfPair = partnerAct
      }
    } else if (edge === 'left') {
      partnerAct = acts.find((other) => {
        if (other.id === act.id) return false
        const otherRightIdx = chapters.findIndex((c) => c.id === other.chapter_ids[other.chapter_ids.length - 1])
        return otherRightIdx === initialLeftIdx - 1
      })
      if (partnerAct) {
        leftActOfPair = partnerAct
        rightActOfPair = act
      }
    }

    // Single-row drag uses the 1-D flow-x of the grabbed edge + mouse delta to
    // pick the hovered chapter. Multi-row drag instead reads the cursor's
    // ABSOLUTE 2-D flow position (so it can cross rows), which needs the canvas
    // element's screen rect — captured once here at grab time. `multiRowMapRef`
    // holds the live layout (read fresh; it's declared after this callback so
    // it can't be a deps entry).
    const multiRow = !!multiRowMapRef.current?.multiRow
    const canvasRect = multiRow ? (document.querySelector('.react-flow')?.getBoundingClientRect() || null) : null
    const startFlowX = multiRow ? 0 : (edge === 'left'
      ? edges[initialLeftIdx].left
      : edges[initialRightIdx].left + edges[initialRightIdx].width)

    if (partnerAct) {
      // Shared mode: track both acts' initial extents. The pivot index
      // (the index in chapters[] of the LAST chapter that belongs to the
      // left act of the pair) starts at the left act's current right.
      const leftActInitialLeftIdx = chapters.findIndex((c) => c.id === leftActOfPair.chapter_ids[0])
      const rightActInitialRightIdx = chapters.findIndex((c) => c.id === rightActOfPair.chapter_ids[rightActOfPair.chapter_ids.length - 1])
      const initialPivotIdx = chapters.findIndex((c) => c.id === leftActOfPair.chapter_ids[leftActOfPair.chapter_ids.length - 1])
      actResizeRef.current = {
        mode: 'shared',
        multiRow,
        canvasRect,
        startClientX: ev.clientX,
        startFlowX,
        currentPivotIdx: initialPivotIdx,
        leftActId: leftActOfPair.id,
        rightActId: rightActOfPair.id,
        leftActInitialLeftIdx,
        rightActInitialRightIdx,
      }
      // Stash the shared-mode static fields on `actResizeState` so the
      // render path (`actSharedDraft`) can read them without touching
      // the ref. Pivot index goes into `draftPivotIdx` and updates on
      // every mousemove.
      setActResizeState({
        mode: 'shared',
        actId: act.id,
        edge,
        leftActId: leftActOfPair.id,
        rightActId: rightActOfPair.id,
        leftActInitialLeftIdx,
        rightActInitialRightIdx,
      })
      setDraftPivotIdx(initialPivotIdx)
      return
    }

    // Solo mode: the existing single-act resize behaviour.
    actResizeRef.current = {
      mode: 'solo',
      multiRow,
      canvasRect,
      actId: act.id,
      edge,
      initialLeftIdx,
      initialRightIdx,
      startClientX: ev.clientX,
      startFlowX,
      currentLeftIdx: initialLeftIdx,
      currentRightIdx: initialRightIdx,
    }
    setActResizeState({ mode: 'solo', actId: act.id, edge })
    setDraftActLeftIdx(initialLeftIdx)
    setDraftActRightIdx(initialRightIdx)
  }, [chapters, edges, acts])

  useEffect(() => {
    if (!actResizeState) return undefined
    const handleMove = (ev) => {
      const s = actResizeRef.current
      if (!s) return
      // Which chapter the cursor is over (global chapters[] index).
      let hoveredIdx = 0
      if (s.multiRow) {
        // Multi-row: map the cursor's ABSOLUTE 2-D flow position to a chapter
        // (row by Y, column by X) so the boundary follows the cursor across
        // rows. Needs the canvas rect (captured at grab time) + the live
        // viewport + layout.
        const rect = s.canvasRect
        const map = multiRowMapRef.current
        if (rect && map && map.rowLayout) {
          const cursorFlowX = (ev.clientX - rect.left - viewport.x) / viewport.zoom
          const cursorFlowY = (ev.clientY - rect.top - viewport.y) / viewport.zoom
          hoveredIdx = chapterIndexAtFlowPoint(cursorFlowX, cursorFlowY, map.rowLayout, map.mrHeaderRows, map.chapters)
        }
      } else {
        // Single-row: 1-D walk of the chapter columns by the cursor's flow x
        // (grabbed-edge flow-x + mouse delta). Clamp to first / last chapter.
        const cursorFlowX = s.startFlowX + (ev.clientX - s.startClientX) / viewport.zoom
        if (edges.length > 0) {
          if (cursorFlowX < edges[0].left) {
            hoveredIdx = 0
          } else {
            hoveredIdx = edges.length - 1
            for (let i = 0; i < edges.length; i++) {
              if (cursorFlowX < edges[i].left + edges[i].width) {
                hoveredIdx = i
                break
              }
            }
          }
        }
      }

      if (s.mode === 'shared') {
        // Shared-boundary drag: the pivot index is the LAST chapter
        // belonging to the left act of the pair. Clamp so both acts
        // keep at least one chapter:
        //   - pivot ≥ leftActInitialLeftIdx (left act keeps ≥ 1)
        //   - pivot ≤ rightActInitialRightIdx − 1 (right act keeps ≥ 1)
        // For shared mode the cursor position IS the pivot directly —
        // the act being grabbed determines which chapter the user wants
        // the boundary to land on. (The earlier left-edge-vs-right-edge
        // distinction was wrong: in shared mode both acts' edges are
        // touching the same boundary, and the user's mental model is
        // "I'm dragging the line between them to here".)
        const clampedPivot = Math.max(
          actResizeState.leftActInitialLeftIdx,
          Math.min(hoveredIdx, actResizeState.rightActInitialRightIdx - 1),
        )
        s.currentPivotIdx = clampedPivot
        setDraftPivotIdx(clampedPivot)
        return
      }

      if (s.edge === 'left') {
        // Solo left-edge drag: new left index is the hovered chapter,
        // clamped so it can't go past the act's right edge.
        const newLeft = Math.min(hoveredIdx, s.initialRightIdx)
        s.currentLeftIdx = newLeft
        setDraftActLeftIdx(newLeft)
      } else if (s.edge === 'right') {
        const newRight = Math.max(hoveredIdx, s.initialLeftIdx)
        s.currentRightIdx = newRight
        setDraftActRightIdx(newRight)
      }
    }
    const handleUp = () => {
      const s = actResizeRef.current
      actResizeRef.current = null
      if (s) {
        if (s.mode === 'shared') {
          const pivotChapter = chapters[s.currentPivotIdx]
          if (pivotChapter) {
            setAdjacentActBoundary(s.leftActId, s.rightActId, pivotChapter.id)
          }
        } else {
          const leftChapter = chapters[s.currentLeftIdx]
          const rightChapter = chapters[s.currentRightIdx]
          if (leftChapter && rightChapter) {
            setActRange(s.actId, leftChapter.id, rightChapter.id)
          }
        }
      }
      setActResizeState(null)
    }
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
    return () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
    }
  }, [actResizeState, viewport.zoom, viewport.x, viewport.y, chapters, edges, setActRange, setAdjacentActBoundary])

  // Compute each act's flow-space range by finding its leftmost and
  // rightmost chapter edges. Acts whose chapter_ids have all been deleted
  // are silently skipped (this is a display layer — the store's
  // _pruneActContiguity keeps them clean, but a race during a chapter
  // delete could momentarily leave a dangling chapter_id).
  //
  // Live preview: while an act edge is being dragged, override the
  // affected act's `chapter_ids` with the draft range so every act-cell
  // renderer picks up the new left/right during the drag. In shared-
  // boundary mode (two adjacent acts share a single drag handle), BOTH
  // acts get overridden — the left act of the pair via the existing
  // draft indices, and the right act via its own pair-derived range
  // looked up from `actResizeRef.current`.
  //
  // The `index` field on each entry is the act's 1-indexed position in
  // `acts[]`, used by the cell renderer to display the auto-numbered
  // "Act N" label (mirrors the chapter cell's "Chapter N" pattern).
  const actSharedDraft = actResizeState?.mode === 'shared'
    ? {
      leftActId: actResizeState.leftActId,
      rightActId: actResizeState.rightActId,
      pivotIdx: draftPivotIdx,
      leftActLeftIdx: actResizeState.leftActInitialLeftIdx,
      rightActRightIdx: actResizeState.rightActInitialRightIdx,
    }
    : null
  const actRanges = []
  acts.forEach((act, actIdx) => {
    let actEdges
    if (actSharedDraft && act.id === actSharedDraft.leftActId) {
      actEdges = []
      for (let i = actSharedDraft.leftActLeftIdx; i <= actSharedDraft.pivotIdx; i++) {
        const edge = edges[i]
        if (edge) actEdges.push(edge)
      }
    } else if (actSharedDraft && act.id === actSharedDraft.rightActId) {
      actEdges = []
      for (let i = actSharedDraft.pivotIdx + 1; i <= actSharedDraft.rightActRightIdx; i++) {
        const edge = edges[i]
        if (edge) actEdges.push(edge)
      }
    } else if (actResizeState?.actId === act.id) {
      // Solo-mode drag: only the grabbed act gets overridden.
      actEdges = []
      for (let i = draftActLeftIdx; i <= draftActRightIdx; i++) {
        const edge = edges[i]
        if (edge) actEdges.push(edge)
      }
    } else {
      actEdges = act.chapter_ids
        .map((id) => edgeById.get(id))
        .filter(Boolean)
    }
    if (actEdges.length === 0) return
    const left = actEdges[0].left
    const right = actEdges[actEdges.length - 1].left + actEdges[actEdges.length - 1].width
    actRanges.push({
      id: act.id,
      index: actIdx + 1,
      title: act.title,
      colour: act.colour,
      left,
      width: right - left,
    })
  })

  // Act row is only shown when NOT collapsed AND there is at least one
  // chapter to anchor it to. Total header height = 1 row or 2 rows.
  const showActsRow = !actsCollapsed && chapters.length > 0
  const totalHeaderHeight = showActsRow ? ROW_HEIGHT_PX * 2 : ROW_HEIGHT_PX
  const chapterRowTop = showActsRow ? ROW_HEIGHT_PX : 0

  // ── Phase 4.3 multi-row layout (gated; null in single-row mode) ──
  // `multiRow` true ⇒ render the stacked-row branches below; false ⇒ the
  // existing single-row path runs untouched (byte-identical). `rowLayout`
  // is the per-chapter cell list (column-x within row + the row's content
  // band top/height). We pass `rowsTopY = totalHeaderHeight` so each
  // cell's `rowTop` is its content-band top (header sits at
  // `rowTop - totalHeaderHeight`), and `rowGap = totalHeaderHeight +
  // ROW_VGAP` so each subsequent row leaves room for its own header plus
  // the visible gap. Live width-drag preview is folded in by overriding
  // the resizing chapter's width, mirroring the `edges` memo.
  const multiRow = layoutMode === 'multi' && Array.isArray(chapterRows) && chapterRows.length > 0
  const rowLayout = useMemo(() => {
    if (!multiRow) return null
    const chaptersForLayout = resizingChapterId
      ? chapters.map((c) => (c.id === resizingChapterId ? { ...c, width: draftChapterWidth } : c))
      : chapters
    // Shared geometry params (rowLayout.rowGeometryParams) so the rendered
    // bands/headers line up exactly with the chapter-as-group node
    // repositioning in projectStore.setCanvasLayoutMode.
    const geom = rowGeometryParams(effectiveXOffset, multirowHeaderRows('multi', multirowActsExpanded))
    return buildChapterLayout(chaptersForLayout, chapterRows, geom.xOffset, geom.rowsTopY, geom.rowGap)
  }, [multiRow, chapters, chapterRows, effectiveXOffset, resizingChapterId, draftChapterWidth, multirowActsExpanded])

  // Phase 4.3 — per-row act segments for the EXPANDED multi-row acts band.
  // An act spans a contiguous run of chapters; because the row-major
  // flattening of chapter_rows equals chapters[] order, an act's chapters
  // stay contiguous WITHIN each row they touch. So per (act, row) we take the
  // min-left / max-right of the act's cells in that row → one clean band
  // segment positioned in that row's column space (`rowLayout.cells`). An act
  // that straddles a row wrap renders as one segment per row it covers.
  // Gated to expanded multi-row (null otherwise → the act band isn't drawn).
  const actSegmentsByRow = useMemo(() => {
    if (!multiRow || !multirowActsExpanded || !rowLayout) return null
    const cellById = new Map(rowLayout.cells.map((c) => [c.id, c]))
    const segs = []
    acts.forEach((act, actIdx) => {
      // Live preview during an act-edge drag: override the dragged act(s)'
      // chapter range with the draft so the band resizes as you drag (mirrors
      // the single-row `actRanges` override). Shared mode moves the pivot
      // between the pair; solo mode moves one act's left/right.
      let effChapterIds = act.chapter_ids || []
      if (actResizeState) {
        if (actResizeState.mode === 'solo' && actResizeState.actId === act.id) {
          effChapterIds = chapters.slice(draftActLeftIdx, draftActRightIdx + 1).map((c) => c.id)
        } else if (actResizeState.mode === 'shared' && act.id === actResizeState.leftActId) {
          effChapterIds = chapters.slice(actResizeState.leftActInitialLeftIdx, draftPivotIdx + 1).map((c) => c.id)
        } else if (actResizeState.mode === 'shared' && act.id === actResizeState.rightActId) {
          effChapterIds = chapters.slice(draftPivotIdx + 1, actResizeState.rightActInitialRightIdx + 1).map((c) => c.id)
        }
      }
      const byRow = new Map()
      for (const cid of effChapterIds) {
        const cell = cellById.get(cid)
        if (!cell) continue
        if (!byRow.has(cell.rowIndex)) byRow.set(cell.rowIndex, [])
        byRow.get(cell.rowIndex).push(cell)
      }
      // Build this act's segments (one per row it touches), then mark the
      // first (lowest row) and last (highest row): the first hosts the edit
      // controls + the LEFT resize handle, the last hosts the RIGHT handle.
      const actSegs = []
      for (const [rowIndex, cells] of byRow) {
        let left = Infinity, right = -Infinity, rowTop = 0
        for (const c of cells) {
          left = Math.min(left, c.left)
          right = Math.max(right, c.left + c.width)
          rowTop = c.rowTop
        }
        actSegs.push({
          key: `${act.id}-r${rowIndex}`,
          id: act.id,
          index: actIdx + 1,
          title: act.title,
          colour: act.colour,
          rowIndex,
          rowTop,
          left,
          width: right - left,
        })
      }
      actSegs.forEach((seg, i) => {
        seg.isFirstSeg = i === 0
        seg.isLastSeg = i === actSegs.length - 1
        segs.push(seg)
      })
    })
    return segs
  }, [multiRow, multirowActsExpanded, rowLayout, acts, chapters, actResizeState, draftActLeftIdx, draftActRightIdx, draftPivotIdx])

  // Multi-row header row count: 2 when the per-row acts band is expanded
  // (act row sits above the chapter row), else 1 (chapter row only). Drives
  // each row's header-strip screen height and where the act band is placed
  // (one row above the chapter header). `ROW_HEIGHT_PX === ROW_HEADER_RESERVED`,
  // so `mrHeaderRows * ROW_HEIGHT_PX` is the full reserve a row owns.
  const mrHeaderRows = multiRow && multirowActsExpanded ? 2 : 1

  // Keep the act-resize cursor-mapping snapshot fresh (read by startActResize
  // + the drag listener, which run after this body). Cheap object write.
  multiRowMapRef.current = { multiRow, rowLayout, mrHeaderRows, chapters }

  // ── Viewport row-cull predicate (shared by the tint layer + the header
  // layer) ── Both layers re-create their per-row JSX on every viewport
  // frame (the component subscribes to `useViewport`), so rendering all
  // rows makes per-frame work grow with project size — the multiplicative
  // cost that only shows up at scale. `bandVisible[i]` marks rows whose
  // on-screen footprint (header reserve + content band + a small overscan)
  // intersects the visible canvas; each per-row map skips off-screen rows,
  // bounding cost to O(rows on screen) regardless of total row count. Keyed
  // on the VERTICAL viewport only (horizontal pan never changes which rows
  // are visible). Empty in single-row mode. The cross-row act-resize math
  // and the sticky header read the full `rowLayout`, so both are unaffected.
  const bandVisible = useMemo(() => {
    if (!multiRow || !rowLayout) return []
    const zoom = viewport.zoom || 1
    const visTopFlow = (-viewport.y) / zoom
    const ch = (typeof canvasHeight === 'number' && canvasHeight > 0) ? canvasHeight : 2000
    const visBotFlow = (ch - viewport.y) / zoom
    const headerReserveFlow = (mrHeaderRows * ROW_HEIGHT_PX) / zoom
    const overscanFlow = ROW_OVERSCAN_FLOW / zoom
    return rowLayout.bands.map((b) => {
      const top = b.top - headerReserveFlow - overscanFlow
      const bot = b.top + b.height + overscanFlow
      return bot >= visTopFlow && top <= visBotFlow
    })
  }, [multiRow, rowLayout, viewport.y, viewport.zoom, canvasHeight, mrHeaderRows])

  // Lookup maps for the multi-row header layer. Memoised on `chapters` so
  // they are NOT rebuilt on every viewport frame inside the header render
  // (they have no viewport dependency); rebuilding O(total chapters) Maps
  // per frame was a second scale-linear cost alongside the per-row render.
  const chapterById = useMemo(() => new Map(chapters.map((c) => [c.id, c])), [chapters])
  const chapterIndexById = useMemo(() => new Map(chapters.map((c, idx) => [c.id, idx])), [chapters])

  // Bug 3 (Phase 1.11) — full header collapse. Only valid while the story
  // has zero chapters; a non-empty story always shows the header so the
  // user can see and edit their chapters. When the collapse flag is set
  // and chapters.length === 0, render NOTHING — the canvas toolbar reads
  // the same state and shifts up into the freed space, and a re-expand
  // button in the top-bar flyover lets the user bring the header back.
  const fullyCollapsed = chapterHeaderCollapsed && chapters.length === 0

  const handleAddAct = () => {
    const unclaimed = _unclaimedChapterIds(chapters, acts)
    if (unclaimed.length === 0) {
      // All chapters are already in an act — block creation and flash the
      // rightmost act's right edge red. Bumping the timestamp state
      // remounts the flash element (via `key`) so the animation restarts
      // even if the user hammers the button repeatedly.
      setActAddBlockedAt(Date.now())
      return
    }
    addAct(unclaimed)
  }

  // Active-handle highlight flags, computed from `resizeState` so React
  // can read them during render (using the ref would trip the
  // react-hooks/refs rule). Only the visual highlight on the actively
  // dragging handle uses these — all the heavy drag math still reads
  // from `resizeRef.current` inside the event handlers.
  const isFirstLeftActive =
    resizeState?.mode === 'left-first' && resizeState?.chapterId === chapters[0]?.id
  const isRightActiveFor = (chapterId) =>
    resizeState?.mode === 'right' && resizeState?.chapterId === chapterId

  if (fullyCollapsed) return null

  // Inner content of a chapter header cell (colour chip + delete while
  // editing, the "Chapter N" label, and the title display / inline input).
  // Extracted so the single-row header cells and the multi-row per-row
  // header cells render identically with full editing parity — the outer
  // positioning div + click handlers differ per mode, the inner content
  // does not. `displayIndex` is the chapter's 1-based global number
  // (row-major), `isEditing` whether this chapter is the one being edited.
  const renderChapterCellInner = (chapter, displayIndex, isEditing) => {
    const chapterLabelIsSmall = isEditing || !!chapter.title
    return (
      <>
        {isEditing && (
          <>
            <button
              type="button"
              ref={colourChipRef}
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => setChapterColourPickerOpen((o) => !o)}
              onContextMenu={handleChipResetContextMenu}
              title="Right-click to reset to default"
              style={{
                position: 'absolute',
                left: 6,
                top: (ROW_HEIGHT_PX - 26) / 2,
                width: 26,
                height: 26,
                backgroundColor: draftColour,
                border: '1px solid rgba(82, 82, 91, 1)',
                borderRadius: 6,
                cursor: 'pointer',
                boxShadow: '0 1px 2px rgba(0, 0, 0, 0.4)',
                padding: 0,
                pointerEvents: 'auto',
              }}
              aria-label={`Chapter colour: ${draftColour}. Click to open picker.`}
            />
            <EntityColorPicker
              value={draftColour}
              onChange={setDraftColour}
              anchorEl={colourChipRef.current}
              isOpen={chapterColourPickerOpen}
              onClose={() => setChapterColourPickerOpen(false)}
            />
            <div
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={handleDeleteChapter}
              title={`Delete ${chapterLabel.toLowerCase()}`}
              style={{
                position: 'absolute',
                right: 6,
                top: (ROW_HEIGHT_PX - 26) / 2,
                width: 26,
                height: 26,
                backgroundColor: 'rgba(63, 63, 70, 1)',
                border: '1px solid rgba(127, 29, 29, 0.8)',
                borderRadius: 6,
                cursor: 'pointer',
                boxShadow: '0 1px 2px rgba(0, 0, 0, 0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#f87171',
                fontSize: 18,
                lineHeight: 1,
                fontWeight: 600,
                pointerEvents: 'auto',
              }}
              onMouseEnter={(ev) => {
                ev.currentTarget.style.backgroundColor = 'rgba(127, 29, 29, 0.6)'
                ev.currentTarget.style.color = '#fecaca'
              }}
              onMouseLeave={(ev) => {
                ev.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 1)'
                ev.currentTarget.style.color = '#f87171'
              }}
            >
              ×
            </div>
          </>
        )}
        <div
          style={{
            fontSize: chapterLabelIsSmall ? 10 : 15,
            lineHeight: chapterLabelIsSmall ? 1 : 1.333,
            color: chapterLabelIsSmall ? '#71717a' : '#d4d4d8',
            fontWeight: chapterLabelIsSmall ? 400 : 500,
          }}
        >
          {chapterLabel} {displayIndex}
        </div>
        {isEditing ? (
          <input
            ref={titleInputRef}
            type="text"
            value={draftTitle}
            onChange={(ev) => setDraftTitle(ev.target.value)}
            onKeyDown={handleTitleKeyDown}
            placeholder="Custom title"
            style={{
              marginTop: 2,
              width: '85%',
              maxWidth: '85%',
              padding: '1px 6px',
              fontSize: 15,
              lineHeight: 1,
              color: '#e4e4e7',
              backgroundColor: 'rgba(39, 39, 42, 0.9)',
              border: '1px solid rgba(82, 82, 91, 1)',
              borderRadius: 2,
              outline: 'none',
              textAlign: 'center',
              fontWeight: 500,
              fontFamily: 'inherit',
              pointerEvents: 'auto',
            }}
          />
        ) : chapter.title && (
          <div
            style={{
              fontSize: 15,
              color: '#e4e4e7',
              lineHeight: 1,
              marginTop: 2,
              maxWidth: '100%',
              padding: '0 8px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: 500,
            }}
          >
            {chapter.title}
          </div>
        )}
      </>
    )
  }

  // Phase 4.3 — the chapter cell content (renderChapterCellInner) wrapped in a
  // "visible box" clamped to the ON-SCREEN portion of the chapter column, so a
  // wide column extending past either viewport edge keeps its title (and edit
  // controls) centred in view — the same panning behaviour as the act title.
  // `cellLeftPx` / `cellWidthPx` are the cell's screen rect; the inner content's
  // interactive elements carry their own pointerEvents:'auto'.
  const renderChapterVisibleBox = (chapter, displayIndex, isEditing, cellLeftPx, cellWidthPx) => {
    const visLeftInset = Math.max(0, -cellLeftPx)
    const cellRight = cellLeftPx + cellWidthPx
    const w = (typeof canvasWidth === 'number' && canvasWidth > 0) ? canvasWidth : cellRight
    const visRightInset = Math.max(0, cellRight - w)
    return (
      <div
        style={{
          position: 'absolute',
          left: visLeftInset,
          right: visRightInset,
          top: 0,
          bottom: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          pointerEvents: 'none',
        }}
      >
        {renderChapterCellInner(chapter, displayIndex, isEditing)}
      </div>
    )
  }

  // Phase 4.3 — the act cell's editable content (auto-numbered "Act N" label,
  // custom title / inline input, and the colour-chip + delete controls while
  // editing), wrapped in a "visible box" clamped to the ON-SCREEN portion of
  // the cell so a wide act extending past either viewport edge keeps its label
  // AND its edit controls in view. Shared by the single-row acts row and the
  // per-row multi-row acts band; the cell wrapper (positioning, background,
  // click / double-click, editingActCellRef) differs per mode, this inner
  // content does not. `a` carries { id, index, title, colour }. `cellLeftPx`
  // / `cellWidthPx` are the cell's screen rect. For a multi-row act that spans
  // rows, only its FIRST segment passes isEditing=true so the controls / refs
  // aren't duplicated across segments.
  const renderActVisibleBox = (a, isEditing, cellLeftPx, cellWidthPx) => {
    const actLabelIsSmall = isEditing || !!a.title
    const visLeftInset = Math.max(0, -cellLeftPx)
    const cellRight = cellLeftPx + cellWidthPx
    const w = (typeof canvasWidth === 'number' && canvasWidth > 0) ? canvasWidth : cellRight
    const visRightInset = Math.max(0, cellRight - w)
    return (
      <div
        style={{
          position: 'absolute',
          left: visLeftInset,
          right: visRightInset,
          top: 0,
          bottom: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          pointerEvents: 'none',
        }}
      >
        {isEditing && (
          <>
            <button
              type="button"
              ref={actColourChipRef}
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => setActColourPickerOpen((o) => !o)}
              onContextMenu={handleActChipResetContextMenu}
              title="Right-click to reset to default"
              style={{
                position: 'absolute', left: 6, top: (ROW_HEIGHT_PX - 26) / 2,
                width: 26, height: 26, backgroundColor: draftActColour,
                border: '1px solid rgba(82, 82, 91, 1)', borderRadius: 6,
                cursor: 'pointer', boxShadow: '0 1px 2px rgba(0, 0, 0, 0.4)',
                padding: 0, pointerEvents: 'auto',
              }}
              aria-label={`Act colour: ${draftActColour}. Click to open picker.`}
            />
            <EntityColorPicker
              value={draftActColour}
              onChange={setDraftActColour}
              anchorEl={actColourChipRef.current}
              isOpen={actColourPickerOpen}
              onClose={() => setActColourPickerOpen(false)}
            />
            <div
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={handleDeleteAct}
              title="Delete act"
              style={{
                position: 'absolute', right: 6, top: (ROW_HEIGHT_PX - 26) / 2,
                width: 26, height: 26, backgroundColor: 'rgba(63, 63, 70, 1)',
                border: '1px solid rgba(127, 29, 29, 0.8)', borderRadius: 6,
                cursor: 'pointer', boxShadow: '0 1px 2px rgba(0, 0, 0, 0.4)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#f87171', fontSize: 18, lineHeight: 1, fontWeight: 600,
                pointerEvents: 'auto',
              }}
              onMouseEnter={(ev) => { ev.currentTarget.style.backgroundColor = 'rgba(127, 29, 29, 0.6)'; ev.currentTarget.style.color = '#fecaca' }}
              onMouseLeave={(ev) => { ev.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 1)'; ev.currentTarget.style.color = '#f87171' }}
            >
              ✕
            </div>
          </>
        )}
        <div
          style={{
            position: 'relative',
            fontSize: actLabelIsSmall ? 8 : 11,
            lineHeight: 1,
            color: actLabelIsSmall ? '#71717a' : '#e4e4e7',
            fontWeight: actLabelIsSmall ? 400 : 500,
            pointerEvents: 'none',
            userSelect: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {actLabel} {a.index}
        </div>
        {isEditing ? (
          <input
            ref={actTitleInputRef}
            type="text"
            value={draftActTitle}
            onChange={(ev) => setDraftActTitle(ev.target.value)}
            onKeyDown={handleActTitleKeyDown}
            placeholder={`${actLabel} title`}
            style={{
              position: 'relative', marginTop: 1, width: '60%', maxWidth: '60%',
              padding: '1px 6px', fontSize: 11, lineHeight: 1, color: '#e4e4e7',
              backgroundColor: 'rgba(39, 39, 42, 0.9)', border: '1px solid rgba(82, 82, 91, 1)',
              borderRadius: 2, outline: 'none', textAlign: 'center', fontWeight: 500,
              fontFamily: 'inherit', pointerEvents: 'auto',
            }}
          />
        ) : a.title && (
          <div
            style={{
              position: 'relative', marginTop: 1, fontSize: 11, color: '#e4e4e7',
              fontWeight: 500, lineHeight: 1, userSelect: 'none', pointerEvents: 'none',
              overflow: 'hidden', whiteSpace: 'nowrap', padding: '0 8px',
              maxWidth: '100%', textOverflow: 'ellipsis',
            }}
          >
            {a.title}
          </div>
        )}
      </div>
    )
  }

  // Phase 4.3 — the acts expand/collapse chevron. Global toggle (all rows
  // expand together) drawn at the far right of a header row at screen `topPx`.
  // Rendered once PER ROW (so it's reachable wherever you are) and once on the
  // sticky pinned header. ▲ collapses (sits on the act row when expanded), ▼
  // expands (sits on the chapter row when collapsed).
  const renderActsChevron = (topPx, key) => (
    <button
      key={key}
      type="button"
      onClick={() => toggleMultirowActsExpanded()}
      title={multirowActsExpanded ? `Hide ${actLabel.toLowerCase()}s row` : `Show ${actLabel.toLowerCase()}s row`}
      style={{
        position: 'absolute',
        right: 8,
        top: topPx,
        width: 18,
        height: 18,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'transparent',
        border: 'none',
        boxShadow: 'none',
        color: '#71717a',
        fontSize: 11,
        opacity: 0.7,
        lineHeight: 1,
        cursor: 'pointer',
        pointerEvents: 'auto',
        padding: 0,
        zIndex: 5,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = '#d4d4d8'; e.currentTarget.style.opacity = '1' }}
      onMouseLeave={(e) => { e.currentTarget.style.color = '#71717a'; e.currentTarget.style.opacity = '0.7' }}
    >
      {multirowActsExpanded ? '▲' : '▼'}
    </button>
  )

  return (
    <>
      {/* ── Layer 1: tint bands + divider lines (flow-space) ── */}
      {/* Bands and divider lines are pointerEvents: none so they are
          strictly VISUAL on the main canvas area — they never intercept
          clicks, drags, or context menus on nodes / edges / empty canvas
          underneath them. Chapter resizing lives ONLY on the header row
          divider handles (in screen space), not on the canvas bands. */}
      <ViewportPortal>
        {/* ── Single-row tint bands (full-height columns) ── */}
        {!multiRow && edges.map((e, i) => {
          // Live preview: while the user is editing a chapter and picking
          // a new colour, the tint band reflects `draftColour` immediately,
          // not the stored `chapter.colour`. This gives instant feedback
          // before the user commits the edit.
          const isEditing = editingChapterId === chapters[i].id
          const colour = (isEditing ? draftColour : chapters[i].colour) || DEFAULT_CHAPTER_COLOUR
          return (
            <div
              key={`band-${e.id}`}
              style={{
                position: 'absolute',
                left: e.left,
                top: BAND_TOP,
                width: e.width,
                height: BAND_HEIGHT,
                backgroundColor: colour,
                opacity: 0.06,
                pointerEvents: 'none',
                // Bug 4 — when tintBehindNodes is on, push the band behind
                // the React Flow node wrappers. Negative z-index inside the
                // viewport's stacking context keeps it clipped to the
                // viewport (so nothing leaks behind the canvas background)
                // while sitting below nodes at the default z-index 0.
                zIndex: tintBehindNodes ? -1 : undefined,
              }}
            />
          )
        })}
        {/* Divider lines between chapters. Rendered as 1 px vertical strips
            at each internal boundary. Skips the very last right edge. */}
        {!multiRow && edges.slice(0, -1).map((e) => (
          <div
            key={`divider-${e.id}`}
            style={{
              position: 'absolute',
              left: e.left + e.width - 0.5,
              top: BAND_TOP,
              width: 1,
              height: BAND_HEIGHT,
              backgroundColor: 'rgba(161, 161, 170, 0.18)', // zinc-400 @ 18%
              pointerEvents: 'none',
              zIndex: tintBehindNodes ? -1 : undefined,
            }}
          />
        ))}

        {/* ── Multi-row tint bands (per-row content cells) ── Each cell's
            tint spans its column-x within the row × the row's content
            band [rowTop, rowTop + rowHeight]. Column dividers render on
            each cell's right edge except the row's last column. */}
        {multiRow && rowLayout && rowLayout.cells.map((cell) => {
          if (!bandVisible[cell.rowIndex]) return null
          const isEditing = editingChapterId === cell.id
          const colour = (isEditing ? draftColour : cell.colour) || DEFAULT_CHAPTER_COLOUR
          return (
            <div
              key={`mrband-${cell.id}`}
              style={{
                position: 'absolute',
                left: cell.left,
                // Extend the tint UP by the full header reserve (1 or 2 rows)
                // so the chapter colour reaches the row boundary, backing the
                // flow-anchored header. The header top sits at this same flow
                // position (band.top - reserve), so the two scale together and
                // the header always caps its chapter section at the boundary —
                // no bare-canvas gap and no tint poking above, at any zoom.
                top: cell.rowTop - mrHeaderRows * ROW_HEIGHT_PX,
                width: cell.width,
                height: cell.rowHeight + mrHeaderRows * ROW_HEIGHT_PX,
                backgroundColor: colour,
                opacity: 0.06,
                pointerEvents: 'none',
                zIndex: tintBehindNodes ? -1 : undefined,
              }}
            />
          )
        })}
        {/* Multi-row column dividers (1 px vertical strips at each internal
            column boundary within a row) + row-boundary outlines drawn as
            a faint top border on each row band. */}
        {multiRow && rowLayout && rowLayout.cells.filter((c) => !c.isRowLast && bandVisible[c.rowIndex]).map((cell) => (
          <div
            key={`mrdiv-${cell.id}`}
            style={{
              position: 'absolute',
              left: cell.left + cell.width - 0.5,
              // Match the tint band's upward extension so the column boundary
              // runs the full height of the chapter section (under the header).
              top: cell.rowTop - mrHeaderRows * ROW_HEIGHT_PX,
              width: 1,
              height: cell.rowHeight + mrHeaderRows * ROW_HEIGHT_PX,
              backgroundColor: 'rgba(161, 161, 170, 0.18)',
              pointerEvents: 'none',
              zIndex: tintBehindNodes ? -1 : undefined,
            }}
          />
        ))}
        {/* Multi-row ROW dividers — a horizontal line at each row's
            header top (the boundary between this row and the one above),
            sharp left edge at the chapter strip's left, running far to
            the right (BAND_WIDTH), the way single-row column dividers run
            BAND_HEIGHT down. */}
        {multiRow && rowLayout && rowLayout.bands.map((band, i) => bandVisible[i] && (
          <div
            key={`mrrowdiv-${band.rowId}`}
            style={{
              position: 'absolute',
              // At the header TOP / row boundary (band.top minus the header
              // reserve), where the flow-anchored header top also sits.
              left: effectiveXOffset,
              top: band.top - mrHeaderRows * ROW_HEIGHT_PX - 0.5,
              width: BAND_WIDTH,
              height: 1,
              backgroundColor: 'rgba(161, 161, 170, 0.25)',
              pointerEvents: 'none',
              zIndex: tintBehindNodes ? -1 : undefined,
            }}
          />
        ))}
      </ViewportPortal>

      {/* ── Layer 2 (single-row): screen-fixed header at the top ──
          Gated to single-row mode; the multi-row per-row header layer
          renders instead when rows are active (just below). */}
      {!multiRow && (
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: totalHeaderHeight,
          pointerEvents: 'none', // children opt back in
          zIndex: 4,
        }}
      >
        {/* Act row — shown only when !actsCollapsed && chapters exist.
            Mirrors the chapter row: each act cell supports in-place
            editing via double-click, with a colour chip on the left,
            a title input in the middle, and a delete button on the
            right. Display mode shows the act as a flat coloured strip
            at 18% alpha with the title centred on top. */}
        {showActsRow && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: ROW_HEIGHT_PX,
              backgroundColor: HEADER_BG,
              borderBottom: `1px solid ${BORDER_COLOUR}`,
              pointerEvents: 'none',
            }}
          >
            {/* Phase 1.22j — double-click on empty acts row space adds
                a new act covering any chapters not yet in an act. Sits
                behind the act cells; act cells opt into
                pointerEvents:'auto' on their own so clicks /
                double-clicks ON an act cell don't reach this overlay.
                Routes through `handleAddAct` (not `addAct` directly)
                so the all-chapters-already-claimed edge case still
                produces the red-flash feedback instead of silently
                doing nothing. */}
            <div
              onDoubleClick={(ev) => {
                if (ev.target === ev.currentTarget) handleAddAct()
              }}
              title="Double-click empty acts row to add an act"
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'auto',
                cursor: 'default',
                userSelect: 'none',
                WebkitUserSelect: 'none',
              }}
            />

            {/* Phase 1.22j — Empty-state placeholder for the Acts row
                when chapters exist but no acts have been created yet.
                Mirrors the chapters-row placeholder. */}
            {acts.length === 0 && (
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 32, // leave room for the subtle hide-acts chevron
                  top: 0,
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 13,
                  color: '#52525b',
                  fontStyle: 'italic',
                  pointerEvents: 'none',
                  userSelect: 'none',
                  WebkitUserSelect: 'none',
                }}
              >
                No {actLabel.toLowerCase()}s yet. Double-click anywhere on the row to add one.
              </div>
            )}
            {actRanges.map((a) => {
              const isEditing = editingActId === a.id
              const screenLeft = a.left * viewport.zoom + viewport.x
              const screenWidth = a.width * viewport.zoom
              // Live preview: while editing, the background reflects the
              // draft colour immediately.
              const effectiveColour = (isEditing ? draftActColour : a.colour) || DEFAULT_CHAPTER_COLOUR
              return (
                <div
                  key={`act-${a.id}`}
                  data-help-region="chapter-header:act_cell"
                  ref={isEditing ? editingActCellRef : null}
                  onClick={(ev) => {
                    if (isEditing) return
                    ev.stopPropagation()
                    scheduleHeaderFit(a.left, a.left + a.width)
                  }}
                  onDoubleClick={(ev) => {
                    ev.stopPropagation()
                    cancelHeaderFit()
                    openActEditor({ id: a.id, title: a.title, colour: a.colour })
                  }}
                  style={{
                    position: 'absolute',
                    left: screenLeft,
                    top: 0,
                    width: screenWidth,
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                    pointerEvents: 'auto',
                    userSelect: 'none',
                    cursor: isEditing ? 'text' : 'pointer',
                  }}
                  title={isEditing ? '' : `${a.title || `${actLabel} ${a.index}`}. Click to fit viewport, double-click to edit.`}
                >
                  {/* Coloured strip background — sits behind the content. */}
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      backgroundColor: effectiveColour,
                      opacity: 0.18,
                      pointerEvents: 'none',
                    }}
                  />

                  {/* Act content (label / title / edit controls), sticky-
                      centred in the on-screen portion of the cell. Shared with
                      the multi-row acts band via renderActVisibleBox. */}
                  {renderActVisibleBox(a, isEditing, screenLeft, screenWidth)}
                </div>
              )
            })}

            {/* Act edge drag handles. Two 8 px col-resize handles per
                act — one at the left edge, one at the right. Drag the
                handle to extend / shrink the act's chapter range. The
                handles sit on top of the act cells (zIndex 3) so clicks
                near the edge are captured by the handle rather than
                triggering the double-click editor. Snapping is to
                chapter boundaries (not the 20 px grid) because acts
                always span a contiguous run of whole chapters.
                Header-only, so moving scene nodes on the canvas below
                can never accidentally edge-resize an act. */}
            {actRanges.map((a, idx) => {
              // In solo mode, only the grabbed handle highlights. In
              // shared mode, the right handle of the LEFT act AND the
              // left handle of the RIGHT act both highlight, since
              // they're the two sides of the same shared boundary.
              const isSoloLeft =
                actResizeState?.mode === 'solo' &&
                actResizeState?.actId === a.id &&
                actResizeState?.edge === 'left'
              const isSoloRight =
                actResizeState?.mode === 'solo' &&
                actResizeState?.actId === a.id &&
                actResizeState?.edge === 'right'
              const isSharedLeft =
                actResizeState?.mode === 'shared' &&
                actResizeState?.rightActId === a.id
              const isSharedRight =
                actResizeState?.mode === 'shared' &&
                actResizeState?.leftActId === a.id
              const isLeftActive = isSoloLeft || isSharedLeft
              const isRightActive = isSoloRight || isSharedRight
              const actScreenLeft = a.left * viewport.zoom + viewport.x
              const actScreenRight = (a.left + a.width) * viewport.zoom + viewport.x
              // Look up the underlying act object (not the computed range)
              // so startActResize can read its chapter_ids.
              const actObject = acts.find((x) => x.id === a.id)
              if (!actObject) return null
              // Only one of the two adjacent handles at any shared
              // boundary should render the grip indicator (otherwise
              // they double up). Convention: the LEFT handle of every
              // act after the first owns the indicator for that
              // boundary, and the LAST act's RIGHT handle owns the
              // indicator for the right outer edge.
              const isFirstAct = idx === 0
              const isLastAct = idx === actRanges.length - 1
              const leftIndicator = isFirstAct ? 'outer' : 'inner'
              const rightIndicator = isLastAct ? 'outer' : null
              return (
                <React.Fragment key={`act-handles-${a.id}`}>
                  <ResizeHandle
                    onMouseDown={(ev) => startActResize(ev, actObject, 'left')}
                    title="Drag to resize act"
                    active={isLeftActive}
                    outer={leftIndicator === 'outer'}
                    dataHelpRegion="chapter-header:act_resize"
                    style={{
                      position: 'absolute',
                      left: actScreenLeft - 4,
                      top: 0,
                      width: 8,
                      height: '100%',
                      cursor: 'col-resize',
                      pointerEvents: 'auto',
                      zIndex: 3,
                      backgroundColor: 'transparent',
                    }}
                  />
                  {rightIndicator ? (
                    <ResizeHandle
                      onMouseDown={(ev) => startActResize(ev, actObject, 'right')}
                      title="Drag to resize act"
                      active={isRightActive}
                      outer
                      style={{
                        position: 'absolute',
                        left: actScreenRight - 4,
                        top: 0,
                        width: 8,
                        height: '100%',
                        cursor: 'col-resize',
                        pointerEvents: 'auto',
                        zIndex: 3,
                        backgroundColor: 'transparent',
                      }}
                    />
                  ) : (
                    <div
                      onMouseDown={(ev) => startActResize(ev, actObject, 'right')}
                      title="Drag to resize act"
                      style={{
                        position: 'absolute',
                        left: actScreenRight - 4,
                        top: 0,
                        width: 8,
                        height: '100%',
                        cursor: 'col-resize',
                        pointerEvents: 'auto',
                        zIndex: 3,
                        backgroundColor: 'transparent',
                      }}
                    />
                  )}
                </React.Fragment>
              )
            })}

            {/* Subtle but visible separator strips between adjacent acts.
                The 18 % alpha tint strips touching each other are hard to
                read at a glance, so each act gets a thin 1 px line at its
                LEFT edge in a slightly brighter zinc. Skip the very first
                act (its left edge is the act row's outer boundary, not a
                divider). pointerEvents: none so it never intercepts the
                drag handles overhead. */}
            {actRanges.map((a, idx) => {
              if (idx === 0) return null
              const screenLeft = a.left * viewport.zoom + viewport.x
              return (
                <div
                  key={`act-sep-${a.id}`}
                  style={{
                    position: 'absolute',
                    left: screenLeft - 0.5,
                    top: 0,
                    width: 1,
                    height: '100%',
                    backgroundColor: 'rgba(212, 212, 216, 0.4)', // zinc-300 @ 40 %
                    pointerEvents: 'none',
                    zIndex: 2,
                  }}
                />
              )
            })}

            {/* Add Act blocked flash. When the user clicks Add Act and
                every chapter is already in an act, this thin red bar
                appears on the right edge of the rightmost act with a
                glowing fade-out animation (~2 s). The `key` is the
                trigger timestamp so React remounts the element on each
                trigger and the animation restarts even if the user
                hammers the button repeatedly. */}
            {actAddBlockedAt > 0 && actRanges.length > 0 && (() => {
              // Find the act with the rightmost right-edge.
              let maxRight = -Infinity
              for (const a of actRanges) {
                const r = a.left + a.width
                if (r > maxRight) maxRight = r
              }
              if (maxRight === -Infinity) return null
              return (
                <div
                  key={actAddBlockedAt}
                  className="nn-act-add-blocked-flash"
                  style={{
                    position: 'absolute',
                    left: maxRight * viewport.zoom + viewport.x - 2,
                    top: 0,
                    width: 4,
                    height: '100%',
                    backgroundColor: 'rgba(239, 68, 68, 0.95)', // red-500
                    borderRadius: 1,
                    pointerEvents: 'none',
                    zIndex: 4,
                  }}
                />
              )
            })()}
          </div>
        )}

        {/* Chapter row — always shown. Fills the remaining space below the
            Act row (if any), or sits at top: 0 when acts are collapsed / no
            chapters exist. */}
        <div
          style={{
            position: 'absolute',
            top: chapterRowTop,
            left: 0,
            right: 0,
            height: ROW_HEIGHT_PX,
            backgroundColor: HEADER_BG,
            borderBottom: `1px solid ${BORDER_COLOUR}`,
            pointerEvents: 'none',
          }}
        >
          {/* Phase 1.22j — double-click on empty chapter row space adds
              a new chapter. Sits behind the chapter cells; chapter cells
              opt into pointerEvents:'auto' on their own so clicks /
              double-clicks ON a chapter cell don't reach this overlay. */}
          <div
            onDoubleClick={(ev) => {
              if (ev.target === ev.currentTarget) addChapter()
            }}
            title="Double-click empty chapter row to add a chapter"
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'auto',
              cursor: 'default',
            }}
          />
          {edges.map((e, i) => {
            const chapter = chapters[i]
            const screenLeft = e.left * viewport.zoom + viewport.x
            const screenWidth = e.width * viewport.zoom
            const isEditing = editingChapterId === chapter.id
            return (
              <div
                key={`hdr-${e.id}`}
                data-help-region="chapter-header:chapter_cell"
                ref={isEditing ? editingCellRef : null}
                onClick={(ev) => {
                  if (isEditing) return
                  ev.stopPropagation()
                  scheduleHeaderFit(e.left, e.left + e.width)
                }}
                onDoubleClick={(ev) => {
                  ev.stopPropagation()
                  cancelHeaderFit()
                  openEditor(chapter)
                }}
                style={{
                  position: 'absolute',
                  left: screenLeft,
                  top: 0,
                  width: screenWidth,
                  height: '100%',
                  borderLeft: i === 0 ? undefined : `1px solid rgba(255, 255, 255, 0.06)`,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                  pointerEvents: 'auto',
                  userSelect: 'none',
                  cursor: isEditing ? 'text' : 'pointer',
                }}
                title={isEditing ? '' : `${chapter.title || `${chapterLabel} ${i + 1}`}. Click to fit viewport, double-click to edit.`}
              >
                {renderChapterVisibleBox(chapter, i + 1, isEditing, screenLeft, screenWidth)}
              </div>
            )
          })}

          {/* Phase 4.3d — "+" button immediately after the last chapter
              column. Appends a new empty chapter (addChapter). Pans with
              the columns so it always sits at the end of the strip. The
              new chapter is empty ⇒ no story-order impact on existing
              nodes (§5). Mode-agnostic (single-row and multi-row). */}
          {chapters.length > 0 && (() => {
            const last = edges[edges.length - 1]
            const screenRight = (last.left + last.width) * viewport.zoom + viewport.x
            const SIZE = 22
            return (
              <button
                type="button"
                data-help-region="chapter-header:add_chapter"
                onClick={() => addChapter()}
                title={`Add ${chapterLabel.toLowerCase()} at the end`}
                aria-label={`Add ${chapterLabel.toLowerCase()} at the end`}
                style={{
                  position: 'absolute',
                  left: screenRight + 6,
                  top: (ROW_HEIGHT_PX - SIZE) / 2,
                  width: SIZE,
                  height: SIZE,
                  borderRadius: 4,
                  backgroundColor: 'rgba(63, 63, 70, 1)',
                  color: '#d4d4d8',
                  border: '1px solid rgba(82, 82, 91, 1)',
                  cursor: 'pointer',
                  pointerEvents: 'auto',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 16,
                  lineHeight: 1,
                  padding: 0,
                  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.4)',
                  zIndex: 3,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgba(82, 82, 91, 1)'
                  e.currentTarget.style.color = '#fafafa'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 1)'
                  e.currentTarget.style.color = '#d4d4d8'
                }}
              >
                +
              </button>
            )
          })()}

          {/* Chapter column divider drag handles. HEADER-ONLY: the
              canvas tint bands stay pointerEvents: none, so there is no
              way to accidentally resize a chapter by dragging on the
              canvas area while moving scene nodes. Each handle is an
              8 px wide invisible click-catcher with a col-resize cursor
              and zIndex 3 so it wins over the cells underneath.
              Three handle types:
                - Right edge of every chapter (including the last) →
                  updates that chapter's width. For non-last chapters
                  this is the divider between adjacent chapters; for the
                  last chapter it's the outer right edge.
                - Left edge of the first chapter → updates the story's
                  `chapter_x_offset` AND the first chapter's width in
                  opposite directions (right edge stays pinned, left
                  edge slides). */}
          {edges.map((e, i) => {
            const chapter = chapters[i]
            const screenRight = (e.left + e.width) * viewport.zoom + viewport.x
            const isActive = isRightActiveFor(chapter.id)
            const isOuterRight = i === edges.length - 1
            return (
              <ResizeHandle
                key={`divider-handle-${chapter.id}`}
                dataHelpRegion="chapter-header:chapter_divider"
                onMouseDown={(ev) => startResize(ev, chapter, 'right')}
                onDoubleClick={(ev) => {
                  ev.stopPropagation()
                  ev.preventDefault()
                  insertChapterAtDivider(i + 1)
                }}
                onContextMenu={(ev) => {
                  ev.stopPropagation()
                  ev.preventDefault()
                  setDividerMenu({ x: ev.clientX, y: ev.clientY, index: i + 1 })
                }}
                title="Drag to resize. Double-click or right-click to insert a chapter."
                active={isActive}
                outer={isOuterRight}
                style={{
                  position: 'absolute',
                  left: screenRight - 4,
                  top: 0,
                  width: 8,
                  height: '100%',
                  cursor: 'col-resize',
                  pointerEvents: 'auto',
                  zIndex: 3,
                  backgroundColor: 'transparent',
                }}
              />
            )
          })}
          {/* Left edge of the FIRST chapter — only rendered when
              chapters exist. Updates chapter_x_offset AND chapter_0.width
              in opposite directions on drag. */}
          {chapters.length > 0 && (
            <ResizeHandle
              key="divider-handle-first-left"
              onMouseDown={(ev) => startResize(ev, chapters[0], 'left-first')}
              title="Drag to resize (moves the chapter's left edge)"
              active={isFirstLeftActive}
              outer
              style={{
                position: 'absolute',
                left: edges[0].left * viewport.zoom + viewport.x - 4,
                top: 0,
                width: 8,
                height: '100%',
                cursor: 'col-resize',
                pointerEvents: 'auto',
                zIndex: 3,
                backgroundColor: 'transparent',
              }}
            />
          )}

          {/* Empty-state placeholder when there are no chapters yet. */}
          {chapters.length === 0 && (
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 48, // leave room for the Add button on the right
                top: 0,
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 13,
                color: '#52525b',
                fontStyle: 'italic',
                pointerEvents: 'none',
                userSelect: 'none', // suppress double-click text-selection flash on the row
                WebkitUserSelect: 'none',
              }}
            >
              No {chapterLabel.toLowerCase()}s yet. Double-click anywhere on the row to add one.
            </div>
          )}
        </div>

        {/* Static right-side controls — fixed position in the header, do
            NOT pan or zoom with the canvas. All are square, sized to fit
            flush inside the row height. Layered at zIndex 2 so any
            chapter/act cells visually behind them at extreme pan
            positions are occluded. */}

        {/* Acts-row controls — only rendered when the Acts row is
            expanded. The COLLAPSE chevron lives on the Acts row so it sits
            visually with the row it collapses; Add Act sits to its right. */}
        {/* Phase 1.22j \u2014 Hide Acts row chevron. Subtle, anchored to
            far right of the Acts row. Add Act button removed; double-
            click empty acts space adds an act instead. */}
        {showActsRow && (
          <button
            data-help-region="chapter-header:acts_toggle"
            onClick={toggleActs}
            title="Hide Acts row"
            style={{
              ...cornerButtonStyle(ROW_BUTTON_MARGIN),
              right: 8,
              backgroundColor: 'transparent',
              border: 'none',
              boxShadow: 'none',
              color: '#71717a',
              fontSize: 11,
              opacity: 0.7,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = '#d4d4d8'
              e.currentTarget.style.opacity = '1'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = '#71717a'
              e.currentTarget.style.opacity = '0.7'
            }}
          >
            {'\u25B2'}
          </button>
        )}

        {/* EXPAND chevron — only rendered when the Acts row is COLLAPSED.
            Lives on the Chapters row just left of the Add Chapter button.
            When the Acts row is expanded, this is hidden because the
            collapse chevron has moved to the Acts row. */}
        {chapters.length > 0 && actsCollapsed && (
          <button
            data-help-region="chapter-header:acts_toggle"
            onClick={toggleActs}
            title="Show Acts row"
            style={{
              ...cornerButtonStyle(chapterRowTop + ROW_BUTTON_MARGIN),
              right: 8,
              backgroundColor: 'transparent',
              border: 'none',
              boxShadow: 'none',
              color: '#71717a',
              fontSize: 11,
              opacity: 0.7,
              lineHeight: 1,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = '#d4d4d8'
              e.currentTarget.style.opacity = '1'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = '#71717a'
              e.currentTarget.style.opacity = '0.7'
            }}
          >
            {'\u25BC'}
          </button>
        )}

        {/* Full-collapse chevron — only rendered when the story has zero
            chapters. Sits immediately left of Add Chapter and hides the
            entire header overlay on click. The re-expand counterpart
            lives in the top header bar (CanvasToolbar area / AlertsPanel
            neighbourhood) so users can bring the header back. */}
        {chapters.length === 0 && (
          <button
            data-help-region="chapter-header:header_collapse"
            onClick={toggleChapterHeaderCollapsed}
            title="Hide chapter header"
            style={{
              ...cornerButtonStyle(chapterRowTop + ROW_BUTTON_MARGIN),
              right: 8,
              backgroundColor: 'transparent',
              border: 'none',
              boxShadow: 'none',
              color: '#71717a',
              fontSize: 11,
              opacity: 0.7,
              lineHeight: 1,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = '#d4d4d8'
              e.currentTarget.style.opacity = '1'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = '#71717a'
              e.currentTarget.style.opacity = '0.7'
            }}
          >
            {'\u25B2'}
          </button>
        )}

        {/* Add Chapter — always visible at the far right of the Chapters
            row, even in the empty state. */}
        {/* Phase 1.22j \u2014 Add Chapter button removed from the chapters
            bar. Chapter creation now lives on the canvas + button /
            right-click context menu (AddNodesMenuBody), and via
            double-click on empty space within the chapter row. */}

        {/* Table of Contents toggle — left side of the chapter row. Always
            visible whenever the chapter header is itself visible. Acts as
            the anchor for the TOC flyout panel rendered as a sibling
            absolute element below the header. The `data-toc-toggle`
            attribute lets the panel's click-outside handler ignore clicks
            on this button (so clicking it a second time to close doesn't
            get pre-empted by the outside handler). */}
        {/* Phase 1.22j \u2014 TOC toggle button moved to the top bar. */}

        {/* Timeline Navigator toggle — sibling to the TOC button, to its
            right. Opens the Phase 1.12c Timeline Navigator flyout. Same
            pattern as the TOC toggle, with `data-timeline-toggle` so the
            panel's click-outside handler can ignore clicks on this button. */}
        {/* Phase 1.22j \u2014 Timeline Navigator toggle button moved to the top bar. */}
      </div>
      )}

      {/* ── Phase 4.3 multi-row header layer (screen-space, per row) ──
          For each chapter cell, a header strip sits directly above its
          content band (flow→screen positioned, fixed ROW_HEIGHT_PX height
          so labels stay readable when zoomed out), reusing the shared
          cell renderer for full editing parity. Each cell's right edge
          carries the same width-drag + insert-chapter affordances. Empty
          rows show a delete-row control; an add-row control sits below the
          last row. Per-row act segments, the sticky top-most-visible
          header, and the per-row row-height drag are follow-ons within
          4.3d/4.3e. */}
      {multiRow && rowLayout && (() => {
        const fx = (x) => x * viewport.zoom + viewport.x
        const fy = (y) => y * viewport.zoom + viewport.y
        const bands = rowLayout.bands
        const lastBand = bands[bands.length - 1]
        const stripLeftPx = fx(effectiveXOffset)
        // Sticky: the top-most-VISIBLE row is the last row whose header
        // has reached or scrolled above the canvas top edge. `topFlowY` is
        // the flow-space y at screen y = 0 (the overlay's top).
        const topFlowY = viewport.zoom ? (-viewport.y) / viewport.zoom : 0
        let stickyBand = null
        let stickyIndex = -1
        for (let i = 0; i < bands.length; i++) {
          if (bands[i].top - mrHeaderRows * ROW_HEIGHT_PX <= topFlowY) { stickyBand = bands[i]; stickyIndex = i }
          else break
        }
        return (
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 4 }}>
            {/* Per-row full-width header strips: a single header background
                per row that starts at the chapter strip's left edge and
                runs to the right canvas edge (so the header continues right
                even past the last chapter, and empty rows still show a
                header band). The chapter cells render on top. */}
            {bands.map((band, i) => bandVisible[i] && (
              <div
                key={`mrstrip-${band.rowId}`}
                style={{
                  position: 'absolute',
                  left: stripLeftPx,
                  right: 0,
                  // Fixed-screen-height header anchored at the content-band top
                  // in SCREEN space, minus a fixed screen height per header row:
                  // its BOTTOM sits exactly at fy(content top) at any zoom, so it
                  // caps the chapter section flush (the tint fills the content
                  // area only — it must NOT extend up, or it pokes above the
                  // header at zoom > 1). Subtracting a flow offset inside fy()
                  // would scale with zoom and let the rows slide off the content.
                  // Expanded ⇒ 2 header rows (act + chapter); collapsed ⇒ 1.
                  // Flow-anchored TOP at the row boundary (band.top minus the
                  // header reserve) so the header always meets the boundary
                  // with the upper row; the tint extends up to back it. Fixed
                  // screen height per row keeps the labels legible at any zoom.
                  top: fy(band.top - mrHeaderRows * ROW_HEIGHT_PX),
                  height: mrHeaderRows * ROW_HEIGHT_PX,
                  backgroundColor: HEADER_BG,
                  borderTop: `1px solid ${BORDER_COLOUR}`,
                  borderBottom: `1px solid ${BORDER_COLOUR}`,
                  pointerEvents: 'none',
                }}
              />
            ))}

            {/* Per-row acts band (expanded only): one coloured segment per
                (act, row) intersection, sitting in the row's UPPER header row
                (the chapter header occupies the lower one). Display shows the
                act colour at low alpha with the auto-numbered "Act N" / title
                centred, mirroring the single-row acts row. The row's HEADER_BG
                background is already drawn by the per-row strip above (its
                height covers both header rows when expanded). Editing parity
                (colour / rename / delete / resize) folds in next. */}
            {actSegmentsByRow && (() => {
              // An act spanning rows renders one segment per row. The editor
              // opens on the segment the user DOUBLE-CLICKED (editingActSegKey);
              // if that key isn't among the editing act's current segments
              // (stale, or opened from a non-segment path), fall back to its
              // first segment. Only that one segment hosts the edit controls so
              // the chip / input / delete refs aren't duplicated across rows.
              let editSegKey = null
              if (editingActId) {
                const segs = actSegmentsByRow.filter((s) => s.id === editingActId)
                editSegKey = segs.some((s) => s.key === editingActSegKey)
                  ? editingActSegKey
                  : (segs.find((s) => s.isFirstSeg)?.key ?? segs[0]?.key ?? null)
              }
              return actSegmentsByRow.map((seg) => {
              if (!bandVisible[seg.rowIndex]) return null
              const effectiveColour = (editingActId === seg.id ? draftActColour : seg.colour) || DEFAULT_CHAPTER_COLOUR
              const cellLeftPx = fx(seg.left)
              const cellWidthPx = seg.width * viewport.zoom
              const isEditingThis = editingActId === seg.id
              const showEdit = isEditingThis && seg.key === editSegKey
              return (
                <div
                  key={`mract-${seg.key}`}
                  data-help-region="chapter-header:act_cell"
                  ref={showEdit ? editingActCellRef : null}
                  onClick={(ev) => {
                    if (isEditingThis) return
                    ev.stopPropagation()
                    scheduleHeaderFit(seg.left, seg.left + seg.width)
                  }}
                  onDoubleClick={(ev) => {
                    ev.stopPropagation()
                    cancelHeaderFit()
                    openActEditor({ id: seg.id, title: seg.title, colour: seg.colour })
                    setEditingActSegKey(seg.key)
                  }}
                  title={isEditingThis ? '' : `${seg.title || `${actLabel} ${seg.index}`}. Click to fit, double-click to edit.`}
                  style={{
                    position: 'absolute',
                    left: cellLeftPx,
                    top: fy(seg.rowTop - 2 * ROW_HEIGHT_PX),
                    width: cellWidthPx,
                    height: ROW_HEIGHT_PX,
                    backgroundColor: `${effectiveColour}2e`,
                    borderLeft: `1px solid ${effectiveColour}`,
                    borderRight: `1px solid ${effectiveColour}`,
                    overflow: 'hidden',
                    pointerEvents: 'auto',
                    userSelect: 'none',
                    boxSizing: 'border-box',
                    cursor: isEditingThis ? 'text' : 'pointer',
                  }}
                >
                  {renderActVisibleBox(seg, showEdit, cellLeftPx, cellWidthPx)}
                </div>
              )
              })
            })()}

            {/* Act edge drag handles (multi-row, expanded). An act's LEFT
                handle sits on its first segment's left edge, its RIGHT handle
                on its last segment's right edge — both on the act row. Dragging
                maps the cursor's 2-D position to a chapter (so the boundary can
                cross rows); shared-boundary detection + commit reuse the same
                state machine as single-row (startActResize). */}
            {actSegmentsByRow && actSegmentsByRow.map((seg) => {
              if (!bandVisible[seg.rowIndex]) return null
              const actObject = acts.find((a) => a.id === seg.id)
              if (!actObject) return null
              const isLeftActive =
                (actResizeState?.mode === 'solo' && actResizeState?.actId === seg.id && actResizeState?.edge === 'left') ||
                (actResizeState?.mode === 'shared' && actResizeState?.rightActId === seg.id)
              const isRightActive =
                (actResizeState?.mode === 'solo' && actResizeState?.actId === seg.id && actResizeState?.edge === 'right') ||
                (actResizeState?.mode === 'shared' && actResizeState?.leftActId === seg.id)
              const handleTop = fy(seg.rowTop - 2 * ROW_HEIGHT_PX)
              const handleStyle = {
                position: 'absolute',
                top: handleTop,
                width: 8,
                height: ROW_HEIGHT_PX,
                cursor: 'col-resize',
                pointerEvents: 'auto',
                zIndex: 6,
                backgroundColor: 'transparent',
              }
              return (
                <React.Fragment key={`mract-handles-${seg.key}`}>
                  {seg.isFirstSeg && (
                    <ResizeHandle
                      onMouseDown={(ev) => startActResize(ev, actObject, 'left')}
                      title="Drag to resize act"
                      active={isLeftActive}
                      style={{ ...handleStyle, left: fx(seg.left) - 4 }}
                    />
                  )}
                  {seg.isLastSeg && (
                    <ResizeHandle
                      onMouseDown={(ev) => startActResize(ev, actObject, 'right')}
                      title="Drag to resize act"
                      active={isRightActive}
                      style={{ ...handleStyle, left: fx(seg.left + seg.width) - 4 }}
                    />
                  )}
                </React.Fragment>
              )
            })}

            {/* Per-chapter header cells (on top of the strips) */}
            {rowLayout.cells.map((cell) => {
              const chapter = chapterById.get(cell.id)
              if (!chapter) return null
              if (!bandVisible[cell.rowIndex]) return null
              const isEditing = editingChapterId === cell.id
              const displayIndex = (chapterIndexById.get(cell.id) ?? 0) + 1
              return (
                <div
                  key={`mrhdr-${cell.id}`}
                  data-help-region="chapter-header:chapter_cell"
                  ref={isEditing ? editingCellRef : null}
                  onClick={(ev) => {
                    if (isEditing) return
                    ev.stopPropagation()
                    scheduleHeaderFit(cell.left, cell.left + cell.width)
                  }}
                  onDoubleClick={(ev) => {
                    ev.stopPropagation()
                    cancelHeaderFit()
                    openEditor(chapter)
                  }}
                  style={{
                    position: 'absolute',
                    left: fx(cell.left),
                    top: fy(cell.rowTop - mrHeaderRows * ROW_HEIGHT_PX) + (mrHeaderRows - 1) * ROW_HEIGHT_PX,
                    width: cell.width * viewport.zoom,
                    height: ROW_HEIGHT_PX,
                    backgroundColor: 'transparent',
                    borderLeft: cell.isRowFirst ? undefined : '1px solid rgba(255, 255, 255, 0.06)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                    pointerEvents: 'auto',
                    userSelect: 'none',
                    cursor: isEditing ? 'text' : 'pointer',
                  }}
                  title={isEditing ? '' : `${chapter.title || `${chapterLabel} ${displayIndex}`}. Click to fit, double-click to edit.`}
                >
                  {renderChapterVisibleBox(chapter, displayIndex, isEditing, fx(cell.left), cell.width * viewport.zoom)}
                  {/* Edge-shuffle (§5): the row's FIRST chapter can go up to
                      the end of the previous row; the row's LAST chapter can
                      go down to the start of the next row. Hidden while
                      editing (would collide with the colour chip / delete). */}
                  {!isEditing && cell.isRowFirst && cell.rowIndex > 0 && (
                    <button
                      type="button"
                      data-help-region="chapter-header:chapter_shuffle"
                      onClick={(ev) => { ev.stopPropagation(); moveChapterBetweenRows(cell.id, 'up') }}
                      title={`Move ${chapterLabel.toLowerCase()} to the end of the previous row`}
                      style={{ ...rowShuffleBtnStyle, left: 2 }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = '#fafafa'; e.currentTarget.style.backgroundColor = 'rgba(82,82,91,1)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = '#a1a1aa'; e.currentTarget.style.backgroundColor = 'rgba(63,63,70,0.9)' }}
                    >
                      ↑
                    </button>
                  )}
                  {!isEditing && cell.isRowLast && cell.rowIndex < bands.length - 1 && (
                    <button
                      type="button"
                      onClick={(ev) => { ev.stopPropagation(); moveChapterBetweenRows(cell.id, 'down') }}
                      title={`Move ${chapterLabel.toLowerCase()} to the start of the next row`}
                      style={{ ...rowShuffleBtnStyle, right: 2 }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = '#fafafa'; e.currentTarget.style.backgroundColor = 'rgba(82,82,91,1)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = '#a1a1aa'; e.currentTarget.style.backgroundColor = 'rgba(63,63,70,0.9)' }}
                    >
                      ↓
                    </button>
                  )}
                </div>
              )
            })}

            {/* "+" add-chapter button immediately right of the last chapter's
                header cell (the single-row "+" lives in the gated single-row
                header, so multi-row needs its own). Appends a new chapter to
                the last row via addChapter. */}
            {rowLayout.cells.length > 0 && (() => {
              const last = rowLayout.cells[rowLayout.cells.length - 1]
              const SIZE = 22
              return (
                <button
                  type="button"
                  data-help-region="chapter-header:add_chapter"
                  onClick={() => addChapter()}
                  title={`Add ${chapterLabel.toLowerCase()} at the end`}
                  aria-label={`Add ${chapterLabel.toLowerCase()} at the end`}
                  style={{
                    position: 'absolute',
                    left: fx(last.left + last.width) + 6,
                    top: fy(last.rowTop - mrHeaderRows * ROW_HEIGHT_PX) + (mrHeaderRows - 1) * ROW_HEIGHT_PX + (ROW_HEIGHT_PX - SIZE) / 2,
                    width: SIZE,
                    height: SIZE,
                    borderRadius: 4,
                    backgroundColor: 'rgba(63, 63, 70, 1)',
                    color: '#d4d4d8',
                    border: '1px solid rgba(82, 82, 91, 1)',
                    cursor: 'pointer',
                    pointerEvents: 'auto',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 16,
                    lineHeight: 1,
                    padding: 0,
                    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.4)',
                    zIndex: 3,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(82, 82, 91, 1)'; e.currentTarget.style.color = '#fafafa' }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'rgba(63, 63, 70, 1)'; e.currentTarget.style.color = '#d4d4d8' }}
                >
                  +
                </button>
              )
            })()}

            {/* Acts expand / collapse chevron (multi-row). Rendered at the
                far right of EVERY row's top header row (the act row when
                expanded, the chapter row when collapsed) so it's reachable
                wherever the writer is scrolled; the sticky header carries its
                own copy too (below). One global toggle via
                `toggleMultirowActsExpanded` (which re-anchors every scene). */}
            {bands.map((band, i) => bandVisible[i] && renderActsChevron(
              fy(band.top - mrHeaderRows * ROW_HEIGHT_PX) + (ROW_HEIGHT_PX - 18) / 2,
              `mrchev-${band.rowId}`,
            ))}

            {/* Add Act button (multi-row, expanded only): adds an act over any
                chapters not yet claimed by an act (handleAddAct flashes when
                all are claimed). Sits left of the chevron on the act row. */}
            {multirowActsExpanded && bands.length > 0 && (
              <button
                type="button"
                data-help-region="chapter-header:add_act"
                onClick={handleAddAct}
                title={`Add ${actLabel.toLowerCase()}`}
                aria-label={`Add ${actLabel.toLowerCase()}`}
                style={{
                  position: 'absolute',
                  right: 32,
                  top: fy(bands[0].top - 2 * ROW_HEIGHT_PX) + (ROW_HEIGHT_PX - 18) / 2,
                  width: 18,
                  height: 18,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: 'transparent',
                  border: 'none',
                  color: '#71717a',
                  fontSize: 14,
                  opacity: 0.7,
                  lineHeight: 1,
                  cursor: 'pointer',
                  pointerEvents: 'auto',
                  padding: 0,
                  zIndex: 5,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = '#d4d4d8'; e.currentTarget.style.opacity = '1' }}
                onMouseLeave={(e) => { e.currentTarget.style.color = '#71717a'; e.currentTarget.style.opacity = '0.7' }}
              >
                +
              </button>
            )}

            {/* Row-height drag handles: an 8 px grab zone on each row's
                bottom boundary (which is the next row's header-top divider
                line, since rows meet), spanning the row width to the right.
                Drag down to grow (pushes lower rows + nodes down), up to
                shrink (bounded by the row's own content). */}
            {bands.map((band, i) => bandVisible[i] && (
              <div
                key={`mrrowresize-${band.rowId}`}
                data-help-region="chapter-header:row_resize"
                onMouseDown={(ev) => startRowResize(ev, band)}
                title="Drag to resize row height"
                style={{
                  position: 'absolute',
                  left: stripLeftPx,
                  right: 0,
                  top: fy(band.top + band.height) - 4,
                  height: 8,
                  cursor: 'row-resize',
                  pointerEvents: 'auto',
                  zIndex: 5,
                  backgroundColor: rowResizingId === band.rowId ? 'rgba(192, 132, 252, 0.25)' : 'transparent',
                }}
              />
            ))}

            {/* Per-chapter divider drag handles (right edge of each cell):
                width-drag + double-click / right-click insert, same as the
                single-row handles. */}
            {rowLayout.cells.map((cell) => {
              const chapter = chapterById.get(cell.id)
              if (!chapter) return null
              if (!bandVisible[cell.rowIndex]) return null
              const dividerIndex = (chapterIndexById.get(cell.id) ?? 0) + 1
              return (
                <ResizeHandle
                  key={`mrhandle-${cell.id}`}
                  dataHelpRegion="chapter-header:chapter_divider"
                  onMouseDown={(ev) => startResize(ev, chapter, 'right')}
                  onDoubleClick={(ev) => {
                    ev.stopPropagation()
                    ev.preventDefault()
                    insertChapterAtDivider(dividerIndex)
                  }}
                  onContextMenu={(ev) => {
                    ev.stopPropagation()
                    ev.preventDefault()
                    setDividerMenu({ x: ev.clientX, y: ev.clientY, index: dividerIndex })
                  }}
                  title="Drag to resize. Double-click or right-click to insert a chapter."
                  active={isRightActiveFor(cell.id)}
                  outer={cell.isRowLast}
                  style={{
                    position: 'absolute',
                    left: fx(cell.left + cell.width) - 4,
                    top: fy(cell.rowTop - mrHeaderRows * ROW_HEIGHT_PX) + (mrHeaderRows - 1) * ROW_HEIGHT_PX,
                    width: 8,
                    height: ROW_HEIGHT_PX,
                    cursor: 'col-resize',
                    pointerEvents: 'auto',
                    zIndex: 3,
                    backgroundColor: 'transparent',
                  }}
                />
              )
            })}

            {/* Empty-row chrome: an "Empty row" label + a delete-row
                control. Shown only on rows with no chapters (§5: empty
                rows persist and are removed manually). */}
            {bands.map((band, i) => {
              if (!bandVisible[i]) return null
              if (band.chapterIds.length > 0) return null
              return (
                <div
                  key={`mrempty-${band.rowId}`}
                  style={{
                    position: 'absolute',
                    left: fx(effectiveXOffset),
                    top: fy(band.top - mrHeaderRows * ROW_HEIGHT_PX) + (mrHeaderRows - 1) * ROW_HEIGHT_PX,
                    height: ROW_HEIGHT_PX,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    paddingLeft: 8,
                    pointerEvents: 'auto',
                  }}
                >
                  <span style={{ fontSize: 12, color: '#71717a', fontStyle: 'italic', userSelect: 'none', whiteSpace: 'nowrap' }}>
                    Empty row
                  </span>
                  <button
                    type="button"
                    data-help-region="chapter-header:delete_row"
                    onClick={() => deleteChapterRow(band.rowId)}
                    title="Delete this empty row"
                    style={{
                      height: 22,
                      padding: '0 8px',
                      borderRadius: 4,
                      backgroundColor: 'rgba(63, 63, 70, 1)',
                      color: '#f87171',
                      border: '1px solid rgba(127, 29, 29, 0.8)',
                      cursor: 'pointer',
                      fontSize: 12,
                      lineHeight: 1,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Delete row
                  </button>
                </div>
              )
            })}

            {/* Add-row control below the last row. Appends a new empty
                row (§5); it persists until populated or deleted. */}
            {lastBand && (
              <button
                type="button"
                data-help-region="chapter-header:add_row"
                onClick={() => addChapterRow()}
                title="Add a new row"
                style={{
                  position: 'absolute',
                  left: fx(effectiveXOffset),
                  top: fy(lastBand.bottom + 24),
                  height: 26,
                  padding: '0 12px',
                  borderRadius: 4,
                  backgroundColor: 'rgba(63, 63, 70, 1)',
                  color: '#d4d4d8',
                  border: '1px solid rgba(82, 82, 91, 1)',
                  cursor: 'pointer',
                  pointerEvents: 'auto',
                  fontSize: 13,
                  lineHeight: 1,
                  zIndex: 4,
                  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.4)',
                }}
              >
                + Add row
              </button>
            )}

            {/* Sticky header: the top-most-visible row's header pinned at
                the canvas top edge. As the user scrolls down past one
                row's header, the next row's header takes over the pin (the
                4.1j-style viewport-driven recompute, here via the
                viewport-subscribed render). Click a chapter to jump/fit to
                it; editing happens on the in-flow header. */}
            {stickyBand && (
              <div
                key="mr-sticky"
                style={{ position: 'absolute', left: 0, right: 0, top: 0, height: mrHeaderRows * ROW_HEIGHT_PX, zIndex: 6, pointerEvents: 'none' }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: Math.max(stripLeftPx, 0),
                    right: 0,
                    top: 0,
                    height: mrHeaderRows * ROW_HEIGHT_PX,
                    backgroundColor: HEADER_BG,
                    borderBottom: `1px solid ${BORDER_COLOUR}`,
                    boxShadow: '0 2px 5px rgba(0, 0, 0, 0.35)',
                  }}
                />
                {/* Pinned ACT row (expanded only): the sticky row's act
                    segments, on the upper header row. Display-only — editing
                    happens on the in-flow act header. */}
                {multirowActsExpanded && actSegmentsByRow && actSegmentsByRow.filter((s) => s.rowIndex === stickyIndex).map((seg) => {
                  const effectiveColour = seg.colour || DEFAULT_CHAPTER_COLOUR
                  const cellLeftPx = fx(seg.left)
                  const cellWidthPx = seg.width * viewport.zoom
                  return (
                    <div
                      key={`mrstickyact-${seg.key}`}
                      title={seg.title || `${actLabel} ${seg.index}`}
                      style={{
                        position: 'absolute',
                        left: cellLeftPx,
                        top: 0,
                        width: cellWidthPx,
                        height: ROW_HEIGHT_PX,
                        backgroundColor: `${effectiveColour}2e`,
                        borderLeft: `1px solid ${effectiveColour}`,
                        borderRight: `1px solid ${effectiveColour}`,
                        overflow: 'hidden',
                        pointerEvents: 'none',
                        userSelect: 'none',
                        boxSizing: 'border-box',
                      }}
                    >
                      {/* Label sticky-centred in the on-screen portion (display
                          only — isEditing=false), same as the in-flow act row. */}
                      {renderActVisibleBox(seg, false, cellLeftPx, cellWidthPx)}
                    </div>
                  )
                })}
                {/* Pinned CHAPTER row: the sticky row's chapter cells, on the
                    LOWER header row (top:0 when collapsed, one row down when
                    the act row is shown above). */}
                {rowLayout.cells.filter((c) => c.rowIndex === stickyIndex).map((cell) => {
                  const chapter = chapterById.get(cell.id)
                  if (!chapter) return null
                  const displayIndex = (chapterIndexById.get(cell.id) ?? 0) + 1
                  return (
                    <div
                      key={`mrsticky-${cell.id}`}
                      onClick={(ev) => { ev.stopPropagation(); scheduleHeaderFit(cell.left, cell.left + cell.width) }}
                      title={`${chapter.title || `${chapterLabel} ${displayIndex}`}. Click to jump.`}
                      style={{
                        position: 'absolute',
                        left: fx(cell.left),
                        top: (mrHeaderRows - 1) * ROW_HEIGHT_PX,
                        width: cell.width * viewport.zoom,
                        height: ROW_HEIGHT_PX,
                        borderLeft: cell.isRowFirst ? undefined : '1px solid rgba(255, 255, 255, 0.06)',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        overflow: 'hidden',
                        pointerEvents: 'auto',
                        userSelect: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      {renderChapterVisibleBox(chapter, displayIndex, false, fx(cell.left), cell.width * viewport.zoom)}
                    </div>
                  )
                })}
                {stickyBand.chapterIds.length === 0 && (
                  <span
                    style={{
                      position: 'absolute',
                      left: Math.max(stripLeftPx, 0) + 8,
                      top: (mrHeaderRows - 1) * ROW_HEIGHT_PX,
                      height: ROW_HEIGHT_PX,
                      display: 'flex',
                      alignItems: 'center',
                      fontSize: 12,
                      color: '#71717a',
                      fontStyle: 'italic',
                      pointerEvents: 'none',
                      userSelect: 'none',
                    }}
                  >
                    Empty row
                  </span>
                )}
                {/* Sticky acts chevron — top header row (the act row when
                    expanded, chapter row when collapsed), far right (always on
                    screen since the sticky header is pinned to the top). */}
                {renderActsChevron((ROW_HEIGHT_PX - 18) / 2, 'mrchev-sticky')}
              </div>
            )}
          </div>
        )
      })()}

      {/* Phase 1.22j — TOC and Timeline panels relocated to App.jsx so
          they remain accessible when the chapters bar is collapsed. */}

      {/* Phase 4.3d — divider "Insert chapter" context menu. Right-click
          on a column divider handle opens this; the single option inserts
          a new empty chapter at that divider (same as double-clicking the
          handle). Mirrors DockContextMenu's outside-click / Escape / clamp
          pattern. */}
      {dividerMenu && (
        <div
          ref={dividerMenuRef}
          className="fixed z-50 bg-zinc-800 border border-zinc-600 rounded shadow-xl py-1 min-w-[160px] text-xs"
          style={{
            left: Math.max(4, Math.min(dividerMenu.x, window.innerWidth - 170)),
            top: Math.max(4, Math.min(dividerMenu.y, window.innerHeight - 44)),
          }}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              insertChapterAtDivider(dividerMenu.index)
              closeDividerMenu()
            }}
            className="block w-full text-left px-3 py-1.5 text-zinc-200 hover:bg-zinc-700 transition-colors"
          >
            Insert {chapterLabel.toLowerCase()}
          </button>
        </div>
      )}
    </>
  )
}

// Visual indicator inside an 8px-wide chapter resize handle. The handle
// itself stays an invisible click-catcher; this child draws three short
// vertical lines (one centred at the divider, two flanking floaters) so
// the user can see where the grabbable edge is.
//
// Colour states (idle → hover → active drag):
//   idle    — subtle zinc neutrals
//   hover   — accent-400 (#c084fc) on the centre line, dimmer accent on floaters
//   active  — bright white centre, lighter white floaters
function ResizeGripIndicator({ active, hover, outer }) {
  let centre
  let side
  let centreOpacity = 1
  let sideOpacity = 1
  if (active) {
    centre = 'rgba(255, 255, 255, 0.85)'
    side = 'rgba(255, 255, 255, 0.6)'
  } else if (hover) {
    // Live user-set accent colour (Settings → Program Settings).
    // Solid CSS var; opacity applied via the element's `opacity` style
    // since CSS vars don't compose with rgba() inline.
    centre = 'var(--color-accent-400)'
    side = 'var(--color-accent-400)'
    centreOpacity = 0.95
    sideOpacity = 0.6
  } else {
    centre = 'rgba(161, 161, 170, 0.45)'
    side = 'rgba(161, 161, 170, 0.3)'
  }
  const common = {
    position: 'absolute',
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
    transition: 'left 0.12s ease-out',
  }
  // Centre line: bolder on hover/active. Inner dividers (between two
  // chapters) span the full row height; outer dividers (the leftmost and
  // rightmost edges of the chapter band) use the shorter 70% height so
  // they read as "edge of the band" rather than "separator inside it".
  //
  // Inner dividers sit on top of the chapter cell's `borderLeft` (a 1 px
  // line at handle-local x=4..5). To stay visually centred on that
  // border, the inner case treats x=4.5 as the visual midpoint instead
  // of x=4 — otherwise the right floater reads as closer to the centre
  // than the left floater, since the cell border adds visual weight on
  // the right side of our line.
  const visualMid = outer ? 4 : 4.5
  const centreWidth = hover || active ? 2 : 1
  const centreLeft = visualMid - centreWidth / 2
  const centreFullHeight = !outer
  // Floaters: equal gap from each EDGE of the centre line so visual
  // spacing stays symmetric regardless of centre thickness. Gap widens
  // on hover so the grip visibly "expands" outward when about to drag.
  const floaterGap = hover || active ? 4 : 2
  const floaterLeftLeft = visualMid - centreWidth / 2 - floaterGap - 1
  const floaterRightLeft = visualMid + centreWidth / 2 + floaterGap
  const centreStyle = centreFullHeight
    ? { ...common, left: centreLeft, top: 0, transform: 'none', width: centreWidth, height: '100%', backgroundColor: centre, opacity: centreOpacity }
    : { ...common, left: centreLeft, width: centreWidth, height: '70%', backgroundColor: centre, opacity: centreOpacity }
  return (
    <>
      <div style={centreStyle} />
      <div style={{ ...common, left: floaterLeftLeft, width: 1, height: '40%', backgroundColor: side, opacity: sideOpacity }} />
      <div style={{ ...common, left: floaterRightLeft, width: 1, height: '40%', backgroundColor: side, opacity: sideOpacity }} />
    </>
  )
}

// Lightweight wrapper that owns hover state for a single resize handle and
// renders the grip indicator inside. Centralises the hover-tracking logic
// so both the right-edge handles and the first-chapter-left-edge handle
// share the same behaviour without duplicating the useState/onMouseEnter
// dance per call site.
function ResizeHandle({ style, title, onMouseDown, onDoubleClick, onContextMenu, active, outer, dataHelpRegion }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      data-help-region={dataHelpRegion}
      style={style}
    >
      <ResizeGripIndicator active={active} hover={hover} outer={outer} />
    </div>
  )
}

// Shared style for every corner button in the header. Square, zinc-700
// background, subtle border and drop shadow, positioned at the given top
// offset and flush with the right edge (right: 8). Callers can spread
// additional overrides on top to tweak `right`, `color`, etc.
function cornerButtonStyle(top) {
  return {
    position: 'absolute',
    right: 8,
    top,
    width: ROW_BUTTON_SIZE,
    height: ROW_BUTTON_SIZE,
    borderRadius: 3,
    backgroundColor: 'rgba(63, 63, 70, 1)',
    color: '#d4d4d8',
    border: '1px solid rgba(82, 82, 91, 1)',
    cursor: 'pointer',
    pointerEvents: 'auto',
    fontSize: 14,
    lineHeight: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.4)',
    zIndex: 2,
  }
}
