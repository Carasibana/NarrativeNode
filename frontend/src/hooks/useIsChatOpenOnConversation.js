/**
 * Phase 2.7 visibility gate -- `is the chat window open on a
 * conversation that can have context added to it`.
 *
 * Returns true ONLY when BOTH:
 *   - The chat panel is open (`uiStore.chatPanelOpen`).
 *   - A thread is the active view inside that panel
 *     (`conversationsStore.activeThreadId`), as opposed to the
 *     thread-browser landing.
 *
 * Every Phase 2.7 "add as context" affordance reads this hook to
 * decide whether to render itself at all -- when there's no open
 * conversation to attach to, the affordances stay hidden so the
 * writer isn't presented with controls that would be no-ops:
 *   - drop-zone overlay for library drag-and-drop onto the
 *     composer's external-files drop zone;
 *   - "add as context" button in the left-sidebar detail panel
 *     header (lower right of the name/avatar area);
 *   - "add as context" button on canvas nodes that represent
 *     attachable objects;
 *   - "add as context" button on scene-node chips (which uses the
 *     chip's chain anchor as the "version at this scene" reference
 *     for the attachment).
 *
 * Pure derivation hook. Reads both stores via their own selectors
 * so subscribers re-render only when the relevant slice flips.
 * No side effects; safe to call from any component.
 */
import { useUiStore } from '../store/uiStore'
import { useConversationsStore } from '../store/conversationsStore'

export function useIsChatOpenOnConversation() {
  const chatPanelOpen = useUiStore((s) => s.chatPanelOpen)
  const activeThreadId = useConversationsStore((s) => s.activeThreadId)
  return chatPanelOpen && !!activeThreadId
}

/**
 * Non-hook variant for use outside React (e.g. inside a store
 * action that needs to branch on the gate). Reads the same two
 * stores synchronously via `.getState()` — no subscription is
 * established, so the caller is responsible for invoking this at
 * a moment when reading current state makes sense (typically
 * inside an event handler, not during a render).
 */
export function isChatOpenOnConversation() {
  const chatPanelOpen = useUiStore.getState().chatPanelOpen
  const activeThreadId = useConversationsStore.getState().activeThreadId
  return chatPanelOpen && !!activeThreadId
}
