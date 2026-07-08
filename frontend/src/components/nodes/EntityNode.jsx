import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Position, NodeResizeControl, useStore } from '@xyflow/react'
import DescResizeGrip from '../ui/DescResizeGrip'
import PortHandle from '../canvas/PortHandle'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProjectStore } from '../../store/projectStore'
import { useUiStore } from '../../store/uiStore'
import { confirm } from '../../store/dialogStore'
import { buildSourceEventFromEntityRefChip, buildSourceEventFromOriginAttribute, buildSuggestedKnowledgeName } from '../../utils/sourceEventBuilder'
import { getMeasuredHeight } from '../../utils/measuredDimensionsStore'
import { usePreviewStore } from '../../store/previewStore'
import { useAccentColor } from '../../utils/povConstants'
import { useMultiSelectActive } from '../../hooks/useMultiSelectActive'
import { computeEffectiveState, computeEffectiveStateWithPrior, computeChangeSubChips, findPartnerChainNodeAtOrBefore, getAwarenessChangesForObserverAtNode, getKnowledgeNodeOrder } from '../../utils/narrativeChain'
import { useEntityById } from '../../hooks/useEntityById'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import RelationshipSubChip from '../ui/change-subchips/RelationshipSubChip'
import RelationshipChip from './RelationshipChip'
import KnowledgeChip from './KnowledgeChip'
import ChangeSubChip from '../ui/change-subchips/ChangeSubChip'
import CircumstanceMotivatorSubChip from '../ui/change-subchips/CircumstanceMotivatorSubChip'
import PerspectiveSubChip from '../ui/change-subchips/PerspectiveSubChip'
import HoverPopover from '../ui/HoverPopover'
import { CircumstanceTypeBadge, MotivatorTypeBadge } from '../ui/TypeBadges'
import AwarenessSubChip from '../ui/change-subchips/AwarenessSubChip'
import ImageHoverPreview from '../ui/ImageHoverPreview'
import { KNOWLEDGE_COLOUR } from '../ui/IdentityBadges'

import { TYPE_ICONS } from '../../utils/entityHelpers'
import RelationshipHistoryChangeChip from '../ui/change-subchips/RelationshipHistoryChangeChip'
import { applyResizeSnap } from '../../utils/snapUtils'
import { usePovChain } from '../../utils/povSequence'
import { OvumRedAvatar, isOvumRedEntity, setOvumRedSessionDisabled, getOvumRedAttributeStyle } from '../../effects/quarterlyForecasts'
import { useProfileImageDropTarget } from '../../hooks/useProfileImageDropTarget'
import AttachToChatButton from '../chat/AttachToChatButton'

// Accent colour is now user-configurable via useAccentColor() hook

// Phase 4.1g #3 — stable handle-style identity: the four PortHandle
// call sites in this file share one static style; an inline literal
// per render registered as a handle props change on every node
// render. See SceneNode.jsx for the colour-dependent variants.
const ENTITY_HANDLE_STYLE = Object.freeze({ top: 16, transform: 'none' })

export default function EntityNode({ id, data, selected }) {
  const accentColor = useAccentColor()
  const multiSelectActive = useMultiSelectActive()
  const povChain = usePovChain()
  const entity = useEntityById(data.entity_id)
  const customCategories  = useEntitiesStore((s) => s.customCategories)
  // Individual bucket subscriptions — stable refs, combined in useMemo to avoid infinite re-renders
  const allCharacters     = useEntitiesStore((s) => s.characters)
  const allLocations      = useEntitiesStore((s) => s.locations)
  const allItems          = useEntitiesStore((s) => s.items)
  const allFactions       = useEntitiesStore((s) => s.factions)
  const allCustoms        = useEntitiesStore((s) => s.customs)
  const deleteNode              = useProjectStore((s) => s.deleteNode)
  const updateNodeData          = useProjectStore((s) => s.updateNodeData)
  const clearProfileImageChange = useProjectStore((s) => s.clearProfileImageChange)
  const clearEntityRefChange    = useProjectStore((s) => s.clearEntityRefChange)
  const removeBaselineAttribute = useProjectStore((s) => s.removeBaselineAttribute)
  const countEntityChips        = useProjectStore((s) => s.countEntityChips)
  const nodes             = useProjectStore((s) => s.nodes)
  const edges             = useProjectStore((s) => s.edges)
  const allRelationships     = useProjectStore((s) => s.relationships)
  const relationshipsByScene = useProjectStore((s) => s.relationshipsByScene)
  // Phase 1.21c Tier 4 — Knowledges for the awareness sub-chip section.
  const allKnowledgesPS      = useProjectStore((s) => s.knowledges)
  const isActiveNode      = useUiStore((s) => s.detailPanelNodeId === id)
  const setDetailPanel    = useUiStore((s) => s.setDetailPanel)
  const openDeleteEntityDialog = useUiStore((s) => s.openDeleteEntityDialog)
  const openRelationshipDetail = useUiStore((s) => s.openRelationshipDetail)
  const togglePreview     = usePreviewStore((s) => s.togglePreview)
  const [hovered, setHovered] = useState(false)

  // Phase 2.5g — accept drag-and-dropped image data onto the entity's
  // avatar. The drop target's anchor is this node's id; the store
  // action `setEntityProfileImageAtAnchor` routes the write to the
  // chain-aware path automatically (baseline write when this is the
  // entity's origin EntityNode, chain entry when it's a modifier).
  const avatarDrop = useProfileImageDropTarget({
    kind: 'entity',
    id: data.entity_id,
    anchorNodeId: id,
  })

  const allEntities = useMemo(
    () => [...allCharacters, ...allLocations, ...allItems, ...allFactions, ...allCustoms],
    [allCharacters, allLocations, allItems, allFactions, allCustoms]
  )

  const storyOrder = useStoryOrder()

  // Minimum height: measured from headerRef (badge row, header, sub-chips, relationships)
  // plus a description base height. Description is outside headerRef so it can
  // flex-grow into available space when the user resizes the node taller.
  //
  // Default base description height = min(natural text height, ~3 lines) + label
  // + wrapper padding, so short descriptions don't waste space and long ones
  // scroll at minimum node height. When the writer has dragged the description
  // bottom-edge handle to set `data.description_height`, that value is used as
  // the description's preferred size instead of the 3-line cap, and the node
  // grows to fit it.
  const DEFAULT_DESC_TEXT_HEIGHT = 36  // ~3 lines at 9px font + padding
  const DESC_TEXT_FLOOR     = 24  // absolute floor for live drag-shrink
  const DESC_LABEL_HEIGHT   = 16  // "Description" header + border
  const DESC_WRAPPER_PAD    = 12  // px-2 + pb-2 wrapper padding
  const headerRef = useRef(null)
  const descTextRef = useRef(null)
  const descBlockRef = useRef(null)  // outer description container (px-2 pb-2 wrapper)
  // Seed the initial min-height from the REMEMBERED measurement (the side
  // measured-dimensions store, which survives React Flow culling) rather than a
  // flat 60. When a tall auto-height card (data.height == null) is culled and
  // then re-approached, React Flow re-mounts it; if it renders at a collapsed 60
  // first, that 60 gets written back as its measured height and — being a tiny
  // box — culling removes it again before the post-mount ResizeObserver can grow
  // it, so it stays invisible until its 60px top edge is panned into view. Seeding
  // from the remembered height makes the re-mounted card open at its true size, so
  // it's never wrongly culled. On a genuinely first-ever render (nothing
  // remembered yet) this falls back to 60, matching the old behaviour. The
  // post-mount ResizeObserver still corrects the value to the real content height.
  const rememberedMinHeight = getMeasuredHeight(id) ?? 60
  const [naturalMinHeight, setNaturalMinHeight] = useState(rememberedMinHeight)
  const naturalMinHeightRef = useRef(rememberedMinHeight)
  // Description-handle drag state. Mirrors the SceneNode pattern: live drag
  // preview in descDragHeight, committed values in data.description_height.
  const [descDragHeight, setDescDragHeight] = useState(null)
  const descDragStateRef = useRef(null)
  // React Flow zoom for cursor-delta scaling during description drag (canvas
  // is rendered inside a CSS scale transform).
  const reactFlowZoom = useStore((s) => s.transform?.[2] ?? 1)
  const zoomRef = useRef(1)
  zoomRef.current = reactFlowZoom

  // Two-tier minimum height (mirrors SceneNode):
  //   naturalMinHeight = absolute floor — drives the outer node minHeight and
  //     NodeResizeControl minHeight, so the user can corner-shrink down to a
  //     squeezed-description state regardless of description_height.
  //   preferredMinHeight (computed below as a memo) = floor + (description_height
  //     - DESC_TEXT_FLOOR), the size the node should auto-grow to when the
  //     writer expands the description via the handle.
  const recomputeMinHeight = useCallback(() => {
    const el = headerRef.current
    if (!el) return
    // Floor uses a constant DESC_TEXT_FLOOR for the text portion regardless
    // of actual content size. An earlier pass shrank the floor below
    // DESC_TEXT_FLOOR for short descriptions to save a few pixels of empty
    // space, but that made the floor track descTextRef.scrollHeight — which
    // depends on whether the text element's overflow-y scrollbar is visible.
    // The scrollbar's presence affected the content width and thus line wrap,
    // which fed back into scrollHeight, which fed back into the floor —
    // producing a multi-pixel oscillation on short descriptions. Matching
    // SceneNode's stable-floor pattern eliminates the loop.
    const descExtra = descTextRef.current
      ? DESC_TEXT_FLOOR + DESC_LABEL_HEIGHT + DESC_WRAPPER_PAD
      : 0
    const h = el.scrollHeight + descExtra
    naturalMinHeightRef.current = h
    setNaturalMinHeight(h)
  }, [])

  // Preferred minimum: what data.height should be when the description is
  // rendered at its preferred (user-set or default-capped) size. Drives
  // auto-grow on description-handle drag and auto-shrink when the writer
  // explicitly reduces description_height.
  const preferredMinHeight = useMemo(() => {
    const el = headerRef.current
    const descEl = descTextRef.current
    if (!el || !descEl) return naturalMinHeight
    const userPref = data.description_height
    const naturalTextHeight = descEl.scrollHeight
    const targetTextH = userPref != null
      ? userPref
      : Math.min(naturalTextHeight, DEFAULT_DESC_TEXT_HEIGHT)
    return el.scrollHeight + targetTextH + DESC_LABEL_HEIGHT + DESC_WRAPPER_PAD
   
  }, [data.description_height, naturalMinHeight])

  // hasAnyDescription: whether description will be rendered (used only to re-subscribe
  // the ResizeObserver when the description DOM element appears/disappears).
  // Uses raw data sources available at this point — the exact computed `description`
  // value is derived later, but we only need truthiness here.
  const hasAnyDescription = !!(data.description_change ?? entity?.description ?? '')
  // `blankToFull` lets the effect re-run when a modifier transitions from
  // the placeholder render (no headerRef, ref bail) to the full body. Without
  // it, the observer would be set up exactly once during the placeholder
  // phase (where `headerRef.current` is null → early return), never get a
  // chance to attach to the real header element after the entity is wired
  // in, and naturalMinHeight would stay stuck at its useState initial value
  // — leaving the modifier rendered too short to fit the profile image and
  // name when the writer first attaches an entity with no description.
  const blankToFull = data.is_modifier === true && !!data.entity_id
  useEffect(() => {
    const el = headerRef.current
    const descEl = descTextRef.current
    if (!el) return
    const obs = new ResizeObserver(recomputeMinHeight)
    obs.observe(el)
    if (descEl) obs.observe(descEl)
    return () => obs.disconnect()
   
  }, [recomputeMinHeight, hasAnyDescription, blankToFull])

  // Clear description_height when the description text is deleted. Without
  // this, a writer who set description_height (via the resize handle or
  // double-click), then deleted the description, then re-added a long
  // description would see the node jump back to the old preferred size
  // — the saved description_height was acting as a stale preference.
  // Clearing on delete means re-adding falls back to the natural 3-line
  // capped minimum, matching first-time-add behaviour.
  useEffect(() => {
    if (!hasAnyDescription && data.description_height != null) {
      updateNodeData(id, { description_height: null })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAnyDescription])

  // Sync stored node height when preferredMinHeight changes (chip add /
  // remove, description_height adjusted via the description-resize handle /
  // double-click). Grow when too small; shrink when the user explicitly
  // reduced description_height (preferred shrunk while data.height was
  // matched to old preferred). Mirrors the SceneNode pattern.
  const prevPreferredMinHeightRef = useRef(naturalMinHeight)
  useEffect(() => {
    const prevPref = prevPreferredMinHeightRef.current
    prevPreferredMinHeightRef.current = preferredMinHeight
    if (!data.height) return
    // `silent: true` — program-driven layout correction (not a user
    // resize). First-mount fires on every project load; without
    // silent these would flip `hasUnsavedChanges` immediately on load.
    if (data.height < preferredMinHeight) {
      updateNodeData(id, { height: preferredMinHeight }, { silent: true })
    } else if (data.height <= prevPref && preferredMinHeight < prevPref) {
      updateNodeData(id, { height: preferredMinHeight }, { silent: true })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferredMinHeight])

  // Description-handle bottom-edge drag-resize. Mirrors the SceneNode pattern:
  // start from the currently-rendered text height (so the cursor anchors to
  // the visible grip), divide cursor delta by RF zoom, commit description_height
  // + a snapped data.height in lockstep on release. Double-click toggles
  // between auto-minimum (description_height = null, natural cap) and
  // fully-expanded (description_height = full text scrollHeight).
  const handleDescResizeStart = useCallback((e) => {
    if (e.detail >= 2) return  // let onDoubleClick fire on the second click
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const renderedTextH = descTextRef.current?.offsetHeight ?? null
    const startHeight = renderedTextH ?? data.description_height ?? DEFAULT_DESC_TEXT_HEIGHT
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
          // Compute live overhead = naturalMinHeight - descRenderedTextH at
          // the moment of commit. For Entity, the overhead is just the
          // header + label + paddings (no "below" section).
          const headerH = headerRef.current?.offsetHeight ?? 0
          const fixedH = headerH + DESC_LABEL_HEIGHT + DESC_WRAPPER_PAD
          const draggedDescHeight = Math.max(DESC_TEXT_FLOOR, Math.round(current))
          const rawPreferred = fixedH + draggedDescHeight
          const snapToGrid = useProjectStore.getState().snapToGrid
          const snapped = applyResizeSnap(
            { width: data.width || 220, height: rawPreferred },
            snapToGrid,
          )
          // Adjust description_height so descRenderedHeight (= data.height -
          // fixedH) matches the saved value on reload. Clear when at default.
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
  }, [data.description_height, data.width, id, updateNodeData])

  const handleDescResizeDoubleClick = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    const overrideActive = data.description_height != null
    const headerH = headerRef.current?.offsetHeight ?? 0
    const fixedH = headerH + DESC_LABEL_HEIGHT + DESC_WRAPPER_PAD
    const snapToGrid = useProjectStore.getState().snapToGrid
    const snapH = (rawHeight) => applyResizeSnap(
      { width: data.width || 220, height: rawHeight },
      snapToGrid,
    ).height
    if (overrideActive) {
      // Reset to default. Sync data.height = preferred-with-default.
      updateNodeData(id, {
        description_height: null,
        height: snapH(fixedH + DEFAULT_DESC_TEXT_HEIGHT),
      })
    } else {
      // Expand to fit all text.
      const fullH = descTextRef.current?.scrollHeight ?? DEFAULT_DESC_TEXT_HEIGHT
      if (fullH > DEFAULT_DESC_TEXT_HEIGHT) {
        const newDescH = Math.round(fullH)
        updateNodeData(id, {
          description_height: newDescH,
          height: snapH(fixedH + newDescH),
        })
      }
    }
  }, [data.description_height, data.width, id, updateNodeData])


  // Modifier mode when explicitly created as a modifier node (data.is_modifier flag).
  // Edge-presence detection was removed — wiring entity→entity now adds a relationship
  // attribute rather than converting the target to modifier mode (v0.1.6.88).
  const hasInput = data.is_modifier === true
  // Blank modifier: created via context menu, entity_id assigned when first wired
  const isBlankModifier = hasInput && !data.entity_id

  // Phase 1.21k — Knowledge chips on entity origin nodes. Renders for
  // every Knowledge whose chain (history entries OR manual anchors)
  // includes this origin node's id. Mirrors the SceneNode pattern so a
  // Knowledge born at an entity origin via "Add knowledge of this
  // change" surfaces visibly on the originating node. Modifier entity
  // nodes do not host Knowledge chips.
  const knowledgeChipsAtNode = useMemo(() => {
    if (hasInput) return []
    const list = allKnowledgesPS || []
    if (list.length === 0) return []
    const result = []
    for (const k of list) {
      const order = getKnowledgeNodeOrder(k, nodes, edges, storyOrder)
      if (order.includes(id)) result.push(k)
    }
    return result
  }, [hasInput, allKnowledgesPS, nodes, edges, storyOrder, id])

  // For modifier nodes, compute the upstream effective state so the displayed
  // name/colour/description/image reflect inherited overrides from upstream nodes.
  // Current + prior chain-resolved state at this modifier node's
  // anchor via the unified helper (computeEffectiveStateWithPrior).
  // See narrativeChain.js for the helper's docstring: handles sub-
  // chain backward walks, unifies baseline fallback.
  const { effectiveState, priorState } = useMemo(() => {
    if (!entity || !hasInput) return { effectiveState: null, priorState: null }
    const { current, prior } = computeEffectiveStateWithPrior(entity, nodes, edges, id)
    return { effectiveState: current, priorState: prior }
  }, [entity, hasInput, nodes, edges, id])

  // Change sub-chips for attributes (non-relationship).
  // Origin nodes: +ADD chip for each attribute defined at initial state.
  // Modifier nodes: compute from the node's own override data vs prior state.
  const attrSubChips = useMemo(() => {
    if (!entity) return []
    if (!hasInput) {
      // Origin EntityNode — call computeChangeSubChips in originMode.
      // The walker iterates entity.attributes (entity baseline) and
      // emits one add chip per attribute via the shared per-attribute
      // chip-builder helper. Same per-type enrichment (media / list /
      // circumstance / motivator / number) that the mid-chain
      // action='add' branch produces. Single source of truth.
      const chips = computeChangeSubChips(null, null, entity, allEntities, { originMode: true })
      // ovum_red presentational style overlay (per-attribute, name+value
      // dependent). Applied here rather than inside the shared helper so
      // the helper stays pure.
      for (const chip of chips) {
        const attr = (entity.attributes || []).find((a) => a.id === chip.attributeId)
        if (!attr) continue
        const extraStyle = getOvumRedAttributeStyle(entity, attr.name, attr.value)
        if (extraStyle) chip.valueStyle = extraStyle
      }
      return chips
    }
    if (!priorState) return []
    // Exclude relationship chips — rendered separately as RelationshipSubChip.
    // Also exclude Description — shown inline on the node with an amber badge instead.
    return computeChangeSubChips(data, priorState, entity, allEntities)
      .filter((c) => !c.isRelationship)
  }, [hasInput, entity, priorState, data, allEntities])

  // ── Awareness sub-chips ────────────────────────────────────────────────────
  // Phase 1.21c Tier 4. Lists awareness changes where this entity is
  // the OBSERVER:
  //   - On modifier nodes (`is_modifier=true`): walks the helper for
  //     chain-time mutations whose `node_id` matches this modifier's
  //     id (Knowledge.history.awareness_changes is the main source —
  //     EntityNode itself doesn't carry awareness_changes the way
  //     EntityRef does, so the EntityRef-side branches are no-ops).
  //   - On origin nodes (`!is_modifier`): adds origin-baseline
  //     Knowledge awareness — `Knowledge.awareness[entityId]` entries
  //     — since `setKnowledgeAwarenessOrigin` writes to the dict
  //     directly rather than to history. Mirrors the chip-side render
  //     so origin-level wire-grants are immediately visible.
  const awarenessSubChips = useMemo(() => {
    if (!entity) return []
    const out = []
    // Chain-time mutations at this node (modifier-node case primarily).
    out.push(...getAwarenessChangesForObserverAtNode({
      observerEntityId: entity.id,
      nodeId: id,
      allNodes: nodes,
      allEdges: edges,
      allEntities,
      allRelationships,
      allKnowledges: allKnowledgesPS,
    }))
    // Origin-baseline Knowledge awareness — origin nodes only. Skip
    // Knowledges that use AwarenessRef (projected) — those resolve via
    // a different path covered by Phase 1.21f.
    if (!hasInput) {
      for (const k of (allKnowledgesPS || [])) {
        const dict = (k.awareness && typeof k.awareness === 'object' && !('relationship_id' in k.awareness))
          ? k.awareness
          : null
        if (!dict) continue
        const lvl = dict[entity.id]
        if (lvl === undefined) continue
        out.push({
          kind: 'knowledge',
          changeId: `baseline-${k.id}-${entity.id}`,
          knowledgeId: k.id,
          knowledge: k,
          level: lvl,
        })
      }
    }
    return out
  }, [entity, id, nodes, edges, allEntities, allKnowledgesPS, hasInput])

  // ── N-party relationship chips (new system) ──────────────────────────────────
  // Show relationships where a participant join (or other change) was recorded AT this node.
  // Works for both origin nodes (join recorded at origin) and modifier nodes (change recorded there).
  const entityNodeRelChips = useMemo(() => {
    if (!entity) return []
    const relIds = relationshipsByScene[id] || new Set()
    return allRelationships.filter((r) => relIds.has(r.id))
  }, [entity, allRelationships, relationshipsByScene, id])

  // ── Origin-level relationship "+ Joined" minimal chips (Phase D / Q8) ────────
  // On an entity's ORIGIN node, render a minimal `+ Joined : <rel>` chip for
  // every relationship where this entity has a join event anchored at a
  // `relationshipOriginNode`. Full participant data lives on the relationship
  // origin node itself; here we only surface the "this entity is in this
  // relationship at origin" fact, with the other participants' avatars inline
  // to identify which relationship.
  const relationshipOriginNodeIds = useMemo(
    () => new Set(nodes.filter((n) => n.type === 'relationshipOriginNode').map((n) => n.id)),
    [nodes]
  )
  const entityOriginJoinChips = useMemo(() => {
    if (!entity || hasInput) return []
    return allRelationships
      .filter((rel) => {
        const joins = rel.history?.participant_changes || []
        return joins.some((c) =>
          c.action === 'join' && c.entity_id === entity.id && relationshipOriginNodeIds.has(c.node_id)
        )
      })
      .map((rel) => {
        // Find the origin node id for this relationship (first join event that points at a rel-origin node)
        const joinAtOrigin = (rel.history?.participant_changes || []).find(
          (c) => c.action === 'join' && c.entity_id === entity.id && relationshipOriginNodeIds.has(c.node_id),
        )
        // All participants (including this entity) in the order they appear in
        // the rel's history at this origin node. Keeps the label identical on
        // every entity's origin node — "Alice as Ali & Bob" on both Alice's
        // and Bob's nodes — instead of rotating the owner to the front.
        const allIds = Array.from(new Set(
          (rel.history?.participant_changes || [])
            .filter((c) => c.action === 'join' && c.node_id === joinAtOrigin?.node_id)
            .map((c) => c.entity_id),
        ))
        const otherIds = allIds.filter((eid) => eid !== entity.id)
        return { rel, originNodeId: joinAtOrigin?.node_id, allIds, otherIds }
      })
  }, [entity, hasInput, allRelationships, relationshipOriginNodeIds])

  // ── Sub-chip click → navigate to modifier detail + switch to relevant tab ──
  // Origin nodes are always chain index 0 (matches Canvas.jsx dispatch); modifier
  // nodes pass -1 so the detail view resolves chain position via chain lookup.
  // Without the explicit 0 for origin, this handler races Canvas.jsx's selection
  // dispatch and clobbers chainIndex=0 with -1, flipping the chain-nav counter
  // from "1 / x" to "—".
  const handleSubChipClick = useCallback((subTab) => {
    if (!entity) return
    const mode = hasInput ? 'entityNodeModifier' : 'entityNode'
    const chainIdx = hasInput ? -1 : 0
    setDetailPanel(mode, id, data.entity_id, chainIdx, subTab)
  }, [entity, hasInput, id, data.entity_id, setDetailPanel])

  // Click on the node body (outside sub-chips) → navigate sidebar to details tab.
  // Skipped when a multi-selection modifier (Ctrl/Cmd) or the marquee modifier
  // (Shift) is held, because those clicks are about building a multi-selection.
  // chainIndex matches Canvas.jsx: 0 for origin, -1 for modifier (resolved by
  // the detail view's chain lookup).
  const handleNodeBodyClick = useCallback((e) => {
    if (e?.ctrlKey || e?.metaKey || e?.shiftKey) return
    if (!entity) return
    const mode = hasInput ? 'entityNodeModifier' : 'entityNode'
    const chainIdx = hasInput ? -1 : 0
    // Pass null (not 'details') for the subTab so the user's currently-
    // active tab is preserved across the click. An explicit subTab
    // string is reserved for "open the panel pre-targeted at THIS tab"
    // affordances (sub-chip clicks etc.).
    setDetailPanel(mode, id, data.entity_id, chainIdx, null)
  }, [entity, hasInput, id, data.entity_id, setDetailPanel])

  // Delete handler: full dialog for origin nodes; deleteNode handles modifiers
  const handleDeleteClick = useCallback((e) => {
    e.stopPropagation()
    if (!entity) { deleteNode(id); return }

    // Origin nodes → full delete-entity dialog (may delete entity + all chips)
    if (!hasInput) {
      const payload = {
        entityId: entity.id,
        entityName: entity.name,
        entityColour: entity.colour || '#888888',
        chipCount: countEntityChips(entity.id),
        nodeId: id,
        isOrigin: true,
      }
      if (isOvumRedEntity(entity)) {
        payload.extraOption = {
          label: "Don't let this happen again this session",
          onChange: (checked) => setOvumRedSessionDisabled(checked),
        }
      }
      openDeleteEntityDialog(payload)
      return
    }

    // Modifier nodes → deleteNode handles smart confirmation
    deleteNode(id)
  }, [entity, id, hasInput, deleteNode, openDeleteEntityDialog, countEntityChips])

  const colour = effectiveState?.colour ?? entity?.colour ?? '#888888'
  const name = effectiveState?.name ?? entity?.name ?? data.entity_id ?? '—'
  const type = entity?.type || 'character'
  const icon = TYPE_ICONS[type] || '?'

  // ── Relationship sub-chips ──────────────────────────────────────────────────
  // Origin nodes: show entity's base relationships (list[Relationship]).
  // Modifier nodes show no relationship sub-chips here — relationship history
  // lives on the Relationship object itself (`rel.history.*_changes`) post-
  // Phase-1.18 and renders through its own surfaces, not via EntityNode.
  const relationshipSubChips = useMemo(() => {
    if (!entity || hasInput) return []
    // Origin node: show all relationships the entity has (always 'add' — these are establishment events)
    return (entity.relationships || []).map((r) => {
      const otherId = r.entity_a_id === entity.id ? r.entity_b_id : r.entity_a_id
      const partnerEntity = allEntities.find((e) => e.id === otherId)
      const partnerNodeId = findPartnerChainNodeAtOrBefore(partnerEntity, nodes, edges, id, r.id, povChain)
      return { relationship: r, changeType: 'add', partnerNodeId }
    })
  }, [entity, hasInput, allEntities, edges, id, nodes, povChain])

  const categoryName = type === 'custom' && entity?.category_id
    ? customCategories.find((c) => c.id === entity.category_id)?.name
    : null
  const description = effectiveState?.description ?? entity?.description ?? ''
  const descriptionModified = hasInput && data.description_change != null
  const profileRef = effectiveState?.profile_image_ref ?? entity?.profile_image_ref ?? null
  const profileAsset = profileRef ? profileRef.replace(/^assets\//, '') : null

  // ── Blank modifier placeholder render ────────────────────────────────────────
  if (isBlankModifier) {
    return (
      <div
        data-help-region="modifier:node"
        className="bg-zinc-800 border border-dashed border-zinc-500 overflow-hidden shadow select-none"
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          outline: (selected && multiSelectActive) ? `2px dashed ${accentColor}` : undefined,
          outlineOffset: (selected && multiSelectActive) ? 3 : undefined,
          boxShadow: isActiveNode ? `0 0 0 2px ${accentColor}` : undefined,
          width:    data.width  || 160,
          height:   data.height || undefined,
          minWidth: 160,
          minHeight: 64,
          borderRadius: '4px 4px 2px 4px',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {selected && (
          <NodeResizeControl
            minWidth={160}
            minHeight={64}
            position="bottom-right"
            onResizeStart={() => useUiStore.getState().setCanvasGestureActive(true)}
            onResize={(_, dims) => {
              const snapped = applyResizeSnap(dims, useProjectStore.getState().snapToGrid)
              updateNodeData(id, snapped)
            }}
            onResizeEnd={(_, dims) => {
              useUiStore.getState().setCanvasGestureActive(false)
              const snapped = applyResizeSnap(dims, useProjectStore.getState().snapToGrid)
              updateNodeData(id, snapped)
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
        <PortHandle nodeId={id} nodeType="entityNode" type="target" position={Position.Left} style={ENTITY_HANDLE_STYLE} />
        {/* Header row: modifier badge + delete */}
        <div className="flex items-center justify-between px-3 pt-2 pb-1.5 flex-shrink-0">
          <span className="text-[9px] text-amber-400 uppercase tracking-widest font-semibold bg-amber-900/30 px-1.5 py-0.5 rounded flex-shrink-0">
            MODIFIER
          </span>
          <button
            className={`nodrag text-sm leading-none transition-opacity ${
              hovered ? 'text-zinc-600 hover:text-red-400 opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            onClick={(e) => { e.stopPropagation(); deleteNode(id) }}
            title="Delete node"
          >
            ×
          </button>
        </div>
        {/* Placeholder body */}
        <div className="flex-1 flex items-center justify-center px-3 pb-2">
          <div className="text-xs text-zinc-500 italic text-center leading-relaxed">
            ← Wire an entity<br />to configure
          </div>
        </div>
        <PortHandle nodeId={id} nodeType="entityNode" type="source" position={Position.Right} style={ENTITY_HANDLE_STYLE} />
      </div>
    )
  }

  return (
    <div
      data-help-region={hasInput ? 'modifier:node' : 'entity-origin:node'}
      className="bg-zinc-800 border border-zinc-600 overflow-hidden shadow cursor-pointer select-none"
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        // Origin nodes accent on the left edge; modifier nodes accent
        // on the top edge so the two are visually distinct (mirrors the
        // minimap stripe-side rule).
        ...(hasInput
          ? { borderTopColor: colour, borderTopWidth: 4 }
          : { borderLeftColor: colour, borderLeftWidth: 4 }),
        // Phase 1.11 Track I — selection outline driven by the `selected` prop.
        outline: (selected && multiSelectActive) ? `2px dashed ${accentColor}` : undefined,
        outlineOffset: (selected && multiSelectActive) ? 3 : undefined,
        boxShadow: isActiveNode ? `0 0 0 2px ${accentColor}` : undefined,
        width:    data.width  || undefined,
        maxWidth: data.width  ? undefined : 220,
        // While the description handle is being dragged, override
        // data.height with a live computed value so the outer node grows /
        // shrinks in lockstep with the description preview. When idle,
        // pin to preferredMinHeight when data.height is unset so a long
        // description doesn't push the node past its capped 3-line
        // minimum (or past the writer's chosen description_height). When
        // data.height is explicitly set (corner-drag), it wins and the
        // description flex-grows into the extra space.
        height: descDragHeight != null
          ? ((headerRef.current?.offsetHeight ?? 0) + DESC_LABEL_HEIGHT + DESC_WRAPPER_PAD + descDragHeight)
          : (data.height || preferredMinHeight),
        minWidth: 160,
        minHeight: naturalMinHeight,
        borderRadius: '4px 4px 2px 4px',
      }}
      onClick={handleNodeBodyClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={hasInput ? 'Entity modifier — select to edit overrides in sidebar' : 'Select to edit initial state in sidebar'}
    >
      {/* Resize handle — single bottom-right grip, visible only when node is selected */}
      {selected && (
        <NodeResizeControl
          minWidth={160}
          minHeight={naturalMinHeight}
          position="bottom-right"
          onResizeStart={() => useUiStore.getState().setCanvasGestureActive(true)}
          onResize={(_, dims) => {
            const snapped = applyResizeSnap(dims, useProjectStore.getState().snapToGrid)
            updateNodeData(id, { width: snapped.width, height: Math.max(snapped.height, naturalMinHeightRef.current) })
          }}
          onResizeEnd={(_, dims) => {
            useUiStore.getState().setCanvasGestureActive(false)
            const snapped = applyResizeSnap(dims, useProjectStore.getState().snapToGrid)
            updateNodeData(id, { width: snapped.width, height: Math.max(snapped.height, naturalMinHeightRef.current) })
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

      {/* Input port — anchored top-left; accepts relationship wires (entity→entity) and modifier wires */}
      <PortHandle
        nodeId={id}
        nodeType="entityNode"
        type="target"
        position={Position.Left}
        style={ENTITY_HANDLE_STYLE}
      />

      {/* ── Non-scrolling content wrapper (measured for minimum height) ── */}
      <div ref={headerRef} className="flex-shrink-0">

      {/* ── Node type badge row + header — tinted with entity colour ── */}
      <div data-help-region={hasInput ? 'modifier:header' : 'entity-origin:header'} style={{ backgroundColor: colour + '1a' }}>
      <div className="flex items-center justify-between px-3 pt-2 pb-1.5">
        {hasInput ? (
          <span className="text-[9px] text-amber-400 uppercase tracking-widest font-semibold bg-amber-900/30 px-1.5 py-0.5 rounded flex-shrink-0">
            MODIFIER : {type.toUpperCase()}
          </span>
        ) : (
          <span className="text-[9px] text-green-400 uppercase tracking-widest font-semibold bg-green-900/30 px-1.5 py-0.5 rounded flex-shrink-0">
            NEW : {type.toUpperCase()}
          </span>
        )}
        <div className="flex items-center gap-1 nodrag">
          {/* Phase 2.7a/b — corner "Add as context" affordance. THIS
              node id is the chain anchor regardless of whether it's
              an origin or modifier — the chain walker accepts any
              node id and resolves at that position. Origin EntityNode
              → resolves at origin baseline; modifier EntityNode →
              resolves at that modifier's chain stop. Self-gates on
              chat-open. */}
          {data.entity_id && (
            <AttachToChatButton
              kind="entity"
              id={data.entity_id}
              anchorNodeId={id}
              size={12}
              title={hasInput
                ? 'Add this entity at this modifier as context to the open conversation'
                : 'Add this entity at its origin as context to the open conversation'}
              stopPropagation
              className={hovered ? 'opacity-100' : 'opacity-0 pointer-events-none'}
            />
          )}
          <button
            className={`text-sm leading-none transition-opacity ${
              hovered ? 'text-zinc-600 hover:text-red-400 opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            onClick={handleDeleteClick}
            title="Delete node"
          >
            ×
          </button>
        </div>
      </div>

      {/* ── Header (profile image + name) ── */}
      <div className="px-3 pt-0 pb-2 flex items-center gap-2">
        {/* Profile image / placeholder — border in entity colour */}
        {!hasInput && isOvumRedEntity(entity) ? (
          <OvumRedAvatar entityId={entity.id} colour={colour} />
        ) : (
        <div
          {...avatarDrop.dropHandlers}
          className="relative"
          style={avatarDrop.isDragOver ? {
            outline: `2px dashed ${accentColor || '#a855f7'}`,
            outlineOffset: 2,
            borderRadius: 2,
          } : undefined}
          title={avatarDrop.isDragOver ? 'Drop to apply as avatar at this anchor' : undefined}
        >
        <ImageHoverPreview
          src={profileAsset ? `/api/project/assets/${profileAsset}` : null}
          borderColour={colour}
          previewSource={profileRef ? {
            type: 'entity_profile',
            entityId: data.entity_id,
            ...(profileRef.startsWith('data:') ? { url: profileRef } : { fileRef: profileRef }),
            entityName: name,
            entityColour: colour,
          } : undefined}
        >
          {profileAsset ? (
            <img
              src={`/api/project/assets/${profileAsset}`}
              alt=""
              className="w-10 h-10 rounded-sm object-cover flex-shrink-0"
              style={{ border: `2px solid ${colour}` }}
            />
          ) : (
            <div
              className="w-10 h-10 rounded-sm flex items-center justify-center flex-shrink-0 text-xl select-none"
              style={{ backgroundColor: colour + '22', border: `2px solid ${colour}` }}
            >
              {icon}
            </div>
          )}
        </ImageHoverPreview>
        </div>
        )}

        {/* Name + optional category — left aligned with slight extra margin */}
        <div className="min-w-0 flex-1 ml-0.5">
          <div className="flex items-center gap-1.5">
            <div className="text-sm text-zinc-100 font-medium break-words leading-snug flex-1 min-w-0">{name}</div>
            {/* Phase 1.22f — Compact circumstance / motivator marker.
                Inline with the entity name (matching the SceneNode
                entity-chip placement). Source of attributes is chain-
                aware per anchor:
                  - Origin EntityNode (!hasInput): the active anchor IS
                    the entity's origin; baseline `entity.attributes` is
                    the chain-aware path here.
                  - Modifier EntityNode (hasInput): chain-resolved view
                    at this modifier via `effectiveState.attributes`
                    (computed by the chain walker on line 155-158).
                Border colour follows `colour` (already chain-resolved
                at line 362 — eff first, baseline fallback only when at
                origin or no walker result).
                Hover popover shows full row details; click navigates
                the left sidebar to the entity Detail Panel Attributes
                tab. */}
            {(() => {
              const sourceAttrs = hasInput
                ? (effectiveState?.attributes || [])
                : (entity?.attributes || [])
              const cmAttrs = sourceAttrs.filter(
                (a) => a.attribute_type === 'circumstance' || a.attribute_type === 'motivator',
              )
              if (cmAttrs.length === 0) return null
              const circs = cmAttrs.filter((a) => a.attribute_type === 'circumstance')
              const mots  = cmAttrs.filter((a) => a.attribute_type === 'motivator')
              const popoverContent = (
                <div className="px-2 py-1.5 space-y-2 min-w-[220px]">
                  <div className="text-[9px] uppercase tracking-wider text-zinc-500">{name}</div>
                  {circs.length > 0 && (
                    <div className="space-y-1">
                      <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-zinc-400">
                        <CircumstanceTypeBadge size={11} />
                        <span>Circumstances</span>
                      </div>
                      <div className="space-y-1">
                        {circs.map((a) => (
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
                  {mots.length > 0 && (
                    <div className="space-y-1">
                      <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-zinc-400">
                        <MotivatorTypeBadge size={11} />
                        <span>Motivators</span>
                      </div>
                      <div className="space-y-1">
                        {mots.map((a) => (
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
                    className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-zinc-800/80 hover:bg-zinc-800 nodrag flex-shrink-0"
                    style={{ border: `1px solid ${colour}` }}
                    title="Active circumstances + motivators — click to open"
                  >
                    {circs.length > 0 && (
                      <span className="inline-flex items-center gap-0.5">
                        <CircumstanceTypeBadge size={11} />
                        <span className="text-[9px] text-zinc-300 font-semibold">{circs.length}</span>
                      </span>
                    )}
                    {mots.length > 0 && (
                      <span className="inline-flex items-center gap-0.5 ml-0.5">
                        <MotivatorTypeBadge size={11} />
                        <span className="text-[9px] text-zinc-300 font-semibold">{mots.length}</span>
                      </span>
                    )}
                  </span>
                </HoverPopover>
              )
            })()}
          </div>
          {categoryName && (
            <div className="text-xs text-zinc-500">{categoryName}</div>
          )}
        </div>
      </div>
      </div>

      {/* ── Attribute sub-chips (origin: +ADD; modifier: change indicators) ── */}
      {attrSubChips.length > 0 && (
        <div data-help-region={hasInput ? 'modifier:changes' : 'entity-origin:attributes'} className="px-2 pt-1.5 pb-1 space-y-0.5 border-t border-zinc-700/40">
          {/* Section header — only shown when both attributes AND relationships exist */}
          {relationshipSubChips.length > 0 && (
            <div className="text-[7px] text-zinc-600 uppercase tracking-wider opacity-60 mb-0.5">Attributes</div>
          )}
          {attrSubChips.map((chip, i) => {
            const LABEL_TO_KEY = { 'Name': 'name', 'Colour': 'colour', 'Description': 'description', 'Profile Image': 'profile_image' }
            const fieldKey = LABEL_TO_KEY[chip.field] || (chip.attributeId ? `attr:${chip.attributeId}` : chip.field)
            const flagged = hasInput && (data.review_fields || []).some((f) => {
              const fk = typeof f === 'string' ? f : f.field
              if (fk === fieldKey) return true
              // List attribute sub-chips: also flag when any list_add:/list_remove: entry matches this attribute
              if (chip.attributeId && (fk.startsWith(`list_add:${chip.attributeId}:`) || fk.startsWith(`list_remove:${chip.attributeId}:`))) return true
              return false
            })
            const subChipTab = chip.attributeId ? 'attributes'
              : (chip.field === 'Name' || chip.field === 'Colour' || chip.field === 'Description' || chip.isProfileImage || chip.isColour) ? 'details'
              : 'details'
            // Phase 2.13b — perspective change events dispatch to the
            // dedicated PerspectiveSubChip. Same descriptor shape as
            // the SceneNode dispatcher; dismiss path uses baseline-
            // attribute removal at origin (the add entry IS the
            // perspective's origin per the chain model) and falls
            // back to draft-clear on a modifier EntityNode.
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
                  onDismiss={
                    hasInput
                      ? () => clearEntityRefChange(id, data.entity_id, chip)
                      : (chip.attributeId
                          ? async () => {
                              const result = await confirm({
                                title: 'Delete perspective',
                                message: 'Delete this perspective from this entity? Any downstream changes to it will also be removed.',
                                buttons: [
                                  { label: 'Delete', value: 'delete', style: 'danger' },
                                  { label: 'Cancel', value: 'cancel', style: 'neutral' },
                                ],
                              })
                              if (result === 'delete') removeBaselineAttribute(data.entity_id, chip.attributeId)
                            }
                          : undefined)
                  }
                />
              )
            }
            // Phase 1.22f — circumstance / motivator change events
            // dispatch to the dedicated CircumstanceMotivatorSubChip.
            // Same chip-descriptor shape as the SceneNode dispatcher;
            // dismiss path differs because origin EntityNodes use the
            // baseline-attribute removal flow (the add entry IS the
            // attribute's origin per the chain model).
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
                  onDismiss={
                    hasInput
                      ? () => clearEntityRefChange(id, data.entity_id, chip)
                      : (chip.attributeId
                          ? async () => {
                              const result = await confirm({
                                title: 'Delete attribute',
                                message: `Delete "${chip.field}" from this entity? Any downstream changes to this attribute will also be removed.`,
                                buttons: [
                                  { label: 'Delete', value: 'delete', style: 'danger' },
                                  { label: 'Cancel', value: 'cancel', style: 'neutral' },
                                ],
                              })
                              if (result === 'delete') removeBaselineAttribute(data.entity_id, chip.attributeId)
                            }
                          : undefined)
                  }
                  onAddKnowledge={(e) => {
                    const sourceEvent = hasInput
                      ? buildSourceEventFromEntityRefChip(chip, data, id)
                      : (chip.attributeId
                          ? buildSourceEventFromOriginAttribute(
                              (entity?.attributes || []).find((a) => a.id === chip.attributeId),
                              entity,
                              id,
                            )
                          : null)
                    if (!sourceEvent) return
                    const rect = e?.currentTarget?.getBoundingClientRect?.() || null
                    useUiStore.getState().openAddKnowledgeFromChangePopover({
                      anchorRect: rect,
                      sourceEvent,
                      suggestedName: buildSuggestedKnowledgeName(chip, data, entity),
                      triggerNodeId: id,
                      isOrigin: !hasInput,
                      eventDisplay: {
                        ownerEntityId: data.entity_id,
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
                entityColour={colour}
                entityId={data.entity_id}
                entityName={name}
                onDismiss={
                  hasInput && chip.isProfileImage
                    ? () => clearProfileImageChange(id, data.entity_id)
                    : (!hasInput && chip.attributeId)
                      ? async () => {
                          const result = await confirm({
                            title: 'Delete attribute',
                            message: `Delete "${chip.field}" from this entity? Any downstream changes to this attribute will also be removed.`,
                            buttons: [
                              { label: 'Delete', value: 'delete', style: 'danger' },
                              { label: 'Cancel', value: 'cancel', style: 'neutral' },
                            ],
                          })
                          if (result === 'delete') removeBaselineAttribute(data.entity_id, chip.attributeId)
                        }
                      : undefined
                }
                onAddKnowledge={(e) => {
                  // Origin EntityNode = the entity's own origin; baseline
                  // values on `entity.attributes` are the chain-aware
                  // read at this anchor. Modifier EntityNode = downstream
                  // chain stop; route via the carrier ref helper.
                  const sourceEvent = hasInput
                    ? buildSourceEventFromEntityRefChip(chip, data, id)
                    : (chip.attributeId
                        ? buildSourceEventFromOriginAttribute(
                            (entity?.attributes || []).find((a) => a.id === chip.attributeId),
                            entity,
                            id,
                          )
                        : null)
                  if (!sourceEvent) return
                  const rect = e?.currentTarget?.getBoundingClientRect?.() || null
                  useUiStore.getState().openAddKnowledgeFromChangePopover({
                    anchorRect: rect,
                    sourceEvent,
                    suggestedName: buildSuggestedKnowledgeName(chip, data, entity),
                    triggerNodeId: id,
                    isOrigin: !hasInput,
                    eventDisplay: {
                      ownerEntityId: data.entity_id,
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
                  // Navigate the left Detail Panel to this sub-chip's context
                  // (same as clicking the chip body would), then toggle the
                  // Media Preview Panel: if already showing this file, dismiss;
                  // otherwise open with an attribute-source descriptor anchored
                  // to this entity node (origin or modifier entity_node).
                  handleSubChipClick(subChipTab)
                  togglePreview({
                    type: 'attribute',
                    entityId: data.entity_id,
                    attributeId: chip.attributeId,
                    atNodeId: id,
                    fileRef,
                    attributeName: chip.field,
                    entityName: name,
                    entityColour: colour,
                    profileImageRef: profileRef,
                  })
                } : undefined}
              />
            )
          })}
        </div>
      )}

      {/* ── Relationship sub-chips ── */}
      {relationshipSubChips.length > 0 && (
        <div data-help-region="entity-origin:relationships" className={`px-2 pb-1.5 space-y-0.5 overflow-visible${attrSubChips.length === 0 ? ' pt-1.5 border-t border-zinc-700/40' : ''}`}>
          {/* Section header — only shown when both relationships AND attributes exist */}
          {attrSubChips.length > 0 && (
            <div className="text-[7px] text-zinc-600 uppercase tracking-wider opacity-60 mb-0.5">Relationships</div>
          )}
          {relationshipSubChips.map(({ relationship, changeType, descChange, oldDesc, partnerNodeId }) => {
            // Origin node only — modifier nodes return [] from
            // relationshipSubChips above, so this map never runs on them.
            const removeHandler = () => {
              const entStore = useEntitiesStore.getState()
              const otherId = relationship.entity_a_id === entity.id ? relationship.entity_b_id : relationship.entity_a_id
              entStore.updateEntity(entity.id, {
                ...entity,
                relationships: (entity.relationships || []).filter((r) => r.id !== relationship.id),
              })
              const otherEntity = entStore.getEntityById(otherId)
              if (otherEntity) {
                entStore.updateEntity(otherEntity.id, {
                  ...otherEntity,
                  relationships: (otherEntity.relationships || []).filter((r) => r.id !== relationship.id),
                })
              }
              useProjectStore.getState().removeRelationshipEdgeById(relationship.id)
            }
            return (
              <RelationshipSubChip
                key={relationship.id}
                relationship={relationship}
                changeType={changeType}
                descChange={descChange}
                oldDesc={oldDesc}
                ownerEntityId={entity.id}
                allEntities={allEntities}
                nodes={nodes}
                edges={edges}
                atNodeId={partnerNodeId}
                onRemove={removeHandler}
                onClick={() => handleSubChipClick('relationships')}
              />
            )
          })}
        </div>
      )}

      {/* ── Awareness sub-chips (Phase 1.21c Tier 4) ── */}
      {awarenessSubChips.length > 0 && (
        <div className={`px-2 pb-1.5 space-y-0.5 overflow-visible${(attrSubChips.length === 0 && relationshipSubChips.length === 0) ? ' pt-1.5 border-t border-zinc-700/40' : ''}`}>
          {(attrSubChips.length > 0 || relationshipSubChips.length > 0) && (
            <div className="text-[8px] text-zinc-400 uppercase tracking-wider mb-0.5">Awareness</div>
          )}
          {awarenessSubChips.map((rec) => {
            // Awareness review flags live on each awareness object's
            // `history[].review_flag` (per the awareness-as-second-class-
            // object model). Look up the matching entry by changeId.
            let awarenessFlagged = false
            if (rec.changeId) {
              const findInHistory = (h) => Array.isArray(h)
                ? h.some((e) => e?.id === rec.changeId && e?.review_flag)
                : false
              if (rec.targetEntityId) {
                const targetEnt = allEntities.find((e) => e.id === rec.targetEntityId)
                if (rec.kind === 'entity_existence') awarenessFlagged = findInHistory(targetEnt?.awareness?.history)
                else if (rec.kind === 'entity_name') awarenessFlagged = findInHistory(targetEnt?.name_awareness?.history)
                else if (rec.kind === 'attribute' && rec.attributeId) {
                  const attr = (targetEnt?.attributes || []).find((a) => a.id === rec.attributeId)
                  awarenessFlagged = findInHistory(attr?.awareness?.history)
                } else if (rec.kind === 'alias' && rec.aliasValue) {
                  const al = (targetEnt?.aliases || []).find((a) => (typeof a === 'string' ? a : a?.value) === rec.aliasValue)
                  awarenessFlagged = al && typeof al !== 'string' ? findInHistory(al?.awareness?.history) : false
                }
              }
              if (!awarenessFlagged && rec.kind === 'relationship' && rec.relationshipId) {
                const rel = (allRelationships || []).find((r) => r.id === rec.relationshipId)
                awarenessFlagged = findInHistory(rel?.awareness?.history)
              }
              if (!awarenessFlagged && rec.kind === 'knowledge' && rec.knowledgeId) {
                const k = (allKnowledgesPS || []).find((kk) => kk.id === rec.knowledgeId)
                awarenessFlagged = findInHistory(k?.awareness?.history)
              }
            }
            // Build target descriptor for the universal history-entry
            // remove action so the sub-chip's "Remove this change"
            // affordance dispatches correctly across all six kinds.
            let removeTarget = null
            if (rec.changeId) {
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
            }
            const onRemoveAwareness = removeTarget
              ? () => useProjectStore.getState().removeAwarenessHistoryEntry({
                  target: removeTarget,
                  entryId: rec.changeId,
                })
              : undefined
            return (
            <AwarenessSubChip
              key={rec.changeId || `${rec.kind}-${rec.targetEntityId || rec.knowledgeId || rec.relationshipId}`}
              record={rec}
              observerName={effectiveState?.name || entity?.name}
              reviewFlagged={awarenessFlagged}
              onRemove={onRemoveAwareness}
              getEntity={(eid) => {
                // Phase 1.21h — chain-resolve the target entity at this
                // node so badges (avatar / name / colour) reflect chain-
                // time changes. Falls back to the base entity when the
                // walker can't resolve.
                const base = allEntities.find((e) => e.id === eid) || null
                if (!base) return null
                const eff = computeEffectiveState(base, nodes, edges, id)
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
              getRelationship={(rid) => allRelationships?.find((r) => r.id === rid) || null}
              getKnowledge={(kid) => allKnowledgesPS?.find((k) => k.id === kid) || null}
              onClick={() => handleSubChipClick('awareness')}
            />
            )
          })}
        </div>
      )}

      {/* ── N-party relationship chips ── */}
      {entityNodeRelChips.length > 0 && (
        <div className={`px-2 pb-1.5 space-y-0.5${attrSubChips.length === 0 && relationshipSubChips.length === 0 ? ' pt-1.5' : ''} border-t border-zinc-700/40`}>
          {entityNodeRelChips.map((rel) => (
            <RelationshipChip key={rel.id} nodeId={id} relationship={rel} parentNodeType="entityNode" />
          ))}
        </div>
      )}

      {/* ── Origin-level "+ Joined : <relationship>" minimal chips (Phase D / Q8) ── */}
      {entityOriginJoinChips.length > 0 && (
        <div className={`px-2 pb-1.5 space-y-0.5${attrSubChips.length === 0 && relationshipSubChips.length === 0 && entityNodeRelChips.length === 0 ? ' pt-1.5' : ''} border-t border-zinc-700/40`}>
          {entityOriginJoinChips.map(({ rel, originNodeId, otherIds }) => {
            const resolveNameAtOrigin = (eid) => {
              const ent = allEntities.find((e) => e.id === eid)
              if (!ent) return null
              const s = computeEffectiveState(ent, nodes, edges, originNodeId)
              return s?.name || ent.name || null
            }
            // Synthesize a participant-join change entry so this chip
            // shares the RelationshipHistoryChangeChip rendering with
            // the sidebar history rows. Same shape, same visuals;
            // canvas variant just adds the trailing other-participant
            // avatar row via `otherParticipantIds`.
            const syntheticEntry = {
              relationship: rel,
              change: { type: 'participant', action: 'join', entity_id: id },
            }
            return (
              <RelationshipHistoryChangeChip
                key={rel.id}
                entry={syntheticEntry}
                otherParticipantIds={otherIds}
                allEntities={allEntities}
                resolveNameAtAnchor={resolveNameAtOrigin}
                getEntity={(eid) => allEntities.find((e) => e.id === eid) || null}
                onClick={() => openRelationshipDetail(rel.id, originNodeId)}
              />
            )
          })}
        </div>
      )}
      {/* ── Knowledge chips on entity origin nodes (Phase 1.21k) ── */}
      {knowledgeChipsAtNode.length > 0 && (
        <div className="px-2 pb-2 pt-1 border-t border-zinc-700/60 space-y-0.5">
          <div
            className="text-[9px] uppercase tracking-widest px-0.5 pb-0.5 select-none"
            style={{ color: `${KNOWLEDGE_COLOUR}b3` }}
          >
            Knowledge
          </div>
          {knowledgeChipsAtNode.map((k) => (
            <KnowledgeChip key={k.id} nodeId={id} knowledge={k} parentNodeType="entityNode" />
          ))}
        </div>
      )}
      </div>{/* end headerRef wrapper */}

      {/* ── Description (outside headerRef so it can flex-grow into extra space) ── */}
      {/* At minimum node height the text area is capped at ~3 lines and scrolls;
          shorter text uses only what it needs. Resizing taller grows the description.
          Top padding is added when no attribute or relationship sub-chips sit above
          so the description card doesn't touch the entity-coloured header directly. */}
      {description && (
        <div
          ref={descBlockRef}
          data-help-region={hasInput ? 'modifier:description' : 'entity-origin:description'}
          className={`px-2 pb-2 flex-1 flex flex-col${
            attrSubChips.length === 0 && relationshipSubChips.length === 0 ? ' pt-2' : ''
          }`}
          style={{ minHeight: 0, position: 'relative' }}
        >
          <div
            className="rounded overflow-hidden flex-1 flex flex-col"
            style={{
              border: `1px solid ${descriptionModified ? '#fbbf2466' : hasInput ? '#52525b' : '#4ade8066'}`,
              minHeight: 0,
            }}
          >
            {/* Header row with corner badge + label */}
            <div className="flex items-center gap-1 text-[8px] select-none flex-shrink-0" style={{
              backgroundColor: descriptionModified ? '#fbbf2418' : !hasInput ? '#4ade8012' : undefined,
              borderBottom: `1px solid ${descriptionModified ? '#fbbf2418' : hasInput ? '#52525b44' : '#4ade8022'}`,
              padding: '1px 6px',
            }}>
              {descriptionModified ? (
                <span className="font-bold" style={{ color: '#fbbf24' }}>✱</span>
              ) : !hasInput ? (
                <span className="font-bold" style={{ color: '#4ade80' }}>+</span>
              ) : null}
              <span className="text-zinc-500 uppercase tracking-wider">Description</span>
            </div>
            {/* Description text — flex-1 grows when node is resized taller.
                At minimum node height this is capped at ~3 lines and scrolls;
                shorter text uses only its natural height. */}
            <div
              ref={descTextRef}
              className="overflow-y-auto text-[9px] text-zinc-400 break-words nowheel px-1.5 py-1 flex-1"
              style={{ minHeight: 0 }}
            >
              {description}
            </div>
          </div>
          {/* Bottom-edge resize handle — sits absolutely overlaid on the
              wrapper's bottom border so toggling on selection doesn't
              shift node layout. Drag to resize the description (and the
              node, since description is the bottom section). Double-click
              toggles between auto-minimum (3-line cap) and fully-expanded.
              Visible only when the node is selected. */}
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

      <PortHandle nodeId={id} nodeType="entityNode" type="source" position={Position.Right} style={ENTITY_HANDLE_STYLE} />
    </div>
  )
}
