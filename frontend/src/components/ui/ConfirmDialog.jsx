/**
 * ConfirmDialog — Phase 1.13 reusable confirm / alert dialog.
 *
 * Reads from `dialogStore.confirmDialog`. When non-null, renders a
 * portal-style overlay (fixed inset-0 backdrop + centred panel) with
 * the title, message, and configured button row. Click any button to
 * resolve the promise with that button's `value`. Escape, backdrop
 * click, and the ✕ button all resolve with the config's `cancelValue`.
 *
 * Mounted once at the app root in `App.jsx`. Call sites trigger it
 * via `confirm({...})` or `useConfirm()` from `dialogStore.js`.
 *
 * Styling follows `DeleteEntityDialog` (the template this system was
 * generalised from): zinc-800 panel, 380 px wide, optional coloured
 * accent strip at the top, escape-closes, backdrop-click-closes.
 */

import { useEffect, useRef } from 'react'
import { useDialogStore } from '../../store/dialogStore'

// Button-style → Tailwind class mapping.
//
// - `primary`: solid accent-coloured button, used for the default /
//   "recommended" action (e.g. Save, Continue, Connect).
// - `danger`: warn the user they're about to take a lossy / hard-
//   to-undo action WITHOUT using the bright-red colour scheme the
//   user explicitly dislikes. Design: same zinc background as
//   neutral, but with an inset accent-coloured ring (the "interior
//   border" that visually cues the user something is different)
//   AND accent-coloured text. The interior ring uses Tailwind's
//   `ring-inset` so the button's outer dimensions don't change
//   compared to neutral — only the inner painted surface shifts.
// - `neutral`: outlined zinc button, used for the safe / no-op
//   cancel action.
const BUTTON_STYLES = {
  primary: 'bg-accent-700 hover:bg-accent-600 text-white border-accent-600',
  danger:  'bg-zinc-800 hover:bg-zinc-700 text-accent-400 hover:text-accent-300 border-zinc-600 ring-2 ring-inset ring-accent-500',
  neutral: 'text-zinc-300 hover:text-zinc-100 border-zinc-600 hover:border-zinc-500',
}

export default function ConfirmDialog() {
  const dialog = useDialogStore((s) => s.confirmDialog)
  const resolveDialog = useDialogStore((s) => s.resolveDialog)

  const backdropRef = useRef(null)
  const firstButtonRef = useRef(null)

  // Auto-focus the first button when a new dialog opens so Enter
  // triggers the primary action without a stray tab.
  useEffect(() => {
    if (dialog && firstButtonRef.current) {
      firstButtonRef.current.focus()
    }
  }, [dialog])

  // Close on Escape — resolves with the config's cancelValue.
  useEffect(() => {
    if (!dialog) return undefined
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        resolveDialog(dialog.cancelValue)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [dialog, resolveDialog])

  if (!dialog) return null

  // Close on backdrop click (but NOT on clicks inside the panel).
  function handleBackdropClick(e) {
    if (e.target === backdropRef.current) {
      resolveDialog(dialog.cancelValue)
    }
  }

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60"
      onClick={handleBackdropClick}
    >
      <div
        className="bg-zinc-800 border border-zinc-600 rounded-lg shadow-2xl w-[420px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        {/* Optional coloured accent strip — matches DeleteEntityDialog's
            entity-colour strip. Falls through when null / undefined. */}
        {dialog.accentColour && (
          <div className="h-1" style={{ backgroundColor: dialog.accentColour }} />
        )}

        <div className="p-5 space-y-4">
          {/* Title + close button row */}
          <div className="flex items-start justify-between gap-3">
            <h2
              id="confirm-dialog-title"
              className="text-sm font-semibold text-zinc-100 flex-1"
            >
              {dialog.title}
            </h2>
            <button
              onClick={() => resolveDialog(dialog.cancelValue)}
              className="text-zinc-400 hover:text-zinc-200 text-sm leading-none -mt-0.5"
              title="Cancel"
              aria-label="Close dialog"
            >
              ✕
            </button>
          </div>

          {/* Message — renders whatever the caller passed. Strings are
              rendered with whitespace-pre-line so `\n` in a string
              literal becomes a visual line break; ReactNode passes
              through unchanged. */}
          {dialog.message && (
            <div className="text-xs text-zinc-300 whitespace-pre-line leading-relaxed">
              {dialog.message}
            </div>
          )}

          {/* Action buttons — rendered in the order the caller defined
              them, so "primary first" and "cancel last" are caller
              conventions. First button is auto-focused via
              `firstButtonRef` so Enter activates it. */}
          <div className="flex gap-2 justify-end pt-1">
            {dialog.buttons.map((btn, i) => {
              const style = BUTTON_STYLES[btn.style] || BUTTON_STYLES.neutral
              return (
                <button
                  key={`${btn.label}-${i}`}
                  ref={i === 0 ? firstButtonRef : null}
                  onClick={() => resolveDialog(btn.value)}
                  className={`px-3 py-1.5 text-xs rounded border ${style}`}
                >
                  {btn.label}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
