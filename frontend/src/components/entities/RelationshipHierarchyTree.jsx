import { useCallback, useRef, useState } from 'react'
import { TYPE_ICONS } from '../../utils/entityHelpers'

// Phase 1.26a — store-agnostic nested tree component for the per-relationship
// hierarchy view. Mirrors the visual style of `HierarchyTreeView.jsx` (the
// location-library tree) but operates on a generic `roots` forest passed in
// as a prop. Caller resolves labels / colours / type-icon via callback props.
//
// Drag-and-drop reparents nodes; dropping on a node makes it the new parent,
// dropping on the top-level zone makes it a root. Cycle detection lives in
// the store action that handles the resulting `onReparent` call.

const LEVEL_W = 14   // px per indentation level
const BASE_PAD = 4   // px left padding for root-level content
const LINE_X = 5     // px from start of each level block to the vertical line
const LINE_CLR = '#3f3f46'  // zinc-700

export default function RelationshipHierarchyTree({
  roots,                  // HierarchyNode[]
  mode = 'participants',  // 'participants' | 'roles'
  getLabel,               // (id) => string
  getColour,              // (id) => string (hex)
  getTypeIconKey,         // (id) => string | null  — used to pick TYPE_ICONS[key]; null = no icon
  renderInlineMembers,    // (id) => ReactNode | null  — roles mode: extra row beneath the node listing its members
  onReparent,             // (nodeId, newParentId | null) => void
  onDeleteNode,           // (id) => void              — optional, for role-mode delete affordance
  onMemberDrop,           // (entityId, targetRoleValue) => void  — roles mode: pill dropped onto a role node
}) {
  const [collapsed, setCollapsed] = useState(new Set())
  const dragIdRef = useRef(null)
  const [dragId, setDragId] = useState(null)
  const [dragOverId, setDragOverId] = useState(null)
  const [dragOverTopLevel, setDragOverTopLevel] = useState(false)

  const clearDragState = useCallback(() => {
    dragIdRef.current = null
    setDragId(null)
    setDragOverId(null)
    setDragOverTopLevel(false)
  }, [])

  const toggleCollapsed = useCallback((id) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  function connX(depth) { return (depth - 1) * LEVEL_W + BASE_PAD + LINE_X }

  function renderNode(node, depth, isLast, ancestorHasMore) {
    const id = node.id
    const children = node.children || []
    const isCollapsed = collapsed.has(id)
    const colour = getColour ? (getColour(id) || '#888888') : '#888888'
    const label = getLabel ? getLabel(id) : id
    const iconKey = getTypeIconKey ? getTypeIconKey(id) : null
    const icon = iconKey ? (TYPE_ICONS[iconKey] || '?') : (mode === 'roles' ? '⛬' : '?')
    const isDragTarget = dragOverId === id && dragId !== id
    const isDragging = dragId === id

    const cx = depth > 0 ? connX(depth) : 0
    const horizW = LEVEL_W - LINE_X

    // Resolve inline members JSX (if any) up-front so we can decide whether
    // to render the role-row + members as a single unified outer block (for
    // a continuous left border with no boundary divit between them) or just
    // the row.
    const inlineMembers = renderInlineMembers ? renderInlineMembers(id) : null
    const hasInlineMembers = !!inlineMembers

    // Outer wrapper owns the border-left + background tint when there are
    // inline members, so the coloured vertical line is one continuous element
    // across both the row and the members. When there are no inline members,
    // the role-row itself owns the border (no wrapper needed).
    const outerStyle = hasInlineMembers
      ? {
          borderLeft: `3px solid ${colour}`,
          backgroundColor: isDragTarget ? 'rgba(139,92,246,0.15)' : colour + '0d',
        }
      : null
    const rowStyle = {
      position: 'relative',
      paddingLeft: depth * LEVEL_W + BASE_PAD,
      ...(hasInlineMembers
        ? {}  // border + bg live on the outer wrapper instead
        : {
            borderLeft: `3px solid ${colour}`,
            backgroundColor: isDragTarget ? 'rgba(139,92,246,0.15)' : colour + '0d',
          }),
    }

    // Drop-target handlers cover both role-reparent drags (the role node
    // itself being dragged onto another role) and member-pill drags (an
    // entity pill being dragged from its current role onto a different
    // role to reassign). Read `dataTransfer.types` to discriminate; the
    // actual data is only available in onDrop, not onDragOver.
    const dropHandlers = {
      onDragOver: (e) => {
        const types = e.dataTransfer.types
        const isRoleDrag = (types.includes ? types.includes('application/nnz-rel-hier-reparent') : Array.from(types).includes('application/nnz-rel-hier-reparent'))
          && dragIdRef.current && dragIdRef.current !== id
        const isPillDrag = (types.includes ? types.includes('application/nnz-rel-pill-entityid') : Array.from(types).includes('application/nnz-rel-pill-entityid'))
        if (!isRoleDrag && !isPillDrag) return
        e.preventDefault()
        e.stopPropagation()
        setDragOverId(id)
        setDragOverTopLevel(false)
      },
      onDragLeave: () => {
        if (dragOverId === id) setDragOverId(null)
      },
      onDrop: (e) => {
        const types = e.dataTransfer.types
        const hasRoleDrag = types.includes ? types.includes('application/nnz-rel-hier-reparent') : Array.from(types).includes('application/nnz-rel-hier-reparent')
        const hasPillDrag = types.includes ? types.includes('application/nnz-rel-pill-entityid') : Array.from(types).includes('application/nnz-rel-pill-entityid')
        e.preventDefault()
        e.stopPropagation()
        if (hasRoleDrag && dragIdRef.current && dragIdRef.current !== id) {
          onReparent?.(dragIdRef.current, id)
        } else if (hasPillDrag) {
          const entityId = e.dataTransfer.getData('application/nnz-rel-pill-entityid')
          if (entityId) onMemberDrop?.(entityId, id)
        }
        clearDragState()
      },
    }

    // Drag-source props for the role node itself (separate from drop
    // handling, which lives on either this row or the outer wrapper
    // depending on whether inline members are present).
    const dragSourceProps = {
      draggable: true,
      title: 'Drag to reparent',
      onDragStart: (e) => {
        dragIdRef.current = id
        setDragId(id)
        e.dataTransfer.setData('application/nnz-rel-hier-reparent', id)
        e.dataTransfer.effectAllowed = 'move'
      },
      onDragEnd: clearDragState,
    }

    const rowContent = (
      <div
        data-help-region="relationship-hierarchy-tree:node_row"
        className={`flex items-center gap-1 py-1 ${hasInlineMembers ? '' : 'rounded-sm'} cursor-grab group/item ${isDragTarget && !hasInlineMembers ? 'ring-1 ring-inset ring-accent-500' : ''} ${isDragging ? 'opacity-50' : ''}`}
        style={rowStyle}
        {...dragSourceProps}
        {...(hasInlineMembers ? {} : dropHandlers)}
      >
        {depth > 0 && (
          <>
            <div style={{ position: 'absolute', left: cx, top: 0, height: '50%', width: 1, background: LINE_CLR, pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', left: cx, top: '50%', width: horizW, height: 1, background: LINE_CLR, pointerEvents: 'none' }} />
            {!isLast && <div style={{ position: 'absolute', left: cx, top: '50%', bottom: 0, width: 1, background: LINE_CLR, pointerEvents: 'none' }} />}
            {ancestorHasMore.map((hasMore, i) =>
              hasMore ? <div key={i} style={{ position: 'absolute', left: Math.max(0, i - 1) * LEVEL_W + BASE_PAD + LINE_X, top: 0, bottom: 0, width: 1, background: LINE_CLR, pointerEvents: 'none' }} /> : null
            )}
          </>
        )}
        {/* Children connector — when this node has visible children, run a
            vertical from the role-row's mid down through the bottom of
            the row at the CHILDREN's cx (one indent level deeper than
            this node's). Pairs with the same line through the members
            section (rendered below in the wrapper) and the children's
            own elbow top-halves to form a continuous connector from
            this node's mid to the first child's mid. Only needed when
            inline members create a visual gap between this row and
            the first child; without inline members the children's
            elbow top-halves alone visually connect to this row's
            bottom edge. */}
        {hasInlineMembers && !isCollapsed && children.length > 0 && (
          <div style={{ position: 'absolute', left: depth * LEVEL_W + BASE_PAD + LINE_X, top: '50%', bottom: 0, width: 1, background: LINE_CLR, pointerEvents: 'none' }} />
        )}

        {children.length > 0 ? (
          <button
            type="button"
            className="text-zinc-500 hover:text-zinc-300 flex-shrink-0 text-[8px] w-3 text-center leading-none"
            onClick={(e) => { e.stopPropagation(); toggleCollapsed(id) }}
          >
            {isCollapsed ? '▶' : '▼'}
          </button>
        ) : (
          <span className="flex-shrink-0 w-3" />
        )}

        <span className="w-5 h-5 rounded-sm flex items-center justify-center flex-shrink-0 text-[10px]" style={{ backgroundColor: colour + '22', border: `1px solid ${colour}` }}>
          {icon}
        </span>

        <span className="truncate flex-1 text-[11px] text-zinc-200">{label}</span>

        {onDeleteNode && (
          <button
            className="w-5 h-5 flex items-center justify-center text-zinc-400 hover:text-red-400 hover:bg-zinc-700 opacity-0 group-hover/item:opacity-100 transition-opacity flex-shrink-0 text-[10px] rounded"
            onClick={(e) => { e.stopPropagation(); onDeleteNode(id) }}
            title="Remove from hierarchy"
          >
            ×
          </button>
        )}
      </div>
    )

    return (
      <div key={id}>
        {hasInlineMembers ? (
          <div
            className={`rounded-sm overflow-hidden ${isDragTarget ? 'ring-1 ring-inset ring-accent-500' : ''}`}
            style={outerStyle}
            {...dropHandlers}
          >
            {rowContent}
            <div
              style={{
                position: 'relative',
                // Padding-left clears the children-connector vertical (which
                // sits at LEVEL_W * depth + BASE_PAD + LINE_X) so member
                // pills don't paint over the line. +LINE_X + 4 = a few px
                // of breathing room past the line.
                paddingLeft: depth * LEVEL_W + BASE_PAD + LINE_X + 4,
                paddingTop: 2,
                paddingBottom: 4,
                paddingRight: 4,
              }}
            >
              {/* Tree connector lines extended through the members section
                  so the sibling-continuation and ancestor-continuation
                  verticals run uninterrupted from the role-row through
                  to the next sibling's row below. The "elbow" lines
                  (top-half + horizontal pointing into the role label)
                  stay on the role-row only — they're row-specific. */}
              {depth > 0 && (
                <>
                  {!isLast && <div style={{ position: 'absolute', left: cx, top: 0, bottom: 0, width: 1, background: LINE_CLR, pointerEvents: 'none' }} />}
                  {ancestorHasMore.map((hasMore, i) =>
                    hasMore ? <div key={i} style={{ position: 'absolute', left: Math.max(0, i - 1) * LEVEL_W + BASE_PAD + LINE_X, top: 0, bottom: 0, width: 1, background: LINE_CLR, pointerEvents: 'none' }} /> : null
                  )}
                </>
              )}
              {/* Children connector — paired with the role-row's bottom-half
                  vertical at the children's cx. Runs the full height of the
                  members section so the line stays continuous from this
                  role's mid down through the members and into the first
                  child's elbow top-half. */}
              {!isCollapsed && children.length > 0 && (
                <div style={{ position: 'absolute', left: depth * LEVEL_W + BASE_PAD + LINE_X, top: 0, bottom: 0, width: 1, background: LINE_CLR, pointerEvents: 'none' }} />
              )}
              {inlineMembers}
            </div>
          </div>
        ) : (
          rowContent
        )}

        {!isCollapsed && children.map((child, i) =>
          renderNode(child, depth + 1, i === children.length - 1, [...ancestorHasMore, !isLast])
        )}
      </div>
    )
  }

  return (
    <div data-help-region="relationship-hierarchy-tree:tree" className="space-y-0.5">
      {/* Top-level drop zone — drag a node here to make it a root sibling */}
      <div
        data-help-region="relationship-hierarchy-tree:top_level_drop"
        className={`mb-1 text-[9px] text-center py-1 border border-dashed rounded transition-colors ${dragOverTopLevel ? 'border-accent-500 text-accent-300 bg-accent-500/10' : 'border-zinc-700/50 text-zinc-600'}`}
        onDragOver={(e) => {
          if (!dragIdRef.current) return
          e.preventDefault()
          setDragOverTopLevel(true)
          setDragOverId(null)
        }}
        onDragLeave={() => setDragOverTopLevel(false)}
        onDrop={(e) => {
          if (!dragIdRef.current) return
          e.preventDefault()
          onReparent?.(dragIdRef.current, null)
          clearDragState()
        }}
      >
        Drop here to move to top level
      </div>

      {(roots || []).map((root, i) => renderNode(root, 0, i === (roots || []).length - 1, []))}
    </div>
  )
}
