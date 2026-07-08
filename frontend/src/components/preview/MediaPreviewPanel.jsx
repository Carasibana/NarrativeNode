import { useCallback, useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { usePreviewStore } from '../../store/previewStore'
import { useProjectStore } from '../../store/projectStore'
import { acquireMediaElement } from '../../utils/mediaElementPool'
import { useAccentColor } from '../../utils/povConstants'
import PreviewSourceBadge from './PreviewSourceBadge'
import EqualizerIndicator from './EqualizerIndicator'

/**
 * Floating expanded Media Preview Panel — Phase 1.10 Track B.
 *
 * Single-instance (hard cap = 1). Content-adaptive sizing: image natural aspect ratio,
 * video native dimensions (with max-bounds), audio compact fixed size. Draggable via
 * the header. Reads from and writes to previewStore.
 *
 * ## Shared media element pool
 *
 * Audio and video playback goes through `mediaElementPool.js` — a module-scoped
 * pool of `<audio>` / `<video>` DOM elements keyed by fileRef. On mount, the panel
 * acquires the shared element for its source and appendChilds it into a container
 * div. On unmount, React removes the container div, which detaches the element
 * but does NOT destroy it — `<audio>` playback continues in the browser's media
 * pipeline while the node is detached. `MediaPreviewTrayChip` then picks up the
 * same element when it mounts, eliminating the re-buffer/re-seek gap that would
 * otherwise happen during collapse/expand transitions.
 *
 * Images still use an inline `<img>` tag — they don't need persistent state.
 *
 * ## Cross-player coordination
 *
 * The "at most one media playing at a time across the whole app" rule is enforced
 * via `previewStore.activePlayerId`. When the element fires `play`, we claim the
 * active-player slot; an effect watches activePlayerId and pauses our element if
 * the id changes to something that isn't ours. `ReferenceNode`'s inline player
 * participates in the same coordination.
 */
export default function MediaPreviewPanel() {
  const expanded = usePreviewStore((s) => s.expanded)
  const dismissPreview = usePreviewStore((s) => s.dismissPreview)
  const collapsePreview = usePreviewStore((s) => s.collapsePreview)
  const setPanelPosition = usePreviewStore((s) => s.setPanelPosition)
  const setPanelSize = usePreviewStore((s) => s.setPanelSize)
  const setExpandedPlayback = usePreviewStore((s) => s.setExpandedPlayback)
  const setActivePlayer = usePreviewStore((s) => s.setActivePlayer)
  const replaceExpandedSource = usePreviewStore((s) => s.replaceExpandedSource)
  const activePlayerId = usePreviewStore((s) => s.activePlayerId)
  const projectNodes = useProjectStore((s) => s.nodes)
  const updateNodeData = useProjectStore((s) => s.updateNodeData)
  const writeAttributeFileRef = useProjectStore((s) => s.writeAttributeFileRef)
  const accentColour = useAccentColor()

  // Replace File flow: hidden file input + upload state. Only supported for
  // reference_node sources in this phase; attribute sources will gain the same
  // flow in Track C.4 (writes via setAttrFileRefOverride instead of updateNodeData).
  const fileInputRef = useRef(null)
  const [uploading, setUploading] = useState(false)

  const dragState = useRef(null)   // header drag: { startX, startY, startPosX, startPosY }
  const resizeState = useRef(null) // resize drag: { startX, startY, startW, startH, aspect, headerH }
  const panelRef = useRef(null)
  const headerRef = useRef(null)           // measured to compute image-area height on resize
  const mediaContainerRef = useRef(null)  // div that will host the pooled media element
  const mediaElRef = useRef(null)          // the pooled <audio>/<video>, managed imperatively

  // Natural aspect ratio of the loaded media (image: naturalWidth/naturalHeight,
  // video: videoWidth/videoHeight). null until the media has loaded enough for the
  // browser to report dimensions. Audio has no aspect (fixed-size panel, no resize).
  const [naturalAspect, setNaturalAspect] = useState(null)

  // Measured height of the app's top <header> element. Used to position the
  // anchored panel just below the header so its top edge aligns with the canvas
  // area's top edge. Re-measured whenever a new panel opens (expanded.id change)
  // and on window resize since the header height can change with responsive
  // layout or content wrapping.
  const [headerOffsetY, setHeaderOffsetY] = useState(56)
  useEffect(() => {
    function measure() {
      const headerEl = document.querySelector('header')
      if (headerEl) {
        setHeaderOffsetY(headerEl.getBoundingClientRect().height)
      }
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [expanded?.id])

  // Reset aspect when the source changes so a previous media's aspect doesn't
  // leak into the new one before its load event fires.
  useEffect(() => { setNaturalAspect(null) }, [expanded?.id])

  // Cross-player coordination: stable per-instance id for the activePlayerId slot.
  const playerId = expanded ? `preview:${expanded.id}` : null

  // ── Auto-close when the source disappears ──────────────────────────────────
  // Dismiss the expanded panel if its underlying source has been deleted or its
  // media file cleared on the canvas. For reference_node sources: the node has
  // been deleted, or the user clicked the node's "Remove media" trash button
  // which sets data.file_ref = null. Attribute sources will be validated when
  // Track C wires up click-to-preview (no attribute callers exist yet).
  useEffect(() => {
    if (!expanded) return
    if (expanded.source?.type !== 'reference_node') return
    const node = projectNodes.find((n) => n.id === expanded.source.nodeId)
    const invalid = !node || node.data?.file_ref == null
    if (invalid) dismissPreview()
  }, [projectNodes, expanded, dismissPreview])

  // ── Cross-player coordination: pause our element when another player starts ──
  useEffect(() => {
    if (!playerId) return
    const el = mediaElRef.current
    if (!el) return
    if (activePlayerId && activePlayerId !== playerId && !el.paused) {
      el.pause()
    }
  }, [activePlayerId, playerId])

  // ── Drag the panel by the header ────────────────────────────────────────────
  // Safety nets against stuck drag state: end the drag on ANY of mouseup,
  // pointerup, window blur, visibility change, or Escape key. Multiple
  // cancellation paths mean if one event slips through (mouseup outside the
  // viewport, browser steals focus, tab switches, etc.) the others still
  // release the drag. A click event anywhere while dragging also ends it as
  // a final fallback.
  const handleHeaderMouseDown = useCallback((e) => {
    // Only drag on primary button and only when not clicking interactive children
    if (e.button !== 0) return
    if (e.target.closest('button')) return
    const current = usePreviewStore.getState().expanded
    if (!current) return
    e.preventDefault()
    // Read the panel's CURRENT rendered left/top from the DOM rather than
    // trusting `current.position.x/y`. When the panel is in anchored mode,
    // `position.x` is the RIGHT-edge offset (not an absolute left), so using
    // it directly would place the drag origin at the wrong x. Reading the
    // rect works for both anchored and absolute modes — it's always the
    // visual top-left of the panel — so the first mousemove's setPanelPosition
    // call clears the anchor and continues from the exact current position
    // without any visible jump.
    const panelEl = panelRef.current
    if (!panelEl) return
    const rect = panelEl.getBoundingClientRect()
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPosX: rect.left,
      startPosY: rect.top,
    }

    function onMove(ev) {
      if (!dragState.current) return
      const dx = ev.clientX - dragState.current.startX
      const dy = ev.clientY - dragState.current.startY
      const nextX = Math.max(0, Math.min(window.innerWidth - 100, dragState.current.startPosX + dx))
      const nextY = Math.max(0, Math.min(window.innerHeight - 40, dragState.current.startPosY + dy))
      setPanelPosition({ x: nextX, y: nextY })
    }
    function endDrag() {
      if (!dragState.current) return
      dragState.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', endDrag)
      document.removeEventListener('pointerup', endDrag)
      document.removeEventListener('click', endDrag, true)
      window.removeEventListener('blur', endDrag)
      document.removeEventListener('visibilitychange', onVisibility)
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.userSelect = ''
    }
    function onVisibility() {
      if (document.visibilityState === 'hidden') endDrag()
    }
    function onKeyDown(ev) {
      if (ev.key === 'Escape') endDrag()
    }
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', endDrag)
    document.addEventListener('pointerup', endDrag)
    document.addEventListener('click', endDrag, true)
    window.addEventListener('blur', endDrag)
    document.addEventListener('visibilitychange', onVisibility)
    document.addEventListener('keydown', onKeyDown)
  }, [setPanelPosition])

  // ── Acquire the pooled media element + wire event listeners ────────────────
  // Scoped to expanded?.id only. On source change: grab the pool element,
  // appendChild into our container (moves it here from wherever it was before —
  // tray chip container, document, or brand new), restore playback state, and
  // attach listeners. On unmount / source change, remove listeners and DO NOT
  // destroy the element — the next consumer will pick it up from the pool.
  useEffect(() => {
    const container = mediaContainerRef.current
    if (!expanded || !container) return
    if (expanded.kind !== 'audio' && expanded.kind !== 'video') return

    const el = acquireMediaElement(expanded.source.fileRef)
    if (!el) return
    mediaElRef.current = el

    // Show native controls in the panel (the tray chip hides this again on its side)
    el.controls = true
    el.style.display = ''
    if (expanded.kind === 'video') {
      el.className = 'rounded'
      // Video styling: content-adaptive (max-h 70vh) when panel is unsized,
      // fill-parent when panel is user-sized (parent is flex-1 min-h-0 with
      // exact aspect-matched dimensions).
      el.style.width = ''
      if (expanded.size) {
        el.style.maxWidth = '100%'
        el.style.maxHeight = '100%'
        el.style.height = '100%'
      } else {
        el.style.maxWidth = '100%'
        el.style.maxHeight = '70vh'
        el.style.height = ''
      }
    } else {
      // Audio: fixed compact layout, never resized.
      el.className = ''
      el.style.maxWidth = '100%'
      el.style.maxHeight = ''
      el.style.width = '360px'
      el.style.height = ''
    }

    // Move the element into our container (appendChild on an already-attached
    // element atomically moves it — playback and currentTime are preserved)
    container.appendChild(el)

    // Restore captured playback state. Only seek if there's a difference, so
    // re-entering an unchanged source doesn't cause a seek hiccup.
    if (expanded.currentTime != null && Math.abs(el.currentTime - expanded.currentTime) > 0.05) {
      try { el.currentTime = expanded.currentTime } catch { /* noop */ }
    }
    if (expanded.volume != null) el.volume = expanded.volume
    if (expanded.playing && el.paused) {
      const p = el.play()
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          setExpandedPlayback({ playing: false, paused: true })
        })
      }
    }

    // Capture natural aspect from video metadata. If loadedmetadata already fired
    // (e.g. the pool element was previously in use and metadata is cached), the
    // values are available immediately; otherwise we attach a one-shot listener.
    if (expanded.kind === 'video') {
      if (el.videoWidth > 0 && el.videoHeight > 0) {
        setNaturalAspect(el.videoWidth / el.videoHeight)
      } else {
        const onLoadedMeta = () => {
          if (el.videoWidth > 0 && el.videoHeight > 0) {
            setNaturalAspect(el.videoWidth / el.videoHeight)
          }
        }
        el.addEventListener('loadedmetadata', onLoadedMeta, { once: true })
      }
    }

    // Event listeners — feed playback events back into the store.
    const onPlay = () => {
      setExpandedPlayback({ playing: true, paused: false })
      // Claim the active-player slot so other players (reference nodes, other
      // preview instances) pause themselves via their own coordinator effects.
      setActivePlayer(`preview:${expanded.id}`)
    }
    const onPause = () => setExpandedPlayback({ playing: false, paused: true, currentTime: el.currentTime })
    const onEnded = () => setExpandedPlayback({ playing: false, paused: false, currentTime: 0 })
    const onTimeUpdate = () => setExpandedPlayback({ currentTime: el.currentTime })
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onEnded)
    el.addEventListener('timeupdate', onTimeUpdate)

    // Capture the fileRef this effect was for so cleanup can compare against
    // the post-cleanup store state and decide whether to preserve or tear down
    // the element.
    const elFileRef = expanded.source.fileRef

    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('timeupdate', onTimeUpdate)
      // Three cleanup scenarios:
      //   1. COLLAPSE → tray chip is now set with this same fileRef. The tray
      //      chip will acquire the element from the pool via appendChild,
      //      moving it from our container to theirs. Leave it playing.
      //   2. DISMISS → expanded is null, trayChip is null (or unrelated). The
      //      element should stop and detach so the user doesn't hear a ghost
      //      track continuing in the background.
      //   3. REPLACE SOURCE → expanded has a new id / different fileRef. The
      //      new effect run will acquire a different pool element. The old one
      //      should stop (Replace File flow) and be removed from our container
      //      so the new element can take its place cleanly.
      const state = usePreviewStore.getState()
      const handedOffToTray = state.trayChip && state.trayChip.source?.fileRef === elFileRef
      if (!handedOffToTray) {
        try { el.pause() } catch { /* noop */ }
        if (el.parentNode === container) {
          container.removeChild(el)
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded?.id])

  // ── Size-sync for the pooled video element ────────────────────────────────
  // The main mount effect above sets video styles once per source change.
  // When the user drags the resize handle (size changes) we also need to
  // switch the video between "fill parent" and "max-h: 70vh" modes without
  // re-running the whole acquire/appendChild/listener setup. Tiny dedicated
  // effect keyed to expanded?.size handles just the style swap.
  useEffect(() => {
    const el = mediaElRef.current
    if (!el || !expanded || expanded.kind !== 'video') return
    if (expanded.size) {
      el.style.maxWidth = '100%'
      el.style.maxHeight = '100%'
      el.style.height = '100%'
      el.style.width = ''
    } else {
      el.style.maxWidth = '100%'
      el.style.maxHeight = '70vh'
      el.style.height = ''
      el.style.width = ''
    }
  }, [expanded?.size, expanded?.kind])

  // ── Resize the panel from its bottom-right corner ──────────────────────────
  // Aspect-locked for image and video sources: the IMAGE AREA (panel minus
  // header) always matches the natural aspect ratio of the media. The panel's
  // total height is (image height) + (header height), so the header never
  // overlaps the image and the displayed media stays fully visible at its
  // correct proportions. Drag in either direction; we use the larger of the
  // proposed image width and (proposed image height × aspect) to drive the
  // image width, then derive image height via aspect and add the measured
  // header height to get the total panel height. Audio has no resize handle
  // so this only fires for image/video sources.
  //
  // Viewport clamping: the panel's top-left position is captured at drag-
  // start. The resize is clamped so that (position.x + panelW) never exceeds
  // the viewport width, and (position.y + panelH) never exceeds the viewport
  // height (with a small margin). If a clamp would break the aspect lock, the
  // OTHER dimension is reduced proportionally so the image area stays at its
  // natural aspect ratio and the whole panel stays visible.
  const handleResizeMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const el = panelRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // Measure the header's current rendered height so we can reserve space
    // for it explicitly in the resize math. Captured at drag-start so mid-drag
    // layout shifts (e.g. long filename wrapping) don't cause jitter.
    const headerH = headerRef.current?.getBoundingClientRect().height || 0
    // Capture the panel's current top-left position from the rendered rect
    // (works for both anchored and absolute modes). The panel can't be
    // dragged while resizing, so this stays valid through the drag.
    // We also convert the panel to absolute positioning immediately by
    // calling setPanelPosition with the current rect coordinates — this
    // unsticks an anchored panel so the bottom-right resize handle can
    // naturally move with the mouse instead of the top-right staying pinned
    // (which would make the handle move AWAY from the cursor when dragged
    // outward — confusing UX).
    if (usePreviewStore.getState().expanded?.anchored) {
      setPanelPosition({ x: rect.left, y: rect.top })
    }
    resizeState.current = {
      startX: e.clientX,
      startY: e.clientY,
      startW: rect.width,
      startH: rect.height,
      aspect: naturalAspect,  // captured at drag-start so async loads don't change mid-drag
      headerH,
      panelX: rect.left,
      panelY: rect.top,
    }

    function onMove(ev) {
      if (!resizeState.current) return
      const dx = ev.clientX - resizeState.current.startX
      const dy = ev.clientY - resizeState.current.startY
      const proposedW = resizeState.current.startW + dx
      const proposedH = resizeState.current.startH + dy
      const aspect = resizeState.current.aspect
      const headerH = resizeState.current.headerH
      const { panelX, panelY } = resizeState.current

      // Viewport bounds for the panel (with a small safety margin so the
      // resize handle stays reachable and the user can still drop the mouse).
      const margin = 16
      const maxPanelW = Math.max(260, window.innerWidth - panelX - margin)
      const maxPanelH = Math.max(120 + headerH, window.innerHeight - panelY - margin)

      let nextW, nextH
      if (aspect && aspect > 0) {
        // Drive aspect-locked resize from the bigger of "user-requested width"
        // and "user-requested height × aspect" so dragging in any direction
        // grows the panel naturally.
        const proposedImageH = Math.max(0, proposedH - headerH)
        const widthDriven = Math.max(proposedW, proposedImageH * aspect)
        let imageW = Math.max(260, widthDriven)
        let imageH = imageW / aspect

        // Clamp to viewport. If either dimension would overflow, reduce it and
        // recompute the other via aspect so the image stays fully visible and
        // at its natural proportions. Width clamp runs first; height clamp may
        // then further reduce if the width-driven height is still too tall.
        const maxImageH = Math.max(120, maxPanelH - headerH)
        if (imageW > maxPanelW) {
          imageW = maxPanelW
          imageH = imageW / aspect
        }
        if (imageH > maxImageH) {
          imageH = maxImageH
          imageW = imageH * aspect
          // Edge case: if the width-clamp ceiling is tighter than the height-
          // clamp recompute produced (tiny viewports, extreme aspect ratios),
          // bring width back in line and let the shrinkage cascade.
          if (imageW > maxPanelW) {
            imageW = maxPanelW
            imageH = imageW / aspect
          }
        }
        nextW = imageW
        nextH = imageH + headerH
      } else {
        // Fallback: free-form (shouldn't happen for image/video once loaded)
        nextW = Math.min(maxPanelW, Math.max(260, proposedW))
        nextH = Math.min(maxPanelH, Math.max(120, proposedH))
      }
      setPanelSize({ width: nextW, height: nextH })
    }
    function endResize() {
      if (!resizeState.current) return
      resizeState.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', endResize)
      document.removeEventListener('pointerup', endResize)
      document.removeEventListener('click', endResize, true)
      window.removeEventListener('blur', endResize)
      document.removeEventListener('visibilitychange', onVisibility)
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    function onVisibility() {
      if (document.visibilityState === 'hidden') endResize()
    }
    function onKeyDown(ev) {
      if (ev.key === 'Escape') endResize()
    }
    document.body.style.cursor = 'nwse-resize'
    document.body.style.userSelect = 'none'
    // Safety nets: end the resize on ANY of mouseup, pointerup, window blur,
    // visibility change, Escape key, or any click event. Multiple cancellation
    // paths prevent the "stuck dragging" state where a single mouseup miss
    // (e.g. off the viewport, browser steals focus) leaves the resize active.
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', endResize)
    document.addEventListener('pointerup', endResize)
    document.addEventListener('click', endResize, true)
    window.addEventListener('blur', endResize)
    document.addEventListener('visibilitychange', onVisibility)
    document.addEventListener('keydown', onKeyDown)
  }, [setPanelSize, naturalAspect])

  // ── Auto-clamp on window resize ───────────────────────────────────────────
  // When the browser window shrinks below what the current panel size can fit,
  // re-clamp the panel's explicit size (if set) so it stays fully visible and
  // doesn't push the resize handle or close button off-screen. Aspect ratio is
  // preserved: we reduce the image area to fit and the panel adjusts height to
  // match.
  //
  // Skipped when `anchored: true` — in that mode, CSS `right: position.x`
  // handles window resize automatically: the panel's right edge stays glued
  // to the viewport corner, and the content-adaptive maxWidth (min(720px,
  // calc(100vw - 40px))) prevents overflow of the left edge. Absolute left/top
  // panels still need this clamp because they don't have that CSS safety net.
  useEffect(() => {
    if (expanded?.anchored) return
    if (!expanded?.size || !expanded?.position) return
    function clampToViewport() {
      const current = usePreviewStore.getState().expanded
      if (current?.anchored) return
      if (!current?.size || !current?.position) return
      const headerH = headerRef.current?.getBoundingClientRect().height || 0
      const margin = 16
      const maxPanelW = Math.max(260, window.innerWidth - current.position.x - margin)
      const maxPanelH = Math.max(120 + headerH, window.innerHeight - current.position.y - margin)
      let { width, height } = current.size
      let changed = false
      if (width > maxPanelW) { width = maxPanelW; changed = true }
      if (height > maxPanelH) { height = maxPanelH; changed = true }
      if (changed && naturalAspect && naturalAspect > 0) {
        // Re-lock aspect ratio after the raw clamp.
        const maxImageH = Math.max(120, maxPanelH - headerH)
        let imageW = Math.min(width, maxPanelW)
        let imageH = imageW / naturalAspect
        if (imageH > maxImageH) {
          imageH = maxImageH
          imageW = imageH * naturalAspect
        }
        width = imageW
        height = imageH + headerH
      }
      if (changed) setPanelSize({ width, height })
    }
    window.addEventListener('resize', clampToViewport)
    // Run once on mount in case the window is already smaller than the stored size.
    clampToViewport()
    return () => window.removeEventListener('resize', clampToViewport)
  }, [expanded?.size, expanded?.position, expanded?.anchored, naturalAspect, setPanelSize])

  // ── Replace Media flow ─────────────────────────────────────────────────────
  // Supports both source types:
  //   - `reference_node`: writes the new file_ref to the node via updateNodeData
  //   - `attribute`: delegates to projectStore.writeAttributeFileRef, which
  //     handles all three possible chain positions (origin entity_node,
  //     modifier entity_node, plot-point scene node) by writing either
  //     directly to entity.attributes[] or via a file_ref_change entry in the
  //     node's attribute_changes, matching the profile_image_change pattern.
  // In both cases, after the upload succeeds we swap the panel's source in
  // place via replaceExpandedSource so the pool acquires the new element.
  const handleReplaceClick = useCallback((e) => {
    e.stopPropagation()
    if (!expanded) return
    if (expanded.source?.type !== 'reference_node' && expanded.source?.type !== 'attribute') return
    if (uploading) return
    fileInputRef.current?.click()
  }, [expanded, uploading])

  const handleFileChosen = useCallback(async (e) => {
    const file = e.target.files?.[0]
    // Reset the input so the same file can be re-chosen later.
    e.target.value = ''
    if (!file || !expanded) return
    const srcType = expanded.source?.type
    if (srcType !== 'reference_node' && srcType !== 'attribute') return
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await axios.post('/api/project/assets/upload', formData)
      const newFileRef = res.data.file_ref
      if (!newFileRef) return

      if (srcType === 'reference_node') {
        // Reference node: write directly to node.data.file_ref. Old asset stays
        // in the ZIP until the next save-time cleanup sweep prunes it.
        updateNodeData(expanded.source.nodeId, { file_ref: newFileRef })
      } else {
        // Attribute: delegate to the store action which handles origin vs
        // modifier vs scene contexts and writes via the correct codepath
        // (direct entity mutation at origin, file_ref_change entry otherwise).
        writeAttributeFileRef(
          expanded.source.entityId,
          expanded.source.attributeId,
          expanded.source.atNodeId,
          newFileRef,
        )
      }

      // Swap the preview panel's source in place (keeps position/size).
      replaceExpandedSource({
        ...expanded.source,
        fileRef: newFileRef,
      })
    } catch (err) {
      console.error('Media replace upload failed:', err)
    } finally {
      setUploading(false)
    }
  }, [expanded, updateNodeData, writeAttributeFileRef, replaceExpandedSource])

  // ── Collapse handler ───────────────────────────────────────────────────────
  // Reads the freshest currentTime from the element and pushes it to the store
  // BEFORE calling collapsePreview(), so when collapsePreview moves state to the
  // tray slot the captured position is accurate. The useEffect cleanup can't do
  // this — by the time it runs, `expanded` is already null in the store and
  // setExpandedPlayback is a no-op.
  const handleCollapseClick = useCallback((e) => {
    e.stopPropagation()
    const el = mediaElRef.current
    if (el) {
      setExpandedPlayback({
        currentTime: el.currentTime,
        playing: !el.paused,
        paused: el.paused,
        volume: el.volume,
      })
    }
    collapsePreview()
  }, [collapsePreview, setExpandedPlayback])

  if (!expanded) return null

  const { source, kind, position, size, anchored } = expanded
  // A preview source carries EITHER a project `fileRef` (assets/-relative
  // path that gets mapped to a backend asset URL) OR a direct `url` (e.g.
  // a transient blob URL for a picked-but-not-saved file the chat panel
  // attaches in 2.5e). Prefer the direct url when set; otherwise compute
  // the asset URL from fileRef. `assetName` is the display label used in
  // the panel header — `source.title` overrides it when provided.
  const assetName = source.title
    || (source.fileRef ? source.fileRef.replace(/^assets\//, '') : null)
  const assetUrl = source.url
    || (source.fileRef ? `/api/project/assets/${source.fileRef.replace(/^assets\//, '')}` : null)

  // Position + sizing has two modes:
  //
  //   ANCHORED — fresh panel, pinned to the top-right of the canvas area
  //   below the app header. CSS uses `right: position.x` (x = right-edge
  //   offset from viewport edge, default 16px) and `top: headerOffsetY`.
  //   The right edge stays glued to the canvas corner regardless of content
  //   width, so audio (360px), video (native), and image (up to 720px)
  //   panels all line up at the same right edge.
  //
  //   ABSOLUTE — after the user drags or resizes. CSS uses
  //   `left: position.x, top: position.y` as pixel coordinates. setPanelPosition
  //   clears anchored to false on first move. The transition is seamless
  //   because drag/resize handlers measure the current rendered position via
  //   getBoundingClientRect at drag-start, so the absolute coordinates match
  //   the anchored-CSS output exactly and there's no visible jump.
  const sizeStyle = size
    ? { width: size.width, height: size.height }
    : { maxWidth: 'min(720px, calc(100vw - 40px))', maxHeight: 'calc(100vh - 100px)' }
  // Small vertical gap between the app header and the anchored panel's top
  // edge so the panel doesn't visually sit flush against the header border.
  const ANCHOR_TOP_GAP = 8
  const panelStyle = anchored
    ? { ...sizeStyle, right: position.x, top: headerOffsetY + ANCHOR_TOP_GAP }
    : { ...sizeStyle, left: position.x, top: position.y }

  return (
    <div
      ref={panelRef}
      data-help-region="media-preview:panel"
      className="fixed z-50 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl flex flex-col select-none overflow-hidden"
      style={panelStyle}
    >
      {/* ── Header (draggable) ─────────────────────────────────────────────── */}
      <div
        ref={headerRef}
        data-help-region="media-preview:header"
        onMouseDown={handleHeaderMouseDown}
        className="flex items-center gap-2 px-2 py-1.5 bg-zinc-800/80 border-b border-zinc-700 cursor-move flex-shrink-0"
      >
        <div className="flex-1 min-w-0" data-help-region="media-preview:metadata">
          <PreviewSourceBadge source={source} />
        </div>
        {/* Equalizer indicator — same visual language as the tray chip. Animates
            while playing, static dim while paused. Only shown for audio/video
            (images have no playback state). */}
        {(kind === 'audio' || kind === 'video') && (
          <EqualizerIndicator playing={expanded.playing} colour={accentColour} />
        )}
        {/* Replace Media is only meaningful when the source is a
            persisted asset under the project (reference node or
            entity attribute). Transient chat-attachment previews
            have no upload target — the file is just being shown.
            Hide the button + input entirely for those sources so
            the header doesn't show a control that wouldn't do
            anything. */}
        {(source?.type === 'reference_node' || source?.type === 'attribute') && (
          <>
            <button
              type="button"
              onClick={handleReplaceClick}
              disabled={uploading}
              data-help-region="media-preview:replace_media"
              title={uploading ? 'Uploading…' : 'Replace this media file'}
              className="text-[10px] text-zinc-400 hover:text-zinc-100 bg-zinc-700 hover:bg-zinc-600 rounded px-2 py-0.5 flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {uploading ? 'Uploading…' : 'Replace Media'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept="image/*,video/*,audio/*"
              onChange={handleFileChosen}
            />
          </>
        )}
        <button
          type="button"
          onClick={handleCollapseClick}
          data-help-region="media-preview:collapse"
          title="Collapse to tray"
          className="text-zinc-400 hover:text-zinc-100 text-sm leading-none px-1 flex-shrink-0"
        >
          −
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); dismissPreview() }}
          data-help-region="media-preview:close"
          title="Close preview"
          className="text-zinc-400 hover:text-red-400 text-sm leading-none px-1 flex-shrink-0"
        >
          ✕
        </button>
      </div>

      {/* ── Body (content-adaptive OR flex-fill when user-sized) ───────────── */}
      {/* Body is padding-free in both modes — the image sits edge-to-edge
          beneath the header. When `size` is null the body sizes to content;
          when the user has explicitly resized, the body becomes flex-1 min-h-0
          to fill the precisely-calculated image area (panelHeight − headerHeight). */}
      <div data-help-region="media-preview:preview" className={`flex items-center justify-center bg-zinc-950/40 overflow-hidden ${
        size ? 'flex-1 min-h-0' : ''
      }`}>
        {!assetUrl && (
          <div className="text-xs text-zinc-500 italic py-8 px-12">No media file</div>
        )}
        {assetUrl && kind === 'image' && (
          <img
            src={assetUrl}
            alt=""
            className={size
              ? 'w-full h-full object-contain'
              : 'max-w-full max-h-[70vh] object-contain rounded'
            }
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget
              if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                setNaturalAspect(img.naturalWidth / img.naturalHeight)
              }
            }}
          />
        )}
        {/* Audio and video go through the shared media element pool — this div
            is just the container the pooled element gets appendChild'd into. */}
        {assetUrl && (kind === 'audio' || kind === 'video') && (
          <div
            ref={mediaContainerRef}
            className={size
              ? 'flex items-center justify-center w-full h-full'
              : 'flex items-center justify-center w-full'
            }
          />
        )}
        {assetUrl && !kind && (
          <div className="text-xs text-zinc-500 italic py-8 px-12">
            Unsupported file type: {assetName}
          </div>
        )}
      </div>

      {/* ── Resize handle (bottom-right corner) ─────────────────────────────── */}
      {/* Only rendered for image and video — audio preview panel is static size.
          Also requires the natural aspect ratio to be known (i.e. the image/video
          has loaded), so the aspect-lock logic can kick in immediately. */}
      {(kind === 'image' || kind === 'video') && naturalAspect && (
        <div
          onMouseDown={handleResizeMouseDown}
          data-help-region="media-preview:resize_handle"
          title="Drag to resize (aspect locked)"
          className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize flex items-end justify-end"
          style={{ touchAction: 'none' }}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" className="text-zinc-600">
            <line x1="4"  y1="14" x2="14" y2="4"  stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            <line x1="8"  y1="14" x2="14" y2="8"  stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            <line x1="12" y1="14" x2="14" y2="12" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          </svg>
        </div>
      )}
    </div>
  )
}
