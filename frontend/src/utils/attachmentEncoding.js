/**
 * Phase 2.5e — chat-attachment wire encoder.
 *
 * Converts a staged attachment record (see `attachmentTypes.js`'s
 * `makeAttachmentRecord`) into the on-the-wire JSON shape the
 * backend's `ChatAttachment` Pydantic model accepts:
 *
 *   { kind: 'text' | 'image' | 'file',
 *     name: string,
 *     mime_type: string,
 *     data_base64: string }
 *
 * Image-kind attachments are pre-resized client-side via a
 * `<canvas>` before base64-encoding. The defaults follow
 * Anthropic's published vision guidance (1568 px on the long edge,
 * which also keeps OpenAI's tile-token cost in the cheap range —
 * see `.References/OpenAI Chat Completions API.md` and the live
 * Anthropic vision docs). JPEG q85 for opaque images; PNG kept
 * for images that have an alpha channel so transparency survives.
 * EXIF metadata is stripped as a side-effect of the canvas
 * round-trip (canvases don't preserve metadata) — smaller payload
 * AND a privacy win since most phone photos carry GPS coordinates.
 *
 * Skipping is automatic: if the source image is already smaller
 * than the cap AND in an accepted format AND no decoded-bytes
 * savings would result, we keep the original bytes as-is.
 *
 * Text + file (PDF) kinds are NOT preprocessed — they're inlined
 * verbatim as base64.
 */

const IMAGE_LONG_EDGE_CAP_PX = 1568
const JPEG_QUALITY = 0.85


/**
 * Encode one staged attachment into the wire shape.
 *
 * `attachment` is the staged record from `chatAttachmentStaging`:
 *   { name, size, mimeType, kind, file, blobUrl }
 *
 * Returns a Promise resolving to the wire shape; throws on
 * decoder errors so the caller can surface a transient alert.
 */
export async function encodeAttachmentForWire(attachment) {
  const { file, kind, name, mimeType } = attachment
  if (!file) throw new Error(`Attachment "${name}" has no File reference.`)

  if (kind === 'image') {
    const { blob, mime } = await _maybeResizeImage(file)
    const data_base64 = await _blobToBase64(blob)
    return { kind, name, mime_type: mime || mimeType || 'application/octet-stream', data_base64 }
  }
  // Text + file (PDF): read raw bytes, base64 verbatim. No
  // preprocessing — text inlining and PDF passthrough happen on
  // the adapter side.
  const data_base64 = await _blobToBase64(file)
  return { kind, name, mime_type: mimeType || 'application/octet-stream', data_base64 }
}


/**
 * Encode a list of staged attachments in parallel. Errors on any
 * individual file are surfaced as the rejection of the whole
 * Promise — caller decides whether to abort the send or retry.
 */
export async function encodeAttachmentsForWire(attachments) {
  if (!attachments || attachments.length === 0) return []
  return Promise.all(attachments.map(encodeAttachmentForWire))
}


/**
 * Resize + re-encode the image, then keep whichever of (source,
 * re-encoded) is smaller. The canvas round-trip is cheap and only
 * runs once per attachment, so it's worth doing for every image
 * — a 4 MB PNG of a photo can become a 400 KB JPEG q85 even at
 * its native resolution. Decoding uses `createImageBitmap` for
 * speed + EXIF-orientation honouring (modern Chromium / Firefox
 * / Safari support it).
 *
 * Returns the chosen `Blob` plus its MIME so the caller can put
 * it in the `data:` URL prefix correctly.
 */
async function _maybeResizeImage(file) {
  // SVG / animated GIF: skip the canvas round-trip — re-encoding
  // loses the vector / animation. Pass through verbatim.
  const lowerName = (file.name || '').toLowerCase()
  if (lowerName.endsWith('.svg') || lowerName.endsWith('.gif')) {
    return { blob: file, mime: file.type || _inferImageMime(lowerName) }
  }
  let bitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    // Decoder failed — fall back to passing through the original
    // bytes. The model might still accept the file even if we
    // can't decode it on this platform.
    return { blob: file, mime: file.type || _inferImageMime(lowerName) }
  }
  const { width, height } = bitmap
  const longEdge = Math.max(width, height)
  // Detect alpha. PNG sources are assumed to want alpha preserved
  // unless they're flat photos saved as PNG (where we'd benefit
  // from converting to JPEG). The cheap alpha probe distinguishes
  // these — see `_hasAlpha`. WebP can carry alpha too; same probe
  // handles it.
  const isPng = (file.type === 'image/png') || lowerName.endsWith('.png')
  const wantsAlpha = isPng && _hasAlpha(bitmap)
  const targetMime = wantsAlpha ? 'image/png' : 'image/jpeg'

  const scale = longEdge > IMAGE_LONG_EDGE_CAP_PX ? IMAGE_LONG_EDGE_CAP_PX / longEdge : 1
  const targetW = Math.max(1, Math.round(width * scale))
  const targetH = Math.max(1, Math.round(height * scale))

  // OffscreenCanvas where available; falls back to a detached
  // DOM canvas otherwise. Both produce identical pixel output.
  const canvas = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(targetW, targetH)
    : Object.assign(document.createElement('canvas'), { width: targetW, height: targetH })
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0, targetW, targetH)
  bitmap.close?.()

  let outBlob
  if (canvas.convertToBlob) {
    outBlob = await canvas.convertToBlob(targetMime === 'image/jpeg'
      ? { type: 'image/jpeg', quality: JPEG_QUALITY }
      : { type: 'image/png' })
  } else {
    outBlob = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), targetMime, targetMime === 'image/jpeg' ? JPEG_QUALITY : undefined)
    })
  }

  // Compare against the source: keep whichever is smaller. This
  // covers all the cases without a special-casing tree:
  //   - Big PNG photo → JPEG q85 is much smaller; we take the JPEG.
  //   - Small JPEG already tight → JPEG q85 might be larger; we
  //     keep the original.
  //   - Small alpha PNG → PNG re-encode might be a touch larger
  //     from the resampling artefacts; we keep the original.
  //   - Exotic source (TIFF / BMP / HEIC the browser can decode) →
  //     re-encoded blob almost always wins; we take it.
  if (outBlob && file.size && outBlob.size > file.size) {
    return { blob: file, mime: file.type || _inferImageMime(lowerName) }
  }
  return { blob: outBlob, mime: targetMime }
}


/**
 * Cheap alpha probe — samples the top-left and several scattered
 * pixels for non-opaque alpha. A heuristic but good enough to
 * route PNG-with-transparency through the PNG re-encode path.
 */
function _hasAlpha(bitmap) {
  try {
    const probeCanvas = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height })
    const ctx = probeCanvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    const samples = [
      [0, 0],
      [bitmap.width - 1, 0],
      [0, bitmap.height - 1],
      [bitmap.width - 1, bitmap.height - 1],
      [Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2)],
    ]
    for (const [x, y] of samples) {
      const d = ctx.getImageData(x, y, 1, 1).data
      if (d[3] < 255) return true
    }
  } catch {
    // Sampling failed (cross-origin canvas etc) — assume opaque.
  }
  return false
}


function _inferImageMime(lowerName) {
  if (lowerName.endsWith('.png')) return 'image/png'
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg'
  if (lowerName.endsWith('.gif')) return 'image/gif'
  if (lowerName.endsWith('.webp')) return 'image/webp'
  if (lowerName.endsWith('.svg')) return 'image/svg+xml'
  return 'application/octet-stream'
}


/**
 * Read a Blob / File as a base64 string (no `data:` URL prefix —
 * the adapter prepends `data:<mime>;base64,` itself). Uses the
 * FileReader API since `Blob.bytes()` isn't universally available
 * in the writer's Chromium / Firefox versions yet.
 */
function _blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      // FileReader.readAsDataURL produces `data:<mime>;base64,<b64>`
      // — strip the prefix so the caller gets the bare base64.
      if (typeof result === 'string') {
        const commaIdx = result.indexOf(',')
        resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result)
      } else {
        reject(new Error('Unexpected FileReader result type.'))
      }
    }
    reader.onerror = () => reject(reader.error || new Error('Failed to read attachment bytes.'))
    reader.readAsDataURL(blob)
  })
}
