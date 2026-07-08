/**
 * useMultiSelectActive — Phase 1.11 Track I.
 *
 * Returns `true` when MORE THAN ONE node is currently selected on the
 * canvas, `false` otherwise. Backed by a Zustand selector so React only
 * re-renders subscribers when the boolean actually flips (crossing the
 * 1-vs-2 threshold), not on every unrelated store update.
 *
 * Used by each custom node component to gate the dashed selection
 * outline: the outline should only appear in multi-select mode, not on
 * a plain single-click selection (single-click visuals are whatever
 * each node component already renders — accent boxShadow on the detail-
 * panel-active node for plot point / entity nodes, POV glow on the POV
 * origin, solid body border on groups, etc.).
 *
 * Deliberately NOT stored as a separate state slice on any store: we
 * derive it on every render from the authoritative `nodes` array, so
 * it can never drift out of sync with React Flow's selection state.
 * That was the lag bug in v0.1.11.46 — a cached flag was being updated
 * via a separate code path than React Flow's selection updates, so the
 * most recently Ctrl+clicked node lost a frame. A pure derivation
 * removes the caching entirely.
 */

import { useProjectStore } from '../store/projectStore'

export function useMultiSelectActive() {
  return useProjectStore((s) => {
    let count = 0
    for (const n of s.nodes) {
      if (n.selected) {
        count++
        if (count > 1) return true
      }
    }
    return false
  })
}
