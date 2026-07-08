/**
 * Phase 2.8a — shared hover-preview popover for any
 * `.nn-entity-highlight` span.
 *
 * Previously inlined inside `RichTextEditor.jsx` and used only by
 * the scene-editor TipTap surface. Extracted so the chat-bubble
 * highlight pass (Phase 2.8a) can render the same popover when
 * the writer hovers a coloured name in a chat message — same
 * styling, same data-attribute contract (`data-entity-image` /
 * `data-entity-colour` / `data-entity-type`).
 *
 * Callers manage their own (target, rect) state from
 * `mouseover` / `mouseout` listeners on whatever container holds
 * the highlight spans, and pass them in. When `target` or `rect`
 * is null, the component renders nothing (no portal cost when
 * no hover is active).
 */

import { createPortal } from 'react-dom'
import { TYPE_ICONS } from '../../utils/entityHelpers'


export default function EntityHoverPreview({ target, rect }) {
  if (!target || !rect) return null

  const assetName = target.dataset.entityImage
  const colour = target.dataset.entityColour || '#888'
  const entityType = target.dataset.entityType || 'character'
  const imageUrl = assetName ? `/api/project/assets/${assetName}` : null

  const imgSize = 80
  const placeholderSize = 40
  const size = imageUrl ? imgSize : placeholderSize
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - size / 2, window.innerWidth - size - 16))
  const top = rect.top - size - 12 < 8 ? rect.bottom + 8 : rect.top - size - 12

  return createPortal(
    <div
      className="fixed z-[9999] pointer-events-none"
      style={{ left, top }}
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          className="rounded-sm object-cover shadow-lg"
          style={{ width: imgSize, height: imgSize, border: `2px solid ${colour}` }}
        />
      ) : (
        <span
          className="rounded-sm flex items-center justify-center shadow-lg"
          style={{ width: placeholderSize, height: placeholderSize, backgroundColor: '#27272a', border: `2px solid ${colour}` }}
        >
          {TYPE_ICONS[entityType] || '◈'}
        </span>
      )}
    </div>,
    document.body,
  )
}
