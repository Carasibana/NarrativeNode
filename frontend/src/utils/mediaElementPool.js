/**
 * Shared media element pool for the Phase 1.10 Media Preview Panel system.
 *
 * Maintains a module-scoped pool of `<audio>` / `<video>` DOM elements keyed by
 * `fileRef` (the asset path). Both `MediaPreviewPanel` and `MediaPreviewTrayChip`
 * acquire the SAME element for a given source, and move it between their DOM
 * containers via imperative `appendChild`. Because the element is not destroyed
 * when a container is unmounted (a detached `<audio>` element continues playing
 * in the browser's media pipeline), transitioning from expanded panel → tray
 * chip and back preserves playback position without any gap.
 *
 * Elements are NOT released on dismiss. They stay in the pool for the session,
 * paused, ready to be re-acquired if the same source is re-opened. This is a
 * tiny amount of memory per unique file opened and avoids re-buffering on
 * re-open.
 *
 * ## Interaction with cross-player coordination
 *
 * Pool elements are NOT the only source of playback in the app — reference nodes
 * on the canvas have their own inline `<video>`/`<audio>` elements too. The
 * "at most one media playing at a time" invariant is enforced separately via
 * `previewStore.activePlayerId` + a subscription hook in each consumer. See
 * `useMediaPlaybackCoordinator.js` for details.
 */

const pool = new Map() // fileRef → HTMLMediaElement

/**
 * Return `'audio'` / `'video'` / `null` based on a file_ref's extension.
 * Duplicated from previewStore's getMediaKind to avoid a circular import at
 * module load time — both files are pure JS modules and this keeps the pool
 * independent.
 */
function kindFor(fileRef) {
  if (!fileRef || typeof fileRef !== 'string') return null
  const dot = fileRef.lastIndexOf('.')
  if (dot === -1) return null
  const ext = fileRef.slice(dot + 1).toLowerCase()
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) return 'audio'
  if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v'].includes(ext)) return 'video'
  return null
}

/**
 * Acquire (or create) the shared media element for a given fileRef. Returns
 * null for image files or unknown extensions.
 *
 * The element is returned in whatever state it's currently in. Callers should
 * check / set `src`, `currentTime`, `volume`, and call `play()` / `pause()` as
 * appropriate. `src` is set at creation time and should not normally need to
 * be changed (each unique fileRef has its own pool entry).
 */
export function acquireMediaElement(fileRef) {
  if (!fileRef) return null
  const kind = kindFor(fileRef)
  if (!kind) return null

  let el = pool.get(fileRef)
  if (el) return el

  el = document.createElement(kind)
  el.preload = 'auto'
  const assetName = fileRef.replace(/^assets\//, '')
  el.src = `/api/project/assets/${assetName}`
  pool.set(fileRef, el)
  return el
}

/**
 * Detach the element for `fileRef` from whatever DOM parent it's currently in,
 * leaving it alive and ready to be re-appended by a new consumer. Useful when a
 * component is about to unmount and wants to hand the element off cleanly.
 *
 * Unused in current code (React's unmount removes the container and the element
 * goes detached automatically, which is fine for `<audio>` — continues playing)
 * but kept here in case the video path needs explicit handling later.
 */
export function detachMediaElement(fileRef) {
  const el = pool.get(fileRef)
  if (el && el.parentNode) {
    el.parentNode.removeChild(el)
  }
}

/**
 * Pause and release the pool entry for `fileRef`. Call when a source is
 * definitively gone (e.g. the reference node it came from was deleted) and
 * the element should stop consuming resources.
 */
export function releaseMediaElement(fileRef) {
  const el = pool.get(fileRef)
  if (!el) return
  try { el.pause() } catch { /* noop */ }
  el.removeAttribute('src')
  try { el.load() } catch { /* noop */ }
  if (el.parentNode) el.parentNode.removeChild(el)
  pool.delete(fileRef)
}

/**
 * Iterate over every element currently in the pool. Used by the cross-player
 * coordinator to pause all pool elements when a different source becomes the
 * active player.
 */
export function forEachPoolElement(callback) {
  for (const [fileRef, el] of pool.entries()) {
    callback(el, fileRef)
  }
}
