/**
 * NotesFooterButton — Phase 1.21d Step E
 *
 * Layer 2 detail-panel-section component. Footer button that opens (or
 * toggles closed) the right-sidebar Notes editor for the active object.
 *
 * Layer-3 callers pass a `surface` discriminator (`'entity' | 'knowledge'`)
 * + the object's `id`. The internal `SURFACE_CONFIG` table maps the
 * surface to the appropriate `uiStore` action + active-state field.
 * Pattern A from the planning doc § "Discriminator pattern" — same
 * rendering and interactions across all consumers; only the data
 * adapter (which store action / which active-state key) varies.
 *
 * Behaviour:
 *   - Click → if the right sidebar is already open for THIS object's
 *     notes, close it. Otherwise open the notes editor for this object.
 *
 * Add a fourth field to `SURFACE_CONFIG` to support a third surface
 * (e.g. relationship notes if/when that lands) — a 4-line addition,
 * no rendering changes.
 */

import { useUiStore } from '../../store/uiStore'

const SURFACE_CONFIG = {
  entity: {
    openAction:    'openEntityNotes',
    activeStateKey: 'rightSidebarEntityNotesId',
  },
  knowledge: {
    openAction:    'openKnowledgeNotes',
    activeStateKey: 'rightSidebarKnowledgeNotesId',
  },
}

export default function NotesFooterButton({ surface, id }) {
  const cfg = SURFACE_CONFIG[surface]
  if (!cfg || !id) return null

  function handleClick() {
    const s = useUiStore.getState()
    if (s.rightSidebarOpen && s[cfg.activeStateKey] === id) {
      s.closeRightSidebar()
    } else {
      s[cfg.openAction](id)
    }
  }

  return (
    <div className="border-t border-zinc-700 p-2 flex-shrink-0" data-help-region="detail-panel:notes_button">
      <button
        onClick={handleClick}
        className="w-full px-2 py-1.5 text-xs rounded bg-accent-700/20 border border-accent-700/40 text-accent-300 hover:bg-accent-700/40 hover:text-accent-200 transition-colors"
      >
        ✎ Notes
      </button>
    </div>
  )
}
