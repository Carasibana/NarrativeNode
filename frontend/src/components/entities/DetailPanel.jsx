import { useState, useEffect } from 'react'
import { useUiStore } from '../../store/uiStore'
import SceneDetailView from './SceneDetailView'
import EntityDetailView from './EntityDetailView'
import RelationshipDetailView from './RelationshipDetailView'
import KnowledgeDetailView from './KnowledgeDetailView'
import ReferenceDetailView from './ReferenceDetailView'
import EmptyDetailState from './EmptyDetailState'

// ── Detail Panel (top-level dispatcher embedded in unified sidebar) ───────────
// Reads `activeSelection` and `detailPanelMode` from the ui-store and renders
// the appropriate Layer-3 *DetailView for the current selection. Hosts the
// shared `subTab` / `showAddAttr` state consumed by the entity views.

export default function DetailPanel() {
  const activeSelection = useUiStore((s) => s.activeSelection)
  const mode     = useUiStore((s) => s.detailPanelMode)
  const requestedShowAddAttr = useUiStore((s) => s.detailPanelShowAddAttr)
  // Active sub-tab lives in the store so it survives DetailPanel
  // unmount/remount during transient sidebar-tab flips (e.g. the
  // empty-selection branch of React Flow's onSelectionChange briefly
  // clears the panel before the new entity origin click lands —
  // previously that blew away the local 'awareness' pick on every
  // origin-node click). The store action `setDetailPanel` handles
  // resetting to 'details' only when navigating to a different entity.
  const storeSubTab = useUiStore((s) => s.detailPanelActiveSubTab)
  const setSubTab = useUiStore((s) => s.setDetailPanelActiveSubTab)
  // The store slot is shared across panel kinds. When navigating from
  // a scene (whose tab keys are 'details' / 'changes') into an entity
  // panel (whose keys are 'details' / 'attributes' / 'relationships' /
  // 'awareness'), the slot may carry a value the entity view doesn't
  // recognise — without coercion the body renders blank because each
  // body branch is gated on an exact-match tab key. Default to 'details'
  // when the carried value isn't a valid entity tab.
  const ENTITY_SUB_TABS = ['details', 'attributes', 'relationships', 'awareness']
  const subTab = ENTITY_SUB_TABS.includes(storeSubTab) ? storeSubTab : 'details'
  const [showAddAttr, setShowAddAttr] = useState(false)

  // One-shot "Add Attribute" form trigger from context menu
  useEffect(() => {
    if (requestedShowAddAttr) {
      setShowAddAttr(true)
      useUiStore.setState({ detailPanelShowAddAttr: false })
    }
  }, [requestedShowAddAttr])

  // Relationship + Knowledge selections take precedence over `detailPanelMode`
  // (those flows drive selection through `activeSelection` rather than the
  // mode/entityId pair used by entity / scene views).
  if (activeSelection?.kind === 'relationship') {
    return <RelationshipDetailView key={activeSelection.id} />
  }
  if (activeSelection?.kind === 'knowledge') {
    return <KnowledgeDetailView key={activeSelection.id} />
  }
  // Phase 8.6 — Concept / Note reference node selection.
  if (activeSelection?.kind === 'reference') {
    return <ReferenceDetailView key={activeSelection.id} />
  }

  if (!mode) {
    // Phase 5.2b — cover + title + author, with the hint centred beneath.
    return <EmptyDetailState />
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 min-h-0 overflow-hidden">
        {mode === 'scene'              && <SceneDetailView />}
        {mode === 'entityNode'         && <EntityDetailView anchorKind="origin"   subTab={subTab} setSubTab={setSubTab} showAddAttr={showAddAttr} setShowAddAttr={setShowAddAttr} />}
        {mode === 'entityChip'         && <EntityDetailView anchorKind="chip"     subTab={subTab} setSubTab={setSubTab} showAddAttr={showAddAttr} setShowAddAttr={setShowAddAttr} />}
        {mode === 'entityNodeModifier' && <EntityDetailView anchorKind="modifier" subTab={subTab} setSubTab={setSubTab} showAddAttr={showAddAttr} setShowAddAttr={setShowAddAttr} />}
      </div>
    </div>
  )
}
