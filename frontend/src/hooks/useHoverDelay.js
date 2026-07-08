import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Hover detection with a configurable delay before firing an
 * "open" state, and a shorter grace period before closing. Used
 * to show tint flyouts around preset hexes and the saturation-
 * square pointer — we don't want the flyout popping the instant
 * the cursor grazes the swatch (hence `openDelay`), nor
 * dismissing the moment the pointer crosses the gap between the
 * source hex and the flyout ring (hence `closeDelay`).
 *
 * State machine:
 * - pointerenter → cancel any pending close; start open timer.
 * - pointerleave → cancel any pending open; start close timer.
 *   If a pointerenter arrives before the close timer fires, the
 *   close is cancelled (lets the user cross the small gap
 *   between the source hex and the flyout ring without dismiss).
 * - mousedown    → cancel timers + close immediately (drag
 *                  wins; flyout would fight the drag).
 * - touchstart   → cancel timers + close (hover-less devices
 *                  should tap-to-select with no flyout).
 * - `cancelClose()` — external escape hatch callers use when an
 *                  adjacent element (e.g. the flyout itself)
 *                  wants to assert "pointer is still in the
 *                  hover zone, keep me open."
 *
 * Returned handlers spread onto whatever element owns the hover
 * region. `isOpen` becomes true once the open timer elapses and
 * stays true until the close timer elapses without being
 * cancelled. The hook renders nothing — callers mount their own
 * flyout component conditionally on `isOpen`.
 */
export default function useHoverDelay({ openDelay = 500, closeDelay = 180 } = {}) {
  const [isOpen, setIsOpen] = useState(false)
  const openTimerRef  = useRef(null)
  const closeTimerRef = useRef(null)

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current != null) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
  }, [])

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current != null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const onPointerEnter = useCallback(() => {
    clearCloseTimer()
    clearOpenTimer()
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null
      setIsOpen(true)
    }, openDelay)
  }, [clearCloseTimer, clearOpenTimer, openDelay])

  const onPointerLeave = useCallback(() => {
    clearOpenTimer()
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      setIsOpen(false)
    }, closeDelay)
  }, [clearOpenTimer, closeDelay])

  const onPointerDown = useCallback(() => {
    clearOpenTimer()
    clearCloseTimer()
    setIsOpen(false)
  }, [clearOpenTimer, clearCloseTimer])

  const onTouchStart = useCallback(() => {
    clearOpenTimer()
    clearCloseTimer()
    setIsOpen(false)
  }, [clearOpenTimer, clearCloseTimer])

  // External "stay open" assertion — used by flyout-like
  // adjacent elements to veto a pending close while the pointer
  // is over them.
  const cancelClose = useCallback(() => {
    clearCloseTimer()
  }, [clearCloseTimer])

  useEffect(() => {
    return () => {
      clearOpenTimer()
      clearCloseTimer()
    }
  }, [clearOpenTimer, clearCloseTimer])

  return {
    isOpen,
    onPointerEnter,
    onPointerLeave,
    onPointerDown,
    onTouchStart,
    cancelClose,
  }
}
