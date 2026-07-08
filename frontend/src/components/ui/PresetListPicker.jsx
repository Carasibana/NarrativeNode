import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useEntitiesStore } from '../../store/entitiesStore'

/**
 * Searchable popup for selecting which preset list to attach.
 * Follows the EntityColorPicker portal + anchor-relative positioning pattern.
 *
 * The caller renders the trigger button and manages open/close state.
 * This component renders only the floating popover.
 *
 * Props:
 *   value     — currently selected preset list id, or null
 *   onChange  — called with listId (string) or null when user selects/clears
 *   anchorEl  — DOM element the popover positions itself below
 *   isOpen    — parent controls visibility
 *   onClose   — parent should set isOpen to false
 */
export default function PresetListPicker({ value, onChange, anchorEl, isOpen, onClose }) {
  const presetLists    = useEntitiesStore((s) => s.presetLists)
  const createPresetList = useEntitiesStore((s) => s.createPresetList)

  const [query,         setQuery]         = useState('')
  const [creating,      setCreating]      = useState(false)
  const [newName,       setNewName]       = useState('')
  const [newValues,     setNewValues]     = useState([])
  const [newValueInput, setNewValueInput] = useState('')
  const [position,      setPosition]      = useState({ top: 0, left: 0 })

  const popoverRef   = useRef(null)
  const searchRef    = useRef(null)
  const newNameRef   = useRef(null)
  const newValueRef  = useRef(null)

  const POPOVER_W = 224

  // Reset state each time the popover opens, and focus search.
  useEffect(() => {
    if (!isOpen) return
    setQuery('')
    setCreating(false)
    setNewName('')
    setNewValues([])
    setNewValueInput('')
    const t = setTimeout(() => searchRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [isOpen])

  // Position the popover below the anchor, flipping above if near bottom edge.
  // Re-runs when creating changes so the expanded form doesn't overflow.
  useEffect(() => {
    if (!isOpen || !anchorEl) return
    const t = setTimeout(() => {
      const rect = anchorEl.getBoundingClientRect()
      const estimatedH = creating ? 380 : 280
      let top  = rect.bottom + 4
      let left = rect.left
      if (top  + estimatedH > window.innerHeight) top  = Math.max(8, rect.top - estimatedH - 4)
      if (left + POPOVER_W  > window.innerWidth)  left = Math.max(8, window.innerWidth - POPOVER_W - 8)
      setPosition({ top, left })
    }, 0)
    return () => clearTimeout(t)
  }, [isOpen, anchorEl, creating])

  // Escape closes; mousedown outside closes.
  useEffect(() => {
    if (!isOpen) return
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    function onDown(e) {
      if (popoverRef.current?.contains(e.target)) return
      if (anchorEl?.contains(e.target)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [isOpen, onClose, anchorEl])

  if (!isOpen) return null

  const filtered = presetLists.filter(
    (pl) => pl.name.toLowerCase().includes(query.toLowerCase())
  )

  function select(listId) {
    onChange(listId)
    onClose()
  }

  function commitNewValue() {
    const v = newValueInput.trim()
    if (!v || newValues.includes(v)) { setNewValueInput(''); return }
    setNewValues([...newValues, v])
    setNewValueInput('')
    newValueRef.current?.focus()
  }

  async function handleCreate() {
    const name = newName.trim()
    if (!name) return
    const list = await createPresetList({ name, values: newValues })
    onChange(list.id)
    onClose()
  }

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Select preset list"
      data-nested-modal="true"
      data-help-region="preset-list-picker:popover"
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        top:  position.top,
        left: position.left,
        width: POPOVER_W,
        zIndex: 9999,
      }}
      className="bg-zinc-900 border border-zinc-700 rounded-md shadow-2xl flex flex-col overflow-hidden"
    >
      {/* Search */}
      <div className="px-2 pt-2 pb-1">
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search lists…"
          className="w-full px-2 py-1 text-xs bg-zinc-800 border border-zinc-600 rounded focus:outline-none focus:border-accent-500 text-zinc-200 placeholder-zinc-600"
          data-help-region="preset-list-picker:search"
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto max-h-[160px] px-1.5 py-1 space-y-0.5">
        {value && (
          <button
            className="w-full flex items-center gap-2 px-2 py-1 rounded text-left hover:bg-zinc-800 transition-colors"
            onClick={() => select(null)}
          >
            <span className="text-[11px] text-zinc-500 italic flex-1">None</span>
          </button>
        )}
        {filtered.length === 0 && (
          <p className="px-2 py-1.5 text-[11px] text-zinc-600 italic">
            {query ? 'No matching lists' : 'No preset lists yet'}
          </p>
        )}
        {filtered.map((pl) => {
          const selected = pl.id === value
          return (
            <button
              key={pl.id}
              className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left transition-colors ${
                selected
                  ? 'bg-accent-700/25 border border-accent-600/40'
                  : 'hover:bg-zinc-800 border border-transparent'
              }`}
              onClick={() => select(pl.id)}
            >
              <span className="flex-1 text-[11px] text-zinc-200 truncate">{pl.name}</span>
              <span className="text-[10px] text-zinc-600 flex-shrink-0">{pl.values.length}</span>
            </button>
          )
        })}
      </div>

      {/* Create new */}
      <div className="border-t border-zinc-700/60 px-2 py-1.5">
        {creating ? (
          <div className="space-y-1">
            {/* Name field */}
            <input
              ref={newNameRef}
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); newValueRef.current?.focus() }
                if (e.key === 'Escape') { e.stopPropagation(); setCreating(false) }
              }}
              placeholder="List name…"
              className="w-full px-2 py-0.5 text-[11px] bg-zinc-800 border border-zinc-600 rounded focus:outline-none focus:border-accent-500 text-zinc-200"
            />
            {/* Value chips */}
            {newValues.length > 0 && (
              <div className="flex flex-wrap gap-0.5 max-h-[52px] overflow-y-auto">
                {newValues.map((v) => (
                  <span key={v} className="inline-flex items-center gap-0.5 bg-zinc-700 text-zinc-200 text-[10px] rounded px-1.5 py-0.5">
                    {v}
                    <button
                      type="button"
                      onClick={() => setNewValues(newValues.filter((x) => x !== v))}
                      className="text-zinc-400 hover:text-red-400 leading-none ml-0.5"
                    >×</button>
                  </span>
                ))}
              </div>
            )}
            {/* Value input */}
            <div className="flex gap-1">
              <input
                ref={newValueRef}
                value={newValueInput}
                onChange={(e) => setNewValueInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitNewValue() }
                  if (e.key === 'Escape') { e.stopPropagation(); setCreating(false) }
                }}
                placeholder="Add value, press Enter…"
                className="flex-1 px-2 py-0.5 text-[11px] bg-zinc-800 border border-zinc-600 rounded focus:outline-none focus:border-accent-500 text-zinc-200"
              />
              <button
                type="button"
                onClick={commitNewValue}
                className="px-1.5 py-0.5 text-[11px] bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded"
              >+</button>
            </div>
            {/* Action row */}
            <div className="flex gap-1 pt-0.5">
              <button
                onClick={handleCreate}
                disabled={!newName.trim()}
                className="flex-1 px-2 py-0.5 text-[11px] bg-accent-700 hover:bg-accent-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded"
              >
                Create
              </button>
              <button
                onClick={() => setCreating(false)}
                className="px-1.5 py-0.5 text-[11px] text-zinc-500 hover:text-zinc-300"
              >✕</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => { setCreating(true); setQuery('') }}
            className="w-full text-left text-[11px] text-accent-400 hover:text-accent-300 transition-colors py-0.5"
            data-help-region="preset-list-picker:create_new"
          >
            ✚ Create new list…
          </button>
        )}
      </div>
    </div>,
    document.body,
  )
}
