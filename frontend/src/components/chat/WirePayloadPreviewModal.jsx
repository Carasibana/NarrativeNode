// WirePayloadPreviewModal — popup hosting <WirePayloadPreview>.
//
// Read-only display. Owner (the surface, e.g. the chat composer)
// passes in the already-assembled `payload` from the surface's
// preview-mode send call. Mode toggle bubbles back up via
// `onModeChange` so the owner can re-fire its send with the new
// shape and update `payload` in place.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import WirePayloadPreview from './WirePayloadPreview'

const SURFACE_LABELS = {
  chat: 'Chat composer',
  'section-pbh': 'Section prompt block',
  'ipb': 'Inline prompt block',
  'scene-desc-pbh': 'Scene description prompt block',
}

export default function WirePayloadPreviewModal({
  surface,
  payload,
  mode,
  onModeChange,
  modeToggleAvailable,
  onClose,
}) {
  const [viewMode, setViewMode] = useState('markdown')

  // ESC closes.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded shadow-2xl w-[min(900px,92vw)] h-[min(80vh,720px)] flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
        data-help-region="wire-payload-preview:modal"
      >
        {/* Header */}
        <div className="flex-shrink-0 flex items-center gap-3 border-b border-zinc-700 px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-zinc-100">Preview Message</span>
            <span className="text-[11px] text-zinc-500 truncate">
              · {SURFACE_LABELS[surface] || surface}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-zinc-500 hover:text-zinc-200 text-sm leading-none flex-shrink-0"
            title="Close"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0">
          <WirePayloadPreview
            payload={payload}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            mode={mode}
            onModeChange={onModeChange}
            modeToggleAvailable={modeToggleAvailable}
          />
        </div>
      </div>
    </div>,
    document.body,
  )
}
