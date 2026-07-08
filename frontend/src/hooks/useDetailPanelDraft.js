/**
 * useDetailPanelDraft — shared draft mechanism for every Detail Panel view.
 *
 * Replaces the per-view `useState(draft)` blocks that historically lived in
 * each detail view (`EntityDetailView` had one; `RelationshipDetailView` /
 * `KnowledgeDetailView` / `SceneDetailView` committed on blur). One hook,
 * one mechanism, every kind of subject plugs into it.
 *
 * Architectural rule (from the planning doc that governs the Detail Panel
 * shell): the shell stays type-agnostic. The hook is the SHARED MECHANISM,
 * not the shell. Views call the hook themselves — they don't pass type
 * info into the shell.
 *
 * Slot semantics deliberately match the legacy `useState(null)` shape so
 * existing view code (notably `(d) => ({ ...(d ?? initDraft()), ... })`
 * patterns) keeps working unchanged: `draft` is null when clean,
 * populated when dirty; `setDraft(updater)` passes the current slot
 * value (possibly null) to the updater. Initial-state derivation stays
 * in the view (the view computes its own initDraft when needed, just as
 * it did before). The hook is a slot manager + nav-guard wiring +
 * tryProceed, nothing more.
 *
 * Args:
 *   draftKey  — stable identifier for the current subject (entity id,
 *               relationship id, knowledge id, scene id; typically a
 *               composite that distinguishes anchor positions too).
 *               When this changes, the hook clears the in-store slot so
 *               the new subject starts clean. Use `null` if the view
 *               has no meaningful subject yet.
 *   save      — async closure invoked when the user clicks Confirm in
 *               the Save bar OR Confirm-and-continue in the Unsaved-
 *               changes popup. Receives no arguments — the view reads
 *               its own draft. The hook clears the slot AFTER `save`
 *               resolves, so any `setDraft(null)` inside the closure is
 *               redundant but harmless.
 *   discard   — optional sync closure invoked when the user clicks
 *               Discard / Discard-and-continue. The hook clears the
 *               slot regardless; this closure is for view-side
 *               cleanup (closing transient UI like "Add attribute"
 *               forms). May be omitted.
 *
 * Returns:
 *   draft       — current slot value (null when clean).
 *   setDraft    — `(updater) => void`. Updater is either an object
 *                 (replaces the slot) or a function `(prev) => next`
 *                 (called with the current slot value, which may be
 *                 null — the view uses `?? initDraft()` to fall back to
 *                 fresh initial state, matching the legacy useState
 *                 idiom). Pass `null` directly to clear the slot.
 *   isDirty     — true when the slot is non-null.
 *   save        — async wrapper calling the caller's `save` closure,
 *                 then clearing the slot.
 *   discard     — wrapper calling the caller's `discard` closure
 *                 (if provided), then clearing the slot.
 *   tryProceed  — `(continuation) => Promise<boolean>`. Runs the same
 *                 popup as the navigation guard. If clean, runs
 *                 `continuation()` and returns true. If dirty, opens
 *                 the Unsaved-changes popup; on Confirm, runs save +
 *                 continuation; on Discard, clears + continuation; on
 *                 Cancel, returns false without running. Use this for
 *                 "open sibling editor" affordances (awareness modal
 *                 triggers etc.) that would otherwise hide the draft.
 *
 * Nav-guard lifecycle: when isDirty is true, the hook registers a
 * navigation guard via `registerNavigationGuard` (already wired into
 * `setDetailPanel` / `clearDetailPanel` in `uiStore`). The guard opens
 * the Unsaved-changes popup and resolves to true (proceed) or false
 * (cancel) per user choice. When isDirty becomes false, the guard is
 * cleared. Cleanup on unmount.
 */

import { useEffect, useRef } from 'react'
import { useUiStore } from '../store/uiStore'
import { confirm } from '../store/dialogStore'
import { buildUnsavedChangesMessage } from '../components/ui/popupMessages'

const UNSAVED_CHANGES_BUTTONS = [
  { label: 'Confirm and continue', value: 'confirm', style: 'primary'  },
  { label: 'Discard and continue', value: 'discard', style: 'danger'   },
  { label: 'Cancel',               value: 'cancel',  style: 'neutral'  },
]

export function useDetailPanelDraft({ draftKey, save: saveFn, discard: discardFn }) {
  const storeDraft     = useUiStore((s) => s._detailPanelDraft)
  const storeDraftKey  = useUiStore((s) => s._detailPanelDraftKey)
  const setStoreDraft  = useUiStore((s) => s._setDetailPanelDraft)
  const registerGuard  = useUiStore((s) => s.registerNavigationGuard)
  const clearGuard     = useUiStore((s) => s.clearNavigationGuard)

  // Reset the slot when the subject changes. The user already passed any
  // nav guard to get here (or there was no draft to guard), so dropping
  // the slot is safe — its contents belonged to a different subject.
  useEffect(() => {
    if (storeDraftKey !== draftKey) {
      setStoreDraft(null, draftKey)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])

  // `draft` matches the legacy useState shape exactly: null when clean,
  // populated when dirty. View code reading `draft.x` continues to gate
  // on `isDirty` first, just as before.
  const isDirty = storeDraft !== null && storeDraftKey === draftKey
  const draft   = isDirty ? storeDraft : null

  // Refs so the guard / tryProceed see the latest closures across renders.
  const saveFnRef    = useRef(saveFn)
  const discardFnRef = useRef(discardFn)
  saveFnRef.current    = saveFn
  discardFnRef.current = discardFn

  function setDraft(updater) {
    if (typeof updater === 'function') {
      // Read from the store at call time so rapid successive
      // updater-form calls within the same render don't race against
      // captured-from-render `storeDraft`. Equivalent to `useState`'s
      // functional-updater guarantee.
      const live = useUiStore.getState()
      const liveBase = (live._detailPanelDraftKey === draftKey) ? live._detailPanelDraft : null
      const next = updater(liveBase)
      setStoreDraft(next, draftKey)
    } else {
      setStoreDraft(updater, draftKey)
    }
  }

  async function save() {
    if (saveFnRef.current) await saveFnRef.current()
    setStoreDraft(null, draftKey)
  }

  function discard() {
    if (discardFnRef.current) {
      try { discardFnRef.current() } catch { /* discard cleanup must never throw */ }
    }
    setStoreDraft(null, draftKey)
  }

  // Single resolver for the Unsaved-changes popup — reused by both the
  // navigation guard (subject switch / panel close) and tryProceed (open
  // sibling editor). Returns true if the caller may proceed (user chose
  // Confirm or Discard), false to abort (user chose Cancel).
  async function resolveUnsavedChanges() {
    const result = await confirm({
      title: 'Unsaved changes',
      message: buildUnsavedChangesMessage(),
      buttons: UNSAVED_CHANGES_BUTTONS,
    })
    if (result === 'confirm') { await save(); return true }
    if (result === 'discard') { discard(); return true }
    return false
  }

  // Register / clear nav guard based on dirty state.
  useEffect(() => {
    if (isDirty) {
      registerGuard(() => resolveUnsavedChanges())
    } else {
      clearGuard()
    }
    return () => clearGuard()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty])

  // Public — call before opening any sibling editor that reads off the
  // saved store rather than the panel draft (awareness modals, etc.).
  // Runs the continuation only if the user permits.
  async function tryProceed(continuation) {
    if (!isDirty) {
      if (continuation) continuation()
      return true
    }
    const ok = await resolveUnsavedChanges()
    if (ok && continuation) continuation()
    return ok
  }

  return { draft, setDraft, isDirty, save, discard, tryProceed }
}
