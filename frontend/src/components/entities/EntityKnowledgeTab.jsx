import { useMemo, useState } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import { computeKnowledgeEffectiveState, knowledgeExistsAtNode } from '../../utils/narrativeChain'
import {
  AwarenessLevelSelector,
  SCALE_ALIAS,
  SCALE_BINARY,
  DEFAULT_AWARENESS_LEVEL,
  awarenessLabelsFor,
} from '../ui/AwarenessBadges'
import { KnowledgeLabelChip } from '../ui/IdentityBadges'
import KnowledgePickerPopover from './KnowledgePickerPopover'

/**
 * Entity Detail Panel "Knowledge" sub-tab content (Phase 1.21c Step 7).
 *
 * Surfaces the set of Knowledges this observer entity currently has any
 * awareness state for, at the current chain position. Each row renders the
 * Knowledge identity chip + an `AwarenessLevelSelector` pill + a remove `×`.
 *
 * **All edits write to `Knowledge.history.awareness_changes` at the
 * current chain node** — entity origin node, scene chip, or modifier
 * node — via `setKnowledgeAwarenessAtNode` / `removeKnowledgeAwarenessAtNode`.
 *
 * **Edits never write to `Knowledge.awareness` (story-origin) from this
 * panel.** Story-origin represents the world's pre-story baseline awareness
 * ("what was already known before the story began") and is editable only
 * from the Knowledge Detail Panel itself. If we wrote entity-awareness to
 * the story-origin dict, the chain walker would back-fill the entity as
 * having known the Knowledge from before they even appeared in the story
 * — which contradicts the entity's actual introduction node.
 *
 * Writes never touch `EntityRef.awareness_changes` either — Knowledge is
 * its own object and owns its own chain-time history.
 *
 * Props:
 *   entityId    — the observer entity whose known-Knowledges are being listed
 *   nodeId      — current chain anchor (entity origin node, scene, or modifier
 *                 node id). Required; the panel disables editing without one.
 *   entityName  — display-name used in the empty-state prompt and header.
 */
export default function EntityKnowledgeTab({ entityId, nodeId, entityName }) {
  const knowledges = useProjectStore((s) => s.knowledges)
  const nodes = useProjectStore((s) => s.nodes)
  const edges = useProjectStore((s) => s.edges)
  const setKnowledgeAwarenessAtNode    = useProjectStore((s) => s.setKnowledgeAwarenessAtNode)
  const removeKnowledgeAwarenessAtNode = useProjectStore((s) => s.removeKnowledgeAwarenessAtNode)

  const storyOrder = useStoryOrder()

  const [pickerOpen, setPickerOpen] = useState(false)

  // Knowledges that don't exist yet at the current chain position are
  // excluded from rows AND the picker (Phase 1.21c Step 15 creation-point
  // gating). The chain walker returns notYetExists=true for those, but
  // also for safety we guard explicitly in the picker via knowledgeExistsAtNode.
  const existingKnowledges = useMemo(() => {
    return (knowledges || []).filter(
      (k) => knowledgeExistsAtNode(k, nodeId, nodes, edges, storyOrder),
    )
  }, [knowledges, nodeId, nodes, edges, storyOrder])

  const hiddenByCreationPoint = (knowledges?.length ?? 0) - existingKnowledges.length

  // Build the row list by walking every Knowledge that exists at this
  // chain position and pulling the observer's effective awareness level.
  // Includes level 0 (explicitly unaware) — any explicit entry is worth
  // surfacing.
  const rows = useMemo(() => {
    const orderIds = storyOrder?.orderedIds || []
    const result = []
    for (const k of existingKnowledges) {
      const effective = computeKnowledgeEffectiveState(k, orderIds, nodeId, { nodes })
      if (effective?.notYetExists) continue
      const awareness = effective?.awareness
      if (!awareness || typeof awareness !== 'object') continue
      // AwarenessRef — not locally resolvable to per-observer levels without
      // the referenced relationship; Phase 1.21f wires that resolution.
      if ('relationship_id' in awareness) continue
      if (!(entityId in awareness)) continue
      result.push({ knowledge: k, level: awareness[entityId] })
    }
    return result
  }, [existingKnowledges, storyOrder, nodeId, nodes, entityId])

  const knownIds = useMemo(() => new Set(rows.map((r) => r.knowledge.id)), [rows])

  function commitLevel(knowledgeId, level) {
    if (!nodeId) return
    setKnowledgeAwarenessAtNode(knowledgeId, entityId, nodeId, level)
  }

  function commitRemove(knowledgeId) {
    if (!nodeId) return
    removeKnowledgeAwarenessAtNode(knowledgeId, entityId, nodeId)
  }

  function handlePick(knowledgeId) {
    commitLevel(knowledgeId, DEFAULT_AWARENESS_LEVEL)
    setPickerOpen(false)
  }

  const canEdit = !!nodeId

  return (
    <div data-help-region="detail-panel:awareness_knowledge" className="space-y-2">
      <div className="text-[10px] text-zinc-500 italic">
        What <span className="text-zinc-300">{entityName || 'this entity'}</span> knows
        {nodeId ? ' at this chain position' : ' (no chain anchor; pick a chip or origin node)'}.
      </div>

      {rows.length === 0 && !pickerOpen && (
        <p className="text-[11px] text-zinc-600 italic px-1 py-2">
          No tracked awareness of any Knowledge at this position yet.
        </p>
      )}

      {hiddenByCreationPoint > 0 && (
        <p className="text-[10px] text-zinc-600 italic px-1">
          {hiddenByCreationPoint} knowledge{hiddenByCreationPoint === 1 ? '' : 's'} hidden — {hiddenByCreationPoint === 1 ? "it doesn't" : "they don't"} exist yet at this chain position.
        </p>
      )}

      {rows.map(({ knowledge, level }) => {
        const scale = (knowledge.awareness_scale || 'full') === 'binary' ? SCALE_BINARY : SCALE_ALIAS
        const scaleWithLabels = {
          ...scale,
          labels: awarenessLabelsFor('knowledge', { parentName: knowledge.name || 'this knowledge' }),
        }
        return (
          <div
            key={knowledge.id}
            data-help-region="detail-panel:awareness_knowledge_row"
            className="flex items-center gap-1.5 px-1.5 py-1 rounded bg-zinc-800/40 border border-zinc-700"
          >
            <span className="min-w-0 flex-1 truncate">
              <KnowledgeLabelChip name={knowledge.name || '(unnamed)'} />
            </span>
            <AwarenessLevelSelector
              scale={scaleWithLabels}
              value={level}
              onChange={(lvl) => commitLevel(knowledge.id, lvl)}
              disabled={!canEdit}
            />
            {canEdit && (
              <button
                type="button"
                onClick={() => commitRemove(knowledge.id)}
                className="text-zinc-500 hover:text-red-400 leading-none ml-0.5 text-xs"
                title="Remove awareness of this Knowledge at this position"
              >×</button>
            )}
          </div>
        )
      })}

      {canEdit && (
        <div>
          {!pickerOpen ? (
            <button
              data-help-region="detail-panel:awareness_knowledge_add"
              type="button"
              onClick={() => setPickerOpen(true)}
              className="text-[10px] text-accent-400 hover:text-accent-300"
            >
              + Add Knowledge…
            </button>
          ) : (
            <KnowledgePickerPopover
              allKnowledges={existingKnowledges}
              excludeIds={knownIds}
              onPick={handlePick}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>
      )}
    </div>
  )
}
