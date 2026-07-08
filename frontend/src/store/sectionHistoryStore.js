/**
 * sectionHistoryStore — per-Section session-only Snapshot list with
 * Step back / Step forward navigation (Phase 2.9a item 8).
 *
 * Parallel to the editor's own undo/redo and the canvas-level undo
 * stack — NOT part of either. Section History is the writer's
 * non-destructive layer that captures the Section's content state
 * at the two moments specified in planning doc §1.5:
 *
 *   (1) Send-time — when an Apply to Editor Section lands in a
 *       Section, OR when a Prompt Block Header fires, the PRE-Send
 *       state of the Section's content is captured. Gives the
 *       writer a return point to whatever was there pre-Send.
 *   (2) AI-response-end — when a streaming AI response stops
 *       (whether completed normally OR cancelled mid-stream by the
 *       writer), the Section's then-current content becomes a
 *       Snapshot. Partial output from an interrupted stream is
 *       captured the same way so the writer can step forward to
 *       recover it if they want; we don't throw partials away.
 *
 * Section History is session-only — never persists. Only the live
 * state at save-time is written to disk.
 *
 * **Trigger wiring lives in the AI write paths**, not in this store.
 * Phase 2.9b (Apply to Editor Section) and Phase 2.9c (Prompt Block
 * Header Send) call `pushSnapshot(sectionId, content)` at the two
 * moments above. This store provides the data + the
 * Step back / Step forward navigation; it has no opinion on WHEN
 * snapshots get pushed.
 *
 * State shape:
 *
 *   history: {
 *     [sectionId]: {
 *       snapshots:    Array<Fragment-as-JSON>  // each entry is the
 *                                              // section's children
 *                                              // fragment captured as
 *                                              // TipTap JSON (an array
 *                                              // of block-node objects).
 *       currentIndex: number   // index of the snapshot currently applied
 *                              // to the live document; -1 if no snapshots.
 *     }
 *   }
 *
 * Step back walks the index down; Step forward walks it up. The
 * caller is responsible for applying the returned snapshot to the
 * editor's document (this store is decoupled from the editor).
 *
 * Section-delete cleanup: callers should `clear(sectionId)` when a
 * Section is destroyed so the history map doesn't leak.
 */

import { create } from 'zustand'

function isSameAsLast(snapshots, currentIndex, content) {
  if (currentIndex < 0 || currentIndex >= snapshots.length) return false
  return JSON.stringify(snapshots[currentIndex]) === JSON.stringify(content)
}

export const useSectionHistoryStore = create((set, get) => ({
  history: {},

  /**
   * Push a new snapshot for the given Section id. If the Section's
   * history pointer is in the middle of the list (writer has stepped
   * back), the forward history is truncated before the new snapshot
   * is appended — diverging from a stepped-back state forks the
   * timeline forward, dropping the old branch (undo/redo convention).
   *
   * Deduplicates: if the snapshot is byte-identical to the current
   * snapshot, no-op. Avoids cluttering history with consecutive
   * identical states.
   *
   * `content` is the Section's children fragment as TipTap JSON — an
   * array of block-node objects (NOT a single wrapper-node object).
   * The Section node's own attrs (id, name) are not part of the
   * snapshot; only what's INSIDE the Section.
   */
  pushSnapshot: (sectionId, content) => {
    if (!sectionId) return
    set((state) => {
      const existing = state.history[sectionId] || { snapshots: [], currentIndex: -1 }
      if (isSameAsLast(existing.snapshots, existing.currentIndex, content)) {
        return state
      }
      const truncated = existing.snapshots.slice(0, existing.currentIndex + 1)
      const nextSnapshots = [...truncated, content]
      return {
        history: {
          ...state.history,
          [sectionId]: {
            snapshots: nextSnapshots,
            currentIndex: nextSnapshots.length - 1,
          },
        },
      }
    })
  },

  /**
   * Decrement the section's currentIndex by 1. Returns the snapshot
   * at the new index (the caller applies it to the editor), or null
   * if the section is already at the start of its history.
   */
  stepBack: (sectionId) => {
    const h = get().history[sectionId]
    if (!h || h.currentIndex <= 0) return null
    const nextIndex = h.currentIndex - 1
    set((state) => ({
      history: {
        ...state.history,
        [sectionId]: { ...h, currentIndex: nextIndex },
      },
    }))
    return h.snapshots[nextIndex]
  },

  /**
   * Increment the section's currentIndex by 1. Returns the snapshot
   * at the new index (the caller applies it to the editor), or null
   * if the section is already at the end of its history.
   */
  stepForward: (sectionId) => {
    const h = get().history[sectionId]
    if (!h || h.currentIndex >= h.snapshots.length - 1) return null
    const nextIndex = h.currentIndex + 1
    set((state) => ({
      history: {
        ...state.history,
        [sectionId]: { ...h, currentIndex: nextIndex },
      },
    }))
    return h.snapshots[nextIndex]
  },

  /**
   * Remove a section's history entry entirely. Call this when the
   * Section is deleted so the map doesn't leak entries that no
   * longer correspond to any live Section.
   */
  clear: (sectionId) => {
    set((state) => {
      if (!(sectionId in state.history)) return state
      const next = { ...state.history }
      delete next[sectionId]
      return { history: next }
    })
  },
}))
