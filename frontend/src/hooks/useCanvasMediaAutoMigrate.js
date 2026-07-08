import { useCallback, useEffect, useRef } from 'react'
import { useOnViewportChange } from '@xyflow/react'
import { usePreviewStore } from '../store/previewStore'
import { useProjectStore } from '../store/projectStore'
import { getInlineMediaEl } from '../components/nodes/ReferenceNode'
import { acquireMediaElement } from '../utils/mediaElementPool'

// Dead-band around the canvas edge so slow panning can't oscillate a node
// between inline and tray on every frame. 16px of slack either side of the
// viewport boundary.
const HYSTERESIS_PX = 16

// Check if a node DOM element is FULLY outside the canvas visible area.
// Used for the migrate-OUT decision (must be fully gone, not just clipped).
function isNodeFullyOffscreen(nodeRect, canvasRect) {
  return (
    nodeRect.right  < canvasRect.left   - HYSTERESIS_PX ||
    nodeRect.left   > canvasRect.right  + HYSTERESIS_PX ||
    nodeRect.bottom < canvasRect.top    - HYSTERESIS_PX ||
    nodeRect.top    > canvasRect.bottom + HYSTERESIS_PX
  )
}

// Check if a node DOM element is FULLY inside the canvas visible area.
// Used for the migrate-BACK decision (must be fully visible again, not just
// partially poking in from the edge — otherwise we'd flicker during edge
// grazes). Tightened by HYSTERESIS_PX so the dead-band is symmetric.
function isNodeFullyOnscreen(nodeRect, canvasRect) {
  return (
    nodeRect.left   >= canvasRect.left   + HYSTERESIS_PX &&
    nodeRect.right  <= canvasRect.right  - HYSTERESIS_PX &&
    nodeRect.top    >= canvasRect.top    + HYSTERESIS_PX &&
    nodeRect.bottom <= canvasRect.bottom - HYSTERESIS_PX
  )
}

function getNodeRect(nodeId) {
  const el = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`)
  return el ? el.getBoundingClientRect() : null
}

function getCanvasRect() {
  const el = document.querySelector('.react-flow')
  return el ? el.getBoundingClientRect() : null
}

/**
 * Auto-migrate an actively-playing media reference node's playback into the
 * collapsed tray chip when the node scrolls out of the visible canvas, and
 * back into the inline player when it scrolls back into view. Bidirectional.
 *
 * Relies on:
 *   - `previewStore.activePlayerId` to identify the actively-playing reference
 *     node (format `reference:<nodeId>`). If `activePlayerId` is anything else
 *     (null, `preview:*`, or nothing playing) the check is a full no-op, so
 *     paused video reference nodes being used as visual references are never
 *     touched by this hook.
 *   - `previewStore.openAsTrayChip` for direct-to-tray handoff without the
 *     expanded panel flashing into view.
 *   - `mediaElementPool.acquireMediaElement` to read current state off the
 *     pooled element when migrating back inline.
 *   - `ReferenceNode`'s inline media registry (`getInlineMediaEl`) for O(1)
 *     lookup of the node's live `<video>`/`<audio>` element.
 *
 * Called from `CanvasInner` so the hook runs under `ReactFlowProvider`.
 */
export default function useCanvasMediaAutoMigrate() {
  const activePlayerId = usePreviewStore((s) => s.activePlayerId)
  const trayChip = usePreviewStore((s) => s.trayChip)
  const openAsTrayChip = usePreviewStore((s) => s.openAsTrayChip)
  const dismissTrayChip = usePreviewStore((s) => s.dismissTrayChip)

  // rAF-coalesced check — useOnViewportChange fires many times per second
  // during a pan; we only need at most one check per frame.
  const pendingRef = useRef(false)

  const check = useCallback(() => {
    const canvasRect = getCanvasRect()
    if (!canvasRect) return

    // ── Migrate-back (tray → inline) ────────────────────────────────────────
    // Check this first so it can fire on re-entry before any competing logic.
    const state = usePreviewStore.getState()
    const tray = state.trayChip
    if (tray && tray.source?.type === 'reference_node') {
      const nodeId = tray.source.nodeId
      const nodeRect = getNodeRect(nodeId)
      if (nodeRect && isNodeFullyOnscreen(nodeRect, canvasRect)) {
        const inlineEl = getInlineMediaEl(nodeId)
        if (inlineEl) {
          const poolEl = acquireMediaElement(tray.source.fileRef)
          const captured = {
            currentTime: poolEl ? poolEl.currentTime : (tray.currentTime || 0),
            playing: poolEl ? !poolEl.paused : !!tray.playing,
            volume: poolEl ? poolEl.volume : (tray.volume != null ? tray.volume : 1.0),
          }
          // Pause pool element explicitly before swapping so there's no
          // window where both players could be running.
          if (poolEl && !poolEl.paused) {
            try { poolEl.pause() } catch { /* noop */ }
          }
          dismissTrayChip()
          // Restore state on inline element.
          try {
            if (Math.abs(inlineEl.currentTime - captured.currentTime) > 0.05) {
              inlineEl.currentTime = captured.currentTime
            }
          } catch { /* noop */ }
          try { inlineEl.volume = captured.volume } catch { /* noop */ }
          if (captured.playing) {
            const p = inlineEl.play()
            if (p && typeof p.catch === 'function') p.catch(() => {})
          }
          return
        }
      }
    }

    // ── Migrate-out (inline → tray) ─────────────────────────────────────────
    // Only consider reference nodes that are CURRENTLY the active player.
    // Everything else (paused inline media, preview-panel playback, nothing
    // playing) is a complete no-op.
    if (!activePlayerId || !activePlayerId.startsWith('reference:')) return
    const nodeId = activePlayerId.slice('reference:'.length)
    const inlineEl = getInlineMediaEl(nodeId)
    if (!inlineEl) return
    const nodeRect = getNodeRect(nodeId)
    if (!nodeRect) return
    if (!isNodeFullyOffscreen(nodeRect, canvasRect)) return

    // Look up the current node data from the project store at check time
    // (on-demand, no subscription) to get an accurate source descriptor.
    const node = useProjectStore.getState().nodes.find((n) => n.id === nodeId)
    const fileRef = node?.data?.file_ref
    if (!fileRef) return

    // Capture playback state from the inline element.
    const captured = {
      currentTime: inlineEl.currentTime,
      playing: !inlineEl.paused,
      paused: inlineEl.paused,
      volume: inlineEl.volume,
    }
    // Pause inline element explicitly before handing off.
    if (!inlineEl.paused) {
      try { inlineEl.pause() } catch { /* noop */ }
    }
    openAsTrayChip(
      {
        type: 'reference_node',
        nodeId,
        fileRef,
        title: node.data.title || 'Untitled',
        colour: node.data.colour || '#40afd0',
      },
      captured,
    )
  }, [activePlayerId, openAsTrayChip, dismissTrayChip])

  // Fire check on every viewport change (rAF-coalesced).
  useOnViewportChange({
    onChange: useCallback(() => {
      if (pendingRef.current) return
      pendingRef.current = true
      requestAnimationFrame(() => {
        pendingRef.current = false
        check()
      })
    }, [check]),
  })

  // Also re-run when activePlayerId or trayChip changes, so that a node
  // starting playback while already off-screen migrates immediately, and
  // so a tray chip being manually paused still gets picked up on the next
  // viewport change. Deferred to a microtask so React has finished
  // committing before we read the DOM.
  useEffect(() => {
    const id = requestAnimationFrame(() => check())
    return () => cancelAnimationFrame(id)
  }, [activePlayerId, trayChip, check])
}
