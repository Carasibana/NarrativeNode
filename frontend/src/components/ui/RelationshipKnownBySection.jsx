/**
 * RelationshipKnownBySection — relationship awareness section in the
 * relationship Detail Panel's Awareness sub-tab. Mirrors the entity
 * `KnownBySection` shell exactly: own collapsible header (clickable
 * row with `Known by…` label, `Track who knows <Name>` toggle, and an
 * expand chevron), renders the universal `<AwarenessPicker>` (with
 * its internal toggle row hidden) as the body when expanded.
 *
 * Header semantics:
 *   - Toggle ON / OFF flips the relationship's awareness tracking via
 *     the dedicated tracking-toggle action (chain-tracked event on
 *     `relationship.awareness.history`). At the relationship's
 *     creation anchor (or origin) the action collapses to baseline
 *     null/`{}` semantics.
 *   - Chevron is only clickable when tracking is on; tracking off
 *     leaves nothing to expand into so the section stays collapsed.
 *
 * Anchor-aware writes route through the universal
 * `commitAwarenessAtAnchor` setter the same way `KnownBySection` does
 * for entities.
 */

import { useMemo } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { computeRelationshipEffectiveState, getRelationshipNodeOrder, getRelationshipCreationNodeId } from '../../utils/narrativeChain'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import AwarenessPicker from '../entities/AwarenessPicker'
import ToggleInput from './ToggleInput'
import { SCALE_BINARY, SCALE_ALIAS, AwarenessBadge } from './AwarenessBadges'

export default function RelationshipKnownBySection({
  relationship,
  anchorNodeId = null,
  isExpanded = false,
  onToggleExpand,
}) {
  const projectNodes = useProjectStore((s) => s.nodes)
  const projectEdges = useProjectStore((s) => s.edges)
  const commitAwarenessAtAnchor = useProjectStore((s) => s.commitAwarenessAtAnchor)
  const commitAwarenessTrackingAtAnchor = useProjectStore((s) => s.commitAwarenessTrackingAtAnchor)
  const updateRelationship = useProjectStore((s) => s.updateRelationship)
  const storyOrder = useStoryOrder()

  // The relationship's creation anchor counts as origin for the
  // setter — at-or-before-creation writes go to baseline.
  const creationNodeId = useMemo(
    () => relationship ? getRelationshipCreationNodeId(relationship, projectNodes, anchorNodeId) : null,
    [relationship, projectNodes, anchorNodeId],
  )
  const isOriginAnchor = !anchorNodeId || anchorNodeId === creationNodeId

  // Picker value: wrapper-shape resolved at the current anchor via
  // the chain walker. Walker correctly distinguishes events at THIS
  // anchor (which apply) from events DOWNSTREAM (which don't) — at
  // origin the only events that apply are those whose `node_id` IS
  // the relationship's origin scene. That keeps the v0.2a.2.0-era
  // invariant (downstream `tracking_action: 'on'` events don't
  // falsely flip origin to tracking-ON) AND closes the bug where
  // awareness data stored as history events anchored AT origin
  // (legitimate data shape) was being stripped, producing a false
  // tracking-OFF in the picker.
  const pickerValue = useMemo(() => {
    if (!relationship) return null
    const nodeOrder = getRelationshipNodeOrder(relationship, projectNodes, projectEdges, storyOrder)
    const eff = computeRelationshipEffectiveState(relationship, nodeOrder, anchorNodeId, { storyOrder })
    return eff?.awareness_raw ?? eff?.awareness ?? null
  }, [relationship, anchorNodeId, projectNodes, projectEdges, storyOrder])

  if (!relationship) return null

  const handleChange = (next) => {
    commitAwarenessAtAnchor({
      target: { kind: 'relationship', relationshipId: relationship.id },
      anchor: { kind: isOriginAnchor ? 'origin' : 'chain', nodeId: isOriginAnchor ? null : anchorNodeId },
      draft: next,
    })
  }

  const isTracking = pickerValue != null

  function handleToggleTrack() {
    commitAwarenessTrackingAtAnchor({
      target: { kind: 'relationship', relationshipId: relationship.id },
      anchor: { kind: isOriginAnchor ? 'origin' : 'chain', nodeId: isOriginAnchor ? null : anchorNodeId },
      action: isTracking ? 'off' : 'on',
    })
  }

  const canExpand = isTracking
  const effectivelyExpanded = canExpand && isExpanded

  const labelName = relationship.name?.trim() || 'this relationship'

  // Per-relationship awareness scale (binary {0,3} vs full {0,1,2,3}).
  // Baseline-only field, settable from any anchor since it's a
  // presentation-layer choice, not a chain-tracked value.
  const currentScale = relationship.awareness_scale === 'full' ? 'full' : 'binary'
  const isFull = currentScale === 'full'
  const extraTrackingRow = (
    <div className="flex items-center gap-2">
      <label className="text-[10px] text-zinc-500 uppercase tracking-wider flex-shrink-0">Precision</label>
      <div className="inline-flex rounded border border-zinc-700 overflow-hidden">
        {[
          { key: 'binary', levels: [0, 3] },
          { key: 'full',   levels: [0, 1, 2, 3] },
        ].map((opt) => {
          const active = currentScale === opt.key
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => {
                if (currentScale === opt.key) return
                updateRelationship(relationship.id, { ...relationship, awareness_scale: opt.key })
              }}
              title={opt.key === 'binary' ? 'Binary: known / not known' : 'Graduated: four awareness levels'}
              className={`inline-flex items-center gap-0.5 px-1.5 py-1 transition-colors ${
                active
                  ? 'bg-zinc-700 ring-2 ring-inset ring-accent-500'
                  : 'bg-zinc-900 opacity-50 hover:opacity-80 hover:bg-zinc-800'
              }`}
            >
              {opt.levels.map((lvl) => (
                <AwarenessBadge key={lvl} level={lvl} size={12} />
              ))}
            </button>
          )
        })}
      </div>
    </div>
  )

  return (
    <div data-help-region="awareness-display:relationship_known_by">
      {/* Section header — always visible. Clicking the row toggles
          expansion when the section can expand (tracking is on). The
          toggle pill on the right governs tracking on/off; clicks on
          the toggle don't bubble up to the row's expand handler. */}
      <div
        className={`flex items-center justify-between gap-2 px-1 py-1.5 ${canExpand ? 'cursor-pointer hover:bg-zinc-800/30' : 'cursor-default'} transition-colors`}
        onClick={canExpand && onToggleExpand ? onToggleExpand : undefined}
      >
        <span className="text-[10px] text-zinc-400 uppercase tracking-wider whitespace-nowrap flex-shrink-0">Known by…</span>
        <div className="flex items-center gap-1 flex-shrink-0 min-w-0">
          <span className="flex flex-col items-end text-[7px] text-zinc-500 select-none leading-tight">
            <span className="whitespace-nowrap">Track who knows</span>
            <span className="whitespace-nowrap">{labelName}</span>
          </span>
          <span onClick={(e) => e.stopPropagation()} className="flex-shrink-0">
            <ToggleInput
              value={isTracking}
              onCommit={() => handleToggleTrack()}
            />
          </span>
          <span className={`text-[8px] ml-1 flex-shrink-0 ${canExpand ? 'text-zinc-600' : 'text-zinc-800'}`}>
            {canExpand ? (effectivelyExpanded ? '▲' : '▼') : ''}
          </span>
        </div>
      </div>

      {/* Body — picker drag-and-drop levels + sources. Internal toggle
          row suppressed (it lives in the section header above). Only
          rendered when the section is expanded AND tracking is on. */}
      {effectivelyExpanded && (
        <div className="pt-1">
          <AwarenessPicker
            value={pickerValue}
            onChange={handleChange}
            surface="relationship"
            mode="groups"
            scale={isFull ? SCALE_ALIAS : SCALE_BINARY}
            parentEntityId={null}
            context={{ relationshipName: labelName }}
            extraTrackingRow={extraTrackingRow}
            hideToggleRow
          />
        </div>
      )}
    </div>
  )
}
