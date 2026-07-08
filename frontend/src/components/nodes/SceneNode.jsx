import { memo, useState, useCallback, useMemo, useRef, useEffect, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { Position, useStore, NodeResizeControl, useUpdateNodeInternals } from '@xyflow/react'
import PortHandle from '../canvas/PortHandle'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProjectStore } from '../../store/projectStore'
import { useUiStore } from '../../store/uiStore'
import { useMcpControlStore } from '../../store/mcpControlStore'
import { buildSourceEventFromEntityRefChip, buildSuggestedKnowledgeName } from '../../utils/sourceEventBuilder'
import { usePreviewStore } from '../../store/previewStore'
import { getEntityNarrativeChain, computeEffectiveState, computeEffectiveStateWithPrior, computeChangeSubChips, computeRelationshipEffectiveState, getKnowledgeNodeOrder, getAwarenessChangesForObserverAtNode, computeSceneEffectiveCircumstancePool, ENTITY_BUCKETS } from '../../utils/narrativeChain'
import { useEntityById } from '../../hooks/useEntityById'
import { useEntityChainSignature, useEntityHasIncomingChainEdge } from '../../hooks/useEntityChainIndex'
import { useNodeDataById } from '../../hooks/useNodeDataById'
import { selectEntitiesChainHash } from '../../utils/entityChainIndex'

// Phase 4.1g #3 — stable handle-style identities for the static
// PortHandle styles (colour-independent). Hoisted so every render
// passes the same object reference; see the chip/pov style memos for
// the colour-dependent variants.
const GENERIC_IN_HANDLE_STYLE = Object.freeze({ top: 16, transform: 'none' })
const BROADCAST_HANDLE_STYLE = Object.freeze({
  width: 10, height: 10, backgroundColor: '#7c3aed', border: '2px solid #18181b',
  right: -6, top: 16, transform: 'none', borderRadius: '50%',
})
import { useMultiSelectActive } from '../../hooks/useMultiSelectActive'
import RelationshipChip from './RelationshipChip'
import KnowledgeChip from './KnowledgeChip'
import SceneTimeRow from './SceneTimeRow'
import { KNOWLEDGE_COLOUR } from '../ui/IdentityBadges'
import ChangeSubChip from '../ui/change-subchips/ChangeSubChip'
import CircumstanceMotivatorSubChip from '../ui/change-subchips/CircumstanceMotivatorSubChip'
import PerspectiveSubChip from '../ui/change-subchips/PerspectiveSubChip'
import HoverPopover from '../ui/HoverPopover'
import { CircumstanceTypeBadge, MotivatorTypeBadge } from '../ui/TypeBadges'
import AwarenessSubChip from '../ui/change-subchips/AwarenessSubChip'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import ImageHoverPreview from '../ui/ImageHoverPreview'
import DescResizeGrip from '../ui/DescResizeGrip'
import { usePovColor, useAccentColor, getPovDerived } from '../../utils/povConstants'
import { usePovChain, getPovChainIndex, isReachableFromOrigin } from '../../utils/povSequence'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import { useKnowledgeNodeMaps, knowledgesAtNode } from '../../hooks/useKnowledgeNodeMaps'
import { useRelationshipNodeMaps, relationshipNodeOrder } from '../../hooks/useRelationshipNodeMaps'
import { getSpanningBoundary } from '../../utils/chapterMembership'
import { usePovOrderAlert } from '../../hooks/useAlerts'
import { applyResizeSnap } from '../../utils/snapUtils'
import { getMeasuredHeight } from '../../utils/measuredDimensionsStore'
import AttachToChatButton from '../chat/AttachToChatButton'
import { useProfileImageDropTarget } from '../../hooks/useProfileImageDropTarget'

// Stable empty arrays so the chapters / chapter_x_offset store selectors
// return a referentially equal value when the story has no chapters. Keeps
// the spanning-triangle computation from re-running every render.
const EMPTY_CHAPTERS = []

// POV types that don't require a character in the scene — suppress "No character" badge.
const NON_CHARACTER_POV_TYPES = new Set([
  '3rd Person',
  '3rd Person (Limited)',
  '3rd Person (Omniscient)',
])

// Accent colour is now user-configurable via useAccentColor() hook
// Scene-specific purple (#7c3aed) on the node border/glow/badge is intentionally hardcoded (scene identity)
// ── Location hierarchy sub-tree (recursive, used inside expanded chip) ───────

function LocationChildTree({ locationId, allLocations, depth = 0 }) {
  const children = allLocations.filter((l) => l.parent_id === locationId)
  if (children.length === 0 || depth > 3) return null
  return (
    <>
      {children.map((child) => (
        <div key={child.id}>
          <div className="flex items-center gap-1" style={{ paddingLeft: (depth + 1) * 10 }}>
            <span className="text-zinc-600 text-[9px]">└</span>
            <span
              className="text-[10px] text-zinc-300 truncate"
              style={{ color: child.colour || undefined }}
            >
              {child.name}
            </span>
          </div>
          <LocationChildTree locationId={child.id} allLocations={allLocations} depth={depth + 1} />
        </div>
      ))}
    </>
  )
}

// ── Entity chip ───────────────────────────────────────────────────────────────

// ── Change sub-chip row ───────────────────────────────────────────────────────

// ── Chip context menu (right-click on entity chip) ───────────────────────────

function ChipContextMenu({ x, y, onClose, onAddAttribute }) {
  const menuRef = useRef(null)

  useEffect(() => {
    function onPointerDown(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => document.removeEventListener('pointerdown', onPointerDown, { capture: true })
  }, [onClose])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-zinc-800 border border-zinc-600 rounded shadow-xl py-1 min-w-[180px] text-xs"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className="w-full text-left px-3 py-1.5 text-accent-400 hover:bg-zinc-700 flex items-center gap-2"
        onClick={onAddAttribute}
      >
        <span>+</span>
        Add Attribute
      </button>
    </div>
  )
}

// ── Entity chip ───────────────────────────────────────────────────────────────

// `memo` so parent SceneNode renders don't cascade through every chip.
// Phase 2.11 Bugs & Fixes — profile capture
// `profiling-data.2026-05-31.18-31-58.json` showed `EntityChip` rendering
// 987 times for 225 ms self / 592 ms actualMs, with 635 of those renders
// citing `Props changed: [onDragStart, onDragOver, onDrop, onPovDragOver,
// onPovDrop]`. Cause: the SceneNode call sites previously passed inline
// arrows like `(e) => handleChipDragStart(ref.entity_id, e)` — new function
// every parent render. Now the SceneNode-level handlers all take an
// `(entityId, e)` signature and the call sites pass them directly; this
// component does the per-chip `entityRef.entity_id` binding at the DOM
// event boundary (one inline lambda per chip, recreated only when this
// chip itself re-renders, which is far less often once memo bails out
// on cascade renders). The handler-instability prop-changed reason
// should disappear from future profile captures.
const EntityChip = memo(function EntityChip({ nodeId, entityRef, onDragStart, onDragOver, onDrop, onDragEnd, isDragOver, isDragging, hasPov, povColor, accentColor, isPovDragTarget, onPovDragOver, onPovDrop, insidePovWrapper, isFlashback }) {
  const removeEntityChip                = useProjectStore((s) => s.removeEntityChip)
  // clearEntityReviewFlags removed — review flags are now cleared only from the Alerts panel
  const clearEntityRefChange            = useProjectStore((s) => s.clearEntityRefChange)
  // Phase 1.22h — Temporary C/M sub-chip dismiss handler. The scene
  // IS the origin for these (scene-side, not chain-tracked) so direct
  // remove on the SceneNode's `entity_temporary_circumstances` list
  // is the chain-aware path.
  const removeEntityTemporaryCM         = useProjectStore((s) => s.removeEntityTemporaryCM)
  // Phase 4.1g #2 — scoped subscription: this chip only ever reads its
  // OWN scene node's data (temporary C/M list, bucket refs). The prior
  // whole `s.nodes` subscription re-rendered every chip on every
  // array-identity write.
  const sceneNodeData                   = useNodeDataById(nodeId)
  // Phase 3.7 perf fix #14: replace the broad `s.edges` subscription
  // with a per-entity chain signature. Profile capture
  // `2026-06-06.11-58-30.json` showed 560 EntityChip re-renders per
  // chip-wire all driven by hook index 14 (the `s.edges`
  // subscription); structural-equality was a non-fix because the
  // edges array genuinely changed content. The signature changes
  // ONLY when THIS entity's chain inputs change (its origin id, any
  // chain edge it sources, any scene EntityRef for it). Chain-aware
  // semantics preserved: the signature serializes the full EntityRef
  // content at every scene the entity appears in, so any
  // chain-tracked value change (name_change, has_pov flip,
  // attribute_changes add, etc.) flips the signature and triggers a
  // re-render at this chip + a fresh chain walk inside the effective-
  // state memo (which reads current edges via `useProjectStore.getState()`).
  const chainSignature                  = useEntityChainSignature(entityRef.entity_id)
  const setDetailPanel                  = useUiStore((s) => s.setDetailPanel)
  const requestAddAttributeForm         = useUiStore((s) => s.requestAddAttributeForm)
  const togglePreview                   = usePreviewStore((s) => s.togglePreview)
  const isActiveChip = useUiStore((s) => s.detailPanelNodeId === nodeId && s.detailPanelEntityId === entityRef.entity_id)
  const [chipCtxMenu, setChipCtxMenu]   = useState(null)

  const entity = useEntityById(entityRef.entity_id)

  // All entities for relationship sub-chip labels.
  // Select individual buckets (stable refs) — avoid spreading in selector
  // (new array every call → infinite re-render when any store update fires).
  const allCharacters = useEntitiesStore((s) => s.characters)
  const allLocations  = useEntitiesStore((s) => s.locations)
  const allItems      = useEntitiesStore((s) => s.items)
  const allFactions   = useEntitiesStore((s) => s.factions)
  const allCustoms    = useEntitiesStore((s) => s.customs)
  // allLocations above also serves the location hierarchy display
  // Phase 1.21c Tier 4 — Knowledges + relationships for awareness sub-chips.
  const allKnowledgesPS    = useProjectStore((s) => s.knowledges)
  const allRelationshipsPS = useProjectStore((s) => s.relationships)

  const [hierarchyExpanded, setHierarchyExpanded] = useState(false)

  // Compute the entity's effective state at this node by walking the full upstream chain.
  // Using the raw entityRef fields (entityRef.name_change ?? entity.name) is wrong for
  // downstream chips: a chip with no override at this node would show the origin entity
  // value instead of the inherited upstream effective value.
  // For flashback scenes, compute effective state at the PARENT scene's position.
  const effectiveNodeId = isFlashback
    ? (useProjectStore.getState().nodes.find((n) => n.id === nodeId)?.data?.parent_scene_id || nodeId)
    : nodeId
  // Resolve current + prior chain-resolved state at the chip's anchor
  // in one helper call. `computeEffectiveStateWithPrior` handles the
  // sub-chain backward-walk for both views and unifies the "no prior"
  // fallback against the entity's origin EntityNode (returns pure
  // baseline). Replaces the previous pattern of two separate useMemo
  // blocks each re-running `getEntityNarrativeChain` and constructing
  // a per-file baseline-shape literal as the prior fallback — see
  // the helper's docstring in narrativeChain.js for the full bug
  // history (sub-chain inheritance gap, divergent baseline shapes).
  const { current: effectiveState, prior: priorState } = useMemo(() => {
    if (!entity) return { current: null, prior: null }
    // Phase 3.7 perf fix #14: read fresh `(nodes, edges)` via
    // `useProjectStore.getState()` instead of subscribing. The memo
    // re-runs when `chainSignature` changes — which captures every
    // chain-tracked input for this entity — so the chain walker
    // always sees the same `(nodes, edges)` content it would see
    // when the memo last ran. Chain-aware semantics fully preserved.
    const { nodes: ns, edges: es } = useProjectStore.getState()
    return computeEffectiveStateWithPrior(entity, ns, es, effectiveNodeId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity, chainSignature, effectiveNodeId])

  const effectiveColour = effectiveState?.colour            ?? '#888888'

  // Phase 4.1g #3 — stable handle-style identities. Inline style
  // literals at the PortHandle call sites created a fresh object per
  // chip render, registering as a props change on every handle and
  // re-rendering React Flow's HandleComponent beneath (~1,714 handle
  // style prop changes per full-canvas commit). Memoized on the only
  // dynamic input (the chain-resolved chip colour).
  const chipHandleStyles = useMemo(() => ({
    in: {
      width: 10, height: 10, backgroundColor: effectiveColour,
      border: '2px solid #18181b', left: -11, top: '50%', transform: 'translateY(-50%)',
    },
    out: {
      width: 8, height: 8, backgroundColor: effectiveColour,
      border: '2px solid #18181b', right: -10, top: '50%', transform: 'translateY(-50%)',
    },
  }), [effectiveColour])
  const effectiveName   = effectiveState?.name              ?? '—'
  const profileRef      = effectiveState?.profile_image_ref ?? null
  const assetName       = profileRef ? profileRef.replace(/^assets\//, '') : null

  // Phase 2.5g — accept image drops onto this chip's avatar. The
  // anchor is the scene node id; the store action treats this as a
  // chain entry on `EntityRef.profile_image_change` for the entity
  // at this scene.
  const avatarDrop = useProfileImageDropTarget({
    kind: 'entity',
    id: entityRef?.entity_id,
    anchorNodeId: nodeId,
  })

  // Orphaned: no incoming *narrative flow* edge carries this entity to this node.
  // Relationship wires (is_relationship) are excluded — they are not chain links.
  // Flashback scenes are never orphaned — entities are inherited from the parent scene.
  //
  // Phase 3.7 perf fix #14: served by the per-entity chain index. The
  // index pre-computes per-entity Set<nodeId> of scenes with incoming
  // chain edges in one O(E) walk, cached at module level. This hook
  // returns a boolean — default `Object.is` equality skips re-render
  // on store updates that don't change THIS entity's incoming chain-
  // edge presence at THIS scene. Replaces the previous inline
  // `useStore((s) => !s.edges.some(...))` pattern which walked all
  // edges per chip per store update (560 chips × ~3000 edges per
  // update = ~17ms of wasted main-thread time per update on
  // large-scale projects).
  const _hasIncomingChainEdge = useEntityHasIncomingChainEdge(entityRef.entity_id, nodeId)
  const isOrphaned = isFlashback ? false : !_hasIncomingChainEdge

  // ── Change sub-chips ───────────────────────────────────────────────────────
  // Non-relationship changes are rendered via ChangeSubChip; relationships via RelationshipSubChip.
  const subChips = useMemo(() => {
    if (isFlashback) return []  // Flashback scenes show effective state only, no change sub-chips
    if (!entity || !priorState) return []
    const allEntities = [...allCharacters, ...allLocations, ...allItems, ...allFactions, ...allCustoms]
    // Exclude relationship chips (rendered separately). Description IS
    // included as a sub-chip — earlier behaviour relied on an inline
    // amber badge, but that wasn't visible enough at the chip level
    // alongside the other field sub-chips (Name / Colour / Profile
    // Image / per-attribute changes).
    return computeChangeSubChips(entityRef, priorState, entity, allEntities)
      .filter((c) => !c.isRelationship)
  }, [entity, priorState, entityRef, allCharacters, allLocations, allItems, allFactions, allCustoms, isFlashback])

  // ── Temporary C/M sub-chips ─────────────────────────────────────────────────
  // Phase 1.22h — temporary circumstances / motivators are scene-side
  // (NOT chain-tracked); the scene IS their origin so reading directly
  // is the chain-aware path. Rendered as info sub-chips on the entity
  // chip alongside chain-change sub-chips so the writer sees "what
  // this entity carries at this scene only" inline rather than only
  // in the C/M marker popover.
  const tempCMSubChips = useMemo(() => {
    if (isFlashback) return []
    if (!entity) return []
    const allTemp = sceneNodeData?.entity_temporary_circumstances || []
    return allTemp.filter((t) => t.entity_id === entityRef.entity_id)
  }, [entity, entityRef.entity_id, sceneNodeData, isFlashback])

  // ── Awareness sub-chips ────────────────────────────────────────────────────
  // Phase 1.21c Tier 4. Lists every awareness change at this scene where
  // the chip's entity is the OBSERVER (became aware of something —
  // entity-existence, attribute, relationship, or Knowledge). Single
  // unified section so the user sees all "I learned X here" events at
  // a glance. Flashback scenes inherit awareness from the parent
  // scene; no scene-local awareness changes apply.
  const awarenessSubChips = useMemo(() => {
    if (isFlashback) return []
    if (!entity) return []
    const allEntities = [...allCharacters, ...allLocations, ...allItems, ...allFactions, ...allCustoms]
    // Phase 3.7 perf fix #14: gate on `chainSignature` instead of
    // raw `edges`. Read fresh `(nodes, edges)` via `getState()` so
    // the awareness computation always sees the latest store
    // content. Chain-aware semantics preserved — `chainSignature`
    // captures every chain-tracked input for this entity.
    const { nodes: ns, edges: es } = useProjectStore.getState()
    return getAwarenessChangesForObserverAtNode({
      observerEntityId: entity.id,
      nodeId,
      allNodes: ns,
      allEdges: es,
      allEntities,
      allRelationships: allRelationshipsPS,
      allKnowledges: allKnowledgesPS,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFlashback, entity, nodeId, chainSignature, allCharacters, allLocations, allItems, allFactions, allCustoms, allRelationshipsPS, allKnowledgesPS])

  // Location hierarchy data (only computed for location entities)
  const isLocation = entity?.type === 'location'

  const parentChain = useMemo(() => {
    if (!isLocation || !entity) return []
    const chain = []
    let current = entity
    while (current.parent_id) {
      const parent = allLocations.find((l) => l.id === current.parent_id)
      if (!parent) break
      chain.unshift(parent) // prepend so chain goes root → parent
      current = parent
    }
    return chain
  }, [isLocation, entity, allLocations])

  const hasChildren = useMemo(
    () => isLocation && allLocations.some((l) => l.parent_id === entityRef.entity_id),
    [isLocation, allLocations, entityRef.entity_id]
  )

  const showHierarchyToggle = isLocation && (parentChain.length > 0 || hasChildren)

  // ── Click → open sidebar chip detail view ────────────────────────────────
  const handleChipClick = useCallback((e) => {
    e.stopPropagation()
    if (!entity) return
    // Phase 3.7 perf fix #14: read fresh `(nodes, edges)` via
    // `getState()` rather than via closure. Handlers fire on user
    // action; closures captured at memoization time may be stale if
    // unrelated chip-wires (which don't re-render this chip) landed
    // between renders. The chain walker is called against current
    // store content; chain-aware semantics fully preserved.
    const { nodes: ns, edges: es } = useProjectStore.getState()
    if (isFlashback) {
      // Navigate to the parent scene and select this entity there
      const flashbackNode = ns.find((n) => n.id === nodeId)
      const parentId = flashbackNode?.data?.parent_scene_id
      if (parentId) {
        const chain = getEntityNarrativeChain(entity.id, ns, es)
        const idx = chain.findIndex((n) => n.id === parentId)
        setDetailPanel('entityChip', parentId, entityRef.entity_id, idx >= 0 ? idx : 0)
        // Focus the parent scene on the canvas
        const focusNode = useUiStore.getState()._focusNode
        if (focusNode) focusNode(parentId)
      }
      return
    }
    const chain = getEntityNarrativeChain(entity.id, ns, es)
    const idx = chain.findIndex((n) => n.id === nodeId)
    setDetailPanel('entityChip', nodeId, entityRef.entity_id, idx)
  }, [entity, nodeId, entityRef.entity_id, setDetailPanel, isFlashback])

  // ── Sub-chip click → navigate to chip detail + switch to relevant tab ───
  const handleSubChipClick = useCallback((subTab) => {
    if (!entity) return
    const { nodes: ns, edges: es } = useProjectStore.getState()
    const chain = getEntityNarrativeChain(entity.id, ns, es)
    const idx = chain.findIndex((n) => n.id === nodeId)
    setDetailPanel('entityChip', nodeId, entityRef.entity_id, idx, subTab)
  }, [entity, nodeId, entityRef.entity_id, setDetailPanel])

  // ── Context menu (right-click) → Add Attribute shortcut ─────────────────
  const handleChipContextMenu = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    // MCP session edit-lock — the chip context menu offers Add
    // Attribute / Add Alias shortcuts that mutate the entity's
    // chain. Suppress while a session is in flight so user changes
    // can't conflict with the AI's plan.
    if (useMcpControlStore.getState().sessionState === 'active') return
    setChipCtxMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const handleAddAttribute = useCallback(() => {
    setChipCtxMenu(null)
    if (!entity) return
    const { nodes: ns, edges: es } = useProjectStore.getState()
    const chain = getEntityNarrativeChain(entity.id, ns, es)
    const idx = chain.findIndex((n) => n.id === nodeId)
    setDetailPanel('entityChip', nodeId, entityRef.entity_id, idx, 'attributes')
    requestAddAttributeForm()
  }, [entity, nodeId, entityRef.entity_id, setDetailPanel, requestAddAttributeForm])

  // ── Chip row and (optional) hierarchy expansion ──────────────────────────

  return (
    // Outer wrapper carries the left-colour border spanning the full chip height
    <div
      data-help-region="entity-chip:chip"
      className="overflow-visible text-xs select-none nodrag cursor-pointer group/chip"
      style={{
        position: 'relative',
        zIndex: isActiveChip ? 10 : undefined,
        borderLeft: `3px solid ${effectiveColour}`,
        borderTop: (isDragOver && !hasPov) ? `2px solid ${accentColor}` : isPovDragTarget ? `2px solid ${povColor}` : insidePovWrapper ? `1px solid ${effectiveColour}1a` : '2px solid transparent',
        borderRight: hasPov ? `2px solid ${povColor}` : undefined,
        borderBottom: hasPov ? `2px solid ${povColor}` : undefined,
        boxShadow: isActiveChip ? `0 0 0 1.5px ${accentColor}` : isPovDragTarget ? `0 0 0 1.5px ${povColor}` : 'none',
        borderRadius: isActiveChip ? 3 : insidePovWrapper ? '0 0 0 0' : hasPov ? '0 4px 4px 2px' : '2px 4px 4px 2px',
        opacity: isDragging ? 0.4 : 1,
        backgroundColor: effectiveColour + '1a',
      }}
      onClick={handleChipClick}
      onContextMenu={handleChipContextMenu}
      onDragOver={(e) => { onDragOver(entityRef.entity_id, e); onPovDragOver?.(entityRef.entity_id, e) }}
      onDrop={(e) => { onPovDrop?.(entityRef.entity_id, e); onDrop(entityRef.entity_id, e) }}
    >
      {/* Inner row — position:relative so the Handle positions relative to this row.
          Right padding reserves space for two absolute-positioned controls in the
          right corner: the ✕ delete button (always present, hidden on flashback)
          and the Phase 2.7b "Add as context" chain-anchored attach button (only
          renders when the chat panel is open on a conversation). Constant pr keeps
          the chip's inline content from shifting when the chat panel opens. */}
      <div
        data-help-region="entity-chip:identity"
        className="relative flex items-center gap-1 pl-2 pr-10 py-1"
      >
        {/* Drag grip handle — absolutely positioned inside the left padding area */}
        <span
          className="absolute text-zinc-500 hover:text-zinc-200 cursor-grab active:cursor-grabbing opacity-0 group-hover/chip:opacity-100 transition-opacity z-10"
          draggable
          onDragStart={(e) => onDragStart(entityRef.entity_id, e)}
          onDragEnd={onDragEnd}
          onClick={(e) => e.stopPropagation()}
          title="Drag to reorder"
          style={{ fontSize: 10, lineHeight: 1, left: 2, top: '50%', transform: 'translateY(-50%)' }}
        >⠿</span>

        {/* Location hierarchy toggle — left of icon */}
        {showHierarchyToggle && (
          <button
            className="nodrag text-zinc-500 hover:text-zinc-200 text-[10px] leading-none flex-shrink-0"
            onClick={(e) => { e.stopPropagation(); setHierarchyExpanded((v) => !v) }}
            title={hierarchyExpanded ? 'Collapse hierarchy' : 'Show location hierarchy'}
          >
            {hierarchyExpanded ? '▴' : '▾'}
          </button>
        )}

        {/* Profile image or type icon — border in entity colour */}
        <div
          {...avatarDrop.dropHandlers}
          className="relative"
          style={avatarDrop.isDragOver ? {
            outline: `2px dashed ${accentColor || '#a855f7'}`,
            outlineOffset: 2,
            borderRadius: 2,
          } : undefined}
          title={avatarDrop.isDragOver ? 'Drop to apply as avatar at this scene' : undefined}
        >
        <ImageHoverPreview
          src={assetName ? `/api/project/assets/${assetName}` : null}
          borderColour={effectiveColour}
          previewSource={profileRef ? {
            type: 'entity_profile',
            entityId: entityRef.entity_id,
            ...(profileRef.startsWith('data:') ? { url: profileRef } : { fileRef: profileRef }),
            entityName: effectiveName,
            entityColour: effectiveColour,
          } : undefined}
        >
          {assetName ? (
            <img
              src={`/api/project/assets/${assetName}`}
              alt=""
              className="w-8 h-8 rounded-sm object-cover flex-shrink-0"
              style={{ border: `1.5px solid ${effectiveColour}` }}
            />
          ) : (
            <span
              className="w-8 h-8 rounded-sm flex items-center justify-center flex-shrink-0 text-sm"
              style={{ backgroundColor: effectiveColour + '22', border: `1.5px solid ${effectiveColour}` }}
            >{TYPE_ICONS[entity?.type] || '?'}</span>
          )}
        </ImageHoverPreview>
        </div>

        {/* Name */}
        <span className="flex-1 truncate text-zinc-100 text-sm max-w-[100px] ml-1.5">{effectiveName}</span>

        {/* Phase 1.22f — Compact circumstance / motivator marker.
            Reads the chain-resolved attribute list from `effectiveState`
            (which `computeEffectiveState` already produced for this
            entity at this scene anchor — chain-aware) and filters for
            circumstance / motivator types. Renders only when at least
            one is active here. Hover popover shows full row details
            via `CircumstanceMotivatorSubChip`; click navigates the
            sidebar to the entity's Detail Panel Attributes tab at
            this scene. */}
        {(() => {
          // Ongoing C/M: chain-resolved at the active anchor.
          const cmAttrs = (effectiveState?.attributes || []).filter(
            (a) => a.attribute_type === 'circumstance' || a.attribute_type === 'motivator',
          )
          // Phase 1.22h — Temporary C/M for this entity at this scene.
          // Reads `Scene.entity_temporary_circumstances` (scene-side
          // data; the scene IS the origin for its own temporaries
          // list, baseline-direct read is chain-aware here).
          const allTemp = (sceneNodeData?.entity_temporary_circumstances || [])
          const tempForEntity = allTemp.filter((e) => e.entity_id === entityRef.entity_id)
          if (cmAttrs.length === 0 && tempForEntity.length === 0) return null
          const ongoingCircs = cmAttrs.filter((a) => a.attribute_type === 'circumstance')
          const ongoingMots  = cmAttrs.filter((a) => a.attribute_type === 'motivator')
          const tempCircs = tempForEntity.filter((e) => e.attribute_type === 'circumstance')
          const tempMots  = tempForEntity.filter((e) => e.attribute_type === 'motivator')
          const totalCircs = ongoingCircs.length + tempCircs.length
          const totalMots  = ongoingMots.length  + tempMots.length
          const popoverContent = (
            <div className="px-2 py-1.5 space-y-2 min-w-[220px]">
              <div className="text-[9px] uppercase tracking-wider text-zinc-500">{effectiveName}</div>
              {totalCircs > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-zinc-400">
                    <CircumstanceTypeBadge size={11} />
                    <span>Circumstances</span>
                  </div>
                  <div className="space-y-1">
                    {/* Temporaries sorted to top within their type */}
                    {tempCircs.map((e) => (
                      <CircumstanceMotivatorSubChip
                        key={`t-${e.id}`}
                        attributeType="circumstance"
                        name={e.name || ''}
                        description={e.description || ''}
                        intensity={e.intensity ?? null}
                        temporary
                        temporaryColour={accentColor}
                      />
                    ))}
                    {ongoingCircs.map((a) => (
                      <CircumstanceMotivatorSubChip
                        key={a.id}
                        attributeType="circumstance"
                        name={a.name || ''}
                        description={a.description || ''}
                        intensity={a.intensity ?? null}
                      />
                    ))}
                  </div>
                </div>
              )}
              {totalMots > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-zinc-400">
                    <MotivatorTypeBadge size={11} />
                    <span>Motivators</span>
                  </div>
                  <div className="space-y-1">
                    {tempMots.map((e) => (
                      <CircumstanceMotivatorSubChip
                        key={`t-${e.id}`}
                        attributeType="motivator"
                        name={e.name || ''}
                        description={e.description || ''}
                        intensity={e.intensity ?? null}
                        temporary
                        temporaryColour={accentColor}
                      />
                    ))}
                    {ongoingMots.map((a) => (
                      <CircumstanceMotivatorSubChip
                        key={a.id}
                        attributeType="motivator"
                        name={a.name || ''}
                        description={a.description || ''}
                        intensity={a.intensity ?? null}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
          return (
            <HoverPopover
              content={popoverContent}
              placement="below"
              maxWidth={280}
              onTriggerClick={() => handleSubChipClick('attributes')}
            >
              <span
                className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-zinc-800/80 hover:bg-zinc-800 nodrag"
                style={{ border: `1px solid ${effectiveColour}` }}
                title="Active circumstances + motivators at this scene — click to open"
              >
                {totalCircs > 0 && (
                  <span className="inline-flex items-center gap-0.5">
                    <CircumstanceTypeBadge size={11} />
                    <span className="text-[9px] text-zinc-300 font-semibold">{totalCircs}</span>
                  </span>
                )}
                {totalMots > 0 && (
                  <span className="inline-flex items-center gap-0.5 ml-0.5">
                    <MotivatorTypeBadge size={11} />
                    <span className="text-[9px] text-zinc-300 font-semibold">{totalMots}</span>
                  </span>
                )}
              </span>
            </HoverPopover>
          )
        })()}

        {/* Legacy POV badge removed — POV is now shown via the POV chip badge above */}

        {/* Orphaned warning */}
        {isOrphaned && (
          <span
            className="text-amber-500 text-[10px]"
            title="Orphaned: no incoming connection. Wire this entity from upstream to resolve."
          >
            ⚮
          </span>
        )}

        {/* Phase 2.7b — chain-anchored "Add as context" button.
            Anchored to this scene (`anchor_node_id = nodeId`), so the
            attachment carries the chip's chain-resolved state at this
            scene anchor. Self-gates on the chat-open hook; the store
            dedup key includes the anchor, so the same entity can be
            attached at multiple scenes as separate pins. */}
        <AttachToChatButton
          kind="entity"
          id={entityRef.entity_id}
          anchorNodeId={nodeId}
          size={11}
          title="Add this entity at this scene as context to the open conversation"
          stopPropagation
          className="absolute right-5 top-1/2 -translate-y-1/2 opacity-0 group-hover/chip:opacity-100 transition-opacity"
        />

        {/* Remove — hidden for flashback scenes (read-only) */}
        {!isFlashback && (
          <button
            className="absolute right-1.5 text-zinc-500 hover:text-red-400 text-[10px] nodrag"
            onClick={(e) => { e.stopPropagation(); removeEntityChip(nodeId, entityRef.entity_id) }}
            title="Remove from this scene"
          >
            ✕
          </button>
        )}

        {/* Per-chip input handle — accepts entity flow wires and relationship wires */}
        <PortHandle
          nodeId={nodeId}
          nodeType="sceneNode"
          type="target"
          position={Position.Left}
          id={`chip-in-${entityRef.entity_id}`}
          style={chipHandleStyles.in}
        />

        {/* Per-chip output handle — hidden for flashback scenes (no entity output) */}
        {!isFlashback && (
          <PortHandle
            nodeId={nodeId}
            nodeType="sceneNode"
            type="source"
            position={Position.Right}
            id={entityRef.entity_id}
            style={chipHandleStyles.out}
          />
        )}
      </div>

      {/* Change sub-chips — one row per changed field, split into Attributes / Awareness */}
      {(subChips.length > 0 || tempCMSubChips.length > 0 || awarenessSubChips.length > 0) && (
        <div data-help-region="entity-chip:changes" className="px-2 pt-0.5 pb-1 space-y-0.5">
          {/* Section header — only shown when both groups have entries */}
          {(subChips.length > 0 || tempCMSubChips.length > 0) && awarenessSubChips.length > 0 && (
            <div className="text-[8px] text-zinc-400 uppercase tracking-wider mb-0.5">Attributes</div>
          )}
          {subChips.map((chip, i) => {
            // Map sub-chip field label → review_fields key to check if flagged
            const LABEL_TO_KEY = { 'Name': 'name', 'Colour': 'colour', 'Description': 'description', 'Profile Image': 'profile_image' }
            const fieldKey = LABEL_TO_KEY[chip.field] || (chip.attributeId ? `attr:${chip.attributeId}` : chip.field)
            const flagged = (entityRef.review_fields || []).some((f) => {
              const fk = typeof f === 'string' ? f : f.field
              if (fk === fieldKey) return true
              // List attribute sub-chips: also flag when any list_add:/list_remove: entry matches this attribute
              if (chip.attributeId && (fk.startsWith(`list_add:${chip.attributeId}:`) || fk.startsWith(`list_remove:${chip.attributeId}:`))) return true
              return false
            })
            // Determine which sidebar tab this sub-chip maps to
            const subChipTab = chip.attributeId ? 'attributes'
              : (chip.field === 'Name' || chip.field === 'Colour' || chip.field === 'Description' || chip.isProfileImage || chip.isColour) ? 'details'
              : 'details'
            // Phase 2.13b — perspective change events dispatch to the
            // dedicated PerspectiveSubChip. Descriptor was emitted by
            // computeChangeSubChips with `isPerspective` set + the
            // payload (description / perspectiveTargetKind /
            // perspectiveTargetId on add/modify/remove, plus the
            // `old*` mirror fields on modify so the expand-body can
            // show a before → after transition).
            if (chip.isPerspective) {
              return (
                <PerspectiveSubChip
                  key={i}
                  description={chip.description}
                  perspectiveTargetKind={chip.perspectiveTargetKind}
                  perspectiveTargetId={chip.perspectiveTargetId}
                  action={chip.action}
                  oldDescription={chip.oldDescription}
                  oldPerspectiveTargetKind={chip.oldPerspectiveTargetKind}
                  oldPerspectiveTargetId={chip.oldPerspectiveTargetId}
                  reviewFlagged={flagged}
                  onClick={() => handleSubChipClick(subChipTab)}
                  onDismiss={() => clearEntityRefChange(nodeId, entityRef.entity_id, chip)}
                />
              )
            }
            // Phase 1.22f — circumstance / motivator change events
            // dispatch to the dedicated CircumstanceMotivatorSubChip.
            // The chip descriptor was emitted by computeChangeSubChips
            // with `isCircumstanceOrMotivator` set + the per-event
            // payload (description / intensity for add / remove,
            // oldIntensity / newIntensity for intensity-only modify,
            // oldValue / newValue for text-modify).
            if (chip.isCircumstanceOrMotivator) {
              return (
                <CircumstanceMotivatorSubChip
                  key={i}
                  attributeType={chip.attributeType}
                  name={chip.field}
                  description={chip.description}
                  intensity={chip.intensity ?? null}
                  action={chip.action}
                  oldValue={chip.oldValue}
                  newValue={chip.newValue}
                  oldIntensity={chip.oldIntensity}
                  newIntensity={chip.newIntensity}
                  reviewFlagged={flagged}
                  onClick={() => handleSubChipClick(subChipTab)}
                  onDismiss={() => clearEntityRefChange(nodeId, entityRef.entity_id, chip)}
                  onAddKnowledge={(e) => {
                    const sourceEvent = buildSourceEventFromEntityRefChip(chip, entityRef, nodeId)
                    if (!sourceEvent) return
                    const rect = e?.currentTarget?.getBoundingClientRect?.() || null
                    useUiStore.getState().openAddKnowledgeFromChangePopover({
                      anchorRect: rect,
                      sourceEvent,
                      suggestedName: buildSuggestedKnowledgeName(chip, entityRef, entity),
                      triggerNodeId: nodeId,
                      isOrigin: false,
                      eventDisplay: {
                        ownerEntityId: entityRef.entity_id,
                        action: chip.action,
                        fieldLabel: chip.field,
                        oldValue: chip.oldValue,
                        newValue: chip.newValue,
                      },
                    })
                  }}
                />
              )
            }
            return (
              <ChangeSubChip
                key={i}
                chip={chip}
                entityColour={effectiveColour}
                entityId={entityRef.entity_id}
                entityName={effectiveName}
                isOrphaned={isOrphaned}
                onDismiss={() => clearEntityRefChange(nodeId, entityRef.entity_id, chip)}
                onAddKnowledge={(e) => {
                  const sourceEvent = buildSourceEventFromEntityRefChip(chip, entityRef, nodeId)
                  if (!sourceEvent) return
                  const rect = e?.currentTarget?.getBoundingClientRect?.() || null
                  useUiStore.getState().openAddKnowledgeFromChangePopover({
                    anchorRect: rect,
                    sourceEvent,
                    suggestedName: buildSuggestedKnowledgeName(chip, entityRef, entity),
                    triggerNodeId: nodeId,
                    isOrigin: false,
                    eventDisplay: {
                      ownerEntityId: entityRef.entity_id,
                      action: chip.action,
                      fieldLabel: chip.field,
                      oldValue: chip.oldValue,
                      newValue: chip.newValue,
                    },
                  })
                }}
                reviewFlagged={flagged}
                onClick={() => handleSubChipClick(subChipTab)}
                onMediaPreviewClick={chip.isFileAttribute ? (fileRef) => {
                  // First navigate the left Detail Panel to this sub-chip's
                  // context (same as clicking the chip body would). Keeps the
                  // sidebar in sync when the user clicks a media thumbnail.
                  handleSubChipClick(subChipTab)
                  // Then toggle the Media Preview Panel: if already showing
                  // this file, dismiss; otherwise open with an attribute-
                  // source descriptor anchored to this scene node.
                  togglePreview({
                    type: 'attribute',
                    entityId: entityRef.entity_id,
                    attributeId: chip.attributeId,
                    atNodeId: effectiveNodeId,
                    fileRef,
                    attributeName: chip.field,
                    entityName: effectiveName,
                    entityColour: effectiveColour,
                    profileImageRef: profileRef,
                  })
                } : undefined}
              />
            )
          })}
          {/* Phase 1.22h — Temporary C/M sub-chips. Scene-side data
              (NOT chain-tracked); the scene IS their origin so reading
              directly from `node.data.entity_temporary_circumstances`
              is the chain-aware path. Rendered with chevron-corner
              badge + accent stroke + dashed accent border so the
              temporary-only-at-this-scene scoping reads at a glance,
              and append after the chain-change sub-chips so the
              writer scans chain → temp top to bottom. */}
          {tempCMSubChips.map((t) => (
            <CircumstanceMotivatorSubChip
              key={`temp-${t.id}`}
              attributeType={t.attribute_type}
              name={t.name || ''}
              description={t.description || ''}
              intensity={t.intensity ?? null}
              action="add"
              temporary
              temporaryColour={accentColor}
              dashedOutline={accentColor}
              onClick={() => handleSubChipClick('attributes')}
              onDismiss={() => removeEntityTemporaryCM(nodeId, t.id)}
            />
          ))}
          {/* Section header — only shown when awareness exists alongside another group */}
          {awarenessSubChips.length > 0 && subChips.length > 0 && (
            <div className="text-[8px] text-zinc-400 uppercase tracking-wider mt-0.5 mb-0.5">Awareness</div>
          )}
          {awarenessSubChips.map((rec) => {
            // Phase 1.21h — match the field key on the TARGET's EntityRef
            // at this scene (the carrier that holds the chain entry —
            // sub-chips render observer-side but the chain entry lives
            // target-side, so the review flag for that entry is on the
            // target's review_fields). Knowledge entries live on the
            // Knowledge.history list rather than on an EntityRef carrier
            // — flag state and removal are dispatched through the
            // Knowledge-side path below.
            let targetRef = null
            const targetEntityId = rec.targetEntityId
            if (targetEntityId) {
              const sceneData = sceneNodeData
              if (sceneData) {
                for (const b of ENTITY_BUCKETS) {
                  const ref = (sceneData[b] || []).find((r) => r.entity_id === targetEntityId)
                  if (ref) { targetRef = ref; break }
                }
              }
            }
            let awarenessFieldKey = null
            if (rec.kind === 'entity_existence') awarenessFieldKey = `awareness:entity:${entity?.id}`
            else if (rec.kind === 'entity_name') awarenessFieldKey = `awareness:entity_name:${entity?.id}`
            else if (rec.kind === 'attribute' && rec.attributeId) awarenessFieldKey = `awareness_set:${rec.attributeId}:${entity?.id}`
            else if (rec.kind === 'alias') awarenessFieldKey = 'aliases'
            // Awareness review flags: each awareness object carries
            // its own `history[].review_flag`. Look up the matching
            // history entry by changeId and check the flag. Falls
            // back to legacy EntityRef.review_fields for non-awareness
            // sub-chip kinds.
            let historyReviewFlagged = false
            if (rec.changeId && targetEntityId) {
              const targetEnt = [...allCharacters, ...allLocations, ...allItems, ...allFactions, ...allCustoms]
                .find((e) => e.id === targetEntityId)
              const findInHistory = (h) => Array.isArray(h)
                ? h.some((e) => e?.id === rec.changeId && e?.review_flag)
                : false
              if (rec.kind === 'entity_existence') {
                historyReviewFlagged = findInHistory(targetEnt?.awareness?.history)
              } else if (rec.kind === 'entity_name') {
                historyReviewFlagged = findInHistory(targetEnt?.name_awareness?.history)
              } else if (rec.kind === 'attribute' && rec.attributeId) {
                const attr = (targetEnt?.attributes || []).find((a) => a.id === rec.attributeId)
                historyReviewFlagged = findInHistory(attr?.awareness?.history)
              } else if (rec.kind === 'alias' && rec.aliasValue) {
                const al = (targetEnt?.aliases || []).find((a) => (typeof a === 'string' ? a : a?.value) === rec.aliasValue)
                historyReviewFlagged = al && typeof al !== 'string' ? findInHistory(al?.awareness?.history) : false
              }
            }
            if (!historyReviewFlagged && rec.kind === 'relationship' && rec.relationshipId && rec.changeId) {
              const rel = (allRelationshipsPS || []).find((r) => r.id === rec.relationshipId)
              historyReviewFlagged = Array.isArray(rel?.awareness?.history)
                && rel.awareness.history.some((e) => e?.id === rec.changeId && e?.review_flag)
            }
            if (!historyReviewFlagged && rec.kind === 'knowledge' && rec.knowledgeId && rec.changeId) {
              const k = (allKnowledgesPS || []).find((kk) => kk.id === rec.knowledgeId)
              historyReviewFlagged = Array.isArray(k?.awareness?.history)
                && k.awareness.history.some((e) => e?.id === rec.changeId && e?.review_flag)
            }
            const awarenessFlagged = historyReviewFlagged
              || (rec.kind === 'knowledge'
                ? false
                : !!(targetRef && awarenessFieldKey && (targetRef.review_fields || []).some((f) => {
                    const fk = typeof f === 'string' ? f : f.field
                    return fk === awarenessFieldKey
                  })))
            // Wire the dismiss `−` button. Awareness chain entries in
            // the new model live on each awareness object's `history`
            // list and are stripped by id via `removeAwarenessHistoryEntry`.
            // Build the target descriptor from the sub-chip record's kind
            // and ids; entryId is the history entry's stable id (== changeId).
            let onRemoveAwareness = null
            if (rec.changeId) {
              let removeTarget = null
              if (rec.kind === 'entity_existence' && rec.targetEntityId) {
                removeTarget = { kind: 'entity', entityId: rec.targetEntityId }
              } else if (rec.kind === 'entity_name' && rec.targetEntityId) {
                removeTarget = { kind: 'entity_name', entityId: rec.targetEntityId }
              } else if (rec.kind === 'attribute' && rec.targetEntityId && rec.attributeId) {
                removeTarget = { kind: 'attribute', entityId: rec.targetEntityId, attributeId: rec.attributeId }
              } else if (rec.kind === 'alias' && rec.targetEntityId && rec.aliasValue) {
                removeTarget = { kind: 'alias', entityId: rec.targetEntityId, aliasValue: rec.aliasValue }
              } else if (rec.kind === 'relationship' && rec.relationshipId) {
                removeTarget = { kind: 'relationship', relationshipId: rec.relationshipId }
              } else if (rec.kind === 'knowledge' && rec.knowledgeId) {
                removeTarget = { kind: 'knowledge', knowledgeId: rec.knowledgeId }
              }
              if (removeTarget) {
                onRemoveAwareness = () => {
                  useProjectStore.getState().removeAwarenessHistoryEntry({
                    target: removeTarget,
                    entryId: rec.changeId,
                  })
                }
              }
            }
            return (
              <AwarenessSubChip
                key={rec.changeId || `${rec.kind}-${rec.targetEntityId || rec.knowledgeId || rec.relationshipId}`}
                record={rec}
                observerName={effectiveName || entity?.name}
                reviewFlagged={awarenessFlagged}
                onRemove={onRemoveAwareness}
                getEntity={(id) => {
                  // Phase 1.21h — return the target entity in its
                  // chain-resolved state at THIS scene so the sub-chip
                  // displays the attribute / name / alias value as it
                  // exists at this anchor (e.g. Alice's title shows as
                  // "Queen" at scene 3 after a chain-time rename, not
                  // the origin "Princess"). Falls back to the base
                  // entity when the walker can't resolve.
                  const all = [...allCharacters, ...allLocations, ...allItems, ...allFactions, ...allCustoms]
                  const base = all.find((e) => e.id === id) || null
                  if (!base) return null
                  // Phase 3.7 perf fix #14: read fresh `(nodes, edges)`
                  // for the target entity's chain walk. The callback
                  // can fire when the target entity's chain changed
                  // but this observer chip didn't re-render.
                  const { nodes: tns, edges: tes } = useProjectStore.getState()
                  const eff = computeEffectiveState(base, tns, tes, nodeId)
                  if (!eff) return base
                  return {
                    ...base,
                    name: eff.name || base.name,
                    colour: eff.colour || base.colour,
                    profile_image_ref: eff.profile_image_ref ?? base.profile_image_ref ?? null,
                    attributes: eff.attributes || base.attributes,
                    aliases: eff.aliases || base.aliases,
                  }
                }}
                getRelationship={(id) => allRelationshipsPS?.find((r) => r.id === id) || null}
                getKnowledge={(id) => allKnowledgesPS?.find((k) => k.id === id) || null}
                onClick={() => handleSubChipClick('awareness')}
              />
            )
          })}
        </div>
      )}

      {/* Expandable location hierarchy */}
      {isLocation && hierarchyExpanded && (
        <div className="px-2 pb-1 pt-0.5 bg-zinc-900/30 text-[10px]">
          {/* Parent breadcrumb */}
          {parentChain.length > 0 && (
            <div className="flex items-center flex-wrap gap-0.5 pb-0.5 border-b border-zinc-700/40 mb-0.5">
              {parentChain.map((p, i) => (
                <span key={p.id} className="flex items-center gap-0.5">
                  {i > 0 && <span className="text-zinc-600">›</span>}
                  <span style={{ color: p.colour || '#888' }} className="truncate max-w-[60px]" title={p.name}>
                    {p.name}
                  </span>
                </span>
              ))}
              <span className="text-zinc-600">›</span>
            </div>
          )}
          {/* Children tree */}
          {hasChildren && (
            <LocationChildTree
              locationId={entityRef.entity_id}
              allLocations={allLocations}
            />
          )}
        </div>
      )}

      {/* ── Chip context menu (portalled to body so it's not clipped by node overflow) ── */}
      {chipCtxMenu && createPortal(
        <ChipContextMenu
          x={chipCtxMenu.x}
          y={chipCtxMenu.y}
          onClose={() => setChipCtxMenu(null)}
          onAddAttribute={handleAddAttribute}
        />,
        document.body
      )}
    </div>
  )
})

// ── SceneTitleInput ──────────────────────────────────────────────────────────
//
// Local-draft scene title input. Committing the title to the project
// store on every keystroke triggered a global re-render of every
// `s.nodes` subscriber (45+ components) and a full `useStoryOrder`
// recompute (13-tier constraint walk), which made typing a title
// visibly laggy on stories with more than a handful of scenes.
//
// While unfocused, the input renders `title` straight from props so
// external updates (undo, Find / Replace, MCP writes) flow through
// immediately. On focus we snapshot the current title into `draft`
// and switch to displaying the draft; keystrokes only touch local
// state until blur or Enter, at which point we commit the draft to
// the store via `updateNodeData`. Commit only fires when the user
// actually typed (`editedRef`), so click-in-click-out with no edit
// doesn't clobber a concurrent external title change.
function SceneTitleInput({ id, title, updateNodeData, className, placeholder = 'Title…' }) {
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState('')
  const editedRef = useRef(false)
  const display = focused ? draft : (title || '')

  function onFocus() {
    setDraft(title || '')
    editedRef.current = false
    setFocused(true)
  }
  function onChange(e) {
    editedRef.current = true
    setDraft(e.target.value)
  }
  function onBlur() {
    setFocused(false)
    if (editedRef.current && (title || '') !== draft) {
      updateNodeData(id, { title: draft })
    }
  }

  return (
    <input
      className={className}
      name="node-title"
      aria-label={placeholder || 'Title'}
      placeholder={placeholder}
      value={display}
      onChange={onChange}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
      }}
    />
  )
}

// ── SceneNode ─────────────────────────────────────────────────────────────────

const DEFAULT_SECTION_METRICS = { aboveH: 0, belowH: 0, descOverhead: 32 }

// Per-node cache of the measured section metrics + natural min-height, keyed by
// node id and tagged with the node's `data` reference. The measurement is a
// pure function of the node's rendered CONTENT — it cannot change from a pan,
// zoom, or remount. `data`'s reference is stable across a pan remount (the
// store only spreads a new node object for measurement churn, keeping the same
// `data`), and changes whenever the content changes, so a `data`-ref match
// means "same content → cached measurement still valid → skip the offsetHeight
// reads" (those reads force a layout reflow, which during a pan fired per scene
// node as they virtualized in and out of view). A mismatch (content edited,
// incl. while unmounted) remeasures. Seeding state from the cache on mount also
// avoids the spurious auto-grow the default-then-measured transition can cause.
const _sceneSizeCache = new Map() // id -> { dataRef, sectionMetrics, naturalMinHeight }

function SceneNode({ id, data, selected, positionAbsoluteX, width }) {
  const povColor = usePovColor()
  // Phase 4.1g #3 — POV handle styles memoized on the POV colour so the
  // handle props keep a stable identity across unrelated scene renders.
  const povHandleStyles = useMemo(() => ({
    in: { width: 8, height: 8, background: povColor, border: '2px solid #18181b', left: -10, top: '50%', transform: 'translateY(-50%)' },
    out: { width: 8, height: 8, background: povColor, border: '2px solid #18181b', right: -10, top: '50%', transform: 'translateY(-50%)' },
    flashbackIn: { width: 8, height: 8, background: povColor, border: '2px solid #18181b', left: -12, top: '50%', transform: 'translateY(-50%)' },
  }), [povColor])
  const povDerived = getPovDerived(povColor)
  const accentColor = useAccentColor()
  const multiSelectActive = useMultiSelectActive()
  const updateNodeData        = useProjectStore((s) => s.updateNodeData)
  // Phase 1.11 Track E — spanning-chapter triangle indicator.
  // Read chapters + chapter_x_offset via stable selectors so the membership
  // check only re-runs when these actually change, not on every store tick.
  const chapters = useProjectStore((s) => s.story?.chapters || EMPTY_CHAPTERS)
  const chapterXOffset = useProjectStore((s) => {
    const v = s.story?.chapter_x_offset
    return typeof v === 'number' ? v : 10
  })
  const deleteNode            = useProjectStore((s) => s.deleteNode)
  const addEntityChipToNode        = useProjectStore((s) => s.addEntityChipToNode)
  const createOriginAndWireToScene = useProjectStore((s) => s.createOriginAndWireToScene)
  const setDetailPanel             = useUiStore((s) => s.setDetailPanel)
  const openRightSidebar           = useUiStore((s) => s.openRightSidebar)
  const closeRightSidebar          = useUiStore((s) => s.closeRightSidebar)
  const rightSidebarOpen           = useUiStore((s) => s.rightSidebarOpen)
  const rightSidebarNodeId         = useUiStore((s) => s.rightSidebarNodeId)
  const isActiveNode          = useUiStore((s) => s.detailPanelNodeId === id)
  const hasPovWire            = useProjectStore((s) => s.edges.some((e) => e.target === id && e.data?.is_pov_path))
  const storyPovType          = useProjectStore((s) => s.story?.pov_type_default || '')
  const allRelationships      = useProjectStore((s) => s.relationships)
  const relationshipsByScene  = useProjectStore((s) => s.relationshipsByScene)
  // Phase 1.22f part 2 — entity arrays for the scene-level circumstance
  // marker. Used by `computeSceneEffectiveCircumstancePool` to chain-
  // resolve each present entity's carried circumstance attributes at
  // this scene anchor (chain walker per entity inside the helper).
  const sceneAllCharacters = useEntitiesStore((s) => s.characters)
  const sceneAllLocations  = useEntitiesStore((s) => s.locations)
  const sceneAllItems      = useEntitiesStore((s) => s.items)
  const sceneAllFactions   = useEntitiesStore((s) => s.factions)
  const sceneAllCustoms    = useEntitiesStore((s) => s.customs)
  const setDetailPanelActiveSubTab = useUiStore((s) => s.setDetailPanelActiveSubTab)

  // Phase 4.1g #2 — the scene-circumstances marker was the only
  // consumer of whole `s.nodes` / `s.edges` subscriptions here, and it
  // recomputed its chain-resolved pool inline in the JSX on EVERY
  // render of every scene node. Both replaced: the marker's inputs are
  // this scene's own data (props) plus the chains of the entities
  // PRESENT at this scene, so the re-render gate is the joined
  // per-entity chain hash of those entities, and the pool itself is
  // memoized below, reading fresh store state at compute time. The
  // chain walks are unchanged (same walkers, same scene anchor);
  // only WHEN they re-run is scoped.
  const presentEntityIds = useMemo(() => {
    const ids = []
    for (const b of ENTITY_BUCKETS) {
      for (const r of (data[b] || [])) {
        if (r?.entity_id) ids.push(r.entity_id)
      }
    }
    ids.sort()
    return ids
  }, [data])
  const presentChainHash = useProjectStore(
    (s) => selectEntitiesChainHash(s.nodes, s.edges, presentEntityIds)
  )
  const sceneCircInfo = useMemo(() => {
    const allEntitiesForPool = [
      ...sceneAllCharacters, ...sceneAllLocations, ...sceneAllItems,
      ...sceneAllFactions, ...sceneAllCustoms,
    ]
    const sceneShape = { ...data, id }
    const { nodes: ns, edges: es } = useProjectStore.getState()
    const pool = computeSceneEffectiveCircumstancePool(sceneShape, allEntitiesForPool, ns, es)
    const sceneCircs = pool.sceneLevel || []
    const perEntity = (pool.perEntity || [])
      .filter((e) => (e.circumstances || []).length > 0)
      .map((bucketEntry) => {
        const ent = allEntitiesForPool.find((e) => e.id === bucketEntry.entityId)
        if (!ent) return null
        // Chain-aware: resolve this entity's name + colour at THIS
        // scene anchor (matches the per-entity section in the
        // SceneCircumstancesView sidebar).
        const eff = computeEffectiveState(ent, ns, es, id) || {}
        return {
          entityId: bucketEntry.entityId,
          circumstances: bucketEntry.circumstances,
          dispName: eff.name ?? ent.name ?? '',
          dispColour: eff.colour ?? ent.colour ?? '#888888',
        }
      })
      .filter(Boolean)
    const entityCircCount = perEntity.reduce((acc, e) => acc + e.circumstances.length, 0)
    return { sceneCircs, perEntity, total: sceneCircs.length + entityCircCount }
    // `presentChainHash` gates the chain-walk recompute; see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, id, presentChainHash, sceneAllCharacters, sceneAllLocations, sceneAllItems, sceneAllFactions, sceneAllCustoms])
  const povChain              = usePovChain()
  const storyOrder            = useStoryOrder()
  const povChainIndex         = getPovChainIndex(povChain, id)
  const povNoPathToStart      = data.pov_entity_id ? !isReachableFromOrigin(povChain, id) : false

  const updateNodeInternals         = useUpdateNodeInternals()
  const [hovered, setHovered]       = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)

  // Dynamic minimum height — measured from the inner content div (no explicit height)
  // so the minimum always reflects real content, never the user-set explicit height.
  // Using an inner ref is critical: the outer nodeRef div has height: data.height which
  // inflates scrollHeight to the user-set size, wrongly locking the minimum after any
  // manual enlargement. The contentRef div has no explicit height, so its scrollHeight
  // always equals the natural content height regardless of the outer node's size.
  // Description is rendered INSIDE contentRef, so contentEl.scrollHeight already
  // includes its real height — no separate descExtra calculation is needed.
  // Whitespace-only descriptions count as empty so the section
  // hides itself once the writer clears the field (typing then
  // deleting can leave a stray space behind).
  const hasDescription = !!(data.description?.trim())
  const nodeRef    = useRef(null)   // outer div — carries explicit width/height for React Flow
  const contentRef = useRef(null)   // inner content wrapper (flex column, fills outer node)
  const aboveDescRef = useRef(null) // flex-shrink-0 wrapper around content above description
  const belowDescRef = useRef(null) // flex-shrink-0 wrapper around content below description
  const descBlockRef = useRef(null) // outer description container (px-2 pb-1 pt-1 wrapper)
  const descTextRef = useRef(null)  // description text div — measured for natural text height
  // Section measurements drive the derived descRenderedHeight: with explicit
  // height on the text div, the description block fills the gap between
  // aboveDescRef + belowDescRef and the outer node height (data.height). When
  // any of these change (chip add / remove, header expand, etc.) the resize
  // observer below re-measures and re-derives.
  // Seed from the per-node measurement cache when the node's content (`data`
  // ref) is unchanged — a pan remount then reuses the prior measurement with no
  // offsetHeight read. Cache miss (first mount / content changed) falls back to
  // the defaults and the ResizeObserver below measures.
  const [sectionMetrics, setSectionMetrics] = useState(() => {
    const c = _sceneSizeCache.get(id)
    return c && c.dataRef === data ? c.sectionMetrics : { ...DEFAULT_SECTION_METRICS }
  })
  const [naturalMinHeight, setNaturalMinHeight] = useState(() => {
    const c = _sceneSizeCache.get(id)
    if (c && c.dataRef === data) return c.naturalMinHeight
    // Cache miss (first mount, or `data` changed since the cache was tagged):
    // fall back to the REMEMBERED measurement (which survives React Flow
    // culling) rather than a flat 80, so a tall scene culled then re-approached
    // re-mounts at its true height instead of collapsing to 80 and being wrongly
    // culled again. Genuine first-ever render (nothing remembered) still gets 80;
    // the ResizeObserver corrects it after mount.
    return getMeasuredHeight(id) ?? 80
  })
  // Holds the current `data` ref so the measurement-cache write inside
  // `recomputeMinHeight` can tag the cache without `data` entering its dep array
  // (which `data.height` churn would otherwise invalidate every frame).
  const dataRefForCache = useRef(data)
  dataRefForCache.current = data

  // Description-box resize: default basis is 80px (the original max-h-20
  // cap). Users may drag the bottom edge of the box to enlarge it; dragging
  // back at or below the default clears the override so saves don't carry
  // redundant data. DESC_TEXT_FLOOR is the absolute minimum the inner text
  // div can shrink to (when the user drags the node's bottom-right corner
  // smaller than the description's preferred size, the description follows
  // down to this floor before the node refuses to shrink further).
  const DEFAULT_DESC_MAX_HEIGHT = 80
  const DESC_TEXT_FLOOR = 24
  const [descDragHeight, setDescDragHeight] = useState(null)
  const descDragStateRef = useRef(null)
  // React Flow renders nodes inside a CSS scale transform; cursor delta
  // must be divided by zoom to track node-local pixels during drag.
  const reactFlowZoom = useStore((s) => s.transform?.[2] ?? 1)
  const zoomRef = useRef(1)
  zoomRef.current = reactFlowZoom
  // Tracks the previous preferredMinHeight so the contract effect below can
  // tell whether the node was "at preferred" before a content change (and
  // should therefore follow a downward shift in preferred).
  const prevPreferredMinHeightRef = useRef(80)

  // Reset measurement state on a fresh project load.
  //
  // React Flow reuses SceneNode component instances across project loads when
  // node ids match (test fixtures often share UUIDs). Without this reset,
  // `sectionMetrics` and `prevPreferredMinHeightRef` retain values from the
  // previous project's incarnation; the auto-grow / auto-shrink effects fire
  // on the first render of the new project comparing the new file's
  // `data.height` against the OLD project's measurements, producing a
  // spurious updateNodeData write that flips `hasUnsavedChanges` even though
  // nothing changed.
  //
  // `loadGeneration` increments in projectStore on every successful load.
  // The render-time setState pattern is the canonical React way to reset
  // local state on a prop/store change: when the setter fires during render,
  // React discards the rest of this render's output and immediately
  // re-renders with the new state, BEFORE running any effects, so the
  // auto-grow effects only ever see fresh measurements.
  const loadGeneration = useProjectStore((s) => s.loadGeneration)
  const [storedLoadGen, setStoredLoadGen] = useState(loadGeneration)
  if (storedLoadGen !== loadGeneration) {
    setStoredLoadGen(loadGeneration)
    setSectionMetrics({ aboveH: 0, belowH: 0, descOverhead: 32 })
    prevPreferredMinHeightRef.current = 80
  }

  // Recompute naturalMinHeight from above/below section measurements plus
  // description block overhead. naturalMinHeight is the absolute floor: the
  // smallest the node can be while still fitting all chrome and a
  // FLOOR-sized description text region. preferredMinHeight (computed
  // separately below) reflects the user's preferred description size and
  // drives auto-grow / auto-shrink of data.height.
  const recomputeMinHeight = useCallback(() => {
    const aboveEl = aboveDescRef.current
    const belowEl = belowDescRef.current
    const blockEl = descBlockRef.current
    const textEl = descTextRef.current
    if (!aboveEl || !belowEl) return
    const aboveH = aboveEl.offsetHeight
    const belowH = belowEl.offsetHeight
    // Description block overhead = block - text (label + paddings + borders).
    // When the description block isn't rendered (no description text), use
    // 0 so naturalMinHeight reduces to above + below.
    let descOverhead = 0
    if (blockEl && textEl) {
      descOverhead = Math.max(0, blockEl.offsetHeight - textEl.offsetHeight)
    }
    const metrics = { aboveH, belowH, descOverhead }
    setSectionMetrics(metrics)
    const floorH = aboveH + belowH + (hasDescription ? (descOverhead + DESC_TEXT_FLOOR) : 0)
    setNaturalMinHeight(floorH)
    // Cache the measurement against the current content (`data` ref) so a later
    // remount with unchanged content reuses it without re-measuring.
    _sceneSizeCache.set(id, { dataRef: dataRefForCache.current, sectionMetrics: metrics, naturalMinHeight: floorH })
  }, [hasDescription, id])

  useEffect(() => {
    const aboveEl = aboveDescRef.current
    const belowEl = belowDescRef.current
    const descEl    = descTextRef.current
    const blockEl = descBlockRef.current
    if (!aboveEl || !belowEl) return
    // Skip the ResizeObserver's mandatory initial (observe-time) fire when the
    // node remounted with unchanged content (cache hit): its size can't have
    // changed, so re-measuring would only force a needless reflow — the per-
    // node cost of a pan. The seeded state already holds the cached measurement.
    // First-ever mount or content changed (cache miss) measures as before, and
    // every SUBSEQUENT fire is a real resize that always recomputes.
    let firstFire = true
    const obs = new ResizeObserver(() => {
      if (firstFire) {
        firstFire = false
        const c = _sceneSizeCache.get(id)
        if (c && c.dataRef === dataRefForCache.current) return
      }
      recomputeMinHeight()
    })
    obs.observe(aboveEl)
    obs.observe(belowEl)
    if (blockEl) obs.observe(blockEl)
    if (descEl) obs.observe(descEl)
    return () => obs.disconnect()
  }, [hasDescription, recomputeMinHeight, id])

  // Description text rendered height. Derives from the outer node height
  // when set: descRenderedHeight = data.height - aboveH - belowH - overhead,
  // clamped to FLOOR. Without an explicit data.height, falls back to the
  // user's preference (description_height) or the default. Live drag
  // preview takes precedence so the resize handle tracks the cursor.
  const descRenderedHeight = useMemo(() => {
    if (descDragHeight != null) return descDragHeight
    const userPref = data.description_height ?? DEFAULT_DESC_MAX_HEIGHT
    if (!data.height) return userPref
    const fixedH = sectionMetrics.aboveH + sectionMetrics.belowH + sectionMetrics.descOverhead
    return Math.max(DESC_TEXT_FLOOR, data.height - fixedH)
  }, [data.height, data.description_height, descDragHeight, sectionMetrics.aboveH, sectionMetrics.belowH, sectionMetrics.descOverhead])

  // Preferred minimum node height: what data.height should be when the
  // description is rendered at the user's preferred (or default) size.
  // Drives auto-grow when content is added and auto-shrink when the user
  // explicitly reduces description_height.
  const preferredMinHeight = useMemo(() => {
    const userPref = data.description_height ?? DEFAULT_DESC_MAX_HEIGHT
    return sectionMetrics.aboveH + sectionMetrics.belowH +
      (hasDescription ? (sectionMetrics.descOverhead + userPref) : 0)
  }, [data.description_height, sectionMetrics.aboveH, sectionMetrics.belowH, sectionMetrics.descOverhead, hasDescription])

  // Universal handle-reanchor safeguard: any time the inner content
  // wrapper resizes (chip add / remove, POV chip add / remove, time
  // row toggle, description grow / shrink, hierarchy panel toggle,
  // anything that shifts handles vertically), force React Flow to
  // recompute handle positions for the wires that target them.
  // Without this, wires retain stale anchor coordinates from before
  // the layout change and visually disconnect from their port. This
  // catch-all complements the per-cause `updateNodeInternals` calls
  // elsewhere in the file — those stay in place for the "force
  // re-anchor on a known signal that doesn't necessarily resize the
  // content (e.g. POV reassignment via store action)" cases, but
  // this observer ensures any layout change picks up the re-anchor
  // automatically without needing a bespoke trigger.
  useEffect(() => {
    const contentEl = contentRef.current
    if (!contentEl) return
    // Skip the initial observe-time fire (same skip-first-render guard the
    // pov_entity_id / time-tracking re-anchor effects below already use, for
    // the same reason): React Flow's own measurement anchors handles on mount,
    // so re-anchoring here on mount is redundant — and during a pan, where
    // scene nodes remount en masse as they virtualize in and out of view, that
    // rAF `updateNodeInternals` reads handle geometry pre-layout and forces a
    // reflow per node (a trace attributed ~460ms of pan-stutter reflow to it).
    // Only ACTUAL post-mount content resizes (chip add/remove, description
    // grow, etc.) need the re-anchor.
    let firstObserve = true
    const obs = new ResizeObserver(() => {
      if (firstObserve) { firstObserve = false; return }
      requestAnimationFrame(() => updateNodeInternals(id))
    })
    obs.observe(contentEl)
    return () => obs.disconnect()
  }, [id, updateNodeInternals])

  // For flashback scenes, read entity chips from the parent scene (live reference)
  const parentNode = data.is_flashback && data.parent_scene_id
    ? useProjectStore.getState().nodes.find((n) => n.id === data.parent_scene_id)
    : null
  const entitySource = data.is_flashback ? (parentNode?.data || {}) : data
  // Read chip arrays directly from `entitySource` (no `|| []` locals).
  // The previous pattern (`const characters = entitySource.characters || []`)
  // allocated a fresh empty array on every render whenever a bucket was
  // absent, which produced a new dep reference for `orderedChips` and
  // forced the memo to recompute on every render. Reading member
  // accesses directly inside the memo's deps avoids the allocation —
  // `entitySource.characters` is whatever ref the store holds and is
  // stable across renders when the underlying scene data is stable.
  const chipCount = (entitySource.characters?.length || 0)
    + (entitySource.locations?.length || 0)
    + (entitySource.items?.length || 0)
    + (entitySource.factions?.length || 0)
    + (entitySource.customs?.length || 0)
  const hasChips = chipCount > 0

  // ── Ordered chip list (flat, respects chip_order) ──────────────────────────
  const orderedChips = useMemo(() => {
    const all = [
      ...(entitySource.characters || []),
      ...(entitySource.locations  || []),
      ...(entitySource.items      || []),
      ...(entitySource.factions   || []),
      ...(entitySource.customs    || []),
    ]
    const order = data.chip_order || []
    if (order.length === 0) return all
    const orderMap = new Map(order.map((eid, i) => [eid, i]))
    return [...all].sort((a, b) => {
      const ai = orderMap.has(a.entity_id) ? orderMap.get(a.entity_id) : Infinity
      const bi = orderMap.has(b.entity_id) ? orderMap.get(b.entity_id) : Infinity
      return ai - bi
    })
  }, [entitySource.characters, entitySource.locations, entitySource.items, entitySource.factions, entitySource.customs, data.chip_order])

  // ── Relationship chips — shown at this scene in two cases ──
  // 1. A history event was recorded at this scene (relationshipsByScene index).
  // 2. "Ambient" inclusion: the relationship's effective participants at this chain
  //    position are all present as chips in this scene. No sub-chips are rendered
  //    (no change here); the chip just shows the relationship's ambient presence.
  // nodeOrder is derived per-relationship inside the loop below via
  // `getRelationshipNodeOrder` (graph-walk, not canvas x-position).
  const sceneEntityIds = useMemo(() => {
    const ids = new Set()
    const collect = (refs) => {
      for (const ref of (refs || [])) {
        if (ref.entity_id) ids.add(ref.entity_id)
      }
    }
    collect(data.characters)
    collect(data.locations)
    collect(data.items)
    collect(data.factions)
    collect(data.customs)
    return ids
  }, [data.characters, data.locations, data.items, data.factions, data.customs])

  // Perf #10: relationship node-order walks lifted to the shared
  // `useRelationshipNodeMaps` cache. The previous per-render pattern
  // re-ran `getRelationshipNodeOrder` per (scene, rel) pair, and each
  // walk touches every current participant's narrative chain — so the
  // cost compounded across (scenes × rels × participants). Now: one
  // walk per Relationship per `(relationships, nodes, edges, storyOrder)`
  // change, shared across every Scene rendering in the same tick.
  // `computeRelationshipEffectiveState` stays per-call (it depends on
  // `atNodeId` and can't be shared across scenes).
  const { forwardMap: _relForwardMap } = useRelationshipNodeMaps()
  const relChipsAtScene = useMemo(() => {
    const modifiedHere = relationshipsByScene[id] || new Set()
    const result = []
    for (const rel of allRelationships) {
      if (modifiedHere.has(rel.id)) {
        result.push(rel)
        continue
      }
      const nodeOrder = relationshipNodeOrder(_relForwardMap, rel.id)
      const effective = computeRelationshipEffectiveState(rel, nodeOrder, id)
      if (!effective || !effective.is_active) continue
      const participants = effective.participants || []
      if (participants.length === 0) continue
      if (participants.every((p) => sceneEntityIds.has(p.entity_id))) {
        result.push(rel)
      }
    }
    return result
  }, [allRelationships, relationshipsByScene, id, _relForwardMap, sceneEntityIds])

  // Phase 1.21c — Knowledge chips at this scene. A Knowledge chip renders
  // for every Knowledge whose chain (history entries OR manual anchors)
  // includes this scene's id — see `getKnowledgeNodeOrder`. This covers
  // both content-change positions (name / description / colour /
  // profile_image / awareness) and manual-anchor-only positions (scene
  // pinned without any history entry).
  //
  // Perf #7: lifted to a shared story-level memoized map via
  // `useKnowledgeNodeMaps`. The previous pattern walked every Knowledge
  // in the project per (scene, knowledge) pair AND each Scene rebuilt
  // the same answer in isolation. The hook caches one set of maps for
  // the whole canvas; this scene's lookup is now O(K) at worst (the
  // length of `reverseMap.get(id)`), and shared with every other Scene
  // that renders during the same dep tick.
  const { reverseMap: _kReverseMap, knowledgesById: _kById } = useKnowledgeNodeMaps()
  const knowledgeChipsAtScene = useMemo(() => {
    const ids = knowledgesAtNode(_kReverseMap, id)
    if (ids.length === 0) return []
    const result = []
    for (const kid of ids) {
      const k = _kById.get(kid)
      if (k) result.push(k)
    }
    return result
  }, [_kReverseMap, _kById, id])

  // ── Chip drag-to-reorder state ──────────────────────────────────────────────
  const [draggedChipId, setDraggedChipId]   = useState(null)
  const [dragOverChipId, setDragOverChipId] = useState(null)

  const handleChipDragStart = useCallback((entityId, e) => {
    setDraggedChipId(entityId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', entityId)

    // Custom drag ghost: profile image (or placeholder) with entity colour border
    const entity = useEntitiesStore.getState().getEntityById(entityId)
    const { nodes: allNodes, edges: allEdges } = useProjectStore.getState()
    const effective = entity ? computeEffectiveState(entity, allNodes, allEdges, id) : null
    const colour = effective?.colour || entity?.colour || '#888888'
    const imgRef = effective?.profile_image_ref ?? entity?.profile_image_ref
    const imgSrc = imgRef ? `/api/project/assets/${imgRef.replace(/^assets\//, '')}` : null

    const ghost = document.createElement('div')
    ghost.style.cssText = `
      width: 40px; height: 40px; border-radius: 4px; border: 2px solid ${colour};
      overflow: hidden; position: fixed; top: -100px; left: -100px;
      display: flex; align-items: center; justify-content: center;
      background: #27272a; font-size: 18px;
    `
    if (imgSrc) {
      const img = document.createElement('img')
      img.src = imgSrc
      img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;'
      ghost.appendChild(img)
    } else {
      ghost.textContent = TYPE_ICONS[entity?.type] || '?'
      ghost.style.backgroundColor = colour + '22'
    }
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 20, 20)
    requestAnimationFrame(() => document.body.removeChild(ghost))
  }, [id])

  const handleChipDragOver = useCallback((entityId, e) => {
    // Only entity-typed drags (intra-scene reorder via plain text/id, or
    // library entity drag) drive the per-entity-chip indicator. A knowledge
    // or relationship drag shouldn't paint the blue line on entity chips —
    // its indicator lives in its own section, computed by the scene-level
    // handleDragOver / dropIndicator path.
    const types = e.dataTransfer.types
    if (
      types.includes('application/nnz-knowledge-id') ||
      types.includes('application/nnz-relationship-id')
    ) {
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (entityId !== draggedChipId) setDragOverChipId(entityId)
  }, [draggedChipId])

  const handleChipDrop = useCallback((targetEntityId, e) => {
    // Library-to-scene drops: let the event bubble to the node-level handleDrop
    // which will read dragOverChipId for insertion position
    if (e.dataTransfer.types.includes('application/nnz-entity-id')) return
    if (e.dataTransfer.types.includes('application/nnz-relationship-id')) return

    e.preventDefault()
    setDragOverChipId(null)
    if (!draggedChipId || draggedChipId === targetEntityId) { setDraggedChipId(null); return }
    // Build new order
    const currentOrder = orderedChips.map((r) => r.entity_id)
    const fromIdx = currentOrder.indexOf(draggedChipId)
    if (fromIdx === -1) { setDraggedChipId(null); return }
    const newOrder = [...currentOrder]
    newOrder.splice(fromIdx, 1)
    if (targetEntityId === '__end__') {
      // Trailing drop zone: move dragged chip to the end
      newOrder.push(draggedChipId)
    } else {
      const toIdx = currentOrder.indexOf(targetEntityId)
      if (toIdx === -1) { setDraggedChipId(null); return }
      // Adjust insertion index: after removing the dragged item, indices shift
      const insertIdx = toIdx > fromIdx ? toIdx - 1 : toIdx
      newOrder.splice(insertIdx, 0, draggedChipId)
    }
    updateNodeData(id, { chip_order: newOrder })
    setDraggedChipId(null)
    // Force React Flow to recalculate handle positions after chip reorder
    requestAnimationFrame(() => updateNodeInternals(id))
  }, [draggedChipId, orderedChips, id, updateNodeData, updateNodeInternals])

  const handleChipDragEnd = useCallback(() => {
    setDraggedChipId(null)
    setDragOverChipId(null)
  }, [])

  // ── POV chip drag-to-reassign ────────────────────────────────────────────────
  const [povDragging, setPovDragging] = useState(false)
  const [povDragOverEntityId, setPovDragOverEntityId] = useState(null)

  const handlePovDragStart = useCallback((e) => {
    setPovDragging(true)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/nnz-pov-reassign', 'pov')

    // Custom drag ghost: small POV badge
    const ghost = document.createElement('div')
    ghost.style.cssText = `
      padding: 2px 8px; border-radius: 3px; font-size: 9px; font-weight: bold;
      color: ${povColor}; background: #27272a; border: 2px solid ${povColor};
      position: fixed; top: -100px; left: -100px;
    `
    ghost.textContent = 'POV'
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 20, 12)
    requestAnimationFrame(() => document.body.removeChild(ghost))
  }, [povColor])

  // Signature contract: `(entityId, e)` so the EntityChip call sites can
  // pass these stable handler refs directly instead of wrapping with an
  // inline arrow per chip (the prior `(entityId, entityType, e)` shape
  // required the call site to look up the entity's type and pass it,
  // forcing a fresh lambda every render). The type gate that used to be
  // a parameter now lives inside the handler — looks up via
  // `entitiesStore.getEntityById` at fire time, not render time.
  const handlePovDragOverChip = useCallback((entityId, e) => {
    if (!e.dataTransfer.types.includes('application/nnz-pov-reassign')) return
    const ent = useEntitiesStore.getState().getEntityById(entityId)
    if (ent?.type !== 'character') return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setPovDragOverEntityId(entityId)
  }, [])

  const handlePovDropOnChip = useCallback((entityId, e) => {
    if (!e.dataTransfer.types.includes('application/nnz-pov-reassign')) return
    const ent = useEntitiesStore.getState().getEntityById(entityId)
    if (ent?.type !== 'character') return
    e.preventDefault()
    setPovDragging(false)
    setPovDragOverEntityId(null)
    if (entityId !== data.pov_entity_id) {
      updateNodeData(id, { pov_entity_id: entityId })
      // Recalculate port positions after POV badge moves to new chip
      requestAnimationFrame(() => updateNodeInternals(id))
    }
  }, [id, data.pov_entity_id, updateNodeData, updateNodeInternals])

  const handlePovDragEnd = useCallback(() => {
    setPovDragging(false)
    setPovDragOverEntityId(null)
  }, [])

  const handleRemovePov = useCallback((e) => {
    e.stopPropagation()
    // Canonical store action clears pov_entity_id AND strips all POV wires
    // to/from this scene in one atomic commit.
    useProjectStore.getState().removePovWiresForScene(id)
  }, [id])

  const handleEjectPov = useCallback((e) => {
    e.stopPropagation()
    // Detach POV from character but keep POV wires — reverts to orphaned "No character" state
    updateNodeData(id, { pov_entity_id: null })
  }, [id, updateNodeData])

  // Recalculate handle positions when POV is reassigned via onConnect (store-initiated)
  const povInternalsUpdate = useProjectStore((s) => s._povInternalsUpdate)
  useEffect(() => {
    if (povInternalsUpdate && data.pov_entity_id) {
      requestAnimationFrame(() => updateNodeInternals(id))
    }
  }, [povInternalsUpdate, data.pov_entity_id, id, updateNodeInternals])

  // Recalculate handle positions whenever the POV chip is added or
  // REMOVED (pov_entity_id transitions in either direction). Removing
  // POV from a scene shrinks the chip column by one row, shifting
  // every entity-chip handle upward; React Flow doesn't observe that
  // layout change so existing wires would land on the OLD handle
  // positions until the next forced re-anchor.
  //
  // Skip-first-render guard: every `useEffect` fires once on mount
  // with its initial deps. For every SceneNode in viewport on initial
  // load that's a redundant `updateNodeInternals(id)` scheduled in
  // the rAF right after mount — and across many SceneNodes the
  // cascade of "re-measure" requests competes with React Flow's own
  // ResizeObserver-based initial measurement, briefly hanging the
  // canvas and leaving edges drawn against the in-progress
  // measurement state. Initial anchoring is already handled by RF's
  // native measurement; this effect only needs to fire on actual
  // pov_entity_id TRANSITIONS post-mount.
  const povTransitionFirstRunRef = useRef(true)
  useEffect(() => {
    if (povTransitionFirstRunRef.current) {
      povTransitionFirstRunRef.current = false
      return
    }
    requestAnimationFrame(() => updateNodeInternals(id))
  }, [data.pov_entity_id, id, updateNodeInternals])

  // Toggling Time Tracking on/off adds or removes the SceneTimeRow,
  // shifting every handle below its insertion point. React Flow
  // doesn't observe layout changes for handle positions on its own;
  // we have to call updateNodeInternals(id) so wires re-anchor to
  // the new positions. Same pattern as the chip-reorder /
  // POV-reassign flows above. Skip-first-render guard for the same
  // reason as the pov_entity_id transition effect above.
  const timeTrackingEnabled = useProjectStore((s) => s.story?.time_tracking_enabled === true)
  const timeTrackingFirstRunRef = useRef(true)
  useEffect(() => {
    if (timeTrackingFirstRunRef.current) {
      timeTrackingFirstRunRef.current = false
      return
    }
    requestAnimationFrame(() => updateNodeInternals(id))
  }, [timeTrackingEnabled, id, updateNodeInternals])

  // Auto-expand node height when chips are added and the stored height is
  // too small to show them at the description's preferred size.
  // `silent: true` — this is a program-driven layout correction, not a
  // user resize. The recomputed height persists on the next user-save
  // but doesn't trigger the autosave / "discard changes?" prompt on
  // its own (which would otherwise fire on every project load because
  // the first mount of every scene runs this effect).
  useEffect(() => {
    // Skip the offsetHeight re-measure on a remount with unchanged content
    // (cache hit): the seeded sectionMetrics are already correct, and a pan
    // remount can't change the node's size. A real chip change flips the `data`
    // ref → cache miss → remeasure. This effect (not the ResizeObserver) was
    // the dominant per-node pan reflow — it ran recomputeMinHeight on every
    // mount, reading offsetHeight ×3 per scene node as they virtualized in/out.
    const c = _sceneSizeCache.get(id)
    const cacheHit = c && c.dataRef === dataRefForCache.current
    if (!cacheHit) recomputeMinHeight()
    if (data.height && data.height < preferredMinHeight) {
      updateNodeData(id, { height: preferredMinHeight }, { silent: true })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chipCount])

  // Sync stored node height when preferred minimum changes (hierarchy
  // panel toggle, description_height adjusted via the description-resize
  // handle / double-click, time row toggle, etc.).
  // Expand: stored height < new preferred → grow to fit.
  // Contract: node was at-or-below the OLD preferred (i.e., the stored
  //   height tracked the description's old size) and the new preferred
  //   shrank → follow downward so reducing description_height also
  //   reduces the node. The drag-end / double-click handlers also push
  //   data.height down explicitly, so this contract is the safety net
  //   that handles other content-shrink causes.
  // `silent: true` — same rationale as the chipCount-driven effect
  // above: program-driven layout correction, not a user resize.
  useEffect(() => {
    const prevPref = prevPreferredMinHeightRef.current
    prevPreferredMinHeightRef.current = preferredMinHeight
    if (!data.height) return
    if (data.height < preferredMinHeight) {
      updateNodeData(id, { height: preferredMinHeight }, { silent: true })
    } else if (data.height <= prevPref && preferredMinHeight < prevPref) {
      updateNodeData(id, { height: preferredMinHeight }, { silent: true })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferredMinHeight])

  // Description-box bottom-edge drag-resize. Live preview tracked in
  // descDragHeight; on release, commit to data.description_height. If the
  // final height is at or below the default cap, clear the override so the
  // save reverts to the implicit default and keeps narrative.json compact.
  const handleDescResizeStart = useCallback((e) => {
    // Let double-click reach onDoubleClick — skip drag setup on the
    // second click of a double-click sequence.
    if (e.detail >= 2) return
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    // Start from what's currently rendered, not the saved preference. The
    // node may have been corner-resized since the last description-handle
    // commit, so the visible description size differs from data.description_height.
    // Tracking from the rendered size keeps the cursor anchored to the grip.
    const renderedTextH = descTextRef.current?.offsetHeight ?? null
    const startHeight = renderedTextH ?? data.description_height ?? DEFAULT_DESC_MAX_HEIGHT
    // Capture React Flow zoom at drag start so cursor delta tracks
    // node-local pixels (canvas is rendered inside a CSS scale transform).
    // zoomRef is updated on every render via useStore subscription below.
    const zoom = zoomRef.current || 1
    descDragStateRef.current = { startY, startHeight, zoom }

    const onMove = (mv) => {
      const state = descDragStateRef.current
      if (!state) return
      const delta = (mv.clientY - state.startY) / state.zoom
      const next = Math.max(24, state.startHeight + delta)
      setDescDragHeight(next)
    }
    const onUp = () => {
      descDragStateRef.current = null
      setDescDragHeight((current) => {
        if (current != null) {
          // Commit the dragged value exactly as-is so the description size
          // stays where the user dropped it (no spring back to default).
          // Snap node height + adjust description_height to match so the
          // saved-on-disk values are self-consistent and a follow-up corner
          // drag doesn't jump from an off-grid value to the nearest step.
          // Double-click is the canonical "reset to default" affordance.
          const fixedH = sectionMetrics.aboveH + sectionMetrics.belowH + sectionMetrics.descOverhead
          const draggedDescHeight = Math.max(DESC_TEXT_FLOOR, Math.round(current))
          const rawPreferred = fixedH + draggedDescHeight
          const snapToGrid = useProjectStore.getState().snapToGrid
          const snapped = applyResizeSnap(
            { width: data.width || 220, height: rawPreferred },
            snapToGrid,
          )
          // After snapping data.height, derive description_height from it so
          // descRenderedHeight (= data.height - fixedH) matches the saved
          // description_height on reload. If the snapped result equals the
          // default, clear the override so saves stay clean.
          const adjustedDescH = fixedH > 0
            ? Math.max(DESC_TEXT_FLOOR, snapped.height - fixedH)
            : draggedDescHeight
          const finalDescH = adjustedDescH === DEFAULT_DESC_MAX_HEIGHT ? null : adjustedDescH
          const update = { description_height: finalDescH }
          if (fixedH > 0) update.height = snapped.height
          updateNodeData(id, update)
        }
        return null
      })
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [data.description_height, data.width, id, updateNodeData, sectionMetrics])

  // Double-click the description-resize grip toggles between auto-minimum
  // (no override; default 80px cap with internal scroll) and fully-expanded
  // (description_height set to the inner text's natural full height so all
  // text is visible without scrolling). Sync data.height alongside so the
  // node shrinks/grows in lockstep with the description's preferred size.
  const handleDescResizeDoubleClick = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    const overrideActive = data.description_height != null
    const fixedH = sectionMetrics.aboveH + sectionMetrics.belowH + sectionMetrics.descOverhead
    const snapToGrid = useProjectStore.getState().snapToGrid
    const snapH = (rawHeight) => applyResizeSnap(
      { width: data.width || 220, height: rawHeight },
      snapToGrid,
    ).height
    if (overrideActive) {
      const update = { description_height: null }
      if (fixedH > 0) update.height = snapH(fixedH + DEFAULT_DESC_MAX_HEIGHT)
      updateNodeData(id, update)
    } else {
      const descEl = descTextRef.current
      const fullH = descEl ? descEl.scrollHeight : DEFAULT_DESC_MAX_HEIGHT
      // Only commit if expansion actually changes anything — if the text
      // already fits inside the default cap there's no override needed.
      if (fullH > DEFAULT_DESC_MAX_HEIGHT) {
        const newDescH = Math.round(fullH)
        const update = { description_height: newDescH }
        if (fixedH > 0) update.height = snapH(fixedH + newDescH)
        updateNodeData(id, update)
      }
    }
  }, [data.description_height, data.width, id, updateNodeData, sectionMetrics])

  // ── Drag-from-library drop handlers ──────────────────────────────────────

  // Drop-indicator state for relationship and knowledge drags. The indicator
  // line snaps to the valid slot nearest the cursor within the dragged
  // type's section (relationship section or knowledge section). Entity
  // drags keep the existing per-chip handler model — the cursor must be
  // over an entity chip for the indicator to land there.
  const [dropIndicator, setDropIndicator] = useState(null)  // { kind, slot } | null
  const relChipRefsRef = useRef(new Map())
  const knowledgeChipRefsRef = useRef(new Map())

  const handleDragOver = useCallback((e) => {
    const types = e.dataTransfer.types
    const isEntity = types.includes('application/nnz-entity-id')
    const isRel    = types.includes('application/nnz-relationship-id')
    const isKnow   = types.includes('application/nnz-knowledge-id')
    if (!isEntity && !isRel && !isKnow) return

    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setIsDragOver(true)

    if (isRel || isKnow) {
      const kind = isRel ? 'relationship' : 'knowledge'
      const refsMap = isRel ? relChipRefsRef.current : knowledgeChipRefsRef.current
      const ids = isRel
        ? relChipsAtScene.map((r) => r.id)
        : knowledgeChipsAtScene.map((k) => k.id)
      const cy = e.clientY
      let slot = 0
      for (const cid of ids) {
        const el = refsMap.get(cid)
        if (!el) continue
        const r = el.getBoundingClientRect()
        if ((r.top + r.bottom) / 2 < cy) slot++
      }
      setDropIndicator({ kind, slot })
    } else {
      setDropIndicator(null)
    }
  }, [relChipsAtScene, knowledgeChipsAtScene])

  const handleDragLeave = useCallback((e) => {
    // Only clear if leaving the node entirely (not entering a child)
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setIsDragOver(false)
      setDropIndicator(null)
    }
  }, [])

  const handleDrop = useCallback((e) => {
    // Knowledge drop (Phase 1.21c Tier 3):
    //   - if the Knowledge already chips at this scene AND is orphan
    //     (no creation anchor) AND THIS scene is the earliest chain
    //     position (no upstream conflicts) → promote this scene to
    //     creation anchor by seeding a scene-born activate event here.
    //   - else if the Knowledge already chips at this scene → silent
    //     no-op (chipped elsewhere too, can't safely set this as origin
    //     without orphaning the upstream entries).
    //   - else if the Knowledge has NO creation anchor yet → seed a
    //     scene-born birth event here.
    //   - else → add a manual anchor so the chip appears here as a
    //     "show me here too" pin.
    const knowledgeId = e.dataTransfer.getData('application/nnz-knowledge-id')
    if (knowledgeId) {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)
      setDragOverChipId(null)
      setDropIndicator(null)
      const ps = useProjectStore.getState()
      const k = ps.knowledges.find((x) => x.id === knowledgeId)
      if (!k) return
      const order = getKnowledgeNodeOrder(k, ps.nodes, ps.edges, storyOrder)
      if (order.includes(id)) {
        // Already chipped here. If the Knowledge is orphan (no creation
        // anchor) AND this scene is the earliest chain position, promote
        // this scene to be the creation anchor — no upstream entries to
        // orphan. Otherwise silent no-op (existing entries upstream of
        // here would be left dangling).
        const hasOriginNode = ps.nodes.some(
          (n) => n.type === 'knowledgeOriginNode' && n.data?.knowledge_id === knowledgeId,
        )
        const hasActivate = (k.history?.existence_changes || [])
          .some((c) => c?.action === 'activate' && c?.node_id)
        const isOrphan = !hasOriginNode && !hasActivate
        const isEarliest = order[0] === id
        if (isOrphan && isEarliest) {
          ps.seedKnowledgeBirthAtScene(knowledgeId, id)
        }
        return
      }
      const seeded = ps.seedKnowledgeBirthAtScene(knowledgeId, id)
      if (!seeded) ps.addKnowledgeManualAnchor(knowledgeId, id)
      return
    }

    // Relationship drop: anchor the rel to this scene via manual_anchors so
    // the chip renders here regardless of ambient-participant-presence. The
    // store action is idempotent — no-op if a chip already renders here
    // (existing history event or prior manual_anchor at this node).
    const relationshipId = e.dataTransfer.getData('application/nnz-relationship-id')
    if (relationshipId) {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)
      setDragOverChipId(null)
      setDropIndicator(null)
      useProjectStore.getState().addManualAnchor(relationshipId, id)
      return
    }

    const entityId = e.dataTransfer.getData('application/nnz-entity-id')
    if (!entityId) return
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    setDropIndicator(null)

    // Capture insertion position from chip drag-over indicator before clearing it
    const insertBefore = dragOverChipId
    setDragOverChipId(null)

    const entity = useEntitiesStore.getState().getEntityById(entityId)
    if (!entity) return

    const allNodes = useProjectStore.getState().nodes
    const hasOrigin = allNodes.some(
      (n) => n.type === 'entityNode' && !n.data.is_modifier && n.data.entity_id === entityId
    )

    if (!hasOrigin) {
      createOriginAndWireToScene(id, entityId)
    } else {
      addEntityChipToNode(id, entityId)
    }

    // Update chip_order to place the new chip at the indicated position
    if (insertBefore) {
      requestAnimationFrame(() => {
        const nodeData = useProjectStore.getState().nodes.find((n) => n.id === id)?.data
        if (!nodeData) return
        const currentOrder = (nodeData.chip_order || []).length > 0
          ? [...nodeData.chip_order]
          : orderedChips.map((r) => r.entity_id)
        // Only proceed if the new chip was actually added
        if (!currentOrder.includes(entityId)) {
          currentOrder.push(entityId)
        }
        // Remove and reinsert at the target position
        const filtered = currentOrder.filter((eid) => eid !== entityId)
        if (insertBefore === '__end__') {
          filtered.push(entityId)
        } else {
          const idx = filtered.indexOf(insertBefore)
          if (idx !== -1) {
            filtered.splice(idx, 0, entityId)
          } else {
            filtered.push(entityId)
          }
        }
        updateNodeData(id, { chip_order: filtered })
        requestAnimationFrame(() => updateNodeInternals(id))
      })
    }
  }, [id, addEntityChipToNode, createOriginAndWireToScene, dragOverChipId, orderedChips, updateNodeData, updateNodeInternals, storyOrder])

  // Click on the node body (outside entity chips) → navigate sidebar to plot point view.
  // Skipped when a multi-selection modifier (Ctrl/Cmd) or the marquee modifier
  // (Shift) is held, because those clicks are about building a multi-selection,
  // not about opening a single node in the sidebar.
  const handleNodeBodyClick = useCallback((e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return
    setDetailPanel('scene', id)
  }, [id, setDetailPanel])

  // Toggle the right sidebar text editor for this scene's main content.
  // If the editor is already open and pointed at THIS scene, close it.
  // Otherwise (closed, or open on a different scene / surface), open it
  // anchored to this scene.
  const handleOpenEditor = useCallback((e) => {
    e.stopPropagation()
    if (rightSidebarOpen && rightSidebarNodeId === id) {
      closeRightSidebar()
    } else {
      openRightSidebar(id)
    }
  }, [id, openRightSidebar, closeRightSidebar, rightSidebarOpen, rightSidebarNodeId])

  // Spanning-chapter triangle indicator. When this scene node's bounding
  // box crosses a chapter column divider, a small upward-pointing triangle
  // rises from the top of the node on the side the center-point rule
  // assigned it to. Scoped here (inside the component body) so the span
  // computation short-circuits when there are no chapters or this is a
  // flashback node. Flashbacks have dashed borders and different
  // semantics — they don't participate in chapter ordering, so no
  // spanning cue.
  const effectiveNodeWidth = width ?? data.width ?? 220
  const spanNode = useMemo(() => ({
    position: { x: positionAbsoluteX ?? 0 },
    measured: { width: effectiveNodeWidth },
  }), [positionAbsoluteX, effectiveNodeWidth])
  // `getSpanningBoundary` returns `{ x, chapterSide, kind }` for any
  // chapter boundary the bbox straddles — internal divider, leftmost
  // (chapters[0]'s left edge into phantom-leading), or rightmost (last
  // chapter's right edge into phantom-trailing). Phantom boundaries
  // ALWAYS fire on straddle, regardless of where the center sits.
  const spanningBoundary = !data.is_flashback && chapters.length >= 1
    ? getSpanningBoundary(spanNode, chapters, chapterXOffset)
    : null
  const spanSide = spanningBoundary?.chapterSide ?? null
  // Triangle position within the bbox, expressed as a percentage from
  // the chosen side. For internal dividers we keep the established 18%
  // rule. For phantom boundaries the chapter sliver can be anywhere
  // from a thin edge to most of the bbox: centre the triangle within
  // the sliver, but cap the distance-from-the-chapter-edge at 18% so
  // the triangle never drifts further toward the centre of the bbox
  // than its normal two-chapter-spanning position. When the sliver is
  // wide it sits at the standard 18% spot; when the sliver is thin it
  // moves further out toward the chapter-side edge so it stays inside
  // the sliver.
  let spanTrianglePctFromSide = 18
  if (spanningBoundary && spanningBoundary.kind !== 'internal') {
    const bboxLeft = positionAbsoluteX ?? 0
    const w = effectiveNodeWidth
    // Compute the chapter portion's actual bounds in BBOX-LOCAL coords
    // (0 = bbox.left, w = bbox.right). Inner edge is the spanning
    // boundary itself; outer edge is the chapter's OTHER edge in flow
    // space, clamped to the bbox edge if the bbox doesn't extend that
    // far. Crucially we DON'T extend the chapter portion past the
    // chapter's far boundary — when the bbox bleeds past the chapter
    // into the next one (e.g. spans all of chapter 1 AND part of
    // chapter 2), the chapter-1 portion stops at the ch1/ch2 divider.
    // Without this clamp, the triangle's "18 % from bbox edge" math
    // anchors against the wrong edge and lands the indicator inside
    // the next chapter — which is the bug this fixes.
    const ch = chapters[spanningBoundary.chapterIdx]
    const chWidth = ch?.width || 0
    let chapterPortionInnerInBbox, chapterPortionOuterInBbox
    if (spanningBoundary.kind === 'leftmost') {
      // Chapter to the RIGHT of boundary. Outer edge in flow = boundary + chWidth.
      const chOuterFlow = spanningBoundary.x + chWidth
      chapterPortionInnerInBbox = spanningBoundary.x - bboxLeft
      chapterPortionOuterInBbox = Math.min(w, chOuterFlow - bboxLeft)
    } else {
      // kind === 'rightmost'. Chapter to the LEFT of boundary. Outer
      // edge in flow = boundary - chWidth.
      const chOuterFlow = spanningBoundary.x - chWidth
      chapterPortionInnerInBbox = spanningBoundary.x - bboxLeft
      chapterPortionOuterInBbox = Math.max(0, chOuterFlow - bboxLeft)
    }
    // Place the triangle's CENTER 18 % of bbox inside from the chapter
    // portion's OUTER edge (not the bbox edge — that's the original
    // bug). When the chapter portion is too thin to fit that, fall
    // back to the chapter portion's geometric center so the triangle
    // stays inside the sliver. The `max`/`min` selection naturally
    // picks center for thin slivers and the 18 %-from-outer rule
    // otherwise.
    const chapterPortionCenter = (chapterPortionInnerInBbox + chapterPortionOuterInBbox) / 2
    let triangleInBbox
    if (spanningBoundary.kind === 'leftmost') {
      // Outer is to the RIGHT (greater bbox coord).
      const triUnCapped = chapterPortionOuterInBbox - 0.18 * w
      triangleInBbox = Math.max(triUnCapped, chapterPortionCenter)
      // Express as % from bbox right edge for the `right: X%` CSS.
      spanTrianglePctFromSide = ((w - triangleInBbox) / w) * 100
    } else {
      // Outer is to the LEFT (smaller bbox coord).
      const triUnCapped = chapterPortionOuterInBbox + 0.18 * w
      triangleInBbox = Math.min(triUnCapped, chapterPortionCenter)
      // Express as % from bbox left edge for the `left: X%` CSS.
      spanTrianglePctFromSide = (triangleInBbox / w) * 100
    }
  }

  // POV-chapter order regression flag (Track F). The "⚠ POV Order" header
  // badge is driven by the SAME canonical alert the AlertsPanel reads — NOT a
  // re-derivation here. A previous duplicate copy of this math drifted when the
  // canonical check became multi-row-aware (it kept the single-row x-only
  // chapter resolver, so in multi-row it false-flagged scenes the panel
  // correctly did not). `usePovOrderAlert(id)` returns this node's
  // `pov_chapter_order` alert (or null), carrying the chapter titles for the
  // tooltip below, guaranteeing the badge and the panel can never disagree.
  const povOrderIssue = usePovOrderAlert(id)

  return (
    <>
      {spanSide && (
        <svg
          width={22}
          height={12}
          viewBox="0 0 22 12"
          style={{
            position: 'absolute',
            // Sit the SVG so its BOTTOM edge is flush with the node's
            // 3 px top border. Both the triangle and the border use the
            // same solid purple so they read as one continuous shape
            // rising from the border into a point above it.
            top: -9,
            // ~18 % of the node width from the chosen side, so the
            // triangle sits clearly in the left or right third without
            // touching the corner.
            ...(spanSide === 'left'
              ? { left: `${spanTrianglePctFromSide}%`, transform: 'translateX(-50%)' }
              : { right: `${spanTrianglePctFromSide}%`, transform: 'translateX(50%)' }),
            pointerEvents: 'none',
            overflow: 'visible',
          }}
        >
          <polygon
            points="0,12 11,0 22,12"
            fill="#7c3aed" /* accent-700, same solid purple as the node top border */
          />
        </svg>
      )}
      <div
        ref={nodeRef}
        data-help-region="scene-node:node"
        className="bg-zinc-800 border border-zinc-600 overflow-hidden shadow"
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        borderTopColor: isDragOver ? '#a78bfa' : '#7c3aed',
        borderTopWidth: 3,
        borderTopStyle: data.is_flashback ? 'dashed' : 'solid',
        // Phase 1.11 Track I — dashed selection outline ONLY when this
        // node is part of a multi-selection (more than one selected on
        // the canvas). Single-click selection uses the existing detail-
        // panel-active boxShadow below as its visual indicator, so the
        // dashed outline would be redundant noise there. `multiSelectActive`
        // is derived live from the store on every render so it can't lag.
        outline: isDragOver
          ? `1px dashed ${accentColor}`
          : (selected && multiSelectActive)
            ? `2px dashed ${accentColor}`
            : 'none',
        outlineOffset: (isDragOver || (selected && multiSelectActive)) ? 3 : undefined,
        boxShadow: isActiveNode ? `0 0 0 2px ${accentColor}` : undefined,
        width:  data.width  || 220,
        // While the description handle is being dragged, override
        // data.height with a live computed value so the outer node grows /
        // shrinks in lockstep with the description preview. Without this
        // the description text grows past the fixed node height and gets
        // clipped, and the cursor desyncs from the visible bottom edge.
        height: descDragHeight != null
          ? (sectionMetrics.aboveH + sectionMetrics.belowH + sectionMetrics.descOverhead + descDragHeight)
          : (data.height || undefined),
        minWidth: 220,
        minHeight: naturalMinHeight,
        borderRadius: '4px 4px 2px 4px',
        // Paint/layout containment: isolate each node as its own rendering
        // boundary so the React Flow pane transform (pan/zoom, minimap drag)
        // can composite cached node bitmaps instead of repainting every
        // visible node's rich DOM each frame — the dominant per-frame cost
        // during navigation. Deliberately NOT `size`/`strict` (that would
        // zero the element for React Flow's ResizeObserver measurement); the
        // node already clips via `overflow-hidden`, so `paint` adds no new
        // clipping of edge handles.
        contain: 'layout style paint',
      }}
      onClick={handleNodeBodyClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
        {/* Resize handle — single bottom-right grip, visible only when node is selected */}
        {selected && (
          <NodeResizeControl
            minWidth={220}
            minHeight={naturalMinHeight}
            position="bottom-right"
            onResizeStart={() => {
              // Phase 4.1g follow-up — corner resize writes the store per
              // frame; the gesture gate lets `useStoryOrder` serve its
              // cached result mid-resize (one recompute at release
              // instead of one per frame).
              useUiStore.getState().setCanvasGestureActive(true)
            }}
            onResize={(_, dims) => {
              const snapped = applyResizeSnap(dims, useProjectStore.getState().snapToGrid)
              updateNodeData(id, snapped)
            }}
            onResizeEnd={(_, dims) => {
              useUiStore.getState().setCanvasGestureActive(false)
              const snapped = applyResizeSnap(dims, useProjectStore.getState().snapToGrid)
              updateNodeData(id, snapped)
            }}
            style={{ width: 14, height: 14, background: 'transparent', border: 'none', left: 'auto', top: 'auto', right: 1, bottom: 1, translate: 'none' }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" style={{ display: 'block', margin: '2px', pointerEvents: 'none' }}>
              <line x1="0" y1="10" x2="10" y2="0" stroke="#52525b" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="4" y1="10" x2="10" y2="4" stroke="#52525b" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="8" y1="10" x2="10" y2="8" stroke="#52525b" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </NodeResizeControl>
        )}

        {/* Incoming-connection target handle — anchored near the top of the left edge */}
        <PortHandle nodeId={id} nodeType="sceneNode" type="target" position={Position.Left} style={GENERIC_IN_HANDLE_STYLE} />

        {/* ── Content wrapper ──
            Flex column that fills the outer node body. The description
            block is the sole flex-grow child; everything else sits in a
            flex-shrink-0 wrapper above or below it so node-height changes
            (corner drag, auto-grow on chip add, etc.) push surplus into
            the description and pull from it on shrink. */}
        <div ref={contentRef} className="flex flex-col flex-1 min-h-0">
          <div ref={aboveDescRef} className="flex-shrink-0">
          {/* ── Header ── */}
          {data.is_flashback ? (
            /* Flashback: two-row header — badge row, then title row */
            <div data-help-region="scene-node:header" className="px-3 pt-2 pb-1">
              <div className="flex items-center gap-2 pb-1">
                <span className="text-[9px] text-purple-400 uppercase tracking-widest font-semibold bg-purple-900/30 px-1.5 py-0.5 rounded flex-shrink-0">
                  Scene : Flashback
                </span>
                {!hasPovWire && !data.pov_entity_id && (
                  <span className="text-[8px] text-zinc-500 uppercase tracking-wide bg-zinc-800/60 border border-zinc-700 px-1 py-0.5 rounded flex-shrink-0" title="No POV wire connected to this scene">
                    No POV
                  </span>
                )}
                <div className="flex-1" />
                <button
                  className={`nodrag flex-shrink-0 text-xs leading-none transition-opacity ${
                    hovered ? 'text-zinc-500 hover:text-accent-400 opacity-100' : 'opacity-0 pointer-events-none'
                  }`}
                  onClick={handleOpenEditor}
                  title="Open in text editor"
                >✎</button>
                <AttachToChatButton
                  kind="scene"
                  id={id}
                  size={12}
                  title="Add this scene as context to the open conversation"
                  stopPropagation
                  className={`nodrag flex-shrink-0 ${hovered ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                />
                <button
                  className={`nodrag flex-shrink-0 text-sm leading-none transition-opacity ${
                    hovered ? 'text-zinc-600 hover:text-red-400 opacity-100' : 'opacity-0 pointer-events-none'
                  }`}
                  onClick={() => deleteNode(id)}
                  title="Delete node"
                >×</button>
              </div>
              <SceneTitleInput
                id={id}
                title={data.title}
                updateNodeData={updateNodeData}
                className="nodrag w-full bg-transparent text-sm text-zinc-100 font-medium placeholder-zinc-600 focus:outline-none"
              />
            </div>
          ) : (
            /* Normal scene: two-row header — badges + marker + buttons
               on row 1, title input on its own row 2 below. The title
               was getting compressed when the C marker was added inline
               with badges + buttons; giving it its own row gives it
               full width regardless of how many badges show. */
            <div data-help-region="scene-node:header" className="px-3 pt-2 pb-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-purple-400 uppercase tracking-widest font-semibold bg-purple-900/30 px-1.5 py-0.5 rounded flex-shrink-0">
                Scene
              </span>
              {!hasPovWire && !data.pov_entity_id && (
                <span className="text-[8px] text-zinc-500 uppercase tracking-wide bg-zinc-800/60 border border-zinc-700 px-1 py-0.5 rounded flex-shrink-0" title="No POV wire connected to this scene">
                  No POV
                </span>
              )}
              {povOrderIssue && (
                <span
                  className="text-[8px] text-amber-400 uppercase tracking-wide bg-amber-900/30 border border-amber-700/60 px-1 py-0.5 rounded flex-shrink-0"
                  title={`POV order regression: in ${povOrderIssue.currentChapterTitle}, previous POV scene was in ${povOrderIssue.previousChapterTitle}`}
                >
                  ⚠ POV Order
                </span>
              )}
              {/* Spacer pushes circumstance marker + buttons to the right */}
              <span className="flex-1" />
              {/* Phase 2.7a — Attach-to-chat button sits BEFORE the
                  circumstances marker so the marker's position relative
                  to the delete X stays fixed regardless of whether the
                  chat panel is open. When the chat panel is closed the
                  button returns null and the row has [circumstances]
                  [Delete X]; when open it slots in to the LEFT of the
                  marker, only its own width gets added. The order is
                  the inverse of the obvious "decorations on the right,
                  attach near the delete" intuition, deliberately. */}
              <AttachToChatButton
                kind="scene"
                id={id}
                size={12}
                title="Add this scene as context to the open conversation"
                stopPropagation
                className={`nodrag flex-shrink-0 ${hovered ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
              />
              {/* Phase 1.22f part 2 — Compact circumstance marker for the
                  scene as a whole. Aggregates scene-level circumstances
                  (Scene.circumstances — the parallel data type that
                  lives directly on the SceneNode; this scene IS its
                  origin, baseline-direct read is chain-aware) PLUS each
                  present entity's chain-resolved circumstance attributes
                  at this scene anchor (via
                  `computeSceneEffectiveCircumstancePool` → walker per
                  entity). Motivators are entity-only and intentionally
                  excluded — they don't apply at the scene level.
                  Renders only when at least one circumstance is active.
                  Hover popover shows two sections: scene-level + per-
                  entity rollup. Click navigates to Scene Detail Panel
                  Circumstances sub-tab. */}
              {(() => {
                // Phase 4.1g #2 — consumes the memoized `sceneCircInfo`
                // (chain walks gated on `presentChainHash`) instead of
                // recomputing the pool inline on every render.
                const { sceneCircs, perEntity, total } = sceneCircInfo
                if (total === 0) return null
                const popoverContent = (
                  <div className="px-2 py-1.5 space-y-2 min-w-[240px]">
                    <div className="text-[9px] uppercase tracking-wider text-zinc-500">
                      {data.title?.trim() || 'Scene'}
                    </div>
                    {sceneCircs.length > 0 && (
                      <div className="space-y-1">
                        <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-zinc-400">
                          <CircumstanceTypeBadge size={11} />
                          <span>At the scene level</span>
                        </div>
                        <div className="space-y-1">
                          {sceneCircs.map((c) => (
                            <CircumstanceMotivatorSubChip
                              key={c.id}
                              attributeType="circumstance"
                              name={c.name || ''}
                              description={c.description || ''}
                              intensity={c.intensity ?? null}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                    {perEntity.map((bucketEntry) => {
                      // Name + colour pre-resolved chain-aware at this
                      // scene anchor inside the `sceneCircInfo` memo.
                      return (
                        <div key={bucketEntry.entityId} className="space-y-1">
                          <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-zinc-400">
                            <span style={{ color: bucketEntry.dispColour }}>{bucketEntry.dispName || '(unnamed)'}</span>
                          </div>
                          <div className="space-y-1">
                            {bucketEntry.circumstances.map((a) => (
                              <CircumstanceMotivatorSubChip
                                key={a.id}
                                attributeType="circumstance"
                                name={a.name || ''}
                                description={a.description || ''}
                                intensity={a.intensity ?? null}
                              />
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
                return (
                  <HoverPopover
                    content={popoverContent}
                    placement="below"
                    maxWidth={320}
                    onTriggerClick={() => {
                      setDetailPanelActiveSubTab('circumstances')
                      setDetailPanel('scene', id)
                    }}
                  >
                    <span
                      className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-zinc-800/80 hover:bg-zinc-800 nodrag flex-shrink-0"
                      style={{ border: `1px solid ${accentColor}` }}
                      title="Active circumstances at this scene — click to open"
                    >
                      <CircumstanceTypeBadge size={11} />
                      <span className="text-[9px] text-zinc-300 font-semibold">{total}</span>
                    </span>
                  </HoverPopover>
                )
              })()}
              <button
                className={`nodrag flex-shrink-0 text-sm leading-none transition-opacity ${
                  hovered ? 'text-zinc-600 hover:text-red-400 opacity-100' : 'opacity-0 pointer-events-none'
                }`}
                onClick={() => deleteNode(id)}
                title="Delete node"
              >
                ×
              </button>
            </div>
            {/* Row 2: title on its own row so the marker / badges row
                above can grow without compressing it. The Open-Editor
                ✎ button is positioned absolutely over the row's right
                edge so the title's flow-width is unaffected by it
                (title still wraps / truncates as if the button isn't
                there). Button stays hover-only. */}
            <div className="relative mt-1">
              <SceneTitleInput
                id={id}
                title={data.title}
                updateNodeData={updateNodeData}
                className="nodrag w-full bg-transparent text-sm text-zinc-100 font-medium placeholder-zinc-600 focus:outline-none"
              />
              <button
                className={`nodrag absolute right-0 top-1/2 -translate-y-1/2 text-xs leading-none transition-opacity ${
                  hovered ? 'text-zinc-500 hover:text-accent-400 opacity-100' : 'opacity-0 pointer-events-none'
                }`}
                onClick={handleOpenEditor}
                title="Open in text editor"
              >
                ✎
              </button>
            </div>
            </div>
          )}

          {/* Flashback parent subtitle */}
          {data.is_flashback && (
            <div className="px-3 pb-1 -mt-1">
              {data.parent_scene_id ? (
                <span className="text-[9px] text-zinc-500 italic">
                  Flashback of {(() => {
                    const parent = useProjectStore.getState().nodes.find((n) => n.id === data.parent_scene_id)
                    return parent?.data?.title || 'Untitled Scene'
                  })()}
                </span>
              ) : (
                <span className="text-[9px] text-amber-500">⚠ No parent scene. Wire a scene's output into this node.</span>
              )}
            </div>
          )}

          {/* Broadcast output handle — hidden for flashback scenes (no entity output) */}
          {!data.is_flashback && (
            <PortHandle
              nodeId={id}
              nodeType="sceneNode"
              type="source"
              position={Position.Right}
              id="broadcast"
              style={BROADCAST_HANDLE_STYLE}
            />
          )}

          {/* ── Orphaned POV badge (no character to attach to, or disconnected with no character) ── */}
          {(hasPovWire || povNoPathToStart) && (!data.pov_entity_id || !orderedChips.some((r) => r.entity_id === data.pov_entity_id)) && (
            <div className="px-2 pt-1 border-t border-zinc-700/60">
              <div
                className="relative flex items-center pl-2 pr-6 py-0.5 group/pov nodrag"
                style={{
                  border: `2px solid ${povColor}`,
                  borderRadius: 4,
                  backgroundColor: '#27272a',
                  opacity: povDragging ? 0.4 : 1,
                }}
              >
                {/* Drag grip indicator */}
                <span
                  className="absolute opacity-0 group-hover/pov:opacity-100 transition-opacity z-10 cursor-grab active:cursor-grabbing"
                  draggable
                  onDragStart={handlePovDragStart}
                  onDragEnd={handlePovDragEnd}
                  onClick={(e) => e.stopPropagation()}
                  title="Drag to attach POV to a character"
                  style={{ fontSize: 10, lineHeight: 1, left: 2, top: '50%', transform: 'translateY(-50%)', color: povColor }}
                >⠿</span>
                <span
                  className="flex items-center justify-center rounded-sm text-[9px] font-bold flex-shrink-0 cursor-grab active:cursor-grabbing"
                  draggable
                  onDragStart={handlePovDragStart}
                  onDragEnd={handlePovDragEnd}
                  title="Drag to attach POV to a character"
                  style={{ width: 32, height: 16, color: povColor, backgroundColor: povDerived.bg, border: `1px solid ${povDerived.borderSubtle}`, borderRadius: 3 }}
                >POV</span>
                {povChainIndex != null && (
                  <span className="text-[9px] font-bold ml-1 flex-shrink-0" style={{ color: povColor }}>{povChainIndex}</span>
                )}
                <span className="text-[8px] ml-1.5 flex flex-col" style={{ color: povColor }}>
                  {!NON_CHARACTER_POV_TYPES.has(storyPovType) && (
                    <span title="No character to attach to">⚠ No character</span>
                  )}
                  {povNoPathToStart && <span title="No path to POV start node">⚠ No path to start</span>}
                </span>
                <button
                  className="absolute right-1.5 text-zinc-500 hover:text-red-400 text-[12px] font-bold nodrag leading-none"
                  onClick={handleRemovePov}
                  title="Remove POV from this scene"
                >−</button>
                <PortHandle nodeId={id} nodeType="sceneNode" type="target" position={Position.Left} id="pov-in"
                  style={povHandleStyles.in}
                />
                <PortHandle nodeId={id} nodeType="sceneNode" type="source" position={Position.Right} id="pov-out"
                  style={povHandleStyles.out}
                />
              </div>
            </div>
          )}

          </div>{/* end aboveDescRef wrapper */}

          {/* ── Description (read-only, between header and entity chips) ──
              Hidden when empty. Surfaces the scene's description text on
              the canvas so the user doesn't have to open the Detail
              Panel to read it. The inner text div uses an explicit
              computed height so it absorbs surplus when the node is
              dragged taller and shrinks (down to DESC_TEXT_FLOOR) when
              the node is dragged shorter — coordinating with the
              bottom-right node resize. */}
          {hasDescription && (
            <div
              ref={descBlockRef}
              data-help-region="scene-node:description"
              className="px-2 pb-1 pt-1 border-t border-zinc-700/60"
              style={{ position: 'relative' }}
            >
              <div
                className="rounded overflow-hidden flex flex-col"
                style={{ border: '1px solid #52525b' }}
              >
                <div
                  className="text-[8px] text-zinc-500 uppercase tracking-wider select-none flex-shrink-0"
                  style={{ padding: '1px 6px', borderBottom: '1px solid #52525b44' }}
                >
                  Description
                </div>
                <div
                  ref={descTextRef}
                  className="text-[9px] text-zinc-400 break-words px-1.5 py-1 overflow-y-auto nowheel"
                  style={{
                    height: descRenderedHeight,
                    minHeight: DESC_TEXT_FLOOR,
                  }}
                >
                  {data.description}
                </div>
              </div>
              {/* Bottom-edge resize handle — sits absolutely overlaid on the
                  wrapper's bottom border so selecting the node doesn't grow
                  layout height, and the grip's visual centre lines up with
                  the boundary between the description box and the section
                  below. Drag to expand; drag back at or below the default
                  cap clears the override. Double-click toggles between
                  auto-minimum and fully-expanded. Visible only when the
                  scene is selected (matches the bottom-right node resize
                  grip). */}
              {selected && (
                <DescResizeGrip
                  onMouseDown={handleDescResizeStart}
                  onDoubleClick={handleDescResizeDoubleClick}
                  active={descDragHeight != null}
                  accentColor={accentColor}
                />
              )}
            </div>
          )}

          <div ref={belowDescRef} className="flex-shrink-0">
          {/* ── Sections below description (time row, entity / relationship /
              knowledge chips) ── */}

          {/* ── Scene time row (Phase 1.23 step 11) ──
              Compact summary chip + always-on access affordance,
              gated on the per-story Time Tracking master toggle.
              Click opens the Time Modal scoped to this scene. */}
          <SceneTimeRow sceneId={id} sceneData={data} />

          {/* ── Entity chips ── */}
          {hasChips && (
            <div data-help-region="scene-node:entities" className="px-2 pb-2 pt-1 border-t border-zinc-700/60 space-y-0.5">
              <div className="text-[9px] uppercase tracking-widest text-green-400/70 px-0.5 pb-0.5 select-none">
                Entities
              </div>
              {orderedChips.map((ref) => {
                const chipHasPov = (hasPovWire || povNoPathToStart) && data.pov_entity_id === ref.entity_id
                return (
                <div key={ref.entity_id}>
                  {chipHasPov ? (
                    /* ── POV wrapper: single container border around badge + entity chip ── */
                    <div
                      className="relative group/povchip"
                      style={{
                        borderTop: dragOverChipId === ref.entity_id ? `2px solid ${accentColor}` : `2px solid ${povColor}`,
                        borderRight: `2px solid ${povColor}`,
                        borderBottom: `2px solid ${povColor}`,
                        borderLeft: 'none',
                        borderRadius: '0 4px 4px 0',
                        overflow: 'visible',
                        opacity: povDragging ? 0.4 : 1,
                      }}
                    >
                      {/* POV badge — top section of the wrapper */}
                      <div
                        data-help-region="pov-chip:badge"
                        className="relative flex items-center pl-2 pr-4 py-0.5 group/pov nodrag"
                        onDragOver={(e) => handleChipDragOver(ref.entity_id, e)}
                        onDrop={(e) => handleChipDrop(ref.entity_id, e)}
                        style={{
                          backgroundColor: '#27272a',
                          borderLeft: `3px solid ${povColor}`,
                          borderRadius: '0 2px 0 0',
                        }}
                      >
                        {/* Drag grip indicator */}
                        <span
                          className="absolute opacity-0 group-hover/pov:opacity-100 transition-opacity z-10 cursor-grab active:cursor-grabbing"
                          draggable
                          onDragStart={handlePovDragStart}
                          onDragEnd={handlePovDragEnd}
                          onClick={(e) => e.stopPropagation()}
                          title="Drag to reassign POV to a different character"
                          style={{ fontSize: 10, lineHeight: 1, left: 2, top: '50%', transform: 'translateY(-50%)', color: povColor }}
                        >⠿</span>
                        {/* Badge label — also draggable */}
                        <span
                          className="flex items-center justify-center rounded-sm text-[9px] font-bold flex-shrink-0 cursor-grab active:cursor-grabbing"
                          draggable
                          onDragStart={handlePovDragStart}
                          onDragEnd={handlePovDragEnd}
                          title="Drag to reassign POV to a different character"
                          style={{
                            width: 32, height: 16,
                            color: povColor,
                            backgroundColor: povDerived.bg,
                            border: `1px solid ${povDerived.borderSubtle}`,
                            borderRadius: 3,
                          }}
                        >POV</span>
                        {povChainIndex != null && (
                          <span className="text-[9px] font-bold ml-1 flex-shrink-0" style={{ color: povColor }}>{povChainIndex}</span>
                        )}
                        {povNoPathToStart && (
                          <span className="text-[8px] ml-1.5" style={{ color: povColor }} title="No path to POV start node">⚠ No path to start</span>
                        )}
                        {/* POV input port */}
                        <PortHandle
                          nodeId={id}
                          nodeType="sceneNode"
                          type="target"
                          position={Position.Left}
                          id="pov-in"
                          style={povHandleStyles.flashbackIn}
                        />
                        {/* POV output port */}
                        <PortHandle
                          nodeId={id}
                          nodeType="sceneNode"
                          type="source"
                          position={Position.Right}
                          id="pov-out"
                          style={povHandleStyles.out}
                        />
                      </div>
                      {/* Entity chip — inside the wrapper, no POV borders of its own */}
                      <EntityChip
                        nodeId={id}
                        entityRef={ref}
                        onDragStart={handleChipDragStart}
                        onDragOver={handleChipDragOver}
                        onDrop={handleChipDrop}
                        onDragEnd={handleChipDragEnd}
                        isDragOver={false}
                        isDragging={draggedChipId === ref.entity_id}
                        hasPov={false}
                        insidePovWrapper={true}
                        isFlashback={!!data.is_flashback}
                        povColor={povColor}
                        accentColor={accentColor}
                        isPovDragTarget={povDragOverEntityId === ref.entity_id}
                        onPovDragOver={handlePovDragOverChip}
                        onPovDrop={handlePovDropOnChip}
                      />
                      {/* Eject + Remove buttons — positioned at top-right of the whole POV chip */}
                      <span className="absolute top-0.5 right-1.5 flex items-center gap-1 nodrag z-10">
                        <button
                          className="text-zinc-600 hover:text-amber-400 text-[10px] opacity-0 group-hover/povchip:opacity-100 transition-opacity"
                          onClick={handleEjectPov}
                          title="Detach POV from this character"
                        >⏏</button>
                        <button
                          className="text-zinc-500 hover:text-red-400 text-[10px]"
                          onClick={handleRemovePov}
                          title="Remove POV from this scene"
                        >✕</button>
                      </span>
                    </div>
                  ) : (
                    /* ── Normal entity chip (no POV) ── */
                    <EntityChip
                      nodeId={id}
                      entityRef={ref}
                      onDragStart={handleChipDragStart}
                      onDragOver={handleChipDragOver}
                      onDrop={handleChipDrop}
                      onDragEnd={handleChipDragEnd}
                      isDragOver={dragOverChipId === ref.entity_id}
                      isDragging={draggedChipId === ref.entity_id}
                      hasPov={false}
                      isFlashback={!!data.is_flashback}
                      povColor={povColor}
                      accentColor={accentColor}
                      isPovDragTarget={povDragOverEntityId === ref.entity_id}
                      onPovDragOver={handlePovDragOverChip}
                      onPovDrop={handlePovDropOnChip}
                    />
                  )}
                </div>
                )
              })}
              {/* Trailing drop zone — allows dragging a chip to the very end */}
              <div
                className="h-3"
                style={{ borderTop: dragOverChipId === '__end__' ? `2px solid ${accentColor}` : '2px solid transparent' }}
                onDragOver={(e) => handleChipDragOver('__end__', e)}
                onDrop={(e) => handleChipDrop('__end__', e)}
              />
            </div>
          )}

          {/* ── Relationship chips ── (also rendered when dragging a
              relationship onto an empty section so the indicator slot
              has somewhere to land) */}
          {(relChipsAtScene.length > 0 || dropIndicator?.kind === 'relationship') && (
            <div data-help-region="scene-node:relationships" className="px-2 pb-2 pt-1 border-t border-zinc-700/60 space-y-0.5">
              <div className="text-[9px] uppercase tracking-widest text-violet-400/70 px-0.5 pb-0.5 select-none">
                Relationships
              </div>
              {relChipsAtScene.map((rel, i) => (
                <Fragment key={rel.id}>
                  {dropIndicator?.kind === 'relationship' && dropIndicator.slot === i && (
                    <div style={{ height: 0, borderTop: `2px solid ${accentColor}` }} />
                  )}
                  <div
                    ref={(el) => {
                      if (el) relChipRefsRef.current.set(rel.id, el)
                      else relChipRefsRef.current.delete(rel.id)
                    }}
                  >
                    <RelationshipChip nodeId={id} relationship={rel} />
                  </div>
                </Fragment>
              ))}
              {dropIndicator?.kind === 'relationship'
                && dropIndicator.slot === relChipsAtScene.length && (
                <div style={{ height: 0, borderTop: `2px solid ${accentColor}` }} />
              )}
            </div>
          )}

          {/* ── Knowledge chips (Phase 1.21c) ── auto-spawns for any
              Knowledge whose chain (history + manual anchors) lands on
              this scene. Sibling section to entity / relationship chips. */}
          {(knowledgeChipsAtScene.length > 0 || dropIndicator?.kind === 'knowledge') && (
            <div data-help-region="scene-node:knowledge" className="px-2 pb-2 pt-1 border-t border-zinc-700/60 space-y-0.5">
              <div
                className="text-[9px] uppercase tracking-widest px-0.5 pb-0.5 select-none"
                style={{ color: `${KNOWLEDGE_COLOUR}b3` }}
              >
                Knowledge
              </div>
              {knowledgeChipsAtScene.map((k, i) => (
                <Fragment key={k.id}>
                  {dropIndicator?.kind === 'knowledge' && dropIndicator.slot === i && (
                    <div style={{ height: 0, borderTop: `2px solid ${accentColor}` }} />
                  )}
                  <div
                    ref={(el) => {
                      if (el) knowledgeChipRefsRef.current.set(k.id, el)
                      else knowledgeChipRefsRef.current.delete(k.id)
                    }}
                  >
                    <KnowledgeChip nodeId={id} knowledge={k} />
                  </div>
                </Fragment>
              ))}
              {dropIndicator?.kind === 'knowledge'
                && dropIndicator.slot === knowledgeChipsAtScene.length && (
                <div style={{ height: 0, borderTop: `2px solid ${accentColor}` }} />
              )}
            </div>
          )}

          {/* Drop hint when dragging over (no chips yet) */}
          {isDragOver && !hasChips && (
            <div className="px-2 pb-2 pt-1 border-t border-zinc-700/60">
              <div className="text-xs text-purple-400 text-center py-1">Drop to add entity</div>
            </div>
          )}
          </div>{/* end belowDescRef wrapper */}
        </div>{/* end contentRef */}

    </div>
    </>
  )
}

// Memoised: React Flow's node renderer re-renders on every viewport change
// (it recomputes the visible set for `onlyRenderVisibleElements`). Without
// `memo`, this heavy node re-rendered on every pan/zoom frame even though its
// props were unchanged — the dominant per-frame cost during panning and
// minimap-rectangle drags. Shallow prop comparison skips the re-render when
// (id, data, selected, positionAbsoluteX, width, …) are unchanged; genuine
// updates still flow through (new `data` ref on edit) and the component's own
// store-hook subscriptions re-render it independently, so nothing goes stale.
export default memo(SceneNode)
