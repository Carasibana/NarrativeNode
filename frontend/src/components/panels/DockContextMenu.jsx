import { useEffect, useRef } from 'react'
import { useUiStore } from '../../store/uiStore'

/**
 * Right-click dock destination menu.
 *
 * Renders a floating menu at `position` with the four zone+orientation
 * pairings ("Dock to right sidebar", "Dock to right sidebar (stacked)",
 * "Dock to bottom", "Dock to bottom (stacked)") -- minus the current
 * pairing for the given panel, so 3 options are visible at any time.
 * Side-by-side is the implicit default for both zones; "(stacked)"
 * is the explicit alternative.
 *
 * Props:
 *   - panel: 'editor' | 'chat'
 *   - position: { x, y } in viewport coordinates
 *   - onClose: () => void
 */
export default function DockContextMenu({ panel, position, onClose }) {
  const menuRef = useRef(null)

  const editorZone = useUiStore((s) => s.editorZone)
  const chatZone = useUiStore((s) => s.chatZone)
  const rightZoneOrientation = useUiStore((s) => s.rightZoneOrientation)
  const bottomZoneOrientation = useUiStore((s) => s.bottomZoneOrientation)
  const dockPanel = useUiStore((s) => s.dockPanel)

  // Current zone + orientation for this panel determines which option is
  // omitted. The "current orientation" of the panel's current zone is the
  // pairing the menu hides.
  const currentZone = panel === 'editor' ? editorZone : chatZone
  const currentOrientation = currentZone === 'right' ? rightZoneOrientation : bottomZoneOrientation

  // Close on outside click / Escape.
  useEffect(() => {
    function handleOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose()
    }
    function handleKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const options = [
    { zone: 'right',  orientation: 'side-by-side', label: 'Dock to right sidebar' },
    { zone: 'right',  orientation: 'stacked',      label: 'Dock to right sidebar (stacked)' },
    { zone: 'bottom', orientation: 'side-by-side', label: 'Dock to bottom' },
    { zone: 'bottom', orientation: 'stacked',      label: 'Dock to bottom (stacked)' },
  ].filter((o) => !(o.zone === currentZone && o.orientation === currentOrientation))

  const handlePick = (zone, orientation) => {
    dockPanel(panel, zone, orientation)
    onClose()
  }

  // Clamp the menu inside the viewport. The tab buttons sit on the right
  // edge of the canvas — so when the right sidebar is closed, a right-click
  // on a tab button gives a click x near `window.innerWidth`. Without
  // clamping, the menu's left edge anchors there and the whole menu paints
  // off-screen to the right. Same idea for the bottom edge.
  // Rough menu dimensions: min-width 220px + 1px border + small padding =
  // ~232px; each row ~28px + 8px container padding for 3 rows = ~92px.
  const MENU_MAX_WIDTH = 240
  const ROW_HEIGHT = 28
  const menuHeight = options.length * ROW_HEIGHT + 8
  const MARGIN = 4
  const clampedX = Math.max(
    MARGIN,
    Math.min(position.x, window.innerWidth - MENU_MAX_WIDTH - MARGIN)
  )
  const clampedY = Math.max(
    MARGIN,
    Math.min(position.y, window.innerHeight - menuHeight - MARGIN)
  )

  return (
    <div
      ref={menuRef}
      data-help-region="dock-menu:menu"
      className="fixed z-50 bg-zinc-800 border border-zinc-600 rounded shadow-xl py-1 min-w-[220px] text-xs"
      style={{ left: clampedX, top: clampedY }}
      role="menu"
    >
      {options.map((o) => (
        <button
          key={`${o.zone}-${o.orientation}`}
          type="button"
          role="menuitem"
          data-help-region="dock-menu:dock_option"
          onClick={() => handlePick(o.zone, o.orientation)}
          className="block w-full text-left px-3 py-1.5 text-zinc-200 hover:bg-zinc-700 transition-colors"
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
