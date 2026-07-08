import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ReactFlow,
  ReactFlowProvider,
  MiniMap,
  Controls,
  ControlButton,
  Background,
  useReactFlow,
  useConnection,
  useUpdateNodeInternals,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useUiStore } from '../../store/uiStore'
import { useMcpControlStore } from '../../store/mcpControlStore'
import { useConfirm } from '../../store/dialogStore'
import EntityNode from '../nodes/EntityNode'
import SceneNode from '../nodes/SceneNode'
import ReferenceNode from '../nodes/ReferenceNode'
import GenericGroupNode from '../nodes/GenericGroupNode'
import { getNodesInGroup } from '../../utils/groupMembership'
import { snapPosition } from '../../utils/snapUtils'
import { getMeasuredDimensions, subscribeMeasuredDimensions } from '../../utils/measuredDimensionsStore'
import PovOriginNode from '../nodes/PovOriginNode'
import RelationshipOriginNode from '../nodes/RelationshipOriginNode'
import KnowledgeOriginNode from '../nodes/KnowledgeOriginNode'
import { KNOWLEDGE_COLOUR } from '../ui/IdentityBadges'
import { computeEffectiveState } from '../../utils/narrativeChain'
import { useStoryOrder, getOrComputeStoryOrder } from '../../hooks/useStoryOrder'
import TransitionEdge from '../edges/TransitionEdge'
import RelationshipEdge from '../edges/RelationshipEdge'
import PovEdge from '../edges/PovEdge'
import OvumWhiteSilhouetteEdge from '../edges/OvumWhiteSilhouetteEdge'
import ConceptEdge from '../edges/ConceptEdge'
import OvumWhiteCompanionNode from '../nodes/OvumWhiteCompanionNode'
import CanvasToolbar from './CanvasToolbar'
import WireVisibilityControl from './WireVisibilityControl'
import ChapterColumnsOverlay from './ChapterColumnsOverlay'
import EditorToggleCorner from './EditorToggleCorner'
import ChatToggleCorner from './ChatToggleCorner'
import DockDropTargets from './DockDropTargets'
import TableOfContentsPanel from '../panels/TableOfContentsPanel'
import TimelineNavigatorPanel from '../panels/TimelineNavigatorPanel'
import DragTooltip from './DragTooltip'
import WireListPopup from './WireListPopup'
import AddNodesMenuBody from './AddNodesMenuBody'
import DeleteEntityDialog from '../ui/DeleteEntityDialog'
import ConvertEntityDialog from '../ui/ConvertEntityDialog'
import { isOvumRedEntity, setOvumRedSessionDisabled } from '../../effects/quarterlyForecasts'
import { getPovColor } from '../../utils/povConstants'
import { derivePayloadType, accepts as portAccepts, isSameNodeSelfLoop } from '../../utils/portCatalogue'
import { computeBlockedTargets } from '../../utils/portDragState'
import useCanvasMediaAutoMigrate from '../../hooks/useCanvasMediaAutoMigrate'
import { useAccentColor } from '../../utils/povConstants'
import { AccentColorProvider } from './canvasContexts'
import axios from 'axios'


const REFERENCE_MEDIA_EXTS = /\.(png|jpe?g|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg|flac)$/i


// Render a hex colour with an alpha channel. Local copy of the same
// helper in ConversationView.jsx — see that file's header for the
// canonical definition. Inlined here because it's six lines and
// extracting it to a shared util for a second caller is premature.
function _withAccentAlpha(hex, alpha) {
  if (typeof hex !== 'string' || hex.length !== 7 || hex[0] !== '#') return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}


const nodeTypes = {
  entityNode: EntityNode,
  sceneNode: SceneNode,
  referenceNode: ReferenceNode,
  povOriginNode: PovOriginNode,
  relationshipOriginNode: RelationshipOriginNode,
  knowledgeOriginNode: KnowledgeOriginNode,
  genericGroupNode: GenericGroupNode,
  ovumWhiteCompanion: OvumWhiteCompanionNode,
}

const edgeTypes = {
  transitionEdge: TransitionEdge,
  relationshipEdge: RelationshipEdge,
  povEdge: PovEdge,
  ovumWhiteSilhouetteEdge: OvumWhiteSilhouetteEdge,
  conceptEdge: ConceptEdge,
}

const ENTITY_TABS = [
  { key: 'character', label: 'Characters' },
  { key: 'location',  label: 'Locations'  },
  { key: 'item',      label: 'Items'      },
  { key: 'faction',   label: 'Factions'   },
  { key: 'custom',    label: 'Custom'     },
]

const NODE_TYPE_ICONS = { character: '👤', location: '📍', item: '🎒', faction: '🚩', custom: '🔧' }

// ── Node-level entity picker ──────────────────────────────────────────────────

const BUCKET_KEYS = { character: 'characters', location: 'locations', item: 'items', faction: 'factions', custom: 'customs' }

// The minimap's original static dimensions (React Flow's default), now
// used as the MINIMUM size — the resize handle only lets the user grow it
// from here, never shrink below the size it always used to be.
const MINIMAP_MIN_W = 200
const MINIMAP_MIN_H = 150

// Custom MiniMap node renderer factory. Receives REFS to the current
// position map (nodeId → story-order number) and stripe-side map so
// the returned component identity stays stable across map rebuilds.
//
// Phase 3.7 perf fix (large-project load perf): the previous version closed
// over the maps directly, so every time the maps rebuilt (which happens
// on every `nodes` reference change — load, entity-bucket arrival,
// story-order resolve, position drag commit, etc.), the factory ran
// again and produced a NEW component identity. React Flow's
// `<MiniMap nodeComponent={...}>` then treated it as a new component
// TYPE and unmounted + re-mounted all ~290 `MinimapLeftEdgeNode`
// instances. Profile capture `profiling-data.2026-06-06.11-42-19.json`
// showed 3 separate commits with 289 ADD + 289 REMOVE each, totalling
// 6.2 seconds of blocking commit-phase work.
//
// Reading from refs means the component identity is stable forever.
// The existing instances still re-render when React Flow propagates
// new x/y/width/height/color props (which it does whenever `nodes`
// changes), and at that re-render they'll read the latest map values
// via `ref.current`. Net effect: same visible behaviour, no mass
// remount.
//
// Also draws a thin colour bar on the LEFT EDGE only when the
// nodeStrokeColor prop returns a non-transparent colour. Used so entity
// origin / modifier nodes show an entity-colour accent without painting
// a full border that crowds out the fill.
function makeMinimapNodeComponent(positionRef, stripeSideRef) {
  return function MinimapLeftEdgeNode({ x, y, width, height, color, strokeColor, strokeWidth, borderRadius, shapeRendering, onClick, id }) {
    const showStripe = strokeColor && strokeColor !== 'transparent' && strokeWidth > 0
    const stripeSide = stripeSideRef.current.get(id) || 'left'  // 'left' | 'top'
    const position = positionRef.current.get(id)
    const hasPosition = position !== undefined
    // Font size scales with node height — at typical scene heights
    // (~80–150px) this lands around 40–70px which renders large enough
    // to read at normal minimap zoom.
    const fontSize = Math.max(36, Math.min(height, width) * 0.5)
    return (
      <g onClick={onClick}>
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          fill={color}
          rx={borderRadius}
          ry={borderRadius}
          shapeRendering={shapeRendering}
          data-id={id}
        />
        {showStripe && stripeSide === 'left' && (
          <rect
            x={x}
            y={y}
            width={Math.min(strokeWidth, width)}
            height={height}
            fill={strokeColor}
            rx={borderRadius}
            ry={borderRadius}
            shapeRendering={shapeRendering}
          />
        )}
        {showStripe && stripeSide === 'top' && (
          <rect
            x={x}
            y={y}
            width={width}
            height={Math.min(strokeWidth, height)}
            fill={strokeColor}
            rx={borderRadius}
            ry={borderRadius}
            shapeRendering={shapeRendering}
          />
        )}
        {hasPosition && (
          <text
            x={x + width / 2}
            y={y + height / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={fontSize}
            fontWeight="bold"
            fill="white"
            style={{ paintOrder: 'stroke', stroke: '#000', strokeWidth: Math.max(2, fontSize * 0.12), strokeLinejoin: 'round', pointerEvents: 'none' }}
          >
            {position}
          </text>
        )}
      </g>
    )
  }
}

function NodeEntityPicker({ nodeId, type, screenX, screenY, onClose }) {
  const panelRef = useRef(null)
  const addEntityChipToNode = useProjectStore((s) => s.addEntityChipToNode)
  // Select only the single bucket needed — returning a stable array reference avoids
  // the infinite re-render loop caused by returning a new object on every selector call.
  const bucket = useEntitiesStore((s) => s[BUCKET_KEYS[type]] || [])
  const [filter, setFilter] = useState('')
  const entities = bucket.filter((e) =>
    (e.name || '').toLowerCase().includes(filter.toLowerCase())
  )

  useEffect(() => {
    function onPointerDown(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => document.removeEventListener('pointerdown', onPointerDown, { capture: true })
  }, [onClose])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const tab = ENTITY_TABS.find((t) => t.key === type)

  return (
    <div
      ref={panelRef}
      className="fixed z-[60] bg-zinc-800 border border-zinc-600 rounded shadow-xl py-1 w-48"
      style={{ left: screenX, top: screenY }}
    >
      <div className="px-3 py-1 text-[10px] text-zinc-500 uppercase tracking-wide">
        {tab?.label || type}
      </div>
      <div className="px-2 pb-1">
        <input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
        />
      </div>
      {entities.length === 0 ? (
        <p className="px-3 py-1.5 text-xs text-zinc-600 italic">None found.</p>
      ) : entities.map((entity) => (
        <button
          key={entity.id}
          onClick={() => { addEntityChipToNode(nodeId, entity.id); onClose() }}
          className="w-full text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 flex items-center gap-2"
        >
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: entity.colour || '#888888' }} />
          <span className="truncate">{entity.name}</span>
        </button>
      ))}
    </div>
  )
}

// ── Node context menu ─────────────────────────────────────────────────────────

function NodeContextMenu({ nodeId, x, y, onClose }) {
  const menuRef = useRef(null)
  const [pickerType, setPickerType] = useState(null)
  const [pickerPos, setPickerPos] = useState({ x: 0, y: 0 })
  const deleteNode = useProjectStore((s) => s.deleteNode)

  useEffect(() => {
    if (pickerType) return
    function onPointerDown(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => document.removeEventListener('pointerdown', onPointerDown, { capture: true })
  }, [onClose, pickerType])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function openPicker(type, e) {
    const rect = e.currentTarget.getBoundingClientRect()
    setPickerPos({ x: rect.right + 4, y: rect.top })
    setPickerType(type)
  }

  return (
    <>
      <div
        ref={menuRef}
        className="fixed z-50 bg-zinc-800 border border-zinc-600 rounded shadow-xl py-1 min-w-[160px] text-xs"
        style={{ left: x, top: y }}
      >
        <div className="px-3 py-1 text-[10px] text-zinc-500 uppercase tracking-wide">Add Entity</div>
        {ENTITY_TABS.map(({ key, label }) => (
          <button
            key={key}
            className="w-full text-left px-3 py-1.5 text-zinc-200 hover:bg-zinc-700 flex items-center gap-2"
            onClick={(e) => openPicker(key, e)}
          >
            <span>{NODE_TYPE_ICONS[key]}</span>
            {label}
            <span className="ml-auto text-zinc-500">›</span>
          </button>
        ))}
        {/* Delete — same call site as the Delete keyboard shortcut. */}
        <div className="border-t border-zinc-700 my-1" />
        <button
          className="w-full text-left px-3 py-1.5 text-red-400 hover:bg-red-900/30 flex items-center gap-2"
          onClick={() => { onClose(); deleteNode(nodeId) }}
        >
          <span>✕</span>
          Delete scene
        </button>
      </div>
      {pickerType && (
        <NodeEntityPicker
          nodeId={nodeId}
          type={pickerType}
          screenX={pickerPos.x}
          screenY={pickerPos.y}
          onClose={() => { setPickerType(null); onClose() }}
        />
      )}
    </>
  )
}

// ── Entity node context menu ──────────────────────────────────────────────────

function EntityNodeContextMenu({ nodeId, x, y, onClose, onDelete }) {
  const menuRef = useRef(null)
  const deleteNode = useProjectStore((s) => s.deleteNode)
  const openConvertEntityDialog = useUiStore((s) => s.openConvertEntityDialog)
  const setDetailPanel = useUiStore((s) => s.setDetailPanel)
  const requestAddAttributeForm = useUiStore((s) => s.requestAddAttributeForm)
  const openHierarchyEditor = useUiStore((s) => s.openHierarchyEditor)

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

  // Look up the node to determine if it's an origin or modifier
  const nodes = useProjectStore((s) => s.nodes)
  const node = nodes.find((n) => n.id === nodeId)
  const isOrigin = node?.type === 'entityNode' && !node?.data?.is_modifier
  const isModifier = node?.type === 'entityNode' && node?.data?.is_modifier
  const entityId = node?.data?.entity_id
  const getEntityById = useEntitiesStore((s) => s.getEntityById)
  const entity = entityId ? getEntityById(entityId) : null
  const hasHierarchy = entity?.type === 'location' || entity?.type === 'faction'

  function handleAddAttribute() {
    onClose()
    if (!entityId) return
    if (isOrigin) {
      setDetailPanel('entityNode', nodeId, entityId, 0, 'attributes')
    } else {
      setDetailPanel('entityNodeModifier', nodeId, entityId, -1, 'attributes')
    }
    requestAddAttributeForm()
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-zinc-800 border border-zinc-600 rounded shadow-xl py-1 min-w-[180px] text-xs"
      style={{ left: x, top: y }}
    >
      <button
        className="w-full text-left px-3 py-1.5 text-accent-400 hover:bg-zinc-700 flex items-center gap-2"
        onClick={handleAddAttribute}
      >
        <span>+</span>
        Add Attribute
      </button>
      {hasHierarchy && (
        <button
          className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-2"
          onClick={() => { onClose(); openHierarchyEditor(entity.type) }}
        >
          <span>⊞</span>
          Edit Hierarchy...
        </button>
      )}
      {isOrigin && entity && ['character', 'location', 'item', 'faction', 'custom'].includes(entity.type) && (
        <>
          <div className="px-3 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-zinc-500">Convert to</div>
          {['character', 'location', 'item', 'faction', 'custom'].filter((t) => t !== entity.type).map((t) => (
            <button
              key={t}
              className="w-full text-left pl-6 pr-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-2"
              onClick={() => {
                onClose()
                openConvertEntityDialog({
                  entityId,
                  entityName: entity.name,
                  entityColour: entity.colour || '#888888',
                  sourceType: entity.type,
                  targetType: t,
                })
              }}
            >
              <span className="w-4 text-center">{NODE_TYPE_ICONS[t]}</span>
              <span className="capitalize">{t}</span>
            </button>
          ))}
        </>
      )}
      {isOrigin && (
        <button
          className="w-full text-left px-3 py-1.5 text-red-400 hover:bg-zinc-700 flex items-center gap-2"
          onClick={() => { onClose(); onDelete(nodeId) }}
        >
          <span>🗑</span>
          Delete...
        </button>
      )}
      {isModifier && (
        <button
          className="w-full text-left px-3 py-1.5 text-red-400 hover:bg-zinc-700 flex items-center gap-2"
          onClick={() => { onClose(); deleteNode(nodeId) }}
        >
          <span>🗑</span>
          Delete modifier node
        </button>
      )}
    </div>
  )
}

// ── KnowledgeNodeContextMenu (Phase 8.4 — Knowledge→Entity convert) ──────
// The knowledge origin node had no context menu; this adds one whose only
// entry is the same "Convert to" block the entity origin node offers, so a
// Knowledge can be converted into an entity of any subtype (the target is
// chosen here, exactly as for entities). The knowledge-specific forks
// (population mode, forced losses) then live in the convert modal.

function KnowledgeNodeContextMenu({ nodeId, x, y, onClose }) {
  const menuRef = useRef(null)
  const openConvertEntityDialog = useUiStore((s) => s.openConvertEntityDialog)
  const nodes = useProjectStore((s) => s.nodes)
  const knowledges = useProjectStore((s) => s.knowledges)

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

  const node = nodes.find((n) => n.id === nodeId)
  const knowledgeId = node?.data?.knowledge_id
  const knowledge = knowledgeId ? (knowledges || []).find((k) => k.id === knowledgeId) : null
  if (!knowledge) return null

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-zinc-800 border border-zinc-600 rounded shadow-xl py-1 min-w-[180px] text-xs"
      style={{ left: x, top: y }}
    >
      <div className="px-3 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-zinc-500">Convert to</div>
      {['character', 'location', 'item', 'faction', 'custom'].map((t) => (
        <button
          key={t}
          className="w-full text-left pl-6 pr-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-2"
          onClick={() => {
            onClose()
            openConvertEntityDialog({
              sourceKind: 'knowledge',
              entityId: knowledgeId,
              entityName: knowledge.name,
              entityColour: knowledge.colour || '#888888',
              sourceType: 'knowledge',
              targetType: t,
            })
          }}
        >
          <span className="w-4 text-center">{NODE_TYPE_ICONS[t]}</span>
          <span className="capitalize">{t}</span>
        </button>
      ))}
    </div>
  )
}

// ── MultiSelectContextMenu (Phase 1.11 Track I) ──────────────────────────
// Shown when the user right-clicks a multi-selected node. Offers the two
// natural batch operations on a selection: wrap into a new group, or
// delete the whole set.

function MultiSelectContextMenu({ x, y, count, anchorNodeId, onClose }) {
  const menuRef = useRef(null)
  const createGroupFromSelection = useProjectStore((s) => s.createGroupFromSelection)
  const deleteSelectedNodes = useProjectStore((s) => s.deleteSelectedNodes)
  const alignSelectedNodes = useProjectStore((s) => s.alignSelectedNodes)
  const distributeSelectedNodes = useProjectStore((s) => s.distributeSelectedNodes)
  const nodes = useProjectStore((s) => s.nodes)
  const getEntityById = useEntitiesStore((s) => s.getEntityById)
  const openConvertEntityDialog = useUiStore((s) => s.openConvertEntityDialog)

  // Batch convert is offered only when EVERY selected node is a convertible
  // origin node of the SAME starting type (all one entity subtype, or all
  // knowledge). A mixed or partly-non-convertible selection shows no convert
  // option. Descriptor per node: { kind: 'entity'|'knowledge', type, id }.
  const batch = useMemo(() => {
    const selected = (nodes || []).filter((n) => n.selected)
    if (selected.length === 0) return null
    const descriptors = selected.map((n) => {
      if (n.type === 'entityNode' && !n.data?.is_modifier) {
        const ent = getEntityById(n.data?.entity_id)
        return ent ? { kind: 'entity', type: ent.type, id: ent.id } : null
      }
      if (n.type === 'knowledgeOriginNode') {
        return { kind: 'knowledge', type: 'knowledge', id: n.data?.knowledge_id }
      }
      return null
    })
    if (!descriptors.every(Boolean)) return null
    const type0 = descriptors[0].type
    if (!descriptors.every((d) => d.type === type0)) return null
    return { kind: descriptors[0].kind, sourceType: type0, ids: descriptors.map((d) => d.id) }
  }, [nodes, getEntityById])
  // Targets: entities get the other four subtypes; knowledge gets all five.
  const batchTargets = batch
    ? (batch.kind === 'knowledge'
        ? ['character', 'location', 'item', 'faction', 'custom']
        : ['character', 'location', 'item', 'faction', 'custom'].filter((t) => t !== batch.sourceType))
    : []
  // Hover-to-open state for the Align nodes submenu. Hovering the
  // "Align nodes" row opens the D-pad flyout; moving into the submenu
  // keeps it open (the wrapper div contains both the row and the
  // submenu so the mouse never leaves the wrapper). Phase 1.12c
  // v0.1.12.62.
  const [alignOpen, setAlignOpen] = useState(false)
  const [distributeOpen, setDistributeOpen] = useState(false)

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

  const handleAlign = (edge) => {
    alignSelectedNodes(edge, anchorNodeId)
    onClose()
  }

  const handleDistribute = (axis) => {
    distributeSelectedNodes(axis)
    onClose()
  }
  // Distribute is only meaningful with 3+ nodes selected — two
  // endpoints don't leave anything to space in between. Dim the row
  // + disable the flyout when the selection is too small.
  const canDistribute = count >= 3

  // Title for the Align entry — tells the user whether the operation
  // will anchor to the right-clicked node or fall back to the extreme
  // among selected, so the behaviour isn't silently mode-dependent.
  const alignTitle = anchorNodeId
    ? 'Align selected nodes to the right-clicked node\'s edge.'
    : 'Align selected nodes to the extreme edge among the selection.'

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-zinc-800 border border-zinc-600 rounded shadow-xl py-1 min-w-[200px] text-xs"
      style={{ left: x, top: y }}
    >
      <div className="px-3 py-1 text-[10px] text-zinc-500 uppercase tracking-wide border-b border-zinc-700 mb-1">
        {count} nodes selected
      </div>
      <button
        className="w-full text-left px-3 py-1.5 text-zinc-200 hover:bg-zinc-700 flex items-center gap-2"
        onClick={() => { createGroupFromSelection(); onClose() }}
      >
        <span className="text-zinc-500">⬚</span>
        Create New Group
      </button>

      {batch && (
        <>
          <div className="px-3 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-zinc-500">
            Convert {batch.ids.length} {batch.sourceType}{batch.ids.length === 1 ? '' : 's'} to
          </div>
          {batchTargets.map((t) => (
            <button
              key={t}
              className="w-full text-left pl-6 pr-3 py-1.5 text-zinc-200 hover:bg-zinc-700 flex items-center gap-2"
              onClick={() => {
                onClose()
                openConvertEntityDialog({
                  batch: true,
                  batchIds: batch.ids,
                  batchCount: batch.ids.length,
                  sourceKind: batch.kind,
                  sourceType: batch.sourceType,
                  targetType: t,
                  entityName: `${batch.ids.length} ${batch.sourceType}${batch.ids.length === 1 ? '' : 's'}`,
                  entityColour: '#888888',
                })
              }}
            >
              <span className="w-4 text-center">{NODE_TYPE_ICONS[t]}</span>
              <span className="capitalize">{t}</span>
            </button>
          ))}
        </>
      )}

      {/* Align nodes — hover opens a D-pad submenu to the right.
          The wrapper div is the hover target for BOTH the row and
          the submenu so crossing into the submenu keeps it open. */}
      <div
        className="relative"
        onMouseEnter={() => setAlignOpen(true)}
        onMouseLeave={() => setAlignOpen(false)}
      >
        <button
          className={`w-full text-left px-3 py-1.5 text-zinc-200 flex items-center gap-2 ${
            alignOpen ? 'bg-zinc-700' : 'hover:bg-zinc-700'
          }`}
          title={alignTitle}
          type="button"
        >
          <span className="text-zinc-500">⊞</span>
          Align nodes
          <span className="ml-auto text-zinc-500">›</span>
        </button>
        {alignOpen && (
          <div
            className="absolute bg-zinc-800 border border-zinc-600 rounded shadow-xl p-1.5"
            // Flush-left against the parent row (left: 100%) so the
            // cursor crosses from row to submenu without passing over
            // empty space.
            style={{ left: '100%', top: 0 }}
          >
            <div
              className="grid gap-1"
              style={{ gridTemplateColumns: 'repeat(3, 24px)', gridTemplateRows: 'repeat(3, 24px)' }}
            >
              {/* Row 1: empty, top, empty */}
              <div />
              <button
                type="button"
                onClick={() => handleAlign('top')}
                title="Align top edges"
                className="flex items-center justify-center text-zinc-200 hover:bg-zinc-700 rounded text-sm leading-none"
              >
                ↑
              </button>
              <div />
              {/* Row 2: left, center dot, right */}
              <button
                type="button"
                onClick={() => handleAlign('left')}
                title="Align left edges"
                className="flex items-center justify-center text-zinc-200 hover:bg-zinc-700 rounded text-sm leading-none"
              >
                ←
              </button>
              <div className="flex items-center justify-center text-zinc-600 text-[10px] leading-none">·</div>
              <button
                type="button"
                onClick={() => handleAlign('right')}
                title="Align right edges"
                className="flex items-center justify-center text-zinc-200 hover:bg-zinc-700 rounded text-sm leading-none"
              >
                →
              </button>
              {/* Row 3: empty, bottom, empty */}
              <div />
              <button
                type="button"
                onClick={() => handleAlign('bottom')}
                title="Align bottom edges"
                className="flex items-center justify-center text-zinc-200 hover:bg-zinc-700 rounded text-sm leading-none"
              >
                ↓
              </button>
              <div />
            </div>
          </div>
        )}
      </div>

      {/* Distribute nodes — hover opens a small flyout with two
          buttons (horizontal / vertical). Same wrapper pattern as
          the Align submenu so crossing from the row into the flyout
          keeps it open. Phase 1.12c v0.1.12.64. */}
      <div
        className="relative"
        onMouseEnter={() => { if (canDistribute) setDistributeOpen(true) }}
        onMouseLeave={() => setDistributeOpen(false)}
      >
        <button
          type="button"
          disabled={!canDistribute}
          className={`w-full text-left px-3 py-1.5 flex items-center gap-2 ${
            canDistribute
              ? (distributeOpen ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-200 hover:bg-zinc-700')
              : 'text-zinc-600 cursor-not-allowed'
          }`}
          title={canDistribute
            ? 'Distribute selected nodes evenly along an axis. The first and last node stay put; the rest slide into equal gaps.'
            : 'Select at least 3 nodes to distribute.'}
        >
          <span className="text-zinc-500">⇹</span>
          Distribute nodes
          <span className="ml-auto text-zinc-500">›</span>
        </button>
        {canDistribute && distributeOpen && (
          <div
            className="absolute bg-zinc-800 border border-zinc-600 rounded shadow-xl p-1 flex flex-col gap-0.5"
            style={{ left: '100%', top: 0, minWidth: 160 }}
          >
            <button
              type="button"
              onClick={() => handleDistribute('horizontal')}
              title="Distribute horizontally — equal gaps along the x-axis"
              className="text-left px-3 py-1.5 text-zinc-200 hover:bg-zinc-700 rounded flex items-center gap-2 text-xs"
            >
              <span className="text-zinc-500">↔</span>
              Horizontally
            </button>
            <button
              type="button"
              onClick={() => handleDistribute('vertical')}
              title="Distribute vertically — equal gaps along the y-axis"
              className="text-left px-3 py-1.5 text-zinc-200 hover:bg-zinc-700 rounded flex items-center gap-2 text-xs"
            >
              <span className="text-zinc-500">↕</span>
              Vertically
            </button>
          </div>
        )}
      </div>

      <button
        className="w-full text-left px-3 py-1.5 text-red-400 hover:bg-zinc-700 flex items-center gap-2"
        onClick={() => { deleteSelectedNodes(); onClose() }}
      >
        <span>✕</span>
        Delete Selected
      </button>
    </div>
  )
}

// ── CanvasContextMenu ─────────────────────────────────────────────────────────
// Thin positioned wrapper around the shared `AddNodesMenuBody`. Handles
// outside-click / Escape dismissal; all button content lives in the
// shared body so this menu and the toolbar `+` dropdown can't drift.

function CanvasContextMenu({ x, y, flowPosition, onClose }) {
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
      data-help-region="add-nodes-menu:menu"
      className="fixed z-50 bg-zinc-800 border border-zinc-600 rounded shadow-xl py-1 min-w-[200px] text-xs"
      style={{ left: x, top: y }}
    >
      <AddNodesMenuBody flowPosition={flowPosition} onClose={onClose} />
    </div>
  )
}

// ── Canvas ────────────────────────────────────────────────────────────────────

function CanvasInner() {
  const nodes = useProjectStore((s) => s.nodes)
  const edges = useProjectStore((s) => s.edges)
  const knowledges = useProjectStore((s) => s.knowledges)

  // Phase 8.2 — wire-visibility filter. `displayEdges` applies the active mode
  // by hiding non-matching edges (view-only; store edges untouched). 'all'
  // returns the same array (no churn). 'chosen' shows only the checked wire
  // types (POV / narrative / concept; relationship counts as narrative).
  // 'selection_chosen' also shows the focused object's wires (entity /
  // relationship / knowledge in the detail panel, else the selected node).
  const wireVisibilityMode = useUiStore((s) => s.wireVisibilityMode)
  const wireVisibilityTypes = useUiStore((s) => s.wireVisibilityTypes)
  const wireSelNodeId = useUiStore((s) => s.singleSelectedNodeId)
  const wireDetailEntityId = useUiStore((s) => s.detailPanelEntityId)
  const wireActiveSelection = useUiStore((s) => s.activeSelection)
  const displayEdges = useMemo(() => {
    const m = wireVisibilityMode
    if (m === 'all') return edges
    if (m === 'hide') return edges.map((e) => ({ ...e, hidden: true }))
    // Classify each edge into one of the three checkbox wire types. POV wins
    // over everything; concept edges are their own kind; transition and
    // relationship wires both count as narrative.
    const typeOf = (e) => {
      if (e.data?.is_pov_path) return 'pov'
      if (e.type === 'conceptEdge' || e.data?.kind === 'concept') return 'concept'
      return 'narrative'
    }
    const types = wireVisibilityTypes || {}
    const typeShown = (e) => !!types[typeOf(e)]
    if (m === 'chosen') return edges.map((e) => ({ ...e, hidden: !typeShown(e) }))
    // 'selection_chosen': resolve the "selection" predicate (focused object
    // first, then node), then show the selection's wires OR any checked type.
    let sel = null
    if (wireDetailEntityId) {
      const eid = wireDetailEntityId
      sel = (e) => e.data?.source_entity_id === eid || e.data?.target_entity_id === eid
        || e.data?.entity_a_id === eid || e.data?.entity_b_id === eid
    } else if (wireActiveSelection?.kind === 'relationship') {
      const rid = wireActiveSelection.id
      sel = (e) => e.data?.relationship_id === rid
    } else if (wireActiveSelection?.kind === 'knowledge') {
      const kid = wireActiveSelection.id
      sel = (e) => e.data?.knowledge_id === kid
    } else if (wireSelNodeId) {
      const nid = wireSelNodeId
      sel = (e) => e.source === nid || e.target === nid
    }
    if (m === 'selection_chosen') {
      return edges.map((e) => ({ ...e, hidden: !((sel && sel(e)) || typeShown(e)) }))
    }
    return edges
  }, [edges, wireVisibilityMode, wireVisibilityTypes, wireSelNodeId, wireDetailEntityId, wireActiveSelection])
  const storyOrder = useStoryOrder()
  const accentColor = useAccentColor() || '#7c3aed'
  // Entity bucket subscriptions — feed the MiniMap colour-map memo
  // below so it properly invalidates when an entity's baseline (or
  // any other property) changes. The previous pattern read
  // `useEntitiesStore.getState()` inside the per-node callback which
  // didn't subscribe; entity edits silently didn't refresh the
  // minimap until something else triggered a Canvas re-render.
  const _characters = useEntitiesStore((s) => s.characters)
  const _locations = useEntitiesStore((s) => s.locations)
  const _items = useEntitiesStore((s) => s.items)
  const _factions = useEntitiesStore((s) => s.factions)
  const _customs = useEntitiesStore((s) => s.customs)

  // ── OS-file drop overlay state ──────────────────────────────────────────
  // Mirrors the chat composer's two-tier signal (see ConversationView.jsx):
  //   - fileDragInWindow: a file drag is in progress somewhere in the
  //     window. Document-level listeners gate on `dataTransfer.types`
  //     including the literal 'Files' so internal entity / knowledge
  //     library drags don't trigger it. Drives the at-rest overlay.
  //   - dragOverCanvas: the cursor is over the canvas surface itself.
  //     Drives the stronger "Drop to create a media reference" treatment.
  const [fileDragInWindow, setFileDragInWindow] = useState(false)
  const [dragOverCanvas, setDragOverCanvas] = useState(false)
  const canvasDragDepth = useRef(0)
  // Rejection messages from invalid file drops are routed through the
  // app-wide `transientAlert` slot in uiStore so the canvas drop and
  // the chat composer drop share one canonical banner (rendered by
  // `TransientAlertBanner` at the top of the app).
  const showTransientAlert = useUiStore((s) => s.showTransientAlert)
  useEffect(() => {
    function isFileDrag(e) {
      const types = Array.from(e?.dataTransfer?.types || [])
      return types.includes('Files')
    }
    function onDragEnter(e) {
      if (!isFileDrag(e)) return
      setFileDragInWindow(true)
    }
    function onDragLeave(e) {
      // `relatedTarget` is null only when the drag actually leaves
      // the window (vs moving between two elements inside it).
      if (e.relatedTarget != null) return
      setFileDragInWindow(false)
    }
    function onEnd() {
      setFileDragInWindow(false)
      setDragOverCanvas(false)
      canvasDragDepth.current = 0
      // Phase 2.5g — also clear the avatar-drop hover counter in
      // case an inner drop target's stopPropagation-then-handle
      // pipeline left the counter unbalanced (the drop terminates
      // the drag operation regardless of where it landed).
      try { useUiStore.getState().resetAvatarDropOver() } catch { /* never break drag cleanup */ }
    }
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragleave', onDragLeave)
    // Capture phase for `drop` / `dragend` so this cleanup fires
    // BEFORE inner avatar drop handlers can `stopPropagation()` and
    // would otherwise prevent it from running. Without capture, a
    // drop on an avatar leaves `dragOverCanvas` stuck true and the
    // canvas overlay stays on screen forever.
    document.addEventListener('drop', onEnd, true)
    document.addEventListener('dragend', onEnd, true)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onEnd, true)
      document.removeEventListener('dragend', onEnd, true)
    }
  }, [])

  // Phase 2.5g — when any avatar drop target is currently being
  // hovered, suppress the canvas-wide "Drop to create a media
  // reference" overlay. The avatar paints its own dashed outline,
  // which is the truthful affordance for that drop; the canvas
  // overlay's text would mislead the writer about where the file
  // is going.
  const avatarDropOverCount = useUiStore((s) => s.avatarDropOverCount)
  // MCP session edit-lock — true while an MCP session is active.
  // Disables canvas EDIT interactions (drag, connect, drop,
  // context menus) while keeping pan/zoom/scroll alive so the user
  // can still observe the canvas updates the AI is making.
  const isMcpEditLocked = useMcpControlStore((s) => s.sessionState === 'active')
  // Minimap position-number overlay: origin nodes (entity origin,
  // knowledge / relationship / POV origins) get 0; sceneNodes get
  // their 1-based index in the global story order; everything else
  // (modifiers, references, group containers) goes unnumbered.
  const minimapPositionByNodeId = useMemo(() => {
    const map = new Map()
    const nodeById = new Map(nodes.map((n) => [n.id, n]))
    // Walk the story order in sequence and increment ONLY when the node
    // is a sceneNode — origins are interleaved into orderedIds but we
    // collectively label them 0, so scene N+1 should follow scene N
    // numerically regardless of how many origins sit between them.
    let sceneCount = 0
    for (const id of storyOrder.orderedIds) {
      const node = nodeById.get(id)
      if (node?.type === 'sceneNode') {
        sceneCount += 1
        map.set(id, sceneCount)
      }
    }
    // All origins share label 0.
    for (const n of nodes) {
      if (n.type === 'entityNode' && !n.data?.is_modifier) map.set(n.id, 0)
      else if (n.type === 'knowledgeOriginNode' || n.type === 'relationshipOriginNode' || n.type === 'povOriginNode') map.set(n.id, 0)
    }
    return map
  }, [storyOrder, nodes])
  // Origin nodes use a LEFT-edge stripe; modifier entity nodes use a
  // TOP-edge stripe so they read distinctly on the minimap. All other
  // node types fall back to 'left' (only matters when nodeStrokeColor
  // returns a colour, which today is gated on entityNode anyway).
  const minimapStripeSideByNodeId = useMemo(() => {
    const map = new Map()
    for (const n of nodes) {
      if (n.type === 'entityNode') {
        map.set(n.id, n.data?.is_modifier ? 'top' : 'left')
      }
    }
    return map
  }, [nodes])
  // Phase 3.7 perf fix (large-project load perf — Fix #13): keep the
  // `nodeComponent` identity stable forever. The two maps below feed
  // it via refs, so map rebuilds don't trigger a `nodeComponent`
  // identity change — which would otherwise force React Flow to
  // unmount + re-mount every minimap node. Profile capture
  // `profiling-data.2026-06-06.11-42-19.json` showed 3 separate
  // commits with 289 ADD + 289 REMOVE of `MinimapLeftEdgeNode`,
  // totalling 6.2 s of blocking commit-phase work during a single
  // project load.
  const minimapPositionRef = useRef(minimapPositionByNodeId)
  const minimapStripeSideRef = useRef(minimapStripeSideByNodeId)
  minimapPositionRef.current = minimapPositionByNodeId
  minimapStripeSideRef.current = minimapStripeSideByNodeId
  const minimapNodeComponent = useMemo(
    () => makeMinimapNodeComponent(minimapPositionRef, minimapStripeSideRef),
    // Stable identity for the lifetime of this Canvas instance — refs
    // give the component access to the latest maps without changing
    // its identity.
     
    [],
  )

  // Per-node minimap fill + stroke colour maps — built once per
  // [nodes, edges, knowledges, entity-bucket] change so the MiniMap's
  // colour callbacks become O(1) map lookups rather than per-node
  // graph walks on every pan/zoom tick. Previous implementation ran
  // `computeEffectiveState` per entity-node per minimap render
  // (Perf #3). Reads the same inputs the inline callbacks did; the
  // entity-bucket subscriptions above guarantee proper invalidation
  // when an entity baseline changes (the old `getState()`-snapshot
  // pattern silently went stale until something else re-rendered).
  const minimapNodeColorById = useMemo(() => {
    const map = new Map()
    const povColor = getPovColor()
    for (const n of nodes) {
      let colour
      if (n.type === 'povOriginNode') colour = povColor
      else if (n.type === 'referenceNode') colour = n.data?.colour || '#71717a'
      else if (n.type === 'entityNode') colour = n.data?.is_modifier ? '#fbbf24' : '#4ade80'
      else if (n.type === 'knowledgeOriginNode') {
        const k = (knowledges || []).find((x) => x.id === n.data?.knowledge_id)
        colour = k?.colour || KNOWLEDGE_COLOUR
      }
      else if (n.type === 'relationshipOriginNode') colour = '#a78bfa'
      else colour = '#a855f7'
      map.set(n.id, colour)
    }
    return map
  }, [nodes, knowledges])

  const minimapNodeStrokeColorById = useMemo(() => {
    const map = new Map()
    const entStore = useEntitiesStore.getState()
    for (const n of nodes) {
      if (n.type === 'entityNode' && n.data?.entity_id) {
        const ent = entStore.getEntityById(n.data.entity_id)
        if (ent) {
          const eff = computeEffectiveState(ent, nodes, edges, n.id)
          map.set(n.id, eff?.colour || ent.colour || 'transparent')
          continue
        }
      }
      map.set(n.id, 'transparent')
    }
    return map
  }, [nodes, edges, _characters, _locations, _items, _factions, _customs])

  // Stable lambda refs for MiniMap. Without these, the inline arrows
  // passed to `<MiniMap nodeColor / nodeStrokeColor>` were new functions
  // every render, which forced `MiniMap` + `MiniMapNodes` to re-render
  // on every parent commit. Profile capture (Phase 2.11 Bugs & Fixes)
  // cited `Props changed: [nodeColor, nodeStrokeColor]` as the reason
  // every time. Now the lambdas only change when the underlying colour
  // maps do.
  const minimapNodeColor = useCallback(
    (n) => minimapNodeColorById.get(n.id) || '#a855f7',
    [minimapNodeColorById],
  )
  const minimapNodeStrokeColor = useCallback(
    (n) => minimapNodeStrokeColorById.get(n.id) || 'transparent',
    [minimapNodeStrokeColorById],
  )

  const showMinimap = useProjectStore((s) => s.showMinimap)
  const toggleMinimap = useProjectStore((s) => s.toggleMinimap)
  // Resizable minimap (UI preference, persisted to localStorage like the
  // other resizable panels). Drag the top-left corner handle to grow or
  // shrink it. React Flow re-projects the whole graph into whatever box we
  // give it, so a wide-and-short box is how very wide projects escape the
  // "thin sliver in a big empty rectangle" framing.
  const [minimapDims, setMinimapDims] = useState(() => {
    const w = parseInt(localStorage.getItem('nn_minimapW') || '', 10)
    const h = parseInt(localStorage.getItem('nn_minimapH') || '', 10)
    return {
      w: Number.isFinite(w) && w >= MINIMAP_MIN_W ? w : MINIMAP_MIN_W,
      h: Number.isFinite(h) && h >= MINIMAP_MIN_H ? h : MINIMAP_MIN_H,
    }
  })
  // The resize handle lives INSIDE the minimap element (rendered there via a
  // portal) so it counts as part of the minimap for hover purposes: hovering
  // the handle does NOT fire the minimap's mouseleave, so it can't flicker.
  // Shown while the pointer is over the minimap, or while actively resizing.
  const [minimapEl, setMinimapEl] = useState(null)
  const [minimapHover, setMinimapHover] = useState(false)
  const [minimapResizing, setMinimapResizing] = useState(false)
  // Custom accent outline of the current viewport, drawn as a div portaled
  // into the minimap. React Flow's built-in mask stroke can't outline just
  // the viewport (it also stripes the minimap's own edges), so we draw our
  // own rectangle and size it imperatively, costing nothing in React.
  const viewportOutlineRef = useRef(null)
  const snapToGrid = useProjectStore((s) => s.snapToGrid)
  const toggleSnapToGrid = useProjectStore((s) => s.toggleSnapToGrid)
  const snapAllNodesToGrid = useProjectStore((s) => s.snapAllNodesToGrid)
  const reorganizeCanvas = useProjectStore((s) => s.reorganizeCanvas)
  const confirm = useConfirm()
  const onNodesChange = useProjectStore((s) => s.onNodesChange)
  const onEdgesChange = useProjectStore((s) => s.onEdgesChange)
  const onConnect = useProjectStore((s) => s.onConnect)
  const undo = useProjectStore((s) => s.undo)
  const redo = useProjectStore((s) => s.redo)
  const deleteNode = useProjectStore((s) => s.deleteNode)
  const setDetailPanel  = useUiStore((s) => s.setDetailPanel)
  const clearDetailPanel = useUiStore((s) => s.clearDetailPanel)
  const openRelationshipDetail = useUiStore((s) => s.openRelationshipDetail)
  const openKnowledgeDetail    = useUiStore((s) => s.openKnowledgeDetail)
  const openReferenceDetail    = useUiStore((s) => s.openReferenceDetail)
  const setSingleSelectedNodeId = useUiStore((s) => s.setSingleSelectedNodeId)

  const addModifierEntityNode = useProjectStore((s) => s.addModifierEntityNode)
  const addEntityNodeToCanvas = useProjectStore((s) => s.addEntityNodeToCanvas)
  const countEntityChips = useProjectStore((s) => s.countEntityChips)
  const deleteObject = useProjectStore((s) => s.deleteObject)
  const { screenToFlowPosition, getViewport, setViewport, setCenter, fitView, getNodes } = useReactFlow()
  const updateNodeInternals = useUpdateNodeInternals()

  // Vite HMR safety net: after Fast Refresh swaps a node-component module,
  // React Flow's internal handle-position cache survives the remount but
  // the new DOM may have shifted handle offsets. Without a re-measure
  // edges keep drawing to the OLD coordinates and visually detach from
  // their chips. `vite:afterUpdate` fires after every HMR cycle; we
  // schedule one `updateNodeInternals(id)` per current node so all
  // handles get re-measured against the freshly-rendered DOM. The whole
  // effect compiles out in production because `import.meta.hot` is
  // undefined there.
  useEffect(() => {
    if (!import.meta.hot) return undefined
    function reanchorAll() {
      requestAnimationFrame(() => {
        for (const n of getNodes()) updateNodeInternals(n.id)
      })
    }
    import.meta.hot.on('vite:afterUpdate', reanchorAll)
    return () => {
      import.meta.hot?.off?.('vite:afterUpdate', reanchorAll)
    }
  }, [getNodes, updateNodeInternals])

  const consumePendingFitView = useProjectStore((s) => s.consumePendingFitView)
  const setGetViewportCenter = useUiStore((s) => s.setGetViewportCenter)
  const setFocusNode = useUiStore((s) => s.setFocusNode)
  const setFitViewToNodes = useUiStore((s) => s.setFitViewToNodes)
  const deleteDialog = useUiStore((s) => s.deleteEntityDialog)
  const openDeleteEntityDialog = useUiStore((s) => s.openDeleteEntityDialog)
  const closeDeleteEntityDialog = useUiStore((s) => s.closeDeleteEntityDialog)
  const convertDialog = useUiStore((s) => s.convertEntityDialog)
  const closeConvertEntityDialog = useUiStore((s) => s.closeConvertEntityDialog)
  const convertEntityType = useProjectStore((s) => s.convertEntityType)
  const convertKnowledgeToEntity = useProjectStore((s) => s.convertKnowledgeToEntity)
  const convertEntitiesBatch = useProjectStore((s) => s.convertEntitiesBatch)
  const convertKnowledgesBatch = useProjectStore((s) => s.convertKnowledgesBatch)
  const [contextMenu, setContextMenu] = useState(null)
  // Wrapper ref for the capture-phase wheel listener that implements
  // the Phase 1.12c mousewheel swap: plain scroll zooms (React Flow
  // default when `panOnScroll={false}`), and Ctrl+scroll pans the
  // viewport — the inverse of React Flow's stock behaviour. The
  // listener runs before RF's internal wheel handler via capture
  // phase + preventDefault so the user's old muscle memory for
  // Ctrl+scroll = pan is preserved.
  const canvasWrapperRef = useRef(null)

  // Locate the minimap element (to portal the handle into) and track hover
  // on it. The handle is a descendant of the minimap, so hovering the handle
  // does NOT fire the minimap's mouseleave: one hover flag, no flicker, no
  // grace-period hack needed. The element persists across resizes, so this is
  // keyed only on visibility.
  useEffect(() => {
    if (!showMinimap) { setMinimapEl(null); setMinimapHover(false); return undefined }
    const wrap = canvasWrapperRef.current
    if (!wrap) return undefined
    let mm = null
    const onEnter = () => setMinimapHover(true)
    const onLeave = () => setMinimapHover(false)
    const id = requestAnimationFrame(() => {
      mm = wrap.querySelector('.react-flow__minimap')
      if (!mm) return
      setMinimapEl(mm)
      mm.addEventListener('mouseenter', onEnter)
      mm.addEventListener('mouseleave', onLeave)
    })
    return () => {
      cancelAnimationFrame(id)
      if (mm) {
        mm.removeEventListener('mouseenter', onEnter)
        mm.removeEventListener('mouseleave', onLeave)
      }
      setMinimapEl(null)
    }
  }, [showMinimap])

  // Drag the top-left handle: on a bottom-right-anchored minimap, moving
  // up/left grows it. Clamped to the original static size (the minimum)
  // and the wrapper bounds; the size persists to localStorage on release.
  const onMinimapResizeStart = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    setMinimapResizing(true)
    const startX = e.clientX
    const startY = e.clientY
    const startW = minimapDims.w
    const startH = minimapDims.h
    const wrap = canvasWrapperRef.current
    const maxW = wrap ? Math.max(MINIMAP_MIN_W, wrap.clientWidth - 60) : 800
    const maxH = wrap ? Math.max(MINIMAP_MIN_H, wrap.clientHeight - 60) : 600
    const onMove = (ev) => {
      const w = Math.max(MINIMAP_MIN_W, Math.min(maxW, Math.round(startW + (startX - ev.clientX))))
      const h = Math.max(MINIMAP_MIN_H, Math.min(maxH, Math.round(startH + (startY - ev.clientY))))
      setMinimapDims({ w, h })
    }
    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      setMinimapResizing(false)
      setMinimapDims((d) => {
        try {
          localStorage.setItem('nn_minimapW', String(d.w))
          localStorage.setItem('nn_minimapH', String(d.h))
        } catch { /* localStorage unavailable/full - non-critical UI pref */ }
        return d
      })
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }, [minimapDims.w, minimapDims.h])

  // Project the current viewport rectangle into minimap pixels and size the
  // accent outline to it, clamped to the minimap so it never spills onto the
  // minimap's own edges. Reads React Flow's actual minimap viewBox (set on
  // the svg) so it stays exactly aligned with what the minimap draws.
  const updateViewportOutline = useCallback(() => {
    const el = viewportOutlineRef.current
    const wrap = canvasWrapperRef.current
    if (!el || !wrap) return
    const svg = el.parentElement?.querySelector('svg')
    const vb = svg?.viewBox?.baseVal
    if (!vb || !vb.width || !vb.height) return
    const elW = svg.width?.baseVal?.value || vb.width
    const elH = svg.height?.baseVal?.value || vb.height
    const vp = getViewport()
    if (!vp || !vp.zoom) return
    const sx = elW / vb.width
    const sy = elH / vb.height
    const fx = -vp.x / vp.zoom
    const fy = -vp.y / vp.zoom
    const fw = wrap.clientWidth / vp.zoom
    const fh = wrap.clientHeight / vp.zoom
    const x0 = Math.max(0, Math.min(elW, (fx - vb.x) * sx))
    const y0 = Math.max(0, Math.min(elH, (fy - vb.y) * sy))
    const x1 = Math.max(0, Math.min(elW, (fx + fw - vb.x) * sx))
    const y1 = Math.max(0, Math.min(elH, (fy + fh - vb.y) * sy))
    el.style.left = `${x0}px`
    el.style.top = `${y0}px`
    el.style.width = `${Math.max(0, x1 - x0)}px`
    el.style.height = `${Math.max(0, y1 - y0)}px`
  }, [getViewport])

  // Reposition the viewport outline when the minimap appears or is resized
  // (panning/zooming is handled live by the ReactFlow `onMove` handler).
  useEffect(() => {
    if (!minimapEl) return undefined
    const id = requestAnimationFrame(() => updateViewportOutline())
    return () => cancelAnimationFrame(id)
  }, [minimapEl, minimapDims.w, minimapDims.h, updateViewportOutline])

  // ── Minimap viewport-rectangle deferred drag ───────────────────────────
  // React Flow's `pannable` live-pans the main viewport on every pointermove,
  // which re-renders/repaints every visible node and edge each frame — the
  // minimap-drag stutter on large projects. Instead we own the interaction:
  // while dragging we move ONLY the viewport-outline rectangle (cheap) and
  // hide RF's dimming mask so a single rectangle tracks the cursor; the
  // viewport itself doesn't move until release, when we `setCenter` once (one
  // instant jump, nothing to re-render mid-drag). A plain click jumps the same
  // way — an ANIMATED recentre (duration > 0) would move the viewport every
  // frame for its whole duration, re-rendering/repainting the canvas the same
  // way a live pan does (clicking felt slower than dragging for exactly this
  // reason). Pointer capture means the drag tracks even past the minimap edge
  // and no stray click fires.
  useEffect(() => {
    const mm = minimapEl
    if (!mm) return undefined
    let active = false
    let mask = null

    // Map a client point to (flow point under cursor, minimap-local px),
    // clamped to the minimap, using the minimap SVG's viewBox<->pixel scale.
    const project = (clientX, clientY) => {
      const svg = mm.querySelector('svg')
      const vb = svg?.viewBox?.baseVal
      const rect = svg?.getBoundingClientRect()
      if (!svg || !vb || !vb.width || !vb.height || !rect || !rect.width || !rect.height) return null
      const px = Math.max(0, Math.min(rect.width, clientX - rect.left))
      const py = Math.max(0, Math.min(rect.height, clientY - rect.top))
      return {
        px,
        py,
        flowX: vb.x + (px / rect.width) * vb.width,
        flowY: vb.y + (py / rect.height) * vb.height,
      }
    }
    // Move the outline rectangle so its centre sits under the cursor (preview).
    const moveOutline = (clientX, clientY) => {
      const p = project(clientX, clientY)
      const el = viewportOutlineRef.current
      if (!p || !el) return p
      el.style.left = `${p.px - el.offsetWidth / 2}px`
      el.style.top = `${p.py - el.offsetHeight / 2}px`
      return p
    }
    const onDown = (e) => {
      if (e.button !== 0) return
      // The resize handle (top-left bracket) owns its own pointer drag.
      if (e.target?.closest?.('[data-minimap-resize]')) return
      active = true
      try { mm.setPointerCapture?.(e.pointerId) } catch { /* pointer may already be released */ }
      mask = mm.querySelector('.react-flow__minimap-mask')
      if (mask) mask.style.opacity = '0'
      moveOutline(e.clientX, e.clientY)
      e.preventDefault()
    }
    const onMove = (e) => {
      if (!active) return
      moveOutline(e.clientX, e.clientY)
    }
    const onUp = (e) => {
      if (!active) return
      active = false
      try { mm.releasePointerCapture?.(e.pointerId) } catch { /* already released */ }
      if (mask) { mask.style.opacity = ''; mask = null }
      const p = moveOutline(e.clientX, e.clientY)
      if (p) {
        // Instant jump (duration 0) for both click and drag-release. An
        // animated recentre re-renders/repaints the canvas every frame for
        // its whole duration, so a click felt slower than a drag; jumping in
        // one frame keeps both equally cheap.
        setCenter(p.flowX, p.flowY, { zoom: getViewport().zoom, duration: 0 })
        // Re-sync the outline to the committed viewport once the jump lands.
        requestAnimationFrame(() => updateViewportOutline())
      }
    }
    mm.addEventListener('pointerdown', onDown)
    mm.addEventListener('pointermove', onMove)
    mm.addEventListener('pointerup', onUp)
    mm.addEventListener('pointercancel', onUp)
    return () => {
      mm.removeEventListener('pointerdown', onDown)
      mm.removeEventListener('pointermove', onMove)
      mm.removeEventListener('pointerup', onUp)
      mm.removeEventListener('pointercancel', onUp)
    }
  }, [minimapEl, setCenter, getViewport, updateViewportOutline])
  const [nodeContextMenu, setNodeContextMenu] = useState(null)
  const [entityNodeCtxMenu, setEntityNodeCtxMenu] = useState(null)
  const [knowledgeNodeCtxMenu, setKnowledgeNodeCtxMenu] = useState(null)

  // Auto-migrate actively-playing reference-node media into the tray chip when
  // the node scrolls out of the viewport; migrate back inline on re-entry.
  useCanvasMediaAutoMigrate()

  // ── Phase 1.11 Track I — generic group drag snapshot ────────────────────
  // When the user drags a `genericGroupNode`'s header, every node fully
  // contained inside the box at drag-start must move with it by the same
  // delta atomically. Membership is frozen to the drag-start snapshot —
  // nodes the box sweeps over mid-drag are NOT picked up (prevents
  // inadvertent grabs). At drag-end the snapshot is cleared and normal
  // geometric derivation resumes on the next query.
  //
  // Implementation: on drag-start snapshot the group's start position AND
  // each currently-contained member's start position. On every drag tick
  // compute delta = currentGroupPos - groupStartPos, then rewrite each
  // member's position to memberStartPos + delta via a direct store set.
  // React Flow already moves the group itself via `onNodesChange`
  // position events, so we only need to parallel-update the members.
  const groupDragSnapshotRef = useRef(null)

  // Snap-aware wrapper around the store's `onNodesChange` — Phase
  // 1.12c v0.1.12.63.
  //
  // Only touches `type: 'position'` changes (drag moves). NarrativeNode's
  // custom nodes all handle resize via their own `NodeResizeControl
  // onResize` callbacks that call `updateNodeData({width, height})`
  // directly, bypassing `onNodesChange` — those callbacks read the
  // live `snapToGrid` flag via `useProjectStore.getState()` + apply
  // `applyResizeSnap` from `utils/snapUtils.js` at the call site,
  // so there's no resize branch to intercept here.
  //
  // Position rounding uses a half-cell offset so the snapped top-left
  // corner lands on a `<Background gap={20}>` dot (which draws dots
  // at the centre of each 20-px pattern cell).
  const handleNodesChange = useCallback((changes) => {
    if (!snapToGrid) { onNodesChange(changes); return }
    const snapped = changes.map((c) => {
      if (c.type === 'position' && c.position) {
        return {
          ...c,
          position: {
            x: snapPosition(c.position.x),
            y: snapPosition(c.position.y),
          },
          ...(c.positionAbsolute ? {
            positionAbsolute: {
              x: snapPosition(c.positionAbsolute.x),
              y: snapPosition(c.positionAbsolute.y),
            },
          } : {}),
        }
      }
      return c
    })
    onNodesChange(snapped)
  }, [snapToGrid, onNodesChange])

  // Snap button click handler — plain click toggles snap on/off,
  // Ctrl/Cmd+click triggers a one-shot "snap every node to the grid
  // right now" (positions to nearest dot, widths / heights rounded
  // UP to the next grid step so nothing gets smaller).
  const handleSnapButtonClick = useCallback((e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      e.stopPropagation()
      snapAllNodesToGrid()
      return
    }
    toggleSnapToGrid()
  }, [toggleSnapToGrid, snapAllNodesToGrid])

  // Reorganize-canvas click handler. Reorganization rewrites the
  // user's manual canvas layout — scenes pack inside their current
  // chapter in overall story order, entity origins land by first-
  // appearance, chapters widen as needed. No data is lost (Undo
  // restores the pre-reorganize layout in one step) but it's still
  // meaningful enough to warrant a confirm guard before firing.
  // Same store action the MCP `reorganize_canvas` tool routes
  // through.
  // Reorganize progress + chunked-measure state.
  //  - `forceRenderAll`: bypass viewport virtualization during the measure pass.
  //  - `measureWindow` ({start,size}): the batch of node indices currently
  //    revealed; the rest are hidden so each render stays small and the
  //    progress modal can repaint between batches.
  //  - `reorganizeProgress` ({phase,done,total}): drives the modal; null = idle.
  const [forceRenderAll, setForceRenderAll] = useState(false)
  const [measureWindow, setMeasureWindow] = useState(null)
  const [reorganizeProgress, setReorganizeProgress] = useState(null)
  // Nodes actually handed to React Flow. Normally the store nodes; during the
  // reorganize measure pass, only the current batch window is visible (the rest
  // hidden), and nothing renders if the window isn't set yet (avoids a one-shot
  // render-everything freeze when virtualization first flips off).
  const displayNodes = useMemo(() => {
    if (!forceRenderAll) return nodes
    if (!measureWindow) return []
    const { start, size } = measureWindow
    const end = start + size
    return nodes.map((n, i) => (i >= start && i < end ? n : { ...n, hidden: true }))
  }, [nodes, forceRenderAll, measureWindow])

  const handleReorganize = useCallback(async () => {
    const decision = await confirm({
      title: 'Reorganize canvas?',
      message: (
        'This will rearrange every scene and entity-origin node on the ' +
        'canvas. Scenes pack inside their current chapter in overall ' +
        'story order; entity origins land by first appearance; chapters ' +
        'widen as needed. Your wires, chapter order, and per-scene ' +
        'chapter assignments are preserved.\n\n' +
        'No data is lost — Undo restores the pre-reorganize layout.'
      ),
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Reorganize', value: 'ok', style: 'primary' },
      ],
      cancelValue: 'cancel',
    })
    if (decision !== 'ok') return
    // Reorganize needs every node's TRUE size (it stacks origin / reference
    // cards and packs scenes by width). Off-screen nodes are virtualized and
    // carry only a seed-size estimate, so the packer would overlap taller /
    // wider cards (knowledge origins, reference cards). Measure ALL nodes
    // first — but in BATCHES, yielding between them, so the work never blocks
    // the main thread in one burst and the progress modal can repaint. A modal
    // covers the canvas while the batches flicker through behind it.
    const all = useProjectStore.getState().nodes || []
    const total = all.length
    if (total === 0) { reorganizeCanvas(); return }
    const BATCH = 24
    // Wait for one batch to render + fully SETTLE before advancing. The packer
    // reads each node's height/width from `measuredDimensionsStore` (via
    // getMeasuredHeight/Width), so the batch isn't done until EVERY revealed
    // node has landed a real measurement there — not merely after a fixed 60 ms
    // (content-heavy self-measuring cards, e.g. character origins with long
    // attribute / relationship lists, render short first and grow after their
    // own headerRef measurement, so a fixed wait captured a too-short height and
    // the packer then stacked them with an overlap). We re-arm the quiet timer
    // on BOTH store-node churn and side-store measurement bumps, so a card's
    // self-reflow resets the countdown and we capture its SETTLED size. Capped
    // so a node that can never report a size can't hang the run.
    const settleBatch = (revealedIds) => new Promise((resolve) => {
      let quietTimer = null, capTimer = null, unsubStore = null, unsubDims = null, finished = false
      const finish = () => {
        if (finished) return
        finished = true
        if (quietTimer) clearTimeout(quietTimer)
        if (capTimer) clearTimeout(capTimer)
        if (unsubStore) unsubStore()
        if (unsubDims) unsubDims()
        resolve()
      }
      const allMeasured = () => revealedIds.every((id) => getMeasuredDimensions(id) != null)
      const arm = () => {
        if (quietTimer) clearTimeout(quietTimer)
        // Only complete the countdown once the whole batch is measured; if a
        // node is still mounting the quiet fires, finds it unmeasured, and
        // leaves us waiting for the next measurement to re-arm.
        quietTimer = setTimeout(() => { if (allMeasured()) finish() }, 100)
      }
      requestAnimationFrame(() => requestAnimationFrame(() => {
        capTimer = setTimeout(finish, 1500)
        unsubStore = useProjectStore.subscribe((state, prev) => {
          if (state.nodes !== prev.nodes) arm()
        })
        unsubDims = subscribeMeasuredDimensions(arm)
        arm()
      }))
    })
    setReorganizeProgress({ phase: 'measuring', done: 0, total })
    setForceRenderAll(true)
    try {
      for (let start = 0; start < total; start += BATCH) {
        setMeasureWindow({ start, size: BATCH })
        const revealedIds = all.slice(start, start + BATCH).map((n) => n.id)
        await settleBatch(revealedIds)
        setReorganizeProgress({ phase: 'measuring', done: Math.min(start + BATCH, total), total })
      }
      // Re-enable virtualization BEFORE arranging so the next render culls to
      // the viewport instead of mounting everything at once; the measurements
      // persist in `measuredDimensionsStore` (a module-level map, not cleared on
      // unmount), so the packer still reads true sizes after culling.
      setMeasureWindow(null)
      setForceRenderAll(false)
      setReorganizeProgress({ phase: 'arranging', done: total, total })
      // Let the modal paint the 'arranging' state before the synchronous pack.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      reorganizeCanvas()
    } finally {
      setForceRenderAll(false)
      setMeasureWindow(null)
      setReorganizeProgress(null)
    }
  }, [confirm, reorganizeCanvas])

  const handleNodeDragStart = useCallback((_, node) => {
    // Flip the global drag flag. `useStoryOrder` (and any other heavy
    // `s.nodes` consumer that opts in) checks this and short-circuits
    // to its cached result for the duration of the drag, so the 13-
    // tier graph walk doesn't fire on every drag frame. The flag
    // clears in `handleNodeDragStop`; the next render after stop
    // recomputes order against the final positions.
    useUiStore.getState().setIsDraggingNodes(true)

    const currentNodes = useProjectStore.getState().nodes
    // Figure out which groups need their members to follow this drag.
    // Two cases:
    //   (a) Dragging a group directly (whether or not it's part of a
    //       multi-selection): that group's members follow.
    //   (b) Dragging a non-group node while one or more groups ARE in
    //       the active multi-selection: every selected group's members
    //       follow. This lets the user drag any selected node to move
    //       the whole group-including selection atomically.
    const selectedGroups = currentNodes.filter((n) => n.type === 'genericGroupNode' && n.selected)
    const groupsToTrack = []
    if (node.type === 'genericGroupNode') {
      const dragged = currentNodes.find((n) => n.id === node.id)
      if (dragged) groupsToTrack.push(dragged)
    }
    for (const g of selectedGroups) {
      if (!groupsToTrack.some((t) => t.id === g.id)) groupsToTrack.push(g)
    }
    if (groupsToTrack.length === 0) return

    // Dedupe members across overlapping groups, and EXCLUDE any node that
    // is itself part of the current multi-selection — React Flow already
    // translates selected nodes as part of the drag, so double-moving
    // them would blow past the drag delta. Also exclude the dragged node
    // (it's being moved by React Flow's own drag-handling).
    const memberStartById = new Map()
    for (const group of groupsToTrack) {
      const members = getNodesInGroup(group, currentNodes, { excludeGroups: false })
      for (const m of members) {
        if (m.id === node.id) continue
        if (m.selected) continue
        if (memberStartById.has(m.id)) continue
        memberStartById.set(m.id, { x: m.position.x, y: m.position.y })
      }
    }
    if (memberStartById.size === 0) return

    groupDragSnapshotRef.current = {
      draggedNodeId: node.id,
      draggedStartPos: { x: node.position.x, y: node.position.y },
      members: Array.from(memberStartById.entries()).map(([id, startPos]) => ({ id, startPos })),
    }
  }, [])

  const handleNodeDrag = useCallback((_, node) => {
    const snap = groupDragSnapshotRef.current
    if (!snap || snap.draggedNodeId !== node.id) return
    // With snap-to-grid on, React Flow reports the raw (unsnapped) drag
    // position here, but the dragged group itself lands on the grid (its
    // position change is snapped in handleNodesChange). Move the members by the
    // SAME snapped delta, otherwise they track the raw cursor and drift
    // off-grid relative to the group as it moves. snapPosition matches the
    // group's actual stored position and is idempotent, so this is a no-op
    // when snap is off or the group is already grid-aligned.
    const snapOn = useProjectStore.getState().snapToGrid
    const curX = snapOn ? snapPosition(node.position.x) : node.position.x
    const curY = snapOn ? snapPosition(node.position.y) : node.position.y
    const dx = curX - snap.draggedStartPos.x
    const dy = curY - snap.draggedStartPos.y
    if (dx === 0 && dy === 0) return
    const memberStartById = new Map(snap.members.map((m) => [m.id, m.startPos]))
    useProjectStore.getState().applyGroupDragPositions(memberStartById, dx, dy)
  }, [])

  const handleNodeDragStop = useCallback((_, node) => {
    if (groupDragSnapshotRef.current?.draggedNodeId === node.id) {
      groupDragSnapshotRef.current = null
    }
    // Clear the global drag flag so heavy `s.nodes` consumers resume
    // recomputing. The next render (which already carries the final
    // position from the last drag frame's store update) runs the
    // story-order walk fresh against the dropped position so any
    // chapter / canvas-x reordering settles immediately on release.
    useUiStore.getState().setIsDraggingNodes(false)
    // Phase 4.3 multi-row — (1) straddle-snap the dropped node fully into one
    // row by its top edge (never sitting across a divider), then (2) re-fit the
    // affected rows (shrink/grow; rows below follow). Both no-op in single-row
    // mode and when nothing changed.
    const ps = useProjectStore.getState()
    ps.snapNodeToRowOnDrop(node.id)
    ps.refitRowsToContent()
  }, [])

  // Fit the camera onto all loaded nodes whenever a project is loaded.
  // Center the viewport on the single POV origin node at a medium zoom (1.0),
  // if one exists. Returns true when it focused, false when there's no POV
  // origin node so the caller can decide the fallback. The POV origin node is
  // small (200x140 seed); centering on its midpoint is exact enough even before
  // it's been measured at load time.
  const focusPovNode = useCallback((duration = 400) => {
    const pov = useProjectStore.getState().nodes.find((n) => n.type === 'povOriginNode')
    if (!pov) return false
    const w = pov.measured?.width ?? 200
    const h = pov.measured?.height ?? 140
    setCenter((pov.position?.x ?? 0) + w / 2, (pov.position?.y ?? 0) + h / 2, { zoom: 1.0, duration })
    return true
  }, [setCenter])

  // On load: recenter on the POV origin at medium zoom if present, else fall
  // back to fit-all so the loaded project is always visible (we don't persist
  // the user's last pan/zoom). Load actions in projectStore set
  // `_pendingFitView`; this waits for React Flow to have at least one node,
  // then focuses + clears the flag.
  const pendingFitView = useProjectStore((s) => s._pendingFitView)
  useEffect(() => {
    if (!pendingFitView) return
    if (nodes.length === 0) return
    consumePendingFitView()
    requestAnimationFrame(() => {
      if (!focusPovNode(0)) fitView({ padding: 0.2, duration: 0 })
    })
  }, [pendingFitView, nodes.length, consumePendingFitView, fitView, focusPovNode])

  // On a user mode-switch and after a reorganize: recenter on the POV origin
  // at medium zoom IF present; when absent, leave the viewport alone (no
  // fallback, unlike load). Driven by the monotonic `_pendingPovFocus` counter
  // bumped by `setCanvasLayoutMode` (user-initiated) and `reorganizeCanvas`.
  const pendingPovFocus = useProjectStore((s) => s._pendingPovFocus)
  useEffect(() => {
    if (!pendingPovFocus) return
    requestAnimationFrame(() => { focusPovNode(400) })
  }, [pendingPovFocus, focusPovNode])

  // Register viewport center callback so other components can place nodes at the viewport center
  useEffect(() => {
    setGetViewportCenter(() => {
      const vp = getViewport()
      // Convert the screen center to flow coordinates.
      // Also expose the viewport dimensions in flow units + the zoom
      // factor so callers that need to centre a node (and account for
      // its width/height at the current zoom) can do so without having
      // to reach back into React Flow themselves. Extra fields are
      // additive — existing consumers using `{x, y}` are unaffected.
      const w = window.innerWidth
      const h = window.innerHeight
      return {
        x: (-vp.x + w / 2) / vp.zoom,
        y: (-vp.y + h / 2) / vp.zoom,
        widthFlow:  w / vp.zoom,
        heightFlow: h / vp.zoom,
        zoom:       vp.zoom,
      }
    })
  }, [getViewport, setGetViewportCenter])

  // Register focus-node callback so components outside ReactFlow can navigate to a node
  useEffect(() => {
    setFocusNode((nodeId) => {
      fitView({ nodes: [{ id: nodeId }], duration: 400, padding: 0.5 })
    })
    setFitViewToNodes((nodeIds, opts = {}) => {
      const list = (nodeIds || []).filter(Boolean).map((id) => ({ id }))
      if (list.length === 0) return
      fitView({
        nodes: list,
        duration: opts.duration ?? 400,
        padding: opts.padding ?? 0.18,
      })
    })
  }, [fitView, setFocusNode, setFitViewToNodes])

  // ── Local-dev test API (no security concern in a desktop app) ────
  // Exposes a small set of canvas-driving helpers on `window.__nn` so
  // external automation (the Playwright capture tool at
  // `.Tools/help-screenshots/`) can frame screenshots without asking
  // the writer to pan / zoom by hand. The API is intentionally tiny
  // and read-only-by-default — no destructive operations.
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.__nn = {
      // Record of the last node id focused via this API. The
      // Playwright capture tool reads `window.__nn.__lastFocusId`
      // immediately after calling `focusNodeById` (or the helpers
      // that wrap it) so it can build a `[data-id="<id>"]` locator
      // for an element-bounded screenshot.
      __lastFocusId: null,
      // Frame the viewport on one node, identified by id (e.g.
      // `await window.__nn.focusNodeById('<uuid>', 0.4)`).
      focusNodeById: (id, padding = 0.5) => {
        if (!id) return
        window.__nn.__lastFocusId = id
        fitView({ nodes: [{ id }], duration: 0, padding })
      },
      // Frame the viewport on multiple nodes.
      fitNodes: (ids, padding = 0.18) => {
        const list = (ids || []).filter(Boolean).map((nid) => ({ id: nid }))
        if (list.length === 0) return
        fitView({ nodes: list, duration: 0, padding })
      },
      // Fit ALL nodes.
      fitAll: (padding = 0.1) => fitView({ duration: 0, padding }),
      // Direct viewport setter — for tests that want pixel-precise
      // pan / zoom.
      setViewport: (vp) => setViewport(vp),
      getViewport: () => getViewport(),
      // Read-only project introspection. Useful for tests that need
      // to look up a node id by title / type / entity_id.
      getNodes: () => getNodes(),
      findNode: (predicate) => getNodes().find(predicate),
      // Find a SceneNode by its title.
      findSceneByTitle: (title) => getNodes().find(
        (n) => n.type === 'sceneNode' && (n.data?.title || '').trim() === title,
      ),
      // Find an entity-origin EntityNode by the underlying entity's name.
      findEntityOriginByName: (name) => {
        // Need to look up the entity by name first — entity name
        // lives in the entities store, not on the node's data.
        const story = useProjectStore.getState().story
        const buckets = story?.entities || {}
        let entityId = null
        for (const bucket of Object.values(buckets)) {
          if (!Array.isArray(bucket)) continue
          const ent = bucket.find((e) => e?.name === name)
          if (ent) { entityId = ent.id; break }
        }
        if (!entityId) return null
        return getNodes().find(
          (n) => n.type === 'entityNode'
            && !n.data?.is_modifier
            && n.data?.entity_id === entityId,
        )
      },
    }
    return () => {
      try { delete window.__nn } catch { /* ignore */ }
    }
  }, [fitView, setViewport, getViewport, getNodes])

  // ── Phase 1.12c v0.1.12.59 — mousewheel behaviour swap ─────────
  // React Flow's stock behaviour with `panOnScroll={true}` was:
  // plain scroll pans, Ctrl+scroll zooms. User requested the
  // inverse: plain scroll zooms, Ctrl+scroll pans. With
  // `panOnScroll={false}` (removed below), plain scroll already
  // zooms via RF's `zoomOnScroll` default — but Ctrl+scroll keeps
  // zooming too, which we don't want. This capture-phase wheel
  // listener intercepts Ctrl+wheel BEFORE RF's internal handler
  // runs, prevents the default, and pans the viewport directly
  // via `setViewport`. Plain wheel events (no Ctrl) fall through
  // untouched so RF's native zoom path runs normally.
  //
  // Notes:
  //  - `{ capture: true, passive: false }` — capture beats RF's
  //    listener which is attached later on a descendant, and
  //    passive:false lets us preventDefault on ctrl+wheel (which
  //    browsers otherwise block as a page-zoom gesture).
  //  - deltaY maps to viewport Y inversely: scrolling the wheel
  //    down means the content scrolls up relative to the user, so
  //    the viewport y offset DECREASES. Same sign as RF's old
  //    `panOnScroll` behaviour so muscle memory is preserved.
  //  - deltaX (horizontal wheel / touchpad) preserved symmetrically.
  useEffect(() => {
    const wrapper = canvasWrapperRef.current
    if (!wrapper) return undefined
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return  // let RF zoom
      e.preventDefault()
      e.stopPropagation()
      const vp = getViewport()
      setViewport({
        x: vp.x - e.deltaX,
        y: vp.y - e.deltaY,
        zoom: vp.zoom,
      })
    }
    wrapper.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => wrapper.removeEventListener('wheel', onWheel, { capture: true })
  }, [getViewport, setViewport])

  // ── Phase 1.12c v0.1.12.65 — spacebar grab-pan ─────────────────
  //
  // Holding Space turns the cursor into a canvas grab tool: any
  // subsequent pointer motion pans the viewport, WITHOUT requiring
  // the user to hold a mouse button. Works both when idle (no wire,
  // no LMB) and when a wire is actively being dragged (LMB held
  // from a source handle). Release Space to exit.
  //
  // React Flow's stock `panActivationKeyCode='Space'` is DISABLED
  // below (we pass `null`) because it requires LMB-drag — my
  // handler owns the Space interaction entirely, which both removes
  // the "must click LMB" friction and avoids a double-pan when
  // Space + LMB would otherwise trigger both paths together.
  //
  // During a wire drag, pointermove events are NOT stopPropagation'd —
  // RF's own bubble-phase wire-tracking listener still runs AFTER
  // ours and computes the wire endpoint's flow position using the
  // new viewport (Zustand updates synchronously). Net effect: the
  // wire's free end visually stays glued to the cursor through the
  // pan. When Space is released, normal wire tracking resumes.
  //
  // Guardrails:
  //   - Ignore Space when focus is inside a text input / textarea /
  //     contenteditable so typing a space still works.
  //   - Skip pan when LMB is held and NO wire is in progress —
  //     that case belongs to RF's existing LMB-drag pan and
  //     double-panning would move the viewport twice as fast as
  //     the cursor. The wire-drag case deliberately overrides this
  //     because RF's LMB pan is internally blocked there anyway.
  //
  // Middle-button pan during wire drag was attempted in an earlier
  // draft of this commit but abandoned — React Flow's middle-click
  // drop-wire behaviour is hardwired in its d3-zoom integration
  // and couldn't be cleanly overridden from userland. Space turned
  // out to be a better solution for the same use case.
  const connection = useConnection()
  const connectionInProgress = connection.inProgress
  useEffect(() => {
    const wrapper = canvasWrapperRef.current
    if (!wrapper) return undefined

    const state = { spaceDown: false, lastX: 0, lastY: 0 }

    const inInputField = (el) => {
      if (!el) return false
      const tag = el.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
    }

    const onKeyDown = (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return
      if (inInputField(document.activeElement)) return
      state.spaceDown = true
      // Suppress page-scroll (Space is "scroll down one screen" by
      // default when the body has scrollable content). Safe because
      // we've already bailed out when focus is inside an input.
      e.preventDefault()
      wrapper.style.cursor = 'grab'
    }
    const onKeyUp = (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return
      state.spaceDown = false
      wrapper.style.cursor = ''
    }

    const onPointerMove = (e) => {
      // Always update lastX/lastY so a transition into pan mode
      // (Space pressed mid-move) has a fresh reference on the first
      // pointermove after keydown.
      const dx = e.clientX - state.lastX
      const dy = e.clientY - state.lastY
      state.lastX = e.clientX
      state.lastY = e.clientY
      if (!state.spaceDown) return
      // Skip if LMB is held without a wire in progress — that case
      // already belongs to React Flow's LMB-drag pan and our pan
      // would stack on top of it for a 2x pan speed. During a wire
      // drag LMB IS held but RF's pan is internally blocked, so we
      // take over (via this branch).
      const lmbHeld = (e.buttons & 1) !== 0
      if (lmbHeld && !connectionInProgress) return
      const vp = getViewport()
      setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom })
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keyup', onKeyUp, { capture: true })
    wrapper.addEventListener('pointermove', onPointerMove, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('keyup', onKeyUp, { capture: true })
      wrapper.removeEventListener('pointermove', onPointerMove, { capture: true })
      wrapper.style.cursor = ''
    }
  }, [connectionInProgress, getViewport, setViewport])

  // Update the Entity Detail Panel when the canvas selection changes.
  // If the right sidebar editor is already open, also follow selection to the new node.
  // Phase 1.11 Track I — when more than one node is selected, DO NOT populate
  // the detail panel. Multi-selection is a canvas-level operation (group,
  // delete, etc.) and the detail panel is explicitly single-node-scoped.
  const handleSelectionChange = useCallback(({ nodes: sel }) => {
    // `setDetailPanel` / `clearDetailPanel` / `openRelationshipDetail` /
    // `openKnowledgeDetail` are all individually nav-guard-aware and
    // atomically fold activeSelection clearing into their state-update
    // sets. Deselection or panel-target switching uses ONE action per
    // user click — pairing redundant `clearActiveSelection()` calls
    // alongside guard-aware ones bypasses the popup and blanks the
    // panel even when the user picks Cancel.
    if (sel.length === 0) { clearDetailPanel(); setSingleSelectedNodeId(null); return }
    if (sel.length > 1) { clearDetailPanel(); setSingleSelectedNodeId(null); return }
    const node = sel[0]
    if (node.type === 'sceneNode') {
      setSingleSelectedNodeId(node.id)
      setDetailPanel('scene', node.id)
      // If right sidebar is open, follow selection to the newly selected scene node.
      // Phase 1.24c — uses the auto-follow variant so an active editor pin
      // keeps the editor on its pinned scene while the canvas selection moves.
      const uiState = useUiStore.getState()
      if (uiState.rightSidebarOpen) {
        uiState.openRightSidebarAuto(node.id)
      }
    } else if (node.type === 'entityNode') {
      setSingleSelectedNodeId(node.id)
      const isModifier = node.data.is_modifier === true
      if (isModifier) {
        setDetailPanel('entityNodeModifier', node.id, node.data.entity_id, -1)
      } else {
        // Origin node is always index 0 in the chain
        setDetailPanel('entityNode', node.id, node.data.entity_id, 0)
      }
    } else if (node.type === 'relationshipOriginNode') {
      setSingleSelectedNodeId(node.id)
      if (node.data?.relationship_id) {
        openRelationshipDetail(node.data.relationship_id, node.id)
      }
    } else if (node.type === 'knowledgeOriginNode') {
      setSingleSelectedNodeId(node.id)
      if (node.data?.knowledge_id) {
        openKnowledgeDetail(node.data.knowledge_id, node.id)
      }
    } else if (node.type === 'referenceNode' && (node.data?.sub_type || 'note') !== 'media') {
      // Phase 8.6 — Concept / Note detail view in the left sidebar. Media
      // reference nodes carry a player/upload body (not a notes body), so they
      // stay panel-less like pov / group nodes.
      setSingleSelectedNodeId(node.id)
      openReferenceDetail(node.id)
    } else {
      // media referenceNode, povOriginNode, genericGroupNode, etc.
      setSingleSelectedNodeId(node.id)
      clearDetailPanel()
    }
  }, [setDetailPanel, clearDetailPanel, openRelationshipDetail, openKnowledgeDetail, openReferenceDetail, setSingleSelectedNodeId])

  // Keyboard shortcuts: Delete (delete selected node), Ctrl+Z (undo), Ctrl+Y / Ctrl+Shift+Z (redo)
  // Skip all shortcuts when focus is inside a text input, textarea, or contenteditable (TipTap)
  useEffect(() => {
    function onKeyDown(e) {
      const tag = document.activeElement?.tagName
      const inTextField = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable
      if (inTextField) return
      if (e.key === 'Delete') {
        nodes.filter((n) => n.selected).forEach((n) => deleteNode(n.id))
        return
      }
      if (e.ctrlKey && !e.shiftKey && e.key === 'z') { e.preventDefault(); undo() }
      if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo() }
      if (e.ctrlKey && e.shiftKey && e.key === 'Z') { e.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [nodes, deleteNode, undo, redo])

  const [multiSelectCtxMenu, setMultiSelectCtxMenu] = useState(null)

  const handleContextMenu = useCallback((e) => {
    e.preventDefault()
    // MCP session edit-lock — context menu spawns add-nodes / multi-
    // select operations that would mutate the project. Suppress the
    // menu entirely while a session is in flight. Pan/zoom continue
    // to work because they're handled by React Flow internals, not
    // through this handler.
    if (useMcpControlStore.getState().sessionState === 'active') return
    // Phase 1.11 Track I — if there's an active multi-selection, show the
    // multi-select menu instead of the regular add-nodes menu, regardless
    // of where the user clicked. The user's intent when they right-click
    // with a selection active is to act on that selection, not to spawn
    // an unrelated new node at the cursor.
    const currentNodes = useProjectStore.getState().nodes
    const selectedCount = currentNodes.filter((n) => n.selected).length
    if (selectedCount > 1) {
      // Right-click landed on empty canvas — no anchor node, so
      // the Align submenu falls back to extreme-edge-of-selection.
      setMultiSelectCtxMenu({ x: e.clientX, y: e.clientY, count: selectedCount, anchorNodeId: null })
      return
    }
    const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    setContextMenu({ screenX: e.clientX, screenY: e.clientY, flowPos })
  }, [screenToFlowPosition])

  const handleNodeContextMenu = useCallback((e, node) => {
    // Reference nodes handle their own context menu — don't intercept
    if (node.type === 'referenceNode') return
    e.preventDefault()
    e.stopPropagation()
    // MCP session edit-lock — node context menu offers delete /
    // promote / convert operations that mutate the project. Suppress
    // entirely while a session is in flight so the AI's plan isn't
    // invalidated by a concurrent user action.
    if (useMcpControlStore.getState().sessionState === 'active') return
    // Phase 1.11 Track I — if ANY multi-selection is active, show the
    // multi-select menu regardless of whether the right-clicked node is
    // one of the selected ones. Prevents the confusing case where a
    // right-click on an unselected node silently drops the selection and
    // shows the single-node menu.
    const currentNodes = useProjectStore.getState().nodes
    const selectedCount = currentNodes.filter((n) => n.selected).length
    if (selectedCount > 1) {
      // Right-click landed ON a specific node — that node becomes the
      // anchor for the Align submenu (Phase 1.12c v0.1.12.62).
      setMultiSelectCtxMenu({ x: e.clientX, y: e.clientY, count: selectedCount, anchorNodeId: node.id })
      return
    }
    if (node.type === 'sceneNode') {
      setNodeContextMenu({ nodeId: node.id, x: e.clientX, y: e.clientY })
    } else if (node.type === 'entityNode') {
      setEntityNodeCtxMenu({ nodeId: node.id, x: e.clientX, y: e.clientY })
    } else if (node.type === 'knowledgeOriginNode') {
      setKnowledgeNodeCtxMenu({ nodeId: node.id, x: e.clientX, y: e.clientY })
    }
  }, [])

  // ── Drag-from-library: drop entity onto canvas ─────────────────────────────
  const handleCanvasDragOver = useCallback((e) => {
    if (
      e.dataTransfer.types.includes('application/nnz-entity-id')
      || e.dataTransfer.types.includes('application/nnz-knowledge-id')
      || e.dataTransfer.types.includes('Files')
      // Phase 2.5g — chat image dragged from a chat bubble. Same drop
      // behaviour as an OS image file (spawn a Reference Media node)
      // when the drop lands on empty canvas; the inner node / chip
      // avatar drop targets `stopPropagation` so this branch never
      // fires for drops aimed at those.
      || e.dataTransfer.types.includes('application/x-nn-profile-image-data-url')
    ) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  // Track the OS-file / chat-image drag specifically over the canvas
  // surface so the overlay can paint the "Drop to create a media
  // reference" treatment. Mirrors the depth-counter pattern in
  // ConversationView. Accepts both OS `Files` and our in-app chat-
  // image MIME so a drag from a chat bubble paints the same overlay.
  const handleCanvasFileDragEnter = useCallback((e) => {
    if (!e.dataTransfer.types.includes('Files')
      && !e.dataTransfer.types.includes('application/x-nn-profile-image-data-url')
    ) return
    canvasDragDepth.current += 1
    if (!dragOverCanvas) setDragOverCanvas(true)
  }, [dragOverCanvas])

  const handleCanvasFileDragLeave = useCallback((e) => {
    if (!e.dataTransfer.types.includes('Files')
      && !e.dataTransfer.types.includes('application/x-nn-profile-image-data-url')
    ) return
    canvasDragDepth.current -= 1
    if (canvasDragDepth.current <= 0) {
      canvasDragDepth.current = 0
      setDragOverCanvas(false)
    }
  }, [])

  const handleCanvasDrop = useCallback(async (e) => {
    // MCP session edit-lock — drop spawns new origin nodes from the
    // library. Suppress while a session is in flight so the AI's
    // plan isn't undermined by a concurrent user-driven add.
    if (useMcpControlStore.getState().sessionState === 'active') {
      e.preventDefault()
      return
    }
    // Phase 2.5g — chat-image drag dropped onto empty canvas spawns
    // a Reference Media node containing that image, the same shape
    // an OS-dragged image file would produce. The in-app drag uses
    // a custom MIME (`application/x-nn-profile-image-data-url`) and
    // doesn't populate `dataTransfer.files`, so we handle it in its
    // own branch above the OS-file branch.
    const inAppImageDataUrl = e.dataTransfer.getData('application/x-nn-profile-image-data-url')
    if (inAppImageDataUrl) {
      e.preventDefault()
      const dropPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const { addReferenceNode, updateNodeData } = useProjectStore.getState()
      const newId = addReferenceNode(dropPos, 'media', { title: 'image' })
      // Convert the data URL into a Blob so the same upload endpoint
      // we use for OS-file drops can persist it as an asset.
      ;(async () => {
        try {
          const res = await fetch(inAppImageDataUrl)
          const blob = await res.blob()
          const ext = (blob.type && blob.type.startsWith('image/'))
            ? `.${blob.type.split('/')[1].split('+')[0]}`
            : '.png'
          const uniqueName = `chat-image-${crypto.randomUUID()}${ext}`
          const form = new FormData()
          form.append('file', blob, uniqueName)
          const up = await axios.post('/api/project/assets/upload', form)
          updateNodeData(newId, { file_ref: up.data.file_ref })
        } catch (err) {
          console.error('Chat-image canvas drop upload failed:', err)
        }
      })()
      return
    }
    // OS file drop → two routes depending on what was dropped:
    //   - Exactly one `.nnz` file: route through the open-project
    //     flow (with the same unsaved-changes guard the hamburger
    //     menu's Open uses) via the `requestOpenDroppedProject`
    //     signal in uiStore. App.jsx consumes the signal.
    //   - Otherwise: spawn a Reference Media node per supported
    //     media file at the drop position. Unsupported types raise
    //     a brief banner; mixed drops attach the recognised ones
    //     and still report the rejected ones.
    const droppedFiles = Array.from(e.dataTransfer.files || [])
    if (droppedFiles.length > 0) {
      e.preventDefault()
      const nnzFiles = droppedFiles.filter((f) => /\.nnz$/i.test(f.name || ''))
      if (nnzFiles.length > 0) {
        if (droppedFiles.length === 1) {
          useUiStore.getState().requestOpenDroppedProject(nnzFiles[0])
          return
        }
        // Mixed drop with a project file in the bunch — ambiguous,
        // refuse rather than silently picking one interpretation.
        showTransientAlert(
          'Drop a single .nnz file on its own to open a project, or drop media files (without a .nnz) to attach them.',
        )
        return
      }
      // Phase 7.2 — a single dropped PNG/JSON carrying SillyTavern card
      // metadata creates a character entity (its origin node at the drop
      // position) instead of a Reference Media node. A file with no card
      // metadata falls through to the existing media handling below.
      if (droppedFiles.length === 1 && /\.(png|json)$/i.test(droppedFiles[0].name || '')) {
        const cardPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
        let cardResult = null
        try {
          cardResult = await useEntitiesStore.getState().importCharacterCardFile(droppedFiles[0])
        } catch {
          showTransientAlert('Could not import that character card.')
          return
        }
        if (cardResult) {
          useProjectStore.getState().addEntityNodeToCanvas(
            cardResult.entity_node, cardPos, { createdEntity: cardResult.entity },
          )
          return
        }
        // Not a card -> fall through to the media handling below.
      }
      const supported = droppedFiles.filter((f) => REFERENCE_MEDIA_EXTS.test(f.name || ''))
      const rejected = droppedFiles.filter((f) => !REFERENCE_MEDIA_EXTS.test(f.name || ''))
      if (rejected.length > 0) {
        const names = rejected.map((f) => f.name || 'unnamed').join(', ')
        const tail = supported.length > 0
          ? ' The supported ones were attached.'
          : ''
        const noun = rejected.length === 1 ? 'file' : 'files'
        showTransientAlert(`Unsupported ${noun}: ${names}. Reference media accepts images, videos, and audio only.${tail}`)
      }
      if (supported.length === 0) return
      const dropPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const { addReferenceNode, updateNodeData } = useProjectStore.getState()
      supported.forEach((file, idx) => {
        // Cascade multi-file drops down-right so subsequent nodes
        // don't sit exactly on top of the first.
        const pos = { x: dropPos.x + idx * 24, y: dropPos.y + idx * 24 }
        const baseName = (file.name || '').replace(/\.[^.]+$/, '')
        const newId = addReferenceNode(pos, 'media', { title: baseName })
        const formData = new FormData()
        formData.append('file', file)
        axios.post('/api/project/assets/upload', formData)
          .then((res) => updateNodeData(newId, { file_ref: res.data.file_ref }))
          .catch((err) => console.error('Reference media drop upload failed:', err))
      })
      return
    }
    // Phase 1.21c Step 14: a Knowledge dragged from the library spawns a
    // <KnowledgeOriginNode> at the drop position, but only when the drop
    // lands on empty canvas (drops on a `sceneNode` are intercepted
    // by that node's own drop handler — Tier 3 scene-born creation —
    // which calls `e.stopPropagation()` so this handler doesn't fire).
    const knowledgeId = e.dataTransfer.getData('application/nnz-knowledge-id')
    if (knowledgeId) {
      e.preventDefault()
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const hasOrigin = nodes.some(
        (n) => n.type === 'knowledgeOriginNode' && n.data?.knowledge_id === knowledgeId
      )
      if (hasOrigin) return  // one-per-Knowledge invariant; row already shows the locate affordance
      const k = useProjectStore.getState().knowledges.find((x) => x.id === knowledgeId)
      const hasBirthEvent = !!(k?.history?.existence_changes || []).some(
        (c) => c?.action === 'activate'
      )
      if (hasBirthEvent) return  // scene-born already; mutually exclusive with origin node
      useProjectStore.getState().addKnowledgeOriginNodeToCanvas(knowledgeId, position)
      return
    }

    const entityId = e.dataTransfer.getData('application/nnz-entity-id')
    if (!entityId) return
    e.preventDefault()
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const entity = useEntitiesStore.getState().getEntityById(entityId)
    if (!entity) return

    const hasOrigin = nodes.some(
      (n) => n.type === 'entityNode' && !n.data.is_modifier && n.data.entity_id === entityId
    )

    if (!hasOrigin) {
      const entityNode = { id: crypto.randomUUID(), entity_id: entityId, node_type: 'entity' }
      addEntityNodeToCanvas(entityNode, position)
    } else {
      addModifierEntityNode(position, entityId)
    }
  }, [nodes, screenToFlowPosition, addEntityNodeToCanvas, addModifierEntityNode])

  // ── Phase 1.20 drag-time port feedback ──────────────────────────────────
  // React Flow fires onConnectStart when the user begins dragging a wire
  // from a port, and onConnectEnd on both release-to-valid-target AND abort
  // (release-on-nothing). We populate `uiStore.activeDrag` so port-wrapper
  // components can subscribe and render the accept halo / reject overlay
  // as the drag moves. Derivation of payloadType is centralised in
  // utils/portCatalogue.derivePayloadType so no rendering surface needs to
  // know the mapping itself.
  const handleConnectStart = useCallback((_event, { nodeId, handleId, handleType }) => {
    if (handleType !== 'source') return
    const state = useProjectStore.getState()
    const srcNode = state.nodes.find((n) => n.id === nodeId)
    if (!srcNode) return
    const payloadType = derivePayloadType({
      sourceNodeType: srcNode.type,
      sourceHandleId: handleId ?? null,
    })
    if (!payloadType) return
    // Precompute guard-blocked target set once at drag start: iterate every
    // node and ask each guard whether a wire from this source to that target
    // would be rejected. Ports consult this Set via O(1) lookup during the
    // drag; guards never re-evaluate per frame.
    const chapters = state.story?.chapters || []
    const chapterXOffset = typeof state.story?.chapter_x_offset === 'number' ? state.story.chapter_x_offset : 10
    // F#4: route through the shared module-level cache that `useStoryOrder`
    // populates. Connect-start fires from a user action that happens long
    // after the React render which populated the cache, so the four input
    // refs are almost always identity-equal to what the cache holds — this
    // call is then an instant Map-lookup-style read instead of a fresh
    // ~50-75ms graph walk. Cache miss falls through to a fresh compute.
    const storyOrder = getOrComputeStoryOrder({ nodes: state.nodes, edges: state.edges, chapters, chapterXOffset })
    const { nodeIds: blockedTargetNodeIds, handles: blockedTargetHandles } = computeBlockedTargets({
      sourceNodeId: nodeId,
      sourceHandleId: handleId ?? null,
      payloadType,
      nodes: state.nodes,
      edges: state.edges,
      storyOrder,
      relationships: state.relationships,
    })
    useUiStore.getState().setActiveDrag({
      sourceNodeId: nodeId,
      sourceHandleId: handleId ?? null,
      sourceNodeType: srcNode.type,
      payloadType,
      blockedTargetNodeIds,
      blockedTargetHandles,
    })
  }, [])

  const handleConnectEnd = useCallback(() => {
    useUiStore.getState().clearActiveDrag()
  }, [])

  // Gate React Flow's drag-snapping to only land on genuinely valid targets.
  // When this returns false, the drag line refuses to snap to the candidate
  // handle AND onConnect is not called on release over it -- so invalid
  // handles visually reject the drop before the user commits. Mirrors the
  // same three-step resolver as PortHandle's overlay state (catalogue
  // accept + same-node self-loop check + blocked-target set).
  const handleIsValidConnection = useCallback((connection) => {
    const activeDrag = useUiStore.getState().activeDrag
    if (!activeDrag) return true  // no drag tracked -- fall back to allow
    const { target, targetHandle } = connection
    if (!target) return false
    const targetNode = useProjectStore.getState().nodes.find((n) => n.id === target)
    if (!targetNode) return false
    if (!portAccepts({
      targetNodeType: targetNode.type,
      targetHandleId: targetHandle ?? null,
      payloadType: activeDrag.payloadType,
    })) return false
    if (target === activeDrag.sourceNodeId) {
      if (isSameNodeSelfLoop({
        sourceNodeType: activeDrag.sourceNodeType,
        sourceHandleId: activeDrag.sourceHandleId,
        targetNodeType: targetNode.type,
        targetHandleId: targetHandle ?? null,
      })) return false
      if (activeDrag.blockedTargetHandles?.has?.(`${target}:${targetHandle ?? ''}`)) return false
      return true
    }
    if (activeDrag.blockedTargetNodeIds?.has?.(target)) return false
    if (activeDrag.blockedTargetHandles?.has?.(`${target}:${targetHandle ?? ''}`)) return false
    return true
  }, [])

  // React Flow error handler, hoisted to a STABLE reference. `onError` is one of
  // React Flow's tracked store fields (reactFlowFieldsToTrack); passing a fresh
  // inline arrow every render makes StoreUpdater re-sync it into the store on every
  // commit, which snowballs into a "maximum update depth exceeded" loop during
  // high-frequency re-render moments such as dragging a wire into a scene. A
  // useCallback keeps the reference stable so StoreUpdater syncs it once.
  const handleReactFlowError = useCallback((code, message) => {
    // React Flow error 008 ("couldn't create edge for target handle") fires
    // transiently when an edge is added one frame before its target chip/POV
    // handle mounts (e.g. an MCP chip/POV insert). The edge renders correctly on
    // the next frame and a fresh load from disk produces none, so it is benign.
    // Keep it visible in dev for debugging, but silence the noise in production.
    // Every other code falls through to React Flow's normal console.warn.
    if (code === '008') {
      if (import.meta.env.DEV) console.debug(`[ReactFlow] ${code}: ${message}`)
      return
    }
    console.warn(`[ReactFlow] ${code}: ${message}`)
  }, [])

  // Open delete dialog for an entity origin node (from context menu)
  const handleEntityNodeDelete = useCallback((nodeId) => {
    const node = nodes.find((n) => n.id === nodeId)
    if (!node || node.type !== 'entityNode') return
    const entityId = node.data.entity_id
    const entStore = useEntitiesStore.getState()
    const entity = entStore.getEntityById(entityId)
    if (!entity) return
    const chipCount = countEntityChips(entityId)
    const payload = {
      entityId,
      entityName: entity.name,
      entityColour: entity.colour || '#888888',
      chipCount,
      nodeId,
      isOrigin: !node.data.is_modifier,
    }
    if (isOvumRedEntity(entity)) {
      payload.extraOption = {
        label: "Don't let this happen again this session",
        onChange: (checked) => setOvumRedSessionDisabled(checked),
      }
    }
    openDeleteEntityDialog(payload)
  }, [nodes, countEntityChips, openDeleteEntityDialog])

  return (
    <div
      className="flex-1 relative"
      data-help-region="canvas-overview:workspace"
      ref={canvasWrapperRef}
      onDragEnter={handleCanvasFileDragEnter}
      onDragLeave={handleCanvasFileDragLeave}
    >
      <EditorToggleCorner />
      <ChatToggleCorner />
      <DockDropTargets />
      {fileDragInWindow && avatarDropOverCount === 0 && (
        <div
          data-help-region="canvas-overview:file_drop"
          className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none transition-colors"
          style={{
            backgroundColor: _withAccentAlpha(accentColor, dragOverCanvas ? 0.28 : 0.12),
            outline: `${dragOverCanvas ? '2px' : '1.5px'} dashed ${accentColor}`,
            outlineOffset: '-6px',
            opacity: dragOverCanvas ? 1 : 0.85,
          }}
        >
          <span
            className="text-xs font-semibold uppercase tracking-wider px-3 py-1.5 rounded bg-zinc-900/85 border transition-colors"
            style={{ color: accentColor, borderColor: accentColor }}
          >
            {dragOverCanvas ? 'Drop to create a media reference' : 'Drop here to create a media reference'}
          </span>
        </div>
      )}
      <AccentColorProvider value={accentColor}>
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        onError={handleReactFlowError}
        multiSelectionKeyCode={['Control', 'Meta']}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        isValidConnection={handleIsValidConnection}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onContextMenu={handleContextMenu}
        onNodeContextMenu={handleNodeContextMenu}
        onSelectionChange={handleSelectionChange}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onDragOver={handleCanvasDragOver}
        onDrop={handleCanvasDrop}
        defaultViewport={{ x: 0, y: 0, zoom: 1.5 }}
        panActivationKeyCode={null}
        colorMode="dark"
        connectionRadius={30}
        /* Phase 4.1g follow-up — only mount nodes/edges whose bounds
           intersect the viewport. On large projects (the reference
           project spans ~96k px and loads at a partial zoom) this is the
           difference between rendering+measuring all ~288 complex nodes
           on load (a 5-7 s main-thread-bound settle) and rendering only
           the handful actually on screen. Off-screen nodes still carry a
           seeded `measured` estimate (see NODE_DIM_DEFAULTS in
           projectStore) so React Flow can cull them from the first frame
           and the MiniMap can still draw them. */
        /* Temporarily disabled during a reorganize (see handleReorganize) so
           every node mounts and is measured at its true size before the
           packer runs; otherwise off-screen nodes contribute only a seed-size
           estimate and the packer overlaps the taller / wider cards. */
        onlyRenderVisibleElements={!forceRenderAll}
        proOptions={{ hideAttribution: true }}
        /* MCP session edit-lock — disable React Flow's edit
           interactions while a session is active. Pan / zoom /
           scroll keep working because they're not gated by these
           props (panOnDrag / zoomOnScroll stay at their defaults).
           Selection also stays enabled so the user can click on
           nodes to read them; only the EDIT-causing affordances
           (drag-to-move, connect-to-create-edge) are disabled. */
        nodesDraggable={!isMcpEditLocked}
        nodesConnectable={!isMcpEditLocked}
        edgesReconnectable={!isMcpEditLocked}
        onMove={updateViewportOutline}
      >
        <Background variant="dots" gap={20} size={1} color="#3f3f46" />
        {showMinimap && (
          <MiniMap
            nodeComponent={minimapNodeComponent}
            nodeColor={minimapNodeColor}
            nodeStrokeColor={minimapNodeStrokeColor}
            nodeStrokeWidth={40}
            maskColor="rgba(15,15,19,0.75)"
            /* Interaction (click-to-centre + drag-to-position) is handled by
               our own pointer listeners on the minimap element (see the
               deferred-drag effect), NOT React Flow's `pannable`/`onClick`.
               RF's `pannable` live-pans the main viewport on every
               pointermove, re-rendering the whole canvas each frame (the
               minimap-drag stutter); instead we move only the viewport-outline
               rectangle while dragging and commit the viewport once on
               release. `zoomable` stays OFF: its d3-zoom double-click drove the
               main viewport below the canvas min zoom and competed for pointer
               events. Main-canvas scroll-zoom + the +/- controls are
               unaffected. */
            style={{ width: minimapDims.w, height: minimapDims.h }}
          />
        )}
        <Controls>
          <WireVisibilityControl />
          <ControlButton
            data-help-region="canvas-overview:snap_to_grid"
            onClick={handleSnapButtonClick}
            title={
              snapToGrid
                ? 'Snap to grid: ON. Click to disable. Ctrl+click to snap all nodes to grid now.'
                : 'Snap to grid: OFF. Click to enable. Ctrl+click to snap all nodes to grid now.'
            }
          >
            {/* Filled horseshoe-magnet silhouette. The path traces
                (from top-left of the outer edge): outer arc over the
                top, down the outer right leg, across the right pole
                tip, up the inside of the right leg, inner arc back
                across the top, down the inside of the left leg,
                across the left pole tip, back to start. `fillRule
                evenodd` isn't needed — the path is a single closed
                loop. Phase 1.12c v0.1.12.63. */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 20 20"
              fill="currentColor"
              style={{ opacity: snapToGrid ? 1 : 0.5 }}
              aria-hidden="true"
            >
              <path d="M 3 10 A 7 7 0 0 1 17 10 L 17 17 L 13 17 L 13 13 A 3 3 0 0 0 7 13 L 7 17 L 3 17 Z" />
            </svg>
          </ControlButton>
          <ControlButton
            data-help-region="canvas-overview:reorganize"
            onClick={handleReorganize}
            title="Reorganize canvas: pack scenes into their chapter columns + place entity origins by first appearance"
          >
            {/* Three-column block icon: suggests "arrange into chapter columns" */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="1.5" y="3" width="2.5" height="8" />
              <rect x="5.75" y="3" width="2.5" height="8" />
              <rect x="10" y="3" width="2.5" height="8" />
            </svg>
          </ControlButton>
          <ControlButton onClick={toggleMinimap} title="Minimap" data-help-region="canvas-overview:minimap_toggle">
            <span style={{ fontSize: 14, lineHeight: 1, opacity: showMinimap ? 1 : 0.5 }}>◲</span>
          </ControlButton>
        </Controls>
        <CanvasToolbar />
        <ChapterColumnsOverlay />
        <DragTooltip />
        <WireListPopup />
        {/* Phase 1.22j — TOC and Timeline Navigator panels render
            inside the ReactFlow tree so they stay inside the
            ReactFlowProvider (the panels use `useReactFlow()`).
            Anchored at top:8 left:8 of the canvas wrapper. The
            chapters-bar overlay used to host them, but moving the
            toggle buttons to the top bar means the panels needed to
            outlive the overlay's visibility too. */}
        <TableOfContentsPanel anchorTop={8} anchorLeft={8} />
        <TimelineNavigatorPanel anchorTop={8} anchorLeft={8} />
      </ReactFlow>
      </AccentColorProvider>

      {/* Reorganize progress modal. Covers the canvas while the measure pass
          runs its node batches behind it, then the arrange step. The bar is a
          real percentage (nodes measured, then 100% during arrange). */}
      {reorganizeProgress && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-zinc-950/70 backdrop-blur-sm"
          style={{ cursor: 'progress' }}
        >
          <div className="w-[340px] rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl px-5 py-4">
            <div className="text-sm font-semibold text-zinc-100 mb-1">Organizing canvas</div>
            <div className="text-xs text-zinc-400 mb-3">
              {reorganizeProgress.phase === 'arranging'
                ? 'Arranging nodes…'
                : `Measuring nodes… ${reorganizeProgress.done} / ${reorganizeProgress.total}`}
            </div>
            <div className="h-2 w-full rounded-full bg-zinc-700 overflow-hidden">
              <div
                className="h-full rounded-full transition-[width] duration-150 ease-out"
                style={{
                  width: `${reorganizeProgress.total > 0 ? Math.round((reorganizeProgress.done / reorganizeProgress.total) * 100) : 0}%`,
                  backgroundColor: accentColor,
                }}
              />
            </div>
            <div className="mt-2 text-right text-[11px] tabular-nums text-zinc-400">
              {reorganizeProgress.total > 0 ? Math.round((reorganizeProgress.done / reorganizeProgress.total) * 100) : 0}%
            </div>
          </div>
        </div>
      )}

      {/* Accent outline of the current viewport, sized imperatively by
          updateViewportOutline. pointer-events none so it never blocks the
          minimap; clamped to the minimap so it can't touch its own edges. */}
      {minimapEl && createPortal(
        <div
          ref={viewportOutlineRef}
          style={{
            position: 'absolute',
            border: `1.5px solid ${accentColor}`,
            borderRadius: 2,
            boxSizing: 'border-box',
            pointerEvents: 'none',
            zIndex: 5,
          }}
        />,
        minimapEl,
      )}

      {/* Minimap resize handle — a small bracket sitting on the minimap's
          top-left corner. Drag it to resize the minimap (size persists).
          Only the 16px handle is interactive, so it never blocks the
          canvas or the minimap's own pan/zoom/click. */}
      {minimapEl && createPortal(
        <div
          data-minimap-resize
          data-help-region="canvas-overview:minimap_resize"
          onPointerDown={onMinimapResizeStart}
          title="Drag to resize the minimap"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: 16,
            height: 16,
            cursor: 'nwse-resize',
            zIndex: 6,
            borderTop: '2px solid #a1a1aa',
            borderLeft: '2px solid #a1a1aa',
            borderTopLeftRadius: 4,
            touchAction: 'none',
            opacity: (minimapHover || minimapResizing) ? 1 : 0,
            pointerEvents: (minimapHover || minimapResizing) ? 'auto' : 'none',
            transition: 'opacity 120ms ease',
          }}
        />,
        minimapEl,
      )}

      {contextMenu && (
        <CanvasContextMenu
          x={contextMenu.screenX}
          y={contextMenu.screenY}
          flowPosition={contextMenu.flowPos}
          onClose={() => setContextMenu(null)}
        />
      )}

      {nodeContextMenu && (
        <NodeContextMenu
          nodeId={nodeContextMenu.nodeId}
          x={nodeContextMenu.x}
          y={nodeContextMenu.y}
          onClose={() => setNodeContextMenu(null)}
        />
      )}

      {entityNodeCtxMenu && (
        <EntityNodeContextMenu
          nodeId={entityNodeCtxMenu.nodeId}
          x={entityNodeCtxMenu.x}
          y={entityNodeCtxMenu.y}
          onClose={() => setEntityNodeCtxMenu(null)}
          onDelete={handleEntityNodeDelete}
        />
      )}

      {multiSelectCtxMenu && (
        <MultiSelectContextMenu
          x={multiSelectCtxMenu.x}
          y={multiSelectCtxMenu.y}
          count={multiSelectCtxMenu.count}
          anchorNodeId={multiSelectCtxMenu.anchorNodeId}
          onClose={() => setMultiSelectCtxMenu(null)}
        />
      )}

      {deleteDialog && (
        <DeleteEntityDialog
          entityName={deleteDialog.entityName}
          entityColour={deleteDialog.entityColour}
          chipCount={deleteDialog.chipCount}
          mode="origin_node"
          onDeleteEntity={() => {
            deleteObject('entity', deleteDialog.entityId)
            closeDeleteEntityDialog()
          }}
          onDeleteNodeOnly={() => {
            if (deleteDialog.nodeId) {
              if (deleteDialog.isOrigin) {
                deleteObject('node', deleteDialog.nodeId)
              } else {
                deleteNode(deleteDialog.nodeId)
              }
            }
            closeDeleteEntityDialog()
          }}
          onClose={closeDeleteEntityDialog}
          extraOption={deleteDialog.extraOption || null}
        />
      )}

      {convertDialog && (
        <ConvertEntityDialog
          entityId={convertDialog.entityId}
          entityName={convertDialog.entityName}
          entityColour={convertDialog.entityColour}
          sourceType={convertDialog.sourceType}
          targetType={convertDialog.targetType}
          sourceKind={convertDialog.sourceKind}
          batch={convertDialog.batch}
          batchCount={convertDialog.batchCount}
          onConvert={(opts) => {
            if (convertDialog.batch) {
              if (convertDialog.sourceKind === 'knowledge') {
                convertKnowledgesBatch(convertDialog.batchIds, convertDialog.targetType, opts)
              } else {
                convertEntitiesBatch(convertDialog.batchIds, convertDialog.targetType, opts)
              }
            } else if (convertDialog.sourceKind === 'knowledge') {
              convertKnowledgeToEntity(convertDialog.entityId, convertDialog.targetType, opts)
            } else {
              convertEntityType(convertDialog.entityId, convertDialog.targetType, opts)
            }
            closeConvertEntityDialog()
          }}
          onClose={closeConvertEntityDialog}
        />
      )}

      {knowledgeNodeCtxMenu && (
        <KnowledgeNodeContextMenu
          nodeId={knowledgeNodeCtxMenu.nodeId}
          x={knowledgeNodeCtxMenu.x}
          y={knowledgeNodeCtxMenu.y}
          onClose={() => setKnowledgeNodeCtxMenu(null)}
        />
      )}
    </div>
  )
}

// Wrap in ReactFlowProvider so useReactFlow() hooks work inside CanvasInner
export default function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  )
}
