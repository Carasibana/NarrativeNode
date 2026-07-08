/**
 * KnownBySection — entity-existence awareness section in the entity
 * Detail Panel's Awareness sub-tab. Owns its own collapsible section
 * header (clickable row with `Known by…` label, `Track who knows
 * <Name>` toggle + switch, and an expand chevron) and renders the
 * universal `<AwarenessPicker>` (with its internal toggle row hidden)
 * as the body when expanded.
 *
 * Header semantics:
 *   - Toggle ON / OFF flips entity-existence tracking via the universal
 *     anchor-aware setter. Toggle OFF emits `null`; ON emits a seed
 *     dict (`{ entity.id: 3 }`) so the picker has something to render.
 *   - Chevron is only clickable when tracking is on. With tracking off
 *     there's nothing to expand into — the body would be empty — so
 *     the section stays collapsed.
 *
 * Expansion is CONTROLLED by the parent (`isExpanded` / `onToggleExpand`)
 * so the parent can implement mutual-exclusivity with the sibling
 * `<AwareOfSection>` (only one expanded at a time).
 *
 * Anchor-aware:
 *   - At origin (the entity's origin node): writes the picker's emitted
 *     value to the entity's library row via the universal setter.
 *   - At any non-origin chain anchor (scene chip or modifier node): the
 *     setter diffs against chain-resolved prior and writes a chain
 *     entry on the entity's `awareness.history` list. The library
 *     row's baseline `awareness` is never touched.
 */

import { useMemo } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { computeEffectiveState } from '../../utils/narrativeChain'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import AwarenessPicker from '../entities/AwarenessPicker'
import { SCALE_BINARY, SCALE_ALIAS, AwarenessBadge, DEFAULT_AWARENESS_LEVEL } from './AwarenessBadges'
import ToggleInput from './ToggleInput'

export default function KnownBySection({
  entity,
  anchorKind = 'origin',
  anchorNodeId = null,
  isExpanded = false,
  onToggleExpand,
}) {
  const projectNodes = useProjectStore((s) => s.nodes)
  const projectEdges = useProjectStore((s) => s.edges)
  const commitAwarenessAtAnchor = useProjectStore((s) => s.commitAwarenessAtAnchor)
  const commitAwarenessTrackingAtAnchor = useProjectStore((s) => s.commitAwarenessTrackingAtAnchor)
  const updateEntity = useEntitiesStore((s) => s.updateEntity)
  const storyOrder = useStoryOrder()

  const isOriginAnchor = anchorKind === 'origin' || !anchorNodeId

  // Picker value: wrapper-shape resolved at the current anchor via
  // the chain walker. Walker correctly distinguishes events at THIS
  // anchor (which apply) from events DOWNSTREAM (which don't) — at
  // origin the only events that apply are those whose `node_id` IS
  // the host's origin scene. That keeps the v0.2a.2.0-era invariant
  // (downstream `tracking_action: 'on'` events don't falsely flip
  // origin to tracking-ON) AND closes the bug where awareness data
  // stored as history events anchored AT origin (legitimate data
  // shape — see Phase 2.11 Bugs & Fixes ToDo) was being stripped
  // out, producing a false tracking-OFF in the picker.
  const pickerValue = useMemo(() => {
    if (!entity) return null
    const eff = computeEffectiveState(entity, projectNodes, projectEdges, anchorNodeId, { storyOrder })
    return eff?.awareness_raw ?? eff?.awareness ?? null
  }, [entity, anchorNodeId, projectNodes, projectEdges, storyOrder])

  if (!entity) return null

  const handleChange = (next) => {
    commitAwarenessAtAnchor({
      target: { kind: 'entity', entityId: entity.id },
      anchor: { kind: isOriginAnchor ? 'origin' : 'chain', nodeId: anchorNodeId },
      draft: next,
    })
  }

  // Tracking state derived from the picker value at the current anchor.
  // null = off; any non-null value (incl. empty `{}` wrapper) = on.
  const isTracking = pickerValue != null

  function handleToggleTrack() {
    // Tracking on/off is itself a chain-tracked event. Route through
    // the dedicated tracking-toggle action so chain-anchor toggles
    // write a tracking_on / tracking_off history entry instead of
    // (incorrectly) trying to encode the toggle as a per-observer diff.
    commitAwarenessTrackingAtAnchor({
      target: { kind: 'entity', entityId: entity.id },
      anchor: { kind: isOriginAnchor ? 'origin' : 'chain', nodeId: anchorNodeId },
      action: isTracking ? 'off' : 'on',
    })
  }

  // Chevron is only meaningful when there's a body to expand into.
  // Tracking off → no body → no chevron, header is non-expandable.
  const canExpand = isTracking
  const effectivelyExpanded = canExpand && isExpanded

  // Per-entity awareness scale (binary {0,3} vs full {0,1,2,3}). Baseline-
  // only field on the entity itself; settable from any anchor since
  // it's a presentation-layer choice not a chain-tracked value.
  const currentScale = entity.awareness_scale === 'full' ? 'full' : 'binary'
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
                updateEntity(entity.id, { ...entity, awareness_scale: opt.key })
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
    <div data-help-region="awareness-display:known_by">
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
            <span className="whitespace-nowrap">{entity.name || 'this'}</span>
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

      {/* Body — picker drag-and-drop levels + Precision row + sources.
          Internal toggle row suppressed (it lives in the section header
          above). Only rendered when the section is expanded AND
          tracking is on. */}
      {effectivelyExpanded && (
        <div className="pt-1">
          <AwarenessPicker
            value={pickerValue}
            onChange={handleChange}
            surface="entity"
            mode="groups"
            scale={isFull ? SCALE_ALIAS : SCALE_BINARY}
            parentEntityId={entity.id}
            context={{ parentName: entity.name || 'this entity' }}
            extraTrackingRow={extraTrackingRow}
            hideToggleRow
          />
        </div>
      )}
    </div>
  )
}
