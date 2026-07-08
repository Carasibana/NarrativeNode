import { useCallback, useState } from 'react'
import { parseListValue } from '../../utils/narrativeChain'

/**
 * Text List attribute editor — Phase 1.10 Track D.
 *
 * Renders a row of removable tag chips with an inline "add" input, used in
 * the Detail Panel's Attributes tab for `text_list` attributes. Reuses the
 * tag-chip visual from the Story Settings preset-list editor for familiarity.
 *
 * Works in three rendering contexts:
 *
 *   1. ORIGIN VIEW (isOrigin=true):
 *      - `effectiveItems` is the full current value of the attribute (the
 *        JSON-parsed `value` array from the entity's own attributes[]).
 *      - Add / remove callbacks mutate the draft's corresponding add entry's
 *        embedded attribute.value JSON-array via `addListItem` / `removeListItem`.
 *      - No change indicator needed — every item is just "part of the list".
 *
 *   2. MID-CHAIN VIEW (isOrigin=false, not added at this node):
 *      - `effectiveItems` is the chain-walked effective list at this node.
 *      - Items that match a pending `list_remove` in the draft render with a
 *        strikethrough + red-X and a revert ↩ button.
 *      - Items added via a pending `list_add` render with a +ADD green border.
 *      - The add/remove callbacks write list_add / list_remove entries to the
 *        draft via `addListItem` / `removeListItem`.
 *
 *   3. MID-CHAIN "added at this node" (draft contains an add entry for this
 *      attribute): the list lives inside the embedded attribute's `value`
 *      JSON array — same behaviour as the origin view. `addListItem` /
 *      `removeListItem` already handle this case by mutating the add entry
 *      directly instead of writing list_add / list_remove.
 *
 * Props:
 *   attr              — the attribute descriptor (must have .id and .name)
 *   effectiveItems    — array of strings currently in the effective list at
 *                       this rendering position
 *   pendingAdds       — (mid-chain only) set of items added in the draft via
 *                       list_add entries. Rendered with +ADD styling.
 *   pendingRemoves    — (mid-chain only) set of items removed in the draft
 *                       via list_remove entries. Rendered with strikethrough.
 *   onAdd             — (item) => void — called when the user presses Enter
 *                       on the input or clicks the + button
 *   onRemove          — (item) => void — called when the user clicks a chip's
 *                       × (or the revert ↩ on a pending-remove chip)
 *   readOnly          — if true, no input / × buttons are rendered (for
 *                       read-only prior-state reference displays)
 */
export default function TextListAttribute({
  effectiveItems,
  pendingAdds,
  pendingRemoves,
  onAdd,
  onRemove,
  readOnly,
}) {
  const [input, setInput] = useState('')

  const commit = useCallback(() => {
    const v = input.trim()
    if (!v) return
    onAdd?.(v)
    setInput('')
  }, [input, onAdd])

  const items = effectiveItems || []
  const addSet = pendingAdds instanceof Set ? pendingAdds : null
  const removeSet = pendingRemoves instanceof Set ? pendingRemoves : null

  // Merged display list: effective items (which already include any additions
  // in the draft's `add` attribute-value path) PLUS any pending list_add items
  // that aren't in the effective list yet (mid-chain case where effective
  // state hasn't been recomputed with the draft merged in).
  const displayItems = [...items]
  if (addSet) {
    for (const item of addSet) {
      if (!displayItems.includes(item)) displayItems.push(item)
    }
  }

  return (
    <div data-help-region="text-list-attribute:editor" className="space-y-1">
      {displayItems.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {displayItems.map((v) => {
            const isPendingAdd = addSet?.has(v)
            const isPendingRemove = removeSet?.has(v)
            // Styling priority: pending-remove > pending-add > normal
            let chipCls, textCls
            if (isPendingRemove) {
              chipCls = 'bg-red-900/30 border border-red-800/60'
              textCls = 'text-zinc-400 line-through'
            } else if (isPendingAdd) {
              chipCls = 'bg-green-900/30 border border-green-800/60'
              textCls = 'text-green-300'
            } else {
              chipCls = 'bg-zinc-600'
              textCls = 'text-zinc-200'
            }
            return (
              <span
                key={v}
                data-help-region="text-list-attribute:chip"
                className={`inline-flex items-center gap-0.5 text-xs rounded px-1.5 py-0.5 ${chipCls}`}
              >
                <span className={textCls}>{v}</span>
                {!readOnly && (
                  isPendingRemove ? (
                    <button
                      type="button"
                      onClick={() => onRemove?.(v)}
                      className="text-amber-500 hover:text-amber-300 leading-none ml-0.5 text-[10px]"
                      title="Undo remove"
                    >↩</button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onRemove?.(v)}
                      className="text-zinc-400 hover:text-red-400 leading-none ml-0.5"
                      title="Remove"
                    >×</button>
                  )
                )}
              </span>
            )
          })}
        </div>
      )}
      {!readOnly && (
        <div data-help-region="text-list-attribute:add_input" className="flex gap-1">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit() }
            }}
            placeholder="Add value, press Enter…"
            className="flex-1 bg-zinc-800 text-xs text-zinc-300 px-2 py-1 rounded border border-zinc-700 focus:outline-none focus:border-accent-500"
          />
          <button
            type="button"
            onClick={commit}
            className="text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded px-2 py-1"
          >+</button>
        </div>
      )}
      {displayItems.length === 0 && readOnly && (
        <span className="text-xs text-zinc-600 italic">empty list</span>
      )}
    </div>
  )
}

/**
 * Convenience helper: compute the pending-add and pending-remove sets for a
 * given attribute id from the draft's attribute_changes array. Returns empty
 * sets if the attribute is added at this node (in which case the changes are
 * embedded inside the add entry's value JSON, not tracked separately).
 */
export function getTextListPendingSets(attrId, draftAttrChanges) {
  const adds = new Set()
  const removes = new Set()
  if (!attrId || !draftAttrChanges) return { adds, removes }
  // If the attribute is added at this node, we don't use pending sets — the
  // list is in the embedded attribute's value.
  const addedAtNode = draftAttrChanges.some((ac) => ac.action === 'add' && ac.attribute?.id === attrId)
  if (addedAtNode) return { adds, removes }
  for (const ac of draftAttrChanges) {
    if (ac.attribute_id !== attrId) continue
    if (ac.action === 'list_add' && ac.list_item) adds.add(ac.list_item)
    else if (ac.action === 'list_remove' && ac.list_item) removes.add(ac.list_item)
  }
  return { adds, removes }
}

// Re-export parseListValue so consumers can import both from one place.
export { parseListValue }
