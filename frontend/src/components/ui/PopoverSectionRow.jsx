import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Shared flyout-style menu row — extracted from `ConversationView`'s
 * private `SectionRow` so the Prompt Block gear popover (and any
 * future popover that wants the same hover-flyout shape) can use it
 * too.
 *
 * Shows the section label as a small uppercase eyebrow, the active
 * value as the primary line, an optional secondary line (e.g. the
 * active connection name under the model), and a ▸ chevron. Parents
 * own the open / close state via the `isOpen` prop.
 *
 * Two interaction modes via `trigger`:
 *   - `'hover'` (default) — hovering the row (or the flyout) calls
 *     `onEnter`; mouse leaving either calls `onLeave`. Parents
 *     typically run a small grace timer in `onLeave` so the cursor
 *     can travel from row → flyout without racing the close.
 *   - `'click'` — clicking the row toggles open via `onEnter` /
 *     `onLeave`. No hover handlers. Outside-clicks (anywhere not in
 *     the row or its portalled flyout) call `onLeave` automatically.
 *
 * When the flyout would clip the right edge of the viewport, it
 * flips to open on the left instead. Maximum height adapts to the
 * available vertical space below the row so long contents scroll
 * inside the flyout rather than disappearing below the fold.
 *
 * The flyout renders via a React Portal to `document.body` so the
 * parent popover's `overflow-hidden` / clipping container can't
 * cut it off. To keep the parent popover's click-outside handler
 * from treating clicks inside the portal as "outside", the portal
 * carries a `data-flyout` attribute set from the caller's
 * `flyoutDataAttr` prop — the parent's handler matches against
 * `closest('[data-<attr>]')`.
 */
export default function PopoverSectionRow({
  label,
  value,
  secondary,
  isOpen,
  onEnter,
  onLeave,
  flyoutWidth = 280,
  flyoutDataAttr = 'popover-flyout',
  hideChevron = false,
  centerContent = false,
  trigger = 'hover',
  // Tailwind z-class for the portalled flyout. Default `z-50` matches
  // the existing settings-panel / connections-tab call sites. Callers
  // that mount the row inside a higher-stacked surface (e.g. a modal
  // sitting at z-[60]) need to pass a Tailwind class above the
  // hosting modal's z so the flyout renders ON TOP of the modal and
  // its backdrop instead of behind it (otherwise the click lands on
  // the backdrop close-handler and the whole modal vanishes).
  flyoutZClass = 'z-50',
  children,
}) {
  const rowRef = useRef(null)
  const flyoutRef = useRef(null)
  const [flyoutPos, setFlyoutPos] = useState({ top: 0, left: 0, maxH: 400 })

  function recomputePosition() {
    if (!rowRef.current) return
    const rect = rowRef.current.getBoundingClientRect()
    const wouldClipRight = rect.right + flyoutWidth + 16 > window.innerWidth
    const left = wouldClipRight
      ? Math.max(8, rect.left - flyoutWidth - 4)
      : rect.right + 4
    const avail = window.innerHeight - rect.top - 16
    setFlyoutPos({
      top: rect.top,
      left,
      maxH: Math.max(160, Math.min(400, avail)),
    })
  }

  function handleEnter() {
    recomputePosition()
    onEnter && onEnter()
  }

  function handleClickRow() {
    if (isOpen) {
      onLeave && onLeave()
    } else {
      recomputePosition()
      onEnter && onEnter()
    }
  }

  // Outside-click detection for click-mode flyouts. A click anywhere
  // not inside the row or its portalled flyout fires onLeave so the
  // parent closes the popover. Capture-phase so canvas / other
  // event-stopping descendants don't swallow the trigger.
  useEffect(() => {
    if (trigger !== 'click' || !isOpen) return
    function onDocDown(e) {
      if (rowRef.current?.contains(e.target)) return
      if (flyoutRef.current?.contains(e.target)) return
      onLeave && onLeave()
    }
    document.addEventListener('mousedown', onDocDown, true)
    return () => document.removeEventListener('mousedown', onDocDown, true)
  }, [trigger, isOpen, onLeave])

  const portalProps = { [`data-${flyoutDataAttr}`]: 'true' }
  // In click mode the wrapper hosts no event handlers — clicks
  // inside the portalled flyout would otherwise bubble through the
  // React tree (createPortal preserves React's event bubbling
  // semantics) up to the wrapper's onClick and close the flyout.
  // The toggle handler lives on the row's inner content div
  // instead so clicks inside the flyout never reach it.
  const wrapperEventHandlers = trigger === 'hover'
    ? { onMouseEnter: handleEnter, onMouseLeave: onLeave }
    : {}
  const contentEventHandlers = trigger === 'click'
    ? { onClick: handleClickRow }
    : {}
  const flyoutEventHandlers = trigger === 'click'
    ? {}
    : { onMouseEnter: handleEnter, onMouseLeave: onLeave }

  return (
    <div ref={rowRef} className="relative" data-help-region="popover:section_row" {...wrapperEventHandlers}>
      <div
        {...contentEventHandlers}
        className={`flex items-center gap-2 px-2.5 py-1.5 transition-colors ${trigger === 'click' ? 'cursor-pointer' : 'cursor-default'} ${
          isOpen ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'
        }`}
      >
        <div className={`flex-1 min-w-0 ${centerContent ? 'text-center' : ''}`}>
          <div className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</div>
          <div className="text-[11px] text-zinc-200 truncate">{value}</div>
          {secondary && (
            <div className="text-[10px] text-zinc-500 truncate">{secondary}</div>
          )}
        </div>
        {!hideChevron && (
          <span className="text-zinc-500 text-[10px] flex-shrink-0">▸</span>
        )}
      </div>
      {isOpen && createPortal(
        <div
          ref={flyoutRef}
          {...portalProps}
          className={`fixed ${flyoutZClass} bg-zinc-900 border border-zinc-700 rounded shadow-xl overflow-y-auto py-1 text-[11px]`}
          style={{
            top: flyoutPos.top,
            left: flyoutPos.left,
            width: flyoutWidth,
            maxHeight: flyoutPos.maxH,
          }}
          {...flyoutEventHandlers}
        >
          {children}
        </div>,
        document.body,
      )}
    </div>
  )
}
