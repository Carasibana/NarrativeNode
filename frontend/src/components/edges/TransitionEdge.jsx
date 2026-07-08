import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { EdgeLabelRenderer, getBezierPath, useStore, useReactFlow } from '@xyflow/react'
import { useProjectStore } from '../../store/projectStore'
import { useUiStore } from '../../store/uiStore'
import { useEntityById } from '../../hooks/useEntityById'
import { useEntityChainSignature } from '../../hooks/useEntityChainIndex'
import { computeEffectiveState } from '../../utils/narrativeChain'
import {
  resolveWaypoints,
  toRelativeWaypoint,
  buildWaypointPath,
  getPointOnPath,
  findInsertionIndex,
  findPathCircleExit,
} from '../../utils/wirePathUtils'

// ── WaypointHandle ─────────────────────────────────────────────────────────
// Renders a single waypoint as an HTML element in EdgeLabelRenderer space.
// HTML layer gives reliable pointer events (SVG inside React Flow's pan/zoom is unreliable).

function WaypointHandle({ index, absX, absY, type, wireColour, edgeId, zoom, sourceX, sourceY, targetX, targetY }) {
  const [hovered, setHovered] = useState(false)

  const handlePointerDown = useCallback((e) => {
    e.stopPropagation()
    e.preventDefault()

    // Snapshot once for undo
    useProjectStore.getState().snapshotForWaypointDrag()

    const startScreenX = e.clientX
    const startScreenY = e.clientY
    const startAbsX = absX
    const startAbsY = absY
    let didMove = false

    const onMove = (me) => {
      const z = zoom || 1
      const dx = (me.clientX - startScreenX) / z
      const dy = (me.clientY - startScreenY) / z
      if (!didMove && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) didMove = true
      if (!didMove) return

      const newAbsX = startAbsX + dx
      const newAbsY = startAbsY + dy
      const rel = toRelativeWaypoint(sourceX, sourceY, targetX, targetY, newAbsX, newAbsY, type)
      useProjectStore.getState().updateWaypointPosition(edgeId, index, rel)
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (didMove) useProjectStore.getState().sortEdgeWaypoints(edgeId)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [index, absX, absY, type, edgeId, zoom, sourceX, sourceY, targetX, targetY])

  const handleDoubleClick = useCallback((e) => {
    e.stopPropagation()
    useProjectStore.getState().toggleWaypointType(edgeId, index)
  }, [edgeId, index])

  const handleClick = useCallback((e) => {
    if (!e.ctrlKey) return
    e.stopPropagation()
    useProjectStore.getState().toggleWaypointType(edgeId, index)
  }, [edgeId, index])

  const handleContextMenu = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    useProjectStore.getState().removeWaypoint(edgeId, index)
  }, [edgeId, index])

  const size = hovered ? 14 : 6
  const isSharp = type === 'sharp'

  return (
    <div
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="absolute pointer-events-auto nodrag nopan"
      style={{
        transform: `translate(-50%, -50%) translate(${absX}px, ${absY}px)${isSharp ? ' rotate(45deg)' : ''}`,
        // Visible dot — small and borderless at rest, grows with border on hover
        width: size,
        height: size,
        cursor: 'grab',
        borderRadius: isSharp ? 2 : '50%',
        backgroundColor: wireColour,
        border: hovered ? '1.5px solid #71717a' : '1.5px solid transparent',
        boxShadow: hovered ? `0 0 0 3px ${wireColour}44` : 'none',
        transition: 'width 0.12s ease, height 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease',
        zIndex: hovered ? 10 : 1,
      }}
    />
  )
}

// ── TransitionEdge ─────────────────────────────────────────────────────────

export default function TransitionEdge({
  id,
  sourceX, sourceY, sourcePosition,
  targetX, targetY, targetPosition,
  data,
}) {
  const [basePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
  })

  // Expanded state — initialised from persisted data.is_expanded.
  // Stays in sync with the persisted value so external store updates
  // (e.g. global search navigating to a collapsed transition expands
  // it) flip the local UI in lockstep.
  const [expanded, setExpanded] = useState(!!data?.is_expanded)
  useEffect(() => {
    setExpanded(!!data?.is_expanded)
  }, [data?.is_expanded])
  const updateEdgeData = useProjectStore((s) => s.updateEdgeData)
  const zoom = useStore((s) => s.transform[2])
  const { screenToFlowPosition } = useReactFlow()
  // Commit-boundary undo for the transition-text textarea: a single
  // typing session (focus → keystrokes → blur) produces ONE undo
  // entry instead of one per keystroke. We snapshot the pre-edit
  // state on the first keystroke that actually diverges from the
  // focus-start value; subsequent keystrokes within the same focus
  // session don't snapshot. Re-focusing starts a new session.
  const transitionTextFocusValueRef = useRef(null)

  const hasText = !!(data?.transition_text?.trim())

  // ── Waypoints ──────────────────────────────────────────────────────────
  const waypoints = data?.waypoints || []
  const labelWpType = data?.label_waypoint_type || 'curve'
  const hasWaypoints = waypoints.length > 0

  // Resolve relative waypoints → absolute positions for rendering
  const resolvedWps = useMemo(
    () => resolveWaypoints(sourceX, sourceY, targetX, targetY, waypoints),
    [sourceX, sourceY, targetX, targetY, waypoints],
  )

  // Persist expanded/collapsed state to edge data
  const handleExpand = useCallback(() => {
    setExpanded(true)
    updateEdgeData(id, { is_expanded: true })
  }, [id, updateEdgeData])

  const handleCollapse = useCallback(() => {
    setExpanded(false)
    setDotHovered(false)
    setLabelHovered(false)
    updateEdgeData(id, { is_expanded: false })
  }, [id, updateEdgeData])

  // ── Constrained drag offset ──────────────────────────────────────────
  const [offset, setOffset] = useState({ x: data?.label_offset_x || 0, y: data?.label_offset_y || 0 })
  const dragging = useRef(false)
  const [isDragging, setIsDragging] = useState(false)
  const didDrag = useRef(false)
  const dragStart = useRef({ mx: 0, my: 0, ox: 0, oy: 0 })

  useEffect(() => {
    setOffset({ x: data?.label_offset_x || 0, y: data?.label_offset_y || 0 })
  }, [data?.label_offset_x, data?.label_offset_y])

  // Shared drag handler — used by both grip (expanded) and dot (collapsed)
  const startDrag = useCallback((e) => {
    e.stopPropagation()
    e.preventDefault()
    dragging.current = true
    setIsDragging(true)
    didDrag.current = false
    dragStart.current = { mx: e.clientX, my: e.clientY, ox: offset.x, oy: offset.y }
    const onMove = (me) => {
      if (!dragging.current) return
      // Divide screen-space deltas by zoom so offset stays in canvas coordinates
      const z = zoom || 1
      const dx = (me.clientX - dragStart.current.mx) / z
      const dy = (me.clientY - dragStart.current.my) / z
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) didDrag.current = true
      // Constrain to ±200px from edge midpoint
      const nx = Math.max(-200, Math.min(200, dragStart.current.ox + dx))
      const ny = Math.max(-200, Math.min(200, dragStart.current.oy + dy))
      setOffset({ x: nx, y: ny })
    }
    const onUp = () => {
      dragging.current = false
      setIsDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setOffset((cur) => {
        updateEdgeData(id, { label_offset_x: cur.x, label_offset_y: cur.y })
        return cur
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [id, offset.x, offset.y, updateEdgeData, zoom])

  // For expanded editor: drag from anywhere except the textarea and collapse button
  const handleExpandedPointerDown = useCallback((e) => {
    if (e.target.closest('textarea') || e.target.closest('button')) return
    startDrag(e)
  }, [startDrag])

  // For collapsed dot: drag on pointer down, click to expand only if no drag occurred
  const [dotPressed, setDotPressed] = useState(false)
  const [dotHovered, setDotHovered] = useState(false)
  const handleDotPointerDown = useCallback((e) => {
    setDotPressed(true)
    startDrag(e)
    // Listen for pointerup to clear pressed state
    const clearPressed = () => {
      setDotPressed(false)
      window.removeEventListener('pointerup', clearPressed)
    }
    window.addEventListener('pointerup', clearPressed)
  }, [startDrag])

  const handleDotClick = useCallback((e) => {
    // Ctrl+click toggles the dot's waypoint type
    if (e.ctrlKey) {
      e.stopPropagation()
      updateEdgeData(id, { label_waypoint_type: labelWpType === 'curve' ? 'sharp' : 'curve' })
      return
    }
    if (!didDrag.current) handleExpand()
  }, [handleExpand, id, updateEdgeData, labelWpType])

  // ── Compute edge path ────────────────────────────────────────────────
  const hasLabelOffset = offset.x !== 0 || offset.y !== 0

  const { edgePath, noteDotX, noteDotY } = useMemo(() => {
    // Dot-as-waypoint: when the transition note dot is displaced, include it in the path
    const dotIsWaypoint = hasLabelOffset

    if (hasWaypoints || dotIsWaypoint) {
      // Compute base path (without the dot) to find the dot's anchor position
      const basePathStr = hasWaypoints
        ? buildWaypointPath(sourceX, sourceY, targetX, targetY, resolvedWps)
        : null
      const baseMid = hasWaypoints
        ? getPointOnPath(basePathStr, 0.5)
        : { x: labelX, y: labelY }
      const dotX = baseMid.x + offset.x
      const dotY = baseMid.y + offset.y

      // Build final path — include dot as a waypoint if displaced
      let finalPath
      if (dotIsWaypoint) {
        const dotResolved = { x: dotX, y: dotY, type: labelWpType }
        // Compute dot's t along the source→target baseline for correct insertion order
        const dx = targetX - sourceX
        const dy = targetY - sourceY
        const lenSq = dx * dx + dy * dy
        const dotT = lenSq > 0
          ? Math.max(0, Math.min(1, ((dotX - sourceX) * dx + (dotY - sourceY) * dy) / lenSq))
          : 0.5
        // Merge dot into the resolved waypoints at the correct position
        const allResolved = [...resolvedWps]
        const dotIdx = findInsertionIndex(waypoints, dotT)
        allResolved.splice(dotIdx, 0, dotResolved)
        finalPath = buildWaypointPath(sourceX, sourceY, targetX, targetY, allResolved)
      } else {
        finalPath = basePathStr
      }

      return { edgePath: finalPath, noteDotX: dotX, noteDotY: dotY }
    }

    // No waypoints and no offset — use default bezier
    if (!hasLabelOffset) {
      return { edgePath: basePath, noteDotX: labelX, noteDotY: labelY }
    }

    // No waypoints but label offset — existing quadratic bezier behaviour
    const lx = labelX + offset.x
    const ly = labelY + offset.y
    const cx = 2 * lx - 0.5 * (sourceX + targetX)
    const cy = 2 * ly - 0.5 * (sourceY + targetY)
    return {
      edgePath: `M ${sourceX},${sourceY} Q ${cx},${cy} ${targetX},${targetY}`,
      noteDotX: lx,
      noteDotY: ly,
    }
  }, [
    hasWaypoints, hasLabelOffset, resolvedWps, waypoints,
    sourceX, sourceY, targetX, targetY,
    labelX, labelY, offset.x, offset.y, labelWpType, basePath,
  ])

  const accentColour = useProjectStore.getState().story?.accent_color || '#7c3aed'

  // ── Selection-based highlight ────────────────────────────────────────
  // Highlight this wire when:
  //   (a) the source or target node is the sole selected node, or
  //   (b) the specific source entity chip is selected (entityChip mode + matching entity)
  // Use stable individual selectors to avoid new-ref issues.
  const dpMode              = useUiStore((s) => s.detailPanelMode)
  const dpNodeId            = useUiStore((s) => s.detailPanelNodeId)
  const dpEntityId          = useUiStore((s) => s.detailPanelEntityId)
  const singleSelectedNodeId = useUiStore((s) => s.singleSelectedNodeId)
  const hoveredWireId       = useUiStore((s) => s.hoveredWireId)
  const isHoveredFromPopup  = hoveredWireId === id

  const isHighlightedBySelection = useMemo(() => {
    const srcNode   = data?.source_node_id
    const tgtNode   = data?.target_node_id
    const srcEntity = data?.source_entity_id
    // Entity chip selected: highlight wires leaving OR entering that specific chip.
    // Both directions use source_entity_id since the same entity flows on both ends.
    if (dpMode === 'entityChip' && dpEntityId === srcEntity && (dpNodeId === srcNode || dpNodeId === tgtNode)) return true
    // All other selections (scene node, entity origin, POV origin, etc.): use singleSelectedNodeId.
    // Guard against entityChip mode so selecting a chip doesn't highlight all scene wires.
    if (dpMode !== 'entityChip' && singleSelectedNodeId && (singleSelectedNodeId === srcNode || singleSelectedNodeId === tgtNode)) return true
    return false
  }, [dpMode, dpNodeId, dpEntityId, singleSelectedNodeId, data?.source_node_id, data?.target_node_id, data?.source_entity_id])

  // ── Source entity colour for wire tinting ───────────────────────────
  // Phase 4.1g — per-edge scoped subscription. Subscribing to the whole
  // `s.nodes` / `s.edges` here made every one of the ~560 edge instances
  // re-render on every array-identity write (1,120 whole-array
  // subscriptions; ~95-165 ms of every full-canvas commit). The chain
  // signature captures every chain-tracked input for the source entity
  // (origin, chain edges, every EntityRef including `colour_change`,
  // modifier data), so this edge re-renders only when ITS entity's
  // chain actually changes. The memo reads fresh `(nodes, edges)` via
  // `getState()` at recompute time — chain-aware semantics preserved;
  // only WHEN the walker re-runs is scoped. Same pattern as the
  // EntityChip fix in SceneNode.jsx.
  const sourceEntityId = data?.source_entity_id
  const sourceNodeId = data?.source_node_id
  const entity = useEntityById(sourceEntityId)
  const chainSignature = useEntityChainSignature(sourceEntityId)
  const wireColour = useMemo(() => {
    if (!entity || !sourceNodeId) return '#6b7280'
    const { nodes, edges } = useProjectStore.getState()
    const effective = computeEffectiveState(entity, nodes, edges, sourceNodeId)
    return effective?.colour || entity.colour || '#6b7280'
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity, chainSignature, sourceNodeId])

  // ── Highlight wire + ports on hover/drag or selection ──────────────
  const [labelHovered, setLabelHovered] = useState(false)
  const highlighted = labelHovered || isDragging || isHighlightedBySelection || isHoveredFromPopup

  // ── Hit-area event handlers for adding waypoints ───────────────────
  // Minimum canvas-pixel distance between a new waypoint and any existing point/endpoint
  const MIN_PX_GAP = 60

  const tryAddWaypoint = useCallback((e) => {
    const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })

    // New point always goes exactly where the user clicked
    const newRel = toRelativeWaypoint(sourceX, sourceY, targetX, targetY, flowPos.x, flowPos.y, 'curve')

    // Push any existing waypoints that are too close to the click — slide them
    // along the wire path to the boundary of the guard circle
    const resolved = resolveWaypoints(sourceX, sourceY, targetX, targetY, waypoints)
    const gapSq = MIN_PX_GAP * MIN_PX_GAP
    const updatedWps = waypoints.map((wp, i) => {
      const abs = resolved[i]
      const dx = flowPos.x - abs.x, dy = flowPos.y - abs.y
      if (dx * dx + dy * dy >= gapSq) return wp // far enough — keep as-is

      const exit = findPathCircleExit(edgePath, abs.x, abs.y, flowPos.x, flowPos.y, MIN_PX_GAP)
      if (!exit) return wp
      return toRelativeWaypoint(sourceX, sourceY, targetX, targetY, exit.x, exit.y, wp.type)
    })

    // Insert new waypoint at the correct t-sorted position
    const idx = findInsertionIndex(updatedWps, newRel.t)
    updatedWps.splice(idx, 0, newRel)
    updatedWps.sort((a, b) => a.t - b.t)

    // Compensate dot offset so the transition note dot stays in place
    const dataUpdate = { waypoints: updatedWps }
    const hasOffset = offset.x !== 0 || offset.y !== 0
    if (hasWaypoints || hasOffset) {
      const oldBasePath = hasWaypoints
        ? buildWaypointPath(sourceX, sourceY, targetX, targetY, resolved)
        : null
      const oldMid = oldBasePath
        ? getPointOnPath(oldBasePath, 0.5)
        : { x: labelX, y: labelY }
      const dotAbsX = oldMid.x + offset.x
      const dotAbsY = oldMid.y + offset.y

      const newResolved = resolveWaypoints(sourceX, sourceY, targetX, targetY, updatedWps)
      const newBasePath = buildWaypointPath(sourceX, sourceY, targetX, targetY, newResolved)
      const newMid = getPointOnPath(newBasePath, 0.5)

      const newOffsetX = dotAbsX - newMid.x
      const newOffsetY = dotAbsY - newMid.y
      if (Math.abs(newOffsetX - offset.x) > 0.5 || Math.abs(newOffsetY - offset.y) > 0.5) {
        dataUpdate.label_offset_x = newOffsetX
        dataUpdate.label_offset_y = newOffsetY
        setOffset({ x: newOffsetX, y: newOffsetY })
      }
    }

    // Single undo snapshot + batch update
    useProjectStore.getState().snapshotForWaypointDrag()
    updateEdgeData(id, dataUpdate)
  }, [id, sourceX, sourceY, targetX, targetY, waypoints, edgePath, offset, hasWaypoints, labelX, labelY, updateEdgeData, screenToFlowPosition])

  const handlePathDoubleClick = useCallback((e) => {
    e.stopPropagation()
    tryAddWaypoint(e)
  }, [tryAddWaypoint])

  const handlePathCtrlClick = useCallback((e) => {
    if (!e.ctrlKey) return // plain click passes through to React Flow edge selection
    e.stopPropagation()
    tryAddWaypoint(e)
  }, [tryAddWaypoint])


  return (
    <>
      {/* Invisible hit area — wide transparent stroke for click detection */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        onDoubleClick={handlePathDoubleClick}
        onClick={handlePathCtrlClick}
      />

      {/* Visible edge path — stroke set via style to override React Flow's .react-flow__edge-path CSS */}
      <path
        d={edgePath}
        data-help-region="wire:transition"
        fill="none"
        className="react-flow__edge-path"
        style={{
          stroke: isHighlightedBySelection ? accentColour : wireColour,
          strokeWidth: highlighted ? 3 : 1.5,
          filter: isHighlightedBySelection ? `drop-shadow(0 0 3px ${accentColour}88)` : undefined,
          transition: 'stroke-width 0.15s ease, stroke 0.15s ease, filter 0.15s ease',
          pointerEvents: 'none',
        }}
      />

      <EdgeLabelRenderer>
        {/* Waypoint handles — rendered in HTML space for reliable pointer events */}
        {resolvedWps.map((rwp, i) => (
          <WaypointHandle
            key={i}
            index={i}
            absX={rwp.x}
            absY={rwp.y}
            type={waypoints[i]?.type || 'curve'}
            wireColour={wireColour}
            edgeId={id}
            zoom={zoom}
            sourceX={sourceX}
            sourceY={sourceY}
            targetX={targetX}
            targetY={targetY}
          />
        ))}
        <div
          data-help-region="wire:transition_note"
          onMouseEnter={() => setLabelHovered(true)}
          onMouseLeave={() => setLabelHovered(false)}
          style={{
            transform: `translate(-50%, -50%) translate(${noteDotX}px,${noteDotY}px)`,
            zIndex: expanded ? 1000 : 0,
          }}
          className="absolute pointer-events-auto nodrag nopan"
        >
          {expanded ? (
            /* ── Expanded text editor — draggable from anywhere except textarea/button ── */
            <div
              onPointerDown={handleExpandedPointerDown}
              className="relative flex items-start bg-zinc-800 border border-zinc-600 rounded shadow-lg cursor-grab active:cursor-grabbing"
              style={{
                borderColor: hasText ? wireColour + '88' : undefined,
                padding: '3px 3px 3px 4px',
                gap: 4,
              }}
            >
              {/* Curve/sharp type indicator — click to toggle; pinned top so it stays put when note grows */}
              <span
                onClick={(e) => {
                  e.stopPropagation()
                  updateEdgeData(id, { label_waypoint_type: labelWpType === 'curve' ? 'sharp' : 'curve' })
                }}
                className="flex-shrink-0 cursor-pointer select-none self-start"
                title={`Wire bend: ${labelWpType} (click to toggle)`}
                style={{
                  width: 8,
                  height: 8,
                  marginTop: 4,
                  backgroundColor: hasText ? wireColour : '#52525b',
                  borderRadius: labelWpType === 'sharp' ? 1 : '50%',
                  transform: labelWpType === 'sharp' ? 'rotate(45deg)' : undefined,
                }}
              />
              <textarea
                autoFocus
                rows={1}
                value={data?.transition_text || ''}
                onFocus={(e) => {
                  // Capture the focus-start value; the first onChange that
                  // diverges from it triggers a single `_snapshot()` for
                  // this typing session. Subsequent keystrokes don't
                  // snapshot until the user blurs and re-focuses.
                  transitionTextFocusValueRef.current = e.target.value
                }}
                onBlur={() => {
                  transitionTextFocusValueRef.current = null
                }}
                onChange={(e) => {
                  if (
                    transitionTextFocusValueRef.current != null
                    && e.target.value !== transitionTextFocusValueRef.current
                  ) {
                    useProjectStore.getState()._snapshot()
                    transitionTextFocusValueRef.current = null  // one snapshot per focus session
                  }
                  updateEdgeData(id, { transition_text: e.target.value })
                  e.target.style.height = 'auto'
                  e.target.style.height = e.target.scrollHeight + 'px'
                }}
                ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } }}
                className="bg-transparent text-xs text-zinc-200 focus:outline-none w-36 resize-none overflow-hidden leading-snug"
                placeholder="Transition note..."
              />
              <div className="flex flex-col gap-0.5 flex-shrink-0 self-start">
                <button
                  onClick={handleCollapse}
                  className="text-zinc-500 hover:text-zinc-200 text-xs border border-zinc-600 hover:border-zinc-400 rounded px-1 py-0.5 leading-none"
                  title="Collapse"
                >
                  ▾
                </button>
              </div>
            </div>
          ) : (
            /* ── Collapsed dot — circle (curve) or diamond (sharp) ── */
            <button
              onPointerDown={handleDotPointerDown}
              onClick={handleDotClick}
              onMouseEnter={() => setDotHovered(true)}
              onMouseLeave={() => setDotHovered(false)}
              title={hasText ? data.transition_text : 'Add transition note'}
              className="flex-shrink-0 cursor-grab active:cursor-grabbing"
              style={{
                width: dotHovered ? (hasText ? 20 : 16) : (hasText ? 10 : 8),
                height: dotHovered ? (hasText ? 20 : 16) : (hasText ? 10 : 8),
                backgroundColor: hasText ? wireColour : (dotHovered ? '#52525b' : '#3f3f46'),
                outline: `2px solid ${hasText ? wireColour + 'aa' : (dotHovered ? '#71717a' : '#52525b')}`,
                outlineOffset: dotPressed ? 0 : (dotHovered ? (hasText ? 5 : 3) : (hasText ? 3 : 1.5)),
                boxShadow: dotHovered ? `0 0 0 3px ${hasText ? wireColour + '44' : '#52525b44'}` : 'none',
                transition: 'width 0.12s ease, height 0.12s ease, outline-offset 0.15s ease, outline-color 0.15s ease, background-color 0.15s ease, box-shadow 0.12s ease',
                // Curve = circle, Sharp = diamond (rotated square)
                borderRadius: labelWpType === 'sharp' ? 1 : '50%',
                transform: labelWpType === 'sharp' ? 'rotate(45deg)' : undefined,
              }}
            />
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
