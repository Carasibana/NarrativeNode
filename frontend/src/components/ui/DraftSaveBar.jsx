/**
 * DraftSaveBar — Phase 1.21d Step E
 *
 * Layer 2 detail-panel-section component. Sticky footer shown when a
 * draft is pending — Discard + Confirm buttons. Returns null when
 * `isDirty` is false so the footer slot collapses.
 *
 * Type-agnostic by design — same shape across every type-view. Pattern
 * B from the planning doc § "Discriminator pattern": the caller resolves
 * dirty-state, save action, and discard action independently and passes
 * resolved values + handler closures. The component itself has no
 * discriminator.
 *
 * Currently consumed by `<EntityDetailView>` only; future Layer-3 views
 * (Knowledge / Relationship draft+save UX parity, etc.) adopt it
 * directly without modification.
 */

import { useState } from 'react'

// Internal — three-dot bouncing-progress indicator shown while a save is
// in flight. Not exported; only meaningful inside DraftSaveBar.
function BouncingDots() {
  return (
    <span className="inline-flex items-center justify-center gap-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block w-1 h-1 rounded-full bg-white animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  )
}

export default function DraftSaveBar({ isDirty, onSave, onDiscard }) {
  const [saving, setSaving] = useState(false)

  if (!isDirty) return null

  async function handleSaveClick() {
    setSaving(true)
    try { await onSave() } finally { setSaving(false) }
  }

  return (
    <div className="flex-shrink-0 flex gap-2 px-3 py-2 border-t border-zinc-700 bg-zinc-900/80" data-help-region="detail-panel:draft_save_bar">
      <button
        onClick={onDiscard}
        disabled={saving}
        className="flex-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded px-3 py-1.5 disabled:opacity-50"
      >
        Discard
      </button>
      <button
        onClick={handleSaveClick}
        disabled={saving}
        className="flex-1 text-xs bg-accent-600 hover:bg-accent-500 text-white rounded px-3 py-1.5 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {saving ? <BouncingDots /> : 'Confirm'}
      </button>
    </div>
  )
}
