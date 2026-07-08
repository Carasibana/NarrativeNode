/**
 * Phase 1.20 shared port-DOM measurement helper.
 *
 * Given a React Flow handle element, returns `{ portalTarget, centerX,
 * centerY }` where the centre coordinates are in the closest
 * `.react-flow__node` wrapper's local coordinate space (i.e. the coord
 * space an `absolute; left:` child of that wrapper uses). Both the reject X
 * overlay in `PortHandle` and the drag-preview tooltip in `DragTooltip`
 * share this measurement so their positioning logic stays consistent.
 *
 * Implementation: read `getBoundingClientRect` for both the handle and the
 * node wrapper, then divide the screen delta by the current zoom scale
 * (derived from `wrapperRect.width / wrapperOffsetWidth`). CSS transforms
 * on the handle (chip ports use `translateY(-50%)`; React Flow defaults use
 * `translate(-50%, -50%)`) are already folded into the rects returned by
 * `getBoundingClientRect`, so no extra matrix parsing is needed.
 */
export function measureHandlePosition(handleEl) {
  if (!handleEl) return null
  const nodeWrapper = handleEl.closest('.react-flow__node')
  if (!nodeWrapper) return null
  const handleRect = handleEl.getBoundingClientRect()
  const wrapperRect = nodeWrapper.getBoundingClientRect()
  const wrapperOffsetWidth = nodeWrapper.offsetWidth || 1
  const scale = (wrapperRect.width / wrapperOffsetWidth) || 1
  return {
    portalTarget: nodeWrapper,
    centerX: (handleRect.left + handleRect.width / 2 - wrapperRect.left) / scale,
    centerY: (handleRect.top + handleRect.height / 2 - wrapperRect.top) / scale,
  }
}

/**
 * DOM lookup for the handle element currently snapped by a React Flow
 * `useConnection()` state. Returns null if the node or handle can't be
 * found in the DOM. `handleId === null` is the unnamed default handle case
 * (scene flow-in, entityNode default in/out); React Flow renders those
 * without a `data-handleid` attribute (or with the literal string `null`).
 */
export function findHandleEl(nodeId, handleId) {
  if (!nodeId || typeof document === 'undefined') return null
  const nodeWrapper = document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`)
  if (!nodeWrapper) return null
  const handles = nodeWrapper.querySelectorAll('.react-flow__handle')
  for (const h of handles) {
    const hid = h.getAttribute('data-handleid')
    if (handleId == null || handleId === '') {
      if (hid == null || hid === '' || hid === 'null') return h
    } else if (hid === handleId) {
      return h
    }
  }
  return null
}
