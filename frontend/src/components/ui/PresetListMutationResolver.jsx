import { useState, useMemo } from 'react'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProjectStore } from '../../store/projectStore'
import { ENTITY_BUCKETS } from '../../utils/entityHelpers'

/**
 * Modal dialog for resolving consumers when a preset list value is removed
 * or a preset list is deleted entirely.
 *
 * Reads affected items (entity preset attributes + future: participant roles)
 * directly from the store. Applies resolution changes to the store on Apply,
 * then signals the parent to proceed with the underlying list mutation.
 *
 * Props:
 *   isOpen        — visibility
 *   onClose       — called on Cancel (parent should NOT proceed with list mutation)
 *   listId        — the preset list being mutated
 *   listName      — display name for that list
 *   removedValues — string[] of values being removed; null means whole list deleted
 *   pendingValues — string[] of values the list will be saved with; null if deleting
 *   onProceed     — called after resolutions applied; parent then saves/deletes list
 *                   signature: onProceed({ addValues?: string[] })
 *                   addValues = values the resolver wants merged into pendingValues
 */
export default function PresetListMutationResolver({
  isOpen, onClose,
  listId, listName,
  removedValues,   // null = whole list deleted
  pendingValues,   // null = list being deleted
  onProceed,
}) {
  const [mode, setMode]         = useState('pin')        // 'pin'|'replace'|'new'|'individual'
  const [replaceWith, setReplaceWith] = useState('')
  const [newValue,   setNewValue]    = useState('')
  const [addToList,  setAddToList]   = useState(true)
  const [perItem,    setPerItem]     = useState({})       // { [itemId]: { mode, value } }
  const [applying,   setApplying]    = useState(false)

  const entitiesState    = useEntitiesStore((s) => s)
  const updateEntity     = useEntitiesStore((s) => s.updateEntity)

  const relationships      = useProjectStore((s) => s.relationships)
  const updateRelationship = useProjectStore((s) => s.updateRelationship)

  const isDelete = removedValues === null

  // ── Compute affected items ────────────────────────────────────────────────

  const affectedItems = useMemo(() => {
    if (!listId) return []
    const result = []
    for (const bucket of ENTITY_BUCKETS) {
      for (const entity of entitiesState[bucket] || []) {
        for (const attr of entity.attributes || []) {
          if (attr.attribute_type !== 'preset') continue
          if (attr.preset_list_id !== listId) continue
          const valueAffected = isDelete || removedValues.includes(attr.value)
          if (!valueAffected) continue
          result.push({
            id:          `ea-${entity.id}-${attr.id}`,
            type:        'entity_attribute',
            entityId:    entity.id,
            entityName:  entity.name,
            fieldLabel:  attr.name,
            currentValue: attr.value,
            attributeId: attr.id,
          })
        }
      }
    }
    // Participant roles on relationships (base + history role_changes).
    for (const rel of relationships || []) {
      for (const [entityId, role] of Object.entries(rel.participant_roles || {})) {
        if (role?.preset_list_id !== listId) continue
        if (!isDelete && !removedValues.includes(role.value)) continue
        result.push({
          id:           `rr-${rel.id}-${entityId}`,
          type:         'relationship_role',
          relId:        rel.id,
          entityId,
          relName:      rel.name || 'Relationship',
          entityName:   findEntity(entitiesState, entityId)?.name || entityId,
          currentValue: role.value,
        })
      }
      for (const ch of rel.history?.role_changes || []) {
        if (ch.new_role?.preset_list_id !== listId) continue
        if (!isDelete && !removedValues.includes(ch.new_role.value)) continue
        result.push({
          id:           `rrc-${rel.id}-${ch.entity_id}-${ch.node_id}`,
          type:         'relationship_role_change',
          relId:        rel.id,
          entityId:     ch.entity_id,
          nodeId:       ch.node_id,
          relName:      rel.name || 'Relationship',
          entityName:   findEntity(entitiesState, ch.entity_id)?.name || ch.entity_id,
          currentValue: ch.new_role.value,
        })
      }
    }
    return result
  // Deliberately stable: recompute only when list id or delete-mode changes,
  // not on every entity update. The dialog is short-lived.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listId, isDelete, removedValues])

  // Initialise per-item state lazily when switching to 'individual' mode.
  function ensurePerItem() {
    setPerItem((prev) => {
      const next = { ...prev }
      for (const item of affectedItems) {
        if (!next[item.id]) {
          next[item.id] = { mode: 'pin', value: '' }
        }
      }
      return next
    })
  }

  // ── Apply ─────────────────────────────────────────────────────────────────

  async function handleApply() {
    setApplying(true)
    try {
      // Group affected entity-attribute items by entityId for batched updates.
      const entityUpdates = {}
      function queueAttr(item, newAttr) {
        if (!entityUpdates[item.entityId]) {
          const entity = findEntity(entitiesState, item.entityId)
          if (!entity) return
          entityUpdates[item.entityId] = { entity, attrs: [...entity.attributes] }
        }
        const rec = entityUpdates[item.entityId]
        rec.attrs = rec.attrs.map((a) => a.id === item.attributeId ? newAttr : a)
      }

      const extraValues = []

      for (const item of affectedItems) {
        if (item.type !== 'entity_attribute') continue
        const entity = findEntity(entitiesState, item.entityId)
        if (!entity) continue
        const attr = entity.attributes.find((a) => a.id === item.attributeId)
        if (!attr) continue

        const itemMode = mode === 'individual' ? (perItem[item.id]?.mode ?? 'pin') : mode
        const itemVal  = mode === 'individual' ? (perItem[item.id]?.value ?? '')   : (mode === 'replace' ? replaceWith : newValue)

        let newAttr
        if (itemMode === 'pin') {
          newAttr = { ...attr, attribute_type: 'text', preset_list_id: null, preset_list_name: '' }
        } else if (itemMode === 'replace') {
          newAttr = { ...attr, value: itemVal }
        } else {
          // 'new': free-form or add-to-list depending on context
          if (!isDelete && addToList) {
            // Stays preset type; new value will be added to list
            newAttr = { ...attr, value: itemVal }
            if (itemVal && !extraValues.includes(itemVal)) extraValues.push(itemVal)
          } else {
            // Convert to free-form text
            newAttr = { ...attr, attribute_type: 'text', value: itemVal, preset_list_id: null, preset_list_name: '' }
          }
        }
        queueAttr(item, newAttr)
      }

      // Relationship role updates: group by relId.
      const relUpdates = {}
      function resolveRoleValue(item, itemMode, itemVal) {
        if (itemMode === 'pin') return { value: item.currentValue, preset_list_id: null }
        if (itemMode === 'replace') return { value: itemVal, preset_list_id: listId }
        // 'new'
        if (!isDelete && addToList) {
          if (itemVal && !extraValues.includes(itemVal)) extraValues.push(itemVal)
          return { value: itemVal, preset_list_id: listId }
        }
        return { value: itemVal, preset_list_id: null }
      }

      for (const item of affectedItems) {
        if (item.type !== 'relationship_role' && item.type !== 'relationship_role_change') continue
        const itemMode = mode === 'individual' ? (perItem[item.id]?.mode ?? 'pin') : mode
        const itemVal  = mode === 'individual' ? (perItem[item.id]?.value ?? '') : (mode === 'replace' ? replaceWith : newValue)
        const newRole  = resolveRoleValue(item, itemMode, itemVal)

        if (!relUpdates[item.relId]) {
          const rel = (relationships || []).find((r) => r.id === item.relId)
          if (!rel) continue
          relUpdates[item.relId] = { rel, roles: { ...(rel.participant_roles || {}) }, roleChanges: [...(rel.history?.role_changes || [])] }
        }
        const rec = relUpdates[item.relId]

        if (item.type === 'relationship_role') {
          if (newRole.value) rec.roles[item.entityId] = newRole
          else delete rec.roles[item.entityId]
        } else {
          rec.roleChanges = rec.roleChanges.map((ch) =>
            ch.entity_id === item.entityId && ch.node_id === item.nodeId
              ? { ...ch, new_role: newRole.value ? newRole : null }
              : ch
          )
        }
      }

      // Apply entity updates.
      await Promise.all(
        Object.values(entityUpdates).map(({ entity, attrs }) =>
          updateEntity(entity.id, { ...entity, attributes: attrs })
        )
      )

      // Apply relationship role updates.
      await Promise.all(
        Object.values(relUpdates).map(({ rel, roles, roleChanges }) =>
          updateRelationship(rel.id, {
            ...rel,
            participant_roles: roles,
            history: { ...rel.history, role_changes: roleChanges },
          })
        )
      )

      onProceed({ addValues: extraValues })
    } finally {
      setApplying(false)
    }
  }

  if (!isOpen) return null

  const remainingValues = pendingValues ?? []
  const canApply = (() => {
    if (mode === 'replace' && !replaceWith) return false
    if (mode === 'new' && !newValue.trim()) return false
    if (mode === 'individual') {
      for (const item of affectedItems) {
        const r = perItem[item.id]
        if (!r) return false
        if (r.mode === 'replace' && !r.value) return false
        if (r.mode === 'new' && !r.value.trim()) return false
      }
    }
    return true
  })()

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60">
      <div
        className="bg-zinc-800 border border-zinc-600 rounded-lg shadow-2xl w-[500px] max-h-[80vh] flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        data-help-region="preset-list-resolver:modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-zinc-700">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">
              {isDelete ? 'Preset list deleted' : 'Preset list value removed'}
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              {isDelete
                ? <>"{listName}" is being deleted. </>
                : <>{removedValues.map((v) => `"${v}"`).join(', ')} removed from "{listName}". </>
              }
              {affectedItems.length === 0
                ? 'No items are affected.'
                : <>{affectedItems.length} {affectedItems.length === 1 ? 'item uses' : 'items use'} {isDelete ? 'this list' : 'this value'}.</>
              }
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-sm leading-none -mt-0.5">✕</button>
        </div>

        {affectedItems.length === 0 ? (
          <div className="px-5 py-4">
            <p className="text-xs text-zinc-400">No items are affected. The {isDelete ? 'list' : 'value'} can be {isDelete ? 'deleted' : 'removed'} safely.</p>
          </div>
        ) : (
          <>
            {/* Resolution options */}
            <div className="px-5 py-4 space-y-3 overflow-y-auto flex-shrink-0">
              {/* Pin as free-form */}
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="radio" name="mode" value="pin" checked={mode === 'pin'} onChange={() => setMode('pin')} className="mt-0.5 accent-accent-500" />
                <div>
                  <span className="text-xs text-zinc-200 font-medium">Keep current values as free-form text</span>
                  <p className="text-[11px] text-zinc-500 mt-0.5">Each item keeps its current value but is converted from preset to plain text type. The preset list link is removed.</p>
                </div>
              </label>

              {/* Replace with existing value — only when values remain in the list */}
              {!isDelete && remainingValues.length > 0 && (
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input type="radio" name="mode" value="replace" checked={mode === 'replace'} onChange={() => setMode('replace')} className="mt-0.5 accent-accent-500" />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs text-zinc-200 font-medium">Replace all with an existing value</span>
                    {mode === 'replace' && (
                      <select
                        value={replaceWith}
                        onChange={(e) => setReplaceWith(e.target.value)}
                        className="mt-1.5 block w-full bg-zinc-700 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-accent-500"
                      >
                        <option value="">— choose value —</option>
                        {remainingValues.map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    )}
                  </div>
                </label>
              )}

              {/* Replace with new value */}
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="radio" name="mode" value="new" checked={mode === 'new'} onChange={() => setMode('new')} className="mt-0.5 accent-accent-500" />
                <div className="flex-1 min-w-0">
                  <span className="text-xs text-zinc-200 font-medium">
                    {isDelete ? 'Set all to a custom free-form value' : 'Replace all with a new value'}
                  </span>
                  {mode === 'new' && (
                    <div className="mt-1.5 space-y-1.5">
                      <input
                        autoFocus
                        value={newValue}
                        onChange={(e) => setNewValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && canApply && !applying) { e.preventDefault(); handleApply() } }}
                        placeholder="New value…"
                        className="block w-full bg-zinc-700 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-accent-500"
                      />
                      {!isDelete && (
                        <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={addToList}
                            onChange={(e) => setAddToList(e.target.checked)}
                            className="accent-accent-500"
                          />
                          Add "{newValue || '…'}" to the "{listName}" list
                        </label>
                      )}
                    </div>
                  )}
                </div>
              </label>

              {/* Resolve individually */}
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="radio" name="mode" value="individual" checked={mode === 'individual'}
                  onChange={() => { setMode('individual'); ensurePerItem() }}
                  className="mt-0.5 accent-accent-500"
                />
                <div>
                  <span className="text-xs text-zinc-200 font-medium">Resolve individually</span>
                  <p className="text-[11px] text-zinc-500 mt-0.5">Choose a resolution for each affected item separately.</p>
                </div>
              </label>
            </div>

            {/* Per-item list (individual mode) */}
            {mode === 'individual' && (
              <div className="flex-1 overflow-y-auto border-t border-zinc-700 max-h-[200px]">
                {affectedItems.map((item) => {
                  const r = perItem[item.id] || { mode: 'pin', value: '' }
                  return (
                    <div key={item.id} className="flex items-center gap-2 px-5 py-2 border-b border-zinc-700/50 last:border-b-0">
                      <div className="flex-1 min-w-0">
                        <span className="text-[11px] text-zinc-300 font-medium">{item.entityName}</span>
                        <span className="text-[11px] text-zinc-600 mx-1">·</span>
                        <span className="text-[11px] text-zinc-500">{item.fieldLabel}</span>
                        <span className="text-[11px] text-zinc-600 mx-1">·</span>
                        <span className="text-[11px] text-amber-400/80">"{item.currentValue}"</span>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <select
                          value={r.mode === 'new' ? '__new__' : r.mode === 'replace' ? (r.value || '__replace__') : 'pin'}
                          onChange={(e) => {
                            const v = e.target.value
                            if (v === 'pin') {
                              setPerItem((p) => ({ ...p, [item.id]: { mode: 'pin', value: '' } }))
                            } else if (v === '__new__') {
                              setPerItem((p) => ({ ...p, [item.id]: { mode: 'new', value: '' } }))
                            } else {
                              setPerItem((p) => ({ ...p, [item.id]: { mode: 'replace', value: v } }))
                            }
                          }}
                          className="bg-zinc-700 border border-zinc-600 rounded px-1.5 py-0.5 text-[11px] text-zinc-200 focus:outline-none"
                        >
                          <option value="pin">Keep as free-form</option>
                          {!isDelete && remainingValues.map((v) => (
                            <option key={v} value={v}>Replace: "{v}"</option>
                          ))}
                          <option value="__new__">Custom value…</option>
                        </select>
                        {r.mode === 'new' && (
                          <input
                            value={r.value}
                            onChange={(e) => setPerItem((p) => ({ ...p, [item.id]: { ...p[item.id], value: e.target.value } }))}
                            placeholder="value…"
                            className="w-24 bg-zinc-700 border border-zinc-600 rounded px-1.5 py-0.5 text-[11px] text-zinc-200 focus:outline-none focus:border-accent-500"
                          />
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-zinc-700 flex-shrink-0">
          <button
            onClick={onClose}
            disabled={applying}
            className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 rounded border border-zinc-600 hover:border-zinc-500 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={applying || (affectedItems.length > 0 && !canApply)}
            className="px-3 py-1.5 text-xs bg-accent-700 hover:bg-accent-600 text-white rounded border border-accent-600 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {applying ? 'Applying…' : affectedItems.length === 0 ? 'Proceed' : 'Apply and proceed'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findEntity(entitiesState, entityId) {
  for (const bucket of ENTITY_BUCKETS) {
    const found = (entitiesState[bucket] || []).find((e) => e.id === entityId)
    if (found) return found
  }
  return null
}

/**
 * Synchronous check: does any entity preset attribute consume the given list
 * (and optionally a specific set of values)? Call-site uses getState() so this
 * can be used in event handlers without hooks.
 *
 * specificValues — string[] to check for; null = match any value (whole-list check)
 */
export function hasPresetConsumers(listId, specificValues, entitiesStoreState) {
  for (const bucket of ENTITY_BUCKETS) {
    for (const entity of entitiesStoreState[bucket] || []) {
      for (const attr of entity.attributes || []) {
        if (attr.attribute_type !== 'preset') continue
        if (attr.preset_list_id !== listId) continue
        if (!specificValues || specificValues.includes(attr.value)) return true
      }
    }
  }
  const { relationships } = useProjectStore.getState()
  for (const rel of relationships || []) {
    for (const role of Object.values(rel.participant_roles || {})) {
      if (role?.preset_list_id !== listId) continue
      if (!specificValues || specificValues.includes(role.value)) return true
    }
    for (const ch of rel.history?.role_changes || []) {
      if (ch.new_role?.preset_list_id !== listId) continue
      if (!specificValues || specificValues.includes(ch.new_role.value)) return true
    }
  }
  return false
}
