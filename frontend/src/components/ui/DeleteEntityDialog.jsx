import { useState, useEffect, useRef } from 'react'
import { useSettingsStore } from '../../store/settingsStore'

/**
 * Confirmation dialog for deleting an entity.
 *
 * Props:
 *   entityName   — display name the user must type to confirm
 *   entityColour — entity colour for the accent strip
 *   chipCount    — number of plot-point chips that reference this entity (0 = no warning)
 *   mode         — 'library' | 'origin_node'
 *                  'library': single "Delete" button (full purge)
 *                  'origin_node': two buttons — "Delete node only" / "Delete node and entity"
 *   onDeleteEntity — callback: full entity purge (entity + all chips + all nodes + all connections)
 *   onDeleteNodeOnly — callback: remove origin node from canvas, leave entity in library (origin_node mode only)
 *   onClose      — close the dialog without action
 */
export default function DeleteEntityDialog({
  entityName,
  entityColour = '#888888',
  chipCount = 0,
  mode = 'library',
  onDeleteEntity,
  onDeleteNodeOnly,
  onClose,
  extraOption = null,  // optional: { label: string, onChange: (checked)=>void, initial?: bool }
}) {
  const [typed, setTyped] = useState('')
  const [extraChecked, setExtraChecked] = useState(!!extraOption?.initial)
  const inputRef = useRef(null)
  const backdropRef = useRef(null)

  // Program-level setting: require typing the object's name to confirm.
  // Defaults ON (require) — treat anything but an explicit `false` as on,
  // so a fresh prefs file with no entry keeps today's guard.
  const requireTypedName = useSettingsStore((s) => s.preferences.require_typed_name_to_delete) !== false

  // When the guard is off, the delete buttons are enabled immediately;
  // otherwise they gate on the typed name matching exactly.
  const nameMatch = !requireTypedName || typed.trim() === entityName.trim()

  // Auto-focus the input
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on Escape
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Close on backdrop click
  function handleBackdropClick(e) {
    if (e.target === backdropRef.current) onClose()
  }

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60"
      onClick={handleBackdropClick}
    >
      <div
        className="bg-zinc-800 border border-zinc-600 rounded-lg shadow-2xl w-[380px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Colour accent strip */}
        <div className="h-1" style={{ backgroundColor: entityColour }} />

        <div className="p-5 space-y-4">
          {/* Title */}
          <h2 className="text-sm font-semibold text-zinc-100">
            Delete Entity
          </h2>

          {/* Warning about chips */}
          {chipCount > 0 && (
            <div className="bg-red-900/30 border border-red-700/50 rounded px-3 py-2 text-xs text-red-300">
              This entity has chips in <strong>{chipCount}</strong> scene {chipCount === 1 ? 'node' : 'nodes'}.
              {mode === 'library'
                ? ' Deleting will remove all chips and their connections.'
                : ' Choosing "Delete node and entity" will remove all chips and their connections.'}
            </div>
          )}

          {mode === 'origin_node' && (
            <div className="text-xs text-zinc-400 space-y-1">
              <p><strong className="text-zinc-200">Delete node only:</strong> removes this origin node from the canvas but keeps the entity in the library.</p>
              <p><strong className="text-zinc-200">Delete node and entity:</strong> fully purges the entity, all its chips, modifier nodes, and connections.</p>
            </div>
          )}

          {/* Confirmation input — only when the program setting requires
              typing the name. When off, the buttons below are already
              enabled (nameMatch is forced true) and no input is shown. */}
          {requireTypedName && (
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400">
                Type <strong className="text-zinc-200">{entityName}</strong> to confirm:
              </label>
              <input
                ref={inputRef}
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={entityName}
                className="w-full bg-zinc-700 text-sm text-zinc-100 px-3 py-2 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && nameMatch) {
                    if (mode === 'library') onDeleteEntity()
                  }
                }}
              />
            </div>
          )}

          {/* Optional extra checkbox — call site supplies label + onChange.
              Used for ad-hoc per-entity session toggles (e.g. hidden
              feature gates) that only need to live for the lifetime of
              this session. */}
          {extraOption && (
            <label className="flex items-start gap-2 text-xs text-zinc-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={extraChecked}
                onChange={(e) => {
                  setExtraChecked(e.target.checked)
                  extraOption.onChange?.(e.target.checked)
                }}
                className="mt-0.5"
              />
              <span>{extraOption.label}</span>
            </label>
          )}

          {/* Action buttons — Phase 1.13 v0.1.13.1 restyling.
              Matches the shared ConfirmDialog button-style system:
              - Cancel → neutral (outlined zinc)
              - Delete node only → primary (solid accent)
              - Delete node and entity / Delete → danger (zinc bg
                + accent inset ring + accent text; same pattern as
                ConfirmDialog.jsx:BUTTON_STYLES.danger). Disabled
                state uses a muted zinc fill so the button is still
                clearly clickable-shaped but visibly inert. */}
          <div className="flex gap-2 justify-end pt-1">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100 rounded border border-zinc-600 hover:border-zinc-500"
            >
              Cancel
            </button>

            {mode === 'origin_node' && (
              <button
                disabled={!nameMatch}
                onClick={onDeleteNodeOnly}
                className={`px-3 py-1.5 text-xs rounded border ${
                  nameMatch
                    ? 'bg-accent-700 hover:bg-accent-600 text-white border-accent-600'
                    : 'bg-zinc-700 text-zinc-500 border-zinc-600 cursor-not-allowed'
                }`}
              >
                Delete node only
              </button>
            )}

            <button
              disabled={!nameMatch}
              onClick={onDeleteEntity}
              className={`px-3 py-1.5 text-xs rounded border ${
                nameMatch
                  ? 'bg-zinc-800 hover:bg-zinc-700 text-accent-400 hover:text-accent-300 border-zinc-600 ring-2 ring-inset ring-accent-500'
                  : 'bg-zinc-700 text-zinc-500 border-zinc-600 cursor-not-allowed'
              }`}
            >
              {mode === 'origin_node' ? 'Delete node and entity' : 'Delete'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
