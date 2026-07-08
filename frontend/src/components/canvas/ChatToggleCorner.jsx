import { useCallback, useRef, useState } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useAccentColor } from '../../utils/povConstants'
import { useAiDisabled } from '../../hooks/useAiDisabled'
import { ROW_HEIGHT_PX } from './ChapterColumnsOverlay'
import DockContextMenu from '../panels/DockContextMenu'
import {
  VERTICAL_TAB_WIDTH,
  VERTICAL_TAB_HEIGHT,
  HORIZONTAL_TAB_WIDTH,
  HORIZONTAL_TAB_HEIGHT,
  TOP_GAP,
  INTER_TAB_GAP,
  CONTROLS_OFFSET_PX,
} from './EditorToggleCorner'

// Pixels of mouse travel during a mousedown→mouseup gesture that
// distinguish a slow click (toggle the panel) from a drag (dock to a
// drop target or silently cancel). Matches the value in
// `EditorToggleCorner`.
const DRAG_THRESHOLD_PX = 5

/**
 * AI Chat toggle tab.
 *
 * Sibling of `EditorToggleCorner`. Renders at the canvas's right edge
 * (vertical tab) or bottom edge (horizontal tab) depending on `chatZone`.
 * When the chat tab and the editor tab share an edge, the chat tab
 * stacks AFTER the editor tab — below it in the right zone, to its right
 * in the bottom zone — using the shared geometry constants exported
 * from `EditorToggleCorner`.
 *
 * Clicking toggles the chat panel; right-clicking opens the dock menu.
 */
export default function ChatToggleCorner() {
  const chatPanelOpen = useUiStore((s) => s.chatPanelOpen)
  const chatZone = useUiStore((s) => s.chatZone)
  const editorZone = useUiStore((s) => s.editorZone)
  const chapterHeaderCollapsed = useUiStore((s) => s.chapterHeaderCollapsed)
  const actsCollapsed = useUiStore((s) => s.chapterHeaderActsCollapsed)
  const chaptersCount = useProjectStore((s) => s.story?.chapters?.length || 0)
  const accentColor = useAccentColor()
  // Phase 5.7 — this is the "Show AI Chat panel" toggle; hide it when
  // AI integrations are disabled.
  const aiDisabled = useAiDisabled()

  // Right-click dock menu.
  const [menuPos, setMenuPos] = useState(null)
  const handleContextMenu = (e) => {
    e.preventDefault()
    setMenuPos({ x: e.clientX, y: e.clientY })
  }

  // Click-vs-drag handler (mirrors `EditorToggleCorner`): on mousedown
  // start a pending gesture; if the mouse moves past `DRAG_THRESHOLD_PX`
  // before mouseup, promote to a drag (which lights up the dashed
  // drop-target outlines via `dragTabPanel`). On mouseup, a drag
  // dispatches through the drop-target hit-test; a non-drag toggles the
  // panel.
  const dragRef = useRef(null)
  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startY: e.clientY, dragging: false }

    const onMove = (ev) => {
      const st = dragRef.current
      if (!st || st.dragging) return
      const dx = ev.clientX - st.startX
      const dy = ev.clientY - st.startY
      if ((dx * dx + dy * dy) >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        st.dragging = true
        useUiStore.getState().setDragTabPanel('chat')
      }
    }

    const onUp = (ev) => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      const st = dragRef.current
      dragRef.current = null
      if (!st) return
      if (st.dragging) {
        useUiStore.getState().setDragTabPanel(null)
        const targetEl = document.elementFromPoint(ev.clientX, ev.clientY)
        const targetContainer = targetEl?.closest?.('[data-dock-target]')
        const dockZone = targetContainer?.dataset?.dockTarget
        const dockOrient = targetContainer?.dataset?.dockOrientation
        if (dockZone === 'right' || dockZone === 'bottom') {
          const { rightZoneOrientation, bottomZoneOrientation } = useUiStore.getState()
          const orient = dockOrient
            || (dockZone === 'right' ? rightZoneOrientation : bottomZoneOrientation)
          useUiStore.getState().dockPanel('chat', dockZone, orient)
        }
        // else: released outside any target — silent cancel.
      } else {
        useUiStore.getState().toggleChatPanel()
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  // Same overlay-tracking rules as the editor tab so neither sits on top of
  // the chapter header overlay when docked to the right edge.
  if (aiDisabled) return null

  const fullyCollapsed = chapterHeaderCollapsed && chaptersCount === 0
  const showActsRow = !actsCollapsed && chaptersCount > 0
  const overlayHeight = fullyCollapsed
    ? 0
    : (showActsRow ? ROW_HEIGHT_PX * 2 : ROW_HEIGHT_PX)

  const fillColour = chatPanelOpen ? accentColor : 'rgb(39, 39, 42)' // zinc-800
  const borderColour = 'rgb(63, 63, 70)' // zinc-700
  const glyphColour = chatPanelOpen ? '#ffffff' : '#d4d4d8' // zinc-300

  // Stack position depends on whether the editor shares this edge. Editor is
  // always the "first" tab in a zone; chat stacks after it when they share.
  const isRightZone = chatZone === 'right'
  const editorOnSameEdge = editorZone === chatZone

  // Borders are defined as individual sides to avoid the React warning
  // about mixing the `border` shorthand with `borderRight: 'none'` /
  // `borderBottom: 'none'` longhand overrides when the variant flips.
  const sideBorder = `1px solid ${borderColour}`
  const tabStyle = isRightZone
    ? {
        // Vertical tab on right edge: rounded LEFT corners.
        right: 0,
        top: overlayHeight + TOP_GAP + (editorOnSameEdge ? VERTICAL_TAB_HEIGHT + INTER_TAB_GAP : 0),
        width: VERTICAL_TAB_WIDTH,
        height: VERTICAL_TAB_HEIGHT,
        borderTop: sideBorder,
        borderLeft: sideBorder,
        borderBottom: sideBorder,
        borderTopLeftRadius: 6,
        borderBottomLeftRadius: 6,
        borderTopRightRadius: 0,
        borderBottomRightRadius: 0,
      }
    : {
        // Horizontal tab on bottom edge: rounded TOP corners. Horizontal
        // position past the canvas Controls; shifts further right when the
        // editor is also on the bottom edge.
        left: CONTROLS_OFFSET_PX + (editorOnSameEdge ? HORIZONTAL_TAB_WIDTH + INTER_TAB_GAP : 0),
        bottom: 0,
        width: HORIZONTAL_TAB_WIDTH,
        height: HORIZONTAL_TAB_HEIGHT,
        borderTop: sideBorder,
        borderLeft: sideBorder,
        borderRight: sideBorder,
        borderTopLeftRadius: 6,
        borderTopRightRadius: 6,
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
      }

  return (
    <>
      <button
        type="button"
        data-help-region="dock:chat_toggle"
        onMouseDown={handleMouseDown}
        onContextMenu={handleContextMenu}
        title={`${chatPanelOpen ? 'Hide AI Chat panel' : 'Show AI Chat panel'}\n(drag or right click for layout)`}
        aria-label="Toggle AI Chat panel"
        className="absolute group transition-colors"
        style={{
          ...tabStyle,
          padding: 0,
          cursor: 'pointer',
          zIndex: 5,
          backgroundColor: fillColour,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Speech-bubble glyph — same shape in both orientations so the icon
            stays recognisable as "the Chat tab" regardless of which edge
            the tab is docked to. */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke={glyphColour}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ display: 'block' }}
        >
          <path d="M6 4 H18 A4 4 0 0 1 22 8 V12 A4 4 0 0 1 18 16 H11 L7 20 L8 16 H6 A4 4 0 0 1 2 12 V8 A4 4 0 0 1 6 4 Z" />
          <line x1="6" y1="9" x2="18" y2="9" />
          <line x1="6" y1="13" x2="15" y2="13" />
        </svg>
      </button>
      {menuPos && (
        <DockContextMenu
          panel="chat"
          position={menuPos}
          onClose={() => setMenuPos(null)}
        />
      )}
    </>
  )
}
