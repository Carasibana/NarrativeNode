import { useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { usePreviewStore } from '../../store/previewStore'

/**
 * Wraps children and shows a larger preview of an image on hover.
 * The preview appears offset from the cursor so it doesn't block the hovered element.
 *
 * The preview renders the image at its **natural aspect ratio**, with only
 * the height clamped to `size`. Width is auto-derived from the intrinsic
 * proportions so tall/wide images don't get forced into a square. Width is
 * still safety-bounded to a reasonable maximum so extreme aspect ratios don't
 * paint off-screen.
 *
 * Props:
 *   src           — image URL to preview (if null/undefined, no preview is shown)
 *   borderColour  — optional border colour for the preview
 *   size          — preview HEIGHT in px (default 120). Width is natural via aspect.
 *   previewSource — optional source descriptor for the Media Preview Panel.
 *                   When supplied, shift-clicking the wrapped element opens the
 *                   image in the Media Preview Panel via `togglePreview` —
 *                   same store action used by every other "open in preview"
 *                   surface (canvas chips, chat attachments, attribute file
 *                   pills). Descriptor shape mirrors what those callers pass:
 *                   `{ type, fileRef | url, ...context }`. Without this prop
 *                   the shift-click handler is a no-op.
 *   children      — the element to wrap (the small image/avatar)
 */
export default function ImageHoverPreview({ src, borderColour, size = 120, previewSource, children }) {
  const [show, setShow] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const timeout = useRef(null)
  // Rendered width estimate — updated from the img element's aspect once it
  // loads so the position clamp can keep the full preview inside the viewport.
  const [renderedW, setRenderedW] = useState(size)

  const handleEnter = useCallback((e) => {
    if (!src) return
    const rect = e.currentTarget.getBoundingClientRect()
    // Position preview above-right of the element, offset so it doesn't overlap
    setPos({ x: rect.right + 8, y: rect.top - size - 8 })
    timeout.current = setTimeout(() => setShow(true), 200)
  }, [src, size])

  const handleMove = useCallback((e) => {
    if (!src) return
    // Follow cursor with offset: right and above
    setPos({ x: e.clientX + 16, y: e.clientY - size - 16 })
  }, [src, size])

  const handleLeave = useCallback(() => {
    clearTimeout(timeout.current)
    setShow(false)
  }, [])

  // Shift-click → open in Media Preview Panel. Dispatches `togglePreview`
  // on the preview store with whatever descriptor the caller supplied via
  // `previewSource` — same store action every other "open in preview"
  // surface uses (canvas chips, chat attachments, attribute file pills),
  // so the focus / tray-chip / handoff semantics work consistently. No-op
  // when `previewSource` is absent. Plain (non-shift) clicks fall through
  // to the wrapped element's own onClick handler.
  const handleClick = useCallback((e) => {
    if (!e.shiftKey) return
    if (!previewSource) return
    e.preventDefault()
    e.stopPropagation()
    // Dismiss the hover preview popup before opening the panel so the
    // floating thumbnail doesn't linger over the now-expanded media.
    clearTimeout(timeout.current)
    setShow(false)
    usePreviewStore.getState().togglePreview(previewSource)
  }, [previewSource])

  const handleImgLoad = useCallback((e) => {
    const img = e.currentTarget
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      // Scale natural width by the ratio of (size / naturalHeight)
      const scaled = size * (img.naturalWidth / img.naturalHeight)
      // Cap at an absolute max to prevent panoramic images overflowing
      setRenderedW(Math.min(scaled, Math.max(160, window.innerWidth * 0.45)))
    }
  }, [size])

  return (
    <span
      className="inline-flex"
      onMouseEnter={handleEnter}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      onClick={handleClick}
    >
      {children}
      {show && src && createPortal(
        <div
          className="pointer-events-none fixed z-[9999]"
          style={{
            // Clamp using the measured rendered width so wide images stay on-screen
            left: Math.max(8, Math.min(pos.x, window.innerWidth - renderedW - 16)),
            top: Math.max(8, pos.y < 8 ? pos.y + size + 32 : pos.y),
          }}
        >
          <img
            src={src}
            alt=""
            onLoad={handleImgLoad}
            className="rounded shadow-lg block"
            style={{
              height: size,
              width: 'auto',
              maxWidth: Math.max(160, Math.floor(window.innerWidth * 0.45)),
              border: borderColour ? `2px solid ${borderColour}` : '2px solid #52525b',
            }}
          />
        </div>,
        document.body
      )}
    </span>
  )
}
