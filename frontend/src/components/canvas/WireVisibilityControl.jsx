import { useEffect, useRef, useState } from 'react'
import { ControlButton } from '@xyflow/react'
import { useUiStore } from '../../store/uiStore'

// Phase 8.2 — canvas wire-visibility control. Four modes: Show all / Chosen
// only / Selection + chosen / Hide all. The two "chosen" modes reveal three
// wire-type checkboxes (POV / Narrative / Concept); relationship wires count as
// Narrative. Icons are monochrome currentColor glyphs.

const ico = (children) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
)

const ShowAllIcon = () => ico(<>
  <line x1="12" y1="5" x2="6" y2="17" /><line x1="12" y1="5" x2="18" y2="17" /><line x1="6" y1="17" x2="18" y2="17" />
  <circle cx="12" cy="5" r="2.4" fill="currentColor" stroke="none" /><circle cx="6" cy="17" r="2.4" fill="currentColor" stroke="none" /><circle cx="18" cy="17" r="2.4" fill="currentColor" stroke="none" />
</>)
// "Chosen only" — a narrowing filter (pick which wire kinds show).
const ChosenIcon = () => ico(<>
  <line x1="4" y1="7" x2="20" y2="7" />
  <line x1="7" y1="12" x2="17" y2="12" />
  <line x1="10" y1="17" x2="14" y2="17" />
</>)
// "Selection + chosen" — a selected hub (filled centre) with wires radiating to
// its connections, i.e. the selection's wires plus the chosen types.
const SelectionChosenIcon = () => ico(<>
  <line x1="9" y1="10.5" x2="4" y2="6" /><line x1="15" y1="10.5" x2="20" y2="6" />
  <line x1="9" y1="13.5" x2="4" y2="18" /><line x1="15" y1="13.5" x2="20" y2="18" />
  <circle cx="3.5" cy="6" r="1.7" /><circle cx="20.5" cy="6" r="1.7" /><circle cx="3.5" cy="18" r="1.7" /><circle cx="20.5" cy="18" r="1.7" />
  <rect x="9" y="9" width="6" height="6" rx="1.4" fill="currentColor" stroke="none" />
</>)
const HideIcon = () => ico(<>
  <circle cx="6" cy="7" r="2.4" fill="currentColor" stroke="none" /><circle cx="18" cy="7" r="2.4" fill="currentColor" stroke="none" /><circle cx="12" cy="19" r="2.4" fill="currentColor" stroke="none" />
</>)

export const MODES = [
  { key: 'all', label: 'Show all wires', tip: 'Show every wire (default).', Icon: ShowAllIcon },
  { key: 'chosen', label: 'Chosen only', tip: 'Show only the wire types you check below.', Icon: ChosenIcon },
  { key: 'selection_chosen', label: 'Selection + chosen', tip: "Show the selected item's wires, plus the wire types you check below.", Icon: SelectionChosenIcon },
  { key: 'hide', label: 'Hide all wires', tip: 'Hide every wire. A wire shows only while you are drawing a new one.', Icon: HideIcon },
]

// The three checkbox wire types (relationship rides with narrative).
export const WIRE_TYPES = [
  { key: 'pov', label: 'POV' },
  { key: 'narrative', label: 'Narrative' },
  { key: 'concept', label: 'Concept' },
]

const ALL_TYPES = { pov: true, narrative: true, concept: true }
const normTypes = (t) => ({ pov: !!t?.pov, narrative: !!t?.narrative, concept: !!t?.concept })

// Modes that reveal the wire-type checkboxes.
export const MODE_HAS_TYPES = (mode) => mode === 'chosen' || mode === 'selection_chosen'

/**
 * Normalise a wire-visibility default into the current { mode, types } shape,
 * migrating the pre-8.2 mode presets. `types` may be absent (legacy prefs).
 *   all → all           | hide → hide
 *   pov → chosen + {pov} | selected → selection_chosen + {none}
 *   pov_selected → selection_chosen + {pov}
 */
export function migrateWireVisibility(mode, types) {
  switch (mode) {
    case 'hide':             return { mode: 'hide', types: types ? normTypes(types) : { ...ALL_TYPES } }
    case 'pov':              return { mode: 'chosen', types: { pov: true, narrative: false, concept: false } }
    case 'selected':         return { mode: 'selection_chosen', types: { pov: false, narrative: false, concept: false } }
    case 'pov_selected':     return { mode: 'selection_chosen', types: { pov: true, narrative: false, concept: false } }
    case 'chosen':           return { mode: 'chosen', types: types ? normTypes(types) : { ...ALL_TYPES } }
    case 'selection_chosen': return { mode: 'selection_chosen', types: types ? normTypes(types) : { ...ALL_TYPES } }
    default:                 return { mode: 'all', types: types ? normTypes(types) : { ...ALL_TYPES } }
  }
}

export default function WireVisibilityControl() {
  const mode = useUiStore((s) => s.wireVisibilityMode)
  const setMode = useUiStore((s) => s.setWireVisibilityMode)
  const wtypes = useUiStore((s) => s.wireVisibilityTypes)
  const setType = useUiStore((s) => s.setWireVisibilityType)

  const [popoutOpen, setPopoutOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!popoutOpen) return
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setPopoutOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setPopoutOpen(false) }
    document.addEventListener('pointerdown', onDown, { capture: true })
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, { capture: true })
      document.removeEventListener('keydown', onKey)
    }
  }, [popoutOpen])

  const active = MODES.find((m) => m.key === mode) || MODES[0]
  const ActiveIcon = active.Icon
  const showChecks = MODE_HAS_TYPES(mode)

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <ControlButton
        data-help-region="canvas-overview:wire_visibility"
        onClick={() => setPopoutOpen((o) => !o)}
        title={`Wire visibility: ${active.label}. Click to choose a mode.`}
        aria-label={`Wire visibility: ${active.label}`}
      >
        <ActiveIcon />
      </ControlButton>
      {popoutOpen && (
        <div
          className="absolute left-full bottom-0 ml-1 bg-zinc-800 border border-zinc-600 rounded shadow-xl py-1 z-50"
          style={{ minWidth: 200 }}
        >
          {MODES.map((m) => {
            const MIcon = m.Icon
            const isActive = m.key === mode
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => setMode(m.key)}
                title={m.tip}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left transition-colors ${
                  isActive ? 'bg-accent-700/40 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-700/50'
                }`}
              >
                <span className="inline-flex items-center justify-center text-zinc-100" style={{ width: 18, height: 18 }}>
                  <MIcon />
                </span>
                <span>{m.label}</span>
              </button>
            )
          })}
          {showChecks && (
            <>
              <div className="border-t border-zinc-700 my-1" />
              <div className="px-2.5 pt-0.5 pb-1 text-[10px] uppercase tracking-wider text-zinc-500">Show wire types</div>
              {WIRE_TYPES.map((t) => (
                <label
                  key={t.key}
                  className="w-full flex items-center gap-2 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700/50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    className="accent-accent-500"
                    checked={!!wtypes?.[t.key]}
                    onChange={(e) => setType(t.key, e.target.checked)}
                  />
                  <span>{t.label}</span>
                </label>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
