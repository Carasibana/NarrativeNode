/**
 * Phase 2.7c — chain-timeline range-selector modal.
 *
 * Standalone modal wrapper for the chat panel's pinned-context anchor-
 * edit flow. The actual selection UX (timeline grid + state machine +
 * "Dynamically match current scene" button + "Remove that?" overlay +
 * selection-description text) lives in `ChainRangeSelector`, which is
 * also embedded by the Character Chat Setup modal (Phase 2.11b) so
 * the inner UX is single-source.
 *
 * This file is now just the modal chrome (backdrop, box, header,
 * Cancel / Confirm footer) wrapped around an instance of the inner
 * component. The public API is unchanged from the pre-2.11b shape:
 *
 *   - opens with the focused pin
 *   - computes `otherPinMarkers` and `dynamicResolutionPoint` from the
 *     live pinnedItems list (caller's responsibility)
 *   - on `onCommit(newPins[])`: removes the original pin and adds each
 *     new pin via the existing store actions
 *   - on `onClose()`: dismisses without changes
 */
import { useCallback, useEffect, useRef } from 'react'
import { useAccentColor } from '../../utils/povConstants'
import ChainRangeSelector from './ChainRangeSelector'


export default function ChainRangeSelectorModal({
  item,
  otherPinMarkers,
  otherPinRangeFillSpans = null,
  dynamicResolutionPoint,
  dynamicPinSessionId = null,
  onClose,
  onCommit,
  onClearOtherPin,
  onAddDynamicPin = null,
}) {
  const accent = useAccentColor() || '#7c3aed'
  const selectorRef = useRef(null)

  // Esc closes the modal. The "Remove that?" popover (inside the
  // selector) has its own Esc handler that captures FIRST so the
  // popover takes the keystroke when open.
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const confirm = useCallback(() => {
    if (!selectorRef.current) return
    const pins = selectorRef.current.getCurrentPins()
    onCommit?.(pins)
  }, [onCommit])

  if (!item) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-md shadow-xl max-w-[1100px] w-[94vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        data-help-region="chain-range-selector:modal"
      >
        <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs text-zinc-300 font-semibold truncate">Choose context anchor</div>
            <div className="text-[10px] text-zinc-500 truncate">
              {item.kind ? item.kind.charAt(0).toUpperCase() + item.kind.slice(1) : 'Item'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close anchor picker"
            className="text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 rounded w-6 h-6 flex items-center justify-center"
          >
            ✕
          </button>
        </div>

        <ChainRangeSelector
          ref={selectorRef}
          item={item}
          otherPinMarkers={otherPinMarkers}
          otherPinRangeFillSpans={otherPinRangeFillSpans}
          dynamicResolutionPoint={dynamicResolutionPoint}
          dynamicPinSessionId={dynamicPinSessionId}
          onClearOtherPin={onClearOtherPin}
          onAddDynamicPin={onAddDynamicPin}
        />

        {/* Footer */}
        <div className="px-4 py-2 border-t border-zinc-800 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] px-2.5 py-1 rounded border border-zinc-700 bg-zinc-800/40 text-zinc-300 hover:bg-zinc-700/60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            data-help-region="chain-range-selector:confirm"
            className="text-[11px] px-2.5 py-1 rounded text-zinc-900 font-semibold"
            style={{ backgroundColor: accent }}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}
