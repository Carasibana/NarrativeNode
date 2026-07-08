import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { Position, NodeResizeControl, useStore } from '@xyflow/react'
import PortHandle from '../canvas/PortHandle'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProjectStore } from '../../store/projectStore'
import { useUiStore } from '../../store/uiStore'
import { useAccentColor } from '../../utils/povConstants'
import { useMultiSelectActive } from '../../hooks/useMultiSelectActive'
import { computeRelationshipEffectiveState, getRelationshipNodeOrder } from '../../utils/narrativeChain'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import { RelationshipLabelStack, RelationshipArrow } from '../ui/IdentityBadges'
import ImageHoverPreview from '../ui/ImageHoverPreview'
import DescResizeGrip from '../ui/DescResizeGrip'
import { applyResizeSnap } from '../../utils/snapUtils'
import { getMeasuredHeight } from '../../utils/measuredDimensionsStore'
import AttachToChatButton from '../chat/AttachToChatButton'

// Canonical relationship accent colour — matches RelationshipChip / RelationshipSummaryHeader
const REL_COLOUR = '#a78bfa'
// Phase 4.1g #3 — stable handle-style identity (REL_COLOUR is constant).
const RO_HANDLE_STYLE = Object.freeze({
  width: 10, height: 10, background: REL_COLOUR, border: '2px solid #18181b',
  top: 16, transform: 'none',
})
// Same panel background as relationship chips in scenes (see RelationshipChip.jsx)
const REL_CHIP_BG = '#1c1c2e'

// ── Participant avatar (small, with colour border + hover enlargement) ──────────
// Mirrors the avatar density used by RelationshipChip.jsx.
function ParticipantAvatar({ entity }) {
  if (!entity) return null
  const colour = entity.colour || '#888888'
  const name   = entity.name || '?'
  const imgRef = entity.profile_image_ref || null
  const asset  = imgRef ? imgRef.replace(/^assets\//, '') : null

  const inner = asset ? (
    <img
      src={`/api/project/assets/${asset}`}
      alt=""
      className="rounded-sm object-cover flex-shrink-0"
      style={{ width: 16, height: 16, border: `1.5px solid ${colour}` }}
      title={name}
    />
  ) : (
    <span
      className="rounded-sm flex items-center justify-center flex-shrink-0 text-[9px]"
      style={{ width: 16, height: 16, backgroundColor: colour + '22', border: `1.5px solid ${colour}` }}
      title={name}
    >
      {TYPE_ICONS[entity?.type] || '★'}
    </span>
  )

  if (asset) {
    return (
      <ImageHoverPreview
        src={`/api/project/assets/${asset}`}
        borderColour={colour}
        size={80}
        previewSource={imgRef ? {
          type: 'entity_profile',
          entityId: entity.id,
          ...(imgRef.startsWith('data:') ? { url: imgRef } : { fileRef: imgRef }),
          entityName: name,
          entityColour: colour,
        } : undefined}
      >
        {inner}
      </ImageHoverPreview>
    )
  }
  return inner
}

export default function RelationshipOriginNode({ id, data, selected }) {
  const accentColor       = useAccentColor()
  const multiSelectActive = useMultiSelectActive()
  const [hovered, setHovered]           = useState(false)
  const [isDragOver, setIsDragOver]     = useState(false)

  const allRelationships  = useProjectStore((s) => s.relationships)
  const addParticipant    = useProjectStore((s) => s.addParticipant)
  const deleteNode        = useProjectStore((s) => s.deleteNode)
  const updateNodeData    = useProjectStore((s) => s.updateNodeData)
  const storeNodes        = useProjectStore((s) => s.nodes)
  const storeEdges        = useProjectStore((s) => s.edges)
  const allCharacters     = useEntitiesStore((s) => s.characters)
  const allLocations      = useEntitiesStore((s) => s.locations)
  const allItems          = useEntitiesStore((s) => s.items)
  const allFactions       = useEntitiesStore((s) => s.factions)
  const allCustoms        = useEntitiesStore((s) => s.customs)
  const allKnowledges     = useProjectStore((s) => s.knowledges || [])
  const openRelationshipDetail = useUiStore((s) => s.openRelationshipDetail)
  const activeSelection   = useUiStore((s) => s.activeSelection)

  const relationshipId    = data?.relationship_id || null
  const relationship = useMemo(
    () => allRelationships.find((r) => r.id === relationshipId) || null,
    [allRelationships, relationshipId]
  )

  const isActive = activeSelection?.kind === 'relationship'
    && activeSelection?.id === relationshipId
    && (!activeSelection?.atNodeId || activeSelection?.atNodeId === id)

  // Graph-walk narrative order for this relationship's chain. Canvas
  // x-position is NEVER used for chain ordering (see v0.1.18.121+ audit).
  // Filtered over the global story order so manual-anchor scenes land at
  // their deterministic global position (Phase 1.19).
  const storyOrder = useStoryOrder()
  const nodeOrder = useMemo(
    () => getRelationshipNodeOrder(relationship, storeNodes, storeEdges, storyOrder),
    [relationship, storeNodes, storeEdges, storyOrder]
  )

  const getEntity = useCallback((eid) => {
    for (const bucket of [allCharacters, allLocations, allItems, allFactions, allCustoms, allKnowledges]) {
      const found = bucket.find((e) => e.id === eid)
      if (found) return found
    }
    return null
  }, [allCharacters, allLocations, allItems, allFactions, allCustoms, allKnowledges])

  // Effective state at THIS origin node. With only join@originNodeId events, the
  // participants here == every entity that has joined at origin.
  const effectiveState = useMemo(
    () => relationship ? computeRelationshipEffectiveState(relationship, nodeOrder, id) : null,
    [relationship, nodeOrder, id]
  )

  const participants = effectiveState?.participants
    || Array.from(new Set(
      (relationship?.history?.participant_changes || [])
        .filter((c) => c.action === 'join')
        .map((c) => c.entity_id)
    )).map((eid) => ({ entity_id: eid }))

  // Resolved name (chain-walk wins over base); null when neither is set so
  // RelationshipLabelStack falls back to the pure participant-synthesis row.
  const resolvedName = effectiveState?.name || relationship?.name || null
  const labelNode = useMemo(() => {
    if (!resolvedName && !participants.length) return 'Empty relationship'
    return (
      <RelationshipLabelStack
        name={resolvedName}
        participants={participants}
        getEntity={getEntity}
        sliceMax={4}
        rel={relationship}
      />
    )
  }, [resolvedName, relationship, participants, getEntity])

  const isEmpty = participants.length === 0

  // ── Resize machinery (mirrors EntityNode pattern) ──────────────────────────
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
  // re-mounts at its true height instead of collapsing to 60 and being wrongly
  // culled again (see EntityNode for the full rationale). Falls back to 60 on a
  // genuine first-ever render; the ResizeObserver still corrects it after mount.
  const rememberedMinHeight = getMeasuredHeight(id) ?? 60
  const [naturalMinHeight, setNaturalMinHeight] = useState(rememberedMinHeight)
  const naturalMinHeightRef = useRef(rememberedMinHeight)
  const [descDragHeight, setDescDragHeight] = useState(null)
  const descDragStateRef = useRef(null)
  const reactFlowZoom = useStore((s) => s.transform?.[2] ?? 1)
  const zoomRef = useRef(1)
  zoomRef.current = reactFlowZoom

  const description = effectiveState?.description || null
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

  // Preferred minimum: what data.height should be when the description is
  // at its preferred (user-set or default-capped) size.
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
            { width: data?.width || 240, height: rawPreferred },
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
      { width: data?.width || 240, height: rawHeight },
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

  const handleClick = useCallback((e) => {
    if (e?.ctrlKey || e?.metaKey || e?.shiftKey) return
    if (!relationshipId) return
    openRelationshipDetail(relationshipId, id)
  }, [relationshipId, id, openRelationshipDetail])

  const handleDeleteClick = useCallback((e) => {
    e.stopPropagation()
    // Mirrors the entity-origin removal idiom — remove from canvas; the
    // relationship itself persists in the library (re-place via ToDo #2
    // drag-from-library flow, once built).
    deleteNode(id)
  }, [id, deleteNode])

  // ── Drag-from-library drop: add entity as participant at origin ──────────
  // Dropping an entity payload onto this origin node records a
  // `join@originNodeId` for the entity on this relationship. Mirrors the
  // SceneNode drop flow; idempotent via the `addParticipantJoin` helper.
  const handleDragOver = useCallback((e) => {
    if (e.dataTransfer.types.includes('application/nnz-entity-id')) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e) => {
    const entityId = e.dataTransfer.getData('application/nnz-entity-id')
    if (!entityId || !relationshipId) return
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    addParticipant(relationshipId, entityId, id).then(() => {
      // Delegate the entity-origin → rel-origin wire creation to the
      // canonical `ensureRelationshipOriginWire` store action so the
      // component doesn't reach into `useProjectStore.setState` directly
      // (3-layer convention — component calls the store action, the
      // store action owns the mutation).
      useProjectStore.getState().ensureRelationshipOriginWire(entityId, relationshipId, id)
    })
  }, [relationshipId, id, addParticipant])

  // Styling: violet left border as the "starting point" indicator, mirroring
  // EntityNode's coloured left border.
  return (
    <div
      data-help-region="relationship-origin:node"
      className="overflow-hidden shadow cursor-pointer select-none"
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: REL_CHIP_BG,
        // All-longhand to avoid the React "shorthand + longhand conflict" warning.
        // Left side is the "starting point" indicator: solid violet, 4px wide,
        // regardless of empty/proto state. Other sides reflect the empty/proto state.
        borderWidth: '1px 1px 1px 4px',
        borderStyle: isEmpty
          ? 'dashed dashed dashed solid'
          : 'solid',
        borderTopColor:    isEmpty ? `${REL_COLOUR}66` : `${REL_COLOUR}55`,
        borderRightColor:  isEmpty ? `${REL_COLOUR}66` : `${REL_COLOUR}55`,
        borderBottomColor: isEmpty ? `${REL_COLOUR}66` : `${REL_COLOUR}55`,
        borderLeftColor:   REL_COLOUR,
        outline: isDragOver
          ? `1px dashed ${accentColor}`
          : (selected && multiSelectActive)
            ? `2px dashed ${accentColor}`
            : undefined,
        outlineOffset: (isDragOver || (selected && multiSelectActive)) ? 3 : undefined,
        // Single-select outline is driven by `isActive` (uiStore `activeSelection`
        // with this node's id), NOT by React Flow's `selected` prop. This matches
        // EntityNode's pattern so clicking a relationship chip on a scene (which
        // stops propagation and updates the sidebar via `openRelationshipDetail`
        // with a different `atNodeId`) correctly drops the origin node's outline
        // when the sidebar moves off origin.
        boxShadow: isActive ? `0 0 0 2px ${accentColor}` : undefined,
        width:    data?.width  || undefined,
        maxWidth: data?.width  ? undefined : 240,
        minWidth: 180,
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
        opacity: isEmpty ? 0.75 : 1,
      }}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-dragover={isDragOver ? 'true' : undefined}
      title={isEmpty
        ? 'Empty relationship — wire a NEW : ___ entity node (character / location / item / faction / custom / knowledge) in to add a participant'
        : 'Relationship origin — click to open the Relationship Detail Panel'}
    >
      {/* Single input port — accepts multiple wires (entity origins converging on the origin node) */}
      <PortHandle
        nodeId={id}
        nodeType="relationshipOriginNode"
        type="target"
        position={Position.Left}
        style={RO_HANDLE_STYLE}
      />

      {/* Bottom-right corner resize grip — visible only when selected */}
      {selected && (
        <NodeResizeControl
          minWidth={180}
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

      {/* ── Badge row (top): `NEW : RELATIONSHIP` in violet ── */}
      <div
        className="flex items-center justify-between px-3 pt-2 pb-1.5"
        style={{ backgroundColor: REL_COLOUR + '1a' }}
      >
        <span
          className="text-[9px] uppercase tracking-widest font-semibold px-1.5 py-0.5 rounded flex-shrink-0"
          style={{ color: REL_COLOUR, backgroundColor: REL_COLOUR + '22' }}
        >
          NEW : RELATIONSHIP
        </span>
        <div className="flex items-center gap-1 nodrag">
          {relationshipId && (
            <AttachToChatButton
              kind="relationship"
              id={relationshipId}
              anchorNodeId={id}
              size={12}
              title="Add this relationship at its origin as context to the open conversation"
              stopPropagation
              className={hovered ? 'opacity-100' : 'opacity-0 pointer-events-none'}
            />
          )}
          <button
            className={`text-sm leading-none transition-opacity ${
              hovered ? 'text-zinc-500 hover:text-red-400 opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            onClick={handleDeleteClick}
            title="Delete this relationship"
          >
            ✕
          </button>
        </div>
      </div>

      {/* ── Header row (icon + relationship name) ── */}
      <div data-help-region="relationship-origin:header" className="px-3 pt-2 pb-2 flex items-center gap-2">
        {/* Relationship glyph (two-way arrow) — matches RelationshipChip */}
        <span
          className="inline-flex items-center justify-center rounded-full flex-shrink-0"
          style={{
            width: 22, height: 22,
            backgroundColor: REL_COLOUR + '1a',
            border: `1.5px solid ${REL_COLOUR}`,
          }}
        >
          <RelationshipArrow size={13} strokeWidth={2.2} />
        </span>

        <div className="min-w-0 flex-1">
          <div
            className="text-sm font-medium break-words leading-snug"
            style={{ color: isEmpty ? '#a1a1aa' : '#e4e4e7' }}
          >
            {labelNode}
          </div>
        </div>
      </div>

      {/* ── Participant avatars row ── */}
      {!isEmpty && (
        <div data-help-region="relationship-origin:participants" className="px-3 pb-2 flex flex-wrap gap-1 items-center">
          {participants.slice(0, 8).map((p) => (
            <ParticipantAvatar key={p.entity_id} entity={getEntity(p.entity_id)} />
          ))}
          {participants.length > 8 && (
            <span className="text-[9px] text-zinc-500 ml-0.5">
              +{participants.length - 8}
            </span>
          )}
        </div>
      )}

      {/* ── Empty / proto state hint ── */}
      {isEmpty && (
        <div className="px-3 pb-2 text-[10px] text-zinc-500 italic leading-snug">
          Wire a <span className="not-italic font-semibold text-violet-400">NEW : ___</span> node in to add a participant.<br />
          <span className="text-[9px]">(character, location, item, faction, custom, knowledge)</span>
        </div>
      )}

      </div>{/* end headerRef wrapper */}

      {/* ── Description (when set on the relationship baseline) ──
          Inline (rather than the shared OriginNodeDescription) so the
          inner text div carries `descTextRef` for measurement and the
          block hosts the bottom-edge resize grip. */}
      {description && (
        <div
          data-help-region="relationship-origin:body"
          className="px-2 pb-2 flex-1 flex flex-col"
          style={{ position: 'relative', minHeight: 0 }}
        >
          <div
            className="rounded overflow-hidden flex-1 flex flex-col"
            style={{ border: `1px solid ${REL_COLOUR}55`, minHeight: 0 }}
          >
            <div
              className="flex items-center gap-1 text-[8px] select-none flex-shrink-0"
              style={{
                backgroundColor: `${REL_COLOUR}11`,
                borderBottom: `1px solid ${REL_COLOUR}33`,
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

      {/* No output port — relationships propagate to scenes via the auto-chain
          calculation (v0.1.18.86 ambient chip) or explicit drag-from-library
          placement (ToDo #2), never via a wire from this node. */}
    </div>
  )
}
