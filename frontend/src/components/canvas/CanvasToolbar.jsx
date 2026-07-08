import { useCallback, useEffect, useRef, useState } from 'react'
import { Panel, useReactFlow, useStore } from '@xyflow/react'
import { useProjectStore } from '../../store/projectStore'
import { useUiStore } from '../../store/uiStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useMcpControlStore } from '../../store/mcpControlStore'
import { buildHandlePositionMap } from '../../utils/wireTidyUtils'
import AddNodesMenuBody from './AddNodesMenuBody'

export default function CanvasToolbar() {
  const tidyWires         = useProjectStore((s) => s.tidyWires)
  // Phase 1.22j — Tidy Wires button is gated behind the
  // dev_show_tidy_wires_button preference. Truthy = show. Hidden
  // by default because the current implementation isn't shippable
  // yet; toggled on from the Dev Settings tab in the Dev Preview
  // panel for users who want to opt in.
  const showTidyWires     = useSettingsStore((s) => !!s.preferences?.dev_show_tidy_wires_button)
  const undo              = useProjectStore((s) => s.undo)
  const redo              = useProjectStore((s) => s.redo)
  const canUndo           = useProjectStore((s) => s.history.length > 0)
  const canRedo           = useProjectStore((s) => s.future.length > 0)
  const chaptersCount     = useProjectStore((s) => s.story?.chapters?.length || 0)
  const actsCollapsed     = useUiStore((s) => s.chapterHeaderActsCollapsed)
  const chapterHeaderCollapsed = useUiStore((s) => s.chapterHeaderCollapsed)
  const { getNodes, getInternalNode } = useReactFlow()

  // Phase 4.3 — layout-mode toggle. `canvasLayoutMode` is per-story; the
  // toggle is disabled with < 2 chapters (rows are meaningless). On the
  // first enable (no `chapter_rows` yet) we auto-wrap to the viewport
  // width at React Flow's furthest zoom-out (`minZoom`), so the strip
  // wraps to what fits on screen when fully zoomed out.
  const canvasLayoutMode  = useProjectStore((s) => s.story?.canvas_layout_mode || 'single')
  const hasChapterRows    = useProjectStore((s) => Array.isArray(s.story?.chapter_rows) && s.story.chapter_rows.length > 0)
  const setCanvasLayoutMode = useProjectStore((s) => s.setCanvasLayoutMode)
  const minZoom           = useStore((s) => s.minZoom)
  // The layout toggle is LOCKED while an MCP session is active: a session runs
  // the canvas in single-row (concept-group placement is only correct there),
  // and the layout guard restores the prior mode when the session ends, so the
  // user must not flip modes mid-session.
  const mcpSessionActive  = useMcpControlStore((s) => s.sessionState === 'active')

  const handleToggleLayout = useCallback(() => {
    if (chaptersCount < 2 || mcpSessionActive) return
    const target = canvasLayoutMode === 'multi' ? 'single' : 'multi'
    if (target === 'multi' && !hasChapterRows) {
      const z = minZoom || 0.5
      const screenW = typeof window !== 'undefined' ? window.innerWidth : 1600
      setCanvasLayoutMode('multi', { wrapWidth: screenW / z })
    } else {
      setCanvasLayoutMode(target)
    }
    // Recentering is handled by setCanvasLayoutMode's requestPovFocus → the
    // Canvas re-centres on the POV origin at 100% zoom (or leaves the viewport
    // alone when there's no POV origin). We must NOT also fitView here: it runs
    // a frame later and would override that recenter with a fit-to-all-nodes.
  }, [chaptersCount, canvasLayoutMode, hasChapterRows, minZoom, setCanvasLayoutMode, mcpSessionActive])

  // Push the toolbar below the ChapterColumnsOverlay header. The overlay
  // renders as a 2-row strip when there are chapters and the Acts row is
  // expanded, or as a 1-row strip otherwise (acts collapsed, or no chapters
  // yet). Row height = 36 px (see `ROW_HEIGHT_PX` in ChapterColumnsOverlay,
  // which matches the sidebar's py-1.5 text-xs border-b tab rows as they
  // render through the sidebar's `zoom: 1.25` CSS scale). 4 px extra gap
  // keeps the toolbar visually separated from the header's bottom border.
  // Bug 3: when the entire overlay is hidden (only valid while there are
  // zero chapters), the toolbar shifts all the way up to the top of the
  // canvas area by treating the header as 0 px tall.
  const fullyCollapsed = chapterHeaderCollapsed && chaptersCount === 0
  const headerHeight = fullyCollapsed
    ? 0
    : (chaptersCount > 0 && !actsCollapsed ? 72 : 36)
  const toolbarTop = headerHeight + 4

  const [menuOpen, setMenuOpen] = useState(false)
  const btnRef = useRef(null)

  const handleToggleMenu = useCallback(() => {
    setMenuOpen((v) => !v)
  }, [])

  const closeMenu = useCallback(() => setMenuOpen(false), [])

  return (
    <Panel position="top-left" style={{ top: toolbarTop }}>
      <div className="flex flex-col items-start">
      <div className="flex gap-2 items-center">
        {/* Circular + button, with Tidy Wires dot tucked to its right */}
        <div className="relative flex items-center gap-1">
          <button
            ref={btnRef}
            onClick={handleToggleMenu}
            data-help-region="canvas-overview:add_to_canvas"
            title="Add to canvas"
            className={`w-8 h-8 rounded-full flex items-center justify-center shadow transition-colors ${
              menuOpen
                ? 'bg-accent-600 text-white'
                : 'bg-accent-700 hover:bg-accent-600 text-white'
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              <line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </button>

          {/* Tidy Wires — gated behind dev_show_tidy_wires_button user
              preference (Phase 1.22j). Hidden by default because the
              implementation isn't shippable yet. Toggle on in the Dev
              Settings tab in the Dev Preview panel. */}
          {showTidyWires && (
            <button
              onClick={() => {
                const edges = useProjectStore.getState().edges
                tidyWires(getNodes(), buildHandlePositionMap(edges, getInternalNode))
              }}
              title="Tidy Wires (experimental — quality not yet sufficient for general use)"
              className="w-5 h-5 rounded-full flex items-center justify-center shadow transition-colors bg-zinc-700 hover:bg-zinc-600 text-zinc-300 hover:text-zinc-100"
            >
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                {/* Two stacked right-angle wire routes suggesting "tidy" */}
                <path d="M1.5 3 H5 V9 H10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M1.5 6 H7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          )}

          {menuOpen && (
            <AddMenu onClose={closeMenu} btnRef={btnRef} />
          )}
        </div>

        {/* Undo / Redo */}
        <div className="flex gap-1 ml-1" data-help-region="canvas-overview:undo_redo">
          <button
            onClick={undo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            className={`px-2 py-1.5 text-sm rounded shadow transition-colors flex items-center justify-center ${
              canUndo
                ? 'bg-zinc-700 text-zinc-200 hover:bg-zinc-600'
                : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 4 L2 7 L5 10" />
              <path d="M2 7 L9 7 A3 3 0 0 1 12 10 L12 11" />
            </svg>
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            title="Redo (Ctrl+Y / Ctrl+Shift+Z)"
            className={`px-2 py-1.5 text-sm rounded shadow transition-colors flex items-center justify-center ${
              canRedo
                ? 'bg-zinc-700 text-zinc-200 hover:bg-zinc-600'
                : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 4 L12 7 L9 10" />
              <path d="M12 7 L5 7 A3 3 0 0 0 2 10 L2 11" />
            </svg>
          </button>
        </div>
      </div>

      {/* Phase 4.3 — layout-mode toggle. A separate element directly below
          the circular "+" button (left-aligned), 12 px below it (mt-3,
          matching the +→Undo horizontal offset). Disabled with < 2
          chapters. Highlighted when multi-row is active. */}
      <button
        data-help-region="canvas-overview:layout_mode"
        onClick={handleToggleLayout}
        disabled={chaptersCount < 2 || mcpSessionActive}
        title={
          mcpSessionActive
            ? 'Layout is locked to single-row during an MCP session (it restores when the session ends)'
            : chaptersCount < 2
              ? 'Row layout needs at least 2 chapters'
              : canvasLayoutMode === 'multi'
                ? 'Switch to single-row layout'
                : 'Switch to multi-row layout'
        }
        className={`w-8 h-8 mt-3 rounded flex items-center justify-center shadow transition-colors ${
          (chaptersCount < 2 || mcpSessionActive)
            ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
            : canvasLayoutMode === 'multi'
              ? 'bg-accent-700 hover:bg-accent-600 text-white'
              : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200'
        }`}
        aria-pressed={canvasLayoutMode === 'multi'}
      >
        {/* The glyph reflects the CURRENT layout: a single row of chapter
            cells in single-row mode, the two-row wrapped grid in multi-row.
            Segmented cells (not full-width bars) so neither reads as the
            hamburger-menu icon. */}
        {canvasLayoutMode === 'multi' ? (
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
            <rect x="1"  y="3" width="4" height="4" rx="1" />
            <rect x="6"  y="3" width="4" height="4" rx="1" />
            <rect x="11" y="3" width="4" height="4" rx="1" />
            <rect x="1"  y="9" width="4" height="4" rx="1" />
            <rect x="6"  y="9" width="4" height="4" rx="1" />
            <rect x="11" y="9" width="4" height="4" rx="1" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
            <rect x="1"  y="6" width="4" height="4" rx="1" />
            <rect x="6"  y="6" width="4" height="4" rx="1" />
            <rect x="11" y="6" width="4" height="4" rx="1" />
          </svg>
        )}
      </button>
      </div>
    </Panel>
  )
}

// ── Add menu (dropdown from + button) ────────────────────────────────────────
// Thin positioned wrapper around the shared `AddNodesMenuBody`. Only
// handles outside-click / Escape dismissal — all button content lives in
// the shared body so this dropdown and the canvas right-click context
// menu can't drift out of sync.

function AddMenu({ onClose, btnRef }) {
  const menuRef = useRef(null)

  useEffect(() => {
    function handler(e) {
      if (menuRef.current && !menuRef.current.contains(e.target) &&
          btnRef.current && !btnRef.current.contains(e.target)) {
        onClose()
      }
    }
    document.addEventListener('pointerdown', handler, { capture: true })
    return () => document.removeEventListener('pointerdown', handler, { capture: true })
  }, [onClose, btnRef])

  useEffect(() => {
    function handler(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      ref={menuRef}
      className="absolute left-0 top-full mt-1 bg-zinc-800 border border-zinc-600 rounded shadow-xl py-1 min-w-[200px] text-xs z-50"
    >
      <AddNodesMenuBody flowPosition={null} onClose={onClose} />
    </div>
  )
}
