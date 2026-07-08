import { useRef, useState, useCallback, useMemo } from 'react'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useMcpControlStore } from '../../store/mcpControlStore'
import { useAccentColor } from '../../utils/povConstants'
import DetailPanel from './DetailPanel'
import RelationshipSummaryHeader from './RelationshipSummaryHeader'
import ContextCueSection from './ContextCueSection'
import TagsAndListsSection from '../tags/TagsAndListsSection'
import TagFilterBar from '../tags/TagFilterBar'
import ObjectTagsButton from '../tags/ObjectTagsButton'
import {
  matchesProjectTagFilterBySet,
  chainWideTagIdsForHost,
  isEmptyTagFilter,
} from '../../utils/tagFilter'
import { EntityLabelChip, KnowledgeLabelChip, RelationshipLabelChip } from '../ui/IdentityBadges'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import { RelationshipIcon } from '../ui/IdentityBadges'
import ImageHoverPreview from '../ui/ImageHoverPreview'
import HierarchyTreeView from '../ui/HierarchyTreeView'
import PresetListMutationResolver, { hasPresetConsumers } from '../ui/PresetListMutationResolver'
import EntityColorPicker from '../ui/EntityColorPicker'
import { isOvumRedEntity, setOvumRedSessionDisabled } from '../../effects/quarterlyForecasts'
import { confirm } from '../../store/dialogStore'
import { buildDeleteKnowledgeMessage } from '../ui/popupMessages'
import { getKnowledgeNodeOrder } from '../../utils/narrativeChain'
import { getOrComputeStoryOrderFromStore } from '../../hooks/useStoryOrder'
import { nodesStructurallyEqual } from '../../hooks/useAlerts'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import useLibraryReorder from '../../hooks/useLibraryReorder'

const ENTITY_TABS = [
  { key: 'character', label: 'Characters', plural: 'characters' },
  { key: 'location', label: 'Locations', plural: 'locations' },
  { key: 'item', label: 'Items', plural: 'items' },
  { key: 'faction', label: 'Factions', plural: 'factions' },
  { key: 'custom', label: 'Custom', plural: 'customs' },
  { key: 'knowledge', label: 'Knowledge', plural: 'knowledges' },
]

function EntityItem({ entity, nodes, onEdit, onDelete, onLocate, onAddOriginNode, isUninstantiated, onDragStart, onDragOver, onDrop, onDragEnd, isDragOver, isDragOverAtEnd }) {
  const assetName = entity.profile_image_ref ? entity.profile_image_ref.replace(/^assets\//, '') : null
  const colour = entity.colour || '#888888'
  const accentColor = useAccentColor()

  // Row-level drag: carries entity ID for canvas/scene drops
  const handleRowDragStart = (e) => {
    e.dataTransfer.setData('application/nnz-entity-id', entity.id)
    e.dataTransfer.effectAllowed = 'copyMove'

    // Custom drag ghost: larger profile image (or placeholder) with entity colour border
    const ghost = document.createElement('div')
    ghost.style.cssText = `
      width: 40px; height: 40px; border-radius: 4px; border: 2px solid ${colour};
      overflow: hidden; position: fixed; top: -100px; left: -100px;
      display: flex; align-items: center; justify-content: center;
      background: #27272a; font-size: 18px;
    `
    if (assetName) {
      const img = document.createElement('img')
      img.src = `/api/project/assets/${assetName}`
      img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;'
      ghost.appendChild(img)
    } else {
      ghost.textContent = TYPE_ICONS[entity.type] || '?'
      ghost.style.backgroundColor = colour + '22'
    }
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 20, 20)
    requestAnimationFrame(() => document.body.removeChild(ghost))
  }

  return (
    <div
      data-help-region="entity-library:entity_row"
      className="flex items-center gap-1.5 px-1.5 py-1.5 rounded-sm cursor-pointer group/item"
      style={(() => {
        // Compose row style from layered concerns:
        //   - colour-tinted left border + faint colour-tinted bg
        //     (always)
        //   - top accent border = reorder drop indicator for in-
        //     between drops (drives `isDragOver`)
        //   - bottom accent inset = reorder drop indicator for
        //     drop-at-end target (drives `isDragOverAtEnd`)
        //   - uninstantiated red ring (top + bottom + right inset)
        //     when the entity has no origin node on canvas
        const shadowParts = []
        if (isDragOverAtEnd) shadowParts.push(`inset 0 -2px 0 0 ${accentColor}`)
        if (isUninstantiated) {
          shadowParts.push('inset -1px 0 0 0 #f87171')
          if (!isDragOverAtEnd) shadowParts.push('inset 0 -1px 0 0 #f87171')
          shadowParts.push('inset 0 1px 0 0 #f87171')
        }
        return {
          borderLeft: `3px solid ${colour}`,
          backgroundColor: colour + '0d',
          borderTop: isDragOver ? `2px solid ${accentColor}` : '2px solid transparent',
          ...(shadowParts.length ? { boxShadow: shadowParts.join(', ') } : {}),
          ...(isUninstantiated ? { borderRadius: '2px 6px 6px 2px' } : {}),
        }
      })()}
      draggable
      onDragStart={handleRowDragStart}
      onClick={() => onEdit(entity.id)}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* Reorder grip */}
      <span
        className="text-zinc-600 hover:text-zinc-300 cursor-grab active:cursor-grabbing opacity-0 group-hover/item:opacity-100 transition-opacity flex-shrink-0"
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={(e) => e.stopPropagation()}
        title="Drag to reorder"
        style={{ fontSize: 9 }}
      >⠿</span>

      {/* Profile image or type icon */}
      <ImageHoverPreview src={assetName ? `/api/project/assets/${assetName}` : null} borderColour={colour}>
        {assetName ? (
          <img
            src={`/api/project/assets/${assetName}`}
            alt=""
            className="w-6 h-6 rounded-sm object-cover flex-shrink-0"
            style={{ border: `1.5px solid ${colour}` }}
          />
        ) : (
          <span
            className="w-6 h-6 rounded-sm flex items-center justify-center flex-shrink-0 text-xs"
            style={{ backgroundColor: colour + '22', border: `1.5px solid ${colour}` }}
          >{TYPE_ICONS[entity.type] || '?'}</span>
        )}
      </ImageHoverPreview>

      {/* Name */}
      <span className="truncate flex-1 text-xs text-zinc-200">{entity.name}</span>

      {/* Uninstantiated badge */}
      {isUninstantiated && (
        <span
          className="text-red-400 flex-shrink-0 text-[10px] leading-none"
          title="No origin node on canvas"
        >∅</span>
      )}

      {/* Locate on canvas / Add origin node */}
      {isUninstantiated ? (
        <button
          className="text-zinc-600 hover:text-green-400 opacity-0 group-hover/item:opacity-100 transition-opacity flex-shrink-0 text-[10px] leading-none"
          onClick={(e) => { e.stopPropagation(); onAddOriginNode(entity) }}
          title="Add origin node to canvas"
        >⊕</button>
      ) : (
        <button
          className="w-5 h-5 flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 opacity-0 group-hover/item:opacity-100 transition-opacity flex-shrink-0 text-[10px] rounded"
          onClick={(e) => { e.stopPropagation(); onLocate(entity.id) }}
          title="Centre canvas on this node"
        >👁</button>
      )}

      {/* Phase 3.4i — read-only tag-glance button. Fades in on row
          hover to match the surrounding action-cluster buttons
          (Locate / Delete) — keeps the row clean when idle. */}
      <span className="opacity-0 group-hover/item:opacity-100 focus-within:opacity-100 transition-opacity flex-shrink-0">
        <ObjectTagsButton
          pool="project"
          host={entity}
          hostKind={entity.type || 'entity'}
          nodes={nodes}
          hostHeader={<EntityLabelChip entity={entity} name={entity.name} />}
        />
      </span>

      {/* Delete button */}
      <button
        className="w-5 h-5 flex items-center justify-center text-zinc-400 hover:text-red-400 hover:bg-zinc-700 opacity-0 group-hover/item:opacity-100 transition-opacity flex-shrink-0 text-[10px] rounded"
        onClick={(e) => { e.stopPropagation(); onDelete(entity) }}
        title="Delete entity"
      >×</button>
    </div>
  )
}

function DividerItem({ divider, onTitleChange, onRemove, onDragStart, onDragOver, onDrop, onDragEnd, isDragOver, isDragOverAtEnd }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(divider.title || '')
  const accentColor = useAccentColor()

  function commitTitle() {
    onTitleChange(title)
    setEditing(false)
  }

  return (
    <div
      className="flex items-center gap-1 px-1 py-0.5 group/divider"
      style={{
        borderTop: isDragOver ? `2px solid ${accentColor}` : '2px solid transparent',
        // When the writer's drag is over the trailing zone below
        // the last item in this bucket, paint the indicator on
        // this row's BOTTOM edge instead (reads as "drop will land
        // after this row").
        ...(isDragOverAtEnd ? { boxShadow: `inset 0 -2px 0 0 ${accentColor}` } : {}),
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <span
        className="text-zinc-600 hover:text-zinc-300 cursor-grab active:cursor-grabbing opacity-0 group-hover/divider:opacity-100 transition-opacity flex-shrink-0"
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        style={{ fontSize: 9 }}
        title="Drag to reorder"
      >⠿</span>
      <div className="flex-1 border-t border-zinc-600 my-1" />
      {editing ? (
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => { if (e.key === 'Enter') commitTitle(); if (e.key === 'Escape') setEditing(false) }}
          className="bg-transparent text-[9px] text-zinc-400 focus:outline-none w-16 text-right"
          placeholder="Label..."
        />
      ) : (
        <span
          className={`text-[9px] cursor-pointer hover:text-zinc-300 truncate max-w-[60px] ${
            divider.title ? 'text-zinc-500' : 'text-zinc-500 opacity-0 group-hover/divider:opacity-100 transition-opacity'
          }`}
          onClick={() => setEditing(true)}
          title={divider.title || 'Click to add label'}
        >
          {divider.title || '...'}
        </span>
      )}
      <button
        className="text-zinc-700 hover:text-red-400 opacity-0 group-hover/divider:opacity-100 transition-opacity flex-shrink-0 text-[9px]"
        onClick={onRemove}
        title="Remove divider"
      >×</button>
    </div>
  )
}

/** Render location list as an indented tree. */

/** Custom categories sub-section shown in the Custom tab. */
// Phase 1.24a — Library tab quick-filter helper. Case-insensitive
// substring match against the supplied text fields. `query` is the
// active filter string for the current tab; empty string means "no
// filter" and matches everything. Falsy / missing fields are skipped.
function matchesFilter(query, ...fields) {
  if (!query) return true
  const q = String(query).trim().toLowerCase()
  if (!q) return true
  for (const f of fields) {
    if (!f) continue
    if (String(f).toLowerCase().includes(q)) return true
  }
  return false
}

/**
 * Phase post-v0.2.12.18 — unified Customs panel rendering: collapsible
 * categories with the custom entities of each category nested inside.
 * Replaces the prior split between a flat customs list + a separate
 * `CustomCategoriesSection`. Click a category header to expand /
 * collapse; the "+ Add Category" button sits at the top of the panel.
 *
 * Entity reordering / dividers from the prior flat-list pattern are
 * intentionally dropped here — categories themselves are the
 * grouping; per-category entity order is the entity store's natural
 * insertion order.
 */
function CustomsByCategoryView({
  customs,
  categories,
  nameFilter = '',
  nodes,
  onCreateCategory,
  onUpdateCategory,
  onDeleteCategory,
  onEdit,
  onDelete,
  onLocate,
  onAddOriginNode,
  uninstantiatedIds,
}) {
  const reorderCustomCategories = useEntitiesStore((s) => s.reorderCustomCategories)
  const updateEntity = useEntitiesStore((s) => s.updateEntity)
  const accentColor = useAccentColor()
  // Tracks which category id is currently being hovered as an entity
  // drop target. Drives the row-highlight ring on the matching
  // category header.
  const [entityDropTargetCatId, setEntityDropTargetCatId] = useState(null)
  const [collapsed, setCollapsed] = useState({})
  const [showAddCat, setShowAddCat] = useState(false)
  const [addName, setAddName] = useState('')
  const [addDesc, setAddDesc] = useState('')
  const [addColour, setAddColour] = useState('#888888')
  const [addColourPickerOpen, setAddColourPickerOpen] = useState(false)
  const addColourAnchorRef = useRef(null)

  const [editingCatId, setEditingCatId] = useState(null)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editColour, setEditColour] = useState('#888888')
  const [editColourPickerOpen, setEditColourPickerOpen] = useState(false)
  const editColourAnchorRef = useRef(null)

  const grouped = useMemo(() => {
    const groups = new Map()
    for (const cat of categories) groups.set(cat.id, [])
    const uncategorised = []
    for (const c of customs) {
      if (c.category_id && groups.has(c.category_id)) groups.get(c.category_id).push(c)
      else uncategorised.push(c)
    }
    return { groups, uncategorised }
  }, [customs, categories])

  const filterMatch = useCallback(
    (s) => !nameFilter || (s || '').toLowerCase().includes(nameFilter.toLowerCase()),
    [nameFilter],
  )

  // Category-header reorder (drag a category up/down to re-sequence
  // the customCategories array). Disabled while a name filter is
  // active so the writer doesn't accidentally reorder a filtered
  // subset. Mirrors the character/item/etc. library reorder pattern.
  const reorderEnabled = !nameFilter
  const categoryReorder = useLibraryReorder({
    total: categories.length,
    enabled: reorderEnabled,
    onCommit: (srcIdx, dstIdx) => {
      const ids = categories.map((c) => c.id)
      const [moved] = ids.splice(srcIdx, 1)
      const insertPos = dstIdx >= ids.length ? ids.length : (dstIdx > srcIdx ? dstIdx - 1 : dstIdx)
      ids.splice(insertPos, 0, moved)
      reorderCustomCategories(ids)
    },
  })

  // Accept a custom-entity drag onto a category header → set that
  // entity's `category_id` to this category via updateEntity. The
  // payload MIME is `application/nnz-entity-id`, the same one
  // `EntityItem`'s row-drag sets — no separate drag handler needed
  // on entity rows.
  function makeEntityDropProps(catId) {
    return {
      onDragOver: (e) => {
        if (!e.dataTransfer?.types?.includes('application/nnz-entity-id')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (entityDropTargetCatId !== catId) setEntityDropTargetCatId(catId)
      },
      onDragLeave: () => {
        if (entityDropTargetCatId === catId) setEntityDropTargetCatId(null)
      },
      onDrop: async (e) => {
        e.preventDefault()
        setEntityDropTargetCatId(null)
        const entityId = e.dataTransfer?.getData('application/nnz-entity-id')
        if (!entityId) return
        const entity = customs.find((c) => c.id === entityId)
        if (!entity) return  // only customs land here; other types won't be in the list
        if (entity.category_id === catId) return  // already in this category, no-op
        await updateEntity(entityId, { ...entity, category_id: catId })
      },
    }
  }

  function toggleCollapse(catId) { setCollapsed((m) => ({ ...m, [catId]: !m[catId] })) }

  function startEditCat(cat) {
    setEditingCatId(cat.id)
    setEditName(cat.name)
    setEditDesc(cat.description || '')
    setEditColour(cat.colour || '#888888')
  }
  async function saveEditCat() {
    if (!editName.trim()) return
    await onUpdateCategory(editingCatId, { name: editName.trim(), description: editDesc.trim(), colour: editColour })
    setEditingCatId(null)
  }
  async function handleAddCat() {
    if (!addName.trim()) return
    await onCreateCategory({ name: addName.trim(), description: addDesc.trim(), colour: addColour })
    setAddName('')
    setAddDesc('')
    setAddColour('#888888')
    setShowAddCat(false)
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-shrink-0 px-2 pt-1 pb-1">
        {!showAddCat ? (
          <button
            data-help-region="entity-library:add_custom_category_btn"
            onClick={() => setShowAddCat(true)}
            className="w-full px-2 py-1.5 text-xs rounded bg-zinc-800/60 hover:bg-zinc-800 border border-zinc-700 hover:border-accent-500/60 text-zinc-300 hover:text-accent-300 transition-colors"
          >
            + Add Category
          </button>
        ) : (
          <div className="flex flex-col gap-1 border border-zinc-700 rounded bg-zinc-900/40 p-2">
            <input
              autoFocus
              value={addName}
              onChange={e => setAddName(e.target.value)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') handleAddCat() }}
              placeholder="Category name…"
              className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
            />
            <input
              value={addDesc}
              onChange={e => setAddDesc(e.target.value)}
              onKeyDown={e => e.stopPropagation()}
              placeholder="Description (optional)"
              className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
            />
            <div className="flex items-center gap-1">
              <span className="text-xs text-zinc-500 whitespace-nowrap">Colour</span>
              <button
                type="button"
                ref={addColourAnchorRef}
                onClick={() => setAddColourPickerOpen(o => !o)}
                className="w-7 h-6 rounded border border-zinc-600 cursor-pointer flex-shrink-0"
                style={{ background: addColour }}
                aria-label={`Colour: ${addColour}. Click to open picker.`}
              />
              <EntityColorPicker
                value={addColour}
                onChange={setAddColour}
                anchorEl={addColourAnchorRef.current}
                isOpen={addColourPickerOpen}
                onClose={() => setAddColourPickerOpen(false)}
              />
              <input
                value={addColour}
                onChange={e => setAddColour(e.target.value)}
                maxLength={7}
                onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur() }}
                className="flex-1 bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500 font-mono"
              />
            </div>
            <div className="flex gap-1">
              <button onClick={handleAddCat} className="flex-1 text-xs bg-accent-700 hover:bg-accent-600 text-white rounded py-1">Add</button>
              <button onClick={() => setShowAddCat(false)} className="text-xs text-zinc-400 hover:text-zinc-200 px-2">✕</button>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {categories.map((cat, catIdx) => {
          const entitiesInCat = grouped.groups.get(cat.id) || []
          const visibleEntities = nameFilter
            ? entitiesInCat.filter(e => filterMatch(e.name) || filterMatch(e.description))
            : entitiesInCat
          if (nameFilter && !filterMatch(cat.name) && visibleEntities.length === 0) return null
          const isCollapsed = !!collapsed[cat.id]
          const isEditing = editingCatId === cat.id
          // Reorder hook outputs (disabled while a filter is active —
          // see `reorderEnabled` above).
          const gripProps = reorderEnabled ? categoryReorder.gripProps(catIdx) : {}
          const rowDropProps = reorderEnabled ? categoryReorder.rowDropProps(catIdx) : {}
          const isCatDragOver = reorderEnabled
            && categoryReorder.dragIdx != null
            && categoryReorder.dragOverIdx === catIdx
            && categoryReorder.dragIdx !== catIdx
          const isCatDragOverAtEnd = reorderEnabled
            && catIdx === categories.length - 1
            && categoryReorder.dragOverIdx === categories.length
            && categoryReorder.dragIdx !== catIdx
          const isEntityDropTarget = entityDropTargetCatId === cat.id
          const entityDropProps = makeEntityDropProps(cat.id)
          if (isEditing) {
            return (
              <div key={cat.id} className="flex flex-col gap-1 border border-zinc-700 rounded bg-zinc-900/40 p-2 mx-2 mb-1">
                <input
                  autoFocus
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') saveEditCat() }}
                  className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
                />
                <input
                  value={editDesc}
                  onChange={e => setEditDesc(e.target.value)}
                  onKeyDown={e => e.stopPropagation()}
                  placeholder="Description (optional)"
                  className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
                />
                <div className="flex items-center gap-1">
                  <span className="text-xs text-zinc-500 whitespace-nowrap">Colour</span>
                  <button
                    type="button"
                    ref={editColourAnchorRef}
                    onClick={() => setEditColourPickerOpen(o => !o)}
                    className="w-7 h-6 rounded border border-zinc-600 cursor-pointer flex-shrink-0"
                    style={{ background: editColour }}
                    aria-label={`Colour: ${editColour}. Click to open picker.`}
                  />
                  <EntityColorPicker
                    value={editColour}
                    onChange={setEditColour}
                    anchorEl={editColourAnchorRef.current}
                    isOpen={editColourPickerOpen}
                    onClose={() => setEditColourPickerOpen(false)}
                  />
                  <input
                    value={editColour}
                    onChange={e => setEditColour(e.target.value)}
                    maxLength={7}
                    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur() }}
                    className="flex-1 bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500 font-mono"
                  />
                </div>
                <div className="flex gap-1">
                  <button onClick={saveEditCat} className="flex-1 text-xs bg-accent-700 hover:bg-accent-600 text-white rounded py-1">Save</button>
                  <button onClick={() => setEditingCatId(null)} className="text-xs text-zinc-400 hover:text-zinc-200 px-2">✕</button>
                </div>
              </div>
            )
          }
          return (
            <div key={cat.id} className="mb-0.5">
              <div
                className="flex items-center gap-1.5 px-3 py-1 group hover:bg-zinc-800/30 cursor-pointer select-none"
                style={(() => {
                  // Layer the visual cues:
                  //   - top accent line = reorder drop above this row
                  //   - bottom accent line = reorder drop at the END
                  //     of the list (only on the LAST category — the
                  //     trailing-zone div below this map captures the
                  //     hover, and the indicator paints on the last
                  //     row's bottom edge).
                  //   - full ring = entity-into-category drop target.
                  const shadowParts = []
                  if (isCatDragOverAtEnd) shadowParts.push(`inset 0 -2px 0 0 ${accentColor}`)
                  if (isEntityDropTarget) shadowParts.push(`inset 0 0 0 2px ${accentColor}`)
                  return {
                    borderTop: isCatDragOver ? `2px solid ${accentColor}` : '2px solid transparent',
                    ...(shadowParts.length ? { boxShadow: shadowParts.join(', ') } : {}),
                    ...(isEntityDropTarget ? { backgroundColor: `${accentColor}1a` } : {}),
                  }
                })()}
                onClick={() => toggleCollapse(cat.id)}
                onDragOver={(e) => {
                  // Two distinct drag sources: another category
                  // header (reorder) vs a custom entity row
                  // (change-category). Both arrive as `dragover` on
                  // the same header; route by payload-type.
                  if (e.dataTransfer?.types?.includes('application/nnz-entity-id')) {
                    entityDropProps.onDragOver(e)
                  } else if (rowDropProps.onDragOver) {
                    rowDropProps.onDragOver(e)
                  }
                }}
                onDragLeave={entityDropProps.onDragLeave}
                onDrop={(e) => {
                  if (e.dataTransfer?.types?.includes('application/nnz-entity-id')) {
                    entityDropProps.onDrop(e)
                  } else if (rowDropProps.onDrop) {
                    rowDropProps.onDrop(e)
                  }
                }}
              >
                <span className="text-zinc-500 text-[10px] flex-shrink-0 w-3 leading-none">{isCollapsed ? '▸' : '▾'}</span>
                <span
                  className="text-zinc-600 hover:text-zinc-300 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 text-[10px] leading-none"
                  title="Drag to reorder this category"
                  {...gripProps}
                  onClick={(e) => e.stopPropagation()}
                >⋮⋮</span>
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: cat.colour || '#888888' }} />
                <span className="flex-1 text-xs text-zinc-300 truncate" title={cat.description || cat.name}>{cat.name}</span>
                <span className="text-[10px] text-zinc-500 flex-shrink-0">({entitiesInCat.length})</span>
                <button
                  onClick={(e) => { e.stopPropagation(); startEditCat(cat) }}
                  className="text-zinc-500 hover:text-zinc-300 text-xs opacity-0 group-hover:opacity-100"
                  title="Edit category"
                >✎</button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDeleteCategory(cat.id) }}
                  className="text-zinc-500 hover:text-red-400 text-xs opacity-0 group-hover:opacity-100"
                  title="Delete category"
                >✕</button>
              </div>
              {!isCollapsed && (
                <div
                  className="pl-4 py-0.5 space-y-0.5"
                  // While a category-reorder drag is active, the
                  // expanded body of THIS category should act as
                  // a "drop after this category" zone — otherwise
                  // the writer can't reach the trailing zone below
                  // when the last category is expanded with entity
                  // rows underneath (the entity rows themselves
                  // don't accept drops; the cursor would show
                  // "not allowed" all the way down). Routing the
                  // body to `rowDropProps(catIdx + 1)` makes
                  // hovering anywhere inside the expanded body
                  // mean "drop after the current category" — and
                  // for the LAST category, catIdx+1 === total,
                  // which is exactly the trailing-zone semantics.
                  {...(reorderEnabled ? categoryReorder.rowDropProps(catIdx + 1) : {})}
                >
                  {visibleEntities.length > 0 ? (
                    visibleEntities.map(entity => (
                      <EntityItem
                        key={entity.id}
                        entity={entity}
                        nodes={nodes}
                        onEdit={onEdit}
                        onDelete={onDelete}
                        onLocate={onLocate}
                        onAddOriginNode={onAddOriginNode}
                        isUninstantiated={uninstantiatedIds.has(entity.id)}
                      />
                    ))
                  ) : (
                    <p className="pl-2 pr-3 py-1 text-[10px] text-zinc-600 italic">(empty)</p>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {/* Invisible trailing hit-area below the last category so the
            writer can drop AFTER the lowest category to send it to
            the end of the list. The bottom-edge accent indicator
            paints on the last category's bottom edge via the
            `isCatDragOverAtEnd` flag above — this zone has no chrome
            of its own. Only renders during a category-reorder drag
            (the hook returns null `trailingZoneProps` when disabled
            or no drag is active). */}
        {categoryReorder.trailingZoneProps && (
          <div className="h-6" {...categoryReorder.trailingZoneProps} />
        )}
        {grouped.uncategorised.length > 0 && (() => {
          const visible = nameFilter
            ? grouped.uncategorised.filter(e => filterMatch(e.name) || filterMatch(e.description))
            : grouped.uncategorised
          if (nameFilter && visible.length === 0) return null
          return (
            <div className="mb-0.5">
              <div className="flex items-center gap-1.5 px-3 py-1">
                <span className="text-zinc-500 text-[10px] flex-shrink-0 w-3 leading-none">▾</span>
                <span className="w-2 h-2 rounded-full flex-shrink-0 bg-zinc-600" />
                <span className="flex-1 text-xs text-zinc-500 italic truncate">Uncategorised</span>
                <span className="text-[10px] text-zinc-500 flex-shrink-0">({grouped.uncategorised.length})</span>
              </div>
              <div className="pl-4 py-0.5 space-y-0.5">
                {visible.map(entity => (
                  <EntityItem
                    key={entity.id}
                    entity={entity}
                    nodes={nodes}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onLocate={onLocate}
                    onAddOriginNode={onAddOriginNode}
                    isUninstantiated={uninstantiatedIds.has(entity.id)}
                  />
                ))}
              </div>
            </div>
          )
        })()}
        {categories.length === 0 && grouped.uncategorised.length === 0 && (
          <p className="px-3 py-2 text-xs text-zinc-600 italic">No categories yet. Click + Add Category to start.</p>
        )}
      </div>
    </div>
  )
}

function CustomCategoriesSection({ categories, onAdd, onEdit, onDelete, nameFilter = '' }) {
  const filteredCategories = useMemo(
    () => (nameFilter ? categories.filter((c) => matchesFilter(nameFilter, c.name, c.description)) : categories),
    [categories, nameFilter],
  )
  const [editingId, setEditingId] = useState(null)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editColour, setEditColour] = useState('#888888')
  const [showAddForm, setShowAddForm] = useState(false)
  const [addName, setAddName] = useState('')
  const [addDesc, setAddDesc] = useState('')
  const [addColour, setAddColour] = useState('#888888')
  const addColourAnchorRef = useRef(null)
  const [addColourPickerOpen, setAddColourPickerOpen] = useState(false)
  const editColourAnchorRef = useRef(null)
  const [editColourPickerOpen, setEditColourPickerOpen] = useState(false)

  function startEdit(cat) {
    setEditingId(cat.id)
    setEditName(cat.name)
    setEditDesc(cat.description || '')
    setEditColour(cat.colour || '#888888')
  }

  async function saveEdit() {
    if (!editName.trim()) return
    await onEdit(editingId, { name: editName.trim(), description: editDesc.trim(), colour: editColour })
    setEditingId(null)
  }

  async function handleAdd() {
    if (!addName.trim()) return
    await onAdd({ name: addName.trim(), description: addDesc.trim(), colour: addColour })
    setAddName('')
    setAddDesc('')
    setAddColour('#888888')
    setShowAddForm(false)
  }

  return (
    <div className="border-t border-zinc-700 mt-1 pt-1">
      <div className="px-3 py-1 flex items-center justify-between">
        <span className="text-xs text-zinc-500 uppercase tracking-wide">Categories</span>
        <button
          onClick={() => setShowAddForm(v => !v)}
          className="text-xs text-accent-400 hover:text-accent-300"
        >
          {showAddForm ? '×' : '+'}
        </button>
      </div>

      {showAddForm && (
        <div className="px-3 pb-2 flex flex-col gap-1">
          <input
            autoFocus
            value={addName}
            onChange={e => setAddName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            placeholder="Category name…"
            className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
          />
          <input
            value={addDesc}
            onChange={e => setAddDesc(e.target.value)}
            placeholder="Description (optional)"
            className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
          />
          <div className="flex items-center gap-1">
            <span className="text-xs text-zinc-500 whitespace-nowrap">Colour</span>
            <button
              type="button"
              ref={addColourAnchorRef}
              onClick={() => setAddColourPickerOpen((o) => !o)}
              className="w-7 h-6 rounded border border-zinc-600 cursor-pointer flex-shrink-0"
              style={{ background: addColour }}
              aria-label={`Colour: ${addColour}. Click to open picker.`}
            />
            <EntityColorPicker
              value={addColour}
              onChange={setAddColour}
              anchorEl={addColourAnchorRef.current}
              isOpen={addColourPickerOpen}
              onClose={() => setAddColourPickerOpen(false)}
            />
            <input value={addColour} onChange={e => setAddColour(e.target.value)} maxLength={7}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              className="flex-1 bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500 font-mono" />
          </div>
          <div className="flex gap-1">
            <button onClick={handleAdd} className="flex-1 text-xs bg-accent-700 hover:bg-accent-600 text-white rounded py-1">Add</button>
            <button onClick={() => setShowAddForm(false)} className="text-xs text-zinc-400 hover:text-zinc-200 px-2">✕</button>
          </div>
        </div>
      )}

      {filteredCategories.map(cat => (
        <div key={cat.id}>
          {editingId === cat.id ? (
            <div className="px-3 pb-2 flex flex-col gap-1">
              <input
                autoFocus
                value={editName}
                onChange={e => setEditName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveEdit()}
                className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
              />
              <input
                value={editDesc}
                onChange={e => setEditDesc(e.target.value)}
                placeholder="Description (optional)"
                className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
              />
              <div className="flex items-center gap-1">
                <span className="text-xs text-zinc-500 whitespace-nowrap">Colour</span>
                <button
                  type="button"
                  ref={editColourAnchorRef}
                  onClick={() => setEditColourPickerOpen((o) => !o)}
                  className="w-7 h-6 rounded border border-zinc-600 cursor-pointer flex-shrink-0"
                  style={{ background: editColour }}
                  aria-label={`Colour: ${editColour}. Click to open picker.`}
                />
                <EntityColorPicker
                  value={editColour}
                  onChange={setEditColour}
                  anchorEl={editColourAnchorRef.current}
                  isOpen={editColourPickerOpen}
                  onClose={() => setEditColourPickerOpen(false)}
                />
                <input value={editColour} onChange={e => setEditColour(e.target.value)} maxLength={7}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                  className="flex-1 bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500 font-mono" />
              </div>
              <div className="flex gap-1">
                <button onClick={saveEdit} className="flex-1 text-xs bg-accent-700 hover:bg-accent-600 text-white rounded py-1">Save</button>
                <button onClick={() => setEditingId(null)} className="text-xs text-zinc-400 hover:text-zinc-200 px-2">✕</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-3 py-1 group">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: cat.colour || '#888888' }} />
              <span className="flex-1 text-xs text-zinc-300 truncate">{cat.name}</span>
              <button onClick={() => startEdit(cat)} className="text-zinc-500 hover:text-zinc-300 text-xs opacity-0 group-hover:opacity-100">✎</button>
              <button onClick={() => onDelete(cat.id)} className="text-zinc-500 hover:text-red-400 text-xs opacity-0 group-hover:opacity-100">✕</button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** Preset Lists management section — shown when the Preset Lists tab is active. */
function PresetListsSection({ presetLists, onCreate, onUpdate, onDelete, nameFilter = '' }) {
  const presetOrder = useEntitiesStore((s) => s.libraryLayout.preset_lists || [])
  const setLibraryLayout = useEntitiesStore((s) => s.setLibraryLayout)
  const ordered = useMemo(() => {
    const byId = new Map((presetLists || []).map((pl) => [pl.id, pl]))
    const seen = new Set()
    const out = []
    for (const id of (presetOrder || [])) {
      const pl = byId.get(typeof id === 'string' ? id : id?.id)
      if (pl && !seen.has(pl.id)) { out.push(pl); seen.add(pl.id) }
    }
    for (const pl of (presetLists || [])) {
      if (!seen.has(pl.id)) out.push(pl)
    }
    return out
  }, [presetLists, presetOrder])
  // Preset Lists do not carry tags (descoped during Phase 3.4f); the
  // Project Tag filter and per-row ObjectTagsButton are intentionally
  // absent on this tab. Only the name/values quick-filter applies.
  const filteredLists = useMemo(
    () => (nameFilter ? ordered.filter((pl) => matchesFilter(nameFilter, pl.name, ...(pl.values || []))) : ordered),
    [ordered, nameFilter],
  )
  const reorderEnabled = !nameFilter
  const reorder = useLibraryReorder({
    total: filteredLists.length,
    enabled: reorderEnabled,
    onCommit: (srcIdx, dstIdx) => {
      const ids = filteredLists.map((pl) => pl.id)
      const [moved] = ids.splice(srcIdx, 1)
      const insertPos = dstIdx >= ids.length ? ids.length : (dstIdx > srcIdx ? dstIdx - 1 : dstIdx)
      ids.splice(insertPos, 0, moved)
      setLibraryLayout('preset_lists', ids)
    },
  })
  const [editingId, setEditingId]         = useState(null)
  const [editName, setEditName]           = useState('')
  const [editValues, setEditValues]       = useState([])
  const [editValueInput, setEditValueInput] = useState('')
  const [showAddForm, setShowAddForm]     = useState(false)
  const [addName, setAddName]             = useState('')
  const [addValues, setAddValues]         = useState([])
  const [addValueInput, setAddValueInput] = useState('')

  // Resolver state: shown when a value is removed from a list or a list is deleted
  // and consumers exist.
  const [resolver, setResolver] = useState(null)
  // resolver shape: { listId, listName, removedValues, pendingValues, proceedFn }

  function startEdit(pl) {
    setEditingId(pl.id)
    setEditName(pl.name)
    setEditValues([...pl.values])
    setEditValueInput('')
  }

  async function saveEdit() {
    if (!editName.trim()) return
    const pl = presetLists.find((p) => p.id === editingId)
    const removedVals = (pl?.values || []).filter((v) => !editValues.includes(v))
    if (removedVals.length > 0 && hasPresetConsumers(editingId, removedVals, useEntitiesStore.getState())) {
      setResolver({
        listId: editingId,
        listName: editName.trim(),
        removedValues: removedVals,
        pendingValues: editValues,
        proceedFn: async ({ addValues: extra = [] }) => {
          const finalValues = extra.length ? [...editValues, ...extra] : editValues
          await onUpdate(editingId, { id: editingId, name: editName.trim(), values: finalValues })
          setEditingId(null)
          setEditValueInput('')
        },
      })
      return
    }
    await onUpdate(editingId, { id: editingId, name: editName.trim(), values: editValues })
    setEditingId(null)
    setEditValueInput('')
  }

  async function handleDelete(listId) {
    const pl = presetLists.find((p) => p.id === listId)
    if (hasPresetConsumers(listId, null, useEntitiesStore.getState())) {
      setResolver({
        listId,
        listName: pl?.name ?? '',
        removedValues: null,
        pendingValues: null,
        proceedFn: async () => { await onDelete(listId) },
      })
      return
    }
    await onDelete(listId)
  }

  async function handleAdd() {
    if (!addName.trim()) return
    await onCreate({ name: addName.trim(), values: addValues })
    setAddName('')
    setAddValues([])
    setAddValueInput('')
    setShowAddForm(false)
  }

  function commitValue(values, setValues, input, setInput) {
    const v = input.trim()
    if (!v || values.includes(v)) { setInput(''); return }
    setValues([...values, v])
    setInput('')
  }

  function renderValueEditor(values, setValues, valueInput, setValueInput) {
    return (
      <div className="space-y-1">
        {values.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {values.map(v => (
              <span key={v} className="inline-flex items-center gap-0.5 bg-zinc-600 text-zinc-200 text-xs rounded px-1.5 py-0.5">
                {v}
                <button
                  type="button"
                  onClick={() => setValues(values.filter(x => x !== v))}
                  className="text-zinc-400 hover:text-red-400 leading-none ml-0.5"
                >×</button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-1">
          <input
            value={valueInput}
            onChange={e => setValueInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitValue(values, setValues, valueInput, setValueInput) } }}
            placeholder="Add value, press Enter…"
            className="flex-1 bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
          />
          <button
            type="button"
            onClick={() => commitValue(values, setValues, valueInput, setValueInput)}
            className="text-xs bg-zinc-600 hover:bg-zinc-500 text-zinc-200 rounded px-2 py-1"
          >+</button>
        </div>
      </div>
    )
  }

  // Section header count — filter-aware. Shows "N of M" while a
  // content filter is active so the writer can see what's hidden,
  // otherwise just the total. Mirrors the cue + entity-bucket
  // section header pattern.
  const presetHeaderCountLabel = nameFilter
    ? `${filteredLists.length} of ${(presetLists || []).length}`
    : `${(presetLists || []).length}`

  return (
    <>
    <div className="px-3 py-1 text-xs text-zinc-500 flex-shrink-0 flex items-center justify-between">
      <span>Preset Lists ({presetHeaderCountLabel})</span>
    </div>
    <div className="flex-1 overflow-y-auto min-h-0 p-2 space-y-2">
      {showAddForm && (
        <div className="bg-zinc-700/40 rounded p-2 space-y-1.5">
          <input
            autoFocus
            value={addName}
            onChange={e => setAddName(e.target.value)}
            placeholder="List name (e.g. Species)"
            className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
          />
          {renderValueEditor(addValues, setAddValues, addValueInput, setAddValueInput)}
          <button
            onClick={handleAdd}
            className="w-full text-xs bg-accent-700 hover:bg-accent-600 text-white rounded py-1"
          >
            Save List
          </button>
        </div>
      )}

      {filteredLists.length === 0 && !showAddForm && (
        <p className="text-xs text-zinc-600 italic px-1">No preset lists yet.</p>
      )}

      {filteredLists.map((pl, idx) => (
        <div
          key={pl.id}
          data-help-region="entity-library:preset_list_row"
          className="bg-zinc-700/30 rounded p-2 group/preset relative"
          style={reorder.indicatorStyle(idx, idx === filteredLists.length - 1) || undefined}
          {...reorder.rowDropProps(idx)}
        >
          {editingId === pl.id ? (
            <div className="space-y-1.5">
              <input
                autoFocus
                value={editName}
                onChange={e => setEditName(e.target.value)}
                className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
              />
              {renderValueEditor(editValues, setEditValues, editValueInput, setEditValueInput)}
              <div className="flex gap-1">
                <button onClick={saveEdit} className="flex-1 text-xs bg-accent-700 hover:bg-accent-600 text-white rounded py-1">Save</button>
                <button onClick={() => setEditingId(null)} className="text-xs text-zinc-400 hover:text-zinc-200 px-2">✕</button>
              </div>
            </div>
          ) : (
            <div className="flex items-start justify-between gap-1 group">
              {reorderEnabled && (
                <span
                  className="text-zinc-600 hover:text-zinc-300 cursor-grab active:cursor-grabbing opacity-0 group-hover/preset:opacity-100 transition-opacity flex-shrink-0 select-none mt-0.5"
                  style={{ fontSize: 9 }}
                  title="Drag to reorder"
                  {...reorder.gripProps(idx)}
                >⠿</span>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-zinc-200 truncate">{pl.name}</div>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {pl.values.length > 0
                    ? pl.values.map(v => <span key={v} className="bg-zinc-700 text-zinc-400 text-[10px] rounded px-1 py-0.5">{v}</span>)
                    : <span className="text-xs text-zinc-600 italic">(empty)</span>}
                </div>
              </div>
              <div className="flex gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100">
                <button onClick={() => startEdit(pl)} className="text-zinc-500 hover:text-zinc-200 text-xs">✎</button>
                <button onClick={() => handleDelete(pl.id)} className="text-zinc-500 hover:text-red-400 text-xs">✕</button>
              </div>
            </div>
          )}
        </div>
      ))}
      {reorder.trailingZoneProps && (
        <div className="h-6" {...reorder.trailingZoneProps} />
      )}
    </div>
    <div className="border-t border-zinc-700 p-2 flex-shrink-0">
      <button
        data-help-region="entity-library:new_preset_list_btn"
        onClick={() => setShowAddForm(v => !v)}
        className="w-full px-2 py-1.5 text-xs rounded bg-accent-700/20 border border-accent-700/40 text-accent-300 hover:bg-accent-700/40 hover:text-accent-200 transition-colors"
      >
        {showAddForm ? '− Cancel' : '+ New List'}
      </button>
    </div>

    {resolver && (
      <PresetListMutationResolver
        isOpen={!!resolver}
        onClose={() => setResolver(null)}
        listId={resolver.listId}
        listName={resolver.listName}
        removedValues={resolver.removedValues}
        pendingValues={resolver.pendingValues}
        onProceed={async (opts) => { await resolver.proceedFn(opts); setResolver(null) }}
      />
    )}
    </>
  )
}

function ReferencesSection({ nodes, focusNode, onAddReference, nameFilter = '', tagFilter = null }) {
  const refOrder = useEntitiesStore((s) => s.libraryLayout.reference_nodes || [])
  const setLibraryLayout = useEntitiesStore((s) => s.setLibraryLayout)
  // Phase 3.4i — reference nodes are baseline-only for tags (no chain
  // history); the walker collapses to `host.data.tag_ids`. Title is
  // the user-facing name (mirrors entity.name in the chain-aware
  // sense; reference nodes don't have a chain anchor to read from).
  const q = nameFilter ? String(nameFilter).trim().toLowerCase() : ''
  const tagFilterActive = tagFilter && !isEmptyTagFilter(tagFilter)
  const refNodes = useMemo(() => {
    const raw = nodes.filter((n) => n.type === 'referenceNode')
    const byId = new Map(raw.map((n) => [n.id, n]))
    const seen = new Set()
    const ordered = []
    for (const id of (refOrder || [])) {
      const n = byId.get(typeof id === 'string' ? id : id?.id)
      if (n && !seen.has(n.id)) { ordered.push(n); seen.add(n.id) }
    }
    for (const n of raw) {
      if (!seen.has(n.id)) ordered.push(n)
    }
    let result = ordered
    if (q) {
      result = result.filter((n) => {
        const d = n.data || {}
        const title = d.title || ''
        const subtitle = d.subtitle || ''
        return (title && title.toLowerCase().includes(q))
          || (subtitle && subtitle.toLowerCase().includes(q))
      })
    }
    if (tagFilterActive) {
      result = result.filter((n) => matchesProjectTagFilterBySet(
        chainWideTagIdsForHost(n, 'referenceNode', null),
        tagFilter,
      ))
    }
    return result
  }, [nodes, refOrder, q, tagFilterActive, tagFilter])
  const reorder = useLibraryReorder({
    total: refNodes.length,
    // Reorder disabled when EITHER filter is active.
    enabled: !q && !tagFilterActive,
    onCommit: (srcIdx, dstIdx) => {
      const ids = refNodes.map((n) => n.id)
      const [moved] = ids.splice(srcIdx, 1)
      const insertPos = dstIdx >= ids.length ? ids.length : (dstIdx > srcIdx ? dstIdx - 1 : dstIdx)
      ids.splice(insertPos, 0, moved)
      setLibraryLayout('reference_nodes', ids)
    },
  })

  return (
    <>
    <div className="flex-1 overflow-y-auto min-h-0">
      <div className="px-3 py-1 text-xs text-zinc-500 flex-shrink-0">
        References ({refNodes.length})
      </div>
      {refNodes.length === 0 ? (
        <div className="px-3 py-4 text-xs text-zinc-600 text-center">
          No reference nodes on canvas
        </div>
      ) : (
        <div className="py-1 px-1 space-y-0.5">
          {refNodes.map((node, idx) => {
            const d = node.data || {}
            const colour = d.colour || '#888888'
            const title = d.title || (d.sub_type === 'concept' ? 'Untitled concept' : d.sub_type === 'note' ? 'Untitled note' : 'Untitled media')
            let subType = 'MEDIA'
            if (d.sub_type === 'note') {
              subType = 'NOTE'
            } else if (d.sub_type === 'concept') {
              subType = 'CONCEPT'
            } else if (d.file_ref) {
              const ref = d.file_ref.toLowerCase()
              if (/\.(png|jpe?g|gif|webp|svg)$/.test(ref)) subType = 'MEDIA : IMAGE'
              else if (/\.(mp4|webm|mov)$/.test(ref)) subType = 'MEDIA : VIDEO'
              else if (/\.(mp3|wav|ogg|flac)$/.test(ref)) subType = 'MEDIA : AUDIO'
            }
            return (
              <div
                key={node.id}
                data-help-region="entity-library:reference_row"
                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-zinc-700/50 group cursor-default"
                style={reorder.indicatorStyle(idx, idx === refNodes.length - 1) || undefined}
                {...reorder.rowDropProps(idx)}
              >
                <span
                  className="text-zinc-600 hover:text-zinc-300 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 select-none"
                  style={{ fontSize: 9 }}
                  title="Drag to reorder"
                  {...reorder.gripProps(idx)}
                >⠿</span>
                <div
                  className="w-3 h-3 rounded-sm flex-shrink-0 border border-zinc-600"
                  style={{ backgroundColor: colour }}
                />
                <span className="text-xs text-zinc-300 truncate flex-1" title={title}>{title}</span>
                <span className="text-[9px] text-zinc-600 uppercase flex-shrink-0">{subType}</span>
                {/* Phase 3.4i — read-only tag glance, hover-revealed
                    like the surrounding row affordances. Reference
                    nodes are baseline-only (no chain); the popover
                    header is a minimal colour-chip + title since
                    references don't have an IdentityBadges chip. */}
                <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex-shrink-0">
                  <ObjectTagsButton
                    pool="project"
                    host={node}
                    hostKind="referenceNode"
                    nodes={null}
                    hostHeader={(
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-zinc-700 bg-zinc-900/80 text-[10px] text-zinc-200 max-w-[12rem]">
                        <span
                          className="w-2 h-2 rounded-sm flex-shrink-0 border border-zinc-600"
                          style={{ backgroundColor: colour }}
                        />
                        <span className="truncate">{title}</span>
                      </span>
                    )}
                  />
                </span>
                <button
                  className="text-xs text-zinc-600 hover:text-zinc-200 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                  onClick={() => focusNode && focusNode(node.id)}
                  title="Locate on canvas"
                >
                  {'👁'}
                </button>
              </div>
            )
          })}
          {reorder.trailingZoneProps && (
            <div className="h-6" {...reorder.trailingZoneProps} />
          )}
        </div>
      )}
    </div>
    <div className="border-t border-zinc-700 p-2 flex-shrink-0 flex flex-col gap-2">
      <button
        data-help-region="entity-library:new_reference_note_btn"
        onClick={() => onAddReference('note')}
        className="w-full px-2 py-1.5 text-xs rounded bg-accent-700/20 border border-accent-700/40 text-accent-300 hover:bg-accent-700/40 hover:text-accent-200 transition-colors"
      >
        + New Reference Note
      </button>
      <button
        data-help-region="entity-library:new_reference_media_btn"
        onClick={() => onAddReference('media')}
        className="w-full px-2 py-1.5 text-xs rounded bg-accent-700/20 border border-accent-700/40 text-accent-300 hover:bg-accent-700/40 hover:text-accent-200 transition-colors"
      >
        + New Reference Media
      </button>
      <button
        data-help-region="entity-library:new_reference_concept_btn"
        onClick={() => onAddReference('concept')}
        className="w-full px-2 py-1.5 text-xs rounded bg-accent-700/20 border border-accent-700/40 text-accent-300 hover:bg-accent-700/40 hover:text-accent-200 transition-colors"
      >
        + New Concept
      </button>
    </div>
    </>
  )
}

// ── Knowledge library section (Phase 1.21c) ────────────────────────────────
//
// Renders when activeTab === 'knowledge'. Pulls from `projectStore.knowledges`
// (not entitiesStore). Minimal for Step 4 — list + create + delete. Rich
// editing (name / description / colour / avatar / awareness + chain
// navigation) lands with Step 5's Knowledge Detail Panel mode. Row click
// is a no-op until then.
function KnowledgeLibrarySection({ knowledges, onCreate, onDelete, onOpen, originNodeIds, onLocate, onAddOriginNode, nameFilter = '', tagFilter = null, nodes = null }) {
  const baseList = knowledges || []
  const knowledgeOrder = useEntitiesStore((s) => s.libraryLayout.knowledges || [])
  const setLibraryLayout = useEntitiesStore((s) => s.setLibraryLayout)
  // Apply writer-controlled order: any knowledge id present in
  // `library_layout.knowledges` lands in that order; unknown /
  // newly-added knowledges fall back to their natural store order
  // at the end. Filtering by name happens after ordering so the
  // visible list still reflects the writer's intended sort.
  const ordered = useMemo(() => {
    const byId = new Map((baseList || []).map((k) => [k.id, k]))
    const seen = new Set()
    const out = []
    for (const id of (knowledgeOrder || [])) {
      const k = byId.get(typeof id === 'string' ? id : id?.id)
      if (k && !seen.has(k.id)) { out.push(k); seen.add(k.id) }
    }
    for (const k of (baseList || [])) {
      if (!seen.has(k.id)) out.push(k)
    }
    return out
  }, [baseList, knowledgeOrder])
  // Phase 3.4i — intersect text filter with project tag filter.
  // Knowledge is chain-trackable; `chainWideTagIdsForHost` walks
  // `history.tag_changes` from the knowledge row itself (no `nodes`
  // needed for knowledge baseline + chain split, but passed for
  // consistency with the entity path).
  const tagFilterActive = tagFilter && !isEmptyTagFilter(tagFilter)
  const list = useMemo(() => {
    let result = ordered
    if (nameFilter) result = result.filter((k) => matchesFilter(nameFilter, k.name, k.description))
    if (tagFilterActive) {
      result = result.filter((k) => matchesProjectTagFilterBySet(
        chainWideTagIdsForHost(k, 'knowledge', nodes),
        tagFilter,
      ))
    }
    return result
  }, [ordered, nameFilter, tagFilterActive, tagFilter, nodes])
  // Reorder disabled when EITHER filter is active.
  const reorderEnabled = !nameFilter && !tagFilterActive
  const reorder = useLibraryReorder({
    total: list.length,
    enabled: reorderEnabled,
    onCommit: (srcIdx, dstIdx) => {
      const ids = list.map((k) => k.id)
      const [moved] = ids.splice(srcIdx, 1)
      const insertPos = dstIdx >= ids.length ? ids.length : (dstIdx > srcIdx ? dstIdx - 1 : dstIdx)
      ids.splice(insertPos, 0, moved)
      setLibraryLayout('knowledges', ids)
    },
  })
  return (
    <>
      <div className="px-3 py-1 text-xs text-zinc-500 flex-shrink-0 flex items-center justify-between">
        <span>Knowledge ({list.length})</span>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 py-1 px-1 space-y-0.5">
        {list.length === 0 && (
          <p className="px-3 py-2 text-xs text-zinc-600 italic">None.</p>
        )}
        {list.map((k, idx) => (
          <KnowledgeLibraryRow
            key={k.id}
            knowledge={k}
            nodes={nodes}
            onDelete={onDelete}
            onOpen={onOpen}
            hasOriginNode={originNodeIds?.has(k.id) ?? false}
            onLocate={onLocate}
            onAddOriginNode={onAddOriginNode}
            reorderEnabled={reorderEnabled}
            gripProps={reorder.gripProps(idx)}
            rowDropProps={reorder.rowDropProps(idx)}
            indicatorStyle={reorder.indicatorStyle(idx, idx === list.length - 1)}
          />
        ))}
        {reorder.trailingZoneProps && (
          <div className="h-6" {...reorder.trailingZoneProps} />
        )}
      </div>
      <div className="border-t border-zinc-700 p-2 flex-shrink-0">
        <button
          data-help-region="entity-library:new_knowledge_btn"
          onClick={onCreate}
          className="w-full px-2 py-1.5 text-xs rounded bg-accent-700/20 border border-accent-700/40 text-accent-300 hover:bg-accent-700/40 hover:text-accent-200 transition-colors"
        >
          + New Knowledge
        </button>
      </div>
    </>
  )
}

// ── Relationships library section (Phase 2.8 reorder) ─────────────────────
//
// The flat catalogue of every Relationship in the story. Pulls from
// `projectStore.relationships`; uses `entitiesStore.libraryLayout.relationships`
// for writer-controlled order (added in Phase 2.8 alongside the cue +
// knowledge library reorder).
function RelationshipsLibrarySection({ relationships, onOpen, nameFilter = '', tagFilter = null, nodes = null }) {
  const relOrder = useEntitiesStore((s) => s.libraryLayout.relationships || [])
  const setLibraryLayout = useEntitiesStore((s) => s.setLibraryLayout)
  const addEmptyRelationshipOriginNode = useProjectStore((s) => s.addEmptyRelationshipOriginNode)
  const q = nameFilter ? String(nameFilter).trim().toLowerCase() : ''
  const tagFilterActive = tagFilter && !isEmptyTagFilter(tagFilter)
  const ordered = useMemo(() => {
    const byId = new Map((relationships || []).map((r) => [r.id, r]))
    const seen = new Set()
    const out = []
    for (const id of (relOrder || [])) {
      const r = byId.get(typeof id === 'string' ? id : id?.id)
      if (r && !seen.has(r.id)) { out.push(r); seen.add(r.id) }
    }
    for (const r of (relationships || [])) {
      if (!seen.has(r.id)) out.push(r)
    }
    return out
  }, [relationships, relOrder])
  // Phase 3.4i — intersect text + tag filters. Relationship is
  // chain-trackable; tag walker reads `rel.history.tag_changes`.
  const visibleRels = useMemo(() => {
    let result = ordered
    if (q) {
      result = result.filter((rel) => {
        if (rel.name && String(rel.name).toLowerCase().includes(q)) return true
        if (rel.description && String(rel.description).toLowerCase().includes(q)) return true
        return false
      })
    }
    if (tagFilterActive) {
      result = result.filter((rel) => matchesProjectTagFilterBySet(
        chainWideTagIdsForHost(rel, 'relationship', nodes),
        tagFilter,
      ))
    }
    return result
  }, [ordered, q, tagFilterActive, tagFilter, nodes])
  // Reorder disabled when EITHER filter is active.
  const reorderEnabled = !q && !tagFilterActive
  const reorder = useLibraryReorder({
    total: visibleRels.length,
    enabled: reorderEnabled,
    onCommit: (srcIdx, dstIdx) => {
      const ids = visibleRels.map((r) => r.id)
      const [moved] = ids.splice(srcIdx, 1)
      const insertPos = dstIdx >= ids.length ? ids.length : (dstIdx > srcIdx ? dstIdx - 1 : dstIdx)
      ids.splice(insertPos, 0, moved)
      setLibraryLayout('relationships', ids)
    },
  })
  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="px-3 py-1 text-xs text-zinc-500 flex-shrink-0">
        Relationships ({q ? `${visibleRels.length} / ${relationships.length}` : relationships.length})
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 py-1 px-1 space-y-0.5">
        {visibleRels.length === 0 && !q && (
          <p className="px-3 py-2 text-xs text-zinc-600 italic">
            No relationships yet. Create one from an entity&apos;s Relationships tab.
          </p>
        )}
        {visibleRels.length === 0 && q && (
          <p className="px-3 py-2 text-xs text-zinc-600 italic">None.</p>
        )}
        {visibleRels.map((rel, idx) => (
          <div
            key={rel.id}
            data-help-region="entity-library:relationship_row"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/nnz-relationship-id', rel.id)
              e.dataTransfer.effectAllowed = 'copyMove'
            }}
            // Layout mirrors the entity-row pattern: outer wrapper
            // carries the colour-tinted left border so the grip
            // sits INSIDE the bar (not outside indented to the
            // right). `RelationshipSummaryHeader` is rendered with
            // `noBorder` so its own borderLeft doesn't double up.
            className="group/relrow relative flex items-center gap-1.5 pl-1.5 pr-1.5"
            style={{
              borderLeft: '2px solid #a78bfa66',
              ...(reorder.indicatorStyle(idx, idx === visibleRels.length - 1) || {}),
            }}
            {...reorder.rowDropProps(idx)}
          >
            {reorderEnabled && (
              <span
                className="text-zinc-600 hover:text-zinc-300 cursor-grab active:cursor-grabbing opacity-0 group-hover/relrow:opacity-100 transition-opacity flex-shrink-0 select-none"
                style={{ fontSize: 9 }}
                title="Drag to reorder"
                {...reorder.gripProps(idx)}
              >⠿</span>
            )}
            <div className="flex-1 min-w-0">
              <RelationshipSummaryHeader
                relationship={rel}
                compact
                noBorder
                onClick={() => onOpen(rel.id)}
              />
            </div>
            {/* Phase 3.4i — read-only tag glance, hover-revealed
                like surrounding action affordances. */}
            <span className="opacity-0 group-hover/relrow:opacity-100 focus-within:opacity-100 transition-opacity flex-shrink-0">
              <ObjectTagsButton
                pool="project"
                host={rel}
                hostKind="relationship"
                nodes={nodes}
                hostHeader={<RelationshipLabelChip name={rel.name} />}
              />
            </span>
          </div>
        ))}
        {reorder.trailingZoneProps && (
          <div className="h-6" {...reorder.trailingZoneProps} />
        )}
      </div>
      {/* Phase 2.10 Bug 9 follow-up — "+ New Relationship" button mirrors
          the canvas toolbar "Add to canvas" → "Add Relationship" flow
          (`addEmptyRelationshipOriginNode(null)`). Creates an empty
          relationship plus a RelationshipOriginNode on the canvas and
          opens the Relationship Detail panel for the writer to fill in
          participants. Passing null triggers the action's built-in
          automatic placement (random offset near the canvas origin)
          since the library surface has no cursor anchor. */}
      <div className="border-t border-zinc-700 p-2 flex-shrink-0">
        <button
          data-help-region="entity-library:new_relationship_btn"
          onClick={() => addEmptyRelationshipOriginNode(null)}
          className="w-full px-2 py-1.5 text-xs rounded bg-accent-700/20 border border-accent-700/40 text-accent-300 hover:bg-accent-700/40 hover:text-accent-200 transition-colors"
        >
          + New Relationship
        </button>
      </div>
    </div>
  )
}

function KnowledgeLibraryRow({ knowledge, nodes, onDelete, onOpen, hasOriginNode, onLocate, onAddOriginNode, reorderEnabled, gripProps, rowDropProps, indicatorStyle }) {
  const colour = knowledge.colour || '#888888'
  const assetName = knowledge.profile_image_ref
    ? knowledge.profile_image_ref.replace(/^assets\//, '')
    : null
  const src = assetName ? `/api/project/assets/${assetName}` : null

  // Drag-from-library — Phase 1.21c. Carries the Knowledge id under a
  // Knowledge-specific MIME so Canvas / SceneNode drop handlers can
  // disambiguate from entity drops. Always draggable — drop semantics
  // depend on the target:
  //   - Empty canvas + no origin node → spawn a `<KnowledgeOriginNode>`.
  //   - Empty canvas + origin node already exists → silent no-op.
  //   - Scene node + no creation anchor → seed scene-born birth event.
  //   - Scene node + creation anchor exists → add a manual anchor.
  //   - Scene node where this Knowledge is already chipped → silent no-op.
  const handleRowDragStart = (e) => {
    e.dataTransfer.setData('application/nnz-knowledge-id', knowledge.id)
    e.dataTransfer.effectAllowed = 'copy'

    // Custom drag ghost: a small parchment-bordered avatar (matches the
    // entity-row pattern at line ~30 of this file).
    const ghost = document.createElement('div')
    ghost.style.cssText = `
      width: 40px; height: 40px; border-radius: 4px; border: 2px solid ${colour};
      overflow: hidden; position: fixed; top: -100px; left: -100px;
      display: flex; align-items: center; justify-content: center;
      background: #27272a; font-size: 18px;
    `
    if (assetName) {
      const img = document.createElement('img')
      img.src = `/api/project/assets/${assetName}`
      img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;'
      ghost.appendChild(img)
    } else {
      ghost.textContent = '📜'
      ghost.style.backgroundColor = colour + '22'
    }
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 20, 20)
    requestAnimationFrame(() => document.body.removeChild(ghost))
  }

  return (
    <div
      data-help-region="entity-library:knowledge_row"
      className="flex items-center gap-1.5 px-1.5 py-1.5 rounded-sm cursor-pointer group/item hover:bg-zinc-800/60 transition-colors"
      style={(() => {
        const shadowParts = []
        if (indicatorStyle?.boxShadow) shadowParts.push(indicatorStyle.boxShadow)
        if (!hasOriginNode) {
          shadowParts.push('inset -1px 0 0 0 #f87171')
          if (!indicatorStyle?.boxShadow?.includes('-2px')) shadowParts.push('inset 0 -1px 0 0 #f87171')
          shadowParts.push('inset 0 1px 0 0 #f87171')
        }
        return {
          borderLeft: `3px solid ${colour}`,
          backgroundColor: colour + '0d',
          ...(shadowParts.length ? { boxShadow: shadowParts.join(', ') } : {}),
          ...(!hasOriginNode ? { borderRadius: '2px 6px 6px 2px' } : {}),
        }
      })()}
      draggable
      onDragStart={handleRowDragStart}
      onClick={() => onOpen?.(knowledge.id)}
      title={hasOriginNode
        ? 'Open in Detail Panel — or drag onto a scene to add a manual anchor'
        : 'No creation anchor on canvas. Add an origin point: drag to empty canvas to spawn a Knowledge origin node, or drag onto a scene to make that scene its creation point.'}
      {...(rowDropProps || {})}
    >
      {/* Reorder grip — visible only on hover when reorder is enabled. */}
      {reorderEnabled && (
        <span
          className="text-zinc-600 hover:text-zinc-300 cursor-grab active:cursor-grabbing opacity-0 group-hover/item:opacity-100 transition-opacity flex-shrink-0 select-none"
          style={{ fontSize: 9 }}
          title="Drag to reorder"
          {...(gripProps || {})}
        >⠿</span>
      )}
      {/* Avatar — scroll-emoji placeholder when no profile image */}
      <ImageHoverPreview src={src} borderColour={colour} size={80}>
        <span
          className="inline-flex items-center justify-center flex-shrink-0 rounded-sm overflow-hidden"
          style={{
            width: 18, height: 18,
            border: `1.5px solid ${colour}`,
            backgroundColor: src ? 'transparent' : colour + '22',
          }}
        >
          {src ? (
            <img src={src} alt="" className="w-full h-full object-cover" />
          ) : (
            <span style={{ fontSize: 11 }}>📜</span>
          )}
        </span>
      </ImageHoverPreview>

      <span className="flex-1 text-xs text-zinc-200 truncate">
        {knowledge.name || <em className="text-zinc-600">(unnamed)</em>}
      </span>

      {/* No-origin-node badge */}
      {!hasOriginNode && (
        <span
          className="text-red-400 flex-shrink-0 text-[10px] leading-none"
          title="No origin node on canvas (pre-story baseline)"
        >∅</span>
      )}

      {/* Locate-on-canvas / add-origin-node toggle (mirrors the entity row pattern) */}
      {hasOriginNode ? (
        <button
          className="w-5 h-5 flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 opacity-0 group-hover/item:opacity-100 transition-opacity flex-shrink-0 text-[10px] rounded"
          onClick={(e) => { e.stopPropagation(); onLocate?.(knowledge.id) }}
          title="Centre canvas on this knowledge's origin node"
        >👁</button>
      ) : (
        <button
          className="text-zinc-600 hover:text-green-400 opacity-0 group-hover/item:opacity-100 transition-opacity flex-shrink-0 text-[10px] leading-none"
          onClick={(e) => { e.stopPropagation(); onAddOriginNode?.(knowledge.id) }}
          title="Add origin node to canvas"
        >⊕</button>
      )}

      {/* Phase 3.4i — read-only tag glance, hover-revealed like the
          surrounding action buttons. */}
      <span className="opacity-0 group-hover/item:opacity-100 focus-within:opacity-100 transition-opacity flex-shrink-0">
        <ObjectTagsButton
          pool="project"
          host={knowledge}
          hostKind="knowledge"
          nodes={nodes}
          hostHeader={<KnowledgeLabelChip name={knowledge.name} />}
        />
      </span>

      {/* Delete × on hover */}
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(knowledge.id) }}
        className="text-zinc-600 hover:text-red-400 opacity-0 group-hover/item:opacity-100 transition-opacity flex-shrink-0 px-1 text-[11px] leading-none"
        title="Delete knowledge"
      >
        ×
      </button>
    </div>
  )
}

export default function EntityLibraryPanel() {
  const activeTab            = useUiStore((s) => s.entityLibraryTab)
  const setActiveTab         = useUiStore((s) => s.setEntityLibraryTab)

  const entityLibraryOpen   = useUiStore((s) => s.entityLibraryOpen)
  const toggleEntityLibrary      = useUiStore((s) => s.toggleEntityLibrary)
  const sidebarTab               = useUiStore((s) => s.sidebarTab)
  const setSidebarTab            = useUiStore((s) => s.setSidebarTab)
  const openNewEntityModal       = useUiStore((s) => s.openNewEntityModal)
  const setDetailPanel           = useUiStore((s) => s.setDetailPanel)
  const openDeleteEntityDialog   = useUiStore((s) => s.openDeleteEntityDialog)
  const openRelationshipDetail   = useUiStore((s) => s.openRelationshipDetail)

  const focusNode                = useUiStore((s) => s._focusNode)

  // Structurally-gated `nodes` subscription (same equality rule the
  // alerts hooks share): position-only churn (drag, pan, RF dimension
  // settles) leaves every node's `id`/`type`/`data` reference intact
  // and must NOT re-render this panel. Everything the panel derives
  // from `nodes` (origin presence, chain-wide tag sets, knowledge
  // origin anchors) rides `data`, so data changes still pass.
  //
  // No `edges` subscription and no render-path `useStoryOrder()`:
  // both were only consumed inside the knowledge locate click
  // handler, which now reads current state lazily at click time.
  // The render-path story-order subscription made this panel (first
  // story-order consumer in tree order) pay the cold recompute for
  // every consumer; see the Phase 4.1 re-baseline notes.
  const nodes               = useStoreWithEqualityFn(useProjectStore, (s) => s.nodes, nodesStructurallyEqual)
  const countEntityChips    = useProjectStore((s) => s.countEntityChips)
  const addEntityNodeToCanvas = useProjectStore((s) => s.addEntityNodeToCanvas)
  const addReferenceNode    = useProjectStore((s) => s.addReferenceNode)
  const relationships       = useProjectStore((s) => s.relationships)
  const setHierarchyParent  = useProjectStore((s) => s.setHierarchyParent)
  // Phase 1.21c — Knowledge is first-class and lives on projectStore
  // (not entitiesStore). The Library "Knowledge" tab reads from here.
  const knowledgesPS        = useProjectStore((s) => s.knowledges)
  const addKnowledgeOriginNodeToCanvas = useProjectStore((s) => s.addKnowledgeOriginNodeToCanvas)
  const openNewKnowledgeModal = useUiStore((s) => s.openNewKnowledgeModal)
  const openKnowledgeDetail  = useUiStore((s) => s.openKnowledgeDetail)

  const characters = useEntitiesStore((s) => s.characters)
  const locations = useEntitiesStore((s) => s.locations)
  const items = useEntitiesStore((s) => s.items)
  const factions = useEntitiesStore((s) => s.factions)
  const customs = useEntitiesStore((s) => s.customs)
  const knowledges = useProjectStore((s) => s.knowledges)
  const customCategories = useEntitiesStore((s) => s.customCategories)
  const createCustomCategory = useEntitiesStore((s) => s.createCustomCategory)
  const updateCustomCategory = useEntitiesStore((s) => s.updateCustomCategory)
  const presetLists = useEntitiesStore((s) => s.presetLists)
  const createPresetList = useEntitiesStore((s) => s.createPresetList)
  const updatePresetList = useEntitiesStore((s) => s.updatePresetList)
  const deleteObject = useProjectStore((s) => s.deleteObject)
  const libraryLayout = useEntitiesStore((s) => s.libraryLayout)
  const setLibraryLayout = useEntitiesStore((s) => s.setLibraryLayout)
  const addLibraryDivider = useEntitiesStore((s) => s.addLibraryDivider)
  const updateLibraryDivider = useEntitiesStore((s) => s.updateLibraryDivider)
  const removeLibraryDivider = useEntitiesStore((s) => s.removeLibraryDivider)

  const entityMap = { character: characters, location: locations, item: items, faction: factions, custom: customs, knowledge: knowledges }

  // Phase 3.4i — shared Project Tag filter across every entity-family
  // library tab. Single instance per the locked Pre-Prep decision so
  // switching tabs preserves the active filter. The host's chain-wide
  // tag set is computed by `chainWideTagIdsForHost` (chain-aware
  // walker — baseline + every chain-add event across the chain,
  // ignoring removes per the filter discovery semantic). The library
  // is the canonical "view from origin" surface but the FILTER is
  // discovery-time: a host that EVER carried a tag matches that tag's
  // filter, even if the tag was later removed downstream.
  const entityLibraryTagFilter = useUiStore((s) => s.entityLibraryTagFilter)
  const setEntityLibraryTagFilter = useUiStore((s) => s.setEntityLibraryTagFilter)
  const tagFilterEmpty = isEmptyTagFilter(entityLibraryTagFilter)
  // Phase 3.4i — program-pool tag filter for the Context Cues tab,
  // read at panel level so the inline `TagFilterBar` next to the
  // text-filter input can be wired here. `ContextCueSection` keeps
  // its own filter pipeline; it just reads the same `uiStore` field.
  const contextCuesTagFilter = useUiStore((s) => s.contextCuesTagFilter)
  const setContextCuesTagFilter = useUiStore((s) => s.setContextCuesTagFilter)

  // Phase 1.24a — per-tab quick-filter. Each tab carries its own filter
  // string; switching tabs preserves each tab's query for the rest of
  // the session. Component-local state because the filter is transient
  // and per-session — no need to plumb through the store. Reset on
  // project close / reload happens automatically because the panel
  // remounts. Reads of `entity.name` / `entity.description` /
  // `relationship.name` etc. for filter matching are baseline reads
  // at origin context — the library is the canonical "view from
  // origin" surface — so this is chain-correct.
  const [filterByTab, setFilterByTab] = useState({})
  const currentFilter = filterByTab[activeTab] || ''
  const setCurrentFilter = useCallback((next) => {
    setFilterByTab((prev) => ({ ...prev, [activeTab]: next }))
  }, [activeTab])
  const clearCurrentFilter = useCallback(() => {
    setFilterByTab((prev) => ({ ...prev, [activeTab]: '' }))
  }, [activeTab])

  // Phase 1.21c — Knowledge tab renders a distinct section (not an entity
  // list). `isEntityTab` excludes 'knowledge' so the entity-list branch
  // below only fires for the five actual Entity subtypes.
  const isKnowledgeTab = activeTab === 'knowledge'
  const isEntityTab = ENTITY_TABS.some(t => t.key === activeTab) && !isKnowledgeTab
  const currentEntityTab = ENTITY_TABS.find(t => t.key === activeTab)
  const currentEntities = entityMap[activeTab] || []

  // Build ordered list from layout, falling back to raw entity order for entities not in layout
  const bucketKey = activeTab + 's'
  const layout = libraryLayout[bucketKey] || []
  const orderedItems = useMemo(() => {
    const entityById = new Map(currentEntities.map(e => [e.id, e]))
    const result = []
    const seen = new Set()
    for (const item of layout) {
      if (typeof item === 'string') {
        const ent = entityById.get(item)
        if (ent) { result.push({ type: 'entity', entity: ent }); seen.add(item) }
      } else if (item && item.type === 'divider') {
        result.push({ type: 'divider', divider: item })
      }
    }
    // Append any entities not yet in layout
    for (const ent of currentEntities) {
      if (!seen.has(ent.id)) result.push({ type: 'entity', entity: ent })
    }
    return result
  }, [currentEntities, layout])

  // Phase 1.24a — apply current tab's quick-filter to the ordered list.
  // Entities are kept when name OR description matches; dividers are
  // dropped while a filter is active (they only make sense in the
  // unfiltered ordered view). Baseline reads at origin context.
  //
  // Phase 3.4i — also apply the shared Project Tag filter on top
  // (intersection with the name/description quick-filter). Chain-wide
  // ever-tagged semantic: a host that ever carried a tag matches that
  // tag's filter, even if removed downstream.
  const visibleItems = useMemo(() => {
    const q = currentFilter ? String(currentFilter).trim().toLowerCase() : ''
    const applyName = !!q
    const applyTags = !tagFilterEmpty
    if (!applyName && !applyTags) return orderedItems
    return orderedItems.filter((it) => {
      if (it.type !== 'entity') return false
      const e = it.entity
      if (applyName) {
        const hit = (e.name && String(e.name).toLowerCase().includes(q))
          || (e.description && String(e.description).toLowerCase().includes(q))
        if (!hit) return false
      }
      if (applyTags) {
        const tagSet = chainWideTagIdsForHost(e, activeTab, nodes)
        if (!matchesProjectTagFilterBySet(tagSet, entityLibraryTagFilter)) return false
      }
      return true
    })
  }, [orderedItems, currentFilter, tagFilterEmpty, entityLibraryTagFilter, nodes, activeTab])

  // Drag-to-reorder via the shared `useLibraryReorder` hook
  // (single source of truth for the state machine, grip / row
  // wiring, and the top/bottom drop indicator). `onCommit`
  // translates hook indices into the underlying layout list:
  // hook gives us `src` (raw index in orderedItems) and `dst`
  // (raw index of the target row OR `orderedItems.length` for
  // drop-at-end). We rebuild the layout and persist via the
  // same `setLibraryLayout(bucketKey, …)` action as before.
  // Disabled while a quick-filter is active — reorder semantics
  // only make sense against the unfiltered list, matching the
  // pre-hook gating.
  const reorder = useLibraryReorder({
    total: orderedItems.length,
    // Disable reorder while EITHER filter is active — reorder is only
    // safe against the unfiltered list; otherwise drop indices don't
    // correspond to layout positions.
    enabled: !currentFilter && tagFilterEmpty,
    onCommit: (src, dst) => {
      const newLayout = orderedItems.map((item) => (
        item.type === 'entity' ? item.entity.id : item.divider
      ))
      const [moved] = newLayout.splice(src, 1)
      // After removing the dragged item, target indices shift
      // down by 1 for items below `src` (including the drop-
      // at-end sentinel value `orderedItems.length`).
      const insertIdx = dst > src ? dst - 1 : dst
      newLayout.splice(insertIdx, 0, moved)
      setLibraryLayout(bucketKey, newLayout)
    },
  })

  // Set of entity IDs that have no origin node on the canvas
  const uninstantiatedIds = useMemo(() => {
    const allEntities = [...characters, ...locations, ...items, ...factions, ...customs, ...(knowledges || [])]
    const originEntityIds = new Set(
      nodes.filter((n) => n.type === 'entityNode' && !n.data.is_modifier && n.data.entity_id)
        .map((n) => n.data.entity_id)
    )
    return new Set(allEntities.filter((e) => !originEntityIds.has(e.id)).map((e) => e.id))
  }, [characters, locations, items, factions, customs, knowledges, nodes])

  // Navigate to entity's initial state in the sidebar (find its origin node on canvas)
  const navigateToEntity = useCallback((entityId) => {
    const originNode = nodes.find(
      (n) => n.type === 'entityNode' && !n.data.is_modifier && n.data.entity_id === entityId
    )
    if (originNode) {
      setDetailPanel('entityNode', originNode.id, entityId, 0)
    }
  }, [nodes, setDetailPanel])

  // Locate entity origin node on canvas (pan + zoom)
  const handleLocateEntity = useCallback((entityId) => {
    const originNode = nodes.find(
      (n) => n.type === 'entityNode' && !n.data.is_modifier && n.data.entity_id === entityId
    )
    if (originNode && focusNode) focusNode(originNode.id)
  }, [nodes, focusNode])

  // Add a new origin node to the canvas for an uninstantiated entity
  const handleAddOriginNode = useCallback((entity) => {
    const entityNode = {
      id: crypto.randomUUID(),
      entity_id: entity.id,
      node_type: 'entity',
    }
    addEntityNodeToCanvas(entityNode)
  }, [addEntityNodeToCanvas])

  // Add a new reference node (note | media) at the centre of the
  // current viewport. Used by the two bottom buttons in the References
  // tab. The node's `position` is its top-left, so offset by roughly
  // half the default reference-node dimensions to land it visually
  // centred rather than down-and-right of cursor.
  const handleAddReferenceAtViewport = useCallback((subType) => {
    const vp = useUiStore.getState()._getViewportCenter?.()
    const pos = vp
      ? { x: Math.round(vp.x - 150), y: Math.round(vp.y - 90) }
      : undefined
    addReferenceNode(pos, subType)
  }, [addReferenceNode])

  // Open unified delete confirmation dialog for an entity from the library panel
  const handleDeleteRequest = useCallback((entity) => {
    const chipCount = countEntityChips(entity.id)
    const originNode = nodes.find(
      (n) => n.type === 'entityNode' && !n.data.is_modifier && n.data.entity_id === entity.id
    )
    const payload = {
      entityId: entity.id,
      entityName: entity.name,
      entityColour: entity.colour || '#888888',
      chipCount,
      nodeId: originNode?.id || null,
      isOrigin: true,
    }
    if (isOvumRedEntity(entity)) {
      payload.extraOption = {
        label: "Don't let this happen again this session",
        onChange: (checked) => setOvumRedSessionDisabled(checked),
      }
    }
    openDeleteEntityDialog(payload)
  }, [countEntityChips, nodes, openDeleteEntityDialog])

  // ── Knowledge library handlers (Phase 1.21c Step 4) ──────────────────
  const handleCreateKnowledge = useCallback(() => {
    openNewKnowledgeModal()
  }, [openNewKnowledgeModal])

  const handleDeleteKnowledge = useCallback(async (knowledgeId) => {
    const k = (knowledgesPS || []).find((x) => x.id === knowledgeId)
    const result = await confirm({
      title: 'Delete Knowledge',
      message: buildDeleteKnowledgeMessage({ knowledge: k }),
      accentColour: k?.colour || null,
      buttons: [
        { label: 'Delete', value: 'delete', style: 'danger' },
        { label: 'Cancel', value: 'cancel', style: 'neutral' },
      ],
    })
    if (result !== 'delete') return
    await deleteObject('knowledge', knowledgeId)
  }, [deleteObject, knowledgesPS])

  // Phase 1.21c — set of knowledge ids that have a CREATION ANCHOR:
  //   - a <KnowledgeOriginNode> on canvas, OR
  //   - an `existence_changes: activate` event in history (scene-born).
  // Manual anchors and downstream history entries (content change,
  // awareness change) do NOT count — those are mutations on a
  // Knowledge whose first-existence point is undefined. The library
  // row's "no origin" red ∅ + ⊕ affordance keys on the *absence* from
  // this set, matching the orphan-Knowledge alert in `useAlerts.js`.
  const knowledgeOriginNodeIds = useMemo(() => {
    const set = new Set()
    for (const n of (nodes || [])) {
      if (n.type === 'knowledgeOriginNode' && n.data?.knowledge_id) {
        set.add(n.data.knowledge_id)
      }
    }
    for (const k of (knowledgesPS || [])) {
      if (set.has(k.id)) continue
      const hasActivate = (k.history?.existence_changes || [])
        .some((c) => c?.action === 'activate' && c?.node_id)
      if (hasActivate) set.add(k.id)
    }
    return set
  }, [nodes, knowledgesPS])

  const handleLocateKnowledge = useCallback((knowledgeId) => {
    // Prefer the Knowledge's own origin node on canvas if present;
    // otherwise focus the earliest chain-relevant scene (manual anchor
    // or history entry) so scene-anchored Knowledges still locate.
    // Current nodes/edges and the story order are read lazily at click
    // time: subscribing to them on the render path made this panel pay
    // the cold story-order recompute inside its own render.
    const { nodes: curNodes, edges: curEdges } = useProjectStore.getState()
    const originNode = (curNodes || []).find(
      (n) => n.type === 'knowledgeOriginNode' && n.data?.knowledge_id === knowledgeId,
    )
    if (originNode && focusNode) {
      focusNode(originNode.id)
      return
    }
    const k = (knowledgesPS || []).find((kk) => kk.id === knowledgeId)
    if (!k) return
    const order = getKnowledgeNodeOrder(k, curNodes, curEdges, getOrComputeStoryOrderFromStore())
    if (order && order.length > 0 && focusNode) {
      focusNode(order[0])
    }
  }, [knowledgesPS, focusNode])

  const handleAddKnowledgeOriginNode = useCallback((knowledgeId) => {
    const newNode = addKnowledgeOriginNodeToCanvas(knowledgeId)
    if (newNode && focusNode) focusNode(newNode.id)
  }, [addKnowledgeOriginNodeToCanvas, focusNode])


  if (!entityLibraryOpen) {
    return (
      <div className="flex flex-col items-center pt-2 w-8 bg-zinc-900 border-r border-zinc-700 h-full flex-shrink-0">
        <button
          onClick={toggleEntityLibrary}
          className="text-zinc-400 hover:text-zinc-200 text-sm"
          title="Open Entity Library"
        >
          ▸
        </button>
      </div>
    )
  }

  return (
    <LeftSidebarShell>

      {/* ── Top-level tabs + collapse button ── */}
      <div data-help-region="entity-library:view_tabs" className="flex items-center border-b border-zinc-700 flex-shrink-0">
        <button
          data-help-region="entity-library:tab_library_view"
          onClick={() => setSidebarTab('library')}
          className={`flex-1 py-1.5 text-xs transition-colors ${
            sidebarTab === 'library'
              ? 'text-accent-400 border-b-2 border-accent-400'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Library
        </button>
        <button
          data-help-region="entity-library:tab_details_view"
          onClick={() => setSidebarTab('details')}
          className={`flex-1 py-1.5 text-xs transition-colors ${
            sidebarTab === 'details'
              ? 'text-accent-400 border-b-2 border-accent-400'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Details
        </button>
        <button
          data-help-region="entity-library:collapse"
          onClick={toggleEntityLibrary}
          className="px-2 py-1.5 text-zinc-500 hover:text-zinc-300 text-xs flex-shrink-0"
          title="Collapse"
        >
          ◂
        </button>
      </div>

      {sidebarTab === 'library' ? (
        <>
          {/* ── Entity type tabs ── */}
          {/* flex-1 on each button distributes the tab buttons evenly
              across the sidebar's full width. overflow-x-auto dropped
              since nothing needs to scroll anymore (every tab is just
              an icon + flex-1 share of available space). */}
          <div className="flex border-b border-zinc-700 flex-shrink-0" data-help-region="entity-library:tab_bar">
            {ENTITY_TABS.map(tab => (
              <button
                key={tab.key}
                data-help-region={`entity-library:tab_${tab.key}`}
                onClick={() => setActiveTab(tab.key)}
                className={`flex-1 min-w-0 py-1.5 text-[11px] whitespace-nowrap transition hover:scale-110 ${
                  activeTab === tab.key
                    ? 'text-accent-400 border-b-2 border-accent-400'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
                title={`${TYPE_ICONS[tab.key]} ${tab.label}`}
              >
                {TYPE_ICONS[tab.key]}
              </button>
            ))}
            <button
              data-help-region="entity-library:tab_relationships"
              onClick={() => setActiveTab('relationships')}
              className={`flex-1 min-w-0 py-1.5 text-[11px] whitespace-nowrap transition hover:scale-110 ${
                activeTab === 'relationships'
                  ? 'text-accent-400 border-b-2 border-accent-400'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Relationships"
            >
              <span
                className="inline-flex items-center justify-center align-middle"
                style={{ verticalAlign: 'middle' }}
              >
                <RelationshipIcon size={15} />
              </span>
            </button>
            <button
              data-help-region="entity-library:tab_tags_and_lists"
              onClick={() => setActiveTab('tags_and_lists')}
              className={`flex-1 min-w-0 py-1.5 text-[11px] whitespace-nowrap transition hover:scale-110 ${
                activeTab === 'tags_and_lists'
                  ? 'text-accent-400 border-b-2 border-accent-400'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Tags & Lists"
            >
              {'🏷️'}
            </button>
            <button
              data-help-region="entity-library:tab_context_cues"
              onClick={() => setActiveTab('context_cues')}
              className={`flex-1 min-w-0 py-1.5 text-[11px] whitespace-nowrap transition hover:scale-110 ${
                activeTab === 'context_cues'
                  ? 'text-accent-400 border-b-2 border-accent-400'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Context Cues"
            >
              🧩
            </button>
            <button
              data-help-region="entity-library:tab_references"
              onClick={() => setActiveTab('references')}
              className={`flex-1 min-w-0 py-1.5 text-[11px] whitespace-nowrap transition hover:scale-110 ${
                activeTab === 'references'
                  ? 'text-accent-400 border-b-2 border-accent-400'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="References"
            >
              &#x1F4CC;
            </button>
          </div>

          {/* Phase 1.24a — per-tab quick-filter input. Shown on every
              tab except References (out-of-scope for V1). The active
              tab's filter string is held panel-locally per tab so the
              writer can switch tabs without losing each tab's query.
              Phase 3.4i — TagFilterBar sits inline to the right of
              the text-filter input on entity-family tabs. The active-
              filter chip row renders below the bar (TagFilterBar
              owns its own vertical stack). Visible on entity tabs +
              knowledge (chain-trackable) — pinned to the right edge
              so the search input keeps the bulk of the row width. */}
          <div className="px-2 py-1.5 border-b border-zinc-800 flex-shrink-0">
            <div className="flex items-start gap-1.5">
              <div className="relative flex-1 min-w-0">
                <span aria-hidden className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500 text-xs pointer-events-none">🔍</span>
                <input
                  type="text"
                  data-help-region="entity-library:filter_input"
                  value={currentFilter}
                  onChange={(e) => setCurrentFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      clearCurrentFilter()
                      e.currentTarget.blur()
                    }
                  }}
                  placeholder={(() => {
                    const labels = {
                      character: 'Characters',
                      location: 'Locations',
                      item: 'Items',
                      faction: 'Factions',
                      custom: 'Customs',
                      knowledge: 'Knowledge',
                      relationships: 'Relationships',
                      references: 'References',
                      context_cues: 'Context Cues',
                      tags_and_lists: 'Tags & Lists',
                    }
                    return `Filter ${labels[activeTab] || ''}`
                  })()}
                  className="w-full bg-zinc-800 text-xs text-zinc-100 pl-7 pr-7 py-1 rounded border border-zinc-700 focus:outline-none focus:border-accent-500 placeholder:text-zinc-500"
                />
                {currentFilter && (
                  <button
                    type="button"
                    onClick={clearCurrentFilter}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 text-xs leading-none"
                    title="Clear filter"
                    aria-label="Clear filter"
                  >×</button>
                )}
              </div>
              {(isEntityTab || isKnowledgeTab || activeTab === 'relationships' || activeTab === 'references') && (
                <span data-help-region="entity-library:tag_filter" className="contents">
                  <TagFilterBar
                    pool="project"
                    filterState={entityLibraryTagFilter}
                    onFilterStateChange={setEntityLibraryTagFilter}
                  />
                </span>
              )}
              {/* Phase 3.4i — program-pool tag filter for the
                  Context Cues tab; sits inline with the text input
                  so the layout matches every other tab. Wired to
                  the existing `contextCuesTagFilter` so cycling chips
                  keeps the same semantics as before. */}
              {activeTab === 'context_cues' && (
                <TagFilterBar
                  pool="program"
                  programScope="cues"
                  filterState={contextCuesTagFilter}
                  onFilterStateChange={setContextCuesTagFilter}
                />
              )}
            </div>
          </div>

          {isKnowledgeTab ? (
            <KnowledgeLibrarySection
              knowledges={knowledgesPS}
              onCreate={handleCreateKnowledge}
              onDelete={handleDeleteKnowledge}
              onOpen={openKnowledgeDetail}
              originNodeIds={knowledgeOriginNodeIds}
              onLocate={handleLocateKnowledge}
              onAddOriginNode={handleAddKnowledgeOriginNode}
              nameFilter={currentFilter}
              tagFilter={entityLibraryTagFilter}
              nodes={nodes}
            />
          ) : isEntityTab ? (
            <>
              {/* Tab label + divider button. Hidden for tree-view
                  tabs (location's HierarchyTreeView, custom's
                  CustomsByCategoryView) which have their own
                  structure. */}
              <div className="px-3 py-1 text-xs text-zinc-500 flex-shrink-0 flex items-center justify-between">
                <span>{currentEntityTab.label} ({currentEntities.length})</span>
                {activeTab !== 'location' && activeTab !== 'custom' && (
                  <button
                    onClick={() => addLibraryDivider(bucketKey)}
                    className="text-zinc-600 hover:text-zinc-300 text-[10px] px-1"
                    title="Add divider"
                  >┄</button>
                )}
              </div>

              {/* Entity list */}
              <div className="flex-1 overflow-y-auto min-h-0" data-help-region="entity-library:entity_rows">
                {activeTab === 'location' ? (
                  <HierarchyTreeView
                    entityTypeFilter="location"
                    uninstantiatedIds={uninstantiatedIds}
                    onSelect={navigateToEntity}
                    onLocate={handleLocateEntity}
                    onDelete={handleDeleteRequest}
                    onAddOriginNode={handleAddOriginNode}
                    onReparent={(childId, newParentId) => setHierarchyParent(childId, newParentId)}
                    nameFilter={currentFilter}
                    tagFilter={entityLibraryTagFilter}
                  />
                ) : activeTab === 'custom' ? (
                  <CustomsByCategoryView
                    customs={tagFilterEmpty ? customs : customs.filter((e) =>
                      matchesProjectTagFilterBySet(
                        chainWideTagIdsForHost(e, 'custom', nodes),
                        entityLibraryTagFilter,
                      )
                    )}
                    categories={customCategories}
                    nameFilter={currentFilter}
                    nodes={nodes}
                    onCreateCategory={(catData) => createCustomCategory(catData)}
                    onUpdateCategory={(id, data) => updateCustomCategory(id, { id, ...data })}
                    onDeleteCategory={(id) => deleteObject('customCategory', id)}
                    onEdit={navigateToEntity}
                    onDelete={handleDeleteRequest}
                    onLocate={handleLocateEntity}
                    onAddOriginNode={handleAddOriginNode}
                    uninstantiatedIds={uninstantiatedIds}
                  />
                ) : (
                  <div className="py-1 px-1 space-y-0.5">
                    {(currentFilter ? visibleItems : orderedItems).map((item, idx, arr) => {
                      const isLast = idx === arr.length - 1
                      // Drop indicator booleans derived from the
                      // hook's state. `isDragOver` paints the top-
                      // edge accent line on the target row;
                      // `isDragOverAtEnd` paints the bottom-edge
                      // accent line on the LAST row when the writer
                      // is hovering the trailing hit-area.
                      const isDragOver = !currentFilter
                        && reorder.dragIdx != null
                        && reorder.dragOverIdx === idx
                        && reorder.dragIdx !== idx
                      const isAtEnd = !currentFilter
                        && isLast
                        && reorder.dragOverIdx === orderedItems.length
                        && reorder.dragIdx !== idx
                      const gripProps = currentFilter ? {} : reorder.gripProps(idx)
                      const rowDropProps = currentFilter ? {} : reorder.rowDropProps(idx)
                      return item.type === 'entity' ? (
                        <EntityItem
                          key={item.entity.id}
                          entity={item.entity}
                          nodes={nodes}
                          onEdit={navigateToEntity}
                          onDelete={handleDeleteRequest}
                          onLocate={handleLocateEntity}
                          onAddOriginNode={handleAddOriginNode}
                          isUninstantiated={uninstantiatedIds.has(item.entity.id)}
                          onDragStart={gripProps.onDragStart}
                          onDragOver={rowDropProps.onDragOver}
                          onDrop={rowDropProps.onDrop}
                          onDragEnd={gripProps.onDragEnd}
                          isDragOver={isDragOver}
                          isDragOverAtEnd={isAtEnd}
                        />
                      ) : (
                        <DividerItem
                          key={item.divider.id}
                          divider={item.divider}
                          onTitleChange={(title) => updateLibraryDivider(bucketKey, item.divider.id, title)}
                          onRemove={() => removeLibraryDivider(bucketKey, item.divider.id)}
                          onDragStart={gripProps.onDragStart}
                          onDragOver={rowDropProps.onDragOver}
                          onDrop={rowDropProps.onDrop}
                          onDragEnd={gripProps.onDragEnd}
                          isDragOver={isDragOver}
                          isDragOverAtEnd={isAtEnd}
                        />
                      )
                    })}
                    {(currentFilter ? visibleItems : orderedItems).length === 0 && (
                      <p className="px-3 py-2 text-xs text-zinc-600 italic">None.</p>
                    )}
                    {/* Invisible trailing hit-area below the last
                        row so drops below the lowest item are
                        reachable. The visual indicator is painted
                        on the last row's BOTTOM edge via the
                        `isDragOverAtEnd` prop above — this zone
                        has no chrome of its own. Only rendered
                        during reorder drags (the hook returns
                        null `trailingZoneProps` when disabled or
                        no drag is active). */}
                    {reorder.trailingZoneProps && (
                      <div className="h-6" {...reorder.trailingZoneProps} />
                    )}
                  </div>
                )}

              </div>

              {/* New entity button */}
              <div className="border-t border-zinc-700 p-2 flex-shrink-0">
                <button
                  onClick={() => openNewEntityModal(activeTab)}
                  data-help-region="entity-library:new_entity_btn"
                  className="w-full px-2 py-1.5 text-xs rounded bg-accent-700/20 border border-accent-700/40 text-accent-300 hover:bg-accent-700/40 hover:text-accent-200 transition-colors"
                >
                  + New {currentEntityTab.label.replace(/s$/, '')}
                </button>
              </div>
            </>
          ) : activeTab === 'references' ? (
            <ReferencesSection
              nodes={nodes}
              focusNode={focusNode}
              onAddReference={handleAddReferenceAtViewport}
              nameFilter={currentFilter}
              tagFilter={entityLibraryTagFilter}
            />
          ) : activeTab === 'relationships' ? (
            <RelationshipsLibrarySection
              relationships={relationships}
              onOpen={openRelationshipDetail}
              nameFilter={currentFilter}
              tagFilter={entityLibraryTagFilter}
              nodes={nodes}
            />
          ) : activeTab === 'context_cues' ? (
            <ContextCueSection nameFilter={currentFilter} />
          ) : (
            <TagsAndListsSection
              nameFilter={currentFilter}
              presetListsSection={(
                <PresetListsSection
                  presetLists={presetLists}
                  onCreate={createPresetList}
                  onUpdate={(id, data) => updatePresetList(id, data)}
                  onDelete={id => deleteObject('presetList', id)}
                  nameFilter={currentFilter}
                />
              )}
            />
          )}
        </>
      ) : (
        /* ── Detail tab ── */
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
          <DetailPanel />
        </div>
      )}

    </LeftSidebarShell>
  )
}

/**
 * Phase 1.26 — Resizable shell wrapper for the left sidebar. Reads the
 * persisted width from `useSettingsStore.preferences.left_sidebar_width`
 * (null = use the built-in default of 224 logical px). Floor is the
 * built-in default — the writer can drag wider but never narrower than
 * the original baked-in width.
 *
 * The drag handle is a 4-px-wide invisible strip overlapping the right
 * edge of the panel. On mousedown the handler tracks pointer-screen-x
 * deltas; the panel uses CSS `zoom: 1.25`, so screen-px deltas are
 * divided by 1.25 to map to logical-px width. The new width is held
 * locally during the drag for fluid feedback, then committed to the
 * settings store on pointer-up via `updatePreferences` (debounced
 * inside the store as part of the standard pattern).
 */
const LEFT_SIDEBAR_DEFAULT_WIDTH = 224
const LEFT_SIDEBAR_ZOOM = 1.25

function LeftSidebarShell({ children }) {
  const persistedWidth = useSettingsStore((s) => s.preferences?.left_sidebar_width)
  const updatePreferences = useSettingsStore((s) => s.updatePreferences)
  const baseWidth = Math.max(LEFT_SIDEBAR_DEFAULT_WIDTH, persistedWidth || LEFT_SIDEBAR_DEFAULT_WIDTH)
  const [dragWidth, setDragWidth] = useState(null)
  const lastWidthRef = useRef(null)
  // MCP session edit-lock — when a session is active, the entity
  // library / detail panel becomes non-interactive and visually
  // faded so the user can see what's there but can't change
  // anything. Same idea applied to the editor panel on the right.
  const isMcpEditLocked = useMcpControlStore((s) => s.sessionState === 'active')

  const effectiveWidth = dragWidth ?? baseWidth

  const handlePointerDown = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = baseWidth
    lastWidthRef.current = startWidth
    function onMove(ev) {
      const dxLogical = (ev.clientX - startX) / LEFT_SIDEBAR_ZOOM
      const next = Math.max(
        LEFT_SIDEBAR_DEFAULT_WIDTH,
        Math.round(startWidth + dxLogical),
      )
      lastWidthRef.current = next
      setDragWidth(next)
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const finalWidth = lastWidthRef.current
      setDragWidth(null)
      if (typeof finalWidth === 'number' && finalWidth !== startWidth) {
        // Persist null when the writer dragged back to (or below) the
        // floor — keeps the on-disk pref blank in the no-override case.
        const value = finalWidth <= LEFT_SIDEBAR_DEFAULT_WIDTH ? null : finalWidth
        updatePreferences({ left_sidebar_width: value })
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [baseWidth, updatePreferences])

  return (
    <div
      className={`relative flex-shrink-0 bg-zinc-900 border-r border-zinc-700 flex flex-col h-full transition-opacity ${isMcpEditLocked ? 'pointer-events-none opacity-60' : ''}`}
      style={{ width: effectiveWidth, zoom: LEFT_SIDEBAR_ZOOM }}
      data-test-id="left-sidebar"
    >
      {children}
      {/* Drag handle — 6-px strip overlapping the right edge for a
          reliable hit target. Cursor changes on hover via
          `cursor-col-resize`. */}
      <div
        onPointerDown={handlePointerDown}
        title="Drag to resize"
        className="absolute top-0 bottom-0 cursor-col-resize z-10"
        style={{ right: -3, width: 6, touchAction: 'none' }}
      />
    </div>
  )
}
