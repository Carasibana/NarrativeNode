/**
 * Phase 1.26 — Input-port wire-list popup.
 *
 * Opens when the user clicks an input (target) handle that has at least
 * one wire connected to it. Lists every incoming wire with four
 * affordances per row:
 *   - Source label: identifies the upstream end (source node title +
 *     wire kind: POV / relationship / entity narrative-flow / transition).
 *   - Go to source: pans the canvas to the upstream node and selects it.
 *   - Sever (↛): removes ONLY the wire — chips and chain entries the
 *     wire created stay in place. Used to manually disconnect a chip
 *     from its upstream chain without rolling back the downstream state.
 *     Direct edge removal (bypasses `onEdgesChange`'s cascading side
 *     effects); takes its own undo snapshot.
 *   - Delete (✕): DESTRUCTIVE inverse — removes the wire AND the
 *     elements the wire created (entity chips + their EntityRefs,
 *     relationship-participant join entries, POV chain placement, etc.)
 *     plus their downstream dependencies. Routes through the canonical
 *     inverse action for the wire's kind so wire-removal cleanup runs
 *     uniformly.
 *   - Hover-highlight: hovering a row sets `uiStore.hoveredWireId`; the
 *     three custom edge components (TransitionEdge / PovEdge /
 *     RelationshipEdge) read it and thicken / pulse accordingly so the
 *     user can identify which wire each row refers to.
 *
 * Closes on outside click, Escape, or when the wire list becomes empty
 * (last action auto-closes the popup).
 */

import { useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useReactFlow } from '@xyflow/react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { incomingAtTargetHandle } from '../../utils/edgeIndexes'
import { NodeBadge, EntityAvatarName } from '../ui/IdentityBadges'

const POPUP_WIDTH = 320
const POPUP_GAP = 8 // px gap between port and popup edge

function buildEntityMap(buckets) {
  const m = new Map()
  if (!buckets) return m
  for (const bucket of ['characters', 'locations', 'items', 'factions', 'customs']) {
    const list = buckets[bucket] || []
    for (const e of list) m.set(e.id, e)
  }
  return m
}

export default function WireListPopup() {
  const popup = useUiStore((s) => s.wireListPopup)
  const closeWireListPopup = useUiStore((s) => s.closeWireListPopup)
  const setHoveredWireId = useUiStore((s) => s.setHoveredWireId)
  const edges = useProjectStore((s) => s.edges)
  const nodes = useProjectStore((s) => s.nodes)
  // Stable individual selectors per the Zustand stable-selector convention.
  const characters = useEntitiesStore((s) => s.characters)
  const locations = useEntitiesStore((s) => s.locations)
  const items = useEntitiesStore((s) => s.items)
  const factions = useEntitiesStore((s) => s.factions)
  const customs = useEntitiesStore((s) => s.customs)
  const { fitView } = useReactFlow()
  const popupRef = useRef(null)
  const entityMap = useMemo(
    () => buildEntityMap({ characters, locations, items, factions, customs }),
    [characters, locations, items, factions, customs],
  )

  const incoming = useMemo(() => {
    if (!popup) return []
    // Perf #11: lookup via shared `edgesByTargetHandle` index — see
    // utils/edgeIndexes.js. Returns the same array shape the prior
    // `edges.filter(...)` produced, but O(1) instead of O(N). The
    // helper returns a shared frozen empty array when nothing targets
    // the handle (cheap to compare via identity for auto-close below).
    return incomingAtTargetHandle(edges, popup.nodeId, popup.handleId ?? null)
  }, [edges, popup])

  // Phase 8.1 , concept ports are universal connectors, so a wire can attach
  // here as EITHER source or target; list both directions. Concept edges carry
  // no chain side-effects, so removal is a plain edge strip (handleSever).
  const isConcept = !!popup && typeof popup.handleId === 'string' && popup.handleId.startsWith('concept-')
  const conceptWires = useMemo(() => {
    if (!popup || !isConcept) return []
    return edges.filter(
      (e) => e.type === 'conceptEdge' && (
        (e.source === popup.nodeId && e.sourceHandle === popup.handleId) ||
        (e.target === popup.nodeId && e.targetHandle === popup.handleId)
      ),
    )
  }, [edges, popup, isConcept])

  const rows = isConcept ? conceptWires : incoming

  // Auto-close when the wire list goes empty (last removal).
  useEffect(() => {
    if (popup && rows.length === 0) closeWireListPopup()
  }, [popup, rows.length, closeWireListPopup])

  // Outside-click + Escape close.
  useEffect(() => {
    if (!popup) return
    const onPointer = (e) => {
      if (popupRef.current && popupRef.current.contains(e.target)) return
      // Don't close on clicks on the originating port itself (would
      // immediately reopen). The handle that opened us called
      // stopPropagation on its click already, so this is just
      // belt-and-braces.
      closeWireListPopup()
    }
    const onKey = (e) => { if (e.key === 'Escape') closeWireListPopup() }
    // Capture phase so we beat React Flow's pane-click selection-clear.
    document.addEventListener('pointerdown', onPointer, { capture: true })
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, { capture: true })
      document.removeEventListener('keydown', onKey)
    }
  }, [popup, closeWireListPopup])

  // Delete routes through the canonical inverse action for the wire's
  // kind so the wire's persistent data effects are reversed, not just the
  // visual edge removed. Per the every-value-touch chain rule:
  // each wire kind encodes a distinct chain-tracked event whose inverse
  // is a context-scoped REMOVE action. Wire kinds that are creation-time
  // triggers (knowledge awareness grant, scene-level relationship join
  // gesture) leave no persistent wire and so don't appear in this list
  // at all.
  const handleDelete = useCallback(async (edge) => {
    const data = edge.data || {}
    const store = useProjectStore.getState()

    // POV wire — `onEdgesChange` already strips `pov_entity_id` on the
    // target and re-runs the walker; that's the canonical inverse for
    // POV wires.
    if (data.is_pov_path) {
      store.onEdgesChange([{ type: 'remove', id: edge.id }])
      return
    }

    // Persistent relationship wire — origin-context only (relationship
    // origin or faction-membership origin). Inverse is the unified
    // `removeParticipant` action; it removes the join, mirror-strips
    // baseline if applicable, cascades a relationship delete on
    // zero-participant, and aligns the persistent origin wire via
    // `_syncOriginWireForRel`. No need to dispatch `onEdgesChange`
    // separately — the action prunes the edge itself.
    if (data.is_relationship && data.relationship_id && data.source_entity_id) {
      await store.removeParticipant(data.relationship_id, data.source_entity_id, edge.target)
      return
    }

    // Entity narrative-flow wire — the wire's effect is "this entity is
    // present at the downstream node" (i.e. has a chip there). Inverse
    // is `removeEntityChip` which strips the chip + its EntityRef +
    // any temporary circumstances / scene-anchored relationship history
    // for that entity, AND removes the carrying edge(s). No separate
    // `onEdgesChange` needed.
    if (data.source_entity_id) {
      await store.removeEntityChip(edge.target, data.source_entity_id)
      return
    }

    // Plain transition wire — no data side effects to reverse. Just
    // remove the edge.
    store.onEdgesChange([{ type: 'remove', id: edge.id }])
  }, [])

  // Sever removes ONLY the wire — chips, EntityRefs, participant
  // joins, pov_entity_id, etc. that the wire originally created stay
  // in place. Bypasses `onEdgesChange`'s cascading side effects (POV
  // pov_entity_id strip, orphan-flag clean-up) by mutating `edges`
  // directly. Used when the user wants to manually disconnect a chip
  // from its upstream chain WITHOUT rolling back downstream state —
  // intentionally orphans the downstream end so the chain walker's
  // orphan / sub-chain path (`computeEffectiveState`) takes over.
  // Takes its own undo snapshot so the user can reverse the sever.
  //
  // Per-wire-kind notes:
  //   - Entity narrative-flow wire: chip stays on the downstream
  //     node; chain walker now resolves it via orphan / sub-chain
  //     path (v0.2.1.168+). The most common use case.
  //   - POV wire: pov_entity_id stays on the target scene; the scene
  //     comes off the POV chain but keeps its POV character
  //     designation. Useful for re-anchoring later.
  //   - Relationship wire (persistent origin): the wire is a render
  //     of `rel.history.participant_changes` — removing the edge
  //     without removing the data means the wire will rebuild on
  //     the next save / reload cycle (or whenever the relationship
  //     re-renders). Sever is effectively a temporary visual
  //     disconnect for relationship wires; use Delete for a real
  //     remove.
  //   - Plain transition wire: no data attached — Sever and Delete
  //     are equivalent.
  const handleSever = useCallback((edge) => {
    const store = useProjectStore.getState()
    store._snapshot()
    useProjectStore.setState((s) => ({
      edges: s.edges.filter((e) => e.id !== edge.id),
      hasUnsavedChanges: true,
    }))
  }, [])

  const handleGoToSource = useCallback((sourceNodeId) => {
    if (!sourceNodeId) return
    fitView({ nodes: [{ id: sourceNodeId }], duration: 400, padding: 0.5 })
  }, [fitView])

  if (!popup) return null
  if (rows.length === 0) return null

  // Position the popup anchored to the right of the input port. The
  // anchor was captured in screen coords at click time; we render fixed
  // to body so canvas pan/zoom doesn't drag the popup along.
  const rect = popup.anchorRect
  const left = rect ? rect.right + POPUP_GAP : 100
  const top = rect ? rect.top : 100
  // Clamp into viewport (prefer left of port if right would overflow).
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768
  const finalLeft = (left + POPUP_WIDTH > vw && rect)
    ? Math.max(8, rect.left - POPUP_GAP - POPUP_WIDTH)
    : Math.min(left, vw - POPUP_WIDTH - 8)
  const finalTop = Math.max(8, Math.min(top, vh - 80))

  return createPortal(
    <div
      ref={popupRef}
      data-help-region="wire-list:popup"
      className="fixed z-50 bg-zinc-800 border border-zinc-600 rounded shadow-xl text-zinc-200 text-xs"
      style={{ left: finalLeft, top: finalTop, width: POPUP_WIDTH }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-2 border-b border-zinc-700 flex items-center justify-between">
        <span className="font-medium text-zinc-300">
          {rows.length} {rows.length === 1 ? 'connection' : 'connections'}
        </span>
        <button
          data-help-region="wire-list:close"
          onClick={closeWireListPopup}
          className="text-zinc-500 hover:text-zinc-200 px-1 leading-none"
          title="Close"
        >
          ✕
        </button>
      </div>
      <ul className="max-h-72 overflow-y-auto">
        {rows.map((edge) => {
          // Phase 8.1 , concept wire row: show the FAR end (concept ports are
          // undirected, so the "other" node is what matters) + a plain remove.
          if (isConcept) {
            const farId = edge.source === popup.nodeId ? edge.target : edge.source
            const farNode = nodes.find((n) => n.id === farId) || null
            const farTitle = farNode?.data?.title || '(untitled concept)'
            const farColour = farNode?.data?.colour || '#a3e635'
            return (
              <li
                key={edge.id}
                onMouseEnter={() => setHoveredWireId(edge.id)}
                onMouseLeave={() => setHoveredWireId(null)}
                className="px-3 py-1.5 border-b border-zinc-700 last:border-b-0 hover:bg-zinc-700/40 flex items-center gap-2"
              >
                <span className="w-3 h-3 rounded-sm flex-shrink-0 border border-zinc-600" style={{ backgroundColor: farColour }} />
                <span className="flex-1 min-w-0 truncate text-zinc-300" title={farTitle}>{farTitle}</span>
                <button
                  onClick={() => handleGoToSource(farId)}
                  className="flex-shrink-0 w-6 h-6 inline-flex items-center justify-center rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 leading-none"
                  title="Centre canvas on the connected node"
                >
                  <span className="text-sm">👁</span>
                </button>
                <button
                  onClick={() => handleSever(edge)}
                  className="flex-shrink-0 w-6 h-6 inline-flex items-center justify-center rounded border border-red-700 text-red-400 hover:text-red-200 hover:bg-red-900/50 leading-none"
                  title="Remove this concept wire"
                >
                  <span className="text-sm font-semibold">✕</span>
                </button>
              </li>
            )
          }
          // The wire's source-side identity. The NodeBadge identifies the
          // upstream node; we ALSO show the entity's avatar+name beside the
          // badge whenever the wire is associated with a specific entity:
          //   - a sceneNode chip (`source_entity_id` on edge data)
          //   - an entityNode origin / modifier (the node IS the entity,
          //     identified via `node.data.entity_id`)
          // Lets the user tell apart multiple wires from the same upstream
          // scene, and surfaces the entity identity even on origin / modifier
          // wires where the badge alone says only "NEW : CHARACTER" etc.
          const srcNode = nodes.find((n) => n.id === edge.source) || null
          const subChipEntityId = edge.data?.source_entity_id
            || (srcNode?.type === 'entityNode' ? srcNode.data?.entity_id : null)
          const subChipEntity = subChipEntityId ? entityMap.get(subChipEntityId) : null
          const showSubChip = !!subChipEntity
          return (
            <li
              key={edge.id}
              onMouseEnter={() => setHoveredWireId(edge.id)}
              onMouseLeave={() => setHoveredWireId(null)}
              className="px-3 py-1.5 border-b border-zinc-700 last:border-b-0 hover:bg-zinc-700/40 flex items-center gap-2"
            >
              <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-hidden">
                <NodeBadge nodeId={edge.source} nodes={nodes} entityMap={entityMap} />
                {showSubChip && (
                  <>
                    <span className="text-zinc-600 flex-shrink-0">·</span>
                    <span className="min-w-0 truncate">
                      <EntityAvatarName entity={subChipEntity} />
                    </span>
                  </>
                )}
              </div>
              <button
                data-help-region="wire-list:go_to_source"
                onClick={() => handleGoToSource(edge.source)}
                className="flex-shrink-0 w-6 h-6 inline-flex items-center justify-center rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 leading-none"
                title="Centre canvas on the upstream node"
              >
                <span className="text-sm">👁</span>
              </button>
              <button
                data-help-region="wire-list:sever"
                onClick={() => handleSever(edge)}
                className="flex-shrink-0 w-6 h-6 inline-flex items-center justify-center rounded border border-amber-700 text-amber-400 hover:text-amber-200 hover:bg-amber-900/40 leading-none"
                title="Sever this connection. Removes only the wire. Anything it brought into this scene stays."
              >
                {/* ↛ rightwards arrow with stroke (U+219B). Inline SVG
                    instead of the Unicode glyph so it renders as a
                    single glyph regardless of the user's font
                    fallback chain — some fonts render U+219B as base
                    + combining stroke (two glyphs). */}
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {/* Horizontal arrow shaft + arrowhead */}
                  <line x1="3" y1="12" x2="20" y2="12" />
                  <polyline points="15 7 20 12 15 17" />
                  {/* Diagonal "stroke" through the shaft */}
                  <line x1="16" y1="4" x2="8" y2="20" />
                </svg>
              </button>
              <button
                data-help-region="wire-list:delete"
                onClick={() => handleDelete(edge)}
                className="flex-shrink-0 w-6 h-6 inline-flex items-center justify-center rounded border border-red-700 text-red-400 hover:text-red-200 hover:bg-red-900/50 leading-none"
                title="Delete this connection and everything it brought into this scene."
              >
                <span className="text-sm font-semibold">✕</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>,
    document.body,
  )
}
