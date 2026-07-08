import { useCallback, useRef } from 'react'
import { useUiStore } from '../../store/uiStore'
import RightSidebar from './RightSidebar'
import ChatPanel from './ChatPanel'
import PanelDivider from './PanelDivider'

// Same width constraints as the standalone right-sidebar editor panel
// so the zone width feels consistent whether it's hosting one or both
// panels.
const MIN_WIDTH = 280
const MIN_CANVAS_WIDTH = 320
function getMaxWidth() {
  return Math.max(MIN_WIDTH, window.innerWidth - MIN_CANVAS_WIDTH)
}

// Left-edge resize handle for the shared-zone container. Drags
// `rightSidebarWidth` (which doubles as the right-zone container's total
// width when both panels are docked here) so the zone gets wider or
// narrower as the writer pulls the handle left/right.
function ZoneLeftResizeHandle() {
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const handleMouseDown = useCallback((e) => {
    e.preventDefault()
    dragging.current = true
    startX.current = e.clientX
    startWidth.current = useUiStore.getState().rightSidebarWidth

    function onMouseMove(ev) {
      if (!dragging.current) return
      const delta = startX.current - ev.clientX
      const newWidth = Math.min(getMaxWidth(), Math.max(MIN_WIDTH, startWidth.current + delta))
      useUiStore.getState().setRightSidebarWidth(newWidth)
    }

    function onMouseUp() {
      dragging.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  return (
    <div
      data-help-region="dock-zones:right_resize"
      onMouseDown={handleMouseDown}
      className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-accent-700/40 transition-colors z-10"
    />
  )
}

/**
 * Phase 2.3a — right-sidebar dock zone.
 *
 * When both panels are docked to the right zone (any orientation), this
 * wraps them in a single shared container whose width is governed by
 * `rightSidebarWidth`. The container's left-edge resize handle is the
 * one and only control for the overall zone width; the inner
 * `PanelDivider` controls the editor / chat split as a fraction of that
 * width (side-by-side) or height (stacked). Neither inner panel keeps
 * its own width state in shared mode — the share fraction is
 * authoritative.
 *
 * When only one panel is in the right zone, that panel renders solo
 * with its own width state and its own left-edge resize handle.
 */
export default function RightZone() {
  const editorZone = useUiStore((s) => s.editorZone)
  const chatZone = useUiStore((s) => s.chatZone)
  const editorOpen = useUiStore((s) => s.rightSidebarOpen)
  const chatOpen = useUiStore((s) => s.chatPanelOpen)
  const orientation = useUiStore((s) => s.rightZoneOrientation)
  const rightSidebarWidth = useUiStore((s) => s.rightSidebarWidth)
  const editorShare = useUiStore((s) => s.rightZoneEditorShare)
  const setEditorShare = useUiStore((s) => s.setRightZoneEditorShare)

  const editorInRight = editorZone === 'right' && editorOpen
  const chatInRight = chatZone === 'right' && chatOpen
  const bothInRight = editorInRight && chatInRight

  // Hooks must run unconditionally before any early return (Rules of Hooks).
  const innerRef = useRef(null)
  const handleDividerDrag = useCallback((ev) => {
    const el = innerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // Side-by-side uses horizontal drag; stacked uses vertical.
    const fraction = orientation === 'stacked'
      ? (ev.clientY - rect.top) / rect.height
      : (ev.clientX - rect.left) / rect.width
    const clamped = Math.min(0.9, Math.max(0.1, fraction))
    setEditorShare(clamped)
  }, [orientation, setEditorShare])

  if (!editorInRight && !chatInRight) return null

  // Both panels present — shared container regardless of orientation.
  // Orientation determines flex direction and divider orientation;
  // share controls the split.
  if (bothInRight) {
    const chatShare = Math.max(0.01, 1 - editorShare)
    const isStacked = orientation === 'stacked'
    const flexDir = isStacked ? 'flex-col' : 'flex-row'
    const dividerOrient = isStacked ? 'horizontal' : 'vertical'
    return (
      <div
        ref={innerRef}
        data-help-region="dock-zones:right_zone"
        className={`relative flex-shrink-0 flex ${flexDir} h-full bg-zinc-900 border-l border-zinc-700`}
        style={{ width: rightSidebarWidth }}
      >
        <ZoneLeftResizeHandle />
        <RightSidebar zone="right" share={editorShare} />
        <PanelDivider orientation={dividerOrient} onDrag={handleDividerDrag} dataHelpRegion="dock-zones:panel_divider" />
        <ChatPanel zone="right" share={chatShare} />
      </div>
    )
  }

  // Only one panel docked to the right zone — render it solo with its
  // own width state and resize handle (legacy behaviour for the
  // single-panel case).
  return (
    <>
      <RightSidebar zone="right" />
      <ChatPanel zone="right" />
    </>
  )
}
