import { useCallback, useRef, useState } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useAccentColor } from '../../utils/povConstants'
import { ROW_HEIGHT_PX } from './ChapterColumnsOverlay'
import DockContextMenu from '../panels/DockContextMenu'

// Pixels of mouse travel during a mousedown→mouseup gesture that
// distinguish a slow click (release → toggle the panel) from a drag
// (release → dock to drop target or silently cancel).
const DRAG_THRESHOLD_PX = 5

// Tab geometry constants shared with ChatToggleCorner so the two tabs stack
// cleanly when they share an edge. Vertical tabs (right zone) are narrow and
// tall; horizontal tabs (bottom zone) are short and wide, with the long axis
// rotated so they read as anchored to the bottom edge.
const VERTICAL_TAB_WIDTH = 28
const VERTICAL_TAB_HEIGHT = 32
const HORIZONTAL_TAB_WIDTH = 32
const HORIZONTAL_TAB_HEIGHT = 28
const TOP_GAP = 6           // gap below the chapter overlay before the first right-edge tab
const INTER_TAB_GAP = 4     // gap between two tabs sharing the same edge
// Horizontal offset that pushes the first bottom-edge tab past the React Flow
// `<Controls>` stack at the canvas's bottom-left corner. Must match the
// `CONTROLS_OFFSET_PX` used by `BottomZone` so the buttons line up with the
// zone's content area.
const CONTROLS_OFFSET_PX = 56

/**
 * Editor toggle tab.
 *
 * A small bookmark-style tab anchored to the edge of the canvas matching
 * the editor panel's current dock zone:
 *   - `editorZone === 'right'`: vertical tab on the canvas's right edge
 *     (rounded LEFT corners, narrow + tall), sitting just below the
 *     chapter overlay.
 *   - `editorZone === 'bottom'`: horizontal tab on the canvas's bottom
 *     edge (rounded TOP corners, short + wide), horizontally offset past
 *     the React Flow `<Controls>` stack so the zoom / fit / snap-to-grid
 *     buttons stay visible.
 *
 * When both Editor and Chat tabs share an edge, Editor is the "first"
 * tab (topmost in the right zone, leftmost in the bottom zone) and Chat
 * stacks after it. The other tab's zone is read here so layout can adapt
 * automatically as the writer moves panels around.
 *
 * Clicking toggles the editor panel open/closed in its current zone.
 * Right-clicking opens the dock context menu.
 */
export default function EditorToggleCorner() {
  const rightSidebarOpen = useUiStore((s) => s.rightSidebarOpen)
  const editorZone = useUiStore((s) => s.editorZone)
  const chapterHeaderCollapsed = useUiStore((s) => s.chapterHeaderCollapsed)
  const actsCollapsed = useUiStore((s) => s.chapterHeaderActsCollapsed)
  const chaptersCount = useProjectStore((s) => s.story?.chapters?.length || 0)
  const accentColor = useAccentColor()

  // Right-click dock menu.
  const [menuPos, setMenuPos] = useState(null)
  const handleContextMenu = (e) => {
    e.preventDefault()
    setMenuPos({ x: e.clientX, y: e.clientY })
  }

  // Click-vs-drag handler. A mousedown starts a pending gesture; if the
  // mouse moves past DRAG_THRESHOLD_PX before mouseup, the gesture is
  // promoted to a drag and `dragTabPanel` flips on so `<DockDropTargets>`
  // paints its dashed outlines. On mouseup, a drag dispatches through
  // the drop-target hit-test, while a non-drag toggles the panel.
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
        useUiStore.getState().setDragTabPanel('editor')
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
          // The drop target's explicit `data-dock-orientation` wins —
          // halfway / forced-orientation targets carry their specific
          // orientation; adjacent targets carry the zone's current
          // orientation. Fall back to live store state if a future
          // target ever omits the attribute.
          const { rightZoneOrientation, bottomZoneOrientation } = useUiStore.getState()
          const orient = dockOrient
            || (dockZone === 'right' ? rightZoneOrientation : bottomZoneOrientation)
          useUiStore.getState().dockPanel('editor', dockZone, orient)
        }
        // else: released outside any target — silent cancel, no toggle.
      } else {
        // Click without drag — toggle the panel.
        useUiStore.getState().toggleRightSidebar()
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  // Match the chapters-bar overlay's own visibility rules so the right-edge
  // tab never sits ON TOP of the chapter header. Mirrors ChapterColumnsOverlay's
  // `fullyCollapsed` short-circuit and its `showActsRow` / `totalHeaderHeight`
  // math.
  const fullyCollapsed = chapterHeaderCollapsed && chaptersCount === 0
  const showActsRow = !actsCollapsed && chaptersCount > 0
  const overlayHeight = fullyCollapsed
    ? 0
    : (showActsRow ? ROW_HEIGHT_PX * 2 : ROW_HEIGHT_PX)

  const fillColour = rightSidebarOpen ? accentColor : 'rgb(39, 39, 42)' // zinc-800
  const borderColour = 'rgb(63, 63, 70)' // zinc-700
  const glyphColour = rightSidebarOpen ? '#ffffff' : '#d4d4d8' // zinc-300

  // Position + shape vary by zone. Editor is always the "first" tab in its
  // zone (no stacking offset needed regardless of chat's zone).
  const isRightZone = editorZone === 'right'
  // Borders are defined as individual sides (not the shorthand `border`)
  // because each zone variant intentionally OMITS one side (right when
  // anchored to the canvas right edge, bottom when anchored to the canvas
  // bottom edge). Mixing `border: 1px solid X` shorthand with `borderRight:
  // 'none'` longhand triggers React's "Removing a style property during
  // rerender (borderRight) when a conflicting property is set (border)"
  // warning when the variant flips between renders.
  const sideBorder = `1px solid ${borderColour}`
  const tabStyle = isRightZone
    ? {
        // Vertical tab on right edge: rounded LEFT corners, right edge flush
        // with canvas right edge (no border-right).
        right: 0,
        top: overlayHeight + TOP_GAP,
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
        // Horizontal tab on bottom edge: rounded TOP corners, bottom edge
        // flush with canvas bottom edge (no border-bottom). Horizontal
        // position past the `<Controls>` stack.
        left: CONTROLS_OFFSET_PX,
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
        data-help-region="dock:editor_toggle"
        onMouseDown={handleMouseDown}
        onContextMenu={handleContextMenu}
        title={`${rightSidebarOpen ? 'Hide Editor panel' : 'Show Editor panel'}\n(drag or right click for layout)`}
        aria-label="Toggle Editor panel"
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
        {/* Pencil glyph — centred inside the tab. Same glyph in both zones;
            the tab geometry around it changes but the icon stays the same
            so it remains recognisable as "the Editor tab." */}
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
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      </button>
      {menuPos && (
        <DockContextMenu
          panel="editor"
          position={menuPos}
          onClose={() => setMenuPos(null)}
        />
      )}
    </>
  )
}

// Re-export shared geometry constants so ChatToggleCorner can stack its tab
// against the editor tab without duplicating the magic numbers.
export {
  VERTICAL_TAB_WIDTH,
  VERTICAL_TAB_HEIGHT,
  HORIZONTAL_TAB_WIDTH,
  HORIZONTAL_TAB_HEIGHT,
  TOP_GAP,
  INTER_TAB_GAP,
  CONTROLS_OFFSET_PX,
}
