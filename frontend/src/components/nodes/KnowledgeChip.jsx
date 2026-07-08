import { useMemo, useState } from 'react'
import { Position } from '@xyflow/react'
import PortHandle from '../canvas/PortHandle'
import { useProjectStore } from '../../store/projectStore'
import { useUiStore } from '../../store/uiStore'
import { useDialogStore } from '../../store/dialogStore'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import {
  getKnowledgeNodeOrder,
  computeKnowledgeEffectiveState,
} from '../../utils/narrativeChain'
import { KNOWLEDGE_COLOUR } from '../ui/IdentityBadges'
import ImageHoverPreview from '../ui/ImageHoverPreview'
import { useAccentColor } from '../../utils/povConstants'
import ChangeSubChip from '../ui/change-subchips/ChangeSubChip'
import { knowledgeContentChangeToSubChip } from '../ui/change-subchips/knowledgeChangeAdapter'
import AttachToChatButton from '../chat/AttachToChatButton'

/**
 * Phase 1.21c — Knowledge chip on scenes.
 *
 * Auto-spawned inside a <SceneNode> for every Knowledge whose chain
 * (as returned by `getKnowledgeNodeOrder`) includes this scene's id. That
 * covers both paths that put the scene on the Knowledge's chain:
 *   - at least one history entry at this scene (any kind — name,
 *     description, colour, profile_image, or awareness); OR
 *   - a manual anchor pinning the Knowledge to this scene.
 *
 * The chip renders:
 *   - parchment-tan identity border + left bar (matches
 *     `<KnowledgeOriginNode>` and `<KnowledgeLabelChip>`)
 *   - chain-resolved avatar (or 📜 placeholder) + chain-resolved name
 *   - per-content-change-kind `~` indicator: one each for name /
 *     description / colour / profile_image when the corresponding
 *     `knowledge.history.*_changes` array has an entry at THIS scene.
 *   - NO inline awareness-change indicators — awareness deltas surface on
 *     the observer entity's chip per the Step 9 design.
 *
 * Active highlight: when the Knowledge Detail Panel's chain nav lands on
 * this scene (`activeSelection.kind === 'knowledge'` +
 * `activeSelection.id === knowledge.id` + `activeSelection.atNodeId ===
 * nodeId`), the chip swaps its identity outline for the user's accent
 * colour, matching the entity / relationship chip active convention.
 *
 * Ports: input (left) + output (right) — mirror entity / relationship
 * chip pattern. Wire-creation handlers for these ports are NOT wired in
 * this commit (see the port descriptors in `portCatalogue.js` — the
 * accept/emit rules are placeholder and will tighten in a follow-up).
 */
// Phase 4.1g #3 — stable handle-style identity. KNOWLEDGE_COLOUR is a
// module constant, so this style never varies; hoisting it keeps the
// PortHandle props stable across chip re-renders.
const KNOWLEDGE_CHIP_HANDLE_STYLE = Object.freeze({
  width: 10, height: 10, background: KNOWLEDGE_COLOUR, border: '2px solid #18181b',
  right: -11, top: 8, transform: 'none',
})

export default function KnowledgeChip({ nodeId, knowledge, parentNodeType = 'sceneNode' }) {
  const [hovered, setHovered] = useState(false)
  const accentColor = useAccentColor()

  const openKnowledgeDetail = useUiStore((s) => s.openKnowledgeDetail)
  const activeSelection     = useUiStore((s) => s.activeSelection)
  const confirm             = useDialogStore((s) => s.confirm)

  const storeNodes = useProjectStore((s) => s.nodes)
  const storeEdges = useProjectStore((s) => s.edges)
  const removeKnowledgeReferencesAtScene = useProjectStore(
    (s) => s.removeKnowledgeReferencesAtScene,
  )
  const removeKnowledgeContentChangeAtNode = useProjectStore(
    (s) => s.removeKnowledgeContentChangeAtNode,
  )
  const storyOrder = useStoryOrder()

  const isSelected = activeSelection?.kind === 'knowledge'
    && activeSelection?.id === knowledge.id
    && activeSelection?.atNodeId === nodeId

  // Chain order including this Knowledge's history + manual anchors. Used
  // both for the effective-state walk and (implicitly, by the parent
  // SceneNode auto-spawn loop) for deciding whether to render us at
  // all.
  const nodeOrder = useMemo(
    () => getKnowledgeNodeOrder(knowledge, storeNodes, storeEdges, storyOrder),
    [knowledge, storeNodes, storeEdges, storyOrder],
  )

  // Resolve name / colour / profile image as of THIS scene's chain
  // position. Without this the chip would show base-library values and
  // miss any upstream change.
  const effective = useMemo(
    () => computeKnowledgeEffectiveState(knowledge, nodeOrder, nodeId, { nodes: storeNodes }),
    [knowledge, nodeOrder, nodeId, storeNodes],
  )

  const displayName = effective?.name || knowledge.name || '(unnamed)'
  const displayColour = effective?.colour || knowledge.colour || KNOWLEDGE_COLOUR
  const profileRef = effective?.profile_image_ref ?? knowledge.profile_image_ref ?? null
  const assetName = profileRef ? profileRef.replace(/^assets\//, '') : null

  // Per-kind content-change rows landing at this scene. Each row gets
  // its own `<ChangeSubChip>` rendered below the chip header (the same
  // sub-chip component used for entity content changes — Phase 1.21d
  // Step F unified the rendering). Awareness-change history is
  // intentionally not surfaced here — those flow to the observer
  // entity's chip in the dedicated awareness sub-chip section.
  const contentChangesAtScene = useMemo(() => {
    const h = knowledge.history || {}
    const out = []
    const nameEntry = (h.name_changes || []).find((c) => c.node_id === nodeId)
    if (nameEntry) out.push({ field: 'name', entry: nameEntry, key: nameEntry.id || 'name' })
    const descEntry = (h.description_changes || []).find((c) => c.node_id === nodeId)
    if (descEntry) out.push({ field: 'description', entry: descEntry, key: descEntry.id || 'description' })
    const colourEntry = (h.colour_changes || []).find((c) => c.node_id === nodeId)
    if (colourEntry) out.push({ field: 'colour', entry: colourEntry, key: colourEntry.id || 'colour' })
    const imgEntry = (h.profile_image_changes || []).find((c) => c.node_id === nodeId)
    if (imgEntry) out.push({ field: 'profile_image', entry: imgEntry, key: imgEntry.id || 'profile_image' })
    return out
  }, [knowledge.history, nodeId])

  // Effective state at the chain position IMMEDIATELY BEFORE this scene.
  // The adapter (`knowledgeContentChangeToSubChip`) uses this to populate
  // the `oldValue` / `oldImageRef` half of each change-chip diff. When
  // there's no prior chain step (this scene is the first chain stop), we
  // fall back to the Knowledge's base values. Mirrors the entity-side
  // priorState pattern in `EntityNode.jsx`.
  const priorEffective = useMemo(() => {
    const idx = (nodeOrder || []).indexOf(nodeId)
    if (idx <= 0) {
      return {
        name: knowledge.name,
        description: knowledge.description,
        colour: knowledge.colour,
        profile_image_ref: knowledge.profile_image_ref ?? null,
      }
    }
    return computeKnowledgeEffectiveState(knowledge, nodeOrder, nodeOrder[idx - 1], { nodes: storeNodes })
  }, [knowledge, nodeOrder, nodeId, storeNodes])

  // Scene-born creation detection. True only when this chip IS the
  // Knowledge's actual birth scene — earliest `existence_changes`
  // activate event in story order, with no canvas `<KnowledgeOriginNode>`
  // taking precedence. Manual anchors and other chain entries do NOT
  // qualify (mirrors how `<RelationshipChip>` filters to history-event
  // nodes only — manual-anchor presence at a scene doesn't make it a
  // birth scene).
  const isSceneBornOriginChip = useMemo(() => {
    if (parentNodeType !== 'sceneNode') return false
    const hasKnowledgeOriginNode = storeNodes.some(
      (n) => n.type === 'knowledgeOriginNode' && n.data?.knowledge_id === knowledge.id,
    )
    if (hasKnowledgeOriginNode) return false
    const activates = (knowledge.history?.existence_changes || [])
      .filter((c) => c?.action === 'activate' && c?.node_id)
      .map((c) => c.node_id)
    if (activates.length === 0) return false
    const activateSet = new Set(activates)
    // `nodeOrder` is in story order; pick the first node that's also an
    // activate event — that's the birth scene.
    const birthId = (nodeOrder || []).find((id) => activateSet.has(id))
    return birthId === nodeId
  }, [parentNodeType, storeNodes, knowledge.id, knowledge.history, nodeOrder, nodeId])

  // Phase 1.21c — orphan-Knowledge indicator. True when the Knowledge
  // has no creation anchor at all (no `<KnowledgeOriginNode>` on canvas
  // AND no `existence_changes: activate` event in history). Mirrors the
  // entity-chip orphan ⚮ badge convention but uses parchment ∅ to
  // match the alerts pane / library indicator. The chip exists at this
  // scene because of a manual anchor or downstream history entry, but
  // the Knowledge has no defined point of first existence.
  const hasNoOrigin = useMemo(() => {
    const hasOriginNode = storeNodes.some(
      (n) => n.type === 'knowledgeOriginNode' && n.data?.knowledge_id === knowledge.id,
    )
    if (hasOriginNode) return false
    const hasActivate = (knowledge.history?.existence_changes || [])
      .some((c) => c?.action === 'activate' && c?.node_id)
    return !hasActivate
  }, [storeNodes, knowledge.id, knowledge.history])

  const handleClick = (e) => {
    e.stopPropagation()
    openKnowledgeDetail(knowledge.id, nodeId)
  }

  async function handleRemove(e) {
    e.stopPropagation()
    const ok = await confirm({
      title: 'Remove Knowledge from scene',
      message: `Remove "${displayName}" from this scene? Any changes recorded for it here will be discarded.`,
      buttons: [
        { label: 'Remove', value: 'ok', style: 'danger' },
        { label: 'Cancel', value: 'cancel', style: 'default' },
      ],
    })
    if (ok === 'ok') removeKnowledgeReferencesAtScene(knowledge.id, nodeId)
  }

  // Parchment-tan outline at rest; accent outline when active. Matches
  // the two-tone treatment on <RelationshipChip> / <EntityNode>.
  const outlineColour = isSelected ? accentColor : `${KNOWLEDGE_COLOUR}55`
  const leftBarColour = isSelected ? accentColor : KNOWLEDGE_COLOUR

  return (
    <div
      data-help-region="knowledge-chip:chip"
      className="relative flex flex-col pl-2 pr-1 pt-0.5 pb-0.5 rounded nodrag cursor-pointer"
      style={{
        backgroundColor: '#1c1c2e',
        borderTopWidth: 1,
        borderRightWidth: 1,
        borderBottomWidth: 1,
        borderLeftWidth: 2,
        borderStyle: 'solid',
        borderTopColor:    outlineColour,
        borderRightColor:  outlineColour,
        borderBottomColor: outlineColour,
        borderLeftColor:   leftBarColour,
        boxShadow: isSelected ? `0 0 0 1px ${accentColor}66` : undefined,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={handleClick}
      title={`${displayName} — click to open Knowledge Detail Panel at this scene`}
    >
      {/* Output port — action-only awareness-grant emitter. Mirrors
          `<KnowledgeOriginNode>`'s output exactly: drag the wire onto an
          entity origin / modifier / chip to grant that entity awareness
          of this Knowledge at the target's chain position; drop on a
          scene's general-in handle to add a manual anchor. No persistent
          edge stored.

          The chip has no input port by design: the Knowledge chain is
          purely derived from awareness-grant placements + manual anchors
          + content-change history entries. A wire-driven chain would be
          redundant data + a sync hazard, so the chip is a one-way
          emitter with no inbound wiring affordance. */}
      <PortHandle
        nodeId={nodeId}
        nodeType={parentNodeType}
        type="source"
        position={Position.Right}
        id={`knowledge-chip-out-${knowledge.id}`}
        style={KNOWLEDGE_CHIP_HANDLE_STYLE}
      />

      {/* Phase 2.7b — chain-anchored "Add as context" button. Anchored
          to this scene so the attached payload carries the Knowledge's
          chain-resolved state at this scene anchor. Self-gates on the
          chat-open hook. */}
      <AttachToChatButton
        kind="knowledge"
        id={knowledge.id}
        anchorNodeId={nodeId}
        size={10}
        title="Add this knowledge at this scene as context to the open conversation"
        stopPropagation
        className={`absolute top-0.5 right-5 transition-opacity ${hovered ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      />

      {/* Hover-only remove button — strips every reference to this
          Knowledge at this scene (manual anchor + every chain-history
          entry at this node_id). Mirrors the relationship chip ✕ pattern. */}
      <button
        className={`absolute top-0.5 right-0.5 w-3.5 h-3.5 flex items-center justify-center rounded text-[11px] font-bold leading-none transition-all hover:bg-red-500/25 hover:text-red-400 nodrag ${hovered ? 'opacity-100 text-zinc-500' : 'opacity-0 pointer-events-none'}`}
        onClick={handleRemove}
        title="Remove this Knowledge from this scene"
      >−</button>

      {/* `NEW : KNOWLEDGE` badge when this scene IS the Knowledge's creation
          point (no canvas KnowledgeOriginNode AND this is the earliest
          chain-relevant scene). Mirrors <RelationshipChip>'s
          `NEW : RELATIONSHIP` badge for scene-born relationships. */}
      {isSceneBornOriginChip && (
        <span
          className="text-[9px] uppercase tracking-widest font-semibold px-1.5 py-0.5 rounded flex-shrink-0 self-start mb-0.5"
          style={{ color: KNOWLEDGE_COLOUR, backgroundColor: KNOWLEDGE_COLOUR + '22' }}
          title="Creation point of this Knowledge"
        >
          NEW : KNOWLEDGE
        </span>
      )}

      {/* Header row — avatar + chain-resolved name. `pr-5` reserves
          space for the absolutely-positioned remove ✕ in the top-right
          corner so right-side indicators (the orphan ∅, ~ change tags)
          don't get overlapped on hover. `items-center` aligns the
          indicator glyphs vertically with the avatar + name baseline
          (was `items-start` which pinned the ∅ flush to the top edge,
          looking off-centre against the 14px avatar). */}
      <div className="flex items-center gap-1 min-w-0 pr-5">
        <ImageHoverPreview
          src={assetName ? `/api/project/assets/${assetName}` : null}
          borderColour={displayColour}
          size={80}
        >
          <span
            className="inline-flex items-center justify-center rounded-sm flex-shrink-0 overflow-hidden leading-none select-none mt-[1px]"
            style={{
              width: 14,
              height: 14,
              border: `1.5px solid ${displayColour}`,
              backgroundColor: assetName ? 'transparent' : `${displayColour}22`,
              fontSize: 8,
            }}
            title={displayName}
          >
            {assetName ? (
              <img
                src={`/api/project/assets/${assetName}`}
                alt=""
                className="w-full h-full object-cover"
              />
            ) : (
              <span style={{ lineHeight: 1 }}>📜</span>
            )}
          </span>
        </ImageHoverPreview>

        <span
          className="text-[10px] text-zinc-200 flex-1 min-w-0 truncate"
          style={{ color: displayColour }}
          title={displayName}
        >
          {displayName}
        </span>

        {/* Indicator slot — currently only the orphan ∅ badge. Per-
            content-change indicators are rendered below the chip header
            as proper `<ChangeSubChip>` rows (unified with the entity
            sub-chip convention in Phase 1.21d Step F). Awareness-change
            deltas continue to render on the observer entity's chip per
            Phase 1.21c Tier 4. */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {hasNoOrigin && (
            <span
              className="text-red-400 text-[10px] leading-none"
              title="No creation anchor on canvas. Add an origin point at a scene (drag from library onto a scene) or as a Knowledge origin node (drag onto empty canvas)."
            >∅</span>
          )}
        </div>
      </div>

      {/* Per-content-change sub-chip block — one row per change kind
          landing at this scene. Hidden when no content changes at this
          scene (the chip is then rendered solely because of an
          awareness change, manual anchor, or birth event). */}
      {contentChangesAtScene.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {contentChangesAtScene.map((c) => {
            const chipDescriptor = knowledgeContentChangeToSubChip(c.field, c.entry, priorEffective)
            if (!chipDescriptor) return null
            return (
              <ChangeSubChip
                key={c.key}
                chip={chipDescriptor}
                entityColour={displayColour}
                onClick={() => openKnowledgeDetail(knowledge.id, nodeId)}
                onDismiss={() => removeKnowledgeContentChangeAtNode(knowledge.id, c.field, nodeId)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
