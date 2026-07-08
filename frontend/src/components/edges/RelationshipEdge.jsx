import { useMemo } from 'react'
import { getBezierPath } from '@xyflow/react'
import { useUiStore } from '../../store/uiStore'
import { useEntityByIdMap } from '../../hooks/useEntityByIdMap'

const FALLBACK_COLOUR = '#a78bfa'

/**
 * Custom edge for relationship wires.
 * Renders as alternating dashes — each dash in one entity's colour — using two
 * overlapping SVG paths with matching strokeDasharray and a 5px strokeDashoffset
 * on the second path so the dashes interleave perfectly.
 */
export default function RelationshipEdge({
  id,
  sourceX, sourceY, sourcePosition,
  targetX, targetY, targetPosition,
  data,
}) {
  const [edgePath] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
  })

  // When a wire has an explicit `source_entity_id` (rel-origin-node wires,
  // faction-membership wires), the wire semantically represents THAT one
  // entity joining the relationship — colour the wire in that entity's
  // colour as a solid single line (same-colour path-2 is suppressed
  // automatically below). Falls back to `entity_a_id` / `entity_b_id` when
  // no source entity is declared.
  const eidA = data?.source_entity_id ?? data?.entity_a_id ?? null
  const eidB = data?.source_entity_id ?? data?.entity_b_id ?? null

  // Perf #7: shared `useEntityByIdMap` replaces two per-render
  // 5-bucket `.find()` walks wrapped in `useCallback`-as-selector
  // (the callback identity rotates per render, forcing Zustand to
  // re-subscribe — anti-pattern flagged in v2 of the per-render
  // audit). Map lookup is O(1); baseline `.colour` read preserved
  // exactly. Any chain-awareness question about wire-colour-from-
  // baseline is a separate concern outside F#7's perf scope.
  const entityMap = useEntityByIdMap()
  const entityAColour = eidA ? (entityMap.get(eidA)?.colour ?? null) : null
  const entityBColour = eidB ? (entityMap.get(eidB)?.colour ?? null) : null

  const colourA = entityAColour || FALLBACK_COLOUR
  const colourB = entityBColour || colourA

  // When both colours are identical, two complementary dash paths cover every
  // segment with no gap, producing a solid line. Use a single dashed path instead.
  const sameColour = colourA === colourB

  // Highlight when the source or target node is the sole selected node,
  // or the specific source entity chip is selected (entityChip mode)
  const dpMode              = useUiStore((s) => s.detailPanelMode)
  const dpNodeId            = useUiStore((s) => s.detailPanelNodeId)
  const dpEntityId          = useUiStore((s) => s.detailPanelEntityId)
  const singleSelectedNodeId = useUiStore((s) => s.singleSelectedNodeId)
  const hoveredWireId       = useUiStore((s) => s.hoveredWireId)
  const isHoveredFromPopup  = hoveredWireId === id

  const isHighlightedBySelection = useMemo(() => {
    const srcNode   = data?.source_node_id
    const tgtNode   = data?.target_node_id
    const srcEntity = data?.source_entity_id || eidA
    if (dpMode === 'entityChip' && dpNodeId === srcNode && dpEntityId === srcEntity) return true
    if (dpMode !== 'entityChip' && singleSelectedNodeId && (singleSelectedNodeId === srcNode || singleSelectedNodeId === tgtNode)) return true
    return false
  }, [dpMode, dpNodeId, dpEntityId, singleSelectedNodeId, data?.source_node_id, data?.target_node_id, data?.source_entity_id, eidA])

  const isLit = isHighlightedBySelection || isHoveredFromPopup
  const highlightWidth = isLit ? 2.5 : 1.5
  const highlightOpacity = isLit ? 1 : 0.85
  const highlightFilter = isLit
    ? `drop-shadow(0 0 3px ${colourA}88)`
    : undefined

  return (
    <>
      {/* Path 1: dashes in entity A colour */}
      <path
        id={`${id}-a`}
        data-help-region="wire:relationship"
        d={edgePath}
        fill="none"
        stroke={colourA}
        strokeWidth={highlightWidth}
        strokeDasharray="5 5"
        opacity={highlightOpacity}
        style={{ filter: highlightFilter }}
      />
      {/* Path 2: dashes in entity B colour, offset so they fill entity A's gaps.
          Omitted when both colours are identical — rendering it would eliminate all
          gaps and produce a solid line. */}
      {!sameColour && (
        <path
          id={`${id}-b`}
          d={edgePath}
          fill="none"
          stroke={colourB}
          strokeWidth={highlightWidth}
          strokeDasharray="5 5"
          strokeDashoffset="5"
          opacity={highlightOpacity}
        />
      )}
    </>
  )
}
