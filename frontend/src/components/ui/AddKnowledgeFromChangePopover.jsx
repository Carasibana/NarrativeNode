/**
 * AddKnowledgeFromChangePopover — small two-option popover anchored to
 * the "Add knowledge of this change" button on a change sub-chip.
 *
 * Lets the writer either:
 *   - Make a new Knowledge from this change (Path A) — opens the
 *     name + creation-anchor flow, sets the new Knowledge's
 *     `source_event` baseline to the triggering change.
 *   - Attach to an existing Knowledge (Path B) — opens a Knowledge
 *     picker, writes a chain entry on the chosen Knowledge's
 *     `source_event_changes` list at the trigger scene.
 *
 * Both paths are opt-in per click; closing without picking writes
 * nothing. State drives via `useUiStore.addKnowledgeFromChangePopover`.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import { resolveKnowledgeCreationPoint } from '../../utils/narrativeChain'
import { KnowledgeIcon, KNOWLEDGE_COLOUR } from './IdentityBadges'
import KnowledgePickerPopover from '../entities/KnowledgePickerPopover'

export default function AddKnowledgeFromChangePopover() {
  const config = useUiStore((s) => s.addKnowledgeFromChangePopover)
  const close = useUiStore((s) => s.closeAddKnowledgeFromChangePopover)
  const popoverRef = useRef(null)
  const allKnowledges = useProjectStore((s) => s.knowledges)
  const attachKnowledgeSourceEvent = useProjectStore((s) => s.attachKnowledgeSourceEvent)
  const projectNodes = useProjectStore((s) => s.nodes)
  const projectEdges = useProjectStore((s) => s.edges)
  const storyOrder = useStoryOrder()
  // Two-step popover: 'menu' = the make-new / attach-existing chooser;
  // 'picker' = the embedded KnowledgePickerPopover for Path B. Reset
  // back to 'menu' whenever the popover opens fresh.
  const [view, setView] = useState('menu')
  useEffect(() => { if (config) setView('menu') }, [config])

  // Eligibility filter: only Knowledges whose creation point is at-or-
  // before the trigger node in story order can be attached. A
  // Knowledge created later than this change can't logically represent
  // it (the Knowledge didn't exist yet at this chain position).
  // Computed against the trigger node id from the popover config; the
  // story-order index of the trigger sets the cutoff.
  const excludeIds = useMemo(() => {
    const ex = new Set()
    if (!config?.triggerNodeId) return ex
    const orderIds = storyOrder?.orderedIds || []
    if (!Array.isArray(orderIds) || orderIds.length === 0) return ex
    const triggerIdx = orderIds.indexOf(config.triggerNodeId)
    if (triggerIdx < 0) return ex
    for (const k of (allKnowledges || [])) {
      const { creationOrderIndex } = resolveKnowledgeCreationPoint(k, projectNodes, projectEdges, storyOrder)
      if (creationOrderIndex === -Infinity) continue   // pre-story-baseline Knowledge — eligible everywhere
      if (creationOrderIndex > triggerIdx) ex.add(k.id)
    }
    return ex
  }, [allKnowledges, projectNodes, projectEdges, storyOrder, config?.triggerNodeId])

  // Click-outside to close. Use capture phase + pointerdown so we
  // catch the event before React Flow / other interactive parents
  // call stopPropagation on it. Defer registration via rAF so the
  // opening click that just fired doesn't immediately close us.
  useEffect(() => {
    if (!config) return
    let active = false
    function onDown(e) {
      if (!active) return
      if (popoverRef.current && popoverRef.current.contains(e.target)) return
      close()
    }
    const raf = requestAnimationFrame(() => { active = true })
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [config, close])

  if (!config) return null

  // Anchor positioning — place the popover just below-and-right of the
  // click point. Caller passes a DOMRect; we offset slightly so the
  // popover doesn't cover the button.
  const rect = config.anchorRect
  const top = rect ? Math.round(rect.bottom + 4) : 80
  const left = rect ? Math.round(rect.left) : 80

  function handleMakeNew() {
    // Path A — open the existing "+ New Knowledge" modal pre-filled
    // with the suggested name, the trigger scene as the creation
    // anchor, and the source-event back-pointer carried along to land
    // on the new Knowledge's baseline `source_event` field. Cancelling
    // the modal aborts cleanly with no writes.
    if (config?.sourceEvent && config?.triggerNodeId) {
      useUiStore.getState().openNewKnowledgeModal(null, {
        suggestedName: config.suggestedName,
        sourceEvent: config.sourceEvent,
        triggerNodeId: config.triggerNodeId,
        eventDisplay: config.eventDisplay,
      })
    }
    close()
  }

  function handleAttachExisting() {
    // Path B — swap the popover into picker view; on pick we'll
    // commit a source_event_changes chain entry on the chosen
    // Knowledge and close the popover.
    setView('picker')
  }

  function handlePickKnowledge(knowledgeId) {
    if (config?.sourceEvent && config?.triggerNodeId && knowledgeId) {
      attachKnowledgeSourceEvent(knowledgeId, config.sourceEvent, config.triggerNodeId)
    }
    close()
  }

  return (
    <div
      ref={popoverRef}
      className="fixed z-[9999] bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl text-xs min-w-[260px] overflow-hidden"
      style={{ top, left }}
      onClick={(e) => e.stopPropagation()}
      role="menu"
      data-help-region="add-knowledge-from-change:popover"
    >
      <div className="px-3 py-2 border-b border-zinc-700 text-[10px] uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
        <KnowledgeIcon size={12} />
        <span style={{ color: KNOWLEDGE_COLOUR }}>Knowledge of this change</span>
      </div>
      {view === 'menu' && (
        <>
          <button
            onClick={handleMakeNew}
            className="w-full text-left px-3 py-2 hover:bg-zinc-700 text-zinc-200 transition-colors flex items-center gap-2"
            data-help-region="add-knowledge-from-change:make_new"
          >
            <span className="text-green-400 font-bold leading-none text-sm">✚</span>
            <span className="flex-1">Make a new Knowledge from this change</span>
          </button>
          {/* Path B is offered only when the trigger isn't an entity
              origin. At origin, the entity is just coming into
              existence — there's nothing earlier to attach an
              existing Knowledge to. Per-trigger eligibility (a
              Knowledge whose own creation point is later than this
              change can't represent it) is enforced via excludeIds
              when the picker opens. */}
          {!config?.isOrigin && (
            <button
              onClick={handleAttachExisting}
              className="w-full text-left px-3 py-2 hover:bg-zinc-700 text-zinc-200 transition-colors flex items-center gap-2 border-t border-zinc-700"
              data-help-region="add-knowledge-from-change:attach_existing"
            >
              <KnowledgeIcon size={12} />
              <span className="flex-1">Attach to an existing Knowledge…</span>
            </button>
          )}
        </>
      )}
      {view === 'picker' && (
        <KnowledgePickerPopover
          allKnowledges={allKnowledges || []}
          excludeIds={excludeIds}
          onPick={handlePickKnowledge}
          onClose={() => setView('menu')}
        />
      )}
    </div>
  )
}
