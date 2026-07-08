import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import Cropper from 'react-easy-crop'

/**
 * Phase 2.5g — shared profile-image crop modal.
 *
 * Extracted from `ProfileImageUpload.jsx` so the same crop affordance
 * can be invoked from the file-picker upload flow AND from the
 * chat-bubble apply-as-avatar / drag-and-drop flows in Phase 2.5g.
 *
 * IMPORTANT — this modal is rendered via React portal to `document.body`
 * so it escapes any CSS transform / `zoom` context on ancestor DOM. The
 * left `EntityLibraryPanel` wraps its content (including the Detail
 * Panel, which hosts `ProfileImageUpload`) in `style={{ zoom: 1.25 }}`
 * for readability. CSS `zoom` cascades to descendants of any positioning
 * context — including `position: fixed` — in Chrome/WebKit: the visual
 * rendering is scaled 1.25× but internal layout measurements
 * (`offsetWidth`, `getBoundingClientRect`, etc.) stay at nominal size.
 * `react-easy-crop` reads those nominal values for its crop math, so a
 * modal rendered inside the zoom context gets a coordinate mismatch
 * between visual mouse position and internal crop state. Portaling to
 * `document.body` places the modal outside every zoomed ancestor,
 * restoring consistent coordinates.
 *
 * Props:
 *   imageSrc  — anything `<img src>` accepts: data URL, blob URL, or
 *               remote URL. The cropper reads from this directly.
 *   onConfirm — async-or-sync `(blob: Blob) => void | Promise<void>`.
 *               Called with the JPEG-encoded cropped blob when the
 *               writer clicks Confirm. The caller is responsible for
 *               uploading / persisting the blob.
 *   onCancel  — `() => void`, fires when the writer dismisses.
 *   busy      — optional flag the caller can set to `true` while it
 *               does its post-confirm work (uploading, persisting).
 *               Disables the Confirm button and changes its label to
 *               "Working…" so the writer sees feedback.
 *   title     — optional modal heading. Defaults to "Crop Image".
 *   confirmLabel — optional override for the Confirm button label
 *                  in the idle state. Defaults to "Crop & Upload" to
 *                  match the existing upload-flow phrasing.
 *   aspect    — crop aspect ratio (width / height). Defaults to 1
 *               (square — the entity-avatar case). The Phase 5.2b
 *               story cover passes 2/3 for a book-cover portrait.
 *   output    — encode options forwarded to `getCroppedBlob`
 *               (`{ maxWidth, maxHeight, upscale, quality }`). Defaults
 *               to the 256×256 upscaling avatar box; the cover passes
 *               `{ maxWidth: 1024, maxHeight: 1536, upscale: false }`.
 */
export default function CropModal({
  imageSrc,
  onConfirm,
  onCancel,
  busy = false,
  title = 'Crop Image',
  confirmLabel = 'Crop & Upload',
  aspect = 1,
  output,
}) {
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null)

  const onCropComplete = useCallback((_, pixels) => {
    setCroppedAreaPixels(pixels)
  }, [])

  async function handleConfirm() {
    if (!croppedAreaPixels) return
    const blob = await getCroppedBlob(imageSrc, croppedAreaPixels, output)
    await onConfirm(blob)
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black/80">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl w-[420px] flex flex-col" style={{ maxHeight: '90vh' }} data-help-region="crop-modal:modal">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
          <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
          <button onClick={onCancel} className="text-zinc-400 hover:text-zinc-200 text-lg leading-none">✕</button>
        </div>

        {/* Crop area */}
        <div className="relative w-full flex-shrink-0" style={{ height: 320 }} data-help-region="crop-modal:crop_area">
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={aspect}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
            showGrid={false}
            style={{
              containerStyle: { borderRadius: 0 },
              cropAreaStyle: { border: '2px solid #a855f7' },
            }}
          />
        </div>

        {/* Zoom slider */}
        <div className="px-4 py-3 flex items-center gap-3 border-t border-zinc-800">
          <span className="text-xs text-zinc-500 w-8">Zoom</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.05}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="flex-1 accent-accent-500"
            data-help-region="crop-modal:zoom"
          />
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-700">
          <button onClick={onCancel} className="px-4 py-1.5 text-sm text-zinc-300 hover:text-zinc-100" data-help-region="crop-modal:cancel">
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={busy || !croppedAreaPixels}
            className="px-4 py-1.5 text-sm bg-accent-700 hover:bg-accent-600 text-white rounded disabled:opacity-50"
            data-help-region="crop-modal:confirm"
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * Draw the chosen crop rect onto a canvas and return it as a JPEG Blob.
 * Used by `CropModal` internally; also exported for callers that
 * already have crop pixels and just need the blob (rare — most callers
 * should use the modal).
 *
 * `output` controls the encode (all optional):
 *   maxWidth / maxHeight — bounding box for the result (default 256×256).
 *                          The crop is scaled to FIT this box preserving
 *                          its aspect ratio.
 *   upscale  — when true (default) a crop smaller than the box is enlarged
 *              to fill it; when false the scale is capped at 1 so a
 *              low-res source keeps its native pixel size (never upscaled).
 *   quality  — JPEG quality 0–1 (default 0.9).
 *
 * The defaults reproduce the original behaviour exactly for the square
 * entity-avatar case: a 1:1 crop fit into a 256×256 box (upscaling)
 * yields a 256×256 JPEG. The Phase 5.2b cover passes a 2:3 crop with
 * `{ maxWidth: 1024, maxHeight: 1536, upscale: false }`.
 */
export function getCroppedBlob(imageSrc, croppedAreaPixels, output = {}) {
  const { maxWidth = 256, maxHeight = 256, upscale = true, quality = 0.9 } = output
  return new Promise((resolve, reject) => {
    const image = new Image()
    // Allow cross-origin sources (remote URLs from assistant images
    // hosted on the upstream provider) to be drawn to the canvas
    // without tainting it.
    image.crossOrigin = 'anonymous'
    image.addEventListener('load', () => {
      const cw = croppedAreaPixels.width
      const ch = croppedAreaPixels.height
      let scale = Math.min(maxWidth / cw, maxHeight / ch)
      if (!upscale) scale = Math.min(scale, 1)
      const outW = Math.max(1, Math.round(cw * scale))
      const outH = Math.max(1, Math.round(ch * scale))
      const canvas = document.createElement('canvas')
      canvas.width = outW
      canvas.height = outH
      const ctx = canvas.getContext('2d')
      ctx.drawImage(
        image,
        croppedAreaPixels.x,
        croppedAreaPixels.y,
        cw,
        ch,
        0, 0, outW, outH,
      )
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Canvas toBlob failed'))
      }, 'image/jpeg', quality)
    })
    image.addEventListener('error', reject)
    image.src = imageSrc
  })
}
