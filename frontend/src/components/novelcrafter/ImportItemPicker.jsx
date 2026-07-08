/**
 * ImportItemPicker — Phase 3.9 shared per-item selection popover.
 *
 * Used by `NovelcrafterImportDialog` for both the snippets opt-in
 * (Phase 3.8 retrofit) and the chats opt-in (Phase 3.9). When either
 * parent opt-in is on, this component renders:
 *
 *   1. A trigger button reading `"{selected} of {total} selected ▾"`
 *      that toggles a popover anchored beneath it.
 *
 *   2. The popover itself — a scrollable height-capped list of
 *      checkbox rows, one per item, with `[Select all] [Select none]`
 *      / `× close` controls along the top.
 *
 * Each row shows `[checkbox] {date} — {label}` where label is the
 * resolved cue/conversation display name produced by the same
 * backend resolver the import will use (Phase 3.8
 * `_cue_name_for_snippet` / Phase 3.9 `_conversation_name_for_chat`).
 * So what the writer sees in the picker is exactly what lands in
 * the library.
 *
 * Selection state is controlled by the parent (Set<string> of nc_id
 * values). Default-all-selected behaviour is the parent's
 * responsibility: when the parent toggle flips off→on, the parent
 * resets the Set to every item's nc_id.
 *
 * Disabled state: trigger button greys out (disabled prop). Popover
 * never opens while disabled.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export default function ImportItemPicker({
  items,
  selectedIds,
  setSelectedIds,
  onClose,
  disabled = false,
}) {
  const [open, setOpen] = useState(false)
  // Anchor ref is on the TRIGGER button itself. The popover renders
  // through a portal to `document.body` (so it escapes the import
  // dialog's `overflow-y-auto` scroll pane that was clipping it),
  // and its `position: fixed` coords are computed off this rect.
  const triggerRef = useRef(null)
  const popoverRef = useRef(null)
  const [popoverPos, setPopoverPos] = useState({ left: 0, top: 0 })
  const total = items.length
  const selectedCount = selectedIds.size

  // Recompute popover position whenever it opens, on resize, and on
  // any scroll event (since the popover uses position: fixed but its
  // anchor moves with the dialog's scroll). `useLayoutEffect` so the
  // first paint after open already has the right coords.
  useLayoutEffect(() => {
    if (!open) return undefined
    function place() {
      const t = triggerRef.current
      if (!t) return
      const r = t.getBoundingClientRect()
      // Default: drop down beneath the trigger, left-aligned.
      let left = r.left
      let top = r.bottom + 4
      // If the popover would overflow the right edge of the
      // viewport, slide it leftward so its right edge sits 8 px
      // inside the viewport. 320 px is the picker's fixed width
      // (`w-80`); kept literal to avoid a measurement round-trip.
      const POPOVER_W = 320
      const margin = 8
      const vw = window.innerWidth
      if (left + POPOVER_W + margin > vw) {
        left = Math.max(margin, vw - POPOVER_W - margin)
      }
      setPopoverPos({ left, top })
    }
    place()
    window.addEventListener('resize', place)
    // `true` capture so we receive scroll events from any scrolling
    // ancestor (the dialog's overflow-y-auto preview pane, the
    // page itself, anything else). Otherwise the popover stays
    // pinned to the original anchor coords while the trigger
    // visually moves out from under it.
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // Auto-close on outside click. Capture phase so we beat the
  // dialog's own click-outside handler. The popover lives in a
  // portal (not under our trigger DOM), so we have to check BOTH
  // `triggerRef.current` AND `popoverRef.current` for containment
  // — a click inside the popover would otherwise be treated as
  // outside.
  useEffect(() => {
    if (!open) return undefined
    function handler(e) {
      const t = triggerRef.current
      const p = popoverRef.current
      if (t && t.contains(e.target)) return
      if (p && p.contains(e.target)) return
      // Inline equivalent of `closePopover()` here — we can't
      // reference `closePopover` directly because the TDZ would
      // bite (it's declared lower in the function). `useCallback`
      // doesn't hoist.
      setOpen(false)
      onClose?.()
    }
    document.addEventListener('pointerdown', handler, true)
    return () => document.removeEventListener('pointerdown', handler, true)
  }, [open, onClose])

  // Wrap every close path so `onClose` fires once per "user closes
  // the popover" event. The dialog uses this to defer the
  // auto-uncheck-on-empty behaviour until AFTER the popover blurs,
  // so a writer can click Select none + then re-tick a few items
  // before closing without the parent toggle un-checking under them
  // mid-edit.
  const closePopover = useCallback(() => {
    setOpen(false)
    onClose?.()
  }, [onClose])

  const toggle = useCallback((nc_id) => {
    const next = new Set(selectedIds)
    if (next.has(nc_id)) next.delete(nc_id)
    else next.add(nc_id)
    setSelectedIds(next)
  }, [selectedIds, setSelectedIds])

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(items.map((it) => it.nc_id)))
  }, [items, setSelectedIds])

  const selectNone = useCallback(() => {
    setSelectedIds(new Set())
  }, [setSelectedIds])

  // Disable trigger and never open when nothing to pick.
  const triggerDisabled = disabled || total === 0
  const triggerLabel = total === 0
    ? 'No items'
    : `${selectedCount} of ${total} selected ▾`

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-help-region="nc-import-item-picker:trigger"
        onClick={() => {
          if (triggerDisabled) return
          // Trigger button toggles. If closing, fire onClose so the
          // dialog can apply its on-close-only logic (e.g.
          // auto-uncheck parent when picker is empty).
          if (open) closePopover()
          else setOpen(true)
        }}
        disabled={triggerDisabled}
        className={`text-[11px] px-2 py-0.5 rounded border ${
          triggerDisabled
            ? 'border-zinc-800 text-zinc-600 cursor-not-allowed'
            : 'border-zinc-700 text-zinc-300 hover:border-accent-500 hover:text-accent-400'
        }`}
      >
        {triggerLabel}
      </button>
      {open && total > 0 && createPortal(
        <div
          ref={popoverRef}
          data-help-region="nc-import-item-picker:popover"
          className="fixed z-[1100] w-80 bg-zinc-900 border border-zinc-700 rounded shadow-xl"
          style={{ left: popoverPos.left, top: popoverPos.top, maxHeight: 400 }}
        >
          <div data-help-region="nc-import-item-picker:controls" className="flex items-center gap-2 px-2 py-1 border-b border-zinc-800 text-[11px]">
            <button
              type="button"
              onClick={selectAll}
              className="px-1.5 py-0.5 rounded text-zinc-300 hover:bg-zinc-800"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={selectNone}
              className="px-1.5 py-0.5 rounded text-zinc-300 hover:bg-zinc-800"
            >
              Select none
            </button>
            <span className="flex-1 text-right text-zinc-500">
              {selectedCount} / {total}
            </span>
            <button
              type="button"
              onClick={closePopover}
              className="text-zinc-500 hover:text-zinc-200 px-1"
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: 320 }}>
            {items.map((it) => {
              const checked = selectedIds.has(it.nc_id)
              return (
                <label
                  key={it.nc_id}
                  data-help-region="nc-import-item-picker:item_row"
                  className="flex items-start gap-2 px-2 py-1 text-[11px] cursor-pointer hover:bg-zinc-800/60"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(it.nc_id)}
                    className="mt-0.5 accent-accent-500"
                  />
                  <span className="flex-1 min-w-0">
                    {it.date && (
                      <span className="text-zinc-500 mr-1.5">{it.date}</span>
                    )}
                    <span className="text-zinc-200 break-words">{it.label}</span>
                  </span>
                </label>
              )
            })}
          </div>
          {/* Footer with explicit OK confirm — writers shouldn't
              have to rely on outside-click / blur to dismiss the
              popover; the auto-uncheck-on-empty-parent behaviour
              still fires via the shared `closePopover` path so the
              OK button and the × close button behave identically
              w.r.t. the parent dialog. */}
          <div className="flex items-center justify-end px-2 py-1.5 border-t border-zinc-800">
            <button
              type="button"
              onClick={closePopover}
              className="text-[11px] px-2.5 py-0.5 rounded border border-accent-700/70 bg-accent-900/30 text-accent-200 hover:bg-accent-900/50 hover:text-accent-100"
            >
              OK
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
