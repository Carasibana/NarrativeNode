import { useCallback, useEffect, useRef, useState } from 'react'
import { usePreviewStore } from '../../store/previewStore'
import { useProjectStore } from '../../store/projectStore'
import { acquireMediaElement } from '../../utils/mediaElementPool'
import { useAccentColor } from '../../utils/povConstants'
import PreviewSourceBadge from './PreviewSourceBadge'
import EqualizerIndicator from './EqualizerIndicator'

/**
 * Collapsed tray chip for the Media Preview Panel system — Phase 1.10 Track B.
 *
 * Uses the shared media element pool (`mediaElementPool.js`) so the same DOM
 * element that was playing in `MediaPreviewPanel` before collapse continues
 * playing here with no reload or seek. On mount, the tray chip acquires the
 * pool element for its source and appendChilds it into a hidden slot inside
 * the chip. On unmount, the element is left in the pool ready for the next
 * consumer (the expanded panel on re-expand) to appendChild it elsewhere.
 *
 * For video sources, the element is kept `display:none` — audio continues
 * playing but the frame isn't visible. The video PiP thumbnail originally
 * planned for Batch 3 was cut during design review: it would have been a
 * near-duplicate of the expanded panel's visual, and the user explicitly
 * chose to keep video collapse behaviour as "audio-only" for simplicity.
 *
 * Controls (planning doc spec):
 *   - single play/pause toggle (primary affordance)
 *   - dismiss ✕ (stops playback and removes the chip)
 *   - click the chip body outside the buttons → re-expand the full panel
 *   - mouse wheel on hover → volume adjust (no visible slider) + percentage tooltip
 *   - animated equalizer indicator next to the play/pause toggle
 *
 * Cross-player coordination via `previewStore.activePlayerId`: when the element
 * fires `play`, we claim the active-player slot; the subscriber effect below
 * pauses our element if some other player (a reference node's inline player,
 * a future attribute preview, etc.) claims the slot instead.
 */
export default function MediaPreviewTrayChip() {
  const trayChip = usePreviewStore((s) => s.trayChip)
  const expandTrayChip = usePreviewStore((s) => s.expandTrayChip)
  const dismissTrayChip = usePreviewStore((s) => s.dismissTrayChip)
  const setTrayPlayback = usePreviewStore((s) => s.setTrayPlayback)
  const setActivePlayer = usePreviewStore((s) => s.setActivePlayer)
  const activePlayerId = usePreviewStore((s) => s.activePlayerId)
  // Phase 4.1g follow-up — derive the source-node validity verdict INSIDE
  // the selector rather than subscribing to the whole `s.nodes` array. The
  // old `useProjectStore((s) => s.nodes)` re-rendered the tray chip (and
  // re-ran its pooled-media-element effects) on every nodes-array write.
  // The find here is the same one the auto-dismiss effect already ran; the
  // selector returns a boolean, so Zustand's Object.is gate re-renders the
  // chip only when the source node actually goes invalid.
  const sourceInvalid = useProjectStore((s) => {
    if (!trayChip || trayChip.source?.type !== 'reference_node') return false
    const node = s.nodes.find((n) => n.id === trayChip.source.nodeId)
    return !node || node.data?.file_ref == null || node.data.file_ref !== trayChip.source.fileRef
  })
  const accentColour = useAccentColor()

  const mediaContainerRef = useRef(null)  // hidden div that hosts the pooled element
  const mediaElRef = useRef(null)          // the pooled <audio>/<video>

  // Volume tooltip state — shown briefly while the user mouse-wheels over the
  // chip to adjust volume, then fades after ~800ms of no new wheel events.
  const [volumeTip, setVolumeTip] = useState(null)  // { pct, x, y } | null
  const volumeTimerRef = useRef(null)

  // Cross-player coordination id — stable per-instance.
  const playerId = trayChip ? `preview:${trayChip.id}` : null

  // Clear any pending volume-tooltip timer on unmount so a dismiss during a
  // debounce window doesn't try to setState on a torn-down component.
  useEffect(() => {
    return () => {
      if (volumeTimerRef.current) {
        clearTimeout(volumeTimerRef.current)
        volumeTimerRef.current = null
      }
    }
  }, [])

  // ── Auto-dismiss when the source disappears or changes ───────────────────
  // Same validator as the expanded panel — if the reference node has been
  // deleted or its file_ref cleared via the "Remove media" button, the tray
  // chip also clears itself. Also dismiss if the node's file_ref has changed
  // to a different asset (e.g. "Replace Media"), so the tray doesn't keep
  // playing a stale file that no longer matches the source node.
  useEffect(() => {
    if (!trayChip) return
    if (trayChip.source?.type !== 'reference_node') return
    if (sourceInvalid) {
      const el = mediaElRef.current
      if (el) el.pause()
      dismissTrayChip()
    }
  }, [sourceInvalid, trayChip, dismissTrayChip])

  // ── Cross-player coordination: pause our element when another player starts ──
  useEffect(() => {
    if (!playerId) return
    const el = mediaElRef.current
    if (!el) return
    if (activePlayerId && activePlayerId !== playerId && !el.paused) {
      el.pause()
    }
  }, [activePlayerId, playerId])

  // ── Acquire the pooled media element + wire event listeners ───────────────
  // Same pattern as MediaPreviewPanel: grab the element from the pool,
  // appendChild it into our hidden container (moves it here from wherever
  // the expanded panel had it), restore state, attach listeners. On unmount,
  // remove listeners but do NOT destroy the element — the next consumer
  // (a re-expanded MediaPreviewPanel) reacquires and appendChilds elsewhere.
  useEffect(() => {
    const container = mediaContainerRef.current
    if (!trayChip || !container) return
    if (trayChip.kind !== 'audio' && trayChip.kind !== 'video') return

    const el = acquireMediaElement(trayChip.source.fileRef)
    if (!el) return
    mediaElRef.current = el

    // Hide the element visually in the tray — audio has no visible UI anyway,
    // and video's frame is intentionally not shown while collapsed per the
    // cut-from-scope video-PiP decision.
    el.controls = false
    el.style.display = 'none'

    container.appendChild(el)

    // Restore captured playback state (only seek on a meaningful delta)
    if (trayChip.currentTime != null && Math.abs(el.currentTime - trayChip.currentTime) > 0.05) {
      try { el.currentTime = trayChip.currentTime } catch { /* noop */ }
    }
    if (trayChip.volume != null) el.volume = trayChip.volume
    if (trayChip.playing && el.paused) {
      const p = el.play()
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          // Browser autoplay policy blocked the resume. Correct the store
          // state so the equalizer and play/pause button reflect reality.
          setTrayPlayback({ playing: false, paused: true })
        })
      }
    }

    const onPlay = () => {
      setTrayPlayback({ playing: true, paused: false })
      setActivePlayer(`preview:${trayChip.id}`)
    }
    const onPause = () => setTrayPlayback({ playing: false, paused: true, currentTime: el.currentTime })
    const onEnded = () => {
      setTrayPlayback({ playing: false, paused: false, currentTime: 0 })
      dismissTrayChip()
    }
    const onTimeUpdate = () => setTrayPlayback({ currentTime: el.currentTime })
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onEnded)
    el.addEventListener('timeupdate', onTimeUpdate)

    const elFileRef = trayChip.source.fileRef

    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('timeupdate', onTimeUpdate)
      // Symmetric with MediaPreviewPanel's cleanup: if no other slot is using
      // this element's fileRef, pause and detach. If the panel is about to
      // take it over (expand flow), leave it alone — the new effect there
      // will appendChild the same element to its own container.
      const state = usePreviewStore.getState()
      const inUseByPanel = state.expanded && state.expanded.source?.fileRef === elFileRef
      const inUseByTray = state.trayChip && state.trayChip.source?.fileRef === elFileRef
      if (!inUseByPanel && !inUseByTray) {
        try { el.pause() } catch { /* noop */ }
        if (el.parentNode === container) {
          container.removeChild(el)
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trayChip?.id])

  const handleTogglePlay = useCallback((e) => {
    e.stopPropagation()
    const el = mediaElRef.current
    if (!el) return
    if (el.paused) {
      el.play().catch(() => {})
    } else {
      el.pause()
    }
  }, [])

  const handleDismiss = useCallback((e) => {
    e.stopPropagation()
    const el = mediaElRef.current
    if (el) el.pause()
    dismissTrayChip()
  }, [dismissTrayChip])

  const handleExpand = useCallback(() => {
    // Capture the freshest currentTime/playing before expandTrayChip moves
    // the state. Symmetric with the handleCollapseClick path in MediaPreviewPanel.
    const el = mediaElRef.current
    if (el) {
      setTrayPlayback({
        currentTime: el.currentTime,
        playing: !el.paused,
        paused: el.paused,
        volume: el.volume,
      })
    }
    expandTrayChip()
  }, [expandTrayChip, setTrayPlayback])

  const handleWheel = useCallback((e) => {
    const el = mediaElRef.current
    if (!el) return
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.05 : 0.05
    const next = Math.max(0, Math.min(1, el.volume + delta))
    el.volume = next
    setTrayPlayback({ volume: next })
    // Show the volume percentage tooltip near the cursor while scrolling,
    // and clear it after a short debounce window of no new wheel events.
    setVolumeTip({
      pct: Math.round(next * 100),
      x: e.clientX,
      y: e.clientY,
    })
    if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current)
    volumeTimerRef.current = setTimeout(() => setVolumeTip(null), 800)
  }, [setTrayPlayback])

  if (!trayChip) return null

  const { source, playing } = trayChip

  return (
    <>
    <div
      onClick={handleExpand}
      onWheel={handleWheel}
      data-help-region="media-preview-tray:chip"
      title="Click to expand — mouse wheel to adjust volume"
      className="flex items-center gap-2 bg-zinc-700 hover:bg-zinc-600 rounded px-1.5 py-1 cursor-pointer select-none max-w-[340px]"
    >
      {/* Hidden container for the pooled media element. display:none on the
          element itself so the container is zero-size. */}
      <div ref={mediaContainerRef} style={{ display: 'none' }} />

      {/* Source badge — compact; clicking it routes to source via its own handler
          (which stopPropagation's so the chip's expand handler doesn't fire). */}
      <div className="min-w-0 flex-shrink">
        <PreviewSourceBadge source={source} />
      </div>

      {/* Equalizer indicator — animates while playing, static dim while paused;
          tinted with the live story accent colour so it matches the app theme. */}
      <EqualizerIndicator playing={playing} colour={accentColour} />

      {/* Play / pause toggle */}
      <button
        type="button"
        onClick={handleTogglePlay}
        data-help-region="media-preview-tray:play_pause"
        title={playing ? 'Pause' : 'Play'}
        className="flex-shrink-0 text-zinc-200 hover:text-white text-xs leading-none px-1"
      >
        {playing ? '\u23F8' : '\u25B6'}
      </button>

      {/* Dismiss ✕ — stops playback and removes the chip from the tray */}
      <button
        type="button"
        onClick={handleDismiss}
        data-help-region="media-preview-tray:dismiss"
        title="Stop and close"
        className="flex-shrink-0 text-zinc-400 hover:text-zinc-200 text-xs leading-none px-0.5"
      >
        ×
      </button>
    </div>

    {/* Volume tooltip — floats above the cursor while mousewheel adjusts volume.
        Fixed positioned (viewport-relative) so it escapes the top-bar container.
        pointer-events-none so it never intercepts clicks or further wheel events. */}
    {volumeTip && (
      <div
        className="fixed z-50 px-2 py-0.5 rounded bg-zinc-900/90 border border-zinc-700 text-zinc-100 text-[10px] font-medium pointer-events-none shadow-lg"
        style={{ left: volumeTip.x + 12, top: volumeTip.y - 22 }}
      >
        {volumeTip.pct}%
      </div>
    )}
    </>
  )
}
