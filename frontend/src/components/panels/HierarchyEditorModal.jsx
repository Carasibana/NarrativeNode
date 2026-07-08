import { useEffect, useRef, useCallback } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import HierarchyTreeView from '../ui/HierarchyTreeView'

const TYPE_LABELS = {
  location: 'Location Hierarchy',
  faction: 'Faction Hierarchy',
}

export default function HierarchyEditorModal() {
  const open = useUiStore((s) => s.hierarchyEditorOpen)
  const entityType = useUiStore((s) => s.hierarchyEditorEntityType)
  const close = useUiStore((s) => s.closeHierarchyEditor)
  const setDetailPanel = useUiStore((s) => s.setDetailPanel)
  const setSidebarTab = useUiStore((s) => s.setSidebarTab)
  const setHierarchyParent = useProjectStore((s) => s.setHierarchyParent)
  const nodes = useProjectStore((s) => s.nodes)
  const panelRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    function onPointer(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) close()
    }
    function onKey(e) { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  const handleSelect = useCallback((entityId) => {
    const originNode = nodes.find(
      (n) => n.type === 'entityNode' && !n.data.is_modifier && n.data.entity_id === entityId
    )
    if (originNode) {
      close()
      setSidebarTab('details')
      setDetailPanel('entityNode', originNode.id, entityId, 0)
    }
  }, [nodes, close, setSidebarTab, setDetailPanel])

  if (!open || !entityType) return null

  const title = TYPE_LABELS[entityType] || 'Hierarchy'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        ref={panelRef}
        data-help-region="hierarchy-editor:modal"
        className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl flex flex-col"
        style={{ width: 320, maxHeight: '80vh' }}
      >
        {/* Header */}
        <div data-help-region="hierarchy-editor:header" className="flex items-center justify-between px-3 py-2 border-b border-zinc-700 flex-shrink-0">
          <span className="text-sm font-medium text-zinc-200">{title}</span>
          <button
            className="w-6 h-6 flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700 rounded text-sm"
            onClick={close}
            title="Close"
          >
            ×
          </button>
        </div>

        {/* Tree */}
        <div data-help-region="hierarchy-editor:tree" className="overflow-y-auto flex-1 min-h-0">
          <HierarchyTreeView
            entityTypeFilter={entityType}
            onSelect={handleSelect}
            onReparent={(childId, newParentId) => setHierarchyParent(childId, newParentId)}
          />
        </div>
      </div>
    </div>
  )
}
