/**
 * Phase 2.5g — drag-source / drop-target helpers for "apply image as
 * profile / avatar" drops.
 *
 * The drag flow has TWO source kinds and ONE drop pipeline:
 *
 *   Source A: an image preview in the chat panel (InlineImage,
 *             AttachmentStrip image thumbnail). `dataTransfer`
 *             carries our custom MIME with the image's `data_url`
 *             so a drop target can pop the crop modal directly
 *             without re-encoding.
 *
 *   Source B: an OS file dragged in from outside the browser. The
 *             browser supplies `dataTransfer.files`; we read the
 *             first image file and turn it into a data URL on drop.
 *
 * Drop targets (Detail Panel avatar, entity nodes, entity chips,
 * knowledge nodes) inspect `dataTransfer.types` to detect either
 * source and run the same crop-modal pipeline.
 *
 * The custom MIME deliberately uses an `application/` namespace so
 * it doesn't trigger the OS-file branch on drop targets that key
 * on `Files`. The canvas-wide Reference Media drop handler keys on
 * `Files` specifically, so it WON'T fire for in-app drags; for
 * OS-file drags the inner drop targets must `stopPropagation` to
 * suppress the canvas handler — that's enforced by each drop site.
 */

export const NN_PROFILE_IMAGE_MIME = 'application/x-nn-profile-image-data-url'

/**
 * Max longer-edge for the drag ghost, in CSS pixels. Matches the
 * Detail Panel's avatar size (`<ProfileImageUpload size={48}>`) so
 * the ghost reads as "this becomes that avatar". Aspect ratio is
 * preserved; the shorter edge scales down from there.
 */
const DRAG_GHOST_MAX_EDGE = 48

/**
 * Wire an `onDragStart` handler that publishes the image's data URL
 * onto the DataTransfer so any NarrativeNode drop target can pick
 * it up. Also sets a translucent drag-preview image and a `text/uri-list`
 * fallback so the OS displays something sensible.
 *
 * Drag-ghost sizing: by default the browser uses the source `<img>`
 * itself as the drag preview, which can be huge for full-size chat
 * images. We swap in a custom ghost rendered at avatar scale via
 * `setDragImage`, scaled so the longer edge is `DRAG_GHOST_MAX_EDGE`
 * and the shorter edge scales to maintain aspect ratio.
 */
export function makeProfileImageDragStart(dataUrl) {
  return (e) => {
    if (!dataUrl) return
    try {
      e.dataTransfer.setData(NN_PROFILE_IMAGE_MIME, dataUrl)
      // text/uri-list lets other tools / our own URL-based drop
      // handlers fall back. Browsers also tend to render a small
      // generic file icon when this is set.
      e.dataTransfer.setData('text/uri-list', dataUrl)
      e.dataTransfer.effectAllowed = 'copy'
    } catch { /* setData rejects in some sandbox configs; harmless */ }
    // Build a small avatar-sized drag preview. We render via canvas
    // (drawImage from the already-loaded source `<img>`) so the
    // ghost is fully rendered SYNCHRONOUSLY before `setDragImage`
    // takes its snapshot. A naive `<img>` clone with `.src = dataUrl`
    // doesn't work here: the new img hasn't finished its load by
    // the time setDragImage is called, so the browser snapshots an
    // empty element and falls back to using the source img at
    // native size. The canvas approach avoids that race entirely.
    try {
      const src = e.currentTarget
      const naturalW = src?.naturalWidth || 0
      const naturalH = src?.naturalHeight || 0
      if (!naturalW || !naturalH) return
      const longer = Math.max(naturalW, naturalH)
      const scale = DRAG_GHOST_MAX_EDGE / longer
      const ghostW = Math.max(1, Math.round(naturalW * scale))
      const ghostH = Math.max(1, Math.round(naturalH * scale))
      const dpr = window.devicePixelRatio || 1
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(ghostW * dpr)
      canvas.height = Math.round(ghostH * dpr)
      canvas.style.width = `${ghostW}px`
      canvas.style.height = `${ghostH}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(dpr, dpr)
      ctx.drawImage(src, 0, 0, ghostW, ghostH)
      // Browser ghost capture requires the element to be in the DOM
      // and visible. `opacity: 0` works but some engines skip the
      // snapshot — keep it nominally on-screen at the top-left with
      // very low opacity so the snapshot succeeds, and disable
      // pointer events so the user can't interact with it.
      canvas.style.position = 'fixed'
      canvas.style.top = '0px'
      canvas.style.left = '0px'
      canvas.style.opacity = '0.001'
      canvas.style.pointerEvents = 'none'
      canvas.style.zIndex = '-1'
      document.body.appendChild(canvas)
      e.dataTransfer.setDragImage(canvas, Math.round(ghostW / 2), Math.round(ghostH / 2))
      // Remove on next tick — the browser has the snapshot by then.
      setTimeout(() => { try { document.body.removeChild(canvas) } catch { /* gone */ } }, 0)
    } catch { /* drag-preview build failed; fall back to default browser preview */ }
  }
}

/**
 * Does this drag event carry a payload our drop targets can use?
 * Returns 'in-app' for our custom MIME, 'os-file' when the user is
 * dragging an image file in from the OS, or `null` for anything else.
 *
 * Used by both `onDragEnter` (highlight) and `onDrop` (read).
 */
export function classifyProfileImageDrag(e) {
  const t = e.dataTransfer?.types
  if (!t) return null
  // DataTransferItemList implements both indexOf-style iteration AND
  // .contains; Safari is the historical odd one. Use Array.from for
  // portability.
  const types = Array.from(t)
  if (types.includes(NN_PROFILE_IMAGE_MIME)) return 'in-app'
  if (types.includes('Files')) return 'os-file'
  return null
}

/**
 * Pull the image data URL out of a drop event. For in-app drags we
 * read the custom MIME directly. For OS-file drags we pick the first
 * image file in `dataTransfer.files` and FileReader-encode it.
 *
 * Returns a Promise that resolves to a data URL string, or `null`
 * if the drop doesn't carry an image we can use.
 */
export async function readProfileImageDrop(e) {
  const kind = classifyProfileImageDrag(e)
  if (kind === 'in-app') {
    const url = e.dataTransfer.getData(NN_PROFILE_IMAGE_MIME)
    return typeof url === 'string' && url.length > 0 ? url : null
  }
  if (kind === 'os-file') {
    const files = Array.from(e.dataTransfer.files || [])
    const image = files.find((f) => /^image\//i.test(f.type || ''))
    if (!image) return null
    return await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = (ev) => resolve(ev.target?.result || null)
      reader.onerror = reject
      reader.readAsDataURL(image)
    })
  }
  return null
}
