import { useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'

/**
 * Generic hover popover. Wraps a trigger element (`children`) and shows
 * a content node next to it on hover. Position is viewport-clamped via
 * createPortal so the popover never gets clipped by overflow:hidden
 * ancestors.
 *
 * Differences from ImageHoverPreview:
 *   - Content is arbitrary ReactNode (not just an image).
 *   - Popover ITSELF receives pointer events — the user can hover INTO
 *     the popover without it dismissing. Useful when popover content has
 *     scrollable or click-target rows.
 *   - Both trigger-leave and popover-leave dismiss; the small grace
 *     period during transit between trigger and popover lets the user
 *     hand off without flicker.
 *
 * Phase 1.22f — used by the canvas C/M markers (entity chip + scene node)
 * to show chain-resolved circumstance / motivator details on hover.
 *
 * Props:
 *   content       — ReactNode. The popover body.
 *   children      — the trigger element (a small marker / badge).
 *   placement     — 'right' (default) or 'below'. Where the popover
 *                   anchors relative to the trigger.
 *   maxWidth      — px max width for the popover. Default 320.
 *   onTriggerClick — optional callback for click on the trigger.
 *                    Popover dismisses immediately when triggered.
 */
export default function HoverPopover({
  content,
  children,
  placement = 'right',
  maxWidth = 320,
  onTriggerClick,
}) {
  const [show, setShow] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const showTimeout = useRef(null)
  const hideTimeout = useRef(null)

  const computePos = useCallback((rect) => {
    if (placement === 'below') {
      return { x: rect.left, y: rect.bottom + 6 }
    }
    return { x: rect.right + 8, y: rect.top }
  }, [placement])

  const handleEnter = useCallback((e) => {
    if (!content) return
    const rect = e.currentTarget.getBoundingClientRect()
    setPos(computePos(rect))
    if (hideTimeout.current) { clearTimeout(hideTimeout.current); hideTimeout.current = null }
    showTimeout.current = setTimeout(() => setShow(true), 180)
  }, [content, computePos])

  const handleLeave = useCallback(() => {
    if (showTimeout.current) { clearTimeout(showTimeout.current); showTimeout.current = null }
    // Grace period to let cursor cross the gap into the popover.
    hideTimeout.current = setTimeout(() => setShow(false), 180)
  }, [])

  const handlePopoverEnter = useCallback(() => {
    if (hideTimeout.current) { clearTimeout(hideTimeout.current); hideTimeout.current = null }
  }, [])

  const handlePopoverLeave = useCallback(() => {
    hideTimeout.current = setTimeout(() => setShow(false), 120)
  }, [])

  const handleClick = useCallback((e) => {
    if (!onTriggerClick) return
    e.stopPropagation()
    setShow(false)
    onTriggerClick(e)
  }, [onTriggerClick])

  return (
    <span
      className={`inline-flex${onTriggerClick ? ' cursor-pointer' : ''}`}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onClick={onTriggerClick ? handleClick : undefined}
    >
      {children}
      {show && content && createPortal(
        <div
          className="fixed z-[9999] rounded border border-zinc-700 bg-zinc-900 shadow-xl text-zinc-200 nodrag nowheel"
          style={{
            left: Math.max(8, Math.min(pos.x, window.innerWidth - maxWidth - 16)),
            top: Math.max(8, Math.min(pos.y, window.innerHeight - 80)),
            maxWidth,
            maxHeight: 'min(60vh, 480px)',
            overflowY: 'auto',
          }}
          onMouseEnter={handlePopoverEnter}
          onMouseLeave={handlePopoverLeave}
        >
          {content}
        </div>,
        document.body
      )}
    </span>
  )
}
