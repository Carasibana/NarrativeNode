import { useCallback, useRef } from 'react'
import { useUiStore } from '../../store/uiStore'
import RightSidebar from './RightSidebar'
import ChatPanel from './ChatPanel'
import PanelDivider from './PanelDivider'

const MIN_HEIGHT = 160
// The lower bound for the canvas height when the bottom zone is at max.
// Leaves room for the top-left toolbar (~50 px) + a usable canvas viewport
// (~230 px) so the undo / redo / "+" buttons never get pushed out of
// reach by an overgrown bottom zone. `getMaxHeight()` recomputes against
// the current viewport on every drag tick so the cap tracks window resizes.
const MIN_CANVAS_HEIGHT = 280
function getMaxHeight() {
  return Math.max(MIN_HEIGHT, window.innerHeight - MIN_CANVAS_HEIGHT)
}

// (No horizontal offset on the panel content itself — only the TAB BUTTONS
// docked at the bottom edge need to clear the React Flow `<Controls>` stack
// at the canvas's bottom-left corner. Those buttons are positioned in the
// canvas wrapper above the bottom zone, and they handle their own offset
// against the controls. The bottom-zone panel content lives BELOW the
// canvas, so it doesn't visually overlap the controls and uses the full
// width of the canvas column.)

// ── Top-edge resize handle ──────────────────────────────────────────────────
// Drag UP increases the bottom zone's height (the canvas shrinks).
function TopResizeHandle({ onResize }) {
  const dragging = useRef(false)
  const startY = useRef(0)
  const startHeight = useRef(0)

  const handleMouseDown = useCallback((e) => {
    e.preventDefault()
    dragging.current = true
    startY.current = e.clientY
    startHeight.current = useUiStore.getState().bottomZoneHeight

    function onMouseMove(ev) {
      if (!dragging.current) return
      const delta = startY.current - ev.clientY
      const newHeight = Math.min(getMaxHeight(), Math.max(MIN_HEIGHT, startHeight.current + delta))
      onResize(newHeight)
    }

    function onMouseUp() {
      dragging.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [onResize])

  return (
    <div
      data-help-region="dock-zones:bottom_resize"
      onMouseDown={handleMouseDown}
      className="absolute left-0 right-0 top-0 h-1.5 cursor-row-resize hover:bg-accent-700/40 transition-colors z-10"
    />
  )
}

// ── BottomZone ─────────────────────────────────────────────────────────────

/**
 * Phase 2.3a — horizontal-strip dock zone below the canvas.
 *
 * Only occupies vertical space when at least one tab button's panel is
 * docked to the 'bottom' zone (i.e. editorZone === 'bottom' && editorOpen,
 * and/or chatZone === 'bottom' && chatOpen). Returns null otherwise so the
 * canvas extends to the full height.
 *
 * Content area starts at `CONTROLS_OFFSET_PX` from the left so the React
 * Flow `<Controls>` stack at the canvas's bottom-left edge stays visible
 * and uncovered. Top edge is a resize handle.
 *
 * Hosts editor and/or chat panel content via `<RightSidebar zone="bottom">`
 * and `<ChatPanel zone="bottom">` — those components return null when
 * their stored zone doesn't match the prop, so this wrapper just composes
 * them and lets each one self-select whether to paint.
 */
export default function BottomZone() {
  const editorZone = useUiStore((s) => s.editorZone)
  const chatZone = useUiStore((s) => s.chatZone)
  const editorOpen = useUiStore((s) => s.rightSidebarOpen)
  const chatOpen = useUiStore((s) => s.chatPanelOpen)
  const height = useUiStore((s) => s.bottomZoneHeight)
  const setHeight = useUiStore((s) => s.setBottomZoneHeight)
  const orientation = useUiStore((s) => s.bottomZoneOrientation)
  const editorShare = useUiStore((s) => s.bottomZoneEditorShare)
  const setEditorShare = useUiStore((s) => s.setBottomZoneEditorShare)

  const editorInBottom = editorZone === 'bottom' && editorOpen
  const chatInBottom = chatZone === 'bottom' && chatOpen
  const bothInBottom = editorInBottom && chatInBottom

  // Orientation determines how two panels share the zone. Side-by-side
  // arranges them as columns within the horizontal strip (divider is a
  // vertical bar between them); stacked arranges them as rows (divider
  // is a horizontal bar between them).
  const isStacked = orientation === 'stacked' && bothInBottom
  const flexDir = isStacked ? 'flex-col' : 'flex-row'
  const dividerOrientation = isStacked ? 'horizontal' : 'vertical'

  // useRef + useCallback MUST run before the early-return below — Rules of
  // Hooks: hook calls cannot be conditional on render path. Otherwise the
  // first render with nothing docked here skips both hooks, and the next
  // render (after a panel docks) calls them for the first time, triggering
  // "Rendered more hooks than during the previous render."
  const innerRef = useRef(null)
  const handleDividerDrag = useCallback((ev) => {
    const el = innerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let fraction
    if (isStacked) {
      fraction = (ev.clientY - rect.top) / rect.height
    } else {
      fraction = (ev.clientX - rect.left) / rect.width
    }
    // Clamp so neither panel collapses fully.
    const clamped = Math.min(0.9, Math.max(0.1, fraction))
    setEditorShare(clamped)
  }, [isStacked, setEditorShare])

  // Collapse to zero vertical space when nothing is docked here.
  if (!editorInBottom && !chatInBottom) return null

  // Only pass share values when both panels share the zone; a solo
  // panel uses its default flex-1 sizing.
  const editorShareProp = bothInBottom ? editorShare : undefined
  const chatShareProp = bothInBottom ? Math.max(0.01, 1 - editorShare) : undefined

  return (
    <div
      data-help-region="dock-zones:bottom_zone"
      className="relative flex-shrink-0 bg-zinc-900 border-t border-zinc-700"
      style={{ height }}
    >
      <TopResizeHandle onResize={setHeight} />
      <div ref={innerRef} className={`absolute inset-0 flex ${flexDir}`}>
        <RightSidebar zone="bottom" share={editorShareProp} />
        {bothInBottom && (
          <PanelDivider orientation={dividerOrientation} onDrag={handleDividerDrag} dataHelpRegion="dock-zones:panel_divider" />
        )}
        <ChatPanel zone="bottom" share={chatShareProp} />
      </div>
    </div>
  )
}
