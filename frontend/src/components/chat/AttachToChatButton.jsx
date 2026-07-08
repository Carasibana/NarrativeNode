/**
 * Phase 2.7a/b — shared "Add as context" button.
 *
 * Used by every surface that lets the writer attach a story object to
 * the currently-open conversation in one click: detail-panel header
 * (entity / knowledge / relationship / scene), canvas-node corner
 * (entity origin, modifier, knowledge origin, relationship origin,
 * scene), and the scene-chip corner.
 *
 * Visibility-gated by `useIsChatOpenOnConversation()` — the button
 * renders null when no conversation is the active view inside the
 * chat panel, so the writer never sees a control that would be a
 * no-op.
 *
 * `anchorNodeId` is the canonical chain-anchor for the resulting
 * pin. The id is a canvas node id of ANY type — the entity's origin
 * EntityNode (resolves at origin baseline), a modifier EntityNode
 * (resolves at that modifier's chain position), a sceneNode
 * (resolves at the scene), a knowledge / relationship origin node,
 * etc. The chain walker takes a node id and doesn't care about
 * type, so the pill resolves uniformly. Callers MUST pass the right
 * node id for the surface; the button records it verbatim.
 *
 * Toggle behaviour: when an anchored pin already exists for this
 * `(kind, id, anchor_node_id)` triple, the click unpins instead of
 * pinning. Re-clicking re-pins.
 */
import { usePinnedContextStore } from '../../store/pinnedContextStore'
import { useConversationsStore } from '../../store/conversationsStore'
import { useIsChatOpenOnConversation } from '../../hooks/useIsChatOpenOnConversation'
import { useAiDisabled } from '../../hooks/useAiDisabled'
import { confirmAndApplyAnchoredCommit } from '../../utils/pinnedContextMerge'
import AttachToChatGlyph from './AttachToChatGlyph'

export default function AttachToChatButton({
  kind,
  id,
  size = 14,
  title,
  className = '',
  anchorNodeId = null,
  onAttached = null,
  // When set, the click handler will swallow the event so it doesn't
  // bubble to ancestor drag/select handlers (canvas nodes especially).
  stopPropagation = false,
}) {
  const aiDisabled = useAiDisabled()
  const visible = useIsChatOpenOnConversation()
  // Per-thread chat surface key — pinning is scoped to the currently-
  // active conversation. `useIsChatOpenOnConversation()` already gates
  // this component on `activeThreadId` being non-null, so this resolves
  // to a real key when visible.
  const activeThreadId = useConversationsStore((s) => s.activeThreadId)
  const surfaceKey = activeThreadId ? `chat:${activeThreadId}` : null
  const addPin = usePinnedContextStore((s) => s.addPin)
  const removePin = usePinnedContextStore((s) => s.removePin)
  // Look up an existing pin for this (kind, id, anchor_node_id) on
  // the active chat thread. Returns a primitive string (sessionId)
  // or null. Legacy dynamic pins (no anchor) don't collide because
  // the button ALWAYS sets an anchor and the lookup is anchor-
  // discriminated.
  const matchAnchor = anchorNodeId || null
  const existingSessionId = usePinnedContextStore((s) => {
    if (!surfaceKey) return null
    const list = s.surfaces[surfaceKey] || []
    for (const item of list) {
      if (item.kind !== kind || item.id !== id) continue
      if ((item.anchor_node_id || null) !== matchAnchor) continue
      return item.sessionId
    }
    return null
  })
  if (aiDisabled) return null
  if (!visible) return null
  if (!kind || !id) return null
  const isPinned = !!existingSessionId
  const titleAdd = title || `Add ${kind} as context to the open conversation`
  const titleRemove = `Remove this ${kind} from the open conversation's context`
  const resolvedTitle = isPinned ? titleRemove : titleAdd
  const padPx = size <= 11 ? 1 : 2
  return (
    <button
      type="button"
      onClick={async (e) => {
        if (stopPropagation) {
          e.preventDefault()
          e.stopPropagation()
        }
        if (!surfaceKey) return
        if (isPinned) {
          removePin(surfaceKey, existingSessionId)
          return
        }
        const payload = { kind, id }
        if (anchorNodeId) payload.anchor_node_id = anchorNodeId
        // Anchored adds route through `confirmAndApplyAnchoredCommit`
        // so the strict-no-overlap-with-merge rule fires consistently
        // across every attach surface. Dynamic adds (no anchor) go
        // straight to the store — exempt from the merge rule by spec.
        if (payload.anchor_node_id) {
          const result = await confirmAndApplyAnchoredCommit(surfaceKey, payload, null)
          if (result?.committed && onAttached) onAttached()
        } else {
          addPin(surfaceKey, payload)
          if (onAttached) onAttached()
        }
      }}
      onMouseDown={stopPropagation ? (e) => e.stopPropagation() : undefined}
      title={resolvedTitle}
      aria-label={resolvedTitle}
      data-help-region="attach-to-chat:button"
      className={
        `inline-flex items-center justify-center rounded text-zinc-300 hover:text-accent-300 hover:bg-zinc-700/60 transition-colors ${className}`
      }
      style={{ padding: padPx, lineHeight: 0 }}
    >
      <AttachToChatGlyph size={size} mode={isPinned ? 'remove' : 'add'} />
    </button>
  )
}
