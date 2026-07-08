/**
 * ConceptPorts , Phase 8.1 (§8.1.4).
 *
 * The eight concept-wire ports on a concept node (and, later, a group): one at
 * each of the four CORNERS and one at the MIDPOINT of each of the four EDGES.
 * Each port is a triangle glyph that points INWARD by default (toward the node
 * centre), plus TWO stacked React Flow handles , a `source` on top (receives
 * the pointerdown that starts a drag) and a co-located `target` beneath
 * (discovered as a drop target by React Flow's spatial search). The two
 * handles share one id and give the "any port connects to any port" universal
 * connector in React Flow's default Strict mode. The closed world (concept
 * ports only wire to concept ports) is enforced by the port catalogue via
 * `handleIsValidConnection`, not here.
 *
 * Reveal: the glyph + handles are hidden at rest and revealed when the node is
 * hovered / selected, OR while any concept wire is being dragged (so a drop
 * can land on a node that isn't hovered), OR , per port , when that port has a
 * concept wire connected to it (so a live wire is always visible + clickable).
 * The bottom-right port insets up-left while the resize grip is showing.
 *
 * Orientation is DERIVED, not stored: a port points OUTWARD when it is the
 * SOURCE end of a concept wire (a wire was dragged OUT of it), or while a wire
 * is currently being dragged out of it; otherwise it points inward. So it
 * flips out as you drag from a fresh port, reverts to inward if you abort
 * before connecting, and reverts once all its outgoing wires are removed. A
 * port that only RECEIVES wires stays inward.
 *
 * Clicking a wired port (without dragging) opens the wire-list popup so the
 * wire can be removed. Dragging from a port starts a new wire.
 *
 * Orientation angles: the glyph points UP at 0deg; clockwise, 90 = right,
 * 180 = down, 270 = left. "Inward" per position points toward the centre.
 */

import { useMemo } from 'react'
import { Position, Handle } from '@xyflow/react'
import PortHandle from '../canvas/PortHandle'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { PAYLOAD } from '../../utils/portCatalogue'

const CONCEPT_PREFIX_LEN = 'concept-'.length

// top / left are percentages of the node box; inwardDeg rotates the glyph so
// its apex points toward the centre; rfPos is the nearest React Flow edge
// (drives the wire's exit geometry; exact placement is overridden via style).
const PORTS = [
  { key: 'tl', top: 0,   left: 0,   inwardDeg: 135, rfPos: Position.Left },
  { key: 'tm', top: 0,   left: 50,  inwardDeg: 180, rfPos: Position.Top },
  { key: 'tr', top: 0,   left: 100, inwardDeg: 225, rfPos: Position.Right },
  { key: 'rm', top: 50,  left: 100, inwardDeg: 270, rfPos: Position.Right },
  { key: 'br', top: 100, left: 100, inwardDeg: 315, rfPos: Position.Right },
  { key: 'bm', top: 100, left: 50,  inwardDeg: 0,   rfPos: Position.Bottom },
  { key: 'bl', top: 100, left: 0,   inwardDeg: 45,  rfPos: Position.Left },
  { key: 'lm', top: 50,  left: 0,   inwardDeg: 90,  rfPos: Position.Left },
]

const GLYPH = 12        // triangle glyph in px
const HIT = 22          // handle / port hit box in px (generous, so wires snap easily)
const BR_INSET = 16     // px the bottom-right port shifts up-left when the grip shows
const TRIANGLE_CLIP = 'polygon(50% 0%, 100% 100%, 0% 100%)'

// Fill the port wrapper; neutralise React Flow's default handle dot + transform.
const HANDLE_FILL = {
  position: 'absolute', top: 0, left: 0,
  width: '100%', height: '100%',
  minWidth: 0, minHeight: 0,
  transform: 'none',
  background: 'transparent', border: 'none', borderRadius: 0,
}

export default function ConceptPorts({ nodeId, nodeType, visible, gripVisible, colour }) {
  // Reveal + enable ports while a concept wire is being dragged anywhere, so a
  // drop can land on this node even when it isn't hovered.
  const dragActive = useUiStore((s) => s.activeDrag?.payloadType === PAYLOAD.CONCEPT)
  const openWireListPopup = useUiStore((s) => s.openWireListPopup)

  // The port on THIS node a concept drag currently originates FROM (or null).
  // While dragging out of it, that port reads as outward (transiently).
  const dragFromKey = useUiStore((s) => {
    const ad = s.activeDrag
    if (!ad || ad.payloadType !== PAYLOAD.CONCEPT) return null
    if (ad.sourceNodeId !== nodeId) return null
    if (typeof ad.sourceHandleId !== 'string' || !ad.sourceHandleId.startsWith('concept-')) return null
    return ad.sourceHandleId.slice(CONCEPT_PREFIX_LEN)
  })

  // Ports carrying ANY concept wire (source or target). Stable comma-joined
  // string so the component re-renders only when THIS node's wires change.
  const connectedKeysStr = useProjectStore((s) => {
    let out = ''
    for (const e of s.edges) {
      if (e.type !== 'conceptEdge') continue
      if (e.source === nodeId && typeof e.sourceHandle === 'string' && e.sourceHandle.startsWith('concept-')) {
        out += e.sourceHandle.slice(CONCEPT_PREFIX_LEN) + ','
      }
      if (e.target === nodeId && typeof e.targetHandle === 'string' && e.targetHandle.startsWith('concept-')) {
        out += e.targetHandle.slice(CONCEPT_PREFIX_LEN) + ','
      }
    }
    return out
  })
  const connectedKeys = useMemo(
    () => new Set(connectedKeysStr.split(',').filter(Boolean)),
    [connectedKeysStr],
  )

  // Ports that are the SOURCE end of a concept wire (dragged OUT of). These
  // point outward. Derived, so orientation auto-reverts when wires are removed.
  const sourceKeysStr = useProjectStore((s) => {
    let out = ''
    for (const e of s.edges) {
      if (e.type !== 'conceptEdge') continue
      if (e.source === nodeId && typeof e.sourceHandle === 'string' && e.sourceHandle.startsWith('concept-')) {
        out += e.sourceHandle.slice(CONCEPT_PREFIX_LEN) + ','
      }
    }
    return out
  })
  const sourceKeys = useMemo(
    () => new Set(sourceKeysStr.split(',').filter(Boolean)),
    [sourceKeysStr],
  )

  const nodeRevealed = visible || dragActive

  return (
    <>
      {PORTS.map((p) => {
        const connected = connectedKeys.has(p.key)
        // A wired port stays visible + interactive even when the node is at
        // rest, so the wire is always visible and clickable to manage.
        const portRevealed = nodeRevealed || connected
        const pe = portRevealed ? 'auto' : 'none'
        // The bottom-right corner shares its spot with the resize grip (shown
        // only when selected); inset this port up-left so they never overlap.
        const inset = p.key === 'br' && gripVisible
        const dx = inset ? -BR_INSET : 0
        const dy = inset ? -BR_INSET : 0
        // Outward while this port is a wire source, or mid-drag out of it.
        const out = sourceKeys.has(p.key) || dragFromKey === p.key
        const deg = out ? (p.inwardDeg + 180) % 360 : p.inwardDeg
        const handleId = `concept-${p.key}`
        // Click (no drag) on a wired port opens the wire-list popup so the wire
        // can be removed. Placed on the source handle (on top); a drag still
        // starts a new wire.
        const handleClick = connected
          ? (e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              openWireListPopup({
                nodeId,
                handleId,
                anchorRect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
              })
            }
          : undefined
        return (
          <div
            key={p.key}
            className="nn-concept-port"
            data-concept-port={p.key}
            style={{
              position: 'absolute',
              // Position the top-left via calc (NO CSS transform) so React Flow
              // measures the handle bounds at the true port location regardless
              // of how it reads element position; a transform-based centre can
              // register the snap point offset from the visible glyph. `dx`/`dy`
              // apply the bottom-right inset.
              top: `calc(${p.top}% - ${HIT / 2}px + ${dy}px)`,
              left: `calc(${p.left}% - ${HIT / 2}px + ${dx}px)`,
              width: HIT,
              height: HIT,
              opacity: portRevealed ? 1 : 0,
              transition: 'opacity 0.12s ease',
              zIndex: 11,
              // The wrapper is inert; the handles inside opt back into pointer
              // events (via `pe`) so at-rest edge clicks pass through to the node.
              pointerEvents: 'none',
            }}
          >
            {/* Visual triangle glyph (non-interactive) */}
            <div
              aria-hidden
              style={{
                position: 'absolute', top: '50%', left: '50%',
                width: GLYPH, height: GLYPH,
                transform: `translate(-50%, -50%) rotate(${deg}deg)`,
                backgroundColor: colour,
                clipPath: TRIANGLE_CLIP,
                pointerEvents: 'none',
              }}
            />
            {/* Target handle (beneath) , receives drops + the accept halo. */}
            <PortHandle
              nodeId={nodeId}
              nodeType={nodeType}
              type="target"
              position={p.rfPos}
              id={handleId}
              style={{ ...HANDLE_FILL, zIndex: 1, pointerEvents: pe }}
            />
            {/* Source handle (on top) , receives the pointerdown to start a drag
                and the click that opens the wire-list popup on a wired port. */}
            <Handle
              type="source"
              position={p.rfPos}
              id={handleId}
              onClick={handleClick}
              style={{ ...HANDLE_FILL, zIndex: 2, pointerEvents: pe }}
            />
          </div>
        )
      })}
    </>
  )
}
