/**
 * Phase 1.20 drag-time port feedback wrapper.
 *
 * Drop-in replacement for React Flow's <Handle>. Wraps the underlying Handle
 * with drag-time overlay rendering: accent halo when the port accepts the
 * current in-flight drag, red X reject overlay when it would have accepted
 * but a guard (cycle / pov-loop / story-order) blocks the drop.
 *
 * Migration pattern per call site:
 *   before:  <Handle type="target" position={Position.Left} id="pov-in" style={...} />
 *   after:   <PortHandle nodeId={id} nodeType="sceneNode"
 *                        type="target" position={Position.Left} id="pov-in" style={...} />
 *
 * Where `id` / `nodeType` come from the parent node component (React Flow
 * passes node `id` as a prop to custom node components; `nodeType` is a
 * static string the parent knows about itself).
 *
 * Three visual states during an active drag:
 *   - resting: port does not accept the current payload type. No visual
 *     change -- NOT dimmed (per Phase 1.20 §P5).
 *   - accept: port accepts the payload AND the drop is not guard-blocked.
 *     Accent halo on the handle via box-shadow (5 px ring + outer glow).
 *   - reject: port accepts the payload BUT a guard would block it. Red X
 *     SVG overlay with black stroke underlay (pattern from
 *     ChangeSubChip.jsx:41-46), plus a red ring on the handle itself. No
 *     halo.
 *
 * Perf: each PortHandle subscribes to uiStore.activeDrag via a stable
 * selector. activeDrag changes twice per drag (start + end), so each port
 * re-renders twice per drag session. State is derived inline from the
 * handle's own id/type + the activeDrag payload; no per-frame recompute.
 */

import { useMemo, useRef, useState, useLayoutEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Handle } from '@xyflow/react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { accepts as portAccepts, isSameNodeSelfLoop } from '../../utils/portCatalogue'
import { measureHandlePosition } from '../../utils/portMeasurement'
import { useCanvasAccentColor } from './canvasContexts'
import { incomingAtTargetHandle } from '../../utils/edgeIndexes'

const REJECT_RING_COLOUR = '#ef4444'
const REJECT_X_SIZE = 20  // px -- visible overlay around 8-10 px ports
// Accept halo is portal-rendered via the `.nn-port-halo` class in
// index.css (pulse animation + radial gradient using accent purple
// #a855f7). See the keyframes block there for the colour stops.

function resolveOverlayState({ activeDrag, nodeId, nodeType, handleId, handleType }) {
  if (!activeDrag) return 'resting'
  // Source handles never light up during a drag -- only candidate targets do.
  if (handleType === 'source') return 'resting'
  const canAccept = portAccepts({
    targetNodeType: nodeType,
    targetHandleId: handleId ?? null,
    payloadType: activeDrag.payloadType,
  })
  if (!canAccept) return 'resting'
  const handleKey = `${nodeId}:${handleId ?? ''}`
  const handleBlocked = activeDrag.blockedTargetHandles?.has?.(handleKey) ?? false
  // Same-node target: resolve via self-loop detection. The blocked-set
  // precompute explicitly skips the source node for guard checks, so
  // node-level same-node rejection is purely a port-level concern handled
  // here. Per-port blocks (already-participant rel-in) still apply.
  if (nodeId === activeDrag.sourceNodeId) {
    // Phase 8.1 , a concept port's own node is never a valid target; show
    // nothing (not a reject X on every sibling port) during the drag.
    if (typeof activeDrag.sourceHandleId === 'string' && activeDrag.sourceHandleId.startsWith('concept-')) {
      return 'resting'
    }
    const selfLoop = isSameNodeSelfLoop({
      sourceNodeType: activeDrag.sourceNodeType,
      sourceHandleId: activeDrag.sourceHandleId,
      targetNodeType: nodeType,
      targetHandleId: handleId ?? null,
    })
    if (selfLoop || handleBlocked) return 'reject'
    return 'accept'
  }
  const nodeBlocked = activeDrag.blockedTargetNodeIds?.has?.(nodeId) ?? false
  return (nodeBlocked || handleBlocked) ? 'reject' : 'accept'
}

function buildHandleStyle(baseStyle, overlayState) {
  // Accept halo no longer rides on the Handle itself — it's portal-
  // rendered into the outer `.react-flow__node` wrapper below so it
  // escapes the inner node container's `overflow: hidden` (the port
  // sits on the node's edge, so a boxShadow here gets chopped in half).
  // The reject case keeps its inline red ring as a secondary cue
  // alongside the portal-rendered X.
  if (overlayState === 'reject') {
    return {
      ...baseStyle,
      boxShadow: `0 0 0 3px ${REJECT_RING_COLOUR}`,
    }
  }
  return baseStyle
}

// Handle DOM measurement is shared with DragTooltip via
// utils/portMeasurement.js -- the reject X overlay uses it here to portal
// into the outer `.react-flow__node` wrapper (overflow: visible) and dodge
// the inner node container's `overflow: hidden` clip.

export default function PortHandle(props) {
  const { nodeId, nodeType, style, onClick, ...handleProps } = props
  // Phase 4.1g follow-up — derive the overlay state INSIDE the selector
  // instead of subscribing to the whole `activeDrag` object. The old
  // `useUiStore((s) => s.activeDrag)` re-rendered ALL ~1,778 handles
  // twice per drag (activeDrag flips at start + end), even though only a
  // handful are ever drop candidates. Now the selector returns the
  // resolved string ('resting' | 'accept' | 'reject'); Zustand's Object.is
  // gate means a handle re-renders only when ITS OWN state changes, so
  // the non-candidate majority (always 'resting') skip the render. With
  // no drag in flight `resolveOverlayState` short-circuits to 'resting'
  // on its first line, so unrelated uiStore writes stay cheap.
  const overlayState = useUiStore((s) => resolveOverlayState({
    activeDrag: s.activeDrag,
    nodeId,
    nodeType,
    handleId: handleProps.id,
    handleType: handleProps.type,
  }))
  const openWireListPopup = useUiStore((s) => s.openWireListPopup)
  // F#11: read the canvas-level accent colour via context instead of
  // calling `useAccentColor()` directly. Each PortHandle previously
  // opened its own subscription to the accent store — with ~2k
  // PortHandle instances on a real canvas, that's ~2k redundant
  // subscriptions to a value that essentially never changes during a
  // session. The provider sits at the Canvas root and re-renders all
  // PortHandles when the accent actually changes (rare, intentional).
  // Verified call-site audit: every existing PortHandle call site is
  // under the canvas provider (React Flow custom node components only).
  // Fallback default applies only if PortHandle is ever mounted outside
  // the canvas — currently never the case.
  const accentColor = useCanvasAccentColor() || '#a855f7'
  const handleRef = useRef(null)

  // Click on a target handle that has at least one wire connected →
  // open the wire-list popup. The popup lists each incoming wire with
  // per-row sever / go-to-source / hover-highlight actions. Source
  // handles and unwired target handles fall through to the default
  // React Flow click behaviour (which currently does nothing for
  // either, but lets a parent-supplied `onClick` still fire).
  const handleClick = useCallback((e) => {
    if (handleProps.type === 'target') {
      const edges = useProjectStore.getState().edges
      const handleId = handleProps.id ?? null
      // Perf #11: lookup via shared `edgesByTargetHandle` index — see
      // utils/edgeIndexes.js. Module-level cache keyed on the `edges`
      // reference identity so any mutation rebuilds; the gate becomes
      // O(1) instead of an O(N) edge scan.
      const incoming = incomingAtTargetHandle(edges, nodeId, handleId)
      if (incoming.length > 0) {
        e.stopPropagation()
        e.preventDefault()
        const rect = handleRef.current?.getBoundingClientRect?.()
        const anchorRect = rect ? {
          left: rect.left, top: rect.top, right: rect.right,
          bottom: rect.bottom, width: rect.width, height: rect.height,
        } : null
        openWireListPopup({ nodeId, handleId, anchorRect })
        return
      }
    }
    if (typeof onClick === 'function') onClick(e)
  }, [handleProps.type, handleProps.id, nodeId, openWireListPopup, onClick])
  const resolvedStyle = useMemo(
    () => buildHandleStyle(style || {}, overlayState),
    [style, overlayState],
  )

  // When the state transitions to 'reject' OR 'accept', measure the
  // handle's actual DOM position so the overlay can portal to the
  // React Flow node wrapper (which is `overflow: visible`) and sit
  // exactly on top of the handle regardless of the inner node box's
  // clipping. Re-measure whenever the drag payload changes (each drag
  // start triggers one measurement). Accept halo escapes the same clip
  // the reject X already dodges — the port sits on the node's edge,
  // so a non-portal halo would get chopped in half.
  const [measurement, setMeasurement] = useState(null)
  useLayoutEffect(() => {
    if (overlayState === 'resting') {
      if (measurement !== null) setMeasurement(null)
      return
    }
    const m = measureHandlePosition(handleRef.current)
    if (!m) return
    setMeasurement((prev) => {
      if (prev && prev.portalTarget === m.portalTarget && prev.centerX === m.centerX && prev.centerY === m.centerY) {
        return prev
      }
      return m
    })
    // `overlayState` alone is a sufficient trigger: every drag ends by
    // clearing activeDrag, which drives candidate handles back through
    // 'resting' before the next drag's 'accept'/'reject', so each
    // non-resting transition re-fires this measurement.
  }, [overlayState])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Handle {...handleProps} data-help-region="port:port" style={resolvedStyle} ref={handleRef} onClick={handleClick} />
      {overlayState === 'accept' && measurement && createPortal(
        <div
          className="nn-port-halo"
          style={{
            left: measurement.centerX,
            top: measurement.centerY,
            '--nn-port-halo-colour': accentColor,
          }}
          aria-hidden="true"
        />,
        measurement.portalTarget,
      )}
      {overlayState === 'reject' && measurement && createPortal(
        <svg
          viewBox="0 0 20 20"
          style={{
            position: 'absolute',
            pointerEvents: 'none',
            width: REJECT_X_SIZE,
            height: REJECT_X_SIZE,
            left: measurement.centerX - REJECT_X_SIZE / 2,
            top: measurement.centerY - REJECT_X_SIZE / 2,
            zIndex: 10,
          }}
          aria-hidden="true"
        >
          {/* Black stroke underlay for visibility on any background */}
          <line x1="4" y1="4" x2="16" y2="16" stroke="#18181b" strokeWidth="4" strokeLinecap="round" />
          <line x1="16" y1="4" x2="4" y2="16" stroke="#18181b" strokeWidth="4" strokeLinecap="round" />
          {/* Red overlay on top */}
          <line x1="4" y1="4" x2="16" y2="16" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" />
          <line x1="16" y1="4" x2="4" y2="16" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" />
        </svg>,
        measurement.portalTarget,
      )}
    </>
  )
}
