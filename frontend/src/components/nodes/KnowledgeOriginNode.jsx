import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { Position, NodeResizeControl, useStore } from '@xyflow/react'
import PortHandle from '../canvas/PortHandle'
import { useProjectStore } from '../../store/projectStore'
import { useUiStore } from '../../store/uiStore'
import { useAccentColor } from '../../utils/povConstants'
import { useMultiSelectActive } from '../../hooks/useMultiSelectActive'
import { KNOWLEDGE_COLOUR } from '../ui/IdentityBadges'
import DescResizeGrip from '../ui/DescResizeGrip'
import ImageHoverPreview from '../ui/ImageHoverPreview'
import { applyResizeSnap } from '../../utils/snapUtils'
import { getMeasuredHeight } from '../../utils/measuredDimensionsStore'
import { useProfileImageDropTarget } from '../../hooks/useProfileImageDropTarget'
import AttachToChatButton from '../chat/AttachToChatButton'

// Same dark panel background relationship origin nodes use, so the two
// canvas anchors read as siblings rather than disconnected styles.
const KO_PANEL_BG = '#1c1c2e'
// Phase 4.1g #3 — stable handle-style identity (KNOWLEDGE_COLOUR is constant).
const KO_HANDLE_STYLE = Object.freeze({
  width: 10, height: 10, background: KNOWLEDGE_COLOUR, border: '2px solid #18181b',
  top: 16, transform: 'none',
})

/**
 * Phase 1.21c Step 14 — Canvas node anchoring a Knowledge's creation point.
 *
 * One per Knowledge, optional. Visual mirrors `<RelationshipOriginNode>`
 * (parchment-tan accent in place of relationship violet), but the **port
 * structure inverts**:
 *
 *   - **Output port** on the right side (`source`) — wire-to-entity-target
 *     grants the target entity awareness of the Knowledge at that target's
 *     chain position. Drop targets: an entity origin node (writes to
 *     `Knowledge.awareness` origin dict — pre-story baseline) or an entity
 *     chip on a scene (writes to `Knowledge.history.awareness_changes`
 *     anchored at that scene).
 *   - **No input port** — knowledges aren't created by other narrative
 *     objects via wires.
 */
export default function KnowledgeOriginNode({ id, data, selected }) {
  const accentColor       = useAccentColor()
  const multiSelectActive = useMultiSelectActive()
  const [hovered, setHovered]       = useState(false)

  const allKnowledges     = useProjectStore((s) => s.knowledges)
  const deleteNode        = useProjectStore((s) => s.deleteNode)
  const updateNodeData    = useProjectStore((s) => s.updateNodeData)
  const openKnowledgeDetail = useUiStore((s) => s.openKnowledgeDetail)
  const activeSelection   = useUiStore((s) => s.activeSelection)

  const knowledgeId = data?.knowledge_id || null
  const knowledge = useMemo(
    () => (allKnowledges || []).find((k) => k.id === knowledgeId) || null,
    [allKnowledges, knowledgeId],
  )

  const isActive = activeSelection?.kind === 'knowledge'
    && activeSelection?.id === knowledgeId
    && (!activeSelection?.atNodeId || activeSelection?.atNodeId === id)

  const handleClick = useCallback((e) => {
    if (e?.ctrlKey || e?.metaKey || e?.shiftKey) return
    if (!knowledgeId) return
    openKnowledgeDetail(knowledgeId, id)
  }, [knowledgeId, id, openKnowledgeDetail])

  const handleDeleteClick = useCallback((e) => {
    e.stopPropagation()
    // Removes the canvas anchor; the Knowledge itself persists in the
    // library (and reverts to pre-story baseline behaviour without a
    // creation-point anchor). Mirrors RelationshipOriginNode's delete
    // semantic.
    deleteNode(id)
  }, [id, deleteNode])

  const colour = knowledge?.colour || KNOWLEDGE_COLOUR

  const profileRef = knowledge?.profile_image_ref || null
  const assetName  = profileRef ? profileRef.replace(/^assets\//, '') : null

  // Phase 2.5g — accept image drops onto the knowledge's avatar.
  // Anchor is this node's id; the store action routes to the
  // baseline write when this node IS the knowledge's source_event
  // anchor, or to a `profile_image_changes` chain entry otherwise.
  const avatarDrop = useProfileImageDropTarget({
    kind: 'knowledge',
    id: knowledgeId,
    anchorNodeId: id,
  })

  const isOrphan = !knowledge

  // ── Resize machinery (mirrors RelationshipOriginNode pattern) ──────────────
  // Two-tier minimum: naturalMinHeight is the absolute floor (used for outer
  // minHeight + NodeResizeControl.minHeight so corner-drag can squeeze the
  // description); preferredMinHeight is the natural-or-overridden description
  // size (drives auto-grow on description-handle drag, auto-shrink on reset).
  const DEFAULT_DESC_TEXT_HEIGHT = 36 // ~3 lines at 9px font + padding
  const DESC_TEXT_FLOOR     = 24
  const DESC_LABEL_HEIGHT   = 16     // "Description" header + border
  const DESC_WRAPPER_PAD    = 12     // px-2 + pb-2 wrapper padding
  const headerRef = useRef(null)
  const descTextRef = useRef(null)
  // Seed from the REMEMBERED measurement so a culled-then-re-approached card
  // re-mounts at its true height instead of collapsing to 56 and being wrongly
  // culled again (see EntityNode for the full rationale). Falls back to 56 on a
  // genuine first-ever render; the ResizeObserver still corrects it after mount.
  const rememberedMinHeight = getMeasuredHeight(id) ?? 56
  const naturalMinHeightRef = useRef(rememberedMinHeight)
  const [naturalMinHeight, setNaturalMinHeight] = useState(rememberedMinHeight)
  const [descDragHeight, setDescDragHeight] = useState(null)
  const descDragStateRef = useRef(null)
  const reactFlowZoom = useStore((s) => s.transform?.[2] ?? 1)
  const zoomRef = useRef(1)
  zoomRef.current = reactFlowZoom

  const description = knowledge?.description || null
  const hasAnyDescription = !!description

  const recomputeMinHeight = useCallback(() => {
    const el = headerRef.current
    if (!el) return
    // Floor uses a constant DESC_TEXT_FLOOR for the text portion regardless
    // of actual content size. Mirroring SceneNode's stable-floor pattern —
    // a prior pass shrank the floor below DESC_TEXT_FLOOR for short
    // descriptions, which made the floor track descTextRef.scrollHeight and
    // fed back through the overflow-y scrollbar's effect on wrap, producing
    // a multi-pixel oscillation on short descriptions.
    const descExtra = descTextRef.current
      ? DESC_TEXT_FLOOR + DESC_LABEL_HEIGHT + DESC_WRAPPER_PAD
      : 0
    const h = el.scrollHeight + descExtra
    naturalMinHeightRef.current = h
    setNaturalMinHeight(h)
  }, [])

  const preferredMinHeight = useMemo(() => {
    const el = headerRef.current
    const descEl = descTextRef.current
    if (!el || !descEl) return naturalMinHeight
    const userPref = data?.description_height
    const naturalTextHeight = descEl.scrollHeight
    const targetTextH = userPref != null
      ? userPref
      : Math.min(naturalTextHeight, DEFAULT_DESC_TEXT_HEIGHT)
    return el.scrollHeight + targetTextH + DESC_LABEL_HEIGHT + DESC_WRAPPER_PAD
   
  }, [data?.description_height, naturalMinHeight])

  useEffect(() => {
    const el = headerRef.current
    const descEl = descTextRef.current
    if (!el) return
    const obs = new ResizeObserver(recomputeMinHeight)
    obs.observe(el)
    if (descEl) obs.observe(descEl)
    return () => obs.disconnect()
  }, [recomputeMinHeight, hasAnyDescription])

  // Clear description_height when the description text empties so a re-add
  // grows the node only to the 3-line cap rather than springing back to
  // the previous saved preference.
  useEffect(() => {
    if (!hasAnyDescription && data?.description_height != null) {
      updateNodeData(id, { description_height: null })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAnyDescription])

  // Auto-grow / auto-shrink contract on preferredMinHeight changes.
  // `silent: true` — program-driven layout correction (not a user
  // resize). First-mount fires on every project load; without silent
  // these would flip `hasUnsavedChanges` on load.
  const prevPreferredMinHeightRef = useRef(naturalMinHeight)
  useEffect(() => {
    const prevPref = prevPreferredMinHeightRef.current
    prevPreferredMinHeightRef.current = preferredMinHeight
    if (!data?.height) return
    if (data.height < preferredMinHeight) {
      updateNodeData(id, { height: preferredMinHeight }, { silent: true })
    } else if (data.height <= prevPref && preferredMinHeight < prevPref) {
      updateNodeData(id, { height: preferredMinHeight }, { silent: true })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferredMinHeight])

  // ── Description handle: drag-resize + double-click toggle ───────────────────
  const handleDescResizeStart = useCallback((e) => {
    if (e.detail >= 2) return
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const renderedTextH = descTextRef.current?.offsetHeight ?? null
    const startHeight = renderedTextH ?? data?.description_height ?? DEFAULT_DESC_TEXT_HEIGHT
    const zoom = zoomRef.current || 1
    descDragStateRef.current = { startY, startHeight, zoom }

    const onMove = (mv) => {
      const state = descDragStateRef.current
      if (!state) return
      const delta = (mv.clientY - state.startY) / state.zoom
      const next = Math.max(DESC_TEXT_FLOOR, state.startHeight + delta)
      setDescDragHeight(next)
    }
    const onUp = () => {
      descDragStateRef.current = null
      setDescDragHeight((current) => {
        if (current != null) {
          const headerH = headerRef.current?.offsetHeight ?? 0
          const fixedH = headerH + DESC_LABEL_HEIGHT + DESC_WRAPPER_PAD
          const draggedDescHeight = Math.max(DESC_TEXT_FLOOR, Math.round(current))
          const rawPreferred = fixedH + draggedDescHeight
          const snapToGrid = useProjectStore.getState().snapToGrid
          const snapped = applyResizeSnap(
            { width: data?.width || 220, height: rawPreferred },
            snapToGrid,
          )
          const adjustedDescH = Math.max(DESC_TEXT_FLOOR, snapped.height - fixedH)
          const finalDescH = adjustedDescH === DEFAULT_DESC_TEXT_HEIGHT ? null : adjustedDescH
          updateNodeData(id, { description_height: finalDescH, height: snapped.height })
        }
        return null
      })
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [data?.description_height, data?.width, id, updateNodeData])

  const handleDescResizeDoubleClick = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    const overrideActive = data?.description_height != null
    const headerH = headerRef.current?.offsetHeight ?? 0
    const fixedH = headerH + DESC_LABEL_HEIGHT + DESC_WRAPPER_PAD
    const snapToGrid = useProjectStore.getState().snapToGrid
    const snapH = (rawHeight) => applyResizeSnap(
      { width: data?.width || 220, height: rawHeight },
      snapToGrid,
    ).height
    if (overrideActive) {
      updateNodeData(id, {
        description_height: null,
        height: snapH(fixedH + DEFAULT_DESC_TEXT_HEIGHT),
      })
    } else {
      const fullH = descTextRef.current?.scrollHeight ?? DEFAULT_DESC_TEXT_HEIGHT
      if (fullH > DEFAULT_DESC_TEXT_HEIGHT) {
        const newDescH = Math.round(fullH)
        updateNodeData(id, {
          description_height: newDescH,
          height: snapH(fixedH + newDescH),
        })
      }
    }
  }, [data?.description_height, data?.width, id, updateNodeData])

  return (
    <div
      data-help-region="knowledge-origin:node"
      className="overflow-hidden shadow cursor-pointer select-none"
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: KO_PANEL_BG,
        borderWidth: '1px 1px 1px 4px',
        borderStyle: isOrphan ? 'dashed dashed dashed solid' : 'solid',
        borderTopColor:    isOrphan ? `${KNOWLEDGE_COLOUR}66` : `${KNOWLEDGE_COLOUR}55`,
        borderRightColor:  isOrphan ? `${KNOWLEDGE_COLOUR}66` : `${KNOWLEDGE_COLOUR}55`,
        borderBottomColor: isOrphan ? `${KNOWLEDGE_COLOUR}66` : `${KNOWLEDGE_COLOUR}55`,
        borderLeftColor:   KNOWLEDGE_COLOUR,
        outline: (selected && multiSelectActive) ? `2px dashed ${accentColor}` : undefined,
        outlineOffset: (selected && multiSelectActive) ? 3 : undefined,
        boxShadow: isActive ? `0 0 0 2px ${accentColor}` : undefined,
        width:    data?.width  || undefined,
        maxWidth: data?.width  ? undefined : 220,
        minWidth: 160,
        // While the description handle is being dragged, override
        // data.height with a live computed value so the outer node grows /
        // shrinks in lockstep with the description preview. When idle and
        // data.height is unset, pin to preferredMinHeight so a long
        // description doesn't push the node past its capped 3-line min
        // (or past the writer's chosen description_height).
        height: descDragHeight != null
          ? ((headerRef.current?.offsetHeight ?? 0) + DESC_LABEL_HEIGHT + DESC_WRAPPER_PAD + descDragHeight)
          : (data?.height || preferredMinHeight),
        minHeight: naturalMinHeight,
        borderRadius: '4px 4px 2px 4px',
        opacity: isOrphan ? 0.6 : 1,
      }}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={isOrphan
        ? 'Orphaned origin node — its Knowledge has been deleted; remove this node from the canvas'
        : 'Knowledge origin — click to open the Knowledge Detail Panel.'}
    >
      {/* Output port — wire-to-entity-target grants awareness at the
          target's chain position. Wire connect handler ships in a
          follow-up commit; this is the visual anchor. */}
      <PortHandle
        data-help-region="knowledge-origin:port"
        nodeId={id}
        nodeType="knowledgeOriginNode"
        type="source"
        position={Position.Right}
        style={KO_HANDLE_STYLE}
      />

      {/* Bottom-right corner resize grip — visible only when selected */}
      {selected && (
        <NodeResizeControl
          minWidth={160}
          minHeight={naturalMinHeight}
          position="bottom-right"
          onResizeStart={() => useUiStore.getState().setCanvasGestureActive(true)}
          onResize={(_, dims) => {
            const snapped = applyResizeSnap(dims, useProjectStore.getState().snapToGrid)
            updateNodeData(id, {
              width: snapped.width,
              height: Math.max(snapped.height, naturalMinHeightRef.current),
            })
          }}
          onResizeEnd={(_, dims) => {
            useUiStore.getState().setCanvasGestureActive(false)
            const snapped = applyResizeSnap(dims, useProjectStore.getState().snapToGrid)
            updateNodeData(id, {
              width: snapped.width,
              height: Math.max(snapped.height, naturalMinHeightRef.current),
            })
          }}
          style={{ width: 14, height: 14, background: 'transparent', border: 'none', left: 'auto', top: 'auto', right: 1, bottom: 1, translate: 'none', zIndex: 10 }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" style={{ display: 'block', margin: '2px', pointerEvents: 'none' }}>
            <line x1="0" y1="10" x2="10" y2="0" stroke="#52525b" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="4" y1="10" x2="10" y2="4" stroke="#52525b" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="8" y1="10" x2="10" y2="8" stroke="#52525b" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </NodeResizeControl>
      )}

      {/* Above-description content wrapper (measured for naturalMinHeight) */}
      <div ref={headerRef} className="flex-shrink-0">

      {/* ── Badge row: `NEW : KNOWLEDGE` in parchment tan ── */}
      <div
        className="flex items-center justify-between px-3 pt-2 pb-1.5"
        style={{ backgroundColor: KNOWLEDGE_COLOUR + '1a' }}
      >
        <span
          className="text-[9px] uppercase tracking-widest font-semibold px-1.5 py-0.5 rounded flex-shrink-0"
          style={{ color: KNOWLEDGE_COLOUR, backgroundColor: KNOWLEDGE_COLOUR + '22' }}
        >
          NEW : KNOWLEDGE
        </span>
        <div className="flex items-center gap-1 nodrag">
          {knowledgeId && (
            <AttachToChatButton
              kind="knowledge"
              id={knowledgeId}
              anchorNodeId={id}
              size={12}
              title="Add this knowledge at its origin as context to the open conversation"
              stopPropagation
              className={hovered ? 'opacity-100' : 'opacity-0 pointer-events-none'}
            />
          )}
          <button
            className={`text-sm leading-none transition-opacity ${
              hovered ? 'text-zinc-500 hover:text-red-400 opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            onClick={handleDeleteClick}
            title="Delete this knowledge"
          >
            ✕
          </button>
        </div>
      </div>

      {/* ── Header row: 📜 / avatar + knowledge name ── */}
      <div data-help-region="knowledge-origin:header" className="px-3 pt-2 pb-2 flex items-center gap-2">
        <div
          {...avatarDrop.dropHandlers}
          className="relative"
          style={avatarDrop.isDragOver ? {
            outline: `2px dashed ${accentColor || '#a855f7'}`,
            outlineOffset: 2,
            borderRadius: 2,
          } : undefined}
          title={avatarDrop.isDragOver ? 'Drop to apply as the knowledge\'s avatar at this anchor' : undefined}
        >
        <ImageHoverPreview src={assetName ? `/api/project/assets/${assetName}` : null} borderColour={colour} size={100}>
          <span
            className="inline-flex items-center justify-center rounded-sm flex-shrink-0 overflow-hidden"
            style={{
              width: 22, height: 22,
              backgroundColor: assetName ? 'transparent' : colour + '22',
              border: `1.5px solid ${colour}`,
            }}
          >
            {assetName ? (
              <img src={`/api/project/assets/${assetName}`} alt="" className="w-full h-full object-cover" />
            ) : (
              <span style={{ fontSize: 13, lineHeight: 1 }} className="select-none">📜</span>
            )}
          </span>
        </ImageHoverPreview>
        </div>

        <div className="min-w-0 flex-1">
          <div
            className="text-sm font-medium break-words leading-snug"
            style={{ color: isOrphan ? '#a1a1aa' : (knowledge?.colour || '#e4e4e7') }}
          >
            {knowledge?.name || (isOrphan ? '(missing knowledge)' : '(unnamed)')}
          </div>
        </div>
      </div>

      </div>{/* end headerRef wrapper */}

      {/* ── Description (when set on the knowledge baseline) ──
          Inline (rather than the shared OriginNodeDescription) so the
          inner text div carries `descTextRef` for measurement and the
          block hosts the bottom-edge resize grip. Container is flex-1
          so it absorbs surplus height when the node is corner-resized
          larger and shrinks (down to a 24 px floor) when smaller. */}
      {description && (
        <div
          data-help-region="knowledge-origin:body"
          className="px-2 pb-2 flex-1 flex flex-col"
          style={{ position: 'relative', minHeight: 0 }}
        >
          <div
            className="rounded overflow-hidden flex-1 flex flex-col"
            style={{ border: `1px solid ${colour}55`, minHeight: 0 }}
          >
            <div
              className="flex items-center gap-1 text-[8px] select-none flex-shrink-0"
              style={{
                backgroundColor: `${colour}11`,
                borderBottom: `1px solid ${colour}33`,
                padding: '1px 6px',
              }}
            >
              <span className="text-zinc-500 uppercase tracking-wider">Description</span>
            </div>
            <div
              ref={descTextRef}
              className="overflow-y-auto text-[9px] text-zinc-400 break-words nowheel px-1.5 py-1 flex-1"
              style={{ minHeight: 0 }}
            >
              {description}
            </div>
          </div>
          {selected && (
            <DescResizeGrip
              onMouseDown={handleDescResizeStart}
              onDoubleClick={handleDescResizeDoubleClick}
              active={descDragHeight != null}
              accentColor={accentColor}
              parentBottomPad={8}
            />
          )}
        </div>
      )}
    </div>
  )
}
