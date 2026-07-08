import { useCallback } from 'react'

/**
 * Shared divider line between two panels sharing a dock zone.
 *
 * Renders a 3 px-thick solid line in zinc-600. Direction switches with
 * `orientation`:
 *   - `orientation === 'vertical'`: 3 px-wide bar separating side-by-side panels.
 *   - `orientation === 'horizontal'`: 3 px-tall bar separating stacked panels.
 *
 * When `onDrag` is provided, the divider becomes interactive: a
 * mousedown initiates a drag that calls `onDrag(event)` on every
 * mousemove. The cursor flips to col-resize / row-resize and a small
 * hover hit area on either side of the visible line makes the divider
 * easier to grab than a 3 px target. The parent decides what to do
 * with the drag event (typically reads `event.clientX` / `event.clientY`
 * against the container's bounds and updates a split fraction in
 * uiStore).
 */
export default function PanelDivider({ orientation, onDrag, dataHelpRegion }) {
  const isHorizontal = orientation === 'horizontal'
  const draggable = typeof onDrag === 'function'

  const handleMouseDown = useCallback((e) => {
    if (!draggable) return
    e.preventDefault()
    function onMouseMove(ev) {
      onDrag(ev)
    }
    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = isHorizontal ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [draggable, isHorizontal, onDrag])

  // Visible line: 3 px solid zinc-600.
  // Hit area: when draggable, extend the interactive zone ±3 px outward
  // using an absolute-positioned overlay so the user doesn't have to
  // land precisely on the 3 px stripe to grab it.
  const sizeClass = isHorizontal ? 'h-[3px] w-full' : 'w-[3px] h-full'
  const cursorClass = draggable
    ? (isHorizontal ? 'cursor-row-resize' : 'cursor-col-resize')
    : ''

  // When draggable, the divider's z-index is bumped above the zone's own
  // resize handle (`z-10`). Without this, a horizontal divider that spans
  // the full container width would have its leftmost ~6 px obscured by
  // the right-zone's left-edge `ZoneLeftResizeHandle`, so a click near
  // the divider's left end would resize the zone width instead of the
  // intended split fraction. Giving the divider `z-20` makes it win the
  // overlap, while the resize handle still owns the rest of its column
  // above and below the divider.
  const zClass = draggable ? 'z-20' : ''

  return (
    <div
      data-help-region={dataHelpRegion}
      className={`${sizeClass} bg-zinc-600 flex-shrink-0 relative ${cursorClass} ${zClass} hover:bg-accent-700/60 transition-colors`}
      onMouseDown={handleMouseDown}
    >
      {draggable && (
        <div
          className={
            isHorizontal
              ? 'absolute inset-x-0 -top-1 -bottom-1'
              : 'absolute inset-y-0 -left-1 -right-1'
          }
        />
      )}
    </div>
  )
}
