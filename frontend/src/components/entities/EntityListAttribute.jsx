import { useCallback, useMemo, useState } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { computeEffectiveState, parseListValue } from '../../utils/narrativeChain'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import ImageHoverPreview from '../ui/ImageHoverPreview'
import EntityPickerPopover from './EntityPickerPopover'

/**
 * Entity List attribute editor — Phase 1.10 Track E.
 *
 * Renders a row of entity chips representing a `entity_list` attribute. Each
 * chip shows the referenced entity's **effective state at the current chain
 * position** (name, colour, profile image), chain-walked via
 * `computeEffectiveState(entity, nodes, edges, atNodeId)`. If the referenced
 * entity is not present at the exact chain position, the effective state at
 * that point still reflects any chain edits made to that entity earlier in
 * its own narrative, which is the intent — "last known state" per the
 * Phase 1.10 planning doc.
 *
 * Three add paths (this commit implements the first two, canvas wiring lands
 * in the next commit):
 *   1. Drag-and-drop from the Entity Library onto the list drop zone
 *   2. "+ Add entity…" picker dropdown with type filter + name search
 *   3. (Coming next) fire-and-forget canvas wire gesture onto sub-chip handles
 *
 * Rendering contexts, same three as TextListAttribute:
 *   - origin view / at-node add: mutates the draft's embedded `add` entry's
 *     JSON-array value via `addListItem` / `removeListItem` (same helpers
 *     as text_list — they share the list storage shape).
 *   - mid-chain, inherited: writes `list_add` / `list_remove` entries to
 *     `attribute_changes` via `addListItem` / `removeListItem`. Pending
 *     overlays (draft adds in green border, draft removes in red strikethrough)
 *     are computed from `pendingAdds` / `pendingRemoves` props passed by the
 *     caller (same shape as TextListAttribute, reuses `getTextListPendingSets`).
 *
 * Props:
 *   attr             — the attribute descriptor (must have .id and .name)
 *   effectiveItems   — array of entity UUID strings currently in the effective
 *                      list at this rendering position
 *   pendingAdds      — Set of entity UUIDs added in the draft via list_add (optional)
 *   pendingRemoves   — Set of entity UUIDs removed in the draft via list_remove (optional)
 *   atNodeId         — canvas node id for effective-state chain-walk; used to
 *                      compute each referenced entity's state at this point
 *   onAdd            — (entityId) => void
 *   onRemove         — (entityId) => void
 *   onNavigate       — (entityId) => void — called when the user clicks a chip
 *                      body; used to navigate the Detail Panel to that entity
 *   readOnly         — if true, no drop zone / remove / picker rendered
 */
export default function EntityListAttribute({
  effectiveItems,
  pendingAdds,
  pendingRemoves,
  atNodeId,
  onAdd,
  onRemove,
  onNavigate,
  readOnly,
}) {
  const nodes = useProjectStore((s) => s.nodes)
  const edges = useProjectStore((s) => s.edges)

  // Subscribe to all entity buckets so chip names/colours/images stay live
  // if the referenced entities are edited while the panel is open.
  const entCharacters  = useEntitiesStore((s) => s.characters)
  const entLocations   = useEntitiesStore((s) => s.locations)
  const entItems       = useEntitiesStore((s) => s.items)
  const entFactions    = useEntitiesStore((s) => s.factions)
  const entCustoms     = useEntitiesStore((s) => s.customs)
  const entKnowledges  = useProjectStore((s) => s.knowledges)
  const allEntities = useMemo(
    () => [...entCharacters, ...entLocations, ...entItems, ...entFactions, ...entCustoms, ...(entKnowledges || [])],
    [entCharacters, entLocations, entItems, entFactions, entCustoms, entKnowledges]
  )

  const [dragOver, setDragOver] = useState(false)
  const [showPicker, setShowPicker] = useState(false)

  const items = effectiveItems || []
  const addSet = pendingAdds instanceof Set ? pendingAdds : null
  const removeSet = pendingRemoves instanceof Set ? pendingRemoves : null

  // Merged display list: effective items (which already include in-draft
  // additions at origin / at-node — the value is mutated directly in that
  // path) plus any pending list_add entity ids that aren't in the effective
  // list yet (mid-chain inherited case).
  const displayItems = [...items]
  if (addSet) {
    for (const id of addSet) {
      if (!displayItems.includes(id)) displayItems.push(id)
    }
  }

  // Drag-and-drop handlers for the drop zone.
  const handleDragOver = useCallback((e) => {
    if (readOnly) return
    if (!e.dataTransfer.types.includes('application/nnz-entity-id')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }, [readOnly])
  const handleDragLeave = useCallback(() => setDragOver(false), [])
  const handleDrop = useCallback((e) => {
    if (readOnly) return
    setDragOver(false)
    const droppedId = e.dataTransfer.getData('application/nnz-entity-id')
    if (!droppedId) return
    e.preventDefault()
    e.stopPropagation()
    onAdd?.(droppedId)
  }, [onAdd, readOnly])

  return (
    <div
      data-help-region="entity-list-attribute:editor"
      className={`space-y-1 rounded transition-colors ${dragOver ? 'bg-accent-900/20 outline outline-1 outline-accent-500/50' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {displayItems.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {displayItems.map((refEntityId) => {
            const refEntity = allEntities.find((e) => e.id === refEntityId)
            const effective = refEntity ? computeEffectiveState(refEntity, nodes, edges, atNodeId || null) : null
            const name = effective?.name ?? refEntity?.name ?? '(deleted entity)'
            const colour = effective?.colour ?? refEntity?.colour ?? '#888888'
            const profileRef = effective?.profile_image_ref ?? refEntity?.profile_image_ref ?? null
            const assetName = profileRef ? profileRef.replace(/^assets\//, '') : null
            const isPendingAdd = addSet?.has(refEntityId)
            const isPendingRemove = removeSet?.has(refEntityId)

            let borderCls, extraBg
            if (isPendingRemove) {
              borderCls = 'border border-red-800/60'
              extraBg = 'bg-red-900/20'
            } else if (isPendingAdd) {
              borderCls = 'border border-green-800/60'
              extraBg = 'bg-green-900/20'
            } else {
              borderCls = 'border border-zinc-700'
              extraBg = 'bg-zinc-800/50'
            }

            return (
              <span
                key={refEntityId}
                data-help-region="entity-list-attribute:chip"
                className={`inline-flex items-center gap-1 rounded px-1 py-0.5 ${borderCls} ${extraBg}`}
              >
                {/* Profile image / type icon with entity-colour border */}
                <ImageHoverPreview src={assetName ? `/api/project/assets/${assetName}` : null} borderColour={colour} size={80}>
                  {assetName ? (
                    <img
                      src={`/api/project/assets/${assetName}`}
                      alt=""
                      className="rounded-sm object-cover flex-shrink-0"
                      style={{ width: 16, height: 16, border: `1.5px solid ${colour}` }}
                    />
                  ) : (
                    <span
                      className="rounded-sm flex items-center justify-center flex-shrink-0 text-[9px]"
                      style={{ width: 16, height: 16, backgroundColor: colour + '22', border: `1.5px solid ${colour}` }}
                    >
                      {TYPE_ICONS[refEntity?.type] || '?'}
                    </span>
                  )}
                </ImageHoverPreview>
                {/* Entity name — clickable for down-navigation */}
                <button
                  type="button"
                  onClick={() => onNavigate?.(refEntityId)}
                  disabled={!refEntity || !onNavigate}
                  className={`text-[10px] truncate max-w-[120px] ${isPendingRemove ? 'text-zinc-500 line-through' : 'text-zinc-200'} ${refEntity && onNavigate ? 'hover:text-accent-300 cursor-pointer' : 'cursor-default'}`}
                  style={{ color: isPendingRemove ? undefined : colour }}
                  title={refEntity ? `Navigate to ${name}` : 'Entity no longer exists'}
                >
                  {name}
                </button>
                {!readOnly && (
                  isPendingRemove ? (
                    <button
                      type="button"
                      onClick={() => onRemove?.(refEntityId)}
                      className="text-amber-500 hover:text-amber-300 leading-none text-[10px] ml-0.5"
                      title="Undo remove"
                    >↩</button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onRemove?.(refEntityId)}
                      className="text-zinc-500 hover:text-red-400 leading-none ml-0.5"
                      title="Remove from list"
                    >×</button>
                  )
                )}
              </span>
            )
          })}
        </div>
      )}

      {!readOnly && (
        <div className="flex items-center gap-1">
          {displayItems.length === 0 && (
            <span className="text-[10px] text-zinc-600 italic flex-1">
              Drop an entity here or use the picker →
            </span>
          )}
          <button
            data-help-region="entity-list-attribute:add_button"
            type="button"
            onClick={() => setShowPicker((v) => !v)}
            className="text-[10px] text-accent-400 hover:text-accent-300 px-1 py-0.5 ml-auto"
          >
            {showPicker ? '× Close' : '+ Add entity…'}
          </button>
        </div>
      )}

      {showPicker && !readOnly && (
        <EntityPickerPopover
          allEntities={allEntities}
          excludeIds={new Set(displayItems)}
          onPick={(id) => { onAdd?.(id); /* keep picker open so multiple can be added */ }}
          onClose={() => setShowPicker(false)}
        />
      )}

      {displayItems.length === 0 && readOnly && (
        <span className="text-xs text-zinc-600 italic">empty list</span>
      )}
    </div>
  )
}

// Re-export parseListValue for convenience — same pattern as TextListAttribute.
export { parseListValue }
