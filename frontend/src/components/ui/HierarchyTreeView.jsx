import { useState, useMemo, useCallback, useRef } from 'react'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProjectStore } from '../../store/projectStore'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import ImageHoverPreview from './ImageHoverPreview'
import ObjectTagsButton from '../tags/ObjectTagsButton'
import { matchesProjectTagFilterBySet, chainWideTagIdsForHost, isEmptyTagFilter } from '../../utils/tagFilter'
import { EntityLabelChip } from './IdentityBadges'

const LEVEL_W = 14   // px per indentation level
const BASE_PAD = 4   // px left padding for root-level content
const LINE_X = 5     // px from start of each level block to the vertical line
const LINE_CLR = '#3f3f46'  // zinc-700

export default function HierarchyTreeView({
  entityTypeFilter,
  uninstantiatedIds = new Set(),
  onSelect,
  onLocate,
  onDelete,
  onAddOriginNode,
  onReparent,
  nameFilter = '',
  tagFilter = null,
}) {
  const characters = useEntitiesStore((s) => s.characters)
  const locations = useEntitiesStore((s) => s.locations)
  const items = useEntitiesStore((s) => s.items)
  const factions = useEntitiesStore((s) => s.factions)
  const customs = useEntitiesStore((s) => s.customs)
  const knowledges = useProjectStore((s) => s.knowledges)
  // Phase 3.4i — canvas nodes for the chain-aware tag walk inside
  // ObjectTagsButton. Read at panel-mount level so each row doesn't
  // resubscribe individually.
  const nodes = useProjectStore((s) => s.nodes)

  // Phase 1.24a — Library tab quick-filter. When `nameFilter` is set,
  // narrow the entities list to those whose name OR description
  // matches (case-insensitive substring). Tree relationships are
  // re-derived from the filtered set, so non-matching parents simply
  // disappear and their matching descendants surface as new roots.
  // The filter is a baseline read at origin context — the library is
  // the canonical "view from origin" surface — so reading
  // `entity.name` / `entity.description` here is chain-correct.
  //
  // Phase 3.4i — also apply the optional Project Tag filter (chain-
  // wide ever-tagged semantic). Same intersection contract as the
  // entity-tab path in `EntityLibraryPanel`.
  const entities = useMemo(() => {
    const all = [...characters, ...locations, ...items, ...factions, ...customs, ...(knowledges || [])]
    const typed = entityTypeFilter ? all.filter((e) => e.type === entityTypeFilter) : all
    const q = nameFilter ? String(nameFilter).trim().toLowerCase() : ''
    const applyName = !!q
    const applyTags = tagFilter && !isEmptyTagFilter(tagFilter)
    if (!applyName && !applyTags) return typed
    return typed.filter((e) => {
      if (applyName) {
        const hit = (e.name && String(e.name).toLowerCase().includes(q))
          || (e.description && String(e.description).toLowerCase().includes(q))
        if (!hit) return false
      }
      if (applyTags) {
        const tagSet = chainWideTagIdsForHost(e, e.type, nodes)
        if (!matchesProjectTagFilterBySet(tagSet, tagFilter)) return false
      }
      return true
    })
  }, [characters, locations, items, factions, customs, knowledges, entityTypeFilter, nameFilter, tagFilter, nodes])

  const { entityById, roots, childrenOf, cycleIds } = useMemo(() => {
    const entityById = new Map(entities.map((e) => [e.id, e]))
    const childrenOf = new Map()
    for (const entity of entities) {
      if (entity.parent_id && entityById.has(entity.parent_id)) {
        if (!childrenOf.has(entity.parent_id)) childrenOf.set(entity.parent_id, [])
        childrenOf.get(entity.parent_id).push(entity.id)
      }
    }
    const roots = entities.filter((e) => !e.parent_id || !entityById.has(e.parent_id))
    // Detect entities caught in a parent_id cycle (not reachable from any true root).
    // Find the minimal cycle members, then surface ONE representative per cycle as a
    // synthetic root so the subtree stays intact and the user can drag to fix it.
    const reachable = new Set()
    function visit(id) {
      if (reachable.has(id)) return
      reachable.add(id)
      for (const childId of (childrenOf.get(id) || [])) visit(childId)
    }
    for (const r of roots) visit(r.id)
    const unreachable = new Set(entities.filter(e => !reachable.has(e.id)).map(e => e.id))

    // Walk each unreachable entity's parent_id chain to identify actual cycle members.
    const cycleNodes = new Set()
    for (const id of unreachable) {
      const path = []
      const pathSet = new Set()
      let cur = id
      while (cur && unreachable.has(cur) && !pathSet.has(cur)) {
        path.push(cur); pathSet.add(cur)
        cur = entityById.get(cur)?.parent_id
      }
      if (cur && pathSet.has(cur)) {
        let recording = false
        for (const p of path) {
          if (p === cur) recording = true
          if (recording) cycleNodes.add(p)
        }
      }
    }

    // Pick one representative per cycle to add as a synthetic root.
    // Walking the cycle from each chosen representative marks the others as covered
    // so we don't add duplicate roots and explode the subtree.
    const cycleRootCandidates = []
    const assignedCycleNodes = new Set()
    for (const id of cycleNodes) {
      if (assignedCycleNodes.has(id)) continue
      cycleRootCandidates.push(id)
      let cur = entityById.get(id)?.parent_id
      const seen = new Set([id])
      while (cur && cycleNodes.has(cur) && !seen.has(cur)) {
        assignedCycleNodes.add(cur); seen.add(cur)
        cur = entityById.get(cur)?.parent_id
      }
    }

    const allRoots = cycleRootCandidates.length > 0
      ? [...roots, ...cycleRootCandidates.map(id => entityById.get(id)).filter(Boolean)]
      : roots
    return { entityById, roots: allRoots, childrenOf, cycleIds: cycleNodes }
  }, [entities])

  const [collapsed, setCollapsed] = useState(new Set())
  const hierDragIdRef = useRef(null)
  const [hierDragId, setHierDragId] = useState(null)
  const [hierDragOverId, setHierDragOverId] = useState(null)
  const [hierDragOverTopLevel, setHierDragOverTopLevel] = useState(false)

  const clearDragState = useCallback(() => {
    hierDragIdRef.current = null
    setHierDragId(null)
    setHierDragOverId(null)
    setHierDragOverTopLevel(false)
  }, [])

  const toggleCollapsed = useCallback((entityId) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(entityId)) next.delete(entityId)
      else next.add(entityId)
      return next
    })
  }, [])

  // connX: x position of the vertical line for this depth level
  function connX(depth) { return (depth - 1) * LEVEL_W + BASE_PAD + LINE_X }

  function renderNode(entityId, depth, visited, isLast, ancestorHasMore) {
    if (visited.has(entityId)) return null
    const entity = entityById.get(entityId)
    if (!entity) return null
    const children = childrenOf.get(entityId) || []
    const isCollapsed = collapsed.has(entityId)
    const colour = entity.colour || '#888888'
    const assetName = entity.profile_image_ref?.replace(/^assets\//, '') || null
    const isUninstantiated = uninstantiatedIds.has(entity.id)
    const isDragTarget = hierDragOverId === entity.id && hierDragId !== entity.id
    const isDragging = hierDragId === entity.id
    const newVisited = new Set(visited)
    newVisited.add(entityId)
    const cx = depth > 0 ? connX(depth) : 0
    // Horizontal connector width: from cx to where content starts
    const horizW = LEVEL_W - LINE_X   // = 9px

    return (
      <div key={entityId}>
        <div
          data-help-region="hierarchy-tree:row"
          className={`flex items-center gap-1 py-1 rounded-sm cursor-grab group/item ${isDragTarget ? 'ring-1 ring-inset ring-accent-500' : ''} ${isDragging ? 'opacity-50' : ''}`}
          style={{
            position: 'relative',
            paddingLeft: depth * LEVEL_W + BASE_PAD,
            borderLeft: `3px solid ${colour}`,
            backgroundColor: isDragTarget ? 'rgba(139,92,246,0.15)' : colour + '0d',
            ...(isUninstantiated ? { boxShadow: 'inset -1px 0 0 0 #f87171, inset 0 -1px 0 0 #f87171, inset 0 1px 0 0 #f87171', borderRadius: '2px 6px 6px 2px' } : {}),
          }}
          draggable
          title="Drag to reparent or drop onto canvas"
          onDragStart={(e) => {
            hierDragIdRef.current = entity.id
            setHierDragId(entity.id)
            e.dataTransfer.setData('application/nnz-entity-id', entity.id)
            e.dataTransfer.setData('application/nnz-hier-reparent', entity.id)
            e.dataTransfer.effectAllowed = 'copyMove'
            const ghost = document.createElement('div')
            ghost.style.cssText = `width:40px;height:40px;border-radius:4px;border:2px solid ${colour};overflow:hidden;position:fixed;top:-100px;left:-100px;display:flex;align-items:center;justify-content:center;background:#27272a;font-size:18px;`
            if (assetName) {
              const img = document.createElement('img')
              img.src = `/api/project/assets/${assetName}`
              img.style.cssText = 'width:100%;height:100%;object-fit:cover;'
              ghost.appendChild(img)
            } else {
              ghost.textContent = TYPE_ICONS[entity.type] || '?'
              ghost.style.backgroundColor = colour + '22'
            }
            document.body.appendChild(ghost)
            e.dataTransfer.setDragImage(ghost, 20, 20)
            requestAnimationFrame(() => document.body.removeChild(ghost))
          }}
          onDragOver={(e) => {
            if (!hierDragIdRef.current || hierDragIdRef.current === entity.id) return
            e.preventDefault()
            e.stopPropagation()
            setHierDragOverId(entity.id)
            setHierDragOverTopLevel(false)
          }}
          onDragLeave={() => {
            if (hierDragOverId === entity.id) setHierDragOverId(null)
          }}
          onDrop={(e) => {
            if (!hierDragIdRef.current || hierDragIdRef.current === entity.id) return
            e.preventDefault()
            e.stopPropagation()
            onReparent?.(hierDragIdRef.current, entity.id)
            clearDragState()
          }}
          onDragEnd={clearDragState}
          onClick={() => onSelect?.(entity.id)}
        >
          {depth > 0 && (
            <>
              {/* Elbow: vertical top-to-mid + horizontal */}
              <div style={{ position: 'absolute', left: cx, top: 0, height: '50%', width: 1, background: LINE_CLR, pointerEvents: 'none' }} />
              <div style={{ position: 'absolute', left: cx, top: '50%', width: horizW, height: 1, background: LINE_CLR, pointerEvents: 'none' }} />
              {/* Sibling continuation: vertical mid-to-bottom when not last */}
              {!isLast && <div style={{ position: 'absolute', left: cx, top: '50%', bottom: 0, width: 1, background: LINE_CLR, pointerEvents: 'none' }} />}
              {/* Ancestor continuation lines: full-height at each level where that ancestor has more siblings */}
              {ancestorHasMore.map((hasMore, i) =>
                hasMore ? <div key={i} style={{ position: 'absolute', left: Math.max(0, i - 1) * LEVEL_W + BASE_PAD + LINE_X, top: 0, bottom: 0, width: 1, background: LINE_CLR, pointerEvents: 'none' }} /> : null
              )}
            </>
          )}

          {/* Collapse toggle or spacer */}
          {children.length > 0 ? (
            <button
              type="button"
              className="text-zinc-500 hover:text-zinc-300 flex-shrink-0 text-[8px] w-3 text-center leading-none"
              onClick={(e) => { e.stopPropagation(); toggleCollapsed(entity.id) }}
            >
              {isCollapsed ? '▶' : '▼'}
            </button>
          ) : (
            <span className="flex-shrink-0 w-3" />
          )}

          {/* Profile image or type icon */}
          <ImageHoverPreview src={assetName ? `/api/project/assets/${assetName}` : null} borderColour={colour}>
            {assetName ? (
              <img src={`/api/project/assets/${assetName}`} alt="" className="w-6 h-6 rounded-sm object-cover flex-shrink-0" style={{ border: `1.5px solid ${colour}` }} />
            ) : (
              <span className="w-6 h-6 rounded-sm flex items-center justify-center flex-shrink-0 text-xs" style={{ backgroundColor: colour + '22', border: `1.5px solid ${colour}` }}>
                {TYPE_ICONS[entity.type] || '?'}
              </span>
            )}
          </ImageHoverPreview>

          <span className="truncate flex-1 text-xs text-zinc-200">{entity.name}</span>

          {cycleIds.has(entity.id) && <span className="text-amber-400 flex-shrink-0 text-[10px] leading-none" title="Circular parent reference detected — drag to a valid parent or drop onto 'Move to top level'">⚠</span>}
          {isUninstantiated && <span className="text-red-400 flex-shrink-0 text-[10px] leading-none" title="No origin node on canvas">∅</span>}

          {isUninstantiated ? (
            <button className="text-zinc-600 hover:text-green-400 opacity-0 group-hover/item:opacity-100 transition-opacity flex-shrink-0 text-[10px] leading-none" onClick={(e) => { e.stopPropagation(); onAddOriginNode?.(entity) }} title="Add origin node to canvas">⊕</button>
          ) : (
            <button className="w-5 h-5 flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 opacity-0 group-hover/item:opacity-100 transition-opacity flex-shrink-0 text-[10px] rounded" onClick={(e) => { e.stopPropagation(); onLocate?.(entity.id) }} title="Centre canvas on this node">👁</button>
          )}
          {/* Phase 3.4i — read-only tag glance, hover-revealed like
              the surrounding action buttons. */}
          <span className="opacity-0 group-hover/item:opacity-100 focus-within:opacity-100 transition-opacity flex-shrink-0">
            <ObjectTagsButton
              pool="project"
              host={entity}
              hostKind={entity.type || 'entity'}
              nodes={nodes}
              hostHeader={<EntityLabelChip entity={entity} name={entity.name} />}
            />
          </span>
          <button className="w-5 h-5 flex items-center justify-center text-zinc-500 hover:text-red-400 hover:bg-zinc-700 opacity-0 group-hover/item:opacity-100 transition-opacity flex-shrink-0 text-[10px] rounded" onClick={(e) => { e.stopPropagation(); onDelete?.(entity) }} title="Delete entity">✕</button>
        </div>

        {!isCollapsed && children.map((childId, i) =>
          renderNode(childId, depth + 1, newVisited, i === children.length - 1, [...ancestorHasMore, !isLast])
        )}
      </div>
    )
  }

  return (
    <div className="py-1" data-help-region="hierarchy-tree:tree">
      {entities.length === 0 && <p className="px-3 py-2 text-xs text-zinc-600 italic">None.</p>}

      {roots.map((entity, i) =>
        renderNode(entity.id, 0, new Set(), i === roots.length - 1, [])
      )}

      {hierDragId && (
        <div
          data-help-region="hierarchy-tree:top_level_drop"
          className={`mx-1 my-1 py-1.5 text-center text-[9px] border border-dashed rounded transition-colors ${hierDragOverTopLevel ? 'border-accent-500 text-accent-400 bg-accent-900/20' : 'border-zinc-700 text-zinc-600'}`}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setHierDragOverTopLevel(true); setHierDragOverId(null) }}
          onDragLeave={() => setHierDragOverTopLevel(false)}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (hierDragIdRef.current) onReparent?.(hierDragIdRef.current, null); clearDragState() }}
        >
          Drop here to move to top level
        </div>
      )}
    </div>
  )
}
