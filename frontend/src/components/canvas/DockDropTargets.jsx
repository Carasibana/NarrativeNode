import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useAccentColor } from '../../utils/povConstants'
import { ROW_HEIGHT_PX } from './ChapterColumnsOverlay'
import {
  VERTICAL_TAB_WIDTH,
  VERTICAL_TAB_HEIGHT,
  HORIZONTAL_TAB_WIDTH,
  HORIZONTAL_TAB_HEIGHT,
  TOP_GAP,
  INTER_TAB_GAP,
  CONTROLS_OFFSET_PX,
} from './EditorToggleCorner'

/**
 * Dashed-outline drop targets shown during a tab-button drag.
 *
 * Subscribes to `uiStore.dragTabPanel`: when a tab is actively being
 * dragged (i.e. the click-vs-drag threshold has been crossed), this
 * paints drop-target placeholders at every valid drop position.
 *
 * Target layout depends on whether the destination zone already
 * hosts the OTHER panel's tab button:
 *
 *  - Empty destination zone → ONE drop target at the zone's natural
 *    tab-button slot. Drop joins the zone with whatever orientation
 *    that zone currently has.
 *  - Destination zone has an existing button → TWO drop targets:
 *      • "Adjacent" target — positioned where the second tab button
 *        actually stacks against the existing one. Drop here joins
 *        the zone with the zone's current orientation preference.
 *      • "Halfway" target — positioned at the midpoint along the
 *        zone's main axis (midheight for the right zone, midwidth
 *        for the bottom zone). Drop here forces the orientation
 *        that the midpoint visually suggests: right-midheight
 *        splits the column into top/bottom → stacked; bottom-midwidth
 *        splits the strip into left/right → side-by-side.
 *
 * Each placeholder carries `data-dock-target` (zone) and
 * `data-dock-orientation` (orientation) attributes so the drag-end
 * handler in the tab-button components can look the values up via
 * `document.elementFromPoint`.
 *
 * Colours derive from the story's accent colour so the drop-zone
 * outlines match the rest of the canvas chrome.
 */
export default function DockDropTargets() {
  const dragTabPanel = useUiStore((s) => s.dragTabPanel)
  const editorZone = useUiStore((s) => s.editorZone)
  const chatZone = useUiStore((s) => s.chatZone)
  const chapterHeaderCollapsed = useUiStore((s) => s.chapterHeaderCollapsed)
  const actsCollapsed = useUiStore((s) => s.chapterHeaderActsCollapsed)
  const chaptersCount = useProjectStore((s) => s.story?.chapters?.length || 0)
  const accentHex = useAccentColor() || '#7c3aed'

  if (!dragTabPanel) return null

  const draggedPanelZone = dragTabPanel === 'editor' ? editorZone : chatZone

  // Same chapter-overlay math as the tab-button corners so the
  // right-edge drop targets line up with the tab-button slots they
  // would replace.
  const fullyCollapsed = chapterHeaderCollapsed && chaptersCount === 0
  const showActsRow = !actsCollapsed && chaptersCount > 0
  const overlayHeight = fullyCollapsed
    ? 0
    : (showActsRow ? ROW_HEIGHT_PX * 2 : ROW_HEIGHT_PX)

  // Whether the OTHER panel's tab button (the one not being dragged) is
  // docked in each zone. Tab buttons live at their zone edge regardless
  // of whether the panel itself is open or collapsed — so the "is
  // another tab here?" check is purely about `zone`, NOT panel
  // open-state.
  const otherPanel = dragTabPanel === 'editor' ? 'chat' : 'editor'
  const otherZone = otherPanel === 'editor' ? editorZone : chatZone
  const otherInRight = otherZone === 'right'
  const otherInBottom = otherZone === 'bottom'

  // Total count of tab buttons currently docked in each zone. Includes
  // the dragged panel itself, so when both panels live in the same zone
  // the count is 2. Used to position the "adjacent" drop target at the
  // next-free slot past EVERY existing tab — so it never overlaps the
  // ones already drawn.
  const rightSlotCount = (editorZone === 'right' ? 1 : 0) + (chatZone === 'right' ? 1 : 0)
  const bottomSlotCount = (editorZone === 'bottom' ? 1 : 0) + (chatZone === 'bottom' ? 1 : 0)

  // Whether each zone is worth showing drop targets in.
  //   - Always show if the zone is NOT the dragged panel's current zone
  //     (moving across zones is the basic case).
  //   - Also show when both panels live in the same zone (dragging
  //     the panel inside its own zone is how the writer switches
  //     between side-by-side and stacked).
  const showRight = draggedPanelZone !== 'right' || otherInRight
  const showBottom = draggedPanelZone !== 'bottom' || otherInBottom

  // Tailwind hover class can't reference dynamic hex colours, so
  // hover state goes through inline `onMouseEnter` / `onMouseLeave`
  // handlers on each target instead — see `DropBox` below.

  return (
    <>
      {/* RIGHT ZONE drop targets. Shown when the dragged panel needs a
          drop target there (moving from another zone) OR when both
          panels live in the right zone (dragging inside the zone is
          how the writer switches between side-by-side and stacked). */}
      {showRight && (
        <>
          {/* Adjacent target — next-free slot past every tab button
              currently docked in the right zone. With both panels in
              the same zone this lands at slot 2 so the box never
              overlaps either existing tab. Drop here joins the zone
              with whatever orientation it currently has. */}
          <DropBox
            data-help-region="dock:drop_target"
            data-dock-target="right"
            data-dock-orientation="side-by-side"
            accentHex={accentHex}
            style={{
              right: 0,
              top: overlayHeight + TOP_GAP + rightSlotCount * (VERTICAL_TAB_HEIGHT + INTER_TAB_GAP),
              width: VERTICAL_TAB_WIDTH,
              height: VERTICAL_TAB_HEIGHT,
              borderTopLeftRadius: 6,
              borderBottomLeftRadius: 6,
              borderRight: 'none',
            }}
            ariaLabel="Drop here to dock to the right sidebar"
          />
          {/* Halfway (midheight) target — only when the drop would
              result in TWO panels sharing this zone. Drop here forces
              stacked orientation (the natural mental model of
              splitting the column top / bottom). */}
          {otherInRight && (
            <DropBox
              data-dock-target="right"
              data-dock-orientation="stacked"
              accentHex={accentHex}
              style={{
                right: 0,
                top: '50%',
                transform: 'translateY(-50%)',
                width: VERTICAL_TAB_WIDTH,
                height: VERTICAL_TAB_HEIGHT,
                borderTopLeftRadius: 6,
                borderBottomLeftRadius: 6,
                borderRight: 'none',
              }}
              ariaLabel="Drop here to dock to the right sidebar (stacked)"
            />
          )}
        </>
      )}

      {/* BOTTOM ZONE drop targets. Same shape as the right zone
          treatment above; flipped axis. */}
      {showBottom && (
        <>
          <DropBox
            data-dock-target="bottom"
            data-dock-orientation="stacked"
            accentHex={accentHex}
            style={{
              left: CONTROLS_OFFSET_PX + bottomSlotCount * (HORIZONTAL_TAB_WIDTH + INTER_TAB_GAP),
              bottom: 0,
              width: HORIZONTAL_TAB_WIDTH,
              height: HORIZONTAL_TAB_HEIGHT,
              borderTopLeftRadius: 6,
              borderTopRightRadius: 6,
              borderBottom: 'none',
            }}
            ariaLabel="Drop here to dock to the bottom"
          />
          {otherInBottom && (
            <DropBox
              data-dock-target="bottom"
              data-dock-orientation="side-by-side"
              accentHex={accentHex}
              style={{
                left: '50%',
                transform: 'translateX(-50%)',
                bottom: 0,
                width: HORIZONTAL_TAB_WIDTH,
                height: HORIZONTAL_TAB_HEIGHT,
                borderTopLeftRadius: 6,
                borderTopRightRadius: 6,
                borderBottom: 'none',
              }}
              ariaLabel="Drop here to dock to the bottom (side-by-side)"
            />
          )}
        </>
      )}
    </>
  )
}

// ── DropBox ──────────────────────────────────────────────────────
// Single drop-target box with hover state. Hover brightens the fill
// so the writer knows their cursor is on the active candidate. The
// `.nn-dock-target-pulse` class (defined in index.css) applies a slow
// accent-coloured box-shadow pulse so the visible drop zones gently
// guide the eye during a drag. The pulse colour is fed in through a
// `--dock-target-glow` CSS variable so each instance picks up the
// current story accent.
function DropBox({ accentHex, style, ariaLabel, ...dataAttrs }) {
  return (
    <div
      {...dataAttrs}
      aria-label={ariaLabel}
      className="nn-dock-target-pulse"
      style={{
        position: 'absolute',
        borderWidth: 2,
        borderStyle: 'dashed',
        borderColor: withAlpha(accentHex, 0.75),
        backgroundColor: withAlpha(accentHex, 0.10),
        pointerEvents: 'auto',
        zIndex: 6,
        transition: 'background-color 120ms',
        // CSS variable consumed by the `nn-dock-target-pulse` keyframes
        // so the glow tracks the story accent colour.
        '--dock-target-glow': withAlpha(accentHex, 0.55),
        ...style,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = withAlpha(accentHex, 0.30)
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = withAlpha(accentHex, 0.10)
      }}
    />
  )
}

// ── Helpers ──────────────────────────────────────────────────────
// Convert a `#rrggbb` hex string to an `rgba(...)` value with the
// supplied alpha (0-1). Returns the original string unchanged if
// the input isn't a 7-char hex.
function withAlpha(hex, alpha) {
  if (typeof hex !== 'string' || hex.length !== 7 || hex[0] !== '#') return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
